// `pending` (PLAN wl-mv5msri070p0qo D1; PLAN wl-mv7gidggnlkem8 readable rows): everything waiting on
// Jo's word as one block, built from ledger state with no model turn. Pure: reads only; the surface
// shows the block (surface/extensions/surface-input.ts) and Jo's paste of it is read by
// surface/src/input.ts through `pendingWrapperLines`.
//
// What it covers, in errorLines' order (surface/src/errors.ts): every waiting reserved request
// (`waitingReserved`, the standing workload's included), then every open question on an open
// workload: lanes' questions, the runner's ceiling questions, the classifier's round-limit and park
// questions, and the orchestrator's own questions on the standing workload. Each is one counted
// entry; prompt waits (`openPromptWaits`) follow as uncounted entries.
//
// The block: a heading carrying the count and the paste guide, then one ```` ```text ```` fence
// holding every entry, entries separated by a blank line. An entry is one logical line per field,
// nothing clipped, then its exact command last:
//   # Work: <the work's authored name>          (workload name; "Orchestrator decisions" on the standing workload)
//   # Question: <one plain question>            (authored ask, or the machine phrase map below)
//   # Context: at raise: <fixed machine line>   (ceiling and round-limit questions only)
//   # Request: <the exact reserved-request body> (reserved requests only)
//   # Metadata: missing <name|ask> for <id>; pending descriptions need initialization   (one per gap)
//   # Default: <option> (<why>); alternatives: <others>[ / withdraw]
//   <option> <id>                               (or `# Answer: in words; no pasteable command`)
//     plan for q-…: <path>                      (beneath every line naming an open plan question)
// The default is the recorded recommendation (a plan question's approving review verdict, the
// ceiling question's stop, a `(recommended)` mark in the body), else the first option; the reserved
// request's approve is first-listed and never a recommendation. A prompt wait is an entry of its own
// (`pendingWaits`): Work, the real choice (answer the prompt in that session, or end the session),
// its reason as Context, `# Default: none …`, Session, Since and an Answer line with no command.
//
// Asks are authored (surface/src/pending-details.ts), never summarised from a body: a lane's or the
// orchestrator's question shows its stored ask; the machine questions (plan, ceiling, round limit,
// park), detected through their own ledger readers, join fixed phrases for the options they actually
// offer; a plan question with a stored ask shows that instead. A gap (no name, no ask, an option no
// phrase covers) keeps the entry, its default and its command, and adds a `# Metadata:` line naming
// the missing field. Every value from a body or a request is one line with Unicode Cc, Cf, Zl and Zp
// characters written as `\u{…}` escapes, so nothing a caller wrote can hide or reorder the text.
import { parkQuestions } from "../../classifier/src/lab";
import type { EntryRow, InFlightWorkload, Ledger } from "../../ledger/src/index";
import { waitingReserved } from "./errors";
import { isCeilingQuestion, isReviewLimitQuestion } from "./input";
import { type ControlEntry, controlEntries, holdersOf, isPlanQuestionIn } from "./launch";
import { boundWorkload, questionDetails, workName } from "./pending-details";
import { openPlanPath, planLine, QUESTION_ID } from "./plan-paths";
import { openPromptWaits } from "./signals";
import { STANDING_WORKLOAD_ID } from "./types";

/** A display field an entry lacks: the work name (of a workload, or of an unbound orchestrator question) or a question's ask. */
export interface MetadataGap {
	field: "name" | "ask";
	/** The id the missing metadata belongs on: `wl-…` for a workload's name, `q-…` for a question's ask or an unbound question's name. */
	id: string;
}

export interface PendingItem {
	kind: "question" | "reserved";
	/** q-… or en-… */
	id: string;
	workloadId: string;
	/** The question's options as stored; a reserved request's are ["approve", "deny"]. */
	options: string[];
	/** The default: the recorded recommendation, else the first option (`approve` for a reserved request); null with no options. */
	defaultOption: string | null;
	/** The pasteable command's word (the default) when every option is one plain word; null when the entry is answered in words. */
	answer: string | null;
	/** The recorded recommendation (D1 precedence), else null. */
	recommended: string | null;
	/** Where the recommendation is recorded: `review: <verdict>`, `the default`, `recommended`; null with none. */
	recordedWhere: string | null;
	/** A plan question's review verdict when it recommends nothing (the default falls back to the first option), else null. */
	verdict: string | null;
	/** The work's name (`workName`, the standing workload's fixed name, or an unbound question's authored name); null when missing. */
	work: string | null;
	/** The plain question: authored, the reserved request's fixed ask, or a machine phrase-map ask; null when missing. */
	ask: string | null;
	/** A machine question's fixed at-raise line (its body's first line: the ceiling question's spend, the round-limit question's count), raw; else null. */
	context: string | null;
	/** A reserved request's exact authoritative body, raw; else null. */
	request: string | null;
	/** The display fields the entry lacks, name before ask. */
	missing: MetadataGap[];
	/** The plan file path when the row is an open plan question (`openPlanPath`), else null. */
	planPath: string | null;
}

