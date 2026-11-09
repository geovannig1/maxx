import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_API_ENV, trapFetch, useAiEnv } from './helpers/ai-stub'

/**
 * Acceptance: with AI off, nothing in Maxx makes a model call.
 *
 * Proved in two halves, neither of which mocks the gateway:
 *
 * 1. BY CONSTRUCTION (static). Only `src/lib/ai` may import a model SDK or name a model API host,
 *    so every model call in the product goes through the gateway. Every module that imports the
 *    gateway is enumerated below; a new one fails this file until it is classified (and, if it
 *    calls a model, added to the dynamic checks).
 * 2. AT THE NETWORK (dynamic). With `AI_PROVIDER=none`, global `fetch` is replaced by a trap that
 *    records and refuses every request. Each gateway entry point and every AI feature is driven, and
 *    the trap must stay empty. A control drives the same trap with AI ON and must record the SDK's
 *    request, which proves the trap sees model traffic at all.
 *
 * Together: no page, report or API path can reach a model with AI off, whatever it renders.
 */

const ROOT = process.cwd()

const state = vi.hoisted(() => ({
  adminCalls: 0,
  rateLimitCalls: 0,
  feedCalls: 0,
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => {
    state.adminCalls += 1
    throw new Error('the database must not be read with AI off in these paths')
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-id', email: 'owner@example.com' } } }) } }),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: () => null }))
vi.mock('@/lib/security/api-rate-limit', () => ({
  enforceApiRateLimit: async () => { state.rateLimitCalls += 1; return null },
}))
vi.mock('@/lib/signals/feed-fetch', () => ({
  fetchPublicHttps: async () => { state.feedCalls += 1; throw new Error('feeds must not be fetched with AI off') },
}))

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : listFiles(full)
    return /\.(ts|tsx|mts|mjs|js)$/.test(name) ? [full] : []
  })
}

const SOURCE_FILES = [...listFiles(path.join(ROOT, 'src')), ...listFiles(path.join(ROOT, 'scripts'))]
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')
const insideGateway = (file: string) => rel(file).startsWith('src/lib/ai/')

const MODEL_SDK_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](@anthropic-ai\/[^'"]+|openai)['"]/
const MODEL_HOSTS = /api\.anthropic\.com|api\.openai\.com|bedrock-(?:mantle|runtime)\.[a-z0-9-]+\.(?:api\.aws|amazonaws\.com)|aiplatform\.googleapis\.com|services\.ai\.azure\.com|generativelanguage\.googleapis\.com/

export function modelSdkImporters(files: string[]): string[] {
  return files.filter((file) => MODEL_SDK_IMPORT.test(readFileSync(file, 'utf8'))).map(rel).sort()
}
export function modelHostMentions(files: string[]): string[] {
  return files.filter((file) => MODEL_HOSTS.test(readFileSync(file, 'utf8'))).map(rel).sort()
}
/** Modules with a VALUE import of the gateway (`import type` is erased and cannot call anything). */
export function gatewayImporters(files: string[]): string[] {
  const valueImport = /^import\s+(?!type\s)[^;]*?from\s+['"](?:@\/lib\/ai|(?:\.\.\/)+src\/lib\/ai|\.\/lib\/ai)(?:\/[a-z-]+)?['"]/m
  const dynamicImport = /import\(\s*['"](?:@\/lib\/ai|\.\/lib\/ai)(?:\/[a-z-]+)?['"]\s*\)/
  return files
    .filter((file) => !insideGateway(file))
    .filter((file) => {
      const source = readFileSync(file, 'utf8')
      return valueImport.test(source) || dynamicImport.test(source)
    })
    .map(rel).sort()
}

/** Every module outside the gateway that imports it, and why. A new entry must be classified here. */
const MODEL_CALLERS = [
  'scripts/eval-maxx.ts', // optional LLM judge (owner-run script)
  'src/lib/competitors/analyze-ad.ts',
  'src/lib/creative/copy-generator.ts', // Copy studio generation (ADR-061), owner-pressed only
  'src/lib/campaigns/plan-ai.ts', // campaign planning (ADR-062), owner-requested drafts only
  'src/lib/creative/vision-analyzer.ts',
  'src/lib/creative/video-generator.ts', // Creatify vendor gate (aiStatus), not a gateway caller
  'src/lib/maxx/chat.ts',
  'src/lib/report/generator.ts',
  // Opt-in live check (`npm run doctor -- --live`, the setup checklist's AI test): one minimal call.
  'src/lib/setup/ai-probe.ts',
  'src/lib/signals/fetcher.ts',
]
const STATUS_READERS = [
  'src/app/(dashboard)/campaigns/new/page.tsx', // says whether "Draft with AI" is available
  'src/app/(dashboard)/creative/copy/page.tsx',
  'src/lib/maxx/chat-actions.ts', // gateway tool types only; its actions call the copy generator and planner
  'src/app/api/creative/copy/generate/route.ts', // answers AI-off before any work; generation is in copy-generator
  'src/app/(dashboard)/maxx/page.tsx',
  'src/app/api/cron/daily-sync/route.ts',
  'src/app/api/health/route.ts',
  'src/app/api/maxx/chat/route.ts',
  'src/instrumentation.ts',
  'src/lib/monitoring/run.ts',
  // Setup, doctor and the in-app checklist validate AI configuration here (readAiConfig).
  'src/lib/setup/config-checks.ts',
  'src/lib/signals/judge-attempts.ts', // gateway error classes only (instanceof); makes no model call
]

describe('by construction: every model call goes through src/lib/ai', () => {
  it('no module outside the gateway imports a model SDK', () => {
    const outside = modelSdkImporters(SOURCE_FILES.filter((file) => !insideGateway(file)))
    expect(outside).toEqual([])
    // Control: the scan does see the gateway's own SDK imports.
    expect(modelSdkImporters(SOURCE_FILES.filter(insideGateway))).toContain('src/lib/ai/anthropic.ts')
  })

  it('no module outside the gateway names a model API host', () => {
    expect(modelHostMentions(SOURCE_FILES.filter((file) => !insideGateway(file)))).toEqual([])
  })

  it('every gateway importer is classified as a model caller or a status reader', () => {
    expect(gatewayImporters(SOURCE_FILES)).toEqual([...MODEL_CALLERS, ...STATUS_READERS].sort())
  })

  it('control: the scans report planted violations', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-off-scan-'))
    try {
      const sdk = path.join(dir, 'sdk.ts')
      const host = path.join(dir, 'host.ts')
      const gateway = path.join(dir, 'gateway.ts')
      const typeOnly = path.join(dir, 'type-only.ts')
      writeFileSync(sdk, "import Anthropic from '@anthropic-ai/sdk'\nexport const c = new Anthropic()\n")
      writeFileSync(host, "export const u = 'https://api.openai.com/v1/chat/completions'\n")
      writeFileSync(gateway, "import { generateText } from '@/lib/ai'\nexport const g = generateText\n")
      writeFileSync(typeOnly, "import type { AiImage } from '@/lib/ai'\nexport type I = AiImage\n")
      expect(modelSdkImporters([sdk, host])).toHaveLength(1)
      expect(modelHostMentions([sdk, host])).toHaveLength(1)
      expect(gatewayImporters([gateway, typeOnly])).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('at the network: AI_PROVIDER=none makes no request', () => {
  let trap: ReturnType<typeof trapFetch>

  beforeEach(() => {
    state.adminCalls = 0
    state.rateLimitCalls = 0
    state.feedCalls = 0
    useAiEnv({ AI_PROVIDER: 'none', ANTHROPIC_API_KEY: 'k-test-1', OPENAI_COMPATIBLE_BASE_URL: 'http://stub.local/v1' })
    vi.stubEnv('MAXX_CHAT_ENABLED', 'true')
    vi.stubEnv('CREATIFY_API_KEY', 'k-test-2')
    trap = trapFetch()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    // Every case below must leave the trap empty.
    expect(trap.requests).toEqual([])
  })

  it('control: the same trap DOES record the SDK request when AI is on', async () => {
    useAiEnv({ ...CLAUDE_API_ENV })
    const { generateText } = await import('@/lib/ai')
    await expect(generateText({ feature: 'eval_judge', system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000 })).rejects.toThrow()
    expect(trap.requests.length).toBeGreaterThan(0)
    expect(new URL(trap.requests[0].url).host).toBe('api.anthropic.com')
    trap.requests.length = 0 // the AI-off assertion in afterEach applies to the cases below
  })

  it('every gateway entry point refuses before building a client', async () => {
    const { completeTurn, generateStructured, generateText, AiDisabledError } = await import('@/lib/ai')
    const single = { feature: 'eval_judge' as const, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000 }
    await expect(generateText(single)).rejects.toBeInstanceOf(AiDisabledError)
    await expect(generateStructured({ ...single, format: { name: 'x', schema: { type: 'object' } } })).rejects.toBeInstanceOf(AiDisabledError)
    await expect(completeTurn({ ...single, messages: [{ role: 'user', text: 'u' }] })).rejects.toBeInstanceOf(AiDisabledError)
  })

  it('owner chat: "AI is off", and the route refuses before the rate limit', async () => {
    const { runMaxxChat, maxxChatEnabled } = await import('@/lib/maxx/chat')
    expect(maxxChatEnabled()).toBe(false)
    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])
    expect(answer).toMatchObject({ availability: 'unavailable' })
    expect(answer.text).toMatch(/AI is off/)

    const { POST } = await import('@/app/api/maxx/chat/route')
    const response = await POST(new NextRequest('http://localhost/api/maxx/chat', {
      method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'What was spend?' }] }),
    }))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'AI_OFF', disabled: true })
    expect(state.rateLimitCalls).toBe(0)
    expect(state.adminCalls).toBe(0)
  })

  it('competitor analysis, signals and creative vision do nothing at all', async () => {
    const { analyzeUnprocessedAds } = await import('@/lib/competitors/analyze-ad')
    const { runSignalsFetcher } = await import('@/lib/signals/fetcher')
    const { analyzeCreative, runVisionAnalysisForPending } = await import('@/lib/creative/vision-analyzer')

    expect(await analyzeUnprocessedAds('00000000-0000-4000-8000-000000000001')).toBe(0)
    expect(await runSignalsFetcher('00000000-0000-4000-8000-000000000001')).toMatchObject({ skipped: 'ai_off' })
    expect(await runVisionAnalysisForPending('00000000-0000-4000-8000-000000000001')).toBe(0)
    expect(await analyzeCreative({
      id: '00000000-0000-4000-8000-000000000923', ad_account_id: '00000000-0000-4000-8000-000000000921',
      creative_id: '1000000000000005', thumbnail_url: 'https://scontent.example/x.jpg',
    })).toBeNull()
    expect(state.adminCalls).toBe(0)
    expect(state.feedCalls).toBe(0)
  })

  it('the legacy report narrative and the Creatify vendor refuse with a typed error', async () => {
    const { AiDisabledError } = await import('@/lib/ai')
    const { generateReport } = await import('@/lib/report/generator')
    const { getAvailableAvatars, checkVideoStatus } = await import('@/lib/creative/video-generator')
    await expect(generateReport('s', 'u')).rejects.toBeInstanceOf(AiDisabledError)
    await expect(getAvailableAvatars()).rejects.toBeInstanceOf(AiDisabledError)
    await expect(checkVideoStatus('job-1')).rejects.toBeInstanceOf(AiDisabledError)
  })

  it('an INVALID configuration is off too, never a half-working client', async () => {
    useAiEnv({ AI_PROVIDER: 'anthropic' }) // no credential
    const { generateText, aiStatus, AiDisabledError } = await import('@/lib/ai')
    expect(aiStatus().state).toBe('misconfigured')
    await expect(generateText({ feature: 'eval_judge', system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000 }))
      .rejects.toBeInstanceOf(AiDisabledError)
    const { maxxChatEnabled } = await import('@/lib/maxx/chat')
    expect(maxxChatEnabled()).toBe(false)
  })
})
