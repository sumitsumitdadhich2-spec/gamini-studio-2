import { Router } from "express";
import { writeFile, mkdir, readFile, rm, rename } from "fs/promises";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { voicemapStudioService, VoicemapStudioService } from "../services/voicemap-studio";
import { geminiStudioService } from "../services/gemini-studio";
import multer from "multer";

const router = Router();

const UPLOAD_DIR = join(process.cwd(), "uploads");
const COOKIES_DIR = join(process.cwd(), "cookies");
const CHUNKS_DIR = join(process.cwd(), "uploads", "chunks");
const STEP1_COOKIES_PATH_FILE = join(UPLOAD_DIR, "shiva-step1-cookies-path.txt");

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

/**
 * Read the cookies path saved by Step 1 (gemini route).
 * Returns the path if it exists and points to a real file, otherwise null.
 */
function getStep1CookiesPath(): string | null {
  try {
    if (!existsSync(STEP1_COOKIES_PATH_FILE)) return null;
    const p = readFileSync(STEP1_COOKIES_PATH_FILE, "utf-8").trim();
    if (p && existsSync(p)) return p;
    return null;
  } catch {
    return null;
  }
}

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
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

router.post("/voicemap", upload.any(), async (req, res) => {
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
      await rename(chunk.path, join(chunkDir, `${chunkIndex}`));

      if (chunkIndex === totalChunks - 1) {
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
        filepath = video.path;
      }

      const links = youtubeLinks
        ? youtubeLinks.split("\n").filter((l: string) => l.trim())
        : [];

      const step1CookiesPath = getStep1CookiesPath();
      const cookiesPath = step1CookiesPath || join(COOKIES_DIR, `${projectId}.json`);
      if (!step1CookiesPath) await loadCookiesFromEnv(cookiesPath);

      if (!existsSync(cookiesPath)) {
        res.status(401).json({
          error: "Session not configured. Please run Step 1 first to initialise the session.",
          code: "SESSION_NOT_CONFIGURED",
        });
        return;
      }

      // Prefer Step 1's existing session so voice prompt is sent in the same chat,
      // not a new page. Fall back to voicemapStudioService only when no step 1 session exists.
      const uploadService = geminiStudioService.hasSession(projectId)
        ? geminiStudioService
        : voicemapStudioService;

      if (!uploadService.hasSession(projectId)) {
        await uploadService.initSession(projectId, cookiesPath);
      }

      const response = await uploadService.continueChat(
        projectId,
        prompt,
        filepath ?? undefined,
        links.length > 0 ? links : undefined
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

      // Always use Step 1's session (geminiStudioService) so Step 6 operates
      // on the exact same Gemini chat page — never open a new page.
      if (!geminiStudioService.hasSession(projectId)) {
        const step1CookiesPath = getStep1CookiesPath();
        const cookiesPath = step1CookiesPath || join(COOKIES_DIR, `${projectId}.json`);
        if (!step1CookiesPath) await loadCookiesFromEnv(cookiesPath);
        if (!existsSync(cookiesPath)) {
          res.status(401).json({
            error: "No active session. Please complete Step 1 first.",
            code: "NO_SESSION",
          });
          return;
        }
        await geminiStudioService.initSession(projectId, cookiesPath);
      }
      const attachService = geminiStudioService;

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

      await attachService.attachFileOnly(projectId, videoPath);
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

      // Always use Step 1's session (geminiStudioService) so Step 6 sends
      // to the exact same Gemini chat page — never open a new page.
      if (!geminiStudioService.hasSession(projectId)) {
        const step1CookiesPath = getStep1CookiesPath();
        const cookiesPath = step1CookiesPath || join(COOKIES_DIR, `${projectId}.json`);
        if (!step1CookiesPath) await loadCookiesFromEnv(cookiesPath);

        if (!existsSync(cookiesPath)) {
          res.status(401).json({
            error: "No active session. Please complete Step 1 first or configure cookies.",
            code: "NO_SESSION",
          });
          return;
        }

        await geminiStudioService.initSession(projectId, cookiesPath);
      }
      const chatService = geminiStudioService;

      await ensureDir(UPLOAD_DIR);
      let videoPath: string | undefined;
      const inlineVideo = getFile("video");
      if (preAssembledPath) {
        videoPath = preAssembledPath;
      } else if (inlineVideo) {
        videoPath = inlineVideo.path;
      }

      const youtubeLinks = youtubeLinksRaw
        ? youtubeLinksRaw.split("\n").filter((l: string) => l.trim())
        : [];

      const CONTINUE_CHAT_TIMEOUT_MS = 240000;
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
        response = await chatService.continueChat(
          projectId,
          message,
          videoPath,
          youtubeLinks.length > 0 ? youtubeLinks : undefined,
          model
        );
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (timedOut) return;

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
      const step1CookiesPath = getStep1CookiesPath();
      const cookiesPath = step1CookiesPath || join(COOKIES_DIR, `${projectId}.json`);

      const hasCookies = existsSync(cookiesPath);
      const hasActiveSession = voicemapStudioService.hasSession(projectId);

      res.json({ success: true, hasSession: hasActiveSession, hasCookies, projectId });
      return;
    }

    // ── Close session ───────────────────────────────────────────────────────
    if (action === "close-session") {
      const projectId = req.body.projectId as string;

      if (projectId) {
        await voicemapStudioService.closeSession(projectId);
        res.json({ success: true, message: `Session closed for ${projectId}` });
      } else {
        await voicemapStudioService.closeAllSessions();
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
        await VoicemapStudioService.saveCookies(email || "", "", outputPath);
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
      const buf = await voicemapStudioService.takeScreenshot(projectId);
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
    req.log.error({ err: error }, "Voicemap API error");
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export { router as voicemapRouter };
export default router;
