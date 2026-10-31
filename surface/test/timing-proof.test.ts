import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { procArgv, snapshot } from "../src/stuck-detect";
import {
	admitProof, executableTree, finishProofIteration, inspectProof, installedRuntimeHashes, LOAD_EXIT, LOAD_LEASE_MS, type LoadKind, type LoadReceipt, nextProofIteration,
	openProofSchema, parseProofManifest, type ProofInputs, type ProofManifest, proofEvidence, proofIterations, recoverHistoricLoad, recoverProof, runtimeIdentity, startHistoricLoad,
} from "../src/timing-proof";
import { tmp, until } from "./helpers";

const sha = "a".repeat(40);
const fixture = () => ({ version: 1, kind: "smoke", workload: "wl-proof", slice: "sl-proof", repo: "owner/repo", baseSha: sha, candidateSha: "b".repeat(40), mode: "isolated", productionBudget: false, load: "none", runs: { base: 0, candidate: 2 }, files: [{ path: "a.test.ts", cases: [{ base: ["old"], candidate: ["new", "split"], budgetMs: 5000, timingUnderTest: false }], hooks: { base: { setup: [], cleanup: [] }, candidate: { setup: [], cleanup: [] } }, skipped: { base: [], candidate: [] } }] });
const xml = (names: string[], skipped = false) => `<testsuites tests="${names.length}" failures="0" skipped="${skipped ? names.length : 0}"><testsuite name="a.test.ts">${names.map((name) => `<testcase name="${name}" time="0.001">${skipped ? "<skipped/>" : ""}</testcase>`).join("")}</testsuite></testsuites>`;
/** Executable inputs as submission records them: `tree` names the candidate's executable tree, `exec` the installed executor's hash. */
const inputs = (m: ProofManifest, o: { tree?: string; exec?: string } = {}): ProofInputs => ({
	base: { sha: m.baseSha, tree: "1".repeat(64) }, candidate: { sha: m.candidateSha, tree: (o.tree ?? "2").repeat(64) },
	runtime: runtimeIdentity(m.mode, { exec: (o.exec ?? "3").repeat(64), bun: "4".repeat(64) }),
});
const admit = (db: Database, id: string, raw: unknown, at: number, o: { tree?: string; exec?: string } = {}) => {
	const m = parseProofManifest(raw);
	admitProof(db, id, m, inputs(m, o), at);
};
/** One `git ls-tree -r -z --full-tree` entry. */
const entry = (path: string, blob: string, mode = "100644") => `${mode} blob ${blob.repeat(40)}\t${path}\0`;

describe("timing proof admission", () => {
	test("fixes counts and rejects arbitrary env, commands, paths and cache claims", () => {
		for (const change of [{ env: { SECRET: "x" } }, { command: "true" }, { runs: { base: 0, candidate: 3 } }, { kind: "cached" }]) expect(() => parseProofManifest({ ...fixture(), ...change })).toThrow();
		const f = fixture(); f.files[0]!.path = "../a.test.ts";
		expect(() => parseProofManifest(f)).toThrow();
	});
	test("requires exactly five base and twenty candidate observations per file", () => {
		const f = fixture();
		const m = parseProofManifest({ ...f, kind: "file-series", load: "historic", runs: { base: 5, candidate: 20 }, files: [{ ...f.files[0], hooks: { base: { setup: ["ready"], cleanup: ["reaped"] }, candidate: { setup: ["ready"], cleanup: ["reaped"] } } }] });
		expect(proofIterations(m)).toHaveLength(25);
		expect(proofIterations(m).slice(0, 5).every((i) => i.phase === "base")).toBe(true);
		expect(() => parseProofManifest({ ...m, runs: { base: 4, candidate: 20 } })).toThrow();
	});
	test("full-series has exactly five fresh full parts, never a baseline", () => {
		const m = parseProofManifest({ ...fixture(), kind: "full-series", runs: { base: 0, candidate: 5 } });
		expect(proofIterations(m).map((i) => i.file)).toEqual(Array(5).fill(null));
		expect(() => parseProofManifest({ ...m, runs: { base: 5, candidate: 5 } })).toThrow();
	});
});

