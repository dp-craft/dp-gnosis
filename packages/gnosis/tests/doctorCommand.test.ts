/**
 * `doctor` — the read-only pass that makes the QUIET states legible.
 *
 * Every case here asserts a REPORT, never a repair: the command exists because
 * a stale or foreign index answers at exit 0, and a diagnostic that fixed what
 * it found would destroy the evidence it was run to read. The two load-bearing
 * cases are therefore the absent manifest (reported as a fault, with nothing on
 * disk repaired) and the read-only property itself.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

import { buildFts5Index, createFts5Adapter } from '../src/adapters/fts5Adapter.js';
import type { FlagValues } from '../src/cli/args.js';
import type { CommandContext } from '../src/cli/context.js';
import { runDoctorCommand } from '../src/cli/doctorCommand.js';
import type { CommandOutcome } from '../src/cli/outcome.js';
import {
  CORPUS_ROOTS_ENV_VAR,
  ENRICH_MODEL_ENV_VAR,
  ENRICH_MODEL_ID,
  REPHRASE_MODEL_ID,
  RERANK_DEFAULT_URL,
  RERANK_MODEL_ENV_VAR,
  RERANK_MODEL_ID,
  RERANK_URL_ENV_VAR,
  SYNTHESIZE_MODEL_ID
} from '../src/config.js';
import { buildCorpusManifest, serializeCorpusManifest } from '../src/corpusManifest.js';
import { ATOMS_OWNER_FILE, ingest } from '../src/ingest.js';
import type { IngestProfile } from '../src/ingestProfile.js';
import { indexRebuildCommand, ingestCommand } from '../src/invocation.js';
import { dataRoot, ingestProfilePath } from '../src/paths.js';
import type { AnalyzerId } from '../src/query.js';
import { resetRerankProbeCache } from '../src/rerank.js';
import { clearUserConfigCache } from '../src/userConfig.js';

let root = '';
let atomsDir = '';
let indexPath = '';
let manifestPath = '';

const PROFILE_NAME = 'doctor-test';

const atomText = (id: string, body: string): string =>
  [
    '---',
    'type: knowledge',
    `id: ${id}`,
    `title: title of ${id}`,
    'x_domain: runner',
    'status: stable',
    'sources:',
    '  - docs/src.md',
    '---',
    body,
    '',
  ].join('\n');

const ATOMS = [
  { id: 'atom-a', body: 'zustand selector stability rules' },
  { id: 'atom-b', body: 'playwright end to end locator policy' },
];

const writeManifest = (): void => {
  const manifest = buildCorpusManifest({
    profile: PROFILE_NAME,
    atoms: ATOMS.map(atom => ({
      id: atom.id,
      type: 'knowledge',
      domain: 'runner',
      content: atomText(atom.id, atom.body),
    })),
    sources: [],
    skipped: 0,
    duplicates: 0,
  });
  writeFileSync(manifestPath, serializeCorpusManifest(manifest), 'utf8');
};

const profileWith = (extra: Partial<IngestProfile> = {}): IngestProfile => ({
  name: PROFILE_NAME,
  domains: ['runner'],
  types: ['knowledge'],
  defaultType: 'knowledge',
  domainRules: [{ prefix: 'docs/', domain: 'runner' }],
  typeRules: [],
  segmentRules: [],
  ...extra,
});

const contextWith = (
  profile: IngestProfile = profileWith(),
  flags: FlagValues = {}
): CommandContext => ({
  adapter: 'fts5',
  atomsDir,
  indexPath,
  repoRoot: root,
  profilePath: ingestProfilePath(),
  flags,
  positionals: [],
  corpusRoots: ['docs'],
  profile,
});

const doctor = async (
  profile?: IngestProfile,
  flags?: FlagValues
): Promise<CommandOutcome> => await runDoctorCommand(contextWith(profile, flags));

const report = (outcome: CommandOutcome): string => outcome.text;

const setMeta = (key: string, value: string): void => {
  const db = new Database(indexPath);
  db.prepare('INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)').run(key, value);
  db.close();
};

/** Removes a stamp key outright, reproducing an index written before it existed. */
const clearMeta = (key: string): void => {
  const db = new Database(indexPath);
  db.prepare('DELETE FROM index_meta WHERE key = ?').run(key);
  db.close();
};

