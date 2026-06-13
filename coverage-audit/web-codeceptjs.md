# Web Stack Heuristics — CodeceptJS + Playwright

Apply these rules **on top of** `SKILL.md` during Stage 3, when reading the full
source of flagged tests. These patterns are specific to CodeceptJS with the
Playwright helper and common project conventions.

---

## 1. Duplicate masking via PageObject vs direct `I.` calls

`scan.ts` normalises steps to `method:firstArg`. This means two tests that do
the same thing via different abstractions can produce **different step sequences**
and therefore a **low Jaccard score** — even though they are functionally identical.

### Pattern to recognise

```typescript
// Test A — direct I. calls
Scenario('login with valid credentials', ({ I }) => {
  I.amOnPage('/login');
  I.fillField('Email', 'user@example.com');
  I.fillField('Password', 'secret');
  I.click('Sign in');
  I.see('Dashboard');
});

// Test B — PageObject
Scenario('user can log in', ({ I, loginPage }) => {
  loginPage.open();
  loginPage.fillCredentials('user@example.com', 'secret');
  loginPage.submit();
  I.see('Dashboard');
});
```

`scan.ts` sees completely different step lists (one has `fillField:Email`, the
other has `fillCredentials:user@example.com`). Jaccard ≈ 0.1. They will **not**
appear as duplicate candidates.

### How to catch this in Stage 3

When reading flagged tests, look for:
- Tests whose `name` strings are semantically similar (login / sign in / authenticate).
- Tests in the same file or the same feature suite that cover the same user goal.
- One test using named page-object inject params (`{ I, loginPage }`) and another
  using only `{ I }` — suggests one wraps the other's actions.

**Action:** flag as REVIEW with note "possible PageObject/direct-call duplicate —
manual step-through required".

---

## 2. Custom step helpers under non-standard names

CodeceptJS projects often inject custom actor helpers:

```typescript
// codecept.conf.ts
helpers: {
  MyHelper: { require: './helpers/MyHelper.ts' }
}

// In tests
Scenario('...', ({ I, myHelper }) => {
  myHelper.loginAs('admin');
  I.see('Admin panel');
});
```

`scan.ts` only captures `I.xxx()` calls (configurable via helper name detection).
Steps dispatched via `myHelper`, `api`, `dbHelper`, `mailHelper`, etc. are
**invisible to the scanner**.

### Implication for duplicate detection

A test that calls `myHelper.loginAs('admin')` and a test that calls
`I.fillField('Username', 'admin') + I.click('Login')` look unrelated in metadata
but may do exactly the same thing.

### How to catch this in Stage 3

- Look for inject params beyond `{ I }` in the test callback signature.
- If the non-I helper is a login/setup/teardown helper, count it as a precondition,
  not a unique step. Focus Jaccard comparison on the *action steps* after setup.
- If the helper performs assertions (e.g. `dbHelper.assertOrderCreated()`), that
  assertion is invisible — do not recommend removing a test on the assumption that
  `I.see('Order confirmed')` covers the same thing.

**Rule:** Never flag a test as a duplicate of another if one of them uses a
non-standard helper and you cannot see that helper's implementation.

---

## 3. Masked waits — `waitForElement` chains disguising `I.wait()`

`scan.ts` catches `I.wait(n)` with numeric literals. But projects often wrap waits:

```typescript
// Looks clean — scan.ts misses this
I.waitForElement('.spinner', 30);       // 30 second timeout
I.waitForElement('[data-loaded]', 10);

// Or inside page objects
loginPage.waitUntilReady();  // internally calls I.wait(5)
```

### What to look for in Stage 3

When reviewing `hardcoded_wait` candidates, also check for:
- `waitForElement` / `waitForText` / `waitForVisible` called with an explicit
  seconds argument **larger than 10**. These are not flagged by scan.ts but are
  worth reviewing (Playwright default is 30 s; anything beyond that is suspicious).
- Helper methods whose name includes `wait`, `sleep`, or `ready` — skim the helper
  source if accessible.

**Action:** Add to the "Hardcoded Waits" section of the report with a note:
"timeout value in `waitForElement` exceeds Playwright default — verify it is not
compensating for a flaky selector or missing network-idle state".

---

## 4. Data-driven tests with homogeneous datasets

`scan.ts` correctly collapses `Data([...]).Scenario()` to one logical test.
But not all Data() usage is equivalent:

### Pattern A — genuinely parallel paths (keep all rows)

```typescript
Data([
  { cardType: 'visa',       number: '4111...' },
  { cardType: 'mastercard', number: '5555...' },
  { cardType: 'amex',       number: '3714...' },
]).Scenario('checkout with card type', ({ I, current }) => {
  // Each row tests a different payment processor code path
});
```

Different rows → different code paths → retain all iterations.

