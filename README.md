# QA Playbook

Reusable QA automation skills for CodeceptJS (Playwright · WDIO/Appium) projects.
Each skill is self-contained — install its own dependencies, run its own scripts.

---

## Skills

| Skill | Status | What it does |
|-------|--------|-------------|
| [coverage-audit](coverage-audit/) | ✅ Ready | Audit ~2000 CodeceptJS tests for duplicates, dead tests, slow tests, and hardcoded waits |
| [gap-filler](#gap-filler-planned) | 🔲 Planned | Generate tests for uncovered critical flows via ExploreBot for web codeceptjs |
| [flakiness-audit](#flakiness-audit-planned) | 🔲 Planned | Detect and categorize flaky tests using CI run history |
| [smell-linter](#smell-linter-planned) | 🔲 Planned | Static test smell detection (JS/TS) via smelly-test integration |
| [mobile-audit](#mobile-audit-planned) | 🔲 Planned | coverage-audit variant for Appium/WDIO mobile suites |

---

## Full pipeline vision

```
┌─────────────────────────────────────────────────────────────┐
│  1. coverage-audit   → enriched-metadata.json               │
│     Finds: duplicates · dead tests · waits · slow tests     │
│                                                             │
│  2. Claude audit (Stage 2+3)                                │
│     Produces: candidates.json → audit-report.md             │
│     Identifies: uncovered critical flows (gaps)             │
│                                                             │
│  3. gap-filler       → new *.spec.ts files                  │
│     ExploreBot runs against app URLs from gap list          │
│     Generates: Playwright/CodeceptJS tests for missing flows │
│                                                             │
│  4. flakiness-audit  → flakiness-report.md                  │
│     Cross-references CI history (ReportPortal / Currents.dev)│
│     Flags: retry-dependent tests, order-dependent tests      │
│                                                             │
│  5. smell-linter     → smell-report.json                    │
│     Static analysis: Assertion Roulette, Eager Test, etc.   │
└─────────────────────────────────────────────────────────────┘
```

---

---

## coverage-audit

Scans CodeceptJS test sources + a Mochawesome report and produces an enriched
metadata file for Claude to audit.

### Install

```bash
cd coverage-audit
npm install
```

### Run — source-only scan (no runtime data)

```bash
npm run scan -- \
  --tests "../path/to/tests/**/*.spec.ts" \
  --cwd   ..
```

### Run — full scan with Mochawesome report

```bash
# 1. Place your report in coverage-audit/reports/
cp /path/to/mochawesome.json coverage-audit/reports/mochawesome.json

# 2. Scan
cd coverage-audit
npm run scan -- \
  --tests  "../path/to/tests/**/*.spec.ts" \
  --report reports/mochawesome.json \
  --cwd    ..
```

Output: `coverage-audit/reports/enriched-metadata.json`

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--tests` | `tests/**/*.{test,spec}.ts` | Glob pattern for test files |
| `--report` | — | Path to Mochawesome JSON (optional) |
| `--out` | `reports/enriched-metadata.json` | Output file path |
| `--similarity` | `0.85` | Jaccard threshold for duplicate detection (0–1) |
| `--slow-top` | `20` | Number of slowest tests to surface |
| `--cwd` | `process.cwd()` | Project root (tests resolved relative to this) |

### Stage 2 — Claude audit

After the scan, open a new Claude chat and attach:
1. `coverage-audit/reports/enriched-metadata.json`
2. `coverage-audit/SKILL.md`
3. `coverage-audit/web-codeceptjs.md` (web) or `coverage-audit/mobile-codeceptjs.md` (mobile)

Ask Claude to produce `candidates.json` (Stage 2), then follow up with the full
source of flagged tests for `audit-report.md` (Stage 3).

### Mochawesome merge (if using multiple report files)

```bash
npx mochawesome-merge coverage-audit/reports/mochawesome-*.json \
  -o coverage-audit/reports/mochawesome.json
```

---

## gap-filler (planned)

**Goal:** take the "Uncovered Critical Flows" section from `audit-report.md` and generate
real tests for those gaps automatically.

**Approach:** [ExploreBot](https://github.com/testomatio/explorbot) (open source, Elastic
License 2.0) — autonomous AI agent that navigates the app and saves successful flows as
Playwright / CodeceptJS `.spec.ts` files.

**Cost:** $0 license + AI token usage (~$1/hr continuous run via OpenRouter/Groq).

**Planned inputs:**
- `audit-report.md` → parse "Uncovered Critical Flows" section
- App base URL + optional auth credentials

**Planned outputs:**
- Generated `*.spec.ts` files ready for review and CI

**Not applicable for:** mobile native apps (Appium) — ExploreBot is browser-only (Playwright).

**Config sketch:**
```js
// explorbot.config.js
export default {
  url: process.env.APP_URL,
  ai: {
    model: 'openrouter:google/gemini-flash-1.5',
    agenticModel: 'openrouter:anthropic/claude-3.5-sonnet',
  },
  outputDir: '../tests/generated/',
  outputFormat: 'codeceptjs',
};
```

---

## flakiness-audit (planned)

**Goal:** identify tests that are unreliable across CI runs — order-dependent, retry-dependent,
or timing-sensitive — so they can be fixed or quarantined.

**Approach:** cross-reference multiple Mochawesome reports (or ReportPortal / Currents.dev API)
to compute per-test pass rate, retry count, and execution variance.

**Data sources (pick one):**
- Multiple `mochawesome-*.json` from CI artifacts (self-hosted, free)
- [ReportPortal](https://reportportal.io/) self-hosted (free, Docker) — richer ML-based analysis
- [Currents.dev](https://currents.dev/) SaaS — flakiness dashboard out-of-the-box, free tier available for Playwright

**Planned outputs:**
- `flakiness-report.md` — per-test flakiness score, failure pattern, suggested fix category
- Categories: `ORDER_DEPENDENT · TIMING_SENSITIVE · RESOURCE_LEAK · GENUINE_BUG`

**Note:** this is a runtime analysis (needs historical data), not static like coverage-audit.

---

## smell-linter (planned)

**Goal:** static detection of test code smells in JS/TS that coverage-audit doesn't catch —
structural anti-patterns inside individual tests.

**Approach:** integrate [smelly-test](https://github.com/marabesi/smelly-test) (open source)
as a sub-scanner. Detects: Assertion Roulette, Conditional Test Logic, Magic Number Wait,
Duplicate Assert, Empty Test, Eager Test.

**Gap vs coverage-audit:** smelly-test works at AST/code level per test; coverage-audit works
at semantic/step level across tests. They are complementary.

**Planned inputs:** same glob pattern as coverage-audit (`tests/**/*.spec.ts`)

**Planned outputs:** `smell-report.json` merged into the existing `enriched-metadata.json`
schema so Claude can reason over both in Stage 2.

---

## mobile-audit (planned)

**Goal:** same audit workflow as coverage-audit but tuned for CodeceptJS + Appium / WDIO
mobile suites, where helpers, locator patterns, and test smells differ from web.

**Key differences from web:**
- Helpers: `I.tap()`, `I.swipe()`, `I.scrollTo()` instead of `I.click()`, `I.fill()`
- Hardcoded waits more common due to native animation delays — need platform-specific thresholds
- No Mochawesome by default in WDIO — may need Allure or custom reporter adapter
- Precondition patterns: device state, OS version, deep links vs URL navigation

**Planned files:**
- `coverage-audit/mobile-codeceptjs.md` — mobile-specific heuristics (mirrors `web-codeceptjs.md`)
- `coverage-audit/scripts/scan-mobile.ts` — mobile helper normalizer
