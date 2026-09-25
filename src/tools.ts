import { defineTool } from "@barry-rocks/sdk/bags";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve, isAbsolute, basename, dirname, extname } from "node:path";
import { homedir } from "node:os";
import {
  runMelt,
  renderMltXml,
  isMeltInstalled,
  isFfprobeInstalled,
  probeMedia,
  MeltError,
} from "./exec.js";
import { buildMltXml, buildSimpleRenderXml } from "./mlt.js";
import type { ClipSource, Track, TrackEntry, Transition, Filter, Profile } from "./mlt.js";

const NS = "kdenlive";
const RENDER_ROOT = join(homedir(), ".barry", "kdenlive");

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "composition";
}

function expandPath(p: string): string {
  const expanded = p.replace(/^~/, homedir());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Pull a named attribute's integer value from an XML tag string. */
function extractAttr(tag: string, name: string): number | null {
  const m = tag.match(new RegExp(`${name}="(\\d+)"`));
  return m ? parseInt(m[1]) : null;
}

/** Pull a <property name="X">value</property> from an element body. */
function extractProperty(body: string, name: string): string | null {
  const m = body.match(new RegExp(`<property\\s+name="${name}">([^<]*)<\\/property>`));
  return m ? m[1] : null;
}

// ---- Zod schemas for tool inputs ----

const clipSourceSchema = z.object({
  id: z.string().optional().describe("Unique id; auto-generated if omitted"),
  resource: z.string().describe(
    "Media source: a file path (video/audio/image), image sequence glob (e.g. '/path/frames/f_*.png'), or generator ('color:black', 'color:#FF0000')",
  ),
  in: z.number().int().optional().describe("In point in frames (0-based)"),
  out: z.number().int().optional().describe("Out point in frames (inclusive)"),
  fps: z.number().optional().describe("FPS for image sequences"),
  properties: z.record(z.string()).optional().describe("Additional MLT producer properties"),
});

const trackEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("clip"),
    source: clipSourceSchema,
  }),
  z.object({
    type: z.literal("blank"),
    length: z.number().int().describe("Blank duration in frames"),
  }),
]);

const trackSchema = z.object({
  clips: z.array(trackEntrySchema).describe("Clips and blanks on this track, in order"),
  hide: z
    .enum(["video", "audio", "both"])
    .optional()
    .describe("Hide video or audio from this track"),
});

const transitionSchema = z.object({
  mltId: z.string().describe("MLT transition service, e.g. 'luma', 'composite', 'mix'"),
  aTrack: z.number().int().describe("Lower track index (0-based)"),
  bTrack: z.number().int().describe("Upper track index (0-based)"),
  in: z.number().int().describe("Start frame"),
  out: z.number().int().describe("End frame (inclusive)"),
  properties: z.record(z.string()).optional().describe("Transition properties"),
});

const filterSchema = z.object({
  mltId: z.string().describe("MLT filter service, e.g. 'brightness', 'volume'"),
  track: z.number().int().describe("Track index (0-based)"),
  in: z.number().int().optional().describe("Start frame"),
  out: z.number().int().optional().describe("End frame"),
  properties: z.record(z.string()).optional().describe("Filter properties"),
});

const profileSchema = z.object({
  width: z.number().int().optional().describe("Width in pixels (default: 1920)"),
  height: z.number().int().optional().describe("Height in pixels (default: 1080)"),
  fps: z.number().int().optional().describe("Frames per second (default: 24)"),
});

// ---- Tools ----

export const kdenliveStatus = defineTool({
  namespace: NS,
  access: "read",
  name: "kdenlive_status",
  description:
    "Check that melt and ffprobe are installed and report melt's version and available codecs.",
  schema: {},
  handler: async () => {
    const [melt, ffprobe] = await Promise.all([isMeltInstalled(), isFfprobeInstalled()]);

    if (!melt) {
      return {
        meltInstalled: false,
        ffprobeInstalled: ffprobe,
        installCommand: "brew install mlt",
      };
    }

    const versionOut = await runMelt(["-version"], 15_000).catch(() => "");
    const version = versionOut.split("\n")[0]?.trim() || "unknown";

    // List available consumers (output formats)
    const consumersOut = await runMelt(["-query", "consumers"], 15_000).catch(() => "");
    const consumers = consumersOut
      .split("\n")
      .map((l) => l.trim().replace(/^- /, ""))
      .filter((l) => l && !l.startsWith("---") && !l.startsWith("consumers:"));

    // List available transitions
    const transitionsOut = await runMelt(["-query", "transitions"], 15_000).catch(() => "");
    const transitions = transitionsOut
      .split("\n")
      .map((l) => l.trim().replace(/^- /, ""))
      .filter((l) => l && !l.startsWith("---") && !l.startsWith("transitions:"));

    return {
      meltInstalled: true,
      version,
      ffprobeInstalled: ffprobe,
      ffprobeHint: ffprobe ? undefined : "brew install ffmpeg - needed for media probing",
      consumers: consumers.slice(0, 20),
      transitions: transitions.slice(0, 20),
      renderRoot: RENDER_ROOT,
    };
  },
});

