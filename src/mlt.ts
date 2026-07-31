/**
 * MLT XML builder.
 *
 * Generates valid MLT XML documents that melt can render. MLT's model:
 *
 *   producer  — a single media source (video file, image sequence, color)
 *   playlist  — an ordered list of entries (producers or blanks) = one track
 *   tractor   — stacks playlists as tracks; transitions blend between them
 *   consumer  — output target (handled at the melt CLI level, not in XML)
 *
 * A minimal composition: one tractor containing one or more playlists (tracks),
 * each playlist containing producer entries. Transitions connect adjacent
 * tracks (a_track / b_track).
 */

// ---- Public types ----

export interface ClipSource {
  /** Unique id for this producer in the MLT document. Auto-generated if omitted. */
  id?: string;
  /** One of: a file path, an image sequence glob, or a generator string like "color:black". */
  resource: string;
  /** In point in frames (0-based). */
  in?: number;
  /** Out point in frames (inclusive). */
  out?: number;
  /** For image sequences: frames per second. */
  fps?: number;
  /** Additional MLT properties on the producer. */
  properties?: Record<string, string>;
}

export interface Track {
  /** Clips on this track, played in order. Gaps between clips are blanks. */
  clips: TrackEntry[];
  /** Hide audio or video from this track: "video", "audio", or "both". */
  hide?: "video" | "audio" | "both";
}

export type TrackEntry =
  | { type: "clip"; source: ClipSource; }
  | { type: "blank"; length: number; };

export interface Transition {
  /** MLT transition id, e.g. "luma", "composite", "mix", "frei0r.cairoblend". */
  mltId: string;
  /** Lower track index (0-based). */
  aTrack: number;
  /** Upper track index (0-based). */
  bTrack: number;
  /** Start frame. */
  in: number;
  /** End frame (inclusive). */
  out: number;
  /** Additional transition properties. */
  properties?: Record<string, string>;
}

export interface Filter {
  /** MLT filter id, e.g. "brightness", "volume", "frei0r.letterb0xed". */
  mltId: string;
  /** Which track this filter applies to (0-based). */
  track: number;
  /** Start frame. */
  in?: number;
  /** End frame. */
  out?: number;
  /** Filter properties. */
  properties?: Record<string, string>;
}

export interface Composition {
  /** Profile: resolution, fps, pixel aspect ratio. */
  profile: Profile;
  /** Tracks from bottom (0) to top. Video composites top over bottom. */
  tracks: Track[];
  /** Transitions between tracks. */
  transitions?: Transition[];
  /** Filters applied to tracks. */
  filters?: Filter[];
}

export interface Profile {
  width: number;
  height: number;
  fps: number;
  /** Sample aspect ratio numerator (default: 1). */
  sarNum?: number;
  /** Sample aspect ratio denominator (default: 1). */
  sarDen?: number;
  /** Progressive (default) or interlaced. */
  progressive?: boolean;
  /** Display aspect ratio numerator. Computed from width/height if omitted. */
  darNum?: number;
  /** Display aspect ratio denominator. */
  darDen?: number;
  /** Color space (default: 709). */
  colorspace?: number;
}

// ---- XML escaping ----

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attr(name: string, value: string | number | boolean): string {
  return ` ${name}="${esc(String(value))}"`;
}

function propertyTag(name: string, value: string): string {
  return `    <property name="${esc(name)}">${esc(value)}</property>`;
}

// ---- Builder ----

let idCounter = 0;

function nextId(prefix: string): string {
  return `${prefix}_${++idCounter}`;
}

/** Reset the ID counter — useful for deterministic test output. */
export function resetIds(): void {
  idCounter = 0;
}

function buildProfile(p: Profile): string {
  const w = p.width;
  const h = p.height;
  const darNum = p.darNum ?? w;
  const darDen = p.darDen ?? h;

  return [
    `  <profile`,
    attr("width", w),
    attr("height", h),
    attr("frame_rate_num", p.fps),
    attr("frame_rate_den", 1),
    attr("sample_aspect_num", p.sarNum ?? 1),
    attr("sample_aspect_den", p.sarDen ?? 1),
    attr("display_aspect_num", darNum),
    attr("display_aspect_den", darDen),
    attr("progressive", p.progressive !== false ? 1 : 0),
    attr("colorspace", p.colorspace ?? 709),
    ` />`,
  ].join("");
}

