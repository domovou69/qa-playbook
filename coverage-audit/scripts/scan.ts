#!/usr/bin/env node
/**
 * scan.ts — CodeceptJS coverage scanner.
 * Parses test sources + optional Mochawesome report → enriched-metadata.json
 *
 * Usage:
 *   tsx scripts/scan.ts [options]
 *
 * Options:
 *   --tests       <glob>   Test file glob  (default: "tests/**\/*.{test,spec}.ts")
 *   --report      <path>   Mochawesome JSON report (optional)
 *   --out         <path>   Output file     (default: "reports/enriched-metadata.json")
 *   --similarity  <0-1>    Jaccard duplicate threshold (default: 0.85)
 *   --slow-top    <n>      Top-N slowest tests to surface (default: 20)
 *   --cwd         <path>   Project root    (default: process.cwd())
 *   --help                 Show this help
 */

import { Project, Node, type CallExpression, type SourceFile } from 'ts-morph';
import fg from 'fast-glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import type {
  LogicalTest,
  HardcodedWait,
  EnrichedMetadata,
  ScanMeta,
  RuntimeStats,
  TestState,
  DuplicateCandidate,
  SubsetCandidate,
  SlowTest,
  ScanSummary,
  NormalisedStep,
} from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SCAN_VERSION = '1.0.0';
/** Separator Mochawesome appends for Data() iterations: "Test name | {json}" */
const DATA_SEP = ' | ';
/** Max characters kept from a step's first argument before truncation */
const MAX_ARG_LEN = 60;
/** Minimum coverage ratio to flag a subset candidate */
const SUBSET_THRESHOLD = 0.9;

// ─── CLI ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
Usage: tsx scripts/scan.ts [options]

Options:
  --tests       <glob>   Test file glob  (default: "tests/**/*.{test,spec}.ts")
  --report      <path>   Mochawesome JSON report (optional)
  --out         <path>   Output file     (default: "reports/enriched-metadata.json")
  --similarity  <0-1>    Jaccard duplicate threshold (default: 0.85)
  --slow-top    <n>      Top-N slowest tests (default: 20)
  --cwd         <path>   Project root (default: cwd)
  --help                 Show this help
