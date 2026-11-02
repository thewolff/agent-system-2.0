// P-11 row 1 (DESIGN-2.0.md:338; C2.1; SPEC-2.0.md § B16 items 1-2): a message addressed to Jo
// carries at most one ask, hands Jo a command only as a script path, and puts the needs-you block
// first and the closing ask last. On the orchestrator session it hands Jo no command at all,
// not even a script path: a lane runs it, or the ask is one word (tiers/orchestrator.md § What you
// never do). One named exception (2026-10-17, migration/items/pair-offer-own-line.md, the exception
// MIGRATION.md item 52 asked for): the by-hand `as2 lane wl-…` line that continues a user-driven
// workload, in plain text or inline code, never inside a shell fence. The row needs no code for it:
// `as2` is not a command head and not a script line, so it passes in prose and inline code, and a
// shell fence refuses every non-comment line. Refused, not warned. Runs on a top-level session's
// stop (hands never talk to Jo; OMP never fires session_stop for subagents,
// omp://extensions.md:349). On the orchestrator it also runs
// on the turn's finalized reply: a refused reply becomes one fixed marker line that quotes nothing
// from the draft and is rewritten, so the history Jo keeps holds the marker and the rewrite; the
// draft may show while it streams, because OMP does not retract streamed text
// (gates/extensions/r01-turn-shape.ts).
//
// The row reads no output-type labels: the output-types contract labels facts only (CLAIM and
// CITE), never asks. A structured ask is the voice document's closing ask (voice/VOICE.md
// § Message skeleton), opened by the section marker i-have-audhd's skeleton check also reads
// (plugins/i-have-audhd/checks/closing-ask-last.mjs, marker "Closing ask").
import type { Refusal } from "../types";

/**
 * The closing ask's section marker: a line that is only `Closing ask`, as a heading
 * (`## Closing ask`) or in bold (`**Closing ask**`), with an optional colon. The ask follows on the
 * next lines. A sentence that merely starts with the words ("Closing ask: approve it") is not one,
 * as in i-have-audhd (plugins/i-have-audhd/checks/lines.mjs, "Marker matching").
 */
