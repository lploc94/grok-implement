#!/usr/bin/env node

/**
 * grok-runner.js — ACP-based runner for Grok Build CLI (Node.js stdlib only).
 *
 * v2: Uses Agent Client Protocol (`grok agent stdio`) with broker process pattern.
 *
 * Architecture:
 * - Broker: long-running detached Node process that spawns `grok agent stdio`,
 *   does ACP handshake, watches commands.jsonl for prompts, writes events
 *   to output.jsonl.
 * - Runner subcommands (init/start/resume/poll/stop): short-lived; communicate
 *   with broker via files (commands.jsonl, output.jsonl).
 *
 * Subcommands: version, init, start, resume, poll, stop, finalize, render,
 *              status, _broker (internal)
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// --- Constants ---
const GROK_RUNNER_VERSION = 2;

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_TIMEOUT = 2;
const EXIT_TURN_FAILED = 3;
const EXIT_STALLED = 4;
const EXIT_GROK_NOT_FOUND = 5;

const IS_WIN = process.platform === "win32";

const BROKER_STARTUP_TIMEOUT_MS = 30000;
const BROKER_POLL_COMMANDS_MS = 250;

// ============================================================
// Process management helpers
// ============================================================

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getDescendantPids(rootPid) {
  if (IS_WIN) return [];
  const descendants = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const ppid = queue.shift();
    try {
      const r = spawnSync("pgrep", ["-P", String(ppid)], { encoding: "utf8", timeout: 5000 });
      if (r.status === 0 && r.stdout) {
        const children = r.stdout.trim().split("\n")
          .map(s => parseInt(s.trim(), 10))
          .filter(n => !isNaN(n) && n > 0);
        for (const c of children) {
          if (!descendants.includes(c)) { descendants.push(c); queue.push(c); }
        }
      }
    } catch { continue; }
  }
  return descendants;
}

function syncSleep(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`], { timeout: ms + 2000 });
  }
}

function killTree(pid) {
  if (!pid || pid <= 1) return;
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
      return;
    }
    const descendants = getDescendantPids(pid);
    try { process.kill(-pid, "SIGTERM"); } catch {}
    for (const dp of descendants) { try { process.kill(dp, "SIGTERM"); } catch {} }
    syncSleep(2000);
    try { process.kill(-pid, "SIGKILL"); } catch {}
    for (const dp of descendants) {
      if (isAlive(dp)) { try { process.kill(dp, "SIGKILL"); } catch {} }
    }
  } catch {}
}

function killSingle(pid) {
  if (!pid || pid <= 1) return;
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
      return;
    }
    try { process.kill(pid, "SIGTERM"); } catch { return; }
    syncSleep(500);
    if (isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  } catch {}
}

// ============================================================
// File I/O
// ============================================================

function atomicWrite(filepath, content) {
  const dirpath = path.dirname(filepath);
  const tmp = path.join(dirpath, `.${path.basename(filepath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, filepath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function readState(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
}

function updateState(stateDir, updates) {
  const state = readState(stateDir);
  Object.assign(state, updates);
  atomicWrite(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2));
  return state;
}

function readRounds(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, "rounds.json"), "utf8")); }
  catch { return []; }
}

function writeRounds(stateDir, rounds) {
  atomicWrite(path.join(stateDir, "rounds.json"), JSON.stringify(rounds, null, 2));
}

// REQ-4: broker.state.json for cross-process busy/round tracking (separate from session state.json)
function readBrokerState(stateDir) {
  const p = path.join(stateDir, "broker.state.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return { busy: false, current_round: 0, last_round_completed: 0, respawning: false }; }
}

function setBrokerState(stateDir, updates) {
  const cur = readBrokerState(stateDir);
  const next = { ...cur, ...updates };
  atomicWrite(path.join(stateDir, "broker.state.json"), JSON.stringify(next, null, 2));
  return next;
}

// Exported for smoke tests (and cmdResume uses it)
function assertBrokerIdle(stateDir) {
  let b;
  try { b = readBrokerState(stateDir); } catch { b = { busy: false, respawning: false, current_round: 0 }; }
  if (b.busy === true) {
    return { ok: false, code: "BROKER_BUSY", message: `Broker still processing prior round (busy=true, current_round=${b.current_round || 0})` };
  }
  if (b.respawning === true) {
    return { ok: false, code: "BROKER_RECOVERING", message: "Broker is recovering grok subprocess after cancel" };
  }
  return { ok: true };
}

function appendCommand(stateDir, cmd) {
  const file = path.join(stateDir, "commands.jsonl");
  fs.appendFileSync(file, JSON.stringify(cmd) + "\n", "utf8");
}

function appendOutput(stateDir, event) {
  const file = path.join(stateDir, "output.jsonl");
  fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
}

function readStdinSync() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  try {
    while (true) {
      const n = fs.readSync(0, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.slice(0, n)));
    }
  } catch {}
  return Buffer.concat(chunks).toString("utf8");
}

function jsonOut(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function jsonError(error, code = "UNKNOWN_ERROR") { jsonOut({ status: "error", error, code }); }


// ============================================================
// Broker (long-running ACP process)
// ============================================================

/**
 * Broker process: spawns `grok agent stdio`, does ACP handshake, watches
 * commands.jsonl for new commands, writes events to output.jsonl.
 *
 * Lifecycle:
 *   1. Spawn grok agent stdio
 *   2. ACP: initialize → authenticate → session/new
 *   3. Loop: read new commands from commands.jsonl → process them
 *   4. Exit on stop command, grok process death, or fatal error
 */
