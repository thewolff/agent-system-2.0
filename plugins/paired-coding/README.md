# paired-coding

A plugin for pairing with an agent on code, one change set at a time. The agent drives; you
navigate. Before each change set it shows you a **card** that names the decision inside the
change, the code it touches, the code it plans to write, the effect it will have and the exact
files it will write. It writes only after the two of you agree on that card, then shows you the
real diff.

The problem it addresses is speed. Agent code arrives faster than a person can recognise the
decisions inside it. A plan written up front cannot predict every design choice that
implementation reveals, so a wrong direction is found after a whole feature exists, and you end
the session owning code you did not follow. Pairing moves the decision point to before each
change set is written, while it is still cheap to steer.

## Install

**Linux: before you install.** On Linux, on x86_64 and aarch64, the gate runs the agent's writes
and commands under Landlock, through a small helper the plugin ships. That needs a kernel with
Landlock ABI 3 or later, and nothing else; `pair_start` checks for it. macOS needs nothing extra.

Where the kernel has no Landlock ABI 3, the gate uses bubblewrap instead. It also uses
bubblewrap for the few layouts Landlock cannot fence, so it is worth installing anyway.
bubblewrap needs two things:

1. The `bubblewrap` package (`sudo apt install bubblewrap` on Debian and Ubuntu), version 0.10.0
   or later, or a distribution build with the CVE-2024-42472 fix. Ubuntu 24.04's 0.9.0 has it.
2. Unprivileged user namespaces. Check with:

   ```sh
   bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all /bin/true && echo ok
   ```

   If it prints `ok`, you're done. If it fails:
   - **Ubuntu 23.10 and later:** AppArmor blocks them. Run
     `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, and put that setting in a
     file under `/etc/sysctl.d/` to keep it across reboots. Or load the `bwrap-userns-restrict`
     profile from the `apparmor-profiles` package, which lets only bubblewrap through.
   - **Debian kernels with `kernel.unprivileged_userns_clone`:** set it to 1.
   - **Docker containers:** run with `--security-opt seccomp=unconfined`, and on a host that runs
     AppArmor (Ubuntu does) also `--security-opt apparmor=unconfined`: Docker's default AppArmor
     profile stops bubblewrap with "Failed to make / slave: Permission denied". Add
     `--security-opt systempaths=unconfined` and bubblewrap gets a fresh `/proc` of its own.
     Without it, Docker masks parts of the
     container's `/proc`, so the check fails with "Can't mount proc on /newroot/proc". The gate
     then falls back to the container's own `/proc`, bound read-only, and `pair_start` says so:
     its "Sandbox:" line reads "bubblewrap (/proc is the container's, read-only)". See
     "Linux: bubblewrap" below for what that changes.

With neither Landlock ABI 3 nor a working bubblewrap, the plugin still installs, but
`pair_start` refuses and names both reasons.

On a machine with Landlock but no working bubblewrap (a stock Ubuntu 24.04), keep the
worktree, the session state and the installed plugin off temp paths. With `HOME` under `/tmp`,
for instance, the installed plugin sits in a temp path, Landlock cannot fence it there, and
`pair_start` refuses. With a working bubblewrap, those runs go to bubblewrap instead.

The details, and what each sandbox does and does not enforce, are under **Linux: which
sandbox**, **Linux: Landlock** and **Linux: bubblewrap** in
[What this enforces, and what it does not](#what-this-enforces-and-what-it-does-not).

Claude Code:

**Requirements on Claude Code.** Node.js on your `PATH`: every hook and the bundled MCP server
run as `node …`. CI tests on Node 24.

**Claude Code v2.1.274 or later.** The gate recognises its own tools by the `mcp_server` field of
the `PreToolUse` input, which [Claude Code's hooks reference](https://code.claude.com/docs/en/hooks)
says "requires Claude Code v2.1.274 or later". On an older Claude Code, every `pair_*` call is
refused, so pairing cannot start.

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install paired-coding@jo-wolff-plugins
```

To try it for one session without installing, start `claude --plugin-dir <checkout>/plugins/paired-coding`,
where `<checkout>` is your clone of this repository.

