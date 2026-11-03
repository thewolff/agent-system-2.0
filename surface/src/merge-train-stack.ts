// Stacked PRs on the merge train (PLAN wl-mv8s8srodefytc § 1b, Jo in-mv8u5wx3xu54hs: "A PR may declare it
// depends on another PR; the train lands dependencies first, in order, and shows the chain. Independent PRs
// keep today's behaviour."). This module is the pure part: what a PR declares (`prDeps`: its body's
// `Depends-on:` lines, and its base branch when that is another open PR's head), the order the train works
// its PRs in (`trainOrder`, a stable topological sort of Jo's order) and the chain line the lane shows
// (`chainLine`). The `order` subcommand of surface/scripts/merge-train.ts feeds it from gh; the test runner's
// starter refuses a train PR whose body dependency is not merged or whose base is not DEFAULT_BRANCH.

/** The branch every train PR lands on: the runner fetches and tests against `refs/heads/main` (surface/scripts/test-runner.ts). */
export const DEFAULT_BRANCH = "main";

/** What `prDeps` reads of a PR: `gh pr view <n> --json number,body,baseRefName`. */
export interface StackPr {
	number: number;
	body: string;
	baseRefName: string;
}

/** A `Depends-on:` line, case-insensitive, leading spaces allowed; group 1 is the rest of the line. */
const DEPENDS_RE = /^[ \t]*depends-on[ \t]*:(.*)$/i;
const NUMBER_RE = /^#?([1-9][0-9]*)$/;

/**
 * The PRs a body declares with `Depends-on: #N` lines (several lines allowed; one or more numbers per line,
 * comma- or space-separated, `#` optional), in the order written, deduplicated. A line's numbers end at its
 * first word that is no number (`Depends-on: #101 (the API)` declares 101).
 */
export function bodyDeps(body: string): number[] {
	const out: number[] = [];
	for (const line of body.split(/\r?\n/)) {
		const m = DEPENDS_RE.exec(line);
		if (!m) continue;
		for (const word of m[1]!.split(/[\s,]+/).filter(Boolean)) {
			const n = NUMBER_RE.exec(word);
			if (!n) break;
			const pr = Number(n[1]);
			if (!out.includes(pr)) out.push(pr);
		}
	}
	return out;
}

/** The open PR whose head branch is `pr`'s base (GitHub's stacked shape), or null: a base on DEFAULT_BRANCH, or one no open PR heads. */
export function baseDep(pr: StackPr, headsByBranch: ReadonlyMap<string, number>): number | null {
	if (pr.baseRefName === DEFAULT_BRANCH) return null;
	const n = headsByBranch.get(pr.baseRefName);
	return n === undefined || n === pr.number ? null : n;
}

/** Every PR `pr` depends on: its body's `Depends-on:` numbers, then its base-branch PR when the body does not name it; never itself. */
export function prDeps(pr: StackPr, headsByBranch: ReadonlyMap<string, number>): number[] {
	const out = bodyDeps(pr.body).filter((n) => n !== pr.number);
	const base = baseDep(pr, headsByBranch);
	if (base !== null && !out.includes(base)) out.push(base);
	return out;
}

/** What `headsByBranch` reads of an open PR: `gh pr list --state open --json number,headRefName,isCrossRepository`. */
export interface OpenHead {
	number: number;
	headRefName: string;
	/** True for a fork's PR: its head branch lives in another repository, so it is never this repository's base branch. */
	isCrossRepository: boolean;
}

/**
 * `headRefName → number` over the open in-repo PRs. A fork PR never maps: its head is a branch of another
 * repository that may carry an in-repo branch's name, and a base branch is always this repository's. A head
 * branch two open in-repo PRs share maps to neither, so no edge is guessed from it; DEFAULT_BRANCH is never a
 * stack base.
 */
export function headsByBranch(open: readonly OpenHead[]): Map<string, number> {
	const out = new Map<string, number>();
	const shared = new Set<string>();
	for (const { number, headRefName, isCrossRepository } of open) {
		if (isCrossRepository || headRefName === DEFAULT_BRANCH || shared.has(headRefName)) continue;
		if (out.has(headRefName)) {
			out.delete(headRefName);
			shared.add(headRefName);
		} else out.set(headRefName, number);
	}
	return out;
}

