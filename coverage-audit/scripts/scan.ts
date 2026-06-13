#!/usr/bin/env node
/**
 * scan.ts  CodeceptJS coverage scanner with advanced analysis.
 * Parses test sources + optional Mochawesome report  enriched-metadata.json
 *
 * Features:
 * - Multi-helper step extraction (I, customHelpers, etc)
 * - Assertion vs action classification
 * - Precondition-aware duplicate detection
 * - Advanced wait detection (I.wait, waitForElement, etc)
 * - Data-driven homogeneity analysis
 * - Semantic step equivalence grouping
 * - Fuzzy runtime matching with Levenshtein distance
 * - Confidence scoring for all findings
 * - Robust per-file error handling
 *
 * Usage:
 *   tsx scripts/scan.ts [options]
 *
 * Options:
 *   --tests       <glob>   Test file glob  (default: "tests/**\/*.{test,spec}.ts")
 *   --report      <path>   Mochawesome JSON report (optional)
 *   --out         <path>   Output file     (default: "reports/enriched-metadata.json")
 *   --config      <path>   Config file     (default: "audit.config.json")
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
  PreconditionInfo,
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
import { loadConfig, isAssertionKeyword, isWaitKeyword, createReverseEquivalenceMap, type AuditConfig } from './config.js';

//  Constants 

const SCAN_VERSION = '2.0.0';
/** Separator Mochawesome appends for Data() iterations: "Test name | {json}" */
const DATA_SEP = ' | ';
/** Max characters kept from a step's first argument before truncation */
const MAX_ARG_LEN = 60;

//  Utilities 

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }
  return matrix[b.length][a.length]!;
}


function printHelp(): void {
  console.log(`
Usage: tsx scripts/scan.ts [options]

Options:
  --tests       <glob>   Test file glob  (default: "tests/**/*.{test,spec}.ts")
  --report      <path>   Mochawesome JSON report (optional)
  --out         <path>   Output file     (default: "reports/enriched-metadata.json")
  --config      <path>   Config file     (default: "audit.config.json")
  --cwd         <path>   Project root (default: cwd)
  --help                 Show this help
`.trim());
}

const { values: argv } = parseArgs({
  options: {
    tests:   { type: 'string',  default: 'tests/**/*.{test,spec}.ts' },
    report:  { type: 'string' },
    out:     { type: 'string',  default: 'reports/enriched-metadata.json' },
    config:  { type: 'string',  default: 'audit.config.json' },
    cwd:     { type: 'string',  default: process.cwd() },
    help:    { type: 'boolean', default: false },
  },
  strict: true,
});

if (argv.help) { printHelp(); process.exit(0); }

const CWD = path.resolve(argv.cwd!);
let CONFIG: AuditConfig;

try {
  CONFIG = loadConfig(CWD);
  console.log(`[scan] Loaded config from: ${path.resolve(CWD, 'audit.config.json')}`);
  console.log(`[scan] Helpers: ${CONFIG.helpers.join(', ')}`);
  console.log(`[scan] Similarity threshold: ${CONFIG.similarity_threshold}`);
  console.log(`[scan] Subset threshold: ${CONFIG.subset_threshold}`);
} catch (err) {
  console.error('[scan] Failed to load config:', err);
  process.exit(1);
}

const EQUIV_MAP = createReverseEquivalenceMap(CONFIG.semantic_equivalences);

//  Normalisation helpers 

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
  return stripped.length > MAX_ARG_LEN ? stripped.slice(0, MAX_ARG_LEN) + '' : stripped;
}

function hashSteps(steps: NormalisedStep[]): string {
  return crypto.createHash('sha1').update(steps.join('\n')).digest('hex').slice(0, 12);
}

function extractInlineTags(name: string): string[] {
  return [...name.matchAll(/@([\w-]+)/g)].map((m) => m[1] as string);
}

//  AST  tag chain traversal 

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

//  AST  step extraction 

/**
 * Detect which identifiers in the callback params are helper objects.
 * Returns map of { paramName  helperIdentifier }. Includes 'I' by default.
 */
function resolveHelperParams(callback: Node, config: AuditConfig): Map<string, string> {
  const helpers = new Map<string, string>();

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
      const ident = el.getNameNode().getText();
      if (config.helpers.includes(prop)) {
        helpers.set(ident, prop);
      }
    }
  }

  // Ensure 'I' is always available
  if (!helpers.has('I')) {
    helpers.set('I', 'I');
  }

  return helpers;
}

