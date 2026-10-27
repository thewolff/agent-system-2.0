// The positive model of `git` for row 6 (M4 fix round 5, Jo 2026-09-29: "extend"). Rounds 3-4 made
// the *form* of a git command fail closed (literal words, a builtin subcommand, modeled globals:
// exec.ts gitUnmodeled). This file does the same one level down: per subcommand, the options the lane
// may use and the shapes of their operands. Anything else is refused, as a § A4 reserved action where
// it is one and as an unmodeled form otherwise, with the allowed spelling named.
//
// Options are matched the way git matches them, never by literal text. Subcommands built on git's
// parse-options accept any unique prefix of a long option (`git reset --har` is `--hard`) and bundle
// short options (`-fd`); so each such subcommand carries its full option list and a word is resolved
// against it: exact match first, else the one option it is a prefix of. An abbreviation that resolves
// to a refused option is refused; an ambiguous or unknown one is refused as unmodeled (git would stop
// on it too). The option lists are git's own usage text, `git <sub> -h`, on git 2.50.1 (Apple
// Git-155): each `-x, --[no-]name <value>` usage line became one token (format at GIT_OPTIONS).
// Refresh: re-read `git <sub> -h` on the git a profile pins and update GIT_OPTIONS; keep any option
// git has dropped (an older git may still take it).
//
// The OPEN subcommands (reads, and writes no § A4 action names) are modeled the same way: every
// option git documents for them (OPEN_OPTIONS), anything else refused, and each option carries its
// effect (M4 fix round 6): one that runs a program or writes where no value names is refused, one
// whose value is a path it writes is refused when that path is inside .git.
// log/show/diff and the other revision-walking commands do not abbreviate (live, git 2.50.1: `git
// log --onel` → "unrecognized argument: --onel", `git log --sour` → the same, `git diff
// --outp=/dev/null` → "invalid option", `git format-patch --stdou` → "unrecognized argument"), so
// their options match exactly; the parse-options ones (status, grep, ls-remote, …) resolve a unique
// prefix, and match a refused option by prefix.
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type { GitCall } from "./exec";
import type { Word } from "./shell-parse";
import { PROTECTED_BRANCH } from "./types";

/** A refusal of a git form: `reserved` names a § A4 action, otherwise the form is unmodeled. */
export interface GitVerdict {
	reserved: boolean;
	why: string;
	/** The allowed spelling, for an unmodeled form. */
	spelling?: string;
}

type Value = "" | "=" | "=?";
/**
 * What an option does beyond reading (OPEN_OPTIONS `@e`, M4 fix round 6, astra-6 B5): `x` runs a
 * program, `w` its value is a path it writes, `u` it writes where no value names, `o` it rewrites its
 * operands.
 */
type Effect = "x" | "w" | "u" | "o";
interface Opt {
	/** Canonical key: the long name, or `-x` for a short-only option. */
	key: string;
	value: Value;
	effect?: Effect;
}
interface OptTable {
	long: Map<string, Opt>;
	short: Map<string, Opt>;
	/** `-<number>` is an option (`git log -5`). */
	numeric: boolean;
}

/**
 * `git <sub> -h` option lists, one token per option: `[s|][!]name[=|=?]` — `s` the short letter,
 * `!` for `--[no-]name` (both spellings), `=` a required value (attached or the next word), `=?` an
 * optional value (attached only). `s|` with no name is a short-only option. Generated (see header).
 */
const GIT_OPTIONS: Record<string, string> = {
	add: "n|!dry-run v|!verbose i|!interactive p|!patch e|!edit f|!force u|!update !renormalize N|!intent-to-add A|!all !ignore-removal= !refresh !ignore-errors !ignore-missing= !sparse !chmod= !pathspec-from-file= !pathspec-file-nul",
	commit: "q|!quiet v|!verbose F|!file= !author= !date= m|!message= c|!reedit-message= C|!reuse-message= !fixup= !squash= !reset-author trailer= s|!signoff t|!template= e|!edit !cleanup= !status S|!gpg-sign=? a|!all i|!include !interactive p|!patch o|!only n|no-verify verify !dry-run !short !branch !ahead-behind !porcelain !long z|!null !amend no-post-rewrite post-rewrite u|!untracked-files=? !pathspec-from-file= !pathspec-file-nul",
	fetch: "v|!verbose q|!quiet !all !set-upstream a|!append !atomic !upload-pack= f|!force m|!multiple t|!tags n| j|!jobs= !prefetch p|!prune P|!prune-tags= !recurse-submodules=? !dry-run !porcelain !write-fetch-head k|!keep u|!update-head-ok !progress !depth= !shallow-since= !shallow-exclude= !deepen= unshallow refetch !update-shallow= refmap= o|!server-option= 4|ipv4 6|ipv6 !negotiation-tip= !negotiate-only= !filter= !auto-maintenance !auto-gc !show-forced-updates !write-commit-graph !stdin",
	pull: "v|!verbose q|!quiet !progress !recurse-submodules=? r|!rebase=? n| !stat !log=? !signoff=? !squash !commit !edit !cleanup= !ff ff-only !verify !verify-signatures !autostash s|!strategy= X|!strategy-option= S|!gpg-sign=? !allow-unrelated-histories !all a|!append !upload-pack= f|!force t|!tags p|!prune j|!jobs=? !dry-run k|!keep !depth= !shallow-since= !shallow-exclude= !deepen= unshallow !update-shallow= refmap= o|!server-option= 4|!ipv4 6|!ipv6 !negotiation-tip= !show-forced-updates !set-upstream",
	merge: "n| !stat !summary !log=? !squash !commit e|!edit !cleanup= !ff ff-only !rerere-autoupdate !verify-signatures s|!strategy= X|!strategy-option= m|!message= F|file= !into-name= v|!verbose q|!quiet !abort !quit !continue !allow-unrelated-histories !progress S|!gpg-sign=? !autostash !overwrite-ignore !signoff no-verify verify",
	checkout: "b|= B|= l| !guess !overlay q|!quiet !recurse-submodules=? !progress m|!merge !conflict= d|!detach t|!track=? f|!force !orphan= !overwrite-ignore !ignore-other-worktrees 2|ours 3|theirs p|!patch !ignore-skip-worktree-bits !pathspec-from-file= !pathspec-file-nul",
	switch: "c|!create= C|!force-create= !guess !discard-changes q|!quiet !recurse-submodules=? !progress m|!merge !conflict= d|!detach t|!track=? f|!force !orphan= !overwrite-ignore !ignore-other-worktrees",
	restore: "s|!source= S|!staged W|!worktree !ignore-unmerged !overlay q|!quiet !recurse-submodules=? !progress m|!merge !conflict= 2|ours 3|theirs p|!patch !ignore-skip-worktree-bits !pathspec-from-file= !pathspec-file-nul",
	push: "v|!verbose q|!quiet !repo= !all !branches !mirror d|!delete !tags n|!dry-run !porcelain f|!force !force-with-lease=? !force-if-includes !recurse-submodules= !thin !receive-pack= !exec= u|!set-upstream !progress !prune no-verify verify !follow-tags !signed=? !atomic o|!push-option= 4|ipv4 6|ipv6",
	branch: "v|!verbose q|!quiet t|!track=? u|!set-upstream-to= !unset-upstream= !color=? r|remotes contains= no-contains= !abbrev=? a|all d|!delete D| m|!move M| !omit-empty c|!copy C| l|!list !show-current !create-reflog !edit-description f|!force merged= no-merged= !column=? !sort= !points-at= i|!ignore-case !recurse-submodules !format=",
	tag: "l|list n|=? d|delete v|verify a|!annotate m|message= F|!file= trailer= e|!edit s|!sign !cleanup= u|!local-user= f|!force !create-reflog !column=? contains= no-contains= merged= no-merged= !omit-empty !sort= !points-at= !format= !color=? i|!ignore-case",
	reset: "q|!quiet no-refresh refresh mixed soft hard merge keep !recurse-submodules=? p|!patch N|!intent-to-add !pathspec-from-file= !pathspec-file-nul",
	clean: "q|!quiet n|!dry-run f|!force i|!interactive d| e|exclude= x| X|",
	rebase: "!onto= !keep-base no-verify verify q|!quiet v|!verbose n|no-stat stat !signoff !committer-date-is-author-date !reset-author-date C|= !ignore-whitespace !whitespace= f|!force-rebase no-ff ff continue skip abort quit edit-todo show-current-patch apply m|merge i|interactive !rerere-autoupdate empty= !autosquash !update-refs S|!gpg-sign=? !autostash x|!exec= r|!rebase-merges=? !fork-point s|!strategy= X|!strategy-option= !root !reschedule-failed-exec !reapply-cherry-picks",
	mv: "v|!verbose n|!dry-run f|!force k| !sparse",
	rm: "n|!dry-run q|!quiet !cached f|!force r| !ignore-unmatch= !sparse !pathspec-from-file= !pathspec-file-nul",
	"cherry-pick": "quit continue abort skip !cleanup= n|no-commit commit e|!edit s|!signoff m|!mainline= !rerere-autoupdate !strategy= X|!strategy-option= S|!gpg-sign=? x| !ff !allow-empty !allow-empty-message !keep-redundant-commits empty=",
	revert: "quit continue abort skip !cleanup= n|no-commit commit e|!edit s|!signoff m|!mainline= !rerere-autoupdate !strategy= X|!strategy-option= S|!gpg-sign=? !reference",
	init: "!template= !bare shared=? q|!quiet !separate-git-dir= b|!initial-branch= !object-format= !ref-format=",
	clone: "v|!verbose q|!quiet !progress !reject-shallow= n|no-checkout checkout !bare !mirror l|!local no-hardlinks hardlinks s|!shared !recurse-submodules=? !recursive=? j|!jobs= !template= !reference= !reference-if-able= !dissociate o|!origin= b|!branch= !revision= u|!upload-pack= !depth= !shallow-since= !shallow-exclude= !single-branch !tags !shallow-submodules !separate-git-dir= !ref-format= c|!config= !server-option= 4|ipv4 6|ipv6 !filter= !also-filter-submodules !remote-submodules !sparse !bundle-uri=",
	// `git config` in its legacy (option-action) form: `git config -h` prints only the subcommand
	// usage, so this list is `git config get -h` (file, filter, display, type, other options) plus the
	// legacy actions from git-config(1) ("DEPRECATED MODES" and the action options), by hand.
	config: "!global !system !local !worktree f|!file= !blob= !all !regexp !value= !fixed-value !url= z|!null !name-only !show-origin !show-scope !show-names t|!type= bool int bool-or-int bool-or-str path expiry-date !includes !default= get get-all get-regexp get-urlmatch replace-all add unset unset-all rename-section remove-section l|list e|edit get-color get-colorbool",
};

