// Offline word -> durable merge hold -> status reconciliation; no real GitHub or home state.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { checkReserved } from "../../gates/src/rows/r06-reserved";
import { reconcileLandFirstOff, type GhResult } from "../scripts/train-tick";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { apply, interpret } from "../src/input";
import { landFirstBody, landFirstInstructionBody, landFirstOffBody, landFirstOffPending, landFirstOn } from "../src/launch";
import { landFirstRows, REVOKE_ATTEMPTS } from "../src/merge-train";
import { fastPlanBody, testRequestedBody, testRunBody, withFullSuitePublication } from "../src/test-run";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { tempLedger, tmp } from "./helpers";

const REPO = "thewolff/product";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const FULL = "c".repeat(40);
function fixture() {
	const { ledger, path } = tempLedger();
	ensureStandingWorkload(ledger);
	const root = tmp("off-publication");
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "off transition fixture", stakes: "normal", mode: "autonomous" });
	const rows = () => ledger.entries(STANDING_WORKLOAD_ID);
	const instructions = () => ledger.instructions(STANDING_WORKLOAD_ID);
	const pending = () => landFirstOffPending(rows(), instructions(), REPO);
	const states = new Map([[HEAD, "success"], [OTHER, "success"], [FULL, "success"]]);
	let fail = true;
	const posts: string[] = [];
	const gh = (args: string[]): GhResult => {
		const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
		if (args[1]?.includes("/pulls?")) return ok([[...states].map(([sha], i) => ({ number: i + 1, head: { sha } }))]);
		if (args[1]?.endsWith("/statuses")) {
			const head = args[1]!.split("/").at(-2)!;
			return ok([[{ context: "as2/full-suite", state: states.get(head), description: "green" }]]);
		}
		if (args[1] === "-X") {
			const head = args[3]!.split("/").at(-1)!;
			posts.push(head);
			if (fail && head === OTHER) return { code: 1, stdout: "", stderr: "HTTP 502" };
			states.set(head, "failure");
			return ok({});
		}
		throw new Error(`unexpected fake gh ${args.join(" ")}`);
	};
	const result = (pr: number, head: string, scope: "fast" | "tree" | "full") => {
		const runId = `tr-off${pr}`;
		const entry = (body: string) => ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body });
		entry(testRequestedBody({ runId, pr, sha: head, slice: `sl-off${pr}`, by: "lane-off" }));
		entry(fastPlanBody(runId, scope === "tree" ? { ref: "wl/test", scope, g: HEAD, run: "tr-main" } : scope === "fast" ? { ref: "wl/test", scope, files: ["a.test.ts"], parse: [], macOnly: [] } : { ref: "wl/test", scope, reasons: ["schema"] }));
		entry(testRunBody({ runId, pr, sha: head, verdict: "green", reason: null, headAtEnd: head, base: null, mergeBase: null, full: null, solo: [], failures: [], runDir: null, preflight: "ok", scope: scope === "fast" ? "fast" : "full", host: scope === "fast" ? "linux" : "mac", main: false, exec: null }));
	};
	result(1, HEAD, "fast");
	result(2, OTHER, "tree"); // A tree carry intentionally has full scope in its result.
	result(3, FULL, "full");
	const logs: string[] = [];
	const reconcile = () => reconcileLandFirstOff({ ledger, gh }, REPO, root, () => REPO, (s) => logs.push(s));
	const held = () => checkReserved({ toolName: "bash", input: { command: `gh pr merge 1 -R ${REPO} --merge` } }, { role: "lane", cwd: root, env: { HOME: root } }, {
		standing: () => ({ entries: rows(), instructions: instructions() }), now: () => Date.parse(ledger.now()), remoteRepos: () => [REPO],
	});
	return { ledger, path, root, wl, gh, pending, states, posts, logs, reconcile, held, recover: () => { fail = false; } };
}

