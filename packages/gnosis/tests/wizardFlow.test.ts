/**
 * `wizard` — the interactive first run, driven end to end by a scripted
 * prompter.
 *
 * The properties under test are the three the command promises: nothing is
 * written until the summary is confirmed, an abort at any question leaves the
 * machine exactly as it was, and a corpus directory that would ingest nothing
 * is re-asked rather than accepted. The last one is the failure class this
 * repository exists to police — a silently empty corpus answers nothing while
 * every check stays green.
 *
 * The script answers by MESSAGE, never by call order. A positional script
 * silently re-aligns the moment a question is added, and then every assertion
 * below would be about the wrong answer.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { CommandContext } from '../src/cli/context.js';
import type { CommandOutcome } from '../src/cli/outcome.js';
import type { Option, Prompter } from '../src/cli/wizard/prompts.js';
import { CANCELLED } from '../src/cli/wizard/prompts.js';
import { localBaseUrl, startServer } from '../src/cli/wizard/backend.js';
import { timingLines } from '../src/cli/wizard/rerankFlow.js';
import { runWizard } from '../src/cli/wizardCommand.js';
import { atomsDir, fts5IndexPath, userProfilePath } from '../src/paths.js';
import { clearUserConfigCache } from '../src/userConfig.js';
import { activeProfile } from '../src/vocabulary.js';

/** An answer meaning "take the default this question offered". */
const KEEP_DEFAULT = Symbol('keep-default');

interface Reply {
  readonly match: RegExp;
  /** Consumed in order; the last one repeats, so a re-asked question can differ. */
  readonly answers: readonly unknown[];
}

interface Scripted extends Prompter {
  /** Every line the user was TOLD, and every question they were asked. */
  readonly transcript: readonly string[];
  readonly asked: readonly string[];
}

/**
 * A prompter that answers from a table keyed on the question text. An
 * unmatched question is a hard failure naming the message — the alternative is
 * a silent default, which is how a test comes to assert the wrong flow.
 */
const scriptedPrompter = (replies: readonly Reply[]): Scripted => {
  const transcript: string[] = [];
  const asked: string[] = [];
  const used = new Map<Reply, number>();

  const answerFor = (message: string): unknown => {
    asked.push(message);
    transcript.push(`? ${message}`);
    const reply = replies.find(candidate => candidate.match.test(message));
    if (reply === undefined) {
      throw new Error(
        `wizard asked an unscripted question: "${message}"\nasked so far:\n${asked.map(entry => `  ${entry}`).join('\n')}`
      );
    }
    const seen = used.get(reply) ?? 0;
    used.set(reply, seen + 1);
    const answer = reply.answers[Math.min(seen, reply.answers.length - 1)];
    if (answer === CANCELLED) throw CANCELLED;
    return answer;
  };

  const resolveAnswer = <T>(message: string, fallback: T): T => {
    const answer = answerFor(message);
    return answer === KEEP_DEFAULT ? fallback : (answer as T);
  };

  return {
    transcript,
    asked,
    say: lines => {
      transcript.push(...lines);
    },
    progress: line => {
      transcript.push(line);
    },
    select: async <T>(message: string, options: readonly Option<T>[], initial?: T): Promise<T> =>
      resolveAnswer(message, initial === undefined ? (options[0] as Option<T>).value : initial),
    multiSelect: async <T>(message: string, _options: readonly Option<T>[], checked: readonly T[]): Promise<readonly T[]> =>
      resolveAnswer<readonly T[]>(message, checked),
    confirm: async (message, initial) => resolveAnswer(message, initial),
    input: async (message, initial) => resolveAnswer(message, initial ?? ''),
  };
};

let home = '';
let corpusDir = '';

const contextWith = (positionals: readonly string[] = []): CommandContext => ({
  adapter: 'fts5',
  atomsDir: atomsDir(),
  indexPath: fts5IndexPath(),
  repoRoot: home,
  profilePath: userProfilePath(),
  flags: {},
  positionals,
  corpusRoots: [],
  profile: activeProfile(),
});

/**
 * The reranker is declined in EVERY case. Answering it true makes the command
 * probe 127.0.0.1:9292 and Ollama over the network, and a unit suite that
 * depends on either is not measuring the wizard.
 */
