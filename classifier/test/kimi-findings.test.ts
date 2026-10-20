/**
 * The Kimi findings parse (PLAN wl-mv654hoqwpfhmo § 10, PR-K; split A10): real review replies as
 * fixtures under fixtures/kimi-findings/, trimmed to the block and its surroundings.
 *
 * A10 read every Kimi `review-round:` recorded `blocking unknown` (157 of 241 on 2026-10-19). 52 had
 * no reply (403 subscription, 429 balance suspension, provider errors, hands lost). In the other 105,
 * what the classifier was delivered (the hand's yield payload, OMP's `<agent>.md`) never held a block
 * `parseFindings` should have read: no conformant miss. The model did write a valid block, but in its
 * own assistant text: in a turn of its own before the yield (37), or split around the yield call, the
 * closing fence a separate text part after it (59). Nine wrote none that is valid: eight no block at
 * all, one a block whose kind is outside the list.
 *
 * Jo's ruling (q-mvfor0be7rezgg, `transcript`): when the yield payload and the `.md` both give
 * `unknown`, `handFindings` reads the hand's final assistant text from its session file: the text
 * parts of the assistant messages after the last user message and after the last assistant message
 * that calls a tool other than `yield` (OMP's harvest rule), joined in order. The sessions below are
 * built from the fixtures in the layouts A10 found.
 *
 * Sources (session file under ~/.agent-system-2/lanes/, ledger `review-round:` entry; "message n of m"
 * counts the session's assistant messages from 0):
 * - kimi-transcript-runner.md: wl-muraerdsgw7gn4/sessions/2026-10-02T18-19-14-528Z_…/sl-plan-runner--kimi.jsonl
 *   assistant message 22 of 24 (en-murcioa9serr40); kimi-delivered-objects.json is the same hand's `.md`.
 * - kimi-transcript-empty.md: wl-mv6uqrx6d1tjb4/sessions/2026-10-14T01-54-08-585Z_…/sl-audhd-review-2.jsonl
 *   message 26 of 28 (en-mv7lob8vmltv9c).
 * - kimi-split-row6.json: wl-mv457r7iqmq29s/sessions/2026-10-12T00-00-26-467Z_…/sl-plan-row6-3.jsonl
 *   message 17 of 18 (en-mv4np6u59ijzeo); kimi-delivered-prose.json is the same hand's `.md`.
 * - kimi-split-sendline.json: wl-mv66ylg1op3wg0/sessions/2026-10-14T01-54-08-381Z_…/sl-sendline-review.jsonl
 *   message 79 of 80 (en-mv7hxgkya55yf4).
 * - kimi-delivered-bad-escape.json: wl-mv0n5r9cbafe9s/sessions/2026-10-09T07-26-04-752Z_…/sl-plan-alias--kimi-2.md
 *   (en-mv0pbjpr0u5q80): its yield string copies the block with `\x69` unescaped, so its JSON is invalid.
 * - kimi-delivered-pointer.json: wl-mv4xdju27wwdfk/sessions/2026-10-12T07-23-11-160Z_…/sl-plan-unwrap--kimi.md
 *   (en-mv4y604eg80yrk).
 * - kimi-transcript-bad-kind.md: wl-mv8cvw0lq3rlds/sessions/2026-10-14T17-05-58-585Z_…/sl-plan-as2ilex-2.jsonl
 *   message 18 of 20 (en-mv8dw6nxv4h91c): kind `feasibility` is outside the list.
 * - kimi-noblock-objects.json: wl-mv6zl15365nf9c/sessions/2026-10-13T18-00-30-344Z_…/sl-plan-privdata--kimi.md
 *   (en-mv70p7ezyx9h4w), its `verdict` and `findings` only: a hand that wrote no block in any turn.
 * - openai-delivered-snapshot-settle.json: wl-muq13bkdghblmo/sessions/2026-10-01T21-10-37-560Z_…/sl-plan-snapshot-settle.md
 *   (en-muq1estojfkkg0, gpt-6-sol); openai-delivered-byhand.json:
 *   wl-mvb9mw00ycfjeo/sessions/2026-10-16T19-40-00-385Z_…/sl-plan-byhand-6.md (en-mvfnvxn0xo0rnk, gpt-6.1-sol).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handFindings, REVIEW_FINDINGS_PARAGRAPH } from "../extension";
import { type Findings, type FindingsOrUnknown, parseFindings, UNKNOWN } from "../src/rounds";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "kimi-findings", name), "utf8");

const dir = mkdtempSync(join(tmpdir(), "as2-kimi-findings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let roots = 0;
/** A fresh lane artifacts directory: its hands' files are `<root>/<agentId>.jsonl` and `.md`. */
const freshRoot = () => {
	const root = join(dir, `root-${++roots}`);
	mkdirSync(root);
	return root;
};
const AGENT = "sl-r--kimi";

