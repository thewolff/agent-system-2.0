---
status: open
durable: true
---
# Seven fault-tolerance principles are standing rules for everything Jo builds

**Decision (Jo, 2026-10-27, about 5:25 to 5:45 AM PDT):** "everything we build - either for as2 (especially as2), as a plugin, and even for newdle - I want fault tolerance to be important. fail loudly and obviously, be able to recover quickly." Jo asked for research before adopting them. Then on Newdle end users: "yes, users should receive graceful plain language errors that match established conventions."

**Scope:** as2 (the orchestrator, every lane and hand, the runner, the merge train), Plumb, Tinker, every plugin and hook, and Newdle.

## The seven

1. **Fail loudly to operators, gracefully to users.** A failure always reaches someone who will act on it, routed by urgency. A fallback is allowed only if it announces itself and is exercised. End users (Newdle) get a plain-language error that follows established conventions and keeps their input; the alert goes to whoever runs the system.
2. **Fail obviously.** The failure says what broke, where (the file or command), the evidence, and the next step, or says that no next step is known.
3. **Recover by restart.** Restart is the recovery path and is safe to repeat (idempotent). Restart the smallest piece that failed, not the whole system, so recovery stays cheap. Durable state lives in one crash-safe store, and everything else is rebuilt from it.
4. **Bound every retry and restart, then escalate.** Retry in one layer only, with backoff and a limit. An attempt counts against the limit only if it made progress; an attempt that made no progress still counts against the cost budget. When the limit is hit, the next layer up or a person takes over. No nested retries.
5. **Silence is a failure.** Anything long-running or expected has a deadline that tracks progress, not just liveness. A missed deadline, a job that never started, or a dead watcher is an error. The watcher is watched from outside.
6. **Recovery never destroys the evidence.** Cleanup never deletes what a receipt, log or open incident cites, and evidence is kept for a stated retention window.
7. **One failure never hides another.** Errors chain or join, so a cleanup error never replaces the original. A run reports every failed check, not only the first.

Alarms follow the same rules. An alarm fires only on a state that needs action; a normal exit is not a death. It is loud once, repeated only when the state changes or on a slow cadence. An alarm that repeats every cycle, or fires when nothing is wrong, trains people to ignore it.

## Why

Incidents on 10/26 and 10/27:
- A test-runner worker hung for hours on the bun `Bun.spawnSync` lost-reap bug, and nothing flagged it (principle 5).
- Plumb had no watcher on Ilex, and two plan questions sat unseen for about four hours (principle 5).
- The spawn-free ledger workload's close deleted the trace logs its own receipt cited (principle 6).

Research: `.tmp/fault-tolerance-principles-research-2026-10-27.md` has 45 quoted passages from 29 fetched sources, among them Erlang/OTP supervision, Candea and Fox's crash-only software, the Google SRE book (monitoring, cascading failures, postmortems), the AWS Builders' Library (timeouts and retries, avoiding fallback, idempotent APIs), Stripe idempotency keys, Kubernetes probes, Healthchecks.io, NIST SP 800-61r3, PEP 3134 and Go `errors.Join`. That report also has per-principle practice lines for as2 lanes, for plugins and hooks, and for Newdle.

**Rejected:** "fail loudly" for end users. It contradicts the SRE cascading-failures chapter and the NN/g error-message guidance, and Jo ruled it out. Also dropped: the absolutes in Plumb's first draft ("within one cycle", "no quiet fallback", "one recovery step"), because the sources contradict them.

## How it becomes binding

1. **Plumb:** this entry, plus a memory section. Every brief and review Plumb writes checks against the seven.
2. **Ilex and as2 briefs and plan reviews, now:** a standing ruling Jo gives Ilex. Every brief and plan carries a "How it fails" section, and a silent failure path counts as a blocking review finding.
3. **as2 lanes and hands:** a short section in `tiers/lane.md`, `orchestrator.md`, `fast.md`, `standard.md`, `strong.md` and `deep.md`, by PR.
4. **as2 machinery, held until flow is green:** "fault-tolerance" becomes a cross-lab review finding kind (blocking when a failure is silent), and the plan gate refuses a plan with no "How it fails" section. To be filed as an as2 issue.
5. **Tinker, plugins and hooks:** sent to Tinker for its charter and for every extension or hook it builds.
6. **Newdle:** sent to the Newdle seat (Wren) to adopt through Newdle's own engineering standards.

## Amendment, 2026-10-27 ~8:50 AM PDT

Jo added the smallest-piece clause to principle 3 ("Restart the smallest piece that failed, not the whole system, so recovery stays cheap") after Graham reported that restarting his full Salesforce stack takes 2 hours. The `tiers/` principle lines carry the same clause; `tiers/lane.md` names the slice as the smallest piece, not the workload.

Source: Candea et al., "Microreboot: A Technique for Cheap Recovery", OSDI 2004, https://static.usenix.org/event/osdi04/tech/candea.html. From the abstract: "Microreboots recover most of the same failures as full reboots, but do so an order of magnitude faster and result in an order of magnitude savings in lost work."

Second amendment, about 9:05 AM PDT the same day: Jo added the progress-only clause to principle 4 ("An attempt counts against the limit only if it made progress; an attempt that made no progress still counts against the cost budget"). The evidence, from 2026-10-27: a Kimi lane ran 123 minutes at 0 tokens without touching the conflict and used up both of PR #151's conflict-fix attempts. Meanwhile the merge train woke five lanes (79 to 83), and each found nothing to do and released, at about $3 apiece. The `tiers/` "Bound every retry" lines carry the same clause.

Third amendment, about 9:10 AM PDT the same day: Jo added to the alarm rule that an alarm fires only on a state that needs action, and a normal exit is not a death. The evidence, from 2026-10-27: Ilex had to call four "lane died" alarms noise (lanes 80 to 83 of the merge train). Each was a normal exit, for example `lane-exit: lane-mvfye8lm1uwao0-80 code 0`.
