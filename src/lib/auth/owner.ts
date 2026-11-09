// Single source of truth for the owner gate. Pure + dependency-free (reads only process.env), so it's
// safe to import from middleware (proxy.ts) AND node API routes.
//
// SECURITY: fail CLOSED everywhere. If OWNER_EMAIL is unset, deny everyone. It used to stay
// permissive outside production, which admitted ANY authenticated user to a dev server reachable from
// another machine (`next dev -H 0.0.0.0`); the request host cannot tell loopback apart reliably (a client
// sets Host), so there is no safe "local only" exception. `npm run setup` and the demo set OWNER_EMAIL.

//
// SECURITY: an email match alone is not ownership. On a project with open sign-ups, a stranger could
// register OWNER_EMAIL; so a Supabase user passes only with a confirmed email (email_confirmed_at).
// `confirmed_at` is deliberately not accepted: GoTrue sets it from EITHER email or phone confirmation.
//
// SECURITY: optional OWNER_USER_ID pins the owner to one Supabase user id (`npm run setup`
// records it). In production a set value must equal `user.id`; a malformed value denies everyone. It is
// not enforced outside production, where a local stack mints new ids on every reset.

export type OwnerGateReason = 'ok' | 'not_owner' | 'unconfirmed' | 'unconfigured'
export type OwnerGateResult = { allowed: boolean; reason: OwnerGateReason }

/** The fields of a Supabase `User` the gate reads. */
export interface OwnerCandidate {
  id?: string | null
  email?: string | null
  email_confirmed_at?: string | null
}

export function isProductionRuntime(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function hasConfirmedEmail(user: OwnerCandidate): boolean {
  return typeof user.email_confirmed_at === 'string' && user.email_confirmed_at.trim() !== ''
}

/**
 * Decide whether an authenticated Supabase user passes the owner gate. Takes the user, not an email
 * string, so the confirmed-email check cannot be skipped.
 */
export function ownerGate(user: OwnerCandidate | null | undefined): OwnerGateResult {
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase()
  if (!ownerEmail) return { allowed: false, reason: 'unconfigured' }
  const email = user?.email
  if (!email || email.trim().toLowerCase() !== ownerEmail) return { allowed: false, reason: 'not_owner' }
  if (!hasConfirmedEmail(user)) return { allowed: false, reason: 'unconfirmed' }
  const pinnedId = process.env.OWNER_USER_ID?.trim().toLowerCase()
  if (pinnedId && isProductionRuntime()) {
    if (!UUID.test(pinnedId)) return { allowed: false, reason: 'unconfigured' }
    if (user.id?.trim().toLowerCase() !== pinnedId) return { allowed: false, reason: 'not_owner' }
  }
  return { allowed: true, reason: 'ok' }
}
