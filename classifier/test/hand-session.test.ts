/**
 * The dead-hand session reader (classifier/src/hand-session.ts; PLAN wl-mv45jcsi4h3nr4 D2, T4):
 * which candidate files are read, the window on a file's session header, and what counts as an answer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HandSessionQuery, handSessionModels } from "../src/hand-session";
import { tmpDir } from "../../ledger/test/tmp";

const dir = tmpDir("as2-hand-session-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let roots = 0;
const freshRoot = () => {
	const root = join(dir, `root-${++roots}`);
	mkdirSync(root);
	return root;
};
const FROM = "2026-10-11T10:00:00.000Z";
const INSIDE = "2026-10-11T10:05:00.000Z";
const UNTIL = "2026-10-11T10:10:00.000Z";
const header = (ts: string) => JSON.stringify({ type: "session", version: 3, id: "s-1", timestamp: ts, cwd: "/w" });
const turn = (provider: string, model: string, stopReason = "stop") =>
	JSON.stringify({ type: "message", id: "m-1", parentId: null, timestamp: INSIDE, message: { role: "assistant", provider, model, stopReason, content: [] } });
const session = (root: string, agentId: string, lines: string[]) => writeFileSync(join(root, `${agentId}.jsonl`), lines.join("\n"));
const query = (over: Partial<HandSessionQuery>): HandSessionQuery => ({ root: dir, key: "sl-k", claimed: new Set(), from: FROM, until: null, ...over });

describe("T4: no evidence, no models", () => {
	test("a null spawn key, a missing root, no candidate file, an empty file", () => {
		const root = freshRoot();
		session(root, "sl-k", [header(INSIDE), turn("openai-codex", "gpt-6-sol")]);
		expect(handSessionModels(query({ root, key: null }))).toEqual([]);
		expect(handSessionModels(query({ root: join(root, "missing") }))).toEqual([]);
		const other = freshRoot();
		session(other, "sl-other", [header(INSIDE), turn("openai-codex", "gpt-6-sol")]);
		session(other, "sl-k-x", [header(INSIDE), turn("openai-codex", "gpt-6-sol")]); // not `<key>-<digits>`
		writeFileSync(join(other, "sl-k.json"), `${header(INSIDE)}\n${turn("openai-codex", "gpt-6-sol")}`);
		expect(handSessionModels(query({ root: other }))).toEqual([]);
		const empty = freshRoot();
		writeFileSync(join(empty, "sl-k.jsonl"), "");
		expect(handSessionModels(query({ root: empty }))).toEqual([]);
	});
});

describe("the candidates and the window", () => {
	test("<key>.jsonl and every <key>-<N>.jsonl are read; a claimed one is not", () => {
		const root = freshRoot();
		session(root, "sl-k", [header(INSIDE), turn("anthropic", "claude-opus-5-5")]);
		session(root, "sl-k-2", [header(INSIDE), turn("openai-codex", "gpt-6-sol")]);
		session(root, "sl-k-13", [header(INSIDE), turn("moonshot", "kimi-k2.7-code")]);
		expect(handSessionModels(query({ root })).sort()).toEqual(["anthropic/claude-opus-5-5", "moonshot/kimi-k2.7-code", "openai-codex/gpt-6-sol"]);
		expect(handSessionModels(query({ root, claimed: new Set(["sl-k", "sl-k-13"]) }))).toEqual(["openai-codex/gpt-6-sol"]);
	});

	test("the header must be at or after `from` and before `until`; with no `until` there is no upper bound", () => {
		const root = freshRoot();
		session(root, "sl-k", [header(FROM), turn("openai-codex", "gpt-6-sol")]);
		expect(handSessionModels(query({ root, until: UNTIL }))).toEqual(["openai-codex/gpt-6-sol"]);
		expect(handSessionModels(query({ root, from: INSIDE }))).toEqual([]);
		expect(handSessionModels(query({ root, until: FROM }))).toEqual([]);
		const late = freshRoot();
		session(late, "sl-k", [header("2026-10-12T00:00:00.000Z"), turn("openai-codex", "gpt-6-sol")]);
		expect(handSessionModels(query({ root: late }))).toEqual(["openai-codex/gpt-6-sol"]);
		expect(handSessionModels(query({ root: late, until: UNTIL }))).toEqual([]);
	});

	test("a header with no timestamp, or none at all, keeps the file out", () => {
		const root = freshRoot();
		session(root, "sl-k", [JSON.stringify({ type: "session", id: "s-1" }), turn("openai-codex", "gpt-6-sol")]);
		expect(handSessionModels(query({ root }))).toEqual([]);
		const bare = freshRoot();
		session(bare, "sl-k", [turn("openai-codex", "gpt-6-sol")]);
		expect(handSessionModels(query({ root: bare }))).toEqual([]);
	});
});

describe("what counts as an answer", () => {
	test("assistant turns that did not error, distinct, normalized as the message_end path does", () => {
		const root = freshRoot();
		session(root, "sl-k", [
			header(INSIDE),
			turn("openai-codex", "gpt-6-sol@upstream-route"),
			turn("openai-codex", "gpt-6-sol"),
			turn("moonshot", "kimi-k2.7-code", "error"),
			JSON.stringify({ type: "message", message: { role: "user", content: "go" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", provider: "anthropic" } }),
			"{not json",
			"null",
		]);
		expect(handSessionModels(query({ root }))).toEqual(["openai-codex/gpt-6-sol"]);
	});
});
