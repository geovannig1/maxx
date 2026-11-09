// The governed answer's two parts: a short lead (the plain-English summary and the recommended next
// step) and the evidence behind it. The server writes one markdown string because the client replays
// the transcript to the model; the evidence heading is the boundary between the two parts. Client-safe:
// the chat bubble splits on it to put the evidence in a collapsed disclosure.

const EVIDENCE_HEADING = /^\*\*Evidence(?: \((\d+) claims?\))?\*\*$/m

/** `**Evidence (7 claims)**`, or `**Evidence**` when the answer cites no claim. */
export function evidenceHeading(claimCount: number | null): string {
  if (claimCount === null || claimCount <= 0) return '**Evidence**'
  return `**Evidence (${claimCount} claim${claimCount === 1 ? '' : 's'})**`
}

export interface AnswerSections {
  /** Everything before the evidence heading (the whole answer when there is no heading). */
  lead: string
  /** The heading's words without markdown, e.g. "Evidence (7 claims)"; null when absent. */
  evidenceLabel: string | null
  /** The markdown heading line itself; null when absent. */
  evidenceHeadingLine: string | null
  /** Everything after the evidence heading; null when there is no heading. */
  evidence: string | null
}

/** Split an answer at its FIRST evidence heading. Text without one is all lead (older transcripts). */
export function splitAnswerSections(text: string): AnswerSections {
  const match = EVIDENCE_HEADING.exec(text)
  if (!match) return { lead: text.trim(), evidenceLabel: null, evidenceHeadingLine: null, evidence: null }
  return {
    lead: text.slice(0, match.index).trim(),
    evidenceLabel: match[0].replace(/^\*\*|\*\*$/g, ''),
    evidenceHeadingLine: match[0],
    evidence: text.slice(match.index + match[0].length).trim(),
  }
}
