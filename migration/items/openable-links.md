---
title: Openable file paths and URLs on every as2 agent surface
status: building
workload: wl-mv720a2pph9d6o
pr: 219
---

## Scope and decision

**CLAIM**
This item records the Jo-approved rev7 render contract for workload `wl-mv720a2pph9d6o`, not a claim of completed runtime verification. Jo's instruction `in-mv8uirkfn6oiyo` widens the original file-path request to every file path and URL any as2 agent shows Jo in OMP inside herdr inside kitty, including Ilex, lanes, hands and advisor seats such as Plumb. The accepted D1/D2 limits are recorded below.

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
Resolve `agent://`, `artifact://`, `history://`, `local://`, `memory://` and `skill://` in the emitting session, using the host's process-global internal-URL router with a caller-scoped resolve context. Include cwd, session file, session id and `localProtocolOptions`; obtain skills from that caller's `pi.getCommands()`, never the process-global skill set. Supply `rules: []` to block unsafe global fallback.

For `skill://`, use the caller's skill command entry: the skill's file for the root handle, or a path relative to that file's directory for a subpath. Link only an existing target whose real path is equal to or beneath that directory's real path. A symlink or `..` escape, including a sibling skill in the same plugin, stays plain. Missing entries when skill commands are disabled stay plain too.

A handle links only when lookup returns a path. Null, thrown, unknown-id and no-session results leave the original text unchanged; they do not invent a target. Async lookup belongs in model-message handlers and lane-tool storage. Synchronous custom-message rendering uses `locateSync` and can resolve only `local://` and `memory://` under this contract.

Documents, decision logs, commits and ledger rows retain raw paths and stable citation anchors, never display markdown file links or file URLs. Before storage, `lane_message`, `lane_raise_question` and `lane_record_entry` expand locatable session-bound handles in their bodies into plain absolute paths using the lane's full resolve context. Unlocatable handles stay as written. This preserves a plan question's bare first-line path and avoids requiring Ilex to resolve another lane's session later. Stored paths become clickable only when rendered. Do not replace the stable-anchor rules in the output-types contract with line-number-only citations.

### Rendering choke points

**PMDW**
Use the same idempotent renderer at each output boundary:

- `gates/extensions/open-links.ts`: an async `assistant_message` handler rewrites model text for every as2 session and the default-profile seats. Register it before receipt/turn-shape consumers in `gates/index.ts`, so rows 1, 15 and 3 read the rewritten text. Use the host's router export, not an isolated module copy with different session registries.
- Run all lookups for a message concurrently within one shared three-second bound. Link paths, URLs and handles resolved by that point. Leave a still-pending handle unchanged in the settled message; if it later resolves to a path, send one display-only follow-up link message. A null or thrown result sends nothing; a never-settling lookup holds back nothing else.
- `linkedApi(pi, ctx)`: synchronously rewrite custom `sendMessage` content, `before_agent_start` message results and `ctx.ui.notify`. Preserve same-call delivery and existing order: no async queue. Wrap both surface and gates entry points, including wake blocks, notices, plan-path lines, Applied lines, relayed messages/questions and lane-side asides. `plan-path.ts` must use this renderer rather than its own escaping convention.
- `orchestrator_ledger`: provide a linked result for the model and an OSC 8 `renderResult` for Jo. Other tool output remains verbatim.
- Interrupted assistant replies: when `message_end` reports `aborted` or `error` without `assistant_message`, send one display-only message headed "links in the interrupted reply:" with linked paths and URLs from the interrupted text. Exclude this and late-lookup follow-ups from model context.
- Hands render within their own sessions; their relayed text can pass through rendering again without double-linking. Classifier context rewrites are model-only, not another Jo-facing custom-message source.

### Installation and file opening

**PMDW**
Install the herdr plugin at `install/herdr-file-links`: id `as2.file-links`, action `open-file` invoking its `open-file.sh`, and a `^file://` link handler. Decode the URL and open the existing file with `AS2_OPEN_BIN` (default `/usr/bin/open`), passing the path after `--`. If only the parent exists, open the parent; reject non-file URLs. `install/install.sh` links the plugin when herdr is available; http(s) uses herdr's existing opener.

Install `~/.omp/agent/extensions/as2-open-links.ts` as a symlink to the installing checkout's `gates/extensions/open-links.ts`. The intended install runs from Jo's main checkout, not from a lane. This extends coverage to Plumb and every other default-profile OMP session, not just as2 workloads; that broader coverage is an accepted tradeoff.

## Approved limitations and upstream requests

### D1 — the draft while a reply streams

**CLAIM**
The approved rev7 plan accepts raw, unlinked draft text while OMP streams a reply: its recorded OMP investigation found no extension hook to transform that draft or setting to withhold it. The contract requires repainting settled output with links, and the interrupted-reply follow-up described under "Rendering choke points". This documentation slice has not independently reproduced the OMP investigation or observed the settled-screen smoke.

**PMDW**
Upstream OMP request: expose a stream-text transform hook, or a setting that paints only settled messages, so the first visible draft can satisfy the same link contract. Do not claim that rev7 closes this gap. Patching the installed OMP paint boundary was the rejected alternative: it would live outside this repository and be lost on upgrades. This item records the request; it does not claim an upstream issue has been filed or shipped.

### D2 — handles that stay plain text

**CLAIM**
The approved rev7 contract accepts these three categories unchanged:

1. `xd://`, `omp://` and `mcp://`: virtual tool devices, harness documents or remote resources with no openable local target under this plan. Do not invent a file target or silently cache a copy.
2. `rule://`, always; `skill://` when the caller's skill commands are disabled or the target lies outside that skill's own directory, including a sibling directory in the same plugin. Caller scoping and realpath containment take priority over a misleading link to another agent's file.
3. Handles other than `local://` and `memory://` in synchronous as2 custom messages. The approved plan identifies legacy ledger rows, written before lane-tool expansion, as this source. Newly written lane bodies store locatable handles as absolute paths; unlocatable handles still remain plain.

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
The first full run (`tr-0mv9827l5qt93h1`, head `0649bd5`) was red on 20 cases. Repairs make the no-op links context hook return no replacement, compose test-host context results as the real host does, discover optional installed-host sources through PATH rather than an isolated home, and replace stale close-notice prose assertions with lifecycle/target checks. Focused model-view cases passed 21/0 with one skip; the three reported close-notice scenarios passed. Local nested-sandbox controls cannot run under the lane's outer sandbox; the next outside-fence full run remains required.

**ACTION**
No live install, real plugin registration, application launch or Jo Ctrl-click was performed. Headless production-renderer capture does not prove terminal click behavior. Jo's post-merge/install click check remains separate. Full-suite green must come from `lane_full_test` at the PR head; the focused groups and runtime smoke do not substitute for it.
