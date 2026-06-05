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

  // File upload
  attachButton: 'button[aria-label="Insert media"], button[mattooltip="Insert media"], button[aria-label="Add files"], [data-test-id="attach-button"]',
  fileInput: 'input[type="file"][accept*="video"], input[type="file"][multiple], input[type="file"]',
  uploadProgress: 'mat-progress-bar, [role="progressbar"], .upload-progress-indicator, [class*="uploading"]',

  // Response detection - Model chat turns
  loadingSpinner: 'ms-loading-indicator, .loading-indicator, [class*="spinner"], mat-spinner, .generating-indicator',
  responseContainer: 'ms-chat-turn[actor="model"] ms-cmark-node, ms-chat-turn[actor="model"] .markdown, ms-chat-turn[actor="model"] p',
  modelMessage: 'ms-chat-turn[actor="model"]',
};

interface SessionData {
  context: BrowserContext;
  page: Page;
  browser: Browser;
}

interface ParsedResponse {
  text: string;
  timestamp: Date;
  isComplete: boolean;
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
      ],
    });

    // Create context with cookies
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
    });

    // Add cookies to context
    await context.addCookies(cookies);

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
    this.sessions.set(projectId, { context, page, browser });
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
    videoPath: string,
    prompt: string,
    youtubeLinks: string[] = []
  ): Promise<ParsedResponse> {
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(
        `No session found for project: ${projectId}. Call initSession first.`
      );
    }

    const { page } = session;

    // Try to click "New chat" or "+" button to start fresh, but don't fail if not found
    await sleep(randomDelay());
    try {
      const newChatBtn = await page.$(
        `${SELECTORS.newChatButton}, ${SELECTORS.plusButton}`
      );
      if (newChatBtn) {
        await newChatBtn.click();
        await sleep(randomDelay(500, 1000));
        console.log("Clicked new chat button");
      } else {
        console.log("New chat button not found, using existing chat interface");
      }
    } catch (error) {
      console.log("New chat button click failed, using existing chat interface");
    }

    // Wait for chat interface to be ready
    await page.waitForSelector(SELECTORS.chatInput, {
      timeout: 60000,
    });
    await sleep(randomDelay());

    // Upload video file via direct file input injection (more reliable than attach button)
    const absoluteVideoPath = path.resolve(videoPath);
    console.log(`Uploading video: ${absoluteVideoPath}`);

    // Inject a hidden file input and use it for upload - bypasses flaky attach button
    const fileInputHandle = await page.evaluateHandle(() => {
      // Remove any previously injected input
      const existing = document.getElementById('__v0_file_input__');
      if (existing) existing.remove();

      // Create new file input
      const input = document.createElement('input');
      input.type = 'file';
      input.id = '__v0_file_input__';
      input.accept = 'video/*,audio/*,image/*';
      input.style.position = 'absolute';
      input.style.top = '-9999px';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      return input;
    });

    // Convert handle to ElementHandle and set the file
    const fileInput = fileInputHandle.asElement();
    if (fileInput) {
      await fileInput.setInputFiles(absoluteVideoPath);

      // Dispatch change event to trigger any listeners
      await page.evaluate((el) => {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, fileInput);

      // Also try the native attach button flow as backup
      await sleep(randomDelay(500, 800));
      const attachBtn = await page.$(SELECTORS.attachButton);
      if (attachBtn) {
        try {
          await attachBtn.click();
          await sleep(randomDelay(300, 500));
          // If a native file input appears, set the file there too
          const nativeInput = await page.$(SELECTORS.fileInput);
          if (nativeInput) {
            await nativeInput.setInputFiles(absoluteVideoPath);
          }
        } catch {
          // Attach button click failed, continue with injected input
        }
      }

      // Wait for upload to complete (progress indicator disappears)
      await this.waitForUploadComplete(page);
    } else {
      console.warn(
        "Could not create file input, attempting to continue without video upload"
      );
    }

    await sleep(randomDelay(500, 1000));

    // Build the full prompt with YouTube links
    let fullPrompt = "";
    if (youtubeLinks.length > 0) {
      fullPrompt += "Reference YouTube videos:\n";
      youtubeLinks.forEach((link, index) => {
        fullPrompt += `${index + 1}. ${link}\n`;
      });
      fullPrompt += "\n";
    }
    fullPrompt += prompt;

    // Type the prompt with humanlike delay
    await this.typeWithHumanDelay(page, SELECTORS.chatInput, fullPrompt);
    await sleep(randomDelay());

    // Click send button
    await this.clickSendButton(page);

    // Wait for response with polling
    const response = await this.waitForResponse(page);

    return response;
  }

  /**
   * Continue an existing chat conversation
   * @param projectId - Project identifier
   * @param message - Message to send
   */
  async continueChat(projectId: string, message: string): Promise<ParsedResponse> {
    const session = this.sessions.get(projectId);
    if (!session) {
      throw new Error(
        `No session found for project: ${projectId}. Call initSession first.`
      );
    }

    const { page } = session;

    // Wait for chat input to be available
    await page.waitForSelector(SELECTORS.chatInput, {
      timeout: 60000,
    });
    await sleep(randomDelay());

    // Type message with humanlike delay
    await this.typeWithHumanDelay(page, SELECTORS.chatInput, message);
    await sleep(randomDelay());

    // Click send button
    await this.clickSendButton(page);

    // Wait for response
    const response = await this.waitForResponse(page);

    return response;
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
   * @param projectId - Project identifier
   */
  hasSession(projectId: string): boolean {
    return this.sessions.has(projectId);
  }

  /**
   * Get the page instance for a project (for advanced usage)
   * @param projectId - Project identifier
   */
  getPage(projectId: string): Page | undefined {
    return this.sessions.get(projectId)?.page;
  }

  // Private helper methods

  /**
   * Wait for file upload to complete
   */
  private async waitForUploadComplete(page: Page): Promise<void> {
    // First wait for progress indicator to appear
    try {
      await page.waitForSelector(SELECTORS.uploadProgress, {
        timeout: 5000,
        state: "visible",
      });
    } catch {
      // Progress indicator might not appear for small files
      console.log(
        "No upload progress indicator detected, assuming quick upload"
      );
      return;
    }

    // Then wait for it to disappear
    try {
      await page.waitForSelector(SELECTORS.uploadProgress, {
        timeout: 120000, // 2 minutes max for upload
        state: "hidden",
      });
      console.log("Upload completed");
    } catch {
      console.warn("Upload progress indicator did not disappear, continuing...");
    }
  }

  /**
   * Type text with humanlike delays between characters
   */
  private async typeWithHumanDelay(
    page: Page,
    selector: string,
    text: string
  ): Promise<void> {
    const element = await page.$(selector);
    if (!element) {
      throw new Error(`Element not found: ${selector}`);
    }

    await element.click();
    await sleep(randomDelay(100, 200));

    // Type with variable delay between characters
    for (const char of text) {
      await element.type(char, { delay: randomDelay(20, 80) });

      // Occasionally add longer pauses (simulating thinking)
      if (Math.random() < 0.05) {
        await sleep(randomDelay(100, 300));
      }
    }
  }

  /**
   * Click the send button with multiple fallback methods
   */
  private async clickSendButton(page: Page): Promise<void> {
    // After typing the prompt, try multiple send methods
    await sleep(randomDelay(500, 1000));

    // Method 1: Try clicking the Run/Send button
    try {
      const sendBtn = await page.$('button[aria-label="Run"], ms-run-button button, button[mattooltip="Run"], button[aria-label="Send message"], button[mattooltip="Send message"]');
      if (sendBtn) {
        await sendBtn.click();
        console.log("Clicked send button");
      } else {
        // Method 2: Press Ctrl+Enter
        await page.keyboard.press('Control+Enter');
        console.log("Pressed Ctrl+Enter");
      }
    } catch {
      // Method 3: Fallback to Ctrl+Enter
      await page.keyboard.press('Control+Enter');
      console.log("Fallback Ctrl+Enter");
    }

    await sleep(randomDelay(1000, 2000));
  }

  /**
   * Wait for AI response to complete
   */
  private async waitForResponse(page: Page): Promise<ParsedResponse> {
    const startTime = Date.now();
    let lastResponseText = "";
    let stableCount = 0;
    const stableThreshold = 3; // Response must be stable for 3 polls

    console.log("Waiting for AI response...");

    // First, wait for the model message to appear.
    // Video analysis can take 2-3+ minutes before Gemini starts responding.
    try {
      await page.waitForSelector(SELECTORS.modelMessage, { timeout: 180000 });
      console.log("Model response started appearing");
    } catch {
      console.warn("Model response did not appear within timeout");
      return {
        text: "",
        timestamp: new Date(),
        isComplete: false,
      };
    }

    while (Date.now() - startTime < this.maxResponseWaitTime) {
      await sleep(this.pollInterval);

      // Check if loading spinner is present
      const isLoading = await page.$(SELECTORS.loadingSpinner);

      // Get current response text
      const currentResponse = await this.extractLatestResponse(page);

      if (currentResponse && currentResponse === lastResponseText && !isLoading) {
        stableCount++;
        if (stableCount >= stableThreshold) {
          console.log("Response complete");
          return {
            text: currentResponse,
            timestamp: new Date(),
            isComplete: true,
          };
        }
      } else {
        stableCount = 0;
        lastResponseText = currentResponse || "";
      }

      // Log progress
      if (currentResponse) {
        const preview =
          currentResponse.length > 100
            ? currentResponse.substring(0, 100) + "..."
            : currentResponse;
        console.log(`Response in progress: ${preview}`);
      }
    }

    // Timeout reached
    console.warn("Response timeout reached, returning partial response");
    return {
      text: lastResponseText,
      timestamp: new Date(),
      isComplete: false,
    };
  }

  /**
   * Extract the latest model response from the page - targets only markdown content
   */
  private async extractLatestResponse(page: Page): Promise<string | null> {
    try {
      const text = await page.evaluate(() => {
        const turns = document.querySelectorAll('ms-chat-turn[actor="model"]');
        const lastTurn = turns[turns.length - 1];
        if (!lastTurn) return '';

        // Get only ms-cmark-node or .markdown content (actual response)
        const contentEl = lastTurn.querySelector('ms-cmark-node, .markdown, ms-text-chunk');
        if (contentEl) {
          return contentEl.textContent?.trim() || '';
        }

        // Fallback: clone and strip all UI elements
        const cloned = lastTurn.cloneNode(true) as Element;
        ['button', 'ms-toolbar', 'ms-copy-button', 'mat-icon', 'ms-chat-turn-options',
         'ms-prompt-chunk', 'ms-run-button', 'ms-token-count', '[class*="toolbar"]',
         '[class*="action-bar"]', '[class*="footer"]'].forEach(sel => {
          cloned.querySelectorAll(sel).forEach(n => n.remove());
        });
        return cloned.textContent?.trim() || '';
      });

      if (text) {
        console.log('[v0] Extracted response, length:', text.length);
        return text;
      }

      return null;
    } catch (error) {
      console.error('[v0] Error extracting response:', error);
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
