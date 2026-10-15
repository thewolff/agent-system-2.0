# Ask Graham

A skill that answers "should we build X?" with one engineer's stated judgment and a single
verdict, plus an optional one-line prompt nudge that runs it on every new idea.

The skill (`skills/ask-graham/SKILL.md`) restates the ask, searches for what already exists,
answers five gate questions, checks a few red flags for technical asks, and ends in exactly one
verdict:

- **do it now** (under two minutes),
- **backlog**,
- **backlog, prioritize now** (waiting has a named cost),
- **don't build**.

The breakdown that follows is scaled to the size of the work: none, one task, or High Level
Design → Epics → Stories → Tasks with acceptance criteria.

## Who Graham is

Graham is a frontend engineer and a friend of Jo Wolff, who wrote the skill. Jo asked him seven
questions about how he decides whether to build something; his answers are in
`skills/ask-graham/references/graham-answers.md`, verbatim, typos included. He agreed to be
named and quoted: "100%. Nothing would make me happier."

Every rule in the skill is tagged with its source: **Graham #N** for his words, **Jo** for the
author's overrides, **Skill** for mechanics the skill adds. One override matters: Graham listed
type systems as something he would kill or defer, and the skill does not follow him. Using
types is never counted against an ask; building your own type system when an established one
exists is a red flag, and that flag is Jo's.

## Install

Claude Code:

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install ask-graham@jo-wolff-plugins
```

From a shell, the same thing is `claude plugin marketplace add thewolff/jo-wolff-plugins` then
`claude plugin install ask-graham@jo-wolff-plugins`.

OMP, from a shell:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install ask-graham@jo-wolff-plugins
```

On Claude Code the nudge runs from `hooks/hooks.json`. OMP does not run `hooks.json`; the
install registers `omp/ask-graham-omp.ts` (declared in `package.json` under `omp.extensions`),
which does the same job on OMP's `input` event. A Claude Code install alone does not give OMP
the nudge.

## Using it

Ask "should we build X?" or "is it worth building?", or type `/ask-graham <the thing to build>`
on Claude Code or `/skill:ask-graham <the thing to build>` on OMP.

The skill does not run on a ticket or issue, a bug fix, a task inside an already-decided
project, or a request to continue existing work.

## Intensity

Two levels:

| Level | What runs it |
|---|---|
| `ask` (default) | `/ask-graham` (`/skill:ask-graham` on OMP), or an explicit "should we build this?" |
| `every-idea` | the above, plus a one-line nudge added to every message you send |

The level comes from the first of these that exists:

1. the nearest `.ask-graham` in the working directory or any directory above it, so one file at
   a workspace root covers every repository and worktree under it;
2. `${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/config` (`XDG_CONFIG_HOME` counts only when it
   is an absolute path);
3. the default, `ask`.

Each file holds one line, `intensity=ask` or `intensity=every-idea`. Blank lines and lines
starting with `#` are ignored. A file that exists but names no valid level counts as `ask` and
stops the search there, so a typo in a file meant to turn the level down cannot turn it up.

To show or change it from a session (on OMP, write `/skill:ask-graham` in place of
`/ask-graham`):

```
/ask-graham intensity                    # show the level and which file set it
/ask-graham intensity every-idea         # write the user file
/ask-graham intensity ask --here         # write .ask-graham at this git repository's root
```

That runs the script beside the skill, which you can also call directly with the same
arguments, plus `--cwd <dir>` to resolve from another directory:

```
node <plugin dir>/skills/ask-graham/scripts/intensity.mjs [every-idea|ask] [--here] [--cwd <dir>]
```

`--here` fails outside a git repository. The `.ask-graham` it writes is untracked; add it to
`.git/info/exclude` if you do not want to commit it.

## The nudge

At `every-idea`, each message you send gets this line attached as hidden context:

> ask-graham (intensity every-idea): If this message proposes a new idea that doesn't exist yet
> (not a ticket, bug, or task in an existing project), run the ask-graham check before planning
> or building. Otherwise ignore this.

At `ask` nothing is added. The hook does not classify messages; the agent decides whether a
message is a new idea, so a ticket can still draw a check if the agent misreads it.

- **Claude Code**: a `UserPromptSubmit` hook (`hooks/ask-graham-hook.mjs`) reads the level from
  the prompt's working directory and returns the line as `additionalContext`. It always exits 0.
  If the setting cannot be read, it adds one line saying so and treats the level as `ask`.
- **OMP**: the extension reads the level from the session's working directory on each `input`
  event and queues the line for the next turn (`deliverAs: "nextTurn"`, not displayed). It never
  changes your message, and it skips input that another extension injected. If the setting
  cannot be read, it falls back to `ask` silently: unlike Claude Code, nothing tells you.

**To turn the nudge off**, set the level back to `ask`: `/ask-graham intensity ask` (or
`/skill:ask-graham intensity ask` on OMP) for your user level, or add `--here` for one
repository. Check which file wins with `/ask-graham intensity`, since a `.ask-graham` above you
overrides the user file.

## Your own open-work sources

Optional. List extra places to check in `${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/sources.md`,
one bullet per source with the read-only command or path:

```markdown
- **Prior sessions:** `my-history-tool search --limit 5 -- "<the ask>"`
- **Decisions waiting on me:** `~/notes/HELD.md`
```

Without it the skill checks the repo, its issue tracker, and any backlog file the project's
`AGENTS.md` or `CLAUDE.md` names. Keep it out of version control: it describes your machine.

## Update and uninstall

Claude Code:

```
claude plugin update ask-graham@jo-wolff-plugins
claude plugin uninstall ask-graham@jo-wolff-plugins
```

Claude Code needs a restart to apply an update.

OMP:

```
omp plugin upgrade ask-graham@jo-wolff-plugins
omp plugin uninstall ask-graham@jo-wolff-plugins
```

Uninstalling removes the plugin, not your settings. `~/.config/ask-graham/config` (or its
`XDG_CONFIG_HOME` equivalent), `sources.md` beside it, and every `.ask-graham` file stay where
they are and apply again if you reinstall. Delete them by hand if you want them gone.

## Tests

```
cd plugins/ask-graham
node --test
```

The suites cover the intensity resolver and CLI, the Claude Code hook, the OMP extension, and
the manifests. CI runs the same command on Ubuntu and macOS with Node 24
(`.github/workflows/ask-graham.yml`).

## License

MIT. See the repository root `LICENSE`.
