// The lab budget's surface row (MIGRATION.md item 113). The orchestrator's own turns, and the hands it
// spawns, spend tokens on a lab like any lane, but no runner meters them: before this row none of it
// reached the ledger. On the orchestrator's top-level session only (`surfaceSession(...).active`), this
// row reads the session's own file and its hands' directory every minute from where they stood when
// this process started (a resumed session's earlier usage was the earlier process's to record), and
// writes what it counted as one `orchestrator-spend:` delta on the standing workload at most every five
// minutes, plus once at shutdown. It also refreshes the quota cache (`omp usage --json`) in the
// background, so a lab's quota is known while no lane runs.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { jsonlFiles, scanFiles, type Spend } from "../src/ceiling";
import { orchestratorSpendBody } from "../src/lab-budget";
import { refreshQuota } from "../src/lab-budget-io";
import { surfaceSession } from "../src/session";
import { type Ctx, STANDING_WORKLOAD_ID, SURFACE_BY, type SurfaceAPI } from "../src/types";

/** How often the row reads the session files; `AGENT_SYSTEM_LAB_SCAN_MS` overrides it (tests). */
export const LAB_SCAN_MS = 60_000;
export const LAB_SCAN_MS_ENV = "AGENT_SYSTEM_LAB_SCAN_MS";
/** The least time between two `orchestrator-spend:` records of one process. */
export const ORCH_SPEND_EVERY_MS = 5 * 60_000;

const EMPTY: Spend = { usd: 0, tokens: 0, wallMin: 0, labs: {} };

/** OMP's session file for `ctx` (ReadonlySessionManager.getSessionFile), or null when the host does not expose one. */
function sessionFileOf(ctx: Ctx): string | null {
	const sm: unknown = ctx.sessionManager;
	const get = sm !== null && typeof sm === "object" && "getSessionFile" in sm ? sm.getSessionFile : undefined;
	if (typeof get !== "function") return null;
	const file: unknown = Reflect.apply(get, sm, []);
	return typeof file === "string" && file.endsWith(".jsonl") ? file : null;
}

/** The session file and every hand file under `<session>/` (a hand's session file is `<session>/<agent>.jsonl`). */
function filesOf(file: string): string[] {
	return [file, ...jsonlFiles(file.slice(0, -".jsonl".length))];
}

export default function labBudgetRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	let file: string | null = null;
	let offsets = new Map<string, number>();
	let pending: Spend = EMPTY;
	let lastWrite = 0;

	/** Record the pending delta when it is due (or `force`); a failed write keeps it for the next try. */
	const flush = (ctx: Ctx, force: boolean): void => {
		if (file === null || pending.tokens <= 0) return;
		const now = Date.now();
		if (!force && now - lastWrite < ORCH_SPEND_EVERY_MS) return;
		try {
			surfaceSession(ctx, env).ledger().recordEntry({
				by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: orchestratorSpendBody(basename(file, ".jsonl"), pending),
			});
			pending = EMPTY;
			lastWrite = now;
		} catch (err) {
			process.stderr.write(`surface: the orchestrator's spend could not be recorded: ${String(err)}\n`);
		}
	};

	/** Read what was appended since the last scan; a new session file (a `/new`) flushes the old one and starts from its current end. */
	const scan = (ctx: Ctx): void => {
		const current = sessionFileOf(ctx);
		if (current !== file) {
			flush(ctx, true);
			file = current;
			offsets = new Map();
			pending = EMPTY;
			if (file !== null) {
				for (const f of filesOf(file)) {
					try {
						offsets.set(f, statSync(f).size);
					} catch {
						// not written yet: counted from byte 0 once it is
					}
				}
			}
			return;
		}
		if (file !== null) pending = scanFiles(filesOf(file), offsets, pending);
	};

	pi.on("session_start", (_e, ctx) => {
		if (!surfaceSession(ctx, env).active) return undefined;
		scan(ctx);
		const n = Number(env[LAB_SCAN_MS_ENV]);
		ctx.setInterval(() => {
			try {
				scan(ctx);
				flush(ctx, false);
			} catch (err) {
				process.stderr.write(`surface: the orchestrator's spend scan failed: ${String(err)}\n`);
			}
			void refreshQuota(env, env.OMP_PROFILE || "agent-system-2");
		}, Number.isFinite(n) && n > 0 ? n : LAB_SCAN_MS);
		return undefined;
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (!surfaceSession(ctx, env).active) return undefined;
		try {
			scan(ctx);
		} catch {
			// the pending delta still goes
		}
		flush(ctx, true);
		return undefined;
	});
}
