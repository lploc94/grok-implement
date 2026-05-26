<h1 align="center"><b>Grok Implement Skill</b></h1>

Single-command installer for the **grok-implement** skill for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Delegates implementation tasks to [Grok Build CLI](https://docs.x.ai/build/cli/) via ACP, with a structured spec, acceptance-criteria tracking, and a verify→revise loop (up to 10 rounds).

**Claude orchestrates and verifies. Grok implements.**

## Requirements

- Node.js >= 20
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Grok Build CLI](https://docs.x.ai/build/overview) (`grok`) in PATH, authenticated (`grok login` once or set `XAI_API_KEY`)

## Install

```bash
npx github:lploc94/grok-implement
```

### What it does
1. Installs the skill into `~/.claude/skills/grok-implement/`
2. Copies `grok-runner.js` into the skill's `scripts/` directory
3. Injects the absolute runner path into `SKILL.md`
4. Validates templates and references before finalizing
5. Atomic swap with rollback on failure (idempotent — safe to re-run)

### Verify
```bash
node ~/.claude/skills/grok-implement/scripts/grok-runner.js version
```

### Reinstall / Update
```bash
npx github:lploc94/grok-implement
```

### Auto-delegation guidance (optional)
```bash
npx github:lploc94/grok-implement --auto
```
Injects delegation guidance into `~/.claude/CLAUDE.md` so Claude Code proactively considers delegating implementation work to `/grok-implement`. Idempotent — safe to re-run.

## Usage

After install, start Claude Code and run `/grok-implement` to begin a delegated implementation session.

## How It Works

1. **Claude builds the spec** — TASK, CONTEXT, SCOPE, REQUIREMENTS, CONSTRAINTS, ACCEPTANCE_CRITERIA (≥1, mandatory), VERIFICATION_COMMANDS.
2. **Claude calls the runner** — `init` → `start` (with rendered prompt) — which spawns a long-running broker that runs `grok agent stdio` (ACP).
3. **Grok implements** — uses its tools (file edit, terminal, etc) to satisfy the spec, then reports in a strict OUTPUT_FORMAT (STATUS, CHANGES, ACCEPTANCE_STATUS, VERIFICATION_RESULTS, RISKS, OPEN_QUESTIONS).
4. **Claude verifies independently** — re-runs VERIFICATION_COMMANDS, reads modified files, confirms each AC. Updates `acceptance.md` and `dont-break.md`.
5. **Loop** — if any AC failed: write `issues/round-N-issues.md`, render `revise` template, `resume` (same broker, same ACP session). If Grok asked questions: render `clarify` template. If stuck for 2 rounds: render `reconcile`. Up to 10 rounds.
6. **Finalize** — `finalize` writes `meta.json`, `stop` ends the broker.

## Architecture

```
Claude (orchestrator + verifier)
        │
        │ writes spec.md, reads outputs
        ▼
┌───────────────────────────┐  spawns  ┌─────────────────┐  ACP   ┌──────────────┐
│  grok-runner subcommands  │─────────▶│  Broker process │───────▶│ grok agent   │
│  (init/start/poll/etc)    │ commands │ (long-running)  │ stdio  │ stdio (ACP)  │
└───────────────────────────┘  jsonl   └─────────────────┘        └──────────────┘
                              output.jsonl
```

The **broker** stays alive across multiple rounds, so the ACP session context is preserved without re-handshaking.

## Project Structure

```
grok-implement/
├── bin/
│   └── grok-implement.js              # Installer CLI
├── skill-packs/
│   └── grok-implement/
│       ├── manifest.json
│       ├── scripts/
│       │   └── grok-runner.js         # Runner with broker + ACP handshake
│       └── skills/
│           └── grok-implement/
│               ├── SKILL.md           # Workflow for Claude (with placeholders)
│               └── references/
│                   ├── prompts.md     # 4 templates: implement/revise/clarify/reconcile
│                   ├── output-format.md
│                   └── protocol.md
└── package.json
```

## Subcommands (runner)

| Cmd | Purpose |
|---|---|
| `version` | Print runner version |
| `init` | Create session dir with spec.md / acceptance.md / dont-break.md scaffolding |
| `info <dir>` | Full session status: spec validity, AC counts, file paths |
| `list --working-dir D` | All sessions in workspace |
| `start <dir>` | Validate spec, spawn broker, send round 1 prompt |
| `resume <dir>` | Send next-round prompt to existing broker |
| `poll <dir>` | Read latest events, return current status |
| `stop <dir>` | Stop broker (graceful + force-kill fallback) |
| `finalize <dir>` | Write meta.json summary |
| `render` | Substitute placeholders in prompt template |
| `status <dir>` | Liveness + round info |

## Documentation

After install, see:

- `~/.claude/skills/grok-implement/SKILL.md` — Workflow Claude follows
- `~/.claude/skills/grok-implement/references/prompts.md` — 4 prompt templates
- `~/.claude/skills/grok-implement/references/output-format.md` — Strict output schema
- `~/.claude/skills/grok-implement/references/protocol.md` — File conventions, state machine, error handling

## License

MIT
