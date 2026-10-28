// Rows 1 (turn shape, refused), 2 (contract injection) and 3 (receipts, flag-only).
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkTurnShape, closingAsks } from "../src/rows/r01-turn-shape";
import { CONTRACT_MARKER, contractPath, injectContract } from "../src/rows/r02-contract";
import { checkReceipts, type HistoryEvent, historyEvent, workCall } from "../src/rows/r03-receipts";
import { tmp } from "./helpers";

const good = [
	"## Needs you",
	"**CLAIM**",
	"The gate is built.",
	"",
	"Run it with:",
	"```zsh",
	"zsh ~/agent-scratch/agent-system-2.0/run-gates.sh",
	"```",
	"**Closing ask**",
	"Ship the gates to the profile now, or wait for M5? Recommend now.",
].join("\n");

describe("row 1: turn shape to Jo", () => {
	test("allows one closing ask, last, with a script-path command", () => {
		expect(checkTurnShape(good)).toBeNull();
		expect(checkTurnShape("Done, nothing needs you.")).toBeNull();
	});
	test("refuses two asks in one turn", () => {
		const r = checkTurnShape("**Closing ask**\nA or B?\n\n**Closing ask**\nC or D?");
		expect(r?.reason).toContain("2 closing asks");
	});
	test("refuses a bare command handed to Jo", () => {
		const r = checkTurnShape("Run this:\n```bash\ngit push origin feat\n```");
		expect(r?.reason).toContain("bare command (`git push origin feat`)");
	});
	// tiers/orchestrator.md § What you never do: the orchestrator hands Jo no command at all, not
	// even the lane's one `zsh <path>` line.
	const ORCH_REFUSAL = "a lane runs it, or ask Jo for one word";
	test("orchestrator: a bare command fence is refused", () => {
		const r = checkTurnShape("Run this:\n```bash\ngit push origin feat\n```", "orchestrator");
		expect(r?.reason).toContain(ORCH_REFUSAL);
		expect(r?.reason).toContain("it hands Jo a command (`git push origin feat`)");
	});
	test("orchestrator: a script-path fence line is refused; the same text passes as a lane", () => {
		const msg = "Run it with:\n```bash\nzsh ~/agent-scratch/x/run.sh\n```";
		expect(checkTurnShape(msg, "orchestrator")?.reason).toContain(`it hands Jo a command (\`zsh ~/agent-scratch/x/run.sh\`); ${ORCH_REFUSAL}`);
		expect(checkTurnShape(msg)).toBeNull();
		expect(checkTurnShape(msg, "lane")).toBeNull();
		expect(checkTurnShape(good)).toBeNull();
		expect(checkTurnShape(good, "orchestrator")?.reason).toContain(ORCH_REFUSAL);
	});
	test("orchestrator: a script line in prose or in inline code is refused", () => {
		expect(checkTurnShape("Run it:\nzsh ~/agent-scratch/x/run.sh", "orchestrator")?.reason).toContain(ORCH_REFUSAL);
		expect(checkTurnShape("Run it: `zsh ~/agent-scratch/x/run.sh`", "orchestrator")?.reason).toContain(ORCH_REFUSAL);
	});
	test("orchestrator: a code fence and an inline command receipt are not hand-overs", () => {
		expect(checkTurnShape("**CLAIM**\n```ts\nconst x = 1;\n```", "orchestrator")).toBeNull();
		expect(checkTurnShape("**CLAIM**\nThe tree is clean: `git status` printed nothing to commit.", "orchestrator")).toBeNull();
	});
	// PLAN wl-mvb9mw00ycfjeo D7 (2026-10-17; migration/items/pair-offer-own-line.md, MIGRATION.md item
	// 52): the one command the orchestrator may give Jo is the by-hand `as2 lane wl-…` line, in prose
	// or inline code, on its own line before the closing ask. Inside a shell fence it is still refused.
	test("orchestrator: `as2 lane wl-x` passes in prose and inline code, and is refused in a shell fence", () => {
		const lead = "**CLAIM**\nYou took pair on the login page (q-x); its lane has ended. Continue it in another terminal:";
		const ask = "**Closing ask**\nShould I close it when you are done? Recommend yes.";
		expect(checkTurnShape(`${lead}\nas2 lane wl-x\n\n${ask}`, "orchestrator")).toBeNull();
		expect(checkTurnShape(`${lead}\n\`as2 lane wl-x\`\n\n${ask}`, "orchestrator")).toBeNull();
		for (const fence of ["bash", "sh", "zsh", "shell", "console"]) {
			const r = checkTurnShape(`${lead}\n\`\`\`${fence}\nas2 lane wl-x\n\`\`\`\n\n${ask}`, "orchestrator");
			expect(r?.reason).toContain(`it hands Jo a command (\`as2 lane wl-x\`); ${ORCH_REFUSAL}`);
		}
	});
	test("refuses a needs-you block that is not first, and an ask that is not last", () => {
		expect(checkTurnShape("**CLAIM**\nStuff happened.\n## Needs you\nx")?.reason).toContain("needs-you block is not first");
		expect(checkTurnShape("**Closing ask**\nA or B?\n**CLAIM**\nmore after")?.reason).toContain("closing ask is not last");
	});
	// voice/VOICE.md § Older items are counted, not re-listed: every message ends with one count line
	// after the closing ask. It is a footer, not prose after the ask, and only as the last line.
	const COUNT = "3 others waiting: `pending` shows them all";
	const countPasses: [string, string][] = [
		["closing ask + count line", `**Closing ask**\nShip now or wait for M5? Recommend now.\n\n${COUNT}`],
		["closing ask with options and recommendation + count line", `**Closing ask**\nShip now or wait for M5?\n- now\n- M5\nRecommend now.\n${COUNT}`],
		["prose check-in after a CLAIM + count line", `**CLAIM**\nThe gate is built.\n\nWant me to push it?\n${COUNT}`],
		["plain reply ask + count line", `It is pinned to 18.4.4. Want me to restart it?\n\n${COUNT}`],
		["closing ask + nothing else waiting", "**Closing ask**\nShip now or wait for M5?\nnothing else waiting"],
		["prose check-in + Nothing else waiting.", "Want me to push it?\n\nNothing else waiting."],
		["emphasised singular count line, no backticks", "**Closing ask**\nShip now or wait for M5?\n_1 other waiting: pending shows them all._"],
	];
	for (const [name, msg] of countPasses) {
		test(`the count line may follow the closing ask, as the last line: ${name}`, () => {
			expect(checkTurnShape(msg)).toBeNull();
		});
	}
	test("the count line followed by more prose, or other prose after the ask, is still refused", () => {
		expect(checkTurnShape(`**Closing ask**\nShip now or wait for M5?\n${COUNT}\nmore after`)?.reason).toContain(`prose follows it: "3 others waiting:`);
		expect(checkTurnShape(`Want me to push it?\nnothing else waiting\nmore after`)?.reason).toContain(`prose follows it: "nothing else waiting"`);
		expect(checkTurnShape(`Want me to restart it?\n${COUNT}\nIt is floating today.`)?.reason).toContain("closing ask is not last");
		expect(checkTurnShape(`**Closing ask**\nShip now or wait for M5?\nIt is floating today.\n${COUNT}`)?.reason).toContain(`prose follows it: "It is floating today."`);
		expect(checkTurnShape(`Want me to push it?\nIt is floating today.\nnothing else waiting`)?.reason).toContain(`prose follows it: "It is floating today."`);
		// Only the exact footer is exempt: a near-miss is prose.
		expect(checkTurnShape("**Closing ask**\nShip now or wait for M5?\n3 others waiting, see the list")?.reason).toContain("closing ask is not last");
		expect(checkTurnShape("**Closing ask**\nShip now or wait for M5?\nnothing else waiting for now")?.reason).toContain("closing ask is not last");
	});
	test("a non-shell code fence is not a command", () => {
		expect(checkTurnShape("**CLAIM**\n```ts\nconst x = 1;\n```")).toBeNull();
	});
	// The output-types contract labels receipted facts only, CLAIM and CITE (plugins/output-types/
	// skills/output-types/reference.md): a block label asserts and asks nothing.
	for (const label of ["CLAIM", "CITE"]) {
		test(`**${label}** is a block label`, () => {
			// A labeled block above the needs-you heading is not content above it.
			expect(checkTurnShape(`**${label}**\n## Needs you\nx`)).toBeNull();
			expect(checkTurnShape(`**${label}**\nThe caller handles the null.\n\n**Closing ask**\nGuard it or delete it?`)).toBeNull();
		});
		test(`**${label}** refusals name the block and the offending line`, () => {
			expect(checkTurnShape(`**Closing ask**\nGuard it or delete it?\n**${label}**\nmore after`)?.reason).toContain(`the closing ask is not last (a **${label}** block follows it)`);
			expect(checkTurnShape(`**${label}**\nThe SDK needs an explicit region?`)?.reason).toContain(`a ${label} asks something ("The SDK needs an explicit region?")`);
		});
	}
	test("a CLAIM block ends at the blank line: prose after it may carry the check-in", () => {
		expect(checkTurnShape("**CLAIM**\nThe gate is built.\n\nWant me to push it?")).toBeNull();
		expect(checkTurnShape("**CLAIM**\nThe gate is built.\nWant me to push it?")?.reason).toContain(`a CLAIM asks something`);
	});
	test("the retired labels are no block labels: PMDW, ACTION, QUESTION and GUESS are bold prose", () => {
		expect(checkTurnShape("**GUESS**\nThe SDK needs an explicit region?\n\n**Closing ask**\nShip it?")?.reason).toContain("a prose check-in asks beside the closing ask");
		expect(checkTurnShape("**QUESTION**\n## Needs you\nx")?.reason).toContain("needs-you block is not first");
	});
	test("closingAsks reads the text after the marker, as heading or bold, with or without a colon", () => {
		expect(closingAsks("**CLAIM**\nx\n\n**Closing ask**\n(q-1) Guard it or delete it?")).toEqual(["(q-1) Guard it or delete it?"]);
		expect(closingAsks("## Closing ask\nKeep it?")).toEqual(["Keep it?"]);
		expect(closingAsks("**Closing ask:**\nKeep it?")).toEqual(["Keep it?"]);
		expect(closingAsks("Closing ask: keep it?")).toEqual([]);
		expect(closingAsks("The marker is `**Closing ask**`.")).toEqual([]);
	});
});

