/**
 * Reference-data integrity lint. Run: `npm run lint:reference`.
 *
 * The JSON is the rulebook; this checks the rulebook is internally wired:
 *  - every charge-kind obligation points at a real charge code
 *  - every satisfies_measure points at a real measure
 *  - every lattice cross-ref / delegate resolves
 *  - the collision corpus is valid JSONL
 * It does NOT judge clinical values or CPTs — those carry NEEDS-CLINICIAN / NEEDS-CODER
 * markers on purpose and are unsigned.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(root, 'src/data', p), 'utf8'));

const obligations = read('obligations.json').obligations;
const charges = read('charges.json').charge_items;
const measures = read('accreditation_measures.json').measures;
const lattice = read('activation_lattice.json');

const chargeCodes = new Set(charges.map((c) => c.code));
const measureIds = new Set(measures.map((m) => m.id));
const nodeIds = new Set(lattice.families.flatMap((f) => f.nodes.map((n) => n.id)));

const errors = [];
const warn = [];

for (const o of obligations) {
  if (o.subject?.kind === 'charge' && o.subject.ref && !chargeCodes.has(o.subject.ref)) {
    errors.push(`obligation ${o.id}: charge ref "${o.subject.ref}" not in charges.json`);
  }
  if (o.satisfies_measure && !measureIds.has(o.satisfies_measure)) {
    errors.push(`obligation ${o.id}: satisfies_measure "${o.satisfies_measure}" not in measures`);
  }
}

for (const f of lattice.families) {
  for (const n of f.nodes) {
    if (n.delegates_to) {
      const [, nid] = n.delegates_to.split('.');
      if (!nodeIds.has(nid)) errors.push(`lattice ${n.id}: delegates_to "${n.delegates_to}" unresolved`);
    }
    for (const dep of n.depends_on ?? []) {
      if (!nodeIds.has(dep)) errors.push(`lattice ${n.id}: depends_on "${dep}" unresolved`);
    }
  }
}

// collision corpus is valid JSONL
try {
  const jsonl = readFileSync(join(root, 'src/data/collision_corpus.jsonl'), 'utf8');
  jsonl.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { JSON.parse(line); } catch { errors.push(`collision_corpus.jsonl line ${i + 1}: invalid JSON`); }
  });
} catch (e) {
  warn.push(`collision_corpus.jsonl: ${e.message}`);
}

for (const w of warn) console.warn(`  warn ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`  FAIL ${e}`);
  console.error(`\n${errors.length} reference integrity error(s).`);
  process.exit(1);
}
console.log(`Reference OK — ${obligations.length} obligations, ${chargeCodes.size} charges, ${measureIds.size} measures, ${nodeIds.size} lattice nodes wired.`);
