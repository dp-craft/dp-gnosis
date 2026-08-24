#!/usr/bin/env python3
"""qmd-daemon-arm — drive an EXTERNAL `qmd` retrieval arm over a BEIR-layout
topic set through qmd's HTTP MCP daemon, and export a TREC run plus the raw
per-topic payload. Same contracts as `qmd-arm.mjs`; different transport.

WHY IT EXISTS: `qmd-arm.mjs` spawns one `qmd query` process per topic, and a
qmd process reloads its three models on every start. Measured on nfcorpus,
expansion and rerank cache to ~1 ms on a repeat while embedding stays at 3.6 s
because the embedder reloads with the process — so most of that harness's
per-query cost was model loading, not retrieval. A resident daemon pays it once.

WHY THIS IS STILL THE SAME ARM: the MCP `query` tool takes a PLAIN-TEXT `query`
that qmd auto-expands into lex/vec/hyde, fuses by RRF and reranks — the CLI's
pipeline, and its stock defaults match (`candidateLimit` 40 = CLI `-C` 40,
`rerank` true, `limit` = `-n`). Proved rather than assumed: the whole nfcorpus
arm re-run this way scored Δ nDCG@10 −0.0012, p=0.7234, CI [−0.0080, +0.0055],
all five metrics null over 323 topics. Evidence:
`docs/plans/2026-08-19-1502-dp-gnosis-vs-qmd-comparison-and-benchmark.md` § 16.

WHY BLACK BOX: qmd is a competitor arm. It is exercised ONLY through its public
surface — CLI, help text, and the MCP schema read off the wire — never read,
patched or vendored. Reaching into its source would make the number describe OUR
build of qmd rather than the tool a user installs.

Ranking identity with a CLI arm is NOT an acceptance criterion and MUST NOT be
used as one: qmd's generative expansion makes it non-deterministic against
ITSELF (two CLI runs of one `vault` arm agreed on 7 of 60 topics). Equivalence
of the measured metrics is the testable claim.

CONTRACT — document-level first-occurrence rollup, identical to `qmd-arm.mjs`:
qmd returns CHUNKS and the qrels judge DOCUMENTS, so several chunks of one
document are one document held at its BEST (first) rank. `structuredContent
.results[].file` is the collection-relative path, so `basename(file, '.md')`
recovers the corpus id with no `--full-path` equivalent needed.

A failing topic is recorded as zero results — never retried, never skipped. A
dropped topic flatters the arm.

Prerequisite: `cd <index-dir> && qmd mcp --http --daemon` (the daemon serves the
index of ITS OWN cwd), then `qmd mcp stop` when the arm ends.

usage: qmd-daemon-arm.py <topics.jsonl> <out-run.trec> <out-raw.jsonl> [tag] [depth]
exit 0 all topics answered · 3 at least one topic failed
"""

import json
import os
import sys
import time
import urllib.request

MCP_URL = 'http://127.0.0.1:8181/mcp'
PROTOCOL = '2026-07-28'
DEFAULT_TAG = 'qmd'
DEFAULT_DEPTH = 40
PROGRESS_EVERY = 25


def call(method, params=None, name=None, timeout=600):
    """One MCP request. The 2026 envelope is mandatory and precisely specified:
    `_meta` belongs INSIDE `params`, and omitting either key below is answered
    with -32602 naming what is missing."""
    payload = dict(params or {})
    payload['_meta'] = {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL,
        'io.modelcontextprotocol/clientCapabilities': {},
    }
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': payload}).encode()
    headers = {'Content-Type': 'application/json', 'MCP-Protocol-Version': PROTOCOL, 'Mcp-Method': method}
    if name:
        headers['Mcp-Name'] = name
    request = urllib.request.Request(MCP_URL, body, headers)
    return json.loads(urllib.request.urlopen(request, timeout=timeout).read())


def query(text, depth):
    args = {'name': 'query', 'arguments': {'query': text, 'limit': depth}}
    answer = call('tools/call', args, name='query')
    return answer.get('result', {}).get('structuredContent', {}).get('results', []) or []


def rollup(results, depth):
    """Chunks -> documents: first occurrence wins, then truncate to depth."""
    ids = [os.path.basename(str(r.get('file', ''))).removesuffix('.md') for r in results]
    seen, ranking = set(), []
    for doc in ids:
        if doc not in seen:
            seen.add(doc)
            ranking.append(doc)
    return ranking[:depth]


def trec_lines(topic_id, ranking, tag):
    return [f'{topic_id} Q0 {doc} {i + 1} {len(ranking) - i} {tag}'
            for i, doc in enumerate(ranking)]


def percentile(sorted_ms, q):
    if not sorted_ms:
        return 0
    return sorted_ms[min(int(q * len(sorted_ms)), len(sorted_ms) - 1)]


def summarize(records):
    sorted_ms = sorted(r['ms'] for r in records)
    return {
        'topics': len(records),
        'failures': sum(r['failed'] for r in records),
        'queryMs': sum(sorted_ms),
        'queryP50Ms': percentile(sorted_ms, 0.5),
        'queryP95Ms': percentile(sorted_ms, 0.95),
        'chunksReturnedMax': max((r['chunks'] for r in records), default=0),
        'docsReturnedMax': max((r['docs'] for r in records), default=0),
    }


def process(topic, depth, raw, tag):
    started = time.time()
    try:
        results, failed = query(topic['text'], depth), False
    except Exception as err:  # a failing topic is data, not a reason to stop
        sys.stderr.write(f"FAIL {topic['_id']}: {err}\n")
        results, failed = [], True
    ms = int((time.time() - started) * 1000)
    ranking = rollup(results, depth)
    raw.write(json.dumps({'queryId': topic['_id'], 'text': topic['text'],
                          'ms': ms, 'results': results}) + '\n')
    return {'ms': ms, 'failed': failed, 'chunks': len(results), 'docs': len(ranking),
            'lines': trec_lines(topic['_id'], ranking, tag)}


def main():
    if len(sys.argv) < 4:
        sys.stderr.write(__doc__.split('usage: ')[1])
        return 2
    topics_path, out_run, out_raw = sys.argv[1:4]
    tag = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_TAG
    depth = int(sys.argv[5]) if len(sys.argv) > 5 else DEFAULT_DEPTH
    for path in (out_run, out_raw):
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    records = []
    with open(out_raw, 'w', encoding='utf-8') as raw:
        for i, line in enumerate(open(topics_path, encoding='utf-8')):
            if not line.strip():
                continue
            records.append(process(json.loads(line), depth, raw, tag))
            if (i + 1) % PROGRESS_EVERY == 0:
                sys.stderr.write(f"  {i + 1} topics, last {records[-1]['ms']} ms\n")
    lines = [line for r in records for line in r['lines']]
    open(out_run, 'w', encoding='utf-8').write('\n'.join(lines) + ('\n' if lines else ''))
    sys.stdout.write(json.dumps(summarize(records)) + '\n')
    return 3 if any(r['failed'] for r in records) else 0


if __name__ == '__main__':
    sys.exit(main())
