---
title: Openable file paths and URLs on every as2 agent surface
status: building
workload: wl-mv720a2pph9d6o
pr: 219
---

## Scope and decision

**CLAIM**
This item records the Jo-approved rev7 render contract for workload `wl-mv720a2pph9d6o`, amended by `in-mvfm7l291h5jpc` (plain, answering `q-mvfka1g4kovg8w`) for unknown-origin ledger handles, not a claim of completed runtime verification. Jo's instruction `in-mv8uirkfn6oiyo` widens the original file-path request to every file path and URL any as2 agent shows Jo in OMP inside herdr inside kitty, including Ilex, lanes, hands and advisor seats such as Plumb. The accepted D1/D2 limits are recorded below.

**PMDW**
Enforce this through render machinery, not prompt text alone and not a new gate row: a gate would refuse only after text had streamed and require a model rewrite. Keep tier guidance secondary. The receipt rules remain in `contract/output-types.md`, under "The receipt rule" and "Writing a citation INTO a document is the opposite job".

## Render contract

**PMDW**
Apply these rules to Jo-facing output; this section specifies behavior to implement, not test results.

- On markdown surfaces, turn an existing file path into a markdown link whose visible text is its absolute path and whose target is its file URL. Expand `~` against the home directory and resolve relative paths against the emitting session's cwd. This convenience does not relax the contract's requirement to derive absolute receipts.
- Absolute/home paths also link a not-yet-existing leaf when its parent directory exists; the opener then opens that parent. Relative paths require the target to exist. Across unquoted spaces, use only the longest whole path that exists, never the parent-exists rule; a nonexistent path containing spaces needs a delimiter.
- Escape markdown metacharacters in the visible path. Build the target with `pathToFileURL(path).href`, additionally encoding parentheses; spaces, `#`, `?` and `%` must be encoded as URL data, not interpreted as delimiters.
- Preserve `:42`, `:42-50` and `:42:7` suffixes in the visible receipt, but leave them out of the file target. Row 3's receipt parser must audit the decoded target and the visible line suffix, accepting both bare and linked receipts. An openable file is not itself proof of the receipt's claim.
- Render bare http(s) URLs as CommonMark autolinks, displayed once. Keep trailing `.,;:!?'"` and an unbalanced closing parenthesis outside the link. Preserve existing links without double-linking them.
- Map `pr://` and `issue://` to the repository host's web URLs. Support short, owner/repo and host/owner/repo forms, numbered items and lists; carry list filters (`state`, `author`, `label`, `search`) into the matching pulls/issues search. Map PR `/diff`, `/diff/all` and `/diff/<i>` to the PR's files page; retain `/diff/<i>` visibly rather than inventing a file-hash anchor.
- Resolve the default host and repository once per session from `gh repo view --json nameWithOwner,url` in the session cwd, with literal argv and an `origin` remote fallback on failure.
- On plain-text surfaces, render the absolute path followed by its parenthesized file URL, wrapping both halves in OSC 8. The ledger tool's result and `ui.notify` use this form; ordinary http(s) links remain openable.

### Session-bound handles and raw storage

**PMDW**
For current-caller content, resolve `agent://`, `artifact://`, `history://`, `local://`, `memory://` and `skill://` in that caller's session, using the host's process-global internal-URL router with a caller-scoped resolve context. Include cwd, session file, session id and `localProtocolOptions`; obtain skills from that caller's `pi.getCommands()`, never the process-global skill set. Supply `rules: []` to block unsafe global fallback. The session that displays a ledger body is not evidence of that body's originating session.

For `skill://`, use the caller's skill command entry: the skill's file for the root handle, or a path relative to that file's directory for a subpath. Link only an existing target whose real path is equal to or beneath that directory's real path. A symlink or `..` escape, including a sibling skill in the same plugin, stays plain. Missing entries when skill commands are disabled stay plain too.