const baseScript = (): Reply[] => [
  { match: /^Data root/, answers: [KEEP_DEFAULT] },
  { match: /^Corpus directory/, answers: [corpusDir] },
  { match: /^Next corpus directory/, answers: [corpusDir] },
  { match: /^Domain label for/, answers: [KEEP_DEFAULT] },
  { match: /^Add another corpus directory\?/, answers: [false] },
  { match: /^Paths to skip/, answers: [KEEP_DEFAULT] },
  { match: /^Default atom type/, answers: [KEEP_DEFAULT] },
  { match: /^Types to hide/, answers: [KEEP_DEFAULT] },
  { match: /^What language/, answers: [KEEP_DEFAULT] },
  { match: /^Do they contain code identifiers/, answers: [KEEP_DEFAULT] },
  { match: /^Analysis chain/, answers: [KEEP_DEFAULT] },
  { match: /^Ranking adapter/, answers: [KEEP_DEFAULT] },
  { match: /^Serve pseudo-relevance feedback/, answers: [KEEP_DEFAULT] },
  { match: /^Set up the reranker\?/, answers: [false] },
  { match: /^Write it\?/, answers: [true] },
];

/** Replace one entry of the base script, keeping the ORDER the flow asks in. */
const scriptWith = (match: RegExp, answers: readonly unknown[]): readonly Reply[] =>
  baseScript().map(reply => (reply.match.source === match.source ? { match, answers } : reply));

const wizard = async (
  replies: readonly Reply[] = baseScript(),
  positionals: readonly string[] = []
): Promise<{ readonly outcome: CommandOutcome; readonly prompter: Scripted }> => {
  const prompter = scriptedPrompter(replies);
  return { outcome: await runWizard(contextWith(positionals), prompter), prompter };
};

const profilePath = (): string => userProfilePath();

const readProfile = (): Record<string, unknown> =>
  JSON.parse(readFileSync(profilePath(), 'utf8')) as Record<string, unknown>;

const atomFiles = (): readonly string[] =>
  existsSync(atomsDir()) ? readdirSync(atomsDir()).filter(name => name.endsWith('.md')) : [];

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-wizard-'));
  corpusDir = resolve(home, 'notes');
  mkdirSync(corpusDir, { recursive: true });
  writeFileSync(
    join(corpusDir, 'retrieval.md'),
    '# Retrieval\n\nGnosis ranks atoms with BM25 over a lexical index.\n',
    'utf8'
  );
  writeFileSync(
    join(corpusDir, 'ingest.md'),
    '# Ingest\n\nIngest chunks markdown into heading-bounded atoms.\n',
    'utf8'
  );
  process.env['DP_GNOSIS_DATA_HOME'] = join(home, 'data');
  process.env['DP_GNOSIS_CONFIG_HOME'] = join(home, 'config');
  clearUserConfigCache();
});

afterEach(() => {
  delete process.env['DP_GNOSIS_DATA_HOME'];
  delete process.env['DP_GNOSIS_CONFIG_HOME'];
  clearUserConfigCache();
  rmSync(home, { recursive: true, force: true });
});

/**
 * The happy path drives a REAL ingest + index + search. Running it once per
 * `it` made this file the slowest in the suite and starved the parallel run
 * until unrelated files timed out. The flow therefore runs ONCE, in a
 * `beforeAll`, and the four properties are asserted against that single
 * outcome.
 *
 * The suite-wide `beforeEach` builds a fresh temp root for every test, so this
 * describe re-points the module state at its own run before each of its tests,
 * and restores the per-test root afterwards so the suite-wide `afterEach`
 * still removes the directory it created. No other describe shares anything.
 */
