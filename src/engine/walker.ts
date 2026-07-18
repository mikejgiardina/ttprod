/**
 * Activation-criteria lattice walker (buildable task #6).
 *
 * The 8-step walk from src/data/activation_lattice.json → walker.steps:
 *   enter → prune resolved → prune excluded → prune blocked → prune immaterial
 *   → rank by info_gain desc then id → render exactly ONE → loop on new evidence.
 *
 * Three "never" guards for an orphan number: don't infer a family, don't let a bare
 * number satisfy a criterion, don't default to fall. Plus the two-armed materiality with
 * the subline-precedence rule (ADR-0010): the renderer picks the qualification subline
 * when that arm is live, else the documentation subline.
 *
 * Physiologic criteria are pure predicates (never walked, never prompted). Anatomic-flat
 * criteria are presence checks (never prompted). Only lattice mechanism nodes can prompt.
 */

import type {
  ActivationLattice,
  LatticeFamily,
  LatticeNode,
  WalkerResult,
} from '../types.ts';
import type { Corpus } from './matcher.ts';
import { anyPresent, contains, firstMatch } from './matcher.ts';
import { evalPredicate, type EvalContext } from './predicates.ts';

type NodeResolution = 'met' | 'negative' | 'ambiguous' | 'blocked' | 'inactive';

const WORD_NUM: Record<string, number> = {
  ten: 10, fifteen: 15, twenty: 20, twentyfive: 25, thirty: 30, thirtyfive: 35,
  forty: 40, fifty: 50, sixty: 60,
};

function parseDistanceFt(corpus: Corpus): number | null {
  for (const l of corpus.lines) {
    const d = /(\d+)\s*(?:feet|foot|ft)\b/.exec(l.norm);
    if (d) return parseInt(d[1], 10);
    const w = /(ten|fifteen|twenty ?five|twenty|thirty ?five|thirty|forty|fifty|sixty)\s*(?:feet|foot|ft)\b/.exec(l.norm);
    if (w) return WORD_NUM[w[1].replace(' ', '')] ?? null;
  }
  return null;
}

function parseFrom(corpus: Corpus, words: string[]): string | null {
  for (const l of corpus.lines) {
    for (const w of words) if (contains(l.norm, w)) return w;
  }
  return null;
}

