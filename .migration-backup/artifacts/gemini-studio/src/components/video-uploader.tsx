import { useState, useCallback, useRef, useEffect } from 'react'
import { Upload, Link2, Send, Loader2, X, FileVideo, Plus, MessageSquare, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface Message {
  role: 'user' | 'assistant' | 'error'
  content: string
}

function parseErrorMessage(raw: string): string {
  try {
    const obj = JSON.parse(raw)
    return obj.error || obj.message || raw
  } catch {
    return raw
  }
}

function FormattedResponse({ content }: { content: string }) {
  const lines = content.split('\n')

  const renderLine = (line: string, idx: number) => {
    // H1
    if (line.startsWith('# ')) {
      return <h1 key={idx} className="text-base font-bold mt-3 mb-1 text-foreground">{renderInline(line.slice(2))}</h1>
    }
    // H2
    if (line.startsWith('## ')) {
      return <h2 key={idx} className="text-sm font-semibold mt-3 mb-1 text-foreground">{renderInline(line.slice(3))}</h2>
    }
    // H3
    if (line.startsWith('### ')) {
      return <h3 key={idx} className="text-sm font-medium mt-2 mb-1 text-foreground">{renderInline(line.slice(4))}</h3>
    }
    // Bullet
    if (/^[-*] /.test(line)) {
      return (
        <li key={idx} className="ml-4 list-disc text-sm leading-relaxed">
          {renderInline(line.slice(2))}
        </li>
      )
    }
    // Numbered list
    if (/^\d+\. /.test(line)) {
      const text = line.replace(/^\d+\. /, '')
      return (
        <li key={idx} className="ml-4 list-decimal text-sm leading-relaxed">
          {renderInline(text)}
        </li>
      )
    }
    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      return <hr key={idx} className="border-border my-2" />
    }
    // Empty line
    if (line.trim() === '') {
      return <div key={idx} className="h-2" />
    }
    // Normal paragraph
    return (
      <p key={idx} className="text-sm leading-relaxed">
        {renderInline(line)}
      </p>
    )
  }

  function renderInline(text: string): React.ReactNode {
    // Bold: **text**
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return <code key={i} className="bg-black/30 rounded px-1 py-0.5 text-xs font-mono">{part.slice(1, -1)}</code>
      }
      return part
    })
  }

  return <div className="space-y-0.5">{lines.map(renderLine)}</div>
}

const CHUNK_SIZE = 5 * 1024 * 1024 // 5 MB per chunk