export const kdenliveRender = defineTool({
  namespace: NS,
  access: "write",
  name: "kdenlive_render",
  description:
    "Render a .kdenlive or .mlt project file to mp4. For composing new videos from scratch, use kdenlive_compose instead. Returns the mp4 path; pass it to the media bag's view_video.",
  schema: {
    projectFile: z.string().describe("Path to a .kdenlive or .mlt file"),
    outputName: z
      .string()
      .optional()
      .describe("Output filename (without extension). Defaults to the project name"),
    width: z.number().int().optional().describe("Override output width"),
    height: z.number().int().optional().describe("Override output height"),
    timeoutSeconds: z.number().int().optional().describe("Timeout in seconds (default: 1200)"),
  },
  handler: async ({ projectFile, outputName, width, height, timeoutSeconds }) => {
    const file = expandPath(projectFile);
    if (!existsSync(file)) {
      throw new MeltError(`Project file not found: ${file}`, null, "");
    }

    const ext = extname(file).toLowerCase();
    if (ext !== ".kdenlive" && ext !== ".mlt") {
      throw new MeltError(`Expected a .kdenlive or .mlt file, got: ${ext}`, null, "");
    }

    const slug = slugify(outputName ?? basename(file, ext));
    const outDir = join(RENDER_ROOT, slug);
    mkdirSync(outDir, { recursive: true });
    const videoPath = join(outDir, `${slug}.mp4`);

    const args = [file, "-consumer", `avformat:${videoPath}`];
    args.push("acodec=aac", "vcodec=libx264", "pix_fmt=yuv420p", "crf=18", "movflags=+faststart");

    if (width) args.push(`width=${width}`);
    if (height) args.push(`height=${height}`);

    const started = Date.now();
    await runMelt(args, (timeoutSeconds ?? 1200) * 1000);
    const renderMs = Date.now() - started;

    return {
      videoPath,
      renderSeconds: Number((renderMs / 1000).toFixed(1)),
      nextStep: `Show it with the media bag: view_video ${videoPath}`,
    };
  },
});

export const kdenliveCompose = defineTool({
  namespace: NS,
  access: "write",
  name: "kdenlive_compose",
  description:
    "Compose a video from clips, transitions, and filters — the main creative tool. Describe your tracks (video/audio layers), place clips with in/out points, add transitions between tracks, and apply filters. Builds valid MLT XML and renders to mp4. Returns the mp4 path; pass it to the media bag's view_video.",
  schema: {
    name: z.string().describe("Short name for this composition; used as output directory name"),
    profile: profileSchema.optional().describe("Output profile (default: 1920x1080 @ 24fps)"),
    tracks: z.array(trackSchema).describe(
      "Tracks from bottom (index 0) to top. Video composites top over bottom. Each track has an ordered list of clips and blanks.",
    ),
    transitions: z.array(transitionSchema).optional().describe("Transitions between tracks"),
    filters: z.array(filterSchema).optional().describe("Filters applied to tracks"),
    timeoutSeconds: z.number().int().optional().describe("Render timeout in seconds (default: 1200)"),
  },
  handler: async ({ name, profile, tracks, transitions, filters, timeoutSeconds }) => {
    const p: Profile = {
      width: profile?.width ?? 1920,
      height: profile?.height ?? 1080,
      fps: profile?.fps ?? 24,
    };

    const xml = buildMltXml({
      profile: p,
      tracks: tracks as Track[],
      transitions: transitions as Transition[] | undefined,
      filters: filters as Filter[] | undefined,
    });

    const slug = slugify(name);
    const outDir = join(RENDER_ROOT, slug);
    mkdirSync(outDir, { recursive: true });
    const videoPath = join(outDir, `${slug}.mp4`);

    const started = Date.now();
    await renderMltXml(xml, videoPath, {
      timeoutMs: (timeoutSeconds ?? 1200) * 1000,
    });
    const renderMs = Date.now() - started;

    return {
      videoPath,
      renderSeconds: Number((renderMs / 1000).toFixed(1)),
      profile: `${p.width}x${p.height} @ ${p.fps}fps`,
      tracks: tracks.length,
      transitions: transitions?.length ?? 0,
      filters: filters?.length ?? 0,
      nextStep: `Show it with the media bag: view_video ${videoPath}`,
    };
  },
});

