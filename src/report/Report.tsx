/**
 * The 2-page deliverable (buildable task #13) — print-CSS, zero-dependency (Ctrl+P → Save
 * as PDF). Page 1 = nursing transcription/narrative sheet. Page 2 = RCM report (captured
 * charges, "not billed — edit disposition", measure compliance, and the activation
 * determination presented for an abstractor to sign — the tool presents, a human signs).
 *
 * The record is the product; the screen was just where the nurse supervised the agents
 * building it. All figures illustrative / synthetic — NOT for verification or real billing.
 */

import type { EngineState } from '../types.ts';
import type { Evidence } from '../engine/pipeline.ts';

const money = (n: number) => `$${n.toFixed(2)}`;

export function Report({ state, evidence }: { state: EngineState; evidence: Evidence }) {
  const billed = state.charges.filter((c) => c.status === 'billed');
  const notBilled = state.charges.filter((c) => c.status === 'declined' || c.status === 'unresolved' || c.status === 'held');

  return (
    <div className="report-root">
      {/* ─────────── Page 1 — nursing transcription sheet ─────────── */}
      <section className="report-page">
        <header className="report-head">
          <div>
            <h1>Trauma Resuscitation Record</h1>
            <div className="sub">Case {evidence.case} · synthetic · no PHI</div>
          </div>
          <div className="stamp">Page 1 — Nursing Transcription</div>
        </header>

        <table className="rt">
          <thead>
            <tr><th style={{ width: '70px' }}>Time</th><th>Event / spoken record</th></tr>
          </thead>
          <tbody>
            {evidence.utterances
              .filter((u) => u.atSec <= state.nowSec)
              .map((u, i) => (
                <tr key={i}>
                  <td className="mono">{u.t_rel}</td>
                  <td>{u.text}</td>
                </tr>
              ))}
          </tbody>
        </table>

        <h3>Values heard</h3>
        <div className="chips">
          {Object.values(state.values.latest).map((v) => (
            <span className="chip" key={v.name}>
              {v.name}: {String(v.value)}{v.unit ? ` ${v.unit}` : ''} <em>{/* heard */}</em>
            </span>
          ))}
        </div>

        <div className="attest">
          <div>Attestation — reviewed and signed by: ______________________________</div>
          <div className="sub">RN / documenting clinician · date/time ____________</div>
        </div>
      </section>

      {/* ─────────── Page 2 — RCM report ─────────── */}
      <section className="report-page">
        <header className="report-head">
          <div>
            <h1>Revenue Cycle &amp; Compliance Report</h1>
            <div className="sub">Case {evidence.case} · illustrative figures — not for billing</div>
          </div>
          <div className="stamp">Page 2 — RCM</div>
        </header>

        <h3>Charges captured</h3>
        <table className="rt">
          <thead><tr><th>Code</th><th>CPT</th><th>Description</th><th className="r">Charge</th></tr></thead>
          <tbody>
            {billed.map((c) => (
              <tr key={c.obligationId}>
                <td className="mono">{c.code}</td>
                <td className="mono">{c.cpt ?? '—'}</td>
                <td>{c.name}</td>
                <td className="r">{money(c.price)}</td>
              </tr>
            ))}
            <tr className="total"><td colSpan={3}>Estimated captured total</td><td className="r">{money(state.estimatedTotal)}</td></tr>
          </tbody>
        </table>

        <h3>Not billed — edit disposition</h3>
        <table className="rt">
          <thead><tr><th>Code</th><th>CPT</th><th>Disposition</th><th className="r">$ impact</th></tr></thead>
          <tbody>
            {notBilled.length === 0 && <tr><td colSpan={4} className="dim">None.</td></tr>}
            {notBilled.map((c) => (
              <tr key={c.obligationId}>
                <td className="mono">{c.code}</td>
                <td className="mono">{c.cpt ?? '—'}</td>
                <td>
                  <strong>{c.status.toUpperCase()}</strong> — {c.reason}
                  {c.citation && <div className="cite">{c.citation}</div>}
                </td>
                <td className="r">{c.price ? money(c.price) : '$0.00'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Measure compliance</h3>
        <ul className="measures">
          {state.measures.map((m) => (
            <li key={m.id}>
              <span className={`badge ${m.status}`}>{m.status}</span> {m.name}
              {m.targetMin != null && <span className="dim"> · target {m.targetMin} min{m.elapsedMin != null ? ` · ${m.elapsedMin} min` : ''}</span>}
              {m.detail && <span className="dim"> · {m.detail}</span>}
            </li>
          ))}
        </ul>

        <h3>Trauma activation determination</h3>
        <div className="determination">
          <div className="det-head">EVIDENCE PRESENTED — DETERMINATION {state.activation.qualifies ? 'QUALIFIES' : 'PENDING'} — abstractor signs</div>
          <ul>
            {state.activation.criteriaMet.map((c, i) => (
              <li key={i}><strong>{c.category}</strong>: {c.criterion} <span className="dim">({c.evidence})</span></li>
            ))}
          </ul>
          <div className="det-row">Activation documented: {yn(state.activation.activationDocumented)} · Team responded: {yn(state.activation.teamResponded)} · Prehospital notification: {yn(state.activation.prehospitalNotification)}</div>
          {state.activation.openConditions.length > 0 && (
            <div className="open">Open conditions (printed as open): {state.activation.openConditions.join('; ')}</div>
          )}
          <div className="det-row"><strong>Fee disposition:</strong> {state.activation.feeDisposition}</div>
          <div className="sign">Abstractor sign-off: ______________________________ &nbsp; date ________</div>
        </div>

        {state.gaps.length > 0 && (
          <>
            <h3>Open / unresolved gaps</h3>
            <ul className="measures">
              {state.gaps.map((g) => (
                <li key={g.obligationId}><span className="badge unresolved">gap</span> {g.text}{g.dollarImpact ? <span className="dim"> · ${g.dollarImpact.toFixed(2)}</span> : null}</li>
              ))}
            </ul>
          </>
        )}

        <footer className="report-foot">Presented by Trauma Tracker for human review. The tool presents; a human signs. Synthetic data — no PHI.</footer>
      </section>
    </div>
  );
}

const yn = (b: boolean) => (b ? 'yes' : 'no');