const tables = new Map<string, OptTable>();

function table(sub: string): OptTable | null {
	const spec = GIT_OPTIONS[sub] ?? OPEN_OPTIONS[sub] ?? ACTION_OPTIONS[sub];
	if (spec === undefined) return null;
	let t = tables.get(sub);
	if (t) return t;
	t = { long: new Map(), short: new Map(), numeric: false };
	for (const token of spec.split(" ").filter(Boolean)) {
		if (token === "#") {
			t.numeric = true;
			continue;
		}
		const bar = token.indexOf("|");
		const short = bar === 1 ? token[0]! : "";
		let rest = bar === 1 ? token.slice(2) : token;
		const at = rest.indexOf("@");
		const effect = at < 0 ? undefined : (rest.slice(at + 1) as Effect);
		if (at >= 0) rest = rest.slice(0, at);
		const neg = rest.startsWith("!");
		if (neg) rest = rest.slice(1);
		const value: Value = rest.endsWith("=?") ? "=?" : rest.endsWith("=") ? "=" : "";
		const name = rest.slice(0, rest.length - value.length);
		const opt: Opt = { key: name || `-${short}`, value, effect };
		if (name) t.long.set(name, opt);
		if (neg && name) t.long.set(`no-${name}`, { key: `no-${name}`, value: "" });
		if (short) t.short.set(short, opt);
	}
	tables.set(sub, t);
	return t;
}

/**
 * A long option resolved against a table the way parse-options does (parse-options.c
 * parse_long_opt): an exact name wins, else (when the command abbreviates) the one name the word is a
 * prefix of. An error with a reason when it is unknown or ambiguous.
 */
function resolveLong(t: OptTable, name: string, abbrev = true): Opt | { error: string } {
	const exact = t.long.get(name);
	if (exact) return exact;
	const hits = abbrev && name !== "" ? [...t.long.entries()].filter(([n]) => n.startsWith(name)) : [];
	const keys = [...new Set(hits.map(([, o]) => o.key))];
	if (keys.length === 1) return hits[0]![1];
	if (keys.length === 0) return { error: `--${name}, an option git does not list for this subcommand${abbrev ? "" : " (and it does not abbreviate)"}` };
	return { error: `--${name}, an abbreviation git reads as ambiguous (${keys.map((k) => `--${k}`).join(", ")})` };
}

interface Parsed {
	/** Options in argument order, with their value (null when none), effect, and `at`: the index in `args` of the word the value was read from. */
	opts: Array<{ key: string; value: string | null; effect?: Effect; at?: number }>;
	/** Operands before `--`. */
	operands: string[];
	/** Words after `--` (pathspecs). */
	after: string[];
	dashdash: boolean;
}

/**
 * Split a subcommand's words by its option table; a string when a word does not resolve. Short
 * options bundle left to right (`-qd`), and an option that takes a value takes the rest of the word
 * (`-Bmain`, `-eFOO`): the letters after it are its value, never options (astra-6 S1).
 */
function parse(t: OptTable, args: string[], abbrev = true): Parsed | string {
	const out: Parsed = { opts: [], operands: [], after: [], dashdash: false };
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (out.dashdash) {
			out.after.push(a);
			continue;
		}
		if (a === "--" || a === "--end-of-options") {
			out.dashdash = a === "--";
			if (a === "--end-of-options") {
				out.operands.push(...args.slice(i + 1));
				return out;
			}
			continue;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
			const o = resolveLong(t, name, abbrev);
			if ("error" in o) return o.error;
			let value: string | null = eq < 0 ? null : a.slice(eq + 1);
			if (o.value === "" && value !== null) return `--${name}=…, an option that takes no value`;
			if (o.value === "=" && value === null) {
				if (i + 1 >= args.length) return `--${name} without its value`;
				value = args[++i]!;
			}
			out.opts.push({ key: o.key, value, effect: o.effect, ...(value === null ? {} : { at: i }) });
			continue;
		}
		if (t.numeric && /^-\d+$/.test(a)) continue;
		if (a.startsWith("-") && a !== "-") {
			for (let k = 1; k < a.length; k++) {
				const o = t.short.get(a[k]!);
				if (!o) return `-${a[k]}, a short option git does not list for this subcommand`;
				if (o.value === "") {
					out.opts.push({ key: o.key, value: null, effect: o.effect });
					continue;
				}
				let value: string | null = a.slice(k + 1);
				if (value === "") value = o.value === "=" ? (args[++i] ?? null) : null;
				if (o.value === "=" && value === null) return `-${a[k]} without its value`;
				out.opts.push({ key: o.key, value, effect: o.effect, ...(value === null ? {} : { at: i }) });
				break;
			}
			continue;
		}
		out.operands.push(a);
	}
	return out;
}

const has = (p: Parsed, ...keys: string[]): boolean => p.opts.some((o) => keys.includes(o.key));
/**
 * An option's final state in argument order: `--x` turns it on, `--no-x` off, the last one wins
 * (astra-6 B3: `--staged --no-staged` is not staged). A check that allows a form reads this, never
 * mere presence; a check that refuses may read presence (stricter).
 */
const on = (p: Parsed, key: string): boolean => p.opts.reduce((s, o) => (o.key === key ? true : o.key === `no-${key}` ? false : s), false);
/**
 * A value option's final value in argument order, or null when it ends unset: the last `--x <v>`
 * gives its value and a later `--no-x` clears it (astra-7 B1: git 2.50.1 parse-options.c,
 * OPTION_STRING stores NULL on unset, so `checkout --orphan foo --no-orphan .` creates no branch and
 * checks out `.`; live, it restored the dirty file). A check that allows a form reads this, never
 * mere presence.
 */
const finalValue = (p: Parsed, key: string): string | null =>
	p.opts.reduce<string | null>((s, o) => (o.key === key ? (o.value ?? "") : o.key === `no-${key}` ? null : s), null);
const firstOf = (p: Parsed, keys: Record<string, string>): string | null => p.opts.find((o) => keys[o.key] !== undefined)?.key ?? null;

/** Merge strategies git ships: any other `-s <name>` runs a `git-merge-<name>` program found on PATH. */
const BUILTIN_STRATEGY = /^(?:ort|recursive|resolve|octopus|ours|subtree)$/;

const reserved = (why: string): GitVerdict => ({ reserved: true, why });
const unmodeled = (why: string, spelling: string): GitVerdict => ({ reserved: false, why, spelling });

/** Options that run a program, per subcommand: always refused, whatever else the command does. */
const RUNS_PROGRAM: Record<string, Record<string, string>> = {
	fetch: { "upload-pack": "fetch --upload-pack names a program to run" },
	pull: { "upload-pack": "pull --upload-pack names a program to run", "verify-signatures": "pull --verify-signatures runs gpg to check signatures (gpg.program)" },
	merge: { "verify-signatures": "merge --verify-signatures runs gpg to check signatures (gpg.program)" },
	tag: { verify: "git tag -v/--verify runs gpg to check the tag's signature (gpg.program)" },
	clone: { "upload-pack": "clone --upload-pack names a program to run", template: "clone --template copies hooks that run later", config: "clone -c/--config sets config (core.sshCommand, core.hooksPath, …) that runs programs" },
	init: { template: "init --template copies hooks that run later" },
	push: { "receive-pack": "push --receive-pack names a program to run", exec: "push --exec names a program to run" },
	rebase: { exec: "rebase --exec/-x runs a program after each commit" },
};

/** Options per subcommand that are § A4 reserved actions (the discard family, force-push, ref deletion). */
const RESERVED_OPTS: Record<string, Record<string, string>> = {
	reset: { hard: "git reset --hard", merge: "git reset --merge (discards working changes)", keep: "git reset --keep (moves HEAD and rewrites the work tree)" },
	checkout: { force: "git checkout --force (discards working changes)", patch: "git checkout --patch (discards working hunks)" },
	switch: { "discard-changes": "git switch --discard-changes", force: "git switch --force (discards working changes)" },
	branch: { delete: "branch deletion", "-D": "branch deletion" },
	tag: { delete: "tag deletion" },
	push: {
		force: "force-push",
		"force-with-lease": "force-push (--force-with-lease)",
		"force-if-includes": "force-push (--force-if-includes)",
		delete: "remote ref deletion (git push --delete / -d)",
		mirror: "git push --mirror (force-updates and deletes every remote ref)",
		all: "git push --all (pushes every branch, protected ones included)",
		branches: "git push --branches (pushes every branch, protected ones included)",
		prune: "git push --prune (deletes remote branches)",
	},
	pull: { force: "git pull --force (overwrites local refs)" },
};

/**
 * Row 6's scratch-root lifts (PLAN wl-mv5oikd5jtquww § 1.2 rules 2 and 3), which r06-reserved.ts
 * decides: `repo` when the repository the command works on is inside the own scratch root (rule 2),
 * `push` when every push destination is a path inside it (rule 3). A lifted reserved verdict is set
 * aside and the model goes on judging the rest of the command; `used` collects each one set aside.
 * `worktree` (the routine classifier's own-worktree rule, PLAN wl-mvqwn80onq9hq8 D2b) is present when
 * the repository is the workload's own worktree: the work-tree discards (WORKTREE_OPTS and the
 * clean/restore/checkout-path verdicts) are set aside into it, never `reset --hard`, branch or tag
 * deletion or a push.
 */
export interface ScratchLift {
	repo: boolean;
	push: boolean;
	used: string[];
	worktree?: string[];
}

/**
 * The RESERVED_OPTS a scratch lift may set aside, per subcommand: rule 2's `reset --hard`,
 * `branch -d/-D`, `tag -d`; rule 3's force and delete pushes. Never `--mirror`, `--all`, `--branches`,
 * `--prune`, `reset --merge/--keep`, `checkout --force/--patch`: those keep today's verdict.
 */