export const kdenliveProjectInfo = defineTool({
  namespace: NS,
  access: "read",
  name: "kdenlive_project_info",
  description:
    "Parse a .kdenlive or .mlt project file and return a structured summary: tracks, clips, effects, transitions, duration, and media references.",
  schema: {
    projectFile: z.string().describe("Path to a .kdenlive or .mlt file"),
  },
  handler: async ({ projectFile }) => {
    const file = expandPath(projectFile);
    if (!existsSync(file)) {
      throw new MeltError(`Project file not found: ${file}`, null, "");
    }

    const content = readFileSync(file, "utf-8");

    // MLT XML has a stable, well-defined schema — elements and their attribute
    // conventions don't vary in the wild. Self-closing tags (<producer ... />)
    // aren't used for producers/playlists/tractors (they always have children),
    // so the body-capturing patterns below are safe.
    const producers = [...content.matchAll(/<producer\s[^>]*?id="([^"]*)"[^>]*>([\s\S]*?)<\/producer>/g)];
    const playlists = [...content.matchAll(/<playlist\s[^>]*?id="([^"]*)"[^>]*>([\s\S]*?)<\/playlist>/g)];
    const tractors = [...content.matchAll(/<tractor\s[^>]*?id="([^"]*)"[^>]*>([\s\S]*?)<\/tractor>/g)];
    // Match both <transition ...>...</transition> and self-closing <transition ... />
    const transitionMatches = [...content.matchAll(/<transition[\s][^>]*(?:\/>|>[\s\S]*?<\/transition>)/g)];
    const filterMatches = [...content.matchAll(/<filter[\s][^>]*(?:\/>|>[\s\S]*?<\/filter>)/g)];

    // Extract producer resources
    const producerInfo = producers.map(([, id, body]) => {
      const resource = extractProperty(body, "resource") ?? "unknown";
      const length = extractProperty(body, "length");
      return { id, resource, length: length ?? undefined };
    });

    // Extract profile — attributes can appear in any order, so pull each
    // individually rather than relying on a fixed sequence.
    const profileTag = content.match(/<profile\s[^>]*?\/?>/);
    const profileInfo = profileTag
      ? {
          width: extractAttr(profileTag[0], "width"),
          height: extractAttr(profileTag[0], "height"),
          fps: extractAttr(profileTag[0], "frame_rate_num"),
        }
      : null;

    return {
      format: file.endsWith(".kdenlive") ? "kdenlive" : "mlt",
      profile: profileInfo,
      producers: producerInfo,
      playlists: playlists.length,
      tractors: tractors.length,
      transitions: transitionMatches.length,
      filters: filterMatches.length,
    };
  },
});

export const kdenliveProbeMedia = defineTool({
  namespace: NS,
  access: "read",
  name: "kdenlive_probe_media",
  description:
    "Probe a media file (video, audio, image) and return its duration, resolution, fps, and codec info. Useful for determining clip lengths and frame counts before composing.",
  schema: {
    filePath: z.string().describe("Path to the media file"),
  },
  handler: async ({ filePath }) => {
    const file = expandPath(filePath);
    return probeMedia(file);
  },
});

export const kdenliveRunMelt = defineTool({
  namespace: NS,
  access: "write",
  name: "kdenlive_run_melt",
  description:
    "Run an arbitrary melt command. The escape hatch for advanced MLT operations not covered by other tools. Returns stdout.",
  schema: {
    args: z.array(z.string()).describe("Arguments to pass to melt"),
    timeoutSeconds: z.number().int().optional().describe("Timeout in seconds (default: 300)"),
  },
  handler: async ({ args, timeoutSeconds }) => {
    const stdout = await runMelt(args, (timeoutSeconds ?? 300) * 1000);

    const output = stdout
      .split("\n")
      .filter((l) => !/^\s*$/.test(l))
      .join("\n")
      .trim();

    return { output: output || "(no output)" };
  },
});

export const kdenliveListTransitions = defineTool({
  namespace: NS,
  access: "read",
  name: "kdenlive_list_transitions",
  description:
    "List available MLT transitions and filters. Use to discover what effects and transitions are available for kdenlive_compose.",
  schema: {
    type: z.enum(["transitions", "filters", "producers"]).describe("What to list"),
  },
  handler: async ({ type }) => {
    const stdout = await runMelt(["-query", type], 15_000);

    const items = stdout
      .split("\n")
      .map((l) => l.trim().replace(/^- /, ""))
      .filter((l) => l && !l.startsWith("---") && !l.startsWith(`${type}:`));

    return { [type]: items };
  },
});

export { MeltError };
