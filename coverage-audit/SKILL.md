# Coverage Audit Skill — Methodology

This document defines how to judge test quality when auditing a CodeceptJS suite.
It is framework-agnostic at the reasoning level; stack-specific heuristics live in
`web-codeceptjs.md` and `mobile-codeceptjs.md`.

---

## The three-stage workflow

```
Stage 1  scan.ts already ran → enriched-metadata.json is ready
Stage 2  YOU read enriched-metadata.json → produce candidates.json
Stage 3  YOU read full source of flagged tests → produce audit-report.md
```

Never skip to Stage 3 without Stage 2. Reading 2000 raw test files degrades
judgment; the metadata exists to focus attention on what matters.

---

## Core principle: risk-weighted judgment

A test earns its place by reducing the probability that a real user hits a real bug
that would not be caught any other way. Judge every candidate for removal against:

```
Value = Flow Criticality × P(regression not caught elsewhere)
```

High value → keep even if slow, redundant-looking, or poorly written.
Low value AND covered elsewhere → candidate for removal or merge.
Low value AND uncovered → candidate for rewrite, not deletion.

---

## Risk tier classification

Assign each flow (not test) to a tier before judging individual tests.

| Tier | Examples | Default action on duplication |
|------|----------|-------------------------------|
| P0 — Revenue / Auth | checkout, payment, login, signup, subscription cancel | Keep all; flag for merge not delete |
| P1 — Core UX | search, product detail, cart, profile | Keep one representative; remove extras |
| P2 — Supporting | filters, sorting, pagination, notifications | Merge or parameterise |
| P3 — Edge / Error | 404 pages, empty states, validation messages | Remove true duplicates; keep unique assertions |

When a test's tier is unclear, default to the tier above (conservative).

---

## The test pyramid rule

Before flagging an E2E test for removal, ask:

1. **Is this flow covered at the API / integration level?**
   If yes, the E2E test is a candidate for removal — not a certainty.
   Consider: does the E2E test verify the *rendering* or *user interaction* that
   the API test cannot reach? If yes, keep it.

2. **Is there a unit test for the same logic?**
   Unit tests do not replace E2E for critical paths. An E2E test that verifies
   end-to-end data flow (e.g. payment confirmation email sent) is not redundant
   to a unit test of the email formatter.

3. **Would removal leave a gap in the CI signal?**
   If no remaining test would catch a regression in this flow within the same
   CI pipeline, do not remove.

---

## Duplicate judgment rules

### When `exactMatch: true` (identical steps, identical order)

These are mechanical duplicates. Safe to consolidate if:
- Same flow, same assertions.
- Both are in the regression suite (not one smoke + one regression).

Flag as: **MERGE** — convert to a single `Data().Scenario()` if preconditions
differ, or delete the second if preconditions are identical.

