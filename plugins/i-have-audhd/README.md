# I have AuDHD

How to write to someone who is ADHD and autistic: the rules, the research behind each one,
and a Stop hook that warns when a message buries what the reader needs.

The skill (`skills/i-have-audhd/SKILL.md`) carries eleven rules. The two halves of AuDHD
pull opposite ways — ADHD wants short and new, autism wants complete and exact — and the
rules resolve that by ordering, never by cutting content: what the reader must know goes
first, what they must choose goes last, and every reference survives without scrolling. The
reasons and sources per rule are in `skills/i-have-audhd/references/`.

The plugin delivers the rules in two ways:

- **At session start**, a hook injects the skill's first-turn core (the message skeleton, the
  options rule, reference survival, commands, and three machinery anchors) plus every rule
  heading, so the model has the shape before its first message and knows the full skill
  exists.
- **At every stop**, a hook checks the finished message against nine checks and logs each
  finding to `warnings.log`. Every check warns by default; nothing blocks until you arm it.

Renamed from `communication-rules` in 1.0.0 (see "Changes").

## Install

Claude Code:

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install i-have-audhd@jo-wolff-plugins
```

OMP:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install i-have-audhd@jo-wolff-plugins
```

On Claude Code both hooks run from `hooks/hooks.json`. OMP does not run `hooks.json`; the
install registers `omp/i-have-audhd-omp.ts` (declared in `package.json` under
`omp.extensions`), which runs the same two hooks for the main session. The manual-symlink
fallback and an isolated live probe are in `omp/REGISTRATION.md`.

**OMP installs are per profile.** `omp plugin install` puts the plugin under the active
profile's directory (the profile named by `OMP_PROFILE`; unset means the default profile).
Running the install from a plain shell reaches only the default profile. Run it once per
profile, with `OMP_PROFILE` set to that profile, for every profile that should have it.

**Settings and state are shared, not per profile.** The profile file
(`~/.claude/i-have-audhd.json`, or `$I_HAVE_AUDHD_PROFILE`), the state directory
(`~/.claude/.i-have-audhd-state/`) and the kill switch (`~/.claude/.i-have-audhd-off`) are
resolved from your home directory only (`lib/config.mjs`, `defaultProfilePath`;
`lib/state.mjs`, `stateDir` and `killSwitchPath`). Every harness and every OMP profile reads
the same files. For example, `enforcement.armOmp: true` arms blocking in every OMP profile at
once, and the kill switch turns the Stop hook off everywhere.

### Update

```
claude plugin update i-have-audhd@jo-wolff-plugins
omp plugin upgrade i-have-audhd        # once per OMP profile
```

### Uninstall

```
claude plugin uninstall i-have-audhd@jo-wolff-plugins
omp plugin uninstall i-have-audhd      # once per OMP profile
```

Uninstalling removes the plugin, not your files. `~/.claude/i-have-audhd.json`,
`~/.claude/.i-have-audhd-state/` (logs and resume markers) and `~/.claude/.i-have-audhd-off`
stay behind; delete them by hand if you want them gone. Because they are shared, keep them
while any harness or OMP profile still has the plugin installed.

## Check it's working

1. Confirm the install: `claude plugin list` or `omp plugin list` (in the profile you use)
   shows `i-have-audhd`.
2. Finish one turn in a new session, then look in `~/.claude/.i-have-audhd-state/`. A new
   line in `warnings.log` (a check fired) or `skipped.log` (a judge-gated trigger fired with
   no `judgeCommand`) proves the Stop hook ran. A clean message can leave no line in either,
   so try a long reply if nothing appears.
3. On OMP, count adapter failures:
   `grep -c 'omp-adapter fail-open' ~/.claude/.i-have-audhd-state/errors.log`. Every adapter
   failure leaves one such line (`omp/i-have-audhd-omp.ts`, the fail-open contract comment);
   a count that grows each turn means the adapter is installed but failing.

## What happens at session start

`hooks/i-have-audhd-inject.mjs` returns `hookSpecificOutput.additionalContext`: one line
saying the person in the session installed these rules, the span of `SKILL.md` between
`<!-- inject:start -->` and `<!-- inject:end -->`, and any reader traits from your profile.
Editing the skill is editing what sessions receive; there is one copy of the text.

On Claude Code this runs on every SessionStart source. On OMP the adapter runs it on the
main session's start, on a session switch, and after a compaction, and attaches the context to
the next prompt as a hidden message. It stays attached until a model request has carried it,
so OMP re-running its prompt preparation does not lose it, and later prompts do not repeat
it (when a prompt is aborted before any model request, the next prompt carries it again).
Subagent sessions get no injection on OMP.

When the session's source is `resume` or `compact`, the injector also writes a one-shot
marker that arms the restate-the-resumed-thread check for the Stop hook. On OMP both hooks
key that marker on the session manager's id, so it survives OMP rotating the provider
session id under a fresh-session or context reset.

