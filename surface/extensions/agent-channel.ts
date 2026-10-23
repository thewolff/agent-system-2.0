// The agent channel's row (PLAN wl-mv8vx7wdj5nx1c rev 6, D1–D3, D5, D6): the inbound drain from the OMP seat mailbox
// into the ledger and into Ilex's context. Orchestrator only (an inactive surface session registers inert handlers).
// The pure half — the sender config, the envelope checks, every ledger write and read, the proposal reader and the
// `## from other agents` block — is surface/src/channel.ts.
//
// Session start reads `channel.senders` from the installed profile config (D1): no block, the channel is off and
// nothing here runs; an invalid block is refused whole, loudly, and nothing here runs either. A valid block puts the
// senders in force on the session's ledger handle (the needs-you lines and the renders read the same senders), opens
// the standing workload, drains once and then every CHANNEL_DRAIN_MS.
//
// The drain (D2) lists `<root>/inbox/ilex/` and touches only two kinds of names: `<id>.json` (claimed by rename to
// `<id>.json.claimed-ilex-<pid>`, or quarantined when the stem is not an envelope id) and `<id>.json.claimed-ilex-<pid>`
// (adopted, first, when the pid is this drain's or no longer alive). Every other name — the writer's
// `<id>.json.<pid>.<uuid>.tmp`, `.invalid` files, anything unknown — is left as it is. Entry names come from the
// directory listing, never from envelope text. A published `<id>.json` whose claim name this drain already holds waits
// beside it (a rename would replace the claim) until that claim is archived. Per claim, resumable from the first
// missing step:
//   validate → collision boundary → record (once per id) → collision boundary → owed an aside … confirmed (or acted on
//   first): `channel-aside:` → ack (tmp + link, no replace) → archive (link, no replace) → unlink the claim.
// No step ever renames over or unlinks a file in `acks/` or `archive/`; quarantine is link + unlink, and a taken
// `.invalid` name gets `<entry>.<uuid>.invalid` instead. Channel text never reaches `apply`, the typed FIFO or a Jo
// row (D6).
//
// The aside is confirmed, never assumed (D2: ack only after the aside reaches the model). OMP's sendMessage is
// fire-and-forget, and a second aside sent while the first one's turn is starting is rejected ("Agent is already
// processing", smoke (x)), so the drain itself records nothing at a send. Every channel message carries
// `details.surfaceKey` (`channel:<msg ids>`), `details.renderSeq` and `details.msgIds`, as the wake row keys its pushes
// (surface/extensions/wake.ts). A tick sends at most one aside, carrying the claims recorded and not yet confirmed;
// a claim stays claimed and is resent at later idle ticks, PUSH_TRIES sends in all, and after that waits for Jo's
// next turn, whose `before_agent_start` re-renders every unconfirmed claim as one keyed message. OMP's `message_end`
// for a channel message (a turn's input, or an aside folded into context) records `channel-aside:` for the ids it
// names, whatever their state, and finishes their ack and archive; a crash in between leaves a claim the next drain
// resumes at the ack. A message Ilex walks to `acted-on` (the reply or done tool, its id read from the block) before
// any confirmation is settled at the next pass instead of resent: `channel-aside: <id> handled-before-aside`, then its
// ack and archive (code review r1 #1). A message whose confirmation falls inside a turn (between `agent_start` and
// `agent_end`) moves to `consumed` right after that confirmation's drain has acked it; one folded in outside a turn
// moves at the next `agent_start` (the observed-turn receipt). A message a late collision withdrew is never consumed.
// At either moment the registry's turn receipt `acks/<id>.turn.json` is written, so the sender's `seat_message`
// reports `acted`, but only with proof the ack at that id is this drain's own: the message is not withdrawn, the
// archive holds the bytes its `channel-in:` sha256 records, and the ack passes the publication path's ack test against
// that envelope (code review r2 #1). Each tick writes a missing receipt again for a consumed or acted-on message with
// its aside entry that moved in the last TURN_RECEIPT_DAYS, and a session's first tick looks back without bound, so a
// restart after any outage recovers one (code review r1 #2, r2 #2). The `context` hook keeps, after the last
// assistant message, only the newest copy of a resent aside.
//
// The tools Ilex answers with (D4) are the tools section at the end of this file: `orchestrator_reply` writes an
// envelope from `Ilex` into a configured sender's inbox (the registry's writer format, tmp + rename), and it and
// `orchestrator_channel_done` walk the `re` messages to `acted-on`, each id checked to be that sender's own channel row
// first.
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "../../ledger/src/index";
import {
	asideText, CHANNEL_ASIDE_TYPE, CHANNEL_DRAIN_MS, type ChannelConfig, channelIn, confirmAsides, consumeAsides, displayName, type Envelope, hasAside, ID_COLLISION,
	ILEX_SLUG, mailboxRoot, msgIdOf, readChannelConfig, recordMessage, recordOut, recordRefused, reRefusal, setChannelInForce, settleHandled, sha256, TURN_RECEIPT_DAYS, turnReceiptsDue,
	validateEnvelope, withdrawnMessages,
} from "../src/channel";
import { ensureStandingWorkload } from "../src/identity";
import { type SurfaceSession, surfaceSession } from "../src/session";
import { CHANNEL_DONE_TOOL, CHANNEL_REPLY_TOOL, type Ctx, type HostMessage, PUSH_TRIES, type SurfaceAPI, type SurfaceMessage, type ToolResult } from "../src/types";

