# Mobile Stack Heuristics — CodeceptJS + WDIO/Appium

Apply these rules **on top of** `SKILL.md` during Stage 3, when reading the full
source of flagged mobile tests. These patterns are specific to CodeceptJS with the
WebDriverIO helper driving Appium (iOS/Android).

---

## 1. Platform duplication — iOS vs Android copies

The most common source of redundant mobile tests: the same scenario exists twice,
once for iOS and once for Android, with no meaningful difference in the test body.

### Pattern to recognise

```typescript
// android/checkout.spec.ts
Scenario('complete checkout @android', ({ I }) => {
  I.tap('Pay Now');
  I.waitForElement('~order-confirmed', 10);
  I.see('Order confirmed');
});

// ios/checkout.spec.ts
Scenario('complete checkout @ios', ({ I }) => {
  I.tap('Pay Now');
  I.waitForElement('~order-confirmed', 10);
  I.see('Order confirmed');
});
```

`scan.ts` will flag these as near-duplicates (high Jaccard). The key question is:
**does the test body exercise platform-specific code paths?**

| Scenario | Verdict |
|----------|---------|
| Same steps, same selectors, different file/tag | MERGE — use `Scenario` with `if (device.isAndroid())` or platform config |
| Same steps, different selectors (accessibility IDs differ) | KEEP — selector difference signals platform-specific UI |
| Same steps, one has extra `I.tap('Allow')` for OS permission dialog | KEEP — permission flows differ by platform |

**Rule:** Do not recommend merging platform-duplicates unless the step lists are
identical including all selectors and wait arguments.

---

## 2. Accessibility ID vs XPath selector fragility

Mobile selectors fall into two categories with very different reliability profiles:

| Selector type | Example | Risk |
|--------------|---------|------|
| Accessibility ID | `~add-to-cart-button` | Low — stable, recommended |
| XPath positional | `//android.widget.Button[2]` | High — breaks on layout change |
| UIAutomator2 | `-android uiautomator:new UiSelector().text("Pay")` | Medium — text-dependent |
| iOS Predicate String | `-ios predicate string:label == "Pay"` | Medium — text-dependent |
| XPath by text | `//*[@text="Add to cart"]` | High — brittle on i18n |

When reviewing flagged tests in Stage 3, note any XPath positional selectors in
the "Fragile Selectors" section. Do not recommend deletion — recommend selector
migration to accessibility IDs.

---

## 3. `I.wait()` context on mobile — higher thresholds are expected

Mobile tests legitimately need longer waits than web tests due to:
- App launch time (cold start: 3–8 s is normal)
- Animation durations (iOS spring animations, Android transitions)
- Network calls on real devices over cellular

**Adjusted thresholds for mobile:**

| Wait value | Web verdict | Mobile verdict |
|-----------|-------------|----------------|
| ≤ 3 s | Flag | Flag (still too short for app launch, probably wrong) |
| 3–10 s | Flag | Review — may be legitimate |
| > 10 s | Flag | Flag — replace with `waitForElement` with explicit condition |

When reviewing a `hardcoded_wait` candidate on mobile:
- Is it in a `Before` / `BeforeSuite` hook after `I.launchApp()`? Likely legitimate cold-start wait.
- Is it mid-test after a `tap`? Almost certainly should be `waitForElement`.
- Is it before an assertion? Always replace with `waitForText` or `waitForElement`.

---

## 4. Deep link vs manual navigation duplication

Mobile suites often have two versions of the same test: one navigates manually
(tap through UI), one uses a deep link to jump directly to the screen under test.

```typescript
// Manual navigation — tests the navigation path itself
Scenario('reach checkout via cart @regression', ({ I }) => {
  I.tap('~catalog-tab');
  I.tap('~product-1');
  I.tap('~add-to-cart');
  I.tap('~cart-tab');
  I.tap('~checkout-button');
  I.see('Checkout');
});

// Deep link — tests only the checkout screen
Scenario('checkout screen loads @smoke', ({ I }) => {
  I.openDeepLink('myapp://checkout');
  I.see('Checkout');
});
```

These are **not duplicates** — they cover different things:
- The deep link test verifies screen rendering and routing.
- The manual navigation test verifies the user journey to reach the screen.