/** A snapshot of every entry under a directory tree: name plus mtime plus size. */
const snapshot = (dir: string): readonly string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map(rel => {
      const stat = statSync(resolve(dir, rel));
      return `${rel}:${stat.mtimeMs}:${stat.size}`;
    })
    .sort();

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-doctor-'));
  atomsDir = resolve(root, 'atoms');
  indexPath = resolve(root, 'index', 'atoms.db');
  manifestPath = resolve(root, 'corpus-manifest.json');
  mkdirSync(atomsDir, { recursive: true });
  ATOMS.forEach(atom =>
    writeFileSync(resolve(atomsDir, `${atom.id}.md`), atomText(atom.id, atom.body), 'utf8')
  );
  writeFileSync(resolve(atomsDir, ATOMS_OWNER_FILE), `${PROFILE_NAME}\n`, 'utf8');
  writeManifest();
  buildFts5Index({ atomsDir, indexPath });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env[CORPUS_ROOTS_ENV_VAR];
  delete process.env['DP_GNOSIS_DATA_HOME'];
  delete process.env['DP_GNOSIS_CONFIG_HOME'];
  clearUserConfigCache();
});

describe('doctor — a healthy instance', () => {
  it('exits 0 and reports the resolved location quad with WHERE each value came from', async () => {
    const outcome = await doctor();
    expect(outcome.exitCode).toBe(0);
    expect(report(outcome)).toContain(atomsDir);
    expect(report(outcome)).toContain(indexPath);
    expect(report(outcome)).toContain(root);
    expect(report(outcome)).toContain('default');
  });

  it('reports the manifest digest agreeing with the index corpus_digest', async () => {
    expect(report(await doctor())).toContain('corpus_digest');
    expect(await doctor().then(outcome => outcome.exitCode)).toBe(0);
  });

  it('names the owner marker and the profile that owns the atoms directory', async () => {
    expect(report(await doctor())).toContain(PROFILE_NAME);
  });
});

/**
 * A type this build does not define is REFUSED on the query path, so `doctor`
 * — whose whole job is naming a broken instance — MUST NOT call that instance
 * healthy. It reported 0 faults while every `retrieve` died on the same
 * profile.
 */
describe('doctor — a profile declaring a type this build does not define', () => {
  it('reports a fault naming the offending value, not a clean bill of health', async () => {
    const outcome = await doctor(profileWith({ types: ['knowledge', 'recipe'] }));
    expect(outcome.exitCode).toBe(3);
    expect(report(outcome)).toContain('recipe');
    expect(report(outcome)).toMatch(/\[fault\] type-vocabulary/);
  });

  it('stays silent when every declared type is mirrored', async () => {
    expect(report(await doctor())).not.toContain('type-vocabulary');
  });

  /**
   * The message names a file for the reader to go and edit. It derived that
   * name from `ingestProfilePath()`, which is the shipped-or-user profile
   * whatever `--profile` said -- so under one it reported a foreign value that
   * the named file does not contain, and sent the reader to correct a file that
   * was never judged.
   */
  it('names the profile it JUDGED, not the one ingestProfilePath resolves', async () => {
    const elsewhere = '/srv/instances/other.profile.json';

    const outcome = await runDoctorCommand({
      ...contextWith(profileWith({ types: ['knowledge', 'recipe'] })),
      profilePath: elsewhere,
    });

    expect(outcome.exitCode).toBe(3);
    expect(report(outcome)).toContain(elsewhere);
    expect(report(outcome)).not.toContain(ingestProfilePath());

    /**
     * A reader who ran --profile against their OWN file is on an installed
     * instance, which ships no TypeScript, so pointing them at src/config.ts
     * is a dead end rather than a remedy. That wording belongs to the SHIPPED
     * profile tracked beside the tuple in a checkout; every other profile is
     * told to edit the profile file itself.
     */
    expect(
      report(outcome)
        .split('\n')
        .filter(line => line.includes('type-vocabulary'))
        .join('\n')
    ).not.toContain('src/config.ts');
  });
});

