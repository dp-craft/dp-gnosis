/**
 * `retrieve --format <text|json|xml>`.
 *
 * The two OLD renderings are pinned by comparison, not by transcription: the
 * default must equal `--format text` and `--json` must equal `--format json`
 * byte for byte, so a future edit to either renderer fails here instead of
 * silently changing what every existing caller reads.
 *
 * The xml rendering is checked by PARSING it back with a hand-rolled scanner —
 * no XML library is added for a format this small — over a body deliberately
 * carrying `<`, `&`, a quote and the literal `]]>` that breaks naive CDATA.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';

/** Every character class that can make XML malformed, in one atom body. */
const HOSTILE_BODY = 'escaping probe with <tag> & "quoted" \'apos\' and a literal ]]> fence';

const DOC = `# Escaping Probe\n\n${HOSTILE_BODY}\n`;

interface Fixture {
  readonly repoRoot: string;
  readonly atomsDir: string;
}

const makeFixture = async (): Promise<Fixture> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-format-'));
  const corpus = join(repoRoot, 'doc');
  await mkdir(corpus, { recursive: true });
  await writeFile(join(corpus, 'ESCAPING.md'), DOC, 'utf8');
  return { repoRoot, atomsDir: join(repoRoot, 'atoms') };
};

const ingest = async (fixture: Fixture): Promise<void> => {
  await runCli(['ingest', '--atoms-dir', fixture.atomsDir, '--repo-root', fixture.repoRoot]);
};

const retrieveArgv = (
  fixture: Fixture,
  query: string,
  extra: readonly string[]
): readonly string[] => [
  'search',
  query,
  // Pinned: the RENDERINGS are the subject here and are adapter-independent by
  // construction; the default adapter is index-backed and would search the
  // repo's own index rather than the fixture's atoms.
  '--adapter',
  'linear',
  '--atoms-dir',
  fixture.atomsDir,
  '--repo-root',
  fixture.repoRoot,
  ...extra,
];

const TAG = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w.-]+="[^"<]*")*)\s*(\/?)>/g;
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+);/g;

const expectNoRawMarkup = (segment: string): void => {
  expect(segment).not.toContain('<');
  expect(segment.replace(ENTITY, '')).not.toContain('&');
};

/**
 * Minimal well-formedness: every tag matched and balanced under one root, and
 * no raw `<` or unescaped `&` in any text or attribute value.
 */
const expectWellFormedXml = (xml: string): void => {
  const stack: string[] = [];
  let cursor = 0;
  let tags = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(xml); match !== null; match = TAG.exec(xml)) {
    expectNoRawMarkup(xml.slice(cursor, match.index));
    expectNoRawMarkup((match[3] ?? '').replace(/[\w.-]+="/g, '').replace(/"/g, ''));
    if (match[4] !== '/') {
      if (match[1] === '/') expect(stack.pop()).toBe(match[2]);
      else stack.push(match[2] ?? '');
    }
    cursor = match.index + match[0].length;
    tags += 1;
  }
  expectNoRawMarkup(xml.slice(cursor));
  expect(tags).toBeGreaterThan(0);
  expect(stack).toEqual([]);
};

// The checker guards every xml assertion below, so it is itself checked: a
// scanner that accepts everything would make those assertions decorative.
describe('the well-formedness checker', () => {
  it('rejects a raw <, an unescaped & and an unbalanced tag, and accepts an entity', () => {
    expect(() => expectWellFormedXml('<a>1 < 2</a>')).toThrow();
    expect(() => expectWellFormedXml('<a>AT&T</a>')).toThrow();
    expect(() => expectWellFormedXml('<a><b></a></b>')).toThrow();
    expect(() => expectWellFormedXml('<a>ok &amp; fine</a>')).not.toThrow();
  });
});