describe("executed-case and hook evidence", () => {
	test("uses base labels on base and candidate split identities on candidate", () => {
		const m = parseProofManifest(fixture());
		expect(proofEvidence(m, { phase: "base", file: "a.test.ts" }, xml(["old"]), "").cases.map((c) => c.name)).toEqual(["old"]);
		expect(proofEvidence(m, { phase: "candidate", file: "a.test.ts" }, xml(["new", "split"]), "").cases).toHaveLength(2);
		expect(() => proofEvidence(m, { phase: "candidate", file: "a.test.ts" }, xml(["new"]), "")).toThrow("split");
	});
	test("rejects skipped, duplicated, malformed, missing cleanup and over-budget cases", () => {
		const m = parseProofManifest(fixture()); const i = { phase: "candidate" as const, file: "a.test.ts" };
		for (const report of [xml(["new", "split"], true), xml(["new", "new", "split"]), "<testsuites/>", xml(["new", "split"]).replaceAll('time="0.001"', 'time="3"')]) expect(() => proofEvidence(m, i, report, "")).toThrow();
		m.files[0]!.hooks.candidate.cleanup.push("reaped");
		expect(() => proofEvidence(m, i, xml(["new", "split"]), "")).toThrow("cleanup");
	});
});

describe("durable stop-on-red and interruption", () => {
	function world() { const db = new Database(":memory:"); openProofSchema(db); admit(db, "tp-one", fixture(), 1); return db; }
	function failed() {
		const db = world();
		const i = nextProofIteration(db, "tp-one", "tr-one", 2)!;
		finishProofIteration(db, "tp-one", i.index, { state: "failed", error: "assertion red", artifacts: "/evidence/tr-one" });
		return db;
	}
	test("red is terminal and cannot be resumed or admitted again", () => {
		const db = world(); try {
			const i = nextProofIteration(db, "tp-one", "tr-one", 2)!;
			finishProofIteration(db, "tp-one", i.index, { state: "failed", error: "assertion red", artifacts: "/evidence/tr-one" });
			expect(inspectProof(db, "tp-one").state).toBe("failed");
			expect(nextProofIteration(db, "tp-one", "tr-two", 3)).toBeNull();
			expect(() => admit(db, "tp-two", fixture(), 4)).toThrow("same");
		} finally { db.close(); }
	});
	test("a diagnosis, budget change or different workload cannot replay the same failed candidate", () => {
		const db = world(); try {
			const i = nextProofIteration(db, "tp-one", "tr-one", 2)!;
			finishProofIteration(db, "tp-one", i.index, { state: "failed", error: "assertion red", artifacts: "/evidence/tr-one" });
			const retry = fixture();
			retry.files[0]!.cases[0]!.budgetMs = 10000;
			expect(() => admit(db, "tp-budget", { ...retry, diagnosis: "budget was raised" }, 4, { tree: "5" })).toThrow("candidate");
			expect(() => admit(db, "tp-workload", { ...retry, workload: "wl-other", diagnosis: "different owner" }, 4, { tree: "5" })).toThrow("candidate");
			admit(db, "tp-fixed", { ...retry, candidateSha: "c".repeat(40), diagnosis: "changed candidate after the recorded failure" }, 5, { tree: "5" });
			expect(inspectProof(db, "tp-fixed").state).toBe("admitted");
		} finally { db.close(); }
	});
	// TOOLS-REVIEW-r1 F4: a new candidate SHA is not a new input.
	test("an equivalent failed tree is refused under any new SHA, budget, workload or diagnosis; a changed input with a diagnosis is admitted", () => {
		const db = failed(); try {
			const empty = { ...fixture(), candidateSha: "d".repeat(40), diagnosis: "an empty commit after the red" };
			expect(() => admit(db, "tp-empty", empty, 4)).toThrow("executes the same inputs as failed tp-one");
			const churn = { ...fixture(), candidateSha: "e".repeat(40), workload: "wl-other", diagnosis: "infrastructure only: the host was busy" };
			churn.files[0]!.cases[0]!.budgetMs = 10000;
			expect(() => admit(db, "tp-churn", churn, 4)).toThrow("executes the same inputs as failed tp-one");
			expect(() => admit(db, "tp-nodiag", { ...fixture(), candidateSha: "f".repeat(40) }, 4, { tree: "6" })).toThrow("requires a diagnosis");
			expect(db.query("SELECT id FROM timing_proofs").all()).toEqual([{ id: "tp-one" }]);
			admit(db, "tp-code", { ...fixture(), candidateSha: "f".repeat(40), diagnosis: "the code under proof changed" }, 5, { tree: "6" });
			admit(db, "tp-runtime", { ...fixture(), candidateSha: "9".repeat(40), diagnosis: "the installed executor changed" }, 6, { exec: "7" });
			expect(inspectProof(db, "tp-runtime").inputs.runtime.executor.exec).toBe("7".repeat(64));
		} finally { db.close(); }
	});
	// TOOLS-REVIEW r2 R4: the runtime identity covers the measured policy, never the non-executing refresh helper. TOOLS-REVIEW r3
	// minor 1: the OMP pin is in the identity of an installed-OMP proof only; an isolated proof never reads it.
	test("the runtime identity hashes resources.json, and installed-omp.json only in installed-OMP mode, never refresh: unchanged inputs are refused", () => {
		const libexec = tmp("proof-runtime");
		const install = (files: Record<string, string>) => { for (const [name, body] of Object.entries(files)) writeFileSync(join(libexec, name), body); };
		install({ exec: "exec v1", bun: "bun v1", "test-exec.js": "bundle v1", "resources.json": "policy v1", refresh: "helper v1" });
		const at = (m: ProofManifest, tree: string): ProofInputs => ({ base: { sha: m.baseSha, tree: "1".repeat(64) }, candidate: { sha: m.candidateSha, tree: tree.repeat(64) },
			runtime: runtimeIdentity(m.mode, installedRuntimeHashes(libexec, m.mode)) });
		const db = new Database(":memory:"); try {
			openProofSchema(db);
			const first = parseProofManifest(fixture());
			expect(Object.keys(at(first, "2").runtime.executor)).toEqual(["bun", "exec", "resources.json", "test-exec.js"]);
			admitProof(db, "tp-red", first, at(first, "2"), 1);
			finishProofIteration(db, "tp-red", nextProofIteration(db, "tp-red", "tr-red", 2)!.index, { state: "failed", error: "assertion red", artifacts: "/evidence/tr-red" });
			const again = (sha: string, diagnosis: string) => parseProofManifest({ ...fixture(), candidateSha: sha.repeat(40), diagnosis });
			// Unchanged installed files, and a refresh helper that changed alone: the same inputs, refused.
			const same = again("d", "infrastructure only");
			expect(() => admitProof(db, "tp-same", same, at(same, "2"), 3)).toThrow("executes the same inputs as failed tp-red");
			install({ refresh: "helper v2" });
			expect(() => admitProof(db, "tp-helper", same, at(same, "2"), 3)).toThrow("installed runtime (exec, bun, test-exec.js, resources.json) the failure");
			// Only resources.json changed: a different runtime, admitted with its diagnosis.
			install({ "resources.json": "policy v2" });
			const policy = again("e", "the measured resource policy changed");
			admitProof(db, "tp-policy", policy, at(policy, "2"), 4);
			expect(inspectProof(db, "tp-policy").inputs.runtime.executor["resources.json"]).not.toBe(inspectProof(db, "tp-red").inputs.runtime.executor["resources.json"]);
			finishProofIteration(db, "tp-policy", nextProofIteration(db, "tp-policy", "tr-policy", 5)!.index, { state: "failed", error: "assertion red", artifacts: "/evidence/tr-policy" });
			// Isolated: installing an OMP pin, or re-pinning it, is no changed input, so the equivalent failed series is still refused.
			const unpinned = at(policy, "2").runtime;
			install({ "installed-omp.json": "pin v1" });
			expect(at(policy, "2").runtime).toEqual(unpinned);
			install({ "installed-omp.json": "pin v2" });
			const repin = again("7", "infrastructure only: OMP was re-pinned");
			expect(() => admitProof(db, "tp-repin", repin, at(repin, "2"), 6)).toThrow("executes the same inputs as failed tp-policy");
			// Installed-OMP: the pin is hashed, an unchanged pin is refused, and a re-pin is a new identity admitted with its diagnosis.
			const omp = (sha: string, diagnosis: string) => parseProofManifest({ ...fixture(), mode: "installed-OMP", candidateSha: sha.repeat(40), diagnosis });
			const ompRed = omp("8", "the first installed-OMP run");
			expect(Object.keys(at(ompRed, "2").runtime.executor)).toEqual(["bun", "exec", "installed-omp.json", "resources.json", "test-exec.js"]);
			admitProof(db, "tp-omp", ompRed, at(ompRed, "2"), 7);
			finishProofIteration(db, "tp-omp", nextProofIteration(db, "tp-omp", "tr-omp", 8)!.index, { state: "failed", error: "assertion red", artifacts: "/evidence/tr-omp" });
			const ompSame = omp("9", "infrastructure only");
			expect(() => admitProof(db, "tp-omp-same", ompSame, at(ompSame, "2"), 9)).toThrow("installed runtime (exec, bun, test-exec.js, resources.json, installed-omp.json) the failure");
			install({ "installed-omp.json": "pin v3" });
			const ompRepin = omp("a", "the pinned OMP runtime changed");
			admitProof(db, "tp-omp-repin", ompRepin, at(ompRepin, "2"), 10);
			expect(inspectProof(db, "tp-omp-repin").inputs.runtime.identity).not.toBe(inspectProof(db, "tp-omp").inputs.runtime.identity);
		} finally { db.close(); }
	});
	test("a missing required runtime file, or an installed-OMP proof without its pin, refuses submission naming every file", () => {
		const libexec = tmp("proof-runtime-missing");
		writeFileSync(join(libexec, "exec"), "exec");
		writeFileSync(join(libexec, "bun"), "bun");
		expect(() => installedRuntimeHashes(libexec, "isolated")).toThrow(`installed ${join(libexec, "test-exec.js")} is missing; installed ${join(libexec, "resources.json")} is missing; repair the install`);
		writeFileSync(join(libexec, "test-exec.js"), "bundle");
		writeFileSync(join(libexec, "resources.json"), "policy");
		expect(Object.keys(installedRuntimeHashes(libexec, "isolated"))).toEqual(["exec", "bun", "test-exec.js", "resources.json"]);
		expect(() => installedRuntimeHashes(libexec, "installed-OMP")).toThrow(`installed ${join(libexec, "installed-omp.json")} is missing (an installed-OMP proof runs only on a pinned runtime)`);
	});
	test("admission refuses inputs that do not describe the manifest's commits and mode", () => {
		const db = new Database(":memory:"); try {
			openProofSchema(db);
			const m = parseProofManifest(fixture());
			expect(() => admitProof(db, "tp-wrong", m, { ...inputs(m), candidate: { sha: "c".repeat(40), tree: "2".repeat(64) } }, 1)).toThrow("not the manifest's");
			expect(() => admitProof(db, "tp-mode", m, { ...inputs(m), runtime: runtimeIdentity("installed-OMP", { exec: "3".repeat(64) }) }, 1)).toThrow("not the manifest's");
			expect(() => admitProof(db, "tp-bad", m, { ...inputs(m), candidate: { sha: m.candidateSha, tree: "not a hash" } }, 1)).toThrow("malformed");
			expect(() => runtimeIdentity("isolated", {})).toThrow("sha-256");
			expect(db.query("SELECT id FROM timing_proofs").all()).toHaveLength(0);
		} finally { db.close(); }
	});
	test("the executable tree ignores commit identity, order and decision-log churn, never code, dependencies, docs or modes", () => {
		const base = entry("a.test.ts", "1") + entry("bun.lock", "2") + entry("docs/x.md", "3");
		const id = executableTree(base);
		expect(executableTree(entry("docs/x.md", "3") + entry("a.test.ts", "1") + entry("bun.lock", "2"))).toBe(id);
		expect(executableTree(base + entry(".ai/decision-log/2026-10-31--0000--x--y.md", "4"))).toBe(id);
		for (const changed of [entry("a.test.ts", "5") + entry("bun.lock", "2") + entry("docs/x.md", "3"), entry("a.test.ts", "1") + entry("bun.lock", "6") + entry("docs/x.md", "3"),
			entry("a.test.ts", "1") + entry("bun.lock", "2") + entry("docs/x.md", "7"), entry("a.test.ts", "1", "100755") + entry("bun.lock", "2") + entry("docs/x.md", "3")]) {
			expect(executableTree(changed)).not.toBe(id);
		}
		expect(() => executableTree("garbage\0")).toThrow("malformed ls-tree entry");
		expect(() => executableTree(entry(".ai/decision-log/a.md", "1"))).toThrow("no executable input");
	});
	test("a started interrupted iteration is retained and never replayed", () => {
		const db = world(); try {
			nextProofIteration(db, "tp-one", "tr-one", 2);
			recoverProof(db, "tp-one", () => false);
			const p = inspectProof(db, "tp-one");
			expect(p.state).toBe("failed"); expect(p.iterations[0]!.runId).toBe("tr-one"); expect(p.iterations[0]!.state).toBe("interrupted");
			expect(nextProofIteration(db, "tp-one", "tr-two", 3)).toBeNull();
		} finally { db.close(); }
	});
	test("two smoke iterations complete only after two distinct durable receipts", () => {
		const db = world(); try {
			for (const id of ["tr-one", "tr-two"]) {
				const i = nextProofIteration(db, "tp-one", id, 2)!;
				finishProofIteration(db, "tp-one", i.index, { state: "complete", error: null, artifacts: `/evidence/${id}` });
			}
			expect(inspectProof(db, "tp-one").state).toBe("complete");
			expect(inspectProof(db, "tp-one").iterations.map((i) => i.runId)).toEqual(["tr-one", "tr-two"]);
		} finally { db.close(); }
	});
});

