import { createServer } from "http";
import { WebSocketServer } from "ws";
import app from "./app";
import { handleWsUpload } from "./ws-upload";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Wrap Express in a plain HTTP server so we can attach WebSocket
const httpServer = createServer(app);
// maxPayload:0 = unlimited message size (we stream 64 KB chunks so no single
// message is large, but unset default is 100 MB which can still reject frames)
const wss = new WebSocketServer({ noServer: true, maxPayload: 0 });

// Route WebSocket upgrade requests
httpServer.on("upgrade", (request, socket, head) => {
  if (request.url === "/api/render/ws-upload") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleWsUpload(ws);
    });
  } else {
    socket.destroy();
  }
});

httpServer.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

// No HTTP timeouts — large video uploads can take minutes on slow connections
httpServer.timeout = 0;
httpServer.keepAliveTimeout = 0;