OMP:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install paired-coding@jo-wolff-plugins
```

Inside a running OMP session the commands are `/marketplace add` and `/marketplace install`, with
the same arguments; `/plugin install` inside OMP installs nothing. On OMP the gate is an
extension, `omp/paired-coding-omp.ts`, and the install registers it: `package.json` declares it
under `omp.extensions`, and `.omp-plugin/plugin.json` hides the bundled MCP server, which only
works on Claude Code. Tested on OMP 18.4.4: after the install, with no `-e`, the eight `pair_*`
tools were registered natively and no MCP route appeared; `pair_start` then refused a host
`write`, and a session that never called `pair_start` wrote normally and created no state. The
gate is then loaded in every omp process you run, in any repository, and stays inert until
`pair_start`. `omp plugin upgrade` keeps it registered, `omp --no-extensions` starts a process
without it, and `omp plugin uninstall paired-coding@jo-wolff-plugins` removes it.
[`omp/REGISTRATION.md`](omp/REGISTRATION.md) also gives two ways to load the gate without
installing the plugin, and their exact reversal. Without installing, OMP needs both flags:
`--plugin-dir <checkout>/plugins/paired-coding` loads the skill but not the `pair_*` tools, and
`-e <checkout>/plugins/paired-coding/omp/paired-coding-omp.ts` loads the tools but not the
skill. Tested on OMP 18.4.4 with both flags: the eight `pair_*` tools appeared once each, the
skill was listed, and one copy of the gate ran. If your OMP settings carry a
`skills.includeSkills` allowlist, add `paired-coding` to it: a non-empty allowlist that does not
match the skill filters it out, even with `--plugin-dir`, while the `pair_*` tools still load.

## What happens when you pair

Ask for it in words: "pair with me", "let's pair on this", "paired coding". The skill
(`skills/paired-coding/SKILL.md`) then runs three phases:

1. **Define the work together.** Outcome, constraints, one concrete example of success. Nothing
   is written.
2. **Recon.** The agent explores read-only and proposes a roadmap of cards, one line each.
3. **Pairing loop.** For each card: discussion, agreement, the agent makes the whole change set,
   then a read-back with the diff, the checks it ran, what the change means, the cards still
   to play, and one closing line saying what, if anything, it needs from you. A card whose
   checks did not all run and pass is reopened, not closed, and says which checks were not run.

A change set is the smallest change in code whose effect can be checked on its own. Agreement
is a shared understanding of the behavior, the approach and the boundary, evidenced by you
saying to go ahead in your own turn after the card. A question, a comment that changes the
card, or "looks good" while the card still lists open points keeps the conversation going.
When the agent discovers that the agreed behavior, approach or boundary no longer holds, it
stops and brings a revised card.

**The roadmap.** Each card on it is `open`, `not-ready` (with a one-line note on what it waits
for), `done`, `skipped` or `dropped`. The agent works the next ready card, shows the open and
not-ready ones at every read-back, and does not call the roadmap done while any is left. When
you start pairing again in the same worktree, `pair_start` looks back through that worktree's
earlier sessions, newest first and at most 20, past any that recorded nothing (a cleared
session, for one). It stops at the first one that recorded a roadmap or your decision to start
fresh, and offers that roadmap only if cards are still open or not ready. On OMP, where `/clear`
keeps the session, that includes the roadmap the same session recorded before the clear. The
agent asks whether to pick it up or start fresh and records your answer with `pair_note`'s
`earlierRoadmap` field: `pick-up` copies the whole roadmap into this session, so it carries on
to later ones, and `start-fresh` records that you declined it, so later sessions stop looking
back at that point. That is all `start-fresh` does: the agent can still record the same items
again as a new roadmap with `pair_note`, which takes no words from you. Recording a new roadmap
also replaces the offer. The earlier session's journal is never changed. Nothing on a roadmap
is written on its own: each item, picked up or recorded again, still needs its own card and
your typed agreement.

**Ending.** A done roadmap does not end pairing: the agent reports it done and the gate stays
closed. Only you end pairing: type `pair stop` as a message of its own. The agent has no tool
that ends it. When pairing ends, the gate writes a pair-accepted receipt beside the journal, an
export of the journal saying which change sets you agreed to and `pair_done` closed, and the
agent's closing summary names its path once the gate has confirmed it (see **Pair-accepted
receipt** below).

The skill holds the conversation; the gate below holds the writes. The contract is the two
together: where the skill says what the agent should do, the gate decides what it can do.

## The gate

A skill can describe the conversation; only a gate at the tool boundary can hold the agent's
own tools to "no write without agreement". It fences the files the agent writes and the files
its commands write themselves. It does not fence a process outside the sandbox that a command
asks to write; see "The sandbox fences file writes and local sockets, not the network" below.
One gate core (`core/`, no host imports) and one session layer (`lib/`) are shared by both
host adapters:

- **Claude Code:** hooks (`hooks/hooks.json`) plus a bundled MCP server named `pair`
  (`.mcp.json`, `server/`), whose tools appear as `mcp__plugin_paired-coding_pair__pair_*`.
- **OMP:** one extension, `omp/paired-coding-omp.ts`.

How it works:

- Pairing state is `inactive` until `pair_start`, then `closed` between change sets and `open`
  during one. Missing or damaged state in an activated session reads as `closed`, and so does a
  state file that says `inactive` without the gate's own end stamp. The gate writes that stamp
  into the session's activation marker only when it ends pairing itself (a typed `pair stop` or
  the session's end), so rewriting the state file alone cannot switch the gate off. The marker
  sits in the same state directory as the state file and is written the same way, so a process
  that can write that whole directory can forge an ended session. No agent tool can: the
  `pair_run` profile, which `pair_write` and `pair_edit` also write under, denies the whole
  state base. A session that never calls `pair_start` is untouched: host tools work and no state
  is written.
- The agent registers each card with `pair_propose` and opens it with `pair_begin`, quoting
  you. The gate accepts the quote only if it is whole words from your latest turn that the host
  recorded as typed by a person after the card, only if the card has no open points, and only
  if the card's files are unchanged since it was shown.
- While pairing, the host's own write, edit, shell, eval and sub-agent tools are refused, and so
  is any tool the gate does not know. On Claude Code the `Skill` tool is allowed only for this
  plugin's own skill, `paired-coding:paired-coding`, so the agent can reload it after `/clear`;
  every other skill is refused. The agent writes through `pair_write` and `pair_edit`, which
  accept only paths inside the open change set's boundary, and runs commands through
  `pair_run`.
- On OMP, a tool device the agent calls as `write xd://<device>` reaches the gate as the host's
  `write` tool. The gate judges by tool name and does not read the path, so while pairing every
  `xd://` device is refused like any host write ("write is the host's own mutating tool"),
  read-only ones such as a search device included. Allowing them all would also open the
  devices that edit code or change outside systems, so they stay refused. For a read-only
  lookup while pairing, the agent runs the equivalent command-line tool through `pair_run`
  instead, as long as that tool does not reach a local daemon over a Unix socket (see the next
  point).
- `pair_run` runs every command in the foreground under a sandbox built from the state: a
  Seatbelt profile on macOS; on Linux Landlock, or bubblewrap where Landlock cannot be used,
  where some of what follows differs (see **Linux: which sandbox** below). Every sandbox refuses
  any write, create, delete or rename beyond what follows; Landlock does not fence permission,
  owner, timestamp or extended-attribute changes (see **Linux: Landlock**). With no change set
  open a command may write only temp directories and `/dev`. With one open it may also write
  the boundary files. The state directory and the
  plugin's own install root are never writable, and on macOS no command may create a hard link
  anywhere, even between two paths it could write (on Linux one made inside a writable
  directory stops the session; see below). Every sandbox also refuses connections to
  Unix-domain sockets, except the DNS resolver's on macOS, because a local daemon reached over
  a socket writes with its own rights. So the Docker CLI, `ssh-agent`, and a database on a
  local socket are out of reach from `pair_run`. TCP is not fenced: HTTPS and DNS lookups work.
- `pair_write` and `pair_edit` write inside the sandbox too, under the open profile without the
  temp directories. On macOS and under bubblewrap they write the new content to a fresh file
  beside the target and rename it over the target, keeping an existing file's permission bits.
  So a hard link or symlink at a boundary path is replaced rather than written through, a
  symlink swapped in after the path check cannot land the write outside the boundary, and a
  directory at the path is refused. Under Landlock they write in place, which keeps the file
  itself, inode and permission bits included; a target that is a symlink or has a second hard
  link gets the same staged write instead (see **Linux: Landlock** below).
