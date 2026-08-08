import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Atom } from '../src/atom.js';
import { ATOM_MAX_CHARS } from '../src/config.js';
import { readExistingIds, validateAtom } from '../src/validate.js';

const atomWith = (overrides: Partial<Atom['frontmatter']>, body: string): Atom => ({
  frontmatter: {
    type: 'knowledge_atom',
    id: 'runner-gate-contract',
    title: 'Gate contract',
    x_domain: 'runner',
    status: 'stable',
    sources: ['RUNNER-CHANGE.md'],
    ...overrides,
  },
  body,
});

const valid = atomWith({}, 'body text\n');
const none: ReadonlySet<string> = new Set<string>();

describe('validateAtom', () => {
  it('accepts a valid atom with zero errors', () => {
    expect(validateAtom(valid, none)).toEqual([]);
  });

  it('refuses an id that already exists in the tree', () => {
    const errors = validateAtom(valid, new Set(['runner-gate-contract']));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('runner-gate-contract');
    expect(errors[0]).toMatch(/choose a different/i);
  });

  it('refuses a body over the size cap', () => {
    const errors = validateAtom(atomWith({}, 'x'.repeat(ATOM_MAX_CHARS + 1)), none);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(String(ATOM_MAX_CHARS));
    expect(errors[0]).toMatch(/split/i);
  });

  it('accepts a body exactly at the cap', () => {
    expect(validateAtom(atomWith({}, 'x'.repeat(ATOM_MAX_CHARS)), none)).toEqual([]);
  });

  it('refuses a domain outside the closed vocabulary', () => {
    const errors = validateAtom(atomWith({ x_domain: 'runners' }, 'b'), none);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('x_domain');
    expect(errors[0]).toContain('runner | standards | adr');
  });

  it('refuses an id that is not a filesystem-safe slug', () => {
    const bad = ['runner/gate', '../escape', 'runner gate', 'Runner-Gate', '-lead', 'trail-', 'a--b'];
    const refused = bad.filter(id => validateAtom(atomWith({ id }, 'b'), none).length === 1);
    expect(refused).toEqual(bad);
  });

  it('names the correction in every slug refusal', () => {
    const errors = validateAtom(atomWith({ id: '../escape' }, 'b'), none);
    expect(errors[0]).toMatch(/lowercase/i);
    expect(errors[0]).toContain('id');
  });

  it('reports every independent violation at once', () => {
    const broken = atomWith({ id: 'BAD ID', x_domain: 'nope' }, 'x'.repeat(ATOM_MAX_CHARS + 1));
    expect(validateAtom(broken, none)).toHaveLength(3);
  });
});

describe('readExistingIds', () => {
  it('derives ids from the atom filenames, ignoring non-markdown files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gnosis-validate-'));
    await writeFile(join(dir, 'runner-gate-contract.md'), '');
    await writeFile(join(dir, 'notes.txt'), '');
    expect([...(await readExistingIds(dir))]).toEqual(['runner-gate-contract']);
  });

  it('treats a missing atoms directory as an empty tree', async () => {
    expect((await readExistingIds(join(tmpdir(), 'gnosis-absent-dir'))).size).toBe(0);
  });
});