/** The claim suffix this drain writes and adopts: the registry's `.claimed-<owner>` with owner `ilex-<pid>`. */
const claimSuffix = (pid: number): string => `.claimed-${ILEX_SLUG}-${pid}`;
const CLAIMED = new RegExp(`^(.+\\.json)\\.claimed-${ILEX_SLUG}-([0-9]+)$`);
const ENVELOPE_STEM = /^[0-9]+-[0-9a-f-]+$/i;

/** The steps of one claim, in order; `DrainIO.after` sees each as it completes (the crash points a test stops at). */
export type DrainStep = "recorded" | "acked" | "archive-linked";

export interface DrainIO {
	ledger: Ledger;
	config: ChannelConfig;
	/** The mailbox root (`<root>/inbox/ilex`, `<root>/acks`, `<root>/archive`). */
	root: string;
	/** This drain's pid: its claims are `<id>.json.claimed-ilex-<pid>`. */
	pid: number;
	/** Is another drain's pid alive; a dead one's claims are adopted. */
	alive(pid: number): boolean;
	/** After each completed step of a claim; a throw here stops the drain there, as a crash would. */
	after?(step: DrainStep, envelopeId: string): void;
}

/** A claim recorded and owed its aside: no `message_end` has confirmed it yet. `content` is its aside text. */
export interface Unconfirmed {
	msgId: string;
	content: string;
}

/** One pass: the claims it worked on, and those still owed an aside, in the order the pass took them. */
export interface Drained {
	worked: string[];
	unconfirmed: Unconfirmed[];
}

/** `process.kill(pid, 0)`: alive unless it fails with ESRCH (EPERM means alive, owned by someone else). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/** `link(from, to)`: false when `to` exists (never replaced), true when linked. */
function linkNoReplace(from: string, to: string): boolean {
	try {
		linkSync(from, to);
		return true;
	} catch (err) {
		if (code(err) === "EEXIST") return false;
		throw err;
	}
}

/** The file's bytes, or null when it is gone (a racing claimant took it). */
function readOrNull(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch (err) {
		if (code(err) === "ENOENT") return null;
		throw err;
	}
}

/** Quarantine `<inbox>/<name>` as `<entry>.invalid`, else `<entry>.<uuid>.invalid`: link then unlink, so a retained `.invalid` is never overwritten. */
function quarantine(inbox: string, name: string, entry: string): void {
	const from = join(inbox, name);
	if (!linkNoReplace(from, join(inbox, `${entry}.invalid`))) linkSync(from, join(inbox, `${entry}.${randomUUID()}.invalid`));
	unlinkSync(from);
}

/** The registry's ack test: an existing ack is this drain's own when its id, from and to equal the envelope's. */
function ownAck(bytes: Buffer, e: Envelope): boolean {
	try {
		const a = JSON.parse(bytes.toString("utf8")) as { id?: unknown; from?: unknown; to?: unknown };
		return a.id === e.id && a.from === e.from && a.to === e.to;
	} catch {
		return false;
	}
}

/** A foreign file at `acks/<id>.json` or `archive/<id>.json`: present and failing the ack test or the archive's sha256 test. */
function foreignDestination(root: string, e: Envelope, sha: string): boolean {
	const ack = readOrNull(join(root, "acks", `${e.id}.json`));
	if (ack !== null && !ownAck(ack, e)) return true;
	const archived = readOrNull(join(root, "archive", `${e.id}.json`));
	return archived !== null && sha256(archived) !== sha;
}

