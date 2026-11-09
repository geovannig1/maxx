/**
 * Maxx eval harness — replay one private owner audit question plus three committed adversarial
 * scenarios through the real Maxx chat loop, score each deterministically (tool coverage +
 * must-mention/must-not-claim) plus an optional LLM-judge score, and write a dated report.
 *
 * Run (owner-side; needs .env.local with ANTHROPIC_API_KEY + DB creds):
 *   MAXX_CHAT_ENABLED=true MAXX_EVAL_QUESTIONS_FILE=/secure/maxx-questions.json npx tsx --tsconfig tsconfig.scripts.json scripts/eval-maxx.ts --require-pinned
 *   (or:  npm run eval:golden)
 *
 * The owner's exact audit question is not stored in the repo. Provide it in a private v2 fixture through
 * MAXX_EVAL_QUESTIONS_FILE. The other three prompts are explicitly curated regression scenarios.
 * Acceptance requires the owner fixture and fails closed; fallback prompts are exploratory only.
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { GOLDEN_QUESTIONS, scoreAnswer, type GoldenQuestion } from '../src/lib/eval/golden-questions'
import { scoreBrief } from '../src/lib/eval/brief-rubric'
import { BRIEF_EXPECTATIONS, UNREACHABLE_GATES } from '../src/lib/eval/brief-expectations'
import { cohensKappa, JUDGE_KAPPA_FLOOR, JUDGE_KAPPA_MIN_SAMPLE } from '../src/lib/eval/judge-agreement'
import type { AnswerBrief, AnswerBriefClaim } from '../src/lib/maxx/answer-brief'
import { summarizeReliability } from '../src/lib/eval/reliability'
import {
  maxxEvidenceReadsHealthy,
  maxxTrialPasses,
  redactPrivateDecisionCopyForJudge,
  runMaxxGovernancePreflight,
} from '../src/lib/eval/maxx-governance'
import { loadPinnedQuestionFixture } from '../src/lib/eval/pinned-questions'
import { runMaxxChat } from '../src/lib/maxx/chat'
import { aiStatus, generateStructured, isAiEnabled } from '../src/lib/ai'

const REPORT_DIR = path.resolve(process.cwd(), 'reports/eval')
const TRIALS = 3
const REQUIRE_PINNED = process.argv.includes('--require-pinned')
const REQUIRED_PASS_AT_K = 0.9
const REQUIRED_PASS_TO_K = 1

function requireAcceptanceEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for a pinned Maxx acceptance evaluation.`)
  return value
}

function assertAcceptancePrerequisites(): void {
  if (!REQUIRE_PINNED) return

  if (requireAcceptanceEnvironment('MAXX_CHAT_ENABLED') !== 'true') {
    throw new Error('MAXX_CHAT_ENABLED must be exactly "true" for a pinned Maxx acceptance evaluation.')
  }
  const ai = aiStatus()
  if (ai.state !== 'on') {
    throw new Error('A configured AI provider is required for a pinned Maxx acceptance evaluation (set AI_PROVIDER and its credentials; npm run doctor checks them).')
  }
  const supabaseUrl = requireAcceptanceEnvironment('NEXT_PUBLIC_SUPABASE_URL')
  requireAcceptanceEnvironment('SUPABASE_SERVICE_ROLE_KEY')
  try {
    const url = new URL(supabaseUrl)
    if (url.protocol !== 'https:') throw new Error('must use https')
  } catch (error) {
    throw new Error(`NEXT_PUBLIC_SUPABASE_URL must be an absolute HTTPS URL: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function loadQuestionOverrides(): Record<string, string> {
  const configured = process.env.MAXX_EVAL_QUESTIONS_FILE
  if (!configured) {
    if (REQUIRE_PINNED) throw new Error('MAXX_EVAL_QUESTIONS_FILE is required for a pinned acceptance evaluation.')
    return {}
  }
  const fixturePath = path.resolve(process.cwd(), configured)
  try {
    return loadPinnedQuestionFixture(fs.readFileSync(fixturePath, 'utf8'), GOLDEN_QUESTIONS)
  } catch (e) {
    throw new Error(`Could not load pinned Maxx question fixture ${fixturePath}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function promptFor(q: GoldenQuestion, overrides: Record<string, string>): { prompt: string; verbatim: boolean } {
  const o = overrides[q.id]
  return q.source === 'owner' && o && o.trim().length > 0
    ? { prompt: o, verbatim: true }
    : { prompt: q.fallback_prompt, verbatim: false }
}

/** Optional LLM judge — returns 0..10 (or null if unavailable). Deterministic checks are primary; this is
 *  secondary context, not the gate. */
