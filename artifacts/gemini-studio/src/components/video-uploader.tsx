import { useState, useCallback, useRef, useEffect } from 'react'
import { useLocation } from 'wouter'
import {
  Upload, Link2, Send, Loader2, X, FileVideo, Plus, MessageSquare,
  AlertCircle, Copy, CheckCheck, Sparkles, History, Trash2, Clock,
  Paperclip, ChevronDown, ArrowRight, Pencil, Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ShivaHeader } from '@/components/shiva-header'
import { saveLastResponse, saveCleanedScript } from '@/lib/api-keys'
import { Sounds } from '@/lib/sounds'

interface Message {
  role: 'user' | 'assistant' | 'error'
  content: string
  attachments?: { type: 'video' | 'youtube'; label: string }[]
}

interface HistoryItem {
  id: string
  title: string
  projectId: string
  messages: Message[]
  timestamp: number
}

const HISTORY_KEY = 'gemini-studio-history'
const MAX_HISTORY = 50

function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  } catch {
    return []
  }
}

function saveHistory(items: HistoryItem[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)))
}

function pushHistoryItem(item: HistoryItem) {
  const existing = loadHistory().filter(h => h.id !== item.id)
  saveHistory([item, ...existing])
}

function deleteHistoryItem(id: string) {
  saveHistory(loadHistory().filter(h => h.id !== id))
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function parseErrorMessage(raw: string): string {
  try {
    const obj = JSON.parse(raw)
    return obj.error || obj.message || raw
  } catch {
    return raw
  }
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `0:${s.toString().padStart(2, '0')}`
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    Sounds.copy()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      const el = document.createElement('textarea')
      el.value = text
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    }
  }
  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md transition-all duration-200 ${
        copied
          ? 'bg-green-500/20 text-green-400 border border-green-500/30'
          : 'bg-primary/15 text-primary border border-primary/25 hover:bg-primary/25'
      }`}
    >
      {copied ? (
        <><CheckCheck className="w-3 h-3" />Copied!</>
      ) : (
        <><Copy className="w-3 h-3" />Copy Output</>
      )}
    </button>
  )
}

function FormattedResponse({ content }: { content: string }) {
  const lines = content.split('\n')
  const renderLine = (line: string, idx: number) => {
    if (line.startsWith('# ')) return <h1 key={idx} className="text-base font-bold mt-3 mb-1 text-foreground">{renderInline(line.slice(2))}</h1>
    if (line.startsWith('## ')) return <h2 key={idx} className="text-sm font-semibold mt-3 mb-1 text-foreground">{renderInline(line.slice(3))}</h2>
    if (line.startsWith('### ')) return <h3 key={idx} className="text-sm font-medium mt-2 mb-1 text-foreground">{renderInline(line.slice(4))}</h3>
    if (/^[-*] /.test(line)) return <li key={idx} className="ml-4 list-disc text-sm leading-relaxed">{renderInline(line.slice(2))}</li>
    if (/^\d+\. /.test(line)) return <li key={idx} className="ml-4 list-decimal text-sm leading-relaxed">{renderInline(line.replace(/^\d+\. /, ''))}</li>
    if (/^---+$/.test(line.trim())) return <hr key={idx} className="border-border my-2" />
    if (line.trim() === '') return <div key={idx} className="h-2" />
    return <p key={idx} className="text-sm leading-relaxed">{renderInline(line)}</p>
  }
  function renderInline(text: string): React.ReactNode {
    return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
      if (part.startsWith('`') && part.endsWith('`')) return <code key={i} className="bg-black/30 rounded px-1 py-0.5 text-xs font-mono">{part.slice(1, -1)}</code>
      return part
    })
  }
  return <div className="space-y-0.5">{lines.map(renderLine)}</div>
}

const CHUNK_SIZE = 5 * 1024 * 1024

async function uploadChunked(file: File, projectId: string, onProgress: (pct: number) => void): Promise<string> {
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
    const res = await fetch('/api/gemini', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`Chunk ${i + 1}/${totalChunks} upload failed`)
    const data = await res.json()
    if (data.filePath) filePath = data.filePath
    onProgress(Math.round(((i + 1) / totalChunks) * 70))
  }
  return filePath
}

export function VideoUploader() {
  const [, navigate] = useLocation()
  const [video, setVideo] = useState<File | null>(null)
  const [videoPreview, setVideoPreview] = useState<string | null>(null)
  const [youtubeLinks, setYoutubeLinks] = useState<string[]>([''])
  const [prompt, setPrompt] = useState('')
  const [projectId, setProjectId] = useState('default-project')
  const [isLoading, setIsLoading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [messages, setMessages] = useState<Message[]>([])
  const [chatInput, setChatInput] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [generationPhase, setGenerationPhase] = useState<'uploading' | 'sending' | 'generating'>('generating')
  const [justCompleted, setJustCompleted] = useState(false)
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID())

  // History
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory)
  const [editingHistoryId, setEditingHistoryId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  // Model selector
  const [selectedModel, setSelectedModel] = useState('gemini-3.5-flash')

  // Continue-chat attach panel
  const [attachOpen, setAttachOpen] = useState(false)
  const [chatVideo, setChatVideo] = useState<File | null>(null)
  const [chatYoutubeLinks, setChatYoutubeLinks] = useState<string[]>([''])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const chatVideoInputRef = useRef<HTMLInputElement>(null)

  // App open sound — plays once on first mount
  useEffect(() => { Sounds.appOpen() }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  useEffect(() => {
    if (isLoading) {
      setElapsedSeconds(0)
      timerRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000)
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isLoading])

  // Auto-save to history whenever messages change (after first assistant turn)
  useEffect(() => {
    if (messages.length >= 2) {
      const title = messages.find(m => m.role === 'user')?.content?.slice(0, 60) || 'Untitled session'
      const item: HistoryItem = { id: sessionId, title, projectId, messages, timestamp: Date.now() }
      pushHistoryItem(item)
      setHistory(loadHistory())
    }
  }, [messages, projectId, sessionId])

  const handleVideoSelect = useCallback((file: File) => {
    const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'webm', 'mkv', '3gp', 'flv', 'm4v', 'wmv']
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const isVideo = file.type.startsWith('video/') || VIDEO_EXTENSIONS.includes(ext) || file.type === 'application/octet-stream'
    if (isVideo) {
      setVideo(file)
      const url = URL.createObjectURL(file)
      setVideoPreview(url)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleVideoSelect(file)
  }, [handleVideoSelect])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleVideoSelect(file)
  }, [handleVideoSelect])

  const clearVideo = () => {
    setVideo(null)
    if (videoPreview) { URL.revokeObjectURL(videoPreview); setVideoPreview(null) }
  }

  const handleSubmit = async () => {
    if (!prompt.trim()) return
    Sounds.generationStart()
    setIsLoading(true)
    setJustCompleted(false)
    setUploadProgress(0)
    setGenerationPhase('uploading')
    const newId = crypto.randomUUID()
    setSessionId(newId)
    setMessages([{ role: 'user', content: prompt }])

    try {
      const formData = new FormData()
      formData.append('action', 'upload-video')
      formData.append('projectId', projectId)
      formData.append('prompt', prompt)
      formData.append('youtubeLinks', youtubeLinks.filter(l => l.trim()).join('\n'))
      formData.append('model', selectedModel)

      if (video && video.size > CHUNK_SIZE) {
        const filePath = await uploadChunked(video, projectId, setUploadProgress)
        formData.append('filePath', filePath)
      } else if (video) {
        formData.append('video', video)
        setUploadProgress(70)
      } else {
        setUploadProgress(70)
      }

      setGenerationPhase('sending')
      const response = await fetch('/api/gemini', { method: 'POST', body: formData })
      setUploadProgress(100)
      setGenerationPhase('generating')
      const responseText = await response.text()

      if (!response.ok) {
        setMessages(prev => [...prev, { role: 'error', content: parseErrorMessage(responseText) }])
        return
      }
      if (!responseText) {
        setMessages(prev => [...prev, { role: 'error', content: 'Empty response from server' }])
        return
      }

      const data = JSON.parse(responseText)
      if (data.success && data.response) {
        const respText = data.response.text
        if (respText && respText.length > 0) {
          setMessages(prev => [...prev, { role: 'assistant', content: respText }])
          saveLastResponse(respText)
          try { localStorage.setItem('shiva-last-project-id', projectId) } catch {}
          Sounds.generationComplete()
          setJustCompleted(true)
          setTimeout(() => setJustCompleted(false), 8000)
        } else {
          Sounds.error()
          const debugInfo = data.response.debug
            ? `[DEBUG — page content seen by browser]\n\n${data.response.debug}`
            : '[No response text extracted. Check API logs for [wait] messages.]'
          setMessages(prev => [...prev, { role: 'error', content: debugInfo }])
        }
      } else {
        setMessages(prev => [...prev, { role: 'error', content: data.error || 'Unknown error' }])
      }
    } catch (error) {
      setMessages(prev => [...prev, { role: 'error', content: error instanceof Error ? error.message : 'Unknown error' }])
    } finally {
      setIsLoading(false)
      setUploadProgress(0)
    }
  }

  const handleContinueChat = async () => {
    if (!chatInput.trim() || isLoading) return
    Sounds.generationStart()

    const userMessage = chatInput
    const hasAttachments = chatVideo !== null || chatYoutubeLinks.some(l => l.trim())
    const attachments: Message['attachments'] = []
    if (chatVideo) attachments.push({ type: 'video', label: chatVideo.name })
    chatYoutubeLinks.filter(l => l.trim()).forEach(l => attachments.push({ type: 'youtube', label: l }))

    setChatInput('')
    setJustCompleted(false)
    setMessages(prev => [...prev, {
      role: 'user',
      content: userMessage,
      attachments: attachments.length > 0 ? attachments : undefined,
    }])
    setIsLoading(true)
    setGenerationPhase(hasAttachments ? 'uploading' : 'generating')

    try {
      const formData = new FormData()
      formData.append('action', 'continue-chat')
      formData.append('projectId', projectId)
      formData.append('message', userMessage)
      formData.append('model', selectedModel)

      if (chatVideo && chatVideo.size > CHUNK_SIZE) {
        setGenerationPhase('uploading')
        const filePath = await uploadChunked(chatVideo, projectId, () => {})
        formData.append('filePath', filePath)
      } else if (chatVideo) {
        formData.append('video', chatVideo)
      }

      const ytLinks = chatYoutubeLinks.filter(l => l.trim())
      if (ytLinks.length > 0) {
        formData.append('youtubeLinks', ytLinks.join('\n'))
      }

      setGenerationPhase('sending')
      const response = await fetch('/api/gemini', { method: 'POST', body: formData })
      setGenerationPhase('generating')
      const responseText = await response.text()

      if (!response.ok) {
        setMessages(prev => [...prev, { role: 'error', content: parseErrorMessage(responseText) }])
        return
      }
      if (!responseText) {
        setMessages(prev => [...prev, { role: 'error', content: 'Empty response from server' }])
        return
      }

      const data = JSON.parse(responseText)
      if (data.success && data.response) {
        const respText = data.response.text
        if (respText && respText.length > 0) {
          setMessages(prev => [...prev, { role: 'assistant', content: respText }])
          saveLastResponse(respText)
          Sounds.generationComplete()
          setJustCompleted(true)
          setTimeout(() => setJustCompleted(false), 8000)
        } else {
          Sounds.error()
          const debugInfo = data.response.debug
            ? `[DEBUG — page content seen by browser]\n\n${data.response.debug}`
            : '[No response text extracted. Check API logs.]'
          setMessages(prev => [...prev, { role: 'error', content: debugInfo }])
        }
      } else {
        setMessages(prev => [...prev, { role: 'error', content: data.error || 'Unknown error' }])
      }
    } catch (error) {
      setMessages(prev => [...prev, { role: 'error', content: error instanceof Error ? error.message : 'Unknown error' }])
    } finally {
      setIsLoading(false)
      setChatVideo(null)
      setChatYoutubeLinks([''])
      setAttachOpen(false)
    }
  }

  const loadFromHistory = (item: HistoryItem) => {
    setSessionId(item.id)
    setProjectId(item.projectId)
    setMessages(item.messages)
    setHistoryOpen(false)
  }

  const removeFromHistory = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    deleteHistoryItem(id)
    setHistory(loadHistory())
  }

  const startEditingTitle = (item: HistoryItem, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingHistoryId(item.id)
    setEditingTitle(item.title)
  }

  const saveEditedTitle = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!editingTitle.trim()) { setEditingHistoryId(null); return }
    const updated = loadHistory().map(h => h.id === id ? { ...h, title: editingTitle.trim() } : h)
    saveHistory(updated)
    setHistory(updated)
    setEditingHistoryId(null)
  }

  const clearChatVideo = () => setChatVideo(null)

  const phaseLabel = generationPhase === 'uploading'
    ? 'Uploading video...'
    : generationPhase === 'sending'
    ? 'Sending to SHIVA...'
    : 'Generating response...'

  return (
    <div className="min-h-screen flex flex-col">
      <ShivaHeader currentStep={1} />
      {/* History Drawer */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setHistoryOpen(false)} />
          <div className="relative z-10 w-full max-w-sm bg-card border-r border-border flex flex-col h-full shadow-2xl animate-in slide-in-from-left duration-200">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-primary" />
                <h2 className="font-semibold text-sm">Chat History</h2>
              </div>
              <div className="flex items-center gap-2">
                {history.length > 0 && (
                  <button
                    onClick={() => { saveHistory([]); setHistory([]) }}
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Clear all
                  </button>
                )}
                <Button variant="ghost" size="icon" onClick={() => setHistoryOpen(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {history.length === 0 ? (
                <div className="text-center text-muted-foreground py-12">
                  <Clock className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm font-medium">No history yet</p>
                  <p className="text-xs mt-1">Your sessions will appear here</p>
                </div>
              ) : (
                history.map(item => (
                  <div
                    key={item.id}
                    onClick={() => editingHistoryId !== item.id && loadFromHistory(item)}
                    className="group flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/5 cursor-pointer transition-all"
                  >
                    <MessageSquare className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      {editingHistoryId === item.id ? (
                        <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                          <Input
                            value={editingTitle}
                            onChange={e => setEditingTitle(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveEditedTitle(item.id)
                              if (e.key === 'Escape') setEditingHistoryId(null)
                            }}
                            autoFocus
                            className="h-6 text-xs bg-input border-primary/50 px-2 py-0"
                          />
                          <button
                            onClick={e => saveEditedTitle(item.id, e)}
                            className="text-green-400 hover:text-green-300 shrink-0"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setEditingHistoryId(null) }}
                            className="text-muted-foreground hover:text-foreground shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground">{timeAgo(item.timestamp)}</span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">{item.messages.filter(m => m.role === 'assistant').length} responses</span>
                        {item.projectId !== 'default-project' && (
                          <Badge variant="secondary" className="text-xs px-1.5 py-0">{item.projectId}</Badge>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={e => startEditingTitle(item, e)}
                        className="text-muted-foreground hover:text-primary"
                        title="Rename"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={e => removeFromHistory(item.id, e)}
                        className="text-muted-foreground hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="p-3 border-t border-border">
              <button
                onClick={() => {
                  setMessages([])
                  setPrompt('')
                  setVideo(null)
                  setVideoPreview(null)
                  setYoutubeLinks([''])
                  setSessionId(crypto.randomUUID())
                  setHistoryOpen(false)
                }}
                className="w-full text-sm text-primary hover:text-primary/80 transition-colors py-2 rounded-lg border border-primary/30 hover:bg-primary/5"
              >
                + New Session
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-[1400px] mx-auto p-4 md:p-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <p className="text-sm text-muted-foreground">Step 1 — Upload a video and generate your script with SHIVA</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { Sounds.historyOpen(); setHistoryOpen(true) }}
            className="flex items-center gap-2 border-border"
          >
            <History className="w-4 h-4" />
            History
            {history.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-xs px-1.5 py-0">{history.length}</Badge>
            )}
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Column */}
          <div className="space-y-6">
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
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Project ID</CardTitle>
              </CardHeader>
              <CardContent>
                <Input value={projectId} onChange={e => setProjectId(e.target.value)} placeholder="Enter project identifier" className="bg-input border-border" />
              </CardContent>
            </Card>

            {/* Video Upload */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Upload className="w-4 h-4" />
                  Video Upload <span className="text-xs font-normal opacity-60">(Optional)</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!video ? (
                  <div
                    onDrop={handleDrop}
                    onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
                    onDragLeave={() => setIsDragging(false)}
                    className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}
                  >
                    <input type="file" accept="video/*,.mp4,.mov,.avi,.webm,.mkv,.3gp,.flv,.m4v,.wmv" onChange={handleFileInput} className="hidden" id="video-upload" />
                    <label htmlFor="video-upload" className="cursor-pointer">
                      <div className="w-12 h-12 rounded-full bg-secondary mx-auto mb-4 flex items-center justify-center">
                        <Upload className="w-6 h-6 text-muted-foreground" />
                      </div>
                      <p className="text-foreground font-medium mb-1">Drop your video here or click to browse</p>
                      <p className="text-sm text-muted-foreground">Supports MP4, MOV, AVI, WebM</p>
                    </label>
                  </div>
                ) : (
                  <div className="relative">
                    <video src={videoPreview || undefined} className="w-full rounded-lg max-h-48 object-cover" controls />
                    <Button variant="destructive" size="icon" className="absolute top-2 right-2" onClick={clearVideo}>
                      <X className="w-4 h-4" />
                    </Button>
                    <div className="mt-3 flex items-center gap-2">
                      <Badge variant="secondary" className="bg-secondary text-secondary-foreground">
                        <FileVideo className="w-3 h-3 mr-1" />{video.name}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{(video.size / 1024 / 1024).toFixed(2)} MB</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* YouTube Links */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Link2 className="w-4 h-4" />
                  YouTube References (Optional)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {youtubeLinks.map((link, index) => (
                  <div key={index} className="flex gap-2">
                    <Input value={link} onChange={e => { const n = [...youtubeLinks]; n[index] = e.target.value; setYoutubeLinks(n) }} placeholder="https://youtube.com/watch?v=..." className="bg-input border-border" />
                    {youtubeLinks.length > 1 && (
                      <Button variant="ghost" size="icon" onClick={() => setYoutubeLinks(youtubeLinks.filter((_, i) => i !== index))} className="text-muted-foreground hover:text-destructive">
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setYoutubeLinks([...youtubeLinks, ''])} className="w-full border-dashed">
                  <Plus className="w-4 h-4 mr-2" />Add Another Link
                </Button>
              </CardContent>
            </Card>

            {/* Prompt */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" />
                  Script Generation Prompt
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder="Describe what kind of script you want to generate from this video..."
                  className="bg-input border-border min-h-32 resize-none"
                  rows={5}
                />
                {isLoading && uploadProgress > 0 && uploadProgress < 100 && (
                  <div className="mt-4 space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{phaseLabel}</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                    </div>
                  </div>
                )}
                <Button
                  onClick={handleSubmit}
                  disabled={!prompt.trim() || isLoading}
                  className="w-full mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {isLoading ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{uploadProgress > 0 && uploadProgress < 100 ? phaseLabel : `Generating... ${formatElapsed(elapsedSeconds)}`}</>
                  ) : (
                    <><Send className="w-4 h-4 mr-2" />Generate Script</>
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Right Column - Chat & Response */}
          <div className="lg:sticky lg:top-8 lg:h-fit">
            <Card className="bg-card border-border h-[calc(100vh-8rem)] flex flex-col">
              <CardHeader className="pb-3 border-b border-border">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isLoading ? 'bg-yellow-400 animate-pulse' : justCompleted ? 'bg-green-400' : 'bg-primary animate-pulse'}`} />
                  AI Response
                  {isLoading && (
                    <span className="ml-auto text-xs font-normal text-yellow-400 flex items-center gap-1.5 tabular-nums">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {phaseLabel.replace('...', '')} — {formatElapsed(elapsedSeconds)}
                    </span>
                  )}
                  {justCompleted && !isLoading && (
                    <span className="ml-auto text-xs font-normal text-green-400 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3" />Done! Ready to copy
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 overflow-hidden p-0 flex flex-col">
                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {messages.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-center text-muted-foreground">
                      <div>
                        <div className="w-16 h-16 rounded-full bg-secondary mx-auto mb-4 flex items-center justify-center">
                          <MessageSquare className="w-8 h-8" />
                        </div>
                        <p className="font-medium">No messages yet</p>
                        <p className="text-sm">Upload a video and submit a prompt to get started</p>
                      </div>
                    </div>
                  ) : (
                    messages.map((message, index) => {
                      const isLastAssistant = message.role === 'assistant' && index === messages.length - 1
                      if (message.role === 'error') {
                        return (
                          <div key={index} className="flex items-start gap-2 text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3">
                            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                            <p className="text-sm">{message.content}</p>
                          </div>
                        )
                      }
                      if (message.role === 'user') {
                        return (
                          <div key={index} className="flex justify-end">
                            <div className="max-w-[90%] rounded-lg px-4 py-3 bg-primary text-primary-foreground">
                              {message.attachments && message.attachments.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mb-2">
                                  {message.attachments.map((att, i) => (
                                    <span key={i} className="inline-flex items-center gap-1 text-xs bg-white/20 rounded px-2 py-0.5">
                                      {att.type === 'video' ? <FileVideo className="w-3 h-3" /> : <Link2 className="w-3 h-3" />}
                                      <span className="max-w-[120px] truncate">{att.label}</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                              <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                            </div>
                          </div>
                        )
                      }
                      return (
                        <div key={index} className="flex justify-start">
                          <div className="max-w-[95%] rounded-lg px-4 py-3 bg-secondary text-secondary-foreground">
                            <FormattedResponse content={message.content} />
                            <div className={`mt-3 pt-2 border-t flex items-center gap-2 flex-wrap ${isLastAssistant && justCompleted ? 'border-green-500/30' : 'border-border/50'}`}>
                              <CopyButton text={message.content} />
                              {isLastAssistant && justCompleted && (
                                <span className="text-xs text-green-400 flex items-center gap-1">
                                  <Sparkles className="w-3 h-3" />Generation complete
                                </span>
                              )}
                              <button
                                onClick={() => {
                                  Sounds.navigate()
                                  saveLastResponse(message.content)
                                  saveCleanedScript('')
                                  navigate('/script')
                                }}
                                className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-sm shadow-primary/20"
                              >
                                Continue to SHIVA Script
                                <ArrowRight className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })
                  )}
                  {isLoading && (
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

                {/* Continue Chat Input */}
                {messages.length > 0 && (
                  <div className="border-t border-border">
                    {/* Attach panel */}
                    {attachOpen && (
                      <div className="p-3 border-b border-border bg-secondary/30 space-y-3">
                        {/* Video attach */}
                        <div>
                          <p className="text-xs text-muted-foreground mb-1.5 font-medium">Attach Video</p>
                          {chatVideo ? (
                            <div className="flex items-center gap-2 bg-input rounded-lg px-3 py-2">
                              <FileVideo className="w-4 h-4 text-primary shrink-0" />
                              <span className="text-xs flex-1 truncate">{chatVideo.name}</span>
                              <span className="text-xs text-muted-foreground">{(chatVideo.size / 1024 / 1024).toFixed(1)} MB</span>
                              <button onClick={clearChatVideo} className="text-muted-foreground hover:text-destructive">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => chatVideoInputRef.current?.click()}
                              className="w-full text-xs border border-dashed border-border rounded-lg py-2.5 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors flex items-center justify-center gap-2"
                            >
                              <Upload className="w-3.5 h-3.5" />Click to attach a video
                            </button>
                          )}
                          <input
                            ref={chatVideoInputRef}
                            type="file"
                            accept="video/*,.mp4,.mov,.avi,.webm,.mkv,.3gp,.flv,.m4v,.wmv"
                            className="hidden"
                            onChange={e => { const f = e.target.files?.[0]; if (f) setChatVideo(f); e.target.value = '' }}
                          />
                        </div>

                        {/* YouTube links */}
                        <div>
                          <p className="text-xs text-muted-foreground mb-1.5 font-medium">Add YouTube Links</p>
                          <div className="space-y-2">
                            {chatYoutubeLinks.map((link, i) => (
                              <div key={i} className="flex gap-2">
                                <Input
                                  value={link}
                                  onChange={e => { const n = [...chatYoutubeLinks]; n[i] = e.target.value; setChatYoutubeLinks(n) }}
                                  placeholder="https://youtube.com/watch?v=..."
                                  className="bg-input border-border text-xs h-8"
                                />
                                {chatYoutubeLinks.length > 1 && (
                                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => setChatYoutubeLinks(chatYoutubeLinks.filter((_, j) => j !== i))}>
                                    <X className="w-3.5 h-3.5" />
                                  </Button>
                                )}
                              </div>
                            ))}
                            <button
                              onClick={() => setChatYoutubeLinks([...chatYoutubeLinks, ''])}
                              className="text-xs text-primary hover:text-primary/80 flex items-center gap-1"
                            >
                              <Plus className="w-3 h-3" />Add link
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="p-4">
                      {isLoading && (
                        <div className="mb-2 flex items-center gap-2 text-xs text-yellow-400">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span className="tabular-nums">{phaseLabel} {formatElapsed(elapsedSeconds)}</span>
                        </div>
                      )}
                      <div className="flex gap-2 items-center">
                        <button
                          onClick={() => setAttachOpen(!attachOpen)}
                          disabled={isLoading}
                          title="Attach video or YouTube link"
                          className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-lg border transition-colors ${
                            attachOpen || chatVideo || chatYoutubeLinks.some(l => l.trim())
                              ? 'border-primary text-primary bg-primary/10'
                              : 'border-border text-muted-foreground hover:border-primary/50 hover:text-primary'
                          } disabled:opacity-40`}
                        >
                          {attachOpen ? <ChevronDown className="w-4 h-4" /> : <Paperclip className="w-4 h-4" />}
                          {(chatVideo || chatYoutubeLinks.some(l => l.trim())) && !attachOpen && (
                            <span className="absolute -top-1 -right-1 w-2 h-2 bg-primary rounded-full" />
                          )}
                        </button>
                        <Input
                          value={chatInput}
                          onChange={e => setChatInput(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleContinueChat() } }}
                          placeholder={isLoading ? 'Waiting for response...' : 'Continue the conversation...'}
                          className="bg-input border-border"
                          disabled={isLoading}
                        />
                        <Button
                          onClick={handleContinueChat}
                          disabled={!chatInput.trim() || isLoading}
                          size="icon"
                          className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
                        >
                          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        </Button>
                      </div>
                      {(chatVideo || chatYoutubeLinks.some(l => l.trim())) && !attachOpen && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {chatVideo && (
                            <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded px-2 py-0.5 border border-primary/20">
                              <FileVideo className="w-3 h-3" />{chatVideo.name}
                            </span>
                          )}
                          {chatYoutubeLinks.filter(l => l.trim()).map((l, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded px-2 py-0.5 border border-primary/20">
                              <Link2 className="w-3 h-3" /><span className="max-w-[120px] truncate">{l}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
