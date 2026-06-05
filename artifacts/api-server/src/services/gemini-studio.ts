import { chromium, Browser, BrowserContext, Page, Cookie } from "playwright";
import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";

// Find the system-installed Chromium (from nixpkgs) which has proper library
// rpaths baked in — avoids missing .so issues in the deployed container.
function findSystemChromium(): string | undefined {
  try {
    const found = execSync("which chromium 2>/dev/null || which chromium-browser 2>/dev/null || true", {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return found || undefined;
  } catch {
    return undefined;
  }
}

const SYSTEM_CHROMIUM_PATH = findSystemChromium();
console.log("[playwright] system chromium:", SYSTEM_CHROMIUM_PATH ?? "not found — using playwright default");

// Selectors for AI Studio elements (aistudio.google.com 2024-2025)
const SELECTORS = {
  // Login verification - New chat button variations
  newChatButton: '[data-test-id="new-chat-button"], button[aria-label="New chat"], button[aria-label="New chat "], [aria-label*="New chat"], button[mattooltip="New chat"]',
  plusButton: 'button[aria-label="Create new"], mat-icon[fonticon="add"], button:has(mat-icon[fonticon="add"])',

  // Chat interface - Rich text editor
  chatInput: 'ms-prompt-input-wrapper textarea, textarea[placeholder*="prompt"], textarea[placeholder*="Type"], ms-text-chunk textarea, .input-area textarea, rich-textarea .ql-editor, textarea.query-input, [data-test-id="chat-input"] textarea, div[contenteditable="true"][role="textbox"], .text-input-field textarea, textarea',
  sendButton: 'button[aria-label="Run"], ms-run-button button, button[mattooltip="Run"], button[aria-label="Send message"], button.send-button, [data-test-id="send-button"], button[mattooltip="Send message"]',

  // File upload — new AI Studio uses add_circle mat-icon in the toolbar
  attachButton: 'button[aria-label="Insert media"], button[mattooltip="Insert media"], button[aria-label="Add files"], [data-test-id="attach-button"], button[aria-label="Add media"], button[mattooltip="Add media"]',
  fileInput: 'input[type="file"][accept*="video"], input[type="file"][multiple], input[type="file"]',
  uploadProgress: 'mat-progress-bar, [role="progressbar"], .upload-progress-indicator, [class*="uploading"]',

  // Response detection — broad set of selectors to survive DOM changes
  loadingSpinner: [
    'ms-loading-indicator', '.loading-indicator', 'mat-spinner',
    '.generating-indicator', '[class*="spinner"]', '[class*="generating"]',
    '[class*="loading"]', 'ms-run-button[disabled]', 'button[aria-label="Stop"][style*="display: flex"]',
    'button[aria-label="Stop streaming"]', '[aria-label*="Stop"]',
  ].join(', '),
  modelMessage: [
    'ms-chat-turn[actor="model"]',
    'ms-chat-turn[data-turn-actor="model"]',
    '[data-actor="model"]',
    '[data-role="model"]',
    'model-response',
    'ms-model-response',
    '.model-response',
    '[class*="model-response"]',
    '[class*="assistant-message"]',
    '.response-container',
    'ms-response-turn',
    '[data-message-role="model"]',
  ].join(', '),
  responseContainer: [
    'ms-chat-turn[actor="model"] ms-cmark-node',
    'ms-chat-turn[actor="model"] .markdown',
    'ms-chat-turn[actor="model"] p',
    'ms-cmark-node',
    '.markdown-content',
    '[class*="response-text"]',
    '[class*="markdown"]',
  ].join(', '),
};

interface SessionData {
  context: BrowserContext;
  page: Page;
  browser: Browser;
  crashed: boolean;
  cookiesPath: string;
}

interface ParsedResponse {
  text: string;
  timestamp: Date;
  isComplete: boolean;
  debug?: string;
}

/**
 * Generates a random delay between min and max milliseconds
 */
function randomDelay(min: number = 300, max: number = 800): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Service for automating Google AI Studio (Gemini) interactions
 */
class GeminiStudioService {
  private sessions: Map<string, SessionData> = new Map();
  private readonly baseUrl = "https://aistudio.google.com/prompts/new_chat";
  private readonly defaultTimeout = 60000;
  private readonly maxResponseWaitTime = 180000; // 3 minutes
  private readonly pollInterval = 2000; // 2 seconds

  /**
   * Initialize a new session for a project
   * @param projectId - Unique identifier for the project
   * @param cookiesPath - Path to the JSON file containing saved cookies
   */
  async initSession(projectId: string, cookiesPath: string): Promise<void> {
    // Check if session already exists
    if (this.sessions.has(projectId)) {
      console.log(`Session already exists for project: ${projectId}`);
      return;
    }

    // Load cookies from file
    const cookiesJson = await fs.readFile(cookiesPath, "utf-8");
    const cookies: Cookie[] = JSON.parse(cookiesJson);

    // Launch browser in headless mode.
    // Prefer the system Chromium (nixpkgs-compiled, proper library rpaths)
    // over Playwright's downloaded headless shell, which can have missing
    // system libraries in the deployed container.
    const browser = await chromium.launch({
      headless: true,
      timeout: 60000,
      ...(SYSTEM_CHROMIUM_PATH ? { executablePath: SYSTEM_CHROMIUM_PATH } : {}),
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        // Stability & memory fixes — allow large video uploads (2GB+)
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--mute-audio",
        "--disable-extensions",
        "--no-first-run",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=TranslateUI,BlinkGenPropertyTrees",
        "--disable-ipc-flooding-protection",
        // Increase V8 renderer heap to 8 GB so large video buffers don't OOM-crash
        "--js-flags=--max-old-space-size=8192 --max-semi-space-size=256",
      ],
    });

    // Create context with cookies
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
    });

    // Grant clipboard permissions so page.evaluate can read clipboard content
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // Add cookies to context — sanitize first so Cookie-Editor exports work with Playwright
    const sanitizedCookies = cookies.map((cookie: any) => {
      const sanitized = { ...cookie }

      // Fix sameSite — Playwright only accepts Strict, Lax, or None
      if (!sanitized.sameSite || !['Strict', 'Lax', 'None'].includes(sanitized.sameSite)) {
        sanitized.sameSite = 'Lax'
      }

      // Fix expirationDate — Playwright uses expires not expirationDate
      if (sanitized.expirationDate && !sanitized.expires) {
        sanitized.expires = sanitized.expirationDate
        delete sanitized.expirationDate
      }

      // Remove fields Playwright does not accept
      delete sanitized.hostOnly
      delete sanitized.storeId
      delete sanitized.session

      return sanitized
    })
    await context.addCookies(sanitizedCookies);

    // Create new page and navigate to AI Studio
    const page = await context.newPage();
    await page.goto(this.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    await sleep(randomDelay(500, 1000));

    // Verify logged in by checking for chat interface elements (chatInput, newChatButton, or plusButton)
    try {
      await page.waitForSelector(
        `${SELECTORS.chatInput}, ${SELECTORS.newChatButton}, ${SELECTORS.plusButton}`,
        { timeout: 60000 }
      );
      console.log(`Successfully logged in for project: ${projectId}`);
    } catch {
      await browser.close();
      throw new Error(
        "Please configure Google session - login verification failed"
      );
    }

    // Store session
    this.sessions.set(projectId, { context, page, browser, crashed: false, cookiesPath });

    // Detect renderer crashes so callers can trigger auto-recovery
    page.on('crash', () => {
      console.error(`[crash] Renderer crashed for project: ${projectId} — session marked for recovery`);
      const s = this.sessions.get(projectId);
      if (s) s.crashed = true;
    });

    // Save cookiesPath so Step 6 (voicemap) can reuse the same session
    try {
      const { writeFileSync, mkdirSync, existsSync } = require('fs');
      const sharedDir = path.join(process.cwd(), 'uploads');
      if (!existsSync(sharedDir)) mkdirSync(sharedDir, { recursive: true });
      writeFileSync(path.join(sharedDir, 'shiva-step1-cookies-path.txt'), cookiesPath);
      console.log('[step1] Saved cookies path for Step 6 reuse:', cookiesPath);
    } catch (e) {
      console.warn('[step1] Could not save cookies path:', e);
    }
  }

  /**
   * Upload a video and generate a script using AI Studio
   * @param projectId - Project identifier
   * @param videoPath - Path to the video file to upload
   * @param prompt - The prompt for script generation
   * @param youtubeLinks - Array of YouTube links to include in the prompt
   */
  /**
   * Warm-up: send "Hey", if error → reload new chat, retry up to maxAttempts.
   * Leaves page open in a working chat so the actual request can follow immediately.
   * If Gemini returns "An internal error has occurred." we reload and try again (up to maxAttempts).
   * On success the page is left open in the same chat — ready for the actual video + prompt.
   */
  /**
   * Map a model ID (e.g. "gemini-3.5-flash") to the display name shown in AI Studio.
   */
  private modelDisplayName(modelId: string): string {
    const map: Record<string, string> = {
      'gemini-3.5-flash': 'Gemini 3.5 Flash',
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gemini-2.5-pro':   'Gemini 2.5 Pro',
      'gemini-2.0-flash': 'Gemini 2.0 Flash',
      'gemini-1.5-pro':   'Gemini 1.5 Pro',
      'gemini-1.5-flash': 'Gemini 1.5 Flash',
    };
    return map[modelId] || modelId;
  }

  /**
   * Attempt to switch the active model inside an already-loaded AI Studio page.
   * Uses multiple strategies: URL param, mat-select click, aria-based click.
   * Fails gracefully — logs a warning but never throws.
   */
  private async switchModel(page: Page, modelId: string): Promise<void> {
    const displayName = this.modelDisplayName(modelId);
    console.log(`[switchModel] Switching to model: ${modelId} (${displayName})`);

    // Strategy 1: Navigate to the URL with the ?model= param
    try {
      const modelUrl = `${this.baseUrl}?model=${encodeURIComponent(modelId)}`;
      console.log(`[switchModel] Strategy 1: URL → ${modelUrl}`);
      await page.goto(modelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      // Verify by checking page text for model name
      const bodyText: string = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
      if (
        bodyText.toLowerCase().includes(displayName.toLowerCase()) ||
        bodyText.toLowerCase().includes(modelId.replace('gemini-', '').replace('-', ' '))
      ) {
        console.log(`[switchModel] ✅ URL approach confirmed — ${displayName} is active`);
        return;
      }
      console.log(`[switchModel] URL approach loaded but model name not confirmed in page text — trying click`);
    } catch (e) {
      console.warn('[switchModel] Strategy 1 (URL) failed:', e);
    }

    // Strategy 2: Click the model selector dropdown, then pick the model
    try {
      const selectorCandidates = [
        'mat-select[aria-label*="odel" i]',
        '[data-test-id="model-selector"]',
        'button[aria-label*="odel" i]',
        '[aria-haspopup="listbox"]',
        '.model-selector-button',
        `button:has-text("${displayName}")`,
      ];

      for (const sel of selectorCandidates) {
        const el = await page.$(sel).catch(() => null);
        if (!el) continue;

        console.log(`[switchModel] Strategy 2: clicking ${sel}`);
        await el.click();
        await sleep(800);

        // Try to find and click the option
        const optionCandidates = [
          `[aria-label*="${displayName}" i]`,
          `mat-option:has-text("${displayName}")`,
          `[role="option"]:has-text("${displayName}")`,
          `li:has-text("${displayName}")`,
          `[data-value="${modelId}"]`,
        ];

        for (const optSel of optionCandidates) {
          const opt = await page.$(optSel).catch(() => null);
          if (opt) {
            await opt.click();
            await sleep(600);
            console.log(`[switchModel] ✅ Click strategy succeeded — ${displayName} selected`);
            return;
          }
        }

        // Fallback: getByText
        try {
          await page.getByText(displayName, { exact: false }).first().click({ timeout: 2000 });
          await sleep(600);
          console.log(`[switchModel] ✅ getByText succeeded — ${displayName} selected`);
          return;
        } catch { /* ignore */ }

        break; // Only try one matching selector
      }
    } catch (e) {
      console.warn('[switchModel] Strategy 2 (click) failed:', e);
    }

    console.warn(`[switchModel] ⚠️ Could not confirm switch to ${displayName} — AI Studio will use its current default`);
  }

  private async warmUpSession(page: Page, maxAttempts = 5, model?: string): Promise<boolean> {
    const ERROR_PATTERNS = [
      'an internal error has occurred',
      'something went wrong',
      'unable to process',
      'try again',
    ];

    for (let i = 1; i <= maxAttempts; i++) {
      console.log(`[warmup] Attempt ${i}/${maxAttempts} — navigating to fresh chat`);
      try {
        // Use model-specific URL if provided, otherwise use default
        const navUrl = model ? `${this.baseUrl}?model=${encodeURIComponent(model)}` : this.baseUrl;
        if (model) console.log(`[warmup] Using model URL: ${navUrl}`);
        await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(randomDelay(1500, 2500));
      } catch (e) {
        console.warn('[warmup] Navigation failed:', e);
      }

      // Wait for input to be ready
      try {
        await page.waitForSelector(SELECTORS.chatInput, { timeout: 30000 });
      } catch {
        console.warn('[warmup] Chat input not found — retrying');
        continue;
      }
      await sleep(randomDelay(500, 1000));

      // Send "Hey"
      console.log('[warmup] Sending warm-up message: "Hey"');
      await this.typeWithHumanDelay(page, SELECTORS.chatInput, 'Hey');
      await sleep(randomDelay(300, 600));

      const chatTurnsBefore = await page.evaluate(() =>
        document.querySelectorAll('ms-chat-turn').length
      ).catch(() => 0);

      await this.clickSendButton(page);

      // Wait for response
      let warmResponse: ParsedResponse;
      try {
        warmResponse = await this.waitForResponse(page, 'Hey', chatTurnsBefore);
      } catch (e) {
        console.warn('[warmup] waitForResponse threw:', e);
        await sleep(2000);
        continue;
      }

      const responseText = warmResponse.text.trim();
      console.log(`[warmup] Got response (${responseText.length} chars): "${responseText.substring(0, 80)}"`);

      const isError = ERROR_PATTERNS.some(p =>
        responseText.toLowerCase().includes(p)
      );

      if (!isError && responseText.length > 3) {
        console.log('[warmup] ✅ Session is warm — Gemini is responding normally!');
        return true;
      }

      console.log(`[warmup] ❌ Error response on attempt ${i} — waiting 3s before retry...`);
      await sleep(3000);
    }

    console.warn('[warmup] ⚠️ Could not warm up after all attempts — proceeding anyway');
    return false;
  }

  async uploadVideoAndGenerateScript(
    projectId: string,
    videoPath: string | null,
    prompt: string,
    youtubeLinks: string[] = [],
    model?: string
  ): Promise<ParsedResponse> {
    // Try once; if the page crashes, recover and retry automatically.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const session = this.sessions.get(projectId);
      if (!session) {
        throw new Error(`No session found for project: ${projectId}. Call initSession first.`);
      }

      // Proactively recover if a previous operation already crashed this session
      if (session.crashed) {
        console.warn(`[crash] Session already crashed for ${projectId} — recovering before attempt ${attempt}`);
        await this.recoverSession(projectId);
      }

      try {
        const { page } = this.sessions.get(projectId)!;

        // ── WARM-UP PHASE ────────────────────────────────────────────────────────
        // Send "Hey" first. If Gemini returns an error (rate-limit / internal error),
        // refresh + try again up to 5 times until we get a real reply.
        // This leaves the page in a working chat session ready for the actual request.
        console.log(`[attempt ${attempt}] Starting warm-up phase... model=${model ?? 'default'}`);
        await this.warmUpSession(page, 5, model);

        // ── ACTUAL REQUEST PHASE — in the SAME chat ───────────────────────────
        // The warm-up left us in a live, working chat. Now send the real video + prompt
        // in the same session (exactly as the user described).
        console.log('[main] Warm-up complete — now sending actual video + prompt in same chat');

        // Upload video file only if a path was provided
        if (videoPath) {
          const absoluteVideoPath = path.resolve(videoPath);
          console.log(`[video] Uploading: ${absoluteVideoPath}`);
          await this.uploadVideoFile(page, absoluteVideoPath);
        } else {
          console.log('No video provided — sending prompt only');
        }

        await sleep(randomDelay(500, 1000));

        // Type the actual prompt
        await this.typeWithHumanDelay(page, SELECTORS.chatInput, prompt);
        await sleep(randomDelay());

        // Paste each YouTube link as URL context chip (separate from prompt text)
        if (youtubeLinks.length > 0) {
          await this.pasteYouTubeLinksAsContext(page, youtubeLinks);
          await sleep(randomDelay(500, 1000));
        }

        // Capture chat turn count BEFORE sending
        const chatTurnsBefore = await page.evaluate(() =>
          document.querySelectorAll('ms-chat-turn').length
        ).catch(() => 0);

        // Click send button
        await this.clickSendButton(page);

        // Wait for response with polling
        const response = await this.waitForResponse(page, prompt, chatTurnsBefore);
        return response;

      } catch (err) {
        if (this.isCrashError(err) && attempt === 1) {
          console.error(`[crash] Target crashed on attempt 1 for ${projectId} — recovering and retrying...`);
          await this.recoverSession(projectId);
          continue; // retry with fresh session
        }
        throw err; // re-throw on attempt 2 or non-crash errors
      }
    }
    // Should never reach here
    throw new Error(`[crash] uploadVideoAndGenerateScript failed after 2 attempts`);
  }

  /**
   * Continue an existing chat conversation
   * @param projectId - Project identifier
   * @param message - Message to send
   * @param videoPath - Optional video file to attach mid-chat
   * @param youtubeLinks - Optional YouTube URLs to attach mid-chat
   */
  async continueChat(
    projectId: string,
    message: string,
    videoPath?: string,
    youtubeLinks?: string[],
    model?: string
  ): Promise<ParsedResponse> {
    // Try once; if the page crashes, recover and retry automatically.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const session = this.sessions.get(projectId);
      if (!session) {
        throw new Error(`No session found for project: ${projectId}. Call initSession first.`);
      }

      if (session.crashed) {
        console.warn(`[crash] Session already crashed for ${projectId} — recovering before attempt ${attempt}`);
        await this.recoverSession(projectId);
      }

      try {
        const { page } = this.sessions.get(projectId)!;

        // Wait for chat input to be available
        await page.waitForSelector(SELECTORS.chatInput, { timeout: 120000 });
        await sleep(randomDelay());

        // Attach video if provided
        if (videoPath) {
          const absoluteVideoPath = path.resolve(videoPath);
          console.log(`[continue-chat] Attaching video: ${absoluteVideoPath}`);
          await this.uploadVideoFile(page, absoluteVideoPath);
          await sleep(randomDelay(500, 1000));
        }

        // Type message with humanlike delay
        await this.typeWithHumanDelay(page, SELECTORS.chatInput, message);
        await sleep(randomDelay());

        // Paste YouTube links as context chips if provided
        if (youtubeLinks && youtubeLinks.length > 0) {
          await this.pasteYouTubeLinksAsContext(page, youtubeLinks);
          await sleep(randomDelay(500, 1000));
        }

        // Capture chat turn count BEFORE sending
        const chatTurnsBefore = await page.evaluate(() =>
          document.querySelectorAll('ms-chat-turn').length
        ).catch(() => 0);

        // Send the message
        await this.clickSendButton(page);

        // Wait for response using multi-strategy extraction
        const response = await this.waitForResponse(page, message, chatTurnsBefore);
        return response;

      } catch (err) {
        if (this.isCrashError(err) && attempt === 1) {
          console.error(`[crash] Target crashed on attempt 1 for ${projectId} — recovering and retrying...`);
          await this.recoverSession(projectId);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`[crash] continueChat failed after 2 attempts`);
  }

  /**
   * Attach a file to the current Playwright session and wait for it to be
   * fully loaded in AI Studio (token count visible) WITHOUT sending any prompt.
   * Call this before continueChat when you want to decouple file-load from send.
   */
  async attachFileOnly(projectId: string, videoPath: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(`No session found for project: ${projectId}. Please complete Step 1 first.`);
    }
    if (session.crashed) {
      await this.recoverSession(projectId);
    }
    const { page } = this.sessions.get(projectId)!;
    await page.waitForSelector(SELECTORS.chatInput, { timeout: 60000 });
    const absoluteVideoPath = path.resolve(videoPath);
    console.log(`[attach-only] Uploading file to session: ${absoluteVideoPath}`);
    await this.uploadVideoFile(page, absoluteVideoPath);
    console.log(`[attach-only] File confirmed loaded in session`);
  }

  /**
   * Close and cleanup a session for a project
   * @param projectId - Project identifier
   */
  async closeSession(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) {
      console.log(`No session found for project: ${projectId}`);
      return;
    }

    const { context, browser } = session;

    try {
      await context.close();
      await browser.close();
    } catch (error) {
      console.error(`Error closing session for ${projectId}:`, error);
    }

    this.sessions.delete(projectId);
    console.log(`Session closed for project: ${projectId}`);
  }

  /**
   * Close all active sessions
   */
  async closeAllSessions(): Promise<void> {
    const projectIds = Array.from(this.sessions.keys());
    for (const projectId of projectIds) {
      await this.closeSession(projectId);
    }
  }

  /**
   * Recover a crashed session: close the old browser and start a fresh one.
   * Called automatically when "Target crashed" is detected.
   */
  private async recoverSession(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    const cookiesPath = session?.cookiesPath;
    if (!cookiesPath) throw new Error(`[recovery] No cookiesPath stored for ${projectId} — cannot recover`);
    console.log(`[recovery] Closing crashed session for ${projectId}...`);
    try { await this.closeSession(projectId); } catch { /* ignore */ }
    console.log(`[recovery] Re-initialising session for ${projectId}...`);
    await this.initSession(projectId, cookiesPath);
    console.log(`[recovery] Session recovered for ${projectId}`);
  }

  /** Returns true if the error means the browser/page is dead and needs recovery */
  private isCrashError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('Target crashed') ||
      msg.includes('target crashed') ||
      msg.includes('Page crashed') ||
      msg.includes('has been closed') ||
      msg.includes('Target page, context or browser has been closed') ||
      msg.includes('Browser has been closed') ||
      msg.includes('Connection closed')
    );
  }

  /**
   * Save Google cookies for later use
   * Opens a visible browser window for manual login
   * @param email - Google email (displayed for reference)
   * @param password - Not used directly, user logs in manually
   * @param outputPath - Path to save the cookies JSON file
   */
  static async saveCookies(
    email: string,
    _password: string,
    outputPath: string
  ): Promise<void> {
    console.log(`Opening browser for manual login with: ${email}`);
    console.log("Please complete the login and 2FA in the browser window...");

    // Open non-headless browser
    const browser = await chromium.launch({
      headless: false,
      args: ["--start-maximized"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // Navigate to Google accounts
    await page.goto("https://accounts.google.com", { waitUntil: "domcontentloaded", timeout: 60000 });

    // Pre-fill email if email input exists
    try {
      const emailInput = await page.$('input[type="email"]');
      if (emailInput) {
        await emailInput.fill(email);
      }
    } catch {
      // Email input might not be available, continue
    }

    console.log("Waiting for user to complete login and 2FA...");
    console.log("After logging in, navigate to aistudio.google.com");

    // Wait for user to complete login and navigate to AI Studio
    // We'll detect success when they reach the AI Studio main page
    await page.waitForURL("**/aistudio.google.com/**", {
      timeout: 300000, // 5 minutes for manual login
    });

    // Give extra time for all cookies to be set
    await sleep(3000);

    // Navigate to AI Studio to ensure all relevant cookies are captured
    await page.goto("https://aistudio.google.com", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2000);

    // Verify logged in
    try {
      await page.waitForSelector(
        `${SELECTORS.newChatButton}, ${SELECTORS.plusButton}`,
        { timeout: 60000 }
      );
      console.log("Login verified successfully!");
    } catch {
      console.warn(
        "Could not verify login, but saving cookies anyway - they may still work"
      );
    }

    // Get all cookies
    const cookies = await context.cookies();

    // Save cookies to file
    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(cookies, null, 2));

    console.log(`Cookies saved to: ${outputPath}`);
    console.log(`Total cookies captured: ${cookies.length}`);

    // Close browser
    await browser.close();
  }

  /**
   * Check if a session exists for a project
   */
  hasSession(projectId: string): boolean {
    return this.sessions.has(projectId);
  }

  /**
   * Get the page instance for a project (for advanced usage)
   */
  getPage(projectId: string): Page | undefined {
    return this.sessions.get(projectId)?.page;
  }

  /**
   * Take a screenshot of the current page for debugging
   */
  async takeScreenshot(projectId: string): Promise<Buffer | null> {
    const session = this.sessions.get(projectId);
    if (!session) return null;
    try {
      return await session.page.screenshot({ fullPage: false, type: 'png' });
    } catch (e) {
      console.error('[screenshot] Error:', e);
      return null;
    }
  }

  // Private helper methods

  /**
   * Upload a video file to Gemini Studio using Playwright's filechooser event.
   * This is the only reliable approach — injecting a hidden file input doesn't
   * trigger AI Studio's Angular upload pipeline.
   *
   * Strategy order:
   *  1. filechooser via "Insert media" button (best)
   *  2. filechooser via ms-add-media-button (fallback selector)
   *  3. Direct setInputFiles on any visible file input (last resort)
   */
  private async uploadVideoFile(page: Page, absoluteVideoPath: string): Promise<void> {
    let uploaded = false;

    // ── Strategy 0: find attach button by add_circle mat-icon (new AI Studio UI) ──
    // The new AI Studio uses an add_circle icon button in the toolbar, NOT aria-label="Insert media".
    // From debug output: "mic add_circle progress_activity Stop Run" — add_circle is in the toolbar.
    const addCircleLabel = await page.evaluate(() => {
      const icons = Array.from(document.querySelectorAll('mat-icon'));
      const addIcon = icons.find(el => (el.textContent || '').trim() === 'add_circle');
      if (!addIcon) return null;
      const btn = addIcon.closest('button');
      return btn ? (btn.getAttribute('aria-label') || btn.getAttribute('mattooltip') || '__found__') : null;
    }).catch(() => null);

    if (addCircleLabel) {
      console.log(`[video] Found add_circle icon button (label: ${addCircleLabel})`);
    }

    // Build selector list — put the add_circle button first if found
    const attachSelectors: string[] = [];
    if (addCircleLabel && addCircleLabel !== '__found__') {
      attachSelectors.push(`button[aria-label="${addCircleLabel}"]`);
      attachSelectors.push(`button[mattooltip="${addCircleLabel}"]`);
    }
    // Always try known selectors as fallback
    attachSelectors.push(
      'ms-add-media-button button',
      'button[aria-label="Insert media"]',
      'button[mattooltip="Insert media"]',
      'button[aria-label="Add media"]',
      'button[mattooltip="Add media"]',
      'button[aria-label="Add files"]',
      '[data-test-id="attach-button"]',
    );

    // If add_circle icon found but no label, click it directly via JS
    const tryAddCircleDirect = addCircleLabel === '__found__';

    // ── Strategy 1: filechooser via known button selectors ─────────────────
    for (const sel of attachSelectors) {
      if (uploaded) break;
      const btn = await page.$(sel).catch(() => null);
      if (!btn) continue;

      try {
        console.log(`[video] Trying filechooser via selector: ${sel}`);
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
        await btn.click();
        await sleep(700);
        await this.handleUploadMenuIfPresent(page);
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(absoluteVideoPath);
        uploaded = true;
        console.log('[video] File set via filechooser (selector strategy)');
      } catch (err) {
        console.warn(`[video] filechooser failed for ${sel}:`, String(err).slice(0, 120));
      }
    }

    // ── Strategy 2: click add_circle icon directly via JS evaluate ─────────
    if (!uploaded && tryAddCircleDirect) {
      console.log('[video] Trying direct add_circle icon click via evaluate');
      try {
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
        await page.evaluate(() => {
          const icons = Array.from(document.querySelectorAll('mat-icon'));
          const addIcon = icons.find(el => (el.textContent || '').trim() === 'add_circle');
          const btn = addIcon?.closest('button') as HTMLButtonElement | null;
          btn?.click();
        });
        await sleep(700);
        await this.handleUploadMenuIfPresent(page);
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(absoluteVideoPath);
        uploaded = true;
        console.log('[video] File set via add_circle direct click');
      } catch (err) {
        console.warn('[video] add_circle direct click failed:', String(err).slice(0, 120));
      }
    }

    // ── Strategy 3: direct setInputFiles on a native file input ───────────
    if (!uploaded) {
      console.warn('[video] All filechooser attempts failed — trying direct file input');
      try {
        const nativeInput = await page.$('input[type="file"]').catch(() => null);
        if (nativeInput) {
          await nativeInput.setInputFiles(absoluteVideoPath);
          uploaded = true;
          console.log('[video] File set via direct native input');
        }
      } catch (err) {
        console.warn('[video] Direct file input also failed:', String(err).slice(0, 120));
      }
    }

    if (!uploaded) {
      console.warn('[video] Could not upload video — continuing with prompt only');
      return;
    }

    // Wait for upload progress to complete
    await this.waitForUploadComplete(page);

    // Re-focus the chat input after video upload (upload flow can steal focus)
    try {
      await page.click(SELECTORS.chatInput.split(',')[0].trim()).catch(() => {});
      await sleep(300);
    } catch { /* ignore */ }
  }

  /**
   * After clicking the attach button, a dropdown menu may appear with options like
   * "Upload from computer", "From device", "Browse files", etc.
   * This helper detects and clicks the correct option.
   */
  private async handleUploadMenuIfPresent(page: Page): Promise<void> {
    const menuOptionSelectors = [
      // Text-based — covers old and new AI Studio menu labels
      '[role="menuitem"]:has-text("Upload")',
      '[role="option"]:has-text("Upload")',
      '[role="menuitem"]:has-text("Computer")',
      '[role="option"]:has-text("Computer")',
      '[role="menuitem"]:has-text("Device")',
      '[role="option"]:has-text("Device")',
      '[role="menuitem"]:has-text("Browse")',
      '[role="option"]:has-text("Browse")',
      '[role="menuitem"]:has-text("File")',
      'button:has-text("Upload from")',
      'li:has-text("Upload from")',
      'button:has-text("From this")',
      'li:has-text("From this")',
      // mat-menu-item is Angular Material's menu item component
      'mat-menu-item:has-text("Upload")',
      'mat-menu-item:has-text("Computer")',
      'mat-menu-item:has-text("Device")',
      'mat-menu-item:has-text("File")',
    ];
    for (const sel of menuOptionSelectors) {
      const opt = await page.$(sel).catch(() => null);
      if (opt) {
        console.log(`[video] Clicking upload menu option: ${sel}`);
        await opt.click();
        await sleep(400);
        return;
      }
    }
  }

  /**
   * Wait for file upload to complete
   */
  private async waitForUploadComplete(page: Page): Promise<void> {
    // Phase 1: wait for a progress indicator to appear (it may not for small files)
    let progressSeen = false;
    try {
      await page.waitForSelector(SELECTORS.uploadProgress, {
        timeout: 6000,
        state: "visible",
      });
      progressSeen = true;
    } catch {
      console.log("[upload] No progress bar appeared — video may process silently");
    }

    // Phase 2: if progress bar appeared, wait for it to disappear.
    // Large videos can take many minutes to upload — allow up to 15 minutes.
    if (progressSeen) {
      try {
        await page.waitForSelector(SELECTORS.uploadProgress, {
          timeout: 900000, // 15 minutes for large video uploads
          state: "hidden",
        });
        console.log("[upload] Progress bar gone");
      } catch {
        console.warn("[upload] Progress bar did not disappear in time, continuing...");
      }
    }

    // Phase 3: wait for Gemini to finish processing the video.
    // After upload, AI Studio shows a token count next to the video attachment
    // (ms-token-status or ms-prompt-video). We wait up to 5 minutes for this.
    console.log("[upload] Waiting for video processing (token status)...");
    try {
      await page.waitForSelector(
        'ms-token-status, ms-prompt-video, ms-prompt-media, [class*="token-count"], ms-file-data-ref',
        { timeout: 300000, state: "visible" } // 5 minutes
      );
      console.log("[upload] Video processing confirmed — token status visible");
    } catch {
      console.warn("[upload] Token status not detected — waiting 8 s as fallback");
      await sleep(8000);
    }

    // Small extra buffer to let AI Studio settle before we type the prompt
    await sleep(randomDelay(800, 1500));
  }

  /**
   * Paste YouTube links into the chat input as URL context chips.
   * Mimics a real user pasting a URL so Gemini Studio creates the
   * "YouTube Video – X tokens" attachment chip instead of treating
   * the link as plain text.
   */
  private async pasteYouTubeLinksAsContext(page: Page, links: string[]): Promise<void> {
    // Find the actual matched input selector once
    const matchedSel = await page.evaluate((sel: string) => {
      const parts = sel.split(',').map((s) => s.trim());
      for (const p of parts) {
        try { if (document.querySelector(p)) return p; } catch {}
      }
      return null;
    }, SELECTORS.chatInput);

    if (!matchedSel) {
      console.warn('[yt-context] Chat input not found — skipping URL context pasting');
      return;
    }

    const isContentEditable = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      return el?.getAttribute('contenteditable') !== null;
    }, matchedSel);

    for (const link of links) {
      console.log(`[yt-context] Pasting YouTube URL as context: ${link}`);

      // Focus the input
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (el) { el.focus(); el.click(); }
      }, matchedSel);
      await sleep(300);

      // Strategy 1: dispatch a ClipboardEvent with the URL as pasted data.
      // This is the most faithful simulation of a user Ctrl+V paste and triggers
      // Gemini Studio's URL detection logic.
      const pasted = await page.evaluate(({ sel, url }: { sel: string; url: string }) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (!el) return false;
        el.focus();
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', url);
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          return true;
        } catch {
          return false;
        }
      }, { sel: matchedSel, url: link });

      await sleep(1500);

      // Strategy 2 (fallback): append URL text + newline via keyboard/execCommand
      // so Angular's change detection picks it up.
      if (!pasted) {
        console.log('[yt-context] ClipboardEvent failed, falling back to text insertion');
        if (isContentEditable) {
          await page.evaluate(({ sel, url }: { sel: string; url: string }) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (!el) return;
            el.focus();
            // Move cursor to end
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const s = window.getSelection();
            if (s) { s.removeAllRanges(); s.addRange(range); }
            document.execCommand('insertText', false, '\n' + url);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }, { sel: matchedSel, url: link });
        } else {
          // textarea: append via keyboard so input events fire
          await page.press(matchedSel, 'End');
          await page.type(matchedSel, '\n' + link, { delay: 15 });
        }
        await sleep(1500);
      }

      // Wait up to 6 s for a URL context chip to appear
      const chipSelectors = [
        '[class*="url-chip"]',
        'ms-file-data-ref',
        'ms-attachment-chip',
        '[class*="attachment-chip"]',
        'ms-url-chip',
        '[data-test-id*="url"]',
        'span[class*="token"]',
      ].join(', ');

      const chipFound = await page
        .waitForSelector(chipSelectors, { timeout: 6000, state: 'visible' })
        .catch(() => null);

      if (chipFound) {
        console.log(`[yt-context] URL context chip confirmed for: ${link}`);
      } else {
        console.log(`[yt-context] URL chip not visible yet (may still process): ${link}`);
      }

      await sleep(500);
    }
  }

  /**
   * Type text into the chat input using clipboard paste — most reliable method
   * for both textarea and contenteditable elements.
   */
  private async typeWithHumanDelay(
    page: Page,
    selector: string,
    text: string
  ): Promise<void> {
    // Determine which selector actually matched and log it
    const matchedSelector = await page.evaluate((sel: string) => {
      const parts = sel.split(',').map(s => s.trim());
      for (const part of parts) {
        try {
          const el = document.querySelector(part);
          if (el) return part;
        } catch {}
      }
      return null;
    }, selector);

    console.log(`[input] Matched selector: ${matchedSelector ?? 'NONE'}`);

    if (!matchedSelector) {
      // Last resort — dump all visible input-like elements
      const dump = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('textarea, [contenteditable], input[type="text"]'));
        return els.map(e => `${e.tagName}[${Array.from(e.attributes).map(a => `${a.name}="${a.value}"`).join(' ')}]`).join('\n');
      });
      console.warn('[input] No input element found. Found on page:\n', dump);
      throw new Error(`Chat input element not found with selector: ${selector}`);
    }

    // Click to focus the element
    await page.click(matchedSelector).catch(() => {
      page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (el) { el.focus(); el.click(); }
      }, matchedSelector);
    });
    await sleep(300);

    // For contenteditable: use clipboard paste (Ctrl+A → Ctrl+V) — this is the ONLY
    // approach that properly triggers Angular's change detection so the Run button
    // becomes enabled. Direct DOM/execCommand manipulation bypasses Angular and
    // leaves the button disabled, causing the message to never be sent.
    const isContentEditable = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      return el?.getAttribute('contenteditable') !== null;
    }, matchedSelector);

    if (isContentEditable) {
      // Step 1: Write text into clipboard (page context so permissions are relaxed)
      const clipboardSet = await page.evaluate((txt: string) => {
        try {
          // Use the DataTransfer trick — works even without clipboard-write permission
          const dt = new DataTransfer();
          dt.setData('text/plain', txt);
          (window as any).__pendingPaste = txt;
          return true;
        } catch {
          return false;
        }
      }, text);
      console.log(`[input] clipboard staging: ${clipboardSet}`);

      // Step 2: Select-all to clear, then dispatch a synthetic paste event
      // carrying our text. Angular's paste handler fires, updates ngModel, enables Run.
      const pasted = await page.evaluate((args: { sel: string; txt: string }) => {
        const el = document.querySelector(args.sel) as HTMLElement;
        if (!el) return false;
        el.focus();
        // Clear first via select-all + delete
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
        // Synthetic paste with text payload
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', args.txt);
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          return true;
        } catch {
          return false;
        }
      }, { sel: matchedSelector, txt: text });

      await sleep(400);

      // Verify that Angular registered the text (check element content length)
      const registeredLen = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        return (el?.textContent || el?.innerText || '').length;
      }, matchedSelector).catch(() => 0);

      if (registeredLen < 5 || !pasted) {
        // Fallback: type character-by-character so every keystroke fires through
        // Angular's event pipeline. Slow but guaranteed to enable the Run button.
        console.warn(`[input] paste didn't register (len=${registeredLen}) — falling back to keyboard.type()`);
        await page.click(matchedSelector).catch(() => {});
        await sleep(200);
        await page.keyboard.press('Control+a');
        await sleep(100);
        await page.keyboard.type(text, { delay: 8 });
      } else {
        console.log(`[input] Paste confirmed — element content length: ${registeredLen}`);
      }
    } else {
      // For textarea: use Playwright's fill() which is most reliable
      await page.fill(matchedSelector, text);
      // Fire extra events in case Angular reactive forms need them
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
        if (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, matchedSelector);
    }

    await sleep(500);
    console.log(`[input] Typed ${text.length} chars into ${matchedSelector}`);
  }

  /**
   * Click the send button — tries JS click (bypasses overlays) then keyboard fallback
   */
  private async clickSendButton(page: Page): Promise<void> {
    await sleep(randomDelay(500, 800));

    const sendSelectors = [
      'button[aria-label="Run"]',
      'ms-run-button button',
      'button[mattooltip="Run"]',
      'button[aria-label="Send message"]',
      'button[mattooltip="Send message"]',
      'button[aria-label="Send"]',
    ];

    // Wait up to 30 s for the Run button to become enabled (video processing may delay it)
    console.log('[send] Waiting for Run button to be enabled...');
    let buttonReady = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !buttonReady) {
      for (const sel of sendSelectors) {
        const enabled = await page.evaluate((s: string) => {
          const el = document.querySelector(s) as HTMLElement | null;
          return !!(el && !el.hasAttribute('disabled') && !(el as HTMLButtonElement).disabled);
        }, sel);
        if (enabled) { buttonReady = true; break; }
      }
      if (!buttonReady) await sleep(500);
    }

    if (!buttonReady) {
      console.warn('[send] Run button never became enabled — attempting click anyway');
    }

    let sent = false;
    for (const sel of sendSelectors) {
      const clicked = await page.evaluate((s: string) => {
        const el = document.querySelector(s) as HTMLElement | null;
        if (el && !el.hasAttribute('disabled')) {
          el.click();
          return true;
        }
        return false;
      }, sel);

      if (clicked) {
        console.log(`Clicked send button via JS: ${sel}`);
        sent = true;
        break;
      }
    }

    if (!sent) {
      // Try force-clicking even a "disabled" button — Angular may have marked it
      // disabled due to unregistered input but it will still fire the click handler
      for (const sel of sendSelectors) {
        const forceClicked = await page.evaluate((s: string) => {
          const el = document.querySelector(s) as HTMLElement | null;
          if (el) { el.click(); return true; }
          return false;
        }, sel);
        if (forceClicked) {
          console.log(`[send] Force-clicked (ignore disabled): ${sel}`);
          sent = true;
          break;
        }
      }
    }

    if (!sent) {
      // Ctrl+Enter — works in AI Studio's rich text editor and doesn't insert a newline
      console.log('[send] Trying Ctrl+Enter keyboard shortcut...');
      await page.keyboard.press('Control+Enter');
      sent = true;
    }

    await sleep(randomDelay(1000, 2000));
  }

  /**
   * Wait for AI response to complete — multi-strategy extraction.
   *
   * Strategy 1: DOM extraction via ms-cmark-node + ms-prompt-chunk
   * Strategy 2: innerText landmark extraction
   * Strategy 3: extractViaClipboard (3-dot menu → Copy)
   * Strategy 4: Debug snapshot fallback
   */
  private async waitForResponse(page: Page, userMessage: string, chatTurnsBefore: number = 0): Promise<ParsedResponse> {
    console.log('[wait] Waiting for Gemini to finish generating...');

    // Phase 1: Wait up to 15s for generation to START
    // (stop button appears OR chat turn count increases)
    const startPhaseDeadline = Date.now() + 15000;
    let generationStarted = false;
    while (Date.now() < startPhaseDeadline) {
      const started = await page.evaluate((turnsBefore: number) => {
        const stopBtn = !!(
          document.querySelector('[aria-label="Stop generating"]') ||
          document.querySelector('[aria-label*="Stop"]') ||
          document.querySelector('.stop-button') ||
          document.querySelector('button[aria-label="Stop"]')
        );
        const newTurn = document.querySelectorAll('ms-chat-turn').length > turnsBefore;
        return stopBtn || newTurn;
      }, chatTurnsBefore).catch(() => false);
      if (started) { generationStarted = true; console.log('[wait] Generation started — stop button or new turn detected'); break; }
      await sleep(500);
    }
    if (!generationStarted) console.warn('[wait] Generation start not detected — proceeding anyway');

    // Phase 2: Wait for BOTH conditions:
    //   (a) Run/Send button becomes ENABLED again
    //   (b) ms-chat-loading-indicator is GONE (response fully streamed)
    // Both must be true — Run button can enable while response is still streaming.
    console.log('[wait] Waiting for Run button enabled AND loading indicator gone...');
    const maxWait = 4 * 60 * 1000;
    const pollInterval = 800;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const { runEnabled, stillLoading } = await page.evaluate(() => {
        const runSelectors = [
          'ms-run-button button',
          'button[aria-label="Run"]',
          'button[mattooltip="Run"]',
          'button[aria-label="Send message"]',
          'button[mattooltip="Send message"]',
          'button[aria-label="Send"]',
        ];
        let runEnabled = false;
        for (const sel of runSelectors) {
          const el = document.querySelector(sel) as HTMLButtonElement | null;
          if (el && !el.disabled && !el.hasAttribute('disabled')) { runEnabled = true; break; }
        }
        const stillLoading = !!(
          document.querySelector('ms-chat-loading-indicator') ||
          document.querySelector('[class*="loading-indicator"]') ||
          document.querySelector('[class*="chat-loading"]')
        );
        return { runEnabled, stillLoading };
      }).catch(() => ({ runEnabled: false, stillLoading: true }));

      if (runEnabled && !stillLoading) {
        console.log('[wait] Run button enabled + loading indicator gone — fully complete');
        break;
      }
      if (runEnabled && stillLoading) {
        console.log('[wait] Run button enabled but still loading — waiting for stream to finish...');
      } else {
        console.log('[wait] Still generating (run button disabled) — waiting...');
      }
      await sleep(pollInterval);
    }

    // Phase 3: Wait for DOM content to STABILIZE after loading indicator gone.
    // Gemini continues rendering text after the indicator disappears (Angular
    // deferred rendering, virtual scroll, change-detection cycles). Poll the
    // last model-turn textContent length until it stops growing for 1.5 s.
    // NOTE: ms-chat-turn does NOT have actor="model" attribute in the DOM —
    // we identify model turns by the presence of ms-cmark-node inside them.
    console.log('[wait] Waiting for response content to stabilize...');
    {
      const getLastTurnLen = () => page.evaluate(() => {
        const allTurns = Array.from(document.querySelectorAll('ms-chat-turn'));
        // Last turn that has cmark/text content = model response turn
        for (let i = allTurns.length - 1; i >= 0; i--) {
          const el = allTurns[i] as HTMLElement;
          if (el.querySelector('ms-cmark-node, ms-text-chunk')) {
            return el.textContent?.length ?? 0;
          }
        }
        // Fallback: last turn
        if (allTurns.length > 0) return (allTurns[allTurns.length - 1] as HTMLElement).textContent?.length ?? 0;
        return 0;
      }).catch(() => 0);

      let prevLen = 0;
      let stableMs = 0;
      const STABLE_THRESHOLD_MS = 1500; // stop when length hasn't changed for 1.5 s
      const MAX_STABLE_WAIT_MS = 30000; // give up after 30 s
      const POLL_MS = 500;
      const stableDeadline = Date.now() + MAX_STABLE_WAIT_MS;

      while (Date.now() < stableDeadline) {
        await sleep(POLL_MS);
        const curLen = await getLastTurnLen();
        if (curLen > prevLen) {
          console.log(`[wait] Content still growing: ${prevLen} → ${curLen} chars`);
          prevLen = curLen;
          stableMs = 0;
        } else {
          stableMs += POLL_MS;
          if (stableMs >= STABLE_THRESHOLD_MS) {
            console.log(`[wait] Content stable at ${curLen} chars — proceeding to extract`);
            break;
          }
        }
      }
    }

    // Scroll to ensure lazy-rendered sections are in DOM before extracting
    try {
      await page.evaluate(() => {
        const containers = [
          document.querySelector('ms-autoscroll-container'),
          document.querySelector('ms-chat-session'),
          document.querySelector('.chat-container'),
          document.querySelector('main'),
        ].filter(Boolean) as Element[];
        for (const el of containers) {
          (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
        }
        window.scrollTo(0, document.body.scrollHeight);
      });
      await sleep(400);
    } catch { /* non-fatal */ }

    // ── Strategy 1 (PRIMARY): 3-dot menu → Copy → clipboard ────────────────
    // Most reliable: Gemini's own Copy button always gives the full clean text.
    console.log('[wait] Strategy 1: three-dot → Copy → clipboard...');
    try {
      const clipboardText = await this.extractViaClipboard(page);
      if (clipboardText && clipboardText.trim().length > 3) {
        console.log('[wait] ✅ Strategy 1 (clipboard) SUCCESS, length:', clipboardText.length);
        return { text: clipboardText.trim(), timestamp: new Date(), isComplete: true };
      }
      console.log('[wait] Strategy 1 (clipboard) empty/failed — trying DOM fallback...');
    } catch (e) {
      console.warn('[wait] Strategy 1 (clipboard) error:', e);
    }

    // ── Strategy 2 (FALLBACK): DOM extraction via ms-cmark-node ─────────────
    console.log('[wait] Strategy 2: DOM cmark extraction...');
    let domText: string | null = null;
    try {
      domText = await this.extractLatestResponse(page);
      console.log('[wait] Strategy 2 result, length:', domText?.length ?? 0);
    } catch (e) {
      console.warn('[wait] Strategy 2 error:', e);
    }

    // ── Strategy 3 (FALLBACK): Last model turn innerText ────────────────────
    console.log('[wait] Strategy 3: last model turn innerText...');
    let lastTurnText: string = '';
    try {
      lastTurnText = await page.evaluate(() => {
        const JUNK_SELECTORS = [
          'ms-thought-chunk', '[class*="thought-chunk"]',
          'ms-chat-turn-options', 'ms-toolbar', 'ms-copy-button',
          'button', 'mat-icon', 'ms-token-count', 'ms-run-button',
          'ms-chat-loading-indicator', 'mat-snack-bar-container',
          'ms-hallucinations-disclaimer', 'ms-drive-permission-nudge',
        ];
        const allTurns = Array.from(document.querySelectorAll('ms-chat-turn'));
        let lastModelTurn: HTMLElement | null = null;
        for (let i = allTurns.length - 1; i >= 0; i--) {
          const el = allTurns[i] as HTMLElement;
          if (el.querySelector('ms-cmark-node, ms-text-chunk')) {
            lastModelTurn = el;
            break;
          }
        }
        if (!lastModelTurn) return '';
        const clone = lastModelTurn.cloneNode(true) as HTMLElement;
        JUNK_SELECTORS.forEach(sel => clone.querySelectorAll(sel).forEach(n => n.remove()));
        const txt = clone.innerText || clone.textContent || '';
        return txt.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      }) ?? '';
      console.log('[wait] Strategy 3 result, length:', lastTurnText.length);
    } catch (e) {
      console.warn('[wait] Strategy 3 error:', e);
    }

    const domLen = (domText?.trim().length ?? 0);
    const turnLen = lastTurnText.trim().length;
    console.log(`[wait] Comparing: Strategy2(DOM)=${domLen} vs Strategy3(innerText)=${turnLen}`);

    if (domLen > 3 || turnLen > 3) {
      const best = turnLen > domLen ? lastTurnText.trim() : (domText?.trim() ?? '');
      const winner = turnLen > domLen ? '3 (innerText)' : '2 (DOM cmark)';
      console.log(`[wait] ✅ Best fallback: ${winner}, length: ${best.length}`);
      return { text: best, timestamp: new Date(), isComplete: true };
    }
    console.log('[wait] DOM strategies empty — trying innerText landmark...');

    // ── Strategy 4: page innerText landmark extraction ───────────────────────
    console.log('[wait] Strategy 4: innerText landmark extraction...');
    try {
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (pageText) {
        const innerTextResult = this.extractFromInnerText(pageText, userMessage);
        if (innerTextResult && innerTextResult.trim().length > 3) {
          console.log('[wait] Strategy 4 SUCCESS, length:', innerTextResult.length);
          return { text: innerTextResult.trim(), timestamp: new Date(), isComplete: true };
        }
      }
      console.log('[wait] Strategy 4 empty/short — falling back to debug snapshot...');
    } catch (e) {
      console.warn('[wait] Strategy 4 error:', e);
    }

    // ── Strategy 4: Debug snapshot fallback ─────────────────────────────────
    console.warn('[wait] All strategies failed — returning debug snapshot');
    try {
      const debugText = await page.evaluate(() => document.body.innerText).catch(() => '');
      return {
        text: '',
        timestamp: new Date(),
        isComplete: false,
        debug: debugText.slice(0, 5000),
      };
    } catch {
      return { text: '', timestamp: new Date(), isComplete: false, debug: 'All extraction strategies failed' };
    }
  }

  /**
   * Fallback DOM-based response extraction (used when clipboard approach fails).
   */
  private async extractResponseFromDOM(page: Page): Promise<ParsedResponse> {
    console.log('[fallback] Extracting response from DOM...');
    try {
      const text = await page.evaluate(() => {
        const turns = document.querySelectorAll(
          'ms-chat-turn[actor="model"], ms-chat-turn[data-turn-actor="model"], [data-actor="model"]'
        );
        if (turns.length === 0) return '';
        const lastTurn = turns[turns.length - 1];
        return (lastTurn as HTMLElement).textContent?.trim() || '';
      });
      return {
        text: text || '',
        timestamp: new Date(),
        isComplete: !!text,
        debug: text ? undefined : 'DOM extraction returned empty',
      };
    } catch (e) {
      return { text: '', timestamp: new Date(), isComplete: false, debug: String(e) };
    }
  }

  /**
   * Extract model response from full page innerText using the user message as a landmark.
   * Finds the LAST occurrence of the user's message and returns text that follows it,
   * trimming common UI chrome (nav, toolbar, input prompts).
   */
  private extractFromInnerText(pageText: string, userMessage: string): string {
    if (!pageText || !userMessage) return '';

    const fullMsg = userMessage.trim();
    // 200-char prefix used only as a search anchor — we always skip the FULL message
    const msgAnchor = fullMsg.slice(0, 200);

    // Helper: given the start index of the user message in pageText, skip past the
    // ENTIRE message text (not just the anchor) before extracting the response.
    // This is critical for long prompts (e.g. VOICEMAP_PROMPT is 2000+ chars):
    // slicing only msgAnchor.length chars would leave the rest of the prompt in
    // the "response", which is exactly the bug we are fixing here.
    const extractAfterMsg = (anchorIdx: number): string => {
      // Best case: full message text appears from anchorIdx — skip all of it
      if (pageText.slice(anchorIdx).startsWith(fullMsg)) {
        return this.cleanInnerTextResponse(pageText.slice(anchorIdx + fullMsg.length));
      }
      // Fallback: skip at least msgAnchor.length chars, then try to find the next
      // model turn marker ("Model HH:MM") to jump to
      let pos = anchorIdx + msgAnchor.length;
      const modelMarker = /\nModel \d+:\d+/;
      const sub = pageText.slice(pos);
      const m = sub.search(modelMarker);
      if (m !== -1) pos += m + 1; // +1 to skip the leading \n
      return this.cleanInnerTextResponse(pageText.slice(pos));
    };

    // Strategy 1: find LAST "anchor\n" — matches user turn exactly
    // Using lastIndexOf avoids picking up earlier turns or session-title echoes.
    const withNewline = msgAnchor + '\n';
    let idx = pageText.lastIndexOf(withNewline);
    if (idx !== -1) {
      const candidate = extractAfterMsg(idx);
      if (candidate.length > 3) {
        console.log(`[innerText] S1: last user msg+newline at ${idx}, response len=${candidate.length}`);
        return candidate;
      }
    }

    // Strategy 2: last occurrence without trailing newline
    idx = pageText.lastIndexOf(msgAnchor);
    if (idx !== -1) {
      const candidate = extractAfterMsg(idx);
      if (candidate.length > 3) {
        console.log(`[innerText] S2: last user msg at ${idx}, response len=${candidate.length}`);
        return candidate;
      }
    }

    // Strategy 3: first 50 chars as anchor (for very long prompts truncated by AI Studio)
    const shortNeedle = msgAnchor.slice(0, 50);
    if (shortNeedle.length > 10) {
      idx = pageText.lastIndexOf(shortNeedle);
      if (idx !== -1) {
        const candidate = extractAfterMsg(idx);
        if (candidate.length > 3) {
          console.log(`[innerText] S3: short needle at ${idx}, response len=${candidate.length}`);
          return candidate;
        }
      }
    }

    // Strategy 4: last "Expand/Collapse model thoughts" toggle as anchor.
    // When the model uses Thinking mode, this toggle text always appears
    // immediately before the actual response content. The LAST occurrence
    // anchors us to the most recent model turn — works even when the user
    // message is long or not rendered verbatim by AI Studio.
    const THOUGHT_TOGGLES_ANCHORS = [
      'Expand to view model thoughts',
      'Collapse model thoughts',
      'View model thoughts',
    ];
    let lastToggleEnd = -1;
    for (const toggle of THOUGHT_TOGGLES_ANCHORS) {
      let pos = 0;
      let found = -1;
      while ((found = pageText.indexOf(toggle, pos)) !== -1) {
        const end = found + toggle.length;
        if (end > lastToggleEnd) lastToggleEnd = end;
        pos = found + 1;
      }
    }
    if (lastToggleEnd !== -1) {
      const afterToggle = pageText.slice(lastToggleEnd).replace(/^\n+/, '');
      const candidate = this.cleanInnerTextResponse(afterToggle);
      if (candidate.length > 3) {
        console.log(`[innerText] S4: thought toggle anchor, response len=${candidate.length}`);
        return candidate;
      }
    }

    // NOTE: No tail/slice fallback here — it would return the user's long prompt
    // as the "response" when the AI hasn't rendered yet.
    console.warn('[innerText] All strategies failed — user message not found in page text');
    return '';
  }

  /** Remove UI chrome from the response portion of page innerText */
  private cleanInnerTextResponse(raw: string): string {
    let text = raw;

    // ── Hard stop markers — everything after these is settings/nav UI ────────
    // "Ctrl\nkeyboard_return" = keyboard shortcut indicator before the send button
    const HARD_STOPS = [
      /\nCtrl\n[\s\S]*/,
      /\nRun settings\n[\s\S]*/,
      /\nGet code\n[\s\S]*/,
      /\nSystem instructions\n[\s\S]*/,
      /\nTemperature\n[\s\S]*/,
      /\nTools\n[\s\S]*/,                         // right panel header
      /\nGrounding with Google Search[\s\S]*/,     // right panel tool
      /\nType (a|your) (message|prompt|something)[\s\S]*/i,
      /\nWrite a (message|prompt)[\s\S]*/i,
      /\nMessage (Gemini|AI Studio)[\s\S]*/i,
      // Keyboard navigation helper text on chat turns
      /\nUse Arrow Up and Arrow Down[\s\S]*/,
      /Use Arrow Up and Arrow Down[\s\S]*/,
    ];
    for (const re of HARD_STOPS) {
      text = text.replace(re, '');
    }

    // ── Remove mat-icon text (single snake_case words on their own lines) ────
    // Angular Material icons render their ligature name as text content
    // e.g. "edit\n", "more_vert\n", "key_off\n", "thumb_up\n"
    text = text.replace(/^[a-z][a-z0-9_]{0,30}\n/gm, '');
    // Also remove trailing single-word mat-icon at end of text (no trailing \n)
    text = text.replace(/\n[a-z][a-z0-9_]{0,30}$/, '');
    // ── Remove standalone code-block language labels ─────────────────────────
    // AI Studio code blocks show the language as a line above the code content,
    // e.g. "JSON\n", "Python\n", "JavaScript\n" — these are not response text.
    text = text.replace(/^(JSON|Python|JavaScript|TypeScript|HTML|CSS|SQL|Bash|Shell|XML|YAML|Markdown|plaintext|text)\n/gim, '');

    // ── Remove model turn header lines ────────────────────────────────────────
    // "Model 5:24 AM" or "Model 5:24 PM" — timestamp from ms-chat-turn header
    text = text.replace(/^Model \d+:\d+\s*(AM|PM)?\n?/gm, '');
    // "Model • 4:42 PM" variant (bullet separator)
    text = text.replace(/^Model\s*[•·]\s*\d+:\d+\s*(AM|PM)?\n?/gm, '');

    // ── Strip "Thinking" / "Thoughts" section — ANCHOR-BASED APPROACH ──────────
    // When the model uses Thinking mode, AI Studio renders a collapsible section
    // above the actual response.  In innerText the layout is always:
    //
    //   [thoughts content — may be empty if collapsed]
    //   "Expand to view model thoughts"    ← collapsed state toggle
    //   [ACTUAL RESPONSE STARTS HERE]
    //
    // or, when the section is expanded:
    //
    //   [thinking internal monologue...]
    //   "Collapse model thoughts"          ← expanded state toggle
    //   [ACTUAL RESPONSE STARTS HERE]
    //
    // Strategy: if EITHER toggle is present, discard everything before + the
    // toggle itself, and keep only what follows.  This is the most reliable
    // anchor because it is always immediately adjacent to the real response.

    const THOUGHT_TOGGLES = [
      'Expand to view model thoughts',
      'Collapse model thoughts',
      'View model thoughts',
    ];
    for (const toggle of THOUGHT_TOGGLES) {
      const idx = text.indexOf(toggle);
      if (idx !== -1) {
        const candidate = text.slice(idx + toggle.length).replace(/^\n+/, '').trim();
        if (candidate.length > 10) {
          console.log(`[clean] Anchored to "${toggle}" — discarding ${idx} chars of thought content`);
          text = candidate;
          break;
        }
      }
    }

    // Fallback: remove standalone header / timing lines that may remain
    text = text.replace(/^Thinking\n?/gm, '');
    text = text.replace(/^Thoughts\n?/gm, '');
    text = text.replace(/^\d+(\.\d+)?s\n?/gm, ''); // "5.7s" timing lines

    // ── Remove Gemini boilerplate lines ───────────────────────────────────────
    text = text.replace(/^Google AI models may make mistakes.*\n?/gm, '');
    text = text.replace(/^Gemini can make mistakes.*\n?/gm, '');
    text = text.replace(/^Responses? ready\.\n?/gm, '');

    // ── Collapse excessive blank lines and trim ────────────────────────────────
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Extract response by scrolling to the last model turn, hovering to reveal
   * hidden action buttons, clicking the three-dot menu → Copy, and reading
   * the intercepted clipboard text.
   */
  private async extractViaClipboard(page: Page): Promise<string | null> {
    try {
      // ── Step 0: Reset clipboard + scroll to bottom ────────────────────
      await page.evaluate(() => { (window as any).__clipboardText = null; }).catch(() => {});

      // Scroll to bottom so the last turn & its copy button are fully visible
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const vp = document.querySelector(
          'ms-chat-viewport, [class*="chat-viewport"], [class*="scroll-container"], main'
        );
        if (vp) (vp as HTMLElement).scrollTop = (vp as HTMLElement).scrollHeight;
      }).catch(() => {});
      await sleep(500);

      // Poll for __clipboardText — retry up to 15 times (6 seconds total)
      const pollClipboard = async (): Promise<string | null> => {
        for (let i = 0; i < 15; i++) {
          await sleep(400);
          const t = await page.evaluate(() => (window as any).__clipboardText as string | null);
          if (t && t.length > 10) return t;
        }
        return null;
      };

      // ── Step 1: Find and scroll to the last REAL model turn ────────────
      // Gemini adds a "Thoughts" model turn (collapsible thinking section)
      // before the actual response. We must skip thoughts-only turns and
      // find the last turn that contains actual response text (ms-cmark-node).
      // Try attribute-based selectors first, then fall back to content-based detection.
      // AI Studio has changed attribute names over time, so we try broad selectors too.
      const modelTurnSelectors = [
        'ms-chat-turn[actor="model"]',
        'ms-chat-turn[data-turn-actor="model"]',
        '[data-actor="model"]',
        'ms-model-response',
        'ms-response-turn',
        // Broad fallback — all chat turns, detect model turns by their content
        'ms-chat-turn',
      ];

      let lastTurnLocator = null;
      for (const sel of modelTurnSelectors) {
        const loc = page.locator(sel);
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
          // Walk backwards to find the last turn that is a model turn with real content
          for (let i = count - 1; i >= 0; i--) {
            const turn = loc.nth(i);
            const hasRealContent = await turn.evaluate((el) => {
              // Skip user/prompt turns — they only have ms-prompt-chunk, not ms-cmark-node
              const hasUserChunk = el.querySelector('ms-prompt-chunk') !== null;
              const hasCmark = el.querySelector('ms-cmark-node, ms-text-chunk') !== null;
              if (hasUserChunk && !hasCmark) return false; // this is a user turn
              const hasThoughtOnly = (
                el.querySelector('ms-thought-chunk, [class*="thought"]') !== null &&
                !hasCmark
              );
              if (hasThoughtOnly) return false;
              return hasCmark; // must have actual response content
            }).catch(() => false);

            if (hasRealContent) {
              lastTurnLocator = turn;
              console.log(`[clipboard] Found last real model turn via: ${sel} (index ${i}/${count - 1})`);
              break;
            }
          }
          if (lastTurnLocator) break;
        }
      }

      if (!lastTurnLocator) {
        console.warn('[clipboard] No model turn found on page');
        return null;
      }

      // Scroll the last turn into view
      await lastTurnLocator.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(500);

      // ── Step 2: Hover over the last turn to reveal hidden action buttons ─
      await lastTurnLocator.hover({ force: true }).catch(() => {});
      await sleep(600);
      console.log('[clipboard] Hovered over last model turn');

      // ── Step 3: Try three-dot (More) button WITHIN this specific turn ───
      const moreButtonSelectors = [
        'button[aria-label="More"]',
        'button[mattooltip="More"]',
        'button[aria-label="More options"]',
        'button[mattooltip="More options"]',
        'ms-chat-turn-options button:last-child',
        'button[aria-label*="more" i]',
      ];

      for (const moreSel of moreButtonSelectors) {
        const moreBtn = lastTurnLocator.locator(moreSel).last();
        const visible = await moreBtn.isVisible().catch(() => false);
        if (visible) {
          console.log(`[clipboard] Clicking three-dot button via: ${moreSel}`);
          await moreBtn.click({ force: true }).catch(() => {});
          await sleep(700);

          // Find Copy in the opened dropdown
          const menuCopySelectors = [
            'mat-menu-item:has-text("Copy")',
            '[role="menuitem"]:has-text("Copy")',
            '[role="option"]:has-text("Copy")',
            '.mat-menu-item:has-text("Copy")',
            'button:has-text("Copy")',
          ];

          let copied = false;
          for (const copySel of menuCopySelectors) {
            const copyItem = page.locator(copySel).first();
            const copyVisible = await copyItem.isVisible().catch(() => false);
            if (copyVisible) {
              await copyItem.click({ force: true }).catch(() => {});
              console.log(`[clipboard] Clicked Copy menu item via: ${copySel}`);
              copied = true;
              break;
            }
          }

          if (copied) {
            const text = await pollClipboard();
            if (text) {
              console.log('[clipboard] Got text via three-dot → Copy, length:', text.length);
              return text;
            }
          }

          // Close menu and try next selector
          await page.keyboard.press('Escape').catch(() => {});
          await sleep(300);
          // Re-hover since Escape may have dismissed hover state
          await lastTurnLocator.hover({ force: true }).catch(() => {});
          await sleep(400);
        }
      }

      // ── Step 4: Try direct copy / ms-copy-button within the last turn ──
      console.log('[clipboard] Trying direct copy button within last turn...');
      await page.evaluate(() => { (window as any).__clipboardText = null; }).catch(() => {});

      const directCopySelectors = [
        'ms-copy-button button',
        'button[aria-label="Copy"]',
        'button[mattooltip="Copy"]',
        'button[aria-label="Copy response"]',
        'button[mattooltip="Copy response"]',
        '[data-test-id="copy-button"]',
        'button[aria-label*="copy" i]',
      ];

      for (const copySel of directCopySelectors) {
        const copyBtn = lastTurnLocator.locator(copySel).last();
        const visible = await copyBtn.isVisible().catch(() => false);
        if (visible) {
          await copyBtn.click({ force: true }).catch(() => {});
          console.log(`[clipboard] Clicked direct copy button via: ${copySel}`);
          const text = await pollClipboard();
          if (text) {
            console.log('[clipboard] Got text via direct copy button, length:', text.length);
            return text;
          }
        }
      }

      // ── Step 5: Force-inject clipboard text by reading the DOM directly ─
      // Last resort: collect ALL ms-cmark-node elements from the last turn and join them
      console.warn('[clipboard] Button clicks failed — extracting via inner text of last turn');
      const innerText = await lastTurnLocator.evaluate((el) => {
        const NOISE = ['button', 'ms-toolbar', 'ms-copy-button', 'mat-icon',
          'ms-chat-turn-options', 'ms-token-count', 'input', 'textarea',
          '[role="toolbar"]', '[role="button"]'];

        function domToText(node: Node): string {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
          if (node.nodeType !== Node.ELEMENT_NODE) return '';
          const el = node as Element;
          const tag = el.tagName.toUpperCase();
          const BLOCK = new Set(['P','DIV','H1','H2','H3','H4','H5','H6',
            'LI','TR','SECTION','ARTICLE','BLOCKQUOTE','PRE','HR']);
          const inner = Array.from(el.childNodes).map(domToText).join('');
          if (tag === 'BR' || tag === 'HR') return '\n';
          if (BLOCK.has(tag)) return '\n' + inner + '\n';
          return inner;
        }

        function cleanEl(node: Element): string {
          const c = node.cloneNode(true) as Element;
          NOISE.forEach(s => c.querySelectorAll(s).forEach(n => n.remove()));
          return domToText(c).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        }

        // Get ALL cmark nodes, but EXCLUDE those inside ms-thought-chunk only
        // (NOT mat-expansion-panel broadly — AI Studio uses it for collapsible response sections)
        const allCmarks = Array.from(el.querySelectorAll('ms-cmark-node, ms-text-chunk'));
        const thoughtContainers = Array.from(el.querySelectorAll(
          'ms-thought-chunk, [class*="thought-chunk"]'
        ));
        const responseCmarks = allCmarks.filter(node =>
          !thoughtContainers.some(tc => tc.contains(node))
        );
        if (responseCmarks.length > 0) {
          // Keep only top-level cmark nodes — nested cmarks cause triplication
          const topLevel = responseCmarks.filter(n =>
            !responseCmarks.some(other => other !== n && other.contains(n))
          );
          return topLevel.map(cleanEl).filter(t => t.length > 0).join('\n\n');
        }
        // Final fallback: clean the whole turn (removing thoughts sections entirely)
        const c = el.cloneNode(true) as Element;
        [...NOISE, 'ms-thought-chunk'].forEach(s =>
          c.querySelectorAll(s).forEach(n => n.remove())
        );
        return domToText(c).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      }).catch(() => '');

      if (innerText && innerText.length > 0) {
        console.log('[clipboard] Got text via last-turn innerText, length:', innerText.length);
        return innerText;
      }

      console.warn('[clipboard] All extraction attempts failed');
      return null;

    } catch (error) {
      console.error('[clipboard] Error:', error);
      return null;
    }
  }

  /**
   * Extract the latest model response via DOM — last-resort fallback
   */
  private async extractLatestResponse(page: Page): Promise<string | null> {
    try {
      const text = await page.evaluate(() => {
        const NOISE = [
          'button', 'ms-toolbar', 'ms-copy-button', 'mat-icon',
          'ms-chat-turn-options', 'ms-run-button',
          'ms-token-count', '[class*="toolbar"]', '[class*="action-bar"]',
          '[class*="footer"]', '[class*="grounding"]', '[class*="source"]',
          'input', 'textarea', 'label', 'mat-tooltip', 'mat-hint',
          '[role="tooltip"]', '[role="button"]', '[role="menuitem"]',
          '[role="option"]', '[role="tab"]', '[role="menu"]',
          '[class*="sidenav"]', '[class*="nav-"]', '[class*="sidebar"]',
          '[class*="header"]', '[class*="settings"]', '[class*="pricing"]',
          'ms-chat-turn[actor="user"]', 'ms-user-turn', '[data-actor="user"]',
        ];
        // Common UI phrases that indicate we grabbed the wrong element
        const UI_NOISE_PATTERNS = [
          /Enable applet notifications/i,
          /Disable applet notifications/i,
          /Submit: Ctrl \+ Enter/i,
          /Press space for more information/i,
          /API pricing per 1M tokens/i,
          /Usage in AI Studio UI is free/i,
          /Optimized for fastest response/i,
          /Maximizes reasoning depth/i,
          /Browse the url context/i,
          /Moves to Google Drive Trash/i,
        ];

        // Walk the DOM tree, inserting newlines at block-level boundaries.
        // This preserves heading / paragraph / list structure that textContent loses.
        function domToText(node: Node): string {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
          if (node.nodeType !== Node.ELEMENT_NODE) return '';
          const el = node as Element;
          const tag = el.tagName.toUpperCase();
          const BLOCK = new Set(['P','DIV','H1','H2','H3','H4','H5','H6',
            'LI','TR','SECTION','ARTICLE','BLOCKQUOTE','PRE','HR']);
          const inner = Array.from(el.childNodes).map(domToText).join('');
          if (tag === 'BR' || tag === 'HR') return '\n';
          if (BLOCK.has(tag)) return '\n' + inner + '\n';
          return inner;
        }

        function cleanText(el: Element): string {
          const c = el.cloneNode(true) as Element;
          NOISE.forEach(s => c.querySelectorAll(s).forEach(n => n.remove()));
          return domToText(c).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        }

        function looksLikeUIText(t: string): boolean {
          return UI_NOISE_PATTERNS.some(p => p.test(t));
        }

        function isThoughtsOnlyTurn(el: Element): boolean {
          const hasCmark = el.querySelector('ms-cmark-node, ms-text-chunk') !== null;
          // Only treat ms-thought-chunk as a thought indicator, NOT mat-expansion-panel
          // (AI Studio also uses mat-expansion-panel for collapsible response sections)
          const hasThought = el.querySelector(
            'ms-thought-chunk, [class*="thought"]'
          ) !== null;
          return hasThought && !hasCmark;
        }

        // Extract ONLY response text — excludes thoughts content.
        // Falls back to full turn text (minus thoughts) if no cmark nodes found.
        function extractResponseText(el: Element): string {
          // Only filter ms-thought-chunk, NOT mat-expansion-panel broadly
          const thoughtContainers = Array.from(el.querySelectorAll(
            'ms-thought-chunk, [class*="thought-chunk"]'
          ));

          // Prefer structured cmark/text-chunk nodes outside thoughts
          const allCmarks = Array.from(el.querySelectorAll('ms-cmark-node, ms-text-chunk'));
          const responseCmarks = allCmarks.filter(node =>
            !thoughtContainers.some(tc => tc.contains(node))
          );
          if (responseCmarks.length > 0) {
            // Keep only top-level cmark nodes — nested cmarks cause triplication
            const topLevel = responseCmarks.filter(n =>
              !responseCmarks.some(other => other !== n && other.contains(n))
            );
            return topLevel.map(n => cleanText(n)).filter(t => t.length > 0).join('\n\n');
          }

          // No cmark nodes (plain-text / short responses) — clean the whole turn
          // but remove thought sections first so their text isn't included
          const clone = el.cloneNode(true) as Element;
          ['ms-thought-chunk', '[class*="thought-chunk"]',
           'button', 'ms-toolbar', 'ms-copy-button', 'mat-icon',
           'ms-chat-turn-options', 'ms-token-count', '[role="toolbar"]', '[role="button"]',
           'input', 'textarea'].forEach(s =>
            clone.querySelectorAll(s).forEach(n => n.remove())
          );
          return domToText(clone).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        }

        // 1. ms-prompt-chunk + ms-cmark-node strategy (CONFIRMED elements on page)
        //    Find all cmark nodes that appear AFTER the last user prompt chunk in DOM order.
        //    Uses compareDocumentPosition — no actor attribute needed.
        const promptChunks = Array.from(document.querySelectorAll('ms-prompt-chunk'));
        const cmarkNodes = Array.from(document.querySelectorAll('ms-cmark-node'));
        const textChunks = Array.from(document.querySelectorAll('ms-text-chunk'));

        if (cmarkNodes.length > 0) {
          let responseCmarks: Element[];
          if (promptChunks.length > 0) {
            const lastPrompt = promptChunks[promptChunks.length - 1];
            responseCmarks = cmarkNodes.filter(n =>
              lastPrompt.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING
            );
          } else {
            responseCmarks = cmarkNodes;
          }
          // Filter out thought containers — only ms-thought-chunk, NOT mat-expansion-panel
          // broadly (AI Studio also uses mat-expansion-panel for collapsible response sections)
          const thoughts = Array.from(document.querySelectorAll('ms-thought-chunk'));
          responseCmarks = responseCmarks.filter(n => !thoughts.some(t => t.contains(n)));

          if (responseCmarks.length > 0) {
            // Keep only TOP-LEVEL cmark nodes (filter out nested descendants).
            // ms-cmark-node can be nested (parent + child both returned by querySelectorAll),
            // causing text duplication when both are joined.
            const topLevelCmarks = responseCmarks.filter(n =>
              !responseCmarks.some(other => other !== n && other.contains(n))
            );
            const parts = topLevelCmarks.map(n => cleanText(n)).filter(s => s.length > 0);
            const t = parts.join('\n\n');
            if (t.length > 0 && !looksLikeUIText(t)) return t;
          }
        }

        // 2. ms-text-chunk fallback — after last user prompt chunk
        if (textChunks.length > 0) {
          let responseChunks: Element[];
          if (promptChunks.length > 0) {
            const lastPrompt = promptChunks[promptChunks.length - 1];
            responseChunks = textChunks.filter(n =>
              lastPrompt.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING
            );
          } else {
            responseChunks = textChunks;
          }
          if (responseChunks.length > 0) {
            // Also filter nested elements
            const topLevel = responseChunks.filter(n =>
              !responseChunks.some(other => other !== n && other.contains(n))
            );
            const t = topLevel.map(n => cleanText(n)).filter(s => s.length > 0).join('\n');
            if (t.length > 0 && !looksLikeUIText(t)) return t;
          }
        }

        // 3. Try model turn containers — ONLY the LAST one.
        // NEVER iterate backwards: that would return a previous turn's text when the
        // newest response is still empty/loading, causing duplicate "stale" output.
        const modelSelectors = [
          'ms-chat-turn[actor="model"]',
          'ms-chat-turn[data-turn-actor="model"]',
          '[data-actor="model"]',
          '[data-role="model"]',
          'ms-model-response',
          'ms-response-turn',
        ];
        for (const sel of modelSelectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            // Only inspect the LAST (newest) model turn — never fall back to older turns.
            const el = els[els.length - 1] as Element;
            const t = extractResponseText(el);
            if (t.length > 3 && !looksLikeUIText(t)) return t;
          }
        }

        return '';
      });

      if (text && text.length > 0) {
        console.log('[dom-extract] Extracted via DOM, length:', text.length);
        return text;
      }

      // Log page structure to help diagnose selector mismatches
      const tags = await page.evaluate(() => {
        const s = new Set<string>();
        document.querySelectorAll('*').forEach(el => {
          if (el.tagName.includes('-')) s.add(el.tagName.toLowerCase());
        });
        return Array.from(s).slice(0, 60).join(', ');
      }).catch(() => '');
      console.log('[dom-extract] Custom elements on page:', tags);

      return null;
    } catch (error) {
      console.error('[dom-extract] Error:', error);
      return null;
    }
  }
}

// Export as singleton
export const geminiStudioService = new GeminiStudioService();

// Also export the class for testing or custom instances
export { GeminiStudioService };

// Export types
export type { ParsedResponse, SessionData };