**Rule:** Never merge a deep-link test with a manual-navigation test, even if
their final-screen assertions are identical.

---

## 5. `launchApp` / `closeApp` in test body (should be hooks)

`I.launchApp()` and `I.closeApp()` appearing inside a `Scenario` body (not in
`Before`/`After`) is a maintenance smell:

```typescript
// Smell — app lifecycle inside test body
Scenario('login flow', ({ I }) => {
  I.launchApp();           // ← should be in Before()
  I.fillField('~email', 'user@example.com');
  I.tap('~login-button');
  I.closeApp();            // ← should be in After()
});
```

This pattern inflates the step count of every test and causes `scan.ts` to see
`launchApp:` and `closeApp:` as shared steps in Jaccard comparisons — reducing
the similarity score of tests that are otherwise identical.

**When reviewing subset/duplicate candidates:** if both tests in a pair contain
`launchApp:` and `closeApp:` steps, strip those from the mental comparison before
judging similarity. The meaningful steps are everything in between.

**Action:** Note in the report as "App lifecycle steps should move to Before/After
hooks to reduce noise in similarity analysis and improve parallelisation."

---

## 6. Capability-gated steps invisible to scan.ts

Appium tests often branch on device capabilities at runtime:

```typescript
Scenario('biometric login', ({ I }) => {
  if (driver.capabilities.biometricAuth) {
    I.tap('~use-face-id');
    I.performBiometricAuth(true);
  } else {
    I.fillField('~pin', '1234');
    I.tap('~confirm-pin');
  }
  I.see('Home');
});
```

`scan.ts` captures **both** branches as steps (`tap:~use-face-id` AND
`fillField:~pin`). The Jaccard comparison will include steps that may never
execute together on the same device.

**Rule:** When a test contains capability-gated branches, its similarity score
against other tests is unreliable. Flag the candidate as REVIEW and note:
"Test contains conditional capability branching — Jaccard score may be inflated."

---

## 7. Gesture steps and their web equivalents

`scan.ts` normalises steps uniformly, but mobile gesture steps have no web
equivalent and should never be flagged as duplicates of web tests:

| Mobile step | Web non-equivalent |
|------------|-------------------|
| `I.swipeLeft('~carousel')` | `I.click('Next')` |
| `I.pinch('~map', 0.5)` | — |
| `I.longPress('~message')` | `I.rightClick('message')` |
| `I.scrollIntoView('~footer')` | `I.scrollTo('footer')` |

If you are auditing a mixed web+mobile suite (same CodeceptJS project, different
helpers), ensure the `--tests` glob for mobile is run separately from web so
cross-platform Jaccard comparisons do not occur.

---

## 8. Never-run tests — mobile-specific causes

Mobile tests have additional reasons to be absent from the Mochawesome report
beyond those listed in `SKILL.md`:

| Cause | Signal | Action |
|-------|--------|--------|
| Device/emulator not available in CI | Test exists but no runs at all | Check CI device farm config |
| OS version gate (`@ios16+`) | Tag present, device was lower version | Not a dead test — verify tag is correct |
| Flaky test quarantined manually | `xScenario` or `.skip` added without ticket | Require tracking ticket before re-enabling |
| Platform not yet implemented | `// TODO: implement for Android` comment | Flag as "unimplemented" not "dead" |

---

## Quick reference checklist for Stage 3 (mobile)

When reading the full source of a flagged mobile test:

- [ ] Is it an iOS/Android platform-copy? Check if selectors differ before merging.
- [ ] Does it use deep links vs manual navigation? If so, keep both.
- [ ] Does it contain `launchApp`/`closeApp` in the body? Strip from similarity mental model.
- [ ] Does it branch on device capabilities? Mark Jaccard score as unreliable.
- [ ] Does it use XPath positional selectors? Note as fragile selector, not for deletion.
- [ ] Are `I.wait(n)` values in the 3–10 s range? Review context (cold start vs mid-flow).
- [ ] Is it tagged `@ios` or `@android` only? Verify the CI matrix covers that platform.
- [ ] Is it tagged `@smoke` or `@critical`? Move to "Do Not Touch" regardless of findings.
