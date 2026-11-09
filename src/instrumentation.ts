import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
    // Validate every environment variable once (src/config/env.ts). Problems are logged by name and
    // the app keeps serving so the owner reaches /setup; demo mode in production is fatal.
    const { reportStartupConfiguration } = await import('./config/startup')
    reportStartupConfiguration(process.env, console)
    // Validate the AI configuration once at startup. An invalid value switches AI off with a
    // message naming the variable; it never stops the app, which works fully without AI.
    const { aiStatus, describeAiStatus } = await import('./lib/ai/config')
    const status = aiStatus()
    if (status.state === 'misconfigured') console.error(describeAiStatus(status))
    else console.info(describeAiStatus(status))
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

export const onRequestError = Sentry.captureRequestError
