import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The gate must be able to say WHY it failed.
 *
 * A `step()` that runs the command and records only the label leaves nothing but a line like
 * `✗ database RPC tests (PGlite)`. If the step then passes standalone, the cause can never be
 * recovered — the evidence was thrown away.
 *
 * A plausible explanation may exist: `vitest.db.config.ts` documents that `freshDb()` rebuilds the
 * schema per test and that setup timeouts can look like SQL failures. But a plausible explanation
 * with nothing behind it is not a diagnosis, and a gate that reports a verdict it cannot substantiate
 * teaches one behaviour: re-run until green. That is how a real failure gets laundered as flake.
 *
 * This drives the SHIPPED `step` and `print_failure_details` out of `scripts/gate-local.sh` — not a
 * copy written here — with synthetic passing, noisy-failing and silently-failing steps.
 */

const ROOT = process.cwd()
const GATE = join(ROOT, 'scripts/gate-local.sh')

/**
 * The shipped script, split at its `case "$MODE"` dispatch.
 *
 * `head` is everything before the dispatch — the machinery. `tail` is everything after `esac` — the
 * SUMMARY, including the line that decides whether failure details are printed at all.
 *
 * Splitting rather than reimplementing is the whole point. The first version of this file extracted
 * only the machinery and then called `print_failure_details` from the probe itself, so deleting that
 * call from `gate-local.sh` entirely left all seven tests green — a test harness supplying the very
 * wiring it claims to verify. That is this author's documented failure mode, committed inside the
 * file written to prevent it, and mutation testing is what surfaced it.
 */
function gateParts(): { head: string, tail: string } {
  const script = readFileSync(GATE, 'utf8').split('\n')
  const start = script.findIndex((line) => line.startsWith('case "$MODE" in'))
  const end = script.findIndex((line) => line.trim() === 'esac')
  if (start < 0 || end < 0) throw new Error('gate-local.sh no longer has the expected dispatch')
  return { head: script.slice(0, start).join('\n'), tail: script.slice(end + 1).join('\n') }
}

/** Run synthetic steps through the shipped machinery AND the shipped summary. */
function runProbe(steps: string, opts: { pipefail?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-probe-'))
  const probe = join(dir, 'probe.sh')
  const { head, tail } = gateParts()
  writeFileSync(probe, [
    head,
    // Proves PIPESTATUS is load-bearing on its own terms: with pipefail OFF, `$?` after the pipeline
    // is TEE's status, which is always 0. Only PIPESTATUS[0] still sees the command fail.
    opts.pipefail === false ? 'set +o pipefail' : '',
    steps,
    tail,
  ].join('\n'))
  // The shipped tail exits 1 when anything failed, which is the behaviour under test.
  try {
    return execFileSync('bash', [probe], { encoding: 'utf8' })
  } catch (error) {
    const failure = error as { stdout?: string }
    if (typeof failure.stdout === 'string') return failure.stdout
    throw error
  }
}

const summaryOf = (out: string) => out.slice(out.indexOf('── gate summary'))

describe('a failing gate step reports its cause, not just its verdict', () => {
  it('splits the shipped script into machinery and summary (so this file cannot test nothing)', () => {
    const { head, tail } = gateParts()
    expect(head).toContain('step() {')
    expect(head).toContain('print_failure_details() {')
    // The dispatch must be in NEITHER half, or the probe would run the real gate.
    expect(head).not.toContain('case "$MODE" in')
    expect(tail).not.toContain('case "$MODE" in')
    // The summary half must carry the call this file exists to verify — read from the script, not
    // supplied by the harness.
    expect(tail).toContain('print_failure_details')
    expect(tail).toContain('gate summary')
  })

  it('replays the tail of a failing step under the summary', () => {
    const out = runProbe(
      `step 'noisy failure' bash -c 'for i in $(seq 1 60); do echo "line $i"; done;`
      + ` echo "FATAL: schema rebuild timed out"; exit 3'`,
    )
    expect(summaryOf(out)).toContain('last 40 lines of: noisy failure')
    expect(summaryOf(out)).toContain('FATAL: schema rebuild timed out')
  })

  it('reports the exit code at the point of failure', () => {
    const out = runProbe(`step 'boom' bash -c 'exit 3'`)
    expect(out).toContain('FAILED (exit 3)')
  })

  it('says so explicitly when a step failed WITHOUT producing output', () => {
    // The alternative is a blank section, which reads as "no cause" rather than "no output" — a
    // distinction a reader triaging a red gate at speed will not make for themselves.
    const out = runProbe(`step 'silent failure' bash -c 'exit 9'`)
    expect(summaryOf(out)).toContain('the step produced no output')
  })

  it('does NOT replay a step that passed', () => {
    const out = runProbe(
      `step 'ok' bash -c 'echo PASSING_STEP_MARKER; exit 0'\n`
      + `step 'bad' bash -c 'echo FAILING_STEP_MARKER; exit 1'`,
    )
    // Streamed live once, never replayed: the summary is for causes, not for a second copy of a
    // successful build log.
    expect(out).toContain('PASSING_STEP_MARKER')
    expect(summaryOf(out)).not.toContain('PASSING_STEP_MARKER')
    expect(summaryOf(out)).toContain('FAILING_STEP_MARKER')
  })

  it('captures a step that writes only to STDERR', () => {
    // `2>&1` is load-bearing: the PGlite failure mode this was written for reports through stderr,
    // and capturing stdout alone would have reproduced the original blank report exactly.
    const out = runProbe(`step 'stderr only' bash -c 'echo ERR_ONLY_MARKER >&2; exit 1'`)
    expect(summaryOf(out)).toContain('ERR_ONLY_MARKER')
  })

  it('records the COMMAND status, not the status of the tee it is piped into', () => {
    const out = runProbe(`step 'fails through a pipe' bash -c 'echo noise; exit 1'`)
    expect(out).toContain('FAILED (exit 1)')
    expect(summaryOf(out)).toContain('fails through a pipe')
  })

  it('still sees the failure with pipefail OFF — which is what PIPESTATUS actually buys', () => {
    // An earlier version of this test claimed `$?` would report tee's success "so without PIPESTATUS
    // every step would pass". That was false: the script sets `pipefail`, under which `$?` is already
    // the command's status, and swapping PIPESTATUS[0] for `$?` was an EQUIVALENT mutation the suite
    // could not have caught. Mutation testing found the claim, not a bug.
    //
    // PIPESTATUS is still worth having, for one reason that can be stated and therefore tested: it
    // does not depend on `pipefail` staying set. Turning pipefail off is exactly the silent change
    // that would otherwise make every step pass while every label still printed.
    const out = runProbe(`step 'fails with pipefail off' bash -c 'echo noise; exit 1'`, { pipefail: false })
    expect(out).toContain('FAILED (exit 1)')
    expect(summaryOf(out)).toContain('fails with pipefail off')
  })
})
