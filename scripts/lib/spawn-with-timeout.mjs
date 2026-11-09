#!/usr/bin/env node
// Bounded-runtime process supervisor for long-running helper scripts.
//
//   node scripts/lib/spawn-with-timeout.mjs \
//     --timeout <sec> --grace <sec> --status <file> -- <cmd> [args...]
//
// WHY THIS EXISTS (replaces the previous shell `sleep & kill -9 $pid` pattern):
//
//   1. PROCESS GROUP, NOT PID. A reviewed CLI spawns descendants (node, network helpers, its own
//      sleeps). `kill -9 <shell-pid>` reaped only the immediate child and orphaned the rest, which
//      kept running after the wrapper had "timed out". We spawn `detached: true`
//      so the child becomes a process-group leader, then signal the whole group with kill(-pgid).
//
//   2. TERM BEFORE KILL. SIGTERM first, a short grace period, SIGKILL only if the group survives.
//      A reviewer that can flush its output file on TERM produces partial findings instead of none.
//
//   3. EXPLICIT TIMEOUT STATE. The old wrapper inferred "timed out" from exit code 137, but 137 is
//      just 128+SIGKILL — any natural OOM kill or external `kill -9` produces it too. Timeout is a
//      fact this supervisor knows first-hand, so it records it in a status file the caller reads
//      instead of guessing from an exit code.
//
// Status file (shell-greppable key=value, one per line):
//   timed_out=0|1     1 only when THIS supervisor fired the deadline
//   exit_code=<n>     child exit code, or -1 if it died from a signal
//   signal=<NAME|->   terminating signal name, or '-'
//   duration_ms=<n>
//
// Own exit code: the child's exit code; 128+signum if the child died from a signal; 124 on timeout
// (GNU timeout convention). Callers MUST use the status file — not 124 — to detect a timeout, since
// a child may legitimately exit 124 on its own.

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

function usage(msg) {
  process.stderr.write(`spawn-with-timeout: ${msg}\n`)
  process.stderr.write('usage: spawn-with-timeout.mjs --timeout <sec> --grace <sec> --status <file> -- <cmd> [args...]\n')
  process.exit(2)
}

/** PURE: parse argv into options + the command vector after `--`. Exported shape kept simple for tests. */
export function parseArgs(argv) {
  const opts = { timeout: null, grace: 5, status: null, cmd: [] }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { opts.cmd = argv.slice(i + 1); break }
    if (a === '--timeout') { opts.timeout = argv[++i]; continue }
    if (a === '--grace') { opts.grace = argv[++i]; continue }
    if (a === '--status') { opts.status = argv[++i]; continue }
    return { error: `unknown argument: ${a}` }
  }
  if (opts.cmd.length === 0) return { error: 'no command given after --' }
  const t = Number(opts.timeout)
  if (!Number.isInteger(t) || t <= 0) return { error: `--timeout must be a positive integer (got ${opts.timeout})` }
  const g = Number(opts.grace)
  if (!Number.isInteger(g) || g < 0) return { error: `--grace must be a non-negative integer (got ${opts.grace})` }
  return { opts: { timeoutS: t, graceS: g, status: opts.status, cmd: opts.cmd } }
}

const parsed = parseArgs(process.argv.slice(2))
if (parsed.error) usage(parsed.error)
const { timeoutS, graceS, status, cmd } = parsed.opts

const startedAt = Date.now()
let timedOut = false
let settled = false
// On a timeout the supervisor must not exit until SIGKILL escalation has actually run,
// otherwise the leader's prompt exit lets the process end while descendants survive.
let escalationDone = false
let pendingExit = null

const child = spawn(cmd[0], cmd.slice(1), {
  stdio: 'inherit',
  // Own process group: lets us signal every descendant, not just the immediate child.
  detached: true,
})

/** Signal the child's whole process group; fall back to the bare pid if the group is already gone. */
function signalGroup(sig) {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, sig)
  } catch {
    try { process.kill(child.pid, sig) } catch { /* already reaped */ }
  }
}

// Held so the escalation timer keeps the event loop alive until it fires. It is deliberately NOT
// cleared on child exit (see finish()), which is the whole point of the fix.
let killTimer = null
void killTimer
const deadline = setTimeout(() => {
  timedOut = true
  signalGroup('SIGTERM')
  // Escalate if the GROUP is still alive after the grace period.
  //
  // This timer must NOT be cancelled when the child exits. The child is the process-group
  // LEADER; a well-behaved leader exits promptly on SIGTERM while TERM-resistant descendants (a
  // worker that traps TERM, an orphaned node helper) keep running in the same group. The
  // previous code cleared this timer in finish(), so the leader's own exit cancelled the escalation
  // and left exactly the descendants the supervisor exists to reap. Escalation is now owned by the
  // deadline, not by the child's lifetime, and finish() waits for it.
  killTimer = setTimeout(() => {
    signalGroup('SIGKILL')
    escalationDone = true
    maybeExit()
  }, graceS * 1000)
}, timeoutS * 1000)

// If the supervisor itself is interrupted, take the group down with it rather than orphaning it.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { signalGroup(sig); })
}

function maybeExit() {
  if (pendingExit === null) return
  // On a timeout, hold the exit until escalation has fired. Otherwise the supervisor can exit while
  // TERM-resistant grandchildren are still alive in the group.
  if (timedOut && !escalationDone) return
  const { code, signal } = pendingExit
  writeStatus(code, signal)
  if (timedOut) process.exit(124)
  if (signal) process.exit(128 + (SIGNUM[signal] ?? 0))
  process.exit(code ?? 0)
}

function writeStatus(code, signal) {
  if (status) {
    const lines = [
      `timed_out=${timedOut ? 1 : 0}`,
      `exit_code=${code === null || code === undefined ? -1 : code}`,
      `signal=${signal ?? '-'}`,
      `duration_ms=${Date.now() - startedAt}`,
      '',
    ]
    try { writeFileSync(status, lines.join('\n')) } catch { /* status is advisory */ }
  }
}

function finish(code, signal) {
  if (settled) return
  settled = true
  clearTimeout(deadline)
  // DELIBERATELY does not clear killTimer: escalation is owned by the deadline, not by the child's
  // lifetime. The leader exiting on SIGTERM is precisely when surviving descendants need the KILL.
  pendingExit = { code, signal }
  maybeExit()
}

const SIGNUM = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }

child.on('error', (err) => {
  process.stderr.write(`spawn-with-timeout: failed to start ${cmd[0]}: ${err.message}\n`)
  finish(127, null)
})
child.on('exit', (code, signal) => finish(code, signal))