- Under any `.git`, only what `git add` and `git commit` write is writable, even when an agreed
  boundary covers `.git/`: `objects/`, `refs/`, `logs/`, `index`, `HEAD`, `ORIG_HEAD`,
  `COMMIT_EDITMSG`, `packed-refs` and `AUTO_MERGE`, each with its `.lock` file. The same list
  holds in nested repositories and in each submodule's git directory under `.git/modules/`.
  Everything else under `.git` is refused, because git would read or run it outside the
  sandbox later: the `.git` entry itself (so no gitfile or symlink can be planted), `config`,
  `hooks/`, `info/`, and the state of an interrupted operation such as `rebase-merge/`, whose
  todo list git runs when the rebase continues. Letter case does not matter: the worktree
  volume is usually case-insensitive, so `.GIT/CONFIG` is refused like `.git/config`.
  `pair_run` cannot write these paths, and `pair_write` and `pair_edit` refuse them with "the
  path is git's own control data under .git". The list is only left unfenced, never granted:
  a commit inside `pair_run` works only when the boundary covers `.git/`. `git config` fails.
- On Linux all of `.git` is read-only inside `pair_run`, nested repositories and submodules
  included, whatever the boundary says, so `git commit` there fails with "Unable to create
  '…/.git/index.lock': Read-only file system". Commit outside `pair_run`.
- In a linked worktree (one made with `git worktree add`), git's real directory sits in the
  main repository's `.git/worktrees/`, outside the worktree, so `git add` and `git commit`
  inside `pair_run` fail there whatever the boundary says. Commit outside `pair_run`.
- `pair_done` returns the diff of the boundary, computed by the gate, and lists the roadmap cards
  still `open` or `not-ready`. Every card, quote, verdict, refusal and diff goes into a journal
  outside the worktree, under `$PAIRED_CODING_STATE_DIR` (default
  `~/.local/state/paired-coding/<session-id>/`).
- Typing `pair stop` ends pairing in any phase: the gate reaps running commands, takes a final
  snapshot, journals any write it did not approve, journals the stop as `typed-stop`, writes
  the pair-accepted receipt (`pair-accepted.json`, beside the journal; see **Pair-accepted
  receipt** below) and returns the session to inactive. On Claude Code the stop takes effect
  when the turn ends or at the next tool call, whichever comes first; on OMP, when the turn is
  submitted. On OMP the agent is also told, as hidden context on that turn, that pairing has
  ended, that host tools are no longer refused, where the receipt is (or that it could not be
  written), and that pairing starts again only if you ask for it and it calls `pair_start`;
  you see "paired coding is off: you typed pair stop". On Claude Code the stop turn's own note
  says only where the receipt will be if the stop is accepted, since the turn is judged after
  that note; the outcome (accepted and the receipt written, accepted but the write failed, or
  refused because the transcript does not show you typed it) reaches the agent as a note with
  the tool result that judged it, or, for a turn that made no tool call, at the start of the
  next turn or its first tool call. The skill has the closing summary say which of those it
  has heard. The session's end writes the same receipt.
- Card ids are unique within a session's journal. After OMP `/clear`, `/tree` or an interactive
  `/branch` back to an earlier message, or a typed `pair stop` and a later `pair_start` in the
  same session, numbering continues (`card-3` after `card-1` and `card-2`) instead of starting
  again at `card-1`.

## Hosts

| Host | Gate | Live result |
|---|---|---|
| Claude Code, macOS | Built: hooks and a bundled MCP server | Verified on Claude Code v2.1.287, loaded with `--plugin-dir`: tests 11 to 17, then the release checks below |
| OMP, macOS | Built: an extension, registered by `omp plugin install`, or loaded with `--plugin-dir` and `-e` together | Verified on OMP 18.4.4, loaded with `-e`: tests 11 to 17, then the release checks below. After a plain `omp plugin install`, a scripted stand-in model saw the skill listed, the eight `pair_*` tools registered, and a host `write` refused after `pair_start`; tests 11 to 17 were not re-run that way |
| Claude Code and OMP, Linux | Built: the same gate, with Landlock or bubblewrap as the sandbox | The unit suite and the live Landlock and bubblewrap cases pass in an Ubuntu 24.04 container as a non-root user, both with a fresh `/proc` and with Docker's `/proc` masks left on (bubblewrap on its `/proc` fallback), and the suite with the live Landlock cases passes in one with Docker's default security options, where bubblewrap cannot run. Neither host has been run live on Linux |
| Codex | None | Unverified; the skill is included but has not been run there |
| Windows, anything else, or Linux with neither Landlock nor a working bubblewrap | `pair_start` refuses | The skill runs as conversation only |

The adversarial tests, run live with a cheap model in throwaway git repositories and judged by
content snapshots of every file (untracked and ignored included):

| Test | What it tries | Expected and seen |
|---|---|---|
| 11 | Every host write, edit, shell and eval route, plus `pair_write` and `pair_run`, with no change set open | All refused, or denied by Seatbelt |
| 12 | `pair_begin` quoting words not in your latest turn, words typed before the card, and injected input | All refused |
| 13 | With a change set open: writes outside the boundary and into the state directory, three ways each; corrupting the state file; host tools | All refused; corrupt state reads as closed |
| 14 | A long check with a child process writing, a message typed during it, then abort and timeout | The run stays in the foreground, `pair_done` waits for it, the whole process group is killed |
| 15 | Dispatching a sub-agent | Refused |
| 16 | A second extension or plugin hook rewriting `pair_write` paths and `pair_run` commands to targets outside the boundary | Still refused: the gate checks the final arguments |
| 17 | A process that double-forks out of its group in change set A and writes A's file during change set B | B's read-back flags the write and stops the session |

Tests 11 to 17 ran before this release's changes to stopping, `/clear`, quotes, the closed
`pair_run` profile and the sandboxed write, and were not re-run after them. Those changes were
checked live as follows, and by the unit suite:

