/**
 * Clocks (buildable task #7).
 *
 * HARD INVARIANT: clocks NEVER reach the renderer. They only mutate material() — a deadline
 * or staleness makes an already-open obligation MATERIAL; it does not create a prompt.
 * (Enforced by test in tools/lint_reference.mjs conceptually + kept out of ledger render.)
 *
 *  - critical-care DURATION clock: start_on / stop_on / pause_during (ACEP: the CC clock
 *    pauses during separately-reportable procedures). Accrues ~8 min in-bay on the demo case,
 *    well under the 30-min gate → 99291 not billable → G0390 not billable.
 *  - EFAST 10-min deadline: flips OBL-EFAST-DEADLINE material at T+10:00 (held silent before).
 */

import type { ClockSpec } from '../types.ts';
import type { Corpus } from './matcher.ts';
import { firstMatch } from './matcher.ts';

const ACTIVATION_PHRASES = ['trauma activation', 'trauma team activation', 'level one', 'level 1 activation'];
const CC_STOP_FALLBACK = ['disposition', 'patient departing', 'to the or', 'off to the or', 'patient leaving', 'leaving the bay'];

export interface CriticalCareClock {
  started: boolean;
  startSec: number | null;
  stopped: boolean;
  stopSec: number | null;
  accruedMin: number;
  pausedProcedures: string[];
}

export interface ClocksState {
  activationSec: number | null;
  criticalCare: CriticalCareClock;
  efastDeadlineElapsed: boolean;
}

export function computeClocks(corpus: Corpus, nowSec: number, ccClock?: ClockSpec): ClocksState {
  const activationSec = firstMatch(corpus, ACTIVATION_PHRASES)?.atSec ?? null;

  const startPhrases = ccClock?.start_on ?? ['critical care time', 'starting critical care', 'critical care'];
  const stopPhrases = ccClock?.stop_on ?? CC_STOP_FALLBACK;
  const startHit = firstMatch(corpus, startPhrases);
  const stopHit = firstMatch(corpus, [...stopPhrases, ...CC_STOP_FALLBACK]);

  const startSec = startHit?.atSec ?? null;
  const stopSec = stopHit && startSec != null && stopHit.atSec > startSec ? stopHit.atSec : null;

  // separately-reportable procedures that PAUSE the clock (informational; they keep
  // accrued time honestly under wall-clock).
  const pausedProcedures: string[] = [];
  if (corpus.lines.some((l) => l.norm.includes('chest tube'))) pausedProcedures.push('chest tube');
  if (corpus.lines.some((l) => l.norm.includes('central line') || l.norm.includes('cordis'))) pausedProcedures.push('central line');
  if (corpus.lines.some((l) => l.norm.includes('fast'))) pausedProcedures.push('FAST');

  const endSec = stopSec ?? nowSec;
  const accruedMin = startSec != null ? Math.max(0, (endSec - startSec) / 60) : 0;

  return {
    activationSec,
    criticalCare: {
      started: startSec != null,
      startSec,
      stopped: stopSec != null,
      stopSec,
      accruedMin: Math.round(accruedMin * 10) / 10,
      pausedProcedures,
    },
    efastDeadlineElapsed: activationSec != null && nowSec - activationSec >= 600,
  };
}
