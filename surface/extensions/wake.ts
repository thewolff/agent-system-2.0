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
// state changes. The tick's catch-up lines go to their own queue (`tickNotices`) and are pushed as
// `surface-notices` asides with the same confirmation, resends and fallback as a wake; while a wake
// is pending or in flight they wait and ride it. Jo's word echoes (`notices`) are never pushed.
//
// Batched arrivals (PLAN wl-mv5msri070p0qo D3, D4): a poll records the new lines in `delivered` but
// consumes nothing at the take. An on-fire line (surface/src/batch.ts onFire) is pushed on its own
// poll with the hold re-checked beside it; every other line joins the session's hold, and the first
// held line opens a fixed window of `batchMs`, after which the hold goes out as one aside. Whatever
// goes out, pushed or taken by Jo's turn, is re-checked against a fresh read and its messages are
// consumed then. `brb` (surface/extensions/surface-input.ts) holds the routine lines until `back`:
// on-fire lines still go out, alone, and a turn other than `back` leaves the hold. `back`, and a turn
// after a quiet stretch, carry the complete `pending` block, after the wake render when the turn
// takes one. Every needs-you push and every Jo turn ends with the `open answer lines:` count. A wake
// render clears the hold; an `orchestrator_ledger` read takes the lines it showed out of it.
//
// Every pushed message, and Jo's turn message when it re-renders a pushed one, carries
// `details.surfaceKey` (`wake:<id>`, `notices:<id>`, shared by a push's resends and its re-render)
// and `details.renderSeq`. The `context` hook keeps the newest message per key after the last
// assistant message, so copies OMP queued without a turn (the ACP defer branch) reach the model once,
// and drops there the copies of a wake a later trigger superseded unconfirmed (its key retired).
//
// Plan paths (PLAN wl-mv61a8dh4aeneo D2): every text this row produces — the wake render (the pushed
// wake, Jo's turn, `orchestrator_ledger`), the needs-you block (the `surface-needs-you` aside and Jo's
// turn) and each tick line as it is queued — carries an open plan question's path beneath each line
// naming it (surface/src/plan-paths.ts), decorated once where it is produced.
//
// Question links (PLAN wl-mv66q5b148uznk § The rule): each tick also walks the open linked questions
// (`refreshLinks`). One with no `question-links:` entry (raised before links existed) gets its links
// computed — legacy verdict files materialized, the PRs read — and recorded as the surface; the needs-you
// render computes the same links in memory until then (surface/src/errors.ts `shownLinks`). One with an
// entry has its PRs re-read every tick while its last read failed (`pr: unverified`), at most every
// LINKS_REREAD_MS otherwise, and a newer entry is recorded only when its link lines changed — never for
// a failed read alone, which shows nothing new. A changed entry re-delivers the question's line.
import { CONTRACT_MARKER, contractPath, injectContract } from "../../gates/src/rows/r02-contract";
import { BACK_HEADING, countLine, lineKey, NEEDS_YOU_HEADING, onFire, pendingText, present, QUIET_HEADING, surfaceWord } from "../src/batch";
import { consumeAllToOrchestrator, consumeLines, needsYouBlock } from "../src/delivery";
import { type ErrorLine, errorLines, linksState } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { questionSubject } from "../src/orchestrator-question";
import { withPlanPathsOrWarn } from "../src/plan-paths";
import { isLinkedQuestion, type Links, linksAtRaise, questionLinks, recordQuestionLinks } from "../src/question-links";
import { renderWake } from "../src/render";
import { type SurfaceSession, surfaceSession, voiceInPrompt, voiceSection, type WakeTrigger } from "../src/session";
import { recordLapsedLeases } from "../src/signals";
import { type Ctx, HOLD_HOURS, type HostMessage, LEDGER_TOOL, LINKS_REREAD_MS, PUSH_TRIES, STANDING_WORKLOAD_ID, type SurfaceAPI, SURFACE_BY, WAKE_READ_TOOL } from "../src/types";
import { launchVerdict, triggerLaunch } from "./launch";
import { showPending } from "./surface-input";
import { closeWorkloadWithEntry } from "./workload";

const APPLIED_HEADING = "## Applied from the surface since your last turn";

