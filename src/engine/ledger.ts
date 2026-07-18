/**
 * Obligations ledger (buildable task #5) — the deterministic heart.
 *
 * 6 states (dormant/satisfied/missing/ambiguous/not_applicable/unresolved), two-armed
 * materiality (qualification OR documentation; NO safety arm), and the render predicate:
 *
 *   render(o) ⇔ o.state ∈ {missing, ambiguous} ∧ material(o) ∧ ¬suppressed(o)
 *
 * Recompute from the FULL evidence set every call, BEFORE any renderer runs — so a prompt
 * is a pure render of state and retracts itself the instant the room answers. Clocks only
 * flip material(); they never create a prompt. `satisfied` is not a one-way latch.
 *
 * NEEDS-CODER / NEEDS-CLINICIAN predicate atoms evaluate to 'unknown' and are treated as
 * non-gating-but-flagged here (never as reviewed truth).
 */

import type {
  Atom,
  EngineConfig,
  ObligationCatalog,
  ObligationDef,
  ObligationRuntime,
  ObligationState,
  Requires,
} from '../types.ts';
import type { Corpus } from './matcher.ts';
import { anyPresent, deferralSpokenFor, firstMatch } from './matcher.ts';
import { evalPredicate, type EvalContext } from './predicates.ts';
import type { ClocksState } from './clocks.ts';

const FACILITY_DESIGNATIONS = ['state_designated', 'locally_designated', 'ACS_verified'];

interface AtomEval {
  id: string;
  satisfied: boolean;
  flagged: boolean;
}

function evalAtom(atom: Atom, ctx: EvalContext, corpus: Corpus): AtomEval {
  const affirmHit = anyPresent(corpus, atom.affirm);
  const predRes = atom.predicate ? evalPredicate(atom.predicate, ctx) : undefined;
  const satisfied = affirmHit || predRes === true || predRes === 'unknown';
  return { id: atom.id, satisfied, flagged: predRes === 'unknown' };
}

function evalRequires(
  requires: Requires,
  ctx: EvalContext,
  corpus: Corpus,
): { atoms: AtomEval[]; state: ObligationState } {
  const list = requires.all_of ?? requires.any_of ?? [];
  const atoms = list.map((a) => evalAtom(a, ctx, corpus));
  if (!atoms.length) return { atoms, state: 'satisfied' };
  const nSat = atoms.filter((a) => a.satisfied).length;
  const min = requires.all_of ? list.length : (requires.min_satisfied ?? 1);
  let state: ObligationState;
  if (nSat >= min) state = 'satisfied';
  else if (nSat > 0) state = 'ambiguous';
  else state = 'missing';
  return { atoms, state };
}

function pickCpt(def: ObligationDef, ctx: EvalContext): string | null {
  if (!def.code_map) return (def.subject.cpt as string) ?? null;
  // SPLINT: site selects the code
  if (def.id === 'OBL-SPLINT-SITE') {
    const site = ctx.values.splint_site;
    if (!site) return null;
    for (const row of def.code_map) {
      const m = /site in \[([^\]]+)\]/.exec(row.when);
      if (!m) continue;
      const sites = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
      if (sites.includes(site)) return row.cpt;
    }
    return null;
  }
  // EKG: global tracing+interpretation → 93000
  if (def.id === 'OBL-IMG-EKG-INTERP') return '93000';
  // WOUND-CX: needs tier + length (both unknown in the demo) → cannot select
  return null;
}

export interface LedgerResult {
  runtimes: ObligationRuntime[];
  states: Record<string, ObligationState>;
}