A current-caller handle links only when lookup returns a path. Null, thrown, unknown-id and no-session results leave the original text unchanged; they do not invent a target. Async lookup belongs in model-message handlers and lane-tool storage. Synchronous current-caller custom-message rendering uses `locateSync` and can resolve only `local://` and `memory://` under this contract. Ledger-sourced rendering instead leaves every residual session-bound handle plain, including `local://` and `memory://`, even if the displaying session has a same-named file. Do not reconstruct an old session or fall back to the emitter's root.

Documents, decision logs, commits and ledger rows retain raw paths and stable citation anchors, never display markdown file links or file URLs. Before storage, `lane_message`, `lane_raise_question` and `lane_record_entry` expand locatable session-bound handles in their bodies into plain absolute paths using the lane's full resolve context. Unlocatable handles stay as written. This preserves a plan question's bare first-line path and avoids requiring Ilex to resolve another lane's session later. Stored paths become clickable only when rendered. Do not replace the stable-anchor rules in the output-types contract with line-number-only citations.

### Rendering choke points

**PMDW**
Use the same idempotent renderer at each output boundary:

- `gates/extensions/open-links.ts`: an async `assistant_message` handler rewrites model text for every as2 session and the default-profile seats. Register it before receipt/turn-shape consumers in `gates/index.ts`, so rows 1, 15 and 3 read the rewritten text. Use the host's router export, not an isolated module copy with different session registries.
- Run all handle lookups for a message concurrently within one shared three-second bound. Repository discovery has its own finite two-second total budget, with at most one second for each actual `gh`/`git` execution. Link paths, URLs and handles resolved by the handle deadline. Leave a still-pending handle unchanged in the settled message; if it later resolves, queue a display-only follow-up until `agent_end` and a confirmed idle state. A null or thrown result sends nothing; a never-settling lookup holds back nothing else.
- `linkedApi(pi, ctx, router, provenance)`: synchronously rewrite custom `sendMessage` content, `before_agent_start` message results and `ctx.ui.notify`. Preserve same-call delivery and existing order: no async queue. The explicit provenance is `"current-caller"` by default; ledger-reading producers select `"ledger"`, which prevents `syncHandles` from consulting the current session's router. The surface entry binds wake/needs-you/notices/Applied, pending/input echoes, ledger-derived plan-path lines and lane instruction/result asides to the ledger policy; gates bind row 7's question-bearing wake to it. Other custom-message producers and model replies retain current-caller resolution. Do not guess provenance from a filename, handle text or custom message type.
- `orchestrator_ledger`: always apply the ledger provenance policy to the linked result for the model, then an OSC 8 `renderResult` for Jo. Stored absolute paths and URLs still link; unknown-origin handles stay plain in both views. A missing host Text renderer reports an explicit display error without preventing the ledger read itself. Other tool output remains verbatim.
- Interrupted assistant replies: when `message_end` reports `aborted` or `error` without `assistant_message`, queue one display-only message headed "links in the interrupted reply:" with linked paths and URLs from the interrupted text. Flush only after `agent_end` and confirmed idle state, never through busy-session steering. Exclude this and late-lookup follow-ups from model context and compaction; invalidate pending display work on session reset.
- Hands render within their own sessions; their relayed text can pass through rendering again without double-linking. Classifier context rewrites are model-only, not another Jo-facing custom-message source.

### Installation and file opening

**PMDW**
Install the herdr plugin at `install/herdr-file-links`: id `as2.file-links`, action `open-file` invoking its `open-file.sh`, and a `^file://` link handler. Decode URLs into literal argv for `AS2_OPEN_BIN` (default `/usr/bin/open`). Never dispatch a file to its default handler: safe non-executable regular text documents use `-t`; directories, unknown formats, scripts, executables and symlink paths use reveal-only `-R`. App/bundle targets and ancestors are refused, including canonical aliases. Missing files reveal only their immediate existing parent, subject to the same bundle checks. Reject non-file URLs. `install/install.sh` links the plugin when herdr is available; http(s) uses herdr's existing opener.

Install `~/.omp/agent/extensions/as2-open-links.ts` as a symlink to the installing checkout's `gates/extensions/open-links.ts`. The intended install runs from Jo's main checkout, not from a lane. This extends coverage to Plumb and every other default-profile OMP session, not just as2 workloads; that broader coverage is an accepted tradeoff.

