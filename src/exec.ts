import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class MeltError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "MeltError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000;

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
  installHint: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new MeltError(installHint, null, ""));
            return;
          }
          if ((error as { signal?: string | null }).signal === "SIGTERM") {
            reject(
              new MeltError(
                `${bin} timed out after ${Math.round(timeoutMs / 1000)}s. Try reducing resolution or clip count.`,
                null,
                stderr,
              ),
            );
            return;
          }
          reject(
            new MeltError(
              `${bin} failed: ${lastLine(stderr) || lastLine(stdout) || error.message}`,
              typeof error.code === "number" ? error.code : null,
              stderr,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function lastLine(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines.slice(-3).join(" | ") : "";
}

export function runMelt(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return run(
    "melt",
    args,
    timeoutMs,
    "melt is not installed. Install it: brew install mlt",
  );
}

/**
 * Render an MLT XML document to a file. Writes the XML to a temp file and
 * invokes melt with the appropriate consumer args.
 */
export async function renderMltXml(
  xml: string,
  outputPath: string,
  options?: { timeoutMs?: number },
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "barry-kdenlive-"));
  const xmlPath = join(dir, "project.mlt");
  writeFileSync(xmlPath, xml, "utf-8");

  const args = [
    xmlPath,
    "-consumer",
    `avformat:${outputPath}`,
    "acodec=aac",
    "vcodec=libx264",
    "pix_fmt=yuv420p",
    "crf=18",
    "movflags=+faststart",
    "properties=x264-medium",
  ];

  return runMelt(args, options?.timeoutMs);
}

export function runFfprobe(args: string[], timeoutMs = 30_000): Promise<string> {
  return run(
    "ffprobe",
    args,
    timeoutMs,
    "ffprobe is not installed. Install it: brew install ffmpeg",
  );
}

export async function isMeltInstalled(): Promise<boolean> {
  try {
    await runMelt(["-version"], 15_000);
    return true;
  } catch {
    return false;
  }
}

export async function isFfprobeInstalled(): Promise<boolean> {
  try {
    await runFfprobe(["-version"], 15_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe a media file with ffprobe and return structured metadata.
 */
export async function probeMedia(filePath: string): Promise<{
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  audioCodec: string | null;
}> {
  if (!existsSync(filePath)) {
    throw new MeltError(`File not found: ${filePath}`, null, "");
  }

  const stdout = await runFfprobe([
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const info = JSON.parse(stdout);
  const video = info.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  const audio = info.streams?.find((s: { codec_type: string }) => s.codec_type === "audio");

  let fps: number | null = null;
  if (video?.r_frame_rate) {
    const [num, den] = video.r_frame_rate.split("/").map(Number);
    if (den && den > 0) fps = Math.round((num / den) * 100) / 100;
  }

  return {
    duration: info.format?.duration ? parseFloat(info.format.duration) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps,
    codec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}
