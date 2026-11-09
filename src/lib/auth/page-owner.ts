import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ownerGate } from '@/lib/auth/owner'

/**
 * Server-side owner check for PAGES that render with the service-role client (API routes use
 * ownerOnly() from ./require-owner instead).
 *
 * src/proxy.ts is the first gate. Layouts are not re-run on client-side navigation, so each page
 * calls this itself; React's cache() makes the layout and the page share one Supabase call per
 * request. Fails closed: no session, or a session that is not the configured owner, redirects to
 * /login (in production an unset OWNER_EMAIL also fails closed, and an unconfirmed email never
 * passes, see ownerGate).
 */
export const requireOwner = cache(async (): Promise<{ email: string | undefined }> => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const gate = ownerGate(user)
  if (!gate.allowed) redirect(`/login?error=${gate.reason === 'unconfigured' ? 'owner_unconfigured' : 'unauthorized'}`)
  return { email: user.email }
})
