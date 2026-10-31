#!/usr/bin/env bun
// The timing-proof controller (TOOLS-REVIEW-r1 F5): submission, the series loop and each attempt. It drives the ordinary runner's
// one exclusive lifecycle (runs.db lock, queue and `current` fence) only through ExclusiveSession, and never executes a test
// itself: every part runs through the rendered wrapper the session owns.
import type { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, TEST_RUNNER_BY } from "../ledger/src/index";
import { HEARTBEAT_EVERY_MS, runDirOf, runsRoot, type TestRequested, type TestRunnerConfig } from "../surface/src/test-run";
import {
	admitProof, controllerHeartbeatOf, executableTree, type ExclusiveSession, failProof, finishProofIteration, type HistoricLoad, inspectProof, nextProofIteration,
	parseProofManifest, proofDirectory, proofEvidence, type ProofInputs, type ProofIteration, type ProofManifest, recoverProof, recoverProofSeries, proofProcessLive,
	installedRuntimeHashes, runtimeIdentity, startHistoricLoad, validateProofTree,
} from "../surface/src/timing-proof";
import {
	errText, freshRunId, gitSync, hook, importPart, importReport, installSpec, loadConfig, mirrorEnv, mirrorOf, NETWORK, NO_HOOKS, openLedger, openLockDb, Runner,
	servedOf, spawnRunner, START_EXIT, treeAt,
} from "../surface/scripts/test-runner";

/** Slack past a part's cap before its historic load's hard bound: the wrapper's own outlive and finalization fit inside it. */
const LOAD_HARD_SLACK_MS = 5 * 60_000;

/**
 * The executable identity of a series (F4): each pinned commit's tree fetched from the served origin, minus decision-log churn,
 * and the sha-256 of every installed runtime file (installedRuntimeHashes: the executor, its Bun, the measured resource policy and
 * the pinned OMP runtime when installed) with the proof mode.
 */
export function proofInputs(mirror: string, env: Record<string, string>, m: ProofManifest, libexec: string): ProofInputs {
	const tree = (sha: string) => ({ sha, tree: executableTree(gitSync(mirror, ["ls-tree", "-r", "-z", "--full-tree", sha], env).toString()) });
	return { base: tree(m.baseSha), candidate: tree(m.candidateSha), runtime: runtimeIdentity(m.mode, installedRuntimeHashes(libexec, m.mode)) };
}

/** Admission fetches ONLY from the workload's served origin, checks the pinned trees, then records their executable identity. */
export function submitProof(ledger: Ledger, db: Database, root: string, m: ProofManifest, config: TestRunnerConfig): string {
	const w = ledger.workload(m.workload), s = ledger.slice(m.slice);
	if (!w || w.status !== "open" || !s || s.workload_id !== m.workload || s.state !== "open") throw new Error(`timing-proof: ${m.workload}/${m.slice} must be open`);
	const served = servedOf(ledger, m.workload, config);
	if (served.ownerRepo.toLowerCase() !== m.repo.toLowerCase()) throw new Error(`timing-proof: manifest ${m.repo} is not served workload origin ${served.ownerRepo}`);
	if (m.mode !== "installed-OMP" && m.files.some((f) => Object.hasOwn(config.mainSkip, f.path))) throw new Error("timing-proof: installed-OMP files require installed-OMP mode, never mainSkip");
	const env = mirrorEnv(root), mirror = mirrorOf(root, served.ownerRepo, env);
	for (const [phase, sha] of [["base", m.baseSha], ["candidate", m.candidateSha]] as const) {
		gitSync(mirror, [...NETWORK.slice(NO_HOOKS.length), "fetch", "-q", "--no-tags", served.url, sha], env);
		const fetched = gitSync(mirror, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], env).toString().trim();
		if (fetched !== sha) throw new Error(`timing-proof ${phase}: fetched ${fetched}, expected pinned ${sha} from served ${served.ownerRepo}`);
		validateProofTree(m, treeAt(mirror, sha, env, false).files, phase);
	}
	const id = freshRunId().replace(/^tr-/, "tp-");
	admitProof(db, id, m, proofInputs(mirror, env, m, installSpec().libexec), Date.now());
	try { spawnRunner(proofDirectory(root, id), id, import.meta.path); }
	catch (error) {
		try { failProof(db, id, `timing-proof ${id}: controller did not start: ${errText(error)}`); }
		catch (receiptError) { throw new AggregateError([error, receiptError], `timing-proof ${id}: launch failed ${errText(error)}; failure receipt failed ${errText(receiptError)}`); }
		throw error;
	}
	return id;
}