describe('doctor — the quiet states', () => {
  /**
   * A stamped index whose manifest was REMOVED. The served path now refuses it
   * on its own (the stamp proves the manifest once existed), so what this case
   * pins is that doctor REPORTS the state and REPAIRS nothing: the manifest is
   * still gone afterwards and the serving verdict is the adapter's, not
   * doctor's.
   */
  it('reports a stamped corpus_digest whose manifest is ABSENT, and repairs nothing', async () => {
    rmSync(manifestPath);
    const outcome = await doctor();
    expect(outcome.exitCode).toBe(3);
    expect(report(outcome)).toContain('corpus-manifest.json');
    expect(existsSync(manifestPath)).toBe(false);

    const port = createFts5Adapter({ atomsDir, indexPath, now: new Date() });
    const served = await port.retrieve('zustand selector', { k: 5 });
    port.close?.();
    expect(served.indexState).toBe('mismatched');
    expect(served.atoms).toEqual([]);
  });

  it('reports a stamped digest that disagrees with the manifest', async () => {
    setMeta('corpus_digest', 'sha256:0000000000000000000000000000000000000000000000000000000000000000');
    const outcome = await doctor();
    expect(outcome.exitCode).toBe(3);
    expect(report(outcome)).toContain('corpus_digest');
  });

  it('reports a schema_version this build cannot read', async () => {
    setMeta('schema_version', '99');
    const outcome = await doctor();
    expect(outcome.exitCode).toBe(3);
    expect(report(outcome)).toContain('schema_version');
  });

  it('reports an index analyzer that disagrees with the profile defaultAnalyzer', async () => {
    const declared: AnalyzerId = 'ident-porter-fold';
    const outcome = await doctor(profileWith({ defaultAnalyzer: declared }));
    expect(outcome.exitCode).toBe(3);
    expect(report(outcome)).toContain(declared);
  });

  /**
   * The state doctor was SILENT on. An index written before the analyzer stamp
   * existed states nothing, and the served path reads that absence as the one
   * chain that ever produced such a file — so a profile declaring any other
   * chain makes every retrieve REFUSE, while doctor read the raw stamp, found
   * `undefined`, and reported a clean bill of health over it.
   */
  it('reports an UNSTAMPED index under a profile declaring another chain, which the served path REFUSES', async () => {
    clearMeta('analyzer');
    const declared: AnalyzerId = 'ident-porter-fold';

    const outcome = await doctor(profileWith({ defaultAnalyzer: declared }));

    expect(outcome.exitCode).toBe(3);
    expect(report(outcome)).toContain(declared);
    expect(report(outcome)).toContain('porter-fold');

    const port = createFts5Adapter({
      atomsDir,
      indexPath,
      now: new Date(),
      expectedAnalyzer: declared,
    });
    const served = await port.retrieve('zustand selector', { k: 5 });
    port.close?.();
    expect(served.atoms).toEqual([]);
  });

  it('stays silent on an UNSTAMPED index whose profile declares the chain it carries', async () => {
    clearMeta('analyzer');
    const outcome = await doctor(profileWith({ defaultAnalyzer: 'porter-fold' }));
    expect(outcome.exitCode).toBe(0);
  });

  it('reports a domain whose files all failed to become atoms', async () => {
    writeFileSync(
      resolve(atomsDir, 'broken.md'),
      ['---', 'x_domain: standards', 'title: no id here', '---', 'body'].join('\n'),
      'utf8'
    );
    const outcome = await doctor(profileWith({ domains: ['runner', 'standards'] }));
    expect(outcome.exitCode).toBe(3);
    expect(report(outcome)).toContain('standards');
  });

  it('reports an atoms directory owned by ANOTHER profile', async () => {
    writeFileSync(resolve(atomsDir, ATOMS_OWNER_FILE), 'someone-else\n', 'utf8');
    const outcome = await doctor();
    expect(outcome.exitCode).toBe(3);
    expect(report(outcome)).toContain('someone-else');
  });
});

const STATES_CLAUSE = 'the profile states';

