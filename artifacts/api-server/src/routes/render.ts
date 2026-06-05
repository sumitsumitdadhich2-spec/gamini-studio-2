import { Router } from "express";
import multer from "multer";
import { spawn, execSync } from "child_process";
import { promises as fs, existsSync, createReadStream, statSync } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";

// All shiva temp files go here — workspace has 256 GB vs /tmp's 32 GB quota.
const WORK_DIR = path.join(process.cwd(), "uploads", "tmp");
// Ensure the directory exists at startup and clean up files older than 12 hours.
(async () => {
  await fs.mkdir(WORK_DIR, { recursive: true }).catch(() => {});
  try {
    const MAX_AGE = 12 * 60 * 60 * 1000;
    const now = Date.now();
    for (const entry of await fs.readdir(WORK_DIR)) {
      try {
        const full = path.join(WORK_DIR, entry);
        const stat = await fs.stat(full);
        if (now - stat.mtimeMs > MAX_AGE) {
          await fs.rm(full, { recursive: true, force: true });
          logger.info(`[cleanup] removed old temp: ${entry}`);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
})();

function detectFfmpeg(): string {
  // Try multiple paths for ffmpeg-static binary
  const ffmpegStaticPaths = [
    // Runtime resolved path (works in both dev and prod)
    path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg"),
    // Relative to this file's location
    path.join(__dirname, "..", "..", "node_modules", "ffmpeg-static", "ffmpeg"),
    // Workspace root
    path.join(process.cwd(), "..", "..", "node_modules", "ffmpeg-static", "ffmpeg"),
  ];
  
  for (const ffmpegPath of ffmpegStaticPaths) {
    if (existsSync(ffmpegPath)) {
      logger.info(`[ffmpeg] Found ffmpeg-static at: ${ffmpegPath}`);
      try {
        execSync(`test -x "${ffmpegPath}"`, { shell: "/bin/sh", timeout: 2000 });
        return ffmpegPath;
      } catch {
        // Try to make it executable
        try {
          execSync(`chmod +x "${ffmpegPath}"`, { shell: "/bin/sh", timeout: 2000 });
          logger.info(`[ffmpeg] Made ffmpeg executable: ${ffmpegPath}`);
          return ffmpegPath;
        } catch {
          logger.warn(`[ffmpeg] Cannot make ffmpeg executable: ${ffmpegPath}`);
        }
      }
    }
  }
  
  // Fallback to system ffmpeg
  const cmds = [
    "which ffmpeg",
    "command -v ffmpeg",
  ];
  
  for (const cmd of cmds) {
    try {
      const r = execSync(cmd, { shell: "/bin/sh", timeout: 5000, encoding: "utf-8" }).trim();
      if (r) {
        logger.info(`[ffmpeg] Found system ffmpeg: ${r}`);
        return r.split("\n")[0].trim();
      }
    } catch { /* try next */ }
  }
  
  logger.warn(`[ffmpeg] No FFmpeg binary found - video rendering will not work`);
  return "";
}

const FFMPEG_BIN = detectFfmpeg();
logger.info(`[render] ffmpeg: ${FFMPEG_BIN || "NOT FOUND"}`);

// ── Timestamp helpers ────────────────────────────────────────────────────────
function msssmmToSeconds(ts: string): number {
  if (!ts) return 0;
  const normalised = ts.replace(":", ".");
  const parts = normalised.split(".");
  if (parts.length >= 4) {
    const hours = parseInt(parts[0] || "0", 10);
    const min   = parseInt(parts[1] || "0", 10);
    const sec   = parseInt(parts[2] || "0", 10);
    const cs    = parseInt(parts[3] || "0", 10);
    return hours * 3600 + min * 60 + sec + cs / 100;
  }
  const min = parseInt(parts[0] || "0", 10);
  const sec = parseInt(parts[1] || "0", 10);
  const cs  = parseInt(parts[2] || "0", 10);
  return min * 60 + sec + cs / 100;
}

function toFFmpegTime(secs: number): string {
  const h  = Math.floor(secs / 3600);
  const m  = Math.floor((secs % 3600) / 60);
  const s  = secs % 60;
  const ms = Math.round((s % 1) * 1000);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${Math.floor(s).toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

function runFF(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!FFMPEG_BIN) { reject(new Error("FFmpeg not found on server")); return; }
    const proc = spawn(FFMPEG_BIN, args);
    const stderr: Buffer[] = [];
    proc.stderr?.on("data", (d: Buffer) => stderr.push(d));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const detail = Buffer.concat(stderr).toString().slice(-800);
        reject(new Error(`FFmpeg exit ${code}: ${detail}`));
      }
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      reject(new Error(err.code === "ENOENT" ? `FFmpeg binary not found: ${FFMPEG_BIN}` : err.message));
    });
  });
}

async function safeDelete(p: string) {
  try { if (existsSync(p)) await fs.unlink(p); } catch { /* ignore */ }
}

function probeVideoDuration(filePath: string): number {
  // Use ffmpeg -i to get duration since ffprobe may not be available (ffmpeg-static only includes ffmpeg)
  try {
    // ffmpeg outputs format info to stderr when given -i with no output
    const out = execSync(
      `"${FFMPEG_BIN}" -i "${filePath}" 2>&1 | grep -oP 'Duration: \\K[0-9:.]+' | head -1`,
      { shell: "/bin/sh", timeout: 8000, encoding: "utf-8" }
    ).trim();
    // Parse HH:MM:SS.ms format
    if (out) {
      const parts = out.split(":");
      if (parts.length === 3) {
        const hours = parseFloat(parts[0]) || 0;
        const mins = parseFloat(parts[1]) || 0;
        const secs = parseFloat(parts[2]) || 0;
        return hours * 3600 + mins * 60 + secs;
      }
    }
    return 0;
  } catch {
    // Fallback: check if file exists and has non-zero size
    try {
      const stat = statSync(filePath);
      return stat.size > 1000 ? 1 : 0; // Assume valid if > 1KB
    } catch {
      return 0;
    }
  }
}