export function computeObligations(
  catalog: ObligationCatalog,
  corpus: Corpus,
  ctx: EvalContext,
  clocks: ClocksState,
  config: EngineConfig,
  nowSec: number,
): LedgerResult {
  const runtimes: ObligationRuntime[] = [];
  const states: Record<string, ObligationState> = {};

  for (const def of catalog.obligations) {
    // ── trigger ──
    let triggered = false;
    let triggeredAtSec: number | null = null;
    if (def.trigger.any_of) {
      const hit = firstMatch(corpus, def.trigger.any_of, def.trigger_guard);
      triggered = !!hit;
      triggeredAtSec = hit?.atSec ?? null;
    } else if (def.trigger.predicate) {
      triggered = evalPredicate(def.trigger.predicate, ctx) === true;
      triggeredAtSec = triggered ? 0 : null;
    } else if (def.trigger.ref) {
      const want = def.trigger.when ?? 'satisfied';
      triggered = ctx.obligationStates[def.trigger.ref] === want;
      triggeredAtSec = triggered ? 0 : null;
    }

    if (!triggered) {
      const rt: ObligationRuntime = {
        id: def.id,
        label: def.label,
        subject: def.subject,
        state: 'dormant',
        triggered: false,
        triggeredAtSec: null,
        atoms: [],
        materialArms: [],
        material: false,
        suppressed: false,
        render: false,
        cptSelected: pickCpt(def, ctx),
        dollarImpact: def.terminal?.dollar_impact,
        terminal: def.terminal,
      };
      runtimes.push(rt);
      states[def.id] = 'dormant';
      continue;
    }

    // ── requires ──
    const { atoms, state: reqState } = evalRequires(def.requires, ctx, corpus);
    let state: ObligationState = reqState;

    // facility precondition (TRM-ACT rev 068x): a designated-center config constant
    if (def.facility_precondition && !FACILITY_DESIGNATIONS.includes(config.facilityTraumaDesignation)) {
      state = 'not_applicable';
    }

    // ── materiality (two arms; clocks gate the deadline obligation) ──
    const arms = [...def.material_for];
    if (def.id === 'OBL-EFAST-DEADLINE' && !clocks.efastDeadlineElapsed) arms.length = 0;
    const material = arms.length > 0 && (state === 'missing' || state === 'ambiguous');

    // ── suppression ──
    let suppressed = false;
    let suppressReason: string | undefined;
    const humanDeferred = deferralSpokenFor(corpus, def.trigger.any_of);
    if (humanDeferred) {
      suppressed = true;
      suppressReason = 'human_deferred';
    } else if (triggeredAtSec != null && nowSec - triggeredAtSec < config.settleMs / 1000) {
      suppressed = true;
      suppressReason = 'settling';
    }

    // disposition sweep: open + material at disposition → unresolved (terminal)
    if (nowSec >= config.dispositionSec && (state === 'missing' || state === 'ambiguous') && arms.length > 0) {
      state = def.terminal?.if_open ?? 'unresolved';
    }

    const render = (state === 'missing' || state === 'ambiguous') && material && !suppressed;

    // ── prompt text (AWY partials narrow to the half actually absent) ──
    let promptText: string | undefined;
    if (render) {
      if (def.id === 'OBL-AWY-ETI-CONFIRM') {
        const etco2 = atoms.find((a) => a.id === 'etco2')?.satisfied;
        const bs = atoms.find((a) => a.id === 'bilat_bs')?.satisfied;
        if (etco2 && !bs) promptText = def.prompt_partial_etco2;
        else if (bs && !etco2) promptText = def.prompt_partial_bs;
        else promptText = def.prompt;
      } else {
        promptText = def.prompt ?? (def['prompt'] as string | undefined);
      }
    }

    const rt: ObligationRuntime = {
      id: def.id,
      label: def.label,
      subject: def.subject,
      state,
      triggered: true,
      triggeredAtSec,
      atoms: atoms.map((a) => ({ id: a.id, satisfied: a.satisfied, source: a.flagged ? 'flagged:pending-review' : undefined })),
      materialArms: arms,
      material,
      suppressed,
      suppressReason,
      render,
      promptText,
      cptSelected: pickCpt(def, ctx),
      dollarImpact: def.terminal?.dollar_impact,
      terminal: def.terminal,
    };
    runtimes.push(rt);
    states[def.id] = state;
  }

  return { runtimes, states };
}
