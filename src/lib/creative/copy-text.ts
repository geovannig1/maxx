// Pure text helpers for the copy scorer: tokenising, phrase matching on word boundaries, a readability
// grade and a near-duplicate measure. No dependencies, so every rule built on them is deterministic.

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim()
}

export function words(text: string): string[] {
  return normalizeText(text).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []
}

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s))
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whole-phrase, case-insensitive match: "elevate" matches "Elevate," but not "elevated". */
export function containsPhrase(text: string, phrase: string): boolean {
  const p = normalizeText(phrase)
  if (!p) return false
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(p)}(?![\\p{L}\\p{N}])`, 'u').test(normalizeText(text))
}

/** English syllable estimate (vowel groups, silent trailing e). Good enough for a grade band. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!w) return 0
  if (w.length <= 3) return 1
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '')
  return Math.max(1, (trimmed.match(/[aeiouy]{1,2}/g) ?? []).length)
}

/** Flesch-Kincaid grade level; null below five words, where the formula says nothing useful. */
export function fleschKincaidGrade(text: string): number | null {
  const ws = words(text)
  if (ws.length < 5) return null
  const sentenceCount = Math.max(1, sentences(text).length)
  const syllableCount = ws.reduce((total, w) => total + syllables(w), 0)
  const grade = 0.39 * (ws.length / sentenceCount) + 11.8 * (syllableCount / ws.length) - 15.59
  return Math.round(grade * 10) / 10
}

function bigrams(text: string): Set<string> {
  const ws = words(text)
  if (ws.length < 2) return new Set(ws)
  const out = new Set<string>()
  for (let i = 0; i < ws.length - 1; i++) out.add(`${ws[i]} ${ws[i + 1]}`)
  return out
}

/** Jaccard similarity of word bigrams, 0..1. Identical copy is 1; unrelated copy is near 0. */
export function similarity(a: string, b: string): number {
  const x = bigrams(a)
  const y = bigrams(b)
  if (x.size === 0 && y.size === 0) return 0
  let shared = 0
  for (const gram of x) if (y.has(gram)) shared++
  return Math.round((shared / (x.size + y.size - shared)) * 100) / 100
}

/** Adjacent word pairs (both 4+ letters) from the verified facts: the concrete phrases a hook can name. */
export function factBigrams(statements: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const statement of statements) {
    const ws = words(statement)
    for (let i = 0; i < ws.length - 1; i++) {
      if (ws[i].length >= 4 && ws[i + 1].length >= 4) out.add(`${ws[i]} ${ws[i + 1]}`)
    }
  }
  return out
}
