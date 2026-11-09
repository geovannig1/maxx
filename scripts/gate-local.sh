#!/usr/bin/env bash
# Local quality gate. CI runs the same steps; this script exists so a developer sees the same result
# before pushing. It deliberately mirrors the CI job boundaries one-for-one so "green locally" and
# "green in CI" mean the same thing, independent of external GitHub configuration.
#
#   static  == the `verify` job              (no Docker, no network, no secrets)
#   full    == verify + `database-integration` (real Postgres via the Supabase CLI)
#
# WHY TWO TIERS. A pre-push hook that takes twenty-five minutes gets bypassed, and a bypassed gate is
# worse than a fast one because it still reads as enforcement. `static` is what runs on every push.
# `full` is opt-in, because the migration replay DROPS AND REBUILDS the public schema of the local
# Supabase stack — running that automatically would destroy a developer's working database mid-task.
#
# The closing summary prints what this run did NOT cover. That is not decoration: the defect this
# repository keeps repeating is a comment asserting an enforcement that was never wired, and the only
# durable defence is for the gate to state its own boundary out loud every single time it passes.
set -uo pipefail

MODE="${1:-static}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAILED=()
PASSED=()
# Per-step output, kept only for the steps that FAIL. See `step` below for why.
GATE_LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gate-local.XXXXXX")"
trap 'rm -rf "$GATE_LOG_DIR"' EXIT

# WHY THE OUTPUT IS CAPTURED AND REPLAYED.
#
# A wrapper that runs the command and records nothing but the label leaves only a line like
# `✗ database RPC tests (PGlite)` behind. If the step then passes standalone, the cause can never be
# recovered because the evidence has already been discarded. A plausible explanation may exist
# (`vitest.db.config.ts` records that `freshDb()` rebuilds the schema per test and that setup
# timeouts can look like SQL failures) — but a plausible explanation with no evidence behind it is
# not a diagnosis.
#
# A gate that reports a verdict it cannot substantiate teaches one behaviour: re-run until green.
# That is how a real failure gets laundered as flake. So the failing step's tail is printed at the
# point of failure AND replayed under the summary, where a reader who scrolled past it will see it.
# Passing steps stream through untouched and their logs are discarded.
GATE_FAIL_TAIL="${GATE_FAIL_TAIL:-40}"

step() {
  local label="$1"; shift
  printf '\n\033[1m▶ %s\033[0m\n' "$label"
  local log="$GATE_LOG_DIR/$(printf '%s' "$label" | tr -c '[:alnum:]' '_').log"
  # `tee` keeps the live stream a developer watches; PIPESTATUS[0] is the COMMAND's status, not
  # tee's, which is why `set -o pipefail` alone would not be enough here.
  "$@" 2>&1 | tee "$log"
  local status="${PIPESTATUS[0]}"
  if [ "$status" -eq 0 ]; then
    PASSED+=("$label")
    rm -f "$log"
  else
    printf '\033[31m✗ %s FAILED (exit %d)\033[0m\n' "$label" "$status"
    FAILED+=("$label")
  fi
}

# Replay the tail of every failing step, so the summary carries the cause and not just the verdict.
print_failure_details() {
  for f in "${FAILED[@]:-}"; do
    [ -n "$f" ] || continue
    local log="$GATE_LOG_DIR/$(printf '%s' "$f" | tr -c '[:alnum:]' '_').log"
    printf '\n\033[31m── last %s lines of: %s ──\033[0m\n' "$GATE_FAIL_TAIL" "$f"
    if [ -s "$log" ]; then
      tail -n "$GATE_FAIL_TAIL" "$log"
    else
      printf '\033[2m  (the step produced no output — it failed before writing anything)\033[0m\n'
    fi
  done
}

# Mirrors the CI `verify` job, in its order.
run_static() {
  step 'lint'                npm run lint
  step 'typecheck (app)'     npm run typecheck
  step 'typecheck (MCP)'     npm run mcp:build
  step 'unit tests'          npm run test
  step 'database RPC tests (PGlite)' npm run test:db
  step 'production build'    npm run build
}

# Mirrors the CI `database-integration` job. Requires Docker and the Supabase CLI.
run_db() {
  if ! docker info >/dev/null 2>&1; then
    printf '\033[31m✗ Docker is not running — the full tier cannot execute.\033[0m\n'
    FAILED+=('docker unavailable')
    return
  fi
  step 'supabase start'          scripts/sb.sh start
  step 'migration replay'        npm run verify:replay
  step 'real-Postgres proofs'    npm run test:db:integration
}

case "$MODE" in
  static) run_static ;;
  full)   run_static; run_db ;;
  *) printf 'usage: %s [static|full]\n' "$0" >&2; exit 2 ;;
esac

printf '\n\033[1m── gate summary (%s) ──\033[0m\n' "$MODE"
for p in "${PASSED[@]:-}"; do [ -n "$p" ] && printf '  \033[32m✓\033[0m %s\n' "$p"; done
for f in "${FAILED[@]:-}"; do [ -n "$f" ] && printf '  \033[31m✗\033[0m %s\n' "$f"; done

if [ "${#FAILED[@]}" -gt 0 ]; then print_failure_details; fi

# State the boundary every time, pass or fail.
printf '\n\033[2mNOT covered by this run:\033[0m\n'
if [ "$MODE" = "static" ]; then
  printf '\033[2m  • real-Postgres integration proofs (npm run gate:full)\n'
  printf '  • migration replay + prod-upgrade replay (npm run gate:full)\n\033[0m'
fi
printf '  • WHETHER THESE TESTS CAN FAIL. A green suite proves nothing was broken that the suite\n'
printf '    already watches; it cannot prove the suite watches what you just changed. Gate-green\n'
printf '    work can still carry tests that could not have failed. Run `npm run mutate`\n'
printf '    before calling a change done.\033[0m\n'

if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '\n\033[31mGATE FAILED (%d)\033[0m\n' "${#FAILED[@]}"
  exit 1
fi
printf '\n\033[32mGATE PASSED\033[0m\n'
