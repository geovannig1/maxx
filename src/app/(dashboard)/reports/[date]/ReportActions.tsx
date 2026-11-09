'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface ReportActionsProps {
  date: string
}

export function ReportActions({ date }: ReportActionsProps) {
  const [loading, setLoading] = useState(false)

  async function handleRegenerate() {
    setLoading(true)
    try {
      const res = await fetch(`/api/report/${date}`, { method: 'POST' })
      if (res.ok) {
        toast.success('Report regeneration started — refresh in a moment.')
      } else {
        const body = await res.json().catch(() => ({}))
        toast.error(body.error ?? 'Failed to regenerate report')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={handleRegenerate}
      disabled={loading}
      className="h-8 gap-1.5 text-xs"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
    >
      <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
      {loading ? 'Regenerating…' : 'Regenerate'}
    </Button>
  )
}
