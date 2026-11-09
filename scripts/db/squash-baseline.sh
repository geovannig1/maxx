#!/usr/bin/env bash
# Squash supabase/migrations/* into one baseline migration, and PROVE the baseline is equivalent.
#
# Builds two throwaway Supabase Postgres 17 containers (never your local Supabase stack): A replays the
# migration chain, B applies the generated baseline. The baseline is written only when, between A and B:
#   - effective privileges for postgres and service_role on every table, view, sequence and function,
#   - row-level security flags and every policy,
#   - the schema itself (tables, columns, constraints, indexes, functions, triggers, views)
# are identical, the browser roles (anon, authenticated) hold no privilege on anything in B, and the
# chain left no rows in any public table (pg_dump --schema-only would silently drop seed data).
# Each comparison fails on empty input; the browser-role, post-processing and row checks each reject
# a planted violation first, so a passing check is not an instrument that cannot fail.
#
# The baseline is supabase/migrations/0001_baseline.sql: the Supabase CLI accepts any numeric version
# prefix and applies files in filename order, so 0001 sorts before every timestamped migration that
# `supabase migration new` creates.
#
# Usage: scripts/db/squash-baseline.sh            verify only
#        scripts/db/squash-baseline.sh --write    verify, then replace supabase/migrations with the baseline
set -euo pipefail
cd "$(dirname "$0")/../.."

IMAGE="${SQUASH_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
PORT_A="${SQUASH_PORT_A:-55442}"; PORT_B="${SQUASH_PORT_B:-55443}"
NAME_A="maxx-squash-chain-$$"; NAME_B="maxx-squash-baseline-$$"
WORK="$(mktemp -d)"; OUT="supabase/migrations/0001_baseline.sql"
WRITE=0; [ "${1:-}" = "--write" ] && WRITE=1

