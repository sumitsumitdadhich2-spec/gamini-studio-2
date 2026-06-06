import { useState, useRef, useEffect, useCallback } from 'react'
import { useLocation } from 'wouter'
import {
  ArrowLeft, Loader2, Film, Upload, Volume2, Download,
  CheckCircle, XCircle, Settings, X, AlertCircle,
  ChevronDown, ChevronUp, Clock, Trash2, History,
  Play, Scissors, Layers, Mic, RefreshCw, Eye,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShivaHeader } from '@/components/shiva-header'
import { Sounds } from '@/lib/sounds'
import { apiGet, apiPost, apiDelete, apiCall, getWebSocketURL } from '@/lib/api-client'

// ── Constants ────────────────────────────────────────────────────────────────
const VOICEMAP_JSON_KEY   = 'shiva-voicemap-json'
const AUDIO_SESSION_KEY   = 'shiva-voice-audio-dataurl'
const SILENCE_LOCAL_KEY   = 'shiva-silence-audio-dataurl'
const HISTORY_KEY         = 'shiva-render-history'
const MOVIE_PATH_KEY      = 'shiva-movie-server-path'
const MOVIE_NAME_KEY      = 'shiva-movie-file-name'

// ── Types ────────────────────────────────────────────────────────────────────
type Phase =
  | 'setup'
  | 'uploading'
  | 'extracting'
  | 'extracted'
  | 'merging'
  | 'merged'
  | 'finalizing'
  | 'done'
  | 'error'

interface ClipInfo {
  index: number
  clipNumber: number
  movieStart: string
  movieEnd: string
  duration: number
  label?: string
}

interface HistoryEntry {
  jobId:      string
  label:      string
  timestamp:  number
  clips:      number
  resolution: string
}

// ── localStorage helpers ─────────────────────────────────────────────────────
function loadJson(): string {
  try { return localStorage.getItem(VOICEMAP_JSON_KEY) || '' } catch { return '' }
}
function loadAudio(): string | null {
  try {
    return localStorage.getItem(SILENCE_LOCAL_KEY) || sessionStorage.getItem(AUDIO_SESSION_KEY)
  } catch { return null }
}
function loadAudioLabel(): string {
  try {
    if (localStorage.getItem(SILENCE_LOCAL_KEY)) return 'Silence-Reduced Voice'
    if (sessionStorage.getItem(AUDIO_SESSION_KEY)) return 'ElevenLabs Voice'
  } catch { /**/ }
  return 'Voice Audio'
}
function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}
function saveHistory(entries: HistoryEntry[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries)) } catch { /**/ }
}
function loadMoviePath(): string | null {
  try { return sessionStorage.getItem(MOVIE_PATH_KEY) } catch { return null }
}
function loadMovieName(): string {
  try { return sessionStorage.getItem(MOVIE_NAME_KEY) || '' } catch { return '' }
}
function saveMoviePath(path: string, name: string) {
  try { sessionStorage.setItem(MOVIE_PATH_KEY, path); sessionStorage.setItem(MOVIE_NAME_KEY, name) } catch { /**/ }
}
function clearMoviePath() {
  try { sessionStorage.removeItem(MOVIE_PATH_KEY); sessionStorage.removeItem(MOVIE_NAME_KEY) } catch { /**/ }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',')
  const mime = header.match(/:(.*?);/)?.[1] || 'audio/mpeg'
  const bytes = atob(base64)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

// ── Timestamp helpers ────────────────────────────────────────────────────────
function tsToSeconds(ts: string): number {
  if (!ts) return 0
  const p = ts.split('.')
  if (p.length >= 4) return parseInt(p[0])*3600 + parseInt(p[1])*60 + parseInt(p[2]) + parseInt(p[3])/100
  return parseInt(p[0]||'0')*60 + parseInt(p[1]||'0') + parseInt(p[2]||'0')/100
}
function fmtTs(ts: string): string {
  if (!ts) return '—'
  const secs = tsToSeconds(ts)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  const cs = Math.round((secs % 1) * 100)
  if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}.${cs.toString().padStart(2,'0')}`
  return `${m}:${s.toString().padStart(2,'0')}.${cs.toString().padStart(2,'0')}`
}
function fmtDur(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = (secs % 60).toFixed(1)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// ── WebSocket upload (no chunks, no proxy timeouts) ──────────────────────────
async function uploadFileViaWebSocket(
  file: File,
  onProgress: (msg: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proto    = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const uploadId = `render-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const url      = getWebSocketURL('/api/render/ws-upload')

    let ws: WebSocket
    try { ws = new WebSocket(url) } catch { reject(new Error('WebSocket not supported')); return }

    let settled = false
    const done = (ok: true, path: string) => { if (!settled) { settled = true; resolve(path) } }
    const fail = (msg: string)            => { if (!settled) { settled = true; reject(new Error(msg)) } }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'init', uploadId, name: file.name, size: file.size }))
    }

    ws.onmessage = async (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string)

      if (msg.type === 'ready') {
        const SLICE = 64 * 1024 // 64 KB per send
        let offset = 0
        onProgress(`Uploading ${file.name}…`)

        while (offset < file.size) {
          // Backpressure: wait if WebSocket send buffer is too full
          while (ws.bufferedAmount > 8 * 1024 * 1024) {
            await new Promise(r => setTimeout(r, 30))
          }
          if (ws.readyState !== WebSocket.OPEN) { fail('Connection lost during upload'); return }
          const buf = await file.slice(offset, Math.min(offset + SLICE, file.size)).arrayBuffer()
          ws.send(buf)
          offset += buf.byteLength
          const pct = Math.round(offset / file.size * 100)
          onProgress(`Uploading ${file.name}… ${pct}%`)
        }
        ws.send(JSON.stringify({ type: 'done' }))
        onProgress('Finalizing upload…')

      } else if (msg.type === 'assembled') {
        done(true, msg.filePath as string)
        ws.close()
      } else if (msg.type === 'error') {
        fail((msg.error as string) || 'Upload failed')
        ws.close()
      }
    }

    ws.onerror = () => fail('Upload connection failed — check your internet')
    ws.onclose = (e: CloseEvent) => { if (!settled) fail(e.reason || 'Connection closed unexpectedly') }
  })
}

