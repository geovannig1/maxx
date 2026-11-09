#!/usr/bin/env bash
# Durable Supabase-CLI wrapper for local integration testing.
#
# Why this exists: a local `.env.local` can hold lines the Supabase CLI's env parser rejects
# ("failed to parse environment file: .env.local"), which abort `supabase start`/`db reset` when run
# from the project root. This wrapper runs the CLI from a dedicated work dir (`.supabase-work/`,
# gitignored) that holds only `supabase/` (config + migrations) — no `.env.local` — so the CLI never
# reads it. The local stack still binds the same ports, so `npm run test:db:integration` works unchanged.
#
# Usage:
#   scripts/sb.sh start        # bring the stack up (applies every file in supabase/migrations)
#   scripts/sb.sh db reset     # drop + re-apply the baseline (use after editing the schema)
#   scripts/sb.sh status
#   scripts/sb.sh stop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.supabase-work"
LOCK="${MAXX_SUPABASE_LOCK_DIR:-$ROOT/.supabase-work.lock}"

acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK/pid"
    return
  fi

  local owner_pid=""
  if [ -f "$LOCK/pid" ]; then owner_pid="$(cat "$LOCK/pid" 2>/dev/null || true)"; fi
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    echo "REFUSING: process $owner_pid is already using the local Supabase workspace." >&2
    exit 75
  fi

  # Recover only an exact stale lock created by this wrapper; never remove the workspace itself.
  rm -f "$LOCK/pid"
  if ! rmdir "$LOCK" 2>/dev/null || ! mkdir "$LOCK" 2>/dev/null; then
    echo "REFUSING: the local Supabase workspace lock is unavailable." >&2
    exit 75
  fi
  printf '%s\n' "$$" > "$LOCK/pid"
}

release_lock() {
  rm -f "$LOCK/pid"
  rmdir "$LOCK" 2>/dev/null || true
}

acquire_lock
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

mkdir -p "$WORK"
rm -rf "$WORK/supabase"
cp -r "$ROOT/supabase" "$WORK/supabase"
cd "$WORK"
# Pinned for harness reproducibility (keep in lockstep with .github/workflows/ci.yml's setup-cli version).
npx --yes supabase@2.109.1 "$@"
