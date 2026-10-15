// Speaks first (PLAN wl-mv8igegljun18g D1–D5; Jo's amendment in-mv8pgy80vjd69s): the seat-agnostic
// status core any agent reporting to Jo runs once per session. It owns the status clock, the told set
// with its lookback floor W and the 60 s overlap, the delta cap, the confirm-only bookkeeping of a
// pushed batch (in-flight record, resends, fallback, retirement on takeover) and the durable cursor
// `<root>/<seat>/status-cursor.json`. It knows nothing of the ledger or of any seat: a seat (the
// orchestrator surface's adapter is surface/src/status-ilex.ts, wired in surface/extensions/wake.ts)
// feeds it graded items and the callbacks that push, show and mark messages delivered.
//
// Told (D2a): an item is offered when its stamp is `>= W - 60 s` and no identity it carries is in the
// told set. Nothing moves at a push: identities enter `told`, messages move to delivered and W moves
// (by max, never past an item left over the cap) only when a delivery that showed them is confirmed
// (`confirm` for a pushed batch or quiet line, `commit` for a render a turn carried). Told entries
// older than `W - 60 s` are pruned; W and the rest are written to the cursor at every change.
//
// Cap (D2a [R3-5], [R4-2]): a delta's capped items go in grade order (on fire, worth knowing, noise),
// oldest first within a grade, until the next would cross `deltaChars`; the first capped item always
// renders whole. Items left over are neither told nor delivered and the section says how many wait.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Grade = "on fire" | "worth knowing" | "noise";
/** Grade order: the cap takes items in this order, and a section lists them in it. */
export const GRADES: readonly Grade[] = ["on fire", "worth knowing", "noise"];
/** The overlap below W an item may be stamped and still be offered (D2a): a row committed in the read's millisecond is picked up next time. */
export const OVERLAP_MS = 60_000;
/** The default delta cap in characters (D2a [R3-5]). */
export const DELTA_CHARS = 24_000;
/** The default number of sends of an unconfirmed batch before it falls back (D3). */
export const TRIES = 3;

/** One told identity and the stamp it is pruned by. */
export interface Told {
	identity: string;
	ts: string;
}

/** One graded thing a seat offers a batch. */
export interface StatusItem {
	/** The section it is listed under (the seat names the sections and their order). */
	section: string;
	grade: Grade;
	/** The bullet's text after `[grade] `, its continuation lines already indented two spaces by the seat so a body stays under its bullet. Ignored for a silent item. */
	text: string;
	/** Ordering stamp, oldest first within a grade. */
	at: string;
	/** Floor stamp: a left-over item holds W at it. Null for an item found by state, not by time. */
	ts: string | null;
	/** Identities entering the told set at confirmation. */
	told?: readonly Told[];
	/** Message ids marked delivered at confirmation (only those still undelivered; the seat's callback decides). */
	messageIds?: readonly string[];
	/** The seat's own handle for the item (returned at confirmation and takeover). */
	ref?: string;
	/** Always rendered, outside the cap (e.g. needs-you lines). */
	uncapped?: boolean;
	/** Told at confirmation without being listed: something else in the delivery already says it. */
	silent?: boolean;
}

/** What a delivery confirms: told identities, messages, the seat's refs, and the floor W moves to. */
export interface Receipt {
	told: Told[];
	messageIds: string[];
	refs: string[];
	/** min(readAt, the floor stamp of the oldest item left over the cap). */
	floor: string;
}

/** A delta: what renders, what waits for the next batch, and what is told without a line. */
export interface Delta {
	readAt: string;
	/** W when the delta was built (the `since` the text names). */
	since: string;
	shown: StatusItem[];
	left: StatusItem[];
	silent: StatusItem[];
}

/** A batch pushed (or a quiet line shown) and not yet confirmed. */
export interface StatusBatch {
	id: string;
	key: string;
	content: string;
	quiet: boolean;
	tries: number;
	receipt: Receipt;
}

