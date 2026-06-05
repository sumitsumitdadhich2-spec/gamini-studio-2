import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation } from 'wouter'
import {
  ArrowLeft, ArrowRight, Calculator, Loader2, Send, RefreshCw,
  CheckCircle, XCircle, Sparkles, Upload, Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { ShivaHeader } from '@/components/shiva-header'
import { loadGeminiKeys, saveGeminiKeys, callGemini, GeminiKeys } from '@/lib/api-keys'
import { Sounds } from '@/lib/sounds'

const VOICEMAP_RAW_KEY = 'shiva-voicemap-raw'
const VOICEMAP_JSON_KEY = 'shiva-voicemap-json'

const CHAT_SYSTEM = `You are a video edit timeline editor. The user will give you a JSON edit plan and a change request. Apply the changes and return only the updated JSON in the exact same format. Do not add explanation. Do not change the MS.SS.MM format. Do not wrap in markdown.`

function parseTimestampMs(ts: string): number {
  if (!ts || !ts.includes('.')) return 0
  const parts = ts.split('.')
  const minutes = parseInt(parts[0] || '0', 10)
  const seconds = parseInt(parts[1] || '0', 10)
  const mm = parseInt(parts[2] || '0', 10)
  return (minutes * 60000) + (seconds * 1000) + (mm * 10)
}

function formatTimestampMs(totalMs: number): string {
  const safeMs = Math.round(totalMs)
  const minutes = Math.floor(safeMs / 60000)
  const remaining = safeMs % 60000
  const seconds = Math.floor(remaining / 1000)
  const mm = Math.round((remaining % 1000) / 10)
  return `${minutes.toString().padStart(2, '0')}.${seconds.toString().padStart(2, '0')}.${mm.toString().padStart(2, '0')}`
}

function extractJsonFromText(text: string): string | null {
  // Try to find JSON object with clips array
  const matches = [...text.matchAll(/\{[\s\S]*?"clips"[\s\S]*?\}/g)]
  for (const m of matches) {
    try { JSON.parse(m[0]); return m[0] } catch {}
  }
  // Fallback: try any JSON object
  const m = text.match(/\{[\s\S]*\}/)
  if (m) { try { JSON.parse(m[0]); return m[0] } catch {} }
  return null
}

export default function JsonMapPage() {
  const [, navigate] = useLocation()
  const [jsonText, setJsonText] = useState('')
  const [isExtracting, setIsExtracting] = useState(false)
  const [extractError, setExtractError] = useState('')
  const [calcResult, setCalcResult] = useState<string | null>(null)
  const [calcMatch, setCalcMatch] = useState<boolean | null>(null)
  const [calcBreakdown, setCalcBreakdown] = useState<{ clipNum: number; raw: string; speed: number; actual: string }[] | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [isChatting, setIsChatting] = useState(false)
  const [chatError, setChatError] = useState('')
  const [geminiKeys, setGeminiKeys] = useState<GeminiKeys>(loadGeminiKeys)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadError, setUploadError] = useState('')
  const [isExtractingFile, setIsExtractingFile] = useState(false)
  const [uploadFileName, setUploadFileName] = useState('')

  const parsedJson = (() => { try { return JSON.parse(jsonText) } catch { return null } })()
  const summary = parsedJson?.summary
  const clips: any[] = parsedJson?.clips || []

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (!file) return

    setUploadError('')
    setUploadFileName(file.name)
    setIsExtractingFile(true)

    const reader = new FileReader()
    reader.onerror = () => { setUploadError('Failed to read file.'); setIsExtractingFile(false) }
    reader.onload = async (ev) => {
      const rawText = (ev.target?.result as string) || ''

      // Step 1: Try direct JSON parse
      try {
        const parsed = JSON.parse(rawText)
        const pretty = JSON.stringify(parsed, null, 2)
        setJsonText(pretty)
        try { localStorage.setItem(VOICEMAP_JSON_KEY, pretty) } catch {}
        setCalcResult(null)
        setIsExtractingFile(false)
        Sounds.save()
        return
      } catch {}

      // Step 2: Try regex extraction
      const regexResult = extractJsonFromText(rawText)
      if (regexResult) {
        try {
          const parsed = JSON.parse(regexResult)
          const pretty = JSON.stringify(parsed, null, 2)
          setJsonText(pretty)
          try { localStorage.setItem(VOICEMAP_JSON_KEY, pretty) } catch {}
          setCalcResult(null)
          setIsExtractingFile(false)
          Sounds.save()
          return
        } catch {}
      }

      // Step 3: Use Gemini AI to extract JSON
      try {
        const keys = loadGeminiKeys()
        const prompt = `Extract the JSON edit plan from the text below. Return ONLY the raw JSON object — no explanation, no markdown, no code fences. The JSON should contain a "clips" array and a "summary" object if present. If no valid JSON is found, return exactly: {}\n\nFILE CONTENT:\n${rawText.slice(0, 12000)}`
        const response = await callGemini(prompt, keys, (active) => {
          const updated = { ...keys, active }
          setGeminiKeys(updated)
          saveGeminiKeys(updated)
        })
        const extracted = extractJsonFromText(response) || response.trim()
        const parsed = JSON.parse(extracted)
        if (!parsed || Object.keys(parsed).length === 0) throw new Error('No JSON found in file')
        const pretty = JSON.stringify(parsed, null, 2)
        setJsonText(pretty)
        try { localStorage.setItem(VOICEMAP_JSON_KEY, pretty) } catch {}
        setCalcResult(null)
        Sounds.save()
      } catch (err) {
        Sounds.error()
        setUploadError(
          err instanceof Error && err.message.includes('No JSON')
            ? `No JSON found in "${file.name}". Make sure the file contains a valid edit plan.`
            : `Could not extract JSON from "${file.name}": ${err instanceof Error ? err.message : 'Unknown error'}`
        )
      } finally {
        setIsExtractingFile(false)
      }
    }
    reader.readAsText(file)
  }

  const handleClearJson = () => {
    setJsonText('')
    setCalcResult(null)
    setCalcBreakdown(null)
    setCalcMatch(null)
    setUploadError('')
    try { localStorage.removeItem(VOICEMAP_JSON_KEY) } catch {}
    Sounds.buttonClick()
  }

  const calculateDurations = useCallback((json: any) => {
    const c: any[] = json?.clips || []
    if (c.length === 0) { setCalcResult('No clips found.'); setCalcMatch(false); setCalcBreakdown(null); return }

    let totalMs = 0
    const breakdown: { clipNum: number; raw: string; speed: number; actual: string }[] = []

    for (const clip of c) {
      const rawMs  = parseTimestampMs(clip.clip_duration)
      const speed  = (typeof clip.speed === 'number' && clip.speed > 0) ? clip.speed : 1.0
      const actualMs = rawMs / speed
      totalMs += actualMs
      breakdown.push({
        clipNum: clip.clip_number ?? (breakdown.length + 1),
        raw:     clip.clip_duration || '??',
        speed,
        actual:  formatTimestampMs(actualMs),
      })
    }

    const totalStr    = formatTimestampMs(totalMs)
    const voiceDuration = json?.summary?.voiceover_duration || '??'
    const voiceMs     = parseTimestampMs(voiceDuration)
    const diff        = Math.abs(totalMs - voiceMs)
    const match       = diff < 500

    setCalcMatch(match)
    setCalcBreakdown(breakdown)
    setCalcResult(
      `Clips Total (with speed): ${totalStr}\n` +
      `Voiceover Duration: ${voiceDuration}\n` +
      `Difference: ${(diff / 1000).toFixed(1)} sec\n` +
      `STATUS: ${match ? '✅ MATCH' : '❌ MISMATCH — go back to Step 6 and adjust clip lengths'}`
    )
  }, [])

  // Auto-extract JSON from raw response on mount
  useEffect(() => {
    const raw = (() => { try { return localStorage.getItem(VOICEMAP_RAW_KEY) || '' } catch { return '' } })()
    if (!raw) {
      // Check if there's already extracted JSON
      const existing = (() => { try { return localStorage.getItem(VOICEMAP_JSON_KEY) || '' } catch { return '' } })()
      if (existing) { setJsonText(existing) }
      // No raw and no existing JSON — just show empty textarea for manual paste
      return
    }

    // First try direct extraction without API call
    const direct = extractJsonFromText(raw)
    if (direct) {
      setJsonText(direct)
      try { localStorage.setItem(VOICEMAP_JSON_KEY, direct) } catch {}
      return
    }

    // Fall back to Gemini API extraction
    setIsExtracting(true)
    setExtractError('')
    const keys = loadGeminiKeys()
    const extractPrompt = `From the text below, extract only the JSON object. Return only the raw JSON, no explanation, no markdown, no code fences. If there are multiple JSON objects, return only the one that contains a 'clips' array and a 'summary' object.\n\nTEXT:\n${raw.slice(0, 8000)}`

    callGemini(extractPrompt, keys, (active) => {
      const updated = { ...keys, active }
      setGeminiKeys(updated)
      saveGeminiKeys(updated)
    }).then(response => {
      const extracted = extractJsonFromText(response) || response.trim()
      try {
        JSON.parse(extracted)
        setJsonText(extracted)
        try { localStorage.setItem(VOICEMAP_JSON_KEY, extracted) } catch {}
      } catch {
        setExtractError(`Could not parse JSON from SHIVA response. Raw extraction: ${response.slice(0, 200)}`)
      }
    }).catch(err => {
      setExtractError(err instanceof Error ? err.message : 'Extraction failed')
    }).finally(() => setIsExtracting(false))
  }, [])

  const handleCalculate = useCallback(() => {
    Sounds.buttonClick()
    if (!parsedJson) { setCalcResult('Invalid JSON — fix syntax errors first.'); setCalcMatch(false); return }
    calculateDurations(parsedJson)
  }, [parsedJson, calculateDurations])

  const handleChat = async () => {
    if (!chatInput.trim()) return
    if (!parsedJson) { setChatError('Fix the JSON before requesting changes.'); return }
    setChatError('')
    setIsChatting(true)
    try {
      const keys = loadGeminiKeys()
      const prompt = `${CHAT_SYSTEM}\n\nCurrent JSON:\n${jsonText}\n\nChange request: ${chatInput}`
      const response = await callGemini(prompt, keys, (active) => {
        const updated = { ...keys, active }
        setGeminiKeys(updated)
        saveGeminiKeys(updated)
      })
      const extracted = extractJsonFromText(response) || response.trim()
      const parsed = JSON.parse(extracted)
      const newJson = JSON.stringify(parsed, null, 2)
      setJsonText(newJson)
      try { localStorage.setItem(VOICEMAP_JSON_KEY, newJson) } catch {}
      setChatInput('')
      setCalcResult(null)
      calculateDurations(parsed)
      Sounds.save()
    } catch (err) {
      Sounds.error()
      setChatError(err instanceof Error ? err.message : 'Chat failed')
    } finally {
      setIsChatting(false)
    }
  }

  const handleJsonEdit = (val: string) => {
    setJsonText(val)
    try { localStorage.setItem(VOICEMAP_JSON_KEY, val) } catch {}
    setCalcResult(null)
  }

  const handleProceed = () => {
    if (!parsedJson) return
    try { localStorage.setItem(VOICEMAP_JSON_KEY, jsonText) } catch {}
    Sounds.navigate()
    navigate('/render')
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <ShivaHeader currentStep={7} />

      <div className="flex-1 max-w-4xl mx-auto w-full px-4 py-8 flex flex-col gap-6">

        {/* Title + Back */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-foreground">JSON Timeline Analyzer</h2>
            <p className="text-muted-foreground text-sm mt-1">Review, verify, and refine your edit plan before rendering.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => { Sounds.navigate(); navigate('/voicemap') }} className="shrink-0 flex items-center gap-2 border-border text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-4 h-4" />Back
          </Button>
        </div>

        {/* Extracting state */}
        {isExtracting && (
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
            <div>
              <p className="text-sm font-semibold text-foreground">Extracting JSON from SHIVA response...</p>
              <p className="text-xs text-muted-foreground">Using SHIVA to clean and extract the edit plan JSON</p>
            </div>
          </div>
        )}

        {/* Extract error */}
        {extractError && !isExtracting && !jsonText && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {extractError}
          </div>
        )}

        {/* Summary card */}
        {summary && (
          <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Edit Plan Summary</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div><p className="text-xs text-muted-foreground">Voiceover Duration</p><p className="text-sm font-bold font-mono">{summary.voiceover_duration || '—'}</p></div>
              <div><p className="text-xs text-muted-foreground">Clips Duration</p><p className="text-sm font-bold font-mono">{summary.total_clip_duration || '—'}</p></div>
              <div><p className="text-xs text-muted-foreground">Total Clips</p><p className="text-sm font-bold">{summary.total_clips ?? clips.length}</p></div>
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${summary.match_status === 'PERFECT' ? 'bg-green-500/15 text-green-400 border border-green-500/30' : 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30'}`}>
                  {summary.match_status === 'PERFECT' ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                  {summary.match_status || 'UNKNOWN'}
                </span>
              </div>
            </div>
            {summary.warning && <p className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">⚠️ {summary.warning}</p>}
          </div>
        )}

        {/* Duration Calculator */}
        {jsonText && (
          <div className="flex flex-col gap-2">
            <Button onClick={handleCalculate} variant="outline" className="flex items-center gap-2 border-primary/30 text-primary hover:bg-primary/10 w-fit">
              <Calculator className="w-4 h-4" />Calculate & Verify Duration
            </Button>
            {calcResult && (
              <div className="space-y-3">
                {/* Summary box */}
                <div className={`rounded-lg border px-4 py-3 text-sm font-mono whitespace-pre-line ${calcMatch ? 'border-green-500/30 bg-green-500/10 text-green-400' : 'border-red-500/30 bg-red-500/10 text-red-400'}`}>
                  {calcResult}
                </div>

                {/* Per-clip breakdown table */}
                {calcBreakdown && calcBreakdown.length > 0 && (
                  <div className="rounded-lg border border-border bg-card overflow-x-auto">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="px-3 py-2 text-left">Clip</th>
                          <th className="px-3 py-2 text-left">Raw Duration</th>
                          <th className="px-3 py-2 text-left">Speed</th>
                          <th className="px-3 py-2 text-left">Actual Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {calcBreakdown.map(row => (
                          <tr key={row.clipNum} className="border-b border-border/50 hover:bg-input/40">
                            <td className="px-3 py-1.5 text-muted-foreground">{row.clipNum}</td>
                            <td className="px-3 py-1.5">{row.raw}</td>
                            <td className={`px-3 py-1.5 ${row.speed !== 1.0 ? 'text-primary font-bold' : 'text-muted-foreground'}`}>{row.speed}×</td>
                            <td className="px-3 py-1.5 text-foreground">{row.actual}</td>
                          </tr>
                        ))}
                        {/* Total row */}
                        <tr className="border-t border-border bg-input/40">
                          <td colSpan={3} className="px-3 py-2 text-muted-foreground font-semibold">Total</td>
                          <td className="px-3 py-2 text-foreground font-bold">
                            {formatTimestampMs(calcBreakdown.reduce((sum, r) => {
                              const rawMs = parseTimestampMs(r.raw)
                              return sum + rawMs / r.speed
                            }, 0))}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* JSON display / edit — always visible so user can paste JSON directly */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-foreground">Full JSON Edit Plan</p>
              {clips.length > 0 && <span className="text-xs text-muted-foreground bg-input px-2 py-0.5 rounded-full">{clips.length} clips</span>}
            </div>
            <div className="flex items-center gap-2">
              {/* Hidden file input — all formats allowed */}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileUpload}
              />
              {/* Upload button */}
              <Button
                variant="outline"
                size="sm"
                disabled={isExtractingFile}
                onClick={() => { setUploadError(''); fileInputRef.current?.click() }}
                className="flex items-center gap-1.5 border-primary/40 text-primary hover:bg-primary/10 text-xs h-8 disabled:opacity-60"
              >
                {isExtractingFile
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Upload className="w-3.5 h-3.5" />}
                {isExtractingFile ? 'Extracting…' : 'Upload File'}
              </Button>
              {/* Clear button — only when there's content */}
              {jsonText && !isExtractingFile && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearJson}
                  className="flex items-center gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 text-xs h-8"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear
                </Button>
              )}
            </div>
          </div>

          {/* Extracting state */}
          {isExtractingFile && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3">
              <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
              <div>
                <p className="text-xs font-semibold text-foreground">Extracting JSON from "{uploadFileName}"…</p>
                <p className="text-xs text-muted-foreground">Trying direct parse → regex → Gemini AI</p>
              </div>
            </div>
          )}

          {/* Upload error */}
          {uploadError && !isExtractingFile && (
            <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              ⚠️ {uploadError}
            </p>
          )}

          <Textarea
            value={jsonText}
            onChange={e => handleJsonEdit(e.target.value)}
            className="bg-input border-border text-xs font-mono h-72 resize-none"
            spellCheck={false}
            placeholder={'Paste your JSON edit plan here, or upload any file (txt, md, json, csv…) — AI will extract the JSON automatically.'}
          />
          {jsonText && !parsedJson && <p className="text-xs text-destructive">⚠️ Invalid JSON — fix syntax errors before proceeding.</p>}
        </div>

        {/* Chat section */}
        {jsonText && (
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Request Changes via AI</p>
              <p className="text-xs text-muted-foreground mt-0.5">Describe what to change — SHIVA will update the JSON.</p>
            </div>
            <div className="flex gap-2">
              <Input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChat() }}}
                placeholder="e.g. Make clip 3 shorter, swap clips 5 and 6, reduce audio boost at 00.45.30"
                className="bg-input border-border text-sm flex-1"
                disabled={isChatting}
              />
              <Button onClick={handleChat} disabled={isChatting || !chatInput.trim()} className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0">
                {isChatting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>
            {isChatting && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <RefreshCw className="w-3 h-3 animate-spin" />Applying changes...
              </p>
            )}
            {chatError && <p className="text-xs text-destructive">{chatError}</p>}
          </div>
        )}

        {/* Proceed */}
        <Button
          onClick={handleProceed}
          disabled={!parsedJson}
          className="w-full h-12 text-base font-bold bg-green-600 text-white hover:bg-green-500 shadow-lg shadow-green-900/30 flex items-center justify-center gap-2 disabled:opacity-50"
        >
          Proceed to Final Render
          <ArrowRight className="w-5 h-5" />
        </Button>
      </div>
    </div>
  )
}