/** The train's working order (§ 1b). */
export interface TrainOrder {
	/** The PRs the lane works, each after every dependency that is on the train; otherwise Jo's order. */
	order: number[];
	/** A PR that is not run, and the dependencies holding it: off the train and not MERGED, or on the train and itself waiting or in a cycle. */
	waiting: Map<number, number[]>;
	/** Each cycle among the train's PRs, its members in Jo's order; not run. */
	cycles: number[][];
}

/** A PR's state as gh reports it (`OPEN`, `MERGED`, `CLOSED`), or undefined when it was not looked up. */
export type StateOf = (n: number) => string | undefined;
export type DepsOf = (n: number) => readonly number[];

/** The strongly connected components of the train's dependency graph with more than one member: its cycles. */
function cyclesOf(prs: readonly number[], deps: (n: number) => number[]): number[][] {
	const index = new Map<number, number>();
	const low = new Map<number, number>();
	const stack: number[] = [];
	const onStack = new Set<number>();
	const out: number[][] = [];
	let next = 0;
	const visit = (v: number): void => {
		index.set(v, next);
		low.set(v, next);
		next++;
		stack.push(v);
		onStack.add(v);
		for (const d of deps(v)) {
			if (!index.has(d)) {
				visit(d);
				low.set(v, Math.min(low.get(v)!, low.get(d)!));
			} else if (onStack.has(d)) low.set(v, Math.min(low.get(v)!, index.get(d)!));
		}
		if (low.get(v) !== index.get(v)) return;
		const scc: number[] = [];
		for (;;) {
			const w = stack.pop()!;
			onStack.delete(w);
			scc.push(w);
			if (w === v) break;
		}
		if (scc.length > 1) out.push(scc);
	};
	for (const p of prs) if (!index.has(p)) visit(p);
	const rank = (n: number) => prs.indexOf(n);
	for (const c of out) c.sort((a, b) => rank(a) - rank(b));
	return out.sort((a, b) => rank(a[0]!) - rank(b[0]!));
}

/**
 * The train's order (§ 1b): a stable topological sort of `prs` (Jo's order, `trainPrs`). Each PR is preceded by
 * its on-train dependencies, pulled ahead in Jo's order; with no dependency declared, `order` is `prs` exactly.
 * A dependency off the train that is MERGED has landed and holds nothing back; one that is not puts the PR in
 * `waiting`. Cycle members go in `cycles`, and a PR depending on a waiting PR or a cycle member waits too.
 * Neither is in `order`.
 */
export function trainOrder(prs: readonly number[], depsOf: DepsOf, stateOf: StateOf): TrainOrder {
	const onTrain = new Set(prs);
	const rank = (n: number) => prs.indexOf(n);
	const trainDeps = (n: number) =>
		[...new Set(depsOf(n))].filter((d) => d !== n && onTrain.has(d)).sort((a, b) => rank(a) - rank(b));
	const cycles = cyclesOf(prs, trainDeps);
	const inCycle = new Set(cycles.flat());
	const waiting = new Map<number, number[]>();
	for (const p of prs) {
		if (inCycle.has(p)) continue;
		const off = [...new Set(depsOf(p))].filter((d) => d !== p && !onTrain.has(d) && stateOf(d) !== "MERGED");
		if (off.length) waiting.set(p, off);
	}
	// A PR held by a held PR on the train is held too, to a fixed point.
	for (let changed = true; changed; ) {
		changed = false;
		for (const p of prs) {
			if (inCycle.has(p)) continue;
			const held = trainDeps(p).filter((d) => !waiting.get(p)?.includes(d) && (inCycle.has(d) || waiting.has(d)));
			if (!held.length) continue;
			waiting.set(p, [...(waiting.get(p) ?? []), ...held]);
			changed = true;
		}
	}
	const order: number[] = [];
	const place = (p: number): void => {
		if (order.includes(p)) return;
		for (const d of trainDeps(p)) place(d);
		order.push(p);
	};
	for (const p of prs) if (!inCycle.has(p) && !waiting.has(p)) place(p);
	return { order, waiting, cycles };
}

