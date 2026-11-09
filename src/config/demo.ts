// Sample-data mode (`npm run demo`, the v1 release). Dependency-free so next.config.ts, the
// instrumentation hook and server components can all ask the same question.
//
// Demo mode is explicit (MAXX_DEMO=1) and can never be on in a production runtime or on Vercel: there
// the value is refused, the server will not start (instrumentation) and the build will not run
// (next.config.ts). Demo mode adds no authentication bypass of its own: the demo launcher points the
// app at a loopback sample backend and signs in a fictional owner through the normal owner gate.

export type DemoState = 'off' | 'on' | 'refused'

type Env = Record<string, string | undefined>

export const DEMO_ENV = 'MAXX_DEMO'

export function demoState(env: Env): DemoState {
  if (env.MAXX_DEMO?.trim() !== '1') return 'off'
  const production = env.NODE_ENV?.trim() === 'production'
  const onVercel = Boolean(env.VERCEL?.trim() || env.VERCEL_ENV?.trim())
  return production || onVercel ? 'refused' : 'on'
}

/** True only when demo mode is on and allowed. A refused value is off here and fatal at startup. */
export function isDemoMode(env: Env = process.env): boolean {
  return demoState(env) === 'on'
}

export const DEMO_REFUSED_MESSAGE =
  'MAXX_DEMO=1 is refused in production and on Vercel: sample-data mode is for `npm run demo` on your own machine. Unset MAXX_DEMO.'

/** Throws when demo mode is requested where it is never allowed. */
export function assertDemoAllowed(env: Env): void {
  if (demoState(env) === 'refused') throw new Error(DEMO_REFUSED_MESSAGE)
}
