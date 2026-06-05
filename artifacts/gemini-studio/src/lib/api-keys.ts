const GEMINI_KEYS_KEY = 'shiva-gemini-keys'
const ELEVENLABS_KEYS_KEY = 'shiva-elevenlabs-keys'
const LAST_RESPONSE_KEY = 'shiva-last-response'
const CLEANED_SCRIPT_KEY = 'shiva-cleaned-script'
const EL_USAGE_KEY = 'shiva-el-usage'

// ── ElevenLabs local usage tracker ─────────────────────────────────────────
export interface ElSlotUsage { fingerprint: string; used: number }
export interface ElUsage { slot1: ElSlotUsage; slot2: ElSlotUsage }

const DEFAULT_SLOT: ElSlotUsage = { fingerprint: '', used: 0 }

export function loadElUsage(): ElUsage {
  try {
    const raw = JSON.parse(localStorage.getItem(EL_USAGE_KEY) || '{}')
    return {
      slot1: raw.slot1 ?? { ...DEFAULT_SLOT },
      slot2: raw.slot2 ?? { ...DEFAULT_SLOT },
    }
  } catch { return { slot1: { ...DEFAULT_SLOT }, slot2: { ...DEFAULT_SLOT } } }
}

export function saveElUsage(usage: ElUsage) {
  localStorage.setItem(EL_USAGE_KEY, JSON.stringify(usage))
}

function fingerprint(key: string): string { return key.slice(-8) }

export function recordElUsage(slot: 1 | 2, key: string, chars: number) {
  const usage = loadElUsage()
  const fp = fingerprint(key)
  const slotKey = slot === 1 ? 'slot1' : 'slot2'
  if (usage[slotKey].fingerprint !== fp) {
    usage[slotKey] = { fingerprint: fp, used: 0 }
  }
  usage[slotKey].used += chars
  saveElUsage(usage)
}

export function resetElUsageIfKeyChanged(slot: 1 | 2, newKey: string) {
  const usage = loadElUsage()
  const fp = fingerprint(newKey)
  const slotKey = slot === 1 ? 'slot1' : 'slot2'
  if (usage[slotKey].fingerprint !== fp) {
    usage[slotKey] = { fingerprint: fp, used: 0 }
    saveElUsage(usage)
  }
}

export function getElUsed(slot: 1 | 2, key: string): number {
  const usage = loadElUsage()
  const fp = fingerprint(key)
  const slotKey = slot === 1 ? 'slot1' : 'slot2'
  if (usage[slotKey].fingerprint !== fp) return 0
  return usage[slotKey].used
}

export interface GeminiKeys {
  key1: string
  key2: string
  active: 1 | 2
}

export interface ElevenLabsKeys {
  key1: string
  key2: string
  voiceId: string
  active: 1 | 2
}

export function loadGeminiKeys(): GeminiKeys {
  try {
    return JSON.parse(localStorage.getItem(GEMINI_KEYS_KEY) || '{}')
  } catch { return { key1: '', key2: '', active: 1 } }
}

export function saveGeminiKeys(keys: GeminiKeys) {
  localStorage.setItem(GEMINI_KEYS_KEY, JSON.stringify(keys))
}

export function loadElevenLabsKeys(): ElevenLabsKeys {
  try {
    return JSON.parse(localStorage.getItem(ELEVENLABS_KEYS_KEY) || '{}')
  } catch { return { key1: '', key2: '', voiceId: '', active: 1 } }
}

export function saveElevenLabsKeys(keys: ElevenLabsKeys) {
  localStorage.setItem(ELEVENLABS_KEYS_KEY, JSON.stringify(keys))
}

export function saveLastResponse(text: string) {
  localStorage.setItem(LAST_RESPONSE_KEY, text)
}

export function loadLastResponse(): string {
  return localStorage.getItem(LAST_RESPONSE_KEY) || ''
}

export function saveCleanedScript(text: string) {
  localStorage.setItem(CLEANED_SCRIPT_KEY, text)
}

export function loadCleanedScript(): string {
  return localStorage.getItem(CLEANED_SCRIPT_KEY) || ''
}

const CLEAN_PROMPT = `You are a voiceover script extractor. From the text below, extract only the final clean voiceover script. Remove all timestamps, scene numbers, directions, formatting symbols, headers, and technical instructions. Keep only the exact words that should be spoken aloud. Return plain text only, nothing else. Do not return JSON. Do not add any explanation.`

const VOICEOVER_SYSTEM = `Format for ElevenLabs voiceover only. Remove all timestamps, scene descriptions, camera directions, formatting symbols. Keep only natural spoken words exactly as they should be heard. Plain text only.`

export async function callGemini(
  prompt: string,
  keys: GeminiKeys,
  onKeySwitch?: (active: 1 | 2) => void
): Promise<string> {
  // Route through backend proxy to avoid browser-IP blocks (Replit proxy / VPN flags)
  const tryKey = async (key: string) => {
    if (!key) throw new Error('NO_KEY')
    const res = await fetch('/api/gemini-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, key }),
    })
    const data = await res.json()
    if (res.status === 429) throw new Error('QUOTA')
    if (!res.ok) {
      const errMsg = data?.error || `API error (${res.status})`
      throw new Error(errMsg)
    }
    return (data?.text as string) || ''
  }

  const activeKey = keys.active === 1 ? keys.key1 : keys.key2
  try {
    return await tryKey(activeKey)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if ((msg === 'QUOTA' || msg === 'NO_KEY') && keys.key2) {
      const fallback = keys.active === 1 ? 2 : 1
      const fallbackKey = fallback === 1 ? keys.key1 : keys.key2
      onKeySwitch?.(fallback)
      return await tryKey(fallbackKey)
    }
    throw err
  }
}

export async function callGeminiClean(rawResponse: string, keys: GeminiKeys, onKeySwitch?: (active: 1 | 2) => void): Promise<string> {
  return callGemini(`${CLEAN_PROMPT}\n\n${rawResponse}`, keys, onKeySwitch)
}

export async function callGeminiChat(userMsg: string, keys: GeminiKeys, onKeySwitch?: (active: 1 | 2) => void): Promise<string> {
  return callGemini(`${userMsg}\n\n${VOICEOVER_SYSTEM}`, keys, onKeySwitch)
}

export async function callElevenLabs(
  text: string,
  keys: ElevenLabsKeys,
  onKeySwitch?: (active: 1 | 2) => void
): Promise<Blob> {
  // Route through backend proxy to avoid browser-IP blocks and CORS issues
  const tryKey = async (key: string) => {
    if (!key) throw new Error('NO_KEY')
    const res = await fetch('/api/audio/elevenlabs/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key, voiceId: keys.voiceId, text }),
    })
    if (res.ok) return res.blob()

    let errMsg = `Voice generation failed (${res.status})`
    try {
      const d = await res.json()
      errMsg = d?.error || errMsg
    } catch { /* ignore */ }
    if (res.status === 429) errMsg = 'ElevenLabs quota exceeded. Your credits are used up.'
    throw new Error(errMsg)
  }

  const activeKey = keys.active === 1 ? keys.key1 : keys.key2
  try {
    return await tryKey(activeKey)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    const isRetryable = msg.includes('quota') || msg === 'NO_KEY' || msg.includes('credits are used up')
    if (isRetryable && keys.key2) {
      const fallback = keys.active === 1 ? 2 : 1
      const fallbackKey = fallback === 1 ? keys.key1 : keys.key2
      onKeySwitch?.(fallback)
      return await tryKey(fallbackKey)
    }
    throw err
  }
}