async function cmdBroker(argv) {
  const stateDir = argv[0];
  if (!stateDir) {
    process.stderr.write("broker: state directory required\n");
    process.exit(EXIT_ERROR);
  }

  const outputFile = path.join(stateDir, "output.jsonl");
  const commandsFile = path.join(stateDir, "commands.jsonl");
  const cursorFile = path.join(stateDir, "commands.cursor");
  const brokerLog = path.join(stateDir, "broker.log");

  // Redirect broker logs to file
  function blog(msg) {
    try { fs.appendFileSync(brokerLog, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
  }

  blog(`Broker starting (pid=${process.pid})`);

  // Catch unhandled errors so we always log them and emit broker.fatal
  process.on("uncaughtException", err => {
    blog(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
    try { appendOutput(stateDir, { type: "broker.fatal", error: `uncaught: ${err.message}` }); } catch {}
    setTimeout(() => process.exit(EXIT_ERROR), 100);
  });
  process.on("unhandledRejection", reason => {
    const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    blog(`UNHANDLED REJECTION: ${msg}`);
    try { appendOutput(stateDir, { type: "broker.fatal", error: `unhandled: ${msg}` }); } catch {}
  });

  // Update state with broker pid
  try {
    updateState(stateDir, { broker_pid: process.pid, broker_started_at: Math.floor(Date.now() / 1000) });
  } catch (e) {
    blog(`Failed to update state: ${e.message}`);
    process.exit(EXIT_ERROR);
  }

  // REQ-4 init broker.state.json (busy tracking for resume gating + cancel/respawn)
  setBrokerState(stateDir, { busy: false, current_round: 0, last_round_completed: 0, respawning: false });

  // REQ-8: idle TTL (default 30min, overridable via state.json idle_ttl_ms)
  const brokerState = readState(stateDir);
  const idleTtlMs = (brokerState && brokerState.idle_ttl_ms) || (30 * 60 * 1000);
  let lastActivityAt = Date.now();
  function touchActivity() { lastActivityAt = Date.now(); }

  // ---- Spawn grok agent stdio ----
  let grokProc = spawn("grok", ["agent", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: readState(stateDir).working_dir,
  });

  if (!grokProc.pid) {
    blog("Failed to spawn grok agent stdio");
    appendOutput(stateDir, { type: "broker.fatal", error: "Failed to spawn grok agent stdio" });
    process.exit(EXIT_ERROR);
  }

  blog(`Spawned grok agent stdio pid=${grokProc.pid}`);
  updateState(stateDir, { grok_pid: grokProc.pid });

  const grokRl = readline.createInterface({ input: grokProc.stdout });
  const pending = new Map();
  const terminals = new Map();
  let nextId = 1;

  // REQ-5 cancel state
  let currentPromptRpcId = null;
  const CANCEL_GRACE_MS = 10000;

  // REQ-3: single shutdown path for broker (kills terminals + grok tree, records reason, exits)
  function shutdownBroker(reason, fatal = false) {
    blog(`shutdownBroker called: ${reason} (fatal=${fatal})`);
    // Kill all tracked non-exited terminals
    for (const [tid, term] of terminals) {
      if (!term.exited && term.proc && term.proc.pid) {
        try { killTree(term.proc.pid); } catch {}
      }
    }
    terminals.clear();
    // Kill grok subtree if still alive
    if (grokProc && grokProc.pid && isAlive(grokProc.pid)) {
      try { killTree(grokProc.pid); } catch {}
    }
    // Record exit event (additive to existing broker.* events)
    try {
      appendOutput(stateDir, {
        type: "broker.exited",
        reason,
        ts: Math.floor(Date.now() / 1000),
      });
    } catch {}
    process.exit(fatal ? EXIT_ERROR : EXIT_SUCCESS);
  }

  grokProc.stderr.on("data", chunk => {
    const text = chunk.toString();
    blog(`grok stderr: ${text.trim()}`);
  });

  grokProc.on("exit", (code, sig) => {
    blog(`grok exited code=${code} sig=${sig}`);
    appendOutput(stateDir, { type: "broker.grok_exited", code, signal: sig });
    process.exit(0);
  });

  // ---- ACP message routing ----
  let currentRound = 0;

  function sendResponse(id, result) {
    grokProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  function sendErrorResponse(id, code, message) {
    grokProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  }

  grokRl.on("line", line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    // Streaming session/update notifications
    if (msg.method === "session/update") {
      const update = msg.params?.update;
      if (!update) return;
      const ev = { type: `acp.${update.sessionUpdate}`, round: currentRound };
      if (update.content?.text) ev.text = update.content.text;
      if (update.toolCallId) ev.tool_call_id = update.toolCallId;
      if (update.title) ev.title = update.title;
      if (update.kind) ev.kind = update.kind;
      if (update.status) ev.status_field = update.status;
      if (update.rawInput !== undefined) ev.raw_input = update.rawInput;
      if (update.rawOutput !== undefined) ev.raw_output = update.rawOutput;
      if (update.locations) ev.locations = update.locations;
      appendOutput(stateDir, ev);
      return;
    }

    // Server-initiated request: permission request — auto-approve
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      const opts = msg.params?.options || [];
      // Find the "allow" option (allow_once or allow_always)
      let chosen = opts.find(o => o.kind === "allow_always")
        || opts.find(o => o.kind === "allow_once")
        || opts.find(o => o.kind === "allow")
        || opts[0];
      if (!chosen) {
        sendErrorResponse(msg.id, -32603, "No permission option available");
        return;
      }
      blog(`Permission auto-approved: ${chosen.optionId || chosen.kind}`);
      sendResponse(msg.id, {
        outcome: { outcome: "selected", optionId: chosen.optionId },
      });
      return;
    }

    // Server-initiated: file read/write requests (fs capability)
    if (msg.method === "fs/read_text_file" && msg.id !== undefined) {
      try {
        const filePath = msg.params?.path;
        const content = fs.readFileSync(filePath, "utf8");
        sendResponse(msg.id, { content });
      } catch (e) {
        sendErrorResponse(msg.id, -32603, e.message);
      }
      return;
    }

    if (msg.method === "fs/write_text_file" && msg.id !== undefined) {
      try {
        const filePath = msg.params?.path;
        const content = msg.params?.content || "";
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf8");
        sendResponse(msg.id, {});
      } catch (e) {
        sendErrorResponse(msg.id, -32603, e.message);
      }
      return;
    }

    // Server-initiated: terminal capability
    if (msg.method === "terminal/create" && msg.id !== undefined) {
      try {
        const { command, args, env, cwd } = msg.params || {};
        const terminalId = `term-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const termCwd = cwd || readState(stateDir).working_dir;
        const termEnv = { ...process.env, ...(env || {}) };
        const termArgs = Array.isArray(args) ? args : [];
        const SHELL_METACHARS = /[;&|`$<>(){}~'"\\\n\t]/;

        // REQ-1 hardened shell decision (no blanket shell:true for argv-less commands)
        let finalCommand = command;
        let finalArgs = termArgs;
        let useShell = false;
        const hasMetachars = SHELL_METACHARS.test(command);
        const hasSpace = /\s/.test(command);

        if (termArgs.length > 0) {
          // argv provided → always safe, no shell
          useShell = false;
          finalCommand = command;
          finalArgs = termArgs;
        } else if (!hasMetachars && hasSpace) {
          // no metachars but spaces → split into argv, spawn direct (no shell)
          finalArgs = command.trim().split(/\s+/);
          finalCommand = finalArgs.shift();
          useShell = false;
        } else if (!hasMetachars) {
          // simple token, no args, no shell needed
          useShell = false;
          finalCommand = command;
          finalArgs = [];
        } else {
          // metachars present → must use shell
          useShell = true;
          finalCommand = command;
          finalArgs = [];
          blog(`SHELL MODE: ${command}`);
          if (process.env.GROK_RUNNER_STRICT_SHELL === "1") {
            sendErrorResponse(msg.id, -32000, `STRICT_SHELL: shell mode rejected for: ${command}`);
            return;
          }
        }

        const term = {
          id: terminalId,
          proc: null,
          output: "",
          exitCode: null,
          exitSignal: null,
          exited: false,
          waiters: [],
        };

        let proc;
        try {
          proc = spawn(finalCommand, finalArgs, {
            cwd: termCwd, env: termEnv,
            stdio: ["ignore", "pipe", "pipe"],
            shell: useShell,
          });
        } catch (e) {
          sendErrorResponse(msg.id, -32603, `Failed to spawn: ${e.message}`);
          return;
        }
        term.proc = proc;

        // Critical: handle async spawn errors (ENOENT, etc.) so broker doesn't crash
        proc.on("error", err => {
          blog(`terminal ${terminalId} spawn error: ${err.message}`);
          term.exited = true;
          term.exitCode = -1;
          term.exitSignal = null;
          term.output += `[spawn error: ${err.message}]`;
          for (const w of term.waiters) w({ exitCode: -1, signal: null });
          term.waiters = [];
        });
        proc.stdout?.on("data", chunk => { term.output += chunk.toString(); });
        proc.stderr?.on("data", chunk => { term.output += chunk.toString(); });
        proc.on("exit", (code, signal) => {
          term.exited = true;
          term.exitCode = code;
          term.exitSignal = signal;
          for (const w of term.waiters) w({ exitCode: code, signal });
          term.waiters = [];
        });
        terminals.set(terminalId, term);
        blog(`terminal/create: ${terminalId} cmd=${finalCommand} args=${JSON.stringify(finalArgs)} shell=${useShell}`);
        sendResponse(msg.id, { terminalId });
      } catch (e) {
        sendErrorResponse(msg.id, -32603, e.message);
      }
      return;
    }

    if (msg.method === "terminal/output" && msg.id !== undefined) {
      const term = terminals.get(msg.params?.terminalId);
      if (!term) { sendErrorResponse(msg.id, -32602, "Unknown terminalId"); return; }
      sendResponse(msg.id, {
        output: term.output,
        truncated: false,
        exitStatus: term.exited ? { exitCode: term.exitCode, signal: term.exitSignal } : null,
      });
      return;
    }

    if (msg.method === "terminal/wait_for_exit" && msg.id !== undefined) {
      const term = terminals.get(msg.params?.terminalId);
      if (!term) { sendErrorResponse(msg.id, -32602, "Unknown terminalId"); return; }
      if (term.exited) {
        sendResponse(msg.id, { exitCode: term.exitCode, signal: term.exitSignal });
      } else {
        term.waiters.push(result => sendResponse(msg.id, result));
      }
      return;
    }

    if (msg.method === "terminal/kill" && msg.id !== undefined) {
      const term = terminals.get(msg.params?.terminalId);
      if (!term) { sendErrorResponse(msg.id, -32602, "Unknown terminalId"); return; }
      try {
        if (!term.exited && term.proc.pid) {
          killTree(term.proc.pid);
        }
        sendResponse(msg.id, {});
      } catch (e) {
        sendErrorResponse(msg.id, -32603, e.message);
      }
      return;
    }

    if (msg.method === "terminal/release" && msg.id !== undefined) {
      const term = terminals.get(msg.params?.terminalId);
      if (term) {
        if (!term.exited && term.proc.pid) {
          try { killTree(term.proc.pid); } catch {}
        }
        terminals.delete(msg.params.terminalId);
      }
      sendResponse(msg.id, {});
      return;
    }

    // Other server-initiated requests we don't handle — respond with method not found
    if (msg.method && msg.id !== undefined) {
      blog(`Unhandled server request: ${msg.method}`);
      sendErrorResponse(msg.id, -32601, `Method not implemented: ${msg.method}`);
      return;
    }

    // Server-initiated notifications (no id)
    if (msg.method && msg.id === undefined) {
      return;
    }

    // Response to a request we made
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.id === currentPromptRpcId) currentPromptRpcId = null; // REQ-5: in-flight prompt settled
    if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else p.resolve(msg.result ?? {});
  });

  function rpc(method, params, timeoutMs = 60000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve(r) { clearTimeout(timer); resolve(r); },
        reject(e) { clearTimeout(timer); reject(e); },
      });
      grokProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  // ---- ACP handshake ----
  let sessionId;
  try {
    blog("ACP: initialize");
    const init = await rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    const authMethods = new Set((init.authMethods ?? []).map(m => m.id));
    let methodId = null;
    if (process.env.XAI_API_KEY && authMethods.has("xai.api_key")) methodId = "xai.api_key";
    else if (authMethods.has("cached_token")) methodId = "cached_token";
    else if (authMethods.size > 0) methodId = [...authMethods][0];

    if (!methodId) throw new Error("No ACP auth method available. Run `grok login` or set XAI_API_KEY.");

    blog(`ACP: authenticate methodId=${methodId}`);
    await rpc("authenticate", { methodId, _meta: { headless: true } });

    blog("ACP: session/new");
    const result = await rpc("session/new", {
      cwd: readState(stateDir).working_dir,
      mcpServers: [],
    });
    sessionId = result.sessionId;
    blog(`ACP session created: ${sessionId}`);

    appendOutput(stateDir, { type: "broker.ready", grok_pid: grokProc.pid, acp_session_id: sessionId });
    updateState(stateDir, { acp_session_id: sessionId });
  } catch (e) {
    blog(`ACP handshake failed: ${e.message}`);
    appendOutput(stateDir, { type: "broker.fatal", error: `ACP handshake failed: ${e.message}` });
    shutdownBroker(`ACP handshake failed: ${e.message}`, true);
  }

  // ---- Command loop ----
  let cursor = 0;
  if (fs.existsSync(cursorFile)) {
    try { cursor = parseInt(fs.readFileSync(cursorFile, "utf8"), 10) || 0; } catch {}
  }

  let processing = false;
  let stopRequested = false;

  // REQ-5: cooperative cancel with 10s grace + respawn fallback (kill only; full re-handshake deferred to keep ACP simple)
  async function processCancel(round) {
    touchActivity();
    const r = round || currentRound;
    blog(`Cancel requested for round ${r}, in-flightRpcId=${currentPromptRpcId}`);
    if (!currentPromptRpcId) {
      blog("Cancel: no in-flight prompt; emitting round.cancelled (no-op)");
      appendOutput(stateDir, { type: "round.cancelled", round: r, mode: "cooperative", note: "no-inflight" });
      setBrokerState(stateDir, { busy: false, last_round_completed: r });
      return;
    }

    // Send ACP session/cancel notification (no "id" — per ACP spec)
    try {
      const notif = { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } };
      grokProc.stdin.write(JSON.stringify(notif) + "\n");
      blog("Sent session/cancel notification");
    } catch (e) {
      blog(`send cancel notif failed: ${e.message}`);
    }

    // Wait up to CANCEL_GRACE_MS for the in-flight rpc to settle (response or error path clears the id)
    const start = Date.now();
    while (Date.now() - start < CANCEL_GRACE_MS && currentPromptRpcId) {
      await new Promise(r => setTimeout(r, 200));
    }

    if (!currentPromptRpcId) {
      appendOutput(stateDir, { type: "round.cancelled", round: r, mode: "cooperative" });
      setBrokerState(stateDir, { busy: false, last_round_completed: r });
      blog(`Round ${r} cancelled cooperatively within grace`);
      return;
    }

    // Fallback: kill the grok tree (cooperative did not unblock)
    blog(`Cancel grace expired for round ${r}; killing grok tree`);
    if (grokProc && grokProc.pid) {
      try { killTree(grokProc.pid); } catch {}
    }
    // Force-clear any stuck pending entry so awaiters reject promptly
    if (currentPromptRpcId && pending.has(currentPromptRpcId)) {
      const p = pending.get(currentPromptRpcId);
      pending.delete(currentPromptRpcId);
      try { p.reject(new Error("prompt cancelled (grace timeout + kill)")); } catch {}
    }
    currentPromptRpcId = null;

    appendOutput(stateDir, { type: "round.cancelled", round: r, mode: "respawn" });
    setBrokerState(stateDir, { busy: false, last_round_completed: r, respawning: false });
    // Note: broker stays up but grok child is dead; next resume/poll will surface dead broker.
    // Full in-process grok re-spawn + re-handshake + new acp_session_id is complex and omitted to avoid destabilizing existing ACP wiring.
  }

  async function processCommand(cmd) {
    touchActivity();
    if (cmd.action === "stop") {
      blog("Stop command received");
      stopRequested = true;
      return;
    }

    if (cmd.action === "prompt") {
      const round = cmd.round;
      currentRound = round;
      blog(`Round ${round}: sending prompt (${cmd.text.length} chars)`);
      setBrokerState(stateDir, { busy: true, current_round: round });
      appendOutput(stateDir, { type: "round.started", round });
      touchActivity();

      currentPromptRpcId = nextId; // peek: rpc will ++ and use this id
      try {
        const result = await rpc("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: cmd.text }],
        }, cmd.timeout_ms || 3600000);

        currentPromptRpcId = null;
        appendOutput(stateDir, {
          type: "round.completed",
          round,
          stop_reason: result.stopReason || null,
        });
        touchActivity();
        setBrokerState(stateDir, { busy: false, last_round_completed: round });
        blog(`Round ${round} completed: stopReason=${result.stopReason}`);
      } catch (e) {
        currentPromptRpcId = null;
        appendOutput(stateDir, { type: "round.failed", round, error: e.message });
        touchActivity();
        setBrokerState(stateDir, { busy: false, last_round_completed: round });
        blog(`Round ${round} failed: ${e.message}`);
      }
    }

    if (cmd.action === "cancel") {
      await processCancel(cmd.round);
      return;
    }
  }

  async function commandLoop() {
    while (!stopRequested) {
      try {
        if (!fs.existsSync(commandsFile)) {
          await new Promise(r => setTimeout(r, BROKER_POLL_COMMANDS_MS));
          continue;
        }
        const content = fs.readFileSync(commandsFile, "utf8");
        const lines = content.split("\n").filter(l => l.trim());
        const newLines = lines.slice(cursor);

        if (newLines.length > 0 && !processing) {
          processing = true;
          for (const line of newLines) {
            cursor += 1;
            atomicWrite(cursorFile, String(cursor));
            let cmd;
            try { cmd = JSON.parse(line); } catch { continue; }
            await processCommand(cmd);
            if (stopRequested) break;
          }
          processing = false;
        }
      } catch (e) {
        blog(`Command loop error: ${e.message}`);
      }
      // REQ-8: idle TTL check (shutdown if no activity for configured duration)
      if (Date.now() - lastActivityAt > idleTtlMs) {
        shutdownBroker(`idle TTL expired (${Math.floor(idleTtlMs / 60000)}m)`);
        break;
      }
      await new Promise(r => setTimeout(r, BROKER_POLL_COMMANDS_MS));
    }

    blog("Broker shutting down");
    shutdownBroker("stop requested");
  }

  commandLoop();

  // Handle signals gracefully — use unified shutdown
  process.on("SIGTERM", () => { shutdownBroker("SIGTERM"); });
  process.on("SIGINT", () => { shutdownBroker("SIGINT"); });
}


