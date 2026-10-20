// The decision log as context and as a rendering (SPEC-2.0.md § B2.1; DESIGN-2.0.md C7.5 written
// rule): at workload open the target repository's `.ai/decision-log/` entries newer than the last
// 2.0 workload on that repository are rendered into the lane brief; at workload close one entry is
// rendered from the ledger in the shared filename scheme `YYYY-MM-DD--HHMM--<engineer>--<slug>.md`
// with frontmatter scalars status / durable / supersedes / session / date and the four headings.
// Agents do not write these by ritual; the surface renders them.
//
// Which workload was "on" a repository is an `assumption` entry `repo: <absolute path>` written at
// open (identity.ts pattern: an existing entry kind, no schema bump).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Ledger } from "../../ledger/src/index";
import { reversedRowIds } from "../../ledger/src/jo-channel";
import { reservedStates } from "./errors";
import { type Identity, authorSlug } from "./identity";
import { controlEntries, doneBecause, doneLine, holdersOf, reservedPrefix } from "./launch";
import { MERGE_TRAIN_BY, SURFACE_BY } from "./types";

export const REPO_PREFIX = "repo:";
const FILE_NAME = /^(\d{4}-\d{2}-\d{2})--(\d{4})--([^-][^/]*?)--(.+)\.md$/;

export interface LogEntry {
	path: string;
	date: string;
	engineer: string;
	slug: string;
	frontmatter: Record<string, string>;
	body: string;
}

/** Frontmatter scalars, the way the plugin parser reads them: leading `---` block, keys lower-cased, quotes and `#` comments stripped. */
export function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: text };
	const fm: Record<string, string> = {};
	let i = 1;
	for (; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "---") break;
		const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2]!.trim();
		v = v.replace(/\s+#.*$/, "");
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		fm[m[1]!.toLowerCase()] = v;
	}
	return { frontmatter: fm, body: lines.slice(i + 1).join("\n") };
}

/** Every entry in `dir`, oldest first, by filename date then frontmatter `date`. */
export function readLog(dir: string): LogEntry[] {
	if (!existsSync(dir)) return [];
	const out: LogEntry[] = [];
	for (const name of readdirSync(dir)) {
		const m = FILE_NAME.exec(name);
		if (!m) continue;
		const path = join(dir, name);
		const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
		const fmDate = frontmatter.date && !Number.isNaN(Date.parse(frontmatter.date)) ? new Date(frontmatter.date).toISOString() : null;
		const date = fmDate ?? `${m[1]}T${m[2]!.slice(0, 2)}:${m[2]!.slice(2)}:00.000Z`;
		out.push({ path, date, engineer: m[3]!, slug: m[4]!, frontmatter, body });
	}
	return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.path < b.path ? -1 : 1));
}

/** The `## Heading` section of a markdown body, without the heading line. */
export function section(body: string, heading: string): string {
	const lines = body.split("\n");
	const start = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase().startsWith(heading.toLowerCase()));
	if (start < 0) return "";
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i]!)) { end = i; break; }
	return lines.slice(start + 1, end).join("\n").trim();
}

/** The close time of the newest closed 2.0 workload on `repo`, or null. */
export function lastWorkloadOn(ledger: Ledger, repo: string): string | null {
	const row = ledger.db.query<{ closed_at: string | null }, [string, string]>(
		`SELECT w.closed_at FROM workloads w JOIN entries e ON e.workload_id = w.id
		 WHERE w.status = 'closed' AND e.kind = 'assumption' AND e.created_by = ? AND e.body = ? ORDER BY w.closed_at DESC LIMIT 1`,
	).get(SURFACE_BY, `${REPO_PREFIX} ${repo}`);
	return row?.closed_at ?? null;
}

export interface ContextOptions {
	/** Entries newer than this ISO time. Default: the last 2.0 workload's close on the repo, else 14 days. */
	since?: string | null;
	now?: string;
	/** Cap when there is no prior workload. Default 10. */
	cap?: number;
	/** Byte budget for the whole rendering. Default `DECISION_LOG_MAX_BYTES`. */
	maxBytes?: number;
	/** Byte share of one entry, heading and truncation line included. Default `DECISION_LOG_ENTRY_BYTES`. */
	entryBytes?: number;
}

/** 32 KB: one lane prompt carried 438 KB of decision log before this cap (MIGRATION.md item 107). */
export const DECISION_LOG_MAX_BYTES = 32 * 1024;
export const DECISION_LOG_ENTRY_BYTES = 8 * 1024;
export const NOT_RENDERED = "### Not rendered (budget)";

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");
/** Bytes of `lines` once joined with newlines, one newline after each. */
const blockBytes = (lines: readonly string[]): number => lines.reduce((n, l) => n + utf8(l) + 1, 0);
const truncation = (more: number, name: string): string => `… (truncated: ${more} more line${more === 1 ? "" : "s"}; read ${name} for the rest)`;
const notRenderedMore = (more: number, dir: string): string => `… and ${more} more not rendered; read ${dir} for the rest`;

