# Gemini Studio Automation

Upload videos and generate AI-powered scripts by automating Google AI Studio (Gemini) via Playwright browser automation.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/gemini-studio run dev` — run the frontend (port 25667)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: Vite + React (artifacts/gemini-studio)
- API: Express 5 (artifacts/api-server)
- Playwright: Browser automation for Google AI Studio
- File uploads: multer (in-memory storage)
- UI: shadcn/ui, Tailwind CSS v4, lucide-react

## Where things live

- `artifacts/gemini-studio/src/components/video-uploader.tsx` — Main UI component
- `artifacts/api-server/src/routes/gemini.ts` — API endpoint (`POST /api/gemini`)
- `artifacts/api-server/src/services/gemini-studio.ts` — Playwright automation service
- `artifacts/gemini-studio/src/index.css` — Dark theme (oklch colors, green accent)

## Architecture decisions

- Frontend calls `/api/gemini` which routes to the Express backend via the shared proxy
- The Playwright service is a singleton that maintains browser sessions per project ID
- Cookies for Google auth are stored in `cookies/<projectId>.json` or loaded from `GEMINI_COOKIES_JSON` env var (base64-encoded)
- Video files are saved to `uploads/` before being passed to Playwright
- multer handles multipart/form-data uploads in the Express server

## Product

- Upload a video and write a prompt to generate an AI script via Google AI Studio
- Optionally add YouTube reference links to include in the prompt
- Chat interface for continuing the conversation after initial script generation
- Project ID system for managing multiple browser sessions

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The app requires `GEMINI_COOKIES_JSON` (base64-encoded Google cookies) or a local `cookies/<projectId>.json` file to authenticate with Google AI Studio
- Playwright runs headless Chrome — on Replit this requires the `--no-sandbox` flag (already configured)
- Sessions persist in memory; restart the API server to clear all sessions
- `postcss.config.mjs` is intentionally excluded (conflicts with Tailwind v4's Vite plugin)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