/** The resource admission receipt the executor wrote for `stem`: admitted, exact argv/report/file, pinned OMP when asked. */
function resourceErrors(r: { status?: string; selectedWorkers?: number; configuredWorkers?: number; installedOmp?: unknown; executionArgv?: unknown }, stem: string, xml: string, m: ProofManifest, i: ProofIteration): string[] {
	const errors: string[] = [];
	if (r.status !== "admitted" || !Number.isSafeInteger(r.selectedWorkers) || r.selectedWorkers! < 1 || !Number.isSafeInteger(r.configuredWorkers) || r.configuredWorkers! < r.selectedWorkers!) errors.push(`${stem}.resources.json: resource admission failed or malformed; inspect preserved receipt`);
	if (!Array.isArray(r.executionArgv) || !r.executionArgv.every((a) => typeof a === "string") || !r.executionArgv.includes("--reporter=junit") || !r.executionArgv.includes(`--reporter-outfile=${xml}`) || (i.file !== null && !r.executionArgv.includes(`./${i.file}`))) errors.push(`${stem}.resources.json: missing exact admitted child argv/report/file evidence`);
	if (m.mode === "installed-OMP" && !r.installedOmp) errors.push(`${stem}.resources.json: missing pinned installed OMP identity`);
	return errors;
}

/**
 * One immutable attempt on an exclusive session; no normal verdict or publication path is entered. The historic load starts only
 * once the session is prepared, renews its lease only while the session still owns the lock, ends with its owner either way and is
 * stopped before the sweep. Every failure (the part's, the load's teardown, cleanup's, release's) is kept in the receipt.
 */
