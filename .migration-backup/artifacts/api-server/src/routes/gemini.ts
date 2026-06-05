import { Router } from "express";
import { writeFile, mkdir, readFile, rm } from "fs/promises";
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

// Accept any field name — handles both "video" (direct) and "chunk" (chunked upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per request / chunk
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
      await writeFile(join(chunkDir, `${chunkIndex}`), chunk.buffer);

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

      if ((!video && !preAssembledPath) || !projectId || !prompt) {
        res.status(400).json({ error: "Missing required fields: video/filePath, projectId, or prompt" });
        return;
      }

      await ensureDir(UPLOAD_DIR);
      await ensureDir(COOKIES_DIR);

      let filepath: string;
      if (preAssembledPath) {
        filepath = preAssembledPath;
      } else {
        const filename = `${projectId}-${Date.now()}-${video!.originalname}`;
        filepath = join(UPLOAD_DIR, filename);
        await writeFile(filepath, video!.buffer);
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
      }

      const response = await geminiStudioService.uploadVideoAndGenerateScript(
        projectId,
        filepath,
        prompt,
        links
      );

      res.json({
        success: true,
        response: {
          text: response.text,
          isComplete: response.isComplete,
          timestamp: response.timestamp,
        },
        videoPath: filepath,
      });
      return;
    }

    // ── Continue chat ───────────────────────────────────────────────────────
    if (action === "continue-chat") {
      const projectId = req.body.projectId as string;
      const message = req.body.message as string;

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

      const response = await geminiStudioService.continueChat(projectId, message);

      res.json({
        success: true,
        response: {
          text: response.text,
          isComplete: response.isComplete,
          timestamp: response.timestamp,
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

    res.status(400).json({ error: "Invalid action" });
  } catch (error) {
    req.log.error({ err: error }, "Gemini API error");
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export { router as geminiRouter };
export default router;
