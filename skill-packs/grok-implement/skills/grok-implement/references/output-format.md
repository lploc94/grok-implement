# Output Format

Grok's reply at the end of every implement/revise/clarify round MUST follow this exact structure. Section headers are verbatim (case-sensitive, with `##` prefix). Sections appear in the order shown. Empty sections are allowed (write `(none)` or `N/A`) but the header must be present.

The runner extracts the fenced block below as `{OUTPUT_FORMAT}` for prompt injection.

```markdown
## STATUS
<COMPLETED | IN_PROGRESS | BLOCKED>

## SUMMARY
<1–3 sentences: what was done in this round at a high level. No filler.>

## CHANGES
<File-by-file change list. One bullet per file. Format:>
- `path/to/file.ts` — added function X to handle Y; refactored Z (lines 12–34)
- `path/to/test.ts` — added 3 tests for X (success, expired, malformed)
<If no files changed, write: (no file changes this round)>

## ACCEPTANCE_STATUS
<Checkbox list, one bullet per AC from the spec. Status legend:>
<  [x] passed and verified by Grok>
<  [/] partial — addressed but incomplete; explain why>
<  [!] failed or not addressed; explain why>
<  [ ] not yet attempted (only valid for IN_PROGRESS)>
<Format: - [STATUS] AC-N: <criterion> — evidence/explanation>
- [x] AC-1: middleware validates JWT signature — implemented in `auth.ts:42`, tested in `auth.test.ts:18`
- [x] AC-2: returns 401 on invalid token — verified by `auth.test.ts:35` (passes)
- [!] AC-3: refresh-token flow — out of scope per SCOPE.OUT

## VERIFICATION_RESULTS
<Output of every command in spec.VERIFICATION_COMMANDS that you ran. Format per command:>
### `<command>`
<exit code, last ~20 lines of output, or full output if short>

<Example:>
### `npm test`
exit: 0
PASS  src/auth.test.ts (5 tests)
PASS  src/middleware.test.ts (8 tests)
Tests: 13 passed, 13 total

### `npm run lint`
exit: 0
(no warnings)

## RISKS
<Things that may break or that you're uncertain about. One bullet each. Required even if empty — write "(none)" if so.>
- Refactor of `validateToken` could affect `/admin` route which is not covered by tests; manual verification recommended.

## OPEN_QUESTIONS
<Required if STATUS=BLOCKED. Optional otherwise — only include if you need clarification before next round. One question per bullet.>
- Should refresh tokens be validated against the same secret? Spec is silent.
- (none) <— if no questions>
```

## Section Rules

### STATUS

| Value | Meaning | Triggers in Claude |
|---|---|---|
| `COMPLETED` | All ACs ticked `[x]`; ready for finalize | Claude verifies; if confirmed → finalize |
| `IN_PROGRESS` | Some ACs ticked, some pending; ran out of time/context | Claude verifies done items; sends revise to push remaining |
| `BLOCKED` | Cannot proceed without clarification | Claude reads OPEN_QUESTIONS, replies via clarify template |

### CHANGES
- One bullet per file. Multiple changes to same file collapse into one bullet with sub-list if needed.
- Use backticks for paths.
- Mention line ranges or function names so Claude can verify quickly.
- Forbidden: vague entries like "updated several files" or "improved code".

### ACCEPTANCE_STATUS
- One bullet per AC from spec — all ACs must appear, even if not addressed.
- AC-N must match the AC number from spec.
- Evidence is required for `[x]`. Reason is required for `[/]`, `[!]`, `[ ]`.
- This is the primary signal Claude parses to decide pass/fail.

### VERIFICATION_RESULTS
- Run every command from spec.VERIFICATION_COMMANDS. If you cannot run one (missing tool, etc.), say so explicitly with the heading and `(could not run: <reason>)` instead of skipping.
- Include exit code.
- For long output, last 20 lines + summary line. For test runners, include pass/fail counts.
- Forbidden: paraphrased summaries instead of actual command output.

### RISKS
- Honest disclosure of uncertainty. Better to over-report than under-report.
- Each risk should mention: what could break, where, and how to mitigate or detect.

### OPEN_QUESTIONS
- Used by Claude to decide whether to send a clarify round.
- If STATUS=BLOCKED and this is empty, that's a contradiction — revise.
- Be specific: "Should X be Y or Z?" not "Need clarification on X."

## Strictness

- Headers must match exactly: `## STATUS`, `## SUMMARY`, `## CHANGES`, `## ACCEPTANCE_STATUS`, `## VERIFICATION_RESULTS`, `## RISKS`, `## OPEN_QUESTIONS`.
- Order matters for parsing reliability.
- Do not add additional top-level (`##`) sections. If you need notes outside this schema, put them under RISKS or OPEN_QUESTIONS.
- Subsections (`###` inside VERIFICATION_RESULTS for each command) are allowed and expected.

## Reconcile Round (special)

When invoked via the Reconcile Prompt (after stalemate), use a different schema:
```
## STATUS
BLOCKED

## RECONCILE_ANALYSIS
<answers to the 4 reconcile questions>

## PROPOSED_APPROACHES
### Approach A
...
### Approach B
...

## OPEN_QUESTIONS
...
```

No CHANGES or VERIFICATION_RESULTS — reconcile is analysis-only.