export interface SeatOptions {
	/** The seat's name: the cursor's directory under `root` (the orchestrator surface is `orchestrator`). */
	seat: string;
	/** The agent-system home the cursor goes under (`~/.agent-system-2`); null: no durable cursor (warned once). */
	root: string | null;
	/** What the cursor is about (e.g. the ledger path): a cursor written for another scope is ignored. */
	scope?: string;
	/** The seat's clock (ISO-8601 UTC). */
	now(): string;
	/** The status interval in ms. */
	intervalMs: number;
	deltaChars?: number;
	tries?: number;
	/** The word for message items in the left-over line (`<n> more items (<m> lane messages) …`). */
	messageNoun?: string;
	/** Send a batch that starts a turn. */
	push(content: string, key: string): void;
	/** Show a display-only line that starts no turn. */
	show(content: string, key: string): void;
	/** Move these messages to delivered (skip any no longer undelivered). */
	markDelivered(ids: readonly string[]): void;
	/** A cursor that cannot be read or written; default: one stderr line. */
	warn?(message: string): void;
}

/** `HH:MMZ` of an ISO stamp. */
export const hhmm = (at: string): string => `${at.slice(11, 16)}Z`;
/** Grade then oldest first: the order the cap takes items in and a section lists them in. */
const byGradeThenAge = (a: StatusItem, b: StatusItem): number => GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

/** One bullet: `- [grade] text`. */
export function bullet(item: StatusItem): string {
	return `- [${item.grade}] ${item.text}`;
}

/** The left-over line: `<n> more items (<m> <noun>) held for the next batch`. */
export function leftLine(left: readonly StatusItem[], noun = "messages"): string {
	const m = left.filter((i) => (i.messageIds?.length ?? 0) > 0).length;
	return `${left.length} more items (${m} ${noun}) held for the next batch`;
}

/**
 * Split `items` into what renders under `cap` and what waits (pure). Uncapped items always render;
 * capped ones go in grade order, oldest first, until the next would cross the cap (the first capped
 * item always renders); a silent item renders nothing and is always told. `overhead` is the
 * characters the section spends outside its bullets.
 */
export function selectDelta(items: readonly StatusItem[], o: { cap: number; readAt: string; since: string; overhead?: number; noun?: string }): Delta {
	const silent = items.filter((i) => i.silent);
	const listed = items.filter((i) => !i.silent);
	const uncapped = listed.filter((i) => i.uncapped);
	const capped = listed.filter((i) => !i.uncapped).sort(byGradeThenAge);
	const shown = [...uncapped];
	let used = (o.overhead ?? 0) + leftLine(capped, o.noun).length + 1 + uncapped.reduce((n, i) => n + bullet(i).length + 1, 0);
	let k = 0;
	for (; k < capped.length; k++) {
		const cost = bullet(capped[k]!).length + 1;
		if (k > 0 && used + cost > o.cap) break;
		used += cost;
		shown.push(capped[k]!);
	}
	return { readAt: o.readAt, since: o.since, shown, left: capped.slice(k), silent };
}

/** Whether a delta starts a turn (D4): an on-fire or worth-knowing item shown, or items left over the cap (the backlog drains one batch per interval). */
export function hasTurnContent(d: Delta): boolean {
	return d.left.length > 0 || d.shown.some((i) => i.grade !== "noise");
}

/** What confirming `d` moves: every shown and silent item's identities, messages and refs; W to min(readAt, oldest left-over floor stamp). */
export function receiptOf(d: Delta): Receipt {
	const done = [...d.shown, ...d.silent];
	let floor = d.readAt;
	for (const i of d.left) if (i.ts !== null && i.ts < floor) floor = i.ts;
	return {
		told: done.flatMap((i) => [...(i.told ?? [])]),
		messageIds: done.flatMap((i) => [...(i.messageIds ?? [])]),
		refs: done.flatMap((i) => (i.ref === undefined ? [] : [i.ref])),
		floor,
	};
}

/** The shown items of `d` grouped under `sections` (in that order) as `<level> <section>` blocks, grade order within each; empty sections are left out. */
export function sectionBlocks(d: Delta, sections: readonly string[], level: string): string[] {
	const out: string[] = [];
	for (const name of sections) {
		const items = d.shown.filter((i) => i.section === name).sort(byGradeThenAge);
		if (items.length === 0) continue;
		out.push([`${level} ${name}`, ...items.map(bullet)].join("\n"));
	}
	return out;
}

interface CursorFile {
	scope?: string;
	since: string;
	told: [string, string][];
}

