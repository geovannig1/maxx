import { AI_EFFORTS, AI_PROVIDERS } from '../lib/ai/config'
import { formats, hasEnv, v, when, type EnvRecord, type EnvVarSpec } from './env-spec'
import { DEFAULT_GA4_BOOKING_EVENT, DEFAULT_GA4_INTENT_EVENTS, DEFAULT_GA4_LEAD_EVENTS } from '../lib/ga4/event-names'

// Optional integrations (GA4, AI, email, monitoring), feature switches, host-provided values and
// operator tooling. AI cross-field rules (which provider needs which value) are owned by
// src/lib/ai/config.ts; the requirements below only mirror them for documentation and the checklist.

const provider = (env: EnvRecord) => env.AI_PROVIDER?.trim()
const emailProvider = (env: EnvRecord, value: string) =>
  env.DAILY_DIGEST_EMAIL_PROVIDER?.trim() === value || env.WEEKLY_EXECUTIVE_EMAIL_PROVIDER?.trim() === value
const EMAIL_PROVIDERS = ['gmail_smtp', 'resend'] as const

export const EXTRA_ENV_VARS: EnvVarSpec[] = [
  // GA4
  v('GA4_PROPERTY_ID', 'ga4', 'GA4 property id for web telemetry. Optional; needs GA4_SERVICE_ACCOUNT_JSON.', {
    format: formats.digits, required: when('when GA4_SERVICE_ACCOUNT_JSON is set', (env) => hasEnv(env, 'GA4_SERVICE_ACCOUNT_JSON')),
  }),
  v('GA4_SERVICE_ACCOUNT_JSON', 'ga4', 'The full service-account JSON key on one line; the account needs Viewer on the property.', {
    secret: true, format: formats.serviceAccountJson, required: when('when GA4_PROPERTY_ID is set', (env) => hasEnv(env, 'GA4_PROPERTY_ID')),
  }),
  v('GA4_BOOKING_EVENT', 'ga4', 'GA4 event name that marks an outcome on your website; the website report counts it as Confirmation events.', {
    format: formats.ga4EventName, default: DEFAULT_GA4_BOOKING_EVENT,
  }),
  v('GA4_INTENT_EVENTS', 'ga4', 'GA4 events counted as Intent events on the website report (a visitor starting to buy or book), comma-separated.', {
    format: formats.ga4EventNames, default: DEFAULT_GA4_INTENT_EVENTS,
  }),
  v('GA4_LEAD_EVENTS', 'ga4', 'GA4 events counted as Lead events on the website report (an enquiry or form submission), comma-separated.', {
    format: formats.ga4EventNames, default: DEFAULT_GA4_LEAD_EVENTS,
  }),
  // AI
  v('AI_PROVIDER', 'ai', 'AI provider: anthropic, bedrock, vertex, foundry, openai-compatible or none. Unset means anthropic when a Claude key is present, else off. Every report works with AI off.', {
    format: formats.oneOf(AI_PROVIDERS), setup: 'ask', prompt: `AI provider (${AI_PROVIDERS.join(', ')})`,
  }),
  v('AI_MODEL', 'ai', 'Model id. Defaults to claude-opus-5-5 (Bedrock: anthropic.claude-opus-5-5); required for openai-compatible.', {
    format: formats.modelId, required: when('when AI_PROVIDER=openai-compatible', (env) => provider(env) === 'openai-compatible'),
  }),
  v('AI_EFFORT', 'ai', 'Effort for chat: low, medium, high, xhigh, max, or none for models without effort. Batch features use low.', {
    format: formats.oneOf([...AI_EFFORTS, 'none']), default: 'medium',
  }),
  v('AI_FALLBACKS', 'ai', 'Refusal fallback: default (Claude API server-side), off, or 1-3 comma-separated model ids.', { format: formats.nonEmpty }),
  v('ANTHROPIC_API_KEY', 'ai', 'Claude API key (AI_PROVIDER=anthropic, or unset).', {
    secret: true, format: formats.nonEmpty, setup: 'ask', prompt: 'Claude API key',
    required: when('when AI_PROVIDER=anthropic and ANTHROPIC_AUTH_TOKEN is unset', (env) => provider(env) === 'anthropic' && !hasEnv(env, 'ANTHROPIC_AUTH_TOKEN')),
  }),
  v('ANTHROPIC_AUTH_TOKEN', 'ai', 'Claude API bearer token, an alternative to ANTHROPIC_API_KEY.', { secret: true, format: formats.nonEmpty }),
  v('AWS_REGION', 'ai', 'AWS region for AI_PROVIDER=bedrock (or AWS_DEFAULT_REGION).', {
    format: formats.nonEmpty, required: when('when AI_PROVIDER=bedrock and AWS_DEFAULT_REGION is unset', (env) => provider(env) === 'bedrock' && !hasEnv(env, 'AWS_DEFAULT_REGION')),
  }),
  v('AWS_DEFAULT_REGION', 'ai', 'Fallback AWS region for Bedrock.', { format: formats.nonEmpty }),
  v('AWS_ACCESS_KEY_ID', 'ai', 'Bedrock credentials, read by the AWS SDK credential chain (or use a role or profile).', { secret: true, format: formats.nonEmpty, scope: 'platform' }),
  v('AWS_SECRET_ACCESS_KEY', 'ai', 'Bedrock credentials, read by the AWS SDK credential chain.', { secret: true, format: formats.nonEmpty, scope: 'platform' }),
  v('AWS_SESSION_TOKEN', 'ai', 'Temporary Bedrock credentials, read by the AWS SDK credential chain.', { secret: true, format: formats.nonEmpty, scope: 'platform' }),
  v('CLOUD_ML_REGION', 'ai', 'Vertex AI region for AI_PROVIDER=vertex.', { format: formats.nonEmpty, default: 'global' }),
  v('ANTHROPIC_VERTEX_PROJECT_ID', 'ai', 'Google Cloud project for Vertex AI.', { format: formats.nonEmpty }),
  v('GOOGLE_APPLICATION_CREDENTIALS', 'ai', 'Path to Google credentials for Vertex AI, read by the Google auth library.', { format: formats.nonEmpty, scope: 'platform' }),
  v('ANTHROPIC_FOUNDRY_RESOURCE', 'ai', 'Microsoft Foundry resource name (or ANTHROPIC_FOUNDRY_BASE_URL).', {
    format: formats.nonEmpty, required: when('when AI_PROVIDER=foundry and ANTHROPIC_FOUNDRY_BASE_URL is unset', (env) => provider(env) === 'foundry' && !hasEnv(env, 'ANTHROPIC_FOUNDRY_BASE_URL')),
  }),
  v('ANTHROPIC_FOUNDRY_BASE_URL', 'ai', 'Microsoft Foundry endpoint URL.', { format: formats.httpUrl }),
  v('ANTHROPIC_FOUNDRY_API_KEY', 'ai', 'Microsoft Foundry API key.', {
    secret: true, format: formats.nonEmpty, required: when('when AI_PROVIDER=foundry', (env) => provider(env) === 'foundry'),
  }),
  v('OPENAI_COMPATIBLE_BASE_URL', 'ai', 'Base URL of an OpenAI-compatible server, e.g. http://localhost:11434/v1.', {
    format: formats.httpUrl, required: when('when AI_PROVIDER=openai-compatible', (env) => provider(env) === 'openai-compatible'),
  }),
  v('OPENAI_COMPATIBLE_API_KEY', 'ai', 'API key for the OpenAI-compatible server, if it needs one.', { secret: true, format: formats.nonEmpty }),
  v('OPENAI_COMPATIBLE_MAX_TOKENS_FIELD', 'ai', 'max_tokens or max_completion_tokens, whichever the server accepts.', {
    format: formats.oneOf(['max_tokens', 'max_completion_tokens']), default: 'max_tokens',
  }),
  v('MAXX_CHAT_ENABLED', 'ai', 'Exactly `true` turns on owner chat (it also needs a configured AI provider).', { format: formats.trueOnly, default: 'false' }),
  v('CREATIFY_API_KEY', 'ai', 'Optional Creatify key for video generation; blocked while AI is off.', { secret: true, format: formats.nonEmpty }),
  // Email
  v('DAILY_DIGEST_EMAIL_PROVIDER', 'email', 'Daily digest delivery: gmail_smtp or resend. Unset skips the digest.', { format: formats.oneOf(EMAIL_PROVIDERS) }),
  v('WEEKLY_EXECUTIVE_EMAIL_PROVIDER', 'email', 'Weekly executive email delivery: gmail_smtp or resend (defaults to the daily provider).', { format: formats.oneOf(EMAIL_PROVIDERS) }),
  v('DAILY_DIGEST_FROM_EMAIL', 'email', 'From address for both emails.', { format: formats.email }),
  v('GMAIL_SMTP_USER', 'email', 'Gmail account that sends through SMTP.', {
    secret: true, format: formats.email, required: when('when an email provider is gmail_smtp', (env) => emailProvider(env, 'gmail_smtp')),
  }),
  v('GMAIL_SMTP_APP_PASSWORD', 'email', 'A 16-character Gmail App Password (spaces allowed).', {
    secret: true, format: formats.nonEmpty, required: when('when an email provider is gmail_smtp', (env) => emailProvider(env, 'gmail_smtp')),
  }),
  v('RESEND_API_KEY', 'email', 'Resend API key.', {
    secret: true, format: formats.nonEmpty, required: when('when an email provider is resend', (env) => emailProvider(env, 'resend')),
  }),
  v('MAXX_DAILY_EXECUTIVE_EMAIL_ENABLED', 'email', 'Exactly `true` sends the daily executive email from the daily cron.', { format: formats.trueOnly, default: 'false' }),
  v('MAXX_WEEKLY_EXECUTIVE_EMAIL_ENABLED', 'email', 'Exactly `true` sends the weekly executive email.', { format: formats.trueOnly, default: 'false' }),
  // Monitoring
  v('SENTRY_DSN', 'monitoring', 'Server-side Sentry DSN; Sentry is off when unset.', { format: formats.httpUrl }),
  v('NEXT_PUBLIC_SENTRY_DSN', 'monitoring', 'Browser Sentry DSN. Set at build time or its origin is left out of the CSP connect-src.', { format: formats.httpUrl, scope: 'build' }),
  v('SENTRY_AUTH_TOKEN', 'monitoring', 'Build-time token that uploads source maps to Sentry (then deletes them from the build).', { secret: true, format: formats.nonEmpty, scope: 'build' }),
  v('SENTRY_ORG', 'monitoring', 'Sentry organization slug for the source-map upload (read by the Sentry build plugin).', { format: formats.nonEmpty, scope: 'build' }),
  v('SENTRY_PROJECT', 'monitoring', 'Sentry project slug for the source-map upload (read by the Sentry build plugin).', { format: formats.nonEmpty, scope: 'build' }),
  // Feature switches
  v('ENABLE_MEDIA_BUYER_RECOMMENDATIONS', 'features', 'Exactly `true` enables the pragmatic media-buyer recommendation lane.', { format: formats.trueOnly, default: 'false' }),
  v('MAXX_COCKPIT_TRENDS', 'features', '`off` suppresses the extra live Graph reads behind cockpit trend claims, without a deploy.', { format: formats.oneOf(['on', 'off']) }),
  v('REPORTING_PREPARED_ENABLED', 'features', 'Exactly `true` serves prepared (snapshot) reporting responses.', { format: formats.trueOnly, default: 'false' }),
  // Public origin
  v('APP_URL', 'platform', 'The public URL the browser uses for Maxx, e.g. https://maxx.example.com. Sign-in redirects and the same-origin check on every change use it: behind `next start` (and most reverse proxies) the server only sees localhost. Required in production off Vercel; on Vercel the deployment hosts are used when it is unset.', {
    format: formats.httpUrl, example: 'https://maxx.example.com',
    required: when('in production off Vercel', (env) => !env.VERCEL?.trim() && (env.NODE_ENV?.trim() === 'production' || env.VERCEL_ENV?.trim() === 'production')),
  }),
  // Set by the host
  v('NODE_ENV', 'platform', 'Set by Next.js: production for `next build`/`next start` and on Vercel. Production makes the owner gate fail closed.', { format: formats.oneOf(['development', 'production', 'test']), scope: 'platform' }),
  v('NEXT_RUNTIME', 'platform', 'Set by Next.js: nodejs or edge.', { format: formats.oneOf(['nodejs', 'edge']), scope: 'platform' }),
  v('VERCEL', 'platform', 'Set by Vercel to 1 on its build and runtime. Demo mode is refused when it is set.', { format: formats.any, scope: 'platform' }),
  v('VERCEL_ENV', 'platform', 'Set by Vercel: production, preview or development.', { format: formats.oneOf(['production', 'preview', 'development']), scope: 'platform' }),
  v('VERCEL_URL', 'platform', 'Set by Vercel: the deployment host.', { format: formats.nonEmpty, scope: 'platform' }),
  v('VERCEL_PROJECT_PRODUCTION_URL', 'platform', 'Set by Vercel: the production host.', { format: formats.nonEmpty, scope: 'platform' }),
  v('VERCEL_GIT_COMMIT_SHA', 'platform', 'Set by Vercel: the deployed commit.', { format: formats.nonEmpty, scope: 'platform' }),
  v('VERCEL_DEPLOYMENT_ID', 'platform', 'Set by Vercel: the deployment id.', { format: formats.nonEmpty, scope: 'platform' }),
  v('CI', 'platform', 'Set by CI systems. Setup and the install message are silent and non-interactive when it is set.', { format: formats.any, scope: 'platform' }),
  // Operator tooling
  v('MAXX_DEMO', 'tooling', 'Set to 1 only by `npm run demo`: sample data, no accounts. Refused in production (the server will not start).', { format: formats.oneOf(['0', '1']), scope: 'script' }),
  v('MAXX_ENV_FILE', 'tooling', 'Env file that setup and doctor read and write (default .env.local).', { format: formats.nonEmpty, scope: 'script', default: '.env.local' }),
  v('MAXX_EVAL_QUESTIONS_FILE', 'tooling', 'Question file for `npm run eval:golden`.', { format: formats.nonEmpty, scope: 'script' }),
]
