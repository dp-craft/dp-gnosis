#!/usr/bin/env bash
# dp-gnosis-bench — the start script.
#
#   ./bench.sh [--only <ids,csv>] [--depth <n>] [--rerank] [--compare]
#
# The per-topic TSVs are always written: a recorded run must stay re-analysable
# without paying for the benchmark a second time.
#
# Exit 0 = every selected dataset ran and was recorded; non-zero = at least one
# failed (the rest are still recorded — a partial run must never look complete).
set -euo pipefail

# The SINGLE owner of the benchmark's heap limit. Node's default old-space cap
# here is 4.19 GB, and a full BEIR selection dies under it: measured 2026-08-15,
# a nine-dataset run reached 67.5 minutes and six completed datasets before
# "FATAL ERROR: Reached heap limit Allocation failed" at 4092.8 MB, on a corpus
# of 382,545 documents / 0.69 GB. The machine has 31 GB, so 8 GB is headroom
# that costs nothing. `NODE_OPTIONS` is APPENDED to, never clobbered, and it is
# exported so the child process `npx tsx` spawns inherits the limit — raising it
# in the parent alone would leave the process that actually allocates at 4.19 GB.
#
# `gnosis:sweep` is deliberately NOT raised: it is fixed to the `linear` adapter
# over the small vault corpora and has never approached the limit. The asymmetry
# is the measurement, not an oversight.
#
# COMMON.md §III (Constant Ownership): the value appears HERE only —
# package.json's `gnosis:bench` delegates to this script rather than restating
# it, so the two entry points cannot disagree about the heap.
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=8192"

exec npx tsx "$(dirname "$0")/src/run.ts" "$@"
