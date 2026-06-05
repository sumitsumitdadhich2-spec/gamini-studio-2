import { chromium } from 'playwright';

const CHROMIUM = '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium';
const APP_URL = 'http://localhost:80/';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  // Capture all network requests to /api/audio
  const apiCalls = [];
  page.on('response', async (response) => {
    if (response.url().includes('/api/audio')) {
      try {
        const body = await response.text().catch(() => '');
        apiCalls.push({ url: response.url(), status: response.status(), body: body.slice(0, 500) });
      } catch {}
    }
  });

  console.log('=== Opening app ===');
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);

  // Go to Settings and check what's stored
  console.log('\n=== Checking localStorage for ElevenLabs keys ===');
  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem('shiva-elevenlabs-keys');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      hasKey1: !!parsed.key1,
      key1Len: parsed.key1?.length ?? 0,
      key1Start: parsed.key1?.slice(0, 8) ?? '',
      hasKey2: !!parsed.key2,
      voiceId: parsed.voiceId ?? '',
      active: parsed.active,
    };
  });
  console.log('Stored ElevenLabs settings:', JSON.stringify(stored, null, 2));

  // Also check last response
  const lastResp = await page.evaluate(() => localStorage.getItem('shiva-last-response'));
  const cleanedScript = await page.evaluate(() => localStorage.getItem('shiva-cleaned-script'));
  console.log('\nlastResponse length:', lastResp?.length ?? 0);
  console.log('cleanedScript length:', cleanedScript?.length ?? 0);
  console.log('cleanedScript preview:', cleanedScript?.slice(0, 200) ?? '(empty)');

  // Navigate to voice page
  console.log('\n=== Navigating to Voice page ===');
  await page.goto(APP_URL + '#/voice', { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  
  // Try clicking the Voice tab directly
  const voiceTab = page.locator('a:has-text("Voice"), button:has-text("Voice"), [href*="voice"]').first();
  const voiceTabVisible = await voiceTab.isVisible().catch(() => false);
  if (voiceTabVisible) {
    await voiceTab.click();
    await page.waitForTimeout(1000);
  } else {
    // Direct URL navigation  
    await page.goto('http://localhost:80/voice', { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  
  await page.screenshot({ path: '/tmp/voice-1-page.png', fullPage: true });
  console.log('Screenshot: /tmp/voice-1-page.png');

  // Find and click "Generate Voiceover" button
  const genBtn = page.locator('button:has-text("Generate"), button:has-text("Voiceover")').first();
  const genBtnVisible = await genBtn.isVisible().catch(() => false);
  console.log('\nGenerate button visible:', genBtnVisible);
  
  if (genBtnVisible) {
    await genBtn.click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '/tmp/voice-2-after-generate.png', fullPage: true });
    
    // Get any error messages
    const pageText = await page.evaluate(() => document.body.innerText);
    const errorLines = pageText.split('\n').filter(l => 
      l.includes('error') || l.includes('Error') || l.includes('invalid') || 
      l.includes('Invalid') || l.includes('401') || l.includes('key') || l.includes('Key')
    );
    console.log('\nError-related lines in page:');
    errorLines.forEach(l => console.log(' ', l.trim()));
  }

  console.log('\n=== API calls intercepted ===');
  apiCalls.forEach(c => console.log(`  ${c.status} ${c.url}\n  body: ${c.body}`));

  // Get full page text
  const finalText = await page.evaluate(() => document.body.innerText);
  console.log('\n=== Voice page content ===');
  console.log(finalText.slice(0, 2000));

  await browser.close();
  console.log('\n=== DONE ===');
})();
