#!/usr/bin/env node

// Runtime guard: Node.js >= 20 required (ACP runner uses parseArgs and modern features)
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 20) {
  console.error(`Error: Node.js >= 20 required (found ${process.version})`);
  process.exit(1);
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths and CLI flags
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const skillPackDir = path.join(packageRoot, 'skill-packs', 'grok-implement');

// Install target: ~/.claude/skills (Claude Code).
const args = process.argv.slice(2);
const autoMode = args.includes('--auto');

const SKILL_NAME = 'grok-implement';
const skillsRoot = path.join(os.homedir(), '.claude', 'skills');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape characters special in double-quoted shell strings: \ " $ ` */
function escapeForDoubleQuotedShell(s) {
  return s.replace(/[\\"$`]/g, '\\$&');
}

/** Recursively copy a directory */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function install() {
  const skillDir = path.join(skillsRoot, SKILL_NAME);
  const runnerPath = path.join(skillDir, 'scripts', 'grok-runner.js');

  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stagingDir = path.join(skillsRoot, `.${SKILL_NAME}-staging-${uid}`);

  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    // 1. Copy runner into staging/<skill>/scripts/
    const runnerSrc = path.join(skillPackDir, 'scripts', 'grok-runner.js');
    const stagedSkillDir = path.join(stagingDir, SKILL_NAME);
    const stagedScriptsDir = path.join(stagedSkillDir, 'scripts');
    fs.mkdirSync(stagedScriptsDir, { recursive: true });
    fs.copyFileSync(runnerSrc, path.join(stagedScriptsDir, 'grok-runner.js'));

    // ESM marker (Node 20 doesn't auto-detect .js as ESM in all contexts)
    fs.writeFileSync(path.join(stagedSkillDir, 'package.json'), '{"type":"module"}\n', 'utf8');

    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(stagedScriptsDir, 'grok-runner.js'), 0o755);
    }

    // 2. Inject placeholders into SKILL.md and copy references/
    const escapedRunnerPath = escapeForDoubleQuotedShell(runnerPath);
    const escapedSkillsRoot = escapeForDoubleQuotedShell(skillsRoot);

    const templatePath = path.join(skillPackDir, 'skills', SKILL_NAME, 'SKILL.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    if (!template.includes('{{RUNNER_PATH}}')) {
      throw new Error(`Template SKILL.md missing {{RUNNER_PATH}} placeholder`);
    }
    let injected = template.replaceAll('{{RUNNER_PATH}}', escapedRunnerPath);
    injected = injected.replaceAll('{{SKILLS_DIR}}', escapedSkillsRoot);
    if (injected.includes('{{RUNNER_PATH}}') || injected.includes('{{SKILLS_DIR}}')) {
      throw new Error(`Placeholders remaining in SKILL.md after injection`);
    }
    fs.writeFileSync(path.join(stagedSkillDir, 'SKILL.md'), injected, 'utf8');

    // Copy references/ (required)
    const refsSrc = path.join(skillPackDir, 'skills', SKILL_NAME, 'references');
    if (!fs.existsSync(refsSrc)) {
      throw new Error('Missing references/ directory in skill pack');
    }
    copyDirSync(refsSrc, path.join(stagedSkillDir, 'references'));

    // 3. Verify runner can execute
    console.log('Verifying grok-runner.js ...');
    const versionOutput = execFileSync(process.execPath, [path.join(stagedScriptsDir, 'grok-runner.js'), 'version'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    if (!versionOutput) {
      throw new Error('Runner version check returned empty output (possible symlink or gate issue)');
    }
    console.log(`  grok-runner.js version: ${versionOutput}`);

    // Warn if grok CLI not found
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      execFileSync(whichCmd, ['grok'], { encoding: 'utf8', timeout: 5000 });
    } catch {
      console.warn('');
      console.warn('  ⚠️  grok CLI not found in PATH.');
      console.warn('     Install: https://docs.x.ai/build/overview');
      console.warn('     After install, run `grok login` once.');
    }

    // 4. Atomic swap: backup old → move staged → cleanup
    fs.mkdirSync(skillsRoot, { recursive: true });
    let backupPath = null;

    if (fs.existsSync(skillDir)) {
      backupPath = path.join(skillsRoot, `.${SKILL_NAME}-backup-${uid}`);
      fs.renameSync(skillDir, backupPath);
    }

    try {
      fs.renameSync(stagedSkillDir, skillDir);
    } catch (err) {
      // Rollback
      if (backupPath && fs.existsSync(backupPath)) {
        try {
          fs.renameSync(backupPath, skillDir);
        } catch (rollbackErr) {
          // REQ-2: composite error with both failures + manual recovery hint
          const composite = new Error(
            `Install failed: ${err.message}\n` +
            `Rollback also failed: ${rollbackErr.message}\n` +
            `Manual recovery: mv ${backupPath} ${skillDir}`
          );
          composite.cause = err;
          composite.rollbackError = rollbackErr;
          throw composite;
        }
      }
      throw err;
    }

    // Cleanup
    if (backupPath && fs.existsSync(backupPath)) {
      try { fs.rmSync(backupPath, { recursive: true, force: true }); }
      catch { console.warn(`  Warning: could not remove backup ${backupPath}`); }
    }
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}

    return { skillsRoot, skillDir, runnerPath };
  } catch (err) {
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Auto-inject CLAUDE.md guidance
// ---------------------------------------------------------------------------

const START_MARKER = '<!-- grok-implement-start -->';
const END_MARKER = '<!-- grok-implement-end -->';

function buildGuidanceBlock() {
  return [
    START_MARKER,
    '',
    '## Grok Implement — Delegation Guidance',
    '',
    'When the user requests implementation work that you would normally code yourself, **consider delegating to grok-implement** — let Grok do the implementation while you (Claude) act as the orchestrator and verifier.',
    '',
    '### When to delegate to grok-implement',
    '',
    '| Scenario | Action |',
    '|----------|--------|',
    '| Task has clear, testable acceptance criteria | Delegate. You build the spec; Grok implements; you verify. |',
    '| Multi-step plan with N independent sub-tasks | Spawn N parallel grok-implement sessions, one per sub-task |',
    '| Iterative fixes / bug fixes with clear test signals | Delegate. Loop revise/clarify until ACs pass |',
    '| Greenfield modules with self-contained scope | Delegate. Define spec, let Grok produce + tests |',
    '| Tasks needing >5min of focused coding | Delegate to free your context for orchestration |',
    '',
    '### When NOT to delegate (do it yourself)',
    '',
    '- Open-ended exploration ("figure out the right approach")',
    '- Tasks where you cannot define ≥1 testable AC',
    '- Trivial 1–3 line edits (overhead not worth it)',
    '- Tasks requiring reading lots of context the user provided in chat (Grok would lose it)',
    '',
    '### Your role when delegating',
    '',
    '1. **Spec author**: Build the structured spec (TASK, CONTEXT, SCOPE, REQUIREMENTS, CONSTRAINTS, ACCEPTANCE_CRITERIA, VERIFICATION_COMMANDS). Infer verification commands from the project (npm test / cargo test / pytest / etc).',
    '2. **Orchestrator**: Call `/grok-implement`. Monitor polls, report Grok\'s activities (thinking, tool calls) to user.',
    '3. **Verifier (independent)**: Re-run VERIFICATION_COMMANDS yourself. Read modified files. Confirm each AC. Do NOT trust Grok\'s self-reported `VERIFICATION_RESULTS` alone.',
    '4. **Reviewer**: Maintain `acceptance.md` and `dont-break.md`. If issues found, write `issues/round-N-issues.md` and trigger revise round.',
    '5. **Loop controller**: Decide PASS / REVISE / CLARIFY / RECONCILE / FINALIZE. Stop at max 10 rounds or stalemate.',
    '',
    '### Key skill commands (for reference)',
    '',
    '- `/grok-implement` — start a new delegated implementation session',
    '- `node $RUNNER list --working-dir $PWD` — list active sessions in a workspace',
    '- `node $RUNNER info $SESSION_DIR` — re-discover a session you forgot (spec, AC, paths)',
    '',
    '### Rules',
    '',
    '- Always ask the user before delegating: "Want me to use grok-implement for this?" — never auto-delegate without confirmation.',
    '- ≥1 acceptance criterion is mandatory. If you cannot define one, ask the user or do it yourself.',
    '- Verification is YOUR job — Grok\'s self-report is a starting point, not proof.',
    '- Parallel sub-tasks: each gets its own session. Use `list` to track. Aggregate results when all done.',
    '- Trusted working dir only — Grok auto-approves all tool calls (file edit, terminal, etc).',
    '',
    END_MARKER,
  ].join('\n');
}

function injectClaudeMdGuidance() {
  // Inject into both potential locations if they exist or are likely
  const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');

  try {
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });

    let existing = '';
    try { existing = fs.readFileSync(claudeMdPath, 'utf8'); }
    catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    const startIdx = existing.indexOf(START_MARKER);
    const endIdx = existing.indexOf(END_MARKER);
    const block = buildGuidanceBlock();

    let updated;
    if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
      // Replace existing block (idempotent)
      updated = existing.slice(0, startIdx) + block + existing.slice(endIdx + END_MARKER.length);
    } else if (startIdx !== -1 || endIdx !== -1) {
      throw new Error('Found partial grok-implement markers in ~/.claude/CLAUDE.md — remove them manually and re-run');
    } else {
      const sep = existing.length === 0 ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
      updated = existing + sep + block + '\n';
    }

    fs.writeFileSync(claudeMdPath, updated, 'utf8');
    console.log(`Auto-delegation guidance injected into ${claudeMdPath}`);
  } catch (err) {
    console.warn('');
    console.warn(`Warning: could not inject grok-implement guidance into ~/.claude/CLAUDE.md`);
    console.warn(`  Reason: ${err.message}`);
    console.warn('  Skill was installed; only guidance injection failed.');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let installResult;
try {
  installResult = install();
} catch (err) {
  console.error('');
  console.error(`Installation failed: ${err.message}`);
  process.exit(1);
}

console.log('');
console.log('grok-implement installed successfully!');
console.log(`  Skill:  ${installResult.skillDir}`);
console.log(`  Runner: ${installResult.runnerPath}`);
console.log('');
console.log('Skill available in Claude Code: /grok-implement');

if (autoMode) {
  console.log('');
  injectClaudeMdGuidance();
} else {
  console.log('');
  console.log('Optional: npx github:lploc94/grok-implement --auto');
  console.log('  Injects delegation guidance into ~/.claude/CLAUDE.md');
}
