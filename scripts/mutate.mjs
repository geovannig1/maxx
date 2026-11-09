#!/usr/bin/env node
/**
 * Break the code on purpose and see whether anything notices.
 *
 * WHY THIS EXISTS. Three consecutive rounds of this branch shipped "verified, gate-green" work that
 * adversarial review then found could not have failed: a render test that asserted on a string while
 * the browser collapsed the output, a collision guard whose test asserted that `Map.set` overwrites, a
 * component mapping re-implemented inside its own test file, an `if (stated)` assertion that was
 * unreachable on 29 days out of 30. Counts of surviving mutations across those rounds: 12 of 19, then
 * 10 of 51.
 *
 * The common factor is not carelessness, it is that a test written by whoever wrote the code inherits
 * the same wrong model of the system. If the author believes the surface is a string, both the fix and
 * its test will believe it. Adding more tests cannot detect that; only breaking the source can.
 *
 * Every one of those defects was found by mutation, and only by mutation. This makes it a command
 * instead of a habit.
 *
 * USAGE
 *   node scripts/mutate.mjs                      # changed files vs origin/HEAD's merge-base
 *   node scripts/mutate.mjs --base HEAD~3        # changed files vs a ref
 *   node scripts/mutate.mjs src/lib/maxx/chat.ts # explicit files, whole file
 *   node scripts/mutate.mjs --self-test          # prove the harness detects a planted survivor
 *
 * A mutation is CAUGHT if the suite fails and SURVIVES if it stays green. Survivors are the output
 * that matters: each one is a change to shipped behaviour that no test objects to.
 *
 * Operators are deliberately syntax-preserving. A mutation that breaks parsing fails every suite and
 * reads as CAUGHT, which would hide real survivors — the failure direction that matters.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()

/** Each returns the mutated line, or null when it does not apply. */
const OPERATORS = [
  {
    id: 'delete-call',
    // A bare call statement: a guard, a push, an assertion of an invariant. Deleting one is the
    // single highest-value mutation — it found the removed duplicate-id guard and the deleted notice.
    apply: (line) => {
      const trimmed = line.trimEnd()
      // Never touch a line carrying a brace or a keyword: deleting one produces a syntax error, which
      // fails every suite and reads as CAUGHT — hiding real survivors, the dangerous direction.
      if (/[{}]/.test(trimmed)) return null
      return /^\s*[A-Za-z_$][\w.$]*(\.[\w$]+)*\([^;]*\)$/.test(trimmed) ? '' : null
    },
  },
  {
    id: 'if-false',
    // Disables a branch while leaving the statement textually in place — which is exactly how a guard
    // was made dead while a source-order test still passed.
    apply: (line) => {
      const m = /^(\s*)if \((.+)\) \{$/.exec(line)
      return m ? `${m[1]}if (false) {` : null
    },
  },
  {
    id: 'if-true',
    apply: (line) => {
      const m = /^(\s*)if \((.+)\) \{$/.exec(line)
      return m ? `${m[1]}if (true) {` : null
    },
  },
  {
    id: 'negate-if',
    apply: (line) => {
      const m = /^(\s*)if \((.+)\) \{$/.exec(line)
      return m ? `${m[1]}if (!(${m[2]})) {` : null
    },
  },
  {
    id: 'flip-strict-eq',
    apply: (line) => (line.includes(' === ') ? line.replace(' === ', ' !== ') : null),
  },
  {
    id: 'flip-strict-neq',
    apply: (line) => (line.includes(' !== ') ? line.replace(' !== ', ' === ') : null),
  },
  {
    id: 'flip-true',
    apply: (line) => (/\btrue\b/.test(line) ? line.replace(/\btrue\b/, 'false') : null),
  },
  {
    id: 'flip-false',
    apply: (line) => (/\bfalse\b/.test(line) ? line.replace(/\bfalse\b/, 'true') : null),
  },
  {
    id: 'widen-quantifier',
    // `{1,40}` -> `{1,4000}`. A length bound pinned only by a far-larger probe survives this, which is
    // how an id bound of 40 was found to be unasserted.
    apply: (line) => {
      const m = /\{(\d+),(\d+)\}/.exec(line)
      return m ? line.replace(m[0], `{${m[1]},${Number(m[2]) * 100}}`) : null
    },
  },
  {
    id: 'widen-charclass',
    // Adds a space to a character class: the mutation that survived a whole injection suite because
    // every negative probe contained characters the class rejected for another reason.
    apply: (line) => {
      const m = /\[\^?[A-Za-z0-9\\\-_]+\]\{/.exec(line)
      return m ? line.replace(m[0], m[0].replace(']{', ' ]{')) : null
    },
  },
  {
    id: 'bump-max',
    apply: (line) => {
      const m = /\b(maxItems|minItems|max|min|limit|maxLength|minLength):\s*(\d+)/.exec(line)
      return m ? line.replace(m[0], `${m[1]}: ${Number(m[2]) * 100 + 7}`) : null
    },
  },
  {
    id: 'negate-ternary-head',
    // `tool_choice: forcedSubmission` heading a multi-line `? … : …`. Line-based operators cannot
    // swap the branches, but negating the CONDITION selects the other one — which is the same defect
    // and is syntax-preserving. Added because the first honest sweep listed exactly this line as
    // unreachable, and it is the line carrying the mechanism a commit once claimed without writing.
    apply: (line) => {
      const m = /^(\s*)([\w.]+): ([A-Za-z_$][\w.$]*)$/.exec(line)
      return m ? `${m[1]}${m[2]}: !${m[3]}` : null
    },
  },
  {
    id: 'delete-object-property',
    // A whole `key: value,` line inside an object literal. Reaches schema properties, `strict: true`,
    // and every option passed to an API call — none of which any other operator touches.
    apply: (line) => {
      const trimmed = line.trimEnd()
      if (!/^\s*[\w'"]+: .+,$/.test(trimmed)) return null
      // Balanced only: a value that opens a brace or bracket spans lines, and deleting the head
      // orphans the tail into a syntax error, which reads as CAUGHT and hides survivors.
      const opens = (trimmed.match(/[[{(]/g) ?? []).length
      const closes = (trimmed.match(/[\]})]/g) ?? []).length
      return opens === closes ? '' : null
    },
  },
  {
    id: 'empty-string-literal',
    // A message nobody asserts on can be blanked. Catches "the detail says what it checked" claims.
    apply: (line) => {
      const m = /'([^'\\]{12,})'/.exec(line)
      return m && !line.trimStart().startsWith('//') ? line.replace(m[0], "''") : null
    },
  },
]

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

/**
 * Files changed by the COMMITTED work, `base..HEAD` — not `base..worktree`.
 *
 * The two-dot range matters. Diffing against the working tree pulled in another session's
 * uncommitted edits as mutation targets, which the dirty-file refusal then blocked. The harness must
 * measure what was committed, which is also the only thing it can safely restore.
 */
function changedFiles(base) {
  return git(['diff', '--name-only', `${base}..HEAD`, '--', 'src'])
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
}

/** Line numbers touched by the diff, 1-indexed. Empty set means "the whole file". */
function changedLines(base, file) {
  const out = git(['diff', '-U0', `${base}..HEAD`, '--', file])
  const lines = new Set()
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1])
    for (let i = 0; i < Number(m[2] ?? 1); i += 1) lines.add(start + i)
  }
  return lines
}

/**
 * Mutations, AND the lines no operator could reach.
 *
 * Reporting only "10/10 caught, no survivors" is the same false green this harness exists to expose:
 * measured on its own first real sweep, 10 mutations were generated across a 40-line diff, so three
 * quarters of the change was never touched and the summary implied otherwise. The operator set is
 * line-shaped and cannot reach a ternary, a multi-line object literal, or a property on its own line.
 *
 * So the unreachable lines are counted and shown. A reader must be able to see what was NOT measured
 * without inferring it from a suspiciously small denominator.
 */
function buildMutations(file, only) {
  const source = readFileSync(file, 'utf8').split('\n')
  const mutations = []
  const unreached = []
  source.forEach((line, index) => {
    const lineNo = index + 1
    if (only.size > 0 && !only.has(lineNo)) return
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    let produced = 0
    for (const operator of OPERATORS) {
      const mutated = operator.apply(line)
      if (mutated === null || mutated === line) continue
      mutations.push({ file, lineNo, operator: operator.id, original: line, mutated })
      produced += 1
    }
    if (produced === 0) unreached.push({ file, lineNo, line: trimmed })
  })
  return { mutations, unreached }
}

/** True when the suite FAILED, i.e. the mutation was caught. `--bail` keeps caught mutations cheap. */
function suiteRejects() {
  const result = spawnSync('npx', ['vitest', 'run', '--bail=1', '--silent'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1' },
  })
  return result.status !== 0
}

/**
 * True when the TYPECHECKER rejects the mutation.
 *
 * Vitest erases types, so a mutation that lands in a type position is invisible to it and gets
 * reported as a survivor. Measured: mutating `current: CockpitRange` to `current: !CockpitRange`
 * passes all 28 tests and fails `tsc` with TS17020. Three of four survivors in one sweep were this,
 * and that is the DANGEROUS direction for this tool — a survivor list padded with things the gate
 * already catches teaches the reader to skim survivors, which is the exact habit the harness exists
 * to break.
 *
 * "Caught" therefore means caught by any verification the gate runs, not caught by vitest alone.
 * Only survivors pay this cost, so a sweep whose mutations are all behavioural runs no typechecks.
 */
function typecheckRejects() {
  const result = spawnSync('npx', ['tsc', '--noEmit'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1' },
  })
  return result.status !== 0
}

/**
 * Files currently mutated. A kill signal must not leave one behind.
 *
 * This harness stranded a syntax-error mutation in `src/lib/maxx/chat.ts` when a 10-minute timeout
 * SIGTERM'd it mid-run: the `finally` restored on exception but not on signal. Five test files then
 * failed to parse, which read as a code problem rather than a tool problem — and the cleanup for it
 * (`git checkout -- <file>`) destroyed an hour of uncommitted work in the same file.
 *
 * So: register before writing, clear after restoring, and restore from a signal handler too. A
 * harness that damages the tree it measures is worse than no harness.
 */
const inFlight = new Set()

function restoreAll() {
  for (const file of inFlight) {
    try { restore(file) } catch { /* best effort during teardown */ }
  }
  inFlight.clear()
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { restoreAll(); process.exit(130) })
}
process.on('uncaughtException', (error) => { restoreAll(); console.error(error); process.exit(2) })