export async function runAttempt(session: ExclusiveSession, seriesId: string, m: ProofManifest, i: ProofIteration): Promise<{ error: string | null; artifacts: string }> {
	const label = `timing-proof ${seriesId}/${i.index}`;
	const plan = session.partPlan(i.file);
	const errors: string[] = [];
	const receipt: Record<string, unknown> = {
		seriesId, iteration: i, manifest: m, smokeOnly: m.kind === "smoke", startedAt: Date.now(), argv: plan.argv,
		environment: { productionBudget: m.productionBudget, installedOmp: m.mode === "installed-OMP" },
		resources: null, execution: null, cleanup: null, load: null,
	};
	let load: HistoricLoad | null = null;
	let renewal: Timer | undefined;
	let prepared = false;
	try {
		receipt.preparation = await session.prepareSession({
			label, repo: m.repo, check: ({ files }) => validateProofTree(m, files, i.phase),
			caps: { timingProof: { productionBudget: m.productionBudget, installedOmp: m.mode === "installed-OMP" } },
		});
		prepared = true;
		if (m.load === "historic") {
			load = await startHistoricLoad(session.runDir, i.runId, Date.now() + plan.capMs + LOAD_HARD_SLACK_MS);
			receipt.load = load.receipt;
			const held = load;
			renewal = setInterval(() => {
				// A lost lease is not renewed: the load ends itself at its lease, and the next owner recovers what is left.
				if (!session.owned()) { clearInterval(renewal); errors.push("historic load: lock ownership lost; lease left to expire"); return; }
				try { held.renew(Date.now()); }
				catch (error) { clearInterval(renewal); errors.push(`historic load lease renewal: ${errText(error)}; lease left to expire`); }
			}, HEARTBEAT_EVERY_MS);
		}
		const part = await session.runPart(i.file);
		receipt.part = { stem: part.stem, ...part.result, timedOut: part.timedOut, halted: part.halted };
		const resource = importReport(session.workDir, session.runDir, `${part.stem}.resources.json`, session.capBytes);
		if (resource.text !== null) receipt.resources = JSON.parse(resource.text);
		if (resource.error) errors.push(resource.error);
		if (resource.text === null) errors.push(`${part.stem}.resources.json: missing executor-owned resource admission receipt`);
		else errors.push(...resourceErrors(receipt.resources as Record<string, never>, part.stem, join(session.workDir, `${part.stem}.xml`), m, i));
		const imported = importPart(session.workDir, session.runDir, part.stem, session.capBytes);
		if (imported.importError) errors.push(imported.importError);
		if (part.result.error) errors.push(part.result.error);
		if (part.timedOut || part.halted) errors.push(`${part.stem}: timed out or halted`);
		if (imported.junit === null || imported.log === null) errors.push(`${part.stem}: missing JUnit or console evidence`);
		else {
			try { receipt.execution = proofEvidence(m, i, imported.junit, imported.log); }
			catch (error) { errors.push(errText(error)); }
		}
		const expectedBaseRed = i.phase === "base" && part.result.fail > 0 && part.result.exit === 1 && part.result.error === null;
		if (part.result.exit !== 0 && !expectedBaseRed) errors.push(`${part.stem}: exit ${part.result.exit}; only a recorded baseline assertion red may continue`);
	} catch (error) {
		errors.push(errText(error));
	} finally {
		clearInterval(renewal);
		if (load !== null) {
			try { await load.stop(); } catch (error) { errors.push(`load teardown: ${errText(error)}`); }
		}
		if (session.owned()) {
			try {
				const contained = await session.sweepContained(label);
				if (errors.length === 0) {
					await session.cleanup();
					receipt.cleanup = { state: "verified", at: Date.now(), processes: contained, removedRoot: session.workDir };
				} else {
					receipt.cleanup = { state: "contained-evidence-retained", at: Date.now(), processes: contained, retainedRoot: session.workDir };
					writeFileSync(join(session.runDir, "proof-retained-world.json"), JSON.stringify({ target: session.workDir, errors, at: Date.now() }), { mode: 0o600 });
				}
			} catch (error) { errors.push(`cleanup: ${errText(error)}`); }
		} else if (prepared) errors.push("cleanup: ownership lost; no destructive cleanup attempted, inspect preserved world");
		errors.push(...await session.releaseSession());
	}
	const error = errors.length ? `${label} ${i.file ?? "full"} ${i.sha}: ${errors.join("; ")}; evidence ${session.runDir}; diagnose and change inputs, never replay this attempt` : null;
	try {
		writeFileSync(join(session.runDir, "proof.json"), `${JSON.stringify({ ...receipt, completedAt: Date.now(), state: error === null ? "complete" : "failed", error }, null, 2)}\n`, { mode: 0o600 });
	} catch (writeError) {
		throw new AggregateError([...(error === null ? [] : [new Error(error)]), writeError], `${error ?? label}; writing ${session.runDir}/proof.json failed: ${errText(writeError)}`);
	}
	return { error, artifacts: session.runDir };
}

function closeProofDb(db: Database, context: string, original: unknown): void {
	try { db.close(); }
	catch (error) {
		throw new AggregateError([...(original === undefined ? [] : [original]), error], `${context}: ${original === undefined ? "" : `${errText(original)}; `}runs.db close failed: ${errText(error)}`);
	}
}

