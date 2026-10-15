// Wake = the ledger rendered (SPEC-2.0.md § B7) for the orchestrator: at session start (fresh or
// resumed) and after every compaction the first context is `renderWake` — never a hand's prose.
// The voice document (voice/VOICE.md, DESIGN-2.0.md C2.1) rides in the system prompt of every turn.
// `bin/as2` puts it and the output-types contract in the base prompt at launch, so an aside-started
// turn and Jo's turn send the same system bytes and the prompt cache survives a restart; Jo's turn
// appends the voice only when the base prompt lacks it. Resume is enforced the way P-11 row 7
// enforces it for lanes: after a wake the first turn owes one wake-read entry on the standing
// workload; every other tool call is refused until it exists, and the turn's stop is blocked too.
//
// Ilex speaks first (MIGRATION.md item 37): a pending wake is pushed as an aside
// (ExtensionAPI.sendMessage, deliverAs "aside"; an idle session starts a turn on it) one second after
// session_start / session_compact (ctx.setTimeout, WAKE_PUSH_MS) or at the next poll, when the
// session is idle. OMP runs no before_agent_start on an aside-started turn, so when the base prompt
// lacks the voice (a launch without bin/as2), the first push of a process, before any turn of Jo's
// primed the system prompt, carries the voice document and the output-types contract
// (gates/src/rows/r02-contract.ts) inline ahead of the render. A push counts as
// delivered only when its `message_end` arrives (a turn's input message, or an aside OMP folds into
// context); an unconfirmed one is resent at the next idle polls, PUSH_TRIES sends in all, then falls
// back to pending for Jo's next turn and nothing pushes it until that turn or a new trigger. A wake
// Jo's turn finds pending or still unconfirmed rides his turn as before.
//
// Between wakes (Codex B1) the § B3 lines still reach the running surface: every ordinary turn's
// context carries the lines that are new since this session last delivered them, and a poll on
// the session context's timer (OMP ExtensionContext.setInterval, cleared at session_shutdown)
// re-reads the ledger so a question written by a lane, a lane's death, a lane that ended on purpose
// with work open and nobody holding it (MIGRATION.md item 68), or a hold crossing four hours with
// nobody typing is pushed as an aside. Each read first records lapsed leases as lane-died rows
// (surface/src/signals.ts) and each delivery consumes the held orchestrator-bound
// messages behind its lines (surface/src/delivery.ts), so a line is delivered once until its
// state changes. The tick's catch-up lines go to their own queue (`tickNotices`) and never push on
// their own: they ride the next status batch, a pushed wake, or Jo's next turn's Applied block,
// whichever comes first, and leave the queue only through one of them. Jo's word echoes (`notices`)
// are never pushed.
//
// Speaks first (PLAN wl-mv8igegljun18g): a status batch is due at the first idle poll
// `AGENT_SYSTEM_SURFACE_STATUS_MS` (15 min) after the last batch, wake render or `back`, with no wake
// pending or in flight, no batch in flight or fallen back, and no `brb`. The seat-agnostic core
// (surface/src/status.ts, seat `orchestrator`) keeps the clock, the told set and its floor, the cap
// and the batch in flight; this row feeds it the Ilex items (surface/src/status-ilex.ts): the held
// needs-you lines and any on-fire line found on the same poll, the ledger events since the floor,
// the queued tick lines and the held lane messages, each graded. A batch with an on-fire or
// worth-knowing item is a `surface-status` aside that starts a turn; one with only noise is a
// display-only line that starts none. Either is confirmed by its `message_end` under `status:<id>`,
// and only then are its identities told, its messages delivered and its tick lines dequeued; an
// unconfirmed one is resent at idle polls that push nothing else (never while away), PUSH_TRIES
// sends in all, then falls back, so a poll sends one aside at most. A wake trigger, `back` or Jo's
// turn (while `brb` stands, only `back`) takes over a batch in flight or fallen back: its key is
// retired, its needs-you lines go back into the hold, and the taking render carries one fresh delta
// (`## since <HH:MMZ>`). The wake render carries that delta too and consumes only the messages it
// rendered whole; an `orchestrator_ledger` read marks told the events its blocks show.
//
// Batched arrivals (PLAN wl-mv5msri070p0qo D3, D4): a poll records the new lines in `delivered` but
// consumes nothing at the take. An on-fire line (surface/src/batch.ts onFire) is pushed on its own
// poll with the hold re-checked beside it, or rides the status batch when one is due on that poll;
// every other line joins the session's hold for the next status batch. Whatever goes out, pushed or
// taken by Jo's turn, is re-checked against a fresh read. `brb` (surface/extensions/surface-input.ts)
// holds the routine lines, the tick queue and the status batch until `back`: on-fire lines still go
// out, alone, and a turn other than `back` leaves the hold, the queue and the batch. `back`, and a
// turn after a quiet stretch, carry the complete `pending` block, after the wake render when the
// turn takes one. Every needs-you push, status batch and Jo turn ends with the
// `open answer lines:` count. A wake render clears the hold; an
// `orchestrator_ledger` read takes the lines it showed out of it.
//
// Every pushed message, and Jo's turn message when it re-renders a pushed one, carries
// `details.surfaceKey` (`wake:<id>`, `status:<id>`, shared by a push's resends and its re-render)
// and `details.renderSeq`. The `context` hook keeps the newest message per key after the last
// assistant message, so copies OMP queued without a turn (the ACP defer branch) reach the model once,
// and drops there the copies of a wake or batch a later trigger or takeover retired unconfirmed.
//
// Plan paths (PLAN wl-mv61a8dh4aeneo D2): every text this row produces — the wake render (the pushed
// wake, Jo's turn, `orchestrator_ledger`), the needs-you block (the `surface-needs-you` aside and Jo's
// turn), each status item (a batch's and a delta section's, decorated as `ilexItems` builds it, so the
// cap measures the text as sent: PLAN wl-mv8igegljun18g [R3-5]) and each tick line as it is queued —
// carries an open plan question's path beneath each line naming it (surface/src/plan-paths.ts),
// decorated once where it is produced.
import { dirname } from "node:path";
import { CONTRACT_MARKER, contractPath, injectContract } from "../../gates/src/rows/r02-contract";
import { defaultLedgerPath } from "../../ledger/src/locality";
import { BACK_HEADING, countLine, lineKey, NEEDS_YOU_HEADING, onFire, openAnswerCount, pendingText, present, QUIET_HEADING, surfaceWord } from "../src/batch";
import { consumeAllToOrchestrator, consumeIds, consumeLines, needsYouBlock } from "../src/delivery";
import { type ErrorLine, errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { withPlanPathsOrWarn } from "../src/plan-paths";
import { renderWake } from "../src/render";
import { type SurfaceSession, surfaceSession, voiceInPrompt, voiceSection, type WakeTrigger } from "../src/session";
import { recordLapsedLeases } from "../src/signals";
import { hhmm, type Receipt, receiptOf, StatusCore } from "../src/status";
import { DELTA_SECTIONS, ILEX_SEAT, ILEX_SECTIONS, ilexItems, lineRefs, MESSAGES_SECTION, tickRefs } from "../src/status-ilex";
import { type Ctx, HOLD_HOURS, type HostMessage, LEDGER_TOOL, PUSH_TRIES, STANDING_WORKLOAD_ID, STATUS_DELTA_CHARS, type SurfaceAPI, SURFACE_BY, WAKE_READ_TOOL } from "../src/types";
import { launchVerdict, triggerLaunch } from "./launch";
import { showPending } from "./surface-input";
import { closeWorkloadWithEntry } from "./workload";

const APPLIED_HEADING = "## Applied from the surface since your last turn";
/** Characters a status batch or delta section spends outside its bullets (headings, blank lines), counted against the cap. */
const DELTA_OVERHEAD = 200;

/**
 * `text` with each open plan question's path beneath the line naming it (PLAN wl-mv61a8dh4aeneo D2),
 * applied once where surface text is produced; a ledger read error keeps the text and warns.
 */
function planned(s: SurfaceSession, ctx: Ctx, text: string): string {
	return withPlanPathsOrWarn(() => s.ledger(), s.numbering, text, (m) => ctx.ui.notify(m, "warning"));
}

/** Queue one tick line for the next status batch, pushed wake or Jo's Applied block, decorated as it is queued (D2), so every route carries it as stored. */
function tick(s: SurfaceSession, ctx: Ctx, line: string): void {
	s.tickNotices.push(planned(s, ctx, line));
}

/** The lines owed now, after this read's own writes (lapsed leases persisted as lane-died rows), numbered with the session's numbering. */
function readLines(s: SurfaceSession): ErrorLine[] {
	const ledger = s.ledger();
	const now = s.now();
	recordLapsedLeases(ledger, SURFACE_BY, now);
	return s.numbering.assign(errorLines(ledger, ledger.inFlight(), { now, holdHours: HOLD_HOURS }));
}

/** Empty the hold. */
function dropHold(s: SurfaceSession): void {
	s.heldNeedsYou.clear();
}

/** Take `shown` (lines a render put in front of the orchestrator) out of the hold. */
function unhold(s: SurfaceSession, shown: readonly ErrorLine[]): void {
	for (const l of shown) s.heldNeedsYou.delete(lineKey(l));
}

/**
 * Record the lines of `lines` new since the session's last delivery (D3), consuming nothing: the
 * on-fire ones are returned, every other one joins the hold by identity for the next status batch.
 */
function takeFresh(s: SurfaceSession, lines: ErrorLine[]): ErrorLine[] {
	const ledger = s.ledger();
	const fire: ErrorLine[] = [];
	for (const l of s.delivered.take(lines)) {
		if (onFire(ledger, l)) {
			fire.push(l);
			s.heldNeedsYou.delete(lineKey(l));
			continue;
		}
		s.heldNeedsYou.add(lineKey(l));
	}
	return fire;
}

/**
 * What goes out now: `fire`, plus with `withHold` every held identity still present in `lines` (the
 * re-check against a fresh read, current text and `#n`), in `lines`' order. Exactly these lines'
 * messages are consumed, here at the push; a taken hold is emptied.
 */
function release(s: SurfaceSession, lines: ErrorLine[], fire: ErrorLine[], withHold: boolean): ErrorLine[] {
	const keys = new Set(fire.map(lineKey));
	if (withHold) {
		for (const k of s.heldNeedsYou) keys.add(k);
		dropHold(s);
	}
	const out = present(keys, lines);
	if (out.length > 0) consumeLines(s.ledger(), out);
	return out;
}

/** `lines` less one occurrence of each of `drop`: a line queued twice leaves once per message that carried it. */
function without(lines: readonly string[], drop: readonly string[]): string[] {
	const out = [...lines];
	for (const d of drop) {
		const i = out.indexOf(d);
		if (i >= 0) out.splice(i, 1);
	}
	return out;
}

function appliedBlock(lines: readonly string[]): string {
	return [APPLIED_HEADING, ...lines.map((n) => `- ${n}`)].join("\n");
}

/**
 * The delta a render a turn carries (the wake, a takeover, `back`; PLAN wl-mv8igegljun18g D2a): the
 * in-flight events and held lane messages the core has not told, each with its plan paths, under the
 * cap, as a `## since <HH:MMZ>` section (null when it has nothing), and what confirming it moves.
 * `current` is the fresh read whose lines own their messages (never lane-message bullets).
 */
function renderDelta(s: SurfaceSession, ctx: Ctx, core: StatusCore, current: readonly ErrorLine[]): { section: string | null; receipt: Receipt } {
	const delta = core.delta(
		ilexItems(s.ledger(), core, {
			needsYou: [], fire: new Set(), current, ticks: [], delivered: (k) => s.delivered.has(k), readAt: s.now(), countUnchanged: false, decorate: (text) => planned(s, ctx, text),
		}),
		DELTA_OVERHEAD,
	);
	return { section: core.section(delta, { heading: `## since ${hhmm(delta.since)}`, sections: DELTA_SECTIONS }), receipt: receiptOf(delta) };
}

/** Retire the status batch in flight or fallen back (D3 takeover): its key joins the retired keys and its needs-you lines go back into the hold. */
function takeoverStatus(s: SurfaceSession): boolean {
	const b = s.status?.takeover();
	if (!b) return false;
	s.retiredKeys.add(b.key);
	for (const k of lineRefs(b.receipt.refs)) s.heldNeedsYou.add(k);
	return true;
}

/**
 * The wake turn's text: the ledger rendered for `trigger` (the standing workload ensured, lapsed
 * leases recorded, the delivered tracker reseeded, the hold cleared) with its delta section
 * (PLAN wl-mv8igegljun18g D2a) and the plan paths beneath their mentions, the owed-read line, and
 * `ticks` (decorated when queued) under the Applied heading; and the receipt that moves, at the
 * render's confirmation, its delta's identities and messages and its lines' messages. A render
 * failure says so instead, with no receipt. The status interval restarts.
 */
function renderWakeTurn(s: SurfaceSession, ctx: Ctx, core: StatusCore, trigger: WakeTrigger, ticks: readonly string[]): { text: string; receipt: Receipt | null } {
	let text: string;
	let receipt: Receipt | null = null;
	try {
		const ledger = s.ledger();
		ensureStandingWorkload(ledger);
		const now = s.now();
		recordLapsedLeases(ledger, SURFACE_BY, now);
		const rendered = renderWake(ledger, { trigger, holdHours: HOLD_HOURS, now, numbering: s.numbering });
		s.delivered.take(rendered.lines);
		dropHold(s);
		const delta = renderDelta(s, ctx, core, rendered.lines);
		const wakeText = planned(s, ctx, rendered.text);
		text = delta.section ? `${wakeText}\n\n${delta.section}` : wakeText;
		receipt = { ...delta.receipt, messageIds: [...delta.receipt.messageIds, ...rendered.lines.flatMap((l) => l.messageIds ?? [])] };
		core.reset();
	} catch (err) {
		text = `# Ledger could not be rendered (wake: ${trigger})\n\n${String(err)}\n\nSay so; do not reconstruct state from memory.`;
	}
	const parts = [text, "", `This turn owes one wake-read entry: call ${WAKE_READ_TOOL} with what you resume before any other tool call. Your first message restates what is in flight from this render, needs-you first.`];
	if (ticks.length > 0) parts.push("", appliedBlock(ticks));
	return { text: parts.join("\n"), receipt };
}

/**
 * Take the pending wake: clear the mark, render it, owe the read. Synchronous from the test to the
 * clear, so a push and Jo's turn cannot both take one wake. The id is the fallen-back wake's when
 * there is one, so a re-render shares its key. With `withTicks` (a push) the queued tick lines ride
 * the render (a wake trigger took over any status batch, so none is in flight).
 */
function takeWake(s: SurfaceSession, ctx: Ctx, core: StatusCore, withTicks: boolean): { wakeId: string; trigger: WakeTrigger; text: string; carried: string[]; receipt: Receipt | null } | null {
	if (!s.pending) return null;
	const trigger = s.pending;
	s.pending = null;
	const wakeId = s.pendingWakeId ?? s.mintId();
	s.pendingWakeId = null;
	const carried = withTicks ? [...s.tickNotices] : [];
	const { text, receipt } = renderWakeTurn(s, ctx, core, trigger, carried);
	s.owed = { trigger, since: new Date().toISOString() };
	return { wakeId, trigger, text, carried, receipt };
}

/** A message's push key, or null for a message the surface did not key. */
function pushKey(m: HostMessage): { surfaceKey: string; renderSeq: number; supersedes: string[] } | null {
	const d = m.details as { surfaceKey?: unknown; renderSeq?: unknown; supersedes?: unknown } | null | undefined;
	if (!d || typeof d.surfaceKey !== "string" || typeof d.renderSeq !== "number") return null;
	return { surfaceKey: d.surfaceKey, renderSeq: d.renderSeq, supersedes: Array.isArray(d.supersedes) ? d.supersedes.filter((k): k is string => typeof k === "string") : [] };
}

export default function wakeRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	const z = pi.zod;
	pi.registerTool({
		name: WAKE_READ_TOOL,
		loadMode: "essential",
		label: "Record Orchestrator Wake Read",
		description:
			"After a session start or a compaction, record the one wake-read ledger entry stating what you resume, read from the rendered ledger. " +
			"Until it exists every other tool call and the turn's stop are refused (§ B7 verified read).",
		parameters: z.object({
			body: z.string().describe("What you resume: the open workloads and the needs-you lines as read from the render, and your next step."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return { content: [{ type: "text", text: "This session is not the orchestrator surface; no wake read is owed and nothing was recorded." }] };
			const ledger = s.ledger();
			ensureStandingWorkload(ledger);
			const body = String(params.body ?? "").trim();
			if (!body) return { content: [{ type: "text", text: "A wake read needs a body saying what you resume; nothing was recorded." }] };
			const id = ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "wake-read", body });
			s.owed = null;
			return { content: [{ type: "text", text: `Recorded wake-read entry ${id} on ${STANDING_WORKLOAD_ID}.` }], details: { id } };
		},
	});

	// Queryable on demand (M7 fix round 2, finding C): Jo typed `status` and the reply repeated a
	// state the ledger had moved past (a slice done, the lane released, a held message), because the
	// render reached the model only at a wake. This is the same render, on request, with the same
	// consumption: the § B3 lines it shows are recorded as delivered and leave the hold (D3: the
	// orchestrator saw them; a workload-scoped read shows every needs-you line too, so it drops them
	// all), and the held orchestrator-bound messages it shows move to `delivered`. The events its
	// workload blocks show are marked told (PLAN wl-mv8igegljun18g D2a [R5-1]), so the next status
	// batch does not repeat them; the floor does not move. Nothing is pushed.
	pi.registerTool({
		name: LEDGER_TOOL,
		loadMode: "essential",
		label: "Read The Ledger",
		description:
			"The ledger rendered now, the same render a wake gives: needs-you first, then every open workload (or the one you name) with its slices, questions, messages and recent entries. " +
			"Call it first for any ask about state (status, what's open, is X done) and answer from it; a CLAIM about a workload cites this render.",
		parameters: z.object({
			workload: z.string().optional().describe("One workload id (wl-…) to render; omit for every open workload."),
		}),
		approval: "read",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return { content: [{ type: "text", text: "This session is not the orchestrator surface; nothing was read." }] };
			const ledger = s.ledger();
			ensureStandingWorkload(ledger);
			const wl = typeof params.workload === "string" && params.workload.trim() ? params.workload.trim() : undefined;
			if (wl && !ledger.inFlight().some((w) => w.workload.id === wl)) {
				const w = ledger.workload(wl);
				return { content: [{ type: "text", text: w ? `${wl} is ${w.status}${w.closed_at ? ` (closed ${w.closed_at})` : ""}; only open workloads are rendered.` : `No workload ${wl}.` }] };
			}
			const now = s.now();
			recordLapsedLeases(ledger, SURFACE_BY, now);
			const rendered = renderWake(ledger, { heading: `read on demand${wl ? `: ${wl}` : ""}`, holdHours: HOLD_HOURS, now, workloadId: wl, numbering: s.numbering });
			s.delivered.take(rendered.lines);
			unhold(s, rendered.lines);
			if (wl) consumeLines(ledger, rendered.lines);
			consumeAllToOrchestrator(ledger, wl);
			statusOf(s).markTold(rendered.told);
			return { content: [{ type: "text", text: planned(s, ctx, rendered.text) }] };
		},
	});

	/** Send one keyed aside that starts a turn on an idle session. */
	const sendKeyed = (s: SurfaceSession, customType: string, content: string, surfaceKey: string): void => {
		pi.sendMessage?.({ customType, content, display: true, details: { surfaceKey, renderSeq: s.nextSeq() } }, { deliverAs: "aside", triggerTurn: true });
	};

	/**
	 * This session's status core (seat `orchestrator`, PLAN wl-mv8igegljun18g D1–D3), created at first use: the cursor
	 * in the ledger's directory (`~/.agent-system-2/orchestrator/status-cursor.json` for the default ledger; a scratch
	 * ledger's own directory otherwise, so a test or a smoke run never writes the live cursor), scoped to the ledger it is
	 * about; a batch pushed as a keyed `surface-status` aside, a quiet line shown as the same custom type with no turn
	 * (`sendMessage(msg, {})`), messages delivered through `consumeIds`.
	 */
	const statusOf = (s: SurfaceSession): StatusCore => {
		if (s.status) return s.status;
		let root: string | null = null;
		let scope: string | undefined;
		try {
			scope = defaultLedgerPath(env);
			root = dirname(scope);
		} catch {
			// no HOME and no ledger override: the core warns once that W and the told set last only this session
		}
		s.status = new StatusCore({
			seat: ILEX_SEAT, root, scope, now: () => s.now(), intervalMs: s.statusMs, deltaChars: STATUS_DELTA_CHARS, tries: PUSH_TRIES, messageNoun: MESSAGES_SECTION,
			push: (content, key) => sendKeyed(s, "surface-status", content, key),
			show: (content, key) => pi.sendMessage?.({ customType: "surface-status", content, display: true, details: { surfaceKey: key, renderSeq: s.nextSeq() } }, {}),
			markDelivered: (ids) => {
				consumeIds(s.ledger(), ids);
			},
		});
		return s.status;
	};

	/**
	 * Push the pending wake as an aside while the session is idle (Fix 1). With `resend` (the poll),
	 * a wake in flight is sent again, PUSH_TRIES sends in all; then it falls back to pending under its
	 * own key with the read no longer owed, and nothing pushes it until Jo's turn or a new trigger.
	 * Until the system prompt carries the voice (the launch's base prompt, or a turn of Jo's), a push inlines the voice document and the contract.
	 */
	const pushWake = (s: SurfaceSession, ctx: Ctx, resend: boolean): void => {
		if (!s.active || !pi.sendMessage || ctx.isIdle?.() === false) return;
		const flight = s.wakeInFlight;
		if (flight) {
			if (!resend) return;
			if (flight.tries < PUSH_TRIES) {
				flight.tries++;
				sendKeyed(s, "surface-wake", flight.content, `wake:${flight.wakeId}`);
				return;
			}
			s.wakeInFlight = null;
			s.pending = flight.trigger;
			s.pendingWakeId = flight.wakeId;
			s.owed = null;
			s.wakeExhausted = true;
			return;
		}
		if (!s.pending || s.wakeExhausted) return;
		const primed = s.promptPrimed;
		const wake = takeWake(s, ctx, statusOf(s), true)!;
		const content = primed
			? wake.text
			: [voiceSection(s.voice()), `# Output-types contract (${contractPath(env)})\n\n${injectContract([], env)[0]}`, wake.text].join("\n\n");
		s.wakeInFlight = { wakeId: wake.wakeId, trigger: wake.trigger, content, tries: 1, carried: wake.carried, receipt: wake.receipt };
		sendKeyed(s, "surface-wake", content, `wake:${wake.wakeId}`);
	};

	/**
	 * Build and send the due status batch (PLAN wl-mv8igegljun18g D2, D3): needs you (the re-checked hold and `fire`,
	 * the hold moving into the batch's record), in flight (events, tick lines), lane messages; a turn-starting
	 * `surface-status` aside, or the display-only quiet line when nothing is on fire or worth knowing (D4).
	 * Nothing is consumed here: the core moves it all at the batch's `message_end`.
	 */
	const sendStatus = (s: SurfaceSession, ctx: Ctx, core: StatusCore, lines: ErrorLine[], fire: ErrorLine[]): void => {
		const ledger = s.ledger();
		const fireKeys = new Set(fire.map(lineKey));
		const needsYou = present(new Set([...fireKeys, ...s.heldNeedsYou]), lines);
		dropHold(s);
		const items = ilexItems(ledger, core, {
			needsYou, fire: fireKeys, current: lines, ticks: s.tickNotices, delivered: (k) => s.delivered.has(k), readAt: s.now(), countUnchanged: true, decorate: (text) => planned(s, ctx, text),
		});
		const delta = core.delta(items, DELTA_OVERHEAD);
		const open = ledger.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM workloads WHERE status = 'open' AND id <> ?").get(STANDING_WORKLOAD_ID)?.n ?? 0;
		const { content, quiet } = core.compose(delta, {
			sections: ILEX_SECTIONS,
			footer: countLine(ledger),
			summary: [`${open} workloads in flight`, `open answer lines: ${openAnswerCount(ledger)}`],
		});
		core.send(delta, content, quiet);
	};

	/**
	 * One poll: show a `pending` Jo typed while busy, now idle; push or resend the wake; while one is
	 * pending or in flight stay quiet (it carries everything). Else the needs-you lines (D3) and the
	 * status clock (PLAN wl-mv8igegljun18g D1): a due batch carries the hold and any on-fire line found
	 * now; with none due, on-fire lines go out at once as `surface-needs-you`, with the re-checked hold
	 * unless Jo is away. One aside per poll at most: only a poll that pushed nothing resends a status
	 * batch in flight (idle, not away), so a resend waits behind an on-fire push and spends no try on it.
	 */
	const poll = (s: SurfaceSession, ctx: Ctx): void => {
		if (!pi.sendMessage) return;
		if (s.pendingDisplay && ctx.isIdle?.() !== false) {
			s.pendingDisplay = false;
			showPending(pi, s);
		}
		pushWake(s, ctx, true);
		if (s.pending || s.wakeInFlight) return;
		const core = statusOf(s);
		const idle = ctx.isIdle?.() !== false;
		const away = s.away !== null;
		try {
			const lines = readLines(s);
			const fire = takeFresh(s, lines);
			if (core.due({ idle, blocked: away })) {
				sendStatus(s, ctx, core, lines, fire);
				return;
			}
			const out = fire.length > 0 ? release(s, lines, fire, !away) : [];
			if (out.length > 0) {
				const content = [planned(s, ctx, needsYouBlock(out, NEEDS_YOU_HEADING)), "", countLine(s.ledger())].join("\n");
				pi.sendMessage({ customType: "surface-needs-you", content, display: true }, { deliverAs: "aside", triggerTurn: true });
				return;
			}
		} catch (err) {
			pi.sendMessage({ customType: "surface-needs-you", content: `## needs you\n- the ledger could not be read between wakes: ${String(err)}`, display: true }, { deliverAs: "aside", triggerTurn: true });
			return;
		}
		if (idle && !away) core.resend();
	};

	/**
	 * The tick catch-up (DESIGN-lane-launcher.md decision 7): every open workload the predicate says
	 * to launch now gets one starter run, so a resolution or a cap slot that arrived with nobody
	 * typing does not wait for Jo's next turn. A workload the predicate refuses as `awaiting-close`
	 * (its holder's `done-because:` stands, nobody holds it) with no open or paused slice and no open
	 * question is closed through the close tool's own path (`closeWorkloadWithEntry`, decision 13:
	 * the entry committed, the close stamped as the surface); one that still has an open or paused
	 * slice or an open question is told once as "finished but cannot close", again only when its
	 * counts change (`s.stuckFinished`). A refused close (the fail-closed close check refuses a served
	 * repo's workload until its PR is green) is retried every poll but told once per refusal text
	 * (`s.refusedClose`), cleared when the workload closes or stops being ready to close. Runs after
	 * the poll persisted lapsed leases; one catch-up at a time; a line per attempt goes to the tick's
	 * queue, pushed when the catch-up ends. The session's `cwd` is the close tool's fallback repository.
	 */
	const catchUp = async (s: SurfaceSession, ctx: Ctx): Promise<void> => {
		if (s.launching || !pi.exec) return;
		s.launching = true;
		try {
			const ledger = s.ledger();
			for (const w of ledger.inFlight()) {
				const id = w.workload.id;
				if (id === STANDING_WORKLOAD_ID) continue;
				const verdict = launchVerdict(ledger, env, id);
				if (verdict?.launch === false && verdict.reason === "awaiting-close") {
					const { open_slices: open, paused_slices: paused, open_questions: questions } = w.workload;
					if (open > 0 || paused > 0 || questions > 0) {
						s.refusedClose.delete(id);
						// Finished but not closable: told once per session until the counts change, never a close or a launch.
						const told = `${open}:${paused}:${questions}`;
						if (s.stuckFinished.get(id) !== told) {
							s.stuckFinished.set(id, told);
							tick(s, ctx, `tick: ${id} is finished but cannot close: ${open} open slice(s), ${paused} paused, ${questions} open question(s) — resolve them or close by hand`);
						}
						continue;
					}
					s.stuckFinished.delete(id);
					try {
						const r = await closeWorkloadWithEntry(pi, ledger, env, id, { now: s.now(), cwd: ctx.cwd, receipt: null });
						if (r.closed) {
							s.refusedClose.delete(id);
							tick(s, ctx, `tick: closed ${id}: ${(r.receipt ?? "").split("\n")[0]} — ${r.entry}`);
						} else if (s.refusedClose.get(id) !== r.text) {
							// Refused: retried every poll, told once per distinct refusal.
							s.refusedClose.set(id, r.text);
							tick(s, ctx, `tick: ${r.text}`);
						}
					} catch (err) {
						tick(s, ctx, `tick: closing ${id} failed: ${String(err)}`);
					}
					continue;
				}
				s.stuckFinished.delete(id);
				s.refusedClose.delete(id);
				if (!verdict?.launch) continue;
				const r = await triggerLaunch(pi, ledger, env, id, "tick");
				if (r.line) tick(s, ctx, `tick: ${r.line}`);
			}
		} catch (err) {
			tick(s, ctx, `tick: the launch catch-up failed: ${String(err)}`);
		} finally {
			s.launching = false;
		}
	};

	/**
	 * A wake trigger: a new wake with its own key and tries, superseding any earlier one, and its push
	 * one WAKE_PUSH_MS later. The key of a superseded wake that was in flight or fell back is retired,
	 * so the `context` guard drops the copies of it OMP's ACP branch deferred to Jo's next prompt; a
	 * status batch in flight or fallen back is taken over the same way (its content rides the wake's delta).
	 */
	const triggerWake = (s: SurfaceSession, ctx: Ctx, trigger: WakeTrigger): void => {
		const superseded = s.wakeInFlight?.wakeId ?? s.pendingWakeId;
		if (superseded) s.retiredKeys.add(`wake:${superseded}`);
		takeoverStatus(s);
		s.pending = trigger;
		s.pendingWakeId = null;
		s.wakeInFlight = null;
		s.wakeExhausted = false;
		ctx.setTimeout(() => pushWake(s, ctx, false), s.wakePushMs);
	};

	pi.on("session_start", (_e, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		// PLAN wl-mv8igegljun18g D2a [R3-2]: W and the told set resume from the last confirmed cursor.
		statusOf(s).load();
		// Launched by bin/as2: the base prompt already carries the voice and the contract, so no push inlines them.
		const base = ctx.getSystemPrompt?.() ?? [];
		if (voiceInPrompt(base) && base.some((p) => p.includes(CONTRACT_MARKER))) {
			s.promptPrimed = true;
			s.voiceInjected = true;
		}
		const resumed = ctx.sessionManager.getEntries().some((e) => e.type === "message");
		if (!s.polling) {
			s.polling = true;
			ctx.setInterval(() => {
				// A poll that throws (a failing sendMessage) is a tick notice, never a skipped catch-up (MIGRATION.md item 71).
				try {
					poll(s, ctx);
				} catch (err) {
					tick(s, ctx, `tick: the poll failed: ${String(err)}`);
				}
				// The catch-up never pushes (its lines ride the next status batch); anything that escapes it is a stderr
				// line, never a send and never an unhandled rejection.
				catchUp(s, ctx).catch((err: unknown) => {
					process.stderr.write(`surface: the tick's catch-up failed: ${String(err)}\n`);
				});
			}, s.pollMs);
		}
		triggerWake(s, ctx, resumed ? "restart" : "session-start");
		return undefined;
	});

	pi.on("session_compact", (_e, ctx) => {
		const s = surfaceSession(ctx, env);
		if (s.active) triggerWake(s, ctx, "compaction");
		return undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		// Already in the base prompt (bin/as2): unchanged, so this turn's system bytes equal an aside-started turn's (r02-contract.ts does the same for the contract).
		const inBase = voiceInPrompt(event.systemPrompt);
		const voice = inBase ? null : s.voice();
		const systemPrompt = voice ? [...event.systemPrompt, voiceSection(voice)] : event.systemPrompt;
		s.voiceInjected = inBase || voice?.text != null;
		s.promptPrimed = true;
		// Jo's turn takes the wake: a pending one, or one pushed and never confirmed, re-rendered under its key.
		const flight = s.wakeInFlight;
		if (flight) {
			s.wakeInFlight = null;
			s.pending = flight.trigger;
			s.pendingWakeId = flight.wakeId;
		}
		s.wakeExhausted = false;
		const core = statusOf(s);
		// D4/D5: `back` ends `brb` whatever else this turn carries and restarts the status clock; a quiet stretch is marked once, by the input that ended it.
		const back = surfaceWord(event.prompt) === "back";
		// D5: while `brb` stands, a turn of Jo's that is not `back` leaves the status batch and the tick queue for `back` to take.
		const stillAway = s.away !== null && !back;
		// D3: a status batch in flight or fallen back is taken over: its key retired, its lines back in the hold, one fresh delta here.
		const tookOver = !stillAway && takeoverStatus(s);
		if (back) {
			s.away = null;
			core.reset();
		}
		const quiet = s.quietTurn;
		s.quietTurn = false;
		const parts: string[] = [];
		const keys: string[] = [];
		const wake = takeWake(s, ctx, core, false);
		if (wake) {
			parts.push(wake.text);
			keys.push(`wake:${wake.wakeId}`);
			// The turn carries the render: what it showed is confirmed now (D2a).
			if (wake.receipt) core.commit(wake.receipt);
		}
		try {
			// D3: the turn takes the re-checked hold with its fresh lines, except while away, where only `back` drains it.
			// A wake render carries every line and cleared the hold; `back` and a quiet stretch still get the complete block after it.
			let out: ErrorLine[] = [];
			let lines: ErrorLine[] = [];
			if (!wake) {
				lines = readLines(s);
				out = release(s, lines, takeFresh(s, lines), s.away === null);
			}
			const gap = (): string[] => (parts.length > 0 ? [""] : []);
			if (back) parts.push(...gap(), planned(s, ctx, needsYouBlock(out, BACK_HEADING)), "", pendingText(s.ledger()));
			else {
				if (out.length > 0) parts.push(planned(s, ctx, needsYouBlock(out, NEEDS_YOU_HEADING)));
				if (quiet) parts.push(...gap(), `## ${QUIET_HEADING}`, pendingText(s.ledger()));
			}
			// D3/D5: a takeover or `back` carries one fresh delta (a wake render already carries its own), confirmed by this turn.
			if (!wake && (tookOver || back)) {
				const delta = renderDelta(s, ctx, core, lines);
				if (delta.section) parts.push(...gap(), delta.section);
				core.commit(delta.receipt);
			}
		} catch (err) {
			parts.push(...(parts.length > 0 ? [""] : []), `## needs you\n- the ledger could not be read for this turn: ${String(err)}`);
		}
		// Jo's echoes first, then the tick's queue (left queued while away): rendered here, never pushed again.
		const applied = stillAway ? [...s.notices] : [...s.notices, ...s.tickNotices];
		s.notices.length = 0;
		if (!stillAway) s.tickNotices.length = 0;
		if (applied.length > 0) parts.push("", appliedBlock(applied));
		let count: string;
		try {
			count = countLine(s.ledger());
		} catch (err) {
			count = `open answer lines: unknown, the ledger could not be read (${String(err)})`;
		}
		parts.push(...(parts.length > 0 ? [""] : []), count);
		const [surfaceKey, ...supersedes] = keys;
		const details = surfaceKey ? { surfaceKey, renderSeq: s.nextSeq(), ...(supersedes.length > 0 ? { supersedes } : {}) } : undefined;
		return { systemPrompt, message: { customType: "surface-wake", content: parts.join("\n"), display: true, ...(details ? { details } : {}) } };
	});

	// Confirmation: OMP emits message_end for a turn's input messages (pi-agent-core agent-loop.ts
	// emitInputMessages), for an aside it folds into context without a turn (agent-session.ts
	// #foldStrandedIrcAsidesIntoContext, plan mode or after an Esc), and for a custom message sent
	// with no turn (#sendCustomMessage: the quiet line); all reach extension handlers through
	// #emitSessionEvent → #emitExtensionEvent (OMP 18.4.4). A confirmed wake commits what its render
	// showed and takes exactly the tick lines it carried off the queue; a confirmed status batch
	// commits through the core (PLAN wl-mv8igegljun18g D2a) and takes its tick lines off the queue.
	// A retired key matches no record and changes nothing.
	pi.on("message_end", (event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		const key = pushKey(event.message)?.surfaceKey;
		if (!key) return undefined;
		const wake = s.wakeInFlight;
		if (wake && key === `wake:${wake.wakeId}`) {
			s.wakeInFlight = null;
			s.tickNotices.splice(0, s.tickNotices.length, ...without(s.tickNotices, wake.carried));
			if (wake.receipt) statusOf(s).commit(wake.receipt);
		}
		const receipt = s.status?.confirm(key);
		if (receipt) s.tickNotices.splice(0, s.tickNotices.length, ...without(s.tickNotices, tickRefs(receipt.refs)));
		return undefined;
	});

	// Duplicate guard: OMP's ACP branch queues a deferred aside without message_end and the next
	// prompt appends the whole queue (agent-session.ts:8361-8363, :7443-7449), so a resend or a
	// fallen-back wake can reach the model more than once. After the last assistant message, drop
	// every message whose surfaceKey a later trigger or takeover retired (a superseded wake, a retired status batch), and keep per
	// surfaceKey only the newest message carrying it (as its own key or one it supersedes).
	// Unretired different keys, unkeyed messages and earlier history are never touched.
	pi.on("context", (event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		const { messages } = event;
		const start = messages.findLastIndex((m) => m.role === "assistant") + 1;
		const tail = messages.slice(start);
		const newest = new Map<string, { seq: number; index: number }>();
		tail.forEach((m, index) => {
			const k = pushKey(m);
			if (!k) return;
			for (const key of [k.surfaceKey, ...k.supersedes]) {
				const seen = newest.get(key);
				if (!seen || k.renderSeq > seen.seq) newest.set(key, { seq: k.renderSeq, index });
			}
		});
		const kept = tail.filter((m, index) => {
			const k = pushKey(m);
			return !k || (!s.retiredKeys.has(k.surfaceKey) && newest.get(k.surfaceKey)!.index === index);
		});
		return kept.length === tail.length ? undefined : { messages: [...messages.slice(0, start), ...kept] };
	});

	pi.on("tool_call", (event, ctx) => {
		const s = surfaceSession(ctx, env);
		return s.active ? (s.check(event.toolName) ?? undefined) : undefined;
	});

	// A `decision: "block"` here schedules a hidden continuation turn and is exempt from OMP's
	// continuation cap (pi-coding-agent/src/session/agent-session.ts:4323, OMP 18.3.0:
	// `if (result?.decision !== "block" && this.#sessionStopContinuationCount >= SESSION_STOP_CONTINUATION_CAP)`),
	// so this block has no ceiling: a model that never calls the wake-read tool is re-prompted until it
	// does. Relied on deliberately — the verified read is the one thing a wake may not skip (§ B7).
	pi.on("session_stop", (_e, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active || !s.owed) return undefined;
		return { decision: "block", reason: `wake (${s.owed.trigger}): the wake-read entry is still owed; call ${WAKE_READ_TOOL} with what you resume.` };
	});
}