/** The longest prefix of `s` within `max` UTF-8 bytes, cut on a code point and ending `…` when cut; empty when not even `…` fits. */
export function clip(s: string, max: number): string {
	if (utf8(s) <= max) return s;
	const room = max - utf8("…");
	if (room < 0) return "";
	let out = "";
	let n = 0;
	for (const ch of s) {
		const b = utf8(ch);
		if (n + b > room) break;
		out += ch;
		n += b;
	}
	return `${out}…`;
}

/**
 * The `NOT_RENDERED` block for `names` (oldest first) within `room` bytes: every name when they all
 * fit, else the newest that fit, in order, and a closing line counting the rest and naming `dir`.
 * Empty when not even the heading and that closing line fit.
 */
function fitNames(names: readonly string[], room: number, dir: string): string[] {
	const items = names.map((n) => `- ${n}`);
	const all = [NOT_RENDERED, ...items];
	if (blockBytes(all) <= room) return all;
	let used = blockBytes([NOT_RENDERED, notRenderedMore(names.length, dir)]); // widest count
	if (used > room) return [];
	let k = 0;
	while (k < items.length) {
		const cost = utf8(items[items.length - 1 - k]!) + 1;
		if (used + cost > room) break;
		used += cost;
		k++;
	}
	return [NOT_RENDERED, ...items.slice(items.length - k), notRenderedMore(names.length - k, dir)];
}

/**
 * One entry's block — heading, content lines, blank line — cut at a line boundary to fit `share`
 * bytes, with a truncation line naming the file. Null when not even the heading and that line fit.
 */
function fitEntry(heading: string, content: readonly string[], share: number, name: string): string[] | null {
	const whole = [heading, ...content, ""];
	if (blockBytes(whole) <= share) return whole;
	const reserve = utf8(truncation(content.length, name)) + 1 + 1; // the note (widest count) and the closing blank line
	let used = utf8(heading) + 1;
	if (used + reserve > share) return null;
	const kept = [heading];
	for (const line of content) {
		const cost = utf8(line) + 1;
		if (used + cost + reserve > share) break;
		kept.push(line);
		used += cost;
	}
	kept.push(truncation(content.length - (kept.length - 1), name), "");
	return kept;
}

/**
 * The decision-log entries to put in a lane brief at workload open, rendered. Empty string when none.
 * Hard-bounded by `maxBytes` (UTF-8), header and name list included: newest entries are fitted first,
 * each to its `entryBytes` share; once the budget is spent, the older ones are listed by name under
 * `NOT_RENDERED` — every name when they fit, else the newest that fit and a line counting the rest and
 * naming `dir`. When even the header line exceeds `maxBytes`, the result is that line clipped to fit.
 */
export function decisionLogContext(dir: string, opts: ContextOptions = {}): string {
	const now = opts.now ?? new Date().toISOString();
	const maxBytes = opts.maxBytes ?? DECISION_LOG_MAX_BYTES;
	const entryBytes = opts.entryBytes ?? DECISION_LOG_ENTRY_BYTES;
	const entries = readLog(dir);
	const superseded = new Set(entries.map((e) => e.frontmatter.supersedes).filter((s): s is string => !!s && s !== "null" && s !== "~"));
	let picked = entries.filter((e) => e.frontmatter.status !== "superseded" && !superseded.has(basename(e.path)) && !superseded.has(basename(e.path, ".md")));
	if (opts.since) picked = picked.filter((e) => e.date > opts.since!);
	else {
		const floor = new Date(Date.parse(now) - 14 * 86_400_000).toISOString();
		picked = picked.filter((e) => e.date > floor).slice(-(opts.cap ?? 10));
	}
	if (picked.length === 0) return "";
	const head = [`# Decision log for this repository (${picked.length} entr${picked.length === 1 ? "y" : "ies"} ${opts.since ? `since the last 2.0 workload closed ${opts.since}` : "from the last 14 days"})`, ""];
	if (utf8(head[0]!) > maxBytes) return clip(head[0]!, maxBytes);
	const names = picked.map((e) => basename(e.path));
	// listBytes[m]: the NOT_RENDERED block naming every one of names[0 .. m)
	const listBytes = [utf8(NOT_RENDERED) + 1];
	for (const n of names) listBytes.push(listBytes.at(-1)! + utf8(`- ${n}`) + 1);
	let used = blockBytes(head);
	const rendered: string[][] = [];
	let unrendered = 0; // picked[0 .. unrendered) are listed by name only
	for (let i = picked.length - 1; i >= 0; i--) {
		const e = picked[i]!;
		const name = names[i]!;
		// room kept for the name list, should this entry not fit: every name through this one when that
		// fits in what is left, else the heading and the count line; nothing when not even those fit
		const left = maxBytes - used;
		const short = blockBytes([NOT_RENDERED, notRenderedMore(i + 1, dir)]);
		const older = listBytes[i + 1]! <= left ? listBytes[i + 1]! : short <= left ? short : 0;
		const heading = `## ${name} (${e.engineer}, ${e.frontmatter.status ?? "status unknown"}${e.frontmatter.durable ? `, durable: ${e.frontmatter.durable}` : ""})`;
		const content: string[] = [];
		const decisions = section(e.body, "Decisions made");
		const heads = section(e.body, "Heads-up");
		const dead = section(e.body, "Dead ends");
		if (decisions) content.push("### Decisions made (and why)", ...decisions.split("\n"));
		if (dead) content.push("### Dead ends", ...dead.split("\n"));
		if (heads) content.push("### Heads-up", ...heads.split("\n"));
		if (!decisions && !heads && !dead) content.push(...e.body.trim().split("\n").slice(0, 12));
		const block = fitEntry(heading, content, Math.min(entryBytes, left - older), name);
		if (!block) {
			unrendered = i + 1;
			break;
		}
		rendered.unshift(block);
		used += blockBytes(block);
	}
	const out = [...head, ...rendered.flat()];
	if (unrendered > 0) out.push(...fitNames(names.slice(0, unrendered), maxBytes - used, dir));
	return out.join("\n").trimEnd();
}