cleanup() { docker rm -f -v "$NAME_A" "$NAME_B" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok() { printf '\033[32m✓\033[0m %s\n' "$1"; }

command -v docker >/dev/null || fail "docker is required"
docker info >/dev/null 2>&1 || fail "docker is not running"

start() { # name port
  docker run -d --name "$1" -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:$2:5432" "$IMAGE" >/dev/null
  for _ in $(seq 1 90); do docker exec "$1" pg_isready -U postgres >/dev/null 2>&1 && sleep 2 && return 0; sleep 1; done
  fail "container $1 did not become ready"
}
psql_in() { docker exec -i -e PGPASSWORD=postgres "$1" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "${@:2}"; }

start "$NAME_A" "$PORT_A"; start "$NAME_B" "$PORT_B"; ok "throwaway containers ready ($IMAGE)"

count=0
while IFS= read -r f; do
  psql_in "$NAME_A" --single-transaction < "$f" >/dev/null 2>"$WORK/err" || { cat "$WORK/err" >&2; fail "migration failed: $f"; }
  count=$((count + 1))
done < <(ls supabase/migrations/*.sql | sort)
ok "replayed $count migration file(s) on A"

docker exec "$NAME_A" pg_dump -U postgres -d postgres --schema-only --schema=public --no-owner > "$WORK/raw.sql"
# Control: post-processing must refuse a dump whose browser-role grant its line filter does not drop.
{ cat "$WORK/raw.sql"; echo 'GRANT SELECT ON TABLE public.ad_accounts TO anon, service_role;'; } > "$WORK/planted.sql"
if python3 -I scripts/db/postprocess-baseline.py "$WORK/planted.sql" "$WORK/planted.out" 2>/dev/null; then
  fail "post-processing accepted a planted browser-role grant (control)"
fi
ok "post-processing refuses a planted browser-role grant (control)"
python3 -I scripts/db/postprocess-baseline.py "$WORK/raw.sql" "$WORK/baseline.sql"
psql_in "$NAME_B" --single-transaction < "$WORK/baseline.sql" >/dev/null 2>"$WORK/err" || { cat "$WORK/err" >&2; fail "baseline did not apply on B"; }
ok "baseline applied on B"

ACL_Q="select kind||' '||name||' => '||coalesce((select string_agg(x::text, ' ' order by x::text) from unnest(acl) x where x::text !~ '^(anon|authenticated)?='),'') from (
  select ('rel:'||c.relkind::text) kind, c.oid::regclass::text name, coalesce(c.relacl, acldefault(case when c.relkind='S' then 's'::\"char\" else 'r'::\"char\" end, c.relowner)) acl
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','m','S','p')
  union all select 'fn', p.oid::regprocedure::text, coalesce(p.proacl, acldefault('f', p.proowner))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') t order by 1"
RLS_Q="select c.oid::regclass::text||' '||c.relrowsecurity||' '||c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') order by 1"
POL_Q="select tablename||'|'||policyname||'|'||cmd||'|'||array_to_string(roles,'+')||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'') from pg_policies where schemaname='public' order by 1"
BROWSER_Q="select r||' '||(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','m','p') and (has_table_privilege(r,c.oid,'SELECT') or has_table_privilege(r,c.oid,'INSERT') or has_table_privilege(r,c.oid,'UPDATE') or has_table_privilege(r,c.oid,'DELETE')))+(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='S' and has_sequence_privilege(r,c.oid,'USAGE'))+(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and has_function_privilege(r,p.oid,'EXECUTE')) from unnest(array['anon','authenticated']) r"

for q in ACL RLS POL; do
  var="${q}_Q"
  psql_in "$NAME_A" -At -c "${!var}" > "$WORK/$q.a"
  psql_in "$NAME_B" -At -c "${!var}" > "$WORK/$q.b"
  [ -s "$WORK/$q.a" ] || fail "$q query returned nothing on A (instrument failure, not equality)"
  diff -q "$WORK/$q.a" "$WORK/$q.b" >/dev/null || { diff "$WORK/$q.a" "$WORK/$q.b" | head -20 >&2; fail "$q differs between chain and baseline"; }
  ok "$q identical ($(wc -l < "$WORK/$q.a" | tr -d ' ') rows)"
done

schema_of() { docker exec "$1" pg_dump -U postgres -d postgres --schema-only --schema=public --no-owner \
  | sed -E '/^(\\(un)?restrict |GRANT |REVOKE |ALTER DEFAULT PRIVILEGES |--|$)/d' | tr -d '()'; }
schema_of "$NAME_A" > "$WORK/schema.a"; schema_of "$NAME_B" > "$WORK/schema.b"
[ -s "$WORK/schema.a" ] || fail "schema dump of A is empty (instrument failure)"
diff -q "$WORK/schema.a" "$WORK/schema.b" >/dev/null || { diff "$WORK/schema.a" "$WORK/schema.b" | head -20 >&2; fail "schema differs between chain and baseline"; }
ok "schema identical ($(wc -l < "$WORK/schema.a" | tr -d ' ') statement lines; CHECK parenthesization ignored)"

# Control: the same query, in a transaction that plants one grant to anon and rolls back, must see it.
printf 'BEGIN;\nGRANT SELECT ON public.ad_accounts TO anon;\n%s;\nROLLBACK;\n' "$BROWSER_Q" | psql_in "$NAME_B" -At > "$WORK/browser.planted"
grep -Eq '^anon [1-9]' "$WORK/browser.planted" || { cat "$WORK/browser.planted" >&2; fail "browser-role query missed a planted grant (control)"; }
ok "browser-role query sees a planted grant to anon (control, rolled back)"
psql_in "$NAME_B" -At -c "$BROWSER_Q" > "$WORK/browser"
[ "$(wc -l < "$WORK/browser" | tr -d ' ')" = 2 ] || fail "browser-role query returned an unexpected shape"
if awk '$2 != 0 { bad = 1 } END { exit !bad }' "$WORK/browser"; then cat "$WORK/browser" >&2; fail "a browser role holds privileges in the baseline"; fi
ok "anon and authenticated hold no privilege on any table, sequence or function ($(tr '\n' ' ' < "$WORK/browser"))"

# Seed data: pg_dump --schema-only keeps no rows, so the chain must not have inserted any.
ROWS_Q="select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s', c.oid::regclass), false, true, '')))[1]::text::bigint > 0 order by 1"
printf "BEGIN;\nINSERT INTO public.ad_accounts (account_id, account_name, timezone_name) VALUES ('act_control', 'control', 'UTC');\n%s;\nROLLBACK;\n" "$ROWS_Q" | psql_in "$NAME_A" -At > "$WORK/rows.planted"
grep -qx 'ad_accounts' "$WORK/rows.planted" || { cat "$WORK/rows.planted" >&2; fail "row check missed a planted row (control)"; }
psql_in "$NAME_A" -At -c "$ROWS_Q" > "$WORK/rows"
[ ! -s "$WORK/rows" ] || { cat "$WORK/rows" >&2; fail "the chain left rows the schema-only baseline would drop"; }
ok "no public table holds a row after the chain (a planted row was seen, rolled back)"

if [ "$WRITE" -eq 1 ]; then
  git rm -q supabase/migrations/*.sql 2>/dev/null || rm -f supabase/migrations/*.sql
  mkdir -p supabase/migrations   # git removes the directory once it is empty
  cp "$WORK/baseline.sql" "$OUT"
  git add "$OUT" 2>/dev/null || true
  ok "wrote $OUT and removed the squashed migration files"
else
  ok "verification passed; re-run with --write to replace supabase/migrations with the baseline"
fi
