import { ownerGate, type OwnerCandidate } from './owner'

// Owner authorization for API routes. src/proxy.ts also gates /api/* to the owner (except the
// machine-authenticated and public routes), but every write goes through the service-role admin client
// (RLS bypassed), so each route checks again in its own handler rather than trusting one layer.
// Call it right after the existing getUser() 401 check, passing the authenticated user (so the gate
// can also require a confirmed email):
//
//   const forbidden = ownerOnly(user)
//   if (forbidden) return forbidden
//
// There is no email-string form: the gate needs the user to check that the email is confirmed.
// Fails CLOSED whenever OWNER_EMAIL is unset (see ownerGate).
export function ownerOnly(user: OwnerCandidate | null | undefined): Response | null {
  const gate = ownerGate(user)
  if (!gate.allowed) {
    const error = gate.reason === 'unconfigured' ? 'Owner not configured. Set OWNER_EMAIL.' : 'Forbidden — owner only.'
    return Response.json({ error }, { status: 403 })
  }
  return null
}
