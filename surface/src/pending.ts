// `pending` (PLAN wl-mv5msri070p0qo D1): everything waiting on Jo's word as one block of answer
// lines, built from ledger state with no model turn. Pure: reads only; the surface shows the block
// (surface/extensions/surface-input.ts) and Jo's paste of it is read by surface/src/input.ts.
//
// What it covers, in errorLines' order (surface/src/errors.ts): every waiting reserved request
// (`waitingReserved`, the standing workload's included), then every open question on an open
// workload: lanes' questions, the classifier's round-limit and park questions, and the orchestrator's own questions on
// the standing workload.
//
// Each answerable row is one line inside the fence, a whole exact answer:
//   <word> <id>  # <subject> — on <workload words> · <recommended (where) | no recommendation recorded> · also: <others>[ / withdraw]
// The word is the recorded recommendation, else the row's first option (`approve` for a reserved
// request). `withdraw` is offered in a question's tail only: it does not apply to reserved requests.
// A question with an option of more than one word has no answer line (`interpret` reads two words
// at most); it is a sentence under the fence and is counted. Prompt waits (`openPromptWaits`) cannot
// be answered at the surface: a sentence each under the fence, never counted. Every line of the
// block that names an open plan question by its `q-…` id (its own answer line or sentence, another
// question's subject, a prompt wait) has `  plan for q-…: <path>` beneath it (surface/src/plan-paths.ts,
// the every-mention rule); a paste reads that line as the block's own generated text, never as an
// answer or as Jo's words. A question whose `pair` offer is valid (`openPairOffer`, surface/src/input.ts)
// lists its options less `pair` and has `  ↳ pair offer: …` beneath its answer line or sentence (PLAN
// wl-mvb9mw00ycfjeo D4), which a paste reads by the same rule as the plan path line, and which Jo's
// input row leaves out of a prompt with no command (`withoutPairOffers`, R3).
import type { Ledger } from "../../ledger/src/index";
import { clip, controlOf, plain, sameCall, waitingReserved, wordsOf } from "./errors";
import { openPairOffer } from "./input";
import { isPlanQuestionIn } from "./launch";
import { questionSubject } from "./orchestrator-question";
import { pairPendingLine, shownOptions } from "./pair-suggest";
import { openPlanPath, planLine, QUESTION_ID } from "./plan-paths";
import { openPromptWaits } from "./signals";
import { STANDING_WORKLOAD_ID } from "./types";

export interface PendingItem {
	kind: "question" | "reserved";
	/** q-… or en-… */
	id: string;
	workloadId: string;
	/** The question's options as stored; a reserved request's are ["approve", "deny"]. */
	options: string[];
	/** The line's answer word: the recorded recommendation, else the first option; null when an option is multiword. */
	answer: string | null;
	/** The recorded recommendation (D1 precedence), else null. */
	recommended: string | null;
	/** Where the recommendation is recorded: `review: approve-with-changes`, `the default`, `recommended`; null with none. */
	recordedWhere: string | null;
	/** Plain words, clipped. */
	subject: string;
	/** The workload's newest `done:` line, else its brief's first line, clipped. */
	workloadWords: string;
	/** The plan file path when the row is an open plan question (`openPlanPath`), else absent. */
	planPath?: string | null;
	/** The signals of the question's valid `pair` offer (`openPairOffer`), else absent. */
	pairSignals?: string[] | null;
}

