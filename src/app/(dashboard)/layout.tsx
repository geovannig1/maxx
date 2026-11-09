import { Suspense } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { Topbar } from '@/components/layout/Topbar'
import { MobileNavProvider } from '@/components/layout/MobileNavContext'
import { TargetRangesProvider } from '@/components/targets/TargetRangesProvider'
import { MaxxLauncher } from '@/components/maxx/MaxxLauncher'
import { maxxChatEnabled } from '@/lib/maxx/chat'
import { requireOwner } from '@/lib/auth/page-owner'
import { dashboardBlockers } from '@/config/env'
import { isDemoMode } from '@/config/demo'
import { DemoBanner, SetupRequiredNotice } from '@/components/setup/SetupRequiredNotice'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Second gate behind src/proxy.ts. Layouts do not re-run on client-side navigation, so every
  // server page under this group calls requireOwner() as well (tests/dashboard-page-owner-gate.test.ts).
  await requireOwner()
  // incomplete configuration shows what is missing (names only) instead of a broken page.
  const demo = isDemoMode()
  const blockers = demo ? [] : dashboardBlockers(process.env)
  // The chrome polls account-scoped APIs (alerts, changes, approvals). Until setup is complete and the
  // first Meta sync has stored the ad account, those can only fail, so the chrome stays quiet instead.
  const accountReady = blockers.length === 0 && (await resolveOnlyActiveAccount()).ok
  return (
    <TargetRangesProvider>
    <MobileNavProvider>
      <div data-reporting-shell className="flex h-screen" style={{ backgroundColor: 'var(--bg-base)' }}>
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <Suspense fallback={<div className="hidden w-60 shrink-0 lg:block" aria-label="Loading navigation" />}>
          <Sidebar accountReady={accountReady} />
        </Suspense>
        <div data-reporting-frame className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <Suspense fallback={<div className="h-16 shrink-0" aria-label="Loading page controls" />}>
            <Topbar accountReady={accountReady} />
          </Suspense>
          <main
            id="main-content"
            className="flex-1 overflow-y-auto px-4 py-7 sm:px-8"
            style={{ backgroundColor: 'var(--bg-base)' }}
          >
            {/* Centered, capped width so cards/charts don't stretch uncomfortably on wide monitors. */}
            <div className="mx-auto w-full" style={{ maxWidth: '1400px' }}>
              {demo ? <DemoBanner /> : null}
              {blockers.length > 0 ? <SetupRequiredNotice issues={blockers} /> : children}
            </div>
          </main>
        </div>
        {/* Chat stays unavailable until its evidence and action output are structurally governed. */}
        <MaxxLauncher enabled={maxxChatEnabled()} />
      </div>
    </MobileNavProvider>
    </TargetRangesProvider>
  )
}
