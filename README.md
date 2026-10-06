# claude-mods

Claude Code mods.

## dialup

Plays an old-school dial-up modem handshake while Claude is thinking or working, and hangs up when the turn ends. `/modem` turns it on or off.

Needs macOS (it plays through `afplay`) and Claude Code 2.1.287+ in the terminal, or 2.1.286+ in the desktop app's Code tab.

```bash
claude plugin marketplace add https://github.com/Kvadratni/claude-mods.git
claude plugin install dialup@kvadratni-mods
```

Change the sound in `dialup/scripts/synth.ts`, then regenerate it with `bun dialup/scripts/synth.ts`.
