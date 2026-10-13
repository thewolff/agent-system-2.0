// State the surface rows share within one OMP session, keyed on the session's SessionManager the
// way gates/src/session.ts does (separately loaded extension modules still share one store through
// globalThis). Only a top-level session whose role env is `orchestrator` is a surface; a lane or a
// hand loading this extension gets an inert session.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { defaultLedgerPath } from "../../ledger/src/locality";
import type { Invariant, Report } from "../scripts/invariants";
import { Delivered } from "./delivery";
import { liveReport } from "./invariant-watch";
import { Numbering } from "./numbering";
import { type Ctx, INVARIANT_MS, INVARIANT_MS_ENV, POLL_MS, POLL_MS_ENV, ROLE_ENV, SURFACE_TOOLS, VOICE_ENV, WAKE_PUSH_MS, WAKE_PUSH_MS_ENV, WAKE_READ_TOOL } from "./types";

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const VOICE_RELATIVE = join("voice", "VOICE.md");

export type WakeTrigger = "session-start" | "restart" | "compaction";

export class SurfaceSession {
	/** This session is the orchestrator surface. */
	readonly active: boolean;
	/** A wake render is owed: taken by the next push (surface/extensions/wake.ts pushWake) or the next `before_agent_start`. */
	pending: WakeTrigger | null = null;
	/** After a wake render the first turn owes one wake-read entry; tool calls other than it are refused. */
	owed: { trigger: WakeTrigger; since: string } | null = null;
	/** Receipts from Jo's one-word inputs, injected into the context of the turn that typed the word; never pushed. */
	readonly notices: string[] = [];
	/** What Jo typed (OMP's `input` event, interactive or rpc), until the turn's `before_agent_start` reads it: a prose prompt matching it gets a Jo-input row (surface/extensions/surface-input.ts). */
	typed: string | null = null;
	/** The tick's lines (launch catch-up results), pushed as `surface-notices` asides; a line leaves only when a confirmed push or Jo's turn carried it. */
	readonly tickNotices: string[] = [];
	/** The voice document was injected into the system prompt at least once (probes read this). */
	voiceInjected = false;
	/** A `before_agent_start` ran in this process, so the turn's system prompt carries the voice and the contract; until then a pushed wake inlines both. */
	promptPrimed = false;
	/** A wake pushed as an aside and not yet confirmed by its `message_end`: resent at the next idle polls, up to PUSH_TRIES sends. */
	wakeInFlight: { wakeId: string; trigger: WakeTrigger; content: string; tries: number; carried: string[] } | null = null;
	/** The pushed wake was never confirmed: it is pending for Jo's turn and nothing pushes it until his turn or a new trigger. */
	wakeExhausted = false;
	/** The key of a wake that fell back to pending: Jo's render reuses it so the guard drops every deferred copy. */
	pendingWakeId: string | null = null;
	/** Keys (`wake:<id>`) of wakes a new trigger superseded while in flight or fallen back: the `context` guard drops their deferred copies. */
	readonly retiredKeys = new Set<string>();
	/** A tick batch pushed and not yet confirmed: resent at the next idle polls, up to PUSH_TRIES sends. */
	noticesInFlight: { batchId: string; lines: string[]; content: string; tries: number } | null = null;
	/** A batch was never confirmed: no tick line is pushed until Jo's turn renders the queue. */
	noticesExhausted = false;
	/** The key of the batch that fell back to Jo's turn, which renders the queue under it. */
	pendingNoticesId: string | null = null;
	/** Which § B3 lines this session has delivered, in which state (surface/src/delivery.ts). */
	readonly delivered = new Delivered();
	/** The numbers Jo answers needs-you lines with (surface/src/numbering.ts): stable for the session, never reused. */
	readonly numbering = new Numbering();
	/** The between-wakes poll is running (one per session). */
	polling = false;
	/** A tick's launch catch-up (surface/extensions/wake.ts) is still running; the next tick skips rather than overlap it. */
	launching = false;
	/**
	 * Workloads awaiting close that the tick cannot close (a slice open or paused, a question open),
	 * by id → `<open>:<paused>:<questions>` last told: the notice repeats only when the counts change.
	 */
	readonly stuckFinished = new Map<string, string>();
	/**
	 * Workloads awaiting close whose tick close was refused (e.g. the close check found no green
	 * test-run), by id → the refusal text last told: the tick still retries every poll, but the
	 * notice repeats only when the text changes. Cleared when the workload closes or stops being ready.
	 */
	readonly refusedClose = new Map<string, string>();
	/** The invariant timer is registered (one per session, beside the poll; MIGRATION.md item 104). */
	invariantTimer = false;
	/** Each invariant the last invariant run skipped, with its reason: a skip on two runs in a row is surfaced (surface/src/invariant-watch.ts). */
	readonly invariantSkips = new Map<Invariant, string>();
	/** Invariant lines queued and not yet delivered, line → the keys it carries: recorded as surfaced only on delivery (surface/src/invariant-watch.ts). */
	readonly invariantPending = new Map<string, string[]>();
	/** The last failure of the invariant run told as a tick line: the same failure is told once until it changes or a run succeeds. */
	invariantFailure: string | null = null;
	/** The invariant report, run at each invariant tick; tests replace it. Default: `liveReport` over this session's ledger and the as2 checkout. */
	invariantReport: () => Report = () => liveReport(this.ledger().path, REPO_ROOT, this.now(), this.env.HOME || homedir());
	/** The clock the surface reads the ledger at; tests move it. */
	now: () => string = () => new Date().toISOString();
	#ledger: Ledger | null = null;
	/** Push keys and render order: unique within the process (the tag) and increasing (the counter). */
	readonly #tag = Date.now().toString(36);
	#serial = 0;