export class StatusCore {
	/** W: the lookback floor, moved only by a confirmed delivery. */
	since = "";
	/** Told identities → the stamp each is pruned by. */
	readonly told = new Map<string, string>();
	/** Start of the current interval (ms on the seat's clock). */
	at = 0;
	/** A batch or quiet line pushed and not yet confirmed. */
	inFlight: StatusBatch | null = null;
	/** The batch in flight was sent `tries` times unconfirmed: no new batch until a takeover or its late confirmation. */
	exhausted = false;
	#loaded = false;
	#warned = false;
	readonly #tag = Date.now().toString(36);
	#serial = 0;

	constructor(readonly o: SeatOptions) {}

	get deltaChars(): number {
		return this.o.deltaChars ?? DELTA_CHARS;
	}

	/** The cursor's path, or null without a root. */
	get cursorPath(): string | null {
		return this.o.root === null ? null : join(this.o.root, this.o.seat, "status-cursor.json");
	}

	/** Read the cursor once (at session start, or lazily at first use): W and the told set from it, else W = now. The interval starts now. */
	load(): void {
		if (this.#loaded) return;
		this.#loaded = true;
		const now = this.o.now();
		this.since = now;
		this.at = Date.parse(now);
		const path = this.cursorPath;
		if (path === null || !existsSync(path)) return;
		try {
			const c = JSON.parse(readFileSync(path, "utf8")) as CursorFile;
			if ((c.scope ?? null) !== (this.o.scope ?? null) || typeof c.since !== "string" || Number.isNaN(Date.parse(c.since))) return;
			this.since = c.since;
			for (const [identity, ts] of c.told ?? []) if (typeof identity === "string" && typeof ts === "string") this.told.set(identity, ts);
		} catch (err) {
			this.#warn(`the status cursor ${path} could not be read (${String(err)}); starting from now`);
		}
	}

	/** `W - 60 s`: the oldest stamp an item may carry and still be offered. */
	get floor(): string {
		this.load();
		return new Date(Date.parse(this.since) - OVERLAP_MS).toISOString();
	}

	/** Whether an item with this identity and stamp is offered: at or after the floor, and not told. */
	eligible(identity: string, ts: string): boolean {
		return ts >= this.floor && !this.told.has(identity);
	}

	/** Whether a batch is due (D1): the interval elapsed, the seat idle and not blocked (a wake pending, away), and no batch in flight or fallen back. */
	due(o: { idle: boolean; blocked: boolean }): boolean {
		this.load();
		return o.idle && !o.blocked && this.inFlight === null && !this.exhausted && Date.parse(this.o.now()) >= this.at + this.o.intervalMs;
	}

	/** Start a new interval now. */
	reset(): void {
		this.load();
		this.at = Date.parse(this.o.now());
	}

	/** Build a delta of `items` read now, under the cap; `overhead` is what the section spends outside its bullets. */
	delta(items: readonly StatusItem[], overhead = 0): Delta {
		this.load();
		return selectDelta(items, { cap: this.deltaChars, readAt: this.o.now(), since: this.since, overhead, noun: this.o.messageNoun });
	}

	/** The left-over line for `d`, or null when nothing was left. */
	leftOver(d: Delta): string | null {
		return d.left.length > 0 ? leftLine(d.left, this.o.messageNoun) : null;
	}

	/**
	 * A batch's text (D2): `status <HH:MMZ> (since <HH:MMZ>)`, the sections, the left-over line and `footer`;
	 * or, with nothing that starts a turn, the quiet line (D4) `status <HH:MMZ>: no change since <HH:MMZ> · <summary…>` with every noise item under it.
	 */
	compose(d: Delta, o: { sections: readonly string[]; footer: string; summary: readonly string[] }): { content: string; quiet: boolean } {
		if (!hasTurnContent(d)) {
			const head = [`status ${hhmm(d.readAt)}: no change since ${hhmm(d.since)}`, ...o.summary].join(" · ");
			return { content: [head, ...d.shown.map(bullet)].join("\n"), quiet: true };
		}
		const parts = [`status ${hhmm(d.readAt)} (since ${hhmm(d.since)})`, ...sectionBlocks(d, o.sections, "##")];
		const left = this.leftOver(d);
		if (left) parts.push(left);
		parts.push(o.footer);
		return { content: parts.join("\n\n"), quiet: false };
	}

	/** A delta section for a render a turn carries (the wake, a takeover, `back`): `<heading>`, sub-sections, the left-over line; null when it has nothing to say. */
	section(d: Delta, o: { heading: string; sections: readonly string[] }): string | null {
		const blocks = sectionBlocks(d, o.sections, "###");
		const left = this.leftOver(d);
		if (blocks.length === 0 && !left) return null;
		return [o.heading, ...blocks, ...(left ? [left] : [])].join("\n");
	}

	/** Push `content` for `d` (a turn when `quiet` is false, a display-only line otherwise) and hold it in flight; the interval restarts. Nothing is told or delivered here. */
	send(d: Delta, content: string, quiet: boolean, receipt: Receipt = receiptOf(d)): StatusBatch {
		const id = `${this.#tag}-${++this.#serial}`;
		const batch: StatusBatch = { id, key: `status:${id}`, content, quiet, tries: 1, receipt };
		this.inFlight = batch;
		this.exhausted = false;
		this.reset();
		this.#emit(batch);
		return batch;
	}

	/** At an idle poll: resend the batch in flight, `tries` sends in all, then fall back (`exhausted`). */
	resend(): "resent" | "exhausted" | "none" {
		const b = this.inFlight;
		if (!b || this.exhausted) return "none";
		if (b.tries < (this.o.tries ?? TRIES)) {
			b.tries++;
			this.#emit(b);
			return "resent";
		}
		this.exhausted = true;
		return "exhausted";
	}

	/** A `message_end` under `key`: the batch in flight under that key is confirmed and committed; any other key (a retired one) changes nothing. */
	confirm(key: string): Receipt | null {
		const b = this.inFlight;
		if (!b || b.key !== key) return null;
		this.inFlight = null;
		this.exhausted = false;
		this.commit(b.receipt);
		return b.receipt;
	}

	/** Take over the batch in flight or fallen back (a wake, `back`, a turn): its record is dropped and returned, so the seat retires its key and takes its refs back. */
	takeover(): StatusBatch | null {
		const b = this.inFlight;
		this.inFlight = null;
		this.exhausted = false;
		return b;
	}

	/** Commit a confirmed delivery: identities told, messages delivered, W to max(W, floor), told pruned, cursor written. */
	commit(r: Receipt): void {
		this.load();
		for (const t of r.told) this.told.set(t.identity, t.ts);
		if (r.messageIds.length > 0) this.o.markDelivered(r.messageIds);
		if (r.floor > this.since) this.since = r.floor;
		const floor = this.floor;
		for (const [identity, ts] of this.told) if (ts < floor) this.told.delete(identity);
		this.save();
	}

	/** Mark identities told without moving W (a read the seat's model asked for showed them). */
	markTold(told: readonly Told[]): void {
		this.load();
		const floor = this.floor;
		let changed = false;
		for (const t of told) {
			if (t.ts < floor || this.told.get(t.identity) === t.ts) continue;
			this.told.set(t.identity, t.ts);
			changed = true;
		}
		if (changed) this.save();
	}

	/** Write W and the told set: a temp file, then a rename. */
	save(): void {
		const path = this.cursorPath;
		if (path === null) {
			this.#warn(`no home for the ${this.o.seat} status cursor; W and the told set last only this session`);
			return;
		}
		const body: CursorFile = { ...(this.o.scope !== undefined ? { scope: this.o.scope } : {}), since: this.since, told: [...this.told] };
		try {
			mkdirSync(join(this.o.root!, this.o.seat), { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(body)}\n`);
			renameSync(tmp, path);
		} catch (err) {
			this.#warn(`the status cursor ${path} could not be written (${String(err)}); W and the told set last only this session`);
		}
	}

	#emit(b: StatusBatch): void {
		if (b.quiet) this.o.show(b.content, b.key);
		else this.o.push(b.content, b.key);
	}

	#warn(message: string): void {
		if (this.#warned) return;
		this.#warned = true;
		if (this.o.warn) this.o.warn(message);
		else process.stderr.write(`status (${this.o.seat}): ${message}\n`);
	}
}
