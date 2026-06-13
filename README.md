# QA Playbook

Reusable QA automation skills for CodeceptJS (Playwright · WDIO/Appium) projects.
Each skill is self-contained — install its own dependencies, run its own scripts.

---

## Skills

| Skill | What it does |
|-------|-------------|
| [coverage-audit](coverage-audit/) | Audit ~2000 CodeceptJS tests for duplicates, dead tests, slow tests, and hardcoded waits |

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
