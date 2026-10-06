// Synthesizes sounds/handshake.wav: a V.34/V.90-era dial-up handshake as a
// modem's speaker played it, from going off hook to the speaker muting on
// connect. The noise is seeded, so every run writes the same bytes:
//   bun scripts/synth.ts
import { mkdirSync, writeFileSync } from 'node:fs'

const RATE = 11025
const LENGTH = 22.8
const TAU = 2 * Math.PI

type Voice = (t: number) => number
type Point = readonly [number, number]

const mix = new Float64Array(Math.ceil(LENGTH * RATE))

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Adds `voice` to the mix from `start` for `length` seconds, faded in and out
// so segments butt together without clicks.
function place(start: number, length: number, gain: number, voice: Voice, fadeIn = 0.006, fadeOut = fadeIn) {
  const first = Math.round(start * RATE)
  const count = Math.round(length * RATE)
  const rise = Math.max(1, Math.round(fadeIn * RATE))
  const fall = Math.max(1, Math.round(fadeOut * RATE))
  for (let n = 0; n < count && first + n < mix.length; n++) {
    const edge = Math.min(1, n / rise, (count - 1 - n) / fall)
    mix[first + n]! += gain * (0.5 - 0.5 * Math.cos(Math.PI * edge)) * voice(n / RATE)
  }
}

const tones =
  (...hz: number[]): Voice =>
  t =>
    hz.reduce((sum, f) => sum + Math.sin(TAU * f * t), 0) / hz.length

// A tone whose phase flips every `every` seconds, as V.34's tones A and B do.
const reversing =
  (hz: number, every: number): Voice =>
  t =>
    Math.sin(TAU * hz * t + Math.PI * (Math.floor(t / every) % 2))

// V.8's answer tone (ANSam): 2100 Hz, 15 Hz amplitude wobble, phase flipped
// every 450 ms (the clicks in the long beep).
const answerTone: Voice = t => ((1 + 0.2 * Math.sin(TAU * 15 * t)) / 1.2) * reversing(2100, 0.45)(t)

// A relay clunk: going off hook, or the far end picking up.
function clunk(random: () => number): Voice {
  return t => Math.exp(-t * 350) * (0.6 * Math.sin(TAU * 520 * t) + 0.4 * (random() * 2 - 1))
}

const DTMF: Record<string, [number, number]> = {
  '0': [941, 1336],
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
}

// Octets as an async line sends them: a start bit, eight bits LSB first, a stop bit.
function framed(octets: readonly number[]): number[] {
  return octets.flatMap(octet => [0, ...Array.from({ length: 8 }, (_, b) => (octet >> b) & 1), 1])
}

// A V.8 menu: ten ones, then its octets, sent over and over for `seconds`.
function menu(octets: readonly number[], seconds: number): number[] {
  const once = [...Array<number>(10).fill(1), ...framed(octets)]
  const bits: number[] = []
  while (bits.length < seconds * 300) bits.push(...once)
  return bits
}

// V.21 FSK, 300 baud, continuous phase: `mark` Hz for a 1, `space` for a 0.
function fsk(bits: readonly number[], mark: number, space: number): Voice {
  const hz = bits.map(bit => (bit === 1 ? mark : space))
  const phase = [0]
  for (const f of hz) phase.push(phase[phase.length - 1]! + (TAU * f) / 300)
  return t => {
    const k = Math.min(hz.length - 1, Math.floor(t * 300))
    return Math.sin(phase[k]! + TAU * hz[k]! * (t - k / 300))
  }
}

// V.34's INFO sequences: 600 bit/s DPSK, a 1 a half turn of the carrier.
function dpsk(count: number, carrier: number, random: () => number): Voice {
  const phase = [0]
  for (let k = 0; k < count; k++) phase.push(phase[k]! + (random() < 0.5 ? Math.PI : 0))
  return t => Math.sin(TAU * carrier * t + phase[Math.min(count, Math.floor(t * 600))]!)
}