It fails open and says so: every path exits 0, and each failure emits one short line instead
of nothing. To turn the injection off without uninstalling: `I_HAVE_AUDHD_INJECT=off`.

## What happens when you stop

`hooks/i-have-audhd-stop.mjs` reads the final assistant message and runs:

| Check | Rule id (for `enforcement.rules`) | Skill rule | Instrument | Default |
|---|---|---|---|---|
| Needs you first | `needs-you-first` | 1, Skeleton | deterministic | warn |
| One closing ask, last | `closing-ask-last` | 1, Skeleton | deterministic | warn |
| Do not batch by label | `do-not-batch-by-label` | 1, Skeleton | trigger + judge | warn |
| Conclusion first | `conclusion-first` | 1, Skeleton | trigger + judge | warn |
| Plural back-reference in the closing ask | `plural-back-reference` | 6, References survive without scrolling | deterministic | warn |
| Restate a resumed thread | `restate-resumed-thread` | 8, Resume by restating content | injector marker + judge | warn |
| Name the artifact | `name-the-artifact` | 11, Machinery anchors | deterministic | warn |
| Report what you did not do | `report-what-you-did-not-do` | 11, Machinery anchors | todo trigger + judge | warn |
| Bad news in the first sentence | `bad-news-first` | 11, Machinery anchors | lexicon gate + judge | warn |

Every finding names its skill rule. At the default, findings land in
`~/.claude/.i-have-audhd-state/warnings.log` and nothing blocks. The default is measured:
the 2026-09-21 corpus adjudication found no check whose false-positive rate supports blocking
by default; the rates are in `skills/i-have-audhd/reference.md`. Block is one profile flip
away, globally or per check.

The five judge-gated checks are inactive until you configure `enforcement.judgeCommand`;
each trigger that fires without one leaves a line in `skipped.log`, so a skipped check stays
inspectable.

On OMP the Stop hook runs for the main session only: OMP's `session_stop` never fires for
subagent sessions, and OMP has no blocking equivalent of Claude Code's `SubagentStop`. OMP
also caps every block to warn unless the profile sets `enforcement.armOmp: true`.

**Kill switch:** `touch ~/.claude/.i-have-audhd-off` disables the Stop hook within one turn.
`I_HAVE_AUDHD_ENFORCE=off` is a secondary switch that needs a host relaunch to change.
Everything fails open: a broken hook exits 0 with one line in `errors.log`.

## Configuring a profile

Optional. Reader traits and enforcement live in one JSON file, resolved from
`$I_HAVE_AUDHD_PROFILE` then `~/.claude/i-have-audhd.json`; `example.i-have-audhd.json` is a
generic starting point. Every field is optional:

```json
{
  "reader": "the engineer who owns this service",
  "traits": ["reads the first two lines of any message and skims the rest"],
  "enforcement": {
    "mode": "warn",
    "judgeCommand": "codex exec --skip-git-repo-check -",
    "rules": { "name-the-artifact": "block" },
    "armOmp": false
  }
}
```

The example `judgeCommand`, `codex exec --skip-git-repo-check -`, assumes the Codex CLI is
installed and signed in; it is an example, not a requirement. To run without a judge, leave
`judgeCommand` out (or set it to `null`). The four deterministic checks still run; the five
judge-gated checks stay inactive and each fired trigger is logged to `skipped.log`:

```json
{
  "enforcement": { "mode": "warn" }
}
```

The full schema, precedence, every check's contract, and the judge machinery are in
`skills/i-have-audhd/reference.md`. **Keep your profile out of version control if it
describes a real person.**

## Upgrading from communication-rules

1.0.0 reads only its own names; it never looks at the `communication-rules` profile, kill
switch, state directory or environment variables. If you configured `communication-rules`,
carry your settings over once, **before** you uninstall it, from the plugin's directory (a
checkout's `plugins/i-have-audhd`, or wherever your host installed it):

```
node tools/upgrade-from-communication-rules.mjs           # preview: writes nothing
node tools/upgrade-from-communication-rules.mjs --apply   # carry over
node tools/upgrade-from-communication-rules.mjs --undo    # remove what --apply made
```

Run it in the environment your host gives the hooks: it reads the old profile from
`$COMMUNICATION_RULES_PROFILE` (else `~/.claude/communication-rules.json`) and writes to the
path the new loader resolves (`$I_HAVE_AUDHD_PROFILE`, else `~/.claude/i-have-audhd.json`).
Set `I_HAVE_AUDHD_PROFILE` for the run to choose another target.

