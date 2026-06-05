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
  lastAttachedFilePath?: string;
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
class VoicemapStudioService {
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

    // Intercept clipboard writes so __clipboardText is always populated
    // even when navigator.clipboard.readText() is blocked by permissions.
    await context.addInitScript(() => {
      const _orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text: string) => {
        (window as any).__clipboardText = text;
        try { return await _orig(text); } catch { /* ignore permission errors */ }
      };
    });

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
  }

  /**
   * Upload a video and generate a script using AI Studio
   * @param projectId - Project identifier
   * @param videoPath - Path to the video file to upload
   * @param prompt - The prompt for script generation
   * @param youtubeLinks - Array of YouTube links to include in the prompt
   */
  async uploadVideoAndGenerateScript(
    projectId: string,
    videoPath: string | null,
    prompt: string,
    youtubeLinks: string[] = []
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

        // Navigate to a new chat URL only when uploading a video file.
        // For text-only prompts, stay in the existing chat to avoid breaking the conversation.
        if (videoPath) {
          console.log(`[attempt ${attempt}] Video provided — navigating to new chat URL...`);
          try {
            await page.goto(this.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
            await sleep(randomDelay(1000, 2000));
            console.log("Navigated to new chat");
          } catch (error) {
            console.warn("Navigation to new chat failed, continuing on current page:", error);
          }
        } else {
          console.log(`[attempt ${attempt}] No video — staying in existing chat (text-only prompt)`);
        }

        // Wait for chat interface to be ready
        await page.waitForSelector(SELECTORS.chatInput, { timeout: 60000 });
        await sleep(randomDelay());

        // Upload video file only if a path was provided
        if (videoPath) {
          const absoluteVideoPath = path.resolve(videoPath);
          console.log(`[video] Uploading: ${absoluteVideoPath}`);
          await this.uploadVideoFile(page, absoluteVideoPath);
        } else {
          console.log("No video provided — sending prompt only");
        }

        await sleep(randomDelay(500, 1000));

        // Type the actual prompt first
        await this.typeWithHumanDelay(page, SELECTORS.chatInput, prompt);
        await sleep(randomDelay());

        // Paste each YouTube link as URL context chip (separate from prompt text)
        if (youtubeLinks.length > 0) {
          await this.pasteYouTubeLinksAsContext(page, youtubeLinks);
          await sleep(randomDelay(500, 1000));
        }

        // Capture chat turn count BEFORE sending (for model-turn detection in waitForResponse)
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
    youtubeLinks?: string[]
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

        // ── Disable "Grounding with Google Search" if it's ON ─────────────
        // Grounding causes Gemini internal errors when media files are attached.
        // Try multiple strategies in order of reliability.
        let groundingRemoved = false;

        // Strategy 1: settings sidebar toggle (most reliable — visible, not hidden)
        try {
          const toggleCount = await page.locator('mat-slide-toggle').count().catch(() => 0);
          console.log(`[continue-chat] mat-slide-toggle count: ${toggleCount}`);
          for (let i = 0; i < toggleCount; i++) {
            const toggle = page.locator('mat-slide-toggle').nth(i);
            const text = await toggle.textContent().catch(() => '');
            console.log(`[continue-chat] Toggle ${i}: "${(text || '').trim().slice(0, 60)}"`);
            if ((text || '').toLowerCase().includes('grounding') || (text || '').toLowerCase().includes('google search')) {
              const toggleEl = await toggle.elementHandle();
              const isOn = toggleEl ? await toggleEl.evaluate((el: any) =>
                el.classList.contains('mat-mdc-slide-toggle-checked') ||
                el.classList.contains('mat-checked') ||
                el.getAttribute('ng-reflect-checked') === 'true' ||
                el.getAttribute('aria-checked') === 'true' ||
                el.querySelector('[aria-checked="true"]') !== null
              ).catch(() => false) : false;
              if (isOn) {
                await toggle.locator('button').click({ timeout: 3000 });
                groundingRemoved = true;
                console.log('[continue-chat] Grounding toggle turned OFF via sidebar');
              } else {
                console.log('[continue-chat] Grounding toggle found but already OFF');
              }
              break;
            }
          }
        } catch (e) {
          console.warn('[continue-chat] Grounding toggle strategy failed:', String(e).slice(0, 80));
        }

        // Strategy 2: input toolbar chip × button (page.evaluate approach — no timeout risk)
        if (!groundingRemoved) {
          try {
            const chipClicked = await page.evaluate(() => {
              // Look for any element containing "Google Search" or "Grounding" text near a button
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
              let node: Element | null;
              while ((node = walker.nextNode() as Element | null)) {
                const ownText = Array.from(node.childNodes)
                  .filter(n => n.nodeType === 3)
                  .map(n => n.textContent || '')
                  .join('').toLowerCase();
                if (ownText.includes('google search') || ownText.includes('grounding')) {
                  // Click the nearest button (likely the × remove button)
                  const btn = node.querySelector('button') ||
                    (node.parentElement ? node.parentElement.querySelector('button') : null);
                  if (btn) { (btn as HTMLElement).click(); return 'clicked'; }
                  if (node instanceof HTMLElement) { node.click(); return 'clicked-node'; }
                }
              }
              return 'not-found';
            }).catch(() => 'error');
            if (chipClicked === 'clicked' || chipClicked === 'clicked-node') {
              groundingRemoved = true;
              console.log(`[continue-chat] Grounding chip removed via DOM walker: ${chipClicked}`);
            } else {
              console.log(`[continue-chat] Grounding chip DOM walker result: ${chipClicked}`);
            }
          } catch (e) {
            console.warn('[continue-chat] Grounding chip strategy failed:', String(e).slice(0, 80));
          }
        }

        if (groundingRemoved) {
          console.log('[continue-chat] Grounding disabled successfully — waiting 800ms');
          await sleep(800);
        } else {
          console.log('[continue-chat] Grounding could not be disabled — proceeding anyway');
        }

        // Type message with humanlike delay
        await this.typeWithHumanDelay(page, SELECTORS.chatInput, message);
        await sleep(randomDelay());

        // Paste YouTube links as context chips if provided
        if (youtubeLinks && youtubeLinks.length > 0) {
          await this.pasteYouTubeLinksAsContext(page, youtubeLinks);
          await sleep(randomDelay(500, 1000));
        }

        // Send the message
        await this.clickSendButton(page);

        // ── CLIPBOARD-COPY RESPONSE EXTRACTION ─────────────────────────────
        // STEP 1 — Fixed 5s delay after send, then dismiss any blocking popups,
        // then poll for the 3-dot menu button (up to 3 minutes total).
        console.log('[continue-chat] Waiting 5s after send before polling for 3-dot menu...');
        await sleep(5000);

        // Dismiss any overlaying dialogs/banners (e.g. "Control your API cost")
        await page.evaluate(() => {
          const dismissSelectors = [
            'button[aria-label="Dismiss"]',
            'button[aria-label="Close"]',
            'button[aria-label="close"]',
            '.dismiss-button',
          ];
          for (const sel of dismissSelectors) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && el.offsetParent !== null) { el.click(); return; }
          }
          // Try any button with "Dismiss" text
          const btns = Array.from(document.querySelectorAll('button'));
          for (const btn of btns) {
            const t = (btn.textContent || '').trim();
            if ((t === 'Dismiss' || t === 'Got it' || t === 'OK') && (btn as HTMLElement).offsetParent !== null) {
              (btn as HTMLElement).click();
              return;
            }
          }
        }).catch(() => {});
        await sleep(500);

        const threeDotSelectors = [
          'ms-chat-turn:last-of-type button[aria-label="More options"]',
          'ms-chat-turn:last-of-type button[aria-label="More"]',
          'ms-chat-turn:last-of-type button[mattooltip="More"]',
          'ms-chat-turn:last-of-type button[mattooltip="More options"]',
          'ms-chat-turn:last-of-type [aria-label*="option" i]',
          'ms-chat-turn:last-of-type ms-overflow-menu button',
          'ms-chat-turn:last-of-type mat-icon-button',
          'ms-chat-turn:last-of-type button.more-options',
        ];

        const stopSelectors = [
          '[aria-label*="Stop"]',
          '.stop-button',
          '[aria-label="Stop generating"]',
        ];

        const maxWaitMs = 3 * 60 * 1000; // 3 minutes
        const pollInterval = 2000;
        const deadline = Date.now() + maxWaitMs;
        let threeDotFound = false;

        console.log('[continue-chat] Polling for generation completion...');
        let pollCount = 0;
        while (Date.now() < deadline) {
          pollCount++;
          // STEP 2 — Detect generation complete:
          // In AI Studio the run button TEXT changes:
          //   - During generation: "progress_activity Stop" (spinner + Stop)
          //   - After completion:  "Run  Ctrl  keyboard_return"
          // The button is NOT disabled during generation — only the text changes.
          const stateDebug = await page.evaluate(() => {
            const runBtn = document.querySelector('ms-run-button button') as HTMLElement | null;
            const runBtnText = runBtn ? (runBtn.textContent || runBtn.getAttribute('aria-label') || '').trim() : 'no-run-btn';
            // Count ALL ms-chat-turn elements (actor attribute varies by AI Studio version)
            const allTurns = document.querySelectorAll('ms-chat-turn').length;
            return { runBtnText, allTurns };
          }).catch(() => ({ runBtnText: 'eval-error', allTurns: 0 }));

          // Still generating if run button text contains "Stop" (case-insensitive)
          const isGenerating = stateDebug.runBtnText.toLowerCase().includes('stop');
          if (pollCount <= 5 || pollCount % 10 === 0) {
            console.log(`[continue-chat] Poll #${pollCount}: runBtnText="${stateDebug.runBtnText}" allTurns=${stateDebug.allTurns} isGenerating=${isGenerating}`);
          }

          if (isGenerating) {
            await sleep(pollInterval);
            continue;
          }

          // ── Check for Gemini error response on the last chat turn ──────────
          // AI Studio shows a red circle + error text when the model fails.
          // NOTE: ms-chat-turn[actor="model"] returns 0 — AI Studio doesn't set the
          // actor attribute in the current DOM version. Use plain ms-chat-turn instead.
          const geminiErrorText = await page.evaluate(() => {
            const turns = document.querySelectorAll('ms-chat-turn');
            if (turns.length === 0) return null;
            const lastTurn = turns[turns.length - 1] as HTMLElement;
            const text = (lastTurn.textContent || '').trim();
            const errorPatterns = [
              'An internal error has occurred',
              'Something went wrong',
              'error occurred',
              'Unable to process',
              'rate limit',
              'quota exceeded',
            ];
            for (const pattern of errorPatterns) {
              if (text.includes(pattern)) return text.slice(0, 300);
            }
            return null;
          }).catch(() => null);

          if (geminiErrorText) {
            console.warn(`[continue-chat] Gemini error detected: ${geminiErrorText.slice(0, 150)}`);
            throw new Error(`Gemini returned an error: ${geminiErrorText}`);
          }

          // ── STEP 3: Hover over the last chat turn to reveal the 3-dot button ──
          // In AI Studio, action buttons (3-dot, copy) are hidden until you hover.
          // Use ms-chat-turn without actor filter — actor attribute is not set in current AI Studio DOM.
          const lastTurnBox = await page.evaluate(() => {
            const turns = document.querySelectorAll('ms-chat-turn');
            if (turns.length === 0) return null;
            const lastTurn = turns[turns.length - 1] as HTMLElement;
            lastTurn.scrollIntoView({ behavior: 'instant', block: 'center' });
            const rect = lastTurn.getBoundingClientRect();
            return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
          }).catch(() => null);

          if (lastTurnBox) {
            await page.mouse.move(lastTurnBox.x, lastTurnBox.y);
            await sleep(600); // let hover CSS transitions run
          }

          // ── STEP 4: Try 3-dot menu button (now visible after hover) ───────────
          const found = await page.evaluate((sels: string[]) => {
            for (const s of sels) {
              const el = document.querySelector(s) as HTMLElement | null;
              if (el && el.offsetParent !== null) return s;
            }
            return null;
          }, threeDotSelectors).catch(() => null);

          if (found) {
            console.log(`[continue-chat] Found 3-dot button after hover: ${found}`);
            threeDotFound = true;

            await page.evaluate((sels: string[]) => {
              for (const s of sels) {
                const el = document.querySelector(s) as HTMLElement | null;
                if (el) { el.click(); return; }
              }
            }, threeDotSelectors).catch(() => {});
            await sleep(500);

            const copySelectors = [
              'button[aria-label="Copy"]',
              '[role="menuitem"][aria-label*="copy" i]',
              'mat-menu-item',
              '.mat-menu-item',
            ];

            // Debug: dump visible menu items so we can see what AI Studio renders
            const menuDebug = await page.evaluate(() => {
              const items = Array.from(document.querySelectorAll('mat-menu-item, [role="menuitem"]'));
              return items.map(el => ({
                tag: el.tagName,
                label: el.getAttribute('aria-label') || '',
                text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
                visible: (el as HTMLElement).offsetParent !== null,
              }));
            }).catch(() => []);
            if (menuDebug.length > 0) {
              console.log('[continue-chat] Menu items found:', JSON.stringify(menuDebug));
            } else {
              console.warn('[continue-chat] No mat-menu-item / [role="menuitem"] found in DOM');
            }

            // Extract only direct text-node content (ignores mat-icon ligature text like "content_copy")
            const copyResult = await page.evaluate((sels: string[]) => {
              function ownText(el: Element): string {
                return Array.from(el.childNodes)
                  .filter(n => n.nodeType === Node.TEXT_NODE)
                  .map(n => (n.textContent || '').trim())
                  .join(' ')
                  .toLowerCase()
                  .trim();
              }
              // First pass: try aria-label match (most reliable)
              for (const s of sels) {
                const items = Array.from(document.querySelectorAll(s));
                for (const item of items) {
                  const label = (item.getAttribute('aria-label') || '').toLowerCase();
                  if (label.includes('copy')) {
                    (item as HTMLElement).click();
                    return `label:${label}`;
                  }
                }
              }
              // Second pass: own text-node match (handles "content_copy\nCopy" mat-icon issue)
              for (const s of sels) {
                const items = Array.from(document.querySelectorAll(s));
                for (const item of items) {
                  const own = ownText(item);
                  if (own === 'copy' || own.includes('copy')) {
                    (item as HTMLElement).click();
                    return `owntext:${own}`;
                  }
                }
              }
              // Third pass: full textContent partial match, excluding pure icon elements
              const allMenuItems = Array.from(document.querySelectorAll('[role="menuitem"], mat-menu-item, .mat-menu-item'));
              for (const item of allMenuItems) {
                const full = (item.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                const own = ownText(item);
                if (full.includes('copy') && (own === '' || own.includes('copy') || full.replace(/content_copy/g, '').trim().startsWith('copy'))) {
                  (item as HTMLElement).click();
                  return `fulltext:${full.slice(0, 40)}`;
                }
              }
              return '';
            }, copySelectors).catch(() => '');

            const copyClicked = !!copyResult;
            if (copyResult) {
              console.log(`[continue-chat] Clicked Copy menu item via: ${copyResult}`);
            }

            if (!copyClicked) {
              console.warn('[continue-chat] Could not click Copy menu item — closing menu');
              await page.keyboard.press('Escape');
              await sleep(pollInterval);
              threeDotFound = false;
              continue;
            }

            console.log('[continue-chat] Clicked Copy menu item — waiting for clipboard...');
            await sleep(800);

            // Primary: check __clipboardText (set by our write interceptor)
            let clipboardText = await page.evaluate(() => (window as any).__clipboardText as string || '').catch(() => '');
            // Fallback: try native readText
            if (!clipboardText || clipboardText.trim().length === 0) {
              clipboardText = await page.evaluate(async () => {
                try { return await navigator.clipboard.readText(); } catch { return ''; }
              }).catch(() => '');
            }
            // Poll a few more times in case writeText fires slightly late
            if (!clipboardText || clipboardText.trim().length === 0) {
              for (let p = 0; p < 8; p++) {
                await sleep(400);
                clipboardText = await page.evaluate(() => (window as any).__clipboardText as string || '').catch(() => '');
                if (clipboardText && clipboardText.trim().length > 0) break;
              }
            }

            if (clipboardText && clipboardText.trim().length > 0) {
              console.log(`[continue-chat] Clipboard captured via 3-dot menu, length=${clipboardText.length}`);
              return { text: clipboardText.trim(), timestamp: new Date(), isComplete: true };
            }

            console.warn('[continue-chat] Clipboard empty after 3-dot copy — trying other strategies');
            threeDotFound = false;
            await page.keyboard.press('Escape');
          }

          // ── STEP 5: Try inline copy button on code blocks ─────────────────────
          // AI Studio renders JSON/code blocks with a dedicated copy icon in the header.
          // Reset intercepted clipboard first so we can detect a fresh write.
          await page.evaluate(() => { (window as any).__clipboardText = null; }).catch(() => {});

          const inlineCopied = await page.evaluate(() => {
            // Use ALL ms-chat-turn elements (actor attribute is not set in current AI Studio)
            const turns = document.querySelectorAll('ms-chat-turn');
            const lastTurn = turns[turns.length - 1] as HTMLElement | null;
            if (!lastTurn) return false;
            // Find all copy-like buttons inside this turn (code block headers, toolbar, etc.)
            const copyBtns = Array.from(lastTurn.querySelectorAll(
              'button[aria-label*="opy" i], button[mattooltip*="opy" i], button[title*="opy" i],' +
              ' ms-copy-button button, .code-actions button, .copy-button, button.copy,' +
              ' [data-test-id*="copy" i]'
            ));
            for (const btn of copyBtns) {
              if ((btn as HTMLElement).offsetParent !== null) {
                (btn as HTMLElement).click();
                return true;
              }
            }
            return false;
          }).catch(() => false);

          if (inlineCopied) {
            console.log('[continue-chat] Clicked inline copy button on code block');
            await sleep(800);
            // Poll __clipboardText first (set by interceptor), fall back to readText
            let inlineClipText = await page.evaluate(() => (window as any).__clipboardText as string || '').catch(() => '');
            if (!inlineClipText || inlineClipText.trim().length === 0) {
              for (let p = 0; p < 8; p++) {
                await sleep(400);
                inlineClipText = await page.evaluate(() => (window as any).__clipboardText as string || '').catch(() => '');
                if (inlineClipText && inlineClipText.trim().length > 0) break;
              }
            }
            if (!inlineClipText || inlineClipText.trim().length === 0) {
              inlineClipText = await page.evaluate(async () => {
                try { return await navigator.clipboard.readText(); } catch { return ''; }
              }).catch(() => '');
            }
            if (inlineClipText && inlineClipText.trim().length > 0) {
              console.log(`[continue-chat] Clipboard captured via inline copy, length=${inlineClipText.length}`);
              return { text: inlineClipText.trim(), timestamp: new Date(), isComplete: true };
            }
          }

          // ── STEP 6: DOM text extraction fallback ──────────────────────────────
          // Extract text content from the last chat turn.
          // Use ms-chat-turn without actor filter (actor attr not set in current AI Studio).
          const domText = await page.evaluate(() => {
            const turns = document.querySelectorAll('ms-chat-turn');
            if (turns.length === 0) return '';
            const lastTurn = turns[turns.length - 1] as HTMLElement;
            // Collect ALL non-empty code blocks and join them (large JSON may span multiple)
            const codeBlocks = Array.from(lastTurn.querySelectorAll(
              'code[class*="language"], pre code, pre, .code-block, ms-code-block'
            ));
            const codeTexts = codeBlocks
              .map(el => (el.textContent || '').trim())
              .filter(t => t.length > 10);
            if (codeTexts.length > 0) {
              // Return the LONGEST code block (most likely the full JSON)
              return codeTexts.reduce((a, b) => (b.length > a.length ? b : a), '');
            }
            // Fall back to full text content of the turn (remove buttons/icons)
            const clone = lastTurn.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('button, mat-icon, ms-toolbar, ms-chat-turn-options').forEach(el => el.remove());
            return (clone.textContent || '').trim();
          }).catch(() => '');

          if (domText && domText.trim().length > 10) {
            // Strip any UI chrome prefix (text before the first { or [)
            let cleaned = domText.trim();
            const jsonStart = cleaned.search(/[{[]/);
            if (jsonStart > 0) cleaned = cleaned.slice(jsonStart);
            console.log(`[continue-chat] Extracted response via DOM text, length=${cleaned.length}`);
            return { text: cleaned, timestamp: new Date(), isComplete: true };
          }

          await sleep(pollInterval);
        }

        throw new Error(
          'Could not extract response — Gemini may still be generating. Please wait and try again.'
        );

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
    // Store so recovery can re-attach if Gemini fails with "internal error"
    this.sessions.get(projectId)!.lastAttachedFilePath = absoluteVideoPath;
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
   * Wait for AI response to complete — clipboard-based extraction (voicemap only).
   * Uses the 3-dot More Options → Copy approach, same as continueChat.
   */
  private async waitForResponse(page: Page, userMessage: string, chatTurnsBefore: number = 0): Promise<ParsedResponse> {
    console.log("[voicemap-wait] Starting clipboard-based response wait for:", userMessage.slice(0, 80));
    console.log(`[voicemap-wait] chatTurnsBefore: ${chatTurnsBefore}`);

    // ── Step 1: Wait 5s for Gemini to start responding ─────────────────────
    console.log("[voicemap-wait] Waiting 5s for Gemini to start...");
    await sleep(5000);

    // ── Step 2: Poll for generation to complete (stop button gone, max 3 min) ─
    console.log("[voicemap-wait] Polling for generation to finish...");
    const maxWait = 3 * 60 * 1000;
    const pollInterval = 2000;
    const startTime = Date.now();
    let generationDone = false;

    while (Date.now() - startTime < maxWait) {
      const isGenerating = await page.evaluate(() => {
        // Check for stop/generating signals
        const allIcons = Array.from(document.querySelectorAll('mat-icon'));
        const hasProgressIcon = allIcons.some(el =>
          (el.textContent || '').trim() === 'progress_activity'
        );
        if (hasProgressIcon) return true;
        const stopSelectors = [
          'button[aria-label="Stop"]',
          'button[mattooltip="Stop"]',
          'button[aria-label*="stop" i]',
          'button[aria-label*="Stop streaming" i]',
        ];
        return stopSelectors.some(s => {
          const el = document.querySelector(s) as HTMLElement | null;
          return el && el.offsetParent !== null;
        });
      }).catch(() => false);

      if (!isGenerating) {
        console.log("[voicemap-wait] Generation complete — stop button gone");
        generationDone = true;
        break;
      }
      console.log("[voicemap-wait] Still generating — waiting 2s...");
      await sleep(pollInterval);
    }

    if (!generationDone) {
      console.warn("[voicemap-wait] Generation wait timed out after 3 min — extracting anyway");
    }

    // ── Step 3: Extra buffer after generation detected complete ────────────
    await sleep(1500);
    console.log("[voicemap-wait] Post-generation buffer done — starting clipboard extraction");

    // ── Step 4: Find the 3-dot more-options button on the last model turn ──
    // Scroll to the bottom first so the last turn is visible
    await page.evaluate(() => {
      const scrollTargets = [
        document.querySelector('ms-chat-viewport'),
        document.querySelector('[class*="chat-viewport"]'),
        document.querySelector('main'),
        document.documentElement,
        document.body,
      ];
      for (const el of scrollTargets) {
        if (el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
      }
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await sleep(800);

    const moreButtonSelectors = [
      'ms-chat-turn[actor="model"]:last-of-type ms-overflow-menu button',
      'ms-chat-turn[actor="model"]:last-of-type button[aria-label*="more" i]',
      'ms-chat-turn[actor="model"]:last-of-type button[aria-label*="options" i]',
      'ms-chat-turn[actor="model"]:last-of-type [data-mat-icon-name="more_vert"]',
      'ms-chat-turn:last-of-type ms-overflow-menu button',
      'ms-model-response:last-of-type ms-overflow-menu button',
    ];

    let moreButtonFound = false;
    for (const sel of moreButtonSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          console.log(`[voicemap-wait] Found more-options button: ${sel}`);
          await el.click();
          moreButtonFound = true;
          break;
        }
      } catch { /* try next selector */ }
    }

    if (!moreButtonFound) {
      // Fallback: hover over last model turn to reveal the toolbar, then find the button
      console.warn("[voicemap-wait] More-options button not found via selector — trying hover");
      await page.evaluate(() => {
        const turns = Array.from(document.querySelectorAll(
          'ms-chat-turn[actor="model"], ms-model-response'
        ));
        if (turns.length > 0) {
          const last = turns[turns.length - 1] as HTMLElement;
          last.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          last.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        }
      }).catch(() => {});
      await sleep(600);
      for (const sel of moreButtonSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            console.log(`[voicemap-wait] Found more-options button after hover: ${sel}`);
            await el.click();
            moreButtonFound = true;
            break;
          }
        } catch { /* try next */ }
      }
    }

    if (!moreButtonFound) {
      console.warn("[voicemap-wait] Could not find more-options button — returning empty");
      return { text: "", timestamp: new Date(), isComplete: false, debug: "more-options button not found" };
    }

    // ── Step 5: Click "Copy" in the dropdown menu ───────────────────────────
    await sleep(500);
    const copySelectors = [
      'button[aria-label="Copy"]',
      '[role="menuitem"][aria-label*="Copy" i]',
      'mat-menu-item:has(mat-icon:contains("content_copy"))',
      'button.mat-menu-item',
    ];

    let copyClicked = false;
    for (const sel of copySelectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          const text = await el.textContent().catch(() => '');
          const label = await el.getAttribute('aria-label').catch(() => '');
          if ((text && text.toLowerCase().includes('copy')) ||
              (label && label.toLowerCase().includes('copy'))) {
            await el.click();
            copyClicked = true;
            console.log(`[voicemap-wait] Clicked Copy via selector: ${sel}`);
            break;
          }
        }
        if (copyClicked) break;
        // Also try direct click on first match for explicit copy selectors
        const direct = await page.$(sel);
        if (direct && (sel.includes('Copy') || sel.includes('copy'))) {
          await direct.click();
          copyClicked = true;
          console.log(`[voicemap-wait] Direct copy click: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }

    if (!copyClicked) {
      // Last resort — look for any visible menu item with "copy" text
      copyClicked = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll(
          '[role="menuitem"], [role="option"], .mat-menu-item, button'
        ));
        for (const item of items) {
          const t = (item.textContent || '').toLowerCase().trim();
          if (t === 'copy' || t.startsWith('copy')) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      }).catch(() => false);
      if (copyClicked) console.log("[voicemap-wait] Clicked Copy via evaluate fallback");
    }

    if (!copyClicked) {
      console.warn("[voicemap-wait] Could not click Copy — returning empty");
      return { text: "", timestamp: new Date(), isComplete: false, debug: "copy menu item not found" };
    }

    // ── Step 6: Read clipboard ──────────────────────────────────────────────
    await sleep(800);
    let clipboardText = "";
    try {
      clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    } catch {
      // Permission denied — try the intercepted __clipboardText value
      clipboardText = await page.evaluate(() => (window as any).__clipboardText || "").catch(() => "");
    }

    if (clipboardText && clipboardText.length > 0) {
      console.log(`[voicemap-wait] Got response via clipboard, length: ${clipboardText.length}`);
      return { text: clipboardText, timestamp: new Date(), isComplete: true };
    }

    console.warn("[voicemap-wait] Clipboard was empty after copy click — returning empty");
    return { text: "", timestamp: new Date(), isComplete: false, debug: "clipboard empty after copy" };
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
      if (candidate.length > 20) {
        console.log(`[innerText] S1: last user msg+newline at ${idx}, response len=${candidate.length}`);
        return candidate;
      }
    }

    // Strategy 2: last occurrence without trailing newline
    idx = pageText.lastIndexOf(msgAnchor);
    if (idx !== -1) {
      const candidate = extractAfterMsg(idx);
      if (candidate.length > 20) {
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
        if (candidate.length > 20) {
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
      if (candidate.length > 20) {
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
export const voicemapStudioService = new VoicemapStudioService();

// Also export the class for testing or custom instances
export { VoicemapStudioService };

// Export types
export type { ParsedResponse, SessionData };