describe('doctor — the SILENT precedence losers', () => {
  it('names DP_GNOSIS_CORPUS_ROOTS beating a profile that declares corpusRoots', async () => {
    process.env[CORPUS_ROOTS_ENV_VAR] = '/srv/other';
    const outcome = await doctor(profileWith({ corpusRoots: ['docs'] }));
    expect(report(outcome)).toContain(CORPUS_ROOTS_ENV_VAR);
    expect(report(outcome)).toContain('docs');
  });

  it('names a CLI flag beating the profile field it overrode', async () => {
    const outcome = await doctor(profileWith({ atomsDir: '/srv/profile-atoms' }), {
      '--atoms-dir': atomsDir,
    });
    expect(report(outcome)).toContain('/srv/profile-atoms');
    expect(report(outcome)).toContain('--atoms-dir');
  });

  it('names the PROFILE FIELD, not the flag, in the "profile states" clause', async () => {
    const outcome = await doctor(profileWith({ atomsDir: '/home/me/myatoms' }));
    const text = report(outcome);
    expect(text).toContain(STATES_CLAUSE);
    const clause = text.slice(text.indexOf(STATES_CLAUSE), text.indexOf(',', text.indexOf(STATES_CLAUSE)));
    expect(clause).toContain('atomsDir');
    expect(clause).not.toContain('--atoms-dir');
    expect(clause).toContain('/home/me/myatoms');
  });

  it('stays SILENT when the only path outside the data root is where the corpus lives', async () => {
    const outcome = await doctor(profileWith({ corpusRoots: ['/home/me/mydocs'] }));
    expect(report(outcome)).not.toContain('[warn]');
  });

  /**
   * Containment is a PATH question, not a string question. A prefix test called
   * a sibling directory "inside" and called every relative location "an
   * absolute path OUTSIDE" -- wrong in both directions, on the check whose
   * whole subject is where a path lands.
   */
  it('names an absolute path that merely SHARES A PREFIX with the data root', async () => {
    process.env['DP_GNOSIS_DATA_HOME'] = resolve(root, 'data');
    const sibling = `${dataRoot()}-elsewhere`;

    const outcome = await doctor(profileWith({ atomsDir: sibling }));

    expect(report(outcome)).toContain(sibling);
    expect(report(outcome)).toContain('OUTSIDE');
  });

  it('does NOT call a RELATIVE profile location an absolute path outside the data root', async () => {
    process.env['DP_GNOSIS_DATA_HOME'] = resolve(root, 'data');

    const outcome = await doctor(profileWith({ atomsDir: '../sibling/atoms' }));

    expect(report(outcome)).not.toContain('OUTSIDE');
  });

  it('names a DP_GNOSIS_*_HOME that is SET BUT BLANK, which reads as unset', async () => {
    process.env['DP_GNOSIS_DATA_HOME'] = '   ';
    expect(report(await doctor())).toContain('DP_GNOSIS_DATA_HOME');
  });

  /**
   * doctor is the command a user reaches for when the instance is ALREADY in a
   * state it cannot read, so it must report a malformed config.json rather than
   * die on it. dataRoot() never touched the file here -- DP_GNOSIS_DATA_HOME
   * short-circuits ahead of it -- so the only reader was this pass, and it read
   * it unguarded.
   */
  it('REPORTS a malformed config.json instead of dying on it', async () => {
    const configDir = resolve(root, 'config', 'dp-gnosis');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(resolve(configDir, 'config.json'), '{ not json', 'utf8');
    process.env['DP_GNOSIS_CONFIG_HOME'] = resolve(root, 'config');
    process.env['DP_GNOSIS_DATA_HOME'] = resolve(root, 'data');
    clearUserConfigCache();

    const outcome = await doctor();

    expect(outcome.exitCode).toBe(3);
    expect(report(outcome)).toContain('config.json');
  });
});

describe('doctor — read-only', () => {
  it('changes nothing under the atoms directory or the index', async () => {
    const before = snapshot(root);
    await doctor();
    expect(snapshot(root)).toEqual(before);
  });

  it('does NOT create an owner marker for an unclaimed atoms directory', async () => {
    rmSync(resolve(atomsDir, ATOMS_OWNER_FILE));
    await doctor();
    expect(readdirSync(atomsDir)).not.toContain(ATOMS_OWNER_FILE);
  });
});

/**
 * CORPUS → ATOMS — the hop nothing guarded until now.
 *
 * The manifest↔index-stamp pair proves the INDEX describes the atoms beside it.
 * Neither end of that pair knows anything about the source documents, so an
 * instance whose sources moved after the last ingest answered from stale atoms
 * at `indexState: ready`, exit 0, `0 fault(s), 0 warning(s)`. These cases run a
 * REAL ingest over a REAL corpus root, because the check is only worth what
 * `loadCorpus` walking the same scope as ingest is worth.
 */
