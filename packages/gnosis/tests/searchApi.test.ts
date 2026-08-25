/**
 * `search()` is the LIBRARY surface of the same command the CLI runs, and the
 * only thing worth proving about it is that it is not a SECOND retrieval path:
 * a re-implementation drifts the first time either side changes. So the claim
 * here is equality with the `answer --json` payload for the same inputs —
 * asserted on the whole object, never on a field or two.
 *
 * The corpus is one of its own (the shape `tests/mcpProtocol.test.ts` uses), and
 * it is installed as the ACTIVE profile rather than passed as a flag, because
 * `GnosisRequest` states no profile: that is what makes both surfaces read the
 * same instance without `search()` growing a knob its contract does not carry.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli/cli.js';
import { search, searchArgv } from '../src/index.js';
import { loadIngestProfile } from '../src/ingestProfile.js';
import { activeProfile, resetActiveProfile, setActiveProfile } from '../src/vocabulary.js';

type Json = Record<string, unknown>;

const DOC = (term: string): string =>
  `# ${term} handbook\n\nprose about ${term} written at enough length that this section stands on its own as an atom of the corpus rather than folding into a neighbour, carrying real sentences about the ${term} subject matter\n`;

const tinyCorpus = async (): Promise<string> => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'gnosis-api-'));
  await mkdir(join(repoRoot, 'doc'), { recursive: true });
  await writeFile(join(repoRoot, 'doc', 'APIDOC.md'), DOC('apiknowledge'), 'utf8');
  await writeFile(join(repoRoot, 'doc', 'OTHER.md'), DOC('otherknowledge'), 'utf8');
  const profilePath = join(repoRoot, 'api.profile.json');
  await writeFile(
    profilePath,
    JSON.stringify({
      ...activeProfile(),
      name: 'api',
      repoRoot,
      corpusRoots: ['doc'],
      atomsDir: join(repoRoot, 'atoms'),
      indexPath: join(repoRoot, 'index.db'),
    }),
    'utf8'
  );
  await runCli(['ingest', '--profile', profilePath]);
  await runCli(['index', '--adapter', 'fts5', '--profile', profilePath]);
  return profilePath;
};

describe('searchArgv — the request IS an answer --json invocation', () => {
  it('renders only the flags the request states, and always --json', () => {
    expect(searchArgv({ query: 'apiknowledge handbook' })).toEqual([
      'answer',
      'apiknowledge handbook',
      '--json',
    ]);
  });

  it('maps every optional field onto its own CLI flag', () => {
    expect(
      searchArgv({
        query: 'q',
        k: 3,
        adapter: 'fts5',
        types: ['standard', 'guide'],
        domains: ['runner'],
        maxTokens: 500,
        budgetMode: 'tokens',
        minRelevance: 0.4,
        maxPerDoc: 2,
        rerank: true,
        rephrase: true,
        synthesize: true,
      })
    ).toEqual([
      'answer',
      'q',
      '--json',
      '-k',
      '3',
      '--adapter',
      'fts5',
      '--type',
      'standard,guide',
      '--domain',
      'runner',
      '--max-tokens',
      '500',
      '--budget-mode',
      'tokens',
      '--min-relevance',
      '0.4',
      '--max-per-doc',
      '2',
      '--rerank',
      '--rephrase',
      '--synthesize',
    ]);
  });

  it('leaves a false boolean off entirely rather than passing a negated flag', () => {
    expect(searchArgv({ query: 'q', rerank: false, synthesize: false })).toEqual([
      'answer',
      'q',
      '--json',
    ]);
  });
});

describe('ONE code path — search() IS answer --json', () => {
  afterEach(() => {
    resetActiveProfile();
  });

  it('returns the parsed payload of the identical CLI invocation', async () => {
    const profilePath = await tinyCorpus();
    setActiveProfile(loadIngestProfile(profilePath));

    const answer = await search({ query: 'apiknowledge handbook', k: 3 });
    const direct = await runCli(['answer', 'apiknowledge handbook', '-k', '3', '--json']);
    const payload = JSON.parse(direct.stdout) as Json;

    expect(direct.exitCode).toBe(0);
    expect(answer.pack).toContain('apiknowledge');
    expect(answer).toEqual(payload);
  });

  it('refuses a payload carrying no pack instead of returning an empty answer', async () => {
    const profilePath = await tinyCorpus();
    setActiveProfile(loadIngestProfile(profilePath));

    await expect(search({ query: 'q', adapter: 'nosuchadapter' })).rejects.toThrow(/gnosis/);
  });
});
