/**
 * Trauma Tracker — dev harness (buildable task #17 floor).
 *
 * PROVISIONAL UI. This is the canned-transcript dev harness that proves the deterministic
 * pipeline end-to-end with no mic / STT / model. The PRODUCTION capture surface (v1 two-column
 * console vs v3 single running-record-with-margin) is an OPEN decision — see PRODUCT_PLAN.md
 * needs_decision #10 — so this deliberately reads the engine and renders state rather than
 * committing the product's look. Prompts here are a pure render of ledger/lattice state.
 */

import { useEffect, useMemo, useState } from 'react';
import { loadCanned, defaultConfig, recompute } from './engine/pipeline.ts';
import { formatSec } from './engine/time.ts';
import { Report } from './report/Report.tsx';
import type { ChargeStatus } from './types.ts';

const SPEED = 12; // demo seconds per real second when playing

const scoreColor = (label: string, v: number | null): string => {
  if (v == null) return 'text-text-dim';
  if (label === 'shockIndex') return v >= 1.0 ? 'text-crit' : v > 0.9 ? 'text-warn' : 'text-ok';
  if (label === 'RTS') return v < 6 ? 'text-crit' : v < 7 ? 'text-warn' : 'text-ok';
  if (label === 'GCS') return v < 9 ? 'text-crit' : v < 13 ? 'text-warn' : 'text-ok';
  return 'text-text';
};

const chargeColor: Record<ChargeStatus, string> = {
  billed: 'text-ok',
  held: 'text-warn',
  unresolved: 'text-crit',
  declined: 'text-crit',
  not_applicable: 'text-text-dim',
  dormant: 'text-text-dim',
};