/**
 * `text` with each open plan question's path beneath the line naming it (PLAN wl-mv61a8dh4aeneo D2),
 * applied once where surface text is produced; a ledger read error keeps the text and warns.
 */
function planned(s: SurfaceSession, ctx: Ctx, text: string): string {
	return withPlanPathsOrWarn(() => s.ledger(), s.numbering, text, (m) => ctx.ui.notify(m, "warning"));
}

/** Queue one tick line for the `surface-notices` push and Jo's next Applied block, decorated as it is queued (D2), so every route carries it as stored. */
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

/** Empty the hold and close its window. */
function dropHold(s: SurfaceSession): void {
	s.heldNeedsYou.clear();
	s.holdSince = null;
}

/** Take `shown` (lines a render put in front of the orchestrator) out of the hold; an emptied hold closes its window. */
function unhold(s: SurfaceSession, shown: readonly ErrorLine[]): void {
	for (const l of shown) s.heldNeedsYou.delete(lineKey(l));
	if (s.heldNeedsYou.size === 0) s.holdSince = null;
}

/**
 * Record the lines of `lines` new since the session's last delivery (D3), consuming nothing: the
 * on-fire ones are returned, every other one joins the hold by identity (the first opens the window).
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
		if (s.heldNeedsYou.size === 0) s.holdSince = Date.parse(s.now());
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
 * The wake turn's text: the ledger rendered for `trigger` (the standing workload ensured, lapsed
 * leases recorded, the delivered tracker reseeded, held orchestrator-bound messages consumed) with
 * the plan paths beneath their mentions, the owed-read line, and `ticks` (decorated when queued)
 * under the Applied heading. A render failure says so instead.
 */
function renderWakeTurn(s: SurfaceSession, ctx: Ctx, trigger: WakeTrigger, ticks: readonly string[]): string {
	let text: string;
	try {
		const ledger = s.ledger();
		ensureStandingWorkload(ledger);
		const now = s.now();
		recordLapsedLeases(ledger, SURFACE_BY, now);
		const rendered = renderWake(ledger, { trigger, holdHours: HOLD_HOURS, now, numbering: s.numbering });
		text = planned(s, ctx, rendered.text);
		s.delivered.take(rendered.lines);
		dropHold(s);
		consumeAllToOrchestrator(ledger);
	} catch (err) {
		text = `# Ledger could not be rendered (wake: ${trigger})\n\n${String(err)}\n\nSay so; do not reconstruct state from memory.`;
	}
	const parts = [text, "", `This turn owes one wake-read entry: call ${WAKE_READ_TOOL} with what you resume before any other tool call. Your first message restates what is in flight from this render, needs-you first.`];
	if (ticks.length > 0) parts.push("", appliedBlock(ticks));
	return parts.join("\n");
}

/**
 * Take the pending wake: clear the mark, render it, owe the read. Synchronous from the test to the
 * clear, so a push and Jo's turn cannot both take one wake. The id is the fallen-back wake's when
 * there is one, so a re-render shares its key. With `withTicks` (a push) the queued tick lines ride
 * the render, except those of a batch in flight and all of them once a batch fell back to Jo's turn.
 */
function takeWake(s: SurfaceSession, ctx: Ctx, withTicks: boolean): { wakeId: string; trigger: WakeTrigger; text: string; carried: string[] } | null {
	if (!s.pending) return null;
	const trigger = s.pending;
	s.pending = null;
	const wakeId = s.pendingWakeId ?? s.mintId();
	s.pendingWakeId = null;
	const carried = withTicks && !s.noticesExhausted ? without(s.tickNotices, s.noticesInFlight?.lines ?? []) : [];
	const text = renderWakeTurn(s, ctx, trigger, carried);
	s.owed = { trigger, since: new Date().toISOString() };
	return { wakeId, trigger, text, carried };
}

/** A message's push key, or null for a message the surface did not key. */
function pushKey(m: HostMessage): { surfaceKey: string; renderSeq: number; supersedes: string[] } | null {
	const d = m.details as { surfaceKey?: unknown; renderSeq?: unknown; supersedes?: unknown } | null | undefined;
	if (!d || typeof d.surfaceKey !== "string" || typeof d.renderSeq !== "number") return null;
	return { surfaceKey: d.surfaceKey, renderSeq: d.renderSeq, supersedes: Array.isArray(d.supersedes) ? d.supersedes.filter((k): k is string => typeof k === "string") : [] };
}