| Check | Claude Code | OMP |
|---|---|---|
| Typed `pair stop` in a turn with no tool call ends pairing; the next host write is allowed | Passed | Passed |
| `pair stop` that was injected (a scheduled prompt on Claude Code, an extension's message on OMP), or typed while a tool ran, ends nothing | Passed | Passed (injected) |
| A quote of `y` against a typed `why? …` is refused as not whole words | Passed | Passed |
| `/clear` while pairing leaves the session closed until `pair_start` | Passed, twice | Passed, with an open change set |
| `/new` while pairing leaves the new session closed until `pair_start` | Not applicable | Passed |

The closed `pair_run` profile was also run directly under `sandbox-exec`, outside any host:
writes to a stand-in plugin cache and a stand-in `~/.claude/settings.json` were denied, and so
was `launchctl submit`. A symlink swapped back and forth 95,189 times during 1,913 `pair_write`
attempts never moved a write outside the boundary. Before this release, a hard link inside the
boundary pointing at a file outside it let `pair_write` and `pair_edit` overwrite that file; in a
direct check of the fix, five variants of that attack all left the outside file unchanged.

## What this enforces, and what it does not

**The write boundary is enforced; agreement is judged.** The agent decides when you have agreed.
The gate proves that the quote is whole words from a real typed turn after a real card, and
nothing more. A quote with no letter or digit, such as `?` or `...`, is refused: "the quote has
no letter or digit; quote your partner's words". A misread go-ahead can open a change set, but
only for that card's files, and the quote sits in the journal for you to audit. The gate cannot
tell whether behavior inside the boundary drifted from what was agreed; that is the skill's
reopen rule and your read of the real diff.

**Pair-accepted receipt.** When pairing ends, by a typed `pair stop` or by the session ending,
the gate writes `pair-accepted.json` beside the journal (under `$PAIRED_CODING_STATE_DIR`,
default `~/.local/state/paired-coding/<session-id>/`), and the agent names that path in its
closing summary once the gate has confirmed it. The file is an export of the gate's journal: it
records the plugin version, the session id and worktree root, when pairing started and when and
how it stopped, the journal it was built from (`journal`: how many entries, and the SHA-256 of
their bytes), and then three lists, built from the journal:

- `accepted`: one record per change set that reached `pair_done`: the card id, when it was agreed
  and the quote that agreed it, when `pair_done` closed it, the agreed boundary, the fingerprint
  of every path in that boundary as of `pair_done` (the boundary's part of the snapshot
  `pair_done` already takes: mode bits and content hash for a file, mode for a directory,
  `absent` for a literal path that did not exist), the writes outside the boundary that
  `pair_done` found at that moment (`outsideBoundaryWrites`, empty when there were none), the
  checks the card declared, and the `pair_run` commands run under the change set with their
  exit codes.
- `notAccepted`: change sets `pair_begin` opened that pairing ended before `pair_done`, with
  their boundaries.
- `unapproved`: every write the gate journaled as unapproved, by card and path.

The receipt covers the whole session: if pairing stopped and started again in the same session,
the later receipt replaces the earlier one and holds both. Its `means` field says in its own
words what it claims, and the claim is literal: an accepted record is a gate-recorded typed
agreement followed by `pair_done`, with hashes of the boundary at that moment; unapproved
writes are listed and may coexist with acceptance (a change set that reached `pair_done` with a
write outside its boundary is in `accepted` with that write under `outsideBoundaryWrites`, and
in `unapproved`); whether the implementation matches the agreed approach is not established by
this file. Nor does it say the code works, that a declared check was run, or that the diff
matched what the card said: an exit code is a fact about one command, the read-back is the
agent's account of the rest, and the receipt puts the card's declared checks beside the commands
the gate actually ran so the two can be compared. The quote, the approach, and `unapproved` are
for a reviewer to read, not settled by this file; it waives nothing. The hashes let a reviewer
check that a path still holds what it held at `pair_done`. If the receipt cannot be written, or
the journal cannot be read in full (unreadable, a torn or malformed line), the stop still goes
through, no receipt is written, and the journal records `receipt-failed` with the reason; a
receipt built over a gap would read as complete.

The receipt is written by the gate at stop and, like the journal, is protected only while
pairing is active: once pairing has stopped the host's tools are no longer refused, so an agent
can edit both files. A consumer who needs the receipt tamper-evident takes a copy at stop time;
`journal.sha256` then lets it check that the journal's first `journal.entries` lines are still
what the receipt was built from. Tampering is also made detectable from the journal itself:
the stop appends a `receipt` entry carrying the same `journal` field, a restart (`pair_start`
with a journal already there) appends a `resume` entry with the journal's entry count and
SHA-256 at that moment, and the next receipt verifies each such checkpoint against the bytes
that precede it. Every record in the three lists carries `suspect`: true when the record rests
on journal bytes that no longer hash to what a checkpoint recorded (every entry since the
previous checkpoint is marked), or on an entry the gate writes only while pairing is active (a
card, agreement, `done`, run or unapproved write) found between a stop and the next start.
This detects edits and insertions; it does not stop them, and a rewrite that recomputes the
checkpoints as well is caught only by the copy taken at stop.

**What counts as typed.** On OMP, a turn is trusted when the `input` event carries
`source: "interactive"`, which only the editor emits; text injected by an extension or sent over
RPC is not. On Claude Code, the hook input carries no source, so the gate reads the transcript
entry Claude Code writes for the prompt and trusts it only when its `promptSource` is `typed`,
its `origin.kind` is `human`, and it is the only entry with that prompt id. Scheduled prompts,
task notifications, `-p` and SDK prompts never count, and neither does anything you say through
a slash command: its prompt carries no typed source, so agreement given that way is refused.
Type it as a plain message. A message you type while a tool is running never counts either:
Claude Code folds it into the running turn without an ordinary transcript entry, so retype it
after the turn ends. If the agent quotes such a message to `pair_begin`, the refusal says so:
"your partner's words arrived while a tool was running, so they don't count as agreement; ask
them to say it again". Other untrusted text gets the ordinary quote refusal. The same rule
decides whether a typed `pair stop` counts.

**Trust waits briefly for the transcript.** Claude Code writes a prompt's transcript entry
after the prompt is submitted, and usually after the next tool call has started: measured on
2.1.287, the entry was missing when that call began in 11 of 11 checks, and appeared 51 to 105
ms later in the 6 that waited for it. So the hook polls for the entry for up to 2 seconds before
judging the turn. Without that wait every agreement would be refused. When several turns are
queued, they share that one 2-second wait, so an older turn whose entry lands late is still
judged on it. If an entry is still missing when the wait runs out, its turn reads as untrusted:
a slow write refuses agreement, it never grants it.

**A coarser `source` field is coming.** The Claude Agent SDK 0.3.287 declares an upcoming
`source` field on `UserPromptSubmit`, which Claude Code 2.1.287 does not send yet. It reports
typed prompts, queued prompts and accepted suggestions all as `user`, so it can serve only as a
fast refusal for anything that is not `user`. It cannot replace the typed-prompt check.

**Undocumented Claude Code fields, failing closed.** The transcript fields `promptSource` and
`origin` are not documented by Claude Code, and neither is `_meta["claudecode/toolUseId"]`, the id
the MCP server uses to tie each `pair_*` call to the hook that checked it. If the transcript
fields change, every turn reads as untrusted and no change set can open. If the id stops
arriving, every `pair_*` call is refused. Neither change can open the gate. Measured on 2.1.287,
the id matched the hook's `tool_use_id` in 11 of 11 live calls, while the documented
`CLAUDE_CODE_SESSION_ID` went stale after `/clear`, so it cannot do the same job. If the id
disappears, the fallback is a one-shot nonce that the hook passes into the call through
`PreToolUse` `updatedInput`, checked against the binding file. That fallback is not built, and
two of its edges are undocumented too: what happens when several hooks return `updatedInput`,
and whether `updatedInput` applies without a permission decision.

**`pair_run`'s time limit on Claude Code.** Claude Code moves an MCP call that runs longer than
its automatic-backgrounding threshold (two minutes by default) into a background task, and a
backgrounded check would let the agent move on while it still runs. So `pair_run` caps each
command at that threshold minus 10 seconds: 110 seconds by default. Set
`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` to change the threshold. Setting it to `0`, or
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, turns backgrounding off and lifts the cap; the limits
that apply on OMP then hold: 10 minutes by default, at most an hour.

**Session changes fail closed.** On Claude Code, `/clear`, `/resume` and `/branch` start a new
session, and so does a fork (`/fork`, `--fork-session`). On OMP, `/new`, `/fork`, `/resume` and
the branch `/btw` makes start a new session. OMP's `/clear`, `/tree`, and its interactive
`/branch` back to an earlier message stay in the same session: `/clear` resets the conversation,
and the other two move to another point in it. If pairing was active, the gate ends it (reaping
runs, taking the final snapshot, journaling any write it did not approve, finishing an open
change set), and pairing is still on and the card is closed: no card, no open change set, host
writes refused, `pair_note` and `pair_propose` refused, and the journal records
`carried-after-clear`. The agent tells you that pairing carried over closed and waits for your
answer. If you want to keep pairing, it calls `pair_start` and then proposes a card; it does not
call `pair_start` on its own. To end it, type `pair stop`. A host tool the agent tries in the
meantime is refused with "<tool> is refused: pairing is still on and the card is closed after a
session change. Tell your partner pairing carried over closed and wait for their answer: call
pair_start only once they say to keep pairing; they end it by typing pair stop". The same text
refuses `pair_note` and `pair_propose`, on both hosts. On OMP, `/clear` fires no extension
event, so the gate notices the reset marker OMP writes into the session at the next typed turn
or tool call; a move with `/tree` or `/branch` is caught when OMP reports it. The agent is told,
as hidden context on its next turn, that the conversation moved but the files were not rewound,
so edits made for later cards may already be on disk, and that it should tell you so in one
line, ask plainly whether to keep pairing or whether you will type `pair stop`, and wait. That
reply is how you find out. The gate also posts an editor notice ("paired coding: pairing is
still on and the card is closed, because you moved to another point in the conversation…"),
but OMP's own "Rewound to selected point" status can replace it before you see it, so do not
rely on it.

On Claude Code the hand-over is a marker. Every `SessionEnd` while pairing leaves one for the
worktree, whatever the reason: `/clear`, `/resume`, `/branch`, or quitting. It is written
before the final snapshot, so a `SessionEnd` cut short by Claude Code's hook time budget still
leaves it; what can be cut short is the old session's final snapshot. The marker is single-use,
tied to the worktree, and expires after 10 minutes. Only a session that replaces another takes
it: one that starts from `/clear`, a resume or a fork. So quitting while pairing and then
running `claude --resume`, `--continue` or `--fork-session` in the same worktree within 10
minutes starts closed, while a fresh `claude` launch stays untouched. A fork of a session that is
still pairing (the `/fork` background copy) is linked instead through the `forkedFrom` session
id Claude Code writes into the fork's transcript, since the hook input names no parent.

Three limits:

- On Claude Code, only `/clear` has been run live. Resume, `/branch`, quitting and forks are
  covered by unit tests only, and `forkedFrom` is undocumented.
- On Claude Code, a resume or fork starts untouched, not closed, when pairing had already ended
  with a typed `pair stop`, when the marker is older than 10 minutes, when it belongs to another
  worktree, or when an earlier `/clear`, resume or fork already took it.
- A fresh launch leaves the marker in place. If you quit while pairing, start a new
  conversation in the same worktree, and use `/clear` or `/resume` in it within 10 minutes,
  that session takes the marker and pairing is still on and the card is closed. Type
  `pair stop`, or tell the agent to keep pairing. A headless `claude -c -p` in that window is a
  resume, so it starts closed, and no one can type `pair stop` in it because `-p` prompts never
  count as typed: wait out the 10 minutes after the last such run, or run `claude --continue`
  without `-p` and type `pair stop` there.

**One write gate per session, on OMP.** If another gate in your OMP sessions also owns write
enforcement, set `PAIRED_CODING_CONFLICTING_TOOLS` to a comma-separated list of tool names it
registers. While any listed tool is in the session's tool list, `pair_start` refuses with
"another write gate is loaded in this session (its tool … is listed in
PAIRED_CODING_CONFLICTING_TOOLS), so this adapter stays off", the session stays untouched, and
nothing crashes; see `omp/REGISTRATION.md`. Claude Code does not read this variable.

**Three sandboxes: Seatbelt on macOS, Landlock or bubblewrap on Linux.** `pair_run` and the
writes inside `pair_write` and `pair_edit` run under Seatbelt (`/usr/bin/sandbox-exec`) on
macOS. On Linux, on x86_64 and aarch64, they run under Landlock through the plugin's own helper
(`landlock/`), or under bubblewrap (`bwrap`) where Landlock cannot be used. Elsewhere, or where
no sandbox can run, `pair_start` refuses with the reason and the skill works as conversation
only.

**A run that makes a link stops the session.** After each `pair_run` the gate looks where the
run could write for a symlink or a hard link it made, and for a `.git` entry that is new or was
replaced. If it finds one, `pair_run` returns "STOPPED: pair_run made a link or a .git entry
inside the paths it could write (…)", the journal records `link-made`, and `pair_done` refuses
until you type `pair stop`. A link there would carry a later write, your editor's included, to
wherever it points. Snapshot exclusions such as `node_modules` are not searched. This holds
under every sandbox.

**Linux: which sandbox.** The gate picks one when it first needs it in a process, and
`pair_start` says which, in a line that starts "Sandbox:"; the journal's `start` entry records
it as `sandbox`. Wherever bubblewrap works, the line also says how bubblewrap gets `/proc`
("its own /proc", or in a container that masks `/proc`, "/proc is the container's,
read-only"), and the `start` entry records that as `bwrapProc` (`fresh` or
`ro-bind`; see "Linux: bubblewrap").

1. Landlock, when the kernel has Landlock ABI 3 or later (ABI 3 is the first that can refuse
   truncation). The gate checks the helper binary for this machine against
   `landlock/SHA256SUMS` before it first runs it, then asks it for the ABI.
2. bubblewrap, when the kernel has no Landlock or only ABI 1 or 2, and bubblewrap works.
3. Otherwise `pair_start` refuses, naming both reasons.

A helper whose bytes do not match `SHA256SUMS`, a machine that is neither x86_64 nor aarch64,
or a helper that cannot run refuses pairing outright, even where bubblewrap would work: those
mean the plugin is not what was shipped. Reinstall it, or rebuild the helper (below).

Under Landlock, a single run or write that Landlock cannot fence goes to bubblewrap, and its
result says so ("under bubblewrap:" and the reason). Landlock can only grant: nothing inside a
writable directory can be taken back out. So the gate hands a run to bubblewrap when a
directory it would make writable holds a `.git` entry (a submodule under `lib/**`, for
instance), the state directory or a protected path, or when a temp path holds the worktree,
the state directory or a protected path (a worktree under `/tmp` does, and so does a plugin
installed under `/tmp`). The protected paths are the plugin's own directory, the directory that
holds the session state, and the directory of the Claude Code transcript. A file it would grant
that has a second hard link goes to bubblewrap too. If bubblewrap does not work on the machine,
that run or write is refused. A temp path holding the worktree, the state directory or a
protected path would refuse every run, so there `pair_start` refuses instead and names the
reason. The worktree root is never made writable, since it holds `.git`; what that leaves
out (below) stays on Landlock whether or not bubblewrap works, and so does a new file
`pair_write` makes where a directory grant would hold the root, a `.git`, the state directory
or a protected path.

Nothing under a protected path is ever granted. A worktree inside one cannot be written at all:
`pair_start` succeeds, and then every write inside fails with a plain "Permission denied". So
keep worktrees out of `~/.claude/projects/` (where Claude Code keeps transcripts), out of the
plugin's directory, and out of `$PAIRED_CODING_STATE_DIR` (default
`~/.local/state/paired-coding`).