export function computeWalker(
  lattice: ActivationLattice,
  corpus: Corpus,
  ctx: EvalContext,
): WalkerResult {
  // ── step 1: ENTER (with enter_guard.not_preceded_by_negation) ──
  const enteredAt = new Map<string, number>();
  for (const fam of lattice.families) {
    if (fam.enter_when.always) {
      enteredAt.set(fam.id, -1);
      continue;
    }
    const guard = fam.enter_guard?.not_preceded_by_negation ? { not_negated: true } : undefined;
    const hit = firstMatch(corpus, fam.enter_when.any_of, guard);
    if (hit) enteredAt.set(fam.id, hit.atSec);
  }

  // ── step 3 (pre): resolve mutual exclusions — earliest-entered mechanism wins ──
  for (const fam of lattice.families) {
    if (!enteredAt.has(fam.id) || !fam.excludes_families) continue;
    const mine = enteredAt.get(fam.id)!;
    for (const other of fam.excludes_families) {
      if (!enteredAt.has(other)) continue;
      const theirs = enteredAt.get(other)!;
      // drop the later one; ties drop the excluded family
      if (theirs >= mine) enteredAt.delete(other);
    }
  }
  const entered = lattice.families.filter((f) => enteredAt.has(f.id));

  // ── resolve every node in entered families ──
  const resolutions = new Map<string, { node: LatticeNode; family: LatticeFamily; res: NodeResolution }>();

  const resolveNode = (node: LatticeNode, fam: LatticeFamily): NodeResolution => {
    // physiologic: pure predicate, never prompted
    if (fam.shape === 'predicate' && node.predicate) {
      const r = evalPredicate(node.predicate, ctx);
      return r === true ? 'met' : 'inactive'; // unknown/false → inactive (never fabricate)
    }
    // anatomic flat / stub: presence check, never prompted
    if (fam.shape === 'flat' || node.shape === 'lattice_stub') {
      if (node.affirm && anyPresent(corpus, node.affirm)) return 'met';
      if (node.negate && anyPresent(corpus, node.negate)) return 'negative';
      return 'inactive';
    }
    // delegated (ANAT_PENETRATING → PEN_SITE) handled by the PEN family itself
    if (node.shape === 'delegated') return 'inactive';

    // lattice mechanism node
    if (node.resolved_by_modifier === 'distance') {
      const modifier = fam.modifiers?.distance;
      if (!modifier || modifier.role !== 'qualifier') return 'inactive'; // irrelevant under MVC
      const dist = parseDistanceFt(corpus);
      if (dist == null) return 'ambiguous';
      const thr = modifier.threshold ?? 20;
      return dist > thr ? 'met' : 'negative';
    }
    if (node.resolved_by_modifier === 'site') {
      const modifier = fam.modifiers?.site;
      const site = parseFrom(corpus, [...(modifier?.qualifying ?? []), ...(modifier?.non_qualifying ?? [])]);
      if (!site) return 'ambiguous';
      return (modifier?.qualifying ?? []).includes(site) ? 'met' : 'negative';
    }
    // affirm/negate lexicon node
    if (node.negate && anyPresent(corpus, node.negate)) return 'negative';
    if (node.affirm && anyPresent(corpus, node.affirm)) return 'met';
    return 'ambiguous';
  };

  for (const fam of entered) {
    for (const node of fam.nodes) {
      resolutions.set(node.id, { node, family: fam, res: resolveNode(node, fam) });
    }
  }

  // ── step 4: block nodes whose depends_on isn't resolved ──
  const isResolved = (id: string): boolean => {
    const r = resolutions.get(id)?.res;
    return r === 'met' || r === 'negative';
  };
  for (const [, entry] of resolutions) {
    if (entry.res !== 'ambiguous') continue;
    const deps = entry.node.depends_on ?? [];
    if (deps.some((d) => resolutions.has(d) && !isResolved(d))) entry.res = 'blocked';
  }

  // ── collect met criteria + fee-qualification ──
  const criteriaMet: WalkerResult['criteriaMet'] = [];
  for (const [, entry] of resolutions) {
    if (entry.res === 'met' && entry.node.qualifies_alone && entry.node.criterion) {
      criteriaMet.push({
        category: entry.family.axis,
        criterion: entry.node.criterion,
        nodeId: entry.node.id,
        evidence: entry.family.label,
      });
    }
  }
  const anyCriterionSatisfied = criteriaMet.length > 0;

  // ── step 5+6+7: prune immaterial, rank, render exactly one ──
  const candidates = [...resolutions.values()].filter((e) => e.res === 'ambiguous');
  const material = (node: LatticeNode): { arm: 'qualification' | 'documentation' | null } => {
    const qualification = node.qualifies_alone && !anyCriterionSatisfied;
    const documentation = node.registry_required;
    if (qualification) return { arm: 'qualification' };
    if (documentation) return { arm: 'documentation' };
    return { arm: null };
  };

  const ranked = candidates
    .map((e) => ({ ...e, mat: material(e.node) }))
    .filter((e) => e.mat.arm !== null)
    .sort((a, b) => b.node.info_gain - a.node.info_gain || a.node.id.localeCompare(b.node.id));

  let prompt: WalkerResult['prompt'] = null;
  if (ranked.length) {
    const top = ranked[0];
    const dist = parseDistanceFt(corpus);
    const weapon = top.family.modifiers?.weapon
      ? parseFrom(corpus, Object.values(top.family.modifiers.weapon.values ?? {}).flat())
      : null;
    let text = top.node.prompt ?? top.node.prompt_fallback ?? top.node.ask ?? 'Not captured.';
    if (dist != null) text = text.replace('{distance}', `${dist} feet`);
    if (weapon) text = text.replace('{weapon}', weapon);
    if (text.includes('{distance}')) text = top.node.prompt_fallback ?? text.replace(/\{distance\}/g, '');
    const qualifyingCriterion = criteriaMet[0]?.criterion ?? '';
    const subline =
      top.mat.arm === 'qualification'
        ? top.node.prompt_subline_qualification
        : (top.node.prompt_subline_documentation ?? '').replace('{qualifying_criterion}', qualifyingCriterion);
    prompt = {
      nodeId: top.node.id,
      familyId: top.family.id,
      text: text.trim(),
      subline: subline || undefined,
      infoGain: top.node.info_gain,
    };
  }

  return {
    criteriaMet,
    anyCriterionSatisfied,
    prompt,
    enteredFamilies: entered.map((f) => f.id),
  };
}
