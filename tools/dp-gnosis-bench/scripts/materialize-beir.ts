/**
 * Materialize a BEIR dataset into one markdown file per document, so an
 * external markdown-only engine (qmd) can index the SAME corpus we score.
 *
 * It calls this suite's own `materializeCorpus`, so the docid ↔ filename map is
 * bit-identical to what the scorer expects (`basename(f, '.md') === docId`) —
 * derived, never re-implemented. A non-filename-safe id is REFUSED rather than
 * mangled, because a mangled id scores as a miss and looks like a quality loss.
 *
 * Exits 3 when the file count differs from the document count: a corpus the
 * external system cannot see in full is not a comparable arm, and finding that
 * out after a multi-hour run costs the arm.
 *
 * usage: tsx scripts/materialize-beir.ts <beir-dir> <target-dir>
 * exit 0 materialized · 2 bad input · 3 doc/file count mismatch
 */
import { readCorpus } from '../src/beir.ts';
import { materializeCorpus } from '../src/corpus.ts';

const [beirDir, targetDir] = process.argv.slice(2);
if (beirDir === undefined || targetDir === undefined) {
  process.stderr.write('usage: tsx scripts/materialize-beir.ts <beir-dir> <target-dir>\n');
  process.exit(2);
}
const out = materializeCorpus(readCorpus(beirDir), targetDir);
process.stdout.write(`${beirDir} -> ${targetDir}: docs=${out.docCount} files=${out.presentFileCount}\n`);
if (out.docCount !== out.presentFileCount) {
  process.stderr.write('MISMATCH: file count != document count — the arm would score a partial corpus\n');
  process.exit(3);
}