describe('doctor — the corpus AHEAD of its atoms', () => {
  let liveRoot = '';
  let liveAtoms = '';
  let liveIndex = '';
  let liveManifest = '';
  let alpha = '';

  const SOURCES_CHECK = 'corpus-sources';

  const liveContext = (): CommandContext => ({
    adapter: 'fts5',
    atomsDir: liveAtoms,
    indexPath: liveIndex,
    repoRoot: liveRoot,
    profilePath: ingestProfilePath(),
    flags: {},
    positionals: [],
    corpusRoots: ['docs'],
    profile: profileWith(),
  });

  const sourcesLine = (outcome: CommandOutcome): string =>
    outcome.text.split('\n').find(entry => entry.includes(SOURCES_CHECK)) ?? '';

  beforeEach(async () => {
    liveRoot = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-drift-'));
    liveAtoms = resolve(liveRoot, 'vault', 'atoms');
    liveIndex = resolve(liveRoot, 'index', 'atoms.db');
    liveManifest = resolve(liveRoot, 'vault', 'corpus-manifest.json');
    alpha = resolve(liveRoot, 'docs', 'alpha.md');
    mkdirSync(resolve(liveRoot, 'docs'), { recursive: true });
    writeFileSync(alpha, '# Alpha\n\nzustand selector stability rules apply here.\n', 'utf8');
    await ingest({
      outputDir: liveAtoms,
      repoRoot: liveRoot,
      corpusRoots: ['docs'],
      profile: profileWith(),
    });
    buildFts5Index({ atomsDir: liveAtoms, indexPath: liveIndex });
  });

  afterEach(() => rmSync(liveRoot, { recursive: true, force: true }));

  it('reports the sources agreeing with the manifest immediately after an ingest', async () => {
    const outcome = await runDoctorCommand(liveContext());
    expect(sourcesLine(outcome)).toContain('[ok]');
    expect(outcome.exitCode).toBe(0);
  });

  it('WARNS, and does NOT fault, when a source body is edited without a re-ingest', async () => {
    const before = await runDoctorCommand(liveContext());
    appendFileSync(alpha, '\nA sentence no atom on disk contains.\n', 'utf8');
    const after = await runDoctorCommand(liveContext());
    expect(sourcesLine(after)).toContain('[warn]');
    expect(after.exitCode).toBe(before.exitCode);
    expect(after.exitCode).toBe(0);
  });

  it('names BOTH source counts and the two commands that close the gap', async () => {
    writeFileSync(
      resolve(liveRoot, 'docs', 'beta.md'),
      '# Beta\n\nplaywright end to end locator policy.\n',
      'utf8'
    );
    const detail = sourcesLine(await runDoctorCommand(liveContext()));
    expect(detail).toContain('2 source');
    expect(detail).toContain('1 source');
    expect(detail).toContain(ingestCommand());
    expect(detail).toContain(indexRebuildCommand('fts5'));
  });

  it('stays SILENT when a source is merely re-touched with identical bytes', async () => {
    writeFileSync(alpha, readFileSync(alpha, 'utf8'), 'utf8');
    expect(sourcesLine(await runDoctorCommand(liveContext()))).toContain('[ok]');
  });

  it('reports UNKNOWN, never drift, for a manifest that predates the source fields', async () => {
    const legacy = readFileSync(liveManifest, 'utf8')
      .split('\n')
      .filter(entry => !entry.includes('"sourceCount"') && !entry.includes('"sourceDigest"'))
      .join('\n');
    writeFileSync(liveManifest, legacy, 'utf8');
    appendFileSync(alpha, '\nAn edit the legacy manifest cannot possibly describe.\n', 'utf8');
    const outcome = await runDoctorCommand(liveContext());
    expect(sourcesLine(outcome)).toContain('[unknown]');
    expect(sourcesLine(outcome)).not.toContain('[warn]');
    expect(outcome.exitCode).toBe(0);
  });

  it('changes nothing on disk while walking the corpus', async () => {
    const before = snapshot(liveRoot);
    await runDoctorCommand(liveContext());
    expect(snapshot(liveRoot)).toEqual(before);
  });
});

