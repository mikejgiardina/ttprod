/**
 * Reactivation-context guard — a context layer OVER the deterministic ledger.
 *
 * Rule (Mike, 2026-07-18): when an already-`satisfied` ONE-TIME obligation is
 * re-triggered or de-satisfied by an utterance that refers to a one-time event that
 * already happened (a readback, a later mention, a shared-token collision), the engine
 * must NOT blindly re-open/re-prompt. It consults surrounding context to decide:
 * genuinely NEW event vs a REFERENCE to the one already satisfied.
 *
 * The ledger is idempotent BY CONSTRUCTION today (one row, monotonic affirm gates), so
 * this guard is forward-defense: it becomes load-bearing the moment confirmation atoms
 * are event-scoped, the lexicon is broadened for STT, or per-unit billing is supported.
 *
 * PURITY (fixpoint safety): pure over corpus + static catalog. It must NOT read
 * obligationStates, and it only ever pushes state TOWARD `satisfied` — so it can never
 * oscillate across passes. Engages only when the gate actually closed over a strict
 * prefix (originatingAtSec != null); inert otherwise, and inert on first-ever release.
 *
 * The deterministic adjudication is Signal 2 ("no fresh gating evidence"): the robust,
 * whole-token-clean rule. Deterministic cross-obligation attribution ("this 'tube's in'
 * belongs to the chest tube") cannot be done without the stemming the matcher forbids —
 * which is exactly where the generative escalation (ReactivationClassifier, opt-in, live
 * path only) earns its place. It is never wired into the canned/CI path.
 */

import type { Corpus } from './matcher.ts';
import { contains, deferred, futureFramed, negatedNear } from './matcher.ts';
import type {
  ObligationDef,
  ObligationState,
  Recurrence,
  ReactivationInfo,
  Requires,
  TriggerGuard,
} from '../types.ts';

/** minimal per-atom shape the guard needs (id + whether it fired + when). */
export interface AtomHit {
  id: string;
  satisfied: boolean;
  atSec?: number;
}

/** context handed to a classifier — carries the surrounding window a generative impl reads. */
export interface ReactivationContext {
  def: ObligationDef;
  originatingAtSec: number;
  corpus: Corpus;
  triggerPhrases: string[];
  triggerGuard?: TriggerGuard;
  affirmPhrases: string[];
}

export interface ReactivationClassifier {
  classifyRecurrence(def: ObligationDef): Recurrence;
  adjudicate(ctx: ReactivationContext): ReactivationInfo['verdict'];
}

/** one-time (default) · repeatable (per-unit, detect-only) · continuous (value/registry, never guarded). */
export function classifyRecurrence(def: ObligationDef): Recurrence {
  if (def.reactivation) return def.reactivation;
  const kind = def.subject?.kind;
  if (kind === 'value_stream' || kind === 'registry_field') return 'continuous';
  if ((def.subject as { unit_basis?: string })?.unit_basis === 'per_unit') return 'repeatable';
  return 'one_time';
}

/** the atSec at which the gate first closed: all_of → max atom time; any_of(k) → k-th earliest. */
export function originatingEvent(atoms: AtomHit[], requires: Requires): number | null {
  if (requires.all_of) {
    const ids = new Set(requires.all_of.map((a) => a.id));
    const times: number[] = [];
    for (const a of atoms) {
      if (!ids.has(a.id)) continue;
      if (!a.satisfied) return null; // gate not met
      if (a.atSec == null) return null; // predicate-only atom → untimeable → guard inert (conservative)
      times.push(a.atSec);
    }
    return times.length ? Math.max(...times) : null;
  }
  if (requires.any_of) {
    const k = requires.min_satisfied ?? 1;
    const times = atoms.filter((a) => a.satisfied && a.atSec != null).map((a) => a.atSec!).sort((x, y) => x - y);
    return times.length >= k ? times[k - 1] : null;
  }
  return null;
}

