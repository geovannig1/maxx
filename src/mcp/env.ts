import 'server-only'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// MCP-server env bootstrap. The Next.js app loads .env.local automatically — a standalone
// `tsx src/mcp/server.ts` process does NOT. And MCP client registrations that pass env like
// {"NEXT_PUBLIC_SUPABASE_URL": "${NEXT_PUBLIC_SUPABASE_URL}"} deliver the LITERAL placeholder
// (no shell expansion): non-empty, so it passes an existence check, then explodes at client
// creation with "Invalid supabaseUrl". That leaves every MCP tool failing at startup.
// Fix: when a required var is missing OR obviously invalid, hydrate from the project's
// .env.local directly, so the server works no matter how the launcher (mis)passes env.

/** PURE: parse dotenv-style content into a map. Handles comments, blank lines, `export ` prefixes,
 *  and single/double-quoted values. No interpolation — values are taken literally. */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

/** PURE: is this env value unusable — absent, or an unexpanded `${VAR}` placeholder? */
export function isPlaceholder(value: string | undefined): boolean {
  return !value || /^\$\{.*\}$/.test(value.trim())
}

const REQUIRED = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const
// Optional-at-startup vars that the MCP server will hydrate from .env.local if the launcher did not
// pass them. This keeps the server self-contained even when the client registration omits them.
const OPTIONAL_HYDRATE = ['WRITE_MODE_ENABLED', 'GA4_SERVICE_ACCOUNT_JSON', 'GA4_PROPERTY_ID', 'META_ACCESS_TOKEN', 'META_APP_SECRET', 'ENABLE_MEDIA_BUYER_RECOMMENDATIONS'] as const

function needsHydration(key: string, value: string | undefined): boolean {
  if (key === 'NEXT_PUBLIC_SUPABASE_URL') {
    return isPlaceholder(value) || !/^https?:\/\//.test(value ?? '')
  }
  return isPlaceholder(value)
}

/** Hydrate missing/placeholder required vars from .env.local (checked next to the repo root and
 *  the current working directory). Never overrides a real value; never throws — the caller's
 *  startup validation still owns the failure path. Returns which keys were hydrated. */
export function ensureMcpEnv(): string[] {
  const needed = REQUIRED.filter((k) => needsHydration(k, process.env[k]))
  const optionalNeeded = OPTIONAL_HYDRATE.filter((k) => needsHydration(k, process.env[k]))
  if (needed.length === 0 && optionalNeeded.length === 0) return []

  // src/mcp/env.ts → repo root is two levels up; also try cwd for launcher-dependent layouts.
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(here, '../../.env.local'), resolve(process.cwd(), '.env.local')]

  for (const path of candidates) {
    let parsed: Record<string, string>
    try {
      parsed = parseDotenv(readFileSync(path, 'utf8'))
    } catch {
      continue // no file here — try the next candidate
    }
    const hydrated: string[] = []
    for (const k of [...needed, ...optionalNeeded]) {
      if (parsed[k]) {
        process.env[k] = parsed[k]
        hydrated.push(k)
      }
    }
    if (hydrated.length) {
      // Names only — never log values (service-role key / GA4 private key are secrets).
      console.error(`[MCP] Hydrated ${hydrated.join(', ')} from ${path}`)
      return hydrated
    }
  }
  return []
}