// ============================================================
// Output parsing (for poll)
// ============================================================

/**
 * Parse output.jsonl. Filter to events for the current round.
 * Returns terminal status if round.completed/failed found.
 */
function parseOutput(stateDir, lastLineCount, elapsed, brokerAlive, timeoutVal, state) {
  const outputFile = path.join(stateDir, "output.jsonl");
  const targetRound = state.round || 1;

  let allLines = [];
  if (fs.existsSync(outputFile)) {
    allLines = fs.readFileSync(outputFile, "utf8").split("\n").filter(l => l.trim());
  }

  let roundCompleted = false;
  let roundFailed = false;
  let roundFailedMsg = "";
  let stopReason = null;
  let agentText = "";
  let acpSessionId = state.acp_session_id || null;
  let brokerReady = false;
  let brokerExited = false;
  let brokerFatal = null;

  // Parse all lines for terminal state and agent text
  for (const line of allLines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const t = d.type || "";

    if (t === "broker.ready") {
      brokerReady = true;
      acpSessionId = d.acp_session_id;
    } else if (t === "broker.exited") {
      brokerExited = true;
    } else if (t === "broker.fatal") {
      brokerFatal = d.error;
    } else if (t === "broker.grok_exited") {
      brokerExited = true;
    }

    // Round-specific events
    if (d.round === targetRound) {
      if (t === "round.completed") {
        roundCompleted = true;
        stopReason = d.stop_reason;
      } else if (t === "round.failed") {
        roundFailed = true;
        roundFailedMsg = d.error || "unknown error";
      } else if (t === "acp.agent_message_chunk" && d.text) {
        agentText += d.text;
      } else if (t === "acp.agent_thought_chunk" && d.text) {
        // Thinking text — don't add to main output
      }
    }
  }

  // Build activities from new lines for current round
  const activities = [];
  const newLines = allLines.slice(lastLineCount);
  for (const line of newLines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.round !== targetRound && d.round !== undefined) continue;

    const t = d.type || "";
    if (t === "acp.agent_thought_chunk" && d.text) {
      let txt = d.text;
      if (txt.length > 150) txt = txt.slice(0, 150) + "...";
      activities.push({ time: elapsed, type: "thinking", detail: txt });
    } else if (t === "acp.tool_call") {
      activities.push({ time: elapsed, type: "tool_started", detail: d.title || d.kind || "tool" });
    } else if (t === "acp.tool_call_update") {
      if (d.status_field === "completed") {
        activities.push({ time: elapsed, type: "tool_completed", detail: d.title || d.kind || "tool" });
      }
    }
  }

  const currentRound = targetRound;

  if (brokerFatal) {
    return {
      json: { status: "failed", round: currentRound, elapsed_seconds: elapsed, exit_code: EXIT_TURN_FAILED, error: brokerFatal, output: null, activities },
      acpSessionId, agentText: "", terminal: true,
    };
  }

  if (roundCompleted) {
    atomicWrite(path.join(stateDir, "output.md"), agentText);
    return {
      json: { status: "completed", round: currentRound, elapsed_seconds: elapsed, acp_session_id: acpSessionId, stop_reason: stopReason, output: agentText, activities },
      acpSessionId, agentText, terminal: true,
    };
  }

  if (roundFailed) {
    return {
      json: { status: "failed", round: currentRound, elapsed_seconds: elapsed, exit_code: EXIT_TURN_FAILED, error: `Round failed: ${roundFailedMsg}`, output: agentText || null, activities },
      acpSessionId, agentText, terminal: true,
    };
  }

  if (brokerExited) {
    return {
      json: { status: "failed", round: currentRound, elapsed_seconds: elapsed, exit_code: EXIT_ERROR, error: "Broker process exited unexpectedly", output: agentText || null, activities },
      acpSessionId, agentText, terminal: true,
    };
  }

  if (!brokerAlive) {
    if (timeoutVal > 0 && elapsed >= timeoutVal) {
      return {
        json: { status: "timeout", round: currentRound, elapsed_seconds: elapsed, exit_code: EXIT_TIMEOUT, error: `Timeout after ${timeoutVal}s`, output: agentText || null, activities },
        acpSessionId, agentText, terminal: true,
      };
    }
    return {
      json: { status: "failed", round: currentRound, elapsed_seconds: elapsed, exit_code: EXIT_ERROR, error: "Broker process not alive", output: agentText || null, activities },
      acpSessionId, agentText, terminal: true,
    };
  }

  return {
    json: { status: brokerReady ? "running" : "starting", round: currentRound, elapsed_seconds: elapsed, activities },
    acpSessionId, agentText, terminal: false,
  };
}