describe("historic load: bounded without its owner, recovered by identity (TOOLS-REVIEW-r1 F1)", () => {
	const SRC = join(import.meta.dir, "..", "src", "timing-proof.ts");
	const live = (pids: number[]): number[] => {
		const s = snapshot(process.getuid!());
		if (s.kind !== "ok") throw new Error(`process list of this uid unavailable: ${s.why}`);
		return pids.filter((pid) => s.procs.some((p) => p.pid === pid && !p.zombie));
	};
	const receiptOf = (dir: string): LoadReceipt => JSON.parse(readFileSync(join(dir, "load.json"), "utf8")) as LoadReceipt;
	const far = () => Date.now() + 600_000;
	async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
		const reader = stream.getReader();
		let text = "";
		while (!text.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`stream ended before a line: ${JSON.stringify(text)}`);
			text += new TextDecoder().decode(chunk.value);
		}
		reader.releaseLock();
		return text.slice(0, text.indexOf("\n"));
	}

	test("a partial launch tears down every process it launched and keeps the launch error", async () => {
		const dir = tmp("load-partial");
		const error = await startHistoricLoad(dir, "tr-partial", far(), Date.now, ["cpu", "bogus" as LoadKind]).then(() => null, (e: unknown) => e as Error);
		expect(error?.message).toContain("exited before readiness");
		const r = receiptOf(dir);
		expect(r.state).toBe("stopped");
		expect(r.processes.map((p) => p.kind)).toEqual(["cpu", "bogus" as LoadKind]);
		expect(r.processes[1]!.exit).toBe(LOAD_EXIT.usage);
		expect(r.errors.join("\n")).toContain("launch: ");
		expect(live(r.processes.map((p) => p.pid))).toEqual([]);
		expect(await recoverHistoricLoad(dir, "tr-next")).toBeNull();
		expect(await recoverHistoricLoad(tmp("load-none"), "tr-next")).toBeNull();
	});

	test("an owner SIGKILLed after readiness leaks no load: each process ends at its owner's stdin EOF, and recovery records them gone", async () => {
		const dir = tmp("load-owner");
		const owner = Bun.spawn([process.execPath, "-e", [
			`import { startHistoricLoad } from ${JSON.stringify(SRC)};`,
			`const load = await startHistoricLoad(${JSON.stringify(dir)}, "tr-owner", ${far()}, Date.now, ["cpu", "spawn"]);`,
			"console.log(JSON.stringify(load.receipt.processes.map((p) => p.pid)));",
			"process.stdin.resume();",
		].join("\n")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
		const pids = JSON.parse(await firstLine(owner.stdout)) as number[];
		expect(pids).toHaveLength(2);
		expect(receiptOf(dir).state).toBe("running");
		owner.kill("SIGKILL");
		await owner.exited;
		await until("every load process ended with its owner", () => live(pids).length === 0);
		for (const i of [0, 1]) expect(readFileSync(join(dir, `load-${i}.log`), "utf8")).toContain("owner closed stdin");
		const rec = await recoverHistoricLoad(dir, "tr-next");
		expect(rec?.outcomes).toEqual(pids.map((pid) => ({ pid, outcome: "gone" as const })));
		expect(receiptOf(dir).state).toBe("recovered");
		expect(readFileSync(join(dir, "load-recovery.jsonl"), "utf8")).toContain('"recordedState":"running"');
	});

	// The lease is expired by the time handed to load.renew, an injected value, never a wall-clock wait.
	test("an owner that stops renewing (suspended, or its lock lost) leaks no load: every process ends itself at its lease", async () => {
		const dir = tmp("load-lease");
		const load = await startHistoricLoad(dir, "tr-lease", far(), Date.now, ["cpu", "spawn"]);
		const pids = load.receipt.processes.map((p) => p.pid);
		load.renew(Date.now() - LOAD_LEASE_MS - 1);
		await until("every load process ended at its lease", () => live(pids).length === 0);
		for (const i of [0, 1]) expect(readFileSync(join(dir, `load-${i}.log`), "utf8")).toContain("lease expired");
		const error = await load.stop().then(() => null, (e: unknown) => e as Error);
		expect(error?.message).toContain(`ended before its owner stopped it, exit ${LOAD_EXIT.leaseExpired}`);
		expect(receiptOf(dir).state).toBe("teardown-failed");
		expect(receiptOf(dir).processes.map((p) => p.exit)).toEqual([LOAD_EXIT.leaseExpired, LOAD_EXIT.leaseExpired]);
	});

	test("recovery kills only a recorded process whose live start time, group and argv match, never a reused or altered pid", async () => {
		const dir = tmp("load-recover");
		const decoy = Bun.spawn([process.execPath, "-e", "process.stdin.resume();"], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
		try {
			const load = await startHistoricLoad(dir, "tr-dead", far(), Date.now, ["cpu", "cpu", "spawn"]);
			const r = receiptOf(dir);
			const s = snapshot(process.getuid!());
			if (s.kind !== "ok") throw new Error(`process list of this uid unavailable: ${s.why}`);
			const d = s.procs.find((p) => p.pid === decoy.pid)!;
			const decoyArgv = procArgv(decoy.pid);
			expect(decoyArgv).not.toBeNull();
			r.processes[1]!.argv = r.processes[1]!.argv.map((a, i) => (i === 9 ? "0".repeat(24) : a));
			r.processes.push({ ...r.processes[0]!, index: 3, pid: decoy.pid, pgid: d.pgid, startUs: d.startUs });
			r.processes.push({ ...r.processes[0]!, index: 4, pid: decoy.pid, pgid: d.pgid, startUs: d.startUs + 1, argv: decoyArgv! });
			writeFileSync(join(dir, "load.json"), JSON.stringify(r));
			const rec = await recoverHistoricLoad(dir, "tr-next");
			expect(rec?.outcomes.map((o) => o.outcome)).toEqual(["killed", "not ours", "killed", "not ours", "not ours"]);
			expect(live([r.processes[0]!.pid, r.processes[2]!.pid])).toEqual([]);
			expect(live([r.processes[1]!.pid, decoy.pid])).toEqual([r.processes[1]!.pid, decoy.pid]);
			expect(receiptOf(dir).state).toBe("recovered");
			expect(existsSync(join(dir, "load-recovery.jsonl"))).toBe(true);
			await expect(load.stop()).rejects.toThrow("ended before its owner stopped it");
			expect(live([r.processes[1]!.pid])).toEqual([]);
		} finally {
			decoy.kill("SIGKILL");
			await decoy.exited;
		}
	});
});
