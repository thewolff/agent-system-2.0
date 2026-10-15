// The PR set a workload's issue renders from (PLAN wl-mv66ylim0gahog § 2 prs.ts), the close
// check's own definition (surface/src/close-entry.ts gatherCloseFacts): every PR of every bound
// branch (`wl/<id>` plus each `push-dest:` a holder wrote), then each PR a `test-requested:` names
// that no branch list showed, by number. Unlike the close check it pages to 1000 per branch, and a
// branch list that comes back full, or any call that fails, makes the set unknown: the push renders
// nothing for that link. Also the per-tick scan of every open PR in the repo (§ 5).
import type { Ledger } from "../../../ledger/src/index";
import { holdersOf } from "../launch";
import { boundBranches, testRuns } from "../test-run";
import type { GitHub } from "./github";
import type { PrFact, PrState } from "./render";

/** A branch list this long may be cut short: the set is unknown (§ 2). */
export const BRANCH_LIST_LIMIT = 1000;
/** An open-PR scan this long may be cut short: nothing is marked from it (§ 5). */
export const SCAN_LIMIT = 200;

/** Where a workload's PRs come from, both computed locally from the ledger. */
export interface PrSources {
	branches: string[];
	/** PR numbers its `test-requested:` entries name, oldest first, once each. */
	requested: number[];
}

export function prSources(ledger: Ledger, workloadId: string): PrSources {
	const entries = ledger.entries(workloadId, "assumption");
	const w = ledger.workload(workloadId);
	const branches = boundBranches(workloadId, entries, holdersOf(entries, w?.holder ?? null, ledger.holders(workloadId)));
	return { branches, requested: [...new Set(testRuns(entries).map((r) => r.request.pr))] };
}

export type PrSet = { known: true; prs: PrFact[] } | { known: false; why: string };

const STATES: readonly string[] = ["OPEN", "MERGED", "CLOSED"];

/** A `gh pr list` / `gh pr view` record with number, state, url and base, or null. */
function prFactOf(x: unknown): PrFact | null {
	if (x === null || typeof x !== "object") return null;
	if (!("number" in x) || !("state" in x) || !("url" in x) || !("baseRefName" in x)) return null;
	const { number, state, url, baseRefName } = x;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return null;
	if (typeof state !== "string" || !STATES.includes(state) || typeof url !== "string" || url === "" || typeof baseRefName !== "string") return null;
	return { number, state: state as PrState, url, base: baseRefName };
}

/** The workload's PR set through the counted caller; unknown on a full branch list or any failure. Budget and claim stops propagate. */
export async function readPrSet(gh: GitHub, repo: string, sources: PrSources): Promise<PrSet> {
	const byNumber = new Map<number, PrFact>();
	for (const b of sources.branches) {
		const r = await gh.json(["pr", "list", "-R", repo, "--head", b, "--state", "all", "-L", String(BRANCH_LIST_LIMIT), "--json", "number,state,url,baseRefName"]);
		if (!r.ok) return { known: false, why: r.error };
		if (!Array.isArray(r.value)) return { known: false, why: `gh pr list --head ${b} printed no PR list` };
		if (r.value.length >= BRANCH_LIST_LIMIT) return { known: false, why: `gh pr list --head ${b} returned ${r.value.length} rows, the limit` };
		for (const x of r.value) {
			const pr = prFactOf(x);
			if (pr === null) return { known: false, why: `gh pr list --head ${b} printed a PR without number, state, url and base` };
			if (!byNumber.has(pr.number)) byNumber.set(pr.number, pr);
		}
	}
	for (const n of sources.requested) {
		if (byNumber.has(n)) continue;
		const r = await gh.json(["pr", "view", String(n), "-R", repo, "--json", "number,state,url,baseRefName"]);
		if (!r.ok) return { known: false, why: r.error };
		const pr = prFactOf(r.value);
		if (pr === null || pr.number !== n) return { known: false, why: `gh pr view ${n} printed no PR with number, state, url and base` };
		byNumber.set(n, pr);
	}
	return { known: true, prs: [...byNumber.values()].sort((a, b) => a.number - b.number) };
}

/** One open PR as the scan reads it. */
export interface OpenPr {
	number: number;
	url: string;
	head: string;
	base: string;
	crossRepository: boolean;
	body: string;
}

export type Scan = { ok: true; truncated: boolean; prs: OpenPr[] } | { ok: false; error: string };

/** Every open PR in the repo, one counted call (§ 5); `truncated` when SCAN_LIMIT rows came back. */
export async function scanOpenPrs(gh: GitHub, repo: string): Promise<Scan> {
	const r = await gh.json(["pr", "list", "-R", repo, "--state", "open", "-L", String(SCAN_LIMIT), "--json", "number,url,headRefName,baseRefName,isCrossRepository,body"]);
	if (!r.ok) return r;
	if (!Array.isArray(r.value)) return { ok: false, error: "gh pr list --state open printed no PR list" };
	const prs: OpenPr[] = [];
	for (const x of r.value) {
		if (x === null || typeof x !== "object" || !("number" in x) || !("url" in x) || !("headRefName" in x) || !("baseRefName" in x)) continue;
		const { number, url, headRefName, baseRefName } = x;
		if (typeof number !== "number" || typeof url !== "string" || typeof headRefName !== "string" || typeof baseRefName !== "string") continue;
		const cross = "isCrossRepository" in x ? x.isCrossRepository !== false : true;
		const body = "body" in x && typeof x.body === "string" ? x.body : "";
		prs.push({ number, url, head: headRefName, base: baseRefName, crossRepository: cross, body });
	}
	return { ok: true, truncated: r.value.length >= SCAN_LIMIT, prs };
}