/**
 * One claim, from its first missing step. `name` is the claim's directory entry, `entry` the `<id>.json` it was
 * published as. Returns the claim when it is owed an aside (recorded, not yet confirmed); it then stays claimed.
 */
function processClaim(io: DrainIO, inbox: string, name: string, entry: string): Unconfirmed | null {
	const { ledger, root } = io;
	const claim = join(inbox, name);
	const bytes = readOrNull(claim);
	if (bytes === null) return null;
	const v = validateEnvelope(bytes.toString("utf8"), entry, io.config);
	if (!v.ok) {
		quarantine(inbox, name, entry);
		recordRefused(ledger, entry, v.from, v.reason);
		return null;
	}
	const { envelope: e, sender } = v;
	const sha = sha256(bytes);
	const msgId = msgIdOf(e.id);
	const refuse = (withdraws: boolean): null => {
		quarantine(inbox, name, entry);
		recordRefused(ledger, entry, e.from, ID_COLLISION, withdraws ? msgId : undefined);
		return null;
	};
	if (ledger.message(msgId)) {
		// Resume: the row must be this envelope's own (its sender's `channel-in:` with these bytes' sha256); else a reused id, which withdraws nothing.
		const rec = channelIn(ledger, msgId, sender.id);
		if (!rec || rec.sha !== sha) return refuse(false);
	} else {
		if (foreignDestination(root, e, sha)) return refuse(false);
		recordMessage(ledger, e, sender, sha);
		io.after?.("recorded", e.id);
	}
	// The owed-aside decision: a message Ilex already acted on is settled rather than resent (settleHandled, code review
	// r1 #1), and goes on to its ack and archive below like a confirmed one.
	if (!hasAside(ledger, msgId, sender.id) && !settleHandled(ledger, msgId, sender.id)) {
		// Owed its aside: the destinations are checked again right before every send (r5 #1), and nothing is written
		// past this point until a `message_end` confirms the aside (`channel-aside:`).
		if (foreignDestination(root, e, sha)) return refuse(true);
		return { msgId, content: asideText(sender.id, msgId, e.message) };
	}
	// Publish the ack: tmp, then link with no replace; an existing ack passes only the ack test.
	const acks = join(root, "acks");
	mkdirSync(acks, { recursive: true });
	const ackPath = join(acks, `${e.id}.json`);
	const existing = readOrNull(ackPath);
	if (existing !== null) {
		if (!ownAck(existing, e)) return refuse(true);
	} else {
		const tmp = `${ackPath}.${io.pid}.${randomUUID()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ id: e.id, from: e.from, to: e.to, deliveredAt: new Date().toISOString() })}\n`);
		try {
			if (!linkNoReplace(tmp, ackPath) && !ownAck(readFileSync(ackPath), e)) return refuse(true);
		} finally {
			unlinkSync(tmp);
		}
	}
	io.after?.("acked", e.id);
	// Archive: link with no replace; an existing archive passes only with the recorded sha256.
	const archive = join(root, "archive");
	mkdirSync(archive, { recursive: true });
	const archivePath = join(archive, `${e.id}.json`);
	if (!linkNoReplace(claim, archivePath)) {
		const rec = channelIn(ledger, msgId, sender.id);
		if (rec === null || sha256(readFileSync(archivePath)) !== rec.sha) return refuse(true);
	}
	io.after?.("archive-linked", e.id);
	unlinkSync(claim);
	return null;
}

/**
 * One pass over `<root>/inbox/ilex/`: adoptable claims first (this pid's, or a dead pid's), then published `<id>.json`
 * names, each in name order. A missing inbox is an empty one.
 */
