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
import { ADAPTER_CHOICES, ANALYZER_CHOICES } from '../src/cli/wizard/advice.js';
import { localBaseUrl, startServer } from '../src/cli/wizard/backend.js';
import type { HardwareFacts } from '../src/cli/wizard/hardware.js';
import { PRESETS } from '../src/cli/wizard/preset.js';
import type { Option, Prompter } from '../src/cli/wizard/prompts.js';
import { CANCELLED } from '../src/cli/wizard/prompts.js';
import type { RerankPreference, RerankResult, ServeLocations } from '../src/cli/wizard/rerankFlow.js';
import { askRerank, timingLines } from '../src/cli/wizard/rerankFlow.js';
import { runWizard } from '../src/cli/wizardCommand.js';
import { LOCAL_RERANKER_INSTALL_COMMAND } from '../src/localReranker.js';
import { atomsDir, dataRoot, fts5IndexPath, userProfilePath } from '../src/paths.js';
import { resetRerankProbeCache } from '../src/rerank.js';
import { clearUserConfigCache } from '../src/userConfig.js';
import { activeProfile } from '../src/vocabulary.js';

/**
 * The in-process engine is a devDependency, so a checkout HAS it and a consumer
 * does not — and the wizard branches on exactly that. Only the availability
 * probe is replaced, so every other export (the install command the refusal
 * names, the scorer the local backend uses) stays the real one.
 */
const engineState = vi.hoisted(() => ({ available: true }));

vi.mock('../src/localReranker.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/localReranker.js')>();
  return {
    ...actual,
    localRerankerAvailability: async () =>
      engineState.available
        ? { available: true }
        : { available: false, reason: 'the engine is absent in this test' },
  };
});

/** An answer meaning "take the default this question offered". */
const KEEP_DEFAULT = Symbol('keep-default');

/**
 * An answer meaning "take the row this menu rendered under this name". The
 * amend menu's values are the amendment records themselves, which a script
 * cannot construct, and picking one by INDEX would silently move the moment a
 * row is added — which is precisely the class of failure this file exists over.
 */
interface Pick {
  readonly pickName: string;
}

const byName = (pickName: string): Pick => ({ pickName });

const isPick = (value: unknown): value is Pick =>
  typeof value === 'object' && value !== null && 'pickName' in value;

interface Reply {
  readonly match: RegExp;
  /** Consumed in order; the last one repeats, so a re-asked question can differ. */
  readonly answers: readonly unknown[];
}

/** One menu as the user saw it: its question, every row's name and description. */
interface Menu {
  readonly message: string;
  readonly names: readonly string[];
  readonly descriptions: readonly string[];
}

interface Scripted extends Prompter {
  /** Every line the user was TOLD, and every question they were asked. */
  readonly transcript: readonly string[];
  readonly asked: readonly string[];
  readonly menus: readonly Menu[];
}

/**
 * A prompter that answers from a table keyed on the question text. An
 * unmatched question is a hard failure naming the message — the alternative is
 * a silent default, which is how a test comes to assert the wrong flow.
 */
const scriptedPrompter = (replies: readonly Reply[]): Scripted => {
  const transcript: string[] = [];
  const asked: string[] = [];
  const menus: Menu[] = [];
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
    menus,
    say: lines => {
      transcript.push(...lines);
    },
    progress: line => {
      transcript.push(line);
    },
    select: async <T>(message: string, options: readonly Option<T>[], initial?: T): Promise<T> => {
      menus.push({
        message,
        names: options.map(option => option.name),
        descriptions: options.map(option => option.description ?? ''),
      });
      const answer = resolveAnswer<unknown>(
        message,
        initial === undefined ? (options[0] as Option<T>).value : initial
      );
      if (!isPick(answer)) return answer as T;
      const row = options.find(option => option.name === answer.pickName);
      if (row === undefined) {
        throw new Error(
          `no row named "${answer.pickName}" on "${message}" — rows: ${options.map(option => option.name).join(', ')}`
        );
      }
      return row.value;
    },
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
  { match: /^Which of these fits you\?/, answers: [KEEP_DEFAULT] },
  { match: /^Analysis chain/, answers: [KEEP_DEFAULT] },
  { match: /^Ranking adapter/, answers: [KEEP_DEFAULT] },
  { match: /^Serve pseudo-relevance feedback/, answers: [KEEP_DEFAULT] },
  { match: /^Set up the reranker\?/, answers: [false] },
  { match: /^Write it\?/, answers: ['write'] },
];