describe("row 2: contract injected into every agent's system prompt", () => {
	test("by default the contract is the vendored output-types plugin's reference, injected whole", () => {
		const path = contractPath({});
		expect(path).toBe(resolve(import.meta.dir, "../../plugins/output-types/skills/output-types/reference.md"));
		const text = readFileSync(path, "utf8");
		expect(injectContract([], {})[0]).toBe(`${CONTRACT_MARKER}\n${text}`);
		// The contract labels CLAIM and CITE only (plugins/VENDOR.md, the 37d100e pin).
		expect(text).toContain("**CLAIM**");
		expect(text).toContain("**CITE**");
		expect(text).not.toContain("**PMDW**");
	});
	test("appends the configured contract once, from AGENT_SYSTEM_CONTRACT", () => {
		const path = join(tmp("contract"), "output-types.md");
		writeFileSync(path, "Label every statement.");
		const env = { AGENT_SYSTEM_CONTRACT: path };
		const once = injectContract(["base prompt"], env);
		expect(once).toHaveLength(2);
		expect(once[1]).toContain("Label every statement.");
		expect(injectContract(once, env)).toBe(once);
	});
	test("a missing contract file is named in the prompt, not skipped", () => {
		const out = injectContract([], { AGENT_SYSTEM_CONTRACT: "/nonexistent/contract.md" });
		expect(out[0]).toContain(CONTRACT_MARKER);
		expect(out[0]).toContain("could not be loaded from /nonexistent/contract.md");
	});
});

