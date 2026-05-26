# Runner Protocol Reference

Detailed reference for grok-implement's multi-round protocol. Read on-demand for command details, file conventions, polling, and state machine.

## Architecture

```
┌──────────────────┐  commands.   ┌─────────────────┐  stdin  ┌──────────────────┐
│  Runner          │──jsonl──────▶│  Broker (Node)  │────────▶│ grok agent stdio │
│  (subcommands)   │              │  long-running   │ stdout  │  (ACP server)    │
│  short-lived     │◀─output.─────│  detached       │◀────────│                  │
│                  │   jsonl      │                 │         │                  │
└──────────────────┘              └─────────────────┘         └──────────────────┘
        ▲
        │ Claude reads/writes
        ▼
┌─────────────────────────────────────────────────────┐
│ MD files in session dir (spec, acceptance,           │
│ dont-break, issues, verification, outputs)          │
└─────────────────────────────────────────────────────┘
```

- **Broker** does ACP handshake once, stays alive across rounds (in-memory ACP session preserved)
- **Runner** subcommands are short-lived, file-based IPC with broker
- **Claude orchestrator** reads/writes MD files in session dir between rounds

## Session Directory Structure

```
<workdir>/.grok-implement/sessions/<session-id>/
│
│  ─── Claude-managed MD files (Claude writes/reads) ───
├── spec.md                    # IMMUTABLE after start. Contract for the task.
├── acceptance.md              # Per-round AC status (Claude appends)
├── dont-break.md              # Cumulative invariants (Claude appends)
├── issues/
│   └── round-N-issues.md      # Issues found by Claude after round N (input to round N+1 revise)
├── verification/
│   └── round-N.md             # Claude's verification log for round N
├── outputs/
│   └── round-N.md             # Grok's final reply for round N (saved from poll output)
│
│  ─── Runner-managed (do NOT edit) ───
├── state.json                 # session_id, round, broker_pid, max_rounds, etc.
├── rounds.json                # Round history with statuses + stop_reasons
├── prompts/                   # Per-round prompts sent to Grok (debug)
│   ├── round-001.txt
│   └── round-002.txt
├── prompt.txt                 # Most recent prompt
├── commands.jsonl             # Runner → broker IPC (append-only)
├── commands.cursor            # Broker's read position
├── output.jsonl               # Broker → runner ACP events (append-only)
├── output.md                  # Last completed round's agent message
├── broker.log                 # Broker debug log
├── broker.stdout.log          # Broker stdout
├── broker.stderr.log          # Broker stderr (grok stderr forwarded)
├── final.txt                  # Cached terminal poll result for current round
└── meta.json                  # Session summary (after finalize)
```

## State Machine

```
                ┌─────────┐
                │  init   │ creates session dir, scaffolds spec.md, AC=0
                └────┬────┘
                     │
                     │ Claude edits spec.md (must have ≥1 AC + required sections)
                     ▼
                ┌─────────┐
                │  start  │ validates spec, spawns broker, sends round 1 prompt
                └────┬────┘
                     │
                     ▼
              ┌──────────────┐
              │     poll     │◀──────────────┐
              └──────┬───────┘               │
                     │                       │
              completed/failed/timeout       │
                     │                       │
                     ▼                       │
            ┌─────────────────┐              │
            │ Claude verifies │              │
            │ updates MD files│              │
            └────────┬────────┘              │
                     │                       │
        ┌────────────┼────────────┐          │
        │            │            │          │
   ALL_AC_PASS  REVISE/CLARIFY  STALEMATE    │
        │       (round<10)            │      │
        │            │            │          │
        │            ▼            ▼          │
        │      ┌─────────┐  ┌──────────┐    │
        │      │ resume  │  │ resume   │    │
        │      │ (revise │  │ (recon-  │────┘
        │      │ /clarify)│  │ cile)    │
        │      └─────────┘  └──────────┘
        │
        ▼
   ┌──────────┐
   │ finalize │
   │ + stop   │
   └──────────┘
```

## Subcommands

