#!/usr/bin/env bash
# dp-gnosis-bench — the BM25 k1 x b sweep.
#
#   ./sweep.sh [--only <ids,csv>] [--k1 <csv>] [--b <csv>] [--depth <n>]
#
# Defaults: --only nfcorpus,scifact  --k1 1.2,1.0,0.8  --b 0.6,0.5,0.4,0.3
# The shipped operating point (k1=1.2, b=0.75) is ALWAYS measured as a reference
# cell, so the grid is readable against the baseline it has to beat.
#
# The sweep drives the LINEAR adapter, because SQLite FTS5 compiles k1 and b in
# and exposes no way to set them. A winning cell is evidence about BM25's shape
# on this material, not a setting the fts5 path can switch on.
#
# Cost: the linear adapter re-reads the whole corpus on every retrieve, so wall
# time is roughly cells x topics x corpus. Ingest is paid once per dataset.
#
# Exit 0 = every selected dataset produced cells; non-zero = at least one failed
# (the rest are still recorded — a partial sweep must never look complete).
set -euo pipefail
exec npx tsx "$(dirname "$0")/src/sweep.ts" "$@"