describe("row 3: receipts verified (flags, never blocks)", () => {
	const dir = tmp("receipts");
	const file = join(dir, "code.ts");
	writeFileSync(file, "line one\nexport function gate() {\n  return refuse();\n}\n");

	test("a report whose receipts check out gets no flags", () => {
		const history: HistoryEvent[] = [
			{ kind: "read", path: file },
			{ kind: "fetch", url: "https://example.com/doc", finalUrl: "https://example.com/doc" },
			{ kind: "write", path: file },
			{ kind: "bash", command: "bun test gates", exitCode: 0 },
		];
		const report = [
			"**CLAIM**",
			`${file}:2 — \`export function gate() {\``,
			"**CITE**",
			"https://example.com/doc says so.",
			"`bun test gates` → exit 0; tests pass.",
		].join("\n");
		expect(checkReceipts(report, history, dir)).toEqual([]);
	});

	test("flags each unverifiable receipt and returns flags rather than a refusal", () => {
		const history: HistoryEvent[] = [
			{ kind: "fetch", url: "https://example.com/old", finalUrl: "https://example.com/new" },
			{ kind: "bash", command: "bun test gates", exitCode: 1 },
			{ kind: "write", path: file },
		];
		const report = [
			"**CLAIM**",
			`${file}:2 — \`function somethingElse()\``,
			"**CLAIM**",
			`${join(dir, "missing.ts")}:3 says so.`,
			"**CITE**",
			"https://example.com/old and https://example.com/never",
			"`bun test gates` → exit 0",
			"All tests pass.",
			"`ls` → exit 0",
		].join("\n");
		const flags = checkReceipts(report, history, dir);
		expect(Array.isArray(flags)).toBe(true);
		const all = flags.join("\n");
		expect(all).toContain("was not read this session");
		expect(all).toContain('quote "function somethingElse()" does not match');
		expect(all).toContain("missing.ts:3, which does not exist");
		expect(all).toContain("redirected to https://example.com/new");
		expect(all).toContain("https://example.com/never was not fetched");
		expect(all).toContain("reports exit 0; the recorded run exited 1");
		expect(all).toContain("no test run is recorded after the last edit");
		expect(all).toContain("`ls` → exit 0: no such run recorded this session");
	});

	test("history is built from OMP tool_result shapes", () => {
		expect(historyEvent("read", { path: "a.ts:3-9" }, { resolvedPath: "/r/a.ts" }, false)).toEqual({ kind: "read", path: "/r/a.ts" });
		expect(historyEvent("read", { path: "https://x.dev" }, { url: "https://x.dev", finalUrl: "https://x.dev/" }, false)).toEqual({ kind: "fetch", url: "https://x.dev", finalUrl: "https://x.dev/" });
		expect(historyEvent("bash", { command: "false" }, { exitCode: 1 }, true)).toEqual({ kind: "bash", command: "false", exitCode: 1 });
		expect(historyEvent("bash", { command: "true" }, {}, false)).toEqual({ kind: "bash", command: "true", exitCode: 0 });
	});
});