| Cmd | Purpose | Input | Output |
|---|---|---|---|
| `version` | Print runner version | — | `grok-runner v2 (ACP)` |
| `init --skill-name X --working-dir D` | Create session dir | — | `GROK_SESSION:<dir>` |
| `info <dir>` | Status of one session (spec summary, AC, paths) | — | JSON |
| `list --working-dir D` | All sessions in workspace | — | JSON array |
| `start <dir> --timeout T` | Validate spec, spawn broker, send round 1 | prompt on stdin | JSON `{status:"started",round:1,...}` |
| `resume <dir> --timeout T` | Send next round prompt to existing broker | prompt on stdin | JSON `{status:"started",round:N,...}` |
| `poll <dir> [--min-interval N]` | Read latest events, return current status. Long-polls up to N seconds (default 120) if no new output since last poll. | — | JSON `{status,round,output,activities,...}` |
| `stop <dir>` | Send stop to broker, kill if hung | — | JSON `{status:"stopped"}` |
| `finalize <dir>` | Write meta.json | — | JSON summary |
| `render --skill X --template T --skills-dir D` | Substitute placeholders in prompt template | JSON on stdin | rendered text |
| `status <dir>` | Liveness + round info | — | JSON |
| `cancel <dir>` | Request cooperative cancel of in-flight round (10s grace + kill fallback; emits round.cancelled) | — | JSON |
| `_broker <dir>` | (internal) long-running broker | — | logs to broker.log |

## Stdin Format Rules

- **JSON** for `render` / `info`: heredoc with json_esc helper for embedding dynamic vars
  ```bash
  PROMPT=$(node "$RUNNER" render --skill grok-implement --template implement --skills-dir "$SKILLS_DIR" <<RENDER_EOF
  {"TASK":$(json_esc "$TASK"),"CONTEXT":$(json_esc "$CTX"),...}
  RENDER_EOF
  )
  ```
- **Plain text** for `start` / `resume`:
  ```bash
  printf '%s' "$PROMPT" | node "$RUNNER" start "$SESSION_DIR" --timeout 1200
  ```
- NEVER use `echo '...'` for JSON — quoting is fragile.
- json_esc returns `"<escaped>"` (with surrounding quotes), embed directly: `{"K":$(json_esc "$V")}`.
- Forbidden: NULL bytes (`\x00`).

## Spec Validation

`start` rejects spec.md that fails `validateSpec`:
- All required sections present and non-empty: TASK, CONTEXT, SCOPE, REQUIREMENTS, CONSTRAINTS, ACCEPTANCE_CRITERIA, VERIFICATION_COMMANDS
- ACCEPTANCE_CRITERIA contains ≥1 bullet matching `AC-N: ...` (case-insensitive, hyphen optional)

If validation fails: `{"error":"...","code":"SPEC_INCOMPLETE"}`. Edit spec.md and retry start.

## Poll Result Statuses

| Status | Meaning | Action |
|---|---|---|
| `starting` | Broker spawned, ACP handshake in progress | Wait, re-poll |
| `running` | Broker ready, Grok working | Wait, report `activities` |
| `completed` | Round done — `output` and `stop_reason` populated | Save output, verify |
| `failed` | Round failed (Grok error or broker crash) | Inspect `error`; retry once or report |
| `timeout` | Exceeded time limit | Save partial output, report or revise |
| `stalled` | No new output for ~3 min (12 polls × ~15s) | If `recoverable`: stop+restart session. Else: report partial |

**Recommended poll intervals:**

| Round phase | Poll cadence |
|---|---|
| First 30s | Every 5–10s |
| 30s–2min | Every 15–30s |
| > 2min | Every 30–60s |

**Long-polling (`--min-interval`):**

The `poll` command supports built-in long-polling via `--min-interval N` (seconds, default 120). When set:

- If fewer than N seconds have elapsed since the last poll response, the runner **blocks** (up to N seconds) instead of returning immediately.
- The runner breaks out early if: (a) new output lines appear in `output.jsonl`, (b) `final.txt` is written (round completed/failed), or (c) the broker process dies.
- First poll of a session always returns immediately (no prior `last_poll_responded_at`).
- Terminal results (`final.txt` cached) always return immediately regardless of interval.

