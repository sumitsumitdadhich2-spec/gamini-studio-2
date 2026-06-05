// SHIVA Sound Engine — Web Audio API, no files needed
// All sounds generated programmatically via oscillators + envelopes

let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

function ramp(param: AudioParam, from: number, to: number, duration: number, startTime: number) {
  param.setValueAtTime(from, startTime)
  param.exponentialRampToValueAtTime(Math.max(to, 0.0001), startTime + duration)
}

function tone(
  freq: number,
  volume: number,
  duration: number,
  startDelay = 0,
  type: OscillatorType = 'sine',
  attack = 0.01,
  decay = 0.1,
  sustain = 0.6,
  release = 0.2
) {
  const c = getCtx()
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.connect(gain)
  gain.connect(c.destination)

  osc.type = type
  osc.frequency.setValueAtTime(freq, c.currentTime + startDelay)

  const t = c.currentTime + startDelay
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(volume, t + attack)
  gain.gain.exponentialRampToValueAtTime(volume * sustain, t + attack + decay)
  gain.gain.setValueAtTime(volume * sustain, t + duration - release)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)

  osc.start(t)
  osc.stop(t + duration + 0.05)
}

function sweep(
  fromFreq: number,
  toFreq: number,
  volume: number,
  duration: number,
  startDelay = 0,
  type: OscillatorType = 'sine'
) {
  const c = getCtx()
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.connect(gain)
  gain.connect(c.destination)

  osc.type = type
  const t = c.currentTime + startDelay
  osc.frequency.setValueAtTime(fromFreq, t)
  osc.frequency.exponentialRampToValueAtTime(toFreq, t + duration)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)
  osc.start(t)
  osc.stop(t + duration + 0.05)
}

function noise(volume: number, duration: number, startDelay = 0, cutoff = 2000) {
  const c = getCtx()
  const bufferSize = c.sampleRate * duration
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1

  const source = c.createBufferSource()
  source.buffer = buffer

  const filter = c.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = cutoff

  const gain = c.createGain()
  source.connect(filter)
  filter.connect(gain)
  gain.connect(c.destination)

  const t = c.currentTime + startDelay
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)

  source.start(t)
  source.stop(t + duration + 0.05)
}

export const Sounds = {
  // App open — relaxing ascending 3-note chord (soft, welcoming)
  appOpen: () => {
    tone(261.6, 0.06, 0.8, 0,    'sine', 0.05, 0.1, 0.5, 0.4)  // C4
    tone(329.6, 0.05, 0.8, 0.12, 'sine', 0.05, 0.1, 0.5, 0.4)  // E4
    tone(392.0, 0.07, 1.0, 0.25, 'sine', 0.05, 0.1, 0.5, 0.5)  // G4
    tone(523.3, 0.04, 0.9, 0.4,  'sine', 0.05, 0.1, 0.5, 0.5)  // C5 (octave, soft)
  },

  // Generation start — soft rising whoosh
  generationStart: () => {
    sweep(180, 520, 0.06, 0.4, 0, 'sine')
    noise(0.04, 0.3, 0.05, 1200)
  },

  // Generation complete — LOUD satisfying chime (user's request: louder here)
  generationComplete: () => {
    tone(523.3, 0.25, 0.8, 0,    'triangle', 0.01, 0.05, 0.7, 0.4) // C5
    tone(659.3, 0.20, 0.9, 0.12, 'triangle', 0.01, 0.05, 0.7, 0.5) // E5
    tone(784.0, 0.28, 1.0, 0.25, 'triangle', 0.01, 0.05, 0.7, 0.6) // G5
    tone(1046.5, 0.22, 1.1, 0.4, 'sine',     0.01, 0.05, 0.6, 0.7) // C6 (high bright)
    // Subtle sparkle
    tone(1318.5, 0.10, 0.5, 0.5, 'sine', 0.01, 0.02, 0.3, 0.3)     // E6
  },

  // Script clean complete — pleasant ding
  scriptCleanComplete: () => {
    tone(880.0, 0.18, 0.7, 0,    'sine', 0.01, 0.05, 0.6, 0.4)  // A5
    tone(1108.7, 0.14, 0.7, 0.1, 'sine', 0.01, 0.05, 0.5, 0.4)  // C#6
    tone(659.3,  0.10, 0.6, 0.0, 'sine', 0.02, 0.08, 0.4, 0.5)  // E5 harmony
  },

  // Voice generation complete — triumphant, loud (louder than others)
  voiceGenComplete: () => {
    tone(392.0, 0.22, 0.5, 0,    'triangle', 0.01, 0.05, 0.7, 0.3) // G4
    tone(523.3, 0.25, 0.8, 0.1,  'triangle', 0.01, 0.05, 0.7, 0.5) // C5
    tone(659.3, 0.28, 1.0, 0.22, 'triangle', 0.01, 0.05, 0.7, 0.6) // E5
    tone(784.0, 0.30, 1.2, 0.35, 'triangle', 0.01, 0.04, 0.8, 0.7) // G5
    tone(1046.5, 0.25, 1.0, 0.5, 'sine',     0.01, 0.04, 0.6, 0.8) // C6
    tone(1318.5, 0.18, 0.8, 0.65,'sine',     0.01, 0.03, 0.5, 0.6) // E6 sparkle
  },

  // Copy button — crisp soft tick
  copy: () => {
    tone(1200, 0.12, 0.08, 0, 'square', 0.001, 0.02, 0.1, 0.06)
    tone(1800, 0.08, 0.06, 0.03, 'square', 0.001, 0.02, 0.1, 0.05)
  },

  // Navigation / page transition — smooth sweep
  navigate: () => {
    sweep(400, 700, 0.07, 0.25, 0, 'sine')
    noise(0.025, 0.15, 0, 800)
  },

  // Error — low soft thud
  error: () => {
    tone(120, 0.15, 0.4, 0, 'triangle', 0.01, 0.05, 0.5, 0.3)
    tone(90,  0.10, 0.5, 0.05, 'sine', 0.01, 0.1, 0.3, 0.3)
  },

  // Settings open — subtle airy pop
  settingsOpen: () => {
    sweep(600, 900, 0.06, 0.18, 0, 'sine')
    tone(1200, 0.04, 0.12, 0.05, 'sine', 0.005, 0.03, 0.2, 0.1)
  },

  // Settings close — reverse soft pop
  settingsClose: () => {
    sweep(900, 500, 0.05, 0.15, 0, 'sine')
  },

  // History open — soft swipe
  historyOpen: () => {
    sweep(300, 550, 0.06, 0.2, 0, 'sine')
    noise(0.03, 0.15, 0, 600)
  },

  // Generic button click — very subtle tick
  buttonClick: () => {
    tone(800, 0.06, 0.05, 0, 'sine', 0.001, 0.01, 0.1, 0.04)
  },

  // Save / confirm — small positive chime
  save: () => {
    tone(659.3, 0.12, 0.4, 0,    'sine', 0.01, 0.05, 0.5, 0.25) // E5
    tone(880.0, 0.14, 0.5, 0.12, 'sine', 0.01, 0.05, 0.5, 0.3)  // A5
  },

  // Approve / next step — uplifting
  approve: () => {
    tone(523.3, 0.14, 0.4, 0,    'sine', 0.01, 0.05, 0.6, 0.3)  // C5
    tone(659.3, 0.16, 0.5, 0.1,  'sine', 0.01, 0.05, 0.6, 0.35) // E5
    tone(784.0, 0.18, 0.6, 0.22, 'sine', 0.01, 0.05, 0.6, 0.4)  // G5
  },
}
