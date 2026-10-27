# Upkeep evidence and report recipe

This is Jo's upkeep requirement and the skill's collection method, not Graham's judgment. Use it for **every package or tool recommended**, whether comparables research was approved, declined, or unavailable. It is not a new gate. Complete essential compatibility, license, privacy, and security gates using the comparables criteria; missing upkeep evidence alone never fails a gate or makes an otherwise supported requirement unknown.

## Collect each candidate

Record the collection date (`asOf`), selected artifact/version or commercial plan, and the disclosed activity window. Default to the trailing six calendar months ending on the collection date. Keep evidence candidate-specific and dated. Use inspected local records and installed machine evidence in a no-web run; do not fetch remote evidence when the user declined research. Mark remote-only or inaccessible facts unknown and state why. Silence is not consent; while the comparables answer is pending, do not run web research or produce a verdict.

For each candidate collect the following five fields. Each positive value needs a receipt; missing, private, inaccessible, malformed, or unreceipted values are `unknown`, never zero or a guess.

1. **Last commit:** record the last actual default-branch commit date, distinguishing bot/docs churn from substantive human work. For commercial tools where public commits do not apply, mark that field inapplicable and use dated vendor continuity/support evidence.
2. **Last release:** record the latest release in the selected channel and its date; check registry/tag history when GitHub releases are absent. Recent commits do not clear a stale-release warning.
3. **Issue responsiveness:** record opened and closed issue counts for the same window and disclose whether totals are sampled. Sample a bounded, disclosed set of recent non-PR issues in the window. Report sample size, median first *human* response time, and unanswered count; exclude bot replies. A zero-eligible-issue sample means unmeasurable, not immediate response. Name relevant unresolved blockers. For commercial tools mark public issue data inapplicable or undisclosed.
4. **Active human maintainers:** record evidenced active humans during the window and concentration. Do not substitute lifetime contributors, organization headcount, or bots. Unknown stays unknown.
5. **Runtime compatibility:** identify relevant runtimes from selected artifact manifests/support matrix and the current project's runtime requirements. In Jo's actual project context use read-only executable lookup followed by direct version commands only for relevant runtimes (for example, `command -v node` then `node --version`; likewise Bun, Python, Ruby, Go, Rust, or a relevant host CLI). Record executable path, exact command, raw output, and collection date. A manifest or project pin is intended-version evidence, not proof the runtime is installed; call out mismatches. A remote sandbox is not Jo's machine: local discovery is unavailable there. Missing executables, failed commands, unavailable local shell, unparseable output, or absent version-specific support evidence produce explicit `unknown` with command/error/reason, not a guessed version or generic “works”. Compare observed installed versions against support documentation for the selected candidate version or an authorized, directly observed trial. Label docs-supported versus tested; never imply a trial ran when it did not. Inspect local binaries only: do not install or execute a candidate.

**Receipts:** each fact needs an actual fetched URL and observed result, or exact command/output anchor and date. Identify candidate/version, window or sample as applicable, and why unknown fields are unknown. A URL alone or project manifest alone is not evidence of an installed runtime.

## Warnings and ranking

Show a conspicuous `**Upkeep warning:**` whenever a release has been absent for six calendar months or more, active human maintainer count is one or zero, measurable human issue-response evidence is absent, or required upkeep evidence is missing. State the particular evidence and risk, plus a candidate-specific exit path: a named alternative, removable interface, pin/fork with an identified owner, or data export. Unknown maintainer count is missing evidence, not zero. Six months is a signal, not proof of abandonment; quiet mature projects can still rank first when fit justifies the risk.

The inclusive six-calendar-month boundary is calendar-based in UTC and clamped at month ends. Do not treat a newer commit as a release. Upkeep may inform qualitative ranking among suitable candidates and explain tradeoffs; never calculate a health score or use upkeep as an eligibility/rejection gate. Do not let upkeep strengths cancel an actual failed essential requirement. Stars and repository age are context only: never scored, gated, or used as a tie-breaker. Commercial/vendor continuity fields apply the same warning discipline; mark genuinely inapplicable fields and unavailable evidence explicitly.

## Helper interface and invocation

Use the installed skill's `scripts/upkeep.mjs` helper when available. It is a pure formatter, not a collector: it fetches nothing, discovers/runs no runtime or candidate, installs nothing, and makes no ranking or gate decision. Prepare evidence yourself, then supply a JSON evidence file to the CLI:

```sh
node <this skill's directory>/scripts/upkeep.mjs <path-to-evidence.json>
```

Use the helper's exported `renderUpkeep` for programmatic formatting. Preserve the exact JSON contract:

```json
{
  "candidate": "selected name/version",
  "asOf": "YYYY-MM-DD",
  "window": "disclosed activity interval",
  "exitPath": "candidate-specific feasible exit",
  "lastCommit": { "date": "YYYY-MM-DD or null", "receipt": "actual source/result", "reason": "optional unknown reason" },
  "lastRelease": { "date": "YYYY-MM-DD or null", "receipt": "actual source/result", "reason": "optional unknown reason" },
  "issues": {
    "opened": "number or null",
    "closed": "number or null",
    "sampleSize": "number or null",
    "unanswered": "number or null",
    "medianFirstHumanResponseHours": "number or null",
    "receipt": "actual source/result",
    "reason": "optional unknown reason"
  },
  "maintainers": { "count": "number or null", "receipt": "actual source/result", "reason": "optional unknown reason" },
  "compatibility": [
    {
      "runtime": "runtime name",
      "installed": "observed version or null",
      "detectionReceipt": "path, exact command, output and date, or explicit failure",
      "status": "supported | unsupported | unknown",
      "supportReceipt": "version-specific documentation/trial evidence or explicit reason",
      "reason": "optional unknown reason"
    }
  ]
}
```

Field types are literal: dates are `YYYY-MM-DD` or `null`; counts and median are numbers or `null`; compatibility is an array. Use actual JSON nulls, not the quoted explanatory strings above. Every record has its receipt string; absent/null values and missing records become unknown, using `reason` or “not collected”. A positive value without its receipt renders unknown and warns. Missing or empty compatibility is explicitly unknown, never compatible. Malformed dates must not yield a healthy result. The helper output is `**Upkeep — <candidate>:**` with all five fields, receipts, date/window and any triggered warnings with exit path. It contains no gate verdict, rank score, or recommendation boolean. If the helper cannot run, manually preserve these same fields and warnings and state the execution limit; do not weaken the contract.

Attach the resulting line to the candidate's comparison entry, or provide a clearly associated upkeep section for every recommended candidate. In a no-web/local-only recommendation, retain the line with remote-only values unknown and the reason that research was declined; never silently omit upkeep or bypass consent.
