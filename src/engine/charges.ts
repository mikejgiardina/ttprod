/**
 * Charge engine (buildable task #8) — the module the whole "everything that touches
 * money is deterministic code" thesis rests on.
 *
 *  - A charge fires only when its documentation atoms are satisfied (gating via the ledger).
 *  - TRM-ACT is split: OBL-TRM-ACT-068X (rev 0681, facility, ~$2,450) bills; OBL-TRM-ACT-G0390
 *    (professional) carries the charge-to-charge dependency G0390 → 99291 billable.
 *  - The CC-clock <30 min declines 99291 (~$325), which cascades to decline G0390.
 *  - The activation fee is PRESENTED as a determination (ADR-0014), never auto-emitted.
 *
 * Decision #7 (unreconciled in source) is config-driven via `g0390Mode` so page 2 stays
 * internally consistent whichever way it's ruled.
 */

import type {
  ActivationDetermination,
  ChargeItem,
  ChargeRuntime,
  ChargeStatus,
  EngineConfig,
  Gap,
  ObligationRuntime,
  WalkerResult,
} from '../types.ts';

const G0390_CITATION =
  'CMS OCE / MLN MM5438: G0390 must appear with rev code 68x on the same DOS as CPT 99291; ' +
  'facilities providing <30 min critical care may report 68x but MAY NOT report G0390.';
const CC_CITATION = 'CPT 99291 requires ≥30 min documented critical care.';

function stateToStatus(rt: ObligationRuntime): ChargeStatus {
  switch (rt.state) {
    case 'satisfied':
      return 'billed';
    case 'unresolved':
      return rt.suppressReason === 'human_deferred' ? 'unresolved' : 'declined';
    case 'not_applicable':
      return 'not_applicable';
    case 'missing':
    case 'ambiguous':
      return 'held';
    default:
      return 'dormant';
  }
}

export interface ChargesResult {
  charges: ChargeRuntime[];
  estimatedTotal: number;
  activation: ActivationDetermination;
  gaps: Gap[];
}

export function computeCharges(
  chargeItems: ChargeItem[],
  obligations: ObligationRuntime[],
  walker: WalkerResult,
  config: EngineConfig,
): ChargesResult {
  const byCode = new Map(chargeItems.map((c) => [c.code, c]));
  const oblById = new Map(obligations.map((o) => [o.id, o]));
  const charges: ChargeRuntime[] = [];

  for (const rt of obligations) {
    if (rt.subject.kind !== 'charge') continue;
    if (rt.state === 'dormant') continue;

    const code = String(rt.subject.ref ?? '');
    const base = byCode.get(code);
    let price = base?.price ?? 0;
    let name = base?.name ?? rt.label;
    let status = stateToStatus(rt);
    let reason: string | undefined;
    let citation: string | undefined;
    const cpt = rt.cptSelected ?? base?.cpt ?? null;

    // TRM-ACT split
    if (rt.id === 'OBL-TRM-ACT-068X') {
      name = 'Trauma team activation — rev 0681 (facility)';
      // rev 0681 bills when criteria+documented+team+prehospital are met
    } else if (rt.id === 'OBL-TRM-ACT-G0390') {
      name = 'Trauma activation w/ critical care — G0390 (professional)';
      price = 0;
      if (config.g0390Mode === 'decline_with_citation') {
        status = 'declined';
        reason = 'Requires 99291 (≥30 min critical care), which was not billable.';
        citation = G0390_CITATION;
      } else {
        status = 'unresolved';
        reason = 'Activation presented as one unattributed determination (ADR-0014); G0390 neither emitted nor declined.';
      }
    } else if (rt.id === 'OBL-CC-TIME-30MIN' && (status === 'declined' || status === 'unresolved')) {
      reason = 'Critical care <30 min documented in-bay; time likely continued in the OR — reconcile.';
      citation = CC_CITATION;
      status = 'declined';
    }

    if ((status === 'declined' || status === 'unresolved') && rt.terminal?.gap_text) {
      reason = reason ?? rt.terminal.gap_text;
    }

    charges.push({ code, name, cpt, price, status, obligationId: rt.id, reason, citation });
  }

  const estimatedTotal = charges
    .filter((c) => c.status === 'billed')
    .reduce((sum, c) => sum + c.price, 0);

  // ── activation determination (present, don't emit) ──
  const trm = oblById.get('OBL-TRM-ACT-068X');
  const atomSat = (id: string): boolean => !!trm?.atoms.find((a) => a.id === id)?.satisfied;
  const activationDocumented = atomSat('documented');
  const teamResponded = atomSat('team_responded');
  const prehospitalNotification = atomSat('prehospital_notification');
  const qualifies = trm?.state === 'satisfied';

  const openConditions: string[] = [];
  if (!walker.anyCriterionSatisfied) openConditions.push('No activation criterion satisfied yet');
  if (!activationDocumented) openConditions.push('Activation not documented');
  if (!teamResponded) openConditions.push('Team response not captured');
  if (!prehospitalNotification) openConditions.push('Prehospital notification / inter-hospital transfer not captured');

  const g0390 = oblById.get('OBL-TRM-ACT-G0390');
  const feeDisposition =
    (qualifies ? 'rev 0681 reports (activation qualifies). ' : 'Activation determination pending. ') +
    (config.g0390Mode === 'decline_with_citation'
      ? 'G0390 not billed — critical care <30 min (99291).'
      : 'G0390 unattributed pending reconciliation (ADR-0014).') +
    (g0390 ? '' : '');

  const activation: ActivationDetermination = {
    qualifies,
    criteriaMet: walker.criteriaMet.map((c) => ({ category: c.category, criterion: c.criterion, evidence: c.evidence })),
    activationDocumented,
    teamResponded,
    prehospitalNotification,
    openConditions,
    feeDisposition,
  };

  // ── gaps: unresolved terminal obligations render as page-2 gaps ──
  const gaps: Gap[] = obligations
    .filter((o) => o.state === 'unresolved')
    .map((o) => ({
      obligationId: o.id,
      label: o.label,
      text: o.terminal?.gap_text ?? `${o.label}: open and unresolved at disposition.`,
      dollarImpact: o.dollarImpact,
    }));

  return { charges, estimatedTotal, activation, gaps };
}