const SCRATCH_OPTS: Record<string, { lift: "repo" | "push"; keys: Record<string, true> }> = {
	reset: { lift: "repo", keys: { hard: true } },
	branch: { lift: "repo", keys: { delete: true, "-D": true } },
	tag: { lift: "repo", keys: { delete: true } },
	push: { lift: "push", keys: { force: true, "force-with-lease": true, "force-if-includes": true, delete: true } },
};

/** The RESERVED_OPTS the own-worktree lift sets aside (ScratchLift.worktree): the work-tree discards only, never `reset --hard`. */
const WORKTREE_OPTS: Record<string, Record<string, true>> = {
	reset: { merge: true, keep: true },
	checkout: { force: true, patch: true },
	switch: { "discard-changes": true, force: true },
};

/**
 * Where the verdicts `p` reserves for `sub` are set aside: `lift.used` when the scratch lift covers
 * every reserved option it carries, `lift.worktree` when the own-worktree lift does; null when neither
 * covers them all (one outside both keeps the verdict).
 */
function liftsOpts(sub: string, p: Parsed, lift: ScratchLift | undefined): string[] | null {
	const reservedKeys = p.opts.filter((o) => RESERVED_OPTS[sub]![o.key] !== undefined).map((o) => o.key);
	const s = SCRATCH_OPTS[sub];
	if (s && lift?.[s.lift] && reservedKeys.every((k) => s.keys[k] === true)) return lift.used;
	const w = WORKTREE_OPTS[sub];
	if (w && lift?.worktree && reservedKeys.every((k) => w[k] === true)) return lift.worktree;
	return null;
}

/** Options per subcommand the gate does not model (not reserved, but not safe to pass unread). */
const UNMODELED_OPTS: Record<string, Record<string, string>> = {
	checkout: { "-B": "git checkout -B resets an existing branch", ours: "git checkout --ours overwrites paths", theirs: "git checkout --theirs overwrites paths", "pathspec-from-file": "git checkout --pathspec-from-file restores paths" },
	switch: { "force-create": "git switch -C/--force-create resets an existing branch" },
	branch: { force: "git branch -f/--force moves an existing branch", "-M": "git branch -M renames over an existing branch", "-C": "git branch -C copies over an existing branch" },
	tag: { force: "git tag -f/--force moves an existing tag" },
	mv: { force: "git mv -f/--force overwrites the destination" },
	rm: { force: "git rm -f/--force drops uncommitted changes" },
};

const WRITE_SPELLING: Record<string, string> = {
	reset: "`git reset [--soft | --mixed] [<commit>]` or `git reset [<commit>] -- <paths>` (index only)",
	checkout: "`git checkout <branch>` or `git checkout -b <new-branch> [<start>]`; never `--`, `.` or a path",
	switch: "`git switch <branch>` or `git switch -c <new-branch> [<start>]`",
	restore: "`git restore --staged <paths>` (the index only, never the work tree)",
	clean: "`git clean -n` (a dry run that lists what would go)",
	branch: "`git branch <name> [<start>]`, the list forms, `-m <old> <new>`, `-u <upstream>`",
	tag: "`git tag <name> [<commit>]`, `git tag -a <name> -m <msg>`, or `git tag --list`",
	push: "`git push [-u] [--dry-run] <remote> <branch>` to a branch that is not protected, with no force, delete, `+refspec`, `--mirror`, `--all` or `--prune`",
	rebase: "`git rebase <ref>`, or `git rebase --continue | --abort | --skip | --quit`",
	config: "`git config --get <key>`, `git config --list`/`-l`, `git config get <key>` or `git config list` (config reads only)",
	fetch: "`git fetch [<remote> [<ref>…]]` with fetch's other options",
	pull: "`git pull [<remote> [<ref>]]` without --force or --upload-pack",
	merge: "`git merge <ref>` (with a built-in strategy, if any)",
	mv: "`git mv <src> <dst>` without -f",
	rm: "`git rm <paths>` without -f",
};

/** A space-separated word list as a lookup table. */
const words = (list: string): Record<string, true> => Object.fromEntries(list.split(" ").map((k) => [k, true]));

/**
 * Commands that read, or write only what no § A4 action names (a patch file, packed objects), with
 * every option git documents for each (M4 fix round 5, Plumb's ruling: "any option not modeled →
 * refused", read commands included). Generated on git 2.50.1 (Apple Git-155) from two sources: the
 * `git <sub> -h` usage text, and the man page git-<sub>(1) shipped with that git (`man -w
 * git-<sub>`): its option lines, its synopsis forms (`git diff … --cached`), and "--x is a synonym"
 * sentences, "--heads and -h are deprecated synonyms" included. A page that defers to another page's
 * options carries that page's list too, per git's own words: whatchanged ("essentially the same as
 * git-log(1)") and show ("Some options that git log command understands can be used") take log's;
 * blame and annotate take rev-list's (`-h`: "<rev-opts> are documented in git-rev-list(1)"). Tokens as in
 * GIT_OPTIONS, plus `#` for `-<number>`. Refresh: rebuild from the same sources on the git a profile
 * pins, running the generator outside any repository (`git diff -h` in a repository prints only the
 * hand-written summary; outside one, parse-options' full table). The generator is in the M4 fix
 * round 6 record (`gen-open-options.ts`), with each effect's man page paragraph: `@x` runs a program
 * (`--ext-diff`, `--textconv`, `--filters`, `--show-signature`, a pager, a viewer), `@w` the value is
 * a path it writes, `@u` it writes where no value names, `@o` it rewrites its operands in place.
 * Arity: `=` only where parse-options' own `-h` table says so; any other documented value is taken
 * attached (`=?`), so a word after an option is never swallowed as a value git would not take.
 */