type Part = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: unknown };
const text = (t: string): Part => ({ type: "text", text: t });
const thinking: Part = { type: "thinking", thinking: "Writing the findings block." };
const call = (name: string): Part => ({ type: "toolCall", id: `call-${name}`, name, arguments: {} });
const message = (m: unknown) => JSON.stringify({ type: "message", message: m });
const user = (t: string) => message({ role: "user", content: [text(t)] });
const assistant = (...content: Part[]) => message({ role: "assistant", provider: "moonshot", model: "kimi-k3", stopReason: "stop", content });
const toolResult = (name: string) => message({ role: "toolResult", toolCallId: `call-${name}`, toolName: name, content: [text("ok")] });
const developer = (t: string) => message({ role: "developer", content: [text(t)] });
/** The review brief as the classifier sends it: its findings paragraph carries an example block. */
const BRIEF = user(`workload: wl-x\ntask: review the change${REVIEW_FINDINGS_PARAGRAPH}`);

/** A hand's session file (and its `.md` when given) under a fresh root, as OMP writes them. */
function hand(lines: string[], md?: string): string {
	const root = freshRoot();
	writeFileSync(join(root, `${AGENT}.jsonl`), `${[JSON.stringify({ type: "session", version: 3, id: "s-1", timestamp: "2026-10-14T00:00:00.000Z", cwd: "/w" }), ...lines].join("\n")}\n`);
	if (md !== undefined) writeFileSync(join(root, `${AGENT}.md`), md);
	return root;
}

const counted = (f: FindingsOrUnknown): Findings => {
	if (f === UNKNOWN) throw new Error("expected findings, got unknown");
	return f;
};

const NONE: Findings["counts"] = { blocking: {}, major: {}, minor: {} };

describe("Kimi review replies whose rounds were recorded blocking unknown (A10)", () => {
	test("a block the Kimi model wrote in a turn of its own gives its counts", () => {
		const cases: [string, Findings["counts"], number][] = [
			["kimi-transcript-runner.md", { blocking: { security: 1, correctness: 1 }, major: { design: 2 }, minor: { correctness: 3, docs: 2, design: 1 } }, 10],
			["kimi-transcript-empty.md", NONE, 0],
		];
		for (const [name, counts, titles] of cases) {
			const f = counted(parseFindings(fixture(name)));
			expect({ name, counts: f.counts, titles: f.titles.length }).toEqual({ name, counts, titles });
		}
	});

	test("a block split around the yield call is unknown in its first text part and gives its counts with the closing part", () => {
		const cases: [string, Findings["counts"]][] = [
			["kimi-split-row6.json", { blocking: { tests: 1 }, major: { design: 1 }, minor: { docs: 1 } }],
			["kimi-split-sendline.json", { blocking: { correctness: 1 }, major: {}, minor: { tests: 1, correctness: 1, other: 1, docs: 1 } }],
		];
		for (const [name, counts] of cases) {
			const { between, parts } = JSON.parse(fixture(name)) as { between: string; parts: string[] };
			expect(between).toBe("toolCall yield");
			expect(parts[1]).toBe("```");
			expect({ name, first: parseFindings(parts[0]) }).toEqual({ name, first: UNKNOWN });
			expect({ name, counts: counted(parseFindings(parts.join("\n"))).counts }).toEqual({ name, counts });
		}
	});

	test("a non-conformant reply stays unknown, read directly or by handFindings (a yielded payload's strings too)", () => {
		const names = [
			"kimi-delivered-objects.json",
			"kimi-delivered-bad-escape.json",
			"kimi-delivered-pointer.json",
			"kimi-delivered-prose.json",
			"kimi-transcript-bad-kind.md",
			"kimi-noblock-objects.json",
		];
		for (const name of names) {
			const text = fixture(name);
			expect({ name, direct: parseFindings(text), delivered: handFindings(text, freshRoot(), AGENT) }).toEqual({ name, direct: UNKNOWN, delivered: UNKNOWN });
		}
	});
});