/** The block's empty case: nothing waits and no prompt waits. */
export const PENDING_EMPTY = "## pending: nothing is waiting on you";
/** The paste guide the heading carries; the heading is recognized by the count grammar plus this exact text. */
const PASTE_HINT =
	"(to answer: /copy, pick this message and copy it whole, not /copy code; paste it whole, one entry, or only its command lines; " +
	"change a command's first word to pick another option, or delete it to leave that row; pasted untouched it takes every Default " +
	"and approves every reserved request; if a paste is refused, run pending again)";
/** The `pending` heading before its hint, in any layout this surface has written: `## pending: <n> thing(s) wait(s) on you`. */
const COUNT = /^## pending: \d+ (?:thing waits|things wait) on you$/;
const RESERVED_OPTIONS = ["approve", "deny"];
const RESERVED_ASK = "Should this reserved action be approved or denied?";
const ANSWER_IN_WORDS = "# Answer: in words; no pasteable command";
/** `<option> (recommended)`, `<option> (the default)`, `<option> (default)`: the marks a question body records a recommendation with (rule 3). */
const MARK = /([^\s`*(]+)[`*]*\s*\((recommended|the default|default)\)/gi;
/** What hides, reorders or breaks a line: Unicode Cc, Cf, Zl and Zp. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** One plain word: no whitespace and nothing HIDDEN, so the command reads back as typed. */
const PLAIN_WORD = /^[^\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

type Machine = "plan" | "ceiling" | "review-limit" | "park";
/** The machine questions' fixed phrases per option (Jo's approved maps); an option missing here leaves the ask to authored metadata. */
const PHRASES: Record<Machine, Readonly<Record<string, string>>> = {
	plan: { approve: "approve the plan", revise: "revise it", cancel: "cancel it" },
	ceiling: { stop: "continue at the current ceiling", extend: "extend the ceiling", split: "stop at the ceiling and split the remainder", pair: "stop autonomous work and switch this workload to user-driven" },
	"review-limit": { extend: "add review rounds", accept: "accept current findings", stop: "stop without passing", pair: "stop this review loop and switch this workload to user-driven" },
	park: { "same-lab": "use the builder's lab once", wait: "wait for another lab" },
};

/** `s` with every HIDDEN character written as a printable `\u{XXXX}` escape. */
function visible(s: string): string {
	return s.replace(HIDDEN, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

/** `s` as one visible line: whitespace runs (line breaks included) collapsed to one space, then `visible`. */
const oneLine = (s: string): string => visible(s.replace(/\s+/g, " ").trim());

/** `Should we a?`, `Should we a or b?`, `Should we a, b, or c?` from the phrases of the options offered, in their order; null when an option has no phrase. */
function machineAsk(phrases: Readonly<Record<string, string>>, options: readonly string[]): string | null {
	const said = options.map((o) => (Object.hasOwn(phrases, o.toLowerCase()) ? phrases[o.toLowerCase()]! : null));
	if (said.length === 0 || said.some((p) => p === null)) return null;
	const p = said as string[];
	const list = p.length === 1 ? p[0]! : p.length === 2 ? `${p[0]} or ${p[1]}` : `${p.slice(0, -1).join(", ")}, or ${p.at(-1)}`;
	return `Should we ${list}?`;
}

/** The verdict of a plan question body's `review: <verdict>, <model>, <path>` line, or null. */
function reviewVerdict(body: string): string | null {
	const line = body.split("\n").map((l) => l.trim()).find((l) => /^review:/i.test(l));
	const verdict = line?.slice("review:".length).split(",")[0]?.trim();
	return verdict ? verdict : null;
}

/** The stored option equal to `word`, case-insensitively, or null. */
const optionOf = (options: readonly string[], word: string): string | null => options.find((o) => o.toLowerCase() === word.toLowerCase()) ?? null;

/** Rule 3: the first `<option> (recommended|the default|default)` mark in the body naming one of the options. */
function marked(body: string, options: readonly string[]): { option: string; where: string } | null {
	for (const m of body.matchAll(MARK)) {
		const option = optionOf(options, m[1]!.replace(/^["'“]+|["'”]+$/g, ""));
		if (!option) continue;
		const mark = m[2]!.toLowerCase();
		return { option, where: mark === "default" ? "the default" : mark };
	}
	return null;
}

/**
 * The recorded recommendation (D1), in order: the plan question recommends `approve` only when its
 * `review:` verdict starts with approve or accept (any other verdict: none, nothing else consulted);
 * the runner's ceiling question recommends `stop`, which its body records as the default; a mark in
 * the body; otherwise none. Never inferred from the question's type alone.
 */
function recommendation(q: { body: string; options: string[] }, plan: boolean, ceiling: boolean): { option: string; where: string } | null {
	if (plan) {
		const verdict = reviewVerdict(q.body);
		const approve = optionOf(q.options, "approve");
		return verdict && approve && /^(approve|accept)/i.test(verdict) ? { option: approve, where: `review: ${verdict}` } : null;
	}
	if (ceiling) {
		const stop = optionOf(q.options, "stop");
		if (stop) return { option: stop, where: "the default" };
	}
	return marked(q.body, q.options);
}

type OpenQuestion = InFlightWorkload["openQuestions"][number];

/** Which machine question `q` is, read from each one's own ledger source (never from its options): the plan, ceiling, round-limit or park question; else null. */
function machineOf(ledger: Ledger, q: OpenQuestion, standing: boolean, control: readonly ControlEntry[], entries: readonly EntryRow[]): Machine | null {
	if (standing) return null;
	if (isPlanQuestionIn(control, q)) return "plan";
	if (isCeilingQuestion(q, ledger.slice(q.slice_id))) return "ceiling";
	if (isReviewLimitQuestion(ledger, q)) return "review-limit";
	if (parkQuestions(entries, q.slice_id).has(q.id)) return "park";
	return null;
}

/** One open question as an entry: its work name and ask from their authored or fixed sources, its default, and its gaps. */
function questionItem(ledger: Ledger, q: OpenQuestion, w: { standing: boolean; control: readonly ControlEntry[]; entries: readonly EntryRow[]; name: string | null }): PendingItem {
	const machine = machineOf(ledger, q, w.standing, w.control, w.entries);
	const rec = recommendation(q, machine === "plan", machine === "ceiling");
	const details = questionDetails(ledger, q.id);
	const missing: MetadataGap[] = [];
	// The work: the question's own workload; an orchestrator question's subject; an unbound one's own authored name.
	let work = w.name;
	let nameOn = q.workload_id;
	if (w.standing) {
		const bound = boundWorkload(ledger, q);
		work = bound === null ? (details?.name ?? null) : (workName(ledger, bound)?.name ?? null);
		nameOn = bound ?? q.id;
	}
	if (work === null) missing.push({ field: "name", id: nameOn });
	const fixed = machine === null ? null : machineAsk(PHRASES[machine], q.options);
	const ask = machine === "plan" ? (details?.ask ?? fixed) : (fixed ?? details?.ask ?? null);
	if (ask === null) missing.push({ field: "ask", id: q.id });
	const defaultOption = rec?.option ?? q.options[0] ?? null;
	const first = q.body.split("\n")[0]!.trim();
	return {
		kind: "question", id: q.id, workloadId: q.workload_id, options: [...q.options], defaultOption,
		answer: q.options.length > 0 && q.options.every((o) => PLAIN_WORD.test(o)) ? defaultOption : null,
		recommended: rec?.option ?? null, recordedWhere: rec?.where ?? null,
		verdict: machine === "plan" && rec === null ? reviewVerdict(q.body) : null,
		work, ask, context: (machine === "ceiling" || machine === "review-limit") && first !== "" ? first : null, request: null, missing,
		planPath: machine === "plan" ? openPlanPath(ledger, q.id) : null,
	};
}

/** Every waiting reserved request, then every open question, on the open workloads (errorLines' order). */
export function pendingItems(ledger: Ledger): PendingItem[] {
	const reserved: PendingItem[] = [];
	const questions: PendingItem[] = [];
	for (const { workload, openQuestions } of ledger.inFlight()) {
		const wl = workload.id;
		const entries = ledger.entries(wl);
		const control = controlEntries(entries, holdersOf(entries, workload.holder, ledger.holders(wl)));
		const name = workName(ledger, wl)?.name ?? null;
		for (const r of waitingReserved(ledger, wl)) {
			reserved.push({
				kind: "reserved", id: r.id, workloadId: wl, options: [...RESERVED_OPTIONS], defaultOption: RESERVED_OPTIONS[0]!, answer: RESERVED_OPTIONS[0]!,
				recommended: null, recordedWhere: null, verdict: null, work: name, ask: RESERVED_ASK, context: null, request: r.body,
				missing: name === null ? [{ field: "name", id: wl }] : [], planPath: null,
			});
		}
		for (const q of openQuestions) questions.push(questionItem(ledger, q, { standing: wl === STANDING_WORKLOAD_ID, control, entries, name }));
	}
	return [...reserved, ...questions];
}

const metadataLine = (g: MetadataGap): string => `# Metadata: missing ${g.field} for ${g.id}; pending descriptions need initialization`;

/**
 * One entry per unresolved prompt wait on an open workload, as the lines of one string: shown after
 * the counted entries, never counted. The choice is the real one (answer the prompt in the lane's
 * own session, or end that session); pending cannot answer it, so it has no command.
 */
export function pendingWaits(ledger: Ledger): string[] {
	const out: string[] = [];
	for (const { workload } of ledger.inFlight()) {
		const name = workName(ledger, workload.id)?.name ?? null;
		for (const w of openPromptWaits(ledger, workload.id)) {
			const lane = visible(w.lane);
			const reason = oneLine(w.reason);
			out.push([
				...(name === null ? [] : [`# Work: ${visible(name)}`]),
				`# Question: Will you answer the ${visible(w.toolName)} prompt in ${lane}'s session, or end that session?`,
				...(reason === "" ? [] : [`# Context: ${reason}`]),
				...(name === null ? [metadataLine({ field: "name", id: workload.id })] : []),
				"# Default: none — pending cannot answer a human prompt",
				`# Session: ${lane}${w.sessionId ? ` (session ${visible(w.sessionId)})` : ""}`,
				`# Since: ${visible(w.created_at)}`,
				`# Answer: in ${lane}'s own session, or end that session; no pasteable command`,
			].join("\n"));
		}
	}
	return out;
}

/** Why the default is the default: who recommends it, or that it is only the first option. */
function why(item: PendingItem): string {
	if (item.kind === "reserved") return "first option; NOT a recommendation";
	const where = item.recordedWhere;
	if (item.recommended !== null) return where?.startsWith("review: ") ? `recommended by ${where}` : where === "the default" ? "recommended; recorded as the default" : "recommended in the question";
	if (item.verdict !== null) return `first option; NOT a recommendation; review: ${item.verdict}`;
	return "first option; no recommendation recorded";
}

/** The `# Default:` value: the option and why, every other option (and `withdraw` on a question), the answer-in-words note when there is no command, and a reserved request's untouched-paste warning. */
function defaultText(item: PendingItem): string {
	if (item.defaultOption === null) return "none — no options recorded";
	const others = [...item.options.filter((o) => o !== item.defaultOption), ...(item.kind === "question" ? ["withdraw"] : [])];
	const alternatives = others.length > 0 ? `; alternatives: ${others.map(visible).join(" / ")}` : "";
	const words = item.answer === null ? "; the options are not one plain word each, so answer in words" : "";
	const warning = item.kind === "reserved" ? "; the block pasted untouched approves this request" : "";
	return `${visible(item.defaultOption)} (${oneLine(why(item))})${alternatives}${words}${warning}`;
}

/** An entry's lines, command last. */
function itemCard(item: PendingItem): string[] {
	return [
		...(item.work === null ? [] : [`# Work: ${visible(item.work)}`]),
		...(item.ask === null ? [] : [`# Question: ${visible(item.ask)}`]),
		...(item.context === null ? [] : [`# Context: at raise: ${oneLine(item.context)}`]),
		...(item.request === null ? [] : [`# Request: ${visible(item.request)}`]),
		...item.missing.map(metadataLine),
		`# Default: ${defaultText(item)}`,
		item.answer === null ? ANSWER_IN_WORDS : `${item.answer} ${item.id}`,
	];
}

/** `line`, then `  plan for q-…: <path>` for each open plan question it names by id, once each, in the order named. */
function withPlanLines(line: string, plans: Map<string, string>): string[] {
	const out = [line];
	const done = new Set<string>();
	for (const [id] of line.matchAll(QUESTION_ID)) {
		const path = plans.get(id);
		if (path === undefined || done.has(id)) continue;
		done.add(id);
		out.push(`  ${planLine({ ref: id, path })}`);
	}
	return out;
}

/** Every entry's lines as the block shows them, plan path lines included; `id` is the counted entry's row (a wait's is null). */
function entryCards(items: PendingItem[], waits: string[]): { id: string | null; lines: string[] }[] {
	const plans = new Map(items.flatMap((item) => (item.planPath ? [[item.id, item.planPath] as const] : [])));
	const cards = [...items.map((item) => ({ id: item.id as string | null, lines: itemCard(item) })), ...waits.map((w) => ({ id: null, lines: w.split("\n") }))];
	return cards.map((c) => ({ id: c.id, lines: c.lines.flatMap((l) => withPlanLines(l, plans)) }));
}

/**
 * The block Jo reads: the heading with the count and the paste guide, then one fenced `text` block
 * of entries (the items, counted, then `waits`, not counted), a blank line between entries. Every
 * line naming an open plan question has its `  plan for q-…: <path>` line right beneath it; it is
 * the one line that may follow a command. `count` is the items.
 */
export function pendingBlock(items: PendingItem[], waits: string[] = []): { text: string; count: number } {
	const count = items.length;
	if (count === 0 && waits.length === 0) return { text: PENDING_EMPTY, count };
	const body = entryCards(items, waits).flatMap((card, i) => [...(i === 0 ? [] : [""]), ...card.lines]);
	const heading = `## pending: ${count} ${count === 1 ? "thing waits" : "things wait"} on you ${PASTE_HINT}`;
	return { text: [heading, "```text", ...body, "```"].join("\n"), count };
}

// ---- reading a paste back -----------------------------------------------------------------------

/** A line in the shape of an entry's generated field. */
const CARD_LINE = /^# (?:Work|Question|Context|Request|Default|Metadata|Answer|Session|Since):(?: |$)/;
/** A plan question's path line as `pendingBlock` writes it (trimmed); group 1 is the question id. */
const PLAN_LINE = /^plan for (q-[a-z0-9]+): \/.*$/;
/** A command line naming a row (`<word> <id>`, the older layout's `  # …` tail allowed); group 1 is the id. */
const NAMED = /^\S+ ((?:q|en)-[a-z0-9]+)(?:\s+#.*)?$/;

/** `line` is a `pending` heading of any layout: the count grammar alone or with any hint after a space, or the empty case. */
const anyHeading = (line: string): boolean => line === PENDING_EMPTY || /^## pending: \d+ (?:thing waits|things wait) on you(?:\s|$)/.test(line);

/**
 * Complete, commandless cards have no row id on their Answer line. Recognize their whole shape
 * before reading the ledger: an edited or answered card must still reach the fail-closed reader,
 * while isolated metadata-looking fields remain ordinary words. Work and question evidence must
 * be distinct: a q-id's missing-name diagnostic cannot also stand in for its missing ask.
 * Order and rendered values are deliberately not validated here; the reader compares the entire
 * card to one current entry.
 */
function headerlessCards(lines: readonly string[]): { from: number; to: number }[] {
	const cards: { from: number; to: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!CARD_LINE.test(lines[i]!)) continue;
		let end = i;
		while (end < lines.length && (CARD_LINE.test(lines[end]!) || PLAN_LINE.test(lines[end]!))) end++;
		const fields = lines.slice(i, end).filter((line) => CARD_LINE.test(line));
		const names = fields.map((line) => /^# (\w+):/.exec(line)![1]!);
		const question = names.includes("Question") || fields.some((line) => /^# Metadata: missing ask for q-[a-z0-9]+; pending descriptions need initialization$/.test(line));
		const work = names.includes("Work") || fields.some((line) => /^# Metadata: missing name for (?:wl-|q-)[a-z0-9]+; pending descriptions need initialization$/.test(line));
		if (work && names.includes("Default") && question && names.includes("Answer")) cards.push({ from: i, to: end });
		i = end - 1;
	}
	return cards;
}

/** A pending heading or a complete unpasteable card needs a ledger read even without a command. */
export function pendingShaped(text: string): boolean {
	const lines = text.split("\n").map((line) => line.trim());
	return lines.some(anyHeading) || headerlessCards(lines).length > 0;
}

/** What `pendingWrapperLines` read in a paste. */
export interface PendingWrapper {
	/** Indexes of the lines that are pending's own generated text: never a command, never Jo's words. */
	lines: Set<number>;
	/** A current heading, PENDING_EMPTY, or complete commandless card is in the paste. */
	container: boolean;
	/** The index of a heading of another layout (an older block, or the heading edited or wrapped), or null. */
	old: number | null;
	/** Indexes of generated-looking lines or complete cards that do not match a current entry. */
	stale: number[];
}

/**
 * Read a paste against what `pending` shows now. A current heading admits generated fields in
 * its fence as before; fields outside a container attach to their named command as before.
 * A complete commandless card, without heading or fence, is recognized structurally and then
 * compared as a whole to ONE currently rendered entry (never a set of lines from several rows).
 * An edited, reordered or stale card fails closed; an incomplete field fragment stays prose.
 */
export function pendingWrapperLines(ledger: Ledger, lines: string[]): PendingWrapper {
	const t = lines.map((l) => l.trim());
	const cards = entryCards(pendingItems(ledger), pendingWaits(ledger));
	const shown = new Set(cards.flatMap((c) => c.lines.map((l) => l.trim())));
	const currentHeaderless = new Set(cards.filter((c) => c.lines.at(-1)?.trim().startsWith("# Answer:")).map((c) => c.lines.map((l) => l.trim()).join("\n")));
	const out = new Set<number>();
	const inside = new Set<number>();
	const stale: number[] = [];
	let container = false;
	let old: number | null = null;
	const headerless = headerlessCards(t);
	const inCard = new Set<number>();
	for (const { from, to } of headerless) {
		container = true;
		const current = currentHeaderless.has(t.slice(from, to).join("\n"));
		for (let i = from; i < to; i++) {
			inCard.add(i);
			if (current) out.add(i);
			else stale.push(i);
		}
	}
	for (let i = 0; i < t.length; i++) {
		const line = t[i]!;
		if (line === PENDING_EMPTY) {
			container = true;
			out.add(i);
		} else if (line.endsWith(` ${PASTE_HINT}`) && COUNT.test(line.slice(0, -PASTE_HINT.length - 1))) {
			// The current heading: the count grammar with any count, then exactly PASTE_HINT.
			container = true;
			out.add(i);
			if (t[i + 1] !== "```text") continue;
			out.add(i + 1);
			let k = i + 2;
			while (k < t.length && t[k] !== "```") inside.add(k++);
			if (k < t.length) out.add(k);
			i = k;
		} else if (anyHeading(line)) {
			old ??= i;
		}
	}
	// The entries' lines of the rows the paste's command lines name: what a field line outside a container may be.
	const named = new Set(t.flatMap((l, i) => (out.has(i) ? [] : (NAMED.exec(l)?.slice(1, 2) ?? []))));
	const attached = new Set(cards.flatMap((c) => (c.id !== null && named.has(c.id) ? c.lines.map((l) => l.trim()) : [])));
	/** The nearest line above `j` that is not a plan path line names question `id`. */
	const namedAbove = (j: number, id: string): boolean => {
		let h = j - 1;
		while (h >= 0 && PLAN_LINE.test(t[h]!)) h--;
		return h >= 0 && [...t[h]!.matchAll(QUESTION_ID)].some((m) => m[0] === id);
	};
	for (let i = 0; i < t.length; i++) {
		if (out.has(i) || inCard.has(i)) continue;
		const line = t[i]!;
		const plan = PLAN_LINE.exec(line);
		const field = CARD_LINE.test(line);
		if (inside.has(i)) {
			if (!field && !plan) continue;
			if (shown.has(line)) out.add(i);
			else stale.push(i);
		} else if (plan && namedAbove(i, plan[1]!)) {
			if (shown.has(line)) out.add(i);
			else stale.push(i);
		} else if (field && named.size > 0) {
			if (attached.has(line)) out.add(i);
			else stale.push(i);
		}
	}
	return { lines: out, container, old, stale };
}
