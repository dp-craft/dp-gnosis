#!/usr/bin/env bash
#
# Acceptance for the MCP surface: speak the real protocol over real stdio.
#
# Pipes an `initialize` line then a `tools/call` line into the server and prints
# what comes back. It asserts on the WIRE — one JSON object per line, an id that
# correlates, a pack in the tool result — because the unit tests drive the
# handler directly and cannot see the framing or the process binding.
#
# Exit 0 = both responses present and well formed. Exit 1 = one is missing or
# malformed. Run from the repo root: bash packages/gnosis/scripts/mcp-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
QUESTION="${1:-what is the knowledge pack}"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"mcp-smoke","version":"0"}}}'
CALL="$(QUESTION="$QUESTION" node -e 'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"gnosis_answer",arguments:{question:process.env.QUESTION,k:3}}}))')"

OUT="$(mktemp)"
trap 'rm -f "$OUT" "$OUT.in"' EXIT

printf '%s\n%s\n' "$INIT" '{"jsonrpc":"2.0","method":"notifications/initialized"}' >"$OUT.in"
printf '%s\n' "$CALL" >>"$OUT.in"

# stderr stays visible: it is where any diagnostic belongs, and stdout is the protocol.
(cd "$ROOT" && npx tsx packages/gnosis/src/mcp/main.ts <"$OUT.in" >"$OUT")

echo "--- responses ---"
cat "$OUT"
echo "--- checks ---"

node - "$OUT" <<'NODE'
const { readFileSync } = require('node:fs');
const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter(l => l.length > 0);
const fail = (why) => { console.error(`FAIL: ${why}`); process.exit(1); };
const parsed = lines.map(line => { try { return JSON.parse(line); } catch { return fail(`not one JSON object per line: ${line.slice(0, 80)}`); } });
if (parsed.length !== 2) fail(`expected exactly 2 responses (a notification gets none), got ${parsed.length}`);
const [init, call] = parsed;
if (init.id !== 1 || typeof init.result?.protocolVersion !== 'string') fail('initialize returned no protocolVersion');
if (!init.result?.serverInfo?.name) fail('initialize returned no serverInfo.name');
if (call.id !== 2) fail('tools/call response id did not correlate');
if (call.error) fail(`tools/call errored: ${call.error.message}`);
const text = call.result?.content?.[0]?.text;
if (typeof text !== 'string' || text.length === 0) fail('tools/call returned no text content');
if (call.result.isError) fail(`tools/call reported isError: ${text.slice(0, 200)}`);
console.log(`OK: protocolVersion ${init.result.protocolVersion}, server ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);
console.log(`OK: pack of ${text.length} chars`);
NODE
