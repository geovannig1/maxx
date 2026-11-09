import type { User, UserResponse } from '@supabase/supabase-js'
import { REPORTING_IDENTITY_TIMEOUT_MS, withReportingDeadline } from './deadline'

/** A provider/network failure is not proof that the owner needs a new email.
 * Only a missing user or an explicit non-rate-limited client rejection requires sign-in. */
export async function readReportingUser(read: () => Promise<UserResponse>, signal?: AbortSignal): Promise<User | null> {
  const result = await withReportingDeadline(() => read(), REPORTING_IDENTITY_TIMEOUT_MS, signal)
  if (result.error) {
    const status = result.error.status
    if (!status || status < 400 || status >= 500 || status === 429) throw new Error('Reporting session verification is temporarily unavailable.')
    return null
  }
  return result.data.user
}