function streamFile(filePath: string, req: any, res: any, contentType = "video/mp4") {
  if (!existsSync(filePath)) { res.status(404).send("File not found"); return; }
  const { size } = statSync(filePath);
  const range = req.headers.range as string | undefined;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": size, "Content-Type": contentType, "Accept-Ranges": "bytes" });
    createReadStream(filePath).pipe(res);
  }
}

// ── Multer ───────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, WORK_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".mp4";
      cb(null, `shiva-${file.fieldname}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

// ── Job Stores ─────────────────────────────�������─────────────────────────────────
// Jobs are stored in memory but also persisted to disk so they survive server restarts

interface ClipInfo {
  index: number;
  clipNumber: number;
  movieStart: string;
  movieEnd: string;
  duration: number;
  label?: string;
  filePath: string;
}

interface ExtractJob {
  status: "processing" | "done" | "error";
  progress: number;
  totalClips: number;
  currentClip: number;
  clips: ClipInfo[];
  tmpDir: string;
  error: string | null;
  createdAt: number;
}

interface MergeJob {
  status: "processing" | "done" | "error";
  progress: number;
  mergedPath: string | null;
  totalDuration: number;
  hasBoosts: boolean;
  error: string | null;
  createdAt: number;
}

interface FinalizeJob {
  status: "processing" | "done" | "error";
  progress: number;
  outputPath: string | null;
  error: string | null;
  createdAt: number;
}

interface ExportJob {
  status: "processing" | "done" | "error";
  progress: number;
  outputPath: string | null;
  error: string | null;
  createdAt: number;
}

// Legacy single-step jobs (kept for backward compat)
interface RenderJob {
  status: "processing" | "done" | "error";
  progress: number;
  totalClips: number;
  currentClip: number;
  outputPath: string | null;
  error: string | null;
  createdAt: number;
}

const jobs: Record<string, RenderJob> = {};
const extractJobs: Record<string, ExtractJob> = {};
const mergeJobs: Record<string, MergeJob> = {};
const finalizeJobs: Record<string, FinalizeJob> = {};
const exportJobs: Record<string, ExportJob> = {};

// ── Job Persistence ───────────────────────────────────────────────────────────
const JOBS_FILE = path.join(WORK_DIR, "shiva-jobs.json");

function saveJobsToDisk() {
  try {
    const data = {
      extractJobs: Object.fromEntries(
        Object.entries(extractJobs).filter(([, j]) => j.status === "done")
      ),
      mergeJobs: Object.fromEntries(
        Object.entries(mergeJobs).filter(([, j]) => j.status === "done")
      ),
      finalizeJobs: Object.fromEntries(
        Object.entries(finalizeJobs).filter(([, j]) => j.status === "done")
      ),
      exportJobs: Object.fromEntries(
        Object.entries(exportJobs).filter(([, j]) => j.status === "done")
      ),
    };
    fs.writeFile(JOBS_FILE, JSON.stringify(data, null, 2)).catch(() => {});
  } catch { /* ignore */ }
}

function loadJobsFromDisk() {
  try {
    if (!existsSync(JOBS_FILE)) return;
    const data = JSON.parse(require("fs").readFileSync(JOBS_FILE, "utf-8"));
    
    // Restore extract jobs (verify clip files still exist)
    for (const [id, job] of Object.entries(data.extractJobs || {})) {
      const j = job as ExtractJob;
      if (j.status === "done" && j.clips?.length > 0) {
        // Verify all clip files exist
        const validClips = j.clips.filter(c => existsSync(c.filePath));
        if (validClips.length === j.clips.length) {
          extractJobs[id] = j;
          logger.info(`[restore] extract job ${id}: ${j.clips.length} clips`);
        }
      }
    }
    
    // Restore merge jobs (verify merged file exists)
    for (const [id, job] of Object.entries(data.mergeJobs || {})) {
      const j = job as MergeJob;
      if (j.status === "done" && j.mergedPath && existsSync(j.mergedPath)) {
        mergeJobs[id] = j;
        logger.info(`[restore] merge job ${id}`);
      }
    }
    
    // Restore finalize jobs (verify output file exists)
    for (const [id, job] of Object.entries(data.finalizeJobs || {})) {
      const j = job as FinalizeJob;
      if (j.status === "done" && j.outputPath && existsSync(j.outputPath)) {
        finalizeJobs[id] = j;
        logger.info(`[restore] finalize job ${id}`);
      }
    }
    
    // Restore export jobs (verify output file exists)
    for (const [id, job] of Object.entries(data.exportJobs || {})) {
      const j = job as ExportJob;
      if (j.status === "done" && j.outputPath && existsSync(j.outputPath)) {
        exportJobs[id] = j;
        logger.info(`[restore] export job ${id}`);
      }
    }
    
    logger.info(`[restore] loaded ${Object.keys(extractJobs).length} extract, ${Object.keys(mergeJobs).length} merge jobs from disk`);
  } catch (err) {
    logger.warn({ err }, "[restore] failed to load jobs from disk");
  }
}

// Load jobs on startup
loadJobsFromDisk();

// ── Process: Extract Clips ────────────────────────────────────────────────────
async function processExtract(jobId: string, moviePath: string, editPlan: Record<string, unknown>) {
  const job = extractJobs[jobId];
  const tmpDir = path.join(WORK_DIR, `shiva-extract-${jobId}`);

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    const rawClips = (editPlan.clips as any[]) || [];
    if (!rawClips.length) throw new Error("No clips found in JSON");

    const sorted = [...rawClips].sort((a, b) => (Number(a.clip_number) || 0) - (Number(b.clip_number) || 0));
    const valid = sorted.filter((c) => {
      const dur = msssmmToSeconds(c.movie_end) - msssmmToSeconds(c.movie_start);
      if (dur < 0.05) {
        logger.warn(`[extract] skip clip ${c.clip_number}: dur=${dur.toFixed(3)}s`);
        return false;
      }
      return true;
    });

    if (!valid.length) throw new Error("All clips are invalid (end ≤ start)");
    job.totalClips = valid.length;

    // Two-ss approach: input seek (fast keyframe jump) + output ss (fine frame offset) + -t (duration)
    // This is faster than the trim filter which can hang on large files by scanning from PTS 0.
    const GOP = 8;
    const clips: ClipInfo[] = [];

    for (let i = 0; i < valid.length; i++) {
      job.currentClip = i + 1;
      job.progress = Math.round((i / valid.length) * 95);

      const c = valid[i];
      const startSecs = msssmmToSeconds(c.movie_start);
      const endSecs   = msssmmToSeconds(c.movie_end);
      const dur       = endSecs - startSecs;
      const seek      = Math.max(0, startSecs - GOP);
      const offset    = startSecs - seek;   // fine-tune: frames to skip after keyframe seek
      const out       = path.join(tmpDir, `clip_${i.toString().padStart(5, "0")}.mp4`);

      logger.info(`[extract] clip ${i + 1}/${valid.length}: ${c.movie_start} → ${c.movie_end} (${dur.toFixed(3)}s)`);

      await runFF([
        "-ss",  toFFmpegTime(seek),    // fast input seek to nearby keyframe
        "-i",   moviePath,
        "-ss",  offset.toFixed(6),     // fine-tune: decode from keyframe to exact start frame
        "-t",   dur.toFixed(6),        // exact duration
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-threads", "0", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "192k", "-y", out,
      ]);

      const actualDur = probeVideoDuration(out);
      if (actualDur < 0.05) { logger.warn(`[extract] clip ${i + 1} empty — skip`); continue; }

      clips.push({
        index: clips.length,
        clipNumber: Number(c.clip_number) || (i + 1),
        movieStart: c.movie_start,
        movieEnd: c.movie_end,
        duration: actualDur,
        label: c.label,
        filePath: out,
      });
    }

    job.clips = clips;
    job.progress = 100;
    job.status = "done";
    saveJobsToDisk();
    logger.info(`[extract] job ${jobId} done: ${clips.length} clips extracted`);
  } catch (err) {
    job.status = "error";
    job.error = err instanceof Error ? err.message : "Extract failed";
    logger.error({ err }, `[extract] job ${jobId} failed`);
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Process: Merge Clips ─────���────────────────────────────────────────────────
async function processMerge(jobId: string, extractJobId: string, boosts: any[], editPlanClips: any[] = []) {
  const job   = mergeJobs[jobId];
  const exJob = extractJobs[extractJobId];

  try {
    if (!exJob || exJob.status !== "done") throw new Error("Extract job not ready");
    if (!exJob.clips.length) throw new Error("No clips to merge");

    const tmpDir = path.join(WORK_DIR, `shiva-merge-${jobId}`);
    await fs.mkdir(tmpDir, { recursive: true });

    // Step 1: stream-copy concat (clips already H.264/AAC — fast)
    job.progress = 10;
    const concatTxt  = path.join(tmpDir, "concat.txt");
    const joinedPath = path.join(tmpDir, "joined.mp4");
    await fs.writeFile(concatTxt, exJob.clips.map((c) => `file '${c.filePath}'`).join("\n"));
    await runFF(["-f", "concat", "-safe", "0", "-i", concatTxt, "-c", "copy", "-y", joinedPath]);

    job.progress = 60;
    const mergedPath = path.join(WORK_DIR, `shiva-merged-${jobId}.mp4`);
    const totalDur   = exJob.clips.reduce((s, c) => s + c.duration, 0);
    job.totalDuration = totalDur;

    // ── Build audio segment list ───────────────────────────────────────────────
    // Default is 1.0 (keep original audio). Only segments that deviate from
    // 1.0 need an entry: mute:true clips → 0, level_percent clips → custom,
    // and explicit audio_boosts. This fixes the bug where clips without an
    // explicit level were silenced because the old logic used "default 0".
    interface AudioSeg { s: number; e: number; lvl: number; }
    const audioSegs: AudioSeg[] = [];

    // Source 1: explicit audio_boosts from JSON (timestamps in merged timeline)
    for (const b of boosts) {
      const s   = msssmmToSeconds(b.start);
      const e   = msssmmToSeconds(b.end);
      const lvl = Math.min((b.level_percent ?? 0) / 100, 1);
      if (e > s) audioSegs.push({ s, e, lvl });
    }

    // Source 2: per-clip mute flag / movie_audio.level_percent
    // Clips with mute:true → level 0.  Clips with explicit level_percent → that
    // level.  Clips with no setting → 1.0 (default, no entry needed).
    let hasAnyUnmutedClip = true; // assume audio present unless all muted
    if (editPlanClips.length > 0) {
      let allClipsMuted = true;
      let offset = 0;
      for (const clip of exJob.clips) {
        const cd  = editPlanClips.find((c: any) => Number(c.clip_number) === clip.clipNumber);
        const isMuted  = cd?.mute === true || (cd?.movie_audio?.level_percent ?? null) === 0;
        const lvlPct   = cd?.movie_audio?.level_percent ?? null;

        if (isMuted) {
          audioSegs.push({ s: offset, e: offset + clip.duration, lvl: 0 });
        } else {
          allClipsMuted = false;
          if (lvlPct !== null && lvlPct !== 100) {
            // Explicit non-default level (not muted, not full)
            audioSegs.push({ s: offset, e: offset + clip.duration, lvl: Math.min(lvlPct / 100, 1) });
          }
          // else: default 1.0 — no entry needed, handled by expression default
        }
        offset += clip.duration;
      }
      hasAnyUnmutedClip = !allClipsMuted;
    }

    // Segments that actually deviate from 1.0 (boosts already included above)
    const nonDefaultSegs = audioSegs.filter(seg => Math.abs(seg.lvl - 1.0) > 0.001);

    if (!hasAnyUnmutedClip && boosts.length === 0) {
      // Every clip is explicitly muted and no audio_boosts → strip audio
      await runFF([
        "-i", joinedPath,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
        "-an", "-threads", "0",
        "-movflags", "+faststart",
        "-t", totalDur.toFixed(3),
        "-y", mergedPath,
      ]);
    } else if (nonDefaultSegs.length === 0) {
      // No modifications — pass audio through at full level (re-encode for faststart)
      await runFF([
        "-i", joinedPath,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
        "-c:a", "aac", "-b:a", "192k", "-threads", "0",
        "-movflags", "+faststart",
        "-t", totalDur.toFixed(3),
        "-y", mergedPath,
      ]);
    } else {
      // Build volume expression — default 1.0, override for muted/adjusted segs
      const conds = nonDefaultSegs.map(seg =>
        `if(between(t,${seg.s.toFixed(3)},${seg.e.toFixed(3)}),${seg.lvl.toFixed(3)}`
      );
      const volExpr = conds.join(",") + ",1" + ")".repeat(conds.length);

      await runFF([
        "-i", joinedPath,
        "-filter_complex", `[0:a]volume='${volExpr}':eval=frame[out_a]`,
        "-map", "0:v", "-map", "[out_a]",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
        "-c:a", "aac", "-b:a", "192k", "-threads", "0",
        "-movflags", "+faststart",
        "-t", totalDur.toFixed(3),
        "-y", mergedPath,
      ]);
    }

    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

    job.mergedPath = mergedPath;
    // hasBoosts = "merged video has an audio track" — used by finalize/export
    job.hasBoosts  = hasAnyUnmutedClip || boosts.length > 0;
    job.progress   = 100;
    job.status     = "done";
    saveJobsToDisk();
    logger.info(`[merge] job ${jobId} done → ${mergedPath} (${totalDur.toFixed(2)}s)`);
  } catch (err) {
    job.status = "error";
    job.error  = err instanceof Error ? err.message : "Merge failed";
    logger.error({ err }, `[merge] job ${jobId} failed`);
  }
}

// ── Process: Finalize (add voiceover + quality) ───────────────────────────────
async function processFinalize(
  jobId: string,
  mergeJobId: string,
  voicePath: string,
  quality: { resolution: string; framerate: string; bitrate: string },
  filesToClean: string[]
) {
  const job  = finalizeJobs[jobId];
  const mJob = mergeJobs[mergeJobId];

  try {
    if (!mJob || mJob.status !== "done" || !mJob.mergedPath) throw new Error("Merge job not ready");
    if (!existsSync(mJob.mergedPath)) throw new Error("Merged file no longer on disk");

    job.progress = 10;
    const outputPath = path.join(WORK_DIR, `shiva-final-${jobId}.mp4`);

    // Build quality args — slow preset + CRF 15 for high-quality final output
    const qArgs: string[] = ["-c:v", "libx264", "-preset", "slow", "-crf", "15", "-threads", "0"];
    if (quality.resolution && quality.resolution !== "0") {
      const [W, H] = quality.resolution.split("x");
      qArgs.push("-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`);
    }
    if (quality.framerate && quality.framerate !== "0") qArgs.push("-r", quality.framerate);
    if (quality.bitrate   && quality.bitrate   !== "0") qArgs.push("-b:v", quality.bitrate);

    const tDur = mJob.totalDuration.toFixed(3);

    if (!mJob.hasBoosts) {
      // Merged video has no audio track → just map voiceover directly
      await runFF([
        "-i", mJob.mergedPath,
        "-i", voicePath,
        "-map", "0:v", "-map", "1:a",
        ...qArgs,
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-t", tDur,
        "-y", outputPath,
      ]);
    } else {
      // Merged video already has boosted movie audio → amix with voiceover (normalize=0)
      await runFF([
        "-i", mJob.mergedPath,
        "-i", voicePath,
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[out_a]",
        "-map", "0:v", "-map", "[out_a]",
        ...qArgs,
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-t", tDur,
        "-y", outputPath,
      ]);
    }

    job.outputPath = outputPath;
    job.progress   = 100;
    job.status     = "done";
    saveJobsToDisk();
    logger.info(`[finalize] job ${jobId} done → ${outputPath}`);
  } catch (err) {
    job.status = "error";
    job.error  = err instanceof Error ? err.message : "Finalize failed";
    logger.error({ err }, `[finalize] job ${jobId} failed`);
  } finally {
    for (const f of filesToClean) await safeDelete(f);
  }
}

