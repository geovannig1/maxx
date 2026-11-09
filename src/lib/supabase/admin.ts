import 'server-only'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Singleton — created once per server process.
// Used only in API routes and sync jobs (bypasses RLS via service role).
// Typed as any until Supabase types are generated via: supabase gen types typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adminClient: SupabaseClient<any> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAdminClient(): SupabaseClient<any> {
  if (!adminClient) {
    adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    )
  }
  return adminClient
}