const OPEN_OPTIONS: Record<string, string> = {
	status: "!ahead-behind !column=? !ignore-submodules=? !ignored=? !long !porcelain=? !show-stash M|find-renames=? b|!branch no-ahead-behind no-column no-renames renames s|!short u|!untracked-files=? v|!verbose z|!null",
	log: "!decorate-refs-exclude= !decorate-refs= !mailmap !rename-empty !source !use-mailmap # B|=? C|=? D| E| F| G|=? I|=? L|= M|=? O|=? P| R| S|=? U|=? W| X|=? abbrev-commit abbrev=? after=? all all-match alternate-refs ancestry-path=? anchored=? author-date-order author=? a| basic-regexp before=? binary bisect boundary branches=? break-rewrites=? b| cc check cherry cherry-mark cherry-pick children clear-decorations color-moved-ws=? color-moved=? color-words=? color=? combined-all-paths committer=? compact-summary cumulative c| date-order date=? dd decorate=? default-prefix dense diff-algorithm=? diff-filter=? diff-merges=? dirstat-by-file=? dirstat=? do-walk dst-prefix=? encoding=? exclude-first-parent-only exclude-hidden=? exclude=? expand-tabs=? ext-diff@x extended-regexp find-copies-harder find-copies=? find-object=? find-renames=? first-parent fixed-strings follow format=? full-diff full-history full-index function-context glob=? graph grep-reflog=? grep=? g| histogram ignore-all-space ignore-blank-lines ignore-cr-at-eol ignore-matching-lines=? ignore-missing ignore-space-at-eol ignore-space-change ignore-submodules=? indent-heuristic inter-hunk-context=? invert-grep irreversible-delete ita-invisible-in-index i| left-only left-right line-prefix=? log-size l|=? max-count=? max-parents=? merge merges min-parents=? minimal m| name-only name-status no-abbrev-commit no-color no-color-moved no-color-moved-ws no-decorate no-diff-merges no-expand-tabs no-ext-diff no-indent-heuristic no-max-parents no-merges no-min-parents no-notes no-patch no-prefix no-relative no-renames no-standard-notes no-textconv no-walk=? not notes=? numstat n|=? oneline output-indicator-context=? output-indicator-new=? output-indicator-old=? output=?@w parents patch patch-with-raw patch-with-stat patience perl-regexp pickaxe-all pickaxe-regex pretty=? p| q|!quiet raw reflog regexp-ignore-case relative-date relative=? remerge-diff remotes=? remove-empty reverse right-only rotate-to=? shortstat show-linear-break=? show-notes-by-default show-notes=? show-pulls show-signature@x simplify-by-decoration simplify-merges since-as-filter=? since=? single-worktree skip-to=? skip=? sparse src-prefix=? standard-notes stat=? stdin submodule=? summary s| tags=? text textconv@x topo-order t| unified=? until=? u| walk-reflogs word-diff-regex=? word-diff=? ws-error-highlight=? w| z|",
	diff: "!abbrev=? !color-moved-ws= !color-moved=? !compact-summary !exit-code !ext-diff@x !find-copies-harder !follow !full-index !indent-heuristic !quiet !relative=? !rename-empty !textconv@x 0| 1| 2| 3| B|break-rewrites=? C|find-copies=? D|irreversible-delete G|= I|!ignore-matching-lines= M|find-renames=? O|= R| S|= U|unified=? W|!function-context X|dirstat=? anchored= a|!text base binary b|ignore-space-change cached check color-words=? color=? cumulative default-prefix diff-algorithm= diff-filter=? dirstat-by-file=? dst-prefix=? find-object= histogram ignore-blank-lines ignore-cr-at-eol ignore-space-at-eol ignore-submodules=? inter-hunk-context= ita-invisible-in-index ita-visible-in-index line-prefix= l|= merge-base minimal name-only name-status no-color no-color-moved no-color-moved-ws no-ext-diff no-indent-heuristic no-index no-prefix no-relative no-renames no-textconv numstat ours output-indicator-context= output-indicator-new= output-indicator-old= output=@w patch-with-raw patch-with-stat patience pickaxe-all pickaxe-regex p|patch raw rotate-to= shortstat skip-to= src-prefix=? staged stat-count= stat-graph-width= stat-name-width= stat-width= stat=? submodule=? summary s|no-patch theirs u| word-diff-regex= word-diff=? ws-error-highlight= w|ignore-all-space z|",
	show: "!decorate-refs-exclude= !decorate-refs= !mailmap !rename-empty !source !use-mailmap # B|=? C|=? D| E| F| G|=? I|=? L|= M|=? O|=? P| R| S|=? U|=? W| X|=? abbrev-commit abbrev=? after=? all all-match alternate-refs ancestry-path=? anchored=? author-date-order author=? a| basic-regexp before=? binary bisect boundary branches=? break-rewrites=? b| cc check cherry cherry-mark cherry-pick children clear-decorations color-moved-ws=? color-moved=? color-words=? color=? combined-all-paths committer=? compact-summary cumulative c| date-order date=? dd decorate=? default-prefix dense diff-algorithm=? diff-filter=? diff-merges=? dirstat-by-file=? dirstat=? do-walk dst-prefix=? encoding=? exclude-first-parent-only exclude-hidden=? exclude=? expand-tabs=? ext-diff@x extended-regexp find-copies-harder find-copies=? find-object=? find-renames=? first-parent fixed-strings follow format=? full-diff full-history full-index function-context glob=? graph grep-reflog=? grep=? g| histogram ignore-all-space ignore-blank-lines ignore-cr-at-eol ignore-matching-lines=? ignore-missing ignore-space-at-eol ignore-space-change ignore-submodules=? indent-heuristic inter-hunk-context=? invert-grep irreversible-delete ita-invisible-in-index i| left-only left-right line-prefix=? log-size l|=? max-count=? max-parents=? merge merges min-parents=? minimal m| name-only name-status no-abbrev-commit no-color no-color-moved no-color-moved-ws no-decorate no-diff-merges no-expand-tabs no-ext-diff no-indent-heuristic no-max-parents no-merges no-min-parents no-notes no-patch no-prefix no-relative no-renames no-standard-notes no-textconv no-walk=? not notes=? numstat n|=? oneline output-indicator-context=? output-indicator-new=? output-indicator-old=? output=?@w parents patch patch-with-raw patch-with-stat patience perl-regexp pickaxe-all pickaxe-regex pretty=? p| q|!quiet raw reflog regexp-ignore-case relative-date relative=? remerge-diff remotes=? remove-empty reverse right-only rotate-to=? shortstat show-linear-break=? show-notes-by-default show-notes=? show-pulls show-signature@x simplify-by-decoration simplify-merges since-as-filter=? since=? single-worktree skip-to=? skip=? sparse src-prefix=? standard-notes stat=? stdin submodule=? summary s| tags=? text textconv@x topo-order t| unified=? until=? u| walk-reflogs word-diff-regex=? word-diff=? ws-error-highlight=? w| z|",
	"rev-parse": "abbrev-ref=? absolute-git-dir after=? all before=? branches=? default=? disambiguate=? exclude-hidden=? exclude=? flags git-common-dir git-dir git-path=? glob=? is-bare-repository is-inside-git-dir is-inside-work-tree is-shallow-repository keep-dashdash local-env-vars no-flags no-revs not output-object-format=? parseopt path-format=? prefix=? quiet q| remotes=? resolve-git-dir=? revs-only shared-index-path short=? show-cdup show-object-format=? show-prefix show-ref-format show-superproject-working-tree show-toplevel since=? sq sq-quote stop-at-non-option stuck-long symbolic symbolic-full-name tags=? until=? verify",
	"ls-files": "!abbrev=? !debug !deduplicate !directory !empty-directory !eol !error-unmatch !exclude-per-directory= !recurse-submodules !resolve-undo !sparse !with-tree= X|exclude-from= c|!cached d|!deleted exclude-standard format= full-name f| i|!ignored k|!killed m|!modified no-empty-directory o|!others s|!stage t| u|!unmerged v| x|exclude= z|",
	"ls-tree": "!abbrev=? !full-name !full-tree d| format= l|long name-only name-status object-only r| t| z|",
	"ls-remote": "!exit-code !get-url !refs !sort= !symref !upload-pack=@x b|!branches heads h| o|!server-option= q|!quiet t|!tags",
	blame: "!abbrev=? !color-by-age !color-lines !contents= !ignore-rev= !ignore-revs-file= !incremental !minimal !object-names !progress !root !score-debug !show-stats # C|=? E| F| L|= M|=? P| S|= abbrev-commit after=? all all-match alternate-refs ancestry-path=? author-date-order author=? basic-regexp before=? bisect bisect-all bisect-vars boundary branches b| cherry cherry-mark cherry-pick children commit-header committer=? count c| date-order date=? dense disk-usage=? do-walk encoding=? exclude-first-parent-only exclude-hidden= exclude-promisor-objects exclude=? expand-tabs=? extended-regexp e| filter-print-omitted filter-provided-objects filter=? first-parent fixed-strings format=? full-history f|!show-name glob=? graph grep-reflog=? grep=? g| header h| ignore-missing in-commit-order indexed-objects invert-grep i| left-only left-right line-porcelain l| max-age= max-count= max-parents= merge merges min-age= min-parents= missing=? no-abbrev-commit no-commit-header no-expand-tabs no-filter no-max-parents no-merges no-min-parents no-object-names no-walk=? not n|!show-number objects objects-edge objects-edge-aggressive oneline parents perl-regexp pretty=? p|!porcelain quiet reflog regexp-ignore-case relative-date remotes remove-empty reverse right-only show-email show-linear-break=? show-pulls show-signature@x simplify-by-decoration simplify-merges since-as-filter=? since=? single-worktree skip=? sparse stdin s| tags timestamp topo-order t| unpacked until=? use-bitmap-index walk-reflogs w| z|",
	annotate: "!abbrev=? !color-by-age !color-lines !contents= !ignore-rev= !ignore-revs-file= !incremental !minimal !object-names !progress !root !score-debug !show-stats # C|=? E| F| L|= M|=? P| S|= abbrev-commit after=? all all-match alternate-refs ancestry-path=? author-date-order author=? basic-regexp before=? bisect bisect-all bisect-vars boundary branches b| cherry cherry-mark cherry-pick children commit-header committer=? count c| date-order date=? dense disk-usage=? do-walk encoding=? exclude-first-parent-only exclude-hidden= exclude-promisor-objects exclude=? expand-tabs=? extended-regexp e| filter-print-omitted filter-provided-objects filter=? first-parent fixed-strings format=? full-history f|!show-name glob=? graph grep-reflog=? grep=? g| header h| ignore-missing in-commit-order indexed-objects invert-grep i| left-only left-right line-porcelain l| max-age= max-count= max-parents= merge merges min-age= min-parents= missing=? no-abbrev-commit no-commit-header no-expand-tabs no-filter no-max-parents no-merges no-min-parents no-object-names no-walk=? not n|!show-number objects objects-edge objects-edge-aggressive oneline parents perl-regexp pretty=? p|!porcelain quiet reflog regexp-ignore-case relative-date remotes remove-empty reverse right-only show-linear-break=? show-pulls show-signature@x simplify-by-decoration simplify-merges since-as-filter=? since=? single-worktree skip=? sparse stdin s| tags timestamp topo-order t| unpacked until=? use-bitmap-index walk-reflogs w| z|",
	shortlog: "!group= # E| F| P| after=? all all-match alternate-refs ancestry-path=? author=? basic-regexp before=? bisect boundary branches=? cherry cherry-mark cherry-pick c|!committer date=? dense exclude-first-parent-only exclude-hidden=? exclude=? extended-regexp e|!email first-parent fixed-strings format=? full-history glob=? grep-reflog=? grep=? g| ignore-missing invert-grep i| left-only max-count=? max-parents=? merge merges min-parents=? no-max-parents no-merges no-min-parents not n|!numbered perl-regexp pretty=? reflog regexp-ignore-case remotes=? remove-empty right-only show-pulls simplify-by-decoration simplify-merges since-as-filter=? since=? single-worktree skip=? sparse stdin s|!summary tags=? until=? walk-reflogs w|=?",
	describe: "!abbrev=? !all !always !broken=? !contains !debug !exact-match !exclude= !first-parent !long !match= !tags candidates=? dirty=?",
	"cat-file": "!buffer !filter= !follow-symlinks !mailmap !unordered !use-mailmap Z| batch-all-objects batch-check=? batch-command=? batch=? e| filters@x no-filter path=? p| s| textconv@x t| z|",
	"show-ref": "!abbrev=? !branches !exists !head !tags !verify d|!dereference exclude-existing=? hash=? heads q|!quiet s|",
	"for-each-ref": "!count= !exclude= !format= !ignore-case !include-root-refs !omit-empty !points-at= !python !sort= !stdin !tcl color=? contains= merged= no-contains= no-merged= p|!perl s|!shell",
	"merge-base": "a|!all fork-point independent is-ancestor octopus",
	"name-rev": "!all !always !exclude= !name-only !tags !undefined annotate-stdin no-undefined refs=?",
	"rev-list": "!object-names # E| F| P| abbrev-commit after=? all all-match alternate-refs ancestry-path=? author-date-order author=? basic-regexp before=? bisect bisect-all bisect-vars boundary branches cherry cherry-mark cherry-pick children commit-header committer=? count date-order date=? dense disk-usage=? do-walk encoding=? exclude-first-parent-only exclude-hidden= exclude-promisor-objects exclude=? expand-tabs=? extended-regexp filter-print-omitted filter-provided-objects filter=? first-parent fixed-strings format=? full-history glob=? graph grep-reflog=? grep=? g| header ignore-missing in-commit-order indexed-objects invert-grep i| left-only left-right max-age= max-count= max-parents= merge merges min-age= min-parents= missing=? no-abbrev-commit no-commit-header no-expand-tabs no-filter no-max-parents no-merges no-min-parents no-object-names no-walk=? not n|=? objects objects-edge objects-edge-aggressive oneline parents perl-regexp pretty=? progress=? quiet reflog regexp-ignore-case relative-date remotes remove-empty reverse right-only show-linear-break=? show-pulls show-signature@x simplify-by-decoration simplify-merges since-as-filter=? since=? single-worktree skip=? sparse stdin tags timestamp topo-order unpacked until=? use-bitmap-index walk-reflogs z|",
	"check-ignore": "!stdin index no-index n|!non-matching q|!quiet v|!verbose z|",
	"check-attr": "!cached !source= !stdin a|!all z|",
	"check-mailmap": "!mailmap-blob= !mailmap-file= !stdin",
	"check-ref-format": "!allow-onelevel branch normalize refspec-pattern",
	grep: "!all-match !break !cached !column !exclude-standard !ext-grep !full-name !heading !name-only !recurse-submodules !textconv@x !threads= !untracked # A|after-context= B|before-context= C|!context= E|!extended-regexp F|!fixed-strings G|!basic-regexp H| I| L|!files-without-match O|!open-files-in-pager=?@x P|!perl-regexp W|!function-context and a|!text color=? c|!count e|= f|= h| index i|!ignore-case l|!files-with-matches max-depth= m|!max-count= no-color no-exclude-standard no-index no-recursive no-textconv not n|!line-number or o|!only-matching p|!show-function q|!quiet r|!recursive v|!invert-match w|!word-regexp z|!null",
	whatchanged: "!decorate-refs-exclude= !decorate-refs= !mailmap !rename-empty !source !use-mailmap # B|=? C|=? D| E| F| G|=? I|=? L|= M|=? O|=? P| R| S|=? U|=? W| X|=? abbrev-commit abbrev=? after=? all all-match alternate-refs ancestry-path=? anchored=? author-date-order author=? a| basic-regexp before=? binary bisect boundary branches=? break-rewrites=? b| cc check cherry cherry-mark cherry-pick children clear-decorations color-moved-ws=? color-moved=? color-words=? color=? combined-all-paths committer=? compact-summary cumulative c| date-order date=? dd decorate=? default-prefix dense diff-algorithm=? diff-filter=? diff-merges=? dirstat-by-file=? dirstat=? do-walk dst-prefix=? encoding=? exclude-first-parent-only exclude-hidden=? exclude=? expand-tabs=? ext-diff@x extended-regexp find-copies-harder find-copies=? find-object=? find-renames=? first-parent fixed-strings follow format=? full-diff full-history full-index function-context glob=? graph grep-reflog=? grep=? g| histogram ignore-all-space ignore-blank-lines ignore-cr-at-eol ignore-matching-lines=? ignore-missing ignore-space-at-eol ignore-space-change ignore-submodules=? indent-heuristic inter-hunk-context=? invert-grep irreversible-delete ita-invisible-in-index i| left-only left-right line-prefix=? log-size l|=? max-count=? max-parents=? merge merges min-parents=? minimal m| name-only name-status no-abbrev-commit no-color no-color-moved no-color-moved-ws no-decorate no-diff-merges no-expand-tabs no-ext-diff no-indent-heuristic no-max-parents no-merges no-min-parents no-notes no-patch no-prefix no-relative no-renames no-standard-notes no-textconv no-walk=? not notes=? numstat n|=? oneline output-indicator-context=? output-indicator-new=? output-indicator-old=? output=?@w parents patch patch-with-raw patch-with-stat patience perl-regexp pickaxe-all pickaxe-regex pretty=? p| q|!quiet raw reflog regexp-ignore-case relative-date relative=? remerge-diff remotes=? remove-empty reverse right-only rotate-to=? shortstat show-linear-break=? show-notes-by-default show-notes=? show-pulls show-signature@x simplify-by-decoration simplify-merges since-as-filter=? since=? single-worktree skip-to=? skip=? sparse src-prefix=? standard-notes stat=? stdin submodule=? summary s| tags=? text textconv@x topo-order t| unified=? until=? u| walk-reflogs word-diff-regex=? word-diff=? ws-error-highlight=? w| z|",
	"range-diff": "!abbrev=? !color-moved-ws= !color-moved=? !compact-summary !creation-factor= !diff-merges= !exit-code !ext-diff@x !find-copies-harder !follow !full-index !indent-heuristic !left-only !notes=? !quiet !relative=? !remerge-diff !rename-empty !right-only !textconv@x B|break-rewrites=? C|find-copies=? D|irreversible-delete G|= I|!ignore-matching-lines= M|find-renames=? O|= R| S|= U|unified=? W|!function-context X|dirstat=? anchored= a|!text binary b|ignore-space-change check color-words=? color=? cumulative default-prefix diff-algorithm= diff-filter=? dirstat-by-file=? dual-color find-object= histogram ignore-blank-lines ignore-cr-at-eol ignore-submodules=? inter-hunk-context= ita-invisible-in-index ita-visible-in-index line-prefix= l|= minimal name-only name-status no-color no-dual-color no-prefix no-renames numstat output-indicator-context= output-indicator-new= output-indicator-old= output=@w patch-with-raw patch-with-stat patience pickaxe-all pickaxe-regex p|patch raw rotate-to= shortstat skip-to= stat-count= stat-graph-width= stat-name-width= stat-width= stat=? submodule=? summary s|no-patch u| word-diff-regex= word-diff=? ws-error-highlight= w|ignore-all-space z|",
	cherry: "!abbrev=? v|!verbose",
	"show-branch": "!current !independent !list !merge-base !more=? !sha1-name !sparse !topics a|!all color=? date-order g|reflog=? name no-color no-name r|!remotes topo-order",
	"count-objects": "H|!human-readable v|!verbose",
	var: "l|",
	version: "!build-options",
	help: "!aliases !external-commands a|all c|config developer-interfaces g|guides i|!info@x m|!man@x no-aliases no-external-commands user-interfaces v|!verbose w|!web@x",
	"diff-tree": "!rename-empty B|=? C|=? D| G|=? I|=? M|=? O|=? R| S|=? U|=? W| X|=? abbrev-commit abbrev=? always anchored=? a| binary break-rewrites=? b| cc check color-moved-ws=? color-moved=? color-words=? color=? combined-all-paths compact-summary cumulative c| default-prefix diff-algorithm=? diff-filter=? dirstat-by-file=? dirstat=? dst-prefix=? encoding=? exit-code expand-tabs=? ext-diff@x find-copies-harder find-copies=? find-object=? find-renames=? format=? full-index function-context histogram ignore-all-space ignore-blank-lines ignore-cr-at-eol ignore-matching-lines=? ignore-space-at-eol ignore-space-change ignore-submodules=? indent-heuristic inter-hunk-context=? irreversible-delete ita-invisible-in-index line-prefix=? l|=? merge-base minimal m| name-only name-status no-abbrev-commit no-color no-color-moved no-color-moved-ws no-commit-id no-expand-tabs no-ext-diff no-indent-heuristic no-notes no-patch no-prefix no-relative no-renames no-standard-notes no-textconv notes=? numstat oneline output-indicator-context=? output-indicator-new=? output-indicator-old=? output=?@w patch patch-with-raw patch-with-stat patience pickaxe-all pickaxe-regex pretty=? p| quiet raw relative=? root rotate-to=? r| shortstat show-notes-by-default show-notes=? show-signature@x skip-to=? src-prefix=? standard-notes stat=? stdin submodule=? summary s| text textconv@x t| unified=? u| v| word-diff-regex=? word-diff=? ws-error-highlight=? w| z|",
	"diff-index": "!rename-empty B|=? C|=? D| G|=? I|=? M|=? O|=? R| S|=? U|=? W| X|=? abbrev=? anchored=? a| binary break-rewrites=? b| cached check color-moved-ws=? color-moved=? color-words=? color=? compact-summary cumulative default-prefix diff-algorithm=? diff-filter=? dirstat-by-file=? dirstat=? dst-prefix=? exit-code ext-diff@x find-copies-harder find-copies=? find-object=? find-renames=? full-index function-context histogram ignore-all-space ignore-blank-lines ignore-cr-at-eol ignore-matching-lines=? ignore-space-at-eol ignore-space-change ignore-submodules=? indent-heuristic inter-hunk-context=? irreversible-delete ita-invisible-in-index line-prefix=? l|=? merge-base minimal m| name-only name-status no-color no-color-moved no-color-moved-ws no-ext-diff no-indent-heuristic no-patch no-prefix no-relative no-renames no-textconv numstat output-indicator-context=? output-indicator-new=? output-indicator-old=? output=?@w patch patch-with-raw patch-with-stat patience pickaxe-all pickaxe-regex p| quiet raw relative=? rotate-to=? shortstat skip-to=? src-prefix=? stat=? submodule=? summary s| text textconv@x unified=? u| word-diff-regex=? word-diff=? ws-error-highlight=? w| z|",
	"diff-files": "!rename-empty 0| 1| 2| 3| B|=? C|=? D| G|=? I|=? M|=? O|=? R| S|=? U|=? W| X|=? abbrev=? anchored=? a| binary break-rewrites=? b| cc check color-moved-ws=? color-moved=? color-words=? color=? compact-summary cumulative c| default-prefix diff-algorithm=? diff-filter=? dirstat-by-file=? dirstat=? dst-prefix=? exit-code ext-diff@x find-copies-harder find-copies=? find-object=? find-renames=? full-index function-context histogram ignore-all-space ignore-blank-lines ignore-cr-at-eol ignore-matching-lines=? ignore-space-at-eol ignore-space-change ignore-submodules=? indent-heuristic inter-hunk-context=? irreversible-delete ita-invisible-in-index line-prefix=? l|=? minimal name-only name-status no-color no-color-moved no-color-moved-ws no-ext-diff no-indent-heuristic no-patch no-prefix no-relative no-renames no-textconv numstat output-indicator-context=? output-indicator-new=? output-indicator-old=? output=?@w patch patch-with-raw patch-with-stat patience pickaxe-all pickaxe-regex p| quiet q| raw relative=? rotate-to=? shortstat skip-to=? src-prefix=? stat=? submodule=? summary s| text textconv@x unified=? u| word-diff-regex=? word-diff=? ws-error-highlight=? w| z|",
	apply: "!allow-empty !allow-overlap !apply !build-fake-ancestor=@w !cached !check !directory= !ignore-space-change !ignore-whitespace !index !numstat !recount !reject !stat !summary !unidiff-zero !unsafe-paths@u !whitespace= 3|!3way C|= N|!intent-to-add R|!reverse add allow-binary-replacement binary exclude= inaccurate-eof include= no-add ours p|= q|!quiet theirs union v|!verbose z|",
	"format-patch": "!add-header= !attach=? !base= !cc= !cover-from-description= !cover-letter !creation-factor= !description-file= !filename-max-length= !force-in-body-from !ignore-if-in-upstream !in-reply-to= !interdiff= !progress !range-diff= !rename-empty !rfc=? !signature-file= !signature= !start-number= !stdout !suffix= !thread=? !to= !zero-commit # B|=? C|=? D| I|=? M|=? N|no-numbered O|=? U|=? W| X|=? abbrev=? always anchored=? a| binary break-rewrites=? b| compact-summary cumulative default-prefix diff-algorithm=? dirstat-by-file=? dirstat=? dst-prefix=? encode-email-headers ext-diff@x find-copies-harder find-copies=? find-renames=? from=? full-index function-context histogram ignore-all-space ignore-blank-lines ignore-cr-at-eol ignore-matching-lines=? ignore-space-at-eol ignore-space-change ignore-submodules=? indent-heuristic inline=? inter-hunk-context=? irreversible-delete ita-invisible-in-index k|keep-subject line-prefix=? l|=? minimal no-attach no-binary no-encode-email-headers no-ext-diff no-indent-heuristic no-notes no-prefix no-relative no-renames no-textconv no-thread notes=? numbered-files numstat n|!numbered output-indicator-context=? output-indicator-new=? output-indicator-old=? output=?@w o|output-directory=@w patience p|no-stat q|!quiet relative=? root rotate-to=? shortstat skip-to=? src-prefix=? stat=? subject-prefix= summary s|!signoff text textconv@x unified=? v|!reroll-count= w|",
	gc: "!aggressive !auto !cruft !detach !expire-to=@w !force !keep-largest-pack max-cruft-size= no-prune prune=? q|!quiet",
	fsck: "!cache !connectivity-only !dangling !full !lost-found@u !name-objects !progress !references !reflogs !root !strict !tags !unreachable no-reflogs v|!verbose",
	archive: "!add-file= !add-virtual-file= !format= !prefix= !remote=@x !worktree-attributes # exec=?@x l|!list mtime= o|!output=@w v|!verbose",
	"interpret-trailers": "!if-exists= !if-missing= !in-place@o !only-input !only-trailers !trailer= !trim-empty !unfold !where= divider no-divider no-if-exists no-if-missing no-where parse",
	stripspace: "c|comment-lines s|strip-comments",
	"hash-object": "!literally !path= !stdin !stdin-paths filters@x no-filters t|= w|",
};
/** Revision/diff commands: they do not abbreviate options (header), so these match exactly. */
const NO_ABBREV = words("log diff show whatchanged diff-tree diff-index diff-files range-diff rev-list shortlog cherry format-patch rev-parse");
/**
 * Options of the subcommands with actions (M4 fix round 6, astra-6 B1: every special-case handler
 * parses through `parse`, so an unknown option or action is refused and `-Bmain` is `-B main`). Keys
 * are `<sub> <action>`, or `<sub>` for the options before the action. From git 2.50.1 (Apple
 * Git-155): `git <sub> <action> -h` (worktree, stash, remote, symbolic-ref, config); for submodule
 * the case patterns of git-submodule.sh (`$(git --exec-path)/git-submodule`, which matches each
 * spelling exactly and does not bundle); for bisect `git bisect -h` (builtin/bisect.c compares each
 * word exactly). reflog show and stash list take log's options, stash show diff's (git-reflog(1),
 * git-stash(1)), with their effects.
 */
