// Who may see the setup checklist. Dependency-free: src/proxy.ts and the /setup
// page both decide with it, so they cannot disagree.
//
// - `public`: nobody can sign in yet (the Supabase public values are missing, or OWNER_EMAIL is unset so
//   the owner gate denies everyone, in development too). The page then shows only the NAMES of missing
//   variables and the steps; no value, no connection test, no setting.
// - `owner`: sign-in works, so the checklist is owner-only like every other page.

type Env = Record<string, string | undefined>

const set = (env: Env, name: string) => Boolean(env[name]?.trim())

export function supabasePublicConfigured(env: Env): boolean {
  return set(env, 'NEXT_PUBLIC_SUPABASE_URL') && set(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY')
}

export function setupAccessMode(env: Env): 'public' | 'owner' {
  if (!supabasePublicConfigured(env)) return 'public'
  return set(env, 'OWNER_EMAIL') ? 'owner' : 'public'
}
