import { describe, it, expect } from "vitest";
import { buildMltXml, buildSimpleRenderXml, resetIds } from "./mlt.js";

describe("buildMltXml", () => {
  it("generates valid XML for a single-track composition", () => {
    const xml = buildMltXml({
      profile: { width: 1920, height: 1080, fps: 24 },
      tracks: [
        {
          clips: [
            { type: "clip", source: { resource: "color:red", out: 47 } },
          ],
        },
      ],
    });

    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<mlt>");
    expect(xml).toContain('width="1920"');
    expect(xml).toContain('height="1080"');
    expect(xml).toContain('frame_rate_num="24"');
    expect(xml).toContain("<property name=\"resource\">color:red</property>");
    expect(xml).toContain('out="47"');
    expect(xml).toContain("<tractor");
    expect(xml).toContain("<multitrack>");
    expect(xml).toContain("</mlt>");
  });

  it("handles blanks between clips", () => {
    const xml = buildMltXml({
      profile: { width: 640, height: 360, fps: 24 },
      tracks: [
        {
          clips: [
            { type: "clip", source: { resource: "color:red", out: 23 } },
            { type: "blank", length: 12 },
            { type: "clip", source: { resource: "color:blue", out: 23 } },
          ],
        },
      ],
    });

    expect(xml).toContain('blank length="12"');
    // Two producers for two clips
    expect(xml.match(/<producer /g)?.length).toBe(2);
  });

  it("supports multiple tracks with hide attribute", () => {
    const xml = buildMltXml({
      profile: { width: 640, height: 360, fps: 24 },
      tracks: [
        { clips: [{ type: "clip", source: { resource: "color:red", out: 23 } }] },
        {
          clips: [{ type: "clip", source: { resource: "/path/audio.wav", out: 23 } }],
          hide: "video",
        },
      ],
    });

    expect(xml).toContain('hide="video"');
    expect(xml.match(/<track /g)?.length).toBe(2);
  });

  it("includes transitions between tracks", () => {
    const xml = buildMltXml({
      profile: { width: 640, height: 360, fps: 24 },
      tracks: [
        { clips: [{ type: "clip", source: { resource: "color:red", out: 47 } }] },
        { clips: [{ type: "clip", source: { resource: "color:blue", out: 47 } }] },
      ],
      transitions: [
        {
          mltId: "luma",
          aTrack: 0,
          bTrack: 1,
          in: 0,
          out: 23,
          properties: { softness: "0.2" },
        },
      ],
    });

    expect(xml).toContain('mlt_service="luma"');
    expect(xml).toContain('a_track="0"');
    expect(xml).toContain('b_track="1"');
    expect(xml).toContain("<property name=\"softness\">0.2</property>");
  });

  it("includes filters on tracks", () => {
    const xml = buildMltXml({
      profile: { width: 640, height: 360, fps: 24 },
      tracks: [
        { clips: [{ type: "clip", source: { resource: "color:red", out: 47 } }] },
      ],
      filters: [
        {
          mltId: "brightness",
          track: 0,
          in: 0,
          out: 47,
          properties: { level: "0.5" },
        },
      ],
    });

    expect(xml).toContain('mlt_service="brightness"');
    expect(xml).toContain('track="0"');
    expect(xml).toContain("<property name=\"level\">0.5</property>");
  });

  it("escapes special XML characters in properties", () => {
    const xml = buildMltXml({
      profile: { width: 640, height: 360, fps: 24 },
      tracks: [
        {
          clips: [
            {
              type: "clip",
              source: {
                resource: "color:red",
                out: 23,
                properties: { title: 'Test <clip> & "more"' },
              },
            },
          ],
        },
      ],
    });

    expect(xml).toContain("Test &lt;clip&gt; &amp; &quot;more&quot;");
    // Must not contain unescaped special chars in property values
    expect(xml).not.toMatch(/<property[^>]*>[^<]*<clip>/);
  });

  it("passes through custom producer properties", () => {
    const xml = buildMltXml({
      profile: { width: 640, height: 360, fps: 24 },
      tracks: [
        {
          clips: [
            {
              type: "clip",
              source: {
                resource: "/path/frames/f_*.png",
                fps: 30,
                out: 59,
                properties: { aspect_ratio: "1.0" },
              },
            },
          ],
        },
      ],
    });

    expect(xml).toContain("<property name=\"fps\">30</property>");
    expect(xml).toContain("<property name=\"aspect_ratio\">1.0</property>");
  });

  it("uses custom producer ids when provided", () => {
    const xml = buildMltXml({
      profile: { width: 640, height: 360, fps: 24 },
      tracks: [
        {
          clips: [
            { type: "clip", source: { id: "my_clip", resource: "color:red", out: 23 } },
          ],
        },
      ],
    });

    expect(xml).toContain('id="my_clip"');
    expect(xml).toContain('producer="my_clip"');
  });

  it("sets profile display aspect ratio defaults from width/height", () => {
    const xml = buildMltXml({
      profile: { width: 1920, height: 1080, fps: 24 },
      tracks: [{ clips: [{ type: "clip", source: { resource: "color:red", out: 1 } }] }],
    });

    expect(xml).toContain('display_aspect_num="1920"');
    expect(xml).toContain('display_aspect_den="1080"');
  });
});

describe("buildSimpleRenderXml", () => {
  it("wraps a single resource in a minimal composition", () => {
    const xml = buildSimpleRenderXml(
      "/path/to/video.mp4",
      { width: 1920, height: 1080, fps: 24 },
      { in: 10, out: 100 },
    );

    expect(xml).toContain("/path/to/video.mp4");
    expect(xml).toContain("<tractor");
    expect(xml).toContain('in="10"');
    expect(xml).toContain('out="100"');
  });
});

describe("resetIds", () => {
  it("produces deterministic ids after reset", () => {
    resetIds();
    const xml1 = buildMltXml({
      profile: { width: 640, height: 360, fps: 24 },
      tracks: [{ clips: [{ type: "clip", source: { resource: "color:red", out: 1 } }] }],
    });

    resetIds();
    const xml2 = buildMltXml({
      profile: { width: 640, height: 360, fps: 24 },
      tracks: [{ clips: [{ type: "clip", source: { resource: "color:red", out: 1 } }] }],
    });

    expect(xml1).toBe(xml2);
  });
});
