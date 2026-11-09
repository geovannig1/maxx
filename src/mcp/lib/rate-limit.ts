const callCounts = new Map<string, { count: number; resetAt: number }>()

export function checkRateLimit(toolName: string, maxPerMinute = 30): void {
  const now = Date.now()
  const entry = callCounts.get(toolName)

  if (!entry || now > entry.resetAt) {
    callCounts.set(toolName, { count: 1, resetAt: now + 60_000 })
    return
  }

  if (entry.count >= maxPerMinute) {
    throw new Error(`Tool "${toolName}" rate limit exceeded. Max ${maxPerMinute} calls/minute.`)
  }
  entry.count++
}