	constructor(
		ctx: Ctx,
		readonly env: Record<string, string | undefined>,
	) {
		const top = !(!ctx.hasUI && ctx.sessionManager.getHeader()?.parentSession);
		this.active = top && env[ROLE_ENV] === "orchestrator";
	}

	ledger(): Ledger {
		this.#ledger ??= Ledger.open(defaultLedgerPath(this.env));
		return this.#ledger;
	}

	/** How often the poll re-reads the ledger between wakes. */
	get pollMs(): number {
		const n = Number(this.env[POLL_MS_ENV]);
		return Number.isFinite(n) && n > 0 ? n : POLL_MS;
	}

	/** How long after a wake trigger the first push is tried. */
	get wakePushMs(): number {
		const n = Number(this.env[WAKE_PUSH_MS_ENV]);
		return Number.isFinite(n) && n > 0 ? n : WAKE_PUSH_MS;
	}

	/** How often the invariant report runs. */
	get invariantMs(): number {
		const n = Number(this.env[INVARIANT_MS_ENV]);
		return Number.isFinite(n) && n > 0 ? n : INVARIANT_MS;
	}

	/** A fresh push id (`wake:<id>`, `notices:<id>`). */
	mintId(): string {
		return `${this.#tag}-${++this.#serial}`;
	}

	/** The next render sequence number: a later send or render of the same key sorts after an earlier one. */
	nextSeq(): number {
		return ++this.#serial;
	}

	/** The voice document text, or null with the path tried when it is missing. */
	voice(): { path: string; text: string | null } {
		const path = this.env[VOICE_ENV] || join(REPO_ROOT, VOICE_RELATIVE);
		return { path, text: existsSync(path) ? readFileSync(path, "utf8") : null };
	}

	/** A tool call's verdict while a wake read is owed: only the wake-read tool may run. */
	check(toolName: string): { block: true; reason: string } | null {
		if (!this.owed || toolName === WAKE_READ_TOOL) return null;
		return {
			block: true,
			reason: `wake (${this.owed.trigger}): this turn owes one wake-read ledger entry saying what you resume, before any other tool call; record it with ${WAKE_READ_TOOL}. Surface tools: ${SURFACE_TOOLS.join(", ")}.`,
		};
	}
}

const STORE = Symbol.for("agent-system-2.0/surface/sessions");
type Store = WeakMap<object, SurfaceSession>;

/** This session's surface state, created on first use. */
export function surfaceSession(ctx: Ctx, env: Record<string, string | undefined>): SurfaceSession {
	const g = globalThis as unknown as Record<symbol, Store | undefined>;
	const store = (g[STORE] ??= new WeakMap());
	let s = store.get(ctx.sessionManager);
	if (!s) {
		s = new SurfaceSession(ctx, env);
		store.set(ctx.sessionManager, s);
	}
	return s;
}