// ============================================================
// Subcommands
// ============================================================

function cmdVersion() {
  process.stdout.write(`grok-runner v${GROK_RUNNER_VERSION} (ACP)\n`);
  return EXIT_SUCCESS;
}

function cmdInit(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "skill-name": { type: "string" },
      "working-dir": { type: "string" },
    },
    strict: true,
  });

  const skillName = values["skill-name"];
  const workingDir = values["working-dir"];

  if (!skillName || !workingDir) {
    process.stderr.write("Error: --skill-name and --working-dir are required\n");
    return EXIT_ERROR;
  }

  let resolvedWorkingDir;
  try { resolvedWorkingDir = fs.realpathSync(workingDir); }
  catch { process.stderr.write(`Error: working directory does not exist: ${workingDir}\n`); return EXIT_ERROR; }

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `${skillName}-${today}-`;
  const sessionsBase = path.join(resolvedWorkingDir, ".grok-implement", "sessions");
  fs.mkdirSync(sessionsBase, { recursive: true });

  // REQ-7: 100 attempts with re-scan every 10, hex fallback after exhaustion (concurrent init safe)
  let maxN = 0;
  try {
    for (const d of fs.readdirSync(sessionsBase)) {
      if (d.startsWith(prefix)) {
        const n = parseInt(d.slice(prefix.length), 10);
        if (!isNaN(n) && n > maxN) maxN = n;
      }
    }
  } catch {}

  let sessionDir, sessionId, created = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (attempt > 0 && attempt % 10 === 0) {
      // re-scan to catch concurrent inits
      maxN = 0;
      try {
        for (const d of fs.readdirSync(sessionsBase)) {
          if (d.startsWith(prefix)) {
            const n = parseInt(d.slice(prefix.length), 10);
            if (!isNaN(n) && n > maxN) maxN = n;
          }
        }
      } catch {}
    }
    sessionId = `${prefix}${String(maxN + 1 + attempt).padStart(3, "0")}`;
    sessionDir = path.join(sessionsBase, sessionId);
    try { fs.mkdirSync(sessionDir); created = true; break; }
    catch (e) { if (e.code === "EEXIST") continue; throw e; }
  }

  if (!created) {
    // Fallback with random hex suffix
    const fbN = maxN + 101;
    const hex = crypto.randomBytes(4).toString("hex");
    sessionId = `${prefix}${String(fbN).padStart(3, "0")}-${hex}`;
    sessionDir = path.join(sessionsBase, sessionId);
    try {
      fs.mkdirSync(sessionDir);
      created = true;
    } catch (e) {
      process.stderr.write(`Error: could not reserve session directory after 100 attempts and fallback (${e.message})\n`);
      return EXIT_ERROR;
    }
  }

  if (!created) {
    process.stderr.write("Error: could not reserve session directory\n");
    return EXIT_ERROR;
  }

  fs.mkdirSync(path.join(sessionDir, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "verification"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "issues"), { recursive: true });

  // Initial MD scaffolding (Claude orchestrator fills these in).
  // spec.md is REQUIRED to be written before `start`.
  const specScaffold = [
    "# Spec",
    "",
    "<!-- This file is the immutable contract for the implementation task. -->",
    "<!-- Claude orchestrator MUST fill all sections except OPTIONAL ones BEFORE `start`. -->",
    "",
    "## TASK",
    "<!-- One-line goal -->",
    "",
    "## CONTEXT",
    "<!-- Tech stack, repo conventions, file layout, relevant existing code. -->",
    "",
    "## PARENT_PLAN",
    "<!-- OPTIONAL. If this session is part of a larger plan, paste the overall plan here so Grok has context. -->",
    "",
    "## SCOPE",
    "<!-- IN_SCOPE bullets and OUT_OF_SCOPE bullets. -->",
    "",
    "## REQUIREMENTS",
    "<!-- Functional requirements as bullets. -->",
    "",
    "## CONSTRAINTS",
    "<!-- Non-functional: deps, code style, perf, security. -->",
    "",
    "## ACCEPTANCE_CRITERIA",
    "<!-- REQUIRED. >=1 testable bullet. Format: AC-N: <condition> -->",
    "",
    "## VERIFICATION_COMMANDS",
    "<!-- Shell commands Claude will run independently to verify. e.g. npm test, npm run lint, tsc --noEmit -->",
    "",
    "## NOTES",
    "<!-- OPTIONAL. Hints, gotchas, references. -->",
    "",
  ].join("\n");

  const acceptanceScaffold = [
    "# Acceptance Criteria Status",
    "",
    "<!-- Maintained by Claude after each verification round. -->",
    "<!-- Status legend: [x] passed-and-verified | [/] partial | [!] failed | [ ] not yet attempted -->",
    "<!-- After each round, append a section: -->",
    "",
    "<!-- Example:",
    "## Round N (YYYY-MM-DD HH:MM)",
    "- [x] AC-1: <criterion> — verified by <evidence>",
    "- [!] AC-2: <criterion> — failed because <reason>",
    "-->",
    "",
  ].join("\n");

  const dontBreakScaffold = [
    "# Don't-Break List",
    "",
    "<!-- Maintained by Claude. Things that currently work and MUST keep working in subsequent rounds. -->",
    "<!-- Append items as they become verified. Each item must be testable. -->",
    "",
    "<!-- Example:",
    "- AC-1 passes (round 1)",
    "- File `src/auth.ts` is no longer modified after round 2 (out of scope now)",
    "- `npm run lint` returns 0 warnings",
    "-->",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(sessionDir, "spec.md"), specScaffold, "utf8");
  fs.writeFileSync(path.join(sessionDir, "acceptance.md"), acceptanceScaffold, "utf8");
  fs.writeFileSync(path.join(sessionDir, "dont-break.md"), dontBreakScaffold, "utf8");

  const now = Math.floor(Date.now() / 1000);
  const initialState = {
    session_id: sessionId,
    runner_version: GROK_RUNNER_VERSION,
    skill_name: skillName,
    state_dir: sessionDir,
    working_dir: resolvedWorkingDir,
    round: 0,
    max_rounds: 10,
    created_at: now,
    broker_pid: null,
    grok_pid: null,
    acp_session_id: null,
    timeout: null,
    started_at: null,
    last_line_count: 0,
    stall_count: 0,
    last_poll_at: null,
    spec_locked: false,
  };
  atomicWrite(path.join(sessionDir, "state.json"), JSON.stringify(initialState, null, 2));

  process.stdout.write(`GROK_SESSION:${sessionDir}\n`);
  return EXIT_SUCCESS;
}

