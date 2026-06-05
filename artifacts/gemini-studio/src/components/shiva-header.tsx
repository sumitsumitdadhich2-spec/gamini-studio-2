import { useState } from 'react'
import { useLocation } from 'wouter'
import { Settings, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsPanel } from '@/components/settings-panel'

const STEPS = [
  { id: 1, label: 'Chat',     route: '/' },
  { id: 2, label: 'Script',   route: '/script' },
  { id: 3, label: 'Voice',    route: '/voice' },
  { id: 4, label: 'Silence',  route: '/silence' },
  { id: 5, label: 'Movie',    route: '/movie' },
  { id: 6, label: 'VoiceMap', route: '/voicemap' },
  { id: 7, label: 'JSON',     route: '/jsonmap' },
  { id: 8, label: 'Render',   route: '/render' },
]

export function ShivaHeader({ currentStep }: { currentStep: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [, navigate] = useLocation()

  return (
    <>
      <header className="border-b border-border bg-[oklch(0.08_0_0)] sticky top-0 z-40">
        <div className="max-w-[1400px] mx-auto px-4 md:px-8 py-3 flex items-center justify-between gap-4">
          {/* Brand */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-lg shadow-primary/20">
              <Zap className="w-5 h-5 text-primary-foreground" fill="currentColor" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight text-foreground leading-none">SHIVA</h1>
              <p className="text-[10px] text-muted-foreground leading-none mt-0.5">AI Content Studio</p>
            </div>
          </div>

          {/* Step Progress */}
          <div className="flex items-center gap-0.5">
            {STEPS.map((step, i) => {
              const done = currentStep > step.id
              const active = currentStep === step.id
              return (
                <div key={step.id} className="flex items-center gap-0.5">
                  <div
                    onClick={() => navigate(step.route)}
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold transition-all cursor-pointer ${
                      active
                        ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/30'
                        : done
                        ? 'bg-primary/20 text-primary hover:bg-primary/30'
                        : 'bg-secondary/50 text-muted-foreground hover:bg-secondary/80'
                    }`}
                  >
                    <span className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${
                      active ? 'bg-white/20' : done ? 'bg-primary/30' : 'bg-border'
                    }`}>
                      {done ? '✓' : step.id}
                    </span>
                    <span className="hidden lg:inline">{step.label}</span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={`w-2 h-px transition-colors ${currentStep > step.id ? 'bg-primary/50' : 'bg-border'}`} />
                  )}
                </div>
              )
            })}
          </div>

          {/* Settings */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-2 border-border shrink-0"
          >
            <Settings className="w-4 h-4" />
            <span className="hidden sm:inline">Settings</span>
          </Button>
        </div>
      </header>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  )
}
