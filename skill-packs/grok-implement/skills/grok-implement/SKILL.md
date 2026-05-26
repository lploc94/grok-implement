---
name: grok-implement
description: Delegate implementation tasks to Grok via ACP with structured spec, acceptance criteria tracking, and a verify→revise loop (up to 10 rounds). Claude orchestrates: builds spec, runs verification, decides next round.
---

# Grok Implement

## Purpose
Delegate code implementation to Grok Build CLI (ACP mode), governed by a strict multi-round protocol: Claude builds a structured spec with acceptance criteria, Grok implements, Claude independently verifies, then loops with revisions until ACs pass or stalemate.

## When to Use
- Discrete implementation tasks with clear, testable acceptance criteria
- Sub-tasks within a larger plan (use PARENT_PLAN to give Grok context)
- Multiple parallel sub-tasks (spawn one session per task; Claude polls all)

## When NOT to Use
- Open-ended exploration ("figure out how to do X") — first plan, then split into AC-bearing tasks
- Tasks where you cannot define ≥1 testable AC — the runner will reject `start`
- Trivial 1-line edits — overhead not worth it; just do it directly

## Prerequisites
- **Grok Build CLI** in PATH, authenticated (`grok login` or `XAI_API_KEY`)
- Node.js >= 20

## Architecture
- **Broker** (long-running): owns `grok agent stdio`, ACP handshake, session state. Survives across rounds.
- **Session dir** (`.grok-implement/sessions/<id>/`): MD files Claude reads/writes (spec, acceptance, dont-break, issues, verification, outputs) + IPC files (commands.jsonl, output.jsonl).
- **Multi-round loop**: implement → verify → revise (or clarify or reconcile) → verify → ... → finalize.

## Runner
```bash
RUNNER="{{RUNNER_PATH}}"
SKILLS_DIR="{{SKILLS_DIR}}"
json_esc() { printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(d)))'; }
```

## Critical Rules (DO NOT skip)
- **≥1 acceptance criteria is mandatory.** `start` rejects spec.md without `AC-N: ...` bullets.
- **Verify independently after every round.** Re-run VERIFICATION_COMMANDS yourself; do not trust Grok's `VERIFICATION_RESULTS` alone.
- **Maintain `acceptance.md` and `dont-break.md`.** Append a `## Round N` section after each verification.
- **Never modify `spec.md` after first `start`.** It's the immutable contract.
- **Stop after MAX_ROUNDS=10 or stalemate.** Don't loop forever.
- **Stdin protocol**: `printf '%s' "$PROMPT" | node "$RUNNER" ...` — never `echo`. JSON via heredoc.
- **Cleanup is required**: always `finalize` + `stop`, even on failure.
- `cancel <dir>` requests cooperative abort of a hung round (see protocol.md).
- For poll intervals, error subtypes, file conventions → `Read references/protocol.md`

## Workflow

### 0. Pre-flight
Confirm: working dir, tech stack, what files might be touched. If user request is vague, ask clarifying questions BEFORE init.

### 1. Init
```bash
INIT_OUTPUT=$(node "$RUNNER" init --skill-name grok-implement --working-dir "$PWD")
SESSION_DIR=${INIT_OUTPUT#GROK_SESSION:}
```
Validate: `INIT_OUTPUT` must start with `GROK_SESSION:`. The runner has now created `spec.md`, `acceptance.md`, `dont-break.md`, and dirs `prompts/`, `outputs/`, `verification/`, `issues/`.

### 2. Build Spec
Edit `$SESSION_DIR/spec.md`. Required sections: TASK, CONTEXT, SCOPE, REQUIREMENTS, CONSTRAINTS, ACCEPTANCE_CRITERIA, VERIFICATION_COMMANDS. Optional: PARENT_PLAN, NOTES.

**Inferring VERIFICATION_COMMANDS** (Claude does this):
- Detect `package.json` → `npm test`, `npm run lint`, `tsc --noEmit` (if TS)
- Detect `Cargo.toml` → `cargo test`, `cargo clippy --all-targets`, `cargo build`
- Detect `pyproject.toml` / `pytest.ini` → `pytest`, `ruff check`, `mypy`
- Detect `go.mod` → `go test ./...`, `go vet ./...`, `go build ./...`
- If unclear → ask user OR use a single sanity check like file presence

**ACCEPTANCE_CRITERIA tips**:
- Each AC must be testable. "Code is clean" is not an AC. "`npm run lint` returns 0 warnings" is.
- Number them AC-1, AC-2, AC-3.
- Cover: functional behavior, tests added, command outputs, performance/style if relevant.

### 3. Render + Start (Round 1)