/** The longest answer line inside the fence (D1 formatting); a plan path line beneath one is never cut. */
export const PENDING_LINE_MAX = 240;
/** The block's empty case. */
export const PENDING_EMPTY = "## pending: nothing is waiting on you";
const PASTE_HINT = "(paste the block back as is, or any of its lines; change a line's first word to pick another option)";
const SUBJECT_MAX = 80;
const RESERVED_MAX = 60;
const RESERVED_OPTIONS = ["approve", "deny"];
/** `<option> (recommended)`, `<option> (the default)`, `<option> (default)`: the marks a question body records a recommendation with (rule 3). */
const MARK = /([^\s`*(]+)[`*]*\s*\((recommended|the default|default)\)/gi;

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
 * a mark in the body; otherwise none. Never inferred from the question's type alone.
 */
function recommendation(q: { body: string; options: string[] }, plan: boolean): { option: string; where: string } | null {
	if (plan) {
		const verdict = reviewVerdict(q.body);
		const approve = optionOf(q.options, "approve");
		return verdict && approve && /^(approve|accept)/i.test(verdict) ? { option: approve, where: `review: ${verdict}` } : null;
	}
	return marked(q.body, q.options);
}

/** Every waiting reserved request, then every open question, on the open workloads (errorLines' order). */
export function pendingItems(ledger: Ledger): PendingItem[] {
	const reserved: PendingItem[] = [];
	const questions: PendingItem[] = [];
	for (const { workload, openQuestions } of ledger.inFlight()) {
		const wl = workload.id;
		const standing = wl === STANDING_WORKLOAD_ID;
		const control = controlOf(ledger, wl, workload.holder);
		const words = standing ? "a session bound to no workload" : wordsOf(ledger, wl, control);
		for (const r of waitingReserved(ledger, wl)) {
			reserved.push({
				kind: "reserved", id: r.id, workloadId: wl, options: [...RESERVED_OPTIONS], answer: RESERVED_OPTIONS[0]!, recommended: null, recordedWhere: null,
				subject: `reserved action: ${clip(plain(sameCall(r.body)), RESERVED_MAX)}`, workloadWords: words,
			});
		}
		for (const q of openQuestions) {
			const plan = !standing && isPlanQuestionIn(control, q);
			const rec = recommendation(q, plan);
			const oneWord = q.options.length > 0 && q.options.every((o) => !/\s/.test(o));
			const firstLine = clip(plain(q.body.split("\n")[0] ?? ""), SUBJECT_MAX) || "a question";
			let workloadWords = words;
			if (standing) {
				const about = questionSubject(ledger, q.id);
				workloadWords = about ? `your orchestrator's question about ${wordsOf(ledger, about)}` : "your orchestrator's question";
			}
			const offer = standing ? null : openPairOffer(ledger, q);
			questions.push({
				kind: "question", id: q.id, workloadId: wl, options: [...q.options],
				answer: oneWord ? (rec?.option ?? q.options[0]!) : null,
				recommended: rec?.option ?? null, recordedWhere: rec?.where ?? null,
				subject: plan ? clip(`plan for ${words}`, SUBJECT_MAX) : firstLine, workloadWords,
				planPath: plan ? openPlanPath(ledger, q.id) : null,
				pairSignals: offer?.signals ?? null,
			});
		}
	}
	return [...reserved, ...questions];
}

/** One sentence per unresolved prompt wait on an open workload: shown under the block, never counted. */
export function pendingWaits(ledger: Ledger): string[] {
	const out: string[] = [];
	for (const { workload } of ledger.inFlight()) {
		const words = workload.id === STANDING_WORKLOAD_ID ? "a session bound to no workload" : wordsOf(ledger, workload.id);
		for (const w of openPromptWaits(ledger, workload.id)) {
			out.push(`${w.lane} on ${words} is blocked on a ${w.toolName} prompt it should never open (since ${w.created_at}): ${clip(plain(w.reason), 100)}; answer it in that session or end the session.`);
		}
	}
	return out;
}

const noteOf = (item: PendingItem): string =>
	item.recommended === null ? "no recommendation recorded" : item.recordedWhere && item.recordedWhere !== "recommended" ? `recommended (${item.recordedWhere})` : "recommended";

/**
 * The answer line of an item with a one-word answer; the subject gives way so the line fits
 * PENDING_LINE_MAX, and when the subject at its shortest is not enough the `also:` list drops
 * options from its end behind `…`. The answer word and the id are never cut. A stored `pair` is not
 * listed (PLAN wl-mvb9mw00ycfjeo D2): its offer has a line of its own.
 */
function answerLine(item: PendingItem, answer: string): string {
	const others = [...shownOptions(item.options).filter((o) => o !== answer), ...(item.kind === "question" ? ["withdraw"] : [])];
	const head = `${answer} ${item.id}  # `;
	const lead = ` — on ${item.workloadWords} · ${noteOf(item)} · also: `;
	const shortest = Math.min(item.subject.length, 1);
	let kept = others.length;
	let rest = lead + others.join(" / ");
	while (kept > 0 && head.length + shortest + rest.length > PENDING_LINE_MAX) rest = lead + [...others.slice(0, --kept), "…"].join(" / ");
	return `${head}${clip(item.subject, PENDING_LINE_MAX - head.length - rest.length)}${rest}`;
}

/** Why a question has no answer line: its options are not one word each, or its answer word and id alone overrun PENDING_LINE_MAX. */
const NOT_ONE_WORD = "are not one word each";
const TOO_LONG = "are too long for an answer line";

/** The sentence for a question with no answer line that would read back (`why`: NOT_ONE_WORD or TOO_LONG). */
function wordsSentence(item: PendingItem, why: string): string {
	const rec = item.recommended === null ? "no recommendation recorded" : `${item.recommended} ${noteOf(item)}`;
	return `${item.id} on ${item.workloadWords} asks: ${item.subject}; its options (${shownOptions(item.options).join(" / ")}) ${why}, so it has no answer line (${rec}); answer it in words.`;
}

/**
 * `line`, then `  plan for q-…: <path>` for each open plan question it names by id, once each, in the order named; then
 * the item's `  ↳ pair offer: …` line when `item` (the row the line is for) has a valid offer.
 */
function withPlanLines(line: string, plans: Map<string, string>, item: PendingItem | null = null): string[] {
	const out = [line];
	const done = new Set<string>();
	for (const [id] of line.matchAll(QUESTION_ID)) {
		const path = plans.get(id);
		if (path === undefined || done.has(id)) continue;
		done.add(id);
		out.push(`  ${planLine({ ref: id, path })}`);
	}
	if (item?.pairSignals) out.push(pairPendingLine(item.id, item.workloadId, item.pairSignals));
	return out;
}

/**
 * The block Jo reads: a header with the count, one fenced `text` block of answer lines, then the
 * sentences for questions with no answer line (counted), then `waits` (not counted). Every line
 * naming an open plan question has its `  plan for q-…: <path>` line right beneath it, and every
 * question with a valid `pair` offer its `  ↳ pair offer: …` line. `count` is the items.
 */
export function pendingBlock(items: PendingItem[], waits: string[] = []): { text: string; count: number } {
	const count = items.length;
	const plans = new Map(items.flatMap((item) => (item.planPath ? [[item.id, item.planPath] as const] : [])));
	const fenced: string[] = [];
	const below: string[] = [];
	for (const item of items) {
		if (item.answer === null) {
			below.push(...withPlanLines(wordsSentence(item, NOT_ONE_WORD), plans, item));
			continue;
		}
		const line = answerLine(item, item.answer);
		if (line.length <= PENDING_LINE_MAX) fenced.push(...withPlanLines(line, plans, item));
		else below.push(...withPlanLines(wordsSentence(item, TOO_LONG), plans, item));
	}
	const header = count === 0 ? PENDING_EMPTY : `## pending: ${count} ${count === 1 ? "thing waits" : "things wait"} on you${fenced.length > 0 ? ` ${PASTE_HINT}` : ""}`;
	const out = [header];
	if (fenced.length > 0) out.push("```text", ...fenced, "```");
	out.push(...below, ...waits.flatMap((w) => withPlanLines(w, plans)));
	return { text: out.join("\n"), count };
}

/** The heading `pendingBlock` writes when something waits, less the paste hint it carries when there are answer lines. */
const PENDING_COUNT = /^## pending: \d+ (?:thing waits|things wait) on you$/;
/** A plan question's path line as `pendingBlock` writes it (trimmed); group 1 is the question id. */
const PLAN_LINE = /^plan for (q-[a-z0-9]+): \/.*$/;
/** A question's pair offer line as `pendingBlock` writes it (trimmed, `pairPendingLine`); group 1 is the question id. */
const PAIR_LINE = /^↳ pair offer: .*\. Answer pair (q-[a-z0-9]+) instead .*$/;
/** The lines `pendingBlock` hangs under a line naming their question id: the plan path line and the pair offer line. */
const HUNG = [PLAN_LINE, PAIR_LINE];
/** The question id of a hung line, or null when `line` is not one. */
const hungId = (line: string): string | null => HUNG.map((re) => re.exec(line)?.[1]).find((id) => id !== undefined) ?? null;
/** The generated lines `pendingBlock` writes under its fence: `wordsSentence`, a hung line and a `pendingWaits` line. */
const GENERATED_BELOW = [
	new RegExp(`^(?:q|en)-[a-z0-9]+ on .+ asks: .*; its options \\(.*\\) (?:${NOT_ONE_WORD}|${TOO_LONG}), so it has no answer line \\(.*\\); answer it in words\\.$`),
	...HUNG,
	/^\S+ on .+ is blocked on a \S+ prompt it should never open \(since [^)]*\): .*; answer it in that session or end the session\.$/,
];