/**
 * The repo an open workload is on, from its `repo:` entry — the surface's, or the train tick's on a fix workload it opened
 * (PLAN wl-mv8s8srodefytc D8); never a lane's (Codex review B7: a lane's note never routes git). An entry Jo reversed
 * (an effective surface `forgery-reversed:` of the workload naming it, PLAN wl-mvfxw3c4zqfzls D5; jo-channel.ts
 * `reversedRowIds`) is skipped; one whose reversal was itself reversed counts again.
 */
export function repoOf(ledger: Ledger, workloadId: string): string | null {
	const rows = ledger.entries(workloadId, "assumption");
	const reversed = reversedRowIds(rows);
	for (let i = rows.length - 1; i >= 0; i--) {
		const e = rows[i]!;
		if (reversed.has(e.id)) continue;
		if ((e.created_by === SURFACE_BY || e.created_by === MERGE_TRAIN_BY) && e.body.startsWith(REPO_PREFIX)) return e.body.slice(REPO_PREFIX.length).trim();
	}
	return null;
}

/** Record which repository a workload is on (once, at open). */
export function recordRepo(ledger: Ledger, workloadId: string, repo: string): string {
	return ledger.recordEntry({ by: SURFACE_BY, workloadId, kind: "assumption", body: `${REPO_PREFIX} ${repo}` });
}

export interface CloseRender {
	path: string;
	text: string;
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "workload";

/** Local wall-clock parts of an ISO instant as the filename wants them: YYYY-MM-DD and HHMM. */
export function stamp(iso: string): { day: string; hhmm: string } {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, hhmm: `${p(d.getHours())}${p(d.getMinutes())}` };
}