```bash
PROMPT=$(node "$RUNNER" render --skill grok-implement --template implement --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{
  "TASK":$(json_esc "$(cat "$SESSION_DIR/spec.md" | awk '/^## TASK/{f=1;next} /^## /{f=0} f' | sed '/^$/d')"),
  "CONTEXT":$(json_esc "$(awk '/^## CONTEXT/{f=1;next} /^## /{f=0} f' "$SESSION_DIR/spec.md")"),
  "PARENT_PLAN":$(json_esc "$(awk '/^## PARENT_PLAN/{f=1;next} /^## /{f=0} f' "$SESSION_DIR/spec.md")"),
  "SCOPE":$(json_esc "$(awk '/^## SCOPE/{f=1;next} /^## /{f=0} f' "$SESSION_DIR/spec.md")"),
  "REQUIREMENTS":$(json_esc "$(awk '/^## REQUIREMENTS/{f=1;next} /^## /{f=0} f' "$SESSION_DIR/spec.md")"),
  "CONSTRAINTS":$(json_esc "$(awk '/^## CONSTRAINTS/{f=1;next} /^## /{f=0} f' "$SESSION_DIR/spec.md")"),
  "ACCEPTANCE_CRITERIA":$(json_esc "$(awk '/^## ACCEPTANCE_CRITERIA/{f=1;next} /^## /{f=0} f' "$SESSION_DIR/spec.md")"),
  "VERIFICATION_COMMANDS":$(json_esc "$(awk '/^## VERIFICATION_COMMANDS/{f=1;next} /^## /{f=0} f' "$SESSION_DIR/spec.md")"),
  "NOTES":$(json_esc "$(awk '/^## NOTES/{f=1;next} /^## /{f=0} f' "$SESSION_DIR/spec.md")")
}
RENDER_EOF
)

printf '%s' "$PROMPT" | node "$RUNNER" start "$SESSION_DIR" --timeout 1200
```

Validate: returns `{"status":"started","round":1,...}`. Errors:
- `SPEC_INCOMPLETE` → spec.md missing sections or AC; fix and retry
- `GROK_NOT_FOUND` → tell user to install grok CLI
- `BROKER_FAILED` → check `$SESSION_DIR/broker.log`

### 4. Poll
```bash
POLL_JSON=$(node "$RUNNER" poll "$SESSION_DIR" --min-interval 120)
```
The runner long-polls: blocks up to `--min-interval` seconds (default 120) until new output appears or the round completes. No need for external sleep/retry loops — just call poll in a loop.

Wait for `status === "completed"`. Report `activities` (thinking, tool calls) to user during the wait. Save Grok's output:
```bash
echo "$POLL_JSON" | node -e '...' > "$SESSION_DIR/outputs/round-001.md"
```

### 5. Verify (Claude — independent)

This is the most important step. Do NOT trust Grok's self-reported VERIFICATION_RESULTS.

1. **Parse Grok's output** for STATUS, CHANGES, ACCEPTANCE_STATUS sections.
2. **Read each modified file** in CHANGES — sanity check for correctness, scope adherence, constraint violations.
3. **Run every command** in spec.VERIFICATION_COMMANDS yourself, capture exit codes and output.
4. **Compare against ACs**: for each AC,
   - If Grok marked `[x]` and your verification confirms → mark VERIFIED
   - If Grok marked `[x]` but your verification disagrees → mark FAILED with evidence
   - If `[/]` or `[!]` → mark accordingly
   - If untouched → mark PENDING

5. **Update `acceptance.md`**: append a section:
   ```
   ## Round 1 (2026-05-26 15:30)
   - [x] AC-1: <criterion> — verified by `npm test` (24/24 pass)
   - [!] AC-2: <criterion> — Grok claimed [x] but `npm run lint` reports 3 warnings in src/auth.ts
   - [ ] AC-3: <criterion> — not addressed
   ```

6. **Update `dont-break.md`**: append items that are now verified-passing — these become invariants for future rounds.

7. **Write `verification/round-N.md`** with full results (command outputs, AC analysis, decision).

### 6. Decide Next Step

| Condition | Next |
|---|---|
| All ACs `[x]` and verified | → step 8 (finalize) |
| STATUS=BLOCKED with OPEN_QUESTIONS | → step 7a (clarify) |
| Some ACs failing/partial AND round < 10 | → step 7b (revise) |
| Same AC failed 2+ rounds in a row | → step 7c (reconcile, then user escalation) |
| Round = 10 | → step 8 (finalize partial, escalate) |

### 7a. Clarify Round
Grok asked questions in OPEN_QUESTIONS. Claude answers them.

