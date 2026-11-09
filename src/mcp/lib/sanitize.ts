const INJECTION_PATTERNS = [
  /\bignore\b.{0,50}\b(previous|above|all)\b.{0,30}\binstructions?\b/gi,
  /\bsystem\s+prompt\b/gi,
  /\bforget\b.{0,20}\b(everything|context|instructions)\b/gi,
  /\byou\s+are\s+now\b/gi,
  /\bact\s+as\b/gi,
  /\bpretend\b.{0,20}\b(you|to)\b/gi,
]

export function sanitizeString(value: string | null | undefined, maxLength = 200): string {
  if (!value) return ''
  let sanitized = value
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[FILTERED]')
  }
  return sanitized.slice(0, maxLength)
}

export function sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = { ...obj }
  for (const key of Object.keys(result)) {
    if (typeof result[key] === 'string') {
      result[key] = sanitizeString(result[key] as string)
    }
  }
  return result as T
}