`.trim());
}

const { values: argv } = parseArgs({
  options: {
    tests:      { type: 'string',  default: 'tests/**/*.{test,spec}.ts' },
    report:     { type: 'string' },
    out:        { type: 'string',  default: 'reports/enriched-metadata.json' },
    similarity: { type: 'string',  default: '0.85' },
    'slow-top': { type: 'string',  default: '20' },
    cwd:        { type: 'string',  default: process.cwd() },
    help:       { type: 'boolean', default: false },
  },
  strict: true,
});

if (argv.help) { printHelp(); process.exit(0); }

const CWD               = path.resolve(argv.cwd!);
const SIMILARITY_THRESH = Math.min(1, Math.max(0, parseFloat(argv.similarity!)));
const SLOW_TOP          = Math.max(1, parseInt(argv['slow-top']!, 10));

// ─── Normalisation helpers ────────────────────────────────────────────────────

function stripQuotes(raw: string): string {
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith('`') && raw.endsWith('`'))
  ) return raw.slice(1, -1);
  return raw;
}

function normaliseArg(raw: string): string {
  const stripped = stripQuotes(raw.trim());
  return stripped.length > MAX_ARG_LEN ? stripped.slice(0, MAX_ARG_LEN) + '…' : stripped;
}

function hashSteps(steps: NormalisedStep[]): string {
  return crypto.createHash('sha1').update(steps.join('\n')).digest('hex').slice(0, 12);
}

function extractInlineTags(name: string): string[] {
  return [...name.matchAll(/@([\w-]+)/g)].map((m) => m[1] as string);
}

// ─── AST — tag chain traversal ───────────────────────────────────────────────

/**
 * Walk UP from a Scenario() CallExpression through .tag().tag()... chains,
 * collecting every string argument passed to .tag().
 */
function collectChainTags(scenarioCall: CallExpression): string[] {
  const tags: string[] = [];
  let current: Node = scenarioCall;

  for (;;) {
    const parent = current.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent)) break;
    if (parent.getName() !== 'tag') break;
    const gp = parent.getParent();
    if (!gp || !Node.isCallExpression(gp)) break;
    const arg = gp.getArguments()[0];
    if (arg) tags.push(stripQuotes(arg.getText()));
    current = gp;
  }

  return tags;
}

// ─── AST — step extraction ────────────────────────────────────────────────────

/**
 * Detect which identifier in the callback params refers to the CodeceptJS
 * helper object. Handles `({ I }) => {}` and `({ I: actor }) => {}`.
 * Falls back to 'I'.
 */
function resolveHelperName(callback: Node): string {
  const params = Node.isArrowFunction(callback)
    ? callback.getParameters()
    : Node.isFunctionExpression(callback)
    ? callback.getParameters()
    : [];

  for (const param of params) {
    const nameNode = param.getNameNode();
    if (!Node.isObjectBindingPattern(nameNode)) continue;
    for (const el of nameNode.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
      if (prop === 'I') return el.getNameNode().getText();
    }
  }
  return 'I';
}

interface StepExtractionResult {
  steps: NormalisedStep[];
  waits: HardcodedWait[];
}

function extractSteps(callback: Node, helperName: string): StepExtractionResult {
  const steps: NormalisedStep[] = [];
  const waits: HardcodedWait[] = [];

  callback.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    const obj = callee.getExpression();
    // Only capture direct helper calls: I.method(...), not nested objects
    if (!Node.isIdentifier(obj) || obj.getText() !== helperName) return;

    const method = callee.getName();
    const args   = node.getArguments();
    const first  = args[0] ? normaliseArg(args[0].getText()) : '';
    steps.push(`${method}:${first}`);

    // Flag only numeric literal waits, e.g. I.wait(3) — NOT I.wait(TIMEOUT)
    if (method === 'wait' && args[0]) {
      const raw = args[0].getText().trim();
      if (/^\d+(\.\d+)?$/.test(raw)) {
        waits.push({ line: node.getStartLineNumber(), rawArg: raw });
      }
    }
  });

  return { steps, waits };
}

// ─── AST — scenario extraction ───────────────────────────────────────────────

interface RawScenario {
  name:          string;
  line:          number;
  tags:          string[];
  dataDriven:    boolean;
  datasetSource: string | undefined;
  /** 0 = unknown (dataset is an import, not an inline array) */
  iterations:    number;
  steps:         NormalisedStep[];
  waits:         HardcodedWait[];
  disabled:      boolean;
}

function extractScenariosFromFile(sf: SourceFile): RawScenario[] {
  const results: RawScenario[] = [];
  // Guard against visiting the same Scenario() call more than once
  // (happens when a .tag() wrapper node is also visited by forEachDescendant)
  const visitedPos = new Set<number>();

  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const callee = node.getExpression();
    let isScenario  = false;
    let isDisabled  = false;
    let isDataDriven = false;
    let datasetSource: string | undefined;
    let iterations = 0;

    // ── Pattern A: Scenario('name', fn) / xScenario('name', fn) ─────────────
    if (Node.isIdentifier(callee)) {
      const name = callee.getText();
      if (name === 'Scenario')  { isScenario = true; }
      if (name === 'xScenario') { isScenario = true; isDisabled = true; }
    }

    // ── Pattern B: Data(...).Scenario('name', fn) ────────────────────────────
    if (!isScenario && Node.isPropertyAccessExpression(callee)) {
      const prop = callee.getName();
      if (prop === 'Scenario' || prop === 'xScenario') {
        const obj = callee.getExpression();
        if (Node.isCallExpression(obj)) {
          const innerCallee = obj.getExpression();
          if (Node.isIdentifier(innerCallee) && innerCallee.getText() === 'Data') {
            isScenario   = true;
            isDisabled   = prop === 'xScenario';
            isDataDriven = true;

            const dataArg = obj.getArguments()[0];
            if (dataArg) {
              datasetSource = dataArg.getText();
              // Count rows only when dataset is an inline array literal
              if (Node.isArrayLiteralExpression(dataArg)) {
                iterations = dataArg.getElements().length;
              }
            }
          }
        }
      }
    }

    if (!isScenario) return;

    const pos = node.getStart();
    if (visitedPos.has(pos)) return;
    visitedPos.add(pos);

    const args = node.getArguments();
    if (args.length < 2) return; // malformed — skip

    // First argument is always the name string literal
    const nameArg = args[0];
    if (!nameArg) return;
    const scenarioName = stripQuotes(nameArg.getText());

    // Last argument is the test callback
    const callbackArg = args[args.length - 1];
    if (!callbackArg) return;
    if (!Node.isArrowFunction(callbackArg) && !Node.isFunctionExpression(callbackArg)) return;

    const helperName          = resolveHelperName(callbackArg);
    const { steps, waits }    = extractSteps(callbackArg, helperName);
    const chainTags           = collectChainTags(node);
    const inlineTags          = extractInlineTags(scenarioName);
    const allTags             = [...new Set([...chainTags, ...inlineTags])];

    if (isDisabled) allTags.push('disabled');

    results.push({
      name:          scenarioName,
      line:          node.getStartLineNumber(),
      tags:          allTags,
      dataDriven:    isDataDriven,
      datasetSource,
      iterations,
      steps,
      waits,
      disabled:      isDisabled,
    });
  });

  return results;
}

// ─── Mochawesome parsing ──────────────────────────────────────────────────────

interface MochaEntry {
  /** Full title as Mochawesome records it (includes suite prefix + data suffix) */
  fullTitle: string;
  /** fullTitle stripped of trailing " | {data}" suffix */
  baseTitle: string;
  duration:  number;
  state:     TestState;
  speed:     string | undefined;
}

function collectMochaEntries(suite: Record<string, unknown>): MochaEntry[] {
  const entries: MochaEntry[] = [];

  const tests = suite['tests'] as Array<Record<string, unknown>> | undefined;
  if (tests) {
    for (const t of tests) {
      const fullTitle = String(t['fullTitle'] ?? '');
      const sepIdx    = fullTitle.indexOf(DATA_SEP);
      const baseTitle = (sepIdx >= 0 ? fullTitle.slice(0, sepIdx) : fullTitle).trim();
      entries.push({
        fullTitle,
        baseTitle,
        duration: Number(t['duration'] ?? 0),
        state:    (t['state'] as TestState | undefined) ?? 'pending',
        speed:    t['speed'] ? String(t['speed']) : undefined,
      });
    }
  }

  const suites = suite['suites'] as Array<Record<string, unknown>> | undefined;
  if (suites) {
    for (const s of suites) entries.push(...collectMochaEntries(s));
  }

  return entries;
}

function parseMochaReport(reportPath: string): MochaEntry[] {
  const raw  = fs.readFileSync(reportPath, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  const entries: MochaEntry[] = [];

  const results = data['results'] as Array<Record<string, unknown>> | undefined;
  if (results) {
    for (const r of results) entries.push(...collectMochaEntries(r));
  }

  return entries;
}

// ─── Runtime matching ─────────────────────────────────────────────────────────

/**
 * Match LogicalTests to Mochawesome entries.
 *
 * Matching strategy (in order of precedence):
 *  1. Exact baseTitle === test.name
 *  2. baseTitle ends with " " + test.name  (mocha prepends suite title)
 *
 * For Data() tests: multiple mocha entries share the same baseTitle;
 * duration is summed, state is aggregated (failed if any failed).
 */
function buildRuntimeMap(
  tests: LogicalTest[],
  entries: MochaEntry[],
): { runtime: Record<string, RuntimeStats>; updatedIterations: Map<string, number> } {
  // Group by baseTitle → list of matching mocha entries
  const byBase = new Map<string, MochaEntry[]>();
  for (const e of entries) {
    const list = byBase.get(e.baseTitle) ?? [];
    list.push(e);
    byBase.set(e.baseTitle, list);
  }

  const runtime: Record<string, RuntimeStats> = {};
  const updatedIterations = new Map<string, number>();

  for (const test of tests) {
    let matched: MochaEntry[] | undefined;

    // Exact match
    matched = byBase.get(test.name);

    // Suffix match: mocha prepends the Feature/suite title
    if (!matched || matched.length === 0) {
      for (const [base, list] of byBase) {
        if (base.endsWith(' ' + test.name) || base === test.name) {
          matched = list;
          break;
        }
      }
    }

    if (!matched || matched.length === 0) continue;

    const totalDuration = matched.reduce((s, e) => s + e.duration, 0);
    const states        = matched.map((e) => e.state);
    const aggregateState: TestState =
      states.includes('failed')             ? 'failed'
      : states.every((s) => s === 'passed') ? 'passed'
      : states.every((s) => s === 'pending')? 'pending'
      : 'skipped';

    runtime[test.id] = {
      duration: totalDuration,
      state:    aggregateState,
      speed:    matched[0]?.speed,
      runCount: matched.length,
    };

    // For Data() tests with unknown iterations (non-inline dataset), derive from mocha
    if (test.dataDriven && test.iterations === 0 && matched.length > 1) {
      updatedIterations.set(test.id, matched.length);
    }
  }

  return { runtime, updatedIterations };
}

// ─── Similarity & subset detection ───────────────────────────────────────────

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const s of a) if (b.has(s)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Find duplicate pairs using an inverted index over steps (set-based / order-insensitive).
 * Also flags exact hash matches as exactMatch: true.
 */
function findDuplicates(
  tests: LogicalTest[],
  threshold: number,
): DuplicateCandidate[] {
  const stepSets = tests.map((t) => new Set(t.steps));

  // Inverted index: step string → indices of tests that contain it
  const stepIndex = new Map<string, Set<number>>();
  stepSets.forEach((set, i) => {
    for (const step of set) {
      const bucket = stepIndex.get(step) ?? new Set<number>();
      bucket.add(i);
      stepIndex.set(step, bucket);
    }
  });

  const candidates: DuplicateCandidate[] = [];
  const checked = new Set<string>();

  for (let i = 0; i < tests.length; i++) {
    const setA = stepSets[i];
    if (!setA || setA.size === 0) continue;

    // Candidate partners: tests sharing ≥1 step with i
    const partnerIndices = new Set<number>();
    for (const step of setA) {
      for (const j of stepIndex.get(step) ?? []) {
        if (j !== i) partnerIndices.add(j);
      }
    }

    for (const j of partnerIndices) {
      if (j <= i) continue; // each pair once

      const pairKey = `${i}:${j}`;
      if (checked.has(pairKey)) continue;
      checked.add(pairKey);

      const testA = tests[i];
      const testB = tests[j];
      const setB  = stepSets[j];
      if (!testA || !testB || !setB) continue;

      const sim = jaccardSimilarity(setA, setB);
      if (sim < threshold) continue;

      const sharedSteps = [...setA].filter((s) => setB.has(s));
      candidates.push({
        testAId:     testA.id,
        testBId:     testB.id,
        similarity:  Math.round(sim * 1000) / 1000,
        sharedSteps,
        exactMatch:  testA.stepsHash === testB.stepsHash,
      });
    }
  }

  return candidates.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Find tests where A's steps are a subset (or prefix) of B's steps.
 * A may be a redundant smoke test if B is always run — or a valuable fast
 * check. Claude makes the final call; this only surfaces the candidates.
 */
function findSubsets(tests: LogicalTest[]): SubsetCandidate[] {
  const candidates: SubsetCandidate[] = [];

  for (let i = 0; i < tests.length; i++) {
    const shorter = tests[i]!;
    if (shorter.steps.length === 0) continue;

    const shorterSet = new Set(shorter.steps);

    for (let j = 0; j < tests.length; j++) {
      if (i === j) continue;
      const longer = tests[j]!;
      if (longer.steps.length <= shorter.steps.length) continue;

      const coveredCount = shorter.steps.filter((s) => new Set(longer.steps).has(s)).length;
      const coverageRatio = coveredCount / shorter.steps.length;
      if (coverageRatio < SUBSET_THRESHOLD) continue;

      // Order-sensitive prefix check (first N steps of shorter match first N of longer)
      const isPrefix = shorter.steps.every((step, idx) => longer.steps[idx] === step);

      candidates.push({
        subsetTestId:   shorter.id,
        supersetTestId: longer.id,
        coverageRatio:  Math.round(coverageRatio * 1000) / 1000,
        isPrefix,
      });
    }
  }

  return candidates.sort((a, b) => b.coverageRatio - a.coverageRatio);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const testGlob  = argv.tests!;
  const outPath   = path.resolve(CWD, argv.out!);
  const reportArg = argv.report;

  console.log(`[scan] CWD:        ${CWD}`);
  console.log(`[scan] Tests glob: ${testGlob}`);
  console.log(`[scan] Similarity: ${SIMILARITY_THRESH}`);

  // ── 1. Discover test files ─────────────────────────────────────────────────
  const files = await fg(testGlob, { cwd: CWD, absolute: true });
  if (files.length === 0) {
    console.warn('[scan] No test files found — check your --tests glob and --cwd');
    process.exit(1);
  }
  console.log(`[scan] Files found: ${files.length}`);

  // ── 2. Parse AST ──────────────────────────────────────────────────────────
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  project.addSourceFilesAtPaths(files);

  const tests: LogicalTest[] = [];

  for (const sf of project.getSourceFiles()) {
    const relFile   = path.relative(CWD, sf.getFilePath()).replace(/\\/g, '/');
    const scenarios = extractScenariosFromFile(sf);

    for (const s of scenarios) {
      // id uses file + line so it stays unique even if two scenarios share a name
      const id = `${relFile}:${s.line}`;
      tests.push({
        id,
        name:               s.name,
        file:               relFile,
        line:               s.line,
        tags:               s.tags,
        dataDriven:         s.dataDriven,
        iterations:         s.iterations,
        datasetSource:      s.datasetSource,
        steps:              s.steps,
        stepsHash:          hashSteps(s.steps),
        hardcodedWaitCount: s.waits.length,
        hardcodedWaits:     s.waits,
      });
    }
  }

  console.log(`[scan] Logical tests extracted: ${tests.length}`);

  // ── 3. Parse Mochawesome report (optional) ────────────────────────────────
  let runtime: Record<string, RuntimeStats> = {};
  let neverRun: string[] = [];

  if (reportArg) {
    const absReport = path.resolve(CWD, reportArg);
    console.log(`[scan] Parsing report: ${absReport}`);
    const mochaEntries = parseMochaReport(absReport);
    console.log(`[scan] Mocha entries: ${mochaEntries.length}`);

    const { runtime: rt, updatedIterations } = buildRuntimeMap(tests, mochaEntries);
    runtime = rt;

    // Back-fill iterations for Data() tests whose dataset was an import
    for (const test of tests) {
      const derived = updatedIterations.get(test.id);
      if (derived !== undefined) test.iterations = derived;
    }

    neverRun = tests.filter((t) => !runtime[t.id]).map((t) => t.id);
    console.log(`[scan] Tests matched to runtime: ${Object.keys(runtime).length}`);
    console.log(`[scan] Tests never run:          ${neverRun.length}`);
  }

  // ── 4. Algorithmic detection ──────────────────────────────────────────────
  console.log('[scan] Computing duplicates…');
  const duplicateCandidates = findDuplicates(tests, SIMILARITY_THRESH);
  console.log(`[scan] Duplicate pairs: ${duplicateCandidates.length}`);

  console.log('[scan] Computing subsets…');
  const subsetCandidates = findSubsets(tests);
  console.log(`[scan] Subset pairs:    ${subsetCandidates.length}`);

  // ── 5. Slow tests ─────────────────────────────────────────────────────────
  const slowTests: SlowTest[] = Object.keys(runtime).length > 0
    ? tests
        .filter((t) => runtime[t.id])
        .sort((a, b) => (runtime[b.id]?.duration ?? 0) - (runtime[a.id]?.duration ?? 0))
        .slice(0, SLOW_TOP)
        .map((t, idx) => ({ testId: t.id, duration: runtime[t.id]!.duration, rank: idx + 1 }))
    : [];

  // ── 6. Summary ────────────────────────────────────────────────────────────
  const dataDrivenTests = tests.filter((t) => t.dataDriven);
  const runtimeVals     = Object.values(runtime);
  const avgDurationMs   = runtimeVals.length > 0
    ? Math.round(runtimeVals.reduce((s, r) => s + r.duration, 0) / runtimeVals.length)
    : undefined;

  const summary: ScanSummary = {
    totalLogicalTests:      tests.length,
    dataDrivenTests:        dataDrivenTests.length,
    totalDataIterations:    dataDrivenTests.reduce((s, t) => s + t.iterations, 0),
    neverRunCount:          neverRun.length,
    duplicatePairCount:     duplicateCandidates.length,
    subsetPairCount:        subsetCandidates.length,
    hardcodedWaitTestCount: tests.filter((t) => t.hardcodedWaitCount > 0).length,
    avgDurationMs,
  };

  const meta: ScanMeta = {
    scannedAt:   new Date().toISOString(),
    testGlob,
    reportPath:  reportArg,
    scanVersion: SCAN_VERSION,
  };

  const output: EnrichedMetadata = {
    meta,
    tests,
    runtime,
    neverRun,
    duplicateCandidates,
    subsetCandidates,
    slowTests,
    summary,
  };

  // ── 7. Write output ───────────────────────────────────────────────────────
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`\n[scan] Output written to: ${outPath}`);
  console.log('[scan] Summary:');
  console.table(summary);
}

main().catch((err: unknown) => {
  console.error('[scan] Fatal error:', err);
  process.exit(1);
});
