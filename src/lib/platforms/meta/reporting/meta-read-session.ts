import { metaGet } from '@/lib/platforms/meta/client'

// Local reporting policy, not a claim about the account's Meta quota or reset time.
const CONCURRENCY = 4
const DEADLINE_MS = 80_000 // Finish before the reporting loader's 90-second source deadline.
const FALLBACK_COOLDOWN_MS = 5_000
type Priority = 'core' | 'detail'
interface PendingRead {
  run: () => Promise<void>
  reject: (error: unknown) => void
}

function rateLimited(error: unknown): error is Error & { code: number; retryAfterMs?: number } {
  return error instanceof Error && 'code' in error && typeof error.code === 'number'
    && [4, 17, 613, 80000, 80004, 429].includes(error.code)
}

class MetaReadDeadline extends Error {
  constructor() { super('Meta reporting read deadline reached'); this.name = 'MetaReadDeadline' }
}

export function metaReadFailureNote(error: unknown): string {
  if (rateLimited(error)) return 'Meta temporarily limited reporting reads. Successful results remain available; affected detail can be retried later.'
  if (error instanceof MetaReadDeadline) return 'Meta reporting reached its read deadline. Successful results remain available; affected detail is incomplete.'
  return ''
}

/** One report's GET-only transport. Core pagination outranks optional reads; all scopes survive.
 * A shared cooldown prevents a throttled request from being retried into the original burst.
 * Persistent throttling stops queued work instead of trying every remaining scope in turn.
 * Other reports/processes and non-reporting clients have their own transport and quota usage.
 */
export function createMetaReadSession(): { get: typeof metaGet; coreGet: typeof metaGet; close: () => void } {
  const queues: Record<Priority, PendingRead[]> = { core: [], detail: [] }
  const running = new Set<PendingRead>()
  const controller = new AbortController()
  const deadline = Date.now() + DEADLINE_MS
  let active = 0, notBefore = 0
  let wake: ReturnType<typeof setTimeout> | undefined
  let stopped: Error | undefined
  const expiry = setTimeout(() => stop(new MetaReadDeadline()), DEADLINE_MS)
  expiry.unref?.()

  function stop(error: Error) {
    if (stopped) return
    stopped = error
    clearTimeout(expiry)
    clearTimeout(wake)
    controller.abort(error)
    for (const item of running) item.reject(error)
    for (const queue of Object.values(queues)) {
      for (const item of queue.splice(0)) item.reject(error)
    }
  }

  function drain() {
    if (stopped) return
    if (Date.now() >= deadline) { stop(new MetaReadDeadline()); return }
    clearTimeout(wake)
    const delay = notBefore - Date.now()
    if (delay > 0) {
      wake = setTimeout(drain, delay)
      return
    }
    while (active < CONCURRENCY) {
      const next = queues.core.shift() ?? queues.detail.shift()
      if (!next) return
      active += 1
      running.add(next)
      void next.run().finally(() => { running.delete(next); active -= 1; drain() })
    }
  }

  function reader(priority: Priority): typeof metaGet {
    return <T>(path: string, params: Record<string, string> = {}, options: { signal?: AbortSignal } = {}): Promise<T> => {
      if (stopped) return Promise.reject(stopped)
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
      return new Promise<T>((resolve, reject) => {
        let retried = false
        const pending: PendingRead = { reject, run: async () => {
          try {
            if (signal.aborted) throw signal.reason
            const result = await metaGet<T>(path, params, { signal })
            resolve(result)
          } catch (error) {
            if (stopped) { reject(stopped); return }
            if (!rateLimited(error)) { reject(error); return }
            const suppliedDelay = error.retryAfterMs
            const delay = typeof suppliedDelay === 'number' && Number.isFinite(suppliedDelay) && suppliedDelay >= 0
              ? Math.max(1_000, suppliedDelay) : FALLBACK_COOLDOWN_MS
            notBefore = Math.max(notBefore, Date.now() + delay)
            if (retried || notBefore >= deadline) { stop(error); reject(error); return }
            retried = true
            queues[priority].unshift(pending)
          }
        } }
        queues[priority].push(pending)
        drain()
      })
    }
  }

  return { get: reader('detail'), coreGet: reader('core'), close: () => stop(new Error('Meta reporting read session closed')) }
}