export function drainInbox(io: DrainIO): Drained {
	const inbox = join(io.root, "inbox", ILEX_SLUG);
	let names: string[];
	try {
		names = readdirSync(inbox).sort();
	} catch (err) {
		if (code(err) === "ENOENT") return { worked: [], unconfirmed: [] };
		throw err;
	}
	const worked: string[] = [];
	const unconfirmed: Unconfirmed[] = [];
	for (const name of names) {
		const m = CLAIMED.exec(name);
		if (!m) continue;
		const pid = Number(m[2]);
		if (pid !== io.pid && io.alive(pid)) continue;
		const u = processClaim(io, inbox, name, m[1]!);
		if (u) unconfirmed.push(u);
		worked.push(name);
	}
	for (const entry of names) {
		if (!entry.endsWith(".json")) continue;
		if (!ENVELOPE_STEM.test(entry.slice(0, -".json".length))) {
			const bytes = readOrNull(join(inbox, entry));
			if (bytes === null) continue;
			const v = validateEnvelope(bytes.toString("utf8"), entry, io.config);
			quarantine(inbox, entry, entry);
			recordRefused(io.ledger, entry, v.ok ? v.envelope.from : v.from, v.ok ? "bad id" : v.reason);
			continue;
		}
		const name = `${entry}${claimSuffix(io.pid)}`;
		// This drain still holds a claim of the same id (owed its confirmation): a rename would replace it. The
		// republished file waits; once that claim is archived, the next pass takes it (and refuses other bytes by sha256).
		if (existsSync(join(inbox, name))) continue;
		try {
			renameSync(join(inbox, entry), join(inbox, name));
		} catch (err) {
			// A racing claimant renamed it first: the envelope is theirs.
			if (code(err) === "ENOENT") continue;
			throw err;
		}
		const u = processClaim(io, inbox, name, entry);
		if (u) unconfirmed.push(u);
		worked.push(name);
	}
	return { worked, unconfirmed };
}

/** The registry's turn-receipt shape (persistent-seat-registry.ts, its `agent_start` handler), written as Ilex. */
const TURN_SEAT = "Ilex";
const TURN_PROVEN_SEAT = "(not a launcher-started seat)";

/**
 * Proof that `acks/<id>.json` is this drain's own for the channel message `msgId` (code review r2 #1): the message
 * was not withdrawn by a late collision, `archive/<id>.json` holds the bytes its `channel-in:` sha256 records, and the
 * ack passes the publication path's ack test (`ownAck`) against that archived envelope. A turn receipt at an id whose
 * ack is another seat's would tell that seat's sender its recipient acted. Returns the envelope id; `PENDING` while
 * the archive or the ack is not yet there (its publication can fail and be retried by a later drain, code review
 * r4 #1), so the receipt stays owed; or null when no receipt is ever owed (withdrawn, or the files are another's).
 */
const PENDING = Symbol("pending");
function ownedAck(ledger: Ledger, root: string, msgId: string, withdrawn: ReadonlySet<string>): string | typeof PENDING | null {
	const m = ledger.message(msgId);
	if (!m || withdrawn.has(msgId)) return null;
	const rec = channelIn(ledger, msgId, m.sender);
	if (!rec || msgIdOf(rec.envelopeId) !== msgId) return null;
	const archived = readOrNull(join(root, "archive", `${rec.envelopeId}.json`));
	if (archived === null) return PENDING;
	if (sha256(archived) !== rec.sha) return null;
	const ack = readOrNull(join(root, "acks", `${rec.envelopeId}.json`));
	if (ack === null) return PENDING;
	return ownAck(ack, JSON.parse(archived.toString("utf8")) as Envelope) ? rec.envelopeId : null;
}

/**
 * The observed-turn receipt the sender's `seat_message` reads as `acted`: `acks/<id>.turn.json` for each channel
 * message in `msgIds` (moved to consumed at its confirming `message_end` inside a turn or at the next `agent_start`,
 * or found missing by the reconcile) whose ack is proven this drain's own (`ownedAck`); one whose ack or archive is
 * not there yet is counted owed, and any other is skipped. Tmp then `link`, so an existing receipt is never replaced
 * (EEXIST skips it); every error is swallowed, as the registry does: a receipt must never break the turn it reports.
 * Returns how many receipts are still owed (a write error, or proof not yet published), so the reconcile keeps an
 * unbounded pass owed until one leaves none (code review r3 #1, r4 #1).
 */