describe("land-first off reconciliation", () => {
	test("word atomically holds merges; a per-head failure stays pending; retry revokes tree but preserves full green", () => {
		const x = fixture();
		try {
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			expect(x.pending()).toHaveLength(1);
			expect(x.held()).not.toBeNull();
			expect(x.reconcile()).toBe(false);
			expect(x.states.get(HEAD)).toBe("failure");
			expect(x.states.get(OTHER)).toBe("success");
			expect(x.states.get(FULL)).toBe("success");
			expect(x.pending()).toHaveLength(1);
			expect(x.logs.join("\n")).toContain("HTTP 502");
			x.recover();
			expect(x.reconcile()).toBe(true);
			expect(x.pending()).toEqual([]);
			expect(x.states.get(OTHER)).toBe("failure");
			expect(x.posts.filter((s) => s === HEAD)).toHaveLength(1);
			expect(x.posts).not.toContain(FULL);
			expect(x.held()).toBeNull();
			expect(x.reconcile()).toBe(true);
		} finally { x.ledger.close(); }
	});

	for (const verdict of ["green", "red-main"] as const) test(`a genuine full Mac ${verdict} settled after off classification survives serialized revocation`, () => {
		const x = fixture();
		try {
			x.recover();
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			let settled = false;
			const complete = reconcileLandFirstOff({ ledger: x.ledger, gh: (args) => {
				if (!settled && args[1]?.endsWith(`/${HEAD}/statuses`)) {
					settled = true;
					withFullSuitePublication(x.root, REPO, () => {
						const runId = "tr-offfreshfull";
						const entry = (body: string) => x.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: x.wl, kind: "assumption", body });
						entry(testRequestedBody({ runId, pr: 1, sha: HEAD, slice: "sl-offfreshfull", by: "lane-off" }));
						entry(fastPlanBody(runId, { ref: "wl/test", scope: "full", reasons: ["schema"] }));
						entry(testRunBody({ runId, pr: 1, sha: HEAD, verdict, reason: null, headAtEnd: HEAD, base: null, mergeBase: null, full: null, solo: [], failures: [], runDir: null, preflight: "ok", scope: "full", host: "mac", main: false, exec: null,
							...(verdict === "red-main" ? { baseCompare: { sha: OTHER, parts: [{ part: "./a.test.ts", failing: ["a > x"], baseFailing: ["a > x"], baseError: null }] } } : {}),
						}));
						x.states.set(HEAD, "success");
					});
				}
				return x.gh(args);
			} }, REPO, x.root, () => REPO, (s) => x.logs.push(s));
			expect(settled).toBe(true);
			expect(complete).toBe(true);
			expect(x.pending()).toEqual([]);
			expect(x.posts).not.toContain(HEAD);
			expect(x.states.get(HEAD)).toBe("success");
			expect(x.states.get(OTHER)).toBe("failure"); // A copied full/Mac tree result is still revoked.
		} finally { x.ledger.close(); }
	});

	test("a newly discovered workload cannot be overwritten using another workload's stale fast authority", () => {
		const x = fixture();
		try {
			x.recover();
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			let settled = false;
			expect(reconcileLandFirstOff({ ledger: x.ledger, gh: (args) => {
				if (!settled && args[1]?.endsWith(`/${HEAD}/statuses`)) {
					settled = true;
					const wl = x.ledger.openWorkload({ by: SURFACE_BY, brief: "new full owner", stakes: "normal", mode: "autonomous" });
					const entry = (body: string) => x.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body });
					withFullSuitePublication(x.root, REPO, () => {
						entry(testRequestedBody({ runId: "tr-newowner", pr: 1, sha: HEAD, slice: "sl-newowner", by: "lane-off" }));
						entry(fastPlanBody("tr-newowner", { ref: "wl/test", scope: "full", reasons: ["schema"] }));
						entry(testRunBody({ runId: "tr-newowner", pr: 1, sha: HEAD, verdict: "green", reason: null, headAtEnd: HEAD, base: null, mergeBase: null, full: null, solo: [], failures: [], runDir: null, preflight: "ok", scope: "full", host: "mac", main: false, exec: null }));
						x.states.set(HEAD, "success");
					});
				}
				return x.gh(args);
			} }, REPO, x.root, () => REPO, (s) => x.logs.push(s))).toBe(false);
			expect(x.posts).not.toContain(HEAD);
			expect(x.states.get(HEAD)).toBe("success");
			expect(x.pending()).toHaveLength(1);
			expect(x.logs.join("\n")).toContain("repair its runner provenance");
			expect(x.reconcile()).toBe(true); // Next scheduled pass discovers its repository outside the lock.
			expect(x.states.get(HEAD)).toBe("success");
			expect(x.pending()).toEqual([]);
		} finally { x.ledger.close(); }
	});

	for (const source of ["tree", "fast", "full", "missing", "cycle"] as const) test(`off traces copied full/Mac decision-log authority to its ${source} source`, () => {
		const x = fixture();
		try {
			x.recover();
			x.states.delete(HEAD);
			x.states.delete(FULL);
			// Leave only PR #1 at OTHER, with no direct genuine full result at that head.
			const states = new Map([[OTHER, "success"]]);
			const entry = (body: string) => x.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: x.wl, kind: "assumption", body });
			if (source !== "missing") {
				entry(testRequestedBody({ runId: "tr-source", pr: 1, sha: FULL, slice: "sl-source", by: "lane-off" }));
				entry(fastPlanBody("tr-source", source === "tree" ? { ref: "wl/test", scope: "tree", g: HEAD, run: "tr-main" } : source === "fast" ? { ref: "wl/test", scope: "fast", files: ["a.test.ts"], parse: [], macOnly: [] } : { ref: "wl/test", scope: "full", reasons: ["schema"] }));
				entry(testRunBody({ runId: "tr-source", pr: 1, sha: FULL, verdict: "green", reason: source === "cycle" ? `carried from tr-copy at ${OTHER} (decision-log only)` : null, headAtEnd: FULL, base: null, mergeBase: null, full: null, solo: [], failures: [], runDir: null, preflight: "ok", scope: source === "fast" ? "fast" : "full", host: source === "fast" ? "linux" : "mac", main: false, exec: null }));
			}
			entry(testRequestedBody({ runId: "tr-copy", pr: 1, sha: OTHER, slice: "sl-copy", by: "lane-off" }));
			entry(testRunBody({ runId: "tr-copy", pr: 1, sha: OTHER, verdict: "green", reason: `carried from tr-source at ${FULL} (decision-log only)`, headAtEnd: OTHER, base: null, mergeBase: null, full: null, solo: [], failures: [], runDir: null, preflight: "ok", scope: "full", host: "mac", main: false, exec: null }));
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			const complete = reconcileLandFirstOff({ ledger: x.ledger, gh: (args) => {
				if (args[1]?.includes("/pulls?")) return { code: 0, stdout: JSON.stringify([[{ number: 1, head: { sha: OTHER } }]]), stderr: "" };
				if (args[1] === "-X") states.set(OTHER, "failure");
				return x.gh(args);
			} }, REPO, x.root, () => REPO, (s) => x.logs.push(s));
			expect(complete).toBe(source !== "missing" && source !== "cycle");
			expect(states.get(OTHER)).toBe(source === "tree" || source === "fast" ? "failure" : "success");
			expect(x.pending()).toHaveLength(complete ? 0 : 1);
		} finally { x.ledger.close(); }
	});

	test("a later on cannot erase pending off; completing an older request cannot clear a repeated off", () => {
		const x = fixture();
		try {
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			const [old] = x.pending();
			const on = x.ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: STANDING_WORKLOAD_ID, body: landFirstInstructionBody(REPO, true) });
			x.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstBody(REPO, true, on) });
			expect(landFirstOn(x.ledger.entries(STANDING_WORKLOAD_ID), x.ledger.instructions(STANDING_WORKLOAD_ID), REPO)).toBe(false);
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			x.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstOffBody(REPO, "complete", old!) });
			expect(x.pending()).toHaveLength(1);
			x.recover();
			expect(x.reconcile()).toBe(true);
			expect(landFirstOn(x.ledger.entries(STANDING_WORKLOAD_ID), x.ledger.instructions(STANDING_WORKLOAD_ID), REPO)).toBe(false);
		} finally { x.ledger.close(); }
	});

	test("forged completion cannot release the pending hold", () => {
		const x = fixture();
		try {
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			x.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstOffBody(REPO, "complete", x.pending()[0]!) });
			expect(x.pending()).toHaveLength(1);
			expect(x.held()).not.toBeNull();
		} finally { x.ledger.close(); }
	});

	test("publication mutex releases on failure and leaves the ledger writable during publication", () => {
		const x = fixture();
		try {
			expect(() => withFullSuitePublication(x.root, REPO, () => {
				apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
				throw new Error("publisher interrupted");
			})).toThrow("publisher interrupted");
			x.recover();
			expect(x.reconcile()).toBe(true);
			expect(withFullSuitePublication(x.root, REPO.toUpperCase(), () => 7)).toBe(7);
		} finally { x.ledger.close(); }
	});

	test("an in-flight pre-off publication finishes before revocation and durable completed-off", async () => {
		const x = fixture();
		const on = x.ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: STANDING_WORKLOAD_ID, body: landFirstInstructionBody(REPO, true) });
		x.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstBody(REPO, true, on) });
		const events = join(x.root, "publication-events.log");
		writeFileSync(events, "");
		const worker = new Worker(new URL("./fixtures/full-suite-publication-worker.ts", import.meta.url).href);
		const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
		try {
			await new Promise<void>((resolve, reject) => {
				worker.onerror = (event) => reject(new Error(event.message));
				worker.onmessage = (event) => {
					if (event.data === "locked") resolve();
					else if (event.data?.error) reject(new Error(event.data.error));
				};
				worker.postMessage({ root: x.root, repo: REPO, ledgerPath: x.path, signal, events });
			});
			// The publisher already read on and holds the mutex. The word still commits without waiting on it.
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			expect(x.pending()).toHaveLength(1);
			expect(x.held()).not.toBeNull();
			x.recover();
			Atomics.store(new Int32Array(signal), 0, 1);
			Atomics.notify(new Int32Array(signal), 0);
			const complete = reconcileLandFirstOff({ ledger: x.ledger, gh: (args) => {
				if (args[1]?.includes("/pulls?")) appendFileSync(events, "list\n");
				// Before the pre-off publisher finishes this status is still pending. A scan before
				// the initial short activation barrier would miss the success it is about to publish.
				if (args[1]?.endsWith(`/${HEAD}/statuses`) && !readFileSync(events, "utf8").includes("publisher-success")) {
					return { code: 0, stdout: JSON.stringify([[{ context: "as2/full-suite", state: "pending", description: "running" }]]), stderr: "" };
				}
				if (args[1] === "-X") appendFileSync(events, "revoke\n");
				return x.gh(args);
			} }, REPO, x.root, () => REPO, (s) => x.logs.push(s));
			expect(complete).toBe(true);
			appendFileSync(events, "completed-off\n");
			expect(readFileSync(events, "utf8").trim().split("\n")).toEqual(["publisher-read-on", "publisher-success", "list", "revoke", "revoke", "completed-off"]);
			expect(x.states.get(HEAD)).toBe("failure");
			expect(x.pending()).toEqual([]);
		} finally {
			worker.terminate();
			x.ledger.close();
		}
	}, 10_000);

	test("the newest on word takes effect only after pending off revocation completes", () => {
		const x = fixture();
		try {
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			const id = x.ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: STANDING_WORKLOAD_ID, body: landFirstInstructionBody(REPO, true) });
			x.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstBody(REPO, true, id) });
			expect(landFirstOn(x.ledger.entries(STANDING_WORKLOAD_ID), x.ledger.instructions(STANDING_WORKLOAD_ID), REPO)).toBe(false);
			x.recover();
			expect(x.reconcile()).toBe(true);
			expect(landFirstOn(x.ledger.entries(STANDING_WORKLOAD_ID), x.ledger.instructions(STANDING_WORKLOAD_ID), REPO)).toBe(true);
			expect(x.states.get(HEAD)).toBe("failure");
			expect(x.states.get(OTHER)).toBe("failure");
		} finally { x.ledger.close(); }
	});

	test("pending off and its latest failed head survive a surface restart, then disappear on completion", () => {
		const x = fixture();
		apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
		const [instruction] = x.pending();
		expect(x.reconcile()).toBe(false);
		const pendingRow = x.ledger.entries(STANDING_WORKLOAD_ID).find((e) => e.body === landFirstOffBody(REPO, "pending", instruction!))!;
		x.ledger.close();
		const restarted = Ledger.open(x.path, { backupOnOpen: false, backup: false });
		try {
			const pendingLine = errorLines(restarted).find((e) => e.state?.startsWith("off-pending "));
			expect(pendingLine).toMatchObject({ kind: "train", workloadId: STANDING_WORKLOAD_ID, rowId: pendingRow.id });
			expect(pendingLine?.state).toContain(instruction!);
			expect(pendingLine?.line).toContain(OTHER);
			expect(pendingLine?.line).toContain("HTTP 502");
			x.recover();
			expect(reconcileLandFirstOff({ ledger: restarted, gh: x.gh }, REPO, x.root, () => REPO, (s) => x.logs.push(s))).toBe(true);
			expect(errorLines(restarted).filter((e) => e.state?.startsWith("off-pending "))).toEqual([]);
		} finally { restarted.close(); }
	});

	test("a listing failure stays visible without pretending off completed or touching full success", () => {
		const x = fixture();
		try {
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			const complete = reconcileLandFirstOff({ ledger: x.ledger, gh: () => ({ code: 1, stdout: "", stderr: "listing unavailable" }) }, REPO, x.root, () => REPO, (s) => x.logs.push(s));
			expect(complete).toBe(false);
			expect(x.pending()).toHaveLength(1);
			const line = errorLines(x.ledger).find((e) => e.state?.startsWith("off-pending "));
			expect(line?.kind).toBe("train");
			expect(line?.line).toContain("listing unavailable");
			expect(x.posts).toEqual([]);
			expect(x.states.get(FULL)).toBe("success");
		} finally { x.ledger.close(); }
	});

	test("listing, status reads and repository discovery do not hold the publication mutex; each POST does and receives its remaining budget", () => {
		const x = fixture();
		try {
			x.recover();
			withFullSuitePublication(x.root, REPO, () => {});
			const path = join(x.root, readdirSync(x.root).find((name) => name.includes(".publication-"))!);
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			let reads = 0;
			let classifications = 0;
			let posts = 0;
			const probe = (held: boolean) => {
				const db = new Database(path);
				try {
					db.exec("PRAGMA busy_timeout = 1");
					if (held) expect(() => db.exec("BEGIN IMMEDIATE")).toThrow();
					else db.exec("BEGIN IMMEDIATE");
				} finally { db.close(); }
			};
			const complete = reconcileLandFirstOff({ ledger: x.ledger, gh: (args, remainingMs) => {
				const post = args[1] === "-X";
				probe(post);
				if (post) {
					posts++;
					expect(remainingMs).toBeGreaterThan(0);
					expect(remainingMs).toBeLessThanOrEqual(30_000);
				} else {
					reads++;
					expect(remainingMs).toBeUndefined();
				}
				return x.gh(args);
			} }, REPO, x.root, () => {
				probe(false);
				classifications++;
				return REPO;
			}, (s) => x.logs.push(s));
			expect(complete).toBe(true);
			expect(reads).toBe(4);
			expect(classifications).toBeGreaterThan(0);
			expect(posts).toBe(2);
			expect(x.pending()).toEqual([]);
		} finally { x.ledger.close(); }
	});

	test("unknown provenance stays held with its named repair, never becomes a landing revocation failure", () => {
		const x = fixture();
		try {
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			expect(reconcileLandFirstOff({ ledger: x.ledger, gh: x.gh }, REPO, x.root, () => null, (s) => x.logs.push(s))).toBe(false);
			expect(x.posts).toEqual([]);
			expect(x.pending()).toHaveLength(1);
			expect(x.held()).not.toBeNull();
			expect(errorLines(x.ledger).find((e) => e.state?.startsWith("off-pending "))?.line).toContain("repair its runner provenance");
			expect(landFirstRows(x.ledger.entries(STANDING_WORKLOAD_ID), REPO).filter((r) => r.event === "revoke-failed")).toEqual([]);
		} finally { x.ledger.close(); }
	});

	test("a repeated off arriving during the bulk read cannot be completed by the older pass", () => {
		const x = fixture();
		try {
			x.recover();
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			const [old] = x.pending();
			let added = false;
			expect(reconcileLandFirstOff({ ledger: x.ledger, gh: (args) => {
				if (!added && args[1]?.includes("/pulls?")) {
					added = true;
					apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
				}
				return x.gh(args);
			} }, REPO, x.root, () => REPO, (s) => x.logs.push(s))).toBe(false);
			expect(x.pending()).toHaveLength(1);
			expect(x.pending()).not.toContain(old);
			expect(x.held()).not.toBeNull();
			expect(x.reconcile()).toBe(true);
			expect(x.held()).toBeNull();
		} finally { x.ledger.close(); }
	});

	test("off retries exhaust once per instruction, dedupe repeated failures, survive restart, and require repair plus a new off word", () => {
		const x = fixture();
		try {
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			for (let n = 0; n < REVOKE_ATTEMPTS; n++) expect(x.reconcile()).toBe(false);
			const receipts = () => x.ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.created_by === MERGE_TRAIN_BY);
			expect(receipts().filter((e) => e.body.startsWith("off-reconcile-attempt:"))).toHaveLength(REVOKE_ATTEMPTS);
			expect(receipts().filter((e) => e.body.includes("HTTP 502"))).toHaveLength(1);
			expect(receipts().filter((e) => e.body.includes("OffReconciliationExhausted"))).toHaveLength(1);
			expect(x.posts.filter((head) => head === OTHER)).toHaveLength(REVOKE_ATTEMPTS);
			x.recover();
			const before = receipts().length;
			const restarted = Ledger.open(x.path, { backupOnOpen: false, backup: false });
			try {
				let calls = 0;
				expect(reconcileLandFirstOff({ ledger: restarted, gh: (args) => { calls++; return x.gh(args); } }, REPO, x.root, () => REPO, (s) => x.logs.push(s))).toBe(false);
				expect(calls).toBe(0);
			} finally { restarted.close(); }
			expect(x.reconcile()).toBe(false);
			expect(receipts()).toHaveLength(before);
			expect(x.held()).not.toBeNull();
			const line = errorLines(x.ledger).find((e) => e.state?.startsWith("off-pending "))?.line;
			expect(line).toContain("OffReconciliationExhausted");
			expect(line).toContain(`land-first ${REPO} off again`);
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			expect(x.pending()).toHaveLength(2);
			expect(x.reconcile()).toBe(true);
			expect(x.pending()).toEqual([]);
			expect(x.held()).toBeNull();
			expect(x.posts.filter((head) => head === OTHER)).toHaveLength(REVOKE_ATTEMPTS + 1);
		} finally { x.ledger.close(); }
	});

	test("bulk listing failures share the same bounded block and exact repeated receipts are not appended", () => {
		const x = fixture();
		try {
			apply(x.ledger, interpret(x.ledger, `land-first ${REPO} off`)!);
			let calls = 0;
			const reconcile = () => reconcileLandFirstOff({ ledger: x.ledger, gh: () => {
				calls++;
				return { code: 1, stdout: "", stderr: "listing unavailable" };
			} }, REPO, x.root, () => REPO, (s) => x.logs.push(s));
			for (let n = 0; n < REVOKE_ATTEMPTS + 2; n++) expect(reconcile()).toBe(false);
			expect(calls).toBe(REVOKE_ATTEMPTS);
			expect(x.ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.includes("listing unavailable"))).toHaveLength(1);
			expect(x.ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.includes("OffReconciliationExhausted"))).toHaveLength(1);
			expect(x.pending()).toHaveLength(1);
			expect(x.held()).not.toBeNull();
		} finally { x.ledger.close(); }
	});

	test("legacy off words stay off; untrusted or instruction-mismatched pending markers create no synthetic hold", () => {
		const x = fixture();
		try {
			const id = x.ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: STANDING_WORKLOAD_ID, body: landFirstInstructionBody(REPO, false) });
			x.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstBody(REPO, false, id) });
			x.ledger.recordEntry({ by: "lane-forged", workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstOffBody(REPO, "pending", id) });
			x.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstOffBody("thewolff/another", "pending", id) });
			expect(x.pending()).toEqual([]);
			expect(x.held()).toBeNull();
			expect(x.reconcile()).toBe(true);
			expect(x.posts).toEqual([]);
			expect(landFirstOn(x.ledger.entries(STANDING_WORKLOAD_ID), x.ledger.instructions(STANDING_WORKLOAD_ID), REPO)).toBe(false);
		} finally { x.ledger.close(); }
	});
});
