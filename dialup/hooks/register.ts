import type { EngineInterface, Register } from 'claude-code'

const HANDSHAKE = 'sounds/handshake.wav'
const MUTED = 'isMuted'

let gain = 0.6
let isWorking = false
let line: AbortController | undefined
let hasFailed = false

async function dial($: EngineInterface) {
  const isMuted = gain === 0 || (await $.store.get(MUTED)) === true
  if (isMuted || !isWorking || line !== undefined) return
  const call = new AbortController()
  line = call
  $.audio
    .play({ asset: HANDSHAKE }, { shouldLoop: true, gain, signal: call.signal })
    .catch((error: unknown) => {
      if (!hasFailed) $.ui.log(`dialup: no carrier, the handshake did not play (${String(error)})`)
      hasFailed = true
    })
    .finally(() => {
      if (line === call) line = undefined
    })
}

function hangUp() {
  line?.abort()
  line = undefined
}

// The modem dials up when Claude starts a turn, redials for as long as it
// works, and hangs up when the main loop's turn ends (answered, interrupted
// or failed). `/modem` mutes it, across sessions.
export const register: Register = (on, options) => {
  const volume = Number(options.volume)
  gain = Number.isFinite(volume) ? Math.min(4, Math.max(0, volume)) : 0.6

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'modem',
      description: 'Turn the dial-up modem sound on or off',
      argumentHint: '[on|off]',
      immediate: true,
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    await dial($)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      isWorking = false
      hangUp()
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    isWorking = false
    hangUp()
    return next(e)
  })

  on('command.run', { command: 'modem' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    const isMuted = word === 'off' || (word !== 'on' && (await $.store.get(MUTED)) !== true)
    await $.store.set(MUTED, isMuted)
    if (isMuted) hangUp()
    else await dial($)
    return { text: isMuted ? 'Modem off.' : 'Modem on: Claude dials up while it works.' }
  })
}
