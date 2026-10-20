# Self-heal detector fixtures

Cut on 2026-10-19 from the recorded failures named in PLAN wl-mvbcjageg7o2yo § 2.3 (R3–R10) and read by
`surface/test/selfheal-detectors.test.ts`. Each file keeps only the fields the readers in
`surface/src/selfheal/read.ts` look at. Jo's words are never kept: every user message text is
the placeholder `<user message>`, and the surface input entries keep no `data`. Ledger rows were read
with `sqlite3 -readonly ~/.agent-system-2/ledger.db`. The test seeds them into a temp ledger through the
ledger module, which gives entries and routings new ids; questions keep their ids.

## compaction-loop (R3)

| File | Cut from | Kept / removed |
|---|---|---|
| `compaction-loop.jsonl` | `~/.agent-system-2/lanes/wl-mv457r7iqmq29s/sessions/2026-10-12T00-00-26-467Z_01a12d69-1f63-7000-9273-bcafc8e39649.jsonl` (176 MB, 589 compactions) | All 589 `compaction` lines (source lines 12–4564) and 5 other entry lines (source 1697, 2278, 2844, 3429, 4004), each reduced to `type` and `timestamp`; everything else removed. |
| `compaction-loop-jp-build.jsonl` | `~/.agent-system-2/lanes/wl-mv8r90k9nci4qo/sessions/2026-10-14T23-42-45-344Z_01a13ccc-0260-7000-8051-ba7b5162fdd4/sl-jp-build.jsonl` (the sl-jp-build hand) | All 39 `compaction` lines and 8 other entry lines (source 171, 246, 337, 425, 509, 585, 668, 749), reduced to `type` and `timestamp`. The test puts it at the same nested path under its lane. |
| `compaction-loop-clean.jsonl` | `~/.agent-system-2/lanes/wl-mv0n5r9cbafe9s/sessions/2026-10-12T03-29-19-429Z_01a12e28-5c45-7000-a0fe-bb08a05c4e6d.jsonl` | Its 11 `compaction` lines and 12 other entry lines (source 159 … 1910, about every 160th), reduced to `type` and `timestamp`. |

## hand-lab (R4)

| File | Cut from | Kept / removed |
|---|---|---|
| `hand-lab.json` | Ledger, 2026-10-14. `builder-lab: openai lane …` entries en-mv7gich0e4k3r4, en-mv7gicng0jzw1s, en-mv7gidamk1yo74, en-mv7gidpushx4hs; `hand-spawn: … review no` entries en-mv7gm78fbw7qww (sl-links-docs), en-mv7gq05hox8f7k (sl-audhd-build), en-mv7gqtd7tug0sg (sl-fifo-main-refresh), en-mv7i0gfbmx569s (sl-sendline-reviewfix); routings rt-mv7gpebny1ya2o, rt-mv7hcosdhzk54w, rt-mv7guob979bls0, rt-mv7iikenlltv5s (each `ran_models` `["anthropic/claude-opus-5-5"]`) | One build hand each for lanes wl-mv66q5b148uznk-3, wl-mv6uqrx6d1tjb4-4, wl-mv65nllu5g181s-5 and wl-mv66ylg1op3wg0-3. Entries are kept whole. Routings keep the columns the ledger needs to accept them (`kind`, `outcome`, `models`). Confidence, probabilities and tiers are filled in by the test. |
| `hand-lab-clean.json` | Ledger, wl-mv6zl15365nf9c lane-3. Entries en-mv7g4siapccagw (`builder-lab: anthropic`), en-mv7g875x4ghgxs (sl-pd-resolver), en-mv7g875yrn0dmo (sl-pd-docs), en-mv7hms5m9ax0qo (sl-pd-omp-plan--openai, `review yes`); routings rt-mv7gglzgm97a4g, rt-mv7giw5rhay7eo, rt-mv7htab4ca4lj4 | Builders on the lane's own lab, and an OpenAI review hand on an Anthropic lane, which must stay quiet. |

## paste-drop (R5)