describe("handFindings reads the hand's final assistant text (Jo, q-mvfor0be7rezgg)", () => {
	const RUNNER: Findings["counts"] = { blocking: { security: 1, correctness: 1 }, major: { design: 2 }, minor: { correctness: 3, docs: 2, design: 1 } };

	test("a block in a text-only turn of its own before the yield gives its counts", () => {
		const cases: [string, string, Findings["counts"], number][] = [
			["kimi-transcript-runner.md", "kimi-delivered-objects.json", RUNNER, 10],
			["kimi-transcript-empty.md", "kimi-delivered-prose.json", NONE, 0],
		];
		for (const [name, delivered, counts, titles] of cases) {
			const root = hand([BRIEF, assistant(thinking, call("read")), toolResult("read"), assistant(thinking, text(fixture(name))), assistant(call("yield")), toolResult("yield")], fixture(delivered));
			const f = counted(handFindings(fixture(delivered), root, AGENT));
			expect({ name, counts: f.counts, titles: f.titles.length }).toEqual({ name, counts, titles });
		}
	});

	test("a block split around the yield call, its closing fence a text part of its own, rejoins and gives its counts", () => {
		const cases: [string, string, Findings["counts"]][] = [
			["kimi-split-row6.json", "kimi-delivered-prose.json", { blocking: { tests: 1 }, major: { design: 1 }, minor: { docs: 1 } }],
			["kimi-split-sendline.json", "kimi-delivered-objects.json", { blocking: { correctness: 1 }, major: {}, minor: { tests: 1, correctness: 1, other: 1, docs: 1 } }],
		];
		for (const [name, delivered, counts] of cases) {
			const { parts } = JSON.parse(fixture(name)) as { parts: [string, string] };
			const root = hand([BRIEF, assistant(call("read")), toolResult("read"), assistant(thinking, text(parts[0]), call("yield"), text(parts[1])), toolResult("yield")], fixture(delivered));
			expect({ name, counts: counted(handFindings(fixture(delivered), root, AGENT)).counts }).toEqual({ name, counts });
		}
	});

	test("a block in a turn before the last user message is not read", () => {
		const block = text(fixture("kimi-transcript-runner.md"));
		const after = [
			// The follow-up's reply has no block: the earlier one is not read.
			[assistant(text("Done; the report is above."), call("yield"))],
			// The follow-up has no reply at all.
			[],
		];
		for (const reply of after) {
			const root = hand([BRIEF, assistant(block, call("yield")), toolResult("yield"), user("Resend your report."), ...reply]);
			expect(handFindings(null, root, AGENT)).toBe(UNKNOWN);
		}
		// The brief is the last user message's own text, so the example block in it is never read.
		expect(handFindings(null, hand([BRIEF]), AGENT)).toBe(UNKNOWN);
		// No user message: nothing marks where the final reply starts, so nothing is read.
		expect(handFindings(null, hand([assistant(block)]), AGENT)).toBe(UNKNOWN);
		// The same block after the last user message is read.
		expect(counted(handFindings(null, hand([BRIEF, assistant(text("draft")), user("Resend your report."), assistant(block)]), AGENT)).counts).toEqual(RUNNER);
	});

	test("a developer reminder between the block turn and a yield-only turn does not reset the window", () => {
		const root = hand([
			BRIEF,
			assistant(thinking, call("bash")),
			toolResult("bash"),
			assistant(thinking, text(fixture("kimi-transcript-runner.md"))),
			developer("You stopped without calling yield. Call yield with your result."),
			assistant(thinking, call("yield")),
			toolResult("yield"),
		]);
		expect(counted(handFindings(fixture("kimi-delivered-objects.json"), root, AGENT)).counts).toEqual(RUNNER);
	});

	test("a block that later tool work superseded is not read (OMP's harvest rule)", () => {
		const block = text(fixture("kimi-transcript-runner.md"));
		const sessions: [string, string[]][] = [
			// A draft: block and yield, then the verdict file revised, then a yield with no block.
			["draft, revised, yield without block", [BRIEF, assistant(block, call("yield")), toolResult("yield"), assistant(call("bash")), toolResult("bash"), assistant(text("Revising the verdict."), call("write")), toolResult("write"), assistant(text("Revised; the findings are in the verdict file."), call("yield")), toolResult("yield")]],
			// The block in the same turn as a work call: that turn's own text is stale too.
			["block beside a work call, then yield-only", [BRIEF, assistant(block, call("bash")), toolResult("bash"), assistant(call("yield")), toolResult("yield")]],
		];
		for (const [name, lines] of sessions) {
			expect({ name, got: handFindings(fixture("kimi-noblock-objects.json"), hand(lines), AGENT) }).toEqual({ name, got: UNKNOWN });
		}
		// A new block after the work is read in place of the draft's.
		const redone = hand([BRIEF, assistant(block, call("yield")), toolResult("yield"), assistant(call("write")), toolResult("write"), assistant(text(fixture("kimi-transcript-empty.md")), call("yield")), toolResult("yield")]);
		expect(counted(handFindings(null, redone, AGENT)).counts).toEqual(NONE);
	});

	test("the brief's example block echoed before tool work is not read", () => {
		const root = hand([
			BRIEF,
			assistant(thinking, text(`I will review the change and end with this block:${REVIEW_FINDINGS_PARAGRAPH}`)),
			assistant(thinking, call("read")),
			toolResult("read"),
			assistant(text(fixture("kimi-noblock-objects.json")), call("yield")),
			toolResult("yield"),
		]);
		expect(handFindings(fixture("kimi-noblock-objects.json"), root, AGENT)).toBe(UNKNOWN);
	});

	test("a final text with no valid block stays unknown, and a malformed last block hides an earlier valid one", () => {
		const finals: [string, Part[]][] = [
			["kimi-transcript-bad-kind.md", [text(fixture("kimi-transcript-bad-kind.md"))]],
			["kimi-noblock-objects.json", [text(fixture("kimi-noblock-objects.json")), call("yield")]],
			["valid then unterminated", [text(fixture("kimi-transcript-empty.md")), call("yield"), text('```review-findings\n{"findings":[]}')]],
		];
		for (const [name, parts] of finals) {
			const root = hand([BRIEF, assistant(...parts), toolResult("yield")], fixture("kimi-noblock-objects.json"));
			expect({ name, got: handFindings(fixture("kimi-noblock-objects.json"), root, AGENT) }).toEqual({ name, got: UNKNOWN });
		}
	});

	test("the yield payload, then the .md, win over the transcript; an absent or unreadable session file is unknown", () => {
		const transcript = [BRIEF, assistant(text(fixture("kimi-transcript-runner.md")))];
		const openai = fixture("openai-delivered-snapshot-settle.json");
		const openaiCounts = { blocking: { security: 1 }, major: { correctness: 1 }, minor: { tests: 1 } };
		expect(counted(handFindings(openai, hand(transcript), AGENT)).counts).toEqual(openaiCounts);
		expect(counted(handFindings(fixture("kimi-delivered-prose.json"), hand(transcript, openai), AGENT)).counts).toEqual(openaiCounts);
		expect(counted(handFindings(fixture("kimi-delivered-prose.json"), hand(transcript), AGENT)).counts).toEqual(RUNNER);
		expect(handFindings(fixture("kimi-delivered-prose.json"), freshRoot(), AGENT)).toBe(UNKNOWN);
		const unreadable = freshRoot();
		mkdirSync(join(unreadable, `${AGENT}.jsonl`));
		expect(handFindings(fixture("kimi-delivered-prose.json"), unreadable, AGENT)).toBe(UNKNOWN);
	});
});