const CLOSING_ASK = /^\s*(?:#{1,6}\s+)?[*_]*closing ask[*_]*\s*:?\s*[*_]*\s*$/i;
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
 * paragraph. Closing-ask markers, asks and trailing prose are all read from these lines.
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
 * The one normalization row 1 reads through: closing-ask markers, decision counting and the closing ask
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
 * A closing-ask line that is wholly one quoted question (`"Should I proceed?"`): the quote is the
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

/** A choice between options, in a prose check-in: an `or`, a which-question, or choosing between. "Should I pick this up?" is a yes/no. */
const CHOICE = /\bor\b|\bwhich\b|\b(?:choose|pick|decide)\s+between\b/i;
/** A decision phrased as an instruction with no question mark ("Pick main or feature and reply."). */
const IMPERATIVE_CHOICE = /^\s*(?:please\s+)?(?:pick|choose|decide|select|tell me|let me know)\b.*(?:\bor\b|\bwhich\b|\bbetween\b)/i;
/** A block-leading fact label (the output-types contract's two): its block, to the next blank line, asserts and asks nothing. */
const FACT_LABEL = /^\*\*(CLAIM|CITE)\*\*\s*$/;

/**
 * The text of each closing ask in a message to Jo: the lines after a CLOSING_ASK marker in the
 * author's own prose, running to the next marker or the end of the message (nothing but the ask's
 * options, a recommendation and the count line may follow an ask); fences and indented code
 * blanked. The text is the raw line (inline code kept), so an id written as `q-…` in backticks
 * still reads (P-11 row 15's publication binding and answer-first check).
 */
export function closingAsks(message: string): string[] {
	const { lines } = structure(message);
	const asks: string[] = [];
	let current: string[] | null = null;
	for (const line of lines) {
		if (CLOSING_ASK.test(ownProse(line))) {
			if (current) asks.push(current.join("\n").trim());
			current = [];
			continue;
		}
		current?.push(line);
	}
	if (current) asks.push(current.join("\n").trim());
	return asks;
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

/**
 * Row 1 over the final text of a turn addressed to Jo. `role` is the session speaking: a lane may
 * hand Jo a script path; the orchestrator hands over no command at all.
 */
export function checkTurnShape(message: string, role: "orchestrator" | "lane" = "lane"): Refusal {
	const text = message.trimEnd();
	const { lines, fences } = structure(text);
	const own = lines.map(ownProse);
	const problems: string[] = [];

	// (a) one ask per turn (M4 fix round 3, R3-S1). A question mark is not a decision by itself:
	// quoted and code text is exempt. A CLAIM or CITE block (its label line to the next blank line)
	// asserts and asks nothing, not even as an instruction to choose. A choice is the one closing ask
	// (a CLOSING_ASK marker, then the ask), last; unlabeled prose may carry one yes/no check-in only
	// when there is no closing ask, and then it is the last thing in the turn. The closing ask asks one
	// thing, in one sentence, with no second decision in it, its option list included (adversarial-1).
	// A marker or label inside inline code, a quote, a fence or an indented example is text (astra-5
	// R5-S1).
	//
	// A plain reply — no bold-only line anywhere, the trivial-ask path (tiers/orchestrator.md
	// § Trivial asks; SPEC-2.0.md § B15, amended 2026-09-30) — has no closing-ask marker to hold its
	// ask, so its prose may carry the one ask itself: one question mark or one instruction to choose,
	// one decision (options allowed), last.
	// A bold-only line is a label or marker, real or lookalike (`**ＣＬＡＩＭ**`, astra-6 P04): not a plain reply.
	const plain = own.every((l) => !/^\*\*[^*]+\*\*$/.test(l.trim()));
	const markers = own.flatMap((l, i) => (CLOSING_ASK.test(l) ? [i] : []));
	if (markers.length > 1) problems.push(`it carries ${markers.length} closing asks; a turn to Jo carries one ask, the rest are held and written down`);
	const marker = markers[0] ?? -1;
	let fact = "";
	let checkIns = 0;
	let checkInLine = -1;
	let plainAsks = 0;
	let plainAsk = "";
	const closingText: string[] = [];
	for (const [i, line] of own.entries()) {
		if (markers.includes(i)) continue;
		if (marker >= 0 && i > marker) {
			const quoted = closingText.join(" ").search(ASK_END) >= 0 ? null : WHOLLY_QUOTED.exec(lines[i]!);
			closingText.push(quoted?.[1] ?? line);
			continue;
		}
		const label = FACT_LABEL.exec(line.trim())?.[1];
		if (label) {
			fact = label;
			continue;
		}
		if (!line.trim()) {
			if (!lines[i]!.trim()) fact = "";
			continue;
		}
		const asks = line.match(ASK_END) ?? [];
		if (plain) {
			if (asks.length === 0 && !IMPERATIVE_CHOICE.test(line)) continue;
			plainAsks += Math.max(asks.length, 1);
			plainAsk = asks.length === 0 ? line : line.slice(0, line.search(ASK_END)).split(/[.!]\s/).at(-1)!;
			checkInLine = i;
			continue;
		}
		const who = fact ? `a ${fact}` : "unlabeled prose";
		if (asks.length === 0) {
			if (IMPERATIVE_CHOICE.test(line)) problems.push(`${who} asks Jo to choose ("${line.trim()}"); a choice is the one closing ask, last`);
			continue;
		}
		const sentence = line.slice(0, line.search(ASK_END)).split(/[.!:;]\s/).at(-1)!.trim();
		if (fact) problems.push(`${who} asks something ("${sentence}?"); an assertion asks nothing, and the one ask is the closing ask, last`);
		else if (CHOICE.test(line)) problems.push(`unlabeled prose offers Jo a choice ("${sentence}?"); a choice is the one closing ask, last`);
		else {
			checkIns += asks.length;
			checkInLine = i;
		}
	}
	if (checkIns > 1) problems.push(`its prose asks ${checkIns} things; a turn to Jo carries one ask`);
	else if (checkIns === 1 && marker >= 0) problems.push("a prose check-in asks beside the closing ask; a turn to Jo carries one ask, the closing ask, last");
	const plainDecisions = plainAsks === 1 ? decisions(plainAsk) : 0;
	if (plainAsks > 1) problems.push(`the plain reply asks ${plainAsks} things; a turn to Jo carries one ask`);
	else if (plainDecisions > 1) problems.push(`the plain reply joins ${plainDecisions} separate decisions in one ask; the one ask asks one thing, the rest are held and written down`);
	// The count line is exempt only as the message's last line (`text` is trimmed).
	const countLine = COUNT_LINE.test(lines.at(-1) ?? "") ? lines.length - 1 : -1;
	if ((checkIns === 1 && marker < 0) || plainAsks === 1) {
		const from = checkInLine + 1;
		const trailing = own.slice(from).find((l, j) => l.trim() && !FACT_LABEL.test(l.trim()) && from + j !== countLine && !OPTION_LINE.test(l) && !RECOMMENDATION_LINE.test(l));
		if (trailing) problems.push(`the closing ask is not last (prose follows it: "${trailing.trim()}")`);
		else if (own.slice(from).some((l) => FACT_LABEL.test(l.trim()))) problems.push("the closing ask is not last (a CLAIM or CITE block follows it)");
	}
	if (marker >= 0) {
		// Every line counts, bullets included: a bullet is an option only when it does not ask.
		const block = closingText.join(" ");
		const n = block.match(ASK_END)?.length ?? 0;
		if (n === 0) problems.push("its closing ask asks nothing (no question mark)");
		else if (n > 1) problems.push(`its closing ask asks ${n} things (question marks, option lines included); the one ask asks one thing, the rest are held and written down`);
		else {
			const d = decisions(block.slice(0, block.search(ASK_END)));
			if (d > 1) problems.push(`its closing ask joins ${d} separate decisions in one ask; the one ask asks one thing, the rest are held and written down`);
		}
	}

	// (b) commands handed to Jo. A lane hands over script paths, never bare commands. A shell fence:
	// every line is a command. Any other fence that is not code or data: every command-shaped line is.
	// Every fence spelling counts: `~~~bash` and four-backtick fences too (astra-5 R5-S2).
	//
	// The orchestrator hands over no command at all (tiers/orchestrator.md § What you never do): the
	// same fences with no script-path exemption, plus a script line in its own prose or as a whole
	// inline-code span. Inline code holding any other command is a receipt (`git status`), not a
	// hand-over, and stays allowed. The by-hand `as2 lane wl-…` line passes in prose and inline code
	// and is refused in a shell fence, which is the named exception of 2026-10-17
	// (migration/items/pair-offer-own-line.md, MIGRATION.md item 52).
	if (role === "orchestrator") {
		const handed = orchestratorHandOver(lines, fences);
		if (handed) problems.push(`it hands Jo a command (\`${handed}\`); a lane runs it, or ask Jo for one word`);
	} else {
		for (const f of fences) {
			if (CODE_FENCE.test(f.lang)) continue;
			const shell = SHELL_FENCE.test(f.lang);
			const bare = f.lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !SCRIPT_LINE.test(l) && (shell || COMMAND_LINE.test(l)));
			if (bare.length > 0) {
				problems.push(`it hands Jo a bare command (\`${bare[0]}\`); write it to a script under ~/agent-scratch/<repo>/ and hand over the one line \`zsh <path>\``);
				break;
			}
		}
	}

	// (c) needs-you block first: nothing substantive above a "Needs you" heading.
	const needsIdx = lines.findIndex((l) => NEEDS_YOU.test(l));
	if (needsIdx > 0) {
		const before = lines.slice(0, needsIdx).filter((l, i) => l.trim() && !/^#{1,6}\s/.test(l) && !FACT_LABEL.test(own[i]!.trim()));
		if (before.length > 0) problems.push(`the needs-you block is not first (${before.length} line(s) of content above it)`);
	}

	// (c) closing ask last: no CLAIM or CITE block follows the closing ask, and nothing but the ask's
	// own option list, a recommendation, or the count line as the message's last line follows its
	// question line (astra review S1: trailing prose passed; voice/VOICE.md § Older items are counted,
	// not re-listed). Read from the author's own prose, so a quote after the ask is not prose.
	if (marker >= 0) {
		const at = marker + 1;
		const later = own.slice(at).map((l) => FACT_LABEL.exec(l.trim())?.[1]).find((l) => l);
		if (later) problems.push(`the closing ask is not last (a **${later}** block follows it)`);
		else {
			const rest = own.slice(at);
			const q = rest.findIndex((l, j) => !markers.includes(at + j) && (l.search(ASK_END) >= 0 || WHOLLY_QUOTED.test(lines[at + j]!)));
			const from = at + q + 1;
			const trailing = q < 0 ? undefined : own.slice(from).find((l, j) => l.trim() && from + j !== countLine && !markers.includes(from + j) && !OPTION_LINE.test(l) && !RECOMMENDATION_LINE.test(l));
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
