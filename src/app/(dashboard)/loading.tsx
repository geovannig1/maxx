export default function DashboardLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading performance cockpit">
      <div className="h-6 w-48 animate-pulse rounded bg-[var(--bg-subtle)]" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-56 animate-pulse rounded-xl bg-[var(--bg-subtle)]" />
        <div className="h-56 animate-pulse rounded-xl bg-[var(--bg-subtle)]" />
      </div>
    </div>
  )
}
