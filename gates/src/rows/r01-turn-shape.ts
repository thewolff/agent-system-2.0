// P-11 row 1: a message addressed to Jo carries at most one ask/QUESTION and puts needs-you first
// and the closing ask last. Command execution policy belongs to tool-call gates; presenting a
// command is warning-only and checked for an explicit completion status, impact and reversal.
// Runs on a top-level session's stop (hands never talk to Jo; OMP never fires session_stop for
// subagents). On the orchestrator it also runs on the finalized reply: hard-stop defects are held
// for correction, while command-presentation defects reach Jo with a warning.
import { dispositionOf } from "../dispositions";
import type { Refusal } from "../types";

/**
 * A block label alone on its line. A GUESS may carry its basis (contract/output-types.md § Guess
 * basis): `**GUESS(inference)**`, `**GUESS(pattern)**`, `**GUESS(recall)**` label a block exactly
 * like `**GUESS**`, and the captured label keeps the basis so a refusal names the block as written.
 */
const BLOCK_LABEL = /^\*\*(CLAIM|CITE|GUESS(?:\((?:inference|pattern|recall)\))?|ACTION|QUESTION|PMDW)\*\*\s*$/;
const SHELL_FENCE = /^(sh|bash|zsh|shell|console|terminal|shell-session)$/i;
/**
 * Fences that hold code or data, never a command handed over to run. Every other fence (untagged,
 * an unknown tag) is checked for command-shaped lines: an untagged fence hid the same `git push` a
 * `bash` fence was refused for (astra review S1). `text`/`plain`/`output`/`log` are data, a
 * transcript shown to Jo (adversarial-1, Kimi: `$ git status` in a `text` fence was refused).
 */
const CODE_FENCE =
	/^(ts|tsx|typescript|js|jsx|javascript|mjs|cjs|json|jsonc|json5|yaml|yml|toml|ini|xml|html|css|scss|md|markdown|mermaid|diff|patch|py|python|rb|ruby|go|rs|rust|java|kt|kotlin|swift|c|cpp|h|hpp|cs|php|lua|sql|graphql|gql|csv|tsv|proto|dockerfile|makefile|nix|hcl|tf|text|txt|plain|plaintext|output|log)$/i;
/** The first word of a line that runs something: the command heads a handed-over line starts with. */
export const COMMAND_LINE =
	/^(?:\$\s+|%\s+|>\s+)?(?:sudo\s+)?(?:git|gh|npm|npx|pnpm|yarn|bun|bunx|node|deno|cd|rm|mv|cp|mkdir|rmdir|chmod|chown|ln|touch|curl|wget|brew|pip3?|python3?|uv|docker|kubectl|helm|make|just|cargo|go|ssh|scp|rsync|export|source|psql|mysql|sqlite3|terraform|tofu|echo|printf|cat|open|tar|unzip|launchctl|defaults|omp|claude|codex|vercel|netlify|fly|flyctl|aws|gcloud|supabase|doctl|heroku|wrangler|firebase|zsh|bash|sh|kill|pkill|killall|xargs|find|sed|awk)(?:\s|$)/;
/** The one form a command handed to Jo takes: run a script file (SPEC-2.0.md § B16 item 2). */
export const SCRIPT_LINE = /^(?:\$\s*)?(?:zsh|bash|sh)\s+(?:~|\/)\S*\.(?:sh|zsh|bash)\s*$/;
/**
 * After the closing ask, only its option list, a recommendation line, or the count line as the
 * message's last line may follow.
 */
const OPTION_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const RECOMMENDATION_LINE = /^\s*(?:\*\*|_)?(?:recommend(?:ed|ation|s)?|default)\b/i;
/**
 * The count line every message to Jo ends with, after the closing ask (voice/VOICE.md § Older items
 * are counted, not re-listed): ``N others waiting: `pending` shows them all``, or `nothing else
 * waiting` when N is 0. A footer stating a fact, not prose after the ask; read from the raw line,
 * since `ownProse` blanks the inline code around `pending`.
 */
