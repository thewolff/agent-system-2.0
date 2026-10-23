
# Accessibility Audit (WCAG 2.2 AA)

<!-- owned: agent-system 2.0 row #19 (DESIGN-2.0.md § C6.1) — interim base copied once from newdle-claude-plugins plugins/newdle/skills/newdle-a11y-audit at 2f7e67f8 (see skills/VENDOR.md); renamed `accessibility`, the plugin's "spawn the auditor agent first" block removed (a 2.0 judge hand runs this text itself; hands do not spawn), verdict-line skill name updated. Otherwise the plugin text as copied. -->

> Authored by Jo Wolff (Newdle).

---

Audit source files for WCAG 2.2 Level AA violations. Produce a severity-grouped review file under `.tmp/` and wait for the user before applying fixes.

## Workflow

### 1. Determine Scope

**If the user specifies a file or directory** — use that.

**Otherwise** — discover recently changed files:

```bash
git diff --name-only HEAD
git diff --cached --name-only
```

If nothing changed, fall back to `git diff --name-only HEAD~1 HEAD`.

Filter to auditable files: `.tsx`, `.ts`, `.jsx`, `.js`, `.css`, `.module.css`, `.html`.

### 2. Read and Analyze Each File

For every file in scope:

1. Read the full file content
2. Read the git diff (`git diff HEAD -- <file>`) to understand what changed
3. Run ReadLints for the file
4. Audit against every applicable category below

### 3. Audit Categories

For the full WCAG 2.2 AA criteria reference, see [WCAG-AA-CHECKLIST.md](WCAG-AA-CHECKLIST.md). The categories below are what to actively check in code.

---

#### A. Images & Non-Text Content (1.1.1)

- `<img>` must have meaningful `alt` (or `alt=""` + `aria-hidden="true"` if decorative)
- Icon-only buttons/links need `aria-label` or visually-hidden text
- `<svg>` needs `role="img"` + `<title>`, or `aria-hidden="true"` if decorative
- Background images conveying information must have a text alternative
- Emoji in content should have `aria-label` or be wrapped in `<span role="img">`

#### B. Semantic HTML & Document Structure (1.3.1, 1.3.2, 2.4.1, 2.4.6)

- Use native elements over ARIA: `<button>` not `<div onClick>`, `<a href>` not `<span onClick>`
- Heading hierarchy must not skip levels (`h1` → `h2` → `h3`)
- Lists use `<ul>`/`<ol>`/`<li>`, not styled divs
- Tables use `<th>`, `scope`, `<caption>` — not divs with grid layout for tabular data
- Landmark regions: `<main>`, `<nav>`, `<header>`, `<footer>`, `<aside>`
- Reading/DOM order matches visual order
- Skip navigation link present (or landmark navigation sufficient)

#### C. Forms & Labels (1.3.1, 3.3.1, 3.3.2, 4.1.2)

- Every input has a visible, associated `<label>` (via `htmlFor`/`id` or wrapping)
- `aria-describedby` for supplementary help text
- Required fields use `aria-required="true"` or `required` attribute
- Error messages are programmatically associated (`aria-describedby`, `aria-errormessage`)
- Error identification is specific — not just "invalid input"
- Form groups use `<fieldset>` + `<legend>`
- Autocomplete attributes present on personal data fields (`autocomplete="email"`, etc.)

#### D. Color & Contrast (1.4.1, 1.4.3, 1.4.11)

- Text contrast ratio: **4.5:1** (normal text), **3:1** (large text ≥18pt / bold ≥14pt)
- Non-text contrast: **3:1** for UI components (borders, icons, focus rings, form controls)
- Color is never the sole indicator of meaning (add icon, text, pattern, or underline)
- Check CSS for hardcoded colors — look for light-on-light or dark-on-dark combinations
- If a browser is available, use it to spot-check contrast on rendered pages

#### E. Keyboard & Focus (2.1.1, 2.1.2, 2.4.3, 2.4.7, 2.4.11)

- All interactive elements reachable via Tab key
- No keyboard traps (focus can always leave a component with Tab/Esc)
- Focus order is logical and follows visual layout
- `:focus-visible` styles are present and have **3:1** contrast
- `outline: none` or `outline: 0` without a replacement focus style is a violation
- Modals/dialogs trap focus correctly (focus stays inside, Esc closes)
- `tabIndex` > 0 is almost always wrong — flag it
- Custom components with `onClick` need `onKeyDown`/`onKeyUp` with Enter/Space handling

#### F. Interactive Components & ARIA (4.1.2, 4.1.3)

- ARIA roles match the component behavior (`role="dialog"`, `role="tablist"`, etc.)
- Required ARIA attributes are present (e.g., `aria-expanded` on disclosure triggers)
- `aria-live` regions for dynamic content updates (toasts, loading states, search results)
- Toggle buttons use `aria-pressed`, not just visual state changes
- Custom dropdowns/selects have proper listbox/combobox patterns
- Status messages use `role="status"` or `aria-live="polite"`
- No redundant ARIA (e.g., `role="button"` on `<button>`)

#### G. Text & Content (1.4.4, 1.4.5, 1.4.10, 1.4.12, 2.4.4, 2.5.3)

