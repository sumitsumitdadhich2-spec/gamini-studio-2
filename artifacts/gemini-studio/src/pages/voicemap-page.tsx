import { useState, useRef, useEffect, useCallback } from 'react'
import { useLocation } from 'wouter'
import {
  Send, Loader2, X, FileVideo, MessageSquare, AlertCircle, Copy, CheckCheck,
  Sparkles, History, Trash2, Clock, Paperclip, ArrowLeft, ArrowRight,
  Pencil, Check, ChevronDown, ChevronUp,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ShivaHeader } from '@/components/shiva-header'
import { Sounds } from '@/lib/sounds'

const LAST_PROJECT_KEY = 'shiva-last-project-id'
const VOICEMAP_RAW_KEY = 'shiva-voicemap-raw'
const HISTORY_KEY = 'shiva-voicemap-history'
const MAX_HISTORY = 30
const CHUNK_SIZE = 5 * 1024 * 1024

const VOICEMAP_PROMPT_LONG = `You are a professional video editor AI. You have been given:
1. A REFERENCE VIDEO (the edited sample clip I uploaded in Step 1)
2. A VOICEOVER AUDIO FILE (the voice I generated — attach it now)
3. THE FULL MOVIE FILE (uploaded in this project)

Your job is to analyze everything and return a precise JSON edit plan.

MAIN OBJECTIVE:
Match movie scenes to the voiceover. Every word spoken must have a corresponding movie clip playing. The voiceover is the master timeline — never cut more or less than the voiceover duration.

RULES YOU MUST FOLLOW:

RULE 1 — TIMING FORMAT:
Use this exact format for all timestamps: MS.SS.MM
Where MS = minutes, SS = seconds, MM = milliseconds (2 digits)
Example: 01.23.45 means 1 minute, 23 seconds, 450 milliseconds

RULE 2 — NO JUMP CUTS:
Never map a scene change at the exact end of a voiceover breath or sentence.
If a natural cut point is at 00.45.90, place the cut at 00.45.70 instead.
Always cut 0.2 seconds BEFORE the natural end point to avoid jarring transitions.

RULE 3 — VOICEOVER IS MASTER:
Total duration of all clips combined must equal voiceover duration exactly.
Do not add extra clips. Do not leave gaps.

RULE 4 — BREATH MAPPING:
Detect every pause and breath in the voiceover.
Use those pause moments as preferred cut points for scene changes.
Never cut mid-word or mid-sentence.

RULE 5 — SCENE SELECTION:
Use the reference video (Step 1 upload) as visual style guide.
Find matching or similar scenes from the full movie.
Prioritize emotionally matching scenes — sad voiceover = emotional scene, action voiceover = intense scene.

RULE 6 — MOVIE AUDIO CONTROL:
Default: Movie original audio = 0% (fully muted)
At engaging sound effect moments only: Raise movie audio to 20–40% briefly.
Voiceover audio always stays at 100%.
Return exact timestamps where movie audio should rise and fall.

OUTPUT FORMAT — Return only this JSON, nothing else:

{
  "summary": {
    "voiceover_duration": "MS.SS.MM",
    "total_clip_duration": "MS.SS.MM",
    "total_clips": 0,
    "match_status": "PERFECT / MISMATCH",
    "warning": "any notes here or null"
  },
  "clips": [
    {
      "clip_number": 1,
      "movie_start": "MS.SS.MM",
      "movie_end": "MS.SS.MM",
      "clip_duration": "MS.SS.MM",
      "voiceover_start": "MS.SS.MM",
      "voiceover_end": "MS.SS.MM",
      "scene_description": "brief description of what is happening in this scene",
      "why_selected": "why this scene matches the voiceover at this moment",
      "movie_audio": {
        "level_percent": 0,
        "reason": "muted or sound effect name"
      }
    }
  ],
  "audio_boosts": [
    {
      "boost_number": 1,
      "start": "MS.SS.MM",
      "end": "MS.SS.MM",
      "level_percent": 30,
      "sound_description": "what sound effect is being boosted and why it adds engagement"
    }
  ]
}`

