'use client'

// Extracted VERBATIM from the old Tasks page (src/app/(dashboard)/tasks/page.tsx) so the Action Inbox
// renders tasks with identical markup, priority config, and the same PATCH /api/tasks/[id] status verb.
// Only the row type changed (Task → InboxTask, defined in @/lib/inbox/group).

import { useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { format, parseISO } from 'date-fns'
import type { InboxTask, TaskPriority } from '@/lib/inbox/group'

export const PRIORITY_ORDER: TaskPriority[] = ['urgent', 'high', 'medium', 'low']

export const PRIORITY_CONFIG: Record<TaskPriority, { label: string; badgeStyle: React.CSSProperties }> = {
  urgent: {
    label: 'Urgent',
    badgeStyle: {
      background: 'var(--danger-bg)',
      color: 'var(--danger)',
      border: '1px solid var(--danger-border)',
    },
  },
  high: {
    label: 'High',
    badgeStyle: {
      background: 'var(--warning-bg)',
      color: 'var(--warning)',
      border: '1px solid var(--warning-border)',
    },
  },
  medium: {
    label: 'Medium',
    badgeStyle: {
      background: 'var(--info-bg)',
      color: 'var(--info)',
      border: '1px solid var(--info-border)',
    },
  },
  low: {
    label: 'Low',
    badgeStyle: {
      background: 'var(--bg-subtle)',
      color: 'var(--text-tertiary)',
      border: '1px solid var(--border)',
    },
  },
}

export const STATUS_OPTIONS = ['open', 'in_progress', 'done', 'dismissed']

export function TaskCard({
  task,
  onStatusChange,
  isUpdating,
}: {
  task: InboxTask
  onStatusChange: (id: string, status: string) => void
  isUpdating: boolean
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      style={{
        background: hovered ? 'var(--bg-elevated)' : 'var(--bg-surface)',
        border: `1px solid ${hovered ? 'var(--border-hover)' : 'var(--border)'}`,
        borderRadius: 'var(--r-lg)',
        padding: '16px',
        transition: 'border-color 80ms, background 80ms',
        opacity: task.status === 'done' ? 0.5 : 1,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex-1 min-w-0 space-y-1">
          <p
            className="text-sm font-medium"
            style={{
              color: task.status === 'done' ? 'var(--text-tertiary)' : 'var(--text-primary)',
              textDecoration: task.status === 'done' ? 'line-through' : 'none',
            }}
          >
            {task.title}
          </p>
          {task.description && (
            <p
              className="text-xs line-clamp-2"
              style={{ color: 'var(--text-secondary)' }}
            >
              {task.description}
            </p>
          )}
          {task.recommendation && (
            <p
              className="text-xs line-clamp-2"
              style={{ color: 'var(--accent-hover)', opacity: 0.8 }}
            >
              Recommendation: {task.recommendation}
            </p>
          )}
          {task.due_date && (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Due: {format(parseISO(task.due_date), 'MMM d, yyyy')}
            </p>
          )}
        </div>

        <Select
          value={task.status}
          onValueChange={(v) => v && onStatusChange(task.id, v)}
          disabled={isUpdating}
        >
          <SelectTrigger
            className="h-11 w-full shrink-0 text-xs sm:w-36"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              borderRadius: 'var(--r-sm)',
              padding: '0 12px',
              fontSize: '12px',
            }}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
            }}
          >
            {STATUS_OPTIONS.map((s) => (
              <SelectItem
                key={s}
                value={s}
                className="text-xs capitalize"
                style={{ color: 'var(--text-primary)' }}
              >
                {s.replaceAll('_', ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
