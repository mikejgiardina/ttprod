/**
 * Pipeline — the deterministic recompute.
 *
 * On every transcript delta: recompute EVERYTHING from the full evidence set, then render.
 * A small fixpoint (≤4 passes) resolves the two cross-dependencies — obligations read the
 * lattice's any_criterion, the lattice's PHYS_AIRWAY reads an obligation state.
 *
 * Data source is the bundled rulebook JSON (src/data/*). Nothing here calls a model or a
 * network: given evidence + now, it is pure.
 */

import type {
  ActivationLattice,
  ActivePrompt,
  ChargeItem,
  EngineConfig,
  EngineState,
  ObligationCatalog,
  ObligationState,
  ScoreTimelinePoint,
  Utterance,
  ValueReading,
  WalkerResult,
} from '../types.ts';

import obligationsRaw from '../data/obligations.json';
import latticeRaw from '../data/activation_lattice.json';
import chargesRaw from '../data/charges.json';
import measuresRaw from '../data/accreditation_measures.json';
import cannedRaw from '../data/canned_transcript.json';

import { buildCorpus } from './matcher.ts';
import { buildValues } from './values.ts';
import { computeScores } from './scores.ts';
import { computeClocks } from './clocks.ts';
import { computeWalker } from './walker.ts';
import { computeObligations } from './ledger.ts';
import { computeCharges } from './charges.ts';
import { computeMeasures } from './measures.ts';
import { parseTRel, formatSec } from './time.ts';
import type { EvalContext } from './predicates.ts';

const CATALOG = obligationsRaw as unknown as ObligationCatalog;
const LATTICE = latticeRaw as unknown as ActivationLattice;
const CHARGE_ITEMS = (chargesRaw as { charge_items: ChargeItem[] }).charge_items;
const MEASURE_DEFS = (measuresRaw as { measures: Parameters<typeof computeMeasures>[0] }).measures;

const CC_CLOCK = CATALOG.obligations.find((o) => o.id === 'OBL-CC-TIME-30MIN')?.clock;

/* ─────────────────────────── evidence ───────────────────────────── */

export interface Evidence {
  case: string;
  utterances: Utterance[];
  readings: ValueReading[];
  maxSec: number;
}

interface CannedBeat {
  t_rel: string;
  text: string;
  values?: { name: string; value: number | string; unit?: string }[];
}

export function loadCanned(): Evidence {
  const raw = cannedRaw as unknown as { case: string; beats: CannedBeat[] };
  const utterances: Utterance[] = [];
  const readings: ValueReading[] = [];
  let maxSec = 0;
  for (const beat of raw.beats) {
    const atSec = parseTRel(beat.t_rel);
    maxSec = Math.max(maxSec, atSec);
    utterances.push({ t_rel: beat.t_rel, atSec, text: beat.text });
    for (const v of beat.values ?? []) {
      readings.push({ name: v.name, value: v.value, unit: v.unit, heardAtSec: atSec, raw: beat.text });
    }
  }
  return { case: raw.case, utterances, readings, maxSec };
}

export function defaultConfig(dispositionSec: number): EngineConfig {
  return {
    settleMs: 3000,
    cooldownS: 45,
    maxPrompts: 1,
    facilityTraumaDesignation: 'state_designated',
    g0390Mode: 'decline_with_citation',
    dispositionSec,
  };
}

/* ─────────────────────────── recompute ──────────────────────────── */

function buildScoreTimeline(readings: ValueReading[], nowSec: number): ScoreTimelinePoint[] {
  const inputNames = new Set(['HR', 'BP', 'GCS', 'RR']);
  const times = [...new Set(readings.filter((r) => inputNames.has(r.name) && r.heardAtSec <= nowSec).map((r) => r.heardAtSec))].sort((a, b) => a - b);
  const out: ScoreTimelinePoint[] = [];
  for (const t of times) {
    const v = buildValues(readings, buildCorpus([], t), t);
    const s = computeScores(v);
    if (s.GCS == null && s.shockIndex == null && s.RTS == null) continue;
    const prev = out[out.length - 1];
    if (prev && prev.GCS === s.GCS && prev.shockIndex === s.shockIndex && prev.RTS === s.RTS) continue;
    out.push({ ...s, t_rel: formatSec(t), atSec: t });
  }
  return out;
}

