/**
 * Score table-tests (buildable task #3). Run: `npm run test:scores`
 * (node --experimental-strip-types). Expected values are the four known rows from
 * fixtures/expected_extraction.json.
 */

import { shockIndex, rts, gcsFromComponents, gcsCoding, sbpCoding, rrCoding } from '../src/engine/scores.ts';

let failures = 0;
function eq(name: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 1e-9;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}: got ${got}, want ${want}`);
}

// Shock Index = HR / SBP
eq('shockIndex(128, 88)', shockIndex(128, 88), 1.45);
eq('shockIndex(132, 84)', shockIndex(132, 84), 1.57);

// RTS = 0.9368*GCS_c + 0.7326*SBP_c + 0.2908*RR_c
eq('rts(13, 88, 24)', rts(13, 88, 24), 7.11);
eq('rts(9, 84, 24)', rts(9, 84, 24), 6.17);

// component coding boundaries
eq('gcsCoding(13)', gcsCoding(13), 4);
eq('gcsCoding(9)', gcsCoding(9), 3);
eq('sbpCoding(88)', sbpCoding(88), 3); // 88 is 76-89, NOT >89
eq('sbpCoding(90)', sbpCoding(90), 4);
eq('rrCoding(24)', rrCoding(24), 4);
eq('rrCoding(30)', rrCoding(30), 3);
eq('gcsFromComponents(4,5,6)', gcsFromComponents(4, 5, 6), 15);

if (failures) {
  console.error(`\n${failures} score test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll score tests passed.');