// V.34's line probe (L1, L2), the "bong": a tone every 150 Hz from 150 to
// 3750 but 900, 1200, 1800 and 2400, each at phase 0 or a half turn.
function probe(random: () => number): Voice {
  const parts: { hz: number; phase: number }[] = []
  for (let hz = 150; hz <= 3750; hz += 150) {
    if (![900, 1200, 1800, 2400].includes(hz)) parts.push({ hz, phase: random() < 0.5 ? 0 : Math.PI })
  }
  return t => parts.reduce((sum, p) => sum + Math.cos(TAU * p.hz * t + p.phase), 0) / Math.sqrt(parts.length) / 2
}

function raisedCosine(x: number): number {
  const BETA = 0.25
  if (Math.abs(x) < 1e-9) return 1
  const d = 1 - (2 * BETA * x) ** 2
  if (Math.abs(d) < 1e-9) return 0
  return ((Math.sin(Math.PI * x) / (Math.PI * x)) * Math.cos(Math.PI * BETA * x)) / d
}

// Square 16-QAM at `baud` on a `carrier`, raised-cosine shaped; `points(k)`
// picks the k-th symbol.
function qam(seconds: number, baud: number, carrier: number, points: (k: number) => Point): Voice {
  const symbols = Array.from({ length: Math.ceil(seconds * baud) + 8 }, (_, k) => points(k))
  return t => {
    const u = t * baud
    let x = 0
    let y = 0
    for (let k = Math.floor(u) - 4; k <= Math.floor(u) + 4; k++) {
      const symbol = symbols[k]
      if (symbol === undefined) continue
      const h = raisedCosine(u - k)
      x += symbol[0] * h
      y += symbol[1] * h
    }
    return (x * Math.cos(TAU * carrier * t) - y * Math.sin(TAU * carrier * t)) / 1.4
  }
}

const LEVELS = [-1, -1 / 3, 1 / 3, 1]

// Scrambled symbols, as training and data send: the hiss.
const scrambled = (random: () => number) => (): Point => [
  LEVELS[Math.floor(random() * 4)]!,
  LEVELS[Math.floor(random() * 4)]!,
]

// The same `period` symbols over and over: a buzz.
function periodic(random: () => number, period: number): (k: number) => Point {
  const cycle = Array.from({ length: period }, scrambled(random))
  return k => cycle[k % period]!
}

// V.34's S (and S-bar, sign -1): two points in turn, a two-tone whistle.
const alternating =
  (sign: number) =>
  (k: number): Point => [k % 2 === 0 ? sign : -sign, 0]

function biquad(signal: Float64Array, kind: 'lowpass' | 'highpass', hz: number) {
  const w = (TAU * hz) / RATE
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const b0 = kind === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2
  const b1 = kind === 'lowpass' ? 1 - cos : -(1 + cos)
  const a0 = 1 + alpha
  let [x1, x2, y1, y2] = [0, 0, 0, 0]
  for (let n = 0; n < signal.length; n++) {
    const x0 = signal[n]!
    const y0 = (b0 * x0 + b1 * x1 + b0 * x2 + 2 * cos * y1 - (1 - alpha) * y2) / a0
    ;[x2, x1, y2, y1] = [x1, x0, y1, y0]
    signal[n] = y0
  }
}

function wav(samples: Float64Array): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((s, n) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), n * 2))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

// The line's own hiss, under everything.
const hiss = seeded(1)
place(0, LENGTH, 0.012, () => hiss() * 2 - 1, 0.05)

// Off hook: dial tone, then the number.
place(0.15, 0.06, 0.5, clunk(seeded(2)))
place(0.3, 1.2, 0.36, tones(350, 440))
;[...'8675309'].forEach((digit, k) => place(1.6 + k * 0.16, 0.08, 0.36, tones(...DTMF[digit]!)))