interface StepExtractionResult {
  steps: NormalisedStep[];
  actionSteps: NormalisedStep[];
  assertionSteps: NormalisedStep[];
  waits: HardcodedWait[];
  customHelpers: string[];
  hasGrabAssertions: boolean;
}

function extractSteps(callback: Node, config: AuditConfig): StepExtractionResult {
  const steps: NormalisedStep[] = [];
  const actionSteps: NormalisedStep[] = [];
  const assertionSteps: NormalisedStep[] = [];
  const waits: HardcodedWait[] = [];
  const helpers = resolveHelperParams(callback, config);
  const customHelpers = new Set<string>();
  let hasGrabAssertions = false;

  callback.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    const obj = callee.getExpression();
    if (!Node.isIdentifier(obj)) return;

    const objName = obj.getText();
    const helperConfigName = helpers.get(objName);
    if (!helperConfigName) return;

    // Track custom helpers
    if (helperConfigName !== 'I') {
      customHelpers.add(helperConfigName);
    }

    const method = callee.getName();
    const args   = node.getArguments();
    const first  = args[0] ? normaliseArg(args[0].getText()) : '';
    const step = `${method}:${first}`;

    steps.push(step);

    // Classify step
    const isAssertion = isAssertionKeyword(config, method);
    const isWait = isWaitKeyword(config, method);

    if (isAssertion) {
      assertionSteps.push(step);
      if (method.startsWith('grab')) {
        hasGrabAssertions = true;
      }
    } else if (isWait) {
      actionSteps.push(step);
      // Flag waits
      if (method === 'wait' && args[0]) {
        const raw = args[0].getText().trim();
        if (/^\d+(\.\d+)?$/.test(raw)) {
          waits.push({ line: node.getStartLineNumber(), rawArg: raw, method: 'wait', masked: false });
        }
      } else if (config.wait_keywords.includes(method)) {
        // Advanced waits: waitForElement, waitForText, etc
        waits.push({ line: node.getStartLineNumber(), rawArg: first, method, masked: true });
      }
    } else {
      actionSteps.push(step);
    }
  });

  return {
    steps,
    actionSteps,
    assertionSteps,
    waits,
    customHelpers: Array.from(customHelpers),
    hasGrabAssertions,
  };
}

//  Precondition extraction 

/**
 * Extract Before/BeforeSuite hooks and create a normalized precondition.
 * Returns hash + steps for grouping tests by their setup context.
 */
function extractPrecondition(sf: SourceFile, config: AuditConfig): PreconditionInfo | undefined {
  const preconditionSteps: NormalisedStep[] = [];

  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee)) return;
    const name = callee.getText();
    if (name !== 'Before' && name !== 'BeforeSuite') return;

    const args = node.getArguments();
    if (args.length < 1) return;
    const callback = args[args.length - 1];
    if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return;

    const result = extractSteps(callback, config);
    preconditionSteps.push(...result.actionSteps);
  });

  if (preconditionSteps.length === 0) return undefined;

  const hash = crypto.createHash('sha1').update(preconditionSteps.join('\n')).digest('hex').slice(0, 12);
  return { hash, steps: preconditionSteps };
}

//  Data homogeneity analysis 

/**
 * Analyze Data() dataset to detect cosmetic (homogeneous) vs meaningful (heterogeneous) variation.
 * Returns true if all rows exercise the same code path (cosmetic variation).
 */
function analyzeDataHomogeneity(datasetNode: Node | undefined): { isHomogeneous: boolean; reason?: string } | undefined {
  if (!datasetNode || !Node.isArrayLiteralExpression(datasetNode)) return undefined;

  const elements = datasetNode.getElements();
  if (elements.length < 2) return undefined;

  // Check if all elements are object literals with only identity fields
  const identityFields = new Set(['email', 'username', 'name', 'id', 'user', 'account']);
  let allHomogeneous = true;

  for (const elem of elements) {
    if (!Node.isObjectLiteralExpression(elem)) {
      allHomogeneous = false;
      break;
    }

    const props = elem.getProperties();
    for (const prop of props) {
      if (!Node.isPropertyAssignment(prop)) {
        allHomogeneous = false;
        break;
      }
      const propName = prop.getChildAtIndex(0)?.getText() || '';
      if (!identityFields.has(propName.toLowerCase())) {
        allHomogeneous = false;
        break;
      }
    }
  }

  if (allHomogeneous) {
    return { isHomogeneous: true, reason: 'All rows differ only in identity fields' };
  }

  return { isHomogeneous: false };
}