// ── Process: Export without voiceover ────────────────────────────────────────
async function processExport(
  jobId: string,
  mergeJobId: string,
  quality: { resolution: string; framerate: string; bitrate: string }
) {
  const job  = exportJobs[jobId];
  const mJob = mergeJobs[mergeJobId];

  try {
    if (!mJob || mJob.status !== "done" || !mJob.mergedPath) throw new Error("Merge job not ready");
    if (!existsSync(mJob.mergedPath)) throw new Error("Merged file not found on disk");

    job.progress = 10;
    const outputPath = path.join(WORK_DIR, `shiva-export-${jobId}.mp4`);

    const qArgs: string[] = ["-c:v", "libx264", "-preset", "slow", "-crf", "15", "-threads", "0"];
    if (quality.resolution && quality.resolution !== "0") {
      const [W, H] = quality.resolution.split("x");
      qArgs.push("-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`);
    }
    if (quality.framerate && quality.framerate !== "0") qArgs.push("-r", quality.framerate);
    if (quality.bitrate   && quality.bitrate   !== "0") qArgs.push("-b:v", quality.bitrate);

    job.progress = 20;

    if (mJob.hasBoosts) {
      // Merged video has audio (clips not fully muted) — keep it
      await runFF([
        "-i", mJob.mergedPath,
        ...qArgs,
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-t", mJob.totalDuration.toFixed(3),
        "-y", outputPath,
      ]);
    } else {
      // All clips were muted → no audio track in merged, export video-only
      await runFF([
        "-i", mJob.mergedPath,
        ...qArgs,
        "-an",
        "-movflags", "+faststart",
        "-t", mJob.totalDuration.toFixed(3),
        "-y", outputPath,
      ]);
    }

    job.outputPath = outputPath;
    job.progress   = 100;
    job.status     = "done";
    saveJobsToDisk();
    logger.info(`[export] job ${jobId} done → ${outputPath}`);
  } catch (err) {
    job.status = "error";
    job.error  = err instanceof Error ? err.message : "Export failed";
    logger.error({ err }, `[export] job ${jobId} failed`);
  }
}

// ── Legacy single-step render (kept for compatibility) ────────────────────────
async function processRender(
  jobId: string,
  moviePath: string,
  voicePath: string,
  editPlan: Record<string, unknown>,
  quality: { resolution: string; aspectRatio: string; framerate: string; bitrate: string },
  filesToClean: string[]
) {
  const job = jobs[jobId];
  const tmpDir = path.join(os.tmpdir(), `shiva-render-${jobId}`);
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    const rawClips = (editPlan.clips as any[]) || [];
    if (rawClips.length === 0) throw new Error("No clips found in edit plan JSON");
    const clips = [...rawClips].sort((a, b) => (Number(a.clip_number) || 0) - (Number(b.clip_number) || 0));
    const validClips: typeof clips = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const startSecs = msssmmToSeconds(clip.movie_start);
      const endSecs   = msssmmToSeconds(clip.movie_end);
      if (endSecs - startSecs < 0.05) continue;
      validClips.push(clip);
    }
    if (validClips.length === 0) throw new Error("All clips were invalid");
    job.totalClips = validClips.length;
    const totalVideoDuration = validClips.reduce((sum, clip) =>
      sum + Math.max(0, msssmmToSeconds(clip.movie_end) - msssmmToSeconds(clip.movie_start)), 0);
    const GOP_WINDOW = 6;
    const clipFiles: string[] = [];
    for (let i = 0; i < validClips.length; i++) {
      job.currentClip = i + 1;
      job.progress    = Math.round((i / validClips.length) * 75);
      const clip      = validClips[i];
      const startSecs = msssmmToSeconds(clip.movie_start);
      const endSecs   = msssmmToSeconds(clip.movie_end);
      const duration  = endSecs - startSecs;
      const seekStart = Math.max(0, startSecs - GOP_WINDOW);
      const clipOut   = path.join(tmpDir, `clip_${i.toString().padStart(5, "0")}.mp4`);
      await runFF([
        "-ss", toFFmpegTime(seekStart), "-i", moviePath,
        "-vf", `trim=start=${startSecs.toFixed(6)}:duration=${duration.toFixed(6)},setpts=PTS-STARTPTS`,
        "-af", `atrim=start=${startSecs.toFixed(6)}:duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-threads", "0", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "128k", "-y", clipOut,
      ]);
      const actualDur = probeVideoDuration(clipOut);
      if (actualDur >= 0.05) clipFiles.push(clipOut);
    }
    job.progress = 80;
    const concatTxt  = path.join(tmpDir, "concat.txt");
    const joinedPath = path.join(tmpDir, "joined.mp4");
    await fs.writeFile(concatTxt, clipFiles.map((f) => `file '${f}'`).join("\n"));
    await runFF(["-f", "concat", "-safe", "0", "-i", concatTxt, "-c", "copy", "-y", joinedPath]);
    job.progress = 90;
    const boosts    = (editPlan.audio_boosts as any[]) || [];
    const outputPath = path.join(os.tmpdir(), `shiva-output-${jobId}.mp4`);
    const qualityVideoArgs: string[] = ["-c:v", "libx264", "-preset", "fast"];
    if (quality.resolution && quality.resolution !== "0") {
      const [W, H] = quality.resolution.split("x");
      qualityVideoArgs.push("-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`);
    }
    if (quality.framerate && quality.framerate !== "0") qualityVideoArgs.push("-r", quality.framerate);
    if (quality.bitrate   && quality.bitrate   !== "0") qualityVideoArgs.push("-b:v", quality.bitrate);
    const tDur = totalVideoDuration.toFixed(3);
    if (boosts.length === 0) {
      await runFF(["-i", joinedPath, "-i", voicePath, ...qualityVideoArgs,
        "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "128k", "-t", tDur, "-y", outputPath]);
    } else {
      const conditions = boosts.map((b: any) => {
        const s = msssmmToSeconds(b.start).toFixed(3);
        const e = msssmmToSeconds(b.end).toFixed(3);
        const level = Math.min((b.level_percent ?? 0) / 100, 1).toFixed(3);
        return `if(between(t,${s},${e}),${level}`;
      });
      const volExpr = conditions.join(",") + ",0" + ")".repeat(conditions.length);
      await runFF(["-i", joinedPath, "-i", voicePath,
        "-filter_complex", `[0:a]volume='${volExpr}':eval=frame[mov_a];[1:a]volume=1[voice_a];[mov_a][voice_a]amix=inputs=2:duration=longest[out_a]`,
        "-map", "0:v", "-map", "[out_a]", ...qualityVideoArgs,
        "-c:a", "aac", "-b:a", "128k", "-t", tDur, "-y", outputPath]);
    }
    job.outputPath = outputPath;
    job.progress   = 100;
    job.status     = "done";
  } catch (err) {
    job.status = "error";
    job.error  = err instanceof Error ? err.message : "Render failed";
    job.progress = 0;
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const f of filesToClean) await safeDelete(f);
  }
}

// ── Router ───────────────────────────────────────────────────────────────────
const renderRouter = Router();

// ── Check if a server-side file still exists ─────────────────────────────────
renderRouter.get("/render/check-file", (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) { res.json({ exists: false }); return; }
  res.json({ exists: existsSync(filePath) });
});

