import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Configuration for coverage-audit scanner.
 * Loaded from audit.config.json if present, otherwise defaults.
 */
export interface AuditConfig {
  /** Helper object names to extract steps from (e.g., ["I", "loginPage", "api"]) */
  helpers: string[];

  /** Jaccard threshold for duplicate detection (0-1) */
  similarity_threshold: number;

  /** Coverage ratio threshold for subset detection (0-1) */
  subset_threshold: number;

  /** Milliseconds threshold for warning on wait timeouts */
  wait_timeout_warning_ms: number;

  /** Milliseconds threshold for flagging slow tests */
  slow_test_threshold_ms: number;

  /** Number of slowest tests to surface in report */
  top_slowest_tests: number;

  /** Keywords that indicate assertion steps (see, dontSee, grab*, etc) */
  assertion_keywords: string[];

  /** Keywords that indicate wait steps */
  wait_keywords: string[];

  /** Semantic equivalence mapping: concept → [method names] */
  semantic_equivalences: Record<string, string[]>;
}

const DEFAULT_CONFIG: AuditConfig = {
  helpers: ['I'],
  similarity_threshold: 0.85,
  subset_threshold: 0.9,
  wait_timeout_warning_ms: 10000,
  slow_test_threshold_ms: 60000,
  top_slowest_tests: 20,
  assertion_keywords: [
    'see',
    'dontSee',
    'seeInCurrentUrl',
    'dontSeeInCurrentUrl',
    'seeInSource',
    'dontSeeInSource',
    'seeAttributesOnElements',
    'seeCheckboxIsChecked',
    'dontSeeCheckboxIsChecked',
    'seeInField',
    'dontSeeInField',
    'seeInPopup',
    'grabTextFrom',
    'grabValueFrom',
    'grabAttributeFrom',
    'grabCssPropertyFrom',
    'grabNumberOfOpenTabs',
    'grabCurrentUrl',
    'grabCurrentUrlPath',
    'grabTitle',
  ],
  wait_keywords: [
    'wait',
    'waitForElement',
    'waitForText',
    'waitForVisible',
    'waitForFunction',
    'waitForNavigation',
    'waitForEnabled',
    'waitInUrl',
  ],
  semantic_equivalences: {
    fill_field: ['fillField', 'fill', 'setValue', 'attachFile'],
    click: ['click', 'clickCss', 'checkOption', 'uncheckOption', 'selectOption', 'selectMultiple', 'pressKey'],
    navigate: ['amOnPage', 'amOnUrl', 'openNewTab'],
    wait_for: ['wait', 'waitForElement', 'waitForText', 'waitForVisible', 'waitForFunction'],
  },
};

export function loadConfig(cwd: string): AuditConfig {
  const configPath = path.resolve(cwd, 'audit.config.json');

  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AuditConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    console.warn(`[config] Failed to parse ${configPath}, using defaults:`, err);
    return DEFAULT_CONFIG;
  }
}

export function createReverseEquivalenceMap(
  equivalences: Record<string, string[]>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [concept, methods] of Object.entries(equivalences)) {
    for (const method of methods) {
      map.set(method, concept);
    }
  }
  return map;
}

export function isAssertionKeyword(config: AuditConfig, methodName: string): boolean {
  return config.assertion_keywords.some((kw) => methodName.startsWith(kw));
}

export function isWaitKeyword(config: AuditConfig, methodName: string): boolean {
  return config.wait_keywords.some((kw) => methodName.startsWith(kw));
}