```bash
PROMPT=$(node "$RUNNER" render --skill grok-implement --template clarify --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"TASK":..., "ACCEPTANCE_CRITERIA":..., "CONSTRAINTS":..., "ROUND":"$NEXT_ROUND",
 "QUESTIONS":$(json_esc "$GROK_QUESTIONS"),
 "ANSWERS":$(json_esc "$CLAUDE_ANSWERS"),
 "DONT_BREAK":$(json_esc "$(cat "$SESSION_DIR/dont-break.md")")}
RENDER_EOF
)
printf '%s' "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --timeout 1200
```
Back to step 4.

### 7b. Revise Round
Build issues list and resume.

Write `$SESSION_DIR/issues/round-N-issues.md` (Claude's findings, formatted as):
```
## Issue 1 [CRITICAL]
- AC: AC-2 (rejects expired token)
- Evidence: `npm test` exit 1 — auth.test.ts:42 fails (got 200, expected 401)
- Expected: middleware throws on TokenExpiredError
- Hint: jsonwebtoken v9 throws TokenExpiredError; current code only handles JsonWebTokenError

## Issue 2 [IMPORTANT]
...
```

Severity: CRITICAL (blocks AC), IMPORTANT (regression or partial AC), NIT (cosmetic; usually skip).

```bash
PROMPT=$(node "$RUNNER" render --skill grok-implement --template revise --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"TASK":..., "SCOPE":..., "REQUIREMENTS":..., "CONSTRAINTS":..., "ACCEPTANCE_CRITERIA":..., "VERIFICATION_COMMANDS":...,
 "ROUND":"$NEXT_ROUND",
 "DONT_BREAK":$(json_esc "$(cat "$SESSION_DIR/dont-break.md")"),
 "ISSUES_FOUND":$(json_esc "$(cat "$SESSION_DIR/issues/round-${NEXT_ROUND}-issues.md")")}
RENDER_EOF
)
printf '%s' "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --timeout 1200
```
Back to step 4.

### 7c. Reconcile (stalemate)
After 2 consecutive rounds with the same AC failing the same way:

Build a recurring-issue summary and prior-attempts summary, render reconcile template, resume. Grok will return analysis only (no code). Claude reads, decides whether to:
- Clarify the AC and revise (if Grok identified spec ambiguity)
- Escalate to user (if AC is infeasible or environmental)
- Accept stalemate, finalize partial

### 8. Finalize + Cleanup
```bash
node "$RUNNER" finalize "$SESSION_DIR"
node "$RUNNER" stop "$SESSION_DIR"
```
Always run both. Report final summary to user with:
- ACs passed / failed counts
- Files changed list (cumulative)
- Verification results
- Risks and open questions
- Session dir path (so user can inspect)

## Re-discovering a Session

If you lose track of a session (long task, context compaction, etc.):

```bash
node "$RUNNER" info "$SESSION_DIR"     # Full status of one session
node "$RUNNER" list --working-dir "$PWD"  # All sessions in workspace
```

Then read the relevant MD files:
- `spec.md` — what was the contract
- `acceptance.md` — current AC status
- `dont-break.md` — invariants
- `outputs/round-N.md` — what Grok did each round
- `verification/round-N.md` — what Claude verified

## Parallel Sessions

Claude can run multiple grok-implement sessions concurrently (e.g. when an outer plan splits into N independent sub-tasks):

1. For each sub-task, run `init` (each gets its own session dir)
2. Build spec.md per session, including PARENT_PLAN with the overall plan + which sub-task this is
3. Start all sessions; each spawns its own broker
4. Poll each independently (in parallel via shell `&` or sequential polling cycles)
5. Verify each independently
6. Aggregate final results when all complete

Use `list` to see all active sessions.

## Flavor Text Triggers
SKILL_START, SPEC_BUILT, GROK_THINKING, TOOL_INVOKED, FILE_CHANGED, ROUND_COMPLETE, VERIFY_PASS, VERIFY_FAIL, REVISE_NEEDED, CLARIFY_NEEDED, STALEMATE, ALL_AC_PASS, FINAL_SUMMARY

## Rules
- Grok implements; Claude orchestrates AND verifies independently.
- Spec is immutable after first `start`. Need to change scope? Finalize and start a new session.
- Don't accept Grok's claim of `[x]` without verifying yourself.
- Trust Grok on tool execution (it ran the command), but re-run verification commands to confirm state.
- **Trusted working dir only** — broker auto-approves all tool calls including fs read/write/terminal with no path sandbox. Run only in dirs you trust the spec content for.
- Broker auto-approves all tool calls — only run in trusted working directories.
- If Grok output doesn't follow OUTPUT_FORMAT, treat as failed round; in revise round, instruct it to re-emit using the schema.
