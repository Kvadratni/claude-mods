import type { CommandSpec, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

type Dial = { asset: string | undefined; shouldLoop: boolean; gain: number | undefined; signal: AbortSignal }

const ANSWERED = { answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' } as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

// Stands in for the engine beneath the mod: each clip "plays" until the mod
// hangs up on it.
function exchange(on: On) {
  const dials: Dial[] = []
  const commands: CommandSpec[] = []
  mock.store(on)
  on('audio.play', async (_$, e, next) => {
    dials.push({ asset: e.clip.asset, shouldLoop: e.shouldLoop, gain: e.gain, signal: next.signal })
    await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    commands.push(e)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return { dials, commands }
}

test('dials up when a turn starts and hangs up when it ends', async ($, on) => {
  const { dials } = exchange(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(dials).toHaveLength(1)
  expect(dials[0]).toMatchObject({ asset: 'sounds/handshake.wav', shouldLoop: true, gain: 0.6 })
  expect(dials[0]?.signal.aborted).toBe(false)

  await $.turn.complete({ ...ANSWERED, turnId: 't1' })
  expect(dials[0]?.signal.aborted).toBe(true)
})

test('an interrupted turn hangs up too', async ($, on) => {
  const { dials } = exchange(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ ...ANSWERED, isAborted: true, reason: 'aborted', turnId: 't1' })
  expect(dials[0]?.signal.aborted).toBe(true)
})

test("a subagent's turn ending keeps the line up", async ($, on) => {
  const { dials } = exchange(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ ...ANSWERED, turnId: 'sub', agentId: 'agent-1' })
  expect(dials[0]?.signal.aborted).toBe(false)

  await $.turn.complete({ ...ANSWERED, turnId: 't1' })
  expect(dials[0]?.signal.aborted).toBe(true)
})

test('/modem off hangs up mid-turn and stays quiet; /modem dials back in', async ($, on) => {
  const { dials, commands } = exchange(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(commands).toMatchObject([{ name: 'modem', immediate: true }])

  await $.turn.start({ text: 'hi', turnId: 't1' })
  const off = await $.command.run({ ...TYPED, command: 'modem', args: 'off' })
  expect(off.text).toBe('Modem off.')
  expect(dials[0]?.signal.aborted).toBe(true)
  await $.turn.complete({ ...ANSWERED, turnId: 't1' })

  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(dials).toHaveLength(1)

  const toggled = await $.command.run({ ...TYPED, command: 'modem', args: '' })
  expect(toggled.text).toBe('Modem on: Claude dials up while it works.')
  expect(dials).toHaveLength(2)
  expect(dials[1]?.signal.aborted).toBe(false)
})

test('/modem on while idle waits for the next turn', async ($, on) => {
  const { dials } = exchange(on)

  await $.command.run({ ...TYPED, command: 'modem', args: 'on' })
  expect(dials).toHaveLength(0)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(dials).toHaveLength(1)
})

test('the volume option is the gain', { options: { volume: 1.5 } }, async ($, on) => {
  const { dials } = exchange(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(dials[0]?.gain).toBe(1.5)
})

test('volume 0 never dials', { options: { volume: 0 } }, async ($, on) => {
  const { dials } = exchange(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(dials).toHaveLength(0)
})