// The trivial-ask path (M7 finding 4, Jo 2026-09-30; tiers/orchestrator.md § Trivial asks): a plain
// reply with no CLAIM or CITE, from a turn that made no working call.
describe("trivial ask: row 3 flags a reply with no CLAIM or CITE only when the turn did work", () => {
	const plain = "M7 has one workload open, the 18.4.4 re-verification, with two slices left.";
	const env = { PATH: process.env.PATH };
	test("reads stay trivial: read, grep, find, the wake read by name or device, a read-only command", () => {
		expect(workCall("read", { path: "/tmp/x" }, "/", env)).toBe(false);
		expect(workCall("grep", { pattern: "M7" }, "/", env)).toBe(false);
		expect(workCall("find", { query: "open workloads" }, "/", env)).toBe(false);
		expect(workCall("orchestrator_wake_read", { body: "x" }, "/", env)).toBe(false);
		expect(workCall("write", { path: "xd://orchestrator_wake_read", content: "{}" }, "/", env)).toBe(false);
		expect(workCall("bash", { command: "cat README.md" }, "/", env)).toBe(false);
	});
	test("work is not trivial: a mutating command, a write, dispatch, eval, opening a workload by name or device", () => {
		expect(workCall("bash", { command: "omp update" }, "/", env)).toBe(true);
		expect(workCall("bash", { command: "echo x > /tmp/prompt.md" }, "/", env)).toBe(true);
		expect(workCall("edit", { path: "/tmp/SYSTEM.md" }, "/", env)).toBe(true);
		expect(workCall("task", {}, "/", env)).toBe(true);
		expect(workCall("eval", {}, "/", env)).toBe(true);
		expect(workCall("orchestrator_open_workload", {}, "/", env)).toBe(true);
		expect(workCall("write", { path: "xd://orchestrator_open_workload", content: "{}" }, "/", env)).toBe(true);
	});
	test("a reply with no CLAIM or CITE after a working call is flagged", () => {
		expect(checkReceipts(plain, [], "/", ["bash"]).join("\n")).toContain("no CLAIM or CITE after 1 working call this turn (bash)");
		expect(checkReceipts(plain, [], "/", ["orchestrator_open_workload"]).join("\n")).toContain("no CLAIM or CITE");
		// The retired labels back nothing: a reply carrying only them is still flagged.
		expect(checkReceipts("**GUESS**\nProbably fine.\n\n**PMDW**\nDone.", [], "/", ["bash"]).join("\n")).toContain("no CLAIM or CITE");
	});
	test("a reply with no CLAIM or CITE from a turn with no working call is not flagged", () => {
		expect(checkReceipts(plain, [], "/", [])).toEqual([]);
	});
	test("a labeled report after work gets no zero-label flag; a hand's yield (no turn record) is unchanged", () => {
		expect(checkReceipts("**CLAIM**\nDone.", [], "/", ["bash"])).toEqual([]);
		expect(checkReceipts(plain, [], "/")).toEqual([]);
	});
});

