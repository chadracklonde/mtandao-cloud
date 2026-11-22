#!/usr/bin/env bash
# Runs the SQL migrations and integration tests against a throwaway PostgreSQL cluster.
# Requires PostgreSQL 15+ binaries. Usage: supabase/tests/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$bin" ] || bin="$(dirname "$(command -v postgres)")"
dir="$(mktemp -d)"; port=54329
cleanup() { "$bin/pg_ctl" -D "$dir/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$dir"; }
trap cleanup EXIT
if [ "$(id -u)" = 0 ]; then
  chown postgres "$dir"; chmod 755 "$here" "$here/.." 2>/dev/null || true
  run() { su postgres -s /bin/bash -c "$*"; }
else run() { bash -c "$*"; }; fi
run "'$bin/initdb' -D '$dir/data' -A trust >/dev/null"
run "'$bin/pg_ctl' -D '$dir/data' -o '-p $port -k $dir' -l '$dir/log' -w start >/dev/null"
psql_() { run "'$bin/psql' -h '$dir' -p $port -v ON_ERROR_STOP=1 -q $*"; }

# Template database: Supabase stub + every migration, in order.
psql_ "-d postgres -c 'create database tpl'"
psql_ "-d tpl -f '$here/00_supabase_stub.sql'"
for f in "$here"/../migrations/*.sql; do psql_ "-d tpl -f '$f'" >/dev/null; done

# Each suite runs in its own clone so suites cannot interfere with each other.
for t in "$here"/*.test.sql; do
  db="t_$(basename "$t" .test.sql | tr '.' '_')"
  psql_ "-d postgres -c 'create database $db template tpl'"
  echo "== $(basename "$t")"
  psql_ "-d $db -f '$t'" 2>&1 | grep -E "ok - |FAIL|ERROR|PASSED" | sed 's/^psql:[^ ]* NOTICE:  //'
  echo "-- done"
done
