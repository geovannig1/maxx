// Turn an LLM report's markdown blob into scannable, titled sections. The daily + weekly reports store
// full_report_md as one string; rendering it raw (a wall of prose) is the "dumped report" problem. This
// splits it on headings so the UI can lay each part out as its own block with a status accent. Pure + tested.

export interface ReportSection {
  /** Section heading, or null for any preamble before the first heading. */
  title: string | null
  /** The section's markdown body (heading line removed). */
  body: string
}

const HEADING_RE = /^\s{0,3}#{1,4}\s+(.+?)\s*#*\s*$/
// LLMs frequently emit a standalone bold line as a de-facto heading ("**Winners**", "**What to watch:**").
const BOLD_HEADING_RE = /^\s{0,3}\*\*(.+?)\*\*\s*:?\s*$/

/** Split report markdown into titled sections by its headings. Preamble before the first heading keeps
 *  title=null. Empty/blank input → []. */
export function parseReportSections(md: string | null | undefined): ReportSection[] {
  const text = (md ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) return []

  const sections: ReportSection[] = []
  let title: string | null = null
  let body: string[] = []

  const flush = () => {
    const joined = body.join('\n').trim()
    if (title !== null || joined) sections.push({ title, body: joined })
    body = []
  }

  for (const line of text.split('\n')) {
    const h = HEADING_RE.exec(line)
    const b = h ? null : BOLD_HEADING_RE.exec(line)
    if (h || b) {
      flush()
      title = ((h ? h[1] : b![1]) || '').replace(/[:*#]+\s*$/, '').trim() || null
    } else {
      body.push(line)
    }
  }
  flush()
  return sections
}

export type SectionTone = 'default' | 'good' | 'warn' | 'bad'

/** Derive a status accent for a section from its title (quiet good, loud bad). Keeps color
 *  meaningful: a "Winners" section reads calm-positive, a "Losers"/"Action needed" section escalates. */
export function sectionTone(title: string | null): SectionTone {
  const t = (title ?? '').toLowerCase()
  if (/\b(loser|losers|problem|issue|breach|urgent|cut|kill|waste|pause|failing|over.?spend)\b/.test(t)) return 'bad'
  if (/\b(risk|watch|caution|concern|fatigue|attention|watchlist|monitor)\b/.test(t)) return 'warn'
  if (/\b(win|winner|winners|working|strong|scale|healthy|good|top|highlight)\b/.test(t)) return 'good'
  return 'default'
}