Do NOT auto-delete if:
- Tests live in different suites with different execution schedules (smoke vs. nightly).
- One is tagged `@critical` or `@p0` and the other is not.
- The tests belong to different squads or ownership boundaries (coordinate, don't unilaterally remove).

### When `exactMatch: false` but `similarity ≥ threshold` (same actions, different order or minor variation)

These require human judgment. Ask:
- Are the extra/different steps asserting something the other test misses?
- Could they be unified with a shared precondition helper + one extra assertion?
- Is the ordering difference intentional (e.g. testing idempotency)?

Flag as: **REVIEW** with a specific question about the diverging steps.

### Pairs with different preconditions but identical core steps

Example: Test A sets up a guest user, Test B sets up a logged-in user, both then
complete checkout with the same steps. These are NOT duplicates — the precondition
is the variable under test. Mark them **INTENTIONAL**, do not flag.

---

## Subset judgment rules

A test S is a subset of test L when S's steps are a prefix or subset of L's steps.

### When it is safe to recommend removal of S

All of the following must be true:
1. L is always included in the same CI run as S.
2. L's extra steps do not depend on state that S tests in isolation (i.e. L cannot
   pass if S's assertions would fail).
3. S has no unique assertion (`see:`, `dontSee:`) absent from L.
4. S is not a designated smoke test run on every deploy (short runtime is its value).

### When to keep S despite being a subset

- S is the only test for that flow in the smoke suite; L only runs nightly.
- S runs in < 30 s and acts as a fast-fail signal; L takes > 2 min.
- S covers a P0 flow; faster signal justifies duplication.
- Removing S would leave a gap between deploys and the full regression run.

Flag as: **KEEP (smoke)** or **REMOVE (covered)** with explicit rationale.

---

## Hardcoded wait rules

`I.wait(n)` with a numeric literal is always a smell. Classify:

| Context | Verdict |
|---------|---------|
| Only wait in the test; no retry/poll logic anywhere | **REPLACE** with explicit `waitForElement` or `waitForText` |
| Inside a Data() scenario with known slow external service | **EXTRACT** to a named constant, add a comment |
| In a `Before` / `BeforeSuite` hook | **REVIEW** — may be legitimate startup wait |

Never recommend removing a wait without proposing a deterministic alternative.

---

## Never-run tests

Tests absent from the Mochawesome report fall into three categories:

1. **New** — added after the last report run. Check git log. If < 2 weeks old, no action.
2. **Skipped** — tagged `@skip` / `xScenario`. Flag for review: why are they skipped?
   Skipped tests that have been skipped for > 30 days without a tracking ticket are
   candidates for deletion.
3. **Orphaned** — suite file exists but was never scheduled. Investigate before acting.

---

## What NEVER to recommend for automatic deletion

These require a human decision with explicit sign-off:

- Any test tagged `@critical`, `@p0`, or `@smoke`.
- Any test covering payment, auth, or data-deletion flows.
- Any test that is the *only* coverage for its flow at any level.
- Any test added in the last 14 days (may be under active development).
- Any test involving third-party integrations (flakiness ≠ redundancy).
- Any test owned by a team other than the one requesting the audit.

Always surface these in the **"Do Not Touch" section** of the report even if they
appear in duplicate candidates.

---

## Output format for `candidates.json` (Stage 2)

Produce a JSON array, 50–150 items. Each item:

```jsonc
{
  "testId":   "tests/checkout/payment.spec.ts:14",
  "category": "duplicate | subset | never_run | hardcoded_wait | slow",
  "priority": "high | medium | low",
  "partnerId": "tests/checkout/payment.spec.ts:38",  // for duplicate/subset
  "reason":   "One-sentence human-readable reason this was flagged",
  "action":   "MERGE | REMOVE | REPLACE_WAIT | REVIEW | KEEP",
  "risk":     "P0 | P1 | P2 | P3"
}
```

Sort by `priority` desc, then `category` (duplicate → subset → never_run →
hardcoded_wait → slow).

---

## Output format for `audit-report.md` (Stage 3)

```
# Coverage Audit Report
Generated: <date>   Tests scanned: N   Report: <mochawesome path>

## Executive Summary
<3–5 bullet points: biggest wins, biggest risks, recommended first action>

## 1. Duplicates  (N pairs)
### High confidence — recommend MERGE/REMOVE
| Test A | Test B | Similarity | Exact | Suggested action |
...
### Review required
...

## 2. Subsets  (N pairs)
| Subset test | Superset test | Coverage | Is prefix | Verdict |
...

## 3. Hardcoded Waits  (N tests)
| File | Line | Raw arg | Replacement suggestion |
...

## 4. Never Run  (N tests)
| Test | File | Age (days since last seen) | Likely cause |
...

## 5. Uncovered Critical Flows
<List flows with no test coverage at any level, derived from flow inventory>

## 6. Do Not Touch
<List of tests flagged by scan but excluded from recommendations — with reason>

## 7. Priority Action List
1. <Most impactful single action — be specific>
2. ...
(max 10 items, ordered by effort/impact ratio)
```

---

## Calibration reminders

- **Absence of coverage is worse than redundancy.** Prefer the false-positive
  (keeping a duplicate) over the false-negative (deleting something critical).
- **A slow test is not a bad test.** Duration is a cost signal, not a quality signal.
  Recommend optimisation (replace waits, parallelize) before removal.
- **Data-driven ≠ duplicate.** A `Data([A, B, C]).Scenario()` that exercises three
  code paths is not redundant; it's efficient. Only flag it if all three rows
  exercise the *same* code path.
- **Similarity score is a filter, not a verdict.** Two tests at 0.95 Jaccard may
  be testing different edge cases via identical UI interactions. Always check the
  assertions, not just the action steps.