//  AST  scenario extraction 
interface RawScenario {
  name:            string;
  line:            number;
  tags:            string[];
  dataDriven:      boolean;
  datasetSource:   string | undefined;
  /** 0 = unknown (dataset is an import, not an inline array) */
  iterations:      number;
  steps:           NormalisedStep[];
  actionSteps:     NormalisedStep[];
  assertionSteps:  NormalisedStep[];
  waits:           HardcodedWait[];
  customHelpers:   string[];
  hasGrabAssertions: boolean;
  precondition:    PreconditionInfo | undefined;
  dataHomogeneity: { isHomogeneous: boolean; reason?: string } | undefined;
  disabled:        boolean;
}

function extractScenariosFromFile(sf: SourceFile, config: AuditConfig): RawScenario[] {
  const results: RawScenario[] = [];
  const precondition = extractPrecondition(sf, config);
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
    let datasetNode: Node | undefined;
    let iterations = 0;

    //  Pattern A: Scenario('name', fn) / xScenario('name', fn) 
    if (Node.isIdentifier(callee)) {
      const name = callee.getText();
      if (name === 'Scenario')  { isScenario = true; }
      if (name === 'xScenario') { isScenario = true; isDisabled = true; }
    }

    //  Pattern B: Data(...).Scenario('name', fn) 
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
              datasetNode = dataArg;
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
    if (args.length < 2) return; // malformed  skip

    // First argument is always the name string literal
    const nameArg = args[0];
    if (!nameArg) return;
    const scenarioName = stripQuotes(nameArg.getText());

    // Last argument is the test callback
    const callbackArg = args[args.length - 1];
    if (!callbackArg) return;
    if (!Node.isArrowFunction(callbackArg) && !Node.isFunctionExpression(callbackArg)) return;

    const extraction = extractSteps(callbackArg, config);
    const chainTags           = collectChainTags(node);
    const inlineTags          = extractInlineTags(scenarioName);
    const allTags             = [...new Set([...chainTags, ...inlineTags])];

    if (isDisabled) allTags.push('disabled');

    const dataHomogeneity = isDataDriven ? analyzeDataHomogeneity(datasetNode) : undefined;

    results.push({
      name:             scenarioName,
      line:             node.getStartLineNumber(),
      tags:             allTags,
      dataDriven:       isDataDriven,
      datasetSource,
      iterations,
      steps:            extraction.steps,
      actionSteps:      extraction.actionSteps,
      assertionSteps:   extraction.assertionSteps,
      waits:            extraction.waits,
      customHelpers:    extraction.customHelpers,
      hasGrabAssertions: extraction.hasGrabAssertions,
      precondition,
      dataHomogeneity,
      disabled:         isDisabled,
    });
  });

  return results;
}

//  Mochawesome parsing 

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

//  Runtime matching 

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
  // Group by baseTitle  list of matching mocha entries
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

//  Similarity & subset detection 

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
  const stepSets = tests.map((t) => new Set(t.actionSteps));

  // Inverted index: step string  indices of tests that contain it
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

    // Candidate partners: tests sharing 1 step with i
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
      const exactMatch = testA.actionStepsHash === testB.actionStepsHash;
      
      // Precondition matching
      const preconditionsMatch = testA.precondition?.hash === testB.precondition?.hash;
      
      // Calculate confidence
      let confidence = sim * 100;
      if (exactMatch) confidence = Math.min(100, confidence * 1.15);
      if (preconditionsMatch) confidence = Math.min(100, confidence * 1.1);
      if (testA.customHelpers.length > 0 || testB.customHelpers.length > 0) {
        confidence *= 0.9; // Reduce confidence when custom helpers involved
      }
      
      const reason = exactMatch
        ? 'Identical action steps (exact match)'
        : `High similarity in action steps (${Math.round(sim * 100)}%)`;

      candidates.push({
        testAId:           testA.id,
        testBId:           testB.id,
        similarity:        Math.round(sim * 1000) / 1000,
        sharedSteps,
        exactMatch,
        confidence:        Math.round(confidence),
        reason,
        preconditionsMatch,
      });
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Find tests where A's steps are a subset (or prefix) of B's steps.
 * A may be a redundant smoke test if B is always run  or a valuable fast
 * check. Claude makes the final call; this only surfaces the candidates.
 */
