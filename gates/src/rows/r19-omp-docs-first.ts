// P-11 row 19, "OMP questions read OMP first" (PLAN wl-mv8k0fby51uakg D9, in-mv90pa1iolasjk; jo-issues#55):
// a question about OMP, the harness these sessions run in, is answered from OMP's own docs or source, not
// from memory. Pure: no OMP import. The adapter (gates/extensions/r19-omp-docs-first.ts) feeds it OMP's events.
//
// - A question starts at an input: Ilex's or a lane's `input` (interactive or rpc), a hand's task prompt.
//   Nothing else starts one, so a hidden continuation or an aside keeps the question it follows.
// - It triggers at once on a keyword (KEYWORDS, whole words, case-insensitive, over the whole input), else on
//   the judge, asked at the input and awaited at the first answer boundary. The judge is OMP's `judge` role
//   through classifier/src/judge-ask.ts askJudgment, shown each of judgeWindows(input) in parallel; a yes, an
//   error or a timeout on any window, too many windows, or no judge at all counts as triggered.
// - It is consulted once a successful `read`, `grep`, `find` or `search` (grep's legacy name) since the input
//   named an `omp://` doc, a file under an `@oh-my-pi/` package, or OMP-HARNESS.md / OMP-RUNTIME.md.
// - While triggered and unconsulted, every answer attempt is held, with no limit and no release. The hold
//   reason names WAY_OUT, a read that always exists, so a model is never held with nothing it can do.
import { askJudgment, type BoolQuestion, type JudgmentJudge } from "../../../classifier/src/judge-ask";
import { CHANNEL_REPLY_TOOL, LANE_MESSAGE_TOOL, LANE_RAISE_QUESTION_TOOL, RAISE_QUESTION_TOOL } from "../../../surface/src/types";

/** The words that make an input a question about OMP without asking the judge. */
export const KEYWORDS = ["omp", "oh-my-pi", "pi-coding-agent", "harness", "slash command", "/add-dir", "/collab", "/settings", "/login"] as const;

/**
 * Each keyword as a whole word: no letter, digit or underscore on either side (so `omp` is not found in
 * `compact`), a word may take a plural `s`/`es`, a space may be any run of spaces or hyphens, and a slash
 * command may not follow another `/` (`a/settings` is a path, not the command).
 */
const KEYWORD_PATTERNS: readonly (readonly [string, RegExp])[] = KEYWORDS.map((k) => {
	const body = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s-]+");
	const slash = k.startsWith("/");
	return [k, new RegExp(`(?<![\\w${slash ? "/" : ""}])${body}${slash ? "" : "(?:e?s)?"}(?!\\w)`, "i")] as const;
});

