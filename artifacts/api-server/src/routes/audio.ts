import { Router } from "express";
import multer from "multer";
import { spawn, execSync } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { logger } from "../lib/logger";

function detectFfmpeg(): string {
  const shellCandidates = [
    "which ffmpeg",
    "ls /nix/store/*-ffmpeg*/bin/ffmpeg 2>/dev/null | head -1",
    "ls /nix/store/*-replit-runtime-path/bin/ffmpeg 2>/dev/null | head -1",
    "ls /nix/var/nix/profiles/default/bin/ffmpeg 2>/dev/null",
    "ls /run/current-system/sw/bin/ffmpeg 2>/dev/null",
    "ls /usr/bin/ffmpeg 2>/dev/null",
    "ls /usr/local/bin/ffmpeg 2>/dev/null",
  ];

  for (const cmd of shellCandidates) {
    try {
      const result = execSync(cmd, {
        shell: true,
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      })
        .toString()
        .trim();
      if (result) return result.split("\n")[0].trim();
    } catch {
      /* try next */
    }
  }
  return "";
}

const FFMPEG_BIN = detectFfmpeg();
logger.info(`[ffmpeg] binary: ${FFMPEG_BIN || "NOT FOUND"}`);

const audioRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

audioRouter.post(
  "/audio/remove-silence",
  upload.single("audio"),
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }

    if (!FFMPEG_BIN) {
      res.status(500).json({
        error:
          "FFmpeg is not installed on this server. Please contact support.",
      });
      return;
    }

    const thresholdDb = parseFloat(req.body.threshold_db) || -40;
    const minSilenceDuration =
      parseFloat(req.body.min_silence_duration) || 0.3;
    const padding = parseFloat(req.body.padding) || 0.1;
    const effectiveDuration = Math.max(minSilenceDuration - padding, 0.05);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "shiva-audio-"));
    const inputPath = path.join(tmpDir, "input.mp3");
    const outputPath = path.join(tmpDir, "output.mp3");

    try {
      await fs.writeFile(inputPath, req.file.buffer);

      const filter = [
        `silenceremove=`,
        `start_periods=1:`,
        `start_silence=${effectiveDuration}:`,
        `start_threshold=${thresholdDb}dB:`,
        `stop_periods=-1:`,
        `stop_silence=${effectiveDuration}:`,
        `stop_threshold=${thresholdDb}dB`,
      ].join("");

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(FFMPEG_BIN, [
          "-i",
          inputPath,
          "-af",
          filter,
          "-y",
          outputPath,
        ]);

        const stderrChunks: Buffer[] = [];
        proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

        proc.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            const detail = Buffer.concat(stderrChunks).toString().slice(-300);
            reject(new Error(`FFmpeg failed (code ${code}): ${detail}`));
          }
        });

        proc.on("error", (err: NodeJS.ErrnoException) => {
          reject(
            new Error(
              err.code === "ENOENT"
                ? `FFmpeg binary not executable at: ${FFMPEG_BIN}`
                : err.message
            )
          );
        });
      });

      const outputBuffer = await fs.readFile(outputPath);
      res.set("Content-Type", "audio/mpeg");
      res.set("Content-Disposition", 'attachment; filename="processed.mp3"');
      res.send(outputBuffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Processing failed";
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
);

// ── ElevenLabs proxy — avoids CORS issues from the browser ──────────────────

audioRouter.post("/audio/elevenlabs/tts", async (req, res) => {
  const raw = req.body as { apiKey?: string; voiceId?: string; text?: string };
  const apiKey = raw.apiKey?.trim();
  const voiceId = raw.voiceId?.trim();
  const text = raw.text?.trim();

  if (!apiKey) {
    res.status(400).json({ error: "ElevenLabs API key is missing. Open Settings and save your key." });
    return;
  }
  if (!voiceId) {
    res.status(400).json({ error: "Voice ID is missing. Open Settings and enter a Voice ID." });
    return;
  }
  if (!text) {
    res.status(400).json({ error: "No text to convert. Generate a script first." });
    return;
  }
  console.log(`[elevenlabs/tts] voiceId=${voiceId} textLen=${text.length} keyPrefix=${apiKey.slice(0,8)}...`);
  try {
    const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });

    if (!elRes.ok) {
      let detail = "";
      let detailObj: Record<string, unknown> = {};
      try {
        const raw = await elRes.text();
        detail = raw;
        try { detailObj = JSON.parse(raw); } catch { /* not JSON */ }
      } catch { /* ignore */ }
      console.error(`[elevenlabs/tts] status=${elRes.status} voiceId=${voiceId} body=${detail.slice(0, 400)}`);

      if (elRes.status === 401) {
        const msg = (detailObj as any)?.detail?.message
          || (detailObj as any)?.detail
          || (detailObj as any)?.message
          || detail.slice(0, 200)
          || "Invalid ElevenLabs API key or Voice ID. Please check Settings.";
        res.status(401).json({ error: `ElevenLabs 401: ${msg}` });
        return;
      }
      if (elRes.status === 422) {
        const msg = (detailObj as any)?.detail?.[0]?.msg
          || (detailObj as any)?.detail
          || detail.slice(0, 200)
          || "Invalid Voice ID or request format.";
        res.status(422).json({ error: `ElevenLabs 422: ${msg}` });
        return;
      }
      if (elRes.status === 429) {
        res.status(429).json({ error: "ElevenLabs quota exceeded. Your credits are used up." });
        return;
      }
      res.status(elRes.status).json({ error: `ElevenLabs error (${elRes.status}): ${detail.slice(0, 300)}` });
      return;
    }

    const audioBuffer = await elRes.arrayBuffer();
    res.set("Content-Type", "audio/mpeg");
    res.set("Content-Disposition", 'attachment; filename="voice.mp3"');
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Upstream error" });
  }
});

export { audioRouter };
