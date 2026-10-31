// The per-workload scratch root (PLAN wl-mv5oikd5jtquww § 1.1, § 1.2): where it lives, which root a
// bound session owns, and the two checks the row 6 scratch rules build on — a textual spelling check
// for a word's literal text and a physical containment check for an expanded path. The gates never
// take the root from `AS2_SCRATCH`: `ownScratchRoot` computes it from HOME and the bound workload id,
// and the variable only has to agree with it.
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { WORKLOAD_ENV } from "./types";

/** The variable `laneEnv` exports with the own root (no trailing slash). */
export const SCRATCH_ENV = "AS2_SCRATCH";
/** Per-root size cap, in MiB. */
export const SCRATCH_CAP_ENV = "AGENT_SYSTEM_SCRATCH_CAP_MB";
export const SCRATCH_CAP_DEFAULT_MB = 2048;
/** Cap on all roots together, in MiB. */
export const SCRATCH_TOTAL_ENV = "AGENT_SYSTEM_SCRATCH_TOTAL_MB";
export const SCRATCH_TOTAL_DEFAULT_MB = 10240;

/** Ledger entry prefixes the scratch machinery writes. */
export const SCRATCH_ENTRY = {
	overCap: "scratch-over-cap:",
	underCap: "scratch-under-cap:",
	disk: "scratch-disk:",
	diskOk: "scratch-disk-ok:",
	removed: "scratch-removed:",
	removeFailed: "scratch-remove-failed:",
	archived: "scratch-archived:",
	archiveExpired: "scratch-archive-expired:",
} as const;

/** A workload id as the ledger and the harnesses mint it (`wl-mv5…`, chaos's `wl-chaos-<run>`): one path component, never `.` or `/`. */
const WORKLOAD_ID = /^wl-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The directory every workload's root sits in, derived from HOME. */
export function scratchBase(home: string): string {
	return join(home, "agent-scratch", "agent-system-2.0", "scratch");
}

/** The root of workload `workloadId` under `home` (lexical; nothing is read). */
export function scratchRootFor(home: string, workloadId: string): string {
	if (!WORKLOAD_ID.test(workloadId)) throw new Error(`scratch: not a workload id: ${JSON.stringify(workloadId)}`);
	return join(scratchBase(home), workloadId);
}

/**
 * The physical root the session bound by `env` owns: `realpath(base)/<id>`, only when HOME is absolute,
 * the workload id is valid, that path is a real directory (not a symlink), and `AS2_SCRATCH` is unset or
 * names that root (the HOME-derived form or the physical one). Null otherwise; never throws.
 */
export function ownScratchRoot(env: Readonly<Record<string, string | undefined>>): string | null {
	const home = env.HOME;
	const id = env[WORKLOAD_ENV];
	if (!home || !home.startsWith("/") || !id || !WORKLOAD_ID.test(id)) return null;
	try {
		const root = `${realpathSync.native(scratchBase(home))}/${id}`;
		const st = lstatSync(root);
		if (st.isSymbolicLink() || !st.isDirectory()) return null;
		const named = env[SCRATCH_ENV];
		if (named !== undefined) {
			const given = named.replace(/\/+$/, "");
			if (given !== scratchRootFor(home, id) && given !== root) return null;
		}
		return root;
	} catch {
		return null;
	}
}

/**
 * `p` (absolute, no `..`) with symlinks resolved through its deepest existing ancestor, the rest joined
 * lexically. Unlike exec.ts `physicalPath`, existence is read with lstat, and a dangling symlink on the
 * way yields null: its target is where a write through it lands, and that is not known to be anywhere.
 */
function physicalOf(p: string): string | null {
	let head = p;
	const rest: string[] = [];
	for (;;) {
		let link = false;
		try {
			link = lstatSync(head).isSymbolicLink();
		} catch {
			const up = dirname(head);
			if (up === head) return null;
			rest.unshift(basename(head));
			head = up;
			continue;
		}
		try {
			if (link) statSync(head);
			return resolve(realpathSync.native(head), ...rest);
		} catch {
			return null;
		}
	}
}

/**
 * Whether `path` is strictly below `root` (already physical): absolute, no `..` component, no `%`, not
 * the root itself, and its physical path starts with `root/`. Never throws.
 */
export function insideRoot(root: string, path: string): boolean {
	if (!root.startsWith("/") || root === "/" || !path.startsWith("/")) return false;
	if (path.includes("%") || path.includes("\0") || path.split("/").includes("..")) return false;
	try {
		const phys = physicalOf(resolve(path));
		return phys !== null && phys !== root && phys.startsWith(`${root}/`);
	} catch {
		return false;
	}
}

/** Characters that make a word's text something other than the one literal path it spells. */
const UNLITERAL = /[$`*?[\]~%\\{}'"]/;
const VAR_PREFIXES = ["$AS2_SCRATCH", "${AS2_SCRATCH}", `"$AS2_SCRATCH"`, `"\${AS2_SCRATCH}"`];

/**
 * The absolute path a word's literal text spells, when it is an absolute literal path or
 * `$AS2_SCRATCH` / `${AS2_SCRATCH}` (alone or followed by `/…`) with `root` as the variable's value; null
 * for anything else. One layer of matching quotes around the whole text is removed first; inside single
 * quotes the variable is not expanded, so only a literal path is accepted there. The double-quoted
 * variable alone as a prefix (`"$AS2_SCRATCH"/x`) is accepted too. Textual only: nothing is read.
 */
export function scratchSpelling(text: string, root: string): string | null {
	let body = text;
	let quote: "'" | '"' | null = null;
	if (body.length >= 2 && (body[0] === "'" || body[0] === '"') && body[body.length - 1] === body[0]) {
		quote = body[0] as "'" | '"';
		body = body.slice(1, -1);
	}
	if (quote !== "'") {
		for (const prefix of VAR_PREFIXES) {
			if (quote === '"' && prefix.startsWith('"')) continue;
			if (!body.startsWith(prefix)) continue;
			const rest = body.slice(prefix.length);
			if (rest !== "" && !rest.startsWith("/")) return null;
			if (UNLITERAL.test(rest)) return null;
			return root + rest;
		}
	}
	if (!body.startsWith("/") || UNLITERAL.test(body)) return null;
	return body;
}