async function judge(q: GoldenQuestion, answer: string): Promise<{ score: number | null; note: string }> {
  if (!isAiEnabled()) return { score: null, note: 'AI is off — judge skipped' }
  try {
    const sys = 'You are a strict grader for a Meta-ads assistant. Score 0-10 how well the answer meets the rubric. Reply with ONLY a JSON object {"score": <0-10>, "note": "<one sentence>"}.'
    const user = `RUBRIC: ${q.rubric}\n\nANSWER:\n${answer}\n\nReturn only the JSON.`
    // A refusal, a max-token stop or non-JSON text throws and lands in the catch below as "no score".
    const res = await generateStructured({
      feature: 'eval_judge',
      system: sys,
      user,
      format: {
        name: 'judge_score',
        schema: {
          type: 'object', additionalProperties: false, required: ['score', 'note'],
          properties: { score: { type: 'integer' }, note: { type: 'string' } },
        },
      },
      maxTokens: 2_000,
      timeoutMs: 60_000,
      effort: 'low',
    })
    const parsed = (res.value ?? {}) as { score?: number; note?: string }
    const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(10, parsed.score)) : null
    return { score, note: parsed.note ?? '' }
  } catch (e) {
    return { score: null, note: `judge error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function main() {
  assertAcceptancePrerequisites()
  const preflight = runMaxxGovernancePreflight()
  const failedPreflight = preflight.filter((result) => !result.passed)
  if (failedPreflight.length > 0) {
    throw new Error(`Maxx governance preflight failed: ${failedPreflight.map((result) => result.id).join(', ')}`)
  }
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  const overrides = loadQuestionOverrides()
  const ownerQuestions = GOLDEN_QUESTIONS.filter((question) => question.source === 'owner')
  const ownerFixtureLoaded = ownerQuestions.length === 1
    && (overrides[ownerQuestions[0].id] ?? '').trim().length > 0
  if (REQUIRE_PINNED && !ownerFixtureLoaded) {
    throw new Error('Pinned acceptance evaluation requires exactly one private owner question.')
  }
  const stamp = new Date().toISOString().slice(0, 10)

  console.log(`[eval] running ${GOLDEN_QUESTIONS.length} scenarios${ownerFixtureLoaded ? ' (1 pinned owner question + 3 curated scenarios)' : ' (owner fallback — provide MAXX_EVAL_QUESTIONS_FILE for acceptance)'}`)

  const rows: Array<Record<string, unknown>> = []
  const trialResults: boolean[][] = []
  const judgePairs: Array<{ judge: boolean; deterministic: boolean }> = []
  for (const q of GOLDEN_QUESTIONS) {
    const { prompt, verbatim } = promptFor(q, overrides)
    const trials: Array<Record<string, unknown>> = []
    const passedTrials: boolean[] = []
    for (let trial = 1; trial <= TRIALS; trial++) {
      let answer = ''
      let toolsUsed: string[] = []
      let brief: AnswerBrief | null = null
      let claims: ReadonlyMap<string, AnswerBriefClaim> = new Map()
      let evidenceReadHealthy = false
      let actionDecisionsForJudge: Array<{ owner_copy?: string }> = []
      // The ids G6 resolves against. Without them the gate can only COUNT what the brief referenced.
      let actionDecisionIds: ReadonlySet<string> = new Set()
      try {
        const res = await runMaxxChat([{ role: 'user', content: prompt }])
        answer = res.text
        toolsUsed = res.toolsUsed
        brief = res.brief
        claims = res.claims
        actionDecisionIds = new Set(res.actionDecisions.keys())
        actionDecisionsForJudge = [...res.actionDecisions.values()]
        // Honest nested unavailability is admissible and appears as `partial`; a top-level failed
        // lookup is not. Tool names alone cannot earn release coverage for reads that threw.
        evidenceReadHealthy = maxxEvidenceReadsHealthy(res.evidence)
      } catch (e) {
        answer = `[chat error: ${e instanceof Error ? e.message : String(e)}]`
      }
      // PARTIALLY GATING. scoreAnswer keyword-matches the ANSWER TEXT, and since that change the text is not
      // model output: every runMaxxChat return path is a fixed string or a server-composed render of
      // the brief. Measured against the real render, a correct governed answer scores 0.00 on all four
      // questions while "Maxx chat is disabled." scores 0.25 on two of them. It is retained only so a
      // run can be compared with the pre-cutover reports in reports/eval/. Mention coverage and its
      // aggregate score do not gate, but a must-not-claim violation in the owner-visible render does.
      const det = scoreAnswer(q, answer, toolsUsed)
      const jl = await judge(
        q,
        redactPrivateDecisionCopyForJudge(answer, actionDecisionsForJudge),
      )

      // GATING. The model's judgement is its SELECTION of governed claims, which is what this reads.
      const expectation = BRIEF_EXPECTATIONS[q.id]
      // The GOVERNED claim set, not the model's transcription of it. A gate needing a property the
      // predicate does not carry must resolve the claim the id names.
      const briefScore = brief ? scoreBrief(expectation, brief, claims, actionDecisionIds) : null
      // No brief at all means no governed answer was produced — a withheld or unavailable response.
      const passed = maxxTrialPasses({
        toolCoverage: det.tool_coverage,
        violations: det.violations,
        briefAdmissible: briefScore?.admissible === true,
        evidenceReadHealthy,
      })
      passedTrials.push(passed)
      judgePairs.push({ judge: (jl.score ?? 0) >= 7, deterministic: passed })
      trials.push({
        trial, tools_used: toolsUsed, evidence_read_healthy: evidenceReadHealthy,
        brief_score: briefScore, rendered_text_checks: det, judge: jl, passed,
      })
      const gateNote = briefScore
        ? briefScore.failedGates.join(', ') || 'all gates'
        : 'no governed brief produced'
      console.log(`  ${passed ? '✓' : '✗'} ${q.id} trial ${trial}: evidence groups ${det.tool_groups_hit}/${det.tool_groups_total} · violations ${det.violations.length} · gates ${gateNote}${jl.score != null ? ` · judge ${jl.score}/10` : ''}`)
    }
    trialResults.push(passedTrials)
    rows.push({
      id: q.id,
      source: q.source,
      theme: q.theme,
      verbatim,
      prompt: verbatim ? '[verbatim — redacted]' : prompt,
      pass_at_3: passedTrials.some(Boolean),
      pass_to_3: passedTrials.every(Boolean),
      trials,
    })
  }

  const reliability = summarizeReliability(trialResults)
  const judgeAgreement = cohensKappa(judgePairs)
  // Enforced only once the sample can carry it. Four questions times three trials is twelve, and kappa
  // on twelve binary judgements swings on a single disagreement; gating on that fails releases at
  // random, which is how a gate ends up permanently disabled.
  const judgeGateEnforced = judgeAgreement.n >= JUDGE_KAPPA_MIN_SAMPLE
  const judgeGateMet = !judgeGateEnforced || (judgeAgreement.kappa ?? 0) >= JUDGE_KAPPA_FLOOR
  const report = {
    date: stamp,
    verbatim: ownerFixtureLoaded,
    summary: {
      ...reliability,
      scenarioPassAt3Target: REQUIRED_PASS_AT_K,
      scenarioPassAt3Met: reliability.passAtKRate >= REQUIRED_PASS_AT_K,
      deterministicPassTo3Target: REQUIRED_PASS_TO_K,
      deterministicPassTo3Met: reliability.passToKRate >= REQUIRED_PASS_TO_K,
      pinnedFixtureRequired: REQUIRE_PINNED,
      governancePreflight: preflight,
      judgeAgreement,
      judgeKappaFloor: JUDGE_KAPPA_FLOOR,
      judgeGateEnforced,
      judgeGateMet,
      // Gates switched off because the claim supply cannot satisfy them. Carried into every report so
      // a green run never reads as broader coverage than it has.
      disabledGates: UNREACHABLE_GATES,
    },
    rows,
  }
  fs.writeFileSync(path.join(REPORT_DIR, `${stamp}.json`), JSON.stringify(report, null, 2))

  const md: string[] = [
    `# Golden-questions eval — ${stamp}`,
    ``,
    `**pass@3 ${(reliability.passAtKRate * 100).toFixed(0)}% · pass^3 ${(reliability.passToKRate * 100).toFixed(0)}%** ${ownerFixtureLoaded ? '(1 pinned owner question + 3 curated scenarios)' : '(OWNER FALLBACK — not acceptance; provide MAXX_EVAL_QUESTIONS_FILE)'}`,
    ``,
    `| question | pass@3 | pass^3 | trial results |`,
    `|---|---|---|---|`,
    ...rows.map((r) => {
      const trials = r.trials as Array<{ passed: boolean }>
      return `| ${r.id} | ${r.pass_at_3 ? '✅' : '❌'} | ${r.pass_to_3 ? '✅' : '❌'} | ${trials.map((trial) => trial.passed ? 'pass' : 'fail').join(', ')} |`
    }),
    ``,
    ``,
    `Gates disabled because the claim supply cannot satisfy them: ${UNREACHABLE_GATES.length ? UNREACHABLE_GATES.map((g) => `${g.question}/${g.gate}`).join(', ') : 'none'}.`,
    `Judge agreement (Cohen's kappa vs the deterministic gates): ${judgeAgreement.kappa === null ? `undefined — ${judgeAgreement.note}` : judgeAgreement.kappa.toFixed(2)} over n=${judgeAgreement.n}${judgeGateEnforced ? '' : ' (reported, not enforced — sample too small)'}.`,
    ``,
    `## Detail`,
    ...rows.flatMap((r) => {
      return [
        ``,
        `### ${r.id}`,
        ...(r.trials as Array<Record<string, unknown>>).flatMap((trial) => {
          const brief = trial.brief_score as ReturnType<typeof scoreBrief> | null
          const rendered = trial.rendered_text_checks as ReturnType<typeof scoreAnswer>
          return [
            `- trial ${trial.trial}: ${trial.passed ? 'pass' : 'fail'}`,
            `  - tools used: ${(trial.tools_used as string[]).join(', ') || '(none)'}`,
            `  - rendered-surface violations: ${rendered.violations.join(', ') || '(none)'}`,
            // Each gate reports what the brief actually selected, so a failure is triageable from the
            // report alone without re-running against a live account.
            ...(brief
              ? brief.gates.map((gate) => `  - ${gate.passed ? '✓' : '✗'} ${gate.gate}: ${gate.detail}`)
              : ['  - no governed brief produced (answer was withheld or unavailable)']),
          ]
        }),
      ]
    }),
  ]
  fs.writeFileSync(path.join(REPORT_DIR, `${stamp}.md`), md.join('\n'))
  console.log(`[eval] wrote reports/eval/${stamp}.{json,md} — pass@3 ${(reliability.passAtKRate * 100).toFixed(0)}% · pass^3 ${(reliability.passToKRate * 100).toFixed(0)}%`)
  if (!ownerFixtureLoaded || !judgeGateMet
    || reliability.passAtKRate < REQUIRED_PASS_AT_K || reliability.passToKRate < REQUIRED_PASS_TO_K) {
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
