# Workload ceiling: plan (revision 2)

Workload `wl-muolz8qtp6ylfk`, plan slice `sl-ceiling-plan`, lane `lane-muolz8qtp6ylfk-2`, 2026-09-30.

**done:** Every workload carries a stakes-sized ceiling in its ledger row, the lane runner counts tokens and wall time against it, and crossing 80 % raises a question row to Jo defaulting to stop at the ceiling, proven by a run against a real lane.

**Amended 2026-10-19 — escalation policy** (workload wl-mvfkv7llkp7nk0, plan `~/agent-scratch/agent-system-2.0/wl-mvfkv7llkp7nk0/PLAN.md` rev 5 § 4 and § 4.1; Jo, 2026-10-19: *"yes to auto-start, stop at 100%"*, and the paired-workload amendment in-mvfo7nphl9xn28; `migration/items/escalation-policy.md`). The 80 % question in the done line above no longer exists. At 80 % Jo gets a notice and the lane goes on; at 100 % an autonomous runner lane stops and Jo gets a second notice. No question is raised at any level, nothing extends on its own at any stakes, and a lane Jo runs by hand is never stopped. § 2 items 2, 4 and 5 and "Not covered" describe the mechanism as it is now. §§ 3, 4 and 6 record the 2026-09-30 build, and each marks what the amendment replaced.

## 1. Jo's rulings this revision carries

**CLAIM**
Jo's words on this workload, instruction row of 2026-09-30T21:30:15Z, followed by the answer `revise` to `q-muom66wdlpz340` (answer instruction `in-muomdeln10gcn4`); read with `sqlite3 -readonly` from the live ledger's `instructions` table: *"revise A and B. A: keep schema v5 — the ceiling is a `ceiling:` control entry written at open by orchestrator-surface, read by the runner; no upgrade of the live ledger. B: size by the change-large judgment as the M7 ruling says (x3 for a plan-first workload); editing the open tool in workload.ts is fine, L2 is not open. C and D approved as written."*

- **A.** Schema stays v5 and the ledger module is untouched. The ceiling is a reserved control entry, `ceiling: usd <x> wall <min> source <why>`, written in the open transaction by `orchestrator-surface`, the same way `done:` and `plan: first` are written today (`surface/extensions/workload.ts:208-215`). That entry is the workload's ceiling in its ledger row set.
- **B.** The size is the stakes size, ×3 when the open-time classifier judged the brief change-large (the `brief-judged:` result the open tool already computes). **GUESS(inference):** a workload that is plan-first only because of production stakes or Jo's "plan it", and was not judged change-large, stays ×1. My reading is that Jo's "plan-first" here names the change-large trigger. If Jo meant every plan-first workload, the fix is a one-line change in the sizing function.
- **C.** $5 / 1 h (throwaway), $50 / 6 h (normal), $150 / 12 h (production). Dollars are nominal list price as OMP computes them; hours are lane run time.
- **D.** Jo's word `extend wl-…` adds one more block of the workload's own size; until 2026-10-19 this was the *extend* answer to the ceiling question. An exact figure goes through Jo's surface word `ceiling <usd> [<hours>] [wl-…]`.

## 2. Mechanism

**CLAIM** — facts this rests on, each checked this session:
- OMP's `message_end` rpc frame carries `message.usage.totalTokens` and `message.usage.cost.total`. Read from this lane's frames at `/Users/jowolff/.agent-system-2/lanes/wl-muolz8qtp6ylfk/lane-1.jsonl`: first assistant message `totalTokens 40647`, `cost.total 0.189`.
- A hand's session file is `<artifactsDir>/<id>.jsonl` (`/Users/jowolff/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/task/executor.ts:3520-3521`). Summing assistant `usage` over every `.jsonl` under `~/.agent-system-2/lanes/<wl>/sessions/` therefore counts the lane and all of its hands, sync and async.
- Reserved control prefixes, their fixed writers and the writer check live in one place: `CONTROL_PREFIXES`, `CONTROL_WRITERS` and `validWriter` (`/Users/jowolff/code/agent-system-2.0-lanes/wl-muolz8qtp6ylfk/surface/src/launch.ts:68-128`).
- `questions.slice_id` is `NOT NULL` (`/Users/jowolff/code/agent-system-2.0-lanes/wl-muolz8qtp6ylfk/ledger/schema.sql:128`), so the ceiling question got a slice of its own. Since 2026-10-19 there is no ceiling question and no ceiling slice.