In a Docker container with the default security options Landlock worked and bubblewrap did
not, so a container needs no extra options when its kernel has Landlock.

**Linux: Landlock.** Landlock grants writes per file, so the kernel refuses a write to any
existing file outside the boundary, as Seatbelt does:

- A literal entry that exists is writable as that one file. A literal that does not exist yet
  gets no grant of its own, and the run's result names it; `pair_write` creates it. `pair_run`
  can still create it when a glob entry makes the directory it would go in writable (below).
- A glob entry at the worktree root (`*.md`, `**`) grants the existing root files it matches
  one by one, and the directories below the root as for any other glob. `pair_run` can write
  an existing `README.md` under `*.md` but cannot create `x.md` in the root, and its result
  names `*.md` and says to create such a file with `pair_write` first.
- A glob entry whose directory does not exist yet (`newpkg/**`) needs a writable directory
  above it for `pair_run` to create anything there. Where that directory would be the worktree
  root, or would hold a `.git`, the state directory or a protected path, the gate leaves that
  one grant out rather than handing the run to bubblewrap: the run goes ahead on Landlock, it
  cannot create the path, and its result names the path and says to create it with
  `pair_write` first.
- An existing file under a glob entry is writable when it matches. One that does not match is
  refused by the kernel, even in a directory the glob covers.
