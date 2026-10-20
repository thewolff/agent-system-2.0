# Deploy risk: what escalates a deploy, and why

A lane may run a routine deploy without Jo. A deploy reaches Jo only when a written, mechanically checked condition holds. This page is the research behind those conditions and the conditions themselves. The code is `gates/src/deploy-risk.ts`; the ruling is [SPEC-2.0.md](../SPEC-2.0.md) § A4, *Amended 2026-10-20*; the design is plan rev 9 of workload wl-mvgorfqqbuyyo0.

Every source was fetched while the plan was written. Each factor below names its source id, or is labelled GUESS. A deploy that is not the one routine shape (a `workflow_dispatch` run whose bash command equals a declared target's command byte for byte, from a lane) stays reserved.

## Sources

| id | Source (URL fetched) | Passage relied on |
|---|---|---|
| S1 | Google SRE book, Introduction — https://sre.google/sre-book/introduction/ | "SRE has found that roughly 70% of outages are due to changes in a live system." |
| S2 | SRE workbook, Canarying releases — https://sre.google/workbook/canarying-releases/ | "a majority of incidents are triggered by binary or configuration pushes"; "releasing more often means fewer changes are bundled … Smaller, self-contained release artifacts make it cheaper and easier to roll back" |
| S3 | DORA, Streamlining change approval — https://dora.dev/capabilities/streamlining-change-approval/ | external approval (CAB/senior manager) has "a negative impact on software delivery performance … no evidence was found to support the hypothesis that a more formal, external review process was associated with lower change fail rates"; approvals are best "through peer review during the development process, supplemented by automation" |
| S4 | DORA, Working in small batches — https://dora.dev/capabilities/working-in-small-batches/ | "working in small batches predicts software delivery performance" |
| S5 | DORA, Database change management — https://dora.dev/capabilities/database-change-management/ | "Database changes are often a major source of risk and delay when performing deployments." |
| S6 | AWS Builders' Library, Automating safe, hands-off deployments — https://aws.amazon.com/builders-library/automating-safe-hands-off-deployments/ | "Alarm and time window blockers": the pipeline blocks a prod deploy "when an issue is currently ongoing"; time windows exclude "night, … office holidays, and … weekends", and "many teams also exclude Fridays and late-afternoon deployments" |
| S7 | AWS Builders' Library, Ensuring rollback safety during deployments — https://aws.amazon.com/builders-library/ensuring-rollback-safety-during-deployments/ | "we fully prepare ourselves for a rollback before every deployment"; a data-format change is split into a two-phase deployment because old and new servers cannot read each other's data |
| S8 | Kamei et al., "A Large-Scale Empirical Study of Just-In-Time Quality Assurance", IEEE TSE 2013 — https://posl.ait.kyushu-u.ac.jp/~kamei/publications/Kamei_TSE2013.pdf | change risk factors such as "the number of added lines"; across 11 projects "the diffusion factors [subsystems, directories, files touched] are consistently important", risk-increasing for defect prediction (RQ1) |
| S9 | Gunawi et al., "Why Does the Cloud Stop Computing? Lessons from Hundreds of Service Outages", SoCC 2016 — https://ucare.cs.uchicago.edu/pdf/socc16-cos.pdf | "Among the outages with reported root causes, UPGRADE, NETWORK, and BUGS are three most popular root causes, followed by CONFIG and LOAD"; upgrades "presumably … tested thoroughly in an offline environment, but upgrades pushed to the full ecosystem can be fragile" |
| S10 | Cloudflare, outage of 2 July 2019 — https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/ | "The SOP allowed a non-emergency rule change to go globally into production without a staged rollout." |
| S11 | Cloudflare, outage of 18 Nov 2025 — https://blog.cloudflare.com/18-november-2025-outage/ | "a change to one of our database systems' permissions" doubled a feature file that "was then propagated to all the machines" |
| S12 | Google Cloud incident, 12 June 2025 — https://status.cloud.google.com/incidents/ow5i3PPK96RduMcb1SsW | a code path "never exercised during this rollout" until a policy (config) change; "We will enforce all changes to critical binaries to be feature flag protected" |
| S13 | CrowdStrike Channel File 291 RCA, 6 Aug 2024 — https://www.crowdstrike.com/wp-content/uploads/2024/08/Channel-File-291-Incident-Root-Cause-Analysis-08.06.2024.pdf | "The Content Validator contained a logic error"; "Each Template Instance should be deployed in a staged rollout" |
| S14 | GitLab, database outage of 31 Jan 2017 — https://about.gitlab.com/blog/postmortem-of-database-outage-of-january-31/ | "the process of both finding and using backups failed completely" |
| S15 | AWS S3 US-EAST-1, 28 Feb 2017 — https://aws.amazon.com/message/41926/ | "the tool used allowed too much capacity to be removed too quickly" |
| S16 | Venturini et al., breaking changes in npm, TOSEM 2023 — https://arxiv.org/abs/2301.04563 | "around 12% of the dependent packages and 14% of their releases were impacted by a breaking change during updates of non-major releases"; "44% were introduced both in minor and patch releases" |
| S17 | Google Testing Blog, Flaky tests at Google (2016) — https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html | "about 84% of the transitions we observe from pass to fail involve a flaky test"; "developers dismiss a failing result as flaky only to later realize it was a legitimate failure" |
| S18 | npm unpublish policy — https://docs.npmjs.com/policies/unpublish | "Registry data is immutable, meaning once published, a package cannot change." |

## Factors

| Type | Factor | Source | Becomes |
|---|---|---|---|
| CITE | Changes cause most outages; the deploy step is where they enter | S1, S2, S9 | the reason a check exists at all |
| CITE + GUESS(inference) | Formal external approval of each change shows no association with lower change-fail rates; peer review plus automation is what DORA credits. That Jo's own per-deploy approval adds nothing is an inference from it, not a measurement of Jo | S3 | routine deploys run without Jo |
| CITE | Schema / data migration: hard to roll back, a major source of deploy risk | S5, S7, S11, S14 | E4 |
| CITE | No prepared rollback | S7, S14, S2 | E6 (rollback declared, B exists, probe finds it) |
| CITE + GUESS(inference) | A rollback can be unsafe even when both versions exist and work alone (protocol or data-format change) | S7 | E4 data-shape globs; compatibility itself is not provable here |
| GUESS(inference) | First deploy of a target: no known-good release to return to | S7 (rollback needs a prior good version), inferred | E6 |
| CITE | Change size (lines) | S8, S4, S2 | E9 hard above the high mark, W3 warn above the low mark |
| CITE | Diffusion (subsystems / directories touched) | S8 | W4 |
| CITE | Config / infra / deploy-pipeline changes | S2, S9, S10, S11, S12 | E5 (infra and CI paths) |
| GUESS(inference) | Auth, payments, secrets: no study found ranks them; failure there is a breach or money loss, not an outage, so recovery by rollback does not undo it | none (impact class, and Jo named them in the brief) | E5 (auth, payment, secret paths) |
| CITE | Failed, missing or skipped checks at the deployed commit | S9 ("presumably … tested"), S13 (validator bug), S17 | E2 (every required check present, latest attempt, success); W2 re-run-only passes and skipped optional checks |
| CITE | Deploying while an issue is ongoing in the service | S6 alarm blockers (aggregate alarm checked before each prod deploy) | E10 (target's health probe fails before the deploy) |
| CITE + GUESS(inference) | Deploying while the previous deploy failed or has an unknown outcome; concurrent deploys confound which change broke it | S6 (ongoing issue); concurrency part inferred | E8 (any unsettled or failed deploy of the target, no time-out) |
| CITE | Off-hours, Friday afternoon, weekend: slower to engage a human | S6 time windows | D1 (defer to Jo's window) |
| CITE + GUESS(inference) | Dependency updates break dependents even in non-major releases (12% of dependents, 44% of breaking changes in minor and patch). That a major bump is therefore a weak extra signal, and CI builds catch much of it, is an inference | S16 | W1 warn only |
| CITE | Global, all-at-once rollout with no staging | S10, S12, S13 | not checkable here: Jo's targets have no canary stage (tradeoff) |
| CITE | Irreversible publish (package registry) | S18 | stays always-reserved (`publishes a package`) |
| GUESS(inference) | Unreviewed / unmerged code reaching production bypasses the peer review S3 credits | S3 | H is always the default-branch head; E3 |
| — | Production-stakes workload | as2 policy, SPEC § B4 ("production … then Jo") | E1 |
| — | Deploy order across repos (a consumer must not ship ahead of its provider) | Jo, in-mvgpe7k1np4xkw; no study fetched | O1 hold |
| — | A merge that deploys by itself (push-to-main CD) takes away the choice to deploy and the check | Jo, in-mvgpe7k1np4xkw ("doesn't mean it has to"); inferred | M1 |

The thresholds (400 and 1500 lines, 5 directories) and the window hours are GUESS(inference): no source gives numbers. S6 gives the window's shape and S8 the direction of size risk. All live in the profile's `deploy:` section.

## Predicates

H is the default-branch head at evaluation. B is the H of the target's newest `deploy-settled: … ok` row. Order of outcomes: hold, then escalate, then defer, then routine; every condition that holds is named. First identify a declared target of a parsed policy: absent, unreadable or malformed policy, an unknown workflow/repo, or an unresolved repo leaves the original workflow reserved request unchanged (R5 precedes R6; never routine). For an identifiable declared target, unauthenticated policy is E0 and reads no other fact. No condition runs a declared shell command: every fact is a `gh api` read, a ledger read, the clock or the gate's own HTTPS GET.

Admission runs only after every rejecting gate, including the OS fence, and reads the original command rather than its fence wrapper. All read-only preparation shares one 20 s total deadline below the host's 30 s handler timeout, including merge selector/origin resolution; expiry is a plain E0 refusal with no admission, approval consumption or late ledger writes. Per-gh and health timeouts do not extend this total. Admission checks the deadline again under the ledger lock and before commit.

### Hold

A plain refusal. No reserved request, nothing reaches Jo, and an approval never overrides it.

| id | Outcome | Sources | Predicate |
|---|---|---|---|
| O1 | hold | Jo (in-mvgpe7k1np4xkw), no study | `deploy.order` places target P in an earlier group than this target, and P's default-branch head ≠ P's newest settled-ok H: P has merged work not deployed yet. Deploy P first |
| U1 | hold | S6 | a `deploy:` row of the target (any workload, any age) has no `deploy-settled:` row. The refusal names it and `as2 deploy settle <dp-…>` |
| U2 | hold | S6 | on `gh pr merge`, not on a deploy: the PR's repo is a target's repo whose `deploy:` row has no `deploy-settled:` row. Merge freeze until settle |
| U3 | hold | S6 | on a deploy, in the admission transaction: a `merge-inflight:` or `merge-done:` row of the target's repo is newer than the evaluation's start mark. A merge started or finished while H was read; the next call re-evaluates |

### Escalate

A reserved request `deploy (<target>, escalated: <ids>) …`, NOW under escalation phase 2. Jo's `approve` admits that exact deploy once.

| id | Outcome | Sources | Predicate |
|---|---|---|---|
| E0 | escalate | none (fail-closed rule) | an identifiable declared target's policy is not authenticated; the workflow blob at H ≠ `workflowBlob`; a fact below cannot be read (gh non-zero, timeout, missing JSON field, incomplete pagination); or the `B…H` compare is capped (300 or more files, or fewer commits listed than its total), so E4, E5 and E9 cannot see every file. No parsed target retains the original reservation instead; total deadline expiry is a plain E0 refusal without rows |
| E1 | escalate | as2 policy (SPEC § B4) | the workload's stakes are `production` |
| E2 | escalate | S9, S13, S17 | a `requiredChecks` entry (`{name, app}`: check-run name and `app.slug`) has no check-run at H, or its latest attempt is not completed with `success`; or any check-run or commit status at H is `failure`, `cancelled`, `timed_out`, `action_required`, `stale` or not completed. Every page is read |
| E3 | escalate | S3 | the default-branch head read again at the end of evaluation differs from H; or an open PR of the repo has auto-merge enabled; or the default branch uses a merge queue |
| E4 | escalate | S5, S7, S11, S14 | the `B…H` compare touches a migration or data-shape glob (defaults `**/migrations/**`, `**/migrate/**`, `**/*.sql`, `**/schema.prisma`, `**/alembic/**`, `supabase/**`, `db/schema.*`, `**/*.proto`, `**/*.graphql`, `**/schema.json`; the target adds more) |
| E5 | escalate | S2, S9, S10, S11, S12 | the `B…H` compare touches a sensitive glob (auth `**/auth/**`, `**/*auth*.*`; payment `**/payment*/**`, `**/billing/**`, `**/*stripe*`; secret `**/.env*`, `**/secret*`; infra and pipeline `.github/workflows/**`, `**/Dockerfile*`, `**/*.tf`, `k8s/**`, `helm/**`, `charts/**`, `infra/**`, `deploy/**`, `scripts/deploy*`, `fly.toml`, `vercel.json`, `netlify.toml`, `wrangler.toml`, `app.yaml`; the target adds more). The auth, payment and secret globs are GUESS(inference): no source ranks them |
| E6 | escalate | S7, S14, S2 | no B (first deploy); or the target declares no `rollback` text; or no completed successful run of the workflow at head_sha B exists: the release to return to was never built |
| E7 | escalate | none (misuse guard) | a `gh workflow run` of a declared target's file and explicitly resolved repo that is not byte-equal to the declared command (an extra `-f`, another `--ref`, a pipe, a prefix). A basename without a repo never guesses a target: it keeps the original reservation |
| E8 | escalate | S6 | the target's newest settle is `failed` with no later `ok` |
| E9 | escalate | S8, S4, S2 | the `B…H` compare's additions plus deletions exceed `deploy.lines.escalate` (default 1500) |
| E10 | escalate | S6 | the target's `health` probe, run by the gate before the deploy, fails: an HTTPS GET of the declared URL (no shell, 10 s timeout, redirects not followed) returns a status other than the declared one |
| E11 | escalate | none (mechanism) | a `merge-inflight:` row of the target's repo is unresolved: no `merge-done:`, and its PR is not merged with a merge commit H contains. No age limit, and a closed PR does not resolve it. The request names the PR and token |
| M1 | escalate | Jo (in-mvgpe7k1np4xkw), inferred | the call is `gh pr merge` on a repo in the merge-triggered list (its push to the default branch deploys): the code constant `["ContextPress/crawler"]` plus the policy's `mergeTriggered` when the policy is authenticated. An ineligible session gets `role-not-admissible`, not an approvable request; approval cannot make a hand, orchestrator, train or nonholder admissible |

### Defer

A reserved request `off-hours deploy (<target>) …` that waits for Jo's window.

| id | Outcome | Sources | Predicate |
|---|---|---|---|
| D1 | defer | S6 | now is outside `deploy.window` (default `America/Los_Angeles`, Mon–Thu 09:00–16:00, Fri 09:00–12:00; no weekend) |

### Warn

Never blocks. Warnings ride the `deploy:` row and the settle notice.

| id | Outcome | Sources | Predicate |
|---|---|---|---|
| W1 | warn | S16 | a `package.json` direct dependency's major version changed in `B…H` |
| W2 | warn | S9, S13, S17 | the latest required check-run succeeds but an earlier run with the same name and app slug did not succeed (re-run inference, not a `run_attempt` field), or a check that is not required concluded `skipped` or `neutral` |
| W3 | warn | S8, S4, S2 | additions plus deletions in `B…H` exceed `deploy.lines.warn` (default 400) |
| W4 | warn | S8 | `B…H` touches more than `deploy.dirs.warn` (default 5) top-level directories |

## Always reserved

Every deploy CLI in row 6's table (vercel, netlify, fly, doctl apps, wrangler, firebase, serverless/cdk/eb, gcloud, helm, kubectl, git push heroku/dokku), `infrastructure change (apply/up)`, `publishes a package` (S18), `gh release …`, every secret rule, a `gh workflow run` whose file and repo match no target, and every deploy-family call from a hand, the orchestrator or a train lane.

## Installed policy and settlement

Reinstall carries the installed `deploy:` section, including custom targets and order, and verifies that its canonical hash stays identical while other template sections remain unchanged. An invalid/unreadable installed section refuses reinstall rather than losing targets. Fresh profiles still ship `targets: []`. Carry never writes acceptance: only the newest surface `deploy-policy:` row counts, so `off` and a newer differing hash remain authoritative.

Settlement's fallback query filters workflow_dispatch runs to the deploy row's creation time through 120 s later. Every page must still be complete, and the local event/time-window checks remain mandatory; filtering is not proof of a matching run.

## Not covered

A global, all-at-once rollout with no staging (S10, S12, S13) cannot be checked here: Jo's targets have no canary stage. Whether a rollback is compatible with the data is not provable here; E4 only sends data-shape changes to Jo. A person merging outside as2 in the seconds between the gate's last read and GitHub receiving the dispatch is reported after the fact by settle, not prevented.