function cmdStart(argv) {
  const sessionDir = argv[0];
  if (!sessionDir) { jsonError("Session directory argument required", "INVALID_INPUT"); return EXIT_ERROR; }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      timeout: { type: "string", default: "3600" },
      "stall-threshold": { type: "string", default: "12" },
    },
    strict: true,
  });

  const timeout = parseInt(values.timeout || "3600", 10);
  const stallThreshold = parseInt(values["stall-threshold"] || "12", 10);

  let resolvedSessionDir;
  try { resolvedSessionDir = fs.realpathSync(sessionDir); }
  catch { jsonError(`Session directory does not exist: ${sessionDir}`, "IO_ERROR"); return EXIT_ERROR; }

  let state;
  try { state = readState(resolvedSessionDir); }
  catch (e) { jsonError(`Cannot read state.json: ${e.message}`, "IO_ERROR"); return EXIT_ERROR; }

  if (state.round !== 0) {
    jsonError("Session already started. Use resume for subsequent rounds.", "PRECONDITION_FAILED");
    return EXIT_ERROR;
  }

  // Validate spec.md has been filled in (required sections + at least 1 AC)
  const specPath = path.join(resolvedSessionDir, "spec.md");
  if (!fs.existsSync(specPath)) {
    jsonError("spec.md not found in session dir. Re-run init.", "SPEC_MISSING");
    return EXIT_ERROR;
  }
  const specContent = fs.readFileSync(specPath, "utf8");
  const specCheck = validateSpec(specContent);
  if (!specCheck.ok) {
    jsonError(`spec.md is incomplete: ${specCheck.error}. Edit spec.md before calling start.`, "SPEC_INCOMPLETE");
    return EXIT_ERROR;
  }

  // Check grok in PATH
  const whichCmd = IS_WIN ? "where" : "which";
  const probe = spawnSync(whichCmd, ["grok"], { encoding: "utf8" });
  if (probe.status !== 0) {
    jsonError("grok CLI not found in PATH. Install from https://docs.x.ai/build/overview", "GROK_NOT_FOUND");
    return EXIT_GROK_NOT_FOUND;
  }

  // Read prompt from stdin
  const promptFile = path.join(resolvedSessionDir, "prompt.txt");
  const stdinContent = readStdinSync();
  let prompt;
  if (stdinContent.trim()) {
    prompt = stdinContent;
    fs.writeFileSync(promptFile, prompt, "utf8");
  } else if (fs.existsSync(promptFile)) {
    prompt = fs.readFileSync(promptFile, "utf8");
  }

  if (!prompt || !prompt.trim()) {
    jsonError("No prompt provided", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  fs.writeFileSync(path.join(resolvedSessionDir, "prompts", "round-001.txt"), prompt, "utf8");

  const now = Math.floor(Date.now() / 1000);

  // Update state with round=1 BEFORE spawning broker
  updateState(resolvedSessionDir, {
    round: 1, timeout, started_at: now,
    last_line_count: 0, stall_count: 0, last_poll_at: 0,
    stall_threshold: stallThreshold, stall_recovery_count: 0,
    cancel_requested_round: 0, last_poll_responded_at: 0,
  });

  writeRounds(resolvedSessionDir, [{
    round: 1, started_at: now, completed_at: null,
    elapsed_seconds: null, status: "running",
  }]);

  // Append first command to commands.jsonl
  appendCommand(resolvedSessionDir, {
    action: "prompt",
    round: 1,
    text: prompt,
    timeout_ms: timeout * 1000,
  });

  // Spawn broker (detached)
  const brokerLogOut = fs.openSync(path.join(resolvedSessionDir, "broker.stdout.log"), "w");
  const brokerLogErr = fs.openSync(path.join(resolvedSessionDir, "broker.stderr.log"), "w");

  const broker = spawn(process.execPath, [__filename, "_broker", resolvedSessionDir], {
    stdio: ["ignore", brokerLogOut, brokerLogErr],
    detached: true,
    cwd: state.working_dir,
    ...(IS_WIN ? { windowsHide: true } : {}),
  });
  broker.unref();

  fs.closeSync(brokerLogOut);
  fs.closeSync(brokerLogErr);

  if (!broker.pid) {
    jsonError("Failed to spawn broker process", "LAUNCH_FAILED");
    return EXIT_ERROR;
  }

  updateState(resolvedSessionDir, { broker_pid: broker.pid });

  // Wait briefly for broker to write broker.ready or broker.fatal
  const startWait = Date.now();
  let brokerReady = false;
  let brokerError = null;
  while (Date.now() - startWait < BROKER_STARTUP_TIMEOUT_MS) {
    syncSleep(500);
    const outputFile = path.join(resolvedSessionDir, "output.jsonl");
    if (fs.existsSync(outputFile)) {
      const lines = fs.readFileSync(outputFile, "utf8").split("\n").filter(l => l.trim());
      for (const line of lines) {
        let d; try { d = JSON.parse(line); } catch { continue; }
        if (d.type === "broker.ready") { brokerReady = true; break; }
        if (d.type === "broker.fatal") { brokerError = d.error; break; }
      }
    }
    if (brokerReady || brokerError) break;
    if (!isAlive(broker.pid)) { brokerError = "Broker process died during startup"; break; }
  }

  if (brokerError) {
    jsonError(`Broker failed to start: ${brokerError}`, "BROKER_FAILED");
    return EXIT_ERROR;
  }

  if (!brokerReady) {
    jsonError(`Broker did not become ready within ${BROKER_STARTUP_TIMEOUT_MS}ms`, "BROKER_TIMEOUT");
    return EXIT_ERROR;
  }

  jsonOut({ status: "started", session_dir: resolvedSessionDir, round: 1, broker_pid: broker.pid });
  return EXIT_SUCCESS;
}

function cmdResume(argv) {
  const sessionDir = argv[0];
  if (!sessionDir) { jsonError("Session directory argument required", "INVALID_INPUT"); return EXIT_ERROR; }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      timeout: { type: "string", default: "3600" },
    },
    strict: true,
  });
  const timeout = parseInt(values.timeout || "3600", 10);

  let resolvedSessionDir;
  try { resolvedSessionDir = fs.realpathSync(sessionDir); }
  catch { jsonError(`Session directory does not exist: ${sessionDir}`, "IO_ERROR"); return EXIT_ERROR; }

  let state;
  try { state = readState(resolvedSessionDir); }
  catch (e) { jsonError(`Cannot read state.json: ${e.message}`, "IO_ERROR"); return EXIT_ERROR; }

  if (!state.broker_pid || !isAlive(state.broker_pid)) {
    jsonError("Broker not alive — cannot resume. Start a new session.", "BROKER_DEAD");
    return EXIT_ERROR;
  }

  // REQ-4: gate on broker.state.json (prevents overlapping rounds / resume during cancel recovery)
  const idleCheck = assertBrokerIdle(resolvedSessionDir);
  if (!idleCheck.ok) {
    jsonError(idleCheck.message, idleCheck.code);
    return EXIT_ERROR;
  }

  // Enforce max_rounds limit
  const maxRounds = state.max_rounds || 10;
  if ((state.round || 0) >= maxRounds) {
    jsonError(`Reached max_rounds=${maxRounds}. Finalize and report partial results.`, "MAX_ROUNDS_REACHED");
    return EXIT_ERROR;
  }

  // Verify previous round is done
  const rounds = readRounds(resolvedSessionDir);
  if (rounds.length > 0) {
    const last = rounds[rounds.length - 1];
    if (last.status === "running") {
      jsonError("Previous round still running — poll first", "ROUND_STILL_RUNNING");
      return EXIT_ERROR;
    }
  }

  // Read prompt from stdin
  const promptFile = path.join(resolvedSessionDir, "prompt.txt");
  const stdinContent = readStdinSync();
  let prompt;
  if (stdinContent.trim()) {
    prompt = stdinContent;
    fs.writeFileSync(promptFile, prompt, "utf8");
  } else if (fs.existsSync(promptFile)) {
    prompt = fs.readFileSync(promptFile, "utf8");
  }

  if (!prompt || !prompt.trim()) { jsonError("No prompt provided", "INVALID_INPUT"); return EXIT_ERROR; }

  const newRound = (state.round || 0) + 1;
  fs.writeFileSync(path.join(resolvedSessionDir, "prompts", `round-${String(newRound).padStart(3, "0")}.txt`), prompt, "utf8");

  // Clear stale terminal cache
  try { fs.unlinkSync(path.join(resolvedSessionDir, "final.txt")); } catch {}
  try { fs.unlinkSync(path.join(resolvedSessionDir, "output.md")); } catch {}

  // Snapshot current line count so poll only sees new events for this round
  const outputFile = path.join(resolvedSessionDir, "output.jsonl");
  let lineCount = 0;
  if (fs.existsSync(outputFile)) {
    lineCount = fs.readFileSync(outputFile, "utf8").split("\n").filter(l => l.trim()).length;
  }

  const now = Math.floor(Date.now() / 1000);
  updateState(resolvedSessionDir, {
    round: newRound, timeout, started_at: now,
    last_line_count: lineCount, stall_count: 0, last_poll_at: 0,
    last_output_at: now, cancel_requested_round: 0, last_poll_responded_at: 0,
  });

  rounds.push({
    round: newRound, started_at: now, completed_at: null,
    elapsed_seconds: null, status: "running",
  });
  writeRounds(resolvedSessionDir, rounds);

  // Send command to broker
  appendCommand(resolvedSessionDir, {
    action: "prompt",
    round: newRound,
    text: prompt,
    timeout_ms: timeout * 1000,
  });

  jsonOut({ status: "started", session_dir: resolvedSessionDir, round: newRound, acp_session_id: state.acp_session_id });
  return EXIT_SUCCESS;
}