export function writeTurnReceipts(ledger: Ledger, root: string, msgIds: readonly string[], pid: number): number {
	if (msgIds.length === 0) return 0;
	const turnStartedAt = new Date().toISOString();
	let withdrawn: Set<string>;
	try {
		withdrawn = withdrawnMessages(ledger);
	} catch {
		return msgIds.length; // Diagnostic only: the reconcile tries again.
	}
	let failed = 0;
	for (const msgId of msgIds) {
		try {
			const id = ownedAck(ledger, root, msgId, withdrawn);
			if (id === null) continue;
			if (id === PENDING) {
				failed++;
				continue;
			}
			const path = join(root, "acks", `${id}.turn.json`);
			const tmp = `${path}.${pid}.${randomUUID()}.tmp`;
			writeFileSync(tmp, `${JSON.stringify({ id, seat: TURN_SEAT, provenSeat: TURN_PROVEN_SEAT, pid, turnStartedAt })}\n`);
			try {
				linkNoReplace(tmp, path);
			} finally {
				unlinkSync(tmp);
			}
		} catch {
			failed++; // Diagnostic only, as in the registry.
		}
	}
	return failed;
}

/** How long a reply waits for the sender's drain to ack it: the registry's `seat_message` ack deadline. */
const ACK_WAIT_MS = 3_000;

/** The registry's `waitForFile`: poll every 50 ms until `path` exists or the deadline passes; an abort stops the wait. */
async function waitForFile(path: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!signal?.aborted) {
		if (existsSync(path)) return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(50);
	}
	return existsSync(path);
}

/** A tool's `re`: absent → none; a list of strings → trimmed, deduplicated; anything else → null (refused). */
function reIds(v: unknown): string[] | null {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return null;
	return [...new Set(v.map((x: string) => x.trim()))];
}

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });
const inactive = text("This session is not the orchestrator surface; nothing was written or sent.");

/** The key prefix of every channel message; the rest of the key names the msg ids it carries, so its resends share it. */
const KEY_PREFIX = "channel:";

/** The msg ids a channel message carries and its render sequence, or null for any other message. */
function channelPush(m: HostMessage): { msgIds: string[]; renderSeq: number } | null {
	if (m.customType !== CHANNEL_ASIDE_TYPE) return null;
	const d = m.details as { surfaceKey?: unknown; renderSeq?: unknown; msgIds?: unknown } | null | undefined;
	if (!d || typeof d.surfaceKey !== "string" || !d.surfaceKey.startsWith(KEY_PREFIX) || typeof d.renderSeq !== "number" || !Array.isArray(d.msgIds)) return null;
	const msgIds = d.msgIds.filter((x): x is string => typeof x === "string");
	return msgIds.length > 0 ? { msgIds, renderSeq: d.renderSeq } : null;
}

/** One keyed channel message carrying `owed`: their aside texts in claim order, keyed by their ids, with a fresh render sequence. */
function channelMessage(s: SurfaceSession, owed: readonly Unconfirmed[]): SurfaceMessage {
	const msgIds = owed.map((u) => u.msgId);
	return {
		customType: CHANNEL_ASIDE_TYPE,
		content: owed.map((u) => u.content).join("\n\n"),
		display: true,
		details: { surfaceKey: `${KEY_PREFIX}${msgIds.join(",")}`, renderSeq: s.nextSeq(), msgIds },
	};
}

/** A session's channel while it is on. */
interface Live {
	config: ChannelConfig;
	/** Sends so far per msg id still owed its confirmation (a ride on Jo's turn counts as one); its `message_end` clears it. */
	tries: Map<string, number>;
	/** Between `agent_start` and `agent_end`: a confirmation now falls inside a turn. */
	inTurn: boolean;
	/** The session's one unbounded turn-receipt reconcile is still owed (code review r2 #2): cleared once it has run. */
	fullReconcile: boolean;
}

