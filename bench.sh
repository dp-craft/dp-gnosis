#!/usr/bin/env bash
# dp-gnosis-bench — the start script.
#
#   ./bench.sh [--only <ids,csv>] [--depth <n>] [--rerank] [--compare] [--per-topic]
#
# Exit 0 = every selected dataset ran and was recorded; non-zero = at least one
# failed (the rest are still recorded — a partial run must never look complete).
set -euo pipefail
exec npx tsx "$(dirname "$0")/src/run.ts" "$@"