const STASH_PUSH = "p|!patch S|!staged k|!keep-index q|!quiet u|!include-untracked a|!all m|!message= !pathspec-from-file= !pathspec-file-nul";
const ACTION_OPTIONS: Record<string, string> = {
	"reflog show": OPEN_OPTIONS.log!,
	"reflog list": "",
	"reflog exists": "",
	"stash list": OPEN_OPTIONS.log!,
	"stash show": `${OPEN_OPTIONS.diff!} u|!include-untracked only-untracked`,
	"stash push": STASH_PUSH,
	"stash save": STASH_PUSH,
	"stash pop": "q|!quiet !index",
	"stash apply": "q|!quiet !index",
	"stash branch": "",
	"stash create": "",
	"stash store": "m|!message= q|!quiet",
	remote: "v|!verbose",
	"remote add": "f|!fetch !tags t|!track= m|!master= !mirror=?",
	"remote show": "n|",
	"remote get-url": "!push !all",
	"remote set-url": "!push !add !delete",
	"remote set-head": "a|!auto d|!delete",
	"remote update": "p|!prune",
	"worktree list": "!porcelain v|!verbose !expire= z|",
	"worktree lock": "!reason=",
	"worktree unlock": "",
	"worktree move": "f|!force !relative-paths",
	"worktree add": "f|!force b|= B|= !orphan d|!detach !checkout !lock !reason= q|!quiet !track !guess-remote !relative-paths",
	submodule: "q|quiet cached",
	"submodule status": "q|quiet cached recursive",
	"submodule summary": "cached files for-status n|summary-limit=",
	"submodule init": "q|quiet",
	"submodule sync": "q|quiet recursive",
	"submodule update": "q|quiet v|verbose progress i|init require-init remote N|no-fetch f|force r|rebase ref-format= reference= dissociate m|merge recursive checkout !recommend-shallow depth= j|jobs= !single-branch filter=",
	"bisect start": "term-new= term-bad= term-old= term-good= no-checkout first-parent",
	"bisect terms": "term-good term-bad term-old term-new",
	"bisect good": "",
	"bisect bad": "",
	"bisect new": "",
	"bisect old": "",
	"bisect skip": "",
	"bisect next": "",
	"bisect reset": "",
	"bisect log": "",
	"bisect replay": "",
	"symbolic-ref": "q|!quiet d|!delete !short !recurse m|=",
	"config get": "!global !system !local !worktree f|!file= !blob= !all !regexp !value= !fixed-value !url= z|!null !name-only !show-origin !show-scope !show-names t|!type= bool int bool-or-int bool-or-str path expiry-date !includes !default=",
	"config list": "!global !system !local !worktree f|!file= !blob= z|!null !name-only !show-origin !show-scope !show-names t|!type= bool int bool-or-int bool-or-str path expiry-date !includes",
};
/** The option read as the output file of every OPEN command that has it: refused whatever its value (round 5). */
const OPEN_REFUSED: Record<string, string> = {
	output: "writes its output to a file (it can name .git/hooks)",
};
/** What an `x` or `u` option does, for the refusal line (the man page paragraph gen-open-options.ts cites). */
const EFFECT_WHY: Record<string, string> = {
	"ext-diff": "runs the external diff helper (diff.external, diff.<driver>.command)",
	textconv: "runs the textconv filter programs (diff.<driver>.textconv)",
	filters: "runs the configured filter programs (filter.<driver>.smudge/clean)",
	"show-signature": "runs gpg to check signatures (gpg.program)",
	"open-files-in-pager": "runs a pager program",
	info: "runs the info viewer program",
	man: "runs a man viewer program (man.viewer)",
	web: "runs a web browser program (help.browser)",
	"upload-pack": "names a program to run",
	exec: "names a program to run",
	remote: "runs git-upload-archive on another repository",
	"unsafe-paths": "writes outside the work tree (live, git 2.50.1: with --directory=.git/hooks it wrote an executable .git/hooks/pre-commit)",
	"lost-found": "writes dangling objects into .git/lost-found",
};