/**
 * The chain line (§ 1b): `#101 → #106 → #107 · #139`. Arrows join a stack (the train PRs one dependency edge
 * connects, in `order`), `·` separates independent stacks; a MERGED PR shows `✓` (an off-train merged dependency
 * leads its stack as `#101 ✓`); a waiting PR shows `#120 ⇠ #118 (not on the train)`, `(waiting)` or `(in a cycle)`
 * for a held train PR; a cycle shows `#130 ⇄ #131 (cycle)`. `current` is bolded (`**#106**`), for questions.
 */
export function chainLine(train: TrainOrder, depsOf: DepsOf, stateOf: StateOf, current?: number): string {
	const onTrain = new Set([...train.order, ...train.waiting.keys(), ...train.cycles.flat()]);
	const inCycle = new Set(train.cycles.flat());
	const pr = (n: number) => {
		const tag = n === current ? `**#${n}**` : `#${n}`;
		return stateOf(n) === "MERGED" ? `${tag} ✓` : tag;
	};
	// Stacks: union-find over the ordered PRs and their landed off-train dependencies.
	const parent = new Map<number, number>();
	const find = (n: number): number => {
		let r = n;
		while (parent.get(r) !== r) r = parent.get(r)!;
		parent.set(n, r);
		return r;
	};
	const nodes: number[] = [];
	const add = (n: number) => {
		if (parent.has(n)) return;
		parent.set(n, n);
		nodes.push(n);
	};
	for (const p of train.order) {
		for (const d of depsOf(p)) if (d !== p && !onTrain.has(d) && stateOf(d) === "MERGED") add(d);
		add(p);
	}
	for (const p of train.order) for (const d of depsOf(p)) if (parent.has(d) && d !== p) parent.set(find(d), find(p));
	const stacks = new Map<number, number[]>();
	for (const n of nodes) {
		const root = find(n);
		stacks.set(root, [...(stacks.get(root) ?? []), n]);
	}
	const parts = [...stacks.values()].map((s) => s.map(pr).join(" → "));
	for (const [p, held] of train.waiting) {
		parts.push(`${pr(p)} ⇠ ${held.map((d) => `${pr(d)} (${!onTrain.has(d) ? "not on the train" : inCycle.has(d) ? "in a cycle" : "waiting"})`).join(", ")}`);
	}
	for (const c of train.cycles) parts.push(`${c.map(pr).join(" ⇄ ")} (cycle)`);
	return parts.join(" · ");
}

/** The JSON the `order` subcommand prints after the chain line: the order, its holds, the chain, and the base-branch edges no body line records yet. */
export interface OrderReport {
	order: number[];
	waiting: Record<string, number[]>;
	cycles: number[][];
	chain: string;
	unrecorded: { pr: number; dependsOn: number }[];
}

/**
 * `order`'s report over the PRs gh answered (`views`, every train PR and every dependency found) and the open
 * PRs' heads: the train's order and chain, and each base-branch edge whose PR has no `Depends-on:` line for it.
 */
export function orderReport(prs: readonly number[], views: ReadonlyMap<number, StackPr & { state: string }>, heads: ReadonlyMap<string, number>): OrderReport {
	const depsOf = (n: number) => {
		const v = views.get(n);
		return v && prs.includes(n) ? prDeps(v, heads) : [];
	};
	const stateOf = (n: number) => views.get(n)?.state;
	const train = trainOrder(prs, depsOf, stateOf);
	const unrecorded: OrderReport["unrecorded"] = [];
	for (const n of prs) {
		const v = views.get(n);
		const base = v ? baseDep(v, heads) : null;
		if (v && base !== null && !bodyDeps(v.body).includes(base)) unrecorded.push({ pr: n, dependsOn: base });
	}
	return {
		order: train.order,
		waiting: Object.fromEntries([...train.waiting].map(([k, v]) => [String(k), v])),
		cycles: train.cycles,
		chain: chainLine(train, depsOf, stateOf),
		unrecorded,
	};
}
