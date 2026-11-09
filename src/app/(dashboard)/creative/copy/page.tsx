import { PenLine } from 'lucide-react'
import { requireOwner } from '@/lib/auth/page-owner'
import { aiStatus } from '@/lib/ai'
import { isDemoMode } from '@/config/demo'
import { loadCopyStudio } from '@/lib/creative/copy-studio'
import { PageHeader } from '@/components/layout/PageHeader'
import { CopyStudio } from '@/components/creative/copy-studio/CopyStudio'

// Copy studio (under Creative): write and score Meta ad copy in the business's voice. Generation needs
// an AI provider; the scores, the copy bank and the review of existing ads are deterministic.
export default async function CopyStudioPage() {
  await requireOwner()
  const data = await loadCopyStudio()
  return (
    <div className="owner-page" data-copy-studio>
      <div className="owner-surface owner-surface-section">
        <PageHeader title="Copy studio" icon={PenLine}
          subtitle="Write and score Meta ad copy grounded in your verified facts and the copy that ran. Nothing here publishes to Meta." />
      </div>
      <CopyStudio aiState={aiStatus().state} demo={isDemoMode()} data={data} />
    </div>
  )
}
