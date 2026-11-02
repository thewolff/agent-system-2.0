// `as2 doctor`'s control entries on the standing workload (PLAN wl-mvwks11ye3x9zu § Alerts and its amendments), writer
// DOCTOR_BY (surface/src/launch.ts, CONTROL_PREFIXES and the writer map). Pure: it formats the bodies surface/src/doctor.ts
// writes and reads them back from `controlEntries`; it never touches the ledger.
//
// Text forms (the part is one token: `ctx`, `ledger`, `backup`, `seat`, `mailbox`, `gh`, `disk`, `mcp`, `job-inventory`,
// `job:<label>`, `deps:<label>`):
//   doctor-strike: <part> <evidence>
//   doctor-down: <part> <evidence> — fix: <fix>
//   doctor-up: <part> <evidence>
//   doctor-popup: <popupId> claimed pid <n> start <token> boot <n> until <iso> downs <id,id…>[ after <popupId>]
//   doctor-popup: <popupId> answered|failed|abandoned|expired[ <detail>]
//   doctor-boot: <boot time, seconds>
// Evidence, fix and detail are one line: control characters become spaces and runs of whitespace one space; evidence and
// fix also lose every ` — `, so the down's ` — fix: ` separator is the first one in the body. A value that cannot be written
// in its form (a part, popup id, start or down id that is not one token, an empty evidence or fix, a bad number or instant)
// throws, naming the record and the field: a body that would not parse back is never written.
// Episodes: a part's newest `doctor-down:` with no later `doctor-up:` for that part is open (one `report` needs-you line,
// surface/src/errors.ts `doctorLines`). Popups: a claim pairs with the first outcome naming its id; each `failed`,
// `abandoned` or `expired` outcome spends one attempt on every down its claim names, counted from the ledger.
import { type ControlEntry, DOCTOR_BY } from "./launch";

export type PopupOutcome =
	| { state: "claimed"; pid: number; start: string; boot: number; until: string; downs: string[]; after: string | null }
	| { state: "answered"; detail: string } // button text, optionally "audio-failed <line>"
	| { state: "failed"; detail: string }
	| { state: "abandoned"; detail: string }
	| { state: "expired"; detail: string };

export type DoctorRecord =
	| { prefix: "doctor-strike"; part: string; evidence: string }
	| { prefix: "doctor-down"; part: string; evidence: string; fix: string }
	| { prefix: "doctor-up"; part: string; evidence: string }
	| { prefix: "doctor-popup"; popupId: string; outcome: PopupOutcome }
	| { prefix: "doctor-boot"; boot: number };

/** A down with no `answered` popup stays pending until this many of its popups ended `failed`, `abandoned` or `expired`. */
export const POPUP_ATTEMPT_LIMIT = 3;

const DOWN_SEPARATOR = " — fix: ";
const TOKEN = /^[^\s\x00-\x1f\x7f-\x9f]+$/;
const CLAIM = /^(\S+) claimed pid (\d+) start (\S+) boot (\d+) until (\S+) downs (\S+)(?: after (\S+))?$/;
const OUTCOME = /^(\S+) (answered|failed|abandoned|expired)(?: (.+))?$/;
const PART_TEXT = /^(\S+) (.+)$/;