- Text resizes up to 200% without loss of content or functionality
- No images of text (use real text styled with CSS)
- Content reflows at 320px viewport width without horizontal scrolling
- Text spacing overridable (line height, letter/word spacing, paragraph spacing)
- Link text is descriptive — no bare "click here" or "read more" without context
- Visible labels match accessible names (`aria-label` should include visible text)

#### H. Motion & Time (2.2.1, 2.3.1, 2.3.3)

- Animated content respects `prefers-reduced-motion` media query
- No content flashes more than 3 times per second
- Auto-updating content can be paused, stopped, or hidden
- Time limits can be extended or turned off
- CSS transitions/animations have `prefers-reduced-motion: reduce` fallback

#### I. Error Prevention & Help (3.3.1, 3.3.3, 3.3.4)

- Errors are clearly identified and described in text
- Error suggestions are provided when possible
- Reversible actions for legal/financial/data submissions (confirm, review, undo)

### 4. Optional: Browser-Based Visual Audit

If the app is running locally (dev server), or can be started:

1. Navigate to the relevant page
2. Take a snapshot and visually inspect:
   - Focus ring visibility (Tab through interactive elements)
   - Color contrast on rendered elements
   - Zoom to 200% — check for content overflow or loss
   - Reflow at 320px width
3. Include browser findings in the plan alongside code findings

### 5. Generate Review File

**Location:** Active project workspace root (not the ai-skills repo). Create `.tmp/` if missing. Ensure `.gitignore` contains `.tmp/` (add it if absent). **Filename:** `.tmp/newdle-a11y-audit-YYYY-MM-DD-HHmmss.md` using the local timestamp at write time (include hours, minutes, and seconds). If that path already exists, append `-2`, `-3`, … before `.md` until unused.

**Verdict line:** before writing anything else, compute finding counts by severity (Critical→blocking, Warning→advisory, Suggestion→minor) and write this exact HTML comment as the file's first line, before the `#` heading — it's for tooling, not the human reader, so it must not otherwise appear in the rendered review:

```
<!-- accessibility-audit-verdict: skill=accessibility date=YYYY-MM-DD scope=<short-scope-slug> blocking=<n> advisory=<n> minor=<n> verdict=<clean|minor-only|findings> -->
```

`scope` is a short slug for what was audited (e.g. `working-tree`, or a filename stem), no spaces. `verdict=clean` when blocking, advisory, and minor are all 0; `verdict=minor-only` when blocking=0 and advisory=0 and minor>0; `verdict=findings` otherwise.

Write to that path:

```markdown
<!-- accessibility-audit-verdict: skill=accessibility date=YYYY-MM-DD scope=... blocking=N advisory=N minor=N verdict=... -->
# Accessibility Audit — [date]

> Auditing [N] files against WCAG 2.2 AA. [one-line scope summary]

## Critical (A violations)

Issues that make content inaccessible to entire groups of users.

### [C1] filename.tsx — Short description
**WCAG:** 1.1.1 Non-text Content
**Line(s):** NN–NN
**Issue:** Clear explanation of the violation.
**Fix:** Concrete remediation.
```diff
- <img src="hero.jpg" />
+ <img src="hero.jpg" alt="Team collaborating around a whiteboard" />
```
**Impact:** Who is affected and how (e.g., screen reader users cannot identify the image).

---

## Warning (AA concerns)

Issues that degrade the experience for users with disabilities.

### [W1] filename.tsx — Short description
**WCAG:** 2.4.7 Focus Visible
**Line(s):** NN–NN
**Issue:** Explanation.
**Fix:** Description.
**Impact:** Who is affected.

---

## Suggestion (best practices)

Not strict violations, but improvements to accessibility posture.

### [S1] filename.tsx — Short description
**WCAG:** Best practice
**Line(s):** NN–NN
**Issue:** Explanation.
**Fix:** Description.

---

## Summary

| Severity   | Count |
|------------|-------|
| Critical   | N     |
| Warning    | N     |
| Suggestion | N     |

### Affected WCAG Criteria
- 1.1.1 Non-text Content — N issues
- 2.4.7 Focus Visible — N issues
- ...

> Reply with the IDs to fix (e.g. "fix C1, W1, W3") or "fix all". Say "skip" for any you want to leave.
```

### 6. Severity Classification

| Severity | Criteria |
|----------|----------|
| **Critical** | Content completely inaccessible: missing alt text, no keyboard access, zero-contrast text, keyboard traps, missing form labels |
| **Warning** | Degraded experience: poor contrast (close to threshold), missing focus styles, non-descriptive link text, missing ARIA live regions, heading hierarchy skips |
| **Suggestion** | Best practices: redundant ARIA, `prefers-reduced-motion` absent, `tabIndex` cleanup, semantic element upgrades, autocomplete attributes |

### 7. Output Rules

- Every finding gets a unique ID: `C1`, `W1`, `S1`, etc.
- Always cite the WCAG criterion number and name
- Include diff snippets showing the exact fix
- Include **Impact** on Critical and Warning items (which users are affected)
- Keep descriptions concise — one or two sentences per issue
- Omit empty severity sections
- If no issues found, say so clearly

### 8. Present to User

After writing the review file, tell the user:
- The full file path
- Summary count (e.g., "Found 3 critical, 5 warnings, 2 suggestions across 4 files")
- Which WCAG criteria were most frequently violated
- Remind them they can reply with IDs to fix selectively

**Do NOT start fixing anything until the user explicitly asks.**