describe('wizard — the confirmed happy path', () => {
  let happyHome = '';
  let happyCorpusDir = '';
  let perTestHome = '';
  let perTestCorpusDir = '';
  let outcome: CommandOutcome;
  let prompter: Scripted;

  beforeAll(async () => {
    happyHome = mkdtempSync(resolve(tmpdir(), 'dp-gnosis-wizard-happy-'));
    happyCorpusDir = resolve(happyHome, 'notes');
    mkdirSync(happyCorpusDir, { recursive: true });
    writeFileSync(
      join(happyCorpusDir, 'retrieval.md'),
      '# Retrieval\n\nGnosis ranks atoms with BM25 over a lexical index.\n',
      'utf8'
    );
    writeFileSync(
      join(happyCorpusDir, 'ingest.md'),
      '# Ingest\n\nIngest chunks markdown into heading-bounded atoms.\n',
      'utf8'
    );
    home = happyHome;
    corpusDir = happyCorpusDir;
    process.env['DP_GNOSIS_DATA_HOME'] = join(happyHome, 'data');
    process.env['DP_GNOSIS_CONFIG_HOME'] = join(happyHome, 'config');
    clearUserConfigCache();

    const run = await wizard();
    outcome = run.outcome;
    prompter = run.prompter;
  }, 120_000);

  beforeEach(() => {
    perTestHome = home;
    perTestCorpusDir = corpusDir;
    home = happyHome;
    corpusDir = happyCorpusDir;
    process.env['DP_GNOSIS_DATA_HOME'] = join(happyHome, 'data');
    process.env['DP_GNOSIS_CONFIG_HOME'] = join(happyHome, 'config');
    clearUserConfigCache();
  });

  afterEach(() => {
    home = perTestHome;
    corpusDir = perTestCorpusDir;
  });

  afterAll(() => {
    rmSync(happyHome, { recursive: true, force: true });
  });

  it('should exit 0 and report an indexState when the summary is confirmed', async () => {
    expect(outcome.exitCode).toBe(0);
    expect((outcome.data as Record<string, unknown>)['indexState']).toBe('ready');
  });

  it('should write a profile carrying every answer the interview collected', async () => {
    const profile = readProfile();
    expect(profile['domains']).toEqual(['notes']);
    expect(profile['domainRules']).toEqual([{ prefix: happyCorpusDir, domain: 'notes' }]);
    expect(profile['defaultAnalyzer']).toBe('porter-fold');
    expect(profile['defaultExcludedTypes']).toEqual(['feature-log', 'benchmark', 'review', 'brainstorm']);
    expect(profile['corpusRoots']).toEqual([happyCorpusDir]);
    expect(profile['atomsDir']).toBe(atomsDir());
    expect(profile['indexPath']).toBe(fts5IndexPath());
  });

  it('should leave the atoms directory holding atoms, so the built vault is not empty', async () => {
    expect(atomFiles().length).toBeGreaterThan(0);
  });

  it('should run ingest BEFORE index, which is one operation in two commands', async () => {
    const joined = prompter.transcript.join('\n');
    expect(joined.indexOf('running ingest')).toBeGreaterThan(-1);
    expect(joined.indexOf('running index')).toBeGreaterThan(joined.indexOf('running ingest'));
  });
});

describe('wizard — nothing is written until the summary is confirmed', () => {
  it('should write NOTHING when the summary is declined', async () => {
    const { outcome } = await wizard(scriptWith(/^Write it\?/, [false]));

    expect(outcome.exitCode).toBe(3);
    expect(outcome.text).toContain('no profile and no config were written');
    expect(existsSync(profilePath())).toBe(false);
    expect(atomFiles()).toEqual([]);
  });

  it('should write NOTHING when the user interrupts mid-interview', async () => {
    const { outcome } = await wizard(scriptWith(/^What language/, [CANCELLED]));

    expect(outcome.exitCode).toBe(3);
    expect(outcome.text).toContain('no profile and no config were written');
    expect(existsSync(profilePath())).toBe(false);
    expect(atomFiles()).toEqual([]);
  });
});

describe('wizard — a corpus directory is validated as it is entered', () => {
  it('should re-ask a directory holding no markdown rather than accepting it', async () => {
    const empty = join(home, 'empty');
    mkdirSync(empty, { recursive: true });

    const { outcome, prompter } = await wizard(scriptWith(/^Corpus directory/, [empty, corpusDir]));

    expect(prompter.transcript.join('\n')).toContain('holds no markdown');
    expect(outcome.exitCode).toBe(0);
    expect(readProfile()['corpusRoots']).toEqual([corpusDir]);
  });

  it('should refuse a relative corpus path by name and re-ask', async () => {
    const { outcome, prompter } = await wizard(scriptWith(/^Corpus directory/, ['notes', corpusDir]));

    expect(prompter.transcript.join('\n')).toContain('that path is relative');
    expect(outcome.exitCode).toBe(0);
    expect(readProfile()['corpusRoots']).toEqual([corpusDir]);
  });
});

/**
 * The instance guard reads the root the user CHOSE, so it runs after the one
 * question that can move it and before every other. A guard against the default
 * root cannot see a root typed at the prompt, and both refusals below are about
 * a root the wizard would otherwise write into.
 */