/** One line: control characters to spaces, whitespace runs to one space, trimmed. */
function oneLine(s: string): string {
	return s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

/** One line with no ` — ` left in it (a replacement can make a new one, so it repeats until none is). */
function noSeparator(s: string): string {
	let t = oneLine(s);
	while (t.includes(" — ")) t = t.replaceAll(" — ", " - ");
	return t;
}

function token(record: string, field: string, value: string): string {
	if (!TOKEN.test(value)) throw new Error(`formatDoctor(${record}): ${field} ${JSON.stringify(value)} is not one token (no spaces or control characters)`);
	return value;
}

function text(record: string, field: string, value: string): string {
	const t = noSeparator(value);
	if (t === "") throw new Error(`formatDoctor(${record}): ${field} is empty after removing control characters and " — " (was ${JSON.stringify(value)})`);
	return t;
}

function whole(record: string, field: string, value: number, min: number): string {
	if (!Number.isSafeInteger(value) || value < min) throw new Error(`formatDoctor(${record}): ${field} ${value} is not a whole number of at least ${min}`);
	return String(value);
}

/** The entry body to write, e.g. "doctor-down: ctx not running (…) — fix: run `ctx daemon status` in your own Terminal". */
export function formatDoctor(r: DoctorRecord): string {
	switch (r.prefix) {
		case "doctor-strike":
		case "doctor-up":
			return `${r.prefix}: ${token(r.prefix, "part", r.part)} ${text(r.prefix, "evidence", r.evidence)}`;
		case "doctor-down":
			return `${r.prefix}: ${token(r.prefix, "part", r.part)} ${text(r.prefix, "evidence", r.evidence)}${DOWN_SEPARATOR}${text(r.prefix, "fix", r.fix)}`;
		case "doctor-boot":
			return `${r.prefix}: ${whole(r.prefix, "boot", r.boot, 0)}`;
		case "doctor-popup": {
			const id = token(r.prefix, "popupId", r.popupId);
			const o = r.outcome;
			if (o.state !== "claimed") {
				const detail = oneLine(o.detail);
				return `${r.prefix}: ${id} ${o.state}${detail ? ` ${detail}` : ""}`;
			}
			if (o.downs.length === 0) throw new Error(`formatDoctor(doctor-popup): claim ${id} names no down`);
			for (const d of o.downs) if (d.includes(",")) throw new Error(`formatDoctor(doctor-popup): down id ${JSON.stringify(d)} holds a comma`);
			const until = token(r.prefix, "until", o.until);
			if (!Number.isFinite(Date.parse(until))) throw new Error(`formatDoctor(doctor-popup): until ${JSON.stringify(until)} is not an instant`);
			const downs = o.downs.map((d) => token(r.prefix, "down id", d)).join(",");
			const after = o.after === null ? "" : ` after ${token(r.prefix, "after", o.after)}`;
			return `${r.prefix}: ${id} claimed pid ${whole(r.prefix, "pid", o.pid, 1)} start ${token(r.prefix, "start", o.start)} boot ${whole(r.prefix, "boot", o.boot, 0)} until ${until} downs ${downs}${after}`;
		}
	}
}

/** null for a non-doctor prefix, a writer other than DOCTOR_BY, or text that does not parse. Round-trips formatDoctor. */
export function parseDoctor(c: ControlEntry): DoctorRecord | null {
	if (c.createdBy !== DOCTOR_BY) return null;
	const rest = c.rest;
	switch (c.prefix) {
		case "doctor-strike":
		case "doctor-up": {
			const m = PART_TEXT.exec(rest);
			return m ? { prefix: c.prefix, part: m[1]!, evidence: m[2]! } : null;
		}
		case "doctor-down": {
			const m = PART_TEXT.exec(rest);
			if (!m) return null;
			const at = m[2]!.indexOf(DOWN_SEPARATOR);
			if (at <= 0) return null;
			const fix = m[2]!.slice(at + DOWN_SEPARATOR.length);
			return fix ? { prefix: c.prefix, part: m[1]!, evidence: m[2]!.slice(0, at), fix } : null;
		}
		case "doctor-boot": {
			if (!/^\d+$/.test(rest)) return null;
			const boot = Number(rest);
			return Number.isSafeInteger(boot) ? { prefix: c.prefix, boot } : null;
		}
		case "doctor-popup": {
			const claim = CLAIM.exec(rest);
			if (claim) {
				const pid = Number(claim[2]);
				const boot = Number(claim[4]);
				const downs = claim[6]!.split(",");
				if (pid < 1 || !Number.isSafeInteger(pid) || !Number.isSafeInteger(boot) || !Number.isFinite(Date.parse(claim[5]!)) || downs.includes("")) return null;
				return { prefix: c.prefix, popupId: claim[1]!, outcome: { state: "claimed", pid, start: claim[3]!, boot, until: claim[5]!, downs, after: claim[7] ?? null } };
			}
			const m = OUTCOME.exec(rest);
			if (!m) return null;
			return { prefix: c.prefix, popupId: m[1]!, outcome: { state: m[2] as Exclude<PopupOutcome, { state: "claimed" }>["state"], detail: m[3] ?? "" } };
		}
		default:
			return null;
	}
}

export interface OpenDown {
	entryId: string;
	createdAt: string;
	part: string;
	evidence: string;
	fix: string;
}

/** Per part, the newest down when no later up exists for that part; in the order the downs were written. */
export function openDowns(control: readonly ControlEntry[]): OpenDown[] {
	const open = new Map<string, OpenDown>();
	for (const c of control) {
		const r = parseDoctor(c);
		if (r?.prefix === "doctor-down") {
			open.delete(r.part);
			open.set(r.part, { entryId: c.id, createdAt: c.createdAt, part: r.part, evidence: r.evidence, fix: r.fix });
		} else if (r?.prefix === "doctor-up") open.delete(r.part);
	}
	return [...open.values()];
}

/** Per part, a strike with no later down or up for that part (the newest, when two stand); in the order written. */
export function openStrikes(control: readonly ControlEntry[]): { entryId: string; part: string; createdAt: string }[] {
	const open = new Map<string, { entryId: string; part: string; createdAt: string }>();
	for (const c of control) {
		const r = parseDoctor(c);
		if (r?.prefix === "doctor-strike") {
			open.delete(r.part);
			open.set(r.part, { entryId: c.id, part: r.part, createdAt: c.createdAt });
		} else if (r?.prefix === "doctor-down" || r?.prefix === "doctor-up") open.delete(r.part);
	}
	return [...open.values()];
}

export interface PopupClaim {
	popupId: string;
	entryId: string;
	createdAt: string;
	claim: Extract<PopupOutcome, { state: "claimed" }>;
	outcome: Exclude<PopupOutcome, { state: "claimed" }> | null;
}

/** Claims paired with the first outcome written after them for their id, and that outcome's position in `control`. */
function pairedClaims(control: readonly ControlEntry[]): { claim: PopupClaim; outcomeAt: number }[] {
	const byId = new Map<string, { claim: PopupClaim; outcomeAt: number }>();
	control.forEach((c, i) => {
		const r = parseDoctor(c);
		if (r?.prefix !== "doctor-popup") return;
		const known = byId.get(r.popupId);
		if (r.outcome.state === "claimed") {
			// A second claim under an id already claimed is not a new popup: the first one stands.
			if (!known) byId.set(r.popupId, { claim: { popupId: r.popupId, entryId: c.id, createdAt: c.createdAt, claim: r.outcome, outcome: null }, outcomeAt: -1 });
			return;
		}
		// An outcome with no claim before it, or after the claim's first outcome, settles nothing.
		if (known && known.claim.outcome === null) {
			known.claim.outcome = r.outcome;
			known.outcomeAt = i;
		}
	});
	return [...byId.values()];
}

/** Every claim, in the order written, with its outcome (null while it has none). */
export function popupClaims(control: readonly ControlEntry[]): PopupClaim[] {
	return pairedClaims(control).map((p) => p.claim);
}

/** Attempts spent on a down: count of failed/abandoned/expired outcomes of claims naming it; last = that outcome's text; answered = some claim naming it was answered. */
export function popupAttempts(control: readonly ControlEntry[], downEntryId: string): { spent: number; last: string | null; answered: boolean } {
	let spent = 0;
	let answered = false;
	let last: { at: number; text: string } | null = null;
	for (const { claim, outcomeAt } of pairedClaims(control)) {
		const o = claim.outcome;
		if (!o || !claim.claim.downs.includes(downEntryId)) continue;
		if (o.state === "answered") {
			answered = true;
			continue;
		}
		spent++;
		if (!last || outcomeAt > last.at) last = { at: outcomeAt, text: o.detail ? `${o.state} ${o.detail}` : o.state };
	}
	return { spent, last: last?.text ?? null, answered };
}

/** An instant as Jo's local minute, `YYYY-MM-DD HH:MM`, for "down since" on the needs-you line. */
export function localMinute(iso: string): string {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
