import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { spawn, execSync } from "child_process";

const rawPort = process.env.PORT || "3000";
const basePath = process.env.BASE_PATH || "/";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Start API server in background when vite starts (development only)
function startApiServer() {
  return {
    name: "start-api-server",
    configureServer() {
      // Check if API server is already running
      try {
        execSync("curl -s http://localhost:8080/ >/dev/null 2>&1", { timeout: 2000 });
        console.log("[vite] API server already running on port 8080");
        return;
      } catch {
        // Not running, start it
      }
      
      const apiServerDir = path.resolve(import.meta.dirname, "..", "api-server");
      console.log("[vite] Starting API server from:", apiServerDir);
      
      // Build and start the API server
      const child = spawn("sh", ["-c", "pnpm run build && PORT=8080 node --enable-source-maps ./dist/index.mjs"], {
        cwd: apiServerDir,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, PORT: "8080", NODE_ENV: "development" },
      });
      
      child.stdout?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.log("[api]", msg);
      });
      
      child.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.log("[api]", msg);
      });
      
      child.on("error", (err) => {
        console.error("[vite] Failed to start API server:", err);
      });
      
      child.unref();
    },
  };
}

export default defineConfig(async () => {
  const plugins = [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    startApiServer(),
  ];

  if (process.env.NODE_ENV !== "production" && process.env.REPL_ID !== undefined) {
    plugins.push(
      (await import("@replit/vite-plugin-cartographer")).cartographer({
        root: path.resolve(import.meta.dirname, ".."),
      }),
      (await import("@replit/vite-plugin-dev-banner")).devBanner(),
    );
  }

  return {
    base: basePath,
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
      },
      dedupe: ["react", "react-dom"],
    },
    root: path.resolve(import.meta.dirname),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: "0.0.0.0",
      allowedHosts: true,
      fs: {
        strict: true,
      },
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
      proxy: {
        "/api": {
          target: "http://localhost:8080",
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});
