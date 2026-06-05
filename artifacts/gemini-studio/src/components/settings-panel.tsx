import { useState, useEffect, useRef } from 'react'
import { Settings, X, Key, Mic, Save, CheckCircle, XCircle, Globe, Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  GeminiKeys, ElevenLabsKeys,
  loadGeminiKeys, saveGeminiKeys,
  loadElevenLabsKeys, saveElevenLabsKeys,
  resetElUsageIfKeyChanged,
} from '@/lib/api-keys'
import { Sounds } from '@/lib/sounds'

function KeyStatusBadge({ active, quota }: { active: boolean; quota: boolean }) {
  if (quota) return (
    <span className="inline-flex items-center gap-1 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-full px-2 py-0.5">
      <XCircle className="w-3 h-3" />Quota exceeded
    </span>
  )
  if (active) return (
    <span className="inline-flex items-center gap-1 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">
      <CheckCircle className="w-3 h-3" />Active
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-secondary/50 border border-border rounded-full px-2 py-0.5">
      Standby
    </span>
  )
}

type CookiesSaveStatus = 'idle' | 'saving' | 'success' | 'error'

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [gemini, setGemini] = useState<GeminiKeys>({ key1: '', key2: '', active: 1 })
  const [el, setEl] = useState<ElevenLabsKeys>({ key1: '', key2: '', voiceId: '', active: 1 })
  const [saved, setSaved] = useState(false)

  // Cookies section state
  const [cookiesJson, setCookiesJson] = useState('')
  const [cookiesSaveStatus, setCookiesSaveStatus] = useState<CookiesSaveStatus>('idle')
  const [cookiesMsg, setCookiesMsg] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) {
      setGemini(loadGeminiKeys())
      setEl(loadElevenLabsKeys())
      setCookiesJson('')
      setCookiesSaveStatus('idle')
      setCookiesMsg('')
      Sounds.settingsOpen()
    } else {
      Sounds.settingsClose()
    }
  }, [open])

  const handleSave = () => {
    saveGeminiKeys(gemini)
    const trimmedEl = {
      ...el,
      key1: el.key1.trim(),
      key2: el.key2.trim(),
      voiceId: el.voiceId.trim(),
    }
    setEl(trimmedEl)
    resetElUsageIfKeyChanged(1, trimmedEl.key1)
    resetElUsageIfKeyChanged(2, trimmedEl.key2)
    saveElevenLabsKeys(trimmedEl)
    Sounds.save()
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const handleSaveCookies = async () => {
    const raw = cookiesJson.trim()
    if (!raw) return

    // Quick client-side JSON validation
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        setCookiesSaveStatus('error')
        setCookiesMsg('Cookies must be a JSON array. Copy from browser devtools as an array.')
        return
      }
    } catch {
      setCookiesSaveStatus('error')
      setCookiesMsg('Invalid JSON — make sure you paste a valid cookies array.')
      return
    }

    setCookiesSaveStatus('saving')
    setCookiesMsg('')

    try {
      const projectId = (() => {
        try { return localStorage.getItem('shiva-last-project-id') || 'default-project' } catch { return 'default-project' }
      })()

      const fd = new FormData()
      fd.append('action', 'set-cookies')
      fd.append('projectId', projectId)
      fd.append('cookiesJson', raw)

      const res = await fetch('/api/gemini', { method: 'POST', body: fd })
      const data = await res.json()

      if (res.ok && data.success) {
        Sounds.save()
        setCookiesSaveStatus('success')
        setCookiesMsg(data.message || 'Cookies saved successfully!')
        setCookiesJson('')
        setTimeout(() => { setCookiesSaveStatus('idle'); setCookiesMsg('') }, 4000)
      } else {
        setCookiesSaveStatus('error')
        setCookiesMsg(data.error || 'Failed to save cookies.')
      }
    } catch (e) {
      setCookiesSaveStatus('error')
      setCookiesMsg('Network error — make sure the server is running.')
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md bg-[oklch(0.1_0_0)] border-l border-border flex flex-col h-full shadow-2xl animate-in slide-in-from-right duration-200 overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-[oklch(0.1_0_0)] z-10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
              <Settings className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h2 className="font-bold text-sm text-foreground">Settings</h2>
              <p className="text-xs text-muted-foreground">API Keys & Configuration</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 p-5 space-y-8">

          {/* Google Session Cookies */}
          <section>
            <div className="flex items-center gap-2 mb-1">
              <Globe className="w-4 h-4 text-primary" />
              <h3 className="font-semibold text-sm text-foreground">Google Session Cookies</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              SHIVA uses your Google session to talk to AI Studio. Paste your browser cookies below to connect your account.
            </p>

            <div className="space-y-3">
              {/* How-to hint */}
              <div className="p-3 rounded-xl bg-primary/5 border border-primary/20 text-xs text-muted-foreground space-y-1.5">
                <p className="font-medium text-primary">How to get your cookies:</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>Open <span className="font-mono text-foreground">aistudio.google.com</span> in Chrome</li>
                  <li>Press <span className="font-mono text-foreground">F12</span> → Application → Cookies</li>
                  <li>Install <span className="font-mono text-foreground">Cookie-Editor</span> extension → Export as JSON</li>
                  <li>Paste the entire JSON array below</li>
                </ol>
              </div>

              {/* Textarea */}
              <div className="relative">
                <textarea
                  ref={textareaRef}
                  value={cookiesJson}
                  onChange={e => {
                    setCookiesJson(e.target.value)
                    if (cookiesSaveStatus !== 'idle') { setCookiesSaveStatus('idle'); setCookiesMsg('') }
                  }}
                  placeholder={'[\n  {\n    "name": "__Secure-3PSID",\n    "value": "...",\n    ...\n  },\n  ...\n]'}
                  rows={7}
                  className="w-full rounded-xl border border-border bg-input text-xs font-mono p-3 resize-none focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/40"
                />
              </div>

              {/* Status message */}
              {cookiesMsg && (
                <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs ${
                  cookiesSaveStatus === 'success'
                    ? 'bg-green-500/10 border border-green-500/20 text-green-400'
                    : 'bg-red-500/10 border border-red-500/20 text-red-400'
                }`}>
                  {cookiesSaveStatus === 'success'
                    ? <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  }
                  {cookiesMsg}
                </div>
              )}

              {/* Save cookies button */}
              <Button
                onClick={handleSaveCookies}
                disabled={!cookiesJson.trim() || cookiesSaveStatus === 'saving'}
                className={`w-full font-semibold transition-all ${
                  cookiesSaveStatus === 'success'
                    ? 'bg-green-500 hover:bg-green-500 text-white'
                    : cookiesSaveStatus === 'error'
                    ? 'bg-red-500/80 hover:bg-red-500/80 text-white'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                }`}
              >
                {cookiesSaveStatus === 'saving' && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {cookiesSaveStatus === 'success' && <CheckCircle className="w-4 h-4 mr-2" />}
                {cookiesSaveStatus === 'error' && <AlertCircle className="w-4 h-4 mr-2" />}
                {cookiesSaveStatus === 'saving' ? 'Saving Cookies...'
                  : cookiesSaveStatus === 'success' ? 'Cookies Saved!'
                  : cookiesSaveStatus === 'error' ? 'Try Again'
                  : 'Save Cookies'}
              </Button>
            </div>
          </section>

          {/* SHIVA API Keys */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Key className="w-4 h-4 text-primary" />
              <h3 className="font-semibold text-sm text-foreground">SHIVA API Keys</h3>
            </div>
            <div className="space-y-4">
              {/* Key 1 */}
              <div className="p-4 rounded-xl bg-secondary/30 border border-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Key 1</span>
                  <KeyStatusBadge active={gemini.active === 1} quota={false} />
                </div>
                <Input
                  type="password"
                  value={gemini.key1}
                  onChange={e => setGemini(g => ({ ...g, key1: e.target.value }))}
                  placeholder="AIza..."
                  className="bg-input border-border text-xs font-mono"
                />
              </div>
              {/* Key 2 */}
              <div className="p-4 rounded-xl bg-secondary/30 border border-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Key 2 (Fallback)</span>
                  <KeyStatusBadge active={gemini.active === 2} quota={false} />
                </div>
                <Input
                  type="password"
                  value={gemini.key2}
                  onChange={e => setGemini(g => ({ ...g, key2: e.target.value }))}
                  placeholder="AIza... (optional)"
                  className="bg-input border-border text-xs font-mono"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                If Key 1 hits quota (429), SHIVA automatically switches to Key 2.
              </p>
            </div>
          </section>

          {/* ElevenLabs API Keys */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Mic className="w-4 h-4 text-primary" />
              <h3 className="font-semibold text-sm text-foreground">ElevenLabs API Keys</h3>
            </div>
            <div className="space-y-4">
              {/* Key 1 */}
              <div className="p-4 rounded-xl bg-secondary/30 border border-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Key 1</span>
                  <KeyStatusBadge active={el.active === 1} quota={false} />
                </div>
                <Input
                  type="password"
                  value={el.key1}
                  onChange={e => setEl(k => ({ ...k, key1: e.target.value }))}
                  placeholder="sk_..."
                  className="bg-input border-border text-xs font-mono"
                />
              </div>
              {/* Key 2 */}
              <div className="p-4 rounded-xl bg-secondary/30 border border-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Key 2 (Fallback)</span>
                  <KeyStatusBadge active={el.active === 2} quota={false} />
                </div>
                <Input
                  type="password"
                  value={el.key2}
                  onChange={e => setEl(k => ({ ...k, key2: e.target.value }))}
                  placeholder="sk_... (optional)"
                  className="bg-input border-border text-xs font-mono"
                />
              </div>
              {/* Voice ID */}
              <div className="p-4 rounded-xl bg-secondary/30 border border-border space-y-2">
                <span className="text-xs font-medium text-muted-foreground">Voice ID</span>
                <Input
                  value={el.voiceId}
                  onChange={e => setEl(k => ({ ...k, voiceId: e.target.value }))}
                  placeholder="EXAVITQu4vr4xnSDxMaL"
                  className="bg-input border-border text-xs font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Find Voice IDs at elevenlabs.io/voice-library
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                If Key 1 gives 401/429, SHIVA silently switches to Key 2.
              </p>
            </div>
          </section>
        </div>

        {/* Save Button */}
        <div className="p-5 border-t border-border sticky bottom-0 bg-[oklch(0.1_0_0)]">
          <Button
            onClick={handleSave}
            className={`w-full font-semibold transition-all duration-300 ${saved ? 'bg-green-500 hover:bg-green-500 text-white scale-[1.03] shadow-lg shadow-green-500/30' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}
          >
            {saved ? (
              <><CheckCircle className="w-4 h-4 mr-2 animate-bounce" />Saved!</>
            ) : (
              <><Save className="w-4 h-4 mr-2" />Save Settings</>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
