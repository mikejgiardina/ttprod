/**
 * Accreditation / core-measure clocks (case-triggered only for the demo).
 * Extract-and-compare: a measure is met when its confirming event is captured within the
 * target window; open/missed otherwise. Non-case measures (STEMI/SEP-1/stroke) are N/A here.
 */

import type { MeasureResult, ObligationState, WalkerResult } from '../types.ts';
import type { Corpus } from './matcher.ts';
import { firstMatch } from './matcher.ts';
import type { ClocksState } from './clocks.ts';

const SURGEON_PHRASES = [
  'surgeon at bedside', 'surgery to bedside', 'trauma surgeon is here', 'surgeon is here',
  'surgery is at bedside', 'theyre coming down', 'surgery at bedside',
];

interface MeasureDef {
  id: string;
  name: string;
  target_min?: number;
  case_triggered?: boolean;
  type: string;
}

export function computeMeasures(
  measureDefs: MeasureDef[],
  states: Record<string, ObligationState>,
  walker: WalkerResult,
  corpus: Corpus,
  clocks: ClocksState,
): MeasureResult[] {
  const out: MeasureResult[] = [];
  const push = (id: string, name: string, status: MeasureResult['status'], targetMin?: number, elapsedMin?: number, detail?: string) =>
    out.push({ id, name, status, targetMin, elapsedMin, detail });

  for (const m of measureDefs) {
    if (m.type === 'qualification_ruleset') {
      push(m.id, m.name, walker.anyCriterionSatisfied ? 'met' : 'open', undefined, undefined,
        walker.anyCriterionSatisfied ? `${walker.criteriaMet.length} criterion(s) met` : 'no criterion met yet');
      continue;
    }
    if (!m.case_triggered) continue;

    if (m.id === 'AIRWAY_SECURED_CONFIRMED') {
      push(m.id, m.name, states['OBL-AWY-ETI-CONFIRM'] === 'satisfied' ? 'met' : 'open');
    } else if (m.id === 'EFAST_PRIMARY_SURVEY') {
      const st = states['OBL-PRC-FAST-DOC'];
      const target = m.target_min ?? 10;
      const overdue = clocks.efastDeadlineElapsed && st !== 'satisfied';
      push(m.id, m.name, st === 'satisfied' ? 'met' : overdue ? 'missed' : 'open', target);
    } else if (m.id === 'TRAUMA_SURGEON_BEDSIDE') {
      const hit = firstMatch(corpus, SURGEON_PHRASES);
      const target = m.target_min ?? 15;
      const elapsed = hit ? Math.round((hit.atSec / 60) * 100) / 100 : undefined;
      push(m.id, m.name, hit ? (elapsed! <= target ? 'met' : 'missed') : 'open', target, elapsed);
    } else if (m.id === 'CRITICAL_CARE_TIME') {
      const acc = clocks.criticalCare.accruedMin;
      push(m.id, m.name, acc >= 30 ? 'met' : 'open', 30, acc, `${acc} min documented in-bay`);
    } else {
      push(m.id, m.name, 'open', m.target_min);
    }
  }
  return out;
}