function buildProducer(clip: ClipSource): { id: string; xml: string } {
  const id = clip.id ?? nextId("producer");
  const lines = [`  <producer${attr("id", id)}>`];

  lines.push(propertyTag("resource", clip.resource));

  if (clip.in != null) lines.push(propertyTag("in", String(clip.in)));
  if (clip.out != null) lines.push(propertyTag("out", String(clip.out)));
  if (clip.fps != null) lines.push(propertyTag("fps", String(clip.fps)));

  if (clip.properties) {
    for (const [k, v] of Object.entries(clip.properties)) {
      lines.push(propertyTag(k, v));
    }
  }

  lines.push("  </producer>");
  return { id, xml: lines.join("\n") };
}

function buildPlaylist(track: Track, trackIndex: number): { id: string; xml: string; producerXmls: string[] } {
  const playlistId = `playlist_${trackIndex}`;
  const producerXmls: string[] = [];
  const entries: string[] = [];

  for (const entry of track.clips) {
    if (entry.type === "blank") {
      entries.push(`    <blank${attr("length", entry.length)} />`);
    } else {
      const { id: prodId, xml: prodXml } = buildProducer(entry.source);
      producerXmls.push(prodXml);

      let entryAttrs = attr("producer", prodId);
      if (entry.source.in != null) entryAttrs += attr("in", entry.source.in);
      if (entry.source.out != null) entryAttrs += attr("out", entry.source.out);
      entries.push(`    <entry${entryAttrs} />`);
    }
  }

  const lines = [`  <playlist${attr("id", playlistId)}>`];
  lines.push(...entries);
  lines.push("  </playlist>");

  return { id: playlistId, xml: lines.join("\n"), producerXmls };
}

/**
 * Build a complete MLT XML document from a composition description.
 */
export function buildMltXml(comp: Composition): string {
  resetIds();

  const allProducerXmls: string[] = [];
  const playlistXmls: string[] = [];
  const playlistIds: string[] = [];

  // Build playlists (tracks) bottom to top
  for (let i = 0; i < comp.tracks.length; i++) {
    const { id, xml, producerXmls } = buildPlaylist(comp.tracks[i], i);
    allProducerXmls.push(...producerXmls);
    playlistXmls.push(xml);
    playlistIds.push(id);
  }

  // Tractor stacks the playlists
  const tractorId = "tractor_main";
  const tractorLines = [`  <tractor${attr("id", tractorId)}>`];

  // Multitrack
  tractorLines.push("    <multitrack>");
  for (let i = 0; i < playlistIds.length; i++) {
    let trackAttrs = attr("producer", playlistIds[i]);
    const track = comp.tracks[i];
    if (track.hide) trackAttrs += attr("hide", track.hide);
    tractorLines.push(`      <track${trackAttrs} />`);
  }
  tractorLines.push("    </multitrack>");

  // Transitions
  if (comp.transitions) {
    for (const t of comp.transitions) {
      let tAttrs = attr("mlt_service", t.mltId);
      tAttrs += attr("a_track", t.aTrack);
      tAttrs += attr("b_track", t.bTrack);
      tAttrs += attr("in", t.in);
      tAttrs += attr("out", t.out);
      const tLines = [`    <transition${tAttrs}>`];
      if (t.properties) {
        for (const [k, v] of Object.entries(t.properties)) {
          tLines.push(`      ${propertyTag(k, v)}`);
        }
      }
      tLines.push("    </transition>");
      tractorLines.push(tLines.join("\n"));
    }
  }

  // Filters
  if (comp.filters) {
    for (const f of comp.filters) {
      let fAttrs = attr("mlt_service", f.mltId);
      fAttrs += attr("track", f.track);
      if (f.in != null) fAttrs += attr("in", f.in);
      if (f.out != null) fAttrs += attr("out", f.out);
      const fLines = [`    <filter${fAttrs}>`];
      if (f.properties) {
        for (const [k, v] of Object.entries(f.properties)) {
          fLines.push(`      ${propertyTag(k, v)}`);
        }
      }
      fLines.push("    </filter>");
      tractorLines.push(fLines.join("\n"));
    }
  }

  tractorLines.push("  </tractor>");

  // Assemble
  const doc = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<mlt>`,
    buildProfile(comp.profile),
    ...allProducerXmls,
    ...playlistXmls,
    tractorLines.join("\n"),
    `</mlt>`,
  ];

  return doc.join("\n");
}

/**
 * Build a minimal single-clip MLT XML for rendering a file or image sequence.
 */
export function buildSimpleRenderXml(
  resource: string,
  profile: Profile,
  options?: { in?: number; out?: number; properties?: Record<string, string> },
): string {
  return buildMltXml({
    profile,
    tracks: [{
      clips: [{
        type: "clip",
        source: {
          resource,
          in: options?.in,
          out: options?.out,
          properties: options?.properties,
        },
      }],
    }],
  });
}
