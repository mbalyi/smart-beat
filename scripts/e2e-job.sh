#!/bin/bash
# One CI-style e2e job: one group in one browser. Usage: e2e-job.sh <group> <browser> <workers>
# Prints every line with "[group browser]" in front and keeps the plain log in playwright-queue/.
# Needs the dev server (`pnpm test:e2e:server`) already running: three jobs starting their own
# would race for its port.
set -o pipefail
mkdir -p playwright-queue
echo "[$1 $2] start"
E2E_GROUP="$1" E2E_WORKERS="$3" pnpm exec playwright test --project="$2" --retries=2 --reporter=list 2>&1 |
  tee "playwright-queue/$1-$2.log" | sed -u "s/^/[$1 $2] /"
status=$?
echo "[$1 $2] finished, exit $status"
exit "$status"
