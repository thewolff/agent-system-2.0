// Every GitHub call the issues projection makes (PLAN wl-mv66ylim0gahog § 2 github.ts, § 3 claim).
// Each `gh` call goes through the extension API's exec with NETWORK_MS and is counted before it
// runs: against `perTick` in memory, and against `perHour` by a `calls` row inserted in one
// IMMEDIATE sidecar transaction that first checks and renews this tick's claim. Over either cap, or
// with the claim lost, the call is not made and the tick ends (`TickStop`): a budget stop is never a
// failure, so nothing backs off for it. A call that runs and fails is a failure the caller handles.
// A caller with no holder (`surface/scripts/issues.ts check`, reads only) counts against the same
// `perTick` and `perHour` without the claim: its `calls` row is its only sidecar write, and its
// fence always fails, so it never creates an item or writes an item id.
// Bodies always go as argv (`--body <text>`): exec has no stdin.
import type { ExecResult, SurfaceAPI } from "../types";
import type { Sidecar, TrackerKind } from "./sidecar";

/** A network call's timeout (the close path's own, surface/src/close-entry.ts). */
export const NETWORK_MS = 60_000;

export type Exec = NonNullable<SurfaceAPI["exec"]>;

/**
 * Thrown by a counted call that is not made: `budget` (this tick's `perTick` or the hour's
 * `perHour` for that tracker kind is spent) or `lost` (another holder has the claim). A budget stop
 * ends that tracker's work this tick (the other tracker goes on, § 13.2); a lost claim ends the tick.
 * A phase that must record "the budget ran out" (the reconciler's `unknown`) catches it, records, and rethrows.
 */
export class TickStop extends Error {
	constructor(readonly reason: "budget" | "lost", readonly detail: string, readonly kind: TrackerKind = "github") {
		super(`issues tick stopped: ${reason} (${detail})`);
	}
}

export type GhOutcome = { ok: true; out: string } | { ok: false; error: string };

export interface GhCallerOptions {
	/** The claim's holder; null for a read-only caller that counts against the hour without the claim (see the header). */
	holder: string | null;
	perTick: number;
	perHour: number;
	/** Epoch ms; tests move it. */
	now: () => number;
}

/** One tracker kind's budget for one tick: `perTick` in memory, `perHour` in the sidecar, both fenced by the claim. */
export class Counted {
	/** Counted calls this tick made. */
	calls = 0;

	constructor(
		protected readonly sidecar: Sidecar,
		protected readonly o: GhCallerOptions,
		readonly kind: TrackerKind,
	) {}

	/** Count one call before it is made; throws TickStop when it may not run. */
	count(): void {
		if (this.calls >= this.o.perTick) throw new TickStop("budget", `${this.o.perTick} ${this.kind} calls this tick`, this.kind);
		const now = this.o.now();
		const counted = this.o.holder === null ? this.countUnclaimed(now) : this.sidecar.countCall(this.o.holder, now, this.o.perHour, this.kind);
		if (counted === "lost") throw new TickStop("lost", "another process holds the issues claim", this.kind);
		if (counted === "hour") throw new TickStop("budget", `${this.o.perHour} ${this.kind} calls this hour`, this.kind);
		this.calls++;
	}

	/** A holderless caller's count: the same hourly `calls` rows as `Sidecar.countCall`, in one IMMEDIATE transaction, with no claim read or written. */
	private countUnclaimed(nowMs: number): "ok" | "hour" {
		const sc = this.sidecar;
		return sc.immediate(() => {
			if (sc.callsInHour(nowMs, this.kind) >= this.o.perHour) return "hour";
			sc.db.query("INSERT INTO calls (at, tracker) VALUES (?, ?)").run(nowMs, this.kind);
			return "ok";
		});
	}

	/** Re-check and renew the claim without counting a call (before a create, before writing an item id); throws TickStop when lost, and always for a holderless caller. */
	fence(): void {
		if (this.o.holder === null || !this.sidecar.fence(this.o.holder, this.o.now())) throw new TickStop("lost", "another process holds the issues claim", this.kind);
	}
}

/** The counted gh caller one tick uses; phases get the same instance, so they share its budget. */
export class GitHub extends Counted {
	constructor(
		private readonly exec: Exec,
		sidecar: Sidecar,
		o: GhCallerOptions,
	) {
		super(sidecar, o, "github");
	}

	/** One counted `gh <args>`; throws TickStop when it may not run, never on a failed call. */
	async run(args: readonly string[]): Promise<GhOutcome> {
		this.count();
		let r: ExecResult;
		try {
			r = await this.exec("gh", [...args], { timeout: NETWORK_MS });
		} catch (err) {
			return { ok: false, error: `gh ${args.slice(0, 2).join(" ")} failed: ${String(err instanceof Error ? err.message : err).split("\n")[0]}` };
		}
		if (r.code === 0 && !r.killed) return { ok: true, out: r.stdout };
		const why = r.killed ? "timed out" : `exited ${r.code}`;
		return { ok: false, error: `gh ${args.slice(0, 2).join(" ")} ${why}: ${(r.stderr.trim() || r.stdout.trim() || "no output").split("\n")[0]}` };
	}

	/** A counted call whose stdout is JSON: the parsed value, or a failure naming what it printed. */
	async json(args: readonly string[]): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
		const r = await this.run(args);
		if (!r.ok) return r;
		try {
			return { ok: true, value: JSON.parse(r.out) };
		} catch {
			return { ok: false, error: `gh ${args.slice(0, 2).join(" ")} printed no JSON (${r.out.trim().split("\n")[0] || "no output"})` };
		}
	}
}