/** The first keyword `text` names, or null. */
export function keywordHit(text: string): string | null {
	return KEYWORD_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** One judge window: an input up to this many characters reaches the judge whole, in one call. */
export const JUDGE_WINDOW = 24_000;
/** Above JUDGE_WINDOW, each window repeats this many characters of the one before, so a question on a cut is whole in one. */
export const JUDGE_OVERLAP = 1_000;
/** The most windows the judge is asked about; an input needing more counts with no judge call. */
export const JUDGE_MAX_WINDOWS = 8;
/** How long the judge has, from the input to an answer: classifier/extension.ts gives its pair-signal ask the same 10 s. */
export const JUDGE_TIMEOUT_MS = 10_000;

/**
 * The windows the judge is shown of `text`: all of it up to JUDGE_WINDOW, else windows of JUDGE_WINDOW characters
 * each starting JUDGE_WINDOW - JUDGE_OVERLAP after the last, up to the one that reaches the end. Null when that takes
 * more than JUDGE_MAX_WINDOWS.
 */
export function judgeWindows(text: string): string[] | null {
	if (text.length <= JUDGE_WINDOW) return [text];
	const step = JUDGE_WINDOW - JUDGE_OVERLAP;
	const count = Math.ceil((text.length - JUDGE_OVERLAP) / step);
	if (count > JUDGE_MAX_WINDOWS) return null;
	return Array.from({ length: count }, (_, i) => text.slice(i * step, i * step + JUDGE_WINDOW));
}

/** The one judge question, keyed as askJudgment sends it. */
export const OMP_QUESTION: Record<"omp_question", BoolQuestion> = {
	omp_question: {
		type: "bool",
		instructions:
			"Is this message a direct question about OMP (oh-my-pi, the coding-agent harness), or a question about how to do something in a coding-agent harness?",
		criteria: {
			true: "It asks about OMP itself (its commands, flags, settings, tools, extensions, sessions, models) or how to do something in a coding-agent harness.",
			false: "Anything else: a task to carry out, machinery output, a status report, or a question about other software or about the work itself.",
		},
	},
};

/** Why a question is or is not one this row holds. */
export interface Trigger {
	triggered: boolean;
	why: string;
}

/** How the row reaches a judge: OMP's `judge` role in production, a fake in tests. A rejection counts as no judge. */
export type JudgeSource = () => Promise<JudgmentJudge>;

/**
 * The judge's reading of `text`, never rejecting: each window of judgeWindows(text) is asked in parallel, and a yes
 * (probability at least one half) on any of them triggers; all no does not; anything else triggers (fail closed), as
 * does an input needing more than JUDGE_MAX_WINDOWS. `timeoutMs` bounds the whole ask, the judge's own resolution
 * included; every call still out is aborted when it runs out or once one window has triggered.
 */
export async function judgeQuestion(text: string, judge: JudgeSource | undefined, timeoutMs: number = JUDGE_TIMEOUT_MS): Promise<Trigger> {
	if (!judge) return { triggered: true, why: "no judge is wired into this session, so every input counts" };
	const windows = judgeWindows(text);
	if (!windows)
		return { triggered: true, why: `the input is ${text.length} characters, more than ${JUDGE_MAX_WINDOWS} windows of ${JUDGE_WINDOW} the judge reads, so it counts` };
	const abort = new AbortController();
	const decided = Promise.withResolvers<Trigger>();
	const timer = setTimeout(() => decided.resolve({ triggered: true, why: `the judge did not answer within ${timeoutMs} ms, so the input counts` }), timeoutMs);
	const resolved = Promise.resolve().then(judge);
	const asks = windows.map(async (window, i): Promise<Trigger & { p: number }> => {
		const where = windows.length > 1 ? ` on window ${i + 1} of ${windows.length}` : "";
		try {
			const r = await askJudgment(await resolved, window, OMP_QUESTION, { timeoutMs, signal: abort.signal });
			if (!r.ok) return { triggered: true, p: 1, why: `the judge failed${where} (${r.reason}), so the input counts` };
			const a = r.answers.omp_question;
			const p = a?.type === "bool" ? a.bool : 1;
			return { triggered: p >= 0.5, p, why: `the judge read it as a question about OMP${where} (p=${p.toFixed(2)})` };
		} catch (err) {
			return { triggered: true, p: 1, why: `the judge was unavailable${where} (${String(err).split("\n")[0]}), so the input counts` };
		}
	});
	// The first window to trigger decides at once; otherwise the input passes once every window has said no.
	for (const ask of asks) void ask.then(({ triggered, why }) => triggered && decided.resolve({ triggered, why }));
	void Promise.all(asks).then((all) => {
		const { triggered, p, why } = all.find((one) => one.triggered) ?? all.reduce((most, one) => (one.p > most.p ? one : most));
		decided.resolve({ triggered, why: !triggered && all.length > 1 ? `the judge read none of its ${all.length} windows as a question about OMP (highest p=${p.toFixed(2)})` : why });
	});
	try {
		return await decided.promise;
	} finally {
		clearTimeout(timer);
		abort.abort();
	}
}

/** The tools whose successful result can be a consult. `search` is grep's legacy name (OMP tools/builtin-names.ts). */
const CONSULT_TOOLS: Record<string, true> = { read: true, grep: true, find: true, search: true };

/** One path or URL is OMP's own: an `omp://` doc, a file under an `@oh-my-pi/` package, or one of the two guides (a selector suffix allowed). */
export function ompDoc(path: string): boolean {
	const p = path.trim();
	return p.startsWith("omp://") || p.includes("/@oh-my-pi/") || /(?:^|[\\/])OMP-(?:HARNESS|RUNTIME)\.md(?::[^/\\]*)?$/.test(p);
}

/** Whether a `tool_result` consulted OMP: a successful read, grep, find or search whose path, paths, URL or resolved path is OMP's own. */
export function consultsOmp(toolName: string, input: Record<string, unknown>, details: unknown, isError: boolean): boolean {
	if (isError || !CONSULT_TOOLS[toolName]) return false;
	const d = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
	const named = [input.path, input.url, d.resolvedPath, ...(Array.isArray(input.paths) ? input.paths : [])];
	// grep and find take several targets in one `;`-separated path.
	return named.some((p) => typeof p === "string" && p.split(";").some(ompDoc));
}

/** Ilex's and lanes' tools that carry an answer out of the session. */
const OUTWARD_TOOLS: Record<string, true> = { [CHANNEL_REPLY_TOOL]: true, [RAISE_QUESTION_TOOL]: true, [LANE_MESSAGE_TOOL]: true, [LANE_RAISE_QUESTION_TOOL]: true };

/** The outward tool a call reaches, by name or as its `xd://` device (session.ts registerTool loadMode), or null. */
export function outwardTool(toolName: string, input: Record<string, unknown>): string | null {
	if (OUTWARD_TOOLS[toolName]) return toolName;
	if (toolName !== "write" || typeof input.path !== "string" || !input.path.startsWith("xd://")) return null;
	const device = input.path.slice("xd://".length);
	return OUTWARD_TOOLS[device] ? device : null;
}

/** What replaces a held final reply, once per question; it passes row 1 (gates/test/r19-omp-docs-first.test.ts). */
export const HELD_MARKER = "(Answer held by P-11 row 19 until an OMP doc is read. The answer follows.)";
/** Every text block of a later hold for the same question. Non-empty: an empty reply is an empty stop, which skips session_stop. */
export const LATER_HOLD = "…";
/**
 * The read that always gets a held answer out: the profile's OMP-HARNESS.md, where install/manifest.tsv links it
 * into the agent-system-2 profile, or in the agent-system checkout.
 */
export const WAY_OUT = ["~/.omp/profiles/agent-system-2/agent/OMP-HARNESS.md", "profile/OMP-HARNESS.md"] as const;

/** The refusal or stop-block reason for hold number `hold`, naming what to read. */
export function holdReason(why: string, hold: number): string {
	return (
		`P-11 row 19 held this answer: the input it answers is a question about OMP, the harness this session runs in (${why}), ` +
		"and nothing of OMP's own has been read since. Every answer is held until one read succeeds; this one always works: " +
		`\`read ${WAY_OUT[0]}\` (the installed profile's guide), or \`read ${WAY_OUT[1]}\` in the agent-system checkout. ` +
		"OMP-RUNTIME.md beside either, an omp:// doc (`read omp://` lists them) or a file under the `@oh-my-pi/` packages " +
		"(pi-coding-agent/src) counts too, by `read`, `grep` or `find`. A read that errors does not count. Then answer " +
		`from what it says. (hold ${hold})`
	);
}

/** One answer attempt's outcome. */
export type Attempt = { kind: "pass" } | { kind: "hold"; reason: string };

/** One question: from its input to the next, what it takes to answer it. */
export class OmpQuestion {
	readonly trigger: Promise<Trigger>;
	consulted = false;
	/** Holds so far; a consult ends the question's holds. */
	holds = 0;
	/** HELD_MARKER showed for this question; later holds show LATER_HOLD. */
	markerShown = false;
	/** The reply held at `assistant_message`, until its `session_stop` hands it back to the model. */
	draft: string | null = null;
	/** The reason of the last hold. */
	reason = "";

	constructor(text: string, judge: JudgeSource | undefined, timeoutMs?: number) {
		const hit = keywordHit(text);
		this.trigger = hit ? Promise.resolve({ triggered: true, why: `it names \`${hit}\`` }) : judgeQuestion(text, judge, timeoutMs);
	}

	/** The trigger while an answer would be held now (triggered and unconsulted), else null. Counts nothing. */
	async holding(): Promise<Trigger | null> {
		if (this.consulted) return null;
		const t = await this.trigger;
		return t.triggered && !this.consulted ? t : null;
	}

	/** One answer attempt: passed, or held (counted). Held every time until a consult. */
	async attempt(): Promise<Attempt> {
		const t = await this.holding();
		if (!t) return { kind: "pass" };
		this.holds++;
		this.reason = holdReason(t.why, this.holds);
		return { kind: "hold", reason: this.reason };
	}
}