/**
 * A read command's words parsed by its table, or why they are refused: an option git does not list,
 * one that runs a program (`x`) or writes where no value names (`u`), a written path (`w`) inside
 * .git or not spelled out, or an operand rewritten in place (`o`) inside .git.
 */
function readVerdict(g: GitCall, label: string, args: string[], abbrev: boolean, spelling: string): Parsed | GitVerdict {
	const p = parse(table(label)!, args, abbrev);
	if (typeof p === "string") return unmodeled(`git ${label} ${p}`, spelling);
	for (const o of p.opts) {
		const flag = o.key.startsWith("-") ? o.key : `--${o.key}`;
		const without = `\`git ${label}\` without ${flag}`;
		const refused = OPEN_REFUSED[o.key];
		if (refused) return unmodeled(`git ${label} ${flag} ${refused}`, without);
		if (o.effect === "x" || o.effect === "u") return unmodeled(`git ${label} ${flag} ${EFFECT_WHY[o.key] ?? "runs a program the gate does not read"}`, without);
		if (o.effect === "w") {
			if (!o.value) return unmodeled(`git ${label} ${flag} without its path attached (the gate reads the path it writes)`, `\`git ${label} ${flag}=<path>\``);
			if (insideDotGit(o.value) || insideDotGit(resolve(g.dir ?? "/", o.value))) return unmodeled(`git ${label} ${flag} writes ${o.value}, inside .git (git's own hooks, config, index and objects)`, `\`git ${label} ${flag}=<path outside .git>\``);
		}
		if (o.effect === "o" && on(p, o.key) && [g.dir ?? "", ...p.operands, ...p.after].some(insideDotGit)) {
			return unmodeled(`git ${label} ${flag} on a file inside .git rewrites git's own files`, `\`git ${label}\` on a file outside .git`);
		}
	}
	return valueExec(label, p) ?? p;
}

/**
 * A format that makes git run gpg (astra-7 B2 audit; live, git 2.50.1, a signed commit and a stub
 * gpg.program: `log --format=%G?`, `%GS`, `show --pretty=format:%GK` each ran it once, `%H` did not;
 * so did the ref-filter atom `%(signature)` in `for-each-ref`/`branch --format`). `%%` is a literal
 * percent, so `%%G` names no placeholder.
 */