const VOICEMAP_PROMPT_SHORT = `You are a professional video editor AI. You have been given:
1. A REFERENCE VIDEO (the edited sample clip I uploaded in Step 1)
2. A VOICEOVER AUDIO FILE (the voice I generated)
3. THE FULL MOVIE FILE (uploaded now)

Your job is to analyze everything and return a precise JSON edit plan.

---

MAIN OBJECTIVE:
Match movie scenes to the voiceover. Every word spoken must have a corresponding movie clip playing. The voiceover is the master timeline — never cut more or less than the voiceover duration.

---

RULES YOU MUST FOLLOW:

RULE 1 — TIMING FORMAT:
Use this exact format for all timestamps: MS.SS.MM
Where MS = minutes, SS = seconds, MM = milliseconds (2 digits)
Example: 01.23.45 means 1 minute, 23 seconds, 450 milliseconds

RULE 1B — STRICT CLIP LENGTH:
Every single clip must be minimum 0.5 seconds and maximum 3 seconds long.
No clip shorter than 0.5 seconds. No clip longer than 3 seconds.
If a scene needs more time, split it into multiple clips from nearby moments.
If a scene is too short, extend end time slightly within the same scene.

RULE 2 — NO JUMP CUTS:
Never map a scene change at the exact end of a voiceover breath or sentence.
If a natural cut point is at 00.45.90, place the cut at 00.45.70 instead.
Always cut 0.2 seconds BEFORE the natural end point to avoid jarring transitions.

RULE 3 — VOICEOVER IS MASTER:
Total duration of all clips combined must equal voiceover duration exactly.
Do not add extra clips. Do not leave gaps.

RULE 4 — BREATH MAPPING:
Detect every pause and breath in the voiceover.
Use those pause moments as preferred cut points for scene changes.
Never cut mid-word or mid-sentence.

RULE 5 — SCENE SELECTION:
Use the reference video (Step 1 upload) as visual style guide.
Find matching or similar scenes from the full movie.
Prioritize emotionally matching scenes — sad voiceover = emotional scene, action voiceover = intense scene.

RULE 6 — MOVIE AUDIO CONTROL:
Default: Movie original audio = 0% (fully muted)
At engaging sound effect moments only: Raise movie audio to 20–40% briefly.
Voiceover audio always stays at 100%.
Return exact timestamps where movie audio should rise and fall.

---

OUTPUT FORMAT — Return only this JSON, nothing else:

{
  "summary": {
    "voiceover_duration": "MS.SS.MM",
    "total_clip_duration": "MS.SS.MM",
    "total_clips": 0,
    "match_status": "PERFECT / MISMATCH",
    "warning": "any notes here or null"
  },
  "clips": [
    {
      "clip_number": 1,
      "movie_start": "MS.SS.MM",
      "movie_end": "MS.SS.MM",
      "clip_duration": "MS.SS.MM",
      "voiceover_start": "MS.SS.MM",
      "voiceover_end": "MS.SS.MM",
      "scene_description": "brief description of what is happening in this scene",
      "why_selected": "why this scene matches the voiceover at this moment",
      "speed": 1.0,
      "movie_audio": {
        "level_percent": 0,
        "reason": "muted or sound effect name"
      }
    }
  ],
  "audio_boosts": [
    {
      "boost_number": 1,
      "start": "MS.SS.MM",
      "end": "MS.SS.MM",
      "level_percent": 30,
      "sound_description": "what sound effect is being boosted and why it adds engagement"
    }
  ]
}

SPEED FIELD GUIDE — use these exact values only:
0.5 = slow motion (half speed)
0.75 = slightly slow
1.0 = normal speed (default)
1.5 = slightly fast
2.0 = fast motion (double speed)`

interface Message {
  role: 'user' | 'assistant' | 'error'
  content: string
  attachments?: { type: 'video' | 'audio'; label: string }[]
}
interface HistoryItem {
  id: string; title: string; projectId: string; messages: Message[]; timestamp: number
}

