#!/usr/bin/env bash
# Databases two e2e flows need besides the shop fixtures, in the test PostgreSQL (npm run db:up):
#   dbm_backup_test  table bk with 100 rows (e2e/flow46: backup, drop, restore)
#   huge             schemas app1…app20, tables t001…t250 each, every table referencing the previous one
#                    (4980 foreign keys; e2e/flow61: large schema timings)
# Recreating the postgres container loses them; run this again then.
set -euo pipefail
container="${DBM_PG_CONTAINER:-db-mastermind-postgres-1}"
psql() { docker exec -i "$container" psql -v ON_ERROR_STOP=1 -q -U postgres "$@"; }

psql -d postgres -c 'DROP DATABASE IF EXISTS dbm_backup_test' -c 'CREATE DATABASE dbm_backup_test'
psql -d dbm_backup_test -c 'CREATE TABLE bk (id int PRIMARY KEY, name text)' -c "INSERT INTO bk SELECT g, 'row ' || g FROM generate_series(1, 100) g"

psql -d postgres -c 'DROP DATABASE IF EXISTS huge' -c 'CREATE DATABASE huge'
# One schema per transaction: all 5000 tables in one would run out of locks.
for s in $(seq 1 20); do
  psql -d huge <<SQL
CREATE SCHEMA app$s;
DO \$\$
DECLARE t int; name text; prev text;
BEGIN
  FOR t IN 1..250 LOOP
    name := format('app$s.t%s', lpad(t::text, 3, '0'));
    prev := format('app$s.t%s', lpad((t - 1)::text, 3, '0'));
    IF t = 1 THEN
      EXECUTE format('CREATE TABLE %s (id int PRIMARY KEY, label text, created_at timestamptz DEFAULT now())', name);
    ELSE
      EXECUTE format('CREATE TABLE %s (id int PRIMARY KEY, parent_id int REFERENCES %s(id), label text, created_at timestamptz DEFAULT now())', name, prev);
    END IF;
  END LOOP;
END \$\$;
SQL
done
echo "dbm_backup_test and huge are ready"