### Pattern B — cosmetic variation (merge or reduce)

```typescript
Data([
  { username: 'alice@example.com' },
  { username: 'bob@example.com' },
  { username: 'charlie@example.com' },
]).Scenario('user can log in', ({ I, current }) => {
  // Every row hits the exact same code path; only the fixture data differs
});
```

Three rows, one code path → one row is sufficient. This will **not** be flagged
by scan.ts (iterations ≠ duplicate test) but should be flagged by Claude in Stage 3.

### How to recognise Pattern B

- The dataset rows differ only in `email`, `username`, `name`, or other identity
  fields that have no conditional branching in the test body.
- The test body has **no `if/switch`** and no `current.someFlag` checks.
- All rows are expected to `pass` with the same final `see:` assertion.

**Action:** Flag as "DATA REDUNDANCY — reduce to 1 representative row; use
fixtures for boundary cases, not arbitrary additional users".

---

## 5. Selector fragility signals (not in scan.ts — visual inspection only)

When reading test source in Stage 3, note selectors that make a test brittle:

| Selector pattern | Risk | Better alternative |
|-----------------|------|-------------------|
| `I.click('//div[3]/span[2]')` | XPath with positional index | `[data-testid]` or semantic label |
| `I.fillField('#field_12345')` | Auto-generated ID | `aria-label` or `name` attribute |
| `I.see('© 2024 Acme Corp')` | Copyright string, changes yearly | Page title or structural element |
| `I.click({ css: '.btn.btn-primary:last-child' })` | Layout-dependent | `[data-action="submit"]` |

Do **not** recommend test deletion for selector fragility. Recommend selector
improvement in a separate section ("Fragile Selectors") so it can be tracked
independently of the audit.

---

## 6. `Before` / `BeforeSuite` duplication across files

`scan.ts` does not parse `Before()` / `BeforeSuite()` hooks. These frequently
contain duplicated setup logic that inflates test runtime and hides shared
preconditions.

### What to look for

When Stage 3 pulls a test file, glance at the top of the file for:

```typescript
BeforeSuite(({ I }) => {
  I.amOnPage('/');
  I.login('admin@example.com', 'password');
});
```

If the same (or near-identical) `BeforeSuite` block appears in multiple files
covering the same feature area, that is a maintenance risk — not a test duplicate,
but worth noting in the "Priority Action List" as:
"Extract shared login/setup into a reusable `loginAs` step in the actor helper".

---

## 7. `Feature()` scope as a duplicate signal

In CodeceptJS, `Feature('Checkout')` is a suite label. Two tests in different
`Feature` blocks with the same name are structurally separate but may be
functionally identical.

`scan.ts` uses `file:line` as the id, so cross-file same-name tests are tracked
independently. When reviewing candidates, if two tests share:
- Same or very similar `name`
- Different `file` but same `Feature` label (readable from the source)
- High Jaccard similarity

…treat this as a higher-confidence duplicate than same-name tests in different
features.

---

## 8. `grab*` calls as hidden assertions

CodeceptJS `I.grabTextFrom()`, `I.grabAttributeFrom()`, etc. are invisible to
Jaccard similarity (they produce steps like `grabTextFrom:.price`) but are
functionally assertions when their return value is used in a comparison.

```typescript
const price = await I.grabTextFrom('.price');
expect(price).toContain('$');
```

A test containing `grab*` + `expect()` may look like a subset of a test that uses
`I.see()` — but it is asserting something that `I.see()` cannot express.

**Rule:** Never flag a test as a subset of another if it contains a `grab*` call
whose return value is compared — even if the step-level Jaccard is high.

---

## 9. Mobile-specific placeholder

> `mobile-codeceptjs.md` covers WDIO/Appium patterns.
> Do not apply web heuristics (selectors, PageObject patterns, Playwright-specific
> waitFor behaviour) to mobile test audits.

---

## Quick reference checklist for Stage 3 (web)

When reading the full source of a flagged test:

- [ ] Does it use a non-`I` helper? If yes, cannot confirm duplicate without helper source.
- [ ] Does it use `grab*` + `expect()`? If yes, remove from subset candidates.
- [ ] Is it a `Data().Scenario()` with a homogeneous dataset? Flag for data reduction.
- [ ] Does it rely on a `BeforeSuite` that is duplicated elsewhere? Note as shared-setup smell.
- [ ] Are there `waitForElement(sel, N)` calls with N > 10? Add to hardcoded-wait section.
- [ ] Do its selectors use positional XPath or auto-generated IDs? Note as fragile selector.
- [ ] Is the test semantically similar to another in the same `Feature`? Escalate confidence.
- [ ] Is it tagged `@smoke` or `@critical`? Move to "Do Not Touch" regardless of scan findings.