describe('wizard — refusals before any answer is collected', () => {
  it('should refuse an instance that already exists rather than overwriting the profile', async () => {
    mkdirSync(dirname(profilePath()), { recursive: true });
    writeFileSync(profilePath(), '{"name":"user"}\n', 'utf8');

    const { outcome, prompter } = await wizard();

    expect(outcome.exitCode).toBe(3);
    expect(outcome.text).toContain(profilePath());
    expect(outcome.text).toContain('MUST NOT overwrite');
    expect(prompter.asked).toEqual(['Data root']);
    expect(readFileSync(profilePath(), 'utf8')).toBe('{"name":"user"}\n');
  });

  // Given a data root TYPED at the prompt whose atoms directory already holds
  // markdown, When the wizard reads that answer, Then it refuses by count —
  // writing a profile over those atoms makes the next ingest prune every one of
  // them as an orphan, and the default root says nothing about a typed one.
  it('should refuse a chosen data root whose atoms directory already holds atoms', async () => {
    const chosen = join(home, 'adopted');
    const occupied = atomsDir(chosen);
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'someone-elses.md'), '# Theirs\n', 'utf8');

    const { outcome, prompter } = await wizard(scriptWith(/^Data root/, [chosen]));

    expect(outcome.exitCode).toBe(3);
    expect(outcome.text).toContain(occupied);
    expect(outcome.text).toContain('already holds 1 atom file');
    expect(outcome.text).toContain('prune every one of them as an orphan');
    expect(prompter.asked).toEqual(['Data root']);
    expect(existsSync(profilePath())).toBe(false);
  });

  it('should refuse with exit 2 when given a positional, which it takes none of', async () => {
    const { outcome, prompter } = await wizard(baseScript(), ['~/notes']);

    expect(outcome.exitCode).toBe(2);
    expect(prompter.asked).toEqual([]);
    expect(existsSync(profilePath())).toBe(false);
  });
});

/**
 * The adapter is an INSTANCE-wide choice, and `search` defaults to `fts5`. A
 * wizard that passed it to `index` alone would build one index and then prove a
 * different one — reporting its own omission as the vault's state.
 */
describe('wizard — the adapter chosen survives the build', () => {
  it('should probe with the adapter it built, and print it in the next-steps search', async () => {
    const { outcome } = await wizard(scriptWith(/^Ranking adapter/, ['minisearch']));

    expect((outcome.data as Record<string, unknown>)['indexState']).toBe('ready');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.text).toContain('search "<keywords>" --adapter minisearch');
  }, 120_000);
});

/**
 * A port that is already bound is proved by SOMEONE ELSE'S server: the spawn
 * returns a pid before it dies with "address in use", and the readiness poll
 * then reads the pre-existing HTTP 200 as its own success.
 */
describe('startServer — a bound port is reported, not spawned over', () => {
  let taken: Server;
  let port = 0;

  beforeEach(async () => {
    taken = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    });
    await new Promise<void>(done => taken.listen(0, '127.0.0.1', done));
    port = (taken.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>(done => taken.close(() => done()));
  });

  it('should report the address as already served rather than spawning a second server', async () => {
    const logPath = join(home, 'llama-server.log');

    const outcome = await startServer(join(home, 'model.gguf'), port, logPath);

    expect(outcome).toEqual({ ok: true, pid: undefined, alreadyServing: localBaseUrl(port) });
    expect(existsSync(logPath)).toBe(false);
  });
});

/**
 * The in-process scoring path is given no timeout — `rerank.ts` forwards
 * `timeoutMs` to the HTTP scorer only — so a pool that has started is ended by
 * Ctrl-C and by nothing else. That matters where the projection is long, and is
 * noise where it is not, so the line is conditional and both sides are asserted.
 */
describe('timingLines — the projection says when nothing will cancel it', () => {
  const DOCUMENTS = 2;
  const POOL = 100;
  /** perDoc 2000 ms over a pool of 100 → a 200 s projection, well past the threshold. */
  const SLOW_ELAPSED_MS = 4000;
  /** perDoc 200 ms over the same pool → 20 s, under it. */
  const FAST_ELAPSED_MS = 400;

  it('warns that only Ctrl-C ends the run when the projected pool is long', () => {
    const lines = timingLines(SLOW_ELAPSED_MS, DOCUMENTS, POOL).join('\n');

    expect(lines).toContain('no timeout');
    expect(lines).toContain('only Ctrl-C ends it');
  });

  it('says nothing about cancelling on a machine whose projection is short', () => {
    const lines = timingLines(FAST_ELAPSED_MS, DOCUMENTS, POOL).join('\n');

    expect(lines).toContain('a projection, not a measured run');
    expect(lines).not.toContain('Ctrl-C');
  });
});
