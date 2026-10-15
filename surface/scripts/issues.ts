#!/usr/bin/env bun
// The issues projection's read-only drift report (PLAN wl-mv66ylim0gahog § 2, § 4), for Jo and the
// smoke:
//
//   bun surface/scripts/issues.ts check
//
// It runs the reconciler's own comparison (surface/src/issues/reconcile.ts `computeDrift`) against
// the ledger (`$AGENT_SYSTEM_LEDGER_DB`, else the default) and its sidecar `issues.db`, and prints
// `drift: <N>` (or `drift: unknown (<why>)`) then one line per difference. It writes no link, PR
// row, state or claim: the ledger is opened `{ readonly: true }`, the sidecar is read through a
// read-only SQLite connection, no drift entry is recorded and no link is marked; GitHub and Linear
// get reads only (`gh issue list|view`, `gh pr list|view`, Linear queries). Its one sidecar write is
// the call count: each call is counted, without the claim, against the projector's own per-tracker
// hourly budget (the sidecar's `calls` rows, `perHour`), on a connection that runs no migration
// (`Sidecar.openNoMigrate`), and the run makes at most `perTick` calls per tracker. When either cap is
// reached it makes no further call of that tracker and prints `drift: unknown (budget)`. A sidecar the
// surface has not migrated yet (its schema not current, read through the read-only connection) is
// left as it is: the check prints `drift: unknown (sidecar not migrated; start the surface first)`,
// makes no call and writes nothing. There is no script that drains the outbox: only the surface row
// writes to a tracker.
//
// Exit: 0 drift 0; 1 drift above 0 or unknown; 2 a bad argument, no `issues:` block, or no sidecar.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { Ledger } from "../../ledger/src/index";
import { assertNotLiveLedgerUnderTest, defaultLedgerPath } from "../../ledger/src/locality";
import { loadIssuesConfig } from "../src/issues/config";
import type { Exec } from "../src/issues/github";
import { GitHub } from "../src/issues/github";
import { type FetchLike, Linear, LINEAR_KEY_ENV, redact } from "../src/issues/linear";
import { renderWorkload } from "../src/issues/projector";
import { prSources, readPrSet } from "../src/issues/prs";
import { computeDrift, driftCount, driftDetail, driftHead, type DriftSidecar } from "../src/issues/reconcile";
import { type LinkRow, type PrRow, schemaCurrent, Sidecar, sidecarPath } from "../src/issues/sidecar";
import { NO_REPO } from "../src/issues/tracker";

const USAGE = "usage: bun surface/scripts/issues.ts check";
/** The headline when a cap stopped the run: the check never exceeds the budget to finish. */
export const BUDGET_HEAD = "drift: unknown (budget)";
/** The headline for a sidecar whose schema is not current: the check never migrates it (only the surface does). */
export const NOT_MIGRATED_HEAD = "drift: unknown (sidecar not migrated; start the surface first)";

/** The sidecar read through a read-only connection: the same reads `Sidecar` makes, and no write is possible. */
class ReadOnlySidecar implements DriftSidecar {
	readonly db: Database;

	constructor(path: string) {
		assertNotLiveLedgerUnderTest(path);
		this.db = new Database(path, { readonly: true });
	}

	state(key: string): string | null {
		return this.db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key)?.value ?? null;
	}

	link(workloadId: string): LinkRow | null {
		return this.db.query<LinkRow, [string]>("SELECT * FROM links WHERE workload_id = ?").get(workloadId);
	}

	links(): LinkRow[] {
		return this.db.query<LinkRow, []>("SELECT * FROM links ORDER BY last_seq, workload_id").all();
	}

	prs(): PrRow[] {
		return this.db.query<PrRow, []>("SELECT * FROM prs ORDER BY workload_id, number").all();
	}

	close(): void {
		this.db.close();
	}
}

export interface CheckOptions {
	env: Record<string, string | undefined>;
	exec: Exec;
	fetch: FetchLike;
	out: (line: string) => void;
	err: (line: string) => void;
	/** Epoch ms; tests set it. */
	now?: () => number;
}

/** `issues.ts check`: the drift report on `out`; returns the exit code. */
export async function check(o: CheckOptions): Promise<number> {
	const cfg = loadIssuesConfig(o.env);
	if (!cfg.ok) {
		o.err(`issues check: ${cfg.error}`);
		return 2;
	}
	if (cfg.config === null) {
		o.err("issues check: the profile config has no issues: block; nothing is projected");
		return 2;
	}
	const path = sidecarPath(o.env);
	if (!existsSync(path)) {
		o.err(`issues check: no sidecar at ${path}; the projection has not run on this ledger`);
		return 2;
	}
	const now = o.now ?? (() => Date.now());
	const key = o.env[LINEAR_KEY_ENV]?.trim() || null;
	const sidecar = new ReadOnlySidecar(path);
	// A sidecar the surface has not migrated yet: opening it for the meter would migrate it, so nothing more runs.
	if (!schemaCurrent(sidecar.db)) {
		sidecar.close();
		o.out(NOT_MIGRATED_HEAD);
		return 1;
	}
	const ledger = Ledger.open(defaultLedgerPath(o.env), { readonly: true });
	// The meter: the sidecar's own `calls` rows (the projector's hourly budget), counted with no claim,
	// on a read-write connection that runs no migration; the read-only connection above serves every other read.
	const meter = Sidecar.openNoMigrate(path);
	try {
		const caller = { holder: null, perTick: cfg.config.perTick, perHour: cfg.config.perHour, now };
		const gh = new GitHub(o.exec, meter, caller);
		const d = await computeDrift({
			config: cfg.config,
			ledger,
			sidecar,
			gh,
			linear: new Linear(o.fetch, key, meter, caller),
			exec: o.exec,
			rateLow: false,
			prSet: async (workloadId) => {
				const repo = sidecar.link(workloadId)?.repo ?? null;
				return repo === null || repo === NO_REPO ? { known: true, prs: [] } : readPrSet(gh, repo, prSources(ledger, workloadId));
			},
			renderOf: (workloadId, prs) => renderWorkload(ledger, workloadId, prs, sidecar.link(workloadId)?.last_seq ?? 0),
		});
		const head = d.stop !== null ? BUDGET_HEAD : `drift: ${driftHead(d)}`;
		for (const line of [head, ...driftDetail(d)]) o.out(redact(line, key));
		return d.stop === null && driftCount(d) === 0 ? 0 : 1;
	} finally {
		meter.close();
		ledger.close();
		sidecar.close();
	}
}

/** `gh` and `git` for the CLI: argv only, a timeout, never a shell. */
const spawnExec: Exec = async (command, args, options) => {
	const r = Bun.spawnSync([command, ...args], { cwd: options?.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(options?.timeout ? { timeout: options.timeout } : {}) });
	return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode ?? -1, killed: r.exitedDueToTimeout === true };
};

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length !== 1 || args[0] !== "check") {
		process.stderr.write(`${USAGE}\n`);
		process.exit(2);
	}
	const code = await check({
		env: process.env,
		exec: spawnExec,
		fetch: (url, init) => fetch(url, init),
		out: (line) => process.stdout.write(`${line}\n`),
		err: (line) => process.stderr.write(`${line}\n`),
	});
	process.exit(code);
}