This eliminates wasteful rapid polling. Consumer calls `poll --min-interval 120` in a loop — each call blocks up to 2 minutes or until there's something new to report.

Example:
```bash
# Consumer loop — one call every ≤120s, returns early on new output
while true; do
  POLL_JSON=$(node "$RUNNER" poll "$SESSION_DIR" --min-interval 120)
  STATUS=$(echo "$POLL_JSON" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).status')
  # report activities...
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "timeout" ]; then break; fi
done
```

## Activities Reporting

`poll` returns `activities` array with NEW events since last poll:

| type | detail | When |
|---|---|---|
| `thinking` | text chunk (truncated to 150 chars) | Grok is reasoning (`agent_thought_chunk`) |
| `tool_started` | tool name | Grok invoked a tool (`tool_call`) |
| `tool_completed` | tool name | Tool finished (`tool_call_update` with status=completed) |

Report these to user as flavor text during long polls.

## Output Event Types (in `output.jsonl`)

| Type | Meaning |
|---|---|
| `broker.ready` | Broker finished ACP handshake; includes `acp_session_id` |
| `broker.fatal` | Fatal error before/during handshake |
| `broker.exited` | Broker shutting down cleanly |
| `broker.grok_exited` | grok subprocess died unexpectedly |
| `round.started` | session/prompt sent for round N |
| `round.completed` | session/prompt resolved with `stop_reason` |
| `round.failed` | session/prompt rejected with error |
| `acp.<sessionUpdate>` | Pass-through of grok's session/update events |

Common `acp.*` subtypes:
- `acp.agent_message_chunk` — assistant text (this builds the final reply)
- `acp.agent_thought_chunk` — chain-of-thought
- `acp.tool_call` — tool invocation
- `acp.tool_call_update` — tool status change
- `acp.plan` — Grok's internal plan steps
- `acp.available_commands_update` — slash-command list

## Error Handling

### `failed`
1. First occurrence: wait 15s, re-poll once.
2. Persistent: run `finalize` + `stop`. Inspect `error` field. If transient (e.g. 403 from upstream API), can re-init same spec.

### `timeout`
1. `output` field may have partial response — save to outputs/round-N.md.
2. Run `finalize` + `stop`. Report partial. Suggest splitting task or extending timeout.

### `stalled`
1. Check `recoverable` field.
2. Recoverable: `stop` → `init` new session → re-`start` (lose ACP context). Or accept partial.
3. Not recoverable: `finalize` + `stop`. Report partial.

### `MAX_ROUNDS_REACHED`
- `resume` returns this when round=10 attempted again. Cannot proceed.
- Action: finalize, escalate to user, suggest splitting remaining work into a new session.

### `BROKER_DEAD`
- Broker process gone (crashed or killed). ACP session lost.
- Cannot resume. Init a new session, copy spec.md from old session if continuing.

### `SPEC_INCOMPLETE`
- spec.md missing required sections or AC. Returned by `start`.
- Edit spec.md per validation error message and retry start.

## Permission & Tool Auto-Approval

The broker handles all server-initiated ACP requests automatically:

| Method | Behavior |
|---|---|
| `session/request_permission` | Selects `allow_always` or `allow_once` |
| `fs/read_text_file` | Reads via Node fs |
| `fs/write_text_file` | Writes via Node fs (creates parent dirs) |
| `terminal/create` | Spawns child process (shell mode if no args) |
| `terminal/output` | Returns captured stdout+stderr |
| `terminal/wait_for_exit` | Awaits exit |
| `terminal/kill` | killTree |
| `terminal/release` | Cleanup |

**Implication:** Grok has full file/shell access in the working directory. Only run grok-implement in trusted working dirs.

## Loop Control & Stalemate Detection