/**
 * The reranker check. Reranking is OPT-IN, so a machine that has deliberately
 * never served one MUST stay at exit 0 — the absence of an optional hop is not a
 * defect, and reporting it as one would teach every reader to ignore `doctor`.
 * A reachable reranker that FAILS the discrimination probe is the opposite: it
 * answers HTTP 200 with well-formed numbers nothing downstream can question, so
 * this pass is the only place it becomes visible.
 */
describe('doctor — the opt-in reranker', () => {
  const RERANK_CHECK = 'rerank';

  const rerankLine = (outcome: CommandOutcome): string =>
    report(outcome).split('\n').find(line => line.includes(`] ${RERANK_CHECK}:`)) ?? '';

  /** Answers both llama-swap endpoints; `scores` is indexed by probe position. */
  const stubReranker = (models: readonly string[], scores: readonly number[]): void => {
    vi.stubGlobal('fetch', async (url: string): Promise<unknown> => ({
      ok: true,
      status: 200,
      text: async (): Promise<string> =>
        JSON.stringify(
          url.endsWith('/v1/models')
            ? { data: models.map(id => ({ id })) }
            : { results: scores.map((relevance_score, index) => ({ index, relevance_score })) }
        ),
      json: async (): Promise<unknown> =>
        url.endsWith('/v1/models')
          ? { data: models.map(id => ({ id })) }
          : { results: scores.map((relevance_score, index) => ({ index, relevance_score })) },
    }));
  };

  beforeEach(() => {
    resetRerankProbeCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetRerankProbeCache();
  });

  it('reports UNKNOWN and stays at exit 0 when no reranker is served', async () => {
    vi.stubGlobal('fetch', async (): Promise<unknown> => {
      throw new TypeError('fetch failed');
    });

    const outcome = await doctor();

    expect(outcome.exitCode).toBe(0);
    expect(rerankLine(outcome)).toContain('[unknown]');
  });

  it('reports UNKNOWN, not a fault, when the server is up without the model', async () => {
    stubReranker(['some-chat-model'], []);

    const outcome = await doctor();

    expect(outcome.exitCode).toBe(0);
    expect(rerankLine(outcome)).toContain('[unknown]');
  });

  it('FAULTS at exit 3 on a served reranker whose scores are DEGENERATE', async () => {
    stubReranker([RERANK_MODEL_ID], [4.6e-23, 4.5e-23]);

    const outcome = await doctor();

    expect(outcome.exitCode).toBe(3);
    expect(rerankLine(outcome)).toContain('[fault]');
    expect(rerankLine(outcome)).toContain('DEGENERATE');
    expect(rerankLine(outcome)).toContain('cls.output.weight');
  });

  it('reports OK with both probe scores on a reranker that discriminates', async () => {
    stubReranker([RERANK_MODEL_ID], [0.99, 0.001]);

    const outcome = await doctor();

    expect(outcome.exitCode).toBe(0);
    expect(rerankLine(outcome)).toContain('[ok]');
    expect(rerankLine(outcome)).toContain('0.99');
    expect(rerankLine(outcome)).toContain('0.001');
  });
});

/**
 * WHICH reranker endpoint is in effect, and which statement lost. The URL and
 * the model are persistable (`config.json`), so an instance can now hold three
 * statements about the same knob — and a user who edited the file while an
 * exported variable outranks it sees nothing change without this line.
 */