**GUESS(inference)** — the design, not yet built:
1. **Entry and authority.** Two new reserved prefixes go in `launch.ts`:
   - `ceiling:`, writer `orchestrator-surface` only;
   - `spend:`, writer `lane-runner` only.

   Lane tools refuse both, as they already refuse every reserved prefix. The **effective ceiling** is the newest valid `ceiling:` entry, read by a pure `effectiveCeiling(control, instructions)`. An entry that *raises* either half is valid only when it names a Jo-authored instruction id (`… by <in-id>`) newer than the entry it raises. P-7b item 2 is enforced this way, in the reader, since the file no longer carries it. Lowering needs no instruction; it is the orchestrator's. A workload opened before this lands has no entry, so the reader falls back to its stakes size ×1.
2. **Writers, all surface.**
   - The open tool writes the first entry (`source stakes <s>` or `source stakes <s> x3 change-large`).
   - Jo's stakes word re-sizes to the new stakes. The instruction is written first, so the raise can name it.
   - Jo's `extend wl-…` and `ceiling` words record Jo's instruction (`ceiling: <usd> <hours>` for both), then the raising entry that names it.
   - A new `orchestrator_lower_ceiling { workloadId, usd?, wallMinutes? }` refuses any value above the current one.
3. **Spend.** The unit is nominal dollars (§ B11). Tokens are counted and recorded beside it but never compared. Spend is the sum over the workload's session files, so it is cumulative across relaunches and `--resume`. **Wall** is the sum of `lane-started:` → `lane-exit:` intervals plus the current run. Time parked on Jo is not counted.
4. **Runner.** On the existing 5-second poll it meters incrementally (byte offsets per file). It writes `spend: <laneId> usd <x> tokens <n> wall <min>` at each threshold and at `lane-exit:`.
   - **At 80 %** of either half, one notice per ceiling value (*Amended 2026-10-19*): `notice: ceiling 80 % at usd <x> wall <min> on <wl>: …`, a `lane-runner` message to the orchestrator written in one `ledger.write` with the `spend:` entry it reports (`sendCeilingNotice`, `surface/scripts/lane.ts`; the text is `ceilingNoticeBody`, `surface/src/ceiling.ts`). It says the lane goes on and is stopped at 100 %, and names `extend <wl>` and `ceiling <usd> [<hours>] <wl>`. The lane keeps working. A raised or lowered ceiling is a new value, which may notify again at its own 80 % and 100 %.
   - **At 100 %**: `lane-stop: <laneId> accepted ceiling`, then abort, outcome `stop`, every time, and one stop notice per ceiling value (`notice: ceiling 100 % …`). It says the lane is stopped and nothing relaunches on its own, and names `extend <wl>`, `ceiling <usd> [<hours>] <wl>` (either relaunches it) and `user-driven <wl>`. A poll that jumps from under 80 % straight to 100 % sends only the stop notice. That path writes no `lane-died:` (`exitClass`); Jo sees the notice and the idle line of a lane that stopped at its ceiling. Both notices and that idle line are on fire for the batch (`onFire`, `surface/src/batch.ts`).
   - Once per value is read from the ledger's notices for that value (`ceilingNoticesSent`) and the run's own memory (`meterStep`), so a relaunch on the same value sends nothing again. No question row is written at any level, and there is no automatic extension at any stakes.
   - `--max-time` = remaining wall plus 10 minutes, a backstop behind the runner's own stop.
   - The first prompt carries the ceiling and the spend so far, so the lane sets § B9's ceiling share from real numbers, and says what happens at the ceiling: "At 80 % Jo gets a notice; at 100 % this lane is stopped and Jo is told." (`ceilingPromptLine`).
