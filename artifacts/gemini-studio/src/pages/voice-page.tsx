import { useState, useRef, useEffect } from 'react'
import { useLocation } from 'wouter'
import {
  Loader2, Play, Pause, Download, RefreshCw, ArrowLeft, Mic, Volume2, ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ShivaHeader } from '@/components/shiva-header'
import {
  loadCleanedScript, loadElevenLabsKeys, saveElevenLabsKeys,
  callElevenLabs, ElevenLabsKeys,
  recordElUsage, getElUsed,
} from '@/lib/api-keys'
import { Sounds } from '@/lib/sounds'

const AUDIO_SESSION_KEY = 'shiva-voice-audio-dataurl'

function saveAudioToSession(dataUrl: string) {
  try { sessionStorage.setItem(AUDIO_SESSION_KEY, dataUrl) } catch { /* ignore quota */ }
}

function loadAudioFromSession(): string | null {
  try { return sessionStorage.getItem(AUDIO_SESSION_KEY) } catch { return null }
}

function clearAudioFromSession() {
  try { sessionStorage.removeItem(AUDIO_SESSION_KEY) } catch { /* ignore */ }
}

export default function VoicePage() {
  const [, navigate] = useLocation()
  const [elKeys, setElKeys] = useState<ElevenLabsKeys>(loadElevenLabsKeys)
  const [script] = useState(loadCleanedScript)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState('')
  const [audioUrl, setAudioUrl] = useState<string | null>(() => loadAudioFromSession())
  const [isPlaying, setIsPlaying] = useState(false)
  const [voiceIdOverride, setVoiceIdOverride] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [usedChars, setUsedChars] = useState<number>(0)

  useEffect(() => {
    const keys = loadElevenLabsKeys()
    const slot: 1 | 2 = keys.active === 1 ? 1 : 2
    const activeKey = slot === 1 ? keys.key1 : keys.key2
    setUsedChars(getElUsed(slot, activeKey || ''))
  }, [])

  const effectiveVoiceId = voiceIdOverride || elKeys.voiceId

  // Sync audio element src when audioUrl is restored from session
  useEffect(() => {
    if (audioUrl && audioRef.current) {
      audioRef.current.src = audioUrl
      audioRef.current.load()
    }
  }, [audioUrl])

  const handleKeySwitch = (active: 1 | 2) => {
    const updated = { ...elKeys, active }
    setElKeys(updated)
    saveElevenLabsKeys(updated)
  }

  const handleGenerate = async () => {
    if (!script) { setError('No script found. Go back to Step 2.'); return }
    if (!effectiveVoiceId) { setError('Voice ID is required. Set it in Settings or enter below.'); return }
    const keys = loadElevenLabsKeys()
    keys.voiceId = effectiveVoiceId
    if (!keys.key1 && !keys.key2) { setError('No ElevenLabs API key set. Open Settings.'); return }

    Sounds.generationStart()
    setIsGenerating(true)
    setError('')
    setIsPlaying(false)

    // Clear old audio
    if (audioUrl && audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl)
    setAudioUrl(null)
    clearAudioFromSession()

    try {
      const blob = await callElevenLabs(script, keys, handleKeySwitch)

      const finalKeys = loadElevenLabsKeys()
      const activeSlot: 1 | 2 = finalKeys.active === 1 ? 1 : 2
      const activeKey = activeSlot === 1 ? finalKeys.key1 : finalKeys.key2
      recordElUsage(activeSlot, activeKey, script.length)
      setUsedChars(prev => prev + script.length)

      // Convert to data URL for sessionStorage persistence
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        setAudioUrl(dataUrl)
        saveAudioToSession(dataUrl)
        Sounds.voiceGenComplete()
        if (audioRef.current) {
          audioRef.current.src = dataUrl
          audioRef.current.load()
        }
      }
      reader.readAsDataURL(blob)
    } catch (err) {
      Sounds.error()
      setError(err instanceof Error ? err.message : 'Voice generation failed')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleRegenerate = () => {
    clearAudioFromSession()
    setAudioUrl(null)
    setIsPlaying(false)
    handleGenerate()
  }

  const togglePlay = () => {
    if (!audioRef.current || !audioUrl) return
    if (isPlaying) {
      audioRef.current.pause()
      setIsPlaying(false)
    } else {
      audioRef.current.play()
      setIsPlaying(true)
    }
  }

  const handleDownload = () => {
    if (!audioUrl) return
    const a = document.createElement('a')
    a.href = audioUrl
    a.download = `shiva-voice-${Date.now()}.mp3`
    a.click()
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <ShivaHeader currentStep={3} />

      <div className="flex-1 max-w-3xl mx-auto w-full px-4 py-8 flex flex-col gap-6">

        {/* Title + Back */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-foreground flex items-center gap-2">
              <Mic className="w-6 h-6 text-primary" />
              Voice Generation
            </h2>
            <p className="text-muted-foreground text-sm mt-1">
              SHIVA will generate your voiceover using ElevenLabs AI.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { Sounds.navigate(); navigate('/script') }}
            className="shrink-0 flex items-center gap-2 border-border text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Script
          </Button>
        </div>

        {/* Local usage tracker */}
        {(elKeys.key1 || elKeys.key2) && (
          <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Used this key</span>
              <span className={`font-bold tabular-nums ${usedChars >= 9000 ? 'text-red-400' : usedChars >= 6000 ? 'text-yellow-400' : 'text-foreground'}`}>
                {usedChars.toLocaleString()} / 10,000
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${usedChars >= 9000 ? 'bg-red-500' : usedChars >= 6000 ? 'bg-yellow-500' : 'bg-primary'}`}
                style={{ width: `${Math.min(100, (usedChars / 10000) * 100)}%` }}
              />
            </div>
            {usedChars >= 9500 && (
              <p className="text-xs text-red-400 font-medium">Almost out! Get a new key soon.</p>
            )}
          </div>
        )}

        {/* Script preview */}
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Script to Convert</p>
          {script ? (
            <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{script}</p>
          ) : (
            <p className="text-sm text-destructive">No script found. Please go back to Step 2.</p>
          )}
        </div>

        {/* Voice ID */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold text-foreground">Voice ID</p>
            {elKeys.voiceId && (
              <span className="text-xs text-muted-foreground">(from settings: {elKeys.voiceId.slice(0, 10)}...)</span>
            )}
          </div>
          <Input
            value={voiceIdOverride}
            onChange={e => setVoiceIdOverride(e.target.value)}
            placeholder={elKeys.voiceId || 'Enter Voice ID (e.g. EXAVITQu4vr4xnSDxMaL)'}
            className="bg-input border-border text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground">Override the Voice ID from Settings for this generation only.</p>
        </div>

        {/* Audio Player — shown when audio is available (persists between navigations) */}
        {audioUrl && (
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                <Volume2 className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Voice Ready</p>
                <p className="text-xs text-muted-foreground">SHIVA has generated your voiceover</p>
              </div>
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2.5 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                Ready
              </span>
            </div>

            <audio
              ref={audioRef}
              onEnded={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />

            {/* Native player with seek */}
            <audio src={audioUrl} controls className="w-full" style={{ colorScheme: 'dark' }} />

            <div className="flex gap-3">
              <Button onClick={togglePlay} variant="outline" className="flex-1 border-primary/30 hover:bg-primary/10">
                {isPlaying ? <><Pause className="w-4 h-4 mr-2" />Pause</> : <><Play className="w-4 h-4 mr-2" />Play</>}
              </Button>
              <Button onClick={handleDownload} className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90">
                <Download className="w-4 h-4 mr-2" />Download MP3
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Generate / Regenerate Button */}
        {audioUrl ? (
          <Button
            onClick={handleRegenerate}
            variant="outline"
            disabled={isGenerating}
            className="w-full h-11 border-border text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isGenerating ? 'animate-spin' : ''}`} />
            {isGenerating ? 'SHIVA is generating voice...' : 'Regenerate Voice'}
          </Button>
        ) : (
          <Button
            onClick={handleGenerate}
            disabled={isGenerating || !script}
            className="w-full h-12 text-base font-bold bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
          >
            {isGenerating ? (
              <><Loader2 className="w-5 h-5 mr-2 animate-spin" />SHIVA is generating voice...</>
            ) : (
              <><Mic className="w-5 h-5 mr-2" />Generate Voice</>
            )}
          </Button>
        )}

        {/* Next Step: Remove Silence */}
        {audioUrl && !isGenerating && (
          <Button
            onClick={() => { Sounds.navigate(); navigate('/silence') }}
            className="w-full h-12 text-base font-bold bg-green-600 text-white hover:bg-green-500 shadow-lg shadow-green-900/30 flex items-center justify-center gap-2"
          >
            Next: Remove Silence
            <ChevronRight className="w-5 h-5" />
          </Button>
        )}
      </div>
    </div>
  )
}