// One ring, and the far end picks up.
place(2.85, 0.05, 0.25, clunk(seeded(3)))
place(3.3, 1.6, 0.28, tones(440, 480))
place(5.3, 0.06, 0.4, clunk(seeded(4)))

// V.8: the answer tone, the caller's menu over it, the answerer's reply.
const MENU = [0xe0, 0xc1, 0x05, 0x10, 0x94]
place(5.4, 2.55, 0.42, answerTone)
place(6.6, 1.8, 0.34, fsk(menu(MENU, 1.8), 980, 1180))
place(7.75, 0.7, 0.3, fsk(menu([...MENU, 0x2a], 0.7), 1650, 1850))
place(8.4, 0.1, 0.34, fsk(framed([0, 0, 0]), 980, 1180))

// V.34 phase 2: tones A and B (the "ding-dong"), INFO0, the line probe, INFO1.
const info = seeded(5)
const lineProbe = probe(seeded(6))
place(8.7, 0.6, 0.34, reversing(2400, 0.4))
place(8.85, 0.6, 0.34, reversing(1200, 0.45))
place(9.3, 0.2, 0.28, dpsk(120, 2400, info))
place(9.45, 0.2, 0.28, dpsk(120, 1200, info))
place(9.7, 0.16, 0.44, lineProbe)
place(9.86, 0.84, 0.3, lineProbe)
place(10.72, 0.4, 0.32, reversing(1200, 0.3))
place(10.78, 0.34, 0.3, reversing(2400, 0.25))
place(11.12, 0.3, 0.28, dpsk(180, 2400, info))
place(11.16, 0.3, 0.28, dpsk(180, 1200, info))

// Phase 3: each side trains the other's equalizer with S and S-bar, a
// periodic sequence, then scrambled ones.
const answerer = seeded(7)
place(11.5, 0.4, 0.36, qam(0.4, 2400, 1800, alternating(1)))
place(11.9, 0.1, 0.36, qam(0.1, 2400, 1800, alternating(-1)))
place(12.0, 0.45, 0.42, qam(0.45, 2400, 1800, periodic(answerer, 12)))
place(12.45, 1.0, 0.45, qam(1.0, 2400, 1800, scrambled(answerer)))
const caller = seeded(8)
place(13.25, 0.4, 0.38, qam(0.4, 2743, 1829, alternating(1)))
place(13.65, 0.1, 0.38, qam(0.1, 2743, 1829, alternating(-1)))
place(13.75, 0.35, 0.44, qam(0.35, 2743, 1829, periodic(caller, 16)))
place(14.1, 1.2, 0.48, qam(1.2, 2743, 1829, scrambled(caller)))

// Phase 4 and data: both ways at once, the answerer stepping its rate down
// partway; then the speaker mutes on connect.
place(15.3, 6.4, 0.42, qam(6.4, 3200, 1920, scrambled(seeded(9))), 0.02, 0.35)
place(15.3, 3.0, 0.34, qam(3.0, 3429, 1959, scrambled(seeded(10))), 0.02)
place(18.3, 3.4, 0.34, qam(3.4, 3000, 2000, scrambled(seeded(11))), 0.02, 0.35)

// The phone line passes 300-3400 Hz; then level it and round off the peaks.
biquad(mix, 'highpass', 300)
biquad(mix, 'highpass', 300)
biquad(mix, 'lowpass', 3400)
biquad(mix, 'lowpass', 3400)
const peak = mix.reduce((most, s) => Math.max(most, Math.abs(s)), 0)
for (let n = 0; n < mix.length; n++) mix[n] = (0.7 * Math.tanh((1.4 * mix[n]!) / peak)) / Math.tanh(1.4)

const target = new URL('../sounds/handshake.wav', import.meta.url)
mkdirSync(new URL('.', target), { recursive: true })
writeFileSync(target, wav(mix))
console.log(`wrote ${target.pathname}: ${LENGTH}s at ${RATE} Hz`)