export function recompute(evidence: Evidence, nowSec: number, config: EngineConfig): EngineState {
  const corpus = buildCorpus(evidence.utterances, nowSec);
  const values = buildValues(evidence.readings, corpus, nowSec);
  const clocks = computeClocks(corpus, nowSec, CC_CLOCK);
  const resuscitationActive = clocks.activationSec != null;

  let states: Record<string, ObligationState> = {};
  let walker: WalkerResult = { criteriaMet: [], anyCriterionSatisfied: false, prompt: null, enteredFamilies: [] };
  let ledger = computeObligations(CATALOG, corpus, baseCtx(values, nowSec, resuscitationActive, states, clocks, false), clocks, config, nowSec);

  for (let i = 0; i < 4; i++) {
    const w = computeWalker(LATTICE, corpus, baseCtx(values, nowSec, resuscitationActive, states, clocks, walker.anyCriterionSatisfied));
    const l = computeObligations(
      CATALOG,
      corpus,
      baseCtx(values, nowSec, resuscitationActive, states, clocks, w.anyCriterionSatisfied),
      clocks,
      config,
      nowSec,
    );
    const stable = JSON.stringify(l.states) === JSON.stringify(states) && w.anyCriterionSatisfied === walker.anyCriterionSatisfied;
    states = l.states;
    walker = w;
    ledger = l;
    if (stable && i > 0) break;
  }

  const scores = computeScores(values);
  const scoreTimeline = buildScoreTimeline(evidence.readings, nowSec);
  const { charges, estimatedTotal, activation, gaps } = computeCharges(CHARGE_ITEMS, ledger.runtimes, walker, config);
  const measures = computeMeasures(MEASURE_DEFS, states, walker, corpus, clocks);
  const activePrompt = pickActivePrompt(ledger.runtimes, walker);

  return {
    nowSec,
    values,
    scores,
    scoreTimeline,
    obligations: ledger.runtimes,
    activePrompt,
    charges,
    estimatedTotal,
    activation,
    measures,
    gaps,
    resuscitationActive,
  };
}

function baseCtx(
  values: EngineState['values'],
  nowSec: number,
  resuscitationActive: boolean,
  obligationStates: Record<string, ObligationState>,
  clocks: ReturnType<typeof computeClocks>,
  latticeAnyCriterion: boolean,
): EvalContext {
  return {
    values,
    nowSec,
    resuscitationActive,
    obligationStates,
    criticalCareAccruedMin: clocks.criticalCare.accruedMin,
    latticeAnyCriterion,
  };
}

/**
 * Exactly one prompt on the surface. Priority: a charge-integrity hold (qualification arm)
 * → the mechanism disambiguation (lattice) → a documentation miss-pop (freshness/EFAST).
 */
function pickActivePrompt(runtimes: EngineState['obligations'], walker: WalkerResult): ActivePrompt | null {
  const renders = runtimes.filter((r) => r.render);
  const qualCharge = renders.find((r) => r.subject.kind === 'charge' && r.materialArms.includes('qualification'));
  if (qualCharge) {
    return { source: 'ledger', obligationId: qualCharge.id, text: qualCharge.promptText ?? qualCharge.label };
  }
  if (walker.prompt) {
    return { source: 'lattice', nodeId: walker.prompt.nodeId, text: walker.prompt.text, subline: walker.prompt.subline };
  }
  if (renders.length) {
    const r = renders[0];
    return { source: 'ledger', obligationId: r.id, text: r.promptText ?? r.label };
  }
  return null;
}