| Old | `--apply` does |
|---|---|
| `~/.claude/.communication-rules-off` | copied to `~/.claude/.i-have-audhd-off` first, so a disabled Stop hook stays disabled |
| the profile (`reader`, `traits`, `enforcement`) | copied byte-for-byte to the new path at mode 0600; the copy's file mode, bytes, and the enforcement the new loader derives from it are checked before it is put in place |
| each file it creates | gets a 0600 receipt beside it (`.i-have-audhd-off.upgrade-receipt`, `.i-have-audhd.json.upgrade-receipt`) recording its path, device, inode, change time, mode, size and SHA-256, never its contents |
| `~/.claude/.communication-rules-state/` | left where it is as an archive; its logs stay readable there and its resume markers are not carried |
| `COMMUNICATION_RULES_*` variables | named, with the `I_HAVE_AUDHD_*` replacement; the tool cannot change your shell's or host's environment, so edit wherever they are set and relaunch the host |

The cases:

- **Old file missing:** nothing to carry for that item; an existing new file is left as it is.
- **Target already exists:** identical bytes count as done, with no receipt, so `--undo` keeps
  it; different bytes are refused and never overwritten (exit 1). Compare the two by hand.
- **New name resolves to the old file** (for example `I_HAVE_AUDHD_PROFILE` pointing at it):
  nothing is copied, and `--undo` keeps it.
- **Profile does not parse as a JSON object:** refused; fix it and rerun.
- **Target's directory missing:** refused; the tool creates no directories.
- **Old variables set:** `COMMUNICATION_RULES_PROFILE`, `_INJECT` and `_ENFORCE` become the
  same value under `I_HAVE_AUDHD_`. `COMMUNICATION_RULES_PLUGIN_ROOT` points at the retired
  plugin: unset it, or point `I_HAVE_AUDHD_PLUGIN_ROOT` at this plugin. Unset
  `COMMUNICATION_RULES_HARNESS`; the OMP adapter sets its own tag.

The originals are never modified, moved or deleted, and nothing is migrated automatically.
The output names paths, file modes, rule ids and each rule's effective mode on Claude Code and
OMP; it never prints the profile's contents, a parse error (which can quote it), the judge
command, or an environment value. `--undo` removes a new-name file only when its receipt
exists and the file is still the one `--apply` created (same inode, change time, mode, size
and SHA-256), then the receipt, profile first. A file `--apply` did not create, an edited
file and a replaced one are kept.
Exit 0 means every item is done or had nothing to do, 1 means one was refused or failed.

## Changes

### 1.0.0

- Renamed from `communication-rules` 0.2.x. No aliases: the profile is now
  `~/.claude/i-have-audhd.json`, state `~/.claude/.i-have-audhd-state/`, kill switch
  `~/.claude/.i-have-audhd-off`, and the environment variables `I_HAVE_AUDHD_PROFILE`,
  `I_HAVE_AUDHD_INJECT`, `I_HAVE_AUDHD_ENFORCE`, `I_HAVE_AUDHD_HARNESS`,
  `I_HAVE_AUDHD_PLUGIN_ROOT`. Existing logs and resume markers in the old state dir are not
  migrated. `tools/upgrade-from-communication-rules.mjs` carries an existing profile and
  kill switch over on request (see "Upgrading from communication-rules").
- The skill is now the AuDHD rules (eleven rules, with rationale, comparison and sources
  references). The session-start injection carries its first-turn core and every rule
  heading, introduced by a hook-owned line that names no one.
- The Needs-you section and closing ask are conditional on a real need or decision.
  Informational replies need neither; the structural checks enforce order, not ceremony.
- New deterministic check, `plural-back-reference`: the closing ask leaning on "those",
  "these", "both", "them", "the two" or "either one" with no referent in its own sentence.
  Warn by default.
- Every warning and block reason names the skill rule it enforces.
- OMP: the adapter is registered by the plugin install and now delivers the session-start
  injection as well as the Stop check. The injection survives OMP's prompt-preparation
  retries and is sent once per crossing; the resume marker and the loop guard follow the
  session manager's id rather than the rotating provider id.
- OMP judged stops use a 20-second judge deadline inside the adapter's 25-second budget,
  below the host's 30-second handler deadline. Claude Code keeps the 30-second judge deadline.
  Timed-out judge process groups are killed and pipe handles released.

## Tests

```
node --test plugins/i-have-audhd/checks/*.test.mjs plugins/i-have-audhd/triggers/*.test.mjs plugins/i-have-audhd/judge/*.test.mjs plugins/i-have-audhd/hooks/*.test.mjs plugins/i-have-audhd/omp/*.test.mjs plugins/i-have-audhd/tools/*.test.mjs
```

Most tests prove what does not flag: a structural check earns its place by what it leaves
alone. The hook and adapter suites run the real hooks as subprocesses against an isolated
`$HOME`. The judge suite drives only fake judges.

## License

MIT. See the repository root `LICENSE`.