function findSubsets(tests: LogicalTest[], config: AuditConfig): SubsetCandidate[] {
  const candidates: SubsetCandidate[] = [];

  for (let i = 0; i < tests.length; i++) {
    const shorter = tests[i]!;
    if (shorter.actionSteps.length === 0) continue;

    const shorterSet = new Set(shorter.actionSteps);

    for (let j = 0; j < tests.length; j++) {
      if (i === j) continue;
      const longer = tests[j]!;
      if (longer.actionSteps.length <= shorter.actionSteps.length) continue;

      const coveredCount = shorter.actionSteps.filter((s) => new Set(longer.actionSteps).has(s)).length;
      const coverageRatio = coveredCount / shorter.actionSteps.length;
      if (coverageRatio < config.subset_threshold) continue;

      // Don't flag if shorter test has grab assertions
      if (shorter.hasGrabAssertions) continue;

      // Order-sensitive prefix check (first N steps of shorter match first N of longer)
      const isPrefix = shorter.actionSteps.every((step, idx) => longer.actionSteps[idx] === step);

      let confidence = coverageRatio * 100;
      if (isPrefix) confidence = Math.min(100, confidence * 1.1);
      
      const reason = isPrefix
        ? `${shorter.name} is a prefix of ${longer.name}`
        : `${shorter.name} steps are ${Math.round(coverageRatio * 100)}% covered by ${longer.name}`;

      candidates.push({
        subsetTestId:   shorter.id,
        supersetTestId: longer.id,
        coverageRatio:  Math.round(coverageRatio * 1000) / 1000,
        isPrefix,
        confidence:     Math.round(confidence),
        reason,
      });
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

//  Main 

async function main(): Promise<void> {
  const testGlob  = argv.tests!;
  const outPath   = path.resolve(CWD, argv.out!);
  const reportArg = argv.report;

  console.log(`[scan] CWD:        ${CWD}`);
  console.log(`[scan] Tests glob: ${testGlob}`);
  console.log(`[scan] Similarity: ${SIMILARITY_THRESH}`);

  //  1. Discover test files 
  const files = await fg(testGlob, { cwd: CWD, absolute: true });
  if (files.length === 0) {
    console.warn('[scan] No test files found  check your --tests glob and --cwd');
    process.exit(1);
  }
  console.log(`[scan] Files found: ${files.length}`);

  //  2. Parse AST 
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  project.addSourceFilesAtPaths(files);

  const tests: LogicalTest[] = [];
  const fileErrors: Map<string, string> = new Map();

  for (const sf of project.getSourceFiles()) {
    const relFile = path.relative(CWD, sf.getFilePath()).replace(/\\/g, '/');
    let scenarios: RawScenario[] = [];

    try {
      scenarios = extractScenariosFromFile(sf, CONFIG);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      fileErrors.set(relFile, errMsg);
      console.warn(`[scan] Error parsing ${relFile}: ${errMsg}`);
      continue;
    }

    for (const s of scenarios) {
      // id uses file + line so it stays unique even if two scenarios share a name
      const id = `${relFile}:${s.line}`;
      const actionStepsHash = hashSteps(s.actionSteps);
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
        actionSteps:        s.actionSteps,
        assertionSteps:     s.assertionSteps,
        stepsHash:          hashSteps(s.steps),
        actionStepsHash,
        hardcodedWaitCount: s.waits.length,
        hardcodedWaits:     s.waits,
        precondition:       s.precondition,
        dataHomogeneity:    s.dataHomogeneity,
        customHelpers:      s.customHelpers,
        hasGrabAssertions:  s.hasGrabAssertions,
      });
    }
  }

  console.log(`[scan] Logical tests extracted: ${tests.length}`);
  if (fileErrors.size > 0) {
    console.log(`[scan] Parsing errors in ${fileErrors.size} files (continuing)`);
  }

  //  3. Parse Mochawesome report (optional) 
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

  //  4. Algorithmic detection 
  console.log('[scan] Computing duplicates');
  const duplicateCandidates = findDuplicates(tests, CONFIG.similarity_threshold);
  console.log(`[scan] Duplicate pairs: ${duplicateCandidates.length}`);

  console.log('[scan] Computing subsets');
  const subsetCandidates = findSubsets(tests, CONFIG);
  console.log(`[scan] Subset pairs:    ${subsetCandidates.length}`);

  //  5. Slow tests 
  const slowTests: SlowTest[] = Object.keys(runtime).length > 0
    ? tests
        .filter((t) => runtime[t.id])
        .sort((a, b) => (runtime[b.id]?.duration ?? 0) - (runtime[a.id]?.duration ?? 0))
        .slice(0, CONFIG.top_slowest_tests)
        .map((t, idx) => ({ testId: t.id, duration: runtime[t.id]!.duration, rank: idx + 1 }))
    : [];

  //  6. Summary 
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

  //  7. Write output 
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