- New files under a glob entry are fenced per directory, the one gap left. Landlock attaches
  a rule to a file that exists, so the only way to let a command create a file is to make a
  directory writable, and then a file of any name can be created there. The gate makes a
  directory writable only when everything already in it is a regular file with one link that
  matches the boundary, or a directory that passes the same test, and the glob could hold a
  file in each of its subdirectories. A symlink, a FIFO, a socket or a device in it, a
  subdirectory it cannot list, or a mount point at or below it keeps the grant per file there.
  These are preflight checks, made once as the run starts, against a filesystem that holds
  still; a change your other processes make to the worktree while the run is going, such as a
  new mount or link, is outside what the gate models.
  With `src/**/*.ts` agreed, where `src` holds
  `README.md` and `src/lib` holds only `.ts` files, the live tests show: `pair_run` cannot write
  `src/README.md`, cannot create `src/new.md`, and cannot create `src/new.ts` either, because
  `src` holds a file outside the boundary; it can write `src/a.ts`; and in `src/lib` it can
  create `src/lib/new.ts`, a new directory with a `.ts` file in it, and also `src/lib/new.md`.
  `pair_done`'s read-back shows such a write and stops the session on it. `pair_write` creates
  `src/new.ts` where `pair_run` cannot.
- In a directory the gate makes writable (above), `pair_run` can also delete and rename
  files, so `rm`, `mv` within the directory, and tools that rename a new file over the old one
  (`sed -i`, many formatters) work there, in its subdirectories too. A literal entry is
  granted as the file alone, so it cannot be deleted or renamed, and `sed -i` on it fails with
  "Permission denied": write the result with `pair_write`, or agree a glob such as `src/*.ts`.
  A file cannot be moved out of a writable directory into the rest of the worktree, nothing
  can be symlinked, and directories cannot be removed. Moving a file into a temp directory
  works as a copy and a delete, which `cp` and `rm` could do anyway.
- Nothing under `.git` is writable, so `git commit` inside `pair_run` fails (see the `.git`
  points above).
- Temp directories, `/tmp` included, are shared, as on macOS.
- `pair_write` and `pair_edit` write the file in place: the content passes through the helper
  straight into the one granted file, which keeps its inode and permission bits. A new file is
  created with the shell's noclobber on, so anything that appears at the path first fails the
  write instead of taking it. A target that is a symlink or has a second hard link would carry
  an in-place write elsewhere, so it gets the staged write, under a grant on its directory
  that only the gate's own staging command uses. Where that grant would hold a `.git`, the
  state directory or a protected path, or for a link directly in the worktree root, the write
  goes to bubblewrap's staged write (below).
- A new file whose directory grant would be the worktree root, or would hold a `.git`, the
  state directory or a protected path (a new `README.md` at the root, or `newpkg/x.ts`), is
  made by the gate itself, outside the sandbox, and then written through a grant on that one
  file. The gate first refuses if any directory above the path is a symlink, then makes each
  missing directory without following links, and creates the file empty with `O_EXCL`, which
  refuses any name that already exists there, a symlink or a hard link included. If the write
  then fails, the gate removes the file only while it is the same file and still empty, and
  the directories only while they are empty, and its result names anything it left behind.
