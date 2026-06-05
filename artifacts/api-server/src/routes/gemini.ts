import express, { Router } from "express";
import { writeFile, mkdir, readFile, rm, rename } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { geminiStudioService, GeminiStudioService } from "../services/gemini-studio";
import multer from "multer";

const router = Router();

const UPLOAD_DIR = join(process.cwd(), "uploads");
const COOKIES_DIR = join(process.cwd(), "cookies");
const CHUNKS_DIR = join(process.cwd(), "uploads", "chunks");

async function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function loadCookiesFromEnv(cookiesPath: string) {
  const cookiesB64 = process.env.GEMINI_COOKIES_JSON;
  if (cookiesB64 && !existsSync(cookiesPath)) {
    const decoded = Buffer.from(cookiesB64, "base64").toString("utf-8");
    await ensureDir(COOKIES_DIR);
    await writeFile(cookiesPath, decoded);
  }
}

// Disk storage — files written directly to disk, no memory buffering.
// Supports uploads up to 2 GB per file / chunk.
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      await ensureDir(UPLOAD_DIR);
      cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
});

router.post("/gemini", upload.any(), async (req, res) => {
  try {
    const action = req.body.action as string;
    const files = req.files as Express.Multer.File[] | undefined;
    const getFile = (name: string) => files?.find((f) => f.fieldname === name);

    // ── Chunked upload ──────────────────────────────────────────────────────
    if (action === "upload-chunk") {
      const chunk = getFile("chunk");
      const uploadId = req.body.uploadId as string;
      const chunkIndex = parseInt(req.body.chunkIndex as string, 10);
      const totalChunks = parseInt(req.body.totalChunks as string, 10);
      const originalName = (req.body.originalName as string) || "video.mp4";

      if (!chunk || !uploadId || isNaN(chunkIndex) || isNaN(totalChunks)) {
        res.status(400).json({ error: "Missing required chunk fields" });
        return;
      }

      const chunkDir = join(CHUNKS_DIR, uploadId);
      await ensureDir(chunkDir);
      // Move the multer-saved file into the chunk directory
      await rename(chunk.path, join(chunkDir, `${chunkIndex}`));

      if (chunkIndex === totalChunks - 1) {
        // Reassemble all chunks into one file
        const buffers: Buffer[] = [];
        for (let i = 0; i < totalChunks; i++) {
          buffers.push(await readFile(join(chunkDir, `${i}`)));
        }
        await ensureDir(UPLOAD_DIR);
        const finalPath = join(UPLOAD_DIR, `${uploadId}-${originalName}`);
        await writeFile(finalPath, Buffer.concat(buffers));
        await rm(chunkDir, { recursive: true, force: true });
        res.json({ success: true, assembled: true, filePath: finalPath });
      } else {
        res.json({ success: true, assembled: false });
      }
      return;
    }

    // ── Upload video + generate script ─────────────────────────────────────
    if (action === "upload-video") {
      const video = getFile("video");
      const projectId = req.body.projectId as string;
      const prompt = req.body.prompt as string;
      const youtubeLinks = req.body.youtubeLinks as string;
      const preAssembledPath = req.body.filePath as string;
      const model = req.body.model as string | undefined;

      if (!projectId || !prompt) {
        res.status(400).json({ error: "Missing required fields: projectId or prompt" });
        return;
      }

      await ensureDir(UPLOAD_DIR);
      await ensureDir(COOKIES_DIR);

      let filepath: string | null = null;
      if (preAssembledPath) {
        filepath = preAssembledPath;
      } else if (video) {
        // File is already on disk at video.path — use it directly
        filepath = video.path;
      }

      const links = youtubeLinks
        ? youtubeLinks.split("\n").filter((l: string) => l.trim())
        : [];

      const cookiesPath = join(COOKIES_DIR, `${projectId}.json`);
      await loadCookiesFromEnv(cookiesPath);

      if (!existsSync(cookiesPath)) {
        res.status(401).json({
          error: "Session not configured. Please run the setup script first to save cookies.",
          code: "SESSION_NOT_CONFIGURED",
          hint: `Run: pnpm setup-session your-email@gmail.com ${projectId}`,
        });
        return;
      }

      if (!geminiStudioService.hasSession(projectId)) {
        await geminiStudioService.initSession(projectId, cookiesPath);
        // Save Step 1 cookies path so Step 6 (voicemap) can reuse it
        try {
          await ensureDir(UPLOAD_DIR);
          await writeFile(join(UPLOAD_DIR, "shiva-step1-cookies-path.txt"), cookiesPath, "utf-8");
        } catch (e) {
          console.warn("[gemini] Could not save step1 cookies path:", e);
        }
      }

      const response = await geminiStudioService.uploadVideoAndGenerateScript(
        projectId,
        filepath,
        prompt,
        links,
        model
      );

      res.json({
        success: true,
        response: {
          text: response.text,
          isComplete: response.isComplete,
          timestamp: response.timestamp,
          debug: response.debug,
        },
        videoPath: filepath,
      });
      return;
    }

    // ── Attach file only (no prompt sent) ──────────────────────────────────
    if (action === "attach-file") {
      const projectId = req.body.projectId as string;
      const preAssembledPath = req.body.filePath as string | undefined;

      if (!projectId) {
        res.status(400).json({ error: "Missing required field: projectId" });
        return;
      }

      if (!geminiStudioService.hasSession(projectId)) {
        const cookiesPath = join(COOKIES_DIR, `${projectId}.json`);
        await loadCookiesFromEnv(cookiesPath);
        if (!existsSync(cookiesPath)) {
          res.status(401).json({
            error: "No active session. Please complete Step 1 first.",
            code: "NO_SESSION",
          });
          return;
        }
        await geminiStudioService.initSession(projectId, cookiesPath);
      }

      await ensureDir(UPLOAD_DIR);
      let videoPath: string | undefined;
      const inlineVideo = getFile("video");
      if (preAssembledPath) {
        videoPath = preAssembledPath;
      } else if (inlineVideo) {
        videoPath = inlineVideo.path;
      }

      if (!videoPath) {
        res.status(400).json({ error: "No file provided for attach-file action" });
        return;
      }

      await geminiStudioService.attachFileOnly(projectId, videoPath);
      res.json({ success: true, message: "File attached and confirmed loaded" });
      return;
    }

    // ── Continue chat ───────────────────────────────────────────────────────
    if (action === "continue-chat") {
      const projectId = req.body.projectId as string;
      const message = req.body.message as string;
      const youtubeLinksRaw = req.body.youtubeLinks as string | undefined;
      const preAssembledPath = req.body.filePath as string | undefined;
      const model = req.body.model as string | undefined;

      if (!projectId || !message) {
        res.status(400).json({ error: "Missing required fields: projectId or message" });
        return;
      }

      if (!geminiStudioService.hasSession(projectId)) {
        const cookiesPath = join(COOKIES_DIR, `${projectId}.json`);
        await loadCookiesFromEnv(cookiesPath);

        if (!existsSync(cookiesPath)) {
          res.status(401).json({
            error: "No active session. Please upload a video first or configure cookies.",
            code: "NO_SESSION",
          });
          return;
        }

        await geminiStudioService.initSession(projectId, cookiesPath);
      }

      // Handle optional video attachment in continue-chat
      await ensureDir(UPLOAD_DIR);
      let videoPath: string | undefined;
      const inlineVideo = getFile("video");
      if (preAssembledPath) {
        videoPath = preAssembledPath;
      } else if (inlineVideo) {
        // File is already on disk at inlineVideo.path — use it directly
        videoPath = inlineVideo.path;
      }

      const youtubeLinks = youtubeLinksRaw
        ? youtubeLinksRaw.split("\n").filter((l: string) => l.trim())
        : [];

      const CONTINUE_CHAT_TIMEOUT_MS = 240000; // 240 seconds
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (!res.headersSent) {
          res.status(504).json({
            error: "continue-chat timed out after 240 seconds — Gemini is taking too long to respond. Please try again.",
            code: "CONTINUE_CHAT_TIMEOUT",
          });
        }
      }, CONTINUE_CHAT_TIMEOUT_MS);

      let response;
      try {
        response = await geminiStudioService.continueChat(
          projectId,
          message,
          videoPath,
          youtubeLinks.length > 0 ? youtubeLinks : undefined,
          model
        );
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (timedOut) return; // response already sent by timeout handler

      res.json({
        success: true,
        response: {
          text: response.text,
          isComplete: response.isComplete,
          timestamp: response.timestamp,
          debug: response.debug,
        },
      });
      return;
    }

    // ── Check session ───────────────────────────────────────────────────────
    if (action === "check-session") {
      const projectId = req.body.projectId as string;
      const cookiesPath = join(COOKIES_DIR, `${projectId}.json`);

      const hasCookies = existsSync(cookiesPath);
      const hasActiveSession = geminiStudioService.hasSession(projectId);

      res.json({ success: true, hasSession: hasActiveSession, hasCookies, projectId });
      return;
    }

    // ── Close session ───────────────────────────────────────────────────────
    if (action === "close-session") {
      const projectId = req.body.projectId as string;

      if (projectId) {
        await geminiStudioService.closeSession(projectId);
        res.json({ success: true, message: `Session closed for ${projectId}` });
      } else {
        await geminiStudioService.closeAllSessions();
        res.json({ success: true, message: "All sessions closed" });
      }
      return;
    }

    // ── Set cookies directly from UI ────────────────────────────────────────
    if (action === "set-cookies") {
      const projectId = (req.body.projectId as string) || "default-project";
      const cookiesJsonRaw = req.body.cookiesJson as string;

      if (!cookiesJsonRaw) {
        res.status(400).json({ error: "Missing cookiesJson" });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(cookiesJsonRaw);
      } catch {
        res.status(400).json({ error: "Invalid JSON — paste a valid cookies array from your browser." });
        return;
      }

      if (!Array.isArray(parsed)) {
        res.status(400).json({ error: "Cookies must be a JSON array. Export from browser devtools as an array." });
        return;
      }

      await ensureDir(COOKIES_DIR);
      const cookiesPath = join(COOKIES_DIR, `${projectId}.json`);
      await writeFile(cookiesPath, JSON.stringify(parsed, null, 2), "utf-8");

      // Reset existing session so next request picks up the new cookies
      if (geminiStudioService.hasSession(projectId)) {
        await geminiStudioService.closeSession(projectId);
      }

      console.log(`[set-cookies] Saved ${parsed.length} cookies for project: ${projectId}`);
      res.json({ success: true, message: `${parsed.length} cookies saved. Session reset — ready to use!` });
      return;
    }

    // ── Save cookies ────────────────────────────────────────────────────────
    if (action === "save-cookies") {
      const projectId = req.body.projectId as string;
      const email = req.body.email as string;

      if (!projectId) {
        res.status(400).json({ error: "Missing projectId" });
        return;
      }

      await ensureDir(COOKIES_DIR);
      const outputPath = join(COOKIES_DIR, `${projectId}.json`);

      try {
        await GeminiStudioService.saveCookies(email || "", "", outputPath);
        res.json({ success: true, message: "Cookies saved successfully!", cookiesPath: outputPath });
      } catch (err) {
        res.status(500).json({
          success: false,
          error: "Cannot save cookies via API in serverless environment.",
          hint: `Run the setup script locally instead: pnpm setup-session email@gmail.com ${projectId}`,
          details: err instanceof Error ? err.message : "Unknown error",
        });
      }
      return;
    }

    // ── Debug screenshot ────────────────────────────────────────────────────
    if (action === "screenshot") {
      const projectId = (req.body.projectId as string) || "default-project";
      const buf = await geminiStudioService.takeScreenshot(projectId);
      if (!buf) {
        res.status(404).json({ error: "No active session or screenshot failed" });
        return;
      }
      res.setHeader("Content-Type", "image/png");
      res.send(buf);
      return;
    }

    res.status(400).json({ error: "Invalid action" });
  } catch (error) {
    req.log.error({ err: error }, "Gemini API error");
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

// ── Gemini API Proxy ──────────────────────────────────────────────────────────
// Proxies Gemini API calls server-side to avoid browser-level IP/proxy blocks.
// The frontend sends { prompt, key } — the backend makes the actual API call.
router.post("/gemini-proxy", express.json(), async (req, res) => {
  const { prompt, key, model } = req.body as {
    prompt?: string;
    key?: string;
    model?: string;
  };

  if (!prompt || !key) {
    res.status(400).json({ error: "Missing required fields: prompt, key" });
    return;
  }

  const geminiModel = model || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`;

  try {
    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });

    const data = await geminiRes.json() as Record<string, unknown>;

    if (!geminiRes.ok) {
      // Forward the actual Gemini error message to the client
      const errMsg =
        (data?.error as { message?: string } | undefined)?.message ||
        `Gemini API error (${geminiRes.status})`;
      res.status(geminiRes.status).json({ error: errMsg, raw: data });
      return;
    }

    const text =
      (data?.candidates as Array<{ content: { parts: Array<{ text: string }> } }>)?.[0]
        ?.content?.parts?.[0]?.text || "";

    res.json({ success: true, text });
  } catch (err) {
    req.log.error({ err }, "Gemini proxy fetch error");
    res.status(500).json({
      error: err instanceof Error ? err.message : "Gemini proxy failed",
    });
  }
});

export { router as geminiRouter };
export default router;