export default function App() {
  const evidence = useMemo(() => loadCanned(), []);
  const config = useMemo(() => defaultConfig(evidence.maxSec), [evidence.maxSec]);
  const [nowSec, setNowSec] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [showReport, setShowReport] = useState(false);

  const state = useMemo(() => recompute(evidence, nowSec, config), [evidence, nowSec, config]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setNowSec((s) => {
        const next = s + SPEED / 4;
        if (next >= evidence.maxSec) {
          setPlaying(false);
          return evidence.maxSec;
        }
        return next;
      });
    }, 250);
    return () => clearInterval(id);
  }, [playing, evidence.maxSec]);

  const transcript = evidence.utterances.filter((u) => u.atSec <= nowSec);

  return (
    <div className="min-h-full flex flex-col text-text">
      {/* ── header + transport ── */}
      <header className="flex items-center gap-4 px-5 py-3 border-b border-border bg-surface">
        <div className="font-semibold tracking-tight">Trauma Tracker <span className="text-text-dim font-normal">· registrar</span></div>
        <div className="text-xs px-2 py-0.5 rounded bg-surface-2 text-text-dim">canned · synthetic · no PHI</div>
        <div className="ml-auto flex items-center gap-3">
          <button className="px-3 rounded bg-surface-2 hover:bg-border" onClick={() => setPlaying((p) => !p)}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
          <button className="px-3 rounded bg-surface-2 hover:bg-border" onClick={() => { setNowSec(0); setPlaying(true); }}>↻ Restart</button>
          <button className="px-3 rounded bg-accent text-white hover:opacity-90" onClick={() => setShowReport(true)}>Generate report</button>
          <span className="font-mono text-sm text-text-dim w-16 text-right">{formatSec(nowSec)}</span>
        </div>
      </header>
      <input
        type="range" min={0} max={evidence.maxSec} value={nowSec} step={1}
        onChange={(e) => { setPlaying(false); setNowSec(Number(e.target.value)); }}
        className="w-full accent-[var(--color-accent)]"
      />

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 p-4 overflow-hidden">
        {/* ── running record + values ── */}
        <section className="flex flex-col gap-3 min-h-0">
          <Panel title="Running record">
            <div className="flex flex-col gap-1.5 overflow-y-auto text-sm leading-snug pr-1" style={{ maxHeight: '42vh' }}>
              {transcript.map((u, i) => (
                <div key={i} className="flex gap-2">
                  <span className="font-mono text-xs text-text-dim shrink-0 w-14">{u.t_rel}</span>
                  <span>{u.text}</span>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Live scores">
            <div className="grid grid-cols-3 gap-2">
              <Score label="GCS" v={state.scores.GCS} cls={scoreColor('GCS', state.scores.GCS)} />
              <Score label="Shock Index" v={state.scores.shockIndex} cls={scoreColor('shockIndex', state.scores.shockIndex)} />
              <Score label="RTS" v={state.scores.RTS} cls={scoreColor('RTS', state.scores.RTS)} />
            </div>
          </Panel>
        </section>

        {/* ── supervision console: the ONE active prompt (the hero) ── */}
        <section className="flex flex-col gap-3 min-h-0">
          <Panel title="Supervision console">
            {state.activePrompt ? (
              <div className="rounded-lg border border-warn/60 bg-warn/10 p-4">
                <div className="text-[11px] uppercase tracking-wide text-warn mb-1">
                  {state.activePrompt.source === 'lattice' ? 'Disambiguation' : 'Capture check'} — needs a decision
                </div>
                <div className="text-lg leading-snug">{state.activePrompt.text}</div>
                {state.activePrompt.subline && <div className="text-sm text-text-dim mt-2">{state.activePrompt.subline}</div>}
              </div>
            ) : (
              <div className="text-text-dim text-sm italic p-4 text-center">No open prompt — the record is caught up.</div>
            )}
          </Panel>
          <Panel title="Activation determination">
            <div className="text-sm space-y-1">
              <div>{state.activation.qualifies ? <span className="text-ok font-medium">Qualifies</span> : <span className="text-warn">Pending</span>}</div>
              {state.activation.criteriaMet.map((c, i) => (
                <div key={i} className="text-text-dim"><span className="text-text">{c.criterion}</span> <span className="text-xs">({c.category})</span></div>
              ))}
              <div className="text-xs text-text-dim pt-1">{state.activation.feeDisposition}</div>
            </div>
          </Panel>
        </section>

        {/* ── charge integrity ── */}
        <section className="flex flex-col gap-3 min-h-0">
          <Panel title={`Charge integrity — est. $${state.estimatedTotal.toFixed(0)} captured`}>
            <div className="flex flex-col gap-1 overflow-y-auto text-sm pr-1" style={{ maxHeight: '58vh' }}>
              {state.charges.filter((c) => c.status !== 'dormant').map((c) => (
                <div key={c.obligationId} className="flex items-center gap-2 border-b border-border/40 py-1">
                  <span className={`w-16 font-medium ${chargeColor[c.status]}`}>{c.status}</span>
                  <span className="font-mono text-xs text-text-dim w-16">{c.cpt ?? c.code}</span>
                  <span className="flex-1 truncate" title={c.name}>{c.name}</span>
                  <span className="text-text-dim">{c.status === 'billed' ? `$${c.price.toFixed(0)}` : '—'}</span>
                </div>
              ))}
            </div>
          </Panel>
        </section>
      </main>

      {showReport && (
        <div className="fixed inset-0 z-50 bg-black/70 overflow-auto" onClick={() => setShowReport(false)}>
          <div className="report-modal" onClick={(e) => e.stopPropagation()}>
            <div className="no-print flex gap-3 justify-end p-3 sticky top-0 bg-surface border-b border-border">
              <button className="px-3 rounded bg-accent text-white" onClick={() => window.print()}>Print / Save PDF</button>
              <button className="px-3 rounded bg-surface-2" onClick={() => setShowReport(false)}>Close</button>
            </div>
            <Report state={state} evidence={evidence} />
          </div>
        </div>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3 min-h-0">
      <div className="text-xs uppercase tracking-wide text-text-dim mb-2">{title}</div>
      {children}
    </div>
  );
}

function Score({ label, v, cls }: { label: string; v: number | null; cls: string }) {
  return (
    <div className="rounded bg-surface-2 p-2 text-center">
      <div className="text-[10px] uppercase text-text-dim">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${cls}`}>{v == null ? '—' : v}</div>
    </div>
  );
}
