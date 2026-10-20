// State the surface rows share within one OMP session, keyed on the session's SessionManager the
// way gates/src/session.ts does (separately loaded extension modules still share one store through
// globalThis). Only a top-level session whose role env is `orchestrator` is a surface; a lane or a
// hand loading this extension gets an inert session.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { defaultLedgerPath } from "../../ledger/src/locality";
import { Delivered } from "./delivery";
import { Numbering } from "./numbering";
import { BATCH_MS, BATCH_MS_ENV, type Ctx, POLL_MS, POLL_MS_ENV, QUIET_MS, QUIET_MS_ENV, ROLE_ENV, SURFACE_TOOLS, VOICE_ENV, WAKE_PUSH_MS, WAKE_PUSH_MS_ENV, WAKE_READ_TOOL } from "./types";

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const VOICE_RELATIVE = join("voice", "VOICE.md");
/** The heading that opens the voice section; a system prompt holding it at a line start already carries the voice. */
export const VOICE_HEADING = "# Voice document (";

/** The voice document's path: AGENT_SYSTEM_VOICE, else voice/VOICE.md in this checkout. */
export function voicePath(env: Record<string, string | undefined>): string {
	return env[VOICE_ENV] || join(REPO_ROOT, VOICE_RELATIVE);
}

/** The voice document as it goes into a system prompt, or the line saying it is missing. */
export function voiceSection(voice: { path: string; text: string | null }): string {
	return voice.text === null
		? `The voice document was not found at ${voice.path}; the orchestrator surface is running without it. Say so in your first message.`
		: `${VOICE_HEADING}${voice.path})\n\n${voice.text}`;
}

/**
 * The system prompt already carries the voice section: `bin/as2` puts it in the base prompt at
 * launch (`--append-system-prompt`), so every turn, aside-started or Jo's, sees the same bytes.
 */
export function voiceInPrompt(systemPrompt: readonly string[]): boolean {
	return systemPrompt.some((p) => p.startsWith(VOICE_HEADING) || p.includes(`\n${VOICE_HEADING}`));
}

export type WakeTrigger = "session-start" | "restart" | "compaction";

/** One message Jo typed (OMP's `input` event, source interactive or rpc), numbered in submission order. */
export interface TypedEntry {
	text: string;
	seq: number;
	source: "interactive" | "rpc";
}

/** How many discarded typed texts the surface remembers, only to warn when one arrives late (surface/extensions/surface-input.ts). */
export const DISCARDED_KEPT = 20;

export class SurfaceSession {
	/** This session is the orchestrator surface. */
	readonly active: boolean;
	/** A wake render is owed: taken by the next push (surface/extensions/wake.ts pushWake) or the next `before_agent_start`. */
	pending: WakeTrigger | null = null;
	/** After a wake render the first turn owes one wake-read entry; tool calls other than it are refused. */
	owed: { trigger: WakeTrigger; since: string } | null = null;
	/** Receipts from Jo's one-word inputs, injected into the context of the turn that typed the word; never pushed. */
	readonly notices: string[] = [];
	/**
	 * What Jo typed and no turn has taken yet, oldest first (surface/extensions/surface-input.ts): every
	 * `input` with source interactive or rpc pushes one entry; a turn's `before_agent_start` takes only
	 * its own entry (its exact trimmed text, or its exact slice of an OMP `"\n\n"` join), and that
	 * take is what makes a prose prompt Jo's receipt. An entry no turn takes is removed and judged at
	 * a prose take of a newer entry or at an idle sweep: warned and discarded, never written under
	 * another prompt's row.
	 */
	readonly typed: TypedEntry[] = [];
	/** The seq of the latest typed entry pushed (0 before the first). */
	typedSeq = 0;
	/** `typedSeq` when the latest `before_agent_start` ran: an entry with `seq <= startSeq` was pushed before that turn started. */
	startSeq = 0;
	/** The last DISCARDED_KEPT discarded typed texts (warned about, given no row): read only to warn when one arrives late, never a source of rows. */
	readonly discarded: string[] = [];
	/** The tick's lines (launch catch-up results), pushed as `surface-notices` asides; a line leaves only when a confirmed push or Jo's turn carried it. */
	readonly tickNotices: string[] = [];
	/** The voice document reached the system prompt at least once, from the launch's base prompt or a turn's append (probes read this). */
	voiceInjected = false;
	/**
	 * The system prompt carries the voice and the contract: the base prompt held both at session_start
	 * (bin/as2 launch), or a `before_agent_start` ran in this process. Until then a pushed wake inlines both.
	 */
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
	/** Standing lab-wait entry ids already shown in a launch response, tick notice or the session's initial wake. */
	readonly toldWaits = new Set<string>();
	/**
	 * Routine needs-you lines found between wakes and not pushed yet (PLAN wl-mv5msri070p0qo D3), by
	 * identity (`kind:workloadId:rowId`, surface/src/batch.ts lineKey): pushed as one aside when the
	 * window ends, or taken by Jo's turn, re-checked against a fresh read either way. A wake clears it.
	 */
	readonly heldNeedsYou = new Set<string>();
	/** When the first line now held was held (ms on the session clock): the window runs `batchMs` from here and does not slide. */
	holdSince: number | null = null;
	/** Jo typed `brb` (D4): the window never flushes and only `back` drains the hold; on-fire lines still go out, alone. */
	away: { since: string } | null = null;
	/** Jo's previous typed input, on the session clock (D4's quiet stretch). */
	lastTypedAt: string | null = null;
	/** The typed input of the turn about to start came more than `quietMs` after the one before it: the turn carries the complete list once. */
	quietTurn = false;
	/** Jo typed `pending` while the session was busy: shown, rendered fresh, at the next idle poll (D1). */
	pendingDisplay = false;
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

	/** How long a routine needs-you line waits for others before the hold is pushed; 0 pushes at the poll that finds it. */
	get batchMs(): number {
		const raw = this.env[BATCH_MS_ENV];
		const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
		return Number.isFinite(n) && n >= 0 ? n : BATCH_MS;
	}

	/** How long Jo's silence must last for his next turn to carry the complete list. */
	get quietMs(): number {
		const n = Number(this.env[QUIET_MS_ENV]);
		return Number.isFinite(n) && n > 0 ? n : QUIET_MS;
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
		const path = voicePath(this.env);
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