// ── Quality options ───────────────────────────────────────────────────────────
const BASE_HEIGHTS = [
  { label: '4K',    h: 2160 },
  { label: '2K',    h: 1440 },
  { label: '1080p', h: 1080 },
  { label: '720p',  h: 720  },
  { label: '480p',  h: 480  },
  { label: '360p',  h: 360  },
  { label: '144p',  h: 144  },
]
const ASPECT_RATIOS = [
  { label: '16:9', aw: 16, ah: 9  },
  { label: '9:16', aw: 9,  ah: 16 },
  { label: '1:1',  aw: 1,  ah: 1  },
]
function computeRes(h: number, aw: number, ah: number): string {
  return `${Math.round(h * aw / ah / 2) * 2}x${h}`
}

// ── Phase badge ───────────────────────────────────────────────────────────────
function PhaseBadge({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className={`flex items-center gap-2 text-sm font-semibold ${active ? 'text-primary' : done ? 'text-green-400' : 'text-muted-foreground'}`}>
      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border
        ${active ? 'bg-primary/20 border-primary text-primary' : done ? 'bg-green-500/20 border-green-500 text-green-400' : 'border-border text-muted-foreground'}`}>
        {done ? <CheckCircle className="w-3.5 h-3.5" /> : n}
      </div>
      {label}
    </div>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-primary font-mono font-bold">{value}%</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-500"
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
export default function RenderPage() {
  const [, navigate] = useLocation()

  // ── Persistent state ────────────────────────────────────────────────────
  const [jsonText]       = useState(loadJson)
  const [autoAudioUrl]   = useState<string | null>(loadAudio)
  const [autoAudioLabel] = useState(loadAudioLabel)

  // ── Movie file ───────────────────────────────────────────────────────────
  const [movieFile,       setMovieFile]       = useState<File | null>(null)
  const [movieServerPath, setMovieServerPath] = useState<string | null>(loadMoviePath)
  const [movieFileName,   setMovieFileName]   = useState<string>(loadMovieName)
  const [movieChecked,    setMovieChecked]    = useState(false)

  // ── Audio ────────────────────────────────────────────────────────────────
  const [customAudioUrl,  setCustomAudioUrl]  = useState<string | null>(null)
  const [customAudioName, setCustomAudioName] = useState('')
  const audioUrl = customAudioUrl ?? autoAudioUrl

  // ── Phase & jobs ─────────────────────────────────────────────────────────
  const [phase,         setPhase]         = useState<Phase>('setup')
  const [uploadStatus,  setUploadStatus]  = useState('')
  const [errorMsg,      setErrorMsg]      = useState('')

  const [extractJobId,  setExtractJobId]  = useState<string | null>(null)
  const [extractProg,   setExtractProg]   = useState(0)
  const [extractCurrent,setExtractCurrent]= useState(0)
  const [extractTotal,  setExtractTotal]  = useState(0)
  const [clips,         setClips]         = useState<ClipInfo[]>([])

  const [mergeJobId,    setMergeJobId]    = useState<string | null>(null)
  const [mergeProg,     setMergeProg]     = useState(0)

  const [finalJobId,    setFinalJobId]    = useState<string | null>(null)
  const [finalProg,     setFinalProg]     = useState(0)

  // ── Export (render without voiceover) ────────────────────────────────────
  const [exportJobId,      setExportJobId]      = useState<string | null>(null)
  const [exportProg,       setExportProg]       = useState(0)
  const [exportPhase,      setExportPhase]      = useState<'idle'|'exporting'|'done'|'error'>('idle')
  const [exportError,      setExportError]      = useState('')
  const [showExportQuality,setShowExportQuality] = useState(false)
  const exportPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopExportPoll = useCallback(() => {
    if (exportPollRef.current) { clearInterval(exportPollRef.current); exportPollRef.current = null }
  }, [])

  // ── UI state ─────────────────────────────────────────────────────────────
  const [showClips,     setShowClips]     = useState(false)
  const [previewClip,   setPreviewClip]   = useState<number | null>(null)
  const [showQuality,   setShowQuality]   = useState(false)
  const [showHistory,   setShowHistory]   = useState(false)
  const [history,       setHistory]       = useState<HistoryEntry[]>(loadHistory)

  // ── Quality settings ─────────────────────────────────────────────────────
  const [baseHeight,    setBaseHeight]    = useState(1080)
  const [arIdx,         setArIdx]         = useState(0)
  const [framerate,     setFramerate]     = useState('30')
  const [bitrate,       setBitrate]       = useState('4M')
  const selAr     = ASPECT_RATIOS[arIdx]
  const resolution = computeRes(baseHeight, selAr.aw, selAr.ah)

  const fileInputRef      = useRef<HTMLInputElement>(null)
  const audioInputRef     = useRef<HTMLInputElement>(null)
  const pollRef           = useRef<ReturnType<typeof setInterval> | null>(null)
  const handleFinalizeRef = useRef<() => void>(() => {})

  const parsedJson = (() => { try { return JSON.parse(jsonText) } catch { return null } })()
  const summary    = parsedJson?.summary
  const jsonClips: any[] = parsedJson?.clips || []

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  useEffect(() => () => stopPolling(), [stopPolling])

  // ── Verify saved movie path still exists on server ───────────────────────
  useEffect(() => {
    if (!movieServerPath) { setMovieChecked(true); return }
    apiGet(`/api/render/check-file?path=${encodeURIComponent(movieServerPath)}`)
      .then(r => r.json())
      .then(d => {
        if (!d.exists) { clearMoviePath(); setMovieServerPath(null); setMovieFileName('') }
      })
      .catch(() => { clearMoviePath(); setMovieServerPath(null); setMovieFileName('') })
      .finally(() => setMovieChecked(true))
  }, [])  // eslint-disable-line

  // ── STEP 1: Upload movie + start extract ─────────────────────────────────
  const handleStartExtract = async () => {
    if (!parsedJson) return
    setPhase('uploading')
    setErrorMsg('')
    setExtractProg(0)
    setExtractCurrent(0)
    setExtractTotal(0)
    setClips([])

    try {
      let serverPath = movieServerPath

      if (!serverPath) {
        if (!movieFile) { throw new Error('Please select a movie file') }
        const path = await uploadFileViaWebSocket(movieFile, setUploadStatus)
        serverPath = path
        saveMoviePath(path, movieFile.name)
        setMovieServerPath(path)
        setMovieFileName(movieFile.name)
      }

      setUploadStatus('Starting clip extraction…')
      setPhase('extracting')

      const res  = await apiPost('/api/render/extract', { moviePath: serverPath, json: jsonText })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Extract failed')

      setExtractJobId(data.jobId)
      pollRef.current = setInterval(async () => {
        try {
          const r = await apiGet(`/api/render/extract/status/${data.jobId}`)
          const d = await r.json()
          setExtractProg(d.progress ?? 0)
          setExtractCurrent(d.currentClip ?? 0)
          setExtractTotal(d.totalClips ?? 0)
          if (d.status === 'done') {
            stopPolling()
            setClips(d.clips || [])
            setPhase('extracted')
            Sounds.generationComplete()
          } else if (d.status === 'error') {
            stopPolling()
            setErrorMsg(d.error || 'Extract failed')
            setPhase('error')
            Sounds.error()
          }
        } catch { /* keep polling */ }
      }, 2000)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start')
      setPhase('error')
      Sounds.error()
    }
  }

  // ── STEP 2: Merge clips ─────────────���─────────────────────────────────────
  const handleMerge = async () => {
    if (!extractJobId) return
    stopPolling()
    setPhase('merging')
    setMergeProg(0)
    setErrorMsg('')

    try {
      const res  = await apiPost('/api/render/merge', { extractJobId, json: jsonText })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Merge failed')

      setMergeJobId(data.jobId)
      pollRef.current = setInterval(async () => {
        try {
          const r = await apiGet(`/api/render/merge/status/${data.jobId}`)
          const d = await r.json()
          setMergeProg(d.progress ?? 0)
          if (d.status === 'done') {
            stopPolling()
            setPhase('merged')
            Sounds.generationComplete()
          } else if (d.status === 'error') {
            stopPolling()
            setErrorMsg(d.error || 'Merge failed')
            setPhase('error')
            Sounds.error()
          }
        } catch { /* keep polling */ }
      }, 2000)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Merge failed')
      setPhase('error')
      Sounds.error()
    }
  }

  // ── STEP 3: Finalize with voiceover ──────────────────────────────────────
  const handleFinalize = async () => {
    if (!mergeJobId || !audioUrl) return
    stopPolling()
    setPhase('finalizing')
    setFinalProg(0)
    setErrorMsg('')

    try {
      const voiceBlob = dataUrlToBlob(audioUrl)
      const voiceFile = new File([voiceBlob], 'voice.mp3', { type: 'audio/mpeg' })
      setUploadStatus('Uploading voice audio…')
      const voicePath = await uploadFileViaWebSocket(voiceFile, setUploadStatus)

      const fd = new FormData()
      fd.append('mergeJobId',  mergeJobId)
      fd.append('voicePath',   voicePath)
      fd.append('resolution',  resolution)
      fd.append('framerate',   framerate)
      fd.append('bitrate',     bitrate)

      const res  = await apiCall('/api/render/finalize', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Finalize failed')

      setFinalJobId(data.jobId)
      pollRef.current = setInterval(async () => {
        try {
          const r = await apiGet(`/api/render/finalize/status/${data.jobId}`)
          const d = await r.json()
          setFinalProg(d.progress ?? 0)
          if (d.status === 'done') {
            stopPolling()
            setPhase('done')
            addHistory(data.jobId)
            Sounds.generationComplete()
          } else if (d.status === 'error') {
            stopPolling()
            setErrorMsg(d.error || 'Finalize failed')
            setPhase('error')
            Sounds.error()
          }
        } catch { /* keep polling */ }
      }, 2000)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Finalize failed')
      setPhase('error')
      Sounds.error()
    }
  }

  // Keep ref current so auto-finalize useEffect always calls the latest version
  useEffect(() => { handleFinalizeRef.current = handleFinalize })

  // Auto-start finalize as soon as merge completes (no manual step, no preview)
  useEffect(() => {
    if (phase === 'merged') {
      handleFinalizeRef.current()
    }
  }, [phase])



  // ── Export: Render without voiceover ─────────────────────────────────────
  const handleExport = async () => {
    if (!mergeJobId) return
    stopExportPoll()
    setExportPhase('exporting')
    setExportProg(0)
    setExportError('')

    try {
      const res  = await apiPost('/api/render/export', { mergeJobId, resolution, framerate, bitrate })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Export failed')

      setExportJobId(data.jobId)
      exportPollRef.current = setInterval(async () => {
        try {
          const r = await apiGet(`/api/render/export/status/${data.jobId}`)
          const d = await r.json()
          setExportProg(d.progress ?? 0)
          if (d.status === 'done') {
            stopExportPoll()
            setExportPhase('done')
            Sounds.generationComplete()
          } else if (d.status === 'error') {
            stopExportPoll()
            setExportError(d.error || 'Export failed')
            setExportPhase('error')
            Sounds.error()
          }
        } catch { /* keep polling */ }
      }, 2000)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed')
      setExportPhase('error')
      Sounds.error()
    }
  }

  const addHistory = (jobId: string) => {
    const entry: HistoryEntry = {
      jobId, timestamp: Date.now(), clips: clips.length, resolution,
      label: `${clips.length} clips · ${summary?.voiceover_duration ?? '?'} · ${baseHeight}p ${selAr.label}`,
    }
    const updated = [entry, ...history].slice(0, 20)
    setHistory(updated)
    saveHistory(updated)
  }

  const deleteHistory = async (entry: HistoryEntry) => {
      await apiDelete(`/api/render/final-job/${entry.jobId}`).catch(() => {})
    const updated = history.filter(h => h.jobId !== entry.jobId)
    setHistory(updated)
    saveHistory(updated)
  }

  const handleReset = () => {
    stopPolling()
    setPhase('setup')
    setErrorMsg('')
    setExtractJobId(null)
    setMergeJobId(null)
    setFinalJobId(null)
    setExtractProg(0)
    setMergeProg(0)
    setFinalProg(0)
    setClips([])
    setPreviewClip(null)
    setUploadStatus('')
  }

  const handleClearMovie = () => {
    clearMoviePath()
    setMovieServerPath(null)
    setMovieFileName('')
    setMovieFile(null)
  }

  const handleAudioReplace = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => { setCustomAudioUrl(reader.result as string); setCustomAudioName(file.name) }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const isRunning = ['uploading', 'extracting', 'merging', 'finalizing'].includes(phase)
  const hasMovie  = !!(movieServerPath || movieFile)
  const hasJson   = !!parsedJson && jsonClips.length > 0
  const canExtract = hasMovie && hasJson && !isRunning

  // Phase progress indicators
  const ph1done = ['extracted', 'merging', 'merged', 'finalizing', 'done'].includes(phase)
  const ph2done = ['merged', 'finalizing', 'done'].includes(phase)
  const ph3done = phase === 'done'
  const ph1active = ['uploading', 'extracting'].includes(phase)
  const ph2active = ['merging'].includes(phase)
  const ph3active = ['finalizing'].includes(phase)

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <ShivaHeader currentStep={8} />

      <div className="flex-1 max-w-3xl mx-auto w-full px-4 py-8 flex flex-col gap-5">

        {/* ── Header row ──────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-foreground flex items-center gap-2">
              <Film className="w-6 h-6 text-primary" />
              Final Render
            </h2>
            <p className="text-muted-foreground text-sm mt-1">
              3-step process: Extract clips → Merge → Add voiceover
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {history.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setShowHistory(v => !v)}
                className={`flex items-center gap-1.5 border-border text-muted-foreground hover:text-foreground ${showHistory ? 'border-primary/50 text-primary' : ''}`}>
                <History className="w-3.5 h-3.5" />
                History
                <span className="ml-0.5 bg-primary/20 text-primary text-[10px] font-bold rounded-full px-1.5 py-0.5 leading-none">
                  {history.length}
                </span>
              </Button>
            )}
            <Button variant="outline" size="sm"
              onClick={() => { Sounds.navigate(); navigate('/jsonmap') }}
              disabled={isRunning}
              className="flex items-center gap-2 border-border text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" /> Back
            </Button>
          </div>
        </div>

        {/* ── Phase indicator bar ─────────────────────────────────────── */}
        <div className="rounded-xl border border-border bg-card px-5 py-3 flex items-center justify-between gap-2">
          <PhaseBadge n={1} label="Extract Clips" active={ph1active} done={ph1done} />
          <div className="flex-1 h-px bg-border mx-1" />
          <PhaseBadge n={2} label="Merge" active={ph2active} done={ph2done} />
          <div className="flex-1 h-px bg-border mx-1" />
          <PhaseBadge n={3} label="Add Voiceover" active={ph3active} done={ph3done} />
        </div>

        {/* ── History panel ───────────────────────────────────────────── */}
        {showHistory && history.length > 0 && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                <History className="w-4 h-4 text-primary" /> Render History
              </p>
              <p className="text-xs text-muted-foreground">{history.length} saved</p>
            </div>
            <div className="divide-y divide-border">
              {history.map(entry => (
                <div key={entry.jobId} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{entry.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{new Date(entry.timestamp).toLocaleString()}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <a href={`/api/render/final-download/${entry.jobId}`} download={`shiva-final-${entry.jobId}.mp4`}>
                      <Button variant="outline" size="sm"
                        className="h-7 px-2.5 text-xs border-green-500/40 text-green-400 hover:bg-green-500/10">
                        <Download className="w-3 h-3 mr-1" /> Download
                      </Button>
                    </a>
                    <Button variant="outline" size="sm" onClick={() => deleteHistory(entry)}
                      className="h-7 px-2 text-xs border-destructive/40 text-destructive hover:bg-destructive/10">
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            SETUP SECTION (always visible at top)
        ════════════════════════════════════════════════════════════════ */}

        {/* ── JSON Plan ───────────────────────────────────────────────── */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Film className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold text-foreground">JSON Edit Plan</p>
            {hasJson
              ? <span className="ml-auto text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" /> {jsonClips.length} clips loaded
                </span>
              : <span className="ml-auto text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-full px-2 py-0.5">
                  Not loaded
                </span>
            }
          </div>
          {hasJson && summary && (
            <div className="px-4 py-3 flex flex-wrap gap-4 text-sm">
              <span className="text-foreground">
                <span className="text-muted-foreground">Clips: </span>{jsonClips.length}
              </span>
              <span className="text-foreground">
                <span className="text-muted-foreground">Duration: </span>
                <span className="font-mono">{summary.voiceover_duration}</span>
              </span>
              <span className={summary.match_status === 'PERFECT' ? 'text-green-400' : 'text-yellow-400'}>
                {summary.match_status === 'PERFECT'
                  ? <><CheckCircle className="inline w-3.5 h-3.5 mr-1" />PERFECT</>
                  : <><XCircle    className="inline w-3.5 h-3.5 mr-1" />{summary.match_status}</>
                }
              </span>
            </div>
          )}
          {!hasJson && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              Go back to Step 7 (JSON Map) to generate and approve the edit plan first.
            </p>
          )}
        </div>

        {/* ── Movie File ──────────────────────────────────────────────── */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold text-foreground">Movie File</p>
            {(movieServerPath || movieFile) && (
              <span className="ml-auto text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" /> Ready
              </span>
            )}
          </div>

          {movieChecked && movieServerPath ? (
            // Already uploaded — show persisted file
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border">
              <Film className="w-5 h-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{movieFileName}</p>
                <p className="text-xs text-muted-foreground">Already uploaded to server</p>
              </div>
              <Button variant="outline" size="sm" onClick={handleClearMovie} disabled={isRunning}
                className="h-7 px-2 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 shrink-0">
                <X className="w-3 h-3 mr-1" /> Remove
              </Button>
            </div>
          ) : (
            <>
              <input ref={fileInputRef} type="file" accept="video/*" className="hidden"
                onChange={e => setMovieFile(e.target.files?.[0] || null)} />
              <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={isRunning}
                className="border-border text-muted-foreground hover:text-foreground">
                <Upload className="w-4 h-4 mr-2" />
                {movieFile ? movieFile.name : 'Choose Movie File'}
              </Button>
              {movieFile && (
                <p className="text-xs text-muted-foreground">
                  {movieFile.name} — {(movieFile.size / 1024 / 1024).toFixed(1)} MB
                  <button onClick={() => setMovieFile(null)} className="ml-2 text-destructive hover:underline">remove</button>
                </p>
              )}
            </>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════════════
            PHASE 1: EXTRACT
        ════════════════════════════════════════════════════════════════ */}

        {/* Start Extract button */}
        {(phase === 'setup' || phase === 'error') && (
          <Button
            onClick={handleStartExtract}
            disabled={!canExtract}
            className="w-full h-12 text-base font-bold gap-2 bg-primary hover:bg-primary/90"
          >
            <Scissors className="w-5 h-5" />
            Step 1: Extract Clips from Movie
          </Button>
        )}

        {/* Uploading progress */}
        {phase === 'uploading' && (
          <div className="rounded-xl border border-primary/30 bg-card p-5 space-y-3">
            <div className="flex items-center gap-2 text-primary font-semibold">
              <Loader2 className="w-4 h-4 animate-spin" />
              Uploading Movie File…
            </div>
            <p className="text-sm text-muted-foreground">{uploadStatus}</p>
          </div>
        )}

        {/* Extracting progress */}
        {phase === 'extracting' && (
          <div className="rounded-xl border border-primary/30 bg-card p-5 space-y-4">
            <div className="flex items-center gap-2 text-primary font-semibold">
              <Loader2 className="w-4 h-4 animate-spin" />
              Extracting Clips…
            </div>
            <ProgressBar
              value={extractProg}
              label={extractTotal > 0 ? `Clip ${extractCurrent} / ${extractTotal}` : 'Starting…'}
            />
            <p className="text-xs text-muted-foreground">
              Frame-accurate extraction using FFmpeg trim filter. Do not close this page.
            </p>
          </div>
        )}

        {/* Extracted: clip list ─────────────────────────────────────── */}
        {(ph1done) && clips.length > 0 && (
          <div className="rounded-xl border border-green-500/30 bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-400" />
                {clips.length} Clips Extracted
              </p>
              <button
                onClick={() => setShowClips(v => !v)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <Eye className="w-3.5 h-3.5" />
                {showClips ? 'Hide' : 'Preview Clips'}
                {showClips ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            </div>

            {showClips && (
              <div className="divide-y divide-border/50 max-h-64 overflow-y-auto">
                {clips.map((clip, i) => (
                  <div key={i} className={`px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-muted/20 transition-colors ${previewClip === i ? 'bg-primary/5' : ''}`}
                    onClick={() => setPreviewClip(previewClip === i ? null : i)}>
                    <span className="text-[11px] font-bold text-muted-foreground w-6 text-right shrink-0">
                      {clip.clipNumber}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-xs font-mono">
                        <span className="text-foreground">{fmtTs(clip.movieStart)}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="text-foreground">{fmtTs(clip.movieEnd)}</span>
                      </div>
                      {clip.label && <p className="text-[11px] text-muted-foreground truncate mt-0.5">{clip.label}</p>}
                    </div>
                    <span className="text-[11px] text-primary font-mono shrink-0 flex items-center gap-1">
                      <Clock className="w-3 h-3" />{fmtDur(clip.duration)}
                    </span>
                    <Play className={`w-3.5 h-3.5 shrink-0 ${previewClip === i ? 'text-primary' : 'text-muted-foreground'}`} />
                  </div>
                ))}
              </div>
            )}

            {/* Inline clip video preview */}
            {showClips && previewClip !== null && extractJobId && (
              <div className="border-t border-border p-4 bg-muted/10 space-y-2">
                <p className="text-xs text-muted-foreground font-semibold">
                  Clip {clips[previewClip]?.clipNumber} Preview
                </p>
                <video
                  key={`${extractJobId}-${previewClip}`}
                  src={`/api/render/clip/${extractJobId}/${previewClip}`}
                  controls
                  autoPlay
                  className="w-full rounded-lg max-h-56 bg-black"
                  style={{ colorScheme: 'dark' }}
                />
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════���════════════
            PHASE 2: MERGE
        ════════════════════════════════════════════════════════════════ */}

        {phase === 'extracted' && (
          <Button
            onClick={handleMerge}
            className="w-full h-12 text-base font-bold gap-2 bg-primary hover:bg-primary/90"
          >
            <Layers className="w-5 h-5" />
            Step 2: Merge Clips (Apply Audio Boosts)
          </Button>
        )}

        {phase === 'merging' && (
          <div className="rounded-xl border border-primary/30 bg-card p-5 space-y-4">
            <div className="flex items-center gap-2 text-primary font-semibold">
              <Loader2 className="w-4 h-4 animate-spin" />
              Merging Clips…
            </div>
            <ProgressBar value={mergeProg} label="Concat + applying audio boosts…" />
            <p className="text-xs text-muted-foreground">
              Clips are being concatenated and movie audio levels are being set. No voiceover yet.
            </p>
          </div>
        )}

        {/* Merged — auto-proceeds to finalize, no preview needed */}

        {/* ── Render without voiceover (below Step 2 preview) ────────────── */}
        {ph2done && mergeJobId && (
          <div className="rounded-xl border border-yellow-500/30 bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <Film className="w-4 h-4 text-yellow-400" />
              <p className="text-sm font-semibold text-foreground">Render Without Voiceover</p>
              <span className="ml-auto text-xs text-muted-foreground">No audio mixing</span>
            </div>
            <div className="p-4 space-y-3">

              {/* Quality Settings */}
              <div className="rounded-lg border border-border overflow-hidden">
                <button onClick={() => setShowExportQuality(v => !v)}
                  className="w-full px-3 py-2.5 flex items-center gap-2 text-sm font-semibold text-foreground hover:bg-muted/20 transition-colors">
                  <Settings className="w-4 h-4 text-primary" />
                  Quality Settings
                  <span className="ml-auto text-xs text-muted-foreground font-normal">{resolution} · {framerate}fps · {bitrate}</span>
                  {showExportQuality ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
                {showExportQuality && (
                  <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border">
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Aspect Ratio</p>
                      <div className="flex gap-2">
                        {ASPECT_RATIOS.map((ar, idx) => (
                          <button key={ar.label} onClick={() => setArIdx(idx)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors
                              ${arIdx === idx ? 'bg-primary/20 border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                            {ar.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Resolution <span className="text-primary font-mono ml-1">{resolution}</span>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {BASE_HEIGHTS.map(({ label, h }) => (
                          <button key={h} onClick={() => setBaseHeight(h)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors
                              ${baseHeight === h ? 'bg-primary/20 border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-4">
                      <div className="space-y-1.5 flex-1">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Framerate</p>
                        <input value={framerate} onChange={e => setFramerate(e.target.value)}
                          className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                          placeholder="30" />
                      </div>
                      <div className="space-y-1.5 flex-1">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Bitrate</p>
                        <input value={bitrate} onChange={e => setBitrate(e.target.value)}
                          className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                          placeholder="4M" />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Render button / progress / download */}
              {exportPhase === 'idle' && (
                <Button onClick={handleExport}
                  className="w-full h-11 text-sm font-bold gap-2 bg-yellow-600 hover:bg-yellow-500 text-white">
                  <Film className="w-4 h-4" />
                  Render Video (No Voiceover)
                </Button>
              )}

              {exportPhase === 'exporting' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-yellow-400 text-sm font-semibold">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Rendering… {exportProg}%
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div className="bg-yellow-500 h-2 rounded-full transition-all" style={{ width: `${exportProg}%` }} />
                  </div>
                </div>
              )}

              {exportPhase === 'done' && exportJobId && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-green-400 text-sm font-semibold">
                    <CheckCircle className="w-4 h-4" />
                    Render complete!
                  </div>
                  <div className="flex gap-2">
                    <a href={`/api/render/export-download/${exportJobId}`} download
                      className="flex-1 flex items-center justify-center gap-2 h-10 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-bold transition-colors">
                      <Download className="w-4 h-4" />
                      Download Video
                    </a>
                    <Button variant="outline" size="sm" onClick={() => { setExportPhase('idle'); setExportJobId(null) }}
                      className="h-10 px-3 text-xs border-border text-muted-foreground hover:text-foreground">
                      <RefreshCw className="w-3 h-3 mr-1" />Re-render
                    </Button>
                  </div>
                </div>
              )}

              {exportPhase === 'error' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-destructive text-sm">
                    <XCircle className="w-4 h-4" />
                    {exportError || 'Render failed'}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => { setExportPhase('idle'); setExportError('') }}
                    className="h-8 px-3 text-xs border-destructive/40 text-destructive hover:bg-destructive/10">
                    Try Again
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            PHASE 3: FINALIZE (voiceover + quality)
        ═══����════════════════════════════════════════════════════════════ */}

        {(phase === 'merged') && (
          <>
            {/* Voice Audio */}
            <input ref={audioInputRef} type="file" accept="audio/*" className="hidden" onChange={handleAudioReplace} />
            <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Volume2 className="w-4 h-4 text-primary shrink-0" />
                <p className="text-sm font-semibold text-foreground">
                  {customAudioUrl ? customAudioName : autoAudioLabel}
                </p>
                {audioUrl
                  ? <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">Loaded</span>
                  : <span className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-full px-2 py-0.5">Not loaded</span>
                }
                <div className="ml-auto flex items-center gap-2">
                  {customAudioUrl && (
                    <Button variant="outline" size="sm" onClick={() => { setCustomAudioUrl(null); setCustomAudioName('') }}
                      className="h-7 px-2 text-xs border-destructive/40 text-destructive hover:bg-destructive/10">
                      <X className="w-3 h-3 mr-1" />Remove
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => audioInputRef.current?.click()}
                    className="h-7 px-2 text-xs border-border text-muted-foreground hover:text-foreground">
                    <RefreshCw className="w-3 h-3 mr-1" />
                    {audioUrl ? 'Replace' : 'Load Audio'}
                  </Button>
                </div>
              </div>
              {audioUrl && <audio src={audioUrl} controls className="w-full" style={{ colorScheme: 'dark' }} />}
              {!audioUrl && <p className="text-xs text-muted-foreground">No voice audio found from Step 4. Load manually above.</p>}
            </div>

            {/* Quality Settings */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <button onClick={() => setShowQuality(v => !v)}
                className="w-full px-4 py-3 flex items-center gap-2 text-sm font-semibold text-foreground hover:bg-muted/20 transition-colors">
                <Settings className="w-4 h-4 text-primary" />
                Quality Settings
                <span className="ml-auto text-xs text-muted-foreground font-normal">{resolution} · {framerate}fps · {bitrate}</span>
                {showQuality ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </button>

              {showQuality && (
                <div className="px-4 pb-4 pt-1 space-y-4 border-t border-border">
                  {/* Aspect Ratio */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Aspect Ratio</p>
                    <div className="flex gap-2">
                      {ASPECT_RATIOS.map((ar, idx) => (
                        <button key={ar.label} onClick={() => setArIdx(idx)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors
                            ${arIdx === idx ? 'bg-primary/20 border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                          {ar.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Resolution */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Resolution <span className="text-primary font-mono ml-1">{resolution}</span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {BASE_HEIGHTS.map(({ label, h }) => (
                        <button key={h} onClick={() => setBaseHeight(h)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors
                            ${baseHeight === h ? 'bg-primary/20 border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Framerate + Bitrate */}
                  <div className="flex gap-4">
                    <div className="space-y-1.5 flex-1">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Framerate</p>
                      <input value={framerate} onChange={e => setFramerate(e.target.value)}
                        className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                        placeholder="30" />
                    </div>
                    <div className="space-y-1.5 flex-1">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Bitrate</p>
                      <input value={bitrate} onChange={e => setBitrate(e.target.value)}
                        className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                        placeholder="4M" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Finalize button */}
            <Button
              onClick={handleFinalize}
              disabled={!audioUrl}
              className="w-full h-12 text-base font-bold gap-2 bg-primary hover:bg-primary/90"
            >
              <Mic className="w-5 h-5" />
              Step 3: Finalize with Voiceover
            </Button>
          </>
        )}

        {/* Finalizing progress */}
        {phase === 'finalizing' && (
          <div className="rounded-xl border border-primary/30 bg-card p-5 space-y-4">
            <div className="flex items-center gap-2 text-primary font-semibold">
              <Loader2 className="w-4 h-4 animate-spin" />
              Adding Voiceover & Rendering…
            </div>
            <ProgressBar value={finalProg} label="Mixing audio + applying quality settings…" />
            {uploadStatus && <p className="text-xs text-muted-foreground">{uploadStatus}</p>}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            DONE
        ════════════════════════════════════════════════════════════════ */}
        {phase === 'done' && finalJobId && (
          <div className="rounded-xl border border-green-500/40 bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-green-400" />
              <p className="text-base font-bold text-foreground">Render Complete!</p>
            </div>
            <div className="p-4 flex gap-3">
              <a href={`/api/render/final-download/${finalJobId}`} download className="flex-1">
                <Button className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white font-bold h-12 text-base">
                  <Download className="w-5 h-5" /> Download Final Video
                </Button>
              </a>
              <Button variant="outline" onClick={handleReset}
                className="border-border text-muted-foreground hover:text-foreground gap-2 h-12">
                <RefreshCw className="w-4 h-4" /> New Render
              </Button>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            ERROR
        ════════════════════════════════════════════════════════════════ */}
        {phase === 'error' && (
          <div className="rounded-xl border border-destructive/40 bg-card p-5 space-y-4">
            <div className="flex items-start gap-3">
              <XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">Error</p>
                <p className="text-sm text-muted-foreground mt-1">{errorMsg}</p>
              </div>
            </div>
            <div className="flex gap-3">
              <Button variant="outline" onClick={handleReset}
                className="gap-2 border-border text-muted-foreground hover:text-foreground">
                <RefreshCw className="w-4 h-4" /> Start Over
              </Button>
              {errorMsg?.includes('re-upload') && (
                <Button variant="outline" onClick={() => { handleClearMovie(); handleReset() }}
                  className="gap-2 border-destructive/40 text-destructive hover:bg-destructive/10">
                  <Upload className="w-4 h-4" /> Re-upload Movie
                </Button>
              )}
            </div>
            {/* If in error but clips were extracted, allow re-trying merge */}
            {clips.length > 0 && !ph2done && (
              <Button onClick={() => { setPhase('extracted'); setErrorMsg('') }}
                className="w-full gap-2">
                <ArrowLeft className="w-4 h-4" /> Go Back to Merge Step
              </Button>
            )}
          </div>
        )}

        {/* ── Small info note ─────────────────────────────────────────── */}
        <p className="text-[11px] text-muted-foreground text-center pb-4">
          Movie file is remembered until you remove it or restart. Render files are stored on the server until deleted.
        </p>

      </div>
    </div>
  )
}
