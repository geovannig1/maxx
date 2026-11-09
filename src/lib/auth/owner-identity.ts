// Defence in depth beside the owner gate (src/lib/auth/owner.ts), at every service entry that receives
// the owner's user id (ADR-059 proposals, ADR-062 plans). Pure; reads only process.env.

/**
 * When OWNER_USER_ID is pinned, the id must equal it, compared exactly as ownerGate compares it
 * (trimmed, case-insensitive; security review L6). An empty id never passes. Unlike the route gate this
 * applies in every runtime: the id here comes from the signed-in session, never from a request body.
 */
export function ownerUserIdMismatch(ownerUserId: string | null | undefined): boolean {
  const id = ownerUserId?.trim().toLowerCase()
  if (!id) return true
  const pinned = process.env.OWNER_USER_ID?.trim().toLowerCase()
  return pinned !== undefined && pinned !== '' && pinned !== id
}
