import { useLocation } from 'wouter'
import { ArrowLeft, ArrowRight, ExternalLink, MonitorPlay } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShivaHeader } from '@/components/shiva-header'
import { Sounds } from '@/lib/sounds'

export default function MoviePage() {
  const [, navigate] = useLocation()

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <ShivaHeader currentStep={5} />

      <div className="flex-1 max-w-3xl mx-auto w-full px-4 py-8 flex flex-col gap-6">

        {/* Title + Back */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-foreground flex items-center gap-2">
              <MonitorPlay className="w-6 h-6 text-primary" />
              Movie Upload Instructions
            </h2>
            <p className="text-muted-foreground text-sm mt-1">
              Before the next step, you need to upload your full movie to AI Studio.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { Sounds.navigate(); navigate('/silence') }}
            className="shrink-0 flex items-center gap-2 border-border text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>
        </div>

        {/* Main instruction box */}
        <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-6 space-y-5">
          <p className="text-xs font-bold text-primary uppercase tracking-wide">Action Required</p>
          <p className="text-sm font-semibold text-foreground">
            You have completed your voiceover. Now follow these steps:
          </p>
          <ol className="space-y-3">
            {[
              'Go to aistudio.google.com in your browser',
              'Open the same project you used in Step 1',
              'Upload your full movie file there manually',
              'Then come back here and click Next',
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <span className="text-sm text-foreground">{step}</span>
              </li>
            ))}
          </ol>

          <a
            href="https://aistudio.google.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-primary hover:underline font-semibold mt-2"
          >
            Open AI Studio <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        {/* Why box */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-1">
          <p className="text-sm font-semibold text-foreground">Why this step?</p>
          <p className="text-sm text-muted-foreground">
            In the next step, SHIVA generates a precise JSON edit plan mapping each movie scene to your voiceover timeline. For this, SHIVA needs to see your full movie file in the same session.
          </p>
        </div>

        {/* Next */}
        <Button
          onClick={() => { Sounds.navigate(); navigate('/voicemap') }}
          className="w-full h-12 text-base font-bold bg-green-600 text-white hover:bg-green-500 shadow-lg shadow-green-900/30 flex items-center justify-center gap-2"
        >
          Next: Voice Map
          <ArrowRight className="w-5 h-5" />
        </Button>
      </div>
    </div>
  )
}