/** does a guarded trigger re-fire strictly after `afterSec`? returns its atSec or null. */
function triggerRefireAfter(corpus: Corpus, phrases: string[], guard: TriggerGuard | undefined, afterSec: number): number | null {
  for (const line of corpus.lines) {
    if (line.atSec <= afterSec) continue;
    for (const p of phrases) {
      if (!contains(line.norm, p)) continue;
      if (guard?.not_negated && negatedNear(line.norm, p)) continue;
      if (guard?.not_future_tense && futureFramed(line.norm)) continue;
      if (guard?.not_deferred && deferred(line.norm)) continue;
      return line.atSec;
    }
  }
  return null;
}

/** count of post-originating lines that mention this event again (trigger or gating affirm). */
function countReactivations(corpus: Corpus, phrases: string[], afterSec: number): number {
  let n = 0;
  for (const line of corpus.lines) {
    if (line.atSec <= afterSec) continue;
    if (phrases.some((p) => contains(line.norm, p))) n++;
  }
  return n;
}

function affirmAtOrAfter(corpus: Corpus, affirmPhrases: string[], sec: number): boolean {
  return corpus.lines.some((l) => l.atSec >= sec && affirmPhrases.some((p) => contains(l.norm, p)));
}

/**
 * Signal 2. A genuine NEW event requires a guarded trigger RE-FIRE after originating AND
 * fresh gating evidence co-located with it. A readback re-states findings without re-firing
 * the trigger → no fresh event → sameEvent (hold). Inconclusive always collapses to sameEvent.
 */
function adjudicate(ctx: ReactivationContext): ReactivationInfo['verdict'] {
  const t2 = triggerRefireAfter(ctx.corpus, ctx.triggerPhrases, ctx.triggerGuard, ctx.originatingAtSec);
  if (t2 != null && affirmAtOrAfter(ctx.corpus, ctx.affirmPhrases, t2)) return 'newEvent';
  return 'sameEvent';
}

export const deterministicClassifier: ReactivationClassifier = { classifyRecurrence, adjudicate };

function collectAffirmPhrases(requires: Requires): string[] {
  const atoms = [...(requires.all_of ?? []), ...(requires.any_of ?? [])];
  return atoms.flatMap((a) => a.affirm ?? []);
}

/**
 * The guard. Pure over `corpus` + the static def; writes at most one field (`state`).
 * mode-off callers never reach this. Returns state unchanged when it does not engage.
 */
export function applyReactivation(
  def: ObligationDef,
  derived: { atoms: AtomHit[]; met: boolean; state: ObligationState },
  corpus: Corpus,
  classifier: ReactivationClassifier = deterministicClassifier,
): { state: ObligationState; reactivation?: ReactivationInfo } {
  const recurrence = classifier.classifyRecurrence(def);
  if (recurrence === 'continuous') return { state: derived.state }; // vitals/registry beats — never freeze

  const originatingAtSec = originatingEvent(derived.atoms, def.requires);
  if (originatingAtSec == null) return { state: derived.state }; // gate never closed / untimeable → inert

  const triggerPhrases = def.trigger.any_of ?? [];
  const affirmPhrases = collectAffirmPhrases(def.requires);
  const reactivations = countReactivations(corpus, [...triggerPhrases, ...affirmPhrases], originatingAtSec);

  const verdict = classifier.adjudicate({
    def, originatingAtSec, corpus, triggerPhrases, triggerGuard: def.trigger_guard, affirmPhrases,
  });

  // one_time + sameEvent + a would-be de-satisfaction → hold the earned satisfaction.
  const heldSatisfied = recurrence === 'one_time' && verdict === 'sameEvent' && derived.state !== 'satisfied';
  const state: ObligationState = heldSatisfied ? 'satisfied' : derived.state;

  return {
    state,
    reactivation: {
      recurrence,
      originatingAtSec,
      reactivations,
      verdict,
      heldSatisfied,
      signal: verdict === 'newEvent' ? 'fresh_done_framed' : 'no_fresh_evidence',
    },
  };
}