describe("trivial ask: row 1 on a plain reply and on one closing ask with options", () => {
	test("Ilex's two refused closing asks are one decision each (M7 session 2026-09-30)", () => {
		const ilex1 = [
			"**Closing ask**",
			"Which M7 item opens first: the OMP 18.4.4 re-verification of gates and surface harnesses together with the `setupVersion` template fix as one workload, or a real first build workload on this repo with those two left to surface as findings? I recommend the re-verification plus `setupVersion` workload, because the first real lane should run on a verified host.",
		].join("\n");
		const ilex2 = [
			"**Closing ask**",
			"Does the look-and-feel pull request, PR #1 adding the composer/symbol/display block to `profile/config.yml`, get merged now, or wait until your fable session's `setupVersion` batch lands first? I recommend merging now: it touches a different region of the file.",
		].join("\n");
		expect(checkTurnShape(ilex1)).toBeNull();
		expect(checkTurnShape(ilex2)).toBeNull();
	});
	test("a which-question with its options still refuses a second decision", () => {
		expect(checkTurnShape("**Closing ask**\nWhich branch, main or feature, and should I deploy today?")?.reason).toContain("2 separate decisions");
		expect(checkTurnShape("**Closing ask**\nDoes it merge now or later, and deploy today or tomorrow?")?.reason).toContain("2 separate decisions");
	});
	test("a plain reply may carry one ask, options included, last", () => {
		expect(checkTurnShape("The host is on 18.4.4. Want it pinned in the profile, or left floating?")).toBeNull();
		expect(checkTurnShape("M7 has one workload open, with two slices left.")).toBeNull();
	});
	test("a plain reply with two asks, two decisions, or prose after its ask is refused", () => {
		expect(checkTurnShape("Pin it? Or restart first?")?.reason).toContain("asks 2 things");
		expect(checkTurnShape("Pin it to 18.4.4 or 18.3.0, and restart now or later?")?.reason).toContain("2 separate decisions");
		expect(checkTurnShape("Want me to pin it?\nIt is floating today.")?.reason).toContain("not last");
	});
	test("a choice in unlabeled prose inside a labeled message is still refused", () => {
		expect(checkTurnShape("**CLAIM**\nIt is pinned.\n\nShould I restart it or leave it?")?.reason).toContain("offers Jo a choice");
	});
});