async function uploadChunked(
  file: File,
  projectId: string,
  onProgress: (pct: number) => void
): Promise<string> {
  const uploadId = `${projectId}-${Date.now()}`
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  let filePath = ''

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const chunk = file.slice(start, end)

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
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  const handleVideoSelect = useCallback((file: File) => {
    if (file.type.startsWith('video/')) {
      setVideo(file)
      const url = URL.createObjectURL(file)
      setVideoPreview(url)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) handleVideoSelect(file)
    },
    [handleVideoSelect]
  )

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleVideoSelect(file)
    },
    [handleVideoSelect]
  )

  const addYoutubeLink = () => setYoutubeLinks([...youtubeLinks, ''])

  const updateYoutubeLink = (index: number, value: string) => {
    const newLinks = [...youtubeLinks]
    newLinks[index] = value
    setYoutubeLinks(newLinks)
  }

  const removeYoutubeLink = (index: number) => {
    if (youtubeLinks.length > 1) {
      setYoutubeLinks(youtubeLinks.filter((_, i) => i !== index))
    }
  }

  const clearVideo = () => {
    setVideo(null)
    if (videoPreview) {
      URL.revokeObjectURL(videoPreview)
      setVideoPreview(null)
    }
  }

  const handleSubmit = async () => {
    if (!video || !prompt.trim()) return

    setIsLoading(true)
    setUploadProgress(0)
    setMessages([{ role: 'user', content: prompt }])

    try {
      const formData = new FormData()
      formData.append('action', 'upload-video')
      formData.append('projectId', projectId)
      formData.append('prompt', prompt)
      formData.append('youtubeLinks', youtubeLinks.filter((l) => l.trim()).join('\n'))

      // Large files (>5 MB) are sent in chunks to bypass the proxy size limit
      if (video.size > CHUNK_SIZE) {
        const filePath = await uploadChunked(video, projectId, setUploadProgress)
        formData.append('filePath', filePath)
      } else {
        formData.append('video', video)
        setUploadProgress(70)
      }

      const response = await fetch('/api/gemini', {
        method: 'POST',
        body: formData,
      })

      setUploadProgress(100)
      const responseText = await response.text()

      if (!response.ok) {
        const msg = parseErrorMessage(responseText)
        setMessages((prev) => [...prev, { role: 'error', content: msg }])
        return
      }

      if (!responseText) {
        setMessages((prev) => [...prev, { role: 'error', content: 'Empty response from server' }])
        return
      }

      const data = JSON.parse(responseText)

      if (data.success && data.response) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: data.response.text || 'No response text' },
        ])
      } else {
        setMessages((prev) => [
          ...prev,
          { role: 'error', content: data.error || 'Unknown error' },
        ])
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: error instanceof Error ? error.message : 'Unknown error' },
      ])
    } finally {
      setIsLoading(false)
      setUploadProgress(0)
    }
  }

  const handleContinueChat = async () => {
    if (!chatInput.trim() || isLoading) return

    const userMessage = chatInput
    setChatInput('')
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }])
    setIsLoading(true)

    try {
      const formData = new FormData()
      formData.append('action', 'continue-chat')
      formData.append('projectId', projectId)
      formData.append('message', userMessage)

      const response = await fetch('/api/gemini', {
        method: 'POST',
        body: formData,
      })

      const responseText = await response.text()

      if (!response.ok) {
        const msg = parseErrorMessage(responseText)
        setMessages((prev) => [...prev, { role: 'error', content: msg }])
        return
      }

      if (!responseText) {
        setMessages((prev) => [...prev, { role: 'error', content: 'Empty response from server' }])
        return
      }

      const data = JSON.parse(responseText)

      if (data.success && data.response) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: data.response.text || 'No response text' },
        ])
      } else {
        setMessages((prev) => [
          ...prev,
          { role: 'error', content: data.error || 'Unknown error' },
        ])
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: error instanceof Error ? error.message : 'Unknown error' },
      ])
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
              <FileVideo className="w-5 h-5 text-primary" />
            </div>
            <h1 className="text-2xl md:text-3xl font-bold text-foreground">
              Gemini Studio Automation
            </h1>
          </div>
          <p className="text-muted-foreground">
            Upload videos and generate AI-powered scripts with Google&apos;s Gemini
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Column - Upload & Config */}
          <div className="space-y-6">
            {/* Project ID */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Project ID
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Input
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  placeholder="Enter project identifier"
                  className="bg-input border-border"
                />
              </CardContent>
            </Card>

            {/* Video Upload */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Upload className="w-4 h-4" />
                  Video Upload
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!video ? (
                  <div
                    onDrop={handleDrop}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setIsDragging(true)
                    }}
                    onDragLeave={() => setIsDragging(false)}
                    className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
                      isDragging
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <input
                      type="file"
                      accept="video/*"
                      onChange={handleFileInput}
                      className="hidden"
                      id="video-upload"
                    />
                    <label htmlFor="video-upload" className="cursor-pointer">
                      <div className="w-12 h-12 rounded-full bg-secondary mx-auto mb-4 flex items-center justify-center">
                        <Upload className="w-6 h-6 text-muted-foreground" />
                      </div>
                      <p className="text-foreground font-medium mb-1">
                        Drop your video here or click to browse
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Supports MP4, MOV, AVI, WebM
                      </p>
                    </label>
                  </div>
                ) : (
                  <div className="relative">
                    <video
                      src={videoPreview || undefined}
                      className="w-full rounded-lg max-h-48 object-cover"
                      controls
                    />
                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute top-2 right-2"
                      onClick={clearVideo}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                    <div className="mt-3 flex items-center gap-2">
                      <Badge variant="secondary" className="bg-secondary text-secondary-foreground">
                        <FileVideo className="w-3 h-3 mr-1" />
                        {video.name}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {(video.size / 1024 / 1024).toFixed(2)} MB
                      </span>
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
                    <Input
                      value={link}
                      onChange={(e) => updateYoutubeLink(index, e.target.value)}
                      placeholder="https://youtube.com/watch?v=..."
                      className="bg-input border-border"
                    />
                    {youtubeLinks.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeYoutubeLink(index)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addYoutubeLink}
                  className="w-full border-dashed"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Another Link
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
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe what kind of script you want to generate from this video..."
                  className="bg-input border-border min-h-32 resize-none"
                  rows={5}
                />
                {isLoading && uploadProgress > 0 && uploadProgress < 100 && (
                  <div className="mt-4 space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{uploadProgress < 70 ? 'Uploading video...' : 'Sending to Gemini...'}</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-300"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                )}
                <Button
                  onClick={handleSubmit}
                  disabled={!video || !prompt.trim() || isLoading}
                  className="w-full mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {uploadProgress > 0 && uploadProgress < 100
                        ? uploadProgress < 70 ? 'Uploading...' : 'Processing...'
                        : 'Waiting for Gemini...'}
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4 mr-2" />
                      Generate Script
                    </>
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
                  <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  AI Response
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
                              <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                            </div>
                          </div>
                        )
                      }

                      return (
                        <div key={index} className="flex justify-start">
                          <div className="max-w-[95%] rounded-lg px-4 py-3 bg-secondary text-secondary-foreground">
                            <FormattedResponse content={message.content} />
                          </div>
                        </div>
                      )
                    })
                  )}
                  {isLoading && (
                    <div className="flex justify-start">
                      <div className="bg-secondary rounded-lg px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-primary" />
                          <span className="text-sm text-muted-foreground">Generating...</span>
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Continue Chat Input */}
                {messages.length > 0 && (
                  <div className="p-4 border-t border-border">
                    <div className="flex gap-2">
                      <Input
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            handleContinueChat()
                          }
                        }}
                        placeholder="Continue the conversation..."
                        className="bg-input border-border"
                        disabled={isLoading}
                      />
                      <Button
                        onClick={handleContinueChat}
                        disabled={!chatInput.trim() || isLoading}
                        size="icon"
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        <Send className="w-4 h-4" />
                      </Button>
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