/**
 * Does `fresh` name other link lines than `recorded` (`linksState`)? A failed PR read over a verified
 * entry is no change unless the other lines moved: it lists the same recorded PRs and adds only that it failed.
 */
function linksChanged(recorded: Links, fresh: Links): boolean {
	const now = linksState(fresh);
	if (now === linksState(recorded)) return false;
	if (fresh.prs.unverified === null || recorded.prs.unverified !== null) return true;
	return now.split("\n").filter((l) => l !== "pr: unverified").join("\n") !== linksState(recorded);
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
	// all), and the held orchestrator-bound messages it shows move to `delivered`. Quiet by default
	// still holds: nothing is pushed.
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
			return { content: [{ type: "text", text: planned(s, ctx, rendered.text) }] };
		},
	});

	/** Send one keyed aside that starts a turn on an idle session. */
	const sendKeyed = (s: SurfaceSession, customType: string, content: string, surfaceKey: string): void => {
		pi.sendMessage?.({ customType, content, display: true, details: { surfaceKey, renderSeq: s.nextSeq() } }, { deliverAs: "aside", triggerTurn: true });
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
		const wake = takeWake(s, ctx, true)!;
		const content = primed
			? wake.text
			: [voiceSection(s.voice()), `# Output-types contract (${contractPath(env)})\n\n${injectContract([], env)[0]}`, wake.text].join("\n\n");
		s.wakeInFlight = { wakeId: wake.wakeId, trigger: wake.trigger, content, tries: 1, carried: wake.carried };
		sendKeyed(s, "surface-wake", content, `wake:${wake.wakeId}`);
	};

	/**
	 * Push the queued tick lines as one `surface-notices` batch (Fix 2), never while a wake is pending
	 * or in flight (they ride it). A new batch goes out busy or idle (a busy session takes it at its
	 * next step boundary); with `resend` (the poll, idle) a batch in flight is sent again, PUSH_TRIES
	 * sends in all, and then every tick line waits for Jo's turn, which renders them under its key.
	 */
	const pushNotices = (s: SurfaceSession, ctx: Ctx, resend: boolean): void => {
		if (!s.active || !pi.sendMessage || s.pending || s.wakeInFlight) return;
		const flight = s.noticesInFlight;
		if (flight) {
			if (!resend || ctx.isIdle?.() === false) return;
			if (flight.tries < PUSH_TRIES) {
				flight.tries++;
				sendKeyed(s, "surface-notices", flight.content, `notices:${flight.batchId}`);
				return;
			}
			s.noticesInFlight = null;
			s.noticesExhausted = true;
			s.pendingNoticesId = flight.batchId;
			return;
		}
		if (s.noticesExhausted || s.tickNotices.length === 0) return;
		const lines = [...s.tickNotices];
		const batch = { batchId: s.mintId(), lines, content: appliedBlock(lines), tries: 1 };
		s.noticesInFlight = batch;
		sendKeyed(s, "surface-notices", batch.content, `notices:${batch.batchId}`);
	};

	/**
	 * One poll: show a `pending` Jo typed while busy, now idle; push or resend the wake; while one is
	 * pending or in flight stay quiet (it carries everything); else the needs-you lines (D3): on-fire
	 * lines go out at once, with the re-checked hold unless Jo is away; otherwise the hold goes out as
	 * one aside at the first poll at or after its window's end, never while away. Then the tick's queue.
	 */
	const poll = (s: SurfaceSession, ctx: Ctx): void => {
		if (!pi.sendMessage) return;
		if (s.pendingDisplay && ctx.isIdle?.() !== false) {
			s.pendingDisplay = false;
			showPending(pi, s);
		}
		pushWake(s, ctx, true);
		if (s.pending || s.wakeInFlight) return;
		try {
			const lines = readLines(s);
			const fire = takeFresh(s, lines);
			const away = s.away !== null;
			const due = !away && s.holdSince !== null && Date.parse(s.now()) >= s.holdSince + s.batchMs;
			const out = fire.length > 0 || due ? release(s, lines, fire, !away) : [];
			if (out.length > 0) {
				const content = [planned(s, ctx, needsYouBlock(out, NEEDS_YOU_HEADING)), "", countLine(s.ledger())].join("\n");
				pi.sendMessage({ customType: "surface-needs-you", content, display: true }, { deliverAs: "aside", triggerTurn: true });
			}
		} catch (err) {
			pi.sendMessage({ customType: "surface-needs-you", content: `## needs you\n- the ledger could not be read between wakes: ${String(err)}`, display: true }, { deliverAs: "aside", triggerTurn: true });
		}
		pushNotices(s, ctx, true);
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
			pushNotices(s, ctx, false);
		}
	};

	/** Per surface session: whether a links pass is running, and when each open linked question's PRs were last read successfully (ms). */
	const linkPasses = new WeakMap<SurfaceSession, { running: boolean; readAt: Map<string, number> }>();

	/**
	 * The tick's links pass (PLAN wl-mv66q5b148uznk § The rule): every open linked question — a lane's on its
	 * workload and slice, an orchestrator's on its subject with no slice — with no `question-links:` entry,
	 * or whose PRs are due a re-read, gets its links computed now (`linksAtRaise`: legacy verdicts
	 * materialized, PRs read and recorded as `pr-seen:`) and recorded as the surface when there was no
	 * entry or `linksChanged`. One pass at a time; a question's failure is a stderr line, never the pass's.
	 */
	const refreshLinks = async (s: SurfaceSession): Promise<void> => {
		const exec = pi.exec?.bind(pi);
		if (!exec) return;
		let pass = linkPasses.get(s);
		if (!pass) {
			pass = { running: false, readAt: new Map() };
			linkPasses.set(s, pass);
		}
		if (pass.running) return;
		pass.running = true;
		try {
			const ledger = s.ledger();
			const open = new Set<string>();
			for (const { workload, openQuestions } of ledger.inFlight()) {
				for (const q of openQuestions) {
					if (!isLinkedQuestion(q.options)) continue;
					const orchestrator = workload.id === STANDING_WORKLOAD_ID;
					const subject = orchestrator ? questionSubject(ledger, q.id) : workload.id;
					if (!subject) continue;
					open.add(q.id);
					const sliceId = orchestrator ? null : q.slice_id;
					const recorded = questionLinks(ledger, subject, q.id);
					const now = Date.parse(s.now());
					const readAt = pass.readAt.get(q.id) ?? (recorded ? Date.parse(recorded.createdAt) : Number.NEGATIVE_INFINITY);
					if (recorded && recorded.links.prs.unverified === null && now - readAt < LINKS_REREAD_MS) continue;
					try {
						const fresh = await linksAtRaise(exec, ledger, { workloadId: subject, sliceId, by: SURFACE_BY });
						if (fresh.prs.unverified === null) pass.readAt.set(q.id, now);
						if (recorded && !linksChanged(recorded.links, fresh)) continue;
						// The question may have been answered while the PRs were read.
						if (ledger.question(q.id)?.state !== "open") continue;
						recordQuestionLinks(ledger, { by: SURFACE_BY, workloadId: subject, sliceId, questionId: q.id, links: fresh });
					} catch (err) {
						process.stderr.write(`surface: the links of ${q.id} could not be refreshed: ${String(err)}\n`);
					}
				}
			}
			for (const id of [...pass.readAt.keys()]) if (!open.has(id)) pass.readAt.delete(id);
		} finally {
			pass.running = false;
		}
	};

	/**
	 * A wake trigger: a new wake with its own key and tries, superseding any earlier one, and its push
	 * one WAKE_PUSH_MS later. The key of a superseded wake that was in flight or fell back is retired,
	 * so the `context` guard drops the copies of it OMP's ACP branch deferred to Jo's next prompt.
	 */
	const triggerWake = (s: SurfaceSession, ctx: Ctx, trigger: WakeTrigger): void => {
		const superseded = s.wakeInFlight?.wakeId ?? s.pendingWakeId;
		if (superseded) s.retiredKeys.add(`wake:${superseded}`);
		s.pending = trigger;
		s.pendingWakeId = null;
		s.wakeInFlight = null;
		s.wakeExhausted = false;
		ctx.setTimeout(() => pushWake(s, ctx, false), s.wakePushMs);
	};

	pi.on("session_start", (_e, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
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
				// The catch-up's own push of its notices can throw through the same sendMessage: a stderr line, never a
				// second send (it would throw again) and never an unhandled rejection; the lines stay queued for the next push.
				catchUp(s, ctx).catch((err: unknown) => {
					process.stderr.write(`surface: the tick's catch-up failed: ${String(err)}\n`);
				});
				refreshLinks(s).catch((err: unknown) => {
					process.stderr.write(`surface: the tick's links pass failed: ${String(err)}\n`);
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
		// D4: `back` ends `brb` whatever else this turn carries; a quiet stretch is marked once, by the input that ended it.
		const back = surfaceWord(event.prompt) === "back";
		if (back) s.away = null;
		const quiet = s.quietTurn;
		s.quietTurn = false;
		const parts: string[] = [];
		const keys: string[] = [];
		const wake = takeWake(s, ctx, false);
		if (wake) {
			parts.push(wake.text);
			keys.push(`wake:${wake.wakeId}`);
		}
		try {
			// D3: the turn takes the re-checked hold with its fresh lines, except while away, where only `back` drains it.
			// A wake render carries every line and cleared the hold; `back` and a quiet stretch still get the complete block after it.
			let out: ErrorLine[] = [];
			if (!wake) {
				const lines = readLines(s);
				out = release(s, lines, takeFresh(s, lines), s.away === null);
			}
			const gap = (): string[] => (parts.length > 0 ? [""] : []);
			if (back) parts.push(...gap(), planned(s, ctx, needsYouBlock(out, BACK_HEADING)), "", pendingText(s.ledger()));
			else {
				if (out.length > 0) parts.push(planned(s, ctx, needsYouBlock(out, NEEDS_YOU_HEADING)));
				if (quiet) parts.push(...gap(), `## ${QUIET_HEADING}`, pendingText(s.ledger()));
			}
		} catch (err) {
			parts.push(...(parts.length > 0 ? [""] : []), `## needs you\n- the ledger could not be read for this turn: ${String(err)}`);
		}
		// Jo's echoes first, then the tick's queue, a batch in flight or fallen back included: rendered here, never pushed again.
		const batchId = s.noticesInFlight?.batchId ?? s.pendingNoticesId;
		if (batchId) keys.push(`notices:${batchId}`);
		s.noticesInFlight = null;
		s.pendingNoticesId = null;
		s.noticesExhausted = false;
		const applied = [...s.notices, ...s.tickNotices];
		s.notices.length = 0;
		s.tickNotices.length = 0;
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
	// emitInputMessages) and for an aside it folds into context without a turn (agent-session.ts
	// #foldStrandedIrcAsidesIntoContext, plan mode or after an Esc); both reach extension handlers
	// through #emitSessionEvent → #emitExtensionEvent (OMP 18.4.4). A confirmed push leaves the
	// in-flight record and takes exactly the tick lines it carried off the queue.
	pi.on("message_end", (event, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		const key = pushKey(event.message)?.surfaceKey;
		if (!key) return undefined;
		const wake = s.wakeInFlight;
		if (wake && key === `wake:${wake.wakeId}`) {
			s.wakeInFlight = null;
			s.tickNotices.splice(0, s.tickNotices.length, ...without(s.tickNotices, wake.carried));
		}
		const batch = s.noticesInFlight;
		if (batch && key === `notices:${batch.batchId}`) {
			s.noticesInFlight = null;
			s.tickNotices.splice(0, s.tickNotices.length, ...without(s.tickNotices, batch.lines));
		}
		return undefined;
	});

	// Duplicate guard: OMP's ACP branch queues a deferred aside without message_end and the next
	// prompt appends the whole queue (agent-session.ts:8361-8363, :7443-7449), so a resend or a
	// fallen-back wake can reach the model more than once. After the last assistant message, drop
	// every message whose surfaceKey a later trigger retired (a superseded wake), and keep per
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
