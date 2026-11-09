import { LowDataNotice } from '@/components/ui/LowDataNotice'
import type { ActiveAccountErrorCode } from '@/lib/accounts/active-account'

const MESSAGE: Record<ActiveAccountErrorCode, string> = {
  ACTIVE_ACCOUNT_NOT_FOUND: 'No active ad account is configured. Maxx cannot present account data until exactly one account is active.',
  ACTIVE_ACCOUNT_AMBIGUOUS: 'More than one active ad account is configured. Maxx will not combine them or choose one silently.',
  ACTIVE_ACCOUNT_UNAVAILABLE: 'The active ad account could not be resolved. Maxx will not present an empty account as if the read succeeded.',
}

// The raw code stays on the data-active-account-error attribute below, where tests and support can read
// it. It used to be appended to the visible message as "Reference: ACTIVE_ACCOUNT_NOT_FOUND." too, which
// put an internal identifier in front of the owner for no benefit.
export function ActiveAccountUnavailableNotice({ code }: { code: ActiveAccountErrorCode }) {
  return (
    <div role="alert" data-active-account-error={code}>
      <LowDataNotice
        title="Account data unavailable"
        message={MESSAGE[code]}
        tone="warning"
      />
    </div>
  )
}