- `state.max_rounds = 10` (set at init, configurable in state.json before start if needed)
- `cmdResume` returns `MAX_ROUNDS_REACHED` if `state.round >= max_rounds`
- **Claude is responsible for stalemate detection**: if `acceptance.md` shows the same AC failing in round N and N-1 with the same root cause → trigger reconcile (analysis round) instead of another revise
- After reconcile, Claude decides: another revise with new approach, or finalize partial + escalate

## Re-discovery via `info`

If you lose context about an active session:

```bash
node "$RUNNER" info "$SESSION_DIR"
```

Returns JSON with:
- spec summary (TASK, SCOPE, AC count)
- current round + max_rounds
- AC totals (passed/partial/failed/pending in latest round)
- broker liveness
- absolute paths to all MD files for direct reading

Then read `spec.md`, `acceptance.md`, latest `verification/round-N.md` to re-orient.

## Parallel Sessions in Same Workspace

`init` uses date+counter session IDs to avoid collision: `<skill>-YYYYMMDD-NNN`. Counter increments atomically via mkdir-fail-retry.

Each session has its own broker process. Use `list` to see all:
```bash
node "$RUNNER" list --working-dir "$PWD"
```

Returns array of all sessions with task summary and AC status — useful for resuming/aggregating across parallel sub-tasks.

## Cancel semantics

The `cancel <dir>` subcommand (and auto-cancel on poll timeout/stalled) appends `{action:"cancel", round:N}` to commands.jsonl.

Broker handling:
- Sends ACP `session/cancel` notification (no `id`) for the current acp_session_id if an in-flight `session/prompt` RPC is tracked (`currentPromptRpcId`).
- Waits up to `CANCEL_GRACE_MS=10000` (10s) for the in-flight request to settle (response or error clears the tracker).
- On success within grace: emits `round.cancelled` with `mode:"cooperative"`.
- On grace expiry: kills the grok tree (fallback), emits `round.cancelled` with `mode:"respawn"`, clears busy.
- During recovery, `cmdResume` returns `BROKER_RECOVERING`; after hard cancel the broker may appear dead on next poll (client should init fresh session if needed).

Error codes during busy/recovery:
- `BROKER_BUSY`: another round is being processed (from `broker.state.json`).
- `BROKER_RECOVERING`: broker is in post-cancel grok respawn window.

## Idle TTL

Broker reads `idle_ttl_ms` from session `state.json` at startup (default: 30 minutes = `1800000`).

`lastActivityAt` is updated on:
- Every command received (prompt/start/resume/cancel/stop)
- `round.started`, `round.completed`, `round.failed`, `round.cancelled` events

If `Date.now() - lastActivityAt > idleTtlMs` in the command loop, broker calls `shutdownBroker("idle TTL expired (Nm)")` and exits with `broker.exited` event. Prevents orphan brokers on long-idle sessions.

Override per-session: edit `state.json` before `start` / `resume` and set `"idle_ttl_ms": 300000` (5 min) etc.

## Strict shell mode

In `terminal/create` (inside grok agent stdio), shell mode is no longer the default for argv-less commands.

Decision (in priority):
1. `args` provided → `shell:false` (argv array passed literally).
2. No metachars (`[;&|`$<>]`) and command has spaces → split on whitespace → `shell:false`.
3. No metachars, no spaces → `shell:false` with command as argv[0].
4. Metachars present → `shell:true`, log `SHELL MODE: <cmd>`.

If `GROK_RUNNER_STRICT_SHELL=1` in broker env and metachars would require shell: broker responds with JSON-RPC error code `-32000`, message `"STRICT_SHELL: shell mode rejected for: <command>"`. No process is spawned. Use to harden against command injection in untrusted specs.

## Render escaping

`cmdRender` escapes any ` ``` ` (triple backtick) inside placeholder values by replacing with `ʼʼʼ` (modifier letter apostrophe ×3, visually distinct but readable). A warning is printed to stderr when escaping occurs. This prevents the rendered prompt from accidentally closing the outer template fence when the value itself contains markdown code blocks (especially relevant for Reconcile Prompt which documents OUTPUT_FORMAT inside its template).

See also `extractTemplateSection` (strict fence parser that does not toggle on inner fences).
