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
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

import { buildFts5Index, createFts5Adapter } from '../src/adapters/fts5Adapter.js';
import type { CommandContext } from '../src/cli/context.js';
import { runDoctorCommand } from '../src/cli/doctorCommand.js';
import type { CommandOutcome } from '../src/cli/outcome.js';
import { CORPUS_ROOTS_ENV_VAR } from '../src/config.js';
import { buildCorpusManifest, serializeCorpusManifest } from '../src/corpusManifest.js';
import { ATOMS_OWNER_FILE, ingest } from '../src/ingest.js';
import { indexRebuildCommand, ingestCommand } from '../src/invocation.js';
import type { IngestProfile } from '../src/ingestProfile.js';
import type { FlagValues } from '../src/cli/args.js';
import type { AnalyzerId } from '../src/query.js';

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

  it('names a DP_GNOSIS_*_HOME that is SET BUT BLANK, which reads as unset', async () => {
    process.env['DP_GNOSIS_DATA_HOME'] = '   ';
    expect(report(await doctor())).toContain('DP_GNOSIS_DATA_HOME');
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