/** Restart is permitted only between unstarted steps. A dead running attempt becomes terminal interrupted, never retried. */
async function cmdRun(id: string): Promise<number> {
	const root = runsRoot(process.env);
	const directory = proofDirectory(root, id);
	const ledger = openLedger(), db = openLockDb(root);
	let timer: Timer | undefined;
	let failure: unknown;
	try {
		const config = loadConfig();
		let p = recoverProof(db, id, (runId, at) => proofProcessLive(root, runId, at, Date.now()));
		if (p.state === "running") throw new Error(`timing-proof ${id}: an attempt remains live; inspect it instead of starting a duplicate`);
		if (p.state === "admitted") {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const beat = () => {
				const path = controllerHeartbeatOf(root, id);
				writeFileSync(`${path}.${process.pid}.tmp`, String(Date.now()), { mode: 0o600 });
				renameSync(`${path}.${process.pid}.tmp`, path);
			};
			beat();
			timer = setInterval(beat, HEARTBEAT_EVERY_MS);
		}
		while (p.state === "admitted") {
			const runId = freshRunId();
			const artifacts = runDirOf(root, runId);
			const i = nextProofIteration(db, id, runId, Date.now(), artifacts);
			if (!i) break;
			try {
				await hook(id, "proof-iteration", { runId, index: i.index });
				const request: TestRequested = { runId, pr: 0, sha: i.sha, slice: p.manifest.slice, by: TEST_RUNNER_BY };
				const session = new Runner(ledger, p.manifest.workload, request, config, { requestedAt: i.requestedAt });
				const result = await runAttempt(session, id, p.manifest, i);
				process.stdout.write(`${new Date().toISOString()} ${result.error ?? `timing-proof ${id}/${i.index} complete (proof only; no gate or slice settlement)`}\n`);
				finishProofIteration(db, id, i.index, { state: result.error === null ? "complete" : "failed", error: result.error, artifacts: result.artifacts });
			} catch (error) {
				finishProofIteration(db, id, i.index, { state: "failed", error: `timing-proof ${id}/${i.index}: ${errText(error)}; evidence ${artifacts}`, artifacts });
			}
			p = inspectProof(db, id);
		}
		return p.state === "complete" ? START_EXIT.ok : START_EXIT.failed;
	} catch (error) {
		failure = error;
		try {
			const p = inspectProof(db, id);
			// A duplicate invocation cannot fail the original live attempt.
			if (p.state !== "running") failProof(db, id, `timing-proof ${id}: ${errText(error)}`);
		} catch (receiptError) { failure = new AggregateError([error, receiptError], `timing-proof ${id}: ${errText(error)}; failure receipt failed ${errText(receiptError)}`); }
		throw failure;
	} finally { clearInterval(timer); closeProofDb(db, `timing-proof ${id}`, failure); }
}

function cmdSubmit(path: string): number {
	if (!path.startsWith("/")) throw new Error("timing-proof submit: manifest path must be absolute");
	const st = lstatSync(path);
	if (!st.isFile() || st.size > 5 * 1024 * 1024) throw new Error(`timing-proof submit: ${path} is not a regular manifest under 5MiB`);
	const m = parseProofManifest(JSON.parse(readFileSync(path, "utf8")));
	const root = runsRoot(process.env), db = openLockDb(root);
	let failure: unknown;
	try {
		const id = submitProof(openLedger(), db, root, m, loadConfig());
		process.stdout.write(`timing-proof ${id} admitted (${m.kind}${m.kind === "smoke" ? "; smoke only, not completion proof" : ""}) log ${join(proofDirectory(root, id), "runner.log")}\n`);
		return START_EXIT.ok;
	} catch (error) { failure = error; throw error; }
	finally { closeProofDb(db, `timing-proof submit ${path}`, failure); }
}

function cmdInspect(id: string): number {
	const root = runsRoot(process.env);
	proofDirectory(root, id);
	const db = openLockDb(root);
	let failure: unknown;
	try {
		const p = recoverProofSeries(db, root, Date.now, id)[0]!;
		process.stdout.write(`${JSON.stringify({ ...p, log: join(proofDirectory(root, id), "runner.log"), completionProof: p.manifest.kind !== "smoke" && p.state === "complete" }, null, 2)}\n`);
		return p.state === "failed" ? START_EXIT.failed : START_EXIT.ok;
	} catch (error) { failure = error; throw error; }
	finally { closeProofDb(db, `timing-proof inspect ${id}`, failure); }
}

const USAGE = "usage: bun scripts/timing-proof.ts submit --manifest <absolute manifest.json> | inspect --series <series-id> | run <series-id>";
export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "submit" && rest.length === 2 && rest[0] === "--manifest") return cmdSubmit(rest[1]!);
	if (command === "inspect" && rest.length === 2 && rest[0] === "--series") return cmdInspect(rest[1]!);
	// The detached controller submission spawns (`spawnRunner`); a restart of a series is the same command.
	if (command === "run" && rest.length === 1) return cmdRun(rest[0]!);
	throw new Error(USAGE);
}
if (import.meta.main) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
		process.stderr.write(`timing-proof: ${errText(error)}; inspect the named series/artifacts before changing inputs\n`);
		process.exitCode = START_EXIT.failed;
	});
}