async function cmdPoll(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "min-interval": { type: "string", default: "120" },
    },
    allowPositionals: true,
    strict: false,
  });

  const rawMinInterval = values["min-interval"];
  const parsedInterval = Number.parseInt(rawMinInterval, 10);
  if (!Number.isFinite(parsedInterval) || parsedInterval < 0) {
    jsonError("Invalid --min-interval; expected non-negative integer seconds", "INVALID_INPUT");
    return EXIT_ERROR;
  }
  const minInterval = parsedInterval;
  const stateDirArg = positionals[0];
  if (!stateDirArg) { jsonError("State directory argument required", "INVALID_INPUT"); return EXIT_ERROR; }

  let stateDir;
  try { stateDir = fs.realpathSync(stateDirArg); }
  catch { jsonError("Invalid state directory", "INVALID_INPUT"); return EXIT_ERROR; }

  // Check cached final result — always return immediately
  const finalFile = path.join(stateDir, "final.txt");
  if (fs.existsSync(finalFile)) {
    const cached = fs.readFileSync(finalFile, "utf8");
    process.stdout.write(cached);
    if (!cached.endsWith("\n")) process.stdout.write("\n");
    return EXIT_SUCCESS;
  }

  const state = readState(stateDir);
  // Anchor the interval to the last poll response; on the first poll of a round
  // there is no prior response, so fall back to the round start so the first
  // poll also respects the interval instead of returning immediately.
  const anchor = state.last_poll_responded_at || state.started_at || Math.floor(Date.now() / 1000);
  const sinceAnchor = Math.floor(Date.now() / 1000) - anchor;

  // Long-poll: block until the interval elapses. Return only when the interval
  // is up, the session finishes (final.txt), or the broker dies — NOT on every
  // new output line (Grok streams continuously, which would defeat the wait).
  if (minInterval > 0 && sinceAnchor < minInterval) {
    const deadline = anchor + minInterval;

    while (Math.floor(Date.now() / 1000) < deadline) {
      // Session finished — return the cached result immediately
      if (fs.existsSync(finalFile)) break;

      // Broker died — result will be terminal, no point waiting longer
      const brokerPid = readState(stateDir).broker_pid || 0;
      if (brokerPid && !isAlive(brokerPid)) break;

      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Re-read state after potential wait
  const freshState = readState(stateDir);
  const brokerPid = freshState.broker_pid || 0;
  const timeoutVal = freshState.timeout || 3600;
  const startedAt = freshState.started_at || Math.floor(Date.now() / 1000);
  const lastLineCount = freshState.last_line_count || 0;
  const stallCount = freshState.stall_count || 0;
  const stallThreshold = freshState.stall_threshold || 12;

  // Re-check final.txt (may have appeared during wait)
  if (fs.existsSync(finalFile)) {
    const cached = fs.readFileSync(finalFile, "utf8");
    process.stdout.write(cached);
    if (!cached.endsWith("\n")) process.stdout.write("\n");
    return EXIT_SUCCESS;
  }

  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - startedAt;
  const brokerAlive = isAlive(brokerPid);

  const outputFile = path.join(stateDir, "output.jsonl");
  let currentLineCount = 0;
  if (fs.existsSync(outputFile)) {
    currentLineCount = fs.readFileSync(outputFile, "utf8").split("\n").filter(l => l.trim()).length;
  }

  const newStallCount = currentLineCount === lastLineCount ? stallCount + 1 : 0;
  const lastOutputAt = currentLineCount === lastLineCount ? (freshState.last_output_at || startedAt) : now;

  let result = parseOutput(stateDir, lastLineCount, elapsed, brokerAlive, timeoutVal, freshState);

  if (!result.terminal) {
    if (elapsed >= timeoutVal) {
      result = {
        json: { status: "timeout", round: freshState.round || 1, elapsed_seconds: elapsed, exit_code: EXIT_TIMEOUT, error: `Timeout after ${timeoutVal}s`, output: result.agentText || null, activities: result.json.activities },
        acpSessionId: result.acpSessionId, agentText: result.agentText, terminal: true,
      };
    } else if (newStallCount >= stallThreshold && brokerAlive) {
      result = {
        json: {
          status: "stalled", round: freshState.round || 1, elapsed_seconds: elapsed,
          exit_code: EXIT_STALLED, error: `No new output for ~${Math.round((now - lastOutputAt) / 60)} minutes`,
          output: result.agentText || null, recoverable: true,
          activities: result.json.activities,
        },
        acpSessionId: result.acpSessionId, agentText: result.agentText, terminal: true,
      };
    }
  }

  // REQ-5: when poll declares terminal (timeout/stalled), instruct broker to cancel in-flight prompt
  if (result.terminal && (result.json.status === "timeout" || result.json.status === "stalled")) {
    const currentRound = freshState.round || 1;
    if (!freshState.cancel_requested_round || freshState.cancel_requested_round < currentRound) {
      updateState(stateDir, { cancel_requested_round: currentRound });
      try { appendCommand(stateDir, { action: "cancel", round: currentRound }); } catch {}
    }
  }

  if (result.terminal) {
    const rounds = readRounds(stateDir);
    if (rounds.length > 0) {
      const cur = rounds[rounds.length - 1];
      if (cur.status === "running") {
        cur.status = result.json.status;
        cur.completed_at = now;
        cur.elapsed_seconds = now - cur.started_at;
        if (result.json.stop_reason) cur.stop_reason = result.json.stop_reason;
        writeRounds(stateDir, rounds);
      }
    }
    atomicWrite(finalFile, JSON.stringify(result.json));
  }

  if (result.acpSessionId && result.acpSessionId !== freshState.acp_session_id) {
    updateState(stateDir, { acp_session_id: result.acpSessionId });
  }

  updateState(stateDir, {
    last_line_count: currentLineCount,
    stall_count: newStallCount,
    last_output_at: lastOutputAt,
    last_poll_at: now,
    last_poll_responded_at: now,
  });

  jsonOut(result.json);
  return EXIT_SUCCESS;
}

function cmdStop(argv) {
  const stateDirArg = argv[0];
  if (!stateDirArg) { jsonError("State directory argument required", "INVALID_INPUT"); return EXIT_ERROR; }

  let stateDir;
  try { stateDir = fs.realpathSync(stateDirArg); }
  catch { jsonError("Invalid state directory", "INVALID_INPUT"); return EXIT_ERROR; }

  let state;
  try { state = readState(stateDir); } catch { state = {}; }

  // Send stop command to broker (if alive)
  if (state.broker_pid && isAlive(state.broker_pid)) {
    try { appendCommand(stateDir, { action: "stop" }); } catch {}
    // Wait briefly for broker to exit gracefully
    const startWait = Date.now();
    while (Date.now() - startWait < 5000 && isAlive(state.broker_pid)) {
      syncSleep(250);
    }
    // Force kill if still alive
    if (isAlive(state.broker_pid)) {
      killTree(state.broker_pid);
    }
  }

  // Mark running rounds as stopped
  const rounds = readRounds(stateDir);
  const now = Math.floor(Date.now() / 1000);
  let modified = false;
  for (const r of rounds) {
    if (r.status === "running") {
      r.status = "stopped";
      r.completed_at = now;
      r.elapsed_seconds = now - r.started_at;
      modified = true;
    }
  }
  if (modified) writeRounds(stateDir, rounds);

  jsonOut({ status: "stopped", session_dir: stateDir });
  return EXIT_SUCCESS;
}

function cmdFinalize(argv) {
  const sessionDir = argv[0];
  if (!sessionDir) { jsonError("Session directory argument required", "INVALID_INPUT"); return EXIT_ERROR; }

  let resolvedSessionDir;
  try { resolvedSessionDir = fs.realpathSync(sessionDir); }
  catch { jsonError(`Session directory does not exist: ${sessionDir}`, "IO_ERROR"); return EXIT_ERROR; }

  const rounds = readRounds(resolvedSessionDir);
  const state = readState(resolvedSessionDir);

  const summary = {
    session_id: state.session_id,
    skill_name: state.skill_name,
    acp_session_id: state.acp_session_id,
    total_rounds: rounds.length,
    final_status: rounds.length > 0 ? rounds[rounds.length - 1].status : "unknown",
    total_elapsed: rounds.reduce((s, r) => s + (r.elapsed_seconds || 0), 0),
    rounds: rounds.map(r => ({ round: r.round, status: r.status, elapsed: r.elapsed_seconds, stop_reason: r.stop_reason })),
  };

  atomicWrite(path.join(resolvedSessionDir, "meta.json"), JSON.stringify(summary, null, 2));

  jsonOut({ status: "finalized", ...summary });
  return EXIT_SUCCESS;
}

// ============================================================
// Render (template engine)
// ============================================================

const TEMPLATE_MAP = {
  "grok-implement": {
    "implement": "Implementation Prompt",
    "revise": "Revision Prompt",
    "clarify": "Clarification Prompt",
    "reconcile": "Reconcile Prompt",
  },
};

function extractTemplateSection(promptsMd, targetHeading) {
  // REQ-9: strict line-based fence parser.
  // - Stop "next heading" search only for ## that appear *outside* the template fence.
  // - Inner ```...``` (examples) temporarily "in fence" so their ## are not treated as section end.
  // - Return literal content between the outer opening ``` and its matching closer.
  const lines = promptsMd.split("\n");
  let i = 0;
  // Find target heading (must be outside any fence)
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^## (.+)$/);
    if (m && m[1].trim() === targetHeading) {
      i++; // past heading
      break;
    }
  }
  if (i >= lines.length) return null;

  // Find the opening fence for this template
  let openIdx = -1;
  for (; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      openIdx = i;
      i++;
      break;
    }
  }
  if (openIdx === -1) return null;

  // Find the outer closing fence.
  // Templates are separated by `---` lines. The outer close is the LAST ```
  // before the next `---` separator (or EOF). This handles nested inner fences.
  let separatorIdx = lines.length;
  for (let j = i; j < lines.length; j++) {
    if (/^---\s*$/.test(lines[j])) { separatorIdx = j; break; }
  }
  let closeIdx = -1;
  for (let j = separatorIdx - 1; j > openIdx; j--) {
    if (/^```\s*$/.test(lines[j])) { closeIdx = j; break; }
  }

  if (closeIdx <= openIdx) return null;

  const section = lines.slice(openIdx + 1, closeIdx);
  return section.join("\n");
}

function cmdRender(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      skill: { type: "string" },
      template: { type: "string" },
      "skills-dir": { type: "string" },
    },
    strict: true,
  });

  const { skill, template: templateName } = values;
  const skillsDir = values["skills-dir"];

  if (!skill || !templateName || !skillsDir) {
    process.stderr.write("Error: --skill, --template, and --skills-dir are required\n");
    return EXIT_ERROR;
  }

  const skillTemplates = TEMPLATE_MAP[skill];
  if (!skillTemplates) { jsonError(`Unknown skill: ${skill}`, "UNKNOWN_SKILL"); return EXIT_ERROR; }

  const targetHeading = skillTemplates[templateName];
  if (!targetHeading) { jsonError(`Template '${templateName}' not found for skill '${skill}'`, "TEMPLATE_NOT_FOUND"); return EXIT_ERROR; }

  const promptsPath = path.join(skillsDir, skill, "references", "prompts.md");
  let promptsMd;
  try { promptsMd = fs.readFileSync(promptsPath, "utf8"); }
  catch (e) { jsonError(`Cannot read prompts.md: ${e.message}`, "IO_ERROR"); return EXIT_ERROR; }

  const template = extractTemplateSection(promptsMd, targetHeading);
  if (!template) { jsonError(`Heading '${targetHeading}' not found`, "TEMPLATE_NOT_FOUND"); return EXIT_ERROR; }

  let placeholders = {};
  const stdinContent = readStdinSync().trim();
  if (stdinContent) {
    try { placeholders = JSON.parse(stdinContent); }
    catch (e) { jsonError(`Invalid JSON on stdin: ${e.message}`, "INVALID_INPUT"); return EXIT_ERROR; }
  }

  if (!placeholders.OUTPUT_FORMAT) {
    const ofPath = path.join(skillsDir, skill, "references", "output-format.md");
    if (fs.existsSync(ofPath)) {
      const ofContent = fs.readFileSync(ofPath, "utf8");
      const m = ofContent.match(/```(?:markdown)?\n([\s\S]*?)```/);
      if (m) placeholders.OUTPUT_FORMAT = m[1].trim();
    }
  }

  const rendered = template.replace(/\{([A-Z][A-Z_0-9]{1,})\}/g, (match, name) => {
    if (placeholders[name] !== undefined) {
      let val = String(placeholders[name]);
      if (val.includes("```")) {
        process.stderr.write(`Warning: placeholder ${name} contained \`\`\`; escaping to ʼʼʼ for fence safety\n`);
        val = val.replaceAll("```", "ʼʼʼ");
      }
      return val;
    }
    return "";
  });

  process.stdout.write(rendered);
  return EXIT_SUCCESS;
}