/** A fenced line as pasted back: `<word> <id>`, with or without its `  # …` tail (Jo may change the word or drop the tail); group 1 is the id. */
const ANSWER_SHAPE = /^\S+ ((?:q|en)-[a-z0-9]+)(?:\s+#.*)?$/;

/**
 * The indexes of `lines` that are the wrapper of a complete `pending` block pasted back, and nothing
 * else. A block is one of the three shapes `pendingBlock` writes: the heading with its paste hint, the
 * ```` ```text ```` fence right under it, lines that are each an answer line or a hung line (a plan
 * path line or a pair offer line), at least one of them an answer line (Jo may delete or reorder
 * lines), and the ```` ``` ```` closing them, then any generated sentences directly under it; the
 * heading without the hint, then one or more generated sentences; or PENDING_EMPTY, then any
 * prompt-wait sentences. The wrapper is the heading, the two fence lines, the hung lines and the
 * generated sentences, never the answer lines. Outside a complete block, a hung line is wrapper when
 * the nearest line above it that is not a hung line names its question id (the line `pendingBlock`
 * hung it under). A heading, a fence or a sentence outside such a block (an unclosed fence, a heading
 * with Jo's prose under it) is Jo's and is kept (surface/src/input.ts interpretPaste).
 */
export function pendingWrapperLines(lines: string[]): Set<number> {
	const out = new Set<number>();
	const t = lines.map((l) => l.trim());
	const below = (from: number): number => {
		let j = from;
		while (j < t.length && GENERATED_BELOW.some((re) => re.test(t[j]!))) j++;
		return j;
	};
	for (let i = 0; i < t.length; i++) {
		const line = t[i]!;
		let end = -1;
		if (line === PENDING_EMPTY) end = below(i + 1);
		else if (PENDING_COUNT.test(line)) end = below(i + 1) > i + 1 ? below(i + 1) : -1;
		else if (line.endsWith(` ${PASTE_HINT}`) && PENDING_COUNT.test(line.slice(0, -PASTE_HINT.length - 1)) && t[i + 1] === "```text") {
			let k = i + 2;
			while (k < t.length && (ANSWER_SHAPE.test(t[k]!) || hungId(t[k]!) !== null)) k++;
			if (t.slice(i + 2, k).some((l) => ANSWER_SHAPE.test(l)) && t[k] === "```") {
				out.add(i + 1).add(k);
				for (let j = i + 2; j < k; j++) if (hungId(t[j]!) !== null) out.add(j);
				end = below(k + 1);
				for (let j = k + 1; j < end; j++) out.add(j);
				out.add(i);
				i = end - 1;
			}
			continue;
		}
		if (end === -1) continue;
		for (let j = i; j < end; j++) out.add(j);
		i = end - 1;
	}
	for (let j = 1; j < t.length; j++) {
		const id = hungId(t[j]!);
		if (id === null || out.has(j)) continue;
		let h = j - 1;
		while (h > 0 && hungId(t[h]!) !== null) h--;
		if (hungId(t[h]!) === null && [...t[h]!.matchAll(QUESTION_ID)].some((m) => m[0] === id)) out.add(j);
	}
	return out;
}

/** The notice for a prompt that is nothing but a `pending` block's wrapper with its pair offer lines (`withoutPairOffers`): no input row. */
export const PENDING_WRAPPER_ONLY = "a pending block pasted back with no answer line and no words of Jo's: nothing applied, no input row; record nothing from it";

/**
 * `text` as Jo's words (PLAN wl-mvb9mw00ycfjeo R3): less the pair offer lines `pendingWrapperLines` recognises as a
 * `pending` block's own, so an offer line is never forwarded as Jo's words; `text` unchanged when it has none. Null
 * when it has some and every other non-blank line is that block's wrapper too: nothing of Jo's is left.
 */
export function withoutPairOffers(text: string): string | null {
	const lines = text.split("\n");
	const wrapper = pendingWrapperLines(lines);
	const offers = new Set([...wrapper].filter((i) => PAIR_LINE.test(lines[i]!.trim())));
	if (offers.size === 0) return text;
	if (lines.every((l, i) => wrapper.has(i) || l.trim().length === 0)) return null;
	return lines.filter((_, i) => !offers.has(i)).join("\n").trim();
}