/** The instant in the template's `YYYY-MM-DDTHH:MM±HH:MM` form, local offset. */
export function localOffset(iso: string): string {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const { day, hhmm } = stamp(iso);
	return `${day}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/**
 * Render one decision-log entry for a workload about to close, from the ledger. Written to
 * `dir/YYYY-MM-DD--HHMM--<engineer>--<slug>.md`; the engineer slot is the orchestrator's name.
 * Sections: done slices with artifacts → What changed; instructions, answers, mode flips and
 * assumptions → Decisions; cancelled slices and withdrawn questions → Dead ends; open items,
 * held messages and pending reserved requests → Heads-up.
 */
export function renderClose(ledger: Ledger, workloadId: string, dir: string, identity: Identity | null, opts: { now?: string; session?: string; write?: boolean } = {}): CloseRender {
	const w = ledger.workload(workloadId);
	if (!w) throw new Error(`no workload ${workloadId}`);
	const now = opts.now ?? ledger.now();
	const engineer = authorSlug(identity);
	const { day, hhmm } = stamp(now);
	const path = join(dir, `${day}--${hhmm}--${engineer}--${slugify(w.brief)}.md`);
	const slices = ledger.db.query<{ id: string; task: string; state: string; artifact: string | null; done_condition: string }, [string]>(
		"SELECT id, task, state, artifact, done_condition FROM slices WHERE workload_id = ? ORDER BY created_at, id").all(workloadId);
	const questions = ledger.db.query<{ id: string; slice_id: string; body: string; state: string; options: string }, [string]>(
		"SELECT id, slice_id, body, state, options FROM questions WHERE workload_id = ? ORDER BY created_at, id").all(workloadId);
	// The record keeps every row, a reversed one included (PLAN wl-mvfxw3c4zqfzls D5); the reversal entry says why.
	const instructions = ledger.instructions(workloadId, { withReversed: true });
	const entries = ledger.entries(workloadId);
	const held = ledger.db.query<{ id: string; body: string; state: string }, [string]>(
		"SELECT id, body, state FROM messages WHERE workload_id = ? AND state <> 'acted-on' ORDER BY created_at, id").all(workloadId);

	const changed = slices.filter((s) => s.state === "done").map((s) => `- ${s.id}: ${s.task} — artifact: ${s.artifact ?? "none recorded"}`);
	const decisions: string[] = [];
	for (const i of instructions) {
		if (i.kind === "instruction") decisions.push(`- ${i.author} (${i.channel})${i.slice_id ? ` on ${i.slice_id}` : ""}: ${i.body}`);
		else if (i.kind === "answer") {
			const q = questions.find((x) => x.id === i.question_id);
			decisions.push(`- ${i.author} answered "${i.body}" to ${i.question_id}${q ? ` (${q.body})` : ""}`);
		} else if (i.kind === "mode-flip") decisions.push(`- ${i.author} flipped mode to ${i.body}`);
	}
	// Control entries (launch:, lane-started:, plan:, done:, …) are machinery; done:/done-because: head the entry instead.
	for (const e of entries) {
		if (e.kind === "assumption" && !e.body.startsWith(REPO_PREFIX) && reservedPrefix(e.body) === null) {
			decisions.push(`- assumption (${e.created_by}${e.slice_id ? `, ${e.slice_id}` : ""}): ${e.body}`);
		}
	}
	const dead: string[] = [];
	for (const s of slices) if (s.state === "cancelled") dead.push(`- ${s.id} cancelled: ${s.task}`);
	for (const i of instructions) if (i.kind === "withdrawal") {
		const q = questions.find((x) => x.id === i.question_id);
		dead.push(`- ${i.question_id} withdrawn (then ${i.disposition}): ${i.body}${q ? ` — the question was: ${q.body}` : ""}`);
	}
	const heads: string[] = [];
	for (const s of slices) if (s.state === "open" || s.state === "paused") heads.push(`- ${s.id} still ${s.state}: ${s.task}`);
	for (const q of questions) if (q.state === "open") heads.push(`- ${q.id} still open on ${q.slice_id}: ${q.body}`);
	for (const m of held) heads.push(`- message ${m.id} [${m.state}] not acted on: ${m.body}`);
	for (const r of reservedStates(ledger, workloadId)) {
		const s = r.state;
		const why = s.kind === "approved" || s.kind === "denied" ? ` — ${s.kind}`
			: s.kind === "withdrawn" ? ` — withdrawn by ${s.by}${s.reason ? `: ${s.reason}` : ""}`
			: s.kind === "lane-stopped" ? ` — closed: ${s.lane} stopped holding the workload`
			: s.kind === "superseded" ? ` — superseded by ${s.by}`
			: "";
		heads.push(`- reserved request ${r.id}: ${r.body}${why}`);
	}
	const none = "- none";
	const holders = holdersOf(entries, w.holder, ledger.holders(workloadId));
	const control = controlEntries(entries, holders);
	const outcome = doneLine(control);
	const receipt = doneBecause(entries, holders);
	const text = [
		"---",
		`date: ${localOffset(now)}`,
		`engineer: ${identity?.name ?? "orchestrator"}`,
		`session: ${opts.session ?? workloadId}`,
		`status: resolved`,
		`durable: false`,
		`supersedes:`,
		`workload: ${workloadId}`,
		"---",
		"",
		`# ${w.brief}`,
		"",
		...(outcome !== null ? [`done: ${outcome}`, `done-because: ${receipt ?? "(no receipt recorded)"}`, ""] : []),
		`Rendered from the ledger by ${identity ? `${identity.name} (${identity.pronouns})` : "the orchestrator surface"} at workload close; stakes ${w.stakes}, mode ${w.mode}, opened ${w.created_at}.`,
		"",
		"## What changed",
		"",
		...(changed.length ? changed : [none]),
		"",
		"## Decisions made (and why)",
		"",
		...(decisions.length ? decisions : [none]),
		"",
		"## Dead ends — don't retry these",
		"",
		...(dead.length ? dead : [none]),
		"",
		"## Heads-up for whoever touches this next",
		"",
		...(heads.length ? heads : [none]),
		"",
	].join("\n");
	if (opts.write !== false) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, text);
	}
	return { path, text };
}
