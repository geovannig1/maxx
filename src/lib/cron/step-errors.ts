// Scheduled-job step failures: the error text is logged server-side and kept for the owner-only sync
// log, while the HTTP response only ever carries the stable STEP_FAILED code.

const MAX_DETAIL = 500

export function createStepErrorRecorder(job: string): {
  stepErrors: Record<string, string>
  stepFailed: (step: string, error: unknown) => { error: 'STEP_FAILED' }
} {
  const stepErrors: Record<string, string> = {}
  const stepFailed = (step: string, error: unknown): { error: 'STEP_FAILED' } => {
    const detail = error instanceof Error ? error.message
      : error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message)
        : String(error)
    stepErrors[step] = detail.slice(0, MAX_DETAIL)
    console.error(`[${job}] step ${step} failed:`, detail)
    return { error: 'STEP_FAILED' }
  }
  return { stepErrors, stepFailed }
}