const GPG_TEMPLATE = /(?:^|[^%])(?:%%)*%(?:G|\(\*?signature)/;
/** The formats git archive builds itself (git-archive(1) "--format": tar, zip, and the tgz/tar.gz gzip pair); any other name runs the command `tar.<format>.command` names. */
const ARCHIVE_FORMAT = words("tar tgz tar.gz zip");
/**
 * URL schemes git speaks itself (transport.c transport_get: file, git, ssh and its two old
 * spellings; http, https, ftp, ftps through the git-remote-http* helpers git ships). A
 * `<scheme>::<address>` or any other `<scheme>://` runs `git-remote-<scheme>` found on PATH (live,
 * git 2.50.1: `git ls-remote review::x` and `review://x` each died with "'remote-review' is not a git
 * command"), like `merge -s <name>` runs git-merge-<name>.
 */
const BUILTIN_SCHEME = words("file git ssh git+ssh ssh+git http https ftp ftps");
const HELPER_URL = /^([A-Za-z][A-Za-z0-9+.-]*)(::|:\/\/)/;
/** Commands whose operands (and push's `--repo`) name a repository by URL. */
const TRANSPORT = words("fetch pull push clone ls-remote remote_add remote_set-url");

/**
 * Why a parsed command runs a program its option values or operands select, or null (astra-7 B2): a
 * gpg-running format placeholder, an archive format git does not build itself, or a transport helper
 * URL.
 */
function valueExec(label: string, p: Parsed): GitVerdict | null {
	for (const o of p.opts) {
		if ((o.key === "format" || o.key === "pretty") && o.value !== null && GPG_TEMPLATE.test(o.value)) {
			return unmodeled(`git ${label} --${o.key}=${o.value} names a signature placeholder (%G…, %(signature…)): git runs gpg (gpg.program) to check it`, `\`git ${label}\` with a format without %G… or %(signature…)`);
		}
		if (label === "archive" && o.key === "format" && !ARCHIVE_FORMAT[o.value ?? ""]) {
			return unmodeled(`git archive --format=${o.value}, a format git does not build itself (it runs the tar.${o.value}.command program)`, "`git archive --format=tar|tgz|tar.gz|zip <tree-ish>`");
		}
	}
	if (TRANSPORT[label.replace(" ", "_")]) {
		const urls = [...p.operands, ...p.after, ...p.opts.filter((o) => o.key === "repo").map((o) => o.value ?? "")];
		for (const u of urls) {
			const m = HELPER_URL.exec(u);
			if (m && (m[2] === "::" || !BUILTIN_SCHEME[m[1]!])) return unmodeled(`git ${label} ${u}, a URL git hands to git-remote-${m[1]} (a program found on PATH)`, "a remote name, a path, or an ssh, https or git URL");
		}
	}
	return null;
}

/** Why an OPEN subcommand's options are refused, or null: each option word must be one git documents for it. */
function openVerdict(g: GitCall, sub: string, args: string[]): GitVerdict | null {
	const v = readVerdict(g, sub, args, !NO_ABBREV[sub], `\`git ${sub}\` with the options git documents for it (\`git ${sub} -h\`, git-${sub}(1))`);
	return "why" in v ? v : null;
}

/**
 * The indices in `g.args` of the words `parse` read as values of the options `names` (table keys:
 * `-S` for a short-only option, `grep` for a long one), recorded as each word was consumed, never
 * found by searching the words afterwards. Empty for a subcommand that is not an OPEN one or whose
 * words do not parse. Row 6 masks these words as data (PLAN wl-mupzpidbb3ksg0 § 1); for an
 * attached spelling (`-S'…'`, `--grep=…`) the index is the whole word, option letters included.
 */
export function gitOptionValueWords(g: GitCall, names: readonly string[]): number[] {
	const sub = g.sub;
	if (!sub || OPEN_OPTIONS[sub] === undefined) return [];
	const p = parse(table(sub)!, g.args.map((w: Word) => w.text), !NO_ABBREV[sub]);
	if (typeof p === "string") return [];
	return p.opts.flatMap((o) => (o.at !== undefined && names.includes(o.key) ? [o.at] : []));
}

/**
 * A subcommand with actions: the options before the action (by `<sub>`'s table, when it has one),
 * then the action, which must be one ACTION_OPTIONS lists, then the action's words by its table.
 */
function actionVerdict(g: GitCall, sub: string, args: string[], spelling: string, abbrev = true): { action: string; p: Parsed } | GitVerdict {
	let i = 0;
	if (ACTION_OPTIONS[sub] !== undefined) {
		while (i < args.length && args[i]!.startsWith("-") && args[i] !== "--") i++;
		const globals = parse(table(sub)!, args.slice(0, i), abbrev);
		if (typeof globals === "string") return unmodeled(`git ${sub} ${globals}`, spelling);
	}
	const action = args[i];
	if (action === undefined || ACTION_OPTIONS[`${sub} ${action}`] === undefined) {
		const form = action === undefined ? `git ${sub} with no action` : `git ${sub} ${action}, an action`;
		return unmodeled(`${form} the gate does not model (it may remove, prune, rewrite or run a program)`, spelling);
	}
	const v = readVerdict(g, `${sub} ${action}`, args.slice(i + 1), abbrev, spelling);
	return "why" in v ? v : { action, p: v };
}

/** Subcommands refused outright: each rewrites history, moves refs directly, or runs a program. */
const REFUSED_SUBS: Record<string, GitVerdict> = {
	"update-ref": reserved("git update-ref moves or deletes a ref directly (a history rewrite)"),
	"filter-branch": reserved("git filter-branch rewrites history"),
	replace: reserved("git replace substitutes objects (a history rewrite)"),
	difftool: unmodeled("git difftool runs an external program (--extcmd, -x or the configured tool)", "`git diff`"),
	mergetool: unmodeled("git mergetool runs an external program", "resolving the conflict by editing the file, then `git add`"),
	"verify-commit": unmodeled("git verify-commit runs gpg to check the signature (gpg.program)", "`git log -1 <commit>` (without signature checks)"),
	"verify-tag": unmodeled("git verify-tag runs gpg to check the signature (gpg.program)", "`git show -s <tag>` (without signature checks)"),
};

/** Is `p` a path in the work tree (it exists, or git tracks it)? `checkout <p>` would then restore it. */
function isWorkTreePath(dir: string, p: string): boolean {
	if (p === "." || p === ".." || p.startsWith(":") || p.includes("*") || p.includes("?")) return true;
	try {
		lstatSync(resolve(dir, p));
		return true;
	} catch {
		// not on disk: tracked (deleted in the work tree) is still a path
	}
	const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", p], { cwd: dir, encoding: "utf8", timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
	return r.status === 0;
}

/** A push refspec's destination on the remote (`src:dst` → dst; a bare `src` → src). */
function pushDestination(spec: string): string {
	const s = spec.replace(/^\+/, "");
	return s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
}

/** Is a destination ref protected (`main`, `refs/heads/main`, `heads/main`, and the other PROTECTED_BRANCH names)? */
export function protectedRef(dst: string): boolean {
	const name = dst.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
	return PROTECTED_BRANCH.test(name) || dst.includes("*");
}

function checkPush(p: Parsed): GitVerdict | null {
	// The first operand is the remote; every later one is a refspec.
	for (const spec of [...p.operands, ...p.after].slice(1)) {
		if (spec.startsWith("+")) return reserved("force-push (+refspec)");
		if (spec.startsWith(":")) return reserved("remote ref deletion (git push :ref)");
		if (protectedRef(pushDestination(spec))) return reserved("push to a protected branch");
	}
	return null;
}

/**
 * A push's destination operand (its first operand) and whether `--repo` names one instead; null when
 * the words do not parse as git push reads them. For row 6's and row 8's scratch rules
 * (PLAN wl-mv5oikd5jtquww § 1.2 rule 3), which then check the destination is a path inside the root.
 */
export function pushDestinationOperand(g: GitCall): { remote: string | null; repoOption: boolean } | null {
	if (g.sub !== "push") return null;
	const p = parse(table("push")!, g.args.map((w: Word) => w.text));
	if (typeof p === "string") return null;
	return { remote: [...p.operands, ...p.after][0] ?? null, repoOption: has(p, "repo") };
}

/** Config read actions (legacy option form) and how many operands each takes at most. */
const CONFIG_READS: Record<string, number> = { get: 2, "get-all": 2, "get-regexp": 2, "get-urlmatch": 2, list: 0, "get-color": 2, "get-colorbool": 2 };
const CONFIG_WRITES = words("replace-all add unset unset-all rename-section remove-section edit");

/**
 * `git config`: the new-style actions only as the first word (`git config get <key>`, `git config
 * list`), as git reads them; anywhere else a word is the legacy form's operand, judged on what the
 * parse leaves (astra-6 B2: in `git config --file get core.hooksPath <dir>` `get` is the file, and the
 * two operands are a write).
 */
function checkConfig(g: GitCall, args: string[]): GitVerdict | null {
	const spelling = WRITE_SPELLING.config!;
	const why = "git config without --get or --list writes configuration (it can set core.hooksPath, core.sshCommand, aliases, …)";
	if (args[0] === "get" || args[0] === "list") {
		const v = readVerdict(g, `config ${args[0]}`, args.slice(1), true, spelling);
		if ("why" in v) return v;
		const n = v.operands.length + v.after.length;
		return (args[0] === "get" ? n >= 1 && n <= 2 : n === 0) ? null : unmodeled(why, spelling);
	}
	const p = parse(table("config")!, args);
	if (typeof p === "string") return unmodeled(`git config ${p}`, spelling);
	const n = p.operands.length + p.after.length;
	const actions = p.opts.filter((o) => CONFIG_READS[o.key] !== undefined || CONFIG_WRITES[o.key]);
	const read = actions.length === 1 ? CONFIG_READS[actions[0]!.key] : undefined;
	if (read !== undefined && n <= read) return null;
	// The legacy read with no action: `git config <key>`.
	if (actions.length === 0 && n === 1) return null;
	return unmodeled(why, spelling);
}

/** The modeled spelling of each subcommand with actions, for its refusal line. */
const ACTION_SPELLING: Record<string, string> = {
	reflog: "`git reflog [show] [<log options>] [<ref>]`, `git reflog list` or `git reflog exists <ref>`",
	stash: "`git stash`, `git stash list`, `show`, `push`, `save`, `pop`, `apply`, `branch`, `create` or `store` with the options git documents for each",
	remote: "`git remote [-v]`, `show`, `get-url`, `add` (without --mirror), `set-url`, `set-head` or `update`",
	worktree: "`git worktree list`, `lock`, `unlock`, `move`, or `git worktree add <path> [<branch>]` / `-b <new-branch>` (never -B)",
	submodule: "`git submodule [status | summary | init | sync | update]` without --force",
	bisect: "`git bisect start | good | bad | new | old | terms | skip | next | reset | log | replay`",
};

/**
 * Why a `git` command (already a modeled form per gitUnmodeled: literal words, builtin subcommand)
 * is refused by the positive model, or null. `lift` (row 6's scratch rules and the own-worktree rule
 * only) sets aside the reserved verdicts its conditions cover and records each in `lift.used`, or in
 * `lift.worktree` for one the own-worktree lift sets aside.
 */
export function gitModel(g: GitCall, lift?: ScratchLift): GitVerdict | null {
	const sub = g.sub;
	if (!sub) return null; // bare `git`, or an unknown subcommand gitUnmodeled refuses
	// `git help <term>`, `git <cmd> --help` and `git --help <cmd>` open the manual through the default
	// viewer: allowed, a doc lookup in the same class as the pager `git log` starts (Main's ruling, fix
	// round 7, § A4 accidental misuse). Choosing a viewer (`help --man`/`--web`/`--info`) stays refused.
	const args = g.args.map((w: Word) => w.text);
	if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) return null;
	const refusedSub = REFUSED_SUBS[sub];
	if (refusedSub) return refusedSub;

	if (OPEN_OPTIONS[sub] !== undefined) return openVerdict(g, sub, args);

	switch (sub) {
		case "reflog": {
			// `git reflog` with no action, or options first, is `git reflog show` (git-reflog(1)).
			const w = args.length === 0 || args[0]!.startsWith("-") ? ["show", ...args] : args;
			const v = actionVerdict(g, "reflog", w, ACTION_SPELLING.reflog!, false);
			return "why" in v ? v : null;
		}
		case "stash": {
			if (args.length === 0) return null;
			// `git stash -p …` is `git stash push -p …` (git-stash(1)).
			const w = args[0]!.startsWith("-") ? ["push", ...args] : args;
			if (w[0] === "drop" || w[0] === "clear") return unmodeled(`git stash ${w[0]} (discards stashed work)`, ACTION_SPELLING.stash!);
			const v = actionVerdict(g, "stash", w, ACTION_SPELLING.stash!, !(w[0] === "list" || w[0] === "show"));
			return "why" in v ? v : null;
		}
		case "remote": {
			if (args.every((a) => a.startsWith("-"))) {
				const p = parse(table("remote")!, args);
				return typeof p === "string" ? unmodeled(`git remote ${p}`, ACTION_SPELLING.remote!) : null;
			}
			const v = actionVerdict(g, "remote", args, ACTION_SPELLING.remote!);
			if ("why" in v) return v;
			if (v.action === "add" && has(v.p, "mirror")) return unmodeled("git remote add --mirror makes every later push a mirror push", "`git remote add <name> <url>`");
			return null;
		}
		case "worktree": {
			const v = actionVerdict(g, "worktree", args, ACTION_SPELLING.worktree!);
			if ("why" in v) return v;
			if (v.action === "add" && has(v.p, "-B")) return unmodeled("git worktree add -B resets an existing branch", "`git worktree add <path> [<branch>]` or `-b <new-branch>`");
			return null;
		}
		case "submodule": {
			if (args.every((a) => a.startsWith("-"))) {
				const p = parse(table("submodule")!, args, false);
				return typeof p === "string" ? unmodeled(`git submodule ${p}`, ACTION_SPELLING.submodule!) : null;
			}
			const v = actionVerdict(g, "submodule", args, ACTION_SPELLING.submodule!, false);
			if ("why" in v) return v;
			if (v.action === "update" && has(v.p, "force")) return unmodeled("git submodule update --force discards submodule work-tree changes", "`git submodule update [--init] [--recursive]`");
			return null;
		}
		case "bisect": {
			if (args.length === 0) return null;
			if (args[0] === "run") return unmodeled("git bisect run runs a program at every step", ACTION_SPELLING.bisect!);
			if (args[0] === "visualize" || args[0] === "view") return unmodeled(`git bisect ${args[0]} runs gitk or a pager program`, "`git bisect log`");
			const v = actionVerdict(g, "bisect", args, ACTION_SPELLING.bisect!, false);
			return "why" in v ? v : null;
		}
		case "symbolic-ref": {
			const v = readVerdict(g, "symbolic-ref", args, true, "`git symbolic-ref [-q] [--short] <name>` (a read)");
			if ("why" in v) return v;
			return [...v.operands, ...v.after].length <= 1 && !has(v, "delete") ? null : reserved("git symbolic-ref writing or deleting HEAD (a ref move)");
		}
		case "config":
			return checkConfig(g, args);
	}

	const t = table(sub);
	if (!t) return unmodeled(`git ${sub}, a git command the gate does not model`, "one of the modeled git commands (reads such as status, log, diff, show; writes such as add, commit, fetch, pull, rebase <ref>, merge, checkout <branch>, switch, restore --staged, stash, push)");
	const spelling = WRITE_SPELLING[sub] ?? `\`git ${sub}\` with its ordinary options`;
	const p = parse(t, args);
	if (typeof p === "string") return unmodeled(`git ${sub} ${p}`, spelling);
	const selected = valueExec(sub, p);
	if (selected) return selected;

	const program = firstOf(p, RUNS_PROGRAM[sub] ?? {});
	if (program) return unmodeled(RUNS_PROGRAM[sub]![program]!, spelling);
	const res = firstOf(p, RESERVED_OPTS[sub] ?? {});
	if (res) {
		const into = liftsOpts(sub, p, lift);
		if (!into) return reserved(RESERVED_OPTS[sub]![res]!);
		into.push(RESERVED_OPTS[sub]![res]!);
	}
	const unm = firstOf(p, UNMODELED_OPTS[sub] ?? {});
	if (unm) return unmodeled(UNMODELED_OPTS[sub]![unm]!, spelling);
	// Every `-s`, not the first: git runs each strategy given (astra-6 B4, `-s ort -s custom`).
	for (const s of p.opts.filter((o) => o.key === "strategy")) {
		if (!BUILTIN_STRATEGY.test(s.value ?? "")) return unmodeled(`git ${sub} -s ${s.value}, a merge strategy git does not ship (it runs git-merge-${s.value} from PATH)`, spelling);
	}

	// A reserved verdict a scratch lift of `kind` sets aside (rule 2: the repository is inside the own
	// scratch root; rule 3: every push destination is), or the own-worktree lift sets aside (a `repo`
	// verdict on the workload's own worktree), else the verdict.
	const liftable = (kind: "repo" | "push", v: GitVerdict): GitVerdict | null => {
		const into = lift?.[kind] ? lift.used : kind === "repo" ? lift?.worktree : undefined;
		if (!into) return v;
		into.push(v.why);
		return null;
	};
	switch (sub) {
		case "reset":
			return null;
		case "clean":
			if (has(p, "interactive")) return reserved("git clean -i (removes untracked files)");
			return on(p, "dry-run") && !has(p, "force") ? null : liftable("repo", reserved("git clean (removes untracked files; force in any position or spelling, or clean.requireForce off)"));
		case "restore":
			// The final state of each switch, in argument order (astra-6 B3: `--staged --no-staged` is the work tree).
			return on(p, "staged") && !has(p, "worktree") ? null : liftable("repo", reserved("git restore of the work tree (discards working changes)"));
		case "checkout": {
			if (p.dashdash || p.after.length > 0) return liftable("repo", reserved("git checkout -- <path> (discards working changes)"));
			// Branch creation by final value, not presence (astra-7 B1: `--orphan foo --no-orphan .` checks out `.`).
			const creates = finalValue(p, "-b") !== null || finalValue(p, "orphan") !== null;
			if (p.operands.length > 1) return liftable("repo", reserved("git checkout <commit> <path> (discards working changes)"));
			const target = p.operands[0];
			if (!creates && target !== undefined) {
				if (!g.dir) return unmodeled("git checkout in a directory the gate cannot resolve", spelling);
				if (isWorkTreePath(g.dir, target)) return liftable("repo", reserved(`git checkout ${target} (a path: discards working changes)`));
			}
			return null;
		}
		case "rebase":
			// History rewrites on a lane's own branch are ordinary; an interactive one runs an editor over
			// a todo list the gate cannot read (--exec is refused above as a program).
			if (has(p, "interactive", "edit-todo")) return unmodeled("git rebase -i (an interactive history rewrite through an editor)", spelling);
			return null;
		case "push": {
			const v = checkPush(p);
			return v ? liftable("push", v) : null;
		}
	}
	return null;
}

