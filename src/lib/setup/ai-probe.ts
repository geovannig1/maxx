import 'server-only'

/**
 * The opt-in live AI check (`npm run doctor -- --live`, the checklist's AI test): one minimal call
 * through the AI gateway with the process environment. A few tokens at most; the reply text is not
 * shown, only who answered and how the turn ended.
 */
export async function liveAiProbe(): Promise<string> {
  const { completeTurn } = await import('@/lib/ai')
  const response = await completeTurn({
    feature: 'setup_check',
    system: 'This is a connectivity check. Reply with the single word OK.',
    messages: [{ role: 'user', text: 'OK?' }],
    maxTokens: 16,
    timeoutMs: 30_000,
    effort: 'low',
  })
  return `${response.provider}/${response.model} answered (stop: ${response.stop}).`
}
