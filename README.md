# Trauma Tracker

**A real-time ED trauma registrar.** Ambient voice capture is the commodity base — Trauma Tracker is the layer on top: while a trauma resuscitation is happening, it listens and does the documentation, quality-measure, and billing work the team can't touch while they're saving a life.

Synthetic data only. No PHI, by design.

## The problem

An ED trauma resuscitation generates a documentation, core-measure, and billing burden nobody is free to handle in the moment. Charges leak. Core-measure clocks — trauma-activation response, airway, sepsis, STEMI — get reconstructed from memory hours later. Accreditation and reimbursement both hinge on times nobody had a hand free to write down.

## The idea

From the same live audio, specialized agents **decide and produce** — they don't just display:

- **Extract** — pull values and interventions as they're spoken (GCS, HR, BP, activation, IV access, type & cross, intubation), timestamped.
- **Score** — compute and track trauma scores live as the patient changes (e.g. Shock Index, RTS).
- **Clocks** — watch accreditation / core-measure windows (airway secured, surgeon-at-bedside) and mark them met or open.
- **Charge integrity** — fire a charge only when the documentation that code requires is present (e.g. intubation confirmed by EtCO₂ + bilateral breath sounds).
- **Reimbursement / activation** — make the trauma-activation determination against criteria, with the evidence cited and open conditions printed as open.

A human stays in the loop: the tool asks ("missed capture, or not yet performed?"), it doesn't accuse — and every correction is supervision signal.

## The deliverable

The product is the **record and the agents**, not the screen. One click generates a two-page report:

1. **Nursing transcription sheet** — every event + timestamp, ready to drop into a paper chart.
2. **RCM report** — captured charges + estimated total, measure compliance, and the trauma-activation determination with evidence cited and an **abstractor's sign-off line**. The tool presents the determination; a human signs it.

Runs on one device, no EHR integration required — a rural trauma bay still on paper prints this and charts from it; a metro center hands the capture layer to its EHR or ambient-scribe suite.

**Roadmap:** EHR write-back, payor prior-auth eligibility, full injury abstraction, and a supervision-driven data flywheel.

## Repo layout

```
Trauma-tracker/
├── README.md          ← this file — the idea
└── hack/              ← planning + reference material (source: ed-ambient-rcm build)
    ├── plan/          gameplan, build spec, pitch, prep, checklists, glossary
    ├── docs/          workflow, cadence, testing strategy, demo/intro + ADRs (docs/adr)
    ├── reference/     obligations model, validation loops, protocols, sign-offs, datasets
    ├── prompts/       agent prompts (extractor, accreditation, reimbursement/charge)
    ├── fixtures/      trauma-callout scripts + expected extraction
    └── design/        mockups + report layout
```

## Status

Early — gathering data and consolidating the plans (staged in `hack/`). Team file transfer is handled out-of-band via a shared drive. More to come.