describe('doctor — where the reranker endpoint came from', () => {
  const SETTINGS_CHECK = 'rerank-settings';

  const settingsLine = (outcome: CommandOutcome): string =>
    report(outcome).split('\n').find(line => line.includes(`] ${SETTINGS_CHECK}:`)) ?? '';

  const isolatedConfig = (text?: string): void => {
    const configDir = resolve(root, 'rerank-config', 'dp-gnosis');
    mkdirSync(configDir, { recursive: true });
    if (text !== undefined) writeFileSync(resolve(configDir, 'config.json'), text, 'utf8');
    process.env['DP_GNOSIS_CONFIG_HOME'] = resolve(root, 'rerank-config');
    clearUserConfigCache();
  };

  afterEach(() => {
    delete process.env[RERANK_URL_ENV_VAR];
    delete process.env[RERANK_MODEL_ENV_VAR];
  });

  it('names the shipped default when nothing states an endpoint', async () => {
    isolatedConfig();

    expect(settingsLine(await doctor())).toContain(`rerankUrl = ${RERANK_DEFAULT_URL} (from the default)`);
    expect(settingsLine(await doctor())).toContain(`rerankModel = ${RERANK_MODEL_ID} (from the default)`);
  });

  it('names config.json as the winning tier when it states one', async () => {
    isolatedConfig(JSON.stringify({ rerank: { url: 'http://box.lan:9292', model: 'box-model' } }));

    const line = settingsLine(await doctor());

    expect(line).toContain('rerankUrl = http://box.lan:9292 (from the config)');
    expect(line).toContain('rerankModel = box-model (from the config)');
  });

  it('names the environment as the winner AND the config statement it beat', async () => {
    isolatedConfig(JSON.stringify({ rerank: { url: 'http://box.lan:9292', model: 'box-model' } }));
    process.env[RERANK_URL_ENV_VAR] = 'http://env.lan:9292';
    process.env[RERANK_MODEL_ENV_VAR] = 'env-model';

    const line = settingsLine(await doctor());

    expect(line).toContain('rerankUrl = http://env.lan:9292 (from the env)');
    expect(line).toContain('beats the "http://box.lan:9292" in config.json');
    expect(line).toContain('beats the "box-model" in config.json');
  });

  it('REPORTS a malformed rerank section instead of dying on it', async () => {
    isolatedConfig(JSON.stringify({ rerank: { url: '127.0.0.1:9292' } }));

    const outcome = await doctor();

    expect(settingsLine(outcome)).toContain('[unknown]');
    expect(settingsLine(outcome)).toContain('rerank.url');
  });
});

/**
 * WHICH chat id each of the three hops (`--rephrase`, `--synthesize`, `enrich`)
 * is about to ask for, and which statement lost. The three shipped constants
 * are one machine's private llama-swap ids, so on any other machine the first
 * question a failed hop raises is "which id did it ask for, and who said so".
 */
describe('doctor — where the chat hop ids came from', () => {
  const CHAT_CHECK = 'chat-settings';

  const chatLine = (outcome: CommandOutcome): string =>
    report(outcome).split('\n').find(line => line.includes(`] ${CHAT_CHECK}:`)) ?? '';

  const isolatedConfig = (text?: string): void => {
    const configDir = resolve(root, 'chat-config', 'dp-gnosis');
    mkdirSync(configDir, { recursive: true });
    if (text !== undefined) writeFileSync(resolve(configDir, 'config.json'), text, 'utf8');
    process.env['DP_GNOSIS_CONFIG_HOME'] = resolve(root, 'chat-config');
    clearUserConfigCache();
  };

  afterEach(() => {
    delete process.env[ENRICH_MODEL_ENV_VAR];
  });

  it('names the shipped defaults when nothing states a chat id', async () => {
    isolatedConfig();

    const line = chatLine(await doctor());

    expect(line).toContain(`rephraseModel = ${REPHRASE_MODEL_ID} (from the default)`);
    expect(line).toContain(`synthesizeModel = ${SYNTHESIZE_MODEL_ID} (from the default)`);
    expect(line).toContain(`enrichModel = ${ENRICH_MODEL_ID} (from the default)`);
  });

  it('names config.json as the winning tier when it states one', async () => {
    isolatedConfig(JSON.stringify({ models: { rephrase: 'box-rewriter', enrich: 'box-generator' } }));

    const line = chatLine(await doctor());

    expect(line).toContain('rephraseModel = box-rewriter (from the config)');
    expect(line).toContain('enrichModel = box-generator (from the config)');
  });

  it('names the environment as the winner AND the config statement it beat', async () => {
    isolatedConfig(JSON.stringify({ models: { enrich: 'box-generator' } }));
    process.env[ENRICH_MODEL_ENV_VAR] = 'env-generator';

    const line = chatLine(await doctor());

    expect(line).toContain('enrichModel = env-generator (from the env)');
    expect(line).toContain('beats the "box-generator" in config.json');
  });

  it('REPORTS a malformed models section instead of dying on it', async () => {
    isolatedConfig(JSON.stringify({ models: { enrich: '' } }));

    expect(chatLine(await doctor())).toContain('[unknown]');
    expect(chatLine(await doctor())).toContain('models.enrich');
  });
});
