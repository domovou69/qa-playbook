/**
 * Enriched metadata types produced by scan.ts and consumed by the Claude audit prompt.
 *
 * Design constraints:
 *  - Must fit in ~15-25k tokens when serialised as JSON.
 *  - Data().Scenario() expansions are collapsed to ONE LogicalTest (dataDriven: true).
 *  - Step normalisation: "method:firstArg" strings, not raw AST.
 */

// ---------------------------------------------------------------------------
// Source-level representation
// ---------------------------------------------------------------------------

/** A single normalised step extracted from a test body, e.g. "click:Submit" */
export type NormalisedStep = string;

/** SHA-1 or xxhash of the joined NormalisedStep[] for fast equality checks */
export type StepsHash = string;

/**
 * One logical test as it appears in source code.
 * A Data().Scenario() with N rows is still ONE LogicalTest (dataDriven: true, iterations: N).
 */
export interface LogicalTest {
  /** Unique key: relative file path + ":" + scenario name */
  id: string;

  /** Raw scenario title as written in source (without dataset suffixes) */
  name: string;

  /** Relative path from project root, e.g. "tests/checkout/payment.test.ts" */
  file: string;

  /** 1-based line of the Scenario() / Data().Scenario() declaration */
  line: number;

  /** Tags extracted from .tag('x') chains or @tag tokens in the name */
  tags: string[];

  /** Whether this test is wrapped in Data() */
  dataDriven: boolean;

  /** Number of dataset rows; 0 when dataDriven is false */
  iterations: number;

  /**
   * Import alias or file path of the dataset, e.g. "checkoutData" or
   * "./data/checkout.ts". Undefined when dataDriven is false.
   */
  datasetSource?: string;

  /** Normalised step sequence extracted from the test body */
  steps: NormalisedStep[];

  /** Action steps only (excluding assertions like see, dontSee, grab*) */
  actionSteps: NormalisedStep[];

  /** Assertion steps (see, dontSee, grabTextFrom, etc) */
  assertionSteps: NormalisedStep[];

  /** Hash of steps[] — primary key for duplicate/subset detection */
  stepsHash: StepsHash;

  /** Hash of actionSteps[] — for comparison without assertions */
  actionStepsHash: StepsHash;

  /** Number of I.wait(n) calls with a numeric literal argument */
  hardcodedWaitCount: number;

  /** Every I.wait(n) occurrence: line number + millisecond/second value */
  hardcodedWaits: HardcodedWait[];

  /** Precondition (Before/BeforeSuite) for this test, if any */
  precondition?: PreconditionInfo;

  /**
   * For Data() tests: whether all dataset rows are cosmetically identical
   * (differ only in identity fields with no code path branching)
   */
  dataHomogeneity?: {
    isHomogeneous: boolean;
    reason?: string;
  };

  /** Helpers injected beyond 'I' (e.g., loginPage, api, dbHelper) */
  customHelpers: string[];

  /** Whether test uses grab* methods with assertions */
  hasGrabAssertions: boolean;
}

export interface HardcodedWait {
  line: number;
  /** Raw first argument as written, e.g. "3" or "1000" */
  rawArg: string;
  /** Which helper method: wait, waitForElement, waitForText, etc. */
  method: string;
  /** Whether this is a masked wait (waitForElement) vs explicit wait() */
  masked: boolean;
}

/**
 * Precondition extracted from Before/BeforeSuite hooks.
 * Used to group tests by their setup context for accurate duplicate detection.
 */
export interface PreconditionInfo {
  /** Hash of the normalized precondition steps */
  hash: string;
  /** Normalized precondition steps */
  steps: NormalisedStep[];
  /** Line where precondition is defined */
  line?: number;
}

// ---------------------------------------------------------------------------
// Mochawesome runtime data (optional — only present when --report is supplied)
// ---------------------------------------------------------------------------

export type TestState = 'passed' | 'failed' | 'pending' | 'skipped';

export interface RuntimeStats {
  /** Aggregate duration in ms (sum across all Data() iterations) */
  duration: number;

  /** Outcome of the last known run */
  state: TestState;

  /**
   * Mochawesome speed bucket — 'fast' | 'medium' | 'slow' | undefined.
   * Absent when not reported.
   */
  speed?: string;

  /** How many times this test appears across ALL suites in the report */
  runCount: number;
}

// ---------------------------------------------------------------------------
// Algorithmic findings (computed entirely in scan.ts, no LLM)
// ---------------------------------------------------------------------------

/** Two tests whose normalised step sequences are suspiciously similar */
export interface DuplicateCandidate {
  testAId: string;
  testBId: string;
  /** Jaccard similarity of step sets, 0–1 (order-insensitive) */
  similarity: number;
  /** Shared steps present in both tests */
  sharedSteps: NormalisedStep[];
  /** True when stepsHash values are identical — guaranteed fully redundant ordering */
  exactMatch: boolean;
  /** Confidence score 0-100 based on matching criteria */
  confidence: number;
  /** Reason for the finding */
  reason: string;
  /** Whether preconditions match (null if preconditions differ) */
  preconditionsMatch?: boolean;
}
/**
 * Test A whose steps are a prefix or strict subset of test B's steps.
 * A may be redundant IF test B is always run.
 */
export interface SubsetCandidate {
  subsetTestId: string;
  supersetTestId: string;
  /** Fraction of subsetTest's steps covered by supersetTest */
  coverageRatio: number;
  /** Whether subsetTest's steps form a contiguous prefix of supersetTest's */
  isPrefix: boolean;
  /** Confidence score 0-100 */
  confidence: number;
  /** Reason for the finding */
  reason: string;
}

// ---------------------------------------------------------------------------
// Top-level output written to enriched-metadata.json
// ---------------------------------------------------------------------------

export interface ScanMeta {
  /** ISO-8601 timestamp of when scan.ts was run */
  scannedAt: string;
  /** Globs / paths that were scanned */
  testGlob: string;
  /** Mochawesome report file path, if used */
  reportPath?: string;
  /** scan.ts version string for reproducibility */
  scanVersion: string;
}

export interface EnrichedMetadata {
  meta: ScanMeta;

  /** All logical tests found in source */
  tests: LogicalTest[];

  /**
   * Runtime data keyed by LogicalTest.id.
   * Absent entries = test was never run / not in the report.
   */
  runtime: Record<string, RuntimeStats>;

  /** Tests present in source but absent from the Mochawesome report */
  neverRun: string[]; // LogicalTest.id[]

  /** Algorithmically detected duplicate pairs */
  duplicateCandidates: DuplicateCandidate[];

  /** Algorithmically detected subset pairs */
  subsetCandidates: SubsetCandidate[];

  /**
   * Top-N slowest tests by aggregate duration.
   * Only populated when --report is supplied.
   */
  slowTests: SlowTest[];

  /** Summary counts for quick orientation */
  summary: ScanSummary;
}

export interface SlowTest {
  testId: string;
  duration: number;
  /** Rank: 1 = slowest */
  rank: number;
}

export interface ScanSummary {
  totalLogicalTests: number;
  dataDrivenTests: number;
  /** Total runtime iterations across all Data() tests */
  totalDataIterations: number;
  neverRunCount: number;
  duplicatePairCount: number;
  subsetPairCount: number;
  hardcodedWaitTestCount: number;
  /** Only when --report supplied */
  avgDurationMs?: number;
}