describe("the findings paragraph appended to review briefs", () => {
	const example = REVIEW_FINDINGS_PARAGRAPH.slice(REVIEW_FINDINGS_PARAGRAPH.lastIndexOf("```review-findings"));

	test("it ends with one complete fenced example block and names the empty list in its prose", () => {
		expect(example.startsWith("```review-findings\n")).toBe(true);
		expect(example.endsWith("\n```")).toBe(true);
		expect(REVIEW_FINDINGS_PARAGRAPH.slice(0, -example.length)).toContain('{"findings":[]}');
	});

	test("a verbatim copy of the example block fails safe: it parses with a blocking finding", () => {
		const blocking = (f: FindingsOrUnknown) => Object.values(counted(f).counts.blocking).reduce((a, n) => a + (n ?? 0), 0);
		expect(blocking(parseFindings(example))).toBeGreaterThanOrEqual(1);
		expect(blocking(parseFindings(`Review done.\n\n${example}`))).toBeGreaterThanOrEqual(1);
		// Copied as the hand's final text, the session source reads it the same way.
		expect(blocking(handFindings(null, hand([BRIEF, assistant(text(`Review done.\n\n${example}`), call("yield")), toolResult("yield")]), AGENT))).toBeGreaterThanOrEqual(1);
	});
});

describe("OpenAI replies whose rounds were counted", () => {
	test("each delivered payload keeps the counts its review-round entry recorded", () => {
		const cases: [string, Findings["counts"]][] = [
			["openai-delivered-snapshot-settle.json", { blocking: { security: 1 }, major: { correctness: 1 }, minor: { tests: 1 } }],
			["openai-delivered-byhand.json", NONE],
		];
		for (const [name, counts] of cases) {
			expect({ name, counts: counted(handFindings(fixture(name), freshRoot(), AGENT)).counts }).toEqual({ name, counts });
		}
	});
});
