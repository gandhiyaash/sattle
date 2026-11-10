#!/bin/sh
# Runs a Litestream command on the VM the way sattle-litestream.service runs it: as ubuntu, with
# the bucket's keys from /etc/sattle/litestream.env (root's alone, hence sudo) and litestream.yml
# beside this file. See the README, "Backups".
#
#   apps/api/deploy/litestream.sh check     restore the latest into /tmp and compare it with the live database
#   apps/api/deploy/litestream.sh status
#   apps/api/deploy/litestream.sh ltx /home/ubuntu/sattle/apps/api/data/sattle.db
#   apps/api/deploy/litestream.sh restore -timestamp 2026-11-11T09:00:00Z -o /tmp/then.db /home/ubuntu/sattle/apps/api/data/sattle.db
set -eu

config="$(cd "$(dirname "$0")" && pwd)/litestream.yml"
db=/home/ubuntu/sattle/apps/api/data/sattle.db

run() {
  cmd=$1
  shift
  sudo systemd-run --quiet --pipe --wait --collect --uid=ubuntu \
    --property=EnvironmentFile=/etc/sattle/litestream.env \
    /usr/local/bin/litestream "$cmd" -config "$config" "$@"
}

if [ $# -eq 0 ]; then
  sed -n '2,10p' "$0" | cut -c3-
  exit 2
fi

if [ "$1" != check ]; then
  run "$@"
  exit
fi

# What the bucket would give back if the VM went now: restored to a file of its own, checked
# whole, and counted against the live database. The counts can differ by the last few seconds' writes.
out=/tmp/sattle-check-$$.db
trap 'rm -f "$out" "$out-wal" "$out-shm"' EXIT
run restore -o "$out" "$db"
RESTORED="$out" LIVE="$db" node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const restored = new DatabaseSync(process.env.RESTORED, { readOnly: true });
  const live = new DatabaseSync(process.env.LIVE, { readOnly: true });
  const integrity = restored.prepare("PRAGMA integrity_check").all().map((r) => r.integrity_check).join(", ");
  console.log(`integrity: ${integrity}`);
  for (const table of ["users", "expense_groups", "members", "expenses", "settlements"]) {
    const count = (db) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    console.log(`${table}: ${count(restored)} restored, ${count(live)} live`);
  }
  if (integrity !== "ok") process.exit(1);
'