/**
 * OPEN subcommands that only read: every option whose effect runs a program or writes is refused by
 * openVerdict. ls-files, blame and describe added in M7 fix round 2 (the orchestrator's
 * `git ls-files | grep` was refused: ls-files was a read git-model allowed but not one row 15 typed).
 */
const PURE_READS: Record<string, true> = { status: true, log: true, diff: true, show: true, "rev-parse": true, "ls-files": true, blame: true, describe: true };
/** `git branch` options that create, move, copy, delete or re-point a branch (git-branch(1) modes other than list). */
const BRANCH_WRITES: Record<string, true> = {
	track: true, "set-upstream-to": true, "unset-upstream": true, delete: true, "-D": true, move: true, "-M": true, copy: true, "-C": true,
	"create-reflog": true, "edit-description": true, force: true,
};

/**
 * A git form that only reads (P-11 row 15, the orchestrator's history reads): one the positive model
 * allows (gitModel null) whose subcommand is a PURE_READS one, `git branch` in list mode (no mode
 * option; operands only with --list, where they are patterns), `git remote` with options only,
 * `git worktree list`, or `git stash list` (log's options, per the action table). Everything else,
 * allowed to a lane or not, is not a read.
 */
export function gitReads(g: GitCall): boolean {
	const sub = g.sub;
	if (!sub || gitModel(g) !== null) return false;
	const args = g.args.map((w: Word) => w.text);
	if (PURE_READS[sub]) return true;
	if (sub === "remote") return args.every((a) => a.startsWith("-"));
	if (sub === "worktree") return args[0] === "list";
	if (sub === "stash") return args[0] === "list";
	if (sub !== "branch") return false;
	const p = parse(table("branch")!, args);
	if (typeof p === "string" || p.opts.some((o) => BRANCH_WRITES[o.key])) return false;
	return p.operands.length + p.after.length === 0 || on(p, "list");
}

/** Does a path, spelled any way (`.GIT`, `.Git` on a case-insensitive file system), fall inside a `.git` directory? */
export function insideDotGit(path: string): boolean {
	return path.split(/[/\\]+/).some((part) => part.toLowerCase() === ".git");
}