function applyMutation(mutation) {
  inFlight.add(mutation.file)
  const source = readFileSync(mutation.file, 'utf8').split('\n')
  source[mutation.lineNo - 1] = mutation.mutated
  writeFileSync(mutation.file, source.join('\n'))
}

/**
 * Restore ONE file from the index, not from HEAD.
 *
 * `git checkout -- <file>` discards uncommitted work, which is correct only because this harness
 * refuses to run on a dirty target (see `assertTargetsClean`). That refusal is the safety property;
 * without it this line is a data-loss bug waiting for a coincidence.
 */
function restore(file) {
  git(['checkout', '--', file])
  inFlight.delete(file)
}

/**
 * Refuse to mutate a file with uncommitted changes.
 *
 * Restoring means `git checkout --`, so mutating a dirty file and restoring it would silently delete
 * whatever was uncommitted. Measured the hard way.
 */
function assertTargetsClean(files) {
  const dirty = git(['status', '--porcelain', '--', ...files]).trim()
  if (dirty === '') return
  console.error('Refusing to mutate files with uncommitted changes — restoring would discard them:')
  console.error(dirty)
  console.error('\nCommit or stash them first.')
  process.exit(2)
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) return selfTest()

  const baseIndex = argv.indexOf('--base')
  const base = baseIndex === -1 ? 'origin/HEAD' : argv[baseIndex + 1]
  const explicit = argv.filter((a) => !a.startsWith('--') && a !== base)

  let targets
  if (explicit.length > 0) {
    targets = explicit.map((file) => ({ file, only: new Set() }))
  } else {
    let resolvedBase = base
    try {
      resolvedBase = git(['merge-base', 'HEAD', base]).trim()
    } catch {
      // A detached or missing upstream: fall back to the ref as given.
    }
    targets = changedFiles(resolvedBase).map((file) => ({ file, only: changedLines(resolvedBase, file) }))
  }

  if (targets.length === 0) {
    console.log('No changed source files to mutate.')
    return
  }

  assertTargetsClean(targets.map((t) => t.file))
  const built = targets.map(({ file, only }) => buildMutations(file, only))
  const mutations = built.flatMap((b) => b.mutations)
  const unreached = built.flatMap((b) => b.unreached)
  const covered = new Set(mutations.map((m) => `${m.file}:${m.lineNo}`)).size
  const considered = covered + unreached.length

  console.log(`Mutating ${targets.length} file(s), ${mutations.length} mutation(s).`)
  console.log(`Code lines in scope: ${considered}. Reached by an operator: ${covered}`
    + ` (${considered === 0 ? 0 : Math.round((covered / considered) * 100)}%).`)
  console.log('A SURVIVOR is a change to shipped behaviour that no test objects to.\n')

  const survivors = []
  mutations.forEach((mutation, index) => {
    applyMutation(mutation)
    let caught
    let by = 'suite'
    try {
      caught = suiteRejects()
      // INSIDE the try, because `finally` restores the file. The first version of this ran after the
      // restore, so it typechecked a clean tree, could never return true, and left the survivor list
      // exactly as it was — a check that cannot fire, added to a tool whose whole purpose is finding
      // checks that cannot fire. Caught only by re-running the sweep and seeing nothing move.
      //
      // Only survivors pay this cost, so a sweep of purely behavioural mutations runs no typechecks.
      if (!caught && typecheckRejects()) {
        caught = true
        by = 'typecheck'
      }
    } finally {
      restore(mutation.file)
    }
    const label = `${mutation.file}:${mutation.lineNo} [${mutation.operator}]`
    console.log(`  ${caught ? `✓ caught (${by})` : '✗ SURVIVED'.padEnd(16)} (${index + 1}/${mutations.length}) ${label}`)
    if (!caught) survivors.push(mutation)
  })

  // The tree must be exactly as it was, for the files THIS run touched. Scoping matters: a repo-wide
  // check reports another session's work as harness damage, which is a false alarm that trains the
  // reader to ignore a real one.
  const dirty = git(['status', '--porcelain', '--', ...targets.map((t) => t.file)]).trim()
  if (dirty !== '') {
    console.error(`\nHARNESS ERROR: working tree not restored:\n${dirty}`)
    process.exit(2)
  }

  console.log(`\n${mutations.length - survivors.length}/${mutations.length} caught`
    + ` across ${covered} of ${considered} code lines in scope.`)
  if (unreached.length > 0) {
    // Named, not summarised away. "No survivors" over a quarter of a diff is a claim about the
    // quarter, and a reader who cannot see the other three quarters will read it as the whole.
    console.log(`\nNOT MEASURED — ${unreached.length} line(s) no operator could reach:`)
    for (const item of unreached.slice(0, 40)) console.log(`  ${item.file}:${item.lineNo}  ${item.line}`)
    if (unreached.length > 40) console.log(`  … and ${unreached.length - 40} more`)
    console.log('\nThese are unverified by this run. Read them, or add an operator that reaches them.')
  }
  if (survivors.length > 0) {
    console.log('\nSURVIVORS — each is unverified behaviour:')
    for (const s of survivors) {
      console.log(`  ${s.file}:${s.lineNo} [${s.operator}]`)
      console.log(`    was: ${s.original.trim()}`)
      console.log(`    now: ${s.mutated.trim() || '(deleted)'}`)
    }
    process.exit(1)
  }
  console.log('No survivors.')
}