| File | Cut from | Kept / removed |
|---|---|---|
| `paste-drop.jsonl` | `~/.omp/profiles/agent-system-2/agent/sessions/-code-agent-system-2.0/2026-10-12T20-29-05-405Z_01a131cd-fbfd-7000-936e-909f05c9853c.jsonl` (8554 lines) | The 1293 `role:user` message and `surface-input` / `surface-jo-input` custom lines, in order. Messages keep `type`, `id`, `timestamp` and `message.role`, with the text replaced by a placeholder. Inputs keep `type`, `customType`, `id` and `timestamp`. All other lines were removed. The six unechoed messages are source lines 795, 801, 863, 913, 3549 and 3557 (ids c803b7f7, 2de87fdc, 9fca9e5c, 20eabc0a, 64cb9012, 4484f0c6), which are fixture lines 111, 112, 123, 129, 501 and 502. |
| `paste-drop-clean.jsonl` | `…/-code-agent-system-2.0/2026-10-12T05-22-06-992Z_01a12e8f-a010-7000-8ca5-0b585db40971.jsonl` (2023 lines, every message echoed) | Cut the same way (289 lines). |
| `paste-drop-smoke.jsonl` | `~/.omp/profiles/agent-system-2/agent/sessions/--Users-jowolff-agent-scratch-agent-system-2.0-scratch-wl-mv8wzipdczs2rk-smoke-repo--/2026-10-15T04-22-34-055Z_01a13dcc-2f47-7000-86ac-66cf6fe673b8.jsonl` (47 lines, no surface input entry) | All 47 lines, reduced to `type`, `customType` and `timestamp`. The one user message keeps its `id` and gets a placeholder text. The smoke session lives in its own sessions subdirectory, not in `-code-agent-system-2.0`. |

## ceiling-wall (R6)

| File | Cut from | Kept / removed |
|---|---|---|
| `ceiling-wall.json` | Ledger questions q-mv6wdkhahpcyrk (26 % $, 197 % min), q-mv6wdvfe1ikv0g (10 % $, 102 % min), q-mv6wdvqfmnudq8 (16 % $, 718 of 60 min), 2026-10-13 16:30Z, all by `lane-runner` on `sl-ceiling-*` slices | Only the first line of each body (the line with the figures) and the options. The option explanations were removed. |
| `ceiling-wall-clean.json` | Ledger question q-mv8fgrl4x8ve9s (wl-mv8fb0xnlc0b28, 253 % $, 441 % min) | The same. |

## flaky-test (R7)

| File | Cut from | Kept / removed |
|---|---|---|
| `flaky-test.json` | Ledger `test-run:` entries en-mv7hclx22h3bwg (error), en-mv7i2bs91uv0u8 (red), en-mv7iji2w4p7fnk (green) for e27bbc0 (PR #136); en-mv7m6q1qd7c3k0 (red) and en-mv7mxoocq63668 (green) for db80ef2 (PR #101); en-mv8do4u3uoz1ts (red) and en-mv8efz3jdpx79c (green) for 49443be (PR #101) | Bodies kept whole: `parseTestRun` checks every field. |
| `flaky-test-clean.json` | Ledger en-mva2bmm239r0g0 (error) and en-mva35u44051b7k (green) for 7482fbd: green, and never red | The same. |

## jetsam (R8)

| File | Cut from | Kept / removed |
|---|---|---|
| `jetsam/JetsamEvent-2026-10-13-124141.ips`, `jetsam/JetsamEvent-2026-10-14-053054.ips`, `jetsam/JetsamEvent-2026-10-16-053539.ips` | The real reports of the same names in `/Library/Logs/DiagnosticReports/` (readable on this machine) | The header line keeps `bug_type` and `timestamp`. The body keeps `memoryStatus.pageSize` and the three largest `processes[]` by `rpages`, with `name` and `rpages` only. Every other field and process was removed. 2026-10-14 05:30:54 -0700: bun, 851139 pages × 16384 B. |

The test also builds an unreadable directory (a missing path) and an unreadable report (mode 000) at run time.

## model-start (R9)

| File | Cut from | Kept / removed |
|---|---|---|
| `model-start.json` | Ledger wl-mv8cvw0lq3rlds: en-mv8cx8c8kwwe80 and en-mv8cx99rgl6gw0 (`lane-started: lane-mv8cvw0lq3rlds-1`, the second with `ranModel` anthropic/claude-opus-5-5), en-mv8d1b8mlysd8g (`lane-model: openai-codex/gpt-6.1-sol by jo`, 2026-10-14T17:04:48Z) | The lane-started JSON keeps `pid`, `start`, `runnerPid`, `model` and `ranModel`. `argv` is emptied and `session` is nulled. The recorded date is 2026-10-14, not 2026-10-16. |
| `model-start-clean.json` | The same lane-model entry, plus en-mv8d2t5cbmgjcw and en-mv8d2u6w3b93b4 (lane-2, started 17:05:58Z on openai-codex/gpt-6.1-sol, the recorded model) | The same reduction. |
