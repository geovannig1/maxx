'use client'

import { useRouter, usePathname } from 'next/navigation'
import { DateRangeControl, type DateRangeValue } from './DateRangeControl'

// URL-driven date-range control for SERVER pages (reports, dashboard): writes ?range=<preset> for a
// preset, or ?from=…&to=… for a custom range, and lets the server re-render from searchParams.
export function UrlDateRangeControl({ value }: { value: DateRangeValue }) {
  const router = useRouter()
  const pathname = usePathname()
  return (
    <DateRangeControl
      value={value}
      onChange={(v) => {
        const q = v.preset === 'custom' ? `?from=${v.from}&to=${v.to}` : `?range=${v.preset}`
        router.replace(`${pathname}${q}`, { scroll: false })
      }}
    />
  )
}