// ============================================================
// Spec validation
// ============================================================

function extractSection(md, heading) {
  const lines = md.split("\n");
  const out = [];
  let inSection = false;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (inSection) break;
      if (m[1].trim() === heading) { inSection = true; continue; }
    }
    if (inSection) out.push(line);
  }
  // Strip HTML comments and trim
  return out.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
}

function validateSpec(specMd) {
  const requiredSections = ["TASK", "CONTEXT", "SCOPE", "REQUIREMENTS", "CONSTRAINTS", "ACCEPTANCE_CRITERIA", "VERIFICATION_COMMANDS"];
  for (const sec of requiredSections) {
    const content = extractSection(specMd, sec);
    if (!content) {
      return { ok: false, error: `section '${sec}' is empty` };
    }
  }
  // ACCEPTANCE_CRITERIA must have at least one bullet with AC-N: (or . ) - ) with non-empty content after
  const acContent = extractSection(specMd, "ACCEPTANCE_CRITERIA");
  const acLines = acContent.split("\n").filter(l => /^\s*[-*]\s*AC-?\d+\s*[:.\)\-]\s*\S+/i.test(l));
  if (acLines.length === 0) {
    return { ok: false, error: "ACCEPTANCE_CRITERIA must have at least 1 bullet starting with 'AC-N: ...'" };
  }
  return { ok: true, ac_count: acLines.length };
}

function parseAcceptanceMd(mdContent) {
  // Strip HTML comments so example markers in scaffolding don't get counted
  const stripped = mdContent.replace(/<!--[\s\S]*?-->/g, "");
  // Returns latest round AC status counts: { passed, partial, failed, pending, latest_round }
  const sections = stripped.split(/^## Round /m).slice(1);
  if (sections.length === 0) return { passed: 0, partial: 0, failed: 0, pending: 0, latest_round: 0 };
  const last = sections[sections.length - 1];
  const headerMatch = last.match(/^(\d+)/);
  const latestRound = headerMatch ? parseInt(headerMatch[1], 10) : 0;
  let passed = 0, partial = 0, failed = 0, pending = 0;
  for (const line of last.split("\n")) {
    const m = line.match(/^\s*[-*]\s*\[([x\/!\s])\]/);
    if (!m) continue;
    const c = m[1];
    if (c === "x") passed++;
    else if (c === "/") partial++;
    else if (c === "!") failed++;
    else pending++;
  }
  return { passed, partial, failed, pending, latest_round: latestRound };
}

// ============================================================
// info / list subcommands
// ============================================================

function cmdInfo(argv) {
  const sessionDirArg = argv[0];
  if (!sessionDirArg) { jsonError("Session directory argument required", "INVALID_INPUT"); return EXIT_ERROR; }

  let sessionDir;
  try { sessionDir = fs.realpathSync(sessionDirArg); }
  catch { jsonError("Invalid session directory", "INVALID_INPUT"); return EXIT_ERROR; }

  let state;
  try { state = readState(sessionDir); }
  catch (e) { jsonError(`Cannot read state.json: ${e.message}`, "IO_ERROR"); return EXIT_ERROR; }

  const rounds = readRounds(sessionDir);
  const brokerAlive = isAlive(state.broker_pid || 0);
  const grokAlive = isAlive(state.grok_pid || 0);

  // Read spec sections
  const specPath = path.join(sessionDir, "spec.md");
  let spec = { task: null, valid: false };
  if (fs.existsSync(specPath)) {
    const specContent = fs.readFileSync(specPath, "utf8");
    const v = validateSpec(specContent);
    spec = {
      valid: v.ok,
      validation_error: v.ok ? null : v.error,
      ac_count: v.ac_count || 0,
      task: extractSection(specContent, "TASK") || null,
      scope: extractSection(specContent, "SCOPE") || null,
      requirements: extractSection(specContent, "REQUIREMENTS") || null,
      acceptance_criteria: extractSection(specContent, "ACCEPTANCE_CRITERIA") || null,
      verification_commands: extractSection(specContent, "VERIFICATION_COMMANDS") || null,
      parent_plan: extractSection(specContent, "PARENT_PLAN") || null,
    };
  }

  // Acceptance status
  let acceptance = { passed: 0, partial: 0, failed: 0, pending: 0, latest_round: 0 };
  const accPath = path.join(sessionDir, "acceptance.md");
  if (fs.existsSync(accPath)) {
    acceptance = parseAcceptanceMd(fs.readFileSync(accPath, "utf8"));
  }

  // List output / verification / issues files
  const listFiles = (sub) => {
    const dir = path.join(sessionDir, sub);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => !f.startsWith(".")).sort().map(f => path.join(dir, f));
  };

  const info = {
    session_id: state.session_id,
    session_dir: sessionDir,
    skill_name: state.skill_name,
    working_dir: state.working_dir,
    current_round: state.round || 0,
    max_rounds: state.max_rounds || 10,
    broker_alive: brokerAlive,
    grok_alive: grokAlive,
    acp_session_id: state.acp_session_id,
    spec,
    acceptance,
    rounds: rounds.map(r => ({ round: r.round, status: r.status, elapsed: r.elapsed_seconds, stop_reason: r.stop_reason })),
    files: {
      spec: path.join(sessionDir, "spec.md"),
      acceptance: path.join(sessionDir, "acceptance.md"),
      dont_break: path.join(sessionDir, "dont-break.md"),
      prompts: listFiles("prompts"),
      outputs: listFiles("outputs"),
      verification: listFiles("verification"),
      issues: listFiles("issues"),
    },
  };

  jsonOut(info);
  return EXIT_SUCCESS;
}