export default function agentChannelRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	/** Each session's channel, by its session manager; absent while the channel is off or refused. */
	const live = new WeakMap<object, Live>();

	/** One pass, or null when it stopped at a failing claim (told once; the next pass resumes there). */
	const drain = (ctx: Ctx, l: Live): Drained | null => {
		try {
			return drainInbox({ ledger: surfaceSession(ctx, env).ledger(), config: l.config, root: mailboxRoot(env), pid: process.pid, alive: pidAlive });
		} catch (err) {
			ctx.ui.notify(`agent channel: the drain stopped: ${err instanceof Error ? err.message : String(err)}`, "warning");
			return null;
		}
	};

	/**
	 * The turn receipt is recoverable (code review r1 #2): `consumed` commits before `acks/<id>.turn.json` is written,
	 * and a receipt write swallows its errors, so a crash or a failed write in between would lose it for good. Each tick
	 * writes it again for every channel message that moved to consumed or acted-on in the last TURN_RECEIPT_DAYS, has
	 * its `channel-aside:`, was not withdrawn, and has no turn receipt; writeTurnReceipts writes it only with proof the
	 * ack is this drain's own (code review r2 #1). An unbounded reconcile is owed at a session's start and stays owed
	 * until one pass writes every missing receipt without an error (r2 #2, r3 #1), so neither an outage longer than the
	 * bound nor a failed write during the first pass (a full disk) abandons an old receipt. No-replace, and every error
	 * swallowed, as at the first write (a receipt must never break the drain). The registry never unlinks an ack or a
	 * turn receipt, so a written one stays and the next tick finds nothing to do.
	 */
	const reconcileTurnReceipts = (ctx: Ctx, l: Live): void => {
		try {
			const ledger = surfaceSession(ctx, env).ledger();
			const root = mailboxRoot(env);
			const since = l.fullReconcile ? null : new Date(Date.parse(ledger.now()) - TURN_RECEIPT_DAYS * 86_400_000).toISOString();
			const missing = turnReceiptsDue(ledger, l.config, since).filter((id) => !existsSync(join(root, "acks", `${id}.turn.json`)));
			if (writeTurnReceipts(ledger, root, missing.map(msgIdOf), process.pid) === 0) l.fullReconcile = false;
		} catch {
			// Diagnostic only, as writeTurnReceipts: the unbounded pass stays owed and the next tick tries again.
		}
	};

	/**
	 * The observed-turn receipt: every confirmed aside not yet consumed (and not withdrawn) moves to consumed, and its
	 * turn receipt is written where the ack is proven this drain's own. A failed write owes the unbounded reconcile, so
	 * it is retried however long the session lasts.
	 */
	const consume = (ctx: Ctx, l: Live): void => {
		const ledger = surfaceSession(ctx, env).ledger();
		let moved: string[];
		try {
			moved = consumeAsides(ledger, l.config);
		} catch (err) {
			ctx.ui.notify(`agent channel: the consumed receipt could not be written: ${err instanceof Error ? err.message : String(err)}`, "warning");
			return;
		}
		if (writeTurnReceipts(ledger, mailboxRoot(env), moved, process.pid) > 0) l.fullReconcile = true;
	};

	/**
	 * The tick: one pass, the turn-receipt reconcile, then at most one aside, carrying the claims still owed one. A
	 * claim never sent goes out busy or idle, as wake.ts sends a new notice batch: OMP queues an aside sent while it
	 * streams for the turn's next step boundary (agent-session.ts:8676-8691), and the loop's last aside poll or
	 * #resumeStrandedIrcAsides (:1179-1221) takes one that arrives after it. A resend goes out only while idle, as
	 * wake.ts resends, PUSH_TRIES sends in all: the idle path is the one that drops an aside (:8726-8753,
	 * #promptAgentInitiatedMessage throws "Agent is already processing" while another turn is starting), so an
	 * unconfirmed claim is retried there, once per tick, and a busy
	 * tick never queues a second copy behind one that may still land. No send counts until its `message_end`.
	 */
	const tick = (ctx: Ctx, l: Live): void => {
		const drained = drain(ctx, l);
		reconcileTurnReceipts(ctx, l);
		if (!drained || !pi.sendMessage) return;
		const idle = ctx.isIdle?.() !== false;
		const owed = drained.unconfirmed.filter((u) => {
			const sent = l.tries.get(u.msgId) ?? 0;
			return sent < PUSH_TRIES && (idle || sent === 0);
		});
		if (owed.length === 0) return;
		for (const u of owed) l.tries.set(u.msgId, (l.tries.get(u.msgId) ?? 0) + 1);
		try {
			pi.sendMessage(channelMessage(surfaceSession(ctx, env), owed), { deliverAs: "aside", triggerTurn: true });
		} catch (err) {
			// Counted as a send that did not land: the claims stay owed and the next idle tick resends them.
			ctx.ui.notify(`agent channel: the aside could not be sent: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	};

	pi.on("session_start", (_e, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		const read = readChannelConfig(env);
		if (read.kind === "off") return undefined;
		if (read.kind === "invalid") {
			ctx.ui.notify(`agent channel refused: the profile config's \`channel\` block is invalid (${read.why}); the channel is off for this session and no mailbox is drained`, "error");
			return undefined;
		}
		const ledger = s.ledger();
		ensureStandingWorkload(ledger);
		setChannelInForce(ledger, read.config);
		const l: Live = { config: read.config, tries: new Map(), inTurn: false, fullReconcile: true };
		live.set(ctx.sessionManager, l);
		tick(ctx, l);
		ctx.setInterval(() => tick(ctx, l), CHANNEL_DRAIN_MS);
		return undefined;
	});

	// Jo's turn (OMP runs no before_agent_start on an aside-started turn): every claim still owed its aside — never
	// sent, in flight, or out of tries — rides the turn as one keyed message, as wake.ts re-renders a wake still in
	// flight, and that message's `message_end` (a turn input) confirms them. The ride counts as one send.
	pi.on("before_agent_start", (_e, ctx) => {
		const l = live.get(ctx.sessionManager);
		if (!l) return undefined;
		const owed = drain(ctx, l)?.unconfirmed ?? [];
		if (owed.length === 0) return undefined;
		for (const u of owed) l.tries.set(u.msgId, 1);
		return { message: channelMessage(surfaceSession(ctx, env), owed) };
	});

	pi.on("agent_start", (_e, ctx) => {
		const l = live.get(ctx.sessionManager);
		if (!l) return undefined;
		l.inTurn = true;
		// The fold case: asides confirmed outside a turn (plan mode, after an Esc) are consumed at this turn's start.
		consume(ctx, l);
		return undefined;
	});

	pi.on("agent_end", (_e, ctx) => {
		const l = live.get(ctx.sessionManager);
		if (l) l.inTurn = false;
		return undefined;
	});

	// Confirmation: OMP emits message_end for a turn's input messages (pi-agent-core agent-loop.ts emitInputMessages,
	// after agent_start) and for an aside it folds into context without a turn (agent-session.ts:1232-1235). The ids
	// the message names get `channel-aside:` whatever their state (one Ilex already acted on included, code review r1
	// #1), and their ack and archive follow at once. The entry is written first, so a crash before the archive leaves a
	// claim the next tick resumes at the ack. Inside a turn they move to `consumed`, with the turn receipt, only after
	// that drain: one it refuses as a late collision is withdrawn by then and is never consumed (code review r2 #1).
	pi.on("message_end", (event, ctx) => {
		const l = live.get(ctx.sessionManager);
		const p = l ? channelPush(event.message) : null;
		if (!l || !p) return undefined;
		try {
			confirmAsides(surfaceSession(ctx, env).ledger(), l.config, p.msgIds);
		} catch (err) {
			ctx.ui.notify(`agent channel: the aside's confirmation could not be recorded: ${err instanceof Error ? err.message : String(err)}`, "warning");
			return undefined;
		}
		for (const id of p.msgIds) l.tries.delete(id);
		drain(ctx, l);
		if (l.inTurn) consume(ctx, l);
		return undefined;
	});

	// Duplicate guard: a resend, or a copy OMP deferred without a turn and the next prompt appended (the ACP branch,
	// agent-session.ts:8746-8748), can reach the model more than once. After the last assistant message, newest first by
	// render sequence, a channel message whose every msg id a newer kept one already carries is dropped. Other
	// messages and earlier history are never touched.
	pi.on("context", (event, ctx) => {
		if (!live.has(ctx.sessionManager)) return undefined;
		const { messages } = event;
		const start = messages.findLastIndex((m) => m.role === "assistant") + 1;
		const pushes = messages.slice(start).flatMap((m, i) => {
			const p = channelPush(m);
			return p ? [{ index: start + i, ...p }] : [];
		});
		pushes.sort((a, b) => b.renderSeq - a.renderSeq);
		const carried = new Set<string>();
		const dropped = new Set<number>();
		for (const p of pushes) {
			if (p.msgIds.every((id) => carried.has(id))) dropped.add(p.index);
			else for (const id of p.msgIds) carried.add(id);
		}
		return dropped.size === 0 ? undefined : { messages: messages.filter((_m, i) => !dropped.has(i)) };
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (!live.has(ctx.sessionManager)) return undefined;
		live.delete(ctx.sessionManager);
		setChannelInForce(surfaceSession(ctx, env).ledger(), null);
		return undefined;
	});

	// ---- tools (D4) ---------------------------------------------------------------------------------------------
	// Ilex's own acts, never the channel's input: a reply envelope from `Ilex` to a configured sender, and the walk of
	// the `re` messages to `acted-on`. Every check runs before anything is written; one failing `re` id refuses the call.
	const z = pi.zod;
	const refused = (why: string): ToolResult => text(`Refused: ${why}; nothing was written or sent.`);
	/** The session's senders and ledger, or the refusal when this is no surface or the channel is off. */
	const open = (ctx: Ctx): { ledger: Ledger; config: ChannelConfig } | ToolResult => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return inactive;
		const l = live.get(ctx.sessionManager);
		if (!l) return refused("the agent channel is off in this session (no valid `channel` block in the profile config)");
		return { ledger: s.ledger(), config: l.config };
	};

	pi.registerTool({
		name: CHANNEL_REPLY_TOOL,
		loadMode: "essential",
		label: "Reply To Agent",
		description:
			"Reply to another agent's channel message: writes a seat-mailbox envelope from Ilex to the configured sender `to`, records a `channel-out:` entry, and walks each `re` message (msg-ch-…, that sender's own) to acted-on. " +
			"It carries no authority and is never Jo's word. Returns delivered when the sender's drain acknowledges within 3 s, else queued.",
		parameters: z.object({
			to: z.string().describe("The configured sender id to reply to (e.g. plumb)."),
			body: z.string().describe("The reply text."),
			re: z.array(z.string()).optional().describe("The channel messages (msg-ch-…) from `to` this reply answers; each is walked to acted-on."),
		}),
		approval: "write",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const o = open(ctx);
			if (!("ledger" in o)) return o;
			const to = String(params.to ?? "").trim().toLowerCase();
			if (!o.config.senders.some((s) => s.id === to)) return refused(`${JSON.stringify(to)} is not a configured channel sender`);
			const message = String(params.body ?? "").trim();
			if (!message) return refused("the reply body is empty");
			const re = reIds(params.re);
			if (re === null) return refused("`re` must be a list of msg-ch-… ids");
			const bad = reRefusal(o.ledger, o.config, re, to);
			if (bad) return refused(bad);
			const envelope: Envelope = { id: `${Date.now()}-${randomUUID()}`, from: displayName(ILEX_SLUG), to: displayName(to), message, createdAt: new Date().toISOString() };
			const root = mailboxRoot(env);
			const inbox = join(root, "inbox", to);
			mkdirSync(inbox, { recursive: true });
			const path = join(inbox, `${envelope.id}.json`);
			const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(envelope)}\n`);
			// Published last inside the ledger transaction, once: a ledger failure before it sends nothing.
			let published = false;
			let moved: string[];
			try {
				moved = recordOut(o.ledger, re, { envelopeId: envelope.id, to }, () => {
					if (published) return;
					renameSync(tmp, path);
					published = true;
				});
			} catch (err) {
				if (!published) unlinkSync(tmp);
				const why = err instanceof Error ? err.message : String(err);
				return text(published ? `The envelope ${envelope.id} was published to ${to}, but the ledger write failed (${why}); no channel-out entry was recorded.` : `The reply failed (${why}); nothing was written or sent.`);
			}
			const status = (await waitForFile(join(root, "acks", `${envelope.id}.json`), ACK_WAIT_MS, signal)) ? "delivered" : "queued";
			const walked = moved.length > 0 ? `; walked to acted-on: ${moved.join(", ")}` : "";
			return text(`Replied to ${to}: envelope ${envelope.id}, ${status}${walked}.`, { id: envelope.id, to, status, re, moved });
		},
	});

	pi.registerTool({
		name: CHANNEL_DONE_TOOL,
		loadMode: "essential",
		label: "Mark Agent Messages Done",
		description: "Mark channel messages from other agents (msg-ch-…) as acted on, without a reply: each is walked to acted-on and leaves the `## from other agents` block.",
		parameters: z.object({
			re: z.array(z.string()).describe("The channel messages (msg-ch-…) to mark acted-on."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const o = open(ctx);
			if (!("ledger" in o)) return o;
			const re = reIds(params.re);
			if (re === null || re.length === 0) return refused("`re` must name at least one msg-ch-… id");
			const bad = reRefusal(o.ledger, o.config, re, null);
			if (bad) return refused(bad);
			const moved = recordOut(o.ledger, re, null);
			return text(moved.length > 0 ? `Walked to acted-on: ${moved.join(", ")}.` : `Already acted-on: ${re.join(", ")}; nothing changed.`, { re, moved });
		},
	});
}