## Approved limitations and upstream requests

### D1 — the draft while a reply streams

**CLAIM**
The approved rev7 plan accepts raw, unlinked draft text while OMP streams a reply: its recorded OMP investigation found no extension hook to transform that draft or setting to withhold it. The contract requires repainting settled output with links, and the interrupted-reply follow-up described under "Rendering choke points". This documentation slice has not independently reproduced the OMP investigation or observed the settled-screen smoke.

**PMDW**
Upstream OMP request: expose a stream-text transform hook, or a setting that paints only settled messages, so the first visible draft can satisfy the same link contract. Do not claim that rev7 closes this gap. Patching the installed OMP paint boundary was the rejected alternative: it would live outside this repository and be lost on upgrades. This item records the request; it does not claim an upstream issue has been filed or shipped.

### D2 — handles that stay plain text

**CLAIM**
The rev7 contract, extended by Jo's plain answer `in-mvfm7l291h5jpc` to `q-mvfka1g4kovg8w`, accepts these categories:

1. `xd://`, `omp://` and `mcp://`: virtual tool devices, harness documents or remote resources with no openable local target under this plan. Do not invent a file target or silently cache a copy.
2. `rule://`, always; `skill://` when the caller's skill commands are disabled or the target lies outside that skill's own directory, including a sibling directory in the same plugin. Caller scoping and realpath containment take priority over a misleading link to another agent's file.
3. Handles other than `local://` and `memory://` in synchronous current-caller as2 custom messages; these schemes have no synchronous resolver under this contract.
4. Every residual session-bound handle in ledger-sourced content, including legacy `local://` and `memory://` handles in wakes, on-demand ledger reads, relayed lane messages/questions and Applied lines. Unknown origin means plain text, not lookup in Ilex's root: even an existing same-named Ilex file is unrelated evidence. No old-session recovery or emitter-root fallback is performed. Newly written lane message, question and entry bodies still expand locatable handles with the original caller's context before storage, retaining raw absolute paths; handles that could not be located stay plain on later ledger rendering. Current-session model text and non-ledger custom messages are not covered by this ledger restriction.

**PMDW**
Upstream OMP request: expose the calling agent's filtered rules through an extension seam, so `rule://` can resolve without reading global rules belonging to another agent. Until that caller-scoped source exists, retain `rules: []` and leave every `rule://` plain. Do not broaden skill containment to the whole plugin as a workaround. No implementation or upstream delivery of this seam is asserted here.

### Other exclusions

**PMDW**
Keep fenced code blocks (backticks or tildes), inline code containing more than a single path/URL, and row 1's handed-over command/script lines untouched so pasted commands and review JSON retain their bytes. Inline code containing exactly one path or URL becomes a link. Preserve tool output verbatim except `orchestrator_ledger`. Thinking blocks remain untouched because the approved plan records no OMP extension seam for changing them. A missing relative file, an absolute/home path without an existing parent, or an unresolved handle remains plain. Stored documents and ledger content are not display surfaces.

## Verification and remaining click check

**ACTION**
After upstream integration at `73cf9b4`, focused groups passed: core 44/0, surface 145/0, installer/manifest 42/0. The separate unpacked baseline (`95433a0`) failed T1/T6 on absent new-module imports and T2–T5 on 14 behavior assertions, including space-bearing paths. The workload plan directory holds `FAILS-BEFORE.txt` with the baseline integrity check and exact commands.

**ACTION**
`SMOKE.md` records repeated actual OMP proof, most recently at repaired source `65896ee`: default-profile discovery linked the model's space-path and `local://` reply; the custom message used OMP read's actual target and preceded its notice; the real surface wake and first reply linked both plan fixtures. The wake ledger was a fresh Ledger-module fixture, not a copied live database, because the gate refused both backup and raw-copy commands. Production Markdown emitted the expected OSC 8 bytes; the file handler received the decoded space path through a recording opener and refused HTTPS.