const COUNT_LINE = /^\s*[*_]*(?:\d+\s+others?\s+waiting:\s+`?pending`?\s+shows\s+them\s+all|nothing\s+else\s+waiting)\.?[*_]*\.?\s*$/i;
const NEEDS_YOU = /^\s*(?:#{1,6}\s*|\*\*)?needs you\b/i;
const ENVELOPE = /<!--\s*output-types[\s\S]*?-->/g;

interface Fence {
	lang: string;
	lines: string[];
}

/**
 * A message split once into its structure (astra-5 R5-S1/S2): the fenced code blocks, and the lines
 * with every fence and indented code block blanked (line numbers kept). Fences follow CommonMark
 * (https://spec.commonmark.org/0.31.2/#fenced-code-blocks, fetched by astra-5): three or more
 * backticks or tildes indented at most three spaces, closed by the same character at least as long
 * with nothing after it, or by the end of the message. An indented code block (four spaces or a tab)
 * starts after a blank line and runs while lines stay indented or blank; it cannot interrupt a
 * paragraph. Block labels, asks and trailing prose are all read from these lines.
 */
function structure(text: string): { lines: string[]; fences: Fence[] } {
	const raw = text.split("\n");
	const lines: string[] = [];
	const fences: Fence[] = [];
	let open: { mark: string; fence: Fence } | null = null;
	let indented = false;
	for (const [i, line] of raw.entries()) {
		if (open) {
			const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
			if (close && close[1]![0] === open.mark[0] && close[1]!.length >= open.mark.length) open = null;
			else open.fence.lines.push(line);
			lines.push("");
			continue;
		}
		const start = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (start && !(start[1]![0] === "`" && start[2]!.includes("`"))) {
			const fence: Fence = { lang: start[2]!.trim().split(/\s+/)[0] ?? "", lines: [] };
			fences.push(fence);
			open = { mark: start[1]!, fence };
			indented = false;
			lines.push("");
			continue;
		}
		if (line.trim() === "") {
			lines.push(line);
			continue;
		}
		if (/^(?: {4}|\t)/.test(line) && (indented || i === 0 || raw[i - 1]!.trim() === "")) {
			indented = true;
			lines.push("");
			continue;
		}
		indented = false;
		lines.push(line);
	}
	return { lines, fences };
}

/**
 * One line with what is not the author's own prose blanked: inline code, URLs, HTML comments,
 * quoted text (`"…"`, `“…”`, `‘…’`, `*"…"*`), and whole lines that are blockquotes, indented code or
 * `//` comments (astra review round 3, R3-S1: a quoted or commented question is evidence, not an ask).
 * The one normalization row 1 reads through: block labels, decision counting and the closing ask
 * all use it (M4 fix round 4, S3). A straight quote opens after a non-word character and closes
 * before one: `12"` and `15"` are inch marks, not a quote span swallowing the ask between them.
 */
function ownProse(line: string): string {
	if (/^(?: {4}|\t)/.test(line) || /^\s*>/.test(line) || /^\s*\/\//.test(line)) return "";
	return line
		.replace(/`[^`\n]*`/g, "")
		.replace(/\bhttps?:\/\/\S+/g, "")
		.replace(/<!--.*?-->/g, "")
		.replace(/(?<![\w"])"[^"\n]*"(?!\w)|“[^”\n]*”/g, "")
		.replace(/‘[^’\n]*’/g, "");
}

/**
 * A QUESTION-block line that is wholly one quoted question (`"Should I proceed?"`): the quote is the
 * ask itself when the block has no ask yet. After the ask it is example text, quoted like any other
 * (astra-6 S3: `Main or feature?` then `“Example text?”` is one ask).
 */
const WHOLLY_QUOTED = /^\s*["“]([^"”\n]*[?？])["”]\s*$/;

/** Sentence-ending question marks, ASCII or full-width, with any `!` after (`?!`): followed by a space, a closing mark or the end of the line. */
const ASK_END = /[?？]+[!！]*(?=[\s)*_\]]|$)/g;

/**
 * Where one ask's clauses split: `;`, `:`, "also", and (fix round 4, S3) a comma or a bare "and".
 * Two clauses that each carry an `or` are two decisions ("main or feature, and today or
 * tomorrow?"); a list with one `or` ("A, B or C?") stays one.
 */
const CLAUSE_SPLIT = /[;:,]|\balso\b|\band\b/i;
/** An `or` that opens a new decision with its own verb ("pick main or feature or pick today or tomorrow"). */
const OR_VERB = /\bor\s+(?=(?:pick|choose|decide|select|should|shall|do|can|will|would|want)\b)/i;
/** A clause that is its own yes/no or which-question ("… and should I deploy today?"). */
const OWN_QUESTION = /^\s*(?:should|shall|do|does|did|can|could|will|would|may|might|is|are|am|was|were|want|which)\b/i;

/**
 * How many separate decisions one ask holds (adversarial-1). Clauses split at CLAUSE_SPLIT; one that
 * opens with a bare `or` continues the list before it ("today or tomorrow, or wait?" is one
 * three-way choice). A clause counts when it offers an `or` or is its own yes/no question ("merge
 * and should I deploy?" is two); one whose `or <verb>` parts each offer an `or` counts that many
 * ("pick A or B or pick C or D" is two, "should I ship or should I wait" one).
 *
 * A question head with no `or` of its own ("Which item opens first: A, or B?", "Does the PR, #1,
 * get merged now, or wait?") takes the first `or` clause after it as its options: one decision, not
 * two (M7 session 2026-09-30, Ilex's closing asks refused twice). A second `or` clause or a second
 * question after that still counts.
 */
function decisions(ask: string): number {
	const clauses: string[] = [];
	for (const part of ask.split(CLAUSE_SPLIT)) {
		if (clauses.length > 0 && /^\s*or\b/i.test(part) && !OR_VERB.test(part.trim())) clauses[clauses.length - 1] += ` ${part}`;
		else clauses.push(part);
	}
	let n = 0;
	let headAwaitsOptions = false;
	for (const clause of clauses) {
		const offers = /\bor\b/i.test(clause);
		const parts = clause.split(OR_VERB);
		if (parts.length > 1 && parts.every((p) => /\bor\b/i.test(p))) {
			n += parts.length;
			headAwaitsOptions = false;
		} else if (OWN_QUESTION.test(clause)) {
			n += 1;
			headAwaitsOptions = !offers;
		} else if (offers) {
			if (!headAwaitsOptions) n += 1;
			headAwaitsOptions = false;
		}
	}
	return n;
}

/** A choice between options, in a PMDW check-in: an `or`, a which-question, or choosing between. "Should I pick this up?" is a yes/no. */
const CHOICE = /\bor\b|\bwhich\b|\b(?:choose|pick|decide)\s+between\b/i;
/** A decision phrased as an instruction with no question mark ("Pick main or feature and reply."). */
const IMPERATIVE_CHOICE = /^\s*(?:please\s+)?(?:pick|choose|decide|select|tell me|let me know)\b.*(?:\bor\b|\bwhich\b|\bbetween\b)/i;

/**
 * The text of each real `**QUESTION**` block in a message to Jo, read the way row 1 reads blocks: a
 * bold label alone on its line in the author's own prose, running to the next block label; fences
 * and indented code blanked. The block text is the raw line (inline code kept), so an id written
 * as `wl-…` in backticks still reads (P-11 row 15's answer-first check, M7 fix round 2).
 */
export function questionBlocks(message: string): string[] {
	const { lines } = structure(message.replace(ENVELOPE, ""));
	const blocks: string[] = [];
	let current: string[] | null = null;
	for (const line of lines) {
		const label = BLOCK_LABEL.exec(ownProse(line).trim())?.[1];
		if (label) {
			if (current) blocks.push(current.join("\n").trim());
			current = label === "QUESTION" ? [] : null;
			continue;
		}
		current?.push(line);
	}
	if (current) blocks.push(current.join("\n").trim());
	return blocks;
}

/**
 * The first command an orchestrator turn hands Jo, or null (tiers/orchestrator.md § What you never
 * do). A fence that is not code or data: every non-comment line of a shell fence, and every
 * command- or script-shaped line of any other fence. Outside fences: a line of the author's own
 * prose that is a script line, and an inline-code span that is wholly one. Spans are read from the
 * structured lines (fences and indented code already blanked), since ownProse drops inline code.
 */
function orchestratorHandOver(lines: string[], fences: Fence[]): string | null {
	for (const f of fences) {
		if (CODE_FENCE.test(f.lang)) continue;
		const shell = SHELL_FENCE.test(f.lang);
		const handed = f.lines.map((l) => l.trim()).find((l) => l && (shell ? !l.startsWith("#") : COMMAND_LINE.test(l) || SCRIPT_LINE.test(l)));
		if (handed) return handed;
	}
	for (const line of lines) {
		const prose = ownProse(line).trim();
		if (SCRIPT_LINE.test(prose)) return prose;
		for (const span of line.matchAll(/`([^`\n]*)`/g)) {
			const code = span[1]!.trim();
			if (SCRIPT_LINE.test(code)) return code;
		}
	}
	return null;
}

/** Row 1 hard stops over the final text of a turn addressed to Jo. */
export function checkTurnShape(message: string, role: "orchestrator" | "lane" = "lane"): Refusal {
	const text = message.replace(ENVELOPE, "").trimEnd();
	const { lines, fences } = structure(text);
	const own = lines.map(ownProse);
	// Real output-type blocks only: a bold label alone on its line in the author's own prose. A label
	// inside inline code, a sentence, a fence or an indented example is text (astra-5 R5-S1).
	const labels = own.map((l) => BLOCK_LABEL.exec(l.trim())?.[1] ?? "");
	const problems: string[] = [];

	// (a) one ask per turn, as one structured decision block (M4 fix round 3, R3-S1). A question mark
	// is not a decision by itself: quoted and code text is exempt. An assertion (CLAIM/CITE/GUESS/
	// ACTION, or unlabeled prose) asks nothing, not even as an instruction to choose; a PMDW may carry
	// one yes/no check-in only when there is no QUESTION block, and then it is the last thing in the
	// turn; the one QUESTION block asks one thing, in one sentence, with no second decision in it, its
	// option list included (adversarial-1).
	//
	// A plain reply — no block-leading label anywhere, the trivial-ask path (tiers/orchestrator.md
	// § Trivial asks; SPEC-2.0.md § B15, amended 2026-09-30) — has no QUESTION block to hold its ask,
	// so its prose may carry the one ask itself: one question mark or one instruction to choose,
	// one decision (options allowed), last.
	// A bold-only line is a label, real or lookalike (`**ＱＵＥＳＴＩＯＮ**`, astra-6 P04): not a plain reply.
	const plain = own.every((l) => !/^\*\*[^*]+\*\*$/.test(l.trim()));
	const questionLines = labels.flatMap((l, i) => (l === "QUESTION" ? [i] : []));
	const questions = questionLines.length;
	if (questions > 1) problems.push(`it carries ${questions} QUESTIONs; a turn to Jo carries one ask, the rest are held and written down`);
	let label = "";
	let checkIns = 0;
	let checkInLine = -1;
	let plainAsks = 0;
	let plainAsk = "";
	const questionText: string[] = [];
	for (const [i, line] of own.entries()) {
		if (labels[i]) {
			label = labels[i]!;
			continue;
		}
		if (label === "QUESTION") {
			const quoted = questionText.join(" ").search(ASK_END) >= 0 ? null : WHOLLY_QUOTED.exec(lines[i]!);
			questionText.push(quoted?.[1] ?? line);
			continue;
		}
		const who = label ? `a ${label}` : "unlabeled prose";
		const asks = line.match(ASK_END) ?? [];
		if (plain) {
			if (asks.length === 0 && !IMPERATIVE_CHOICE.test(line)) continue;
			plainAsks += Math.max(asks.length, 1);
			plainAsk = asks.length === 0 ? line : line.slice(0, line.search(ASK_END)).split(/[.!]\s/).at(-1)!;
			checkInLine = i;
			continue;
		}
		if (asks.length === 0) {
			if (IMPERATIVE_CHOICE.test(line)) problems.push(`${who} asks Jo to choose ("${line.trim()}"); a choice is the one **QUESTION** block, last`);
			continue;
		}
		const sentence = line.slice(0, line.search(ASK_END)).split(/[.!:;]\s/).at(-1)!.trim();
		if (label !== "PMDW") problems.push(`${who} asks something ("${sentence}?"); an assertion asks nothing, and the one ask is a structured **QUESTION** block, last`);
		else if (CHOICE.test(line)) problems.push(`a PMDW offers Jo a choice ("${sentence}?"); a choice is the one **QUESTION** block, last`);
		else {
			checkIns += asks.length;
			checkInLine = i;
		}
	}
	if (checkIns > 1) problems.push(`its PMDW asks ${checkIns} things; a turn to Jo carries one ask`);
	else if (checkIns === 1 && questions > 0) problems.push("a PMDW check-in asks beside the QUESTION block; a turn to Jo carries one ask, the QUESTION, last");
	const plainDecisions = plainAsks === 1 ? decisions(plainAsk) : 0;
	if (plainAsks > 1) problems.push(`the plain reply asks ${plainAsks} things; a turn to Jo carries one ask`);
	else if (plainDecisions > 1) problems.push(`the plain reply joins ${plainDecisions} separate decisions in one ask; the one ask asks one thing, the rest are held and written down`);
	// The count line is exempt only as the message's last line (`text` is trimmed, the envelope gone).
	const countLine = COUNT_LINE.test(lines.at(-1) ?? "") ? lines.length - 1 : -1;
	if ((checkIns === 1 && questions === 0) || plainAsks === 1) {
		const from = checkInLine + 1;
		const trailing = own.slice(from).find((l, j) => l.trim() && !labels[from + j] && from + j !== countLine && !OPTION_LINE.test(l) && !RECOMMENDATION_LINE.test(l));
		if (trailing) problems.push(`the closing ask is not last (prose follows it: "${trailing.trim()}")`);
	}
	if (questions === 1) {
		// Every line counts, bullets included: a bullet is an option only when it does not ask.
		const block = questionText.join(" ");
		const asks = block.match(ASK_END)?.length ?? 0;
		if (asks === 0) problems.push("its QUESTION block asks nothing (no question mark)");
		else if (asks > 1) problems.push(`its QUESTION block asks ${asks} things (question marks, option lines included); the one ask asks one thing, the rest are held and written down`);
		else {
			const n = decisions(block.slice(0, block.search(ASK_END)));
			if (n > 1) problems.push(`its QUESTION block joins ${n} separate decisions in one ask; the one ask asks one thing, the rest are held and written down`);
		}
	}

	// Command execution is not message execution. Presentation defects are reported by
	// turnShapeWarnings and never added to this hard-stop list.

	// (c) needs-you block first: nothing substantive above a "Needs you" heading.
	const needsIdx = lines.findIndex((l) => NEEDS_YOU.test(l));
	if (needsIdx > 0) {
		const before = lines.slice(0, needsIdx).filter((l, i) => l.trim() && !/^#{1,6}\s/.test(l) && !labels[i]);
		if (before.length > 0) problems.push(`the needs-you block is not first (${before.length} line(s) of content above it)`);
	}

	// (c) closing ask last: no labeled block follows the QUESTION, and nothing but the ask's own
	// option list, a recommendation, or the count line as the message's last line follows the ask's
	// question line (astra review S1: trailing prose passed; voice/VOICE.md § Older items are
	// counted, not re-listed). Read from the author's own prose, so a quote after the ask is not prose.
	if (questions === 1) {
		const at = questionLines[0]! + 1;
		const later = labels.slice(at).find((l) => l);
		if (later) problems.push(`the closing ask is not last (a **${later}** block follows the QUESTION)`);
		else {
			const rest = own.slice(at);
			const askLine = rest.findIndex((l, j) => l.search(ASK_END) >= 0 || WHOLLY_QUOTED.test(lines[at + j]!));
			const from = at + askLine + 1;
			const trailing = askLine < 0 ? undefined : own.slice(from).find((l, j) => l.trim() && from + j !== countLine && !OPTION_LINE.test(l) && !RECOMMENDATION_LINE.test(l));
			if (trailing) problems.push(`the closing ask is not last (prose follows it: "${trailing.trim()}")`);
		}
	}

	if (problems.length === 0) return null;
	return {
		block: true,
		reason:
			`P-11 row 1 refused this turn to Jo: ${problems.join("; ")}. ` +
			`Shape: needs-you first, body, one closing ask last (SPEC-2.0.md § B16). Rewrite the message and send it again.`,
	};
}

/** Warning-only command-presentation defects. Execution gates remain hard stops. */
export function turnShapeWarnings(message: string, role: "orchestrator" | "lane" = "lane"): string[] {
	if (dispositionOf("command-presentation") !== "warn") return [];
	const text = message.replace(ENVELOPE, "").trimEnd();
	const { lines, fences } = structure(text);
	let command = orchestratorHandOver(lines, fences);
	if (role === "lane") {
		command = null;
		for (const f of fences) {
			if (CODE_FENCE.test(f.lang)) continue;
			const shell = SHELL_FENCE.test(f.lang);
			command = f.lines.map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !SCRIPT_LINE.test(l) && (shell || COMMAND_LINE.test(l))) ?? null;
			if (command) break;
		}
	}
	if (!command) return [];
	const missing = [
		/\bexecution status\s*:/i.test(text) ? null : "execution status",
		/\bimpact\s*:/i.test(text) ? null : "impact",
		/\breversal\s*:/i.test(text) ? null : "reversal",
	].filter((x): x is string => x !== null);
	return missing.length === 0
		? []
		: [`command presentation is missing ${missing.join(missing.length === 2 ? " and " : ", ").replace(/, ([^,]+)$/, ", and $1")}; the command may still be shown, but say whether execution completed and state its impact and reversal`];
}
