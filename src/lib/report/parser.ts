import { nyToday } from '@/lib/utils/date-utils'

export interface ParsedTask {
  title: string
  description: string
  priority: 'urgent' | 'high' | 'medium' | 'low'
  due_date: string
}

const TODAY = () => nyToday()

function parsePriority(line: string): 'urgent' | 'high' | 'medium' | 'low' {
  const upper = line.toUpperCase()
  if (upper.includes('URGENT') || upper.startsWith('- URGENT') || upper.startsWith('* URGENT')) {
    return 'urgent'
  }
  if (upper.includes('HIGH')) return 'high'     // identity — matches normalizePriority (JSON path)
  if (upper.includes('MEDIUM')) return 'medium'
  if (upper.includes('LOW')) return 'low'
  return 'medium'
}

function cleanBullet(line: string): string {
  return line.replace(/^[-*•]\s*/, '').trim()
}

/**
 * Tries to extract tasks from the structured ```tasks JSON block first.
 * Falls back to parsing bullet points under "## What To Do Today".
 */
export function extractTasksFromMarkdown(markdown: string): ParsedTask[] {
  // Prefer structured JSON block (more reliable)
  const jsonTasks = extractTasksFromJsonBlock(markdown)
  if (jsonTasks.length > 0) return jsonTasks

  // Fall back to bullet extraction
  return extractTasksFromBullets(markdown)
}

function extractTasksFromJsonBlock(markdown: string): ParsedTask[] {
  const blockRegex = /```tasks\s*([\s\S]*?)```/i
  const match = blockRegex.exec(markdown)
  if (!match) return []

  try {
    const raw = JSON.parse(match[1].trim()) as Array<{
      title?: string
      priority?: string
      description?: string
      due_date?: string | null
    }>

    if (!Array.isArray(raw)) return []

    return raw
      .filter((item) => typeof item.title === 'string' && item.title.trim())
      .map((item) => ({
        title: (item.title ?? '').slice(0, 150),
        description: item.description ?? item.title ?? '',
        priority: normalizePriority(item.priority ?? ''),
        due_date: item.due_date ?? TODAY(),
      }))
  } catch {
    return []
  }
}

function normalizePriority(value: string): 'urgent' | 'high' | 'medium' | 'low' {
  const v = value.toLowerCase()
  if (v === 'urgent') return 'urgent'
  if (v === 'high') return 'high'
  if (v === 'medium') return 'medium'
  if (v === 'low') return 'low'
  return 'medium'
}

function extractTasksFromBullets(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = []
  const dueDate = TODAY()

  const sectionRegex = /^##\s+What\s+To\s+Do\s+Today\b/im
  const sectionMatch = sectionRegex.exec(markdown)
  if (!sectionMatch) return tasks

  const afterSection = markdown.slice(sectionMatch.index + sectionMatch[0].length)
  const nextHeaderMatch = /^##\s+/m.exec(afterSection)
  const sectionBody = nextHeaderMatch
    ? afterSection.slice(0, nextHeaderMatch.index)
    : afterSection

  const bulletLines = sectionBody
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*•]/.test(l))

  for (const line of bulletLines) {
    const cleaned = cleanBullet(line)
    if (!cleaned) continue

    tasks.push({
      title: cleaned.slice(0, 150),
      description: cleaned,
      priority: parsePriority(cleaned),
      due_date: dueDate,
    })
  }

  return tasks
}

/**
 * Returns the first paragraph after "## Executive Summary", or the first 300 chars of the markdown.
 */
export function extractSummaryFromMarkdown(markdown: string): string {
  const sectionRegex = /^##\s+Executive\s+Summary\b/im
  const sectionMatch = sectionRegex.exec(markdown)

  if (sectionMatch) {
    const afterSection = markdown.slice(sectionMatch.index + sectionMatch[0].length).trim()

    // Split into paragraphs and return the first non-empty one
    const paragraphs = afterSection.split(/\n\n+/)
    for (const para of paragraphs) {
      const trimmed = para.trim()
      // Skip lines that look like headers or bullet lists
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-')) {
        return trimmed.slice(0, 500)
      }
    }
  }

  // Fallback: first 300 chars of raw markdown
  return markdown.slice(0, 300).trim()
}