/**
 * Validate the instrument before trusting a sweep.
 *
 * Four of one audit's findings this session came from bugs in the measuring tool rather than the
 * thing measured. So the harness proves, on a known input, that it reports a survivor when one exists
 * and does not when one does not.
 */
function selfTest() {
  const file = 'src/lib/maxx/chat.ts'
  const typeAnchor = 'src/lib/cockpit/comparison-window.ts'
  // The self-test mutates these two files and restores them from git, which discards uncommitted
  // work: refuse a dirty tree for them exactly as a normal run does.
  assertTargetsClean([file, typeAnchor])
  const source = readFileSync(file, 'utf8')
  const failures = []

  // A line that IS asserted: removing the brief tool from the roster must be caught.
  const guarded = source.split('\n').findIndex((l) => l.includes('CHAT_TOOLS.push(ANSWER_BRIEF_TOOL_DEFINITION)')) + 1
  if (guarded === 0) failures.push('self-test anchor missing: CHAT_TOOLS.push')

  const { mutations } = buildMutations(file, new Set([guarded]))
  const deletion = mutations.find((m) => m.operator === 'delete-call')
  if (!deletion) failures.push('delete-call did not apply to a bare call statement')

  if (deletion) {
    applyMutation(deletion)
    let caught
    try { caught = suiteRejects() } finally { restore(file) }
    if (!caught) failures.push('harness reported SURVIVED on a mutation the suite is known to catch')
  }

  // THE TYPECHECK PATH, proven rather than assumed.
  //
  // Vitest erases types, so a mutation landing in a type position passes every test and was reported
  // as a survivor — three of four survivors in one sweep were exactly this. The fix counts a
  // typecheck rejection as caught, and the FIRST version of that fix ran after the file had already
  // been restored, so it typechecked a clean tree and could never fire. It changed no output and
  // would have gone unnoticed indefinitely. This is what makes that impossible: a mutation vitest
  // provably ignores, which the harness must still report as caught.
  const typeSource = readFileSync(typeAnchor, 'utf8')
  const typeLineNo = typeSource.split('\n').findIndex((l) => l.trim() === 'current: CockpitRange') + 1
  if (typeLineNo === 0) {
    failures.push(`self-test anchor missing: 'current: CockpitRange' in ${typeAnchor}`)
  } else {
    const typeMutation = {
      file: typeAnchor,
      lineNo: typeLineNo,
      operator: 'self-test:type-position',
      original: '  current: CockpitRange',
      mutated: '  current: !CockpitRange',
    }
    applyMutation(typeMutation)
    let bySuite
    let byTypes
    try {
      bySuite = suiteRejects()
      byTypes = typecheckRejects()
    } finally {
      restore(typeAnchor)
    }
    // Both halves matter. If the suite started catching it, the anchor no longer demonstrates the
    // blind spot and the typecheck result proves nothing about the path under test.
    if (bySuite) failures.push('self-test anchor no longer demonstrates the type blind spot: the suite caught it')
    if (!byTypes) failures.push('typecheck path is dead: tsc accepted a mutation that is not valid TypeScript')
    const typeDirty = git(['status', '--porcelain', '--', typeAnchor]).trim()
    if (typeDirty !== '') failures.push(`working tree not restored: ${typeDirty}`)
  }

  const dirty = git(['status', '--porcelain', '--', file]).trim()
  if (dirty !== '') failures.push(`working tree not restored: ${dirty}`)

  if (failures.length > 0) {
    console.error('SELF-TEST FAILED:'); for (const f of failures) console.error(`  - ${f}`)
    process.exit(2)
  }
  console.log('SELF-TEST PASSED: the harness detects a caught mutation, catches a type-only mutation'
    + ' the suite cannot see, and restores the tree.')
}

main()