function loadHistory(): HistoryItem[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}
function saveHistory(items: HistoryItem[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)))
}
function pushHistoryItem(item: HistoryItem) {
  const existing = loadHistory().filter(h => h.id !== item.id)
  saveHistory([item, ...existing])
}
function timeAgo(ts: number): string {
  const d = Date.now() - ts, m = Math.floor(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}
function parseErr(raw: string): string {
  try { const o = JSON.parse(raw); return o.error || o.message || raw } catch { return raw }
}
function formatElapsed(s: number) {
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}:${(s % 60).toString().padStart(2, '0')}` : `0:${(s % 60).toString().padStart(2, '0')}`
}

const VOICE_SESSION_KEY = 'shiva-voice-audio-dataurl'
const SILENCE_LOCAL_KEY = 'shiva-silence-audio-dataurl'
const AUTO_VOICE_FILENAME = 'shiva-processed-voice.mp3'

function loadBestVoiceDataUrl(): string | null {
  try {
    const silenced = localStorage.getItem(SILENCE_LOCAL_KEY)
    if (silenced) return silenced
    return sessionStorage.getItem(VOICE_SESSION_KEY)
  } catch { return null }
}

function dataUrlToFile(dataUrl: string, filename: string): File {
  const [header, base64] = dataUrl.split(',')
  const mime = header.match(/:(.*?);/)?.[1] || 'audio/mpeg'
  const bytes = atob(base64)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new File([new Blob([arr], { type: mime })], filename, { type: mime })
}

async function uploadChunked(file: File, projectId: string) {
  const uploadId = `${projectId}-${Date.now()}`
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  let filePath = ''
  for (let i = 0; i < totalChunks; i++) {
    const chunk = file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size))
    const fd = new FormData()
    fd.append('action', 'upload-chunk')
    fd.append('uploadId', uploadId)
    fd.append('chunkIndex', String(i))
    fd.append('totalChunks', String(totalChunks))
    fd.append('originalName', file.name)
    fd.append('chunk', chunk)
    const res = await fetch('/api/voicemap', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`Chunk upload failed`)
    const data = await res.json()
    if (data.filePath) filePath = data.filePath
  }
  return filePath
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        Sounds.copy()
        try { await navigator.clipboard.writeText(text) } catch {
          const el = document.createElement('textarea'); el.value = text
          document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el)
        }
        setCopied(true); setTimeout(() => setCopied(false), 2500)
      }}
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md transition-all ${
        copied ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-primary/15 text-primary border border-primary/25 hover:bg-primary/25'
      }`}
    >
      {copied ? <><CheckCheck className="w-3 h-3" />Copied!</> : <><Copy className="w-3 h-3" />Copy</>}
    </button>
  )
}