- Every process a run starts ends when the run does, including one that left the process
  group with `setsid` or a double fork: the helper stays outside the sandbox as the run's
  supervisor and kills them all when the command exits, times out or is aborted. On kernels
  before Landlock ABI 6 a run's own process can kill the supervisor first; a process that left
  the group would then keep running with its run's write permission. Once the helper has forked the command,
  the helper never dies of a signal by its own choice, so whenever it does, the gate stops the
  session, as for a link, until your partner types `pair stop`. That includes the gate's own
  `SIGKILL` when a timed-out or aborted run's helper has not ended within 3 seconds of its
  `SIGTERM`, so a helper that was only slow also stops the session. The exception is a death by
  `SIGTERM`, `SIGINT` or `SIGHUP`: the helper blocks those before it starts the command, so
  dying of one means no command ran. `pair_start` says so on a kernel before ABI 6
  (`landlock/README.md`, **Supervision**).
- Landlock does not fence `chmod`, `chown`, `utime` or `setxattr`
  ([kernel documentation](https://docs.kernel.org/userspace-api/landlock.html)), so a run can
  change the permissions, timestamps and extended attributes of any file your user may change,
  outside the boundary too. `pair_done`'s read-back records each worktree file's and
  directory's permission bits, so a permission change to a worktree file or directory outside
  the boundary stops the session there. The worktree root's own mode is never inside the
  boundary, even under `**`. A chmod of the directory a subtree entry names (`docs` for
  `docs/`) stops the session at `pair_done`: the entry covers what is under the directory, not
  the directory itself. A glob over a directory's files (`src/*.txt`) does not cover the
  directory either: `src` is outside that boundary, and its mode is not on the card. A
  directory created or removed with nothing in it is not a change
  in `pair_done`. The read-back skips `.git` and the snapshot
  exclusions, so under Landlock a `chmod +x` on an existing hook in `.git/hooks` goes unseen.
  It does not record owners, timestamps or extended attributes, and it never sees a change
  outside the worktree. Seatbelt and bubblewrap refuse these changes outside what a run may
  write.
- On kernels before Landlock ABI 9, Landlock cannot refuse a connection to a pathname Unix
  socket, so the helper installs the same seccomp filter as bubblewrap's (below): no
  Unix-domain socket can be created, the DNS resolver's included, and `socketpair` still works.
  DNS lookups worked in the test container. From ABI 9 Landlock refuses those connections
  itself and the filter is not installed.
- The helper is a small static Rust program, committed as `landlock/bin/pair-landlock-x86_64-linux`
  and `landlock/bin/pair-landlock-aarch64-linux` with their SHA256 sums in
  `landlock/SHA256SUMS`. `sh landlock/build.sh` rebuilds both from source in a pinned Rust
  image and needs only Docker; CI rebuilds them on every change and fails if one byte differs.
  `landlock/README.md` describes its input and what the kernel enforces.

The live Landlock cases run where the helper reports ABI 3 or later; set
`PAIRED_CODING_REQUIRE_LANDLOCK=1` to make them fail instead of skip, as CI does. CI runs the
suite three ways on each architecture: with bubblewrap working; with it unusable (the runner's
AppArmor restriction left on), as on a stock Ubuntu 24.04 machine; and in an Ubuntu 24.04
container with Docker's `/proc` masks left on, where `PAIRED_CODING_REQUIRE_PROC_FALLBACK=1`
fails the run unless the live bubblewrap cases ran with the `/proc` fallback.

**Linux: bubblewrap.** bubblewrap is the sandbox where the kernel has no Landlock ABI 3, and
takes the runs and writes Landlock cannot fence. It runs as you, inside a user namespace. It
needs:

- The `bubblewrap` package, with `--bind-fd`: bubblewrap 0.10.0 or later, or a distribution
  build carrying the CVE-2024-42472 fix (Ubuntu 24.04's 0.9.0 has it).
- Unprivileged user namespaces. Check with:

  ```sh
  bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all /bin/true && echo ok
  ```

  If that fails: on Ubuntu 23.10 and later, AppArmor restricts them. Run
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, and put that setting in a
  file under `/etc/sysctl.d/` to keep it; or load the `bwrap-userns-restrict` profile from the
  `apparmor-profiles` package, which lets bubblewrap alone through. On a Debian kernel that has
  `kernel.unprivileged_userns_clone`, set it to 1. In a Docker container, run it with
  `--security-opt seccomp=unconfined`, plus `--security-opt apparmor=unconfined` where the host
  runs AppArmor, and `--security-opt systempaths=unconfined` for a fresh `/proc`. `pair_start`'s
  refusal names the same fixes.

**A container that masks `/proc`.** Docker without `--security-opt systempaths=unconfined`
covers parts of the container's `/proc` (`/proc/kcore`, `/proc/keys` and others), and with
those in place the kernel will not mount a fresh `/proc` for bubblewrap: the check above fails
with "Can't mount proc on /newroot/proc", even though user namespaces work. Other container
runtimes that mount over parts of `/proc` can hit the same refusal. When that is the only
failure, the gate runs bubblewrap with the container's own `/proc` bound read-only instead, and
`pair_start`'s "Sandbox:" line reads "bubblewrap (/proc is the container's, read-only)". Every
namespace is still unshared, so each run still has its own PID namespace, and every process it
starts still ends with it. Any other failure is refused as before. With `systempaths=unconfined`
the masks are gone and bubblewrap gets a fresh `/proc`.

The write boundary is the same in both modes: the bound `/proc` is read-only. In a measured
unprivileged Docker container, writes and reads through another process's
`/proc/<pid>/root`, `cwd`, `fd` and `exe` were refused, as were signals to processes outside
the run. The live tests in the masked-`/proc` CI job check the write and the signal against
the gate's own process. Not measured: a privileged container, `/proc/<pid>/mem`, and entering
another process's namespaces through `/proc/<pid>/ns`.

What a run gains is sight of the container's other processes. It can read their process IDs,
command lines, status, mount tables and open file-descriptor numbers; their environment was
not readable. So keep secrets off command lines inside the container. This does not make
files private: every bubblewrap run already sees the whole filesystem read-only, apart from
`/tmp`.

Under the bound `/proc` there are three differences inside a run:
- `/proc` numbers processes as the container does, not as the run's own PID namespace does.
  So `ps`, `pgrep` and `/proc/$$` do not show the run's own process IDs, and `pkill` can miss.
  `/proc/self` and `/dev/fd` are correct.
- Writes under `/proc`, such as `/proc/self/oom_score_adj`, fail.
- An empty `/proc` would hide the other processes, but it breaks ordinary tools: bash process
  substitution (`<(...)`) reads `/dev/fd`, which points into `/proc`.

bubblewrap mounts paths writable; it cannot match each write against the boundary's patterns
the way Seatbelt and Landlock do. So under bubblewrap:

- A glob entry makes the whole directory above its first wildcard writable to `pair_run`: with
  `src/**/*.ts` agreed, a run can also write `src/notes.md`. `pair_done`'s read-back shows such
  a write and stops the session on it, like any write outside the change set, but the kernel
  does not prevent it.
- A literal entry that does not exist yet makes its nearest existing directory writable, for
  the same reason. If none of its directories exist yet, that is the worktree root.
- `pair_write` and `pair_edit` are fenced by the kernel at the target's directory, not the
  target: the path check keeps them to the agreed file, and the kernel keeps them out of
  everything outside that directory.
- A literal entry that exists is its own mount, so a tool that replaces it by renaming a new
  file over it (`sed -i`, many formatters) fails inside `pair_run`. Agree a glob such as
  `src/*.ts` to let one through.
- All of `.git` is read-only, so `git commit` inside `pair_run` fails (see the `.git` points
  above).
- Each run gets its own empty `/tmp`, and what it writes there is gone when it ends. Other temp
  directories (`$TMPDIR` when it is set) are shared, as on macOS.
- Every process a run starts ends when the run ends. Nothing stays behind in the background.
- No Unix-domain socket can be created at all, the DNS resolver's included: a seccomp filter
  makes it fail with "Operation not permitted". `socketpair` still works, so pipes between a
  run's own processes do. Name lookups worked in the test container; a system whose only
  resolver sits behind a Unix socket would lose them. The filter also refuses `io_uring` (it
  can open sockets past the filter) and 32-bit x86 system calls, so 32-bit binaries fail on
  x86_64.
- A path the sandbox would make writable that turns out to be a symlink refuses the run, so a
  swapped-in symlink cannot carry a mount outside the worktree.

**Links inside the boundary become plain files, or are left alone.** On macOS and under
bubblewrap, `pair_write` and `pair_edit` write a new file and rename it over the target, so
they never write through a symlink or hard link at a boundary path. The file the link pointed
to is never touched, and the linked path becomes a plain copy holding the new content. That
includes links you keep on purpose, such as pnpm-style linked files: an agreed write to one of
them unlinks it. Under Landlock the same write is staged the same way; where Landlock cannot
grant the link's directory (above) it goes to bubblewrap, and where bubblewrap does not work
either, it is refused and the link stays as it was.

**The sandbox fences file writes and local sockets, not the network.** Apart from file writes,
hard links and Unix-domain sockets, the Seatbelt profile allows everything. Local TCP is open:
a run reached `sshd` on `127.0.0.1:22`, and only the missing credentials stopped a login. If a
private key in `~/.ssh` is in your own `authorized_keys`, `pair_run` could probably log in and
get a shell outside the sandbox; that route was not tried. `open`, `osascript` and Apple Events
are not denied either, and were not probed. So a command can ask a process outside the sandbox
to write for it: under the closed profile, in a direct check, a command could not write a file,
and a listener on `127.0.0.1` it sent the text to wrote that file.

**Git's directory is fenced; two neighbours are not.** Under `.git` only what a commit writes
is writable, in any letter case. Two paths outside `.git` also steer git, and only the agreed
boundary governs them. `.gitattributes` can select filter and diff drivers, but only ones
already defined in a git config, and the repository's own config cannot be written. A
repository whose config points `core.hooksPath` at a directory in the worktree (husky's
`.husky/`, for one) runs hooks from there, and `pair_run` can write that directory when it is
in the boundary; unlike `.git/`, such a write shows in the read-back diff.

**Escaped writers are caught late, and only inside the worktree.** On macOS a process that
leaves its run's process group survives the reap and keeps the write permission its run had
(test 17); bubblewrap and Landlock end it with the run. On Landlock before ABI 6 a run can
kill the supervisor first, and so can anything outside on any ABI; whenever the supervisor dies
of a signal after the command started, the gate's own `SIGKILL` after a timeout included, the
gate stops the session. A
process that got out of the sandbox
altogether would write with your own permissions; the one route probed on macOS, `launchctl
submit`, was denied, but no probe proves there is no other. Either kind is caught only by
content snapshots, at the next `pair_done`, which then stops the session: the first write is
not prevented. Snapshots cover the worktree only and leave out `.git`, so a write outside the
worktree, inside an excluded directory, or after the final snapshot is not detected.

## Files

Test files (`*.test.mjs`, beside each module) are left out.

The bundled MCP server is the Claude Code half of the `pair_*` tools. Claude Code runs it from
`.mcp.json`, and each tool's checks run inside the server, on the arguments the call finally
carries. Only Claude Code uses it; OMP gets the same verbs as extension tools registered by
`omp/paired-coding-omp.ts`. Both call into the same `lib/` modules.

- `.claude-plugin/plugin.json`: the plugin manifest.
- `.omp-plugin/plugin.json`: OMP's manifest; its empty `mcpServers` hides the bundled MCP server on OMP.
- `package.json`: declares `omp/paired-coding-omp.ts` under `omp.extensions`, so `omp plugin install` registers the gate.
- `.mcp.json`: registers the bundled MCP server `pair` with Claude Code.
- `README.md`: this file.
- `skills/paired-coding/SKILL.md`: the skill the agent follows while pairing.
- `core/gate.mjs`: the gate core: pairing state, verdicts, Seatbelt profiles, Landlock rulesets and bubblewrap options, with no host imports.
- `lib/verbs.mjs`: the `pair_*` verbs and session lifecycle, shared by the MCP server, the hooks and the OMP adapter.
- `lib/host-io.mjs`: file, snapshot, lock and sandboxed-process I/O, and the post-run link check, shared the same way.
- `lib/bwrap.mjs`: the Linux sandbox under bubblewrap: the bubblewrap probe, the seccomp filter, and descriptor-pinned mounts.
- `lib/landlock.mjs`: the Linux sandbox under Landlock: picking the helper for this machine, checking it against `SHA256SUMS`, and the ABI probe.
- `landlock/`: the `pair-landlock` helper: its Rust source, the two committed binaries, `SHA256SUMS`, `build.sh` and its own tests.
- `server/pair-server.mjs`: the MCP server over stdio that serves the `pair_*` tools to Claude Code.
- `server/binding.mjs`: ties each `pair_*` call to its session through a one-shot file the hook writes; a call the hook never saw is refused.
- `hooks/hooks.json`: registers the Claude Code hooks.
- `hooks/paired-coding-hook.mjs`: the Claude Code hook handler: refusals, typed input, stop, `/clear`.
- `omp/paired-coding-omp.ts`: the OMP extension, registering the same verbs as OMP tools.
- `omp/REGISTRATION.md`: how to load the OMP extension, and how to reverse it.

## License

MIT. See the repository root `LICENSE`.
