import { useState, useEffect, useRef } from 'react'
import { useLocation } from 'wouter'
import {
  Loader2, Sparkles, Copy, CheckCheck, ArrowRight, RefreshCw, Send, ArrowLeft,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { ShivaHeader } from '@/components/shiva-header'
import {
  loadLastResponse, loadGeminiKeys, saveGeminiKeys,
  loadCleanedScript, saveCleanedScript, callGeminiClean, callGeminiChat,
  GeminiKeys,
} from '@/lib/api-keys'
import { Sounds } from '@/lib/sounds'

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        Sounds.copy()
        await navigator.clipboard.writeText(text).catch(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 2500)
      }}
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-all ${
        copied
          ? 'bg-green-500/20 text-green-400 border border-green-500/30'
          : 'bg-primary/15 text-primary border border-primary/25 hover:bg-primary/25'
      }`}
    >
      {copied ? <><CheckCheck className="w-3.5 h-3.5" />Copied!</> : <><Copy className="w-3.5 h-3.5" />Copy Script</>}
    </button>
  )
}

export default function ScriptPage() {
  const [, navigate] = useLocation()
  const [geminiKeys, setGeminiKeys] = useState<GeminiKeys>(loadGeminiKeys)
  const [rawResponse] = useState(loadLastResponse)

  // Load existing cleaned script from localStorage — avoids re-extracting on every visit
  const [cleanedScript, setCleanedScript] = useState<string>(() => loadCleanedScript())

  const [isCleaningLoading, setIsCleaningLoading] = useState(false)
  const [cleanError, setCleanError] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [isChatLoading, setIsChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-clean ONLY if there is no saved script yet — never re-clean automatically
  useEffect(() => {
    const saved = loadCleanedScript()
    if (rawResponse && !saved) {
      handleClean()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [cleanedScript, isCleaningLoading])

  const handleKeySwitch = (active: 1 | 2) => {
    const updated = { ...geminiKeys, active }
    setGeminiKeys(updated)
    saveGeminiKeys(updated)
  }

  const handleClean = async () => {
    if (!rawResponse) {
      setCleanError('No Gemini Studio response found. Go back to Step 1.')
      return
    }
    const keys = loadGeminiKeys()
    if (!keys.key1 && !keys.key2) {
      setCleanError('No Gemini API key set. Open Settings and add a key.')
      return
    }
    Sounds.generationStart()
    setIsCleaningLoading(true)
    setCleanError('')
    try {
      const result = await callGeminiClean(rawResponse, keys, handleKeySwitch)
      setCleanedScript(result)
      saveCleanedScript(result)
      Sounds.scriptCleanComplete()
    } catch (err) {
      Sounds.error()
      setCleanError(err instanceof Error ? err.message : 'Failed to clean script')
    } finally {
      setIsCleaningLoading(false)
    }
  }

  const handleChat = async () => {
    if (!chatInput.trim()) return
    const msg = chatInput.trim()
    setChatInput('')
    setIsChatLoading(true)
    setChatError('')
    const keys = loadGeminiKeys()
    try {
      const context = cleanedScript
        ? `Current script:\n${cleanedScript}\n\nUser request: ${msg}`
        : msg
      const result = await callGeminiChat(context, keys, handleKeySwitch)
      setCleanedScript(result)
      saveCleanedScript(result)
      Sounds.scriptCleanComplete()
    } catch (err) {
      Sounds.error()
      setChatError(err instanceof Error ? err.message : 'Failed to get response')
    } finally {
      setIsChatLoading(false)
    }
  }

  const handleApprove = () => {
    if (cleanedScript) {
      saveCleanedScript(cleanedScript)
      Sounds.approve()
      navigate('/voice')
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <ShivaHeader currentStep={2} />

      <div className="flex-1 max-w-3xl mx-auto w-full px-4 py-8 flex flex-col gap-6">

        {/* Title + Back */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-foreground flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-primary" />
              SHIVA Script
            </h2>
            <p className="text-muted-foreground text-sm mt-1">
              SHIVA extracts only the clean voiceover script from SHIVA's response.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { Sounds.navigate(); navigate('/') }}
            className="shrink-0 flex items-center gap-2 border-border text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Chat
          </Button>
        </div>

        {/* Raw response preview */}
        {rawResponse && (
          <div className="rounded-xl border border-border bg-secondary/20 p-4">
            <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Source (SHIVA Response)</p>
            <p className="text-xs text-muted-foreground line-clamp-4 whitespace-pre-wrap">{rawResponse}</p>
          </div>
        )}

        {/* Cleaned Script Area */}
        <div className="rounded-xl border border-border bg-card flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isCleaningLoading ? 'bg-yellow-400 animate-pulse' : cleanedScript ? 'bg-green-400' : 'bg-muted-foreground'}`} />
              <span className="text-sm font-semibold text-foreground">Clean Voiceover Script</span>
            </div>
            <div className="flex items-center gap-2">
              {cleanedScript && <CopyBtn text={cleanedScript} />}
              <button
                onClick={handleClean}
                disabled={isCleaningLoading || !rawResponse}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors disabled:opacity-40"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isCleaningLoading ? 'animate-spin' : ''}`} />
                Regenerate
              </button>
            </div>
          </div>

          <div className="p-4 min-h-[240px]">
            {isCleaningLoading ? (
              <div className="flex flex-col items-center justify-center h-40 gap-3">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
                <p className="text-sm text-muted-foreground">SHIVA is extracting your voiceover script...</p>
              </div>
            ) : cleanError ? (
              <p className="text-sm text-destructive">{cleanError}</p>
            ) : cleanedScript ? (
              <Textarea
                value={cleanedScript}
                onChange={e => { setCleanedScript(e.target.value); saveCleanedScript(e.target.value) }}
                className="bg-transparent border-0 resize-none min-h-[200px] text-sm leading-relaxed text-foreground focus-visible:ring-0 p-0"
                placeholder="Cleaned script will appear here..."
              />
            ) : rawResponse ? (
              <div className="flex flex-col items-center justify-center h-40 gap-3 text-muted-foreground">
                <p className="text-sm">Ready to extract — click Regenerate to start.</p>
                <Button size="sm" onClick={handleClean} disabled={isCleaningLoading}>
                  <Sparkles className="w-4 h-4 mr-2" />Extract Script
                </Button>
              </div>
            ) : (
              <Textarea
                value={cleanedScript}
                onChange={e => { setCleanedScript(e.target.value); saveCleanedScript(e.target.value) }}
                className="bg-transparent border-0 resize-none min-h-[200px] text-sm leading-relaxed text-foreground focus-visible:ring-0 p-0"
                placeholder="Paste your voiceover script here..."
                autoFocus
              />
            )}
          </div>
          {cleanedScript && !isCleaningLoading && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-secondary/10">
              <span className="text-xs text-muted-foreground">
                {cleanedScript.length.toLocaleString()} characters
              </span>
              <span className="text-xs text-muted-foreground">
                {cleanedScript.length.toLocaleString()} credits
              </span>
            </div>
          )}
        </div>

        {/* Chat for modifications */}
        {cleanedScript && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <p className="text-sm font-semibold text-foreground">Request Changes</p>
              <p className="text-xs text-muted-foreground mt-0.5">Ask SHIVA to modify the script. Voiceover formatting rules are always applied automatically.</p>
            </div>
            <div className="p-4 flex gap-2">
              <Input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChat() } }}
                placeholder="e.g. Make it more energetic, shorter, add a hook..."
                className="bg-input border-border text-sm"
                disabled={isChatLoading}
              />
              <Button
                onClick={handleChat}
                disabled={!chatInput.trim() || isChatLoading}
                size="icon"
                className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
              >
                {isChatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>
            {chatError && <p className="px-4 pb-3 text-xs text-destructive">{chatError}</p>}
          </div>
        )}

        {/* Approve CTA */}
        {cleanedScript && (
          <Button
            onClick={handleApprove}
            className="w-full h-12 text-base font-bold bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
          >
            Approve &amp; Generate Voice
            <ArrowRight className="w-5 h-5 ml-2" />
          </Button>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  )
}