5. **Surface on Jo's word** (*Amended 2026-10-19*). `extend wl-…` raises the ceiling by one block of the workload's own size (`sizeFor` at its stakes, ×3 when judged change-large) on the value in force; `ceiling <usd> [<hours>] [wl-…]` sets Jo's figure. Both run one shared helper (`raiseCeiling`, `surface/src/input.ts`): the `ceiling:` entry naming Jo's instruction, then the relaunch rule. Jo's `launch-requested:` is written when the workload's newest lane was stopped at the ceiling (its `lane-stop: … accepted ceiling`, still stopping or gone), the workload is autonomous, that lane's last `spend:` is under the new value in both halves, and no unconsumed request already waits; so a stopped lane relaunches with `--resume`. Otherwise nothing is requested, and the receipt names the case. The one-liner and the render show `ceiling $50 / 6h` and the newest `spend:` against it.

**Not covered, on purpose, and paired workloads** (*Amended 2026-10-19*, Jo's ruling in-mvfo7nphl9xn28, PLAN wl-mvfkv7llkp7nk0 § 4.1):
- A paired workload, one whose holder is a live by-hand lane (`as2 lane <wl>`, a `launch:` entry with `cause interactive`; `isPaired`, `surface/src/ceiling.ts`), is never stopped at its ceiling and raises no question and no notice about it. The meter, its notices and the 100 % stop run only in the autonomous runner (`cmdRun`); `cmdInteractive` stays unmetered, now as Jo's ruling rather than a gap. A user-driven workload with no by-hand lane running is not paired by itself: nothing spends, and nobody is in a pane to tell. The rule is keyed on the lane kind, not the mode, so the future paired mode (jo-issues #139) falls under it as soon as its lanes start through the interactive path.
- What a by-hand lane gets instead is the cost, from the lane extension (`surface/extensions/lane.ts`). At every turn start it receives a context message against the ceiling in force: `spend: $X of $Y ceiling (Z %), N min; paired: not stopped at the ceiling` (`pairedSpendMessage`). Each time the dollar spend crosses another 25 % of the original ceiling (the workload's first `ceiling:` entry: 37.50, 75, 112.50, 150, 187.50 … for $150), one line is written in Jo's pane with `ctx.ui.notify`, past 100 % without end (`pairedSpendStep`). Marks passed before the session's first measure are not shown. Its first prompt carries `pairedCeilingPromptLine` instead of the autonomous ceiling line.
- TypeSafe `judge()` calls are not in session files and cost fractions of a cent (§ B11).

## 3. Slices

The file clusters are disjoint across slices. S1 is the shared pure module, and it goes first. S2 and S3 then run in one batch against S1's exports (§ 4). L2 is not open (Jo), so `workload.ts` is in S3.

*Amended 2026-10-19:* this table is the 2026-09-30 build. The 80 % question, its slice and the *stop* / *extend* / *split* answers it proves were replaced by the notices and Jo's `extend` word (§ 2 items 4 and 5); `surface/test/ceiling-meter.test.ts` and `surface/test/ceiling-surface.test.ts` now prove those.

| Slice | Kind / tier | Files (read and write) | Done condition | Proving command |
|---|---|---|---|---|
| **S1 ceiling core** | change-small / standard | new `surface/src/ceiling.ts`, `surface/src/launch.ts` (two prefixes, writers, the `--max-time` renderer taking a remaining-wall input), new `surface/test/ceiling.test.ts` | Pure functions: sizing table ×3 rule, `ceiling:` and `spend:` bodies and parsing, `effectiveCeiling` with the raise-needs-Jo rule (matrix: raise without, with an older, and with a newer Jo instruction; lowering by the surface; a lane-written entry ignored), session-file spend scan, wall from control entries, threshold check | `bun test surface/test/ceiling.test.ts surface/test/launch.test.ts` |
| **S2 runner meter** | change-large / strong | `surface/scripts/lane.ts`, `surface/test/fake-omp.ts` (writes session files with `usage`), `surface/test/lane-script.test.ts`, new `surface/test/ceiling-meter.test.ts` | Fake-omp: 80 % raises exactly one question and the lane goes on; 100 % unanswered → accepted ceiling stop, outcome `stop`, no `lane-died:`; hand files counted; a relaunch keeps the cumulative total; finishing under the ceiling withdraws the question | `bun test surface/test/ceiling-meter.test.ts surface/test/lane-script.test.ts` |
| **S3 surface** | change-small / standard | `surface/extensions/workload.ts` (open writes `ceiling:`), `surface/src/input.ts`, `surface/src/render.ts`, new `surface/extensions/ceiling.ts`, `surface/src/types.ts`, `surface/index.ts`, `surface/test/extension.test.ts`, new `surface/test/ceiling-surface.test.ts`, `tiers/orchestrator.md` (one line) | Open writes the entry (×1, and ×3 when judged change-large); *extend* raises and requests a relaunch; *stop* and *split* only complete the slice; the `ceiling` word; the stakes word re-sizes; the lowering tool refuses a raise; the one-liner shows the ceiling | `bun test surface/test/ceiling-surface.test.ts surface/test/extension.test.ts surface/test/lane-tools.test.ts` |
| **S4 review** | judge / strong (normal stakes, § B4) | read-only over S1–S3's diff | Written verdict; blocking findings fixed and re-checked | the review file plus `bun test` |
| **S5 real-lane proof** | change-small / standard | scratch dir `~/agent-scratch/agent-system-2.0/migration/M7/ceiling/` | The worktree's `lane.ts launch` runs a real `omp` lane with a real model against a scratch ledger. A scratch workload is lowered to a tiny ceiling (for example $0.15 / 10 min); it raises the 80 % question and stops at 100 % with no `lane-died:`. Ledger exported. | the exported ledger plus the runner log |

Lane integration, done by me: `install/manifest.tsv` rows for the new files; the `DESIGN-lane-launcher.md` decision 12 note (`--max-time` becomes the wall half of the ceiling); the M7 row in `MIGRATION.md`; the full `bun test`; then rebase, push, and the PR. Jo integrates.

## 4. Contract (S1 delivers; S2 and S3 build against it)

```ts
// surface/src/ceiling.ts
export const CEILING_BY_STAKES: Record<Stakes, { usd: number; wallMin: number }>; // § 1 C
export const CHANGE_LARGE_FACTOR = 3;
export function sizeFor(stakes: Stakes, judgedKind: RoutingKind | null): Ceiling; // Ceiling = { usd, wallMin }
export function ceilingBody(c: Ceiling, source: string, byInstruction?: string): string; // "ceiling: usd 50 wall 360 source …[ by in-…]"
export function effectiveCeiling(control: readonly ControlEntry[], instructions: readonly InstructionRow[], stakes: Stakes): Ceiling;
export function spendBody(laneId: string, s: Spend): string; // Spend = { usd, tokens, wallMin }
export function scanSpend(sessionsDir: string, offsets: Map<string, number>, acc: Spend): Spend; // incremental
export function wallMinutes(control: readonly ControlEntry[], now: number, currentStart: number | null): number;
export function crossed(s: Spend, c: Ceiling): 0 | 80 | 100;
// Replaced 2026-10-19 (§ 2 item 4): CEILING_OPTIONS and ceilingQuestionBody are gone. The notices:
export type CeilingNoticeLevel = 80 | 100;
export const ceilingKey: (c: Ceiling) => string; // "usd 50 wall 360": one notice per level per value
export function ceilingNoticeBody(level: CeilingNoticeLevel, wl: string, s: Spend, c: Ceiling, stakes: Stakes): string;
export function parseCeilingNotice(body: string): { level: CeilingNoticeLevel; key: string; workloadId: string } | null;
```

## 5. Risks

**GUESS(inference)**
- **S5 on a real model.** The lane's `omp` loads the main checkout's extensions from the profile. With schema v5 unchanged, they read a scratch ledger fine. Only the runner (the worktree's `lane.ts`) needs the new code, so a pre-merge real-lane run is expected to work. If it cannot run against a real model, I raise that as a question and do not substitute the stub model.
- **The raise rule is reader-enforced,** so a raw write could forge a `ceiling:` entry. Row 10 already refuses raw ledger writes, and `validWriter` drops any entry not written by `orchestrator-surface`, the same trust level as `plan: approved` today.

## 6. As built

**CLAIM**
Deltas from § 2 after the build and fix round 1 (review `sl-ceiling-review`, fixes `sl-ceiling-fix-1`), each cited by the function that carries it:
*Amended 2026-10-19:* the slice id, the jump rule, the withdrawn rule, the extend relaunch rule and withdraw = cancel below describe the removed ceiling question (`raiseCeilingQuestion`, `ceilingQuestionState`, `settleCeiling` and the withdraw special case are deleted). What replaced each is in § 2 items 4 and 5: a jump from under 80 % to 100 % sends only the stop notice; once per value is read from the notices; the relaunch rule is `raiseCeiling`, shared by `extend` and `ceiling`; `withdraw` on a ceiling question left open from before keeps the ordinary `then: replan`. An `answer` whose body is `extend` still counts as a raise shape, for entries written before.
- **Slice id.** The ceiling slice is `sl-ceiling-<wl without wl->-<n>`, not `sl-ceiling-<n>`: slice ids are ledger-wide, so the workload is in the id (`raiseCeilingQuestion`, `surface/scripts/lane.ts`).
- **A jump past 80 % raises and stops together.** When the spend goes from under 80 % to 100 % between polls, or reaches 100 % with no question open or answered for the ceiling value, the question is raised with the stop, so a ceiling stop always leaves Jo an open question (`meterStep`).
- **Withdrawn does not count as asked.** A withdrawn ceiling question, the runner's own cancel at a clean finish or Jo's withdraw, reads as never raised (`ceilingQuestionState`), so a relaunch at 85 % raises afresh. Within one run, a question Jo withdrew is not asked again before 100 %.
- **Metered before the first prompt.** The runner meters once at readiness, before the prompt; a relaunch already at or past 100 % takes the ceiling stop without sending it (`cmdRun`).
- **The extend relaunch rule.** *extend* writes `launch-requested:` when no lane holds the workload under a live lease, or when the holder's newest valid `lane-stop:` is `accepted ceiling` (it is stopping at the ceiling). A live holder still running gets no request; it reads the raised ceiling at its next poll. The receipt names which case it was (`settleCeiling`, `surface/src/input.ts`).
- **Withdraw = cancel.** Jo's `withdraw` on the ceiling question withdraws with `then: cancel`, so its slice is cancelled and the close is not blocked; the receipt says the lane stops at the ceiling as the default. Other questions keep `then: replan` (`interpret`, `surface/src/input.ts`).
- **The raise shapes.** A raising `ceiling:` entry counts only when its named instruction (author jo, written by `orchestrator-surface`, newer than the entry in force) is one the surface writes to raise: a body opening `ceiling: ` (the ceiling word), a body opening `stakes: ` (the stakes word), or an `answer` whose body is `extend`. An `orchestrator_record_instruction` row does not raise (`isRaiseInstruction`, `surface/src/ceiling.ts`).
- **`spend:` is not intent.** `exitClass` skips `spend:` like `lane-started:` and `lane-ready:`, so a `spend:` after an accepted stop or a park keeps the end intended (`surface/src/launch.ts`).
- **`--max-time`.** It is the remaining wall plus 10 minutes, but an explicit `AGENT_SYSTEM_LANE_MAX_TIME` still wins when it is shorter (`cmdRun`).

**GUESS(inference)**
Known limits, not fixed (review finding 7):
- A run with `lane-started:` but no `lane-exit:` (a hard-killed runner) adds no wall (`wallMinutes`).
- Interactive `as2 lane` runs write `lane-started:` / `lane-exit:` and share the `sessions/` directory, so their wall and dollars count against the same ceiling when the next autonomous run meters, though the interactive run itself is not metered.
