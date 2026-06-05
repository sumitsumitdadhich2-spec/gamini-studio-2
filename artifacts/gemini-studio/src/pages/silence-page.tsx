import { useState, useRef } from 'react'
import { useLocation } from 'wouter'
import {
  Loader2, ArrowLeft, Scissors, Download, RotateCcw, RefreshCw,
  ChevronRight, Volume2, AudioLines,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ShivaHeader } from '@/components/shiva-header'
import { Sounds } from '@/lib/sounds'

const AUDIO_SESSION_KEY = 'shiva-voice-audio-dataurl'
const SILENCE_LOCAL_KEY = 'shiva-silence-audio-dataurl'

function loadAudioFromSession(): string | null {
  try { return sessionStorage.getItem(AUDIO_SESSION_KEY) } catch { return null }
}

function saveSilenceAudio(dataUrl: string): void {
  try { localStorage.setItem(SILENCE_LOCAL_KEY, dataUrl) } catch { /* quota */ }
}

function formatDuration(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return '--:--'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',')
  const mime = header.match(/:(.*?);/)?.[1] || 'audio/mpeg'
  const bytes = atob(base64)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

export default function SilencePage() {
  const [, navigate] = useLocation()
  const [originalUrl] = useState<string | null>(() => loadAudioFromSession())
  const [processedUrl, setProcessedUrl] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState('')

  const [thresholdDb, setThresholdDb] = useState('-40')
  const [minSilenceDuration, setMinSilenceDuration] = useState('0.300')
  const [padding, setPadding] = useState('0.100')

  const [origDuration, setOrigDuration] = useState<number>(0)
  const [procDuration, setProcDuration] = useState<number>(0)

  const origRef = useRef<HTMLAudioElement>(null)
  const procRef = useRef<HTMLAudioElement>(null)

  const handleRemoveSilence = async () => {
    if (!originalUrl) { setError('No audio file found. Please go back to Step 3.'); return }
    setIsProcessing(true)
    setError('')
    setProcessedUrl(null)
    setProcDuration(0)

    try {
      const blob = dataUrlToBlob(originalUrl)
      const fd = new FormData()
      fd.append('audio', blob, 'voice.mp3')
      fd.append('threshold_db', thresholdDb)
      fd.append('min_silence_duration', minSilenceDuration)
      fd.append('padding', padding)

      const res = await fetch('/api/audio/remove-silence', { method: 'POST', body: fd })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Processing failed' }))
        throw new Error(errData.error || 'Processing failed')
      }

      const processedBlob = await res.blob()
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        setProcessedUrl(dataUrl)
        saveSilenceAudio(dataUrl)
      }
      reader.readAsDataURL(processedBlob)
    } catch (err) {
      Sounds.error()
      setError(err instanceof Error ? err.message : 'Processing failed')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleUndo = () => {
    setProcessedUrl(null)
    setProcDuration(0)
    setError('')
  }

  const handleReset = () => {
    setThresholdDb('-40')
    setMinSilenceDuration('0.300')
    setPadding('0.100')
  }

  const handleDownload = () => {
    if (!processedUrl) return
    const a = document.createElement('a')
    a.href = processedUrl
    a.download = `shiva-silence-removed-${Date.now()}.mp3`
    a.click()
  }

  const timeSaved = origDuration > 0 && procDuration > 0
    ? Math.max(0, origDuration - procDuration)
    : 0

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <ShivaHeader currentStep={4} />

      <div className="flex-1 max-w-3xl mx-auto w-full px-4 py-8 flex flex-col gap-6">

        {/* Title + Back */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-foreground flex items-center gap-2">
              <Scissors className="w-6 h-6 text-primary" />
              Silence Reduction
            </h2>
            <p className="text-muted-foreground text-sm mt-1">
              SHIVA will remove silence from your voiceover using FFmpeg.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { Sounds.navigate(); navigate('/voice') }}
            className="shrink-0 flex items-center gap-2 border-border text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Voice
          </Button>
        </div>

        {/* No audio warning */}
        {!originalUrl && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            No audio file found. Please go back to Step 3 and generate a voice first.
          </div>
        )}

        {/* Original audio player */}
        {originalUrl && (
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-primary" />
              <p className="text-sm font-semibold text-foreground">Original Voice</p>
              {origDuration > 0 && (
                <span className="ml-auto text-xs text-muted-foreground">{formatDuration(origDuration)}</span>
              )}
            </div>
            <audio
              ref={origRef}
              src={originalUrl}
              controls
              className="w-full"
              style={{ colorScheme: 'dark' }}
              onLoadedMetadata={() => setOrigDuration(origRef.current?.duration || 0)}
            />
          </div>
        )}

        {/* Silence Reduction Controls */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-5">
          <p className="text-sm font-semibold text-foreground">Silence Reduction Settings</p>

          <div className="space-y-4">
            {/* Threshold dB */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Silence Level (lower = more aggressive)
              </label>
              <div className="flex items-center gap-3">
                <Input
                  value={thresholdDb}
                  onChange={e => setThresholdDb(e.target.value)}
                  placeholder="-40"
                  className="bg-input border-border text-sm font-mono w-32"
                />
                <span className="text-xs text-muted-foreground">dB &mdash; e.g. -30, -40, -50</span>
              </div>
            </div>

            {/* Min Silence Duration */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Remove silences longer than (seconds)
              </label>
              <div className="flex items-center gap-3">
                <Input
                  value={minSilenceDuration}
                  onChange={e => setMinSilenceDuration(e.target.value)}
                  placeholder="0.300"
                  className="bg-input border-border text-sm font-mono w-32"
                />
                <span className="text-xs text-muted-foreground">e.g. 0.100, 0.200, 0.500, 1.300</span>
              </div>
            </div>

            {/* Padding */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Keep this much silence at edges (seconds)
              </label>
              <div className="flex items-center gap-3">
                <Input
                  value={padding}
                  onChange={e => setPadding(e.target.value)}
                  placeholder="0.100"
                  className="bg-input border-border text-sm font-mono w-32"
                />
                <span className="text-xs text-muted-foreground">e.g. 0.050, 0.100, 0.200</span>
              </div>
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="w-3 h-3 mr-1.5" />
            Reset to Default Values
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Primary action */}
        <Button
          onClick={handleRemoveSilence}
          disabled={isProcessing || !originalUrl}
          className="w-full h-12 text-base font-bold bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
        >
          {isProcessing ? (
            <><Loader2 className="w-5 h-5 mr-2 animate-spin" />SHIVA is processing audio...</>
          ) : (
            <><Scissors className="w-5 h-5 mr-2" />Remove Silence</>
          )}
        </Button>

        {/* Undo / Reprocess */}
        {processedUrl && (
          <div className="flex gap-3">
            <Button
              onClick={handleUndo}
              variant="outline"
              className="flex-1 border-border text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="w-4 h-4 mr-2" />Undo
            </Button>
            <Button
              onClick={handleRemoveSilence}
              variant="outline"
              disabled={isProcessing}
              className="flex-1 border-border text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${isProcessing ? 'animate-spin' : ''}`} />Reprocess
            </Button>
          </div>
        )}

        {/* Result: side-by-side comparison */}
        {processedUrl && (
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                <AudioLines className="w-4 h-4 text-primary" />
                Comparison
              </p>
              {timeSaved > 0.5 && (
                <span className="inline-flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2.5 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  Removed {timeSaved.toFixed(1)}s of silence
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Original */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Original</p>
                  {origDuration > 0 && <span className="text-xs text-muted-foreground">{formatDuration(origDuration)}</span>}
                </div>
                <audio
                  src={originalUrl!}
                  controls
                  className="w-full"
                  style={{ colorScheme: 'dark' }}
                />
              </div>

              {/* Processed */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-primary uppercase tracking-wide">Processed</p>
                  {procDuration > 0 && <span className="text-xs text-primary">{formatDuration(procDuration)}</span>}
                </div>
                <audio
                  ref={procRef}
                  src={processedUrl}
                  controls
                  className="w-full"
                  style={{ colorScheme: 'dark' }}
                  onLoadedMetadata={() => setProcDuration(procRef.current?.duration || 0)}
                />
              </div>
            </div>

            {origDuration > 0 && procDuration > 0 && (
              <p className="text-xs text-center text-muted-foreground">
                Original: {formatDuration(origDuration)} &rarr; Processed: {formatDuration(procDuration)}
                {timeSaved > 0.5 && ` · Removed ${timeSaved.toFixed(1)} seconds of silence`}
              </p>
            )}

            <Button
              onClick={handleDownload}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Download className="w-4 h-4 mr-2" />Download Processed Audio
            </Button>
          </div>
        )}

        {/* Next Step placeholder */}
        {processedUrl && (
          <Button
            onClick={() => { Sounds.navigate(); navigate('/movie') }}
            variant="outline"
            className="w-full h-11 border-primary/30 text-primary hover:bg-primary/10 flex items-center justify-center gap-2"
          >
            Next: Scene Analysis
            <ChevronRight className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
