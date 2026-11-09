// Safety ceilings for the current live-read path. Prepared snapshots will remove
// source retrieval from normal page opening; these are not loading-time targets.
export const REPORTING_REQUEST_TIMEOUT_MS = 120_000
export const REPORTING_IDENTITY_TIMEOUT_MS = 10_000

export class ReportingDeadlineError extends Error {
  constructor() { super('Reporting deadline exceeded'); this.name = 'ReportingDeadlineError' }
}

/** Bounds the caller even if a dependency ignores abort. Cooperative operations
 * receive a signal; an SDK that ignores it may finish work after the caller exits. */
export async function withReportingDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    const stop = (error: Error) => { reject(error); controller.abort(error) }
    cancel = () => stop(new DOMException('Reporting request cancelled.', 'AbortError'))
    if (parent?.aborted) { cancel(); return }
    parent?.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => stop(new ReportingDeadlineError()), timeoutMs)
  })
  try {
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return operation(controller.signal)
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    parent?.removeEventListener('abort', cancel)
  }
}
