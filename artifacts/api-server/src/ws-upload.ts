import { WebSocket } from "ws";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { promises as fsp } from "fs";
import { logger } from "./lib/logger";

// Use workspace volume (256 GB) instead of /tmp (quota-limited)
const WORK_DIR = path.join(process.cwd(), "uploads", "tmp");
fsp.mkdir(WORK_DIR, { recursive: true }).catch(() => {});

export function handleWsUpload(ws: WebSocket): void {
  let fh: fs.FileHandle | null = null;
  let finalPath = "";
  let totalSize = 0;
  let receivedBytes = 0;
  let ready = false;

  // Server-side ping every 25 s — keeps the connection alive through proxies
  // and load-balancers that close idle WebSocket connections (common with 2 GB
  // uploads that can take several minutes on a slow link).
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 25_000);

  // Serialize all async work through a single queue so writes never race.
  // ws.on('message') is synchronous-entry but async-body — without a queue,
  // a fast sender can fill the receive buffer before the previous fh.write()
  // resolves, causing two concurrent writes to the same file-position cursor.
  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((err) => {
      logger.error({ err }, "[ws-upload] queue error");
      try { ws.send(JSON.stringify({ type: "error", error: err instanceof Error ? err.message : "Upload failed" })); } catch { /**/ }
    });
  };

  const cleanup = () =>
    enqueue(async () => {
      clearInterval(pingInterval);
      if (fh) { await fh.close().catch(() => {}); fh = null; }
    });

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    enqueue(async () => {
      if (!isBinary) {
        const msg = JSON.parse((raw as Buffer).toString()) as Record<string, unknown>;

        if (msg["type"] === "init") {
          const uploadId = msg["uploadId"] as string;
          const name     = (msg["name"] as string) || "video.mp4";
          totalSize      = (msg["size"] as number) || 0;
          const ext      = path.extname(name) || ".mp4";
          finalPath      = path.join(WORK_DIR, `shiva-ws-upload-${uploadId}${ext}`);

          // Return cached file if a previous upload finished with the exact size
          if (existsSync(finalPath)) {
            try {
              const stat = await fs.stat(finalPath);
              if (stat.size === totalSize) {
                logger.info(`[ws-upload] cache hit: ${finalPath}`);
                ws.send(JSON.stringify({ type: "assembled", filePath: finalPath }));
                return;
              }
            } catch { /* fall through */ }
          }

          fh = await fs.open(finalPath, "w");
          ready = true;
          logger.info(`[ws-upload] init: ${name} (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
          ws.send(JSON.stringify({ type: "ready" }));

        } else if (msg["type"] === "done") {
          if (fh) { await fh.close(); fh = null; }
          logger.info(`[ws-upload] assembled: ${finalPath} (${(receivedBytes / 1024 / 1024).toFixed(1)} MB received)`);
          ws.send(JSON.stringify({ type: "assembled", filePath: finalPath }));
        }

      } else {
        // Binary data — write in strict queue order (no concurrent writes)
        if (!ready || !fh) return;
        const buf: Buffer =
          Buffer.isBuffer(raw)  ? raw :
          Array.isArray(raw)    ? Buffer.concat(raw as Buffer[]) :
          Buffer.from(raw as ArrayBuffer);
        await fh.write(buf);
        receivedBytes += buf.length;
      }
    });
  });

  ws.on("close", () => { cleanup(); });
  ws.on("error", (err) => { logger.error({ err }, "[ws-upload] ws error"); cleanup(); });
}
