import { Router } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import path from "path";
import { logger } from "../lib/logger";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const CHUNKS_DIR = path.join(process.cwd(), "uploads", "ws-chunks");
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

interface UploadSession {
  uploadId: string;
  projectId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  filePath: string;
  chunkDir: string;
}

const activeSessions = new Map<string, UploadSession>();

async function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

export function setupUploadWS(wss: WebSocketServer) {
  wss.on("connection", async (ws: WebSocket) => {
    logger.info("[upload-ws] New client connected");
    let session: UploadSession | null = null;
    let fh: fs.FileHandle | null = null;
    let receivedBytes = 0;

    // Heartbeat to keep connection alive through proxies
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 25_000);

    const cleanup = async () => {
      clearInterval(heartbeat);
      if (fh) {
        await fh.close().catch(() => {});
        fh = null;
      }
      if (session) {
        activeSessions.delete(session.uploadId);
      }
    };

    ws.on("message", async (data: Buffer | ArrayBuffer) => {
      try {
        // Text messages (control)
        if (typeof data === "string" || data instanceof Buffer && data.toString().startsWith("{")) {
          const msg = JSON.parse(data.toString());

          if (msg.type === "init") {
            const uploadId = msg.uploadId as string;
            const projectId = msg.projectId as string;
            const fileName = msg.fileName as string;
            const fileSize = msg.fileSize as number;
            const totalChunks = msg.totalChunks as number;

            if (!uploadId || !projectId || !fileName || fileSize <= 0 || totalChunks <= 0) {
              ws.send(JSON.stringify({ type: "error", error: "Invalid init parameters" }));
              return;
            }

            // Check cache for completed uploads
            const uploadDir = path.join(UPLOAD_DIR);
            await ensureDir(uploadDir);
            const finalPath = path.join(uploadDir, `${uploadId}-${fileName}`);

            if (existsSync(finalPath)) {
              try {
                const stat = await fs.stat(finalPath);
                if (stat.size === fileSize) {
                  logger.info(`[upload-ws] Cache hit: ${finalPath}`);
                  ws.send(
                    JSON.stringify({
                      type: "assembled",
                      filePath: finalPath,
                    })
                  );
                  return;
                }
              } catch {
                /* fall through */
              }
            }

            const chunkDir = path.join(CHUNKS_DIR, uploadId);
            await ensureDir(chunkDir);

            session = {
              uploadId,
              projectId,
              fileName,
              fileSize,
              totalChunks,
              receivedChunks: new Set(),
              filePath: finalPath,
              chunkDir,
            };

            activeSessions.set(uploadId, session);
            fh = await fs.open(path.join(chunkDir, "data"), "w");
            receivedBytes = 0;

            logger.info(
              `[upload-ws] Init: ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)} MB), chunks: ${totalChunks}`
            );

            ws.send(JSON.stringify({ type: "ready" }));
          } else if (msg.type === "done") {
            if (!session || !fh) {
              ws.send(JSON.stringify({ type: "error", error: "No active upload" }));
              return;
            }

            await fh.close();
            fh = null;

            // Verify file size
            const stat = await fs.stat(path.join(session.chunkDir, "data"));
            if (stat.size !== session.fileSize) {
              logger.error(
                `[upload-ws] Size mismatch: expected ${session.fileSize}, got ${stat.size}`
              );
              ws.send(JSON.stringify({ type: "error", error: "Upload size mismatch" }));
              return;
            }

            // Move to final location
            await ensureDir(UPLOAD_DIR);
            await fs.rename(path.join(session.chunkDir, "data"), session.filePath);
            await fs.rm(session.chunkDir, { recursive: true, force: true });

            logger.info(
              `[upload-ws] Assembled: ${session.filePath} (${(receivedBytes / 1024 / 1024).toFixed(1)} MB)`
            );

            ws.send(
              JSON.stringify({
                type: "assembled",
                filePath: session.filePath,
              })
            );
          }
        } else {
          // Binary data (chunk)
          if (!session || !fh) {
            ws.send(JSON.stringify({ type: "error", error: "No active upload session" }));
            return;
          }

          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          await fh.write(buf);
          receivedBytes += buf.length;

          const chunkIndex = Math.floor(receivedBytes / CHUNK_SIZE) - 1;
          session.receivedChunks.add(chunkIndex);

          // Send acknowledgment
          ws.send(JSON.stringify({ type: "chunk-ack", chunkIndex }));

          if (receivedBytes % (50 * 1024 * 1024) === 0) {
            const pct = Math.round((receivedBytes / session.fileSize) * 100);
            logger.info(`[upload-ws] ${pct}% (${(receivedBytes / 1024 / 1024).toFixed(1)} MB)`);
          }
        }
      } catch (error) {
        logger.error({ error }, "[upload-ws] Error processing message");
        ws.send(
          JSON.stringify({
            type: "error",
            error: error instanceof Error ? error.message : "Unknown error",
          })
        );
      }
    });

    ws.on("close", async () => {
      logger.info("[upload-ws] Client disconnected");
      await cleanup();
    });

    ws.on("error", async (error: Error) => {
      logger.error({ error }, "[upload-ws] WebSocket error");
      await cleanup();
    });

    ws.on("pong", () => {
      logger.debug("[upload-ws] Pong received");
    });
  });
}

// Express route to upgrade connections
const router = Router();

router.get("/upload-ws", (req, res) => {
  res.status(400).json({ error: "WebSocket upgrade required" });
});

export default router;
