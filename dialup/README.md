# dialup

A Claude Code mod that plays an old-school dial-up modem handshake while Claude is thinking or working, and hangs up when the turn ends.

- `/modem` turns it on or off (`/modem on`, `/modem off`); the choice sticks across sessions.
- The `volume` option goes from 0 (silent) to 4; the default is 0.6.

Needs macOS (it plays through `afplay`) and Claude Code 2.1.287+ in the terminal, or 2.1.286+ in the desktop app's Code tab.

## Install

- Every session: unzip into `~/.claude/skills/`, so you have `~/.claude/skills/dialup/.claude-plugin/plugin.json`, then start a new session.
- One session: `claude --plugin-dir dialup.zip`

## Change the sound

The handshake is synthesized, not recorded. Edit `scripts/synth.ts`, then run `bun scripts/synth.ts` to rewrite `sounds/handshake.wav`.
