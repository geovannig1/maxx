/**
 * Cohen's kappa between the LLM judge and the deterministic gates.
 *
 * The judge is not the gate and must never become it: it is a language model grading a language
 * model, and it scored the 2026-08-16 run 9/10 on an answer the deterministic rubric could not pass.
 * But an unmeasured judge is worse than no judge, because its number gets read as a second opinion
 * when it may be an echo or noise.
 *
 * Kappa rather than raw agreement, because raw agreement is inflated by the base rate: if 90% of
 * trials pass, a judge that says "pass" unconditionally agrees 90% of the time while carrying no
 * information at all. Kappa subtracts exactly that chance agreement, so a degenerate judge scores ~0.
 *
 * Kappa is undefined when either rater never varies (chance agreement is 1 and the denominator is
 * zero). That is reported as null, not coerced to 0 or 1 — a judge with no variance has not been
 * shown to be bad, it has been shown to be uninformative, and those need different responses.
 */

export interface JudgeAgreement {
  /** Cohen's kappa, or null when it is not defined for this sample. */
  kappa: number | null
  /** Raw agreement, retained only to make a misleading kappa legible next to it. */
  rawAgreement: number
  n: number
  /** Why kappa is null, when it is. */
  note: string | null
}

export function cohensKappa(pairs: ReadonlyArray<{ judge: boolean; deterministic: boolean }>): JudgeAgreement {
  const n = pairs.length
  if (n === 0) return { kappa: null, rawAgreement: 0, n: 0, note: 'no trials to compare' }

  let bothPass = 0, bothFail = 0, judgeOnly = 0, deterministicOnly = 0
  for (const pair of pairs) {
    if (pair.judge && pair.deterministic) bothPass += 1
    else if (!pair.judge && !pair.deterministic) bothFail += 1
    else if (pair.judge) judgeOnly += 1
    else deterministicOnly += 1
  }

  const observed = (bothPass + bothFail) / n
  const judgePassRate = (bothPass + judgeOnly) / n
  const deterministicPassRate = (bothPass + deterministicOnly) / n
  const expected = judgePassRate * deterministicPassRate + (1 - judgePassRate) * (1 - deterministicPassRate)

  if (expected >= 1) {
    return {
      kappa: null,
      rawAgreement: observed,
      n,
      note: 'one rater never varied, so chance agreement is total and kappa is undefined',
    }
  }
  return { kappa: (observed - expected) / (1 - expected), rawAgreement: observed, n, note: null }
}

/**
 * Below this the judge's number is not reported as a second opinion.
 *
 * 0.6 is the conventional floor for "moderate to substantial" agreement. It is a convention, not a
 * law — recorded here so the threshold is arguable rather than folklore embedded in a comparison.
 */
export const JUDGE_KAPPA_FLOOR = 0.6

/**
 * Minimum sample before kappa is allowed to gate anything.
 *
 * Four questions times three trials is twelve, and kappa on twelve binary judgements swings wildly on
 * a single disagreement. Gating an acceptance run on that would fail releases at random, which is how
 * a gate gets disabled permanently. Below this the value is reported and explicitly not enforced.
 */
export const JUDGE_KAPPA_MIN_SAMPLE = 20