// ── FormattedResponse: renders markdown text + fenced code blocks ──────────
function FormattedResponse({ content }: { content: string }) {
  type Segment = { type: 'text'; lines: string[] } | { type: 'code'; lang: string; code: string }
  const segments: Segment[] = []
  const rawLines = content.split('\n')
  let i = 0
  while (i < rawLines.length) {
    const fenceMatch = rawLines[i].match(/^```(\w*)$/)
    if (fenceMatch) {
      const lang = fenceMatch[1] || ''
      const codeLines: string[] = []
      i++
      while (i < rawLines.length && !rawLines[i].match(/^```\s*$/)) {
        codeLines.push(rawLines[i])
        i++
      }
      i++ // skip closing ```
      segments.push({ type: 'code', lang, code: codeLines.join('\n') })
    } else {
      const textLines: string[] = []
      while (i < rawLines.length && !rawLines[i].match(/^```/)) {
        textLines.push(rawLines[i])
        i++
      }
      if (textLines.length > 0) segments.push({ type: 'text', lines: textLines })
    }
  }

  function renderInline(text: string): React.ReactNode {
    return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
      if (part.startsWith('`') && part.endsWith('`')) return <code key={i} className="bg-black/30 rounded px-1 py-0.5 text-xs font-mono">{part.slice(1, -1)}</code>
      return part
    })
  }

  function renderTextLines(lines: string[]) {
    return lines.map((line, idx) => {
      if (line.startsWith('# ')) return <h1 key={idx} className="text-base font-bold mt-3 mb-1">{renderInline(line.slice(2))}</h1>
      if (line.startsWith('## ')) return <h2 key={idx} className="text-sm font-semibold mt-3 mb-1">{renderInline(line.slice(3))}</h2>
      if (/^[-*] /.test(line)) return <li key={idx} className="ml-4 list-disc text-sm leading-relaxed">{renderInline(line.slice(2))}</li>
      if (/^\d+\. /.test(line)) return <li key={idx} className="ml-4 list-decimal text-sm leading-relaxed">{renderInline(line.replace(/^\d+\. /, ''))}</li>
      if (/^---+$/.test(line.trim())) return <hr key={idx} className="border-border my-2" />
      if (line.trim() === '') return <div key={idx} className="h-2" />
      return <p key={idx} className="text-sm leading-relaxed">{renderInline(line)}</p>
    })
  }

  return (
    <div className="space-y-1.5">
      {segments.map((seg, si) => {
        if (seg.type === 'code') {
          return (
            <div key={si} className="rounded-lg overflow-hidden border border-border/60">
              {seg.lang && (
                <div className="bg-black/40 px-3 py-1 text-[10px] font-mono text-muted-foreground border-b border-border/40">
                  {seg.lang}
                </div>
              )}
              <pre className="bg-black/30 p-3 overflow-x-auto text-xs font-mono whitespace-pre text-foreground/90 max-h-96 overflow-y-auto">
                {seg.code}
              </pre>
            </div>
          )
        }
        return <div key={si} className="space-y-0.5">{renderTextLines(seg.lines)}</div>
      })}
    </div>
  )
}

export default function VoicemapPage() {
  const [, navigate] = useLocation()
  const [projectId, setProjectId] = useState(() => {
    try { return localStorage.getItem(LAST_PROJECT_KEY) || 'default-project' } catch { return 'default-project' }
  })
  const [messages, setMessages] = useState<Message[]>([])
  const [chatInput, setChatInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [generationPhase, setGenerationPhase] = useState<'file-loading' | 'uploading' | 'sending' | 'generating'>('generating')
  const [justCompleted, setJustCompleted] = useState(false)
  const [promptOpen, setPromptOpen] = useState(true)
  const [promptTab,  setPromptTab]  = useState<'long' | 'short'>('long')

  // ── Model selector — default: gemini-2.5-flash ────────────────────────────
  const [selectedModel, setSelectedModel] = useState('gemini-3.5-flash')

  // Attach panel — prefer silence-reduced voice over ElevenLabs original
  const [attachOpen, setAttachOpen] = useState(() => !!loadBestVoiceDataUrl())
  const [chatFile, setChatFile] = useState<File | null>(() => {
    try {
      const dataUrl = loadBestVoiceDataUrl()
      if (!dataUrl) return null
      const isSilenced = !!localStorage.getItem(SILENCE_LOCAL_KEY)
      const filename = isSilenced ? 'shiva-silence-voice.mp3' : AUTO_VOICE_FILENAME
      return dataUrlToFile(dataUrl, filename)
    } catch { return null }
  })

  // History
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory)
  const [sessionId] = useState(() => crypto.randomUUID())
  const [editingHistoryId, setEditingHistoryId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, isLoading])

  useEffect(() => {
    if (isLoading) {
      setElapsedSeconds(0)
      timerRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000)
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isLoading])

  useEffect(() => {
    if (messages.length >= 2) {
      const title = messages.find(m => m.role === 'user')?.content?.slice(0, 60) || 'VoiceMap session'
      pushHistoryItem({ id: sessionId, title, projectId, messages, timestamp: Date.now() })
      setHistory(loadHistory())
    }
  }, [messages, projectId, sessionId])

  const phaseLabel =
    generationPhase === 'file-loading' ? 'SHIVA is loading your voice file... please wait'
    : generationPhase === 'uploading' ? 'Uploading file...'
    : generationPhase === 'sending' ? 'Sending to SHIVA...'
    : 'Generating response...'

  // ALL messages use continue-chat so the existing Step 1 session is reused.
  // When a file is attached, we first call attach-file (waits for Playwright
  // confirmation that the file loaded) then call continue-chat with no file.
  const handleSend = async () => {
    if (!chatInput.trim() || isLoading) return
    Sounds.generationStart()

    const userMsg = chatInput
    const attachments: Message['attachments'] = []
    if (chatFile) attachments.push({ type: 'video', label: chatFile.name })

    setChatInput('')
    setJustCompleted(false)
    setMessages(prev => [...prev, { role: 'user', content: userMsg, attachments: attachments.length ? attachments : undefined }])
    setIsLoading(true)

    try {
      // ── Step 1: if a file is attached, upload it to the server then attach
      //    it to the Playwright session and wait for AI Studio to confirm load.
      if (chatFile) {
        setGenerationPhase('uploading')

        let filePath = ''
        if (chatFile.size > CHUNK_SIZE) {
          filePath = await uploadChunked(chatFile, projectId)
        }

        setGenerationPhase('file-loading')

        const attachFd = new FormData()
        attachFd.append('action', 'attach-file')
        attachFd.append('projectId', projectId)
        if (filePath) {
          attachFd.append('filePath', filePath)
        } else {
          attachFd.append('video', chatFile)
        }

        const attachRes = await fetch('/api/voicemap', { method: 'POST', body: attachFd })
        if (!attachRes.ok) {
          Sounds.error()
          const attachText = await attachRes.text()
          setMessages(prev => [...prev, { role: 'error', content: parseErr(attachText) }])
          return
        }
        const attachData = await attachRes.json()
        if (!attachData.success) {
          Sounds.error()
          setMessages(prev => [...prev, { role: 'error', content: attachData.error || 'Failed to load file in SHIVA' }])
          return
        }
      }

      // ── Step 2: send the prompt (file already attached in browser if applicable)
      setGenerationPhase('sending')

      const fd = new FormData()
      fd.append('action', 'continue-chat')
      fd.append('projectId', projectId)
      fd.append('message', userMsg)
      fd.append('model', selectedModel)
      // No file here — if there was one it was already attached via attach-file above

      const response = await fetch('/api/voicemap', { method: 'POST', body: fd })
      setGenerationPhase('generating')
      const text = await response.text()

      if (!response.ok) {
        Sounds.error()
        setMessages(prev => [...prev, { role: 'error', content: parseErr(text) }])
        return
      }
      if (!text) {
        Sounds.error()
        setMessages(prev => [...prev, { role: 'error', content: 'Empty response from server' }])
        return
      }

      const data = JSON.parse(text)
      if (data.success && data.response?.text?.length > 0) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.response.text }])
        Sounds.generationComplete()
        setJustCompleted(true)
        setTimeout(() => setJustCompleted(false), 8000)
      } else {
        Sounds.error()
        const msg = data.response?.debug
          ? `[DEBUG — page content seen by browser]\n\n${data.response.debug}`
          : '[No response text extracted. Check API logs.]'
        setMessages(prev => [...prev, { role: 'error', content: data.error || msg }])
      }
    } catch (e) {
      Sounds.error()
      setMessages(prev => [...prev, { role: 'error', content: e instanceof Error ? e.message : 'Unknown error' }])
    } finally {
      setIsLoading(false)
      setChatFile(null)
      setAttachOpen(false)
    }
  }

  const extractJson = useCallback((content: string) => {
    Sounds.approve?.() 
    Sounds.copy()
    try { localStorage.setItem(VOICEMAP_RAW_KEY, content) } catch {}
    navigate('/jsonmap')
  }, [navigate])

  const loadFromHistory = (item: HistoryItem) => {
    setMessages(item.messages)
    setHistoryOpen(false)
  }

  return (
    <div className="min-h-screen flex flex-col">
      <ShivaHeader currentStep={6} />

      {/* History Drawer */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setHistoryOpen(false)} />
          <div className="relative z-10 w-full max-w-sm bg-card border-r border-border flex flex-col h-full shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2"><History className="w-4 h-4 text-primary" /><h2 className="font-semibold text-sm">VoiceMap History</h2></div>
              <Button variant="ghost" size="icon" onClick={() => setHistoryOpen(false)}><X className="w-4 h-4" /></Button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {history.length === 0 ? (
                <div className="text-center text-muted-foreground py-12"><Clock className="w-10 h-10 mx-auto mb-3 opacity-30" /><p className="text-sm font-medium">No history yet</p></div>
              ) : history.map(item => (
                <div key={item.id} onClick={() => editingHistoryId !== item.id && loadFromHistory(item)} className="group flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/5 cursor-pointer transition-all">
                  <MessageSquare className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    {editingHistoryId === item.id ? (
                      <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                        <Input value={editingTitle} onChange={e => setEditingTitle(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { const u = loadHistory().map(h => h.id === item.id ? { ...h, title: editingTitle } : h); saveHistory(u); setHistory(u); setEditingHistoryId(null) }
                            if (e.key === 'Escape') setEditingHistoryId(null)
                          }} autoFocus className="h-6 text-xs bg-input border-primary/50 px-2 py-0" />
                        <button onClick={() => { const u = loadHistory().map(h => h.id === item.id ? { ...h, title: editingTitle } : h); saveHistory(u); setHistory(u); setEditingHistoryId(null) }} className="text-green-400"><Check className="w-3.5 h-3.5" /></button>
                      </div>
                    ) : <p className="text-sm font-medium text-foreground truncate">{item.title}</p>}
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">{timeAgo(item.timestamp)}</span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="text-xs text-muted-foreground">{item.messages.filter(m => m.role === 'assistant').length} responses</span>
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={e => { e.stopPropagation(); setEditingHistoryId(item.id); setEditingTitle(item.title) }} className="text-muted-foreground hover:text-primary"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={e => { e.stopPropagation(); const u = loadHistory().filter(h => h.id !== item.id); saveHistory(u); setHistory(u) }} className="text-muted-foreground hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="max-w-[1400px] mx-auto p-4 md:p-8 w-full">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => { Sounds.navigate(); navigate('/movie') }} className="flex items-center gap-2 border-border text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" />Back
            </Button>
            <p className="text-sm text-muted-foreground">Step 6 — Continue the SHIVA session from Step 1 and request the JSON edit plan</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => { Sounds.historyOpen(); setHistoryOpen(true) }} className="flex items-center gap-2 border-border">
            <History className="w-4 h-4" />History
            {history.length > 0 && <Badge variant="secondary" className="ml-1 text-xs px-1.5 py-0">{history.length}</Badge>}
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Column */}
          <div className="space-y-4">

            {/* Model Selector */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-medium text-muted-foreground">Gemini Model</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'gemini-3.5-flash', label: '3.5 Flash', desc: 'Latest & smartest ✨' },
                    { id: 'gemini-2.5-flash', label: '2.5 Flash', desc: 'Fast & smart' },
                    { id: 'gemini-2.5-pro',   label: '2.5 Pro',   desc: 'Most capable' },
                    { id: 'gemini-2.0-flash', label: '2.0 Flash', desc: 'Lightweight & quick' },
                    { id: 'gemini-1.5-pro',   label: '1.5 Pro',   desc: 'Stable & reliable' },
                    { id: 'gemini-1.5-flash', label: '1.5 Flash', desc: 'Budget & fast' },
                  ].map(m => (
                    <button
                      key={m.id}
                      onClick={() => setSelectedModel(m.id)}
                      className={`rounded-lg border px-3 py-2.5 text-left transition-all ${
                        selectedModel === m.id
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-input text-muted-foreground hover:border-primary/40 hover:text-foreground'
                      }`}
                    >
                      <p className={`text-xs font-semibold ${selectedModel === m.id ? 'text-primary' : ''}`}>{m.label}</p>
                      <p className="text-[10px] mt-0.5 opacity-70">{m.desc}</p>
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground pt-1">
                  Selected: <span className="text-primary font-mono">{selectedModel}</span>
                  {' '}— make sure AI Studio is also set to this model before sending.
                </p>
              </CardContent>
            </Card>

            {/* Project ID */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-medium text-muted-foreground">Project ID (from Step 1)</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-1">
                <Input value={projectId} onChange={e => setProjectId(e.target.value)} placeholder="default-project" className="bg-input border-border" />
                <p className="text-xs text-muted-foreground">This continues the SAME session opened in Step 1. No new chat will be created.</p>
              </CardContent>
            </Card>

            {/* Prompt Panel */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Step 6 Prompt — Copy &amp; Send</CardTitle>
                  <button onClick={() => setPromptOpen(o => !o)} className="text-muted-foreground hover:text-foreground">
                    {promptOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>
              </CardHeader>
              {promptOpen && (
                <CardContent className="px-4 pb-4 space-y-3">
                  {/* Tabs */}
                  <div className="grid grid-cols-2 gap-1 bg-input rounded-lg p-1">
                    <button
                      onClick={() => setPromptTab('long')}
                      className={`rounded-md px-2 py-1.5 text-xs font-medium transition-all text-center ${
                        promptTab === 'long'
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      Long Video
                    </button>
                    <button
                      onClick={() => setPromptTab('short')}
                      className={`rounded-md px-2 py-1.5 text-xs font-medium transition-all text-center ${
                        promptTab === 'short'
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      Short Video
                    </button>
                  </div>
                  {/* Tab label */}
                  <p className="text-[10px] text-muted-foreground">
                    {promptTab === 'long'
                      ? 'Long Video — No clip length restrictions'
                      : 'Short Video — Clips between 0.5s and 3s'}
                  </p>
                  <Textarea
                    value={promptTab === 'long' ? VOICEMAP_PROMPT_LONG : VOICEMAP_PROMPT_SHORT}
                    readOnly
                    className="bg-input border-border text-xs font-mono h-48 resize-none"
                  />
                  <div className="flex items-center gap-2">
                    <CopyButton text={promptTab === 'long' ? VOICEMAP_PROMPT_LONG : VOICEMAP_PROMPT_SHORT} />
                    <span className="text-xs text-muted-foreground">Paste this into the chat box below and attach your voiceover audio</span>
                  </div>
                </CardContent>
              )}
            </Card>

            {/* Instructions */}
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-2">
              <p className="text-xs font-semibold text-primary">How to use Step 6:</p>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal ml-4">
                <li>Copy the prompt above</li>
                <li>Click the paperclip to attach your voiceover audio file</li>
                <li>Paste the prompt in the chat box and click Send</li>
                <li>When SHIVA replies with the JSON, click <strong className="text-green-400">Extract JSON</strong></li>
              </ol>
            </div>
          </div>

          {/* Right Column — Chat */}
          <div className="lg:sticky lg:top-8 lg:h-fit">
            <Card className="bg-card border-border h-[calc(100vh-8rem)] flex flex-col">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isLoading ? 'bg-yellow-400 animate-pulse' : justCompleted ? 'bg-green-400' : 'bg-primary animate-pulse'}`} />
                  SHIVA — Continuing Step 1 Session
                  {isLoading && (
                    <span className="ml-auto text-xs font-normal text-yellow-400 flex items-center gap-1.5 tabular-nums">
                      <Loader2 className="w-3 h-3 animate-spin" />{phaseLabel} — {formatElapsed(elapsedSeconds)}
                    </span>
                  )}
                  {justCompleted && !isLoading && (
                    <span className="ml-auto text-xs font-normal text-green-400 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3" />Done!
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 overflow-hidden p-0 flex flex-col relative">
                {/* File-loading full overlay */}
                {isLoading && generationPhase === 'file-loading' && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-card/97 backdrop-blur-sm rounded-b-lg">
                    <div className="flex flex-col items-center gap-6 px-8 text-center">
                      <div className="flex items-end gap-1.5">
                        {[0, 80, 160, 240, 320].map((delay, i) => (
                          <span
                            key={i}
                            className="w-2.5 rounded-full bg-primary"
                            style={{
                              height: '3rem',
                              animation: `bounce 0.9s ease-in-out ${delay}ms infinite`,
                              opacity: 0.7 + i * 0.06,
                            }}
                          />
                        ))}
                      </div>
                      <div className="space-y-2">
                        <p className="text-base font-semibold text-foreground leading-snug">
                          SHIVA is loading your voice file<br />into the session... please wait
                        </p>
                        <p className="text-xs text-muted-foreground">Do not close this tab — file must fully load before prompt is sent</p>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                        <span className="tabular-nums">Elapsed: {formatElapsed(elapsedSeconds)}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {messages.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-center text-muted-foreground">
                      <div>
                        <div className="w-16 h-16 rounded-full bg-secondary mx-auto mb-4 flex items-center justify-center">
                          <MessageSquare className="w-8 h-8" />
                        </div>
                        <p className="font-medium">Ready to continue Step 1 session</p>
                        <p className="text-sm mt-1 max-w-xs">Copy the prompt on the left, attach your voiceover audio, and send</p>
                      </div>
                    </div>
                  ) : messages.map((msg, idx) => {
                    if (msg.role === 'error') return (
                      <div key={idx} className="flex items-start gap-2 text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3">
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                      </div>
                    )
                    if (msg.role === 'user') return (
                      <div key={idx} className="flex justify-end">
                        <div className="max-w-[90%] rounded-lg px-4 py-3 bg-primary text-primary-foreground">
                          {msg.attachments?.map((a, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-xs bg-white/20 rounded px-2 py-0.5 mb-2 mr-1">
                              <FileVideo className="w-3 h-3" /><span className="max-w-[120px] truncate">{a.label}</span>
                            </span>
                          ))}
                          <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                        </div>
                      </div>
                    )
                    // Assistant — every bubble has Extract JSON button
                    return (
                      <div key={idx} className="flex justify-start">
                        <div className="max-w-[95%] rounded-lg px-4 py-3 bg-secondary text-secondary-foreground">
                          <FormattedResponse content={msg.content} />
                          <div className="mt-3 pt-2 border-t border-border/50 flex items-center gap-2 flex-wrap">
                            <CopyButton text={msg.content} />
                            {justCompleted && idx === messages.length - 1 && (
                              <span className="text-xs text-green-400 flex items-center gap-1">
                                <Sparkles className="w-3 h-3" />Generation complete
                              </span>
                            )}
                            <button
                              onClick={() => extractJson(msg.content)}
                              className="ml-auto inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-500 transition-all shadow-sm"
                            >
                              Extract JSON
                              <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {isLoading && generationPhase !== 'file-loading' && (
                    <div className="flex justify-start">
                      <div className="bg-secondary rounded-lg px-4 py-3 min-w-[160px]">
                        <div className="flex items-center gap-2 mb-1">
                          <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />
                          <span className="text-sm text-yellow-400 font-medium">{phaseLabel}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                          <div className="flex gap-0.5">
                            <span className="w-1.5 h-4 bg-primary/40 rounded-sm animate-[bounce_1s_ease-in-out_0s_infinite]" />
                            <span className="w-1.5 h-4 bg-primary/40 rounded-sm animate-[bounce_1s_ease-in-out_0.15s_infinite]" />
                            <span className="w-1.5 h-4 bg-primary/40 rounded-sm animate-[bounce_1s_ease-in-out_0.3s_infinite]" />
                          </div>
                          <span>Elapsed: {formatElapsed(elapsedSeconds)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Chat Input — always visible */}
                <div className="border-t border-border">
                  {attachOpen && (
                    <div className="p-3 border-b border-border bg-secondary/30">
                      <p className="text-xs text-muted-foreground mb-1.5 font-medium">Attach voiceover audio or any file</p>
                      {chatFile ? (
                        <div className="flex flex-col gap-1.5">
                          {chatFile.name === AUTO_VOICE_FILENAME && (
                            <span className="text-[10px] font-semibold text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5 w-fit">
                              ✓ Auto-loaded from Step 4
                            </span>
                          )}
                          <div className="flex items-center gap-2 bg-input rounded-lg px-3 py-2">
                            <FileVideo className="w-4 h-4 text-primary shrink-0" />
                            <span className="text-xs flex-1 truncate">{chatFile.name}</span>
                            <span className="text-xs text-muted-foreground">{(chatFile.size / 1024 / 1024).toFixed(1)} MB</span>
                            <button onClick={() => setChatFile(null)} className="text-muted-foreground hover:text-destructive" title="Remove — you can attach a different file"><X className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="w-full text-xs border border-dashed border-border rounded-lg py-2.5 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors flex items-center justify-center gap-2"
                        >
                          <Paperclip className="w-3.5 h-3.5" />Click to attach a file
                        </button>
                      )}
                      <input ref={fileInputRef} type="file" className="hidden" accept="audio/*,video/*,.mp3,.wav,.aac,.m4a,.ogg,.flac" onChange={e => { const f = e.target.files?.[0]; if (f) setChatFile(f); e.target.value = '' }} />
                    </div>
                  )}
                  <div className="flex gap-2 p-3">
                    <button
                      onClick={() => setAttachOpen(o => !o)}
                      className={`p-2 rounded-lg border transition-colors shrink-0 ${attachOpen || chatFile ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-primary hover:border-primary/40'}`}
                      title="Attach voiceover audio"
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                    <Textarea
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }}}
                      placeholder="Paste the voicemap prompt here, or type a message…"
                      className="bg-input border-border text-sm flex-1 min-h-[40px] max-h-32 resize-none"
                      rows={2}
                      disabled={isLoading}
                    />
                    <Button onClick={handleSend} disabled={isLoading || !chatInput.trim()} size="icon" className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0 self-end">
                      {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    </Button>
                  </div>
                  {chatFile && !attachOpen && (
                    <div className="px-3 pb-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <Paperclip className="w-3 h-3 text-primary" />{chatFile.name}
                      <button onClick={() => setChatFile(null)} className="hover:text-destructive"><X className="w-3 h-3" /></button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