describe('retrieve --format', () => {
  beforeEach(() => {
    vi.stubEnv('DP_GNOSIS_CORPUS_ROOTS', 'doc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('the pre-existing renderings', () => {
    it('renders text by default, byte-identical to an explicit --format text', async () => {
      const fixture = await makeFixture();
      await ingest(fixture);

      const bare = await runCli(retrieveArgv(fixture, 'escaping probe', []));
      const explicit = await runCli(
        retrieveArgv(fixture, 'escaping probe', ['--format', 'text'])
      );

      expect(bare.stdout).toBe(explicit.stdout);
      expect(bare.exitCode).toBe(explicit.exitCode);
      expect(bare.stdout).toContain('escaping-probe');
      // The compact human line carries no body — that is what xml/json add.
      expect(bare.stdout).not.toContain(HOSTILE_BODY);
    });

    it('renders --json byte-identical to --format json', async () => {
      const fixture = await makeFixture();
      await ingest(fixture);

      const legacy = await runCli(retrieveArgv(fixture, 'escaping probe', ['--json']));
      const explicit = await runCli(
        retrieveArgv(fixture, 'escaping probe', ['--format', 'json'])
      );

      expect(legacy.stdout).toBe(explicit.stdout);
      expect(legacy.exitCode).toBe(explicit.exitCode);
      expect(JSON.parse(legacy.stdout)['count']).toBeGreaterThan(0);
    });

    it('accepts --json together with --format json as the same request', async () => {
      const fixture = await makeFixture();
      await ingest(fixture);

      const result = await runCli(
        retrieveArgv(fixture, 'escaping probe', ['--json', '--format', 'json'])
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)['command']).toBe('search');
    });
  });

  describe('xml', () => {
    it('emits a well-formed retrieved_context block carrying each atom body', async () => {
      const fixture = await makeFixture();
      await ingest(fixture);

      const result = await runCli(retrieveArgv(fixture, 'escaping probe', ['--format', 'xml']));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expectWellFormedXml(result.stdout);
      expect(result.stdout).toContain('<retrieved_context ');
      expect(result.stdout).toContain('<document ');
      expect(result.stdout).toContain('<section>Escaping Probe</section>');
      // Repo-root-relative, so a pasted block carries no machine-local prefix.
      expect(result.stdout).toContain('<source>atoms/');
      expect(result.stdout).not.toContain(`<source>${fixture.repoRoot}`);
    });

    it('entity-escapes <, &, quotes and a literal ]]> instead of using CDATA', async () => {
      const fixture = await makeFixture();
      await ingest(fixture);

      const result = await runCli(retrieveArgv(fixture, 'escaping probe', ['--format', 'xml']));

      expectWellFormedXml(result.stdout);
      expect(result.stdout).not.toContain('<![CDATA[');
      expect(result.stdout).toContain('&lt;tag&gt;');
      expect(result.stdout).toContain('&amp;');
      expect(result.stdout).toContain('&quot;quoted&quot;');
      expect(result.stdout).toContain(']]&gt; fence');
    });

    it('distinguishes an empty search from no search at all', async () => {
      const fixture = await makeFixture();
      await ingest(fixture);

      const empty = await runCli(retrieveArgv(fixture, 'zzqqxwv', ['--format', 'xml']));
      const unavailable = await runCli([
        'search',
        'escaping probe',
        '--adapter',
        'linear',
        '--atoms-dir',
        join(fixture.repoRoot, 'absent'),
        '--format',
        'xml',
      ]);

      expect(empty.exitCode).toBe(0);
      expectWellFormedXml(empty.stdout);
      expect(empty.stdout).toContain('count="0"');
      expect(empty.stdout).not.toContain('<document ');
      // T3.2: an empty search now carries its OWN note. The distinction the
      // test names is sharper for it — the notes state different facts.
      expect(empty.stdout).toContain('nothing in the vault matched these terms');
      expect(empty.stdout).not.toContain('npm run gnosis -- ingest');

      expect(unavailable.exitCode).toBe(3);
      expectWellFormedXml(unavailable.stdout);
      expect(unavailable.stdout).toContain('indexState="unavailable"');
      expect(unavailable.stdout).toContain('count="0"');
      expect(unavailable.stdout).not.toContain('<document ');
      expect(unavailable.stdout).toContain('npm run gnosis -- ingest');
      expect(unavailable.stdout).not.toContain('nothing in the vault matched these terms');
    });
  });

  describe('usage failures', () => {
    it('exits 2 naming both flags when --json contradicts --format xml', async () => {
      const result = await runCli(['search', 'x', '--json', '--format', 'xml']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--json');
      expect(result.stderr).toContain('--format');
      expect(result.stdout).toBe('');
    });

    it('exits 2 naming the accepted values for an unknown --format', async () => {
      const result = await runCli(['search', 'x', '--format', 'yaml']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('yaml');
      expect(result.stderr).toContain('text');
      expect(result.stderr).toContain('json');
      expect(result.stderr).toContain('xml');
      expect(result.stdout).toBe('');
    });

    it('refuses --format on a command that does not accept it', async () => {
      const result = await runCli(['index', '--format', 'xml']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--format');
      expect(result.stderr).toContain('unknown flag');
      expect(result.stdout).toBe('');
    });
  });
});