function cmdList(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "working-dir": { type: "string" },
      "skill-name": { type: "string", default: "grok-implement" },
    },
    strict: true,
  });

  const workingDir = values["working-dir"];
  const skillName = values["skill-name"];

  if (!workingDir) {
    process.stderr.write("Error: --working-dir is required\n");
    return EXIT_ERROR;
  }

  let resolvedWorkingDir;
  try { resolvedWorkingDir = fs.realpathSync(workingDir); }
  catch { jsonError(`Working dir does not exist: ${workingDir}`, "IO_ERROR"); return EXIT_ERROR; }

  const sessionsBase = path.join(resolvedWorkingDir, ".grok-implement", "sessions");
  if (!fs.existsSync(sessionsBase)) {
    jsonOut({ working_dir: resolvedWorkingDir, sessions: [] });
    return EXIT_SUCCESS;
  }

  const all = fs.readdirSync(sessionsBase).filter(f => {
    if (skillName && !f.startsWith(skillName + "-")) return false;
    return fs.statSync(path.join(sessionsBase, f)).isDirectory();
  });

  const sessions = [];
  for (const id of all.sort()) {
    const dir = path.join(sessionsBase, id);
    let state;
    try { state = readState(dir); } catch { continue; }
    const acc = fs.existsSync(path.join(dir, "acceptance.md"))
      ? parseAcceptanceMd(fs.readFileSync(path.join(dir, "acceptance.md"), "utf8"))
      : { passed: 0, partial: 0, failed: 0, pending: 0 };
    let task = null;
    if (fs.existsSync(path.join(dir, "spec.md"))) {
      task = extractSection(fs.readFileSync(path.join(dir, "spec.md"), "utf8"), "TASK") || null;
    }
    sessions.push({
      session_id: id,
      session_dir: dir,
      task,
      current_round: state.round || 0,
      max_rounds: state.max_rounds || 10,
      broker_alive: isAlive(state.broker_pid || 0),
      acceptance: acc,
      created_at: state.created_at,
    });
  }

  jsonOut({ working_dir: resolvedWorkingDir, sessions });
  return EXIT_SUCCESS;
}

function cmdStatus(argv) {
  const stateDirArg = argv[0];
  if (!stateDirArg) { jsonError("State directory argument required", "INVALID_INPUT"); return EXIT_ERROR; }

  let stateDir;
  try { stateDir = fs.realpathSync(stateDirArg); }
  catch { jsonError("Invalid state directory", "INVALID_INPUT"); return EXIT_ERROR; }

  const state = readState(stateDir);
  const rounds = readRounds(stateDir);
  const brokerAlive = isAlive(state.broker_pid || 0);
  const grokAlive = isAlive(state.grok_pid || 0);

  jsonOut({
    session_id: state.session_id,
    round: state.round,
    broker_alive: brokerAlive,
    grok_alive: grokAlive,
    acp_session_id: state.acp_session_id,
    rounds: rounds.map(r => ({ round: r.round, status: r.status })),
  });
  return EXIT_SUCCESS;
}

function cmdCancel(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      wait: { type: "boolean", default: true },
      timeout: { type: "string", default: "30000" },
      help: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.help || argv.includes("--help") || !positionals[0]) {
    process.stdout.write("Usage: grok-runner cancel <session-dir> [--wait=true] [--timeout=30000]\n");
    process.stdout.write("  Appends cancel command to broker. With --wait (default), polls for round.cancelled event.\n");
    return EXIT_SUCCESS;
  }

  const sessionDirArg = positionals[0];
  let stateDir;
  try { stateDir = fs.realpathSync(sessionDirArg); }
  catch { jsonError("Invalid session directory", "INVALID_INPUT"); return EXIT_ERROR; }

  let state;
  try { state = readState(stateDir); } catch (e) { jsonError(`Cannot read state: ${e.message}`, "IO_ERROR"); return EXIT_ERROR; }

  if (!state.broker_pid || !isAlive(state.broker_pid)) {
    jsonError("Broker not alive — cannot cancel. (Use stop or start a fresh session.)", "BROKER_DEAD");
    return EXIT_ERROR;
  }

  const round = state.round || 1;
  appendCommand(stateDir, { action: "cancel", round });

  const result = { status: "cancel-issued", session_dir: stateDir, round, wait: values.wait };

  if (!values.wait) {
    jsonOut(result);
    return EXIT_SUCCESS;
  }

  // Wait for round.cancelled in output.jsonl
  const timeoutMs = parseInt(values.timeout, 10) || 30000;
  const outputFile = path.join(stateDir, "output.jsonl");
  const start = Date.now();
  let found = null;
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(outputFile)) {
      const lines = fs.readFileSync(outputFile, "utf8").split("\n").filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const d = JSON.parse(lines[i]);
          if (d.type === "round.cancelled" && d.round === round) {
            found = d;
            break;
          }
        } catch {}
      }
      if (found) break;
    }
    syncSleep(250);
  }

  if (found) {
    jsonOut({ ...result, status: "cancelled", mode: found.mode, event: found });
    return EXIT_SUCCESS;
  }

  jsonOut({ ...result, status: "cancel-issued", note: "timeout waiting for round.cancelled event" });
  return EXIT_TIMEOUT;
}

// ============================================================
// Main dispatch (gated so the module can be imported by tests without side effects)
// ============================================================

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    // Use realpath to resolve symlinks (e.g. macOS /var -> /private/var)
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  const subcommand = process.argv[2];
  const subArgs = process.argv.slice(3);

  (async () => {
    let exitCode;
    switch (subcommand) {
      case "version": exitCode = cmdVersion(); break;
      case "init": exitCode = cmdInit(subArgs); break;
      case "info": exitCode = cmdInfo(subArgs); break;
      case "list": exitCode = cmdList(subArgs); break;
      case "start": exitCode = cmdStart(subArgs); break;
      case "resume": exitCode = cmdResume(subArgs); break;
      case "poll": exitCode = await cmdPoll(subArgs); break;
      case "stop": exitCode = cmdStop(subArgs); break;
      case "finalize": exitCode = cmdFinalize(subArgs); break;
      case "render": exitCode = cmdRender(subArgs); break;
      case "status": exitCode = cmdStatus(subArgs); break;
      case "cancel": exitCode = cmdCancel(subArgs); break;
      case "_broker": await cmdBroker(subArgs); return;
      default:
        process.stderr.write(`grok-runner: unknown subcommand '${subcommand}'\nAvailable: version, init, info, list, start, resume, poll, stop, finalize, render, cancel, status\n`);
        exitCode = EXIT_ERROR;
    }
    if (exitCode !== undefined) process.exit(exitCode);
  })();
}

// Export pure helpers for smoke tests (CLI behavior unchanged when run as main)
export {
  extractTemplateSection,
  validateSpec,
  assertBrokerIdle,
};