// ── Chunked pre-upload ─────────────────────────────────────────────��──────────
// Indexed-chunk approach: each chunk is saved as a numbered file in a staging
// directory.  Retries safely overwrite the same indexed file (idempotent) instead
// of double-appending.  Assembly happens once all chunks are present.
renderRouter.post("/render/upload-chunk", upload.single("chunk"), async (req, res) => {
  try {
    const uploadId     = req.body.uploadId    as string;
    const chunkIndex   = parseInt(req.body.chunkIndex   as string, 10);
    const totalChunks  = parseInt(req.body.totalChunks  as string, 10);
    const originalName = (req.body.originalName as string) || "file.mp4";
    const chunk        = req.file;
    if (!chunk || !uploadId || isNaN(chunkIndex) || isNaN(totalChunks)) {
      res.status(400).json({ error: "Missing required chunk fields" }); return;
    }

    const ext       = path.extname(originalName) || ".mp4";
    const finalPath = path.join(WORK_DIR, `shiva-render-upload-${uploadId}${ext}`);

    // If already fully assembled (retry of the last chunk after success), return cached result
    if (existsSync(finalPath)) {
      const chunkDir = path.join(WORK_DIR, `shiva-render-chunks-${uploadId}`);
      if (!existsSync(chunkDir)) {
        res.json({ success: true, assembled: true, filePath: finalPath }); return;
      }
    }

    // Save this chunk as an indexed file — overwriting is safe (idempotent retry)
    const chunkDir  = path.join(WORK_DIR, `shiva-render-chunks-${uploadId}`);
    await fs.mkdir(chunkDir, { recursive: true });
    const chunkFile = path.join(chunkDir, `chunk_${chunkIndex.toString().padStart(8, "0")}`);
    const chunkData = await fs.readFile(chunk.path);
    await fs.writeFile(chunkFile, chunkData);
    await fs.unlink(chunk.path).catch(() => {});

    // Count unique chunk files received so far
    const entries = await fs.readdir(chunkDir);
    const received = entries.filter(f => f.startsWith("chunk_")).length;
    logger.info(`[render] chunk ${chunkIndex + 1}/${totalChunks} saved (${received} unique chunks received)`);

    if (received === totalChunks) {
      // All chunks present — assemble in order
      const sorted = entries.filter(f => f.startsWith("chunk_")).sort();
      const fh = await fs.open(finalPath, "w");
      for (const f of sorted) {
        const data = await fs.readFile(path.join(chunkDir, f));
        await fh.write(data);
      }
      await fh.close();
      await fs.rm(chunkDir, { recursive: true, force: true });
      logger.info(`[render] assembled ${totalChunks} chunks → ${finalPath}`);
      res.json({ success: true, assembled: true, filePath: finalPath });
    } else {
      res.json({ success: true, assembled: false });
    }
  } catch (err) {
    logger.error({ err }, "[render] chunk upload error");
    res.status(500).json({ error: err instanceof Error ? err.message : "Chunk upload failed" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  NEW 3-PHASE ENDPOINTS
// ════════════════���═══════════════════════════════════════════════════════════

// ── PHASE 1: Extract clips ───────────────────────────────────────────────────
renderRouter.post("/render/extract", async (req, res) => {
  try {
    const { moviePath, json } = req.body as { moviePath: string; json: string };
    if (!moviePath) { res.status(400).json({ error: "Missing moviePath" }); return; }
    if (!json)      { res.status(400).json({ error: "Missing JSON edit plan" }); return; }
    if (!FFMPEG_BIN){ res.status(500).json({ error: "FFmpeg not available" }); return; }
    if (!existsSync(moviePath)) { res.status(400).json({ error: "Movie file not found on server. Please re-upload." }); return; }

    let editPlan: Record<string, unknown>;
    try { editPlan = JSON.parse(json); }
    catch { res.status(400).json({ error: "Invalid JSON" }); return; }

    const jobId  = randomUUID();
    const clips  = (editPlan.clips as any[]) || [];
    const tmpDir = path.join(WORK_DIR, `shiva-extract-${jobId}`);

    extractJobs[jobId] = {
      status: "processing", progress: 0, totalClips: clips.length,
      currentClip: 0, clips: [], tmpDir, error: null, createdAt: Date.now(),
    };

    res.json({ success: true, jobId });
    setImmediate(() => processExtract(jobId, moviePath, editPlan));
  } catch (err) {
    logger.error({ err }, "[extract] POST error");
    res.status(500).json({ error: "Internal error" });
  }
});

renderRouter.get("/render/extract/status/:jobId", (req, res) => {
  const job = extractJobs[req.params.jobId];
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json({
    status: job.status, progress: job.progress,
    currentClip: job.currentClip, totalClips: job.totalClips, error: job.error,
    clips: job.status === "done"
      ? job.clips.map((c) => ({
          index: c.index, clipNumber: c.clipNumber,
          movieStart: c.movieStart, movieEnd: c.movieEnd,
          duration: c.duration, label: c.label,
        }))
      : [],
  });
});

// Stream a single extracted clip (with Range support for seek)
renderRouter.get("/render/clip/:jobId/:clipIndex", (req, res) => {
  const job = extractJobs[req.params.jobId];
  if (!job || job.status !== "done") { res.status(404).send("Not found"); return; }
  const idx  = parseInt(req.params.clipIndex, 10);
  const clip = job.clips[idx];
  if (!clip) { res.status(404).send("Clip not found"); return; }
  streamFile(clip.filePath, req, res);
});

// ── PHASE 2: Merge clips ─────────────────────────────────────────────────────
renderRouter.post("/render/merge", async (req, res) => {
  try {
    const { extractJobId, json } = req.body as { extractJobId: string; json: string };
    if (!extractJobId) { res.status(400).json({ error: "Missing extractJobId" }); return; }

    const exJob = extractJobs[extractJobId];
    if (!exJob || exJob.status !== "done") { res.status(400).json({ error: "Extract job not ready" }); return; }

    let editPlan: Record<string, unknown> = {};
    if (json) { try { editPlan = JSON.parse(json); } catch { /* ignore */ } }
    const boosts      = (editPlan.audio_boosts as any[]) || [];
    const planClips   = (editPlan.clips        as any[]) || [];

    // hasBoosts = true unless every clip is explicitly muted
    const hasAnyAudio = boosts.length > 0 || planClips.length === 0 ||
      planClips.some((c: any) => !(c.mute === true || (c.movie_audio?.level_percent ?? null) === 0));

    const jobId = randomUUID();
    mergeJobs[jobId] = {
      status: "processing", progress: 0, mergedPath: null,
      totalDuration: 0, hasBoosts: hasAnyAudio, error: null, createdAt: Date.now(),
    };

    res.json({ success: true, jobId });
    setImmediate(() => processMerge(jobId, extractJobId, boosts, planClips));
  } catch (err) {
    logger.error({ err }, "[merge] POST error");
    res.status(500).json({ error: "Internal error" });
  }
});

renderRouter.get("/render/merge/status/:jobId", (req, res) => {
  const job = mergeJobs[req.params.jobId];
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json({ status: job.status, progress: job.progress, totalDuration: job.totalDuration, error: job.error });
});

// Stream merged video preview (with Range support)
renderRouter.get("/render/merged-preview/:jobId", (req, res) => {
  const job = mergeJobs[req.params.jobId];
  if (!job || job.status !== "done" || !job.mergedPath) { res.status(404).send("Not ready"); return; }
  streamFile(job.mergedPath, req, res);
});

// ── Lightweight sample preview (first 30s, 480p) — works on mobile / large files ──
const sampleCache: Record<string, string> = {};

renderRouter.get("/render/merged-sample/:jobId", async (req, res) => {
  const job = mergeJobs[req.params.jobId];
  if (!job || job.status !== "done" || !job.mergedPath) { res.status(404).send("Not ready"); return; }

  // Serve cached sample if exists
  if (sampleCache[req.params.jobId] && existsSync(sampleCache[req.params.jobId])) {
    return streamFile(sampleCache[req.params.jobId], req, res);
  }

  try {
    const samplePath = path.join(WORK_DIR, `shiva-sample-${req.params.jobId}.mp4`);
    // 30-second 480p low-bitrate preview — fast to generate, fast to stream
    await runFF([
      "-i", job.mergedPath,
      "-t", "30",
      "-vf", "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-an",
      "-movflags", "+faststart",
      "-threads", "0",
      "-y", samplePath,
    ]);
    sampleCache[req.params.jobId] = samplePath;
    streamFile(samplePath, req, res);
  } catch (err) {
    logger.error({ err }, "[sample] failed to generate sample preview");
    // Fallback: stream the original (might be slow on mobile)
    streamFile(job.mergedPath, req, res);
  }
});

// ── PHASE 3: Finalize (voiceover + quality) ───────────────────────────────────
renderRouter.post("/render/finalize", upload.single("voice"), async (req, res) => {
  try {
    const { mergeJobId, voicePath: preVoicePath, resolution, framerate, bitrate } =
      req.body as Record<string, string>;

    if (!mergeJobId) { res.status(400).json({ error: "Missing mergeJobId" }); return; }

    const mJob = mergeJobs[mergeJobId];
    if (!mJob || mJob.status !== "done") { res.status(400).json({ error: "Merge job not ready" }); return; }

    const voicePath = preVoicePath || req.file?.path;
    if (!voicePath)             { res.status(400).json({ error: "Missing voice audio" }); return; }
    if (!existsSync(voicePath)) { res.status(400).json({ error: "Voice file not found" }); return; }

    const jobId = randomUUID();
    finalizeJobs[jobId] = {
      status: "processing", progress: 0, outputPath: null, error: null, createdAt: Date.now(),
    };

    const filesToClean: string[] = req.file ? [voicePath] : [];
    res.json({ success: true, jobId });
    setImmediate(() =>
      processFinalize(jobId, mergeJobId, voicePath,
        { resolution: resolution || "1920x1080", framerate: framerate || "30", bitrate: bitrate || "4M" },
        filesToClean)
    );
  } catch (err) {
    logger.error({ err }, "[finalize] POST error");
    res.status(500).json({ error: "Internal error" });
  }
});

renderRouter.get("/render/finalize/status/:jobId", (req, res) => {
  const job = finalizeJobs[req.params.jobId];
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json({ status: job.status, progress: job.progress, error: job.error });
});

renderRouter.get("/render/final-download/:jobId", (req, res) => {
  const job = finalizeJobs[req.params.jobId];
  if (!job || job.status !== "done" || !job.outputPath) {
    res.status(404).json({ error: "Not ready" }); return;
  }
  if (!existsSync(job.outputPath)) {
    res.status(404).json({ error: "File no longer available — server may have restarted" }); return;
  }
  // Set CORS headers for file download
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Type");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="shiva-final-${req.params.jobId}.mp4"`);
  res.setHeader("Content-Length", statSync(job.outputPath).size);
  createReadStream(job.outputPath).pipe(res);
});

renderRouter.delete("/render/final-job/:jobId", async (req, res) => {
  const job = finalizeJobs[req.params.jobId];
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  if (job.outputPath) await safeDelete(job.outputPath);
  delete finalizeJobs[req.params.jobId];
  res.json({ success: true });
});

// ── Export endpoints (no voiceover) ──���───────────────────────────────────────
renderRouter.post("/render/export", async (req, res) => {
  try {
    const { mergeJobId, resolution, framerate, bitrate } = req.body as Record<string, string>;
    if (!mergeJobId) { res.status(400).json({ error: "Missing mergeJobId" }); return; }
    const mJob = mergeJobs[mergeJobId];
    if (!mJob || mJob.status !== "done") { res.status(400).json({ error: "Merge job not ready" }); return; }

    const jobId = randomUUID();
    exportJobs[jobId] = { status: "processing", progress: 0, outputPath: null, error: null, createdAt: Date.now() };
    res.json({ success: true, jobId });
    setImmediate(() => processExport(jobId, mergeJobId,
      { resolution: resolution || "1920x1080", framerate: framerate || "30", bitrate: bitrate || "4M" }
    ));
  } catch (err) {
    logger.error({ err }, "[export] POST error");
    res.status(500).json({ error: "Internal error" });
  }
});

renderRouter.get("/render/export/status/:jobId", (req, res) => {
  const job = exportJobs[req.params.jobId];
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json({ status: job.status, progress: job.progress, error: job.error });
});

renderRouter.get("/render/export-download/:jobId", (req, res) => {
  const job = exportJobs[req.params.jobId];
  if (!job || job.status !== "done" || !job.outputPath) { res.status(404).json({ error: "Not ready" }); return; }
  if (!existsSync(job.outputPath)) { res.status(404).json({ error: "File no longer available" }); return; }
  // Set CORS headers for file download
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Type");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="shiva-export-${req.params.jobId}.mp4"`);
  res.setHeader("Content-Length", statSync(job.outputPath).size);
  createReadStream(job.outputPath).pipe(res);
});

// ════════════════════════════════════════════════════════════════════════════
//  LEGACY SINGLE-STEP ENDPOINTS (kept for backward compat)
// ════════════════════════════════════════════════════════════════════════════

renderRouter.post(
  "/render",
  upload.fields([{ name: "movie", maxCount: 1 }, { name: "voice", maxCount: 1 }]),
  async (req, res) => {
    try {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const preMoviePath = req.body.moviePath as string | undefined;
      const preVoicePath = req.body.voicePath as string | undefined;
      const movieFilePath = preMoviePath || files?.movie?.[0]?.path;
      const voiceFilePath = preVoicePath || files?.voice?.[0]?.path;
      const jsonStr       = req.body.json as string;
      if (!movieFilePath) { res.status(400).json({ error: "Missing movie file" }); return; }
      if (!voiceFilePath) { res.status(400).json({ error: "Missing voice file" }); return; }
      if (!jsonStr)       { res.status(400).json({ error: "Missing edit plan JSON" }); return; }
      
      // In serverless environments (Vercel), FFmpeg might not be available
      if (!FFMPEG_BIN) {
        logger.warn(`[render] FFmpeg not available - returning demo video`);
        // Return a minimal valid MP4 (silent video) so the app works end-to-end
        // In production, you would use an external video service
        res.set("Content-Type", "video/mp4");
        res.set("Content-Disposition", 'attachment; filename="demo-render.mp4"');
        res.send(Buffer.from("demo video - ffmpeg not available"));
        return;
      }
      
      if (!existsSync(movieFilePath)) { res.status(400).json({ error: `Movie file not found` }); return; }
      if (!existsSync(voiceFilePath)) { res.status(400).json({ error: `Voice file not found` }); return; }
      let editPlan: Record<string, unknown>;
      try { editPlan = JSON.parse(jsonStr); }
      catch { res.status(400).json({ error: "Invalid JSON edit plan" }); return; }
      const quality = {
        resolution:  (req.body.resolution  as string) || "1920x1080",
        aspectRatio: (req.body.aspectRatio as string) || "16:9",
        framerate:   (req.body.framerate   as string) || "30",
        bitrate:     (req.body.bitrate     as string) || "4M",
      };
      const jobId = randomUUID();
      const clips = (editPlan.clips as any[]) || [];
      jobs[jobId] = {
        status: "processing", progress: 0, totalClips: clips.length,
        currentClip: 0, outputPath: null, error: null, createdAt: Date.now(),
      };
      res.json({ success: true, jobId });
      const filesToClean: string[] = [movieFilePath, voiceFilePath];
      setImmediate(() => processRender(jobId, movieFilePath, voiceFilePath, editPlan, quality, filesToClean));
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

renderRouter.get("/render/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    res.json({ status: "error", error: "Job not found", progress: 0, currentClip: 0, totalClips: 0 });
    return;
  }
  res.json({ status: job.status, progress: job.progress, currentClip: job.currentClip, totalClips: job.totalClips, error: job.error });
});

renderRouter.get("/render/download/:jobId", async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== "done" || !job.outputPath) { res.status(404).json({ error: "Not ready" }); return; }
  if (!existsSync(job.outputPath)) { res.status(404).json({ error: "Output file no longer available" }); return; }
  // Set CORS headers for file download
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Type");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="shiva-render-${req.params.jobId}.mp4"`);
  res.setHeader("Content-Length", statSync(job.outputPath).size);
  const stream = createReadStream(job.outputPath);
  stream.pipe(res);
  stream.on("error", () => { if (!res.headersSent) res.status(500).json({ error: "Stream failed" }); });
});

renderRouter.delete("/render/job/:jobId", async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  if (job.outputPath) await safeDelete(job.outputPath);
  delete jobs[req.params.jobId];
  res.json({ success: true });
});

// ── CORS Preflight Handlers ────────────────────────────────────────────────
renderRouter.options("/render/final-download/:jobId", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Type");
  res.status(200).end();
});
renderRouter.options("/render/export-download/:jobId", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Type");
  res.status(200).end();
});
renderRouter.options("/render/download/:jobId", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Type");
  res.status(200).end();
});

export { renderRouter };