/** Replace one entry of the base script, keeping the ORDER the flow asks in. */
const scriptWith = (match: RegExp, answers: readonly unknown[]): readonly Reply[] =>
  baseScript().map(reply => (reply.match.source === match.source ? { match, answers } : reply));

/**
 * The base script with some entries replaced and any new question appended.
 * Lookup is by regex, so an override MUST displace the base entry rather than
 * sit behind it — the first match wins.
 */
const overriding = (overrides: readonly Reply[]): readonly Reply[] => [
  ...baseScript().filter(
    reply => !overrides.some(override => override.match.source === reply.match.source)
  ),
  ...overrides,
];

const wizard = async (
  replies: readonly Reply[] = baseScript(),
  positionals: readonly string[] = []
): Promise<{ readonly outcome: CommandOutcome; readonly prompter: Scripted }> => {
  const prompter = scriptedPrompter(replies);
  return { outcome: await runWizard(contextWith(positionals), prompter), prompter };
};

/** The transcript as one string with its wrapping collapsed, so a wrapped sentence still matches. */
const flatten = (lines: readonly string[]): string => lines.join(' ').replace(/\s+/g, ' ');

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

  // Given a corpus root holding two markdown files, When the wizard accepts it,
  // Then it says how many it found — bounded by the scan depth, so "at least".
  it('should report how much markdown an accepted corpus root holds', async () => {
    expect(flatten(prompter.transcript)).toContain(`at least 2 markdown files in ${happyCorpusDir}`);
  });

  // Given the Build section, When the summary is shown, Then the wizard has
  // already said what runs now and that enrichment is NOT part of setup —
  // `wizardCommand.ts:buildSteps` runs ingest and index and nothing else.
  it('should set the expectation that ingest and index run now and enrichment does not', async () => {
    const said = flatten(prompter.transcript);
    expect(said).toContain('ingest and index both run now');
    expect(said).toContain('Enrichment is NOT part of setup');
    expect(said).toContain('dp-gnosis enrich');
    expect(said).toContain('needs a chat model');
  });

  // Given every menu built from an advice table, When it is rendered, Then each
  // row leads with the clause naming WHO should pick it, above its pro and con.
  it('should lead every analysis-chain and adapter row with who should pick it', async () => {
    const menus = prompter.menus.filter(menu => /^(Analysis chain|Ranking adapter)$/.test(menu.message));
    expect(menus).toHaveLength(2);
    const rows = menus.flatMap(menu => menu.descriptions);
    expect(rows).toHaveLength(ANALYZER_CHOICES.length + ADAPTER_CHOICES.length);
    rows.forEach(description => {
      expect(description).toMatch(/^ {2}Pick this/);
      expect(description.indexOf('  + ')).toBeGreaterThan(description.indexOf('Pick this'));
    });
  });

  // Given the preset question, When section 4 runs, Then it is asked AFTER the
  // two answers that feed the chain and BEFORE the chain menu — a preset asked
  // any earlier could not pre-select a chain, and asked any later would
  // pre-select a menu already past.
  it('should ask the preset after the language answers and before the analysis chain', async () => {
    const at = (message: RegExp): number => prompter.asked.findIndex(question => message.test(question));

    expect(at(/^Which of these fits you\?/)).toBeGreaterThan(at(/^What language/));
    expect(at(/^Which of these fits you\?/)).toBeGreaterThan(at(/^Do they contain code identifiers/));
    expect(at(/^Which of these fits you\?/)).toBeLessThan(at(/^Analysis chain/));
  });

  // The comparison table is shown ABOVE the question, so the tradeoff is in
  // view when the choice is made rather than after it.
  it('should print the preset comparison table before asking which preset', async () => {
    const said = flatten(prompter.transcript);

    expect(said.indexOf('candidate pool')).toBeGreaterThan(-1);
    expect(said.indexOf('candidate pool')).toBeLessThan(said.indexOf('? Which of these fits you?'));
    PRESETS.forEach(preset => {
      expect(said).toContain(preset.id);
    });
  });

  it('should run ingest BEFORE index, which is one operation in two commands', async () => {
    const joined = prompter.transcript.join('\n');
    expect(joined.indexOf('splitting your documents into atoms')).toBeGreaterThan(-1);
    expect(joined.indexOf('building the search index')).toBeGreaterThan(
      joined.indexOf('splitting your documents into atoms')
    );
  });
});

