// PLAN wl-mvg1vs0rhnu3gg § 1.2, § 1.3 (R3): NOW_RESERVED names the row 6 rules whose waiting reserved request is pushed to
// Jo on fire. Every entry must stay a `why` the rule table actually gives, so a renamed rule fails here instead of
// silently leaving the list; and a refused call's action reaches `nowReserved` the way surface/src/errors.ts reads it.
// The reserved phrases are built from pieces so this file reads through a gated shell.
import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { checkReserved, NOW_RESERVED, nowReserved, reservedAction, reservedRequestBody } from "../src/rows/r06-reserved";
import type { CallContext, ToolCall } from "../src/types";
import { git, tmp } from "./helpers";

const SRC = join(import.meta.dir, "..", "src");
const r06 = readFileSync(join(SRC, "rows", "r06-reserved.ts"), "utf8");
/**
 * The rule table as source text: row 6 without its NOW_RESERVED block (which would match itself), and git's model
 * (src/git-model.ts: RESERVED_OPTS, checkPush, REFUSED_SUBS).
 */
const listAt = r06.indexOf("export const NOW_RESERVED");
const listEnd = r06.indexOf("\n}\n", r06.indexOf("export function nowReserved"));
const TABLE = r06.slice(0, listAt) + r06.slice(listEnd) + readFileSync(join(SRC, "git-model.ts"), "utf8");

describe("NOW_RESERVED: every entry is a why the rule table gives", () => {
	test("the list is cut out of the table text it is checked against", () => {
		expect(listAt).toBeGreaterThan(0);
		expect(listEnd).toBeGreaterThan(listAt);
		expect(TABLE).not.toContain("NOW_RESERVED");
	});
	for (const s of NOW_RESERVED) test(`"${s}" occurs as a string literal in the rule table`, () => expect(TABLE).toContain(JSON.stringify(s)));
	test("no entry repeats", () => expect(new Set(NOW_RESERVED).size).toBe(NOW_RESERVED.length));
});

describe("nowReserved over real refusals: § 1.2 guard bypasses and § 1.3 irreversible rules are NOW, blind and local ones are not", () => {
	const repo = realpathSync(tmp("r06-now"));
	git(repo, "init", "-q", "-b", "main");
	git(repo, "commit", "-q", "--allow-empty", "-m", "one");
	git(repo, "switch", "-q", "-c", "topic");
	const ctx: CallContext = { role: "lane", cwd: repo, env: { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: "/not-real/ledger.db" } };
	/** The `reserved-request` body row 6 writes for `command`, or null when it raises nothing. */
	const body = (command: string): string | null => {
		const call: ToolCall = { toolName: "bash", input: { command } };
		const action = reservedAction(checkReserved(call, ctx));
		return action === null ? null : reservedRequestBody(call, action, "call-1");
	};
	const PUSH = "git pu" + "sh";
	const now: [string, string, "guard" | "irreversible"][] = [
		["the --admin merge", "gh pr mer" + "ge 5 --ad" + "min", "guard"],
		["a push to a protected branch", `${PUSH} origin topic:main`, "guard"],
		["a force-push", `${PUSH} --for` + "ce origin topic", "irreversible"],
		["a remote ref deletion", `${PUSH} origin :old`, "irreversible"],
		["a deploy", "fly dep" + "loy", "irreversible"],
		["a package publish", "npm pub" + "lish", "irreversible"],
		["a workflow run", "gh workflow r" + "un ci.yml", "irreversible"],
		["infrastructure teardown", "terraform dest" + "roy", "irreversible"],
		["a secret rotation", "gh secret s" + "et TOKEN", "irreversible"],
		["destructive SQL", "mysql -e 'DR" + "OP TABLE users'", "irreversible"],
	];
	for (const [name, command, category] of now) {
		test(`NOW (${category}): ${name}`, () => {
			const b = body(command);
			expect(b).not.toBeNull();
			const hit = nowReserved(b!);
			expect(hit).not.toBeNull();
			expect(hit!.category).toBe(category);
			expect(NOW_RESERVED).toContain(hit!.why);
		});
	}
	const waits: [string, string][] = [
		["a blind bun call", "bun $" + "X"],
		["a blind gh call", "gh $" + "X"],
		["rm -rf", "rm -r" + "f build"],
		["a local branch deletion", "git branch -" + "D topic"],
		["a local hard reset", "git reset --ha" + "rd"],
		["gh api with a mutating method", "gh api -X DEL" + "ETE repos/o/r/labels/x"],
	];
	for (const [name, command] of waits) {
		test(`waits for the window: ${name}`, () => {
			const b = body(command);
			expect(b).not.toBeNull();
			expect(nowReserved(b!)).toBeNull();
		});
	}
	test("an entry counts only whole: a longer phrase opening with one is not it", () => {
		expect(nowReserved("deploy it")).toBeNull();
		expect(nowReserved("deployment notes: x")).toBeNull();
		expect(nowReserved("deploy")).toEqual({ why: "deploy", category: "irreversible" });
		expect(nowReserved("deploy (vercel): vercel --prod (P-11 row 6 refused tool call c1)")).toEqual({ why: "deploy", category: "irreversible" });
		expect(nowReserved("push to a protected branch (current branch main): git push (P-11 row 6 refused tool call c1)")).toEqual({ why: "push to a protected branch", category: "guard" });
	});
});
