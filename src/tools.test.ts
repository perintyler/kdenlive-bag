import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildMltXml } from "./mlt.js";

// Import the helpers indirectly through the tool handlers — the tools
// re-export what we need to test the parser and probe logic.

describe("kdenliveProjectInfo", () => {
  // Dynamically import to avoid top-level await
  async function getProjectInfo() {
    const { kdenliveProjectInfo } = await import("./tools.js");
    return kdenliveProjectInfo;
  }

  it("parses a generated MLT file correctly", async () => {
    const tool = await getProjectInfo();
    const xml = buildMltXml({
      profile: { width: 1280, height: 720, fps: 30 },
      tracks: [
        {
          clips: [
            { type: "clip", source: { resource: "color:red", out: 29 } },
            { type: "clip", source: { resource: "/path/video.mp4", out: 59 } },
          ],
        },
      ],
    });

    const tmpFile = join(tmpdir(), `barry-test-${Date.now()}.mlt`);
    writeFileSync(tmpFile, xml);

    const result = await tool.handler({ projectFile: tmpFile });

    expect(result.format).toBe("mlt");
    expect(result.profile).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(result.producers).toHaveLength(2);
    expect(result.producers[0].resource).toBe("color:red");
    expect(result.producers[1].resource).toBe("/path/video.mp4");
    expect(result.playlists).toBe(1);
    expect(result.tractors).toBe(1);
  });

  it("parses profile attributes regardless of order", async () => {
    const tool = await getProjectInfo();
    // Profile with attributes in non-standard order
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<mlt>
  <profile progressive="1" height="480" frame_rate_num="25" width="640" colorspace="709" frame_rate_den="1" sample_aspect_num="1" sample_aspect_den="1"/>
  <producer id="p1">
    <property name="resource">color:black</property>
    <property name="out">24</property>
  </producer>
  <playlist id="pl0">
    <entry producer="p1" out="24"/>
  </playlist>
  <tractor id="main">
    <multitrack>
      <track producer="pl0"/>
    </multitrack>
  </tractor>
</mlt>`;

    const tmpFile = join(tmpdir(), `barry-test-reorder-${Date.now()}.mlt`);
    writeFileSync(tmpFile, xml);

    const result = await tool.handler({ projectFile: tmpFile });
    expect(result.profile).toEqual({ width: 640, height: 480, fps: 25 });
  });

  it("counts self-closing transitions and filters", async () => {
    const tool = await getProjectInfo();
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<mlt>
  <profile width="640" height="360" frame_rate_num="24" frame_rate_den="1" sample_aspect_num="1" sample_aspect_den="1" progressive="1" colorspace="709"/>
  <producer id="p1">
    <property name="resource">color:red</property>
  </producer>
  <producer id="p2">
    <property name="resource">color:blue</property>
  </producer>
  <playlist id="pl0">
    <entry producer="p1" out="47"/>
  </playlist>
  <playlist id="pl1">
    <entry producer="p2" out="47"/>
  </playlist>
  <tractor id="main">
    <multitrack>
      <track producer="pl0"/>
      <track producer="pl1"/>
    </multitrack>
    <transition mlt_service="luma" a_track="0" b_track="1" in="0" out="23"/>
    <filter mlt_service="brightness" track="0"/>
  </tractor>
</mlt>`;

    const tmpFile = join(tmpdir(), `barry-test-selfclose-${Date.now()}.mlt`);
    writeFileSync(tmpFile, xml);

    const result = await tool.handler({ projectFile: tmpFile });
    expect(result.transitions).toBe(1);
    expect(result.filters).toBe(1);
  });

  it("counts transitions and filters with bodies", async () => {
    const tool = await getProjectInfo();
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<mlt>
  <profile width="640" height="360" frame_rate_num="24" frame_rate_den="1" sample_aspect_num="1" sample_aspect_den="1" progressive="1" colorspace="709"/>
  <producer id="p1">
    <property name="resource">color:red</property>
  </producer>
  <playlist id="pl0">
    <entry producer="p1" out="47"/>
  </playlist>
  <tractor id="main">
    <multitrack>
      <track producer="pl0"/>
    </multitrack>
    <transition mlt_service="composite" a_track="0" b_track="1" in="0" out="23">
      <property name="geometry">0/0:100%x100%</property>
    </transition>
    <filter mlt_service="brightness" track="0" in="0" out="47">
      <property name="level">0.8</property>
    </filter>
  </tractor>
</mlt>`;

    const tmpFile = join(tmpdir(), `barry-test-withbody-${Date.now()}.mlt`);
    writeFileSync(tmpFile, xml);

    const result = await tool.handler({ projectFile: tmpFile });
    expect(result.transitions).toBe(1);
    expect(result.filters).toBe(1);
  });

  it("throws on missing file", async () => {
    const tool = await getProjectInfo();
    await expect(
      tool.handler({ projectFile: "/nonexistent/file.mlt" }),
    ).rejects.toThrow("not found");
  });

  it("identifies .kdenlive format", async () => {
    const tool = await getProjectInfo();
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<mlt>
  <profile width="640" height="360" frame_rate_num="24" frame_rate_den="1" sample_aspect_num="1" sample_aspect_den="1" progressive="1" colorspace="709"/>
  <producer id="p1"><property name="resource">color:red</property></producer>
  <playlist id="pl0"><entry producer="p1" out="1"/></playlist>
  <tractor id="main"><multitrack><track producer="pl0"/></multitrack></tractor>
</mlt>`;

    const tmpFile = join(tmpdir(), `barry-test-${Date.now()}.kdenlive`);
    writeFileSync(tmpFile, xml);

    const result = await tool.handler({ projectFile: tmpFile });
    expect(result.format).toBe("kdenlive");
  });
});

describe("kdenliveCompose", () => {
  async function getCompose() {
    const { kdenliveCompose } = await import("./tools.js");
    return kdenliveCompose;
  }

  it("renders a color composition to mp4", async () => {
    const tool = await getCompose();
    const result = await tool.handler({
      name: "test-compose",
      profile: { width: 320, height: 240, fps: 24 },
      tracks: [
        {
          clips: [
            { type: "clip", source: { resource: "color:red", out: 11 } },
          ],
        },
      ],
    });

    expect(result.videoPath).toContain("test-compose");
    expect(result.videoPath).toMatch(/\.mp4$/);
    expect(existsSync(result.videoPath)).toBe(true);
    expect(result.tracks).toBe(1);
    expect(result.renderSeconds).toBeGreaterThan(0);
  }, 30_000);
});