describe('wizard — nothing is written until the summary is confirmed', () => {
  it('should write NOTHING when the summary is declined', async () => {
    const { outcome } = await wizard(scriptWith(/^Write it\?/, ['cancel']));

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

/**
 * A skipped section is a REPORT, not a failure. `ingest` exits 3 for both — a
 * mirrored appendix on any real corpus is enough — and a wizard that stopped
 * the chain there would leave the machine holding atoms and no index, which is
 * the silently-unserved vault this command exists to prevent. The fixture
 * writes two files sharing one body past the dedupe floor, so the run really
 * does write atoms AND refuse one.
 */
describe('wizard — a partial ingest is a report, not a stop', () => {
  const MIRRORED =
    'Gnosis chunks a document into heading-bounded atoms and ranks them with BM25 over a lexical index, which is the whole of what the engine does at query time, and this paragraph is long enough to clear the dedupe floor.';

  const reportPath = (): string => join(dataRoot(), 'ingest-report.txt');

  beforeEach(() => {
    writeFileSync(join(corpusDir, 'appendix-a.md'), `# Appendix A\n\n${MIRRORED}\n`, 'utf8');
    writeFileSync(join(corpusDir, 'appendix-b.md'), `# Appendix B\n\n${MIRRORED}\n`, 'utf8');
  });

  it('should run index after an ingest that exited 3 having left atoms behind', async () => {
    const { outcome, prompter } = await wizard();

    expect(prompter.transcript.join('\n')).toContain('building the search index');
    expect((outcome.data as Record<string, unknown>)['indexState']).toBe('ready');
    expect(outcome.exitCode).toBe(0);
  }, 120_000);

  it('should report the ingest summary line and a report path rather than every skipped section', async () => {
    const { outcome } = await wizard();

    expect(outcome.text).toContain('ingest: written');
    expect(outcome.text).toContain(`full report: ${reportPath()}`);
    expect(outcome.text).not.toContain('duplicate-body-of');
    expect(readFileSync(reportPath(), 'utf8')).toContain('duplicate-body-of');
  }, 120_000);
});

/**
 * The summary is the amend point. Nothing has been written when it is reached,
 * so it is the last moment at which a wrong answer — the reported failure was
 * pressing Enter through the hidden-types multi-select — costs one question to
 * correct instead of the whole interview.
 */
describe('wizard — the summary can amend one answer before writing', () => {
  const SUMMARY_HEADING = 'This is everything that will be written:';

  const amending = (row: string, extra: readonly Reply[]): readonly Reply[] =>
    overriding([
      { match: /^Write it\?/, answers: ['amend', 'write'] },
      { match: /^Which answer should be changed\?/, answers: [byName(row)] },
      ...extra,
    ]);

  const countAsked = (prompter: Scripted, message: RegExp): number =>
    prompter.asked.filter(question => message.test(question)).length;

  // Given a user who accepted the hidden types and then chose to change them,
  // When the amend re-asks that one question, Then the SECOND answer is what is
  // written and no other section of the interview is asked again.
  it('should re-ask only the types questions and write the second answer', async () => {
    const script = amending('Atom types', [
      { match: /^Types to hide/, answers: [KEEP_DEFAULT, ['review']] },
    ]);

    const { outcome, prompter } = await wizard(script);

    expect(outcome.exitCode).toBe(0);
    expect(readProfile()['defaultExcludedTypes']).toEqual(['review']);
    expect(countAsked(prompter, /^Types to hide/)).toBe(2);
    expect(countAsked(prompter, /^Default atom type/)).toBe(2);
    expect(countAsked(prompter, /^Corpus directory/)).toBe(1);
    expect(countAsked(prompter, /^What language/)).toBe(1);
    expect(countAsked(prompter, /^Paths to skip/)).toBe(1);
  }, 120_000);

  // The amended plan is REBUILT and shown again, so the answer that was changed
  // is read in its written form before it is committed.
  it('should render the summary again after an amendment', async () => {
    const script = overriding([
      { match: /^Write it\?/, answers: ['amend', 'cancel'] },
      { match: /^Which answer should be changed\?/, answers: [byName('Atom types')] },
    ]);

    const { outcome, prompter } = await wizard(script);

    expect(prompter.transcript.filter(line => line === SUMMARY_HEADING)).toHaveLength(2);
    expect(countAsked(prompter, /^Write it\?/)).toBe(2);
    expect(outcome.exitCode).toBe(3);
    expect(existsSync(profilePath())).toBe(false);
  });

  // Given no reranker was configured, When the amend menu is built, Then the
  // pool row is absent — there is no pool to deepen — while the two answers
  // that are never amendable say why in the reader's own view.
  it('should omit the reranker pool row when no reranker was configured', async () => {
    const script = overriding([
      { match: /^Write it\?/, answers: ['amend', 'cancel'] },
      { match: /^Which answer should be changed\?/, answers: [byName('Paths to skip')] },
    ]);

    const { prompter } = await wizard(script);
    const menu = prompter.menus.find(entry => entry.message === 'Which answer should be changed?');

    expect(menu?.names).toEqual([
      'Corpus directories and their labels',
      'Paths to skip',
      'Atom types',
      'How text is matched',
    ]);
    const said = flatten(prompter.transcript);
    expect(said).toContain('The data root is not on this list because its value gates the two checks');
    expect(said).toContain('The reranker setup is not on this list because it downloads files and starts servers');
  });

  // The three-way replaced a yes/no, and BOTH of the old answers have to keep
  // meaning what they did: `Cancel` writes nothing at all.
  it('should write nothing when Cancel is chosen at the summary', async () => {
    const { outcome, prompter } = await wizard(scriptWith(/^Write it\?/, ['cancel']));
    const menu = prompter.menus.find(entry => entry.message === 'Write it?');

    expect(menu?.names).toEqual(['Write it', 'Change an answer', 'Cancel']);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.text).toContain('no profile and no config were written');
    expect(existsSync(profilePath())).toBe(false);
    expect(atomFiles()).toEqual([]);
  });
});

/**
 * A reranker that is ALREADY running and passes the probe is a question, not an
 * adoption. The wizard cannot know whose server that is — one this project
 * started, one the user runs for something else, or one they would rather gnosis
 * did not depend on — so it asks, and the answer decides which backend is written.
 *
 * Both llama-swap endpoints and the Hugging Face listing are answered in-process
 * by a stubbed `fetch`: this describe is about the DECISION, and a test that
 * needed a live server or a multi-gigabyte download would measure neither.
 */
describe('askRerank — a passing served model is offered, never adopted', () => {
  const FOUND_URL = 'http://127.0.0.1:9999';
  const FOUND_MODEL = 'qwen3-reranker-4b';
  const USE_IT = `Use ${FOUND_MODEL}, already running at ${FOUND_URL}`;
  const EMBEDDED = 'Set up an embedded reranker instead — gnosis loads a model in this process';

  const FACTS: HardwareFacts = {
    totalRamBytes: 32 * 1024 ** 3,
    freeDiskBytes: 200 * 1024 ** 3,
    vramBytes: 8 * 1024 ** 3,
    gpuName: 'Test GPU',
  };

  const PLACES: ServeLocations = { modelsDir: '/tmp/dp-gnosis-wizard-never/models', logPath: '/tmp/dp-gnosis-wizard-never/log' };

  const PREFERENCE: RerankPreference = { hungarian: false, rerank: true, poolK: 100 };

  const okResponse = (payload: unknown): unknown => ({
    ok: true,
    status: 200,
    text: async (): Promise<string> => JSON.stringify(payload),
  });

  /** The discriminating answer to the two-document probe: the relevant document wins. */
  const HEALTHY_PROBE = [
    { index: 0, relevance_score: 2.07 },
    { index: 1, relevance_score: -11 },
  ];

  /**
   * Answers `/v1/models` and `/v1/rerank` as a healthy reranker, and REFUSES the
   * Hugging Face tree listing — so the embedded route reaches its questions and
   * then fails, which is the branch the last two tests are about.
   */
  const stubServer = (): void => {
    vi.stubGlobal('fetch', async (url: string): Promise<unknown> => {
      const target = String(url);
      if (target.endsWith('/v1/models')) return okResponse({ data: [{ id: FOUND_MODEL }] });
      if (target.includes('/rerank')) return okResponse({ results: HEALTHY_PROBE });
      return { ok: false, status: 503, text: async (): Promise<string> => '', json: async (): Promise<unknown> => ({}) };
    });
  };

  const flow = async (replies: readonly Reply[]): Promise<{ readonly result: RerankResult; readonly prompter: Scripted }> => {
    const prompter = scriptedPrompter(replies);
    return { result: await askRerank(prompter, PREFERENCE, FACTS, PLACES), prompter };
  };

  const script = (adopt: unknown, extra: readonly Reply[] = []): readonly Reply[] => [
    { match: /^Set up the reranker\?/, answers: [true] },
    { match: /^A working reranker is already running/, answers: [adopt] },
    { match: /^How many candidates/, answers: [KEEP_DEFAULT] },
    ...extra,
  ];

  beforeEach(() => {
    engineState.available = true;
    resetRerankProbeCache();
    vi.stubEnv('DP_GNOSIS_RERANK_URL', FOUND_URL);
    stubServer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetRerankProbeCache();
  });

  // Given a server whose model PASSES, When the engine is available, Then the
  // wizard opens a two-row menu instead of writing the endpoint it found.
  it('should ask which reranker to use rather than adopting the one that passed', async () => {
    const { prompter } = await flow(script(byName(USE_IT)));

    const menu = prompter.menus.find(entry => /already running/.test(entry.message));
    expect(menu?.names).toEqual([USE_IT, EMBEDDED]);
    expect(menu?.descriptions[1]).toContain('uncalibrated');
    expect(menu?.descriptions[1]).toContain('UNMEASURED');
  });

  it('should write the found url and model under the http backend when the running server is chosen', async () => {
    const { result } = await flow(script(byName(USE_IT)));

    expect(result.rerank).toEqual({ backend: 'http', url: FOUND_URL, model: FOUND_MODEL, poolK: 100 });
    expect(result.catalogue).toEqual([FOUND_MODEL]);
  });

  // The run mode is ALREADY answered by choosing the embedded row, so asking it
  // again would spend a question on a decision the user has just made.
  it('should reach the model and quantisation questions without re-asking how the model should be run', async () => {
    const { prompter } = await flow(
      script(byName(EMBEDDED), [{ match: /^Which reranker\?/, answers: [KEEP_DEFAULT] }, { match: /^Which quantisation\?/, answers: [KEEP_DEFAULT] }, { match: /instead\?/, answers: [false] }])
    );

    expect(prompter.asked).toContain('Which reranker?');
    expect(prompter.asked).toContain('Which quantisation?');
    expect(prompter.asked.some(question => /How should the model be run\?/.test(question))).toBe(false);
  });

  // A working reranker was in hand, so a failed embedded setup MUST NOT drop to
  // no reranker at all — that is a downgrade nobody chose.
  it('should offer the running server when the embedded setup does not complete', async () => {
    const { result, prompter } = await flow(
      script(byName(EMBEDDED), [{ match: /^Which reranker\?/, answers: [KEEP_DEFAULT] }, { match: /^Which quantisation\?/, answers: [KEEP_DEFAULT] }, { match: /instead\?/, answers: [true] }])
    );

    expect(prompter.asked).toContain(`Use ${FOUND_MODEL} at ${FOUND_URL} instead?`);
    expect(result.rerank).toEqual({ backend: 'http', url: FOUND_URL, model: FOUND_MODEL, poolK: 100 });
  });

  it('should leave no reranker configured when the embedded setup fails and the server is declined', async () => {
    const { result } = await flow(
      script(byName(EMBEDDED), [{ match: /^Which reranker\?/, answers: [KEEP_DEFAULT] }, { match: /^Which quantisation\?/, answers: [KEEP_DEFAULT] }, { match: /instead\?/, answers: [false] }])
    );

    expect(result.rerank).toBeUndefined();
    expect(result.catalogue).toEqual([FOUND_MODEL]);
  });

  // With no in-process engine there is no second row to offer, so the wizard
  // names the install command and asks a single confirmation instead.
  it('should name the install command and confirm rather than offer a menu when the engine is absent', async () => {
    engineState.available = false;

    const { result, prompter } = await flow([
      { match: /^Set up the reranker\?/, answers: [true] },
      { match: /^Use qwen3-reranker-4b at http/, answers: [true] },
      { match: /^How many candidates/, answers: [KEEP_DEFAULT] },
    ]);

    expect(prompter.menus.some(entry => /already running/.test(entry.message))).toBe(false);
    expect(flatten(prompter.transcript)).toContain(LOCAL_RERANKER_INSTALL_COMMAND);
    expect(result.rerank).toEqual({ backend: 'http', url: FOUND_URL, model: FOUND_MODEL, poolK: 100 });
  });

  it('should configure no reranker when the found server is declined and no engine can replace it', async () => {
    engineState.available = false;

    const { result } = await flow([
      { match: /^Set up the reranker\?/, answers: [true] },
      { match: /^Use qwen3-reranker-4b at http/, answers: [false] },
    ]);

    expect(result.rerank).toBeUndefined();
  });
});