**ACTION**
The first full run (`tr-0mv9827l5qt93h1`, head `0649bd5`) was red on 20 cases. Repairs make the no-op links context hook return no replacement, compose test-host context results as the real host does, discover optional installed-host sources through PATH rather than an isolated home, and replace stale close-notice prose assertions with lifecycle/target checks. The next outside-fence run `tr-0mv9b1rdy2m3bkt` was green at `220b343`: 5,143 passed, 0 failed, 99 skipped; every changed test file passed alone. Installed-host cases were skipped on that isolated runner and exercised locally in the recorded real OMP smoke instead. A later repair push requires a fresh full run.

**ACTION**
No live install, real plugin registration, application launch or Jo Ctrl-click was performed. Headless production-renderer capture does not prove terminal click behavior. Jo's post-merge/install click check remains separate. Full-suite green must come from `lane_full_test` at the PR head; the focused groups and runtime smoke do not substitute for it.

**ACTION**
The authorized same-lab final review requested repairs before integration. The hardened opener passed 42 tests and a recording-opener runtime smoke covering text mode, reveal-only navigation, executable/script/symlink handling, bundle refusal, percent-decoding and exit propagation. No real application launch was used to prove the safety boundary.

**ACTION**
The settled core/display/ledger repairs passed a combined five-file focused group: 124 tests, zero failures. Runtime smokes exercised decorated paths, punctuation filenames, prose-space receipts and independent quote offsets; actual host exec killed stalled repository-discovery commands within the two-second budget. Controlled host-boundary lifecycle smoke verified idle-only display delivery, session isolation/reset and context/compaction exclusion; this is not a live model-loop race reproduction. A production ledger-tool smoke returned fixture data despite an injected renderer-load failure. These results precede the legacy-handle policy repair and do not verify it.

**ACTION**
The legacy-handle repair was exercised before integration: the same-named lane/Ilex regression failed before the repair (0 passed / 2 failed) and passed after it (2 passed / 0 failed). The seven-file focused group passed 213/0. The actual-host runtime smoke used LocalProtocolHandler, production renderWake/linkedApi and installed-host Text: original-caller storage and current-caller links stayed distinct, old ledger handles stayed plain despite same-named Ilex files, and stored space-bearing absolute paths linked. These are production-module boundary proofs, not a live model-loop race or terminal click. `LEGACY-R1-VERIFICATION.md` in the workload plan directory records the commands under "Regression proof" and "Runtime observation".

**ACTION**
Historical integration head `03b77e218a54ba5a5dc33a50138d52463c8692d5` passed the eight-file focused group (257/0) and outside runner `tr-0mvfmjaloyz6a20` (5,461 passed / 0 failed / 99 skipped; every changed test file alone green), recorded under "Integration receipt" in `LEGACY-R1-VERIFICATION.md`. That green predates subsequent parser performance repairs. The repairs have failing-before/passing-after freeze guards for ordinary prose, repeated relative paths and test-run JSON rows. Real-ledger row measurements preserve byte-identical Markdown/terminal outputs while pruning candidate extension at the first nonexistent directory prefix; valid space-bearing paths still use longest-existing selection without an artificial length cap. `PERF-R2-VERIFICATION.md`, `PERF-R3-VERIFICATION.md` and their raw-sample files in the workload plan directory record the exercised workloads and limits. Consult PR 219 and its current runner receipt for final-head full-suite status, not this historical result.

**ACTION**
The round-four review's separator compatibility regression is repaired: space-bearing paths remain complete links in compact tables and before `|`, `–` or `—` followed by another slash. The new real-filesystem regression fails on unpacked `c5d4238` (0 passed / 1 failed, a partial `My` target) and passes after the repair (1 passed / 0 failed, 14 assertions). A separate runtime probe observes the complete `%20` Markdown and OSC 8 targets. The extra candidate is an existing whitespace-token end, never a synthetic slash endpoint; ordinary missing descendants retain their pruning. `SEPARATOR-R4-VERIFICATION.md` in the workload plan directory records the before/after proof.
