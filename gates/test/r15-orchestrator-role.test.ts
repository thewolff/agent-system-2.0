// P-11 row 15 (gates/extensions/r15-orchestrator-role.ts) driven through a fake OMP extension API:
// on the orchestrator session the lane's tools are refused with the one-line reason; reads, the
// read-only bash forms rows 6 and 10 already model, and the surface's ledger tools pass; a lane and a
// hand see every one of the same calls untouched.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../../surface/index";
import { STANDING_WORKLOAD_ID, SURFACE_TOOLS } from "../../surface/src/types";
import { ctxOf, fakePi } from "../../surface/test/helpers";
import turnShapeRow from "../extensions/r01-turn-shape";
import orchestratorRoleRow from "../extensions/r15-orchestrator-role";
import type { GatesAPI } from "../index";
import { answerFirstRefusal, ORCHESTRATOR_ROLE_REFUSAL, questionIdsOf, readOnlyBash, reusedQuestionRefusal, UNRECORDED_QUESTION_REFUSAL } from "../src/rows/r15-orchestrator-role";
import { tmp } from "./helpers";

/** This checkout, resolved at runtime: Ilex's command named Jo's (item 24, run tr-0mv0ks648wy8d2q). */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

type AnyHandler = (event: unknown, ctx: unknown) => unknown;

/** An empty ledger file: every working call on the orchestrator reads the open-question set from it (round 2, B2). */
function emptyLedger(): string {
	const db = join(tmp("r15-empty-ledger"), "ledger.db");
	Ledger.open(db, { create: true, backup: false, backupOnOpen: false }).close();
	return db;
}

/** Only `tool_call` matters to this row; first block wins, as in runner.ts emitToolCall. `db`: the ledger, an empty one by default. */
function session(kind: "orchestrator" | "lane" | "hand", db: string = emptyLedger()) {
	const handlers: AnyHandler[] = [];
	const pi = { on: (name: string, h: AnyHandler) => name === "tool_call" && handlers.push(h) } as unknown as GatesAPI;
	const env = { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: db, ...(kind === "lane" ? {} : { AGENT_SYSTEM_ROLE: "orchestrator" }) };
	orchestratorRoleRow(pi, env);
	const ctx = {
		hasUI: kind !== "hand",
		cwd: tmp("r15-cwd"),
		sessionManager: { getHeader: () => (kind === "hand" ? { parentSession: "/sessions/lane.jsonl" } : null), getEntries: () => [] },
		ui: { notify: () => {} },
	};
	return async (toolName: string, input: Record<string, unknown>) => {
		for (const h of handlers) {
			const r = (await h({ toolName, toolCallId: "call-1", input }, ctx)) as { block?: boolean; reason?: string } | undefined;
			if (r?.block) return r;
		}
		return undefined;
	};
}

const REFUSED: [string, Record<string, unknown>][] = [
	["edit", { path: "gates/index.ts", edits: [] }],
	["ast_edit", { paths: ["gates/src"], ops: [] }],
	["write", { path: "gates/new.ts", content: "x" }],
	["write", { path: "xd://ast_edit", content: "{}" }],
	["write", { path: "xd://report_issue", content: "x" }],
	["write", { path: "agent://Main", content: "go" }],
	["task", { tasks: [{ agent: "standard", task: "do it" }] }],
	["eval", { language: "py", code: "print(1)" }],
	["bash", { command: "git worktree add ../wt -b feat" }],
	["bash", { command: "git commit -m x" }],
	["bash", { command: "git push -u origin feat" }],
	["bash", { command: "gh pr create --fill" }],
	["bash", { command: "git fetch origin" }], // a git form lanes may run, but not a read
	["bash", { command: "git stash" }], // stash push, not stash list
	["bash", { command: "git stash pop" }],
	["bash", { command: "git branch feat" }], // branch creation
	["bash", { command: "git branch -m old new" }],
	["bash", { command: "git branch -u origin/feat" }],
	["bash", { command: "git branch -D feat" }],
	["bash", { command: "git remote add fork https://example.invalid/r.git" }],
	["bash", { command: "git worktree add ../wt feat" }],
	["bash", { command: "git diff --ext-diff" }], // runs the external diff helper
	["bash", { command: "git show --show-signature HEAD" }], // runs gpg
	["bash", { command: "git log --output=log.txt" }], // writes a file
	["bash", { command: "git log --bogus-option" }], // an option git does not list
	["bash", { command: "git -c core.pager=less log" }], // a -c key gitUnmodeled refuses
	["bash", { command: "git diff > change.patch" }], // a write destination
	["bash", { command: "/bin/ls" }], // path-qualified command name
	["bash", { command: "touch x" }],
	["bash", { command: "ls > listing.txt" }], // a write destination
	["bash", { command: "cat notes | tee copy" }],
	["bash", { command: "ls $(touch y)" }], // a substitution runs a writer
	["bash", { command: "FOO=1 ls" }], // an assignment reaches the command's environment
	["bash", { command: "ls", env: { DYLD_INSERT_LIBRARIES: "/tmp/x.dylib" } }],
	["bash", { command: "sudo cat /etc/hosts" }], // a wrapper
	["bash", { command: "cd $DIR && ls" }], // cd to a directory known only when it runs
	["bash", { command: "ls 2>$ERR" }], // a redirect target known only when it runs
	["bash", { command: "ls > /dev/nullx" }], // not /dev/null
	["bash", { command: "bun -e 'console.log(1)'" }], // inline code
	["bash", { command: "file -C -m magic" }], // a read head's documented output option
	["bash", { command: "cat --output=x notes" }], // an undocumented output option
	["bash", { command: "$CMD notes" }], // a name known only when it runs
	["bash", { command: "cat 'notes" }], // unparseable (unterminated quote): blind
	["bash", { command: "cat notes | sh" }], // a shell reading piped commands
	// M7 fix round 2: the search and filter kin stay refused in their write and run forms.
	["bash", { command: "awk '{print $1}' notes > out.txt" }], // shell redirection into a file
	["bash", { command: "awk '{print $1 > \"out.txt\"}' notes" }], // awk's own output redirection
	["bash", { command: "awk '{print | \"sh\"}' notes" }], // awk piping into a command
	["bash", { command: "awk 'BEGIN{system(\"touch x\")}'" }], // awk running a command
	["bash", { command: "awk -f prog.awk notes" }], // a program the gate cannot read
	["bash", { command: "find . -name '*.tmp' -delete" }],
	["bash", { command: "find . -exec rm {} ';'" }],
	["bash", { command: "find . -fprint list.txt" }],
	["bash", { command: "find $DIR -name x" }], // a word known only when it runs
	["bash", { command: "sort -o sorted.txt notes" }],
	["bash", { command: "sort --output=sorted.txt notes" }],
	["bash", { command: "sort --compress-program=gzip notes" }],
	["bash", { command: "uniq notes deduped.txt" }], // uniq's second operand is its output file
	["bash", { command: "rg --pre ./conv pattern" }],
	["bash", { command: "rg -z pattern" }],
	["bash", { command: "grep -r foo . > hits.txt" }],
	["bash", { command: "cut -d: -f1 /etc/passwd | tee users" }],
	["bash", { command: "git -C /tmp ls-files --bogus" }], // an option ls-files does not list
	["bash", { command: "git blame --bogus README.md" }],
	// M8 ctx wiring: ctx's write commands and the write forms of its reads.
	["bash", { command: "ctx import --all" }],
	["bash", { command: "ctx setup" }],
	["bash", { command: "ctx index mode manual" }],
	["bash", { command: "ctx integrations install omp" }],
	["bash", { command: "ctx --quiet import --provider pi" }], // a global option before the write verb
	["bash", { command: "ctx sources add --provider pi --root /tmp/s as2" }],
	["bash", { command: "ctx sources remove as2" }],
	["bash", { command: "ctx status --usage reset" }],
	["bash", { command: "ctx status --usage=disable" }],
	["bash", { command: "ctx search --refresh wait wl-munn32rmt6ajnk" }], // runs the refresh (an import) first
	["bash", { command: "ctx search --refresh=wait foo" }],
	["bash", { command: "ctx show session 01a0f0ca --out transcript.md" }],
	["bash", { command: "ctx graph --query-log q.jsonl search Ledger" }],
	["bash", { command: "ctx graph search Ledger --query-log=q.jsonl" }],
	["bash", { command: "ctx graph index ." }],
	["bash", { command: "ctx search $FLAGS foo" }], // a word known only when it runs may be --refresh=wait
	["bash", { command: "ctx $VERB foo" }],
	["bash", { command: "ctx search foo > hits.txt" }],
	["write", { path: "xd://mcp__ctx_x_search", content: "{}" }], // a server named ctx_x, not ctx
	["write", { path: "xd://mcp__linear_save_issue", content: "{}" }], // another server's device
	["bash", { command: "" }],
];

const ALLOWED: [string, Record<string, unknown>][] = [
	["read", { path: "gates/index.ts" }],
	["grep", { pattern: "row", path: "gates" }],
	["find", { query: "row 6", grep_keywords: [] }],
	["glob", { path: "gates/**" }],
	["ls", { path: "gates" }],
	["bash", { command: "ls -la gates" }],
	["bash", { command: "cat gates/index.ts | wc -l" }],
	["bash", { command: "head -n 5 README.md; tail -n 5 README.md" }],
	["bash", { command: "[ -f README.md ] && echo yes" }],
	["bash", { command: "diff a.txt b.txt", cwd: "gates" }],
	["bash", { command: "git status" }],
	["bash", { command: "git status --short --branch" }],
	["bash", { command: "git log --oneline -5" }],
	["bash", { command: "git diff HEAD~1 --stat" }],
	["bash", { command: "git show HEAD" }],
	["bash", { command: "git rev-parse --show-toplevel" }],
	["bash", { command: "git branch" }],
	["bash", { command: "git branch -a -v" }],
	["bash", { command: "git branch --list 'feat*'" }],
	["bash", { command: "git branch --contains HEAD" }], // --contains takes HEAD as its value: list mode
	["bash", { command: "git branch --show-current" }],
	["bash", { command: "git remote -v" }],
	["bash", { command: "git worktree list" }],
	["bash", { command: "cd gates && ls" }],
	["bash", { command: "cd /tmp && git status" }],
	["bash", { command: "cat notes 2>/dev/null" }],
	["bash", { command: "git log --oneline -3 2>/dev/null | head -n 1" }],
	// M7 fix round 2, finding A: Ilex's exact command on the orchestrator (05:03:03), refused before
	// because `git ls-files` was not a gitReads subcommand and `grep` sat in no read table.
	// Ilex ran it against /Users/jowolff/code/agent-system-2.0; this checkout stands in, so it holds for any uid.
	["bash", { command: `ls -a ${REPO_ROOT} && git -C ${REPO_ROOT} ls-files | grep -i read` }],
	["bash", { command: "git ls-files" }],
	["bash", { command: "git ls-files --others --exclude-standard" }],
	["bash", { command: "git blame -L 1,10 README.md" }],
	["bash", { command: "git describe --tags --always" }],
	["bash", { command: "git stash list" }],
	["bash", { command: "grep -rn 'row 15' gates" }],
	["bash", { command: "egrep -i 'a|b' notes" }],
	["bash", { command: "rg -n -g '*.ts' checkOrchestratorRole gates" }],
	["bash", { command: "rg -e -z notes" }], // -e takes -z as its pattern
	["bash", { command: "find gates -name '*.ts' -type f" }],
	["bash", { command: "cat notes | sort -u | uniq -c" }],
	["bash", { command: "uniq -f 1 notes" }], // -f's value is not an output operand
	["bash", { command: "cut -d: -f1 notes" }],
	["bash", { command: "awk -F: '{print $1}' notes" }],
	["bash", { command: "awk -v n=2 'NR==n' notes" }],
	["bash", { command: "git log --oneline | awk '{print $1}' | sort | uniq -c | head -n 3" }],
	// M8 ctx wiring: "older history is one ctx index query away" (tiers/orchestrator.md).
	["bash", { command: "ctx search wl-munn32rmt6ajnk --since 2d" }],
	["bash", { command: "ctx search --limit 5 --source-root agent-system-2-sessions -- \"wake read\"" }],
	["bash", { command: "ctx search --refresh off foo" }],
	["bash", { command: "ctx --quiet --data-root /tmp/ctx search foo --format json" }],
	["bash", { command: "ctx search -- $QUERY" }], // after `--` a word is only the query
	["bash", { command: "ctx show session 01a0f0ca --max-events 50" }],
	["bash", { command: "ctx show event abc --window 3" }],
	["bash", { command: "ctx locate session 01a0f0ca" }],
	["bash", { command: "ctx blame file README.md --lines 1:5" }],
	["bash", { command: "ctx status" }],
	["bash", { command: "ctx sources --provider pi --format json" }],
	["bash", { command: "ctx doctor" }],
	["bash", { command: "ctx graph search Ledger --depth 2" }],
	["bash", { command: "ctx graph --db .graf/index.db query Ledger" }],
	["bash", { command: "ctx search foo 2>/dev/null | head -n 20" }],
	["write", { path: "xd://mcp__ctx_search", content: "{\"query\":\"wl-munn32rmt6ajnk\"}" }],
	["write", { path: "xd://mcp__ctx_show_session", content: "{}" }],
	...SURFACE_TOOLS.map((t): [string, Record<string, unknown>] => [t, {}]),
	...SURFACE_TOOLS.map((t): [string, Record<string, unknown>] => ["write", { path: `xd://${t}`, content: "{}" }]),
];

const label = ([tool, input]: [string, Record<string, unknown>]) => `${tool} ${JSON.stringify(input.command ?? input.path ?? input.tasks ?? input.code ?? "")}`;

describe("P-11 row 15: the orchestrator does no lane work", () => {
	for (const call of REFUSED) {
		test(`orchestrator refuses ${label(call)}`, async () => {
			expect(await session("orchestrator")(...call)).toEqual({ block: true, reason: ORCHESTRATOR_ROLE_REFUSAL });
		});
	}
	for (const call of ALLOWED) {
		test(`orchestrator allows ${label(call)}`, async () => {
			expect(await session("orchestrator")(...call)).toBeUndefined();
		});
	}
	test("the refusal is one line naming the tool that opens a workload", () => {
		expect(ORCHESTRATOR_ROLE_REFUSAL).not.toContain("\n");
		expect(ORCHESTRATOR_ROLE_REFUSAL).toContain("orchestrator_open_workload");
		expect(SURFACE_TOOLS).toContain("orchestrator_open_workload");
	});
	test("rg under a session RIPGREP_CONFIG_PATH is refused unless it passes --no-config (the config file can add --pre)", () => {
		const env = { HOME: "/nonexistent-home", RIPGREP_CONFIG_PATH: "/tmp/rgrc" };
		expect(readOnlyBash("rg pattern notes", "/tmp", env)).toBe(false);
		expect(readOnlyBash("rg --no-config pattern notes", "/tmp", env)).toBe(true);
		expect(readOnlyBash("rg pattern notes", "/tmp", { HOME: "/nonexistent-home" })).toBe(true);
	});
	test("round 2, B2, over an unreadable ledger (what the `_as2test` runner sees): a call the role refuses keeps the role refusal, a hand-on call is refused as unchecked (fail closed), reads pass", async () => {
		const call = session("orchestrator", join(tmp("r15-no-ledger"), "missing", "ledger.db"));
		for (const c of REFUSED) expect(await call(...c)).toEqual({ block: true, reason: ORCHESTRATOR_ROLE_REFUSAL });
		for (const c of WORKING.filter(([t, i]) => t.startsWith("orchestrator_") || String(i.path ?? "").startsWith("xd://orchestrator_"))) {
			expect((await call(...c))?.reason).toStartWith("P-11 row 15 could not check this call (");
		}
		for (const c of READING) expect(await call(...c)).toBeUndefined();
	});
	for (const kind of ["lane", "hand"] as const) {
		test(`a ${kind} session is untouched by every call the orchestrator is refused or allowed`, async () => {
			const call = session(kind);
			for (const c of [...REFUSED, ...ALLOWED]) expect(await call(...c)).toBeUndefined();
		});
	}
});

// M7 fix round 2, finding B: Jo's answer to the orchestrator's QUESTION never reached the ledger.
// The turn sequence of Jo's session 2026-09-30 (Ilex): entry 30, the QUESTION (the workload id only
// in the CLAIM above it), then Jo's "use your draft" (entry 31), then a working call (entry 32 was a
// `write` of README.md). MIGRATION.md item 105: the ask itself is a `questions` row first, raised with
// orchestrator_raise_question and named by id in the QUESTION block; a block naming no row is refused,
// and a block naming an open row is refused until the row is answered — by Jo's word at the surface or
// by the recorder naming the question. Both extensions are loaded, as the as2 profile loads them.
const REAL_SESSION = "/Users/jowolff/.omp/profiles/agent-system-2/agent/sessions/-tmp/2026-09-30T04-59-58-976Z_01a0f0af-0c80-7000-abb3-08e67c02614d.jsonl";
const REAL_WL = "wl-munn32rmt6ajnk";
const ILEX_QUESTION = [
	"**CLAIM**",
	"Needs you: one thing, the text of the README line. There's nothing else open.",
	"",
	"**CLAIM**",
	`I opened a workload for this: the one-line README addition to agent-system-2.0 (${REAL_WL}). It's at normal stakes and autonomous, and no lane is dispatched yet. It's waiting only on the line's text.`,
	"",
	"**GUESS(inference)**",
	"My draft, if you just want something descriptive: `agent-system-2.0: orchestrator, lanes, and tiered hands over a SQLite ledger, with output-types gates; see SPEC-2.0.md and MIGRATION.md.`",
	"",
	"**QUESTION**",
	"What should the one line in the new root `README.md` say: my draft line above (I recommend it if you just want a pointer to the spec and the migration plan), or your own text?",
].join("\n");
/** The same ask, re-sent naming its row. */
const withId = (q: string) => ILEX_QUESTION.replace("**QUESTION**\n", `**QUESTION**\n(${q}) `);

type Entry = { type: string; timestamp?: string; message?: { role: string; content: { type: string; text: string }[] } };
/** A session-file message; no timestamp, since the binding reads none (fix round 1, B3). */
const said = (role: "user" | "assistant", text: string): Entry => ({ type: "message", message: { role, content: [{ type: "text", text }] } });
const textOf = (e: Entry): string => e.message?.content.map((p) => p.text).join("") ?? "";
const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

/**
 * All three extensions, as the as2 profile loads them: the surface, row 1 (which binds a reply's QUESTION at publication) and row 15.
 * `existing`: a ledger from an earlier session to start over (a restart, with an empty session file); else a fresh one with `workloads`.
 */
function answerSession(workloads: string[] = [REAL_WL], existing?: string) {
	const db = existing ?? join(tmp("r15-ledger"), "ledger.db");
	if (!existing) {
		const ledger = Ledger.open(db, { create: true, backup: false, backupOnOpen: false });
		for (const id of workloads) ledger.openWorkload({ id, by: "orchestrator-surface", brief: `brief of ${id}`, stakes: "normal", mode: "autonomous" });
		ledger.close();
	}
	const env = { HOME: "/nonexistent-home", AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: db };
	const f = fakePi();
	orchestratorSurface(f.pi, env);
	turnShapeRow(f.pi as unknown as GatesAPI, env);
	orchestratorRoleRow(f.pi as unknown as GatesAPI, env);
	const entries: Entry[] = [];
	const ctx = { ...ctxOf(), sessionManager: { getHeader: () => null, getEntries: () => entries } };
	const call = (toolName: string, input: Record<string, unknown>) => f.emit("tool_call", { toolName, toolCallId: "c", input }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
	const open = () => Ledger.open(db, { create: false, backup: false, backupOnOpen: false });
	const read = <T>(fn: (l: Ledger) => T): T => {
		const l = open();
		try {
			return fn(l);
		} finally {
			l.close();
		}
	};
	const instructions = (id: string) => read((l) => l.instructions(id));
	const question = (id: string) => read((l) => l.question(id));
	/** The citations the gates wrote: one `question-published:` body per published reply. */
	const cited = () => read((l) => l.entries(STANDING_WORKLOAD_ID, "assumption").map((e) => e.body).filter((b) => b.startsWith("question-published:")));
	/** The orchestrator raises its ask through the tool; the returned id. */
	const raise = async (about: string | null = REAL_WL): Promise<string> => {
		const r = await f.tool("orchestrator_raise_question").execute("1", { body: "What should the one README line say?", options: ["draft", "mine"], ...(about ? { about } : {}) }, undefined, undefined, ctx);
		const m = /^Raised question (q-\S+)/.exec(r.content[0]!.text);
		if (!m) throw new Error(`not raised: ${r.content[0]!.text}`);
		return m[1]!;
	};
	/** The orchestrator's final reply through the gates, then the turn's stop: null when it reached Jo, else the stop's reason. The session file gets what OMP stored (the marker, when held). */
	const publish = async (text: string): Promise<string | null> => {
		const r = (await f.emit("assistant_message", { message: message(text) }, ctx)) as { content: { type: string; text: string }[] } | undefined;
		const stored = r ? r.content.map((p) => p.text).join("") : text;
		entries.push(said("assistant", stored));
		const stop = (await f.emit("session_stop", { last_assistant_message: message(stored) }, ctx)) as { decision?: string; reason?: string } | undefined;
		return stop?.reason ?? null;
	};
	/** A `session_stop` over a reply the session file holds unpublished (as after a restart): the block's reason, or null. */
	const stop = async (text: string): Promise<string | null> => {
		const r = (await f.emit("session_stop", { last_assistant_message: message(text) }, ctx)) as { decision?: string; reason?: string } | undefined;
		return r?.reason ?? null;
	};
	/** Jo types `text` (OMP's `input`, then the turn): the `in-…` id of the row the surface wrote for it. */
	const type = async (text: string): Promise<string> => {
		await Bun.sleep(2); // the row must postdate the question it answers (a tie in the millisecond stamp is refused)
		await f.emit("input", { text, source: "interactive" }, ctx);
		await f.emit("before_agent_start", { prompt: text, systemPrompt: [] }, ctx);
		entries.push(said("user", text));
		const e = f.entries.filter((x) => x.type === "surface-jo-input").at(-1) as { data: { id: string } } | undefined;
		if (!e) throw new Error(`no input row for ${JSON.stringify(text)}`);
		return e.data.id;
	};
	/** Jo's command at the surface: OMP's `input` from `source` (none when null), then the turn's prompt `text`. */
	const command = async (text: string, source: string | null = "interactive", prompt = text): Promise<void> => {
		if (source !== null) await f.emit("input", { text, source }, ctx);
		await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx);
		entries.push(said("user", prompt));
	};
	/** An orchestrator message carrying `text` beside a tool call, through the gates: what OMP stores (the hook's replacement, or the message). */
	const working = async (text: string, tool: Record<string, unknown> = { type: "toolCall", id: "read1", name: "read", arguments: { path: "README.md" } }) => {
		const msg = { role: "assistant", content: [{ type: "text", text }, tool] };
		const r = (await f.emit("assistant_message", { message: msg }, ctx)) as { content: { type: string; text?: string }[] } | undefined;
		const stored = r?.content ?? msg.content;
		entries.push({ type: "message", message: { role: "assistant", content: stored.filter((p) => p.type === "text").map((p) => ({ type: "text", text: p.text ?? "" })) } });
		return stored;
	};
	const record = async (params: Record<string, unknown>): Promise<string> =>
		(await f.tool("orchestrator_record_instruction").execute("1", { reading: "use the drafted README line", ...params }, undefined, undefined, ctx)).content[0]!.text;
	return { f, ctx, entries, call, instructions, question, cited, raise, publish, stop, type, command, working, record, db };
}

const WORKING: [string, Record<string, unknown>][] = [
	["write", { path: "/Users/jowolff/code/agent-system-2.0/README.md", content: "x" }], // Ilex's entry 32
	["task", { tasks: [{ agent: "lane", task: "write the README line" }] }], // entry 35
	["orchestrator_close_workload", { workloadId: REAL_WL }],
	["orchestrator_open_workload", { brief: "README line, again" }],
	["orchestrator_schedule", { due: "2026-10-01", text: "x" }],
	["write", { path: "xd://orchestrator_close_workload", content: "{}" }],
];
const READING: [string, Record<string, unknown>][] = [
	["read", { path: "README.md" }],
	["bash", { command: "git log --oneline -3" }],
	["orchestrator_ledger", {}],
	["orchestrator_wake_read", { body: "x" }],
	["orchestrator_record_instruction", {}],
	["write", { path: "xd://orchestrator_record_instruction", content: "{}" }],
	["orchestrator_raise_question", {}],
	["write", { path: "xd://orchestrator_raise_question", content: "{}" }],
];
const SCHEDULE: [string, Record<string, unknown>] = ["orchestrator_schedule", { due: "2026-10-01", text: "x" }];

describe("P-11 row 15: the orchestrator's QUESTION is a ledger row, answered before it works on (M7 fix round 2, finding B; MIGRATION.md item 105; fix round 1 B1-B3)", () => {
	test("the session's sequence: a QUESTION with no row is held at publication and blocked at stop, and working calls under the hold are refused naming the question tool; raised and re-sent with its id it reaches Jo and is cited; working calls then name the recorder; Jo's typed 'use your draft' is an input row, and the recorder naming it answers the row with Jo's bytes, mirrors the instruction on the workload, and the gate lifts", async () => {
		const s = answerSession();
		const held = await s.publish(ILEX_QUESTION);
		expect(held).toStartWith(`${UNRECORDED_QUESTION_REFUSAL}\n\nYour held reply was:\n\n**CLAIM**`);
		expect(textOf(s.entries.at(-1)!)).toStartWith("(Reply held by P-11 row 1.");
		expect(s.cited()).toEqual([]);
		for (const c of WORKING) expect(await s.call(...c)).toEqual({ block: true, reason: UNRECORDED_QUESTION_REFUSAL });
		expect(UNRECORDED_QUESTION_REFUSAL).not.toContain("\n");
		for (const c of READING) expect(await s.call(...c)).toBeUndefined();
		// The row alone lifts nothing: the held reply stands until one passes, and the ask is re-sent naming the id.
		const q = await s.raise();
		expect(s.question(q)).toMatchObject({ workload_id: STANDING_WORKLOAD_ID, slice_id: "sl-orchestrator-questions", state: "open", body: "What should the one README line say?" });
		expect((await s.call("orchestrator_close_workload", { workloadId: REAL_WL }))?.reason).toBe(UNRECORDED_QUESTION_REFUSAL);
		expect(await s.publish(withId(q))).toBeNull();
		expect(textOf(s.entries.at(-1)!)).toBe(withId(q));
		expect(s.cited()).toEqual([`question-published: ${q}`]);
		const input = await s.type("use your draft");
		for (const c of WORKING) {
			const r = await s.call(...c);
			expect(r?.block).toBe(true);
			expect(r?.reason).toBe(answerFirstRefusal([q]));
		}
		expect(answerFirstRefusal([q])).not.toContain("\n");
		for (const c of READING) expect(await s.call(...c)).toBeUndefined();
		// The recorder answers only from Jo's input row: no inputId records nothing, and `words` is never Jo's text.
		expect(await s.record({ questionId: q, words: "use your draft" })).toContain("pass inputId");
		expect(s.question(q)).toMatchObject({ state: "open" });
		const rec = await s.record({ questionId: q, inputId: input, words: "write your own" });
		expect(rec).toContain(`Answered ${q} with Jo's input ${input}`);
		expect(rec).toContain(`on ${REAL_WL} (author jo, channel surface): "use your draft" — use the drafted README line`);
		expect(s.question(q)).toMatchObject({ state: "answered" });
		expect(s.instructions(REAL_WL)).toMatchObject([{ kind: "instruction", author: "jo", channel: "surface", body: `Jo: "use your draft" — reading: use the drafted README line (answers ${q})` }]);
		expect(s.instructions(STANDING_WORKLOAD_ID).map((i) => [i.kind, i.body, i.question_id])).toEqual([["instruction", "use your draft", null], ["answer", "use your draft", q]]);
		// the gate lifts: a hand-on call passes row 15, and the lane's tools get the role refusal again
		expect(await s.call("orchestrator_close_workload", { workloadId: REAL_WL })).toBeUndefined();
		expect(await s.call("write", { path: "README.md", content: "x" })).toEqual({ block: true, reason: ORCHESTRATOR_ROLE_REFUSAL });
		// A row is asked once: the answered row cannot be cited again.
		expect(await s.publish(withId(q))).toStartWith(reusedQuestionRefusal(q, "answered"));
	});

	test("a reply that asks about the question records nothing and is not refused: it is words; the working call stays refused until the row is answered", async () => {
		const s = answerSession();
		const q = await s.raise();
		expect(await s.publish(withId(q))).toBeNull();
		await s.type("which draft, the one with the ledger in it?");
		expect(await s.publish("**PMDW**\nThe draft is the line quoted above, the one naming the SQLite ledger.")).toBeNull();
		for (const c of READING.slice(0, 3)) expect(await s.call(...c)).toBeUndefined();
		expect(s.instructions(REAL_WL)).toEqual([]);
		expect((await s.call("orchestrator_close_workload", { workloadId: REAL_WL }))?.reason).toBe(answerFirstRefusal([q]));
	});

	test("which rows count (fix round 1, B3): an unknown id, a lane's row, a row off the standing slice, or an unknown id beside a good one is unrecorded at publication and at the working call; a resolved row never published is unrecorded; no timestamp is read; a row is cited once; a block naming two open rows names both", async () => {
		const s = answerSession();
		expect(await s.publish("**QUESTION**\n(q-nope) Today or tomorrow?")).toStartWith(UNRECORDED_QUESTION_REFUSAL);
		expect((await s.call(...SCHEDULE))?.reason).toBe(UNRECORDED_QUESTION_REFUSAL);
		const q = await s.raise();
		const l = Ledger.open(s.db, { create: false, backup: false, backupOnOpen: false });
		const sl = l.addSlice({ by: "lane-a", workloadId: REAL_WL, task: "t", doneCondition: "d", inputs: "i" });
		const lanes = l.raiseQuestion({ by: "lane-a", workloadId: REAL_WL, sliceId: sl, body: "a lane's", options: ["a", "b"] });
		const aside = l.addSlice({ by: "orchestrator-surface", workloadId: STANDING_WORKLOAD_ID, task: "not the standing slice", doneCondition: "d", inputs: "i" });
		const offSlice = l.raiseQuestion({ by: "orchestrator-surface", workloadId: STANDING_WORKLOAD_ID, sliceId: aside, body: "off the standing slice", options: ["a", "b"] });
		l.close();
		for (const bad of [lanes, offSlice]) {
			s.entries.length = 0;
			expect(await s.publish(`**QUESTION**\n(${bad}) Today or tomorrow?`)).toStartWith(UNRECORDED_QUESTION_REFUSAL);
			expect((await s.call(...SCHEDULE))?.reason).toBe(UNRECORDED_QUESTION_REFUSAL);
		}
		// An unknown id beside a good one is a refusal, never discarded.
		s.entries.length = 0;
		expect(await s.publish(`**QUESTION**\n(${q}, q-nope) Today or tomorrow, and the other too?`)).toStartWith(UNRECORDED_QUESTION_REFUSAL);
		expect(s.cited()).toEqual([]);
		// A session file carrying the reply without its citation (never published through the gates): the open row refuses the call answer-first, and the stop refuses the uncited reply. Jo's input lifts the earlier hold first.
		await s.f.emit("input", { text: "hm", source: "interactive" }, s.ctx);
		s.entries.length = 0;
		// The open set is the ledger's (round 2, B2): every open row on the standing workload, the off-slice one too, with nothing in the session; withdrawn, it is gone.
		expect((await s.call(...SCHEDULE))?.reason).toBe(answerFirstRefusal([q, offSlice]));
		const l2 = Ledger.open(s.db, { create: false, backup: false, backupOnOpen: false });
		l2.withdrawQuestion(offSlice, { by: "orchestrator-surface", author: "jo", channel: "surface", reason: "test", then: "replan" });
		l2.close();
		s.entries.push(said("assistant", `**QUESTION**\n(${q}) Today or tomorrow?`));
		expect((await s.call(...SCHEDULE))?.reason).toBe(answerFirstRefusal([q]));
		expect(await s.stop(`**QUESTION**\n(${q}) Today or tomorrow?`)).toBe(UNRECORDED_QUESTION_REFUSAL);
		// Published, two open rows in the one block a turn carries: both named; each answered from Jo's own input lifts its own.
		s.entries.length = 0;
		const q2 = await s.raise(null);
		expect(await s.publish(`**QUESTION**\n(${q}, ${q2}) Today or tomorrow, and the other too?`)).toBeNull();
		expect(s.cited()).toEqual([`question-published: ${q} ${q2}`]);
		expect((await s.call(...SCHEDULE))?.reason).toBe(answerFirstRefusal([q, q2]));
		const today = await s.type("today");
		expect(await s.record({ questionId: q, inputId: today, reading: "today" })).toStartWith(`Answered ${q} with Jo's input ${today}`);
		expect((await s.call(...SCHEDULE))?.reason).toBe(answerFirstRefusal([q2]));
		expect(await s.record({ questionId: q2, inputId: today, reading: "the other too" })).toBe(`${today} already answered ${q}, and one input is recorded once; nothing was recorded.`);
		const other = await s.type("the other too");
		expect(await s.record({ questionId: q2, inputId: other, reading: "the other too" })).toStartWith(`Answered ${q2} with Jo's input ${other}`);
		expect(await s.call(...SCHEDULE)).toBeUndefined();
		// A question with no subject: the answer lands on the standing workload only.
		expect(s.question(q2)).toMatchObject({ state: "answered", body: "What should the one README line say?" });
		expect(s.instructions(REAL_WL).map((i) => i.body)).toEqual([`Jo: "today" — reading: today (answers ${q})`]);
		// A published open row cannot be cited by a second reply; a resolved one cannot be cited at all.
		const q3 = await s.raise();
		expect(await s.publish(`**QUESTION**\n(${q3}) Again?`)).toBeNull();
		expect(await s.publish(`**QUESTION**\n(${q3}) Again?`)).toStartWith(reusedQuestionRefusal(q3, "published"));
		expect(await s.publish(`**QUESTION**\n(${q2}) Again?`)).toStartWith(reusedQuestionRefusal(q2, "answered"));
		expect(s.cited()).toEqual([`question-published: ${q} ${q2}`, `question-published: ${q3}`]);
		// Under the hold of that refused reply the working call carries its reason; Jo's input lifts it.
		expect((await s.call(...SCHEDULE))?.reason).toBe(reusedQuestionRefusal(q2, "answered"));
		await s.f.emit("input", { text: "hm", source: "interactive" }, s.ctx);
		// A resolved row never published stays unrecorded at the working call, whatever the clock says.
		const q4 = await s.raise(null);
		await s.command(`draft ${q4}`);
		expect(s.question(q4)).toMatchObject({ state: "answered" });
		s.entries.length = 0;
		s.entries.push(said("assistant", `**QUESTION**\n(${q4}) Draft or mine?`));
		expect((await s.call(...SCHEDULE))?.reason).toBe(UNRECORDED_QUESTION_REFUSAL);
	});

	test.skipIf(!existsSync(REAL_SESSION))("on the real session file: entries through Jo's 'use your draft' leave Ilex's README write refused, the ask having no row; raised, published and answered from Jo's input, the write gets the role refusal", async () => {
		const s = answerSession();
		const real = readFileSync(REAL_SESSION, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry);
		const jo = real.findIndex((e) => e.message?.role === "user" && e.message.content.some((p) => p.text === "use your draft"));
		expect(jo).toBeGreaterThan(0);
		s.entries.push(...real.slice(0, jo + 1));
		const ilexWrite = real[jo + 1]!.message!.content.find((p) => p.type === "toolCall") as unknown as { name: string; arguments: Record<string, unknown> };
		expect(ilexWrite.name).toBe("write");
		expect((await s.call(ilexWrite.name, ilexWrite.arguments))?.reason).toBe(UNRECORDED_QUESTION_REFUSAL);
		const q = await s.raise();
		expect(await s.publish(withId(q))).toBeNull();
		const input = await s.type("use your draft");
		expect((await s.call(ilexWrite.name, ilexWrite.arguments))?.reason).toBe(answerFirstRefusal([q]));
		expect(await s.record({ questionId: q, inputId: input })).toStartWith(`Answered ${q}`);
		expect((await s.call(ilexWrite.name, ilexWrite.arguments))?.reason).toBe(ORCHESTRATOR_ROLE_REFUSAL);
	});
});

// MIGRATION.md item 72: on 2026-10-07 Jo's answer was recorded on wl-muraerdsgw7gn4 and the launch
// tool was still refused. Two shapes gave that refusal (PLAN.md § 1, wl-mv0n866rd9jlds): one QUESTION
// naming several workloads, and the session entry's clock against the ledger row's. Under item 105
// the ask is a row per subject and the row's state is the order (no clock, no session result read),
// and a launch or close naming one workload waits only on the rows about that workload.
const WL_A = "wl-answered00000a";
const WL_B = "wl-pending000000b";
const launchCalls = (id: string): [string, Record<string, unknown>][] => [
	["orchestrator_launch_lane", { workloadId: id, reason: "relaunch after the answer" }],
	["write", { path: "xd://orchestrator_launch_lane", content: JSON.stringify({ workloadId: id }) }],
	["orchestrator_close_workload", { workloadId: id }],
	["write", { path: "xd://orchestrator_close_workload", content: JSON.stringify({ workloadId: id }) }],
];
/** A toolResult entry as OMP stores it: not read by the binding, which trusts the row alone. */
const toolResultMsg = (toolCallId: string, toolName: string, text: string, details: unknown): Entry =>
	({ type: "message", message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], details, isError: false } }) as unknown as Entry;

/** Two rows, one about A and one about B, asked in one block, published; Jo has answered neither yet. */
async function twoAsked() {
	const s = answerSession([WL_A, WL_B]);
	const qA = await s.raise(WL_A);
	const qB = await s.raise(WL_B);
	expect(await s.publish(`**QUESTION**\n(${qA}, ${qB}) Should A keep production stakes, and B get a higher ceiling?`)).toBeNull();
	return { ...s, qA, qB };
}

describe("P-11 row 15: a recorded answer lifts the gate on its own workload (MIGRATION.md item 72, under item 105's rows)", () => {
	test("item 72 positive: one block asks about A and B, Jo's answer is recorded on A's row; launch A and close A pass, direct and as devices, while B's row holds B and every unscoped call", async () => {
		const s = await twoAsked();
		const input = await s.type("keep production on A");
		for (const c of launchCalls(WL_A)) expect((await s.call(...c))?.reason).toBe(answerFirstRefusal([s.qA, s.qB]));
		expect(await s.record({ questionId: s.qA, inputId: input, reading: "keep production stakes on A" })).toStartWith(`Answered ${s.qA}`);
		for (const c of launchCalls(WL_A)) expect(await s.call(...c)).toBeUndefined();
		for (const c of launchCalls(WL_B)) expect((await s.call(...c))?.reason).toBe(answerFirstRefusal([s.qB]));
		const unscoped: [string, Record<string, unknown>][] = [
			["orchestrator_open_workload", { brief: "another" }],
			["orchestrator_schedule", { due: "2026-11-01", text: "x" }],
			["write", { path: "/Users/jowolff/code/agent-system-2.0/README.md", content: "x" }],
			["task", { tasks: [{ agent: "lane", task: "x" }] }],
			["orchestrator_launch_lane", {}],
			["orchestrator_close_workload", { workloadId: "" }],
		];
		for (const c of unscoped) expect((await s.call(...c))?.reason).toBe(answerFirstRefusal([s.qB]));
		// Jo's typed word at the surface answers B's row the same way, and everything passes row 15.
		await s.command(`draft ${s.qB}`);
		expect(s.question(s.qB)).toMatchObject({ state: "answered" });
		for (const c of [...launchCalls(WL_A), ...launchCalls(WL_B)]) expect(await s.call(...c)).toBeUndefined();
		expect(await s.call("orchestrator_schedule", { due: "2026-11-01", text: "x" })).toBeUndefined();
	});

	test("item 72 positive: no clock is read; a QUESTION entry stamped a minute ahead of the ledger, and an answer row older than it, still lift the gate", async () => {
		const s = answerSession([WL_A]);
		const q = await s.raise(WL_A);
		const text = `**QUESTION**\n(${q}) Should A keep production stakes?`;
		expect(await s.publish(text)).toBeNull();
		s.entries[s.entries.length - 1] = { ...said("assistant", text), timestamp: new Date(Date.now() + 60_000).toISOString() };
		const input = await s.type("keep production");
		expect(await s.record({ questionId: q, inputId: input, reading: "keep production" })).toStartWith(`Answered ${q}`);
		expect(s.instructions(WL_A)[0]!.created_at < s.entries.find((e) => textOf(e) === text)!.timestamp!).toBe(true);
		expect(await s.call("orchestrator_launch_lane", { workloadId: WL_A })).toBeUndefined();
	});

	test("item 72 guard: device content that is malformed, missing, empty, non-string or not an object names no target and is refused while B is unanswered", async () => {
		const s = await twoAsked();
		const input = await s.type("keep production on A");
		await s.record({ questionId: s.qA, inputId: input, reading: "keep production stakes on A" });
		const contents: unknown[] = [`{"workloadId":"${WL_A}"`, "not json", "{}", '{"workloadId":""}', '{"workloadId":"   "}', `{"workloadId":7}`, `["${WL_A}"]`, `"${WL_A}"`, "null", undefined, { workloadId: WL_A }];
		for (const device of ["xd://orchestrator_launch_lane", "xd://orchestrator_close_workload"]) {
			for (const content of contents) expect((await s.call("write", { path: device, content }))?.reason).toBe(answerFirstRefusal([s.qB]));
		}
	});

	test("item 72 guard: the row is the authority; recorder results in the session, paired or spoofed, answer nothing while the row is open", async () => {
		const s = await twoAsked();
		s.entries.push(toolResultMsg("rec-spoof", "orchestrator_record_instruction", `Answered ${s.qA} with Jo's input in-x`, { id: "in-x", questionId: s.qA, workloadId: WL_A }));
		s.entries.push(toolResultMsg("rec-w1", "write", `Answered ${s.qA} with Jo's input in-x`, { xdev: { tool: "orchestrator_record_instruction", mode: "execute", inner: { id: "in-x", questionId: s.qA, workloadId: WL_A } } }));
		for (const c of launchCalls(WL_A)) expect((await s.call(...c))?.reason).toBe(answerFirstRefusal([s.qA, s.qB]));
		// A plain Jo instruction row on A (a stakes flip, an instruction recorded with workloadId) is not the answer: the row stays open.
		const input = await s.type("production on A");
		expect(await s.record({ workloadId: WL_A, inputId: input, reading: "production stakes on A" })).toStartWith("Recorded instruction");
		for (const c of launchCalls(WL_A)) expect((await s.call(...c))?.reason).toBe(answerFirstRefusal([s.qA, s.qB]));
	});

	test("item 72 guard: an open row with no subject scopes to nothing, so a launch naming A waits on it; withdrawn, A's launch passes", async () => {
		const s = answerSession([WL_A]);
		const q = await s.raise(null);
		expect(await s.publish(`**QUESTION**\n(${q}) Rename me?`)).toBeNull();
		for (const c of launchCalls(WL_A)) expect((await s.call(...c))?.reason).toBe(answerFirstRefusal([q]));
		await s.command(`withdraw ${q}`);
		expect(s.question(q)).toMatchObject({ state: "withdrawn" });
		for (const c of launchCalls(WL_A)) expect(await s.call(...c)).toBeUndefined();
	});
});

// Codex review of PR #55 round 2. B1: a command-shaped prompt resolved the orchestrator's question
// with no typed input behind it. B2: the open set came from the newest QUESTION message, so an older
// open row behind a newer answered one, or every row after a restart, was forgotten. B3: QUESTION
// text beside a tool call was never bound to its row.
describe("P-11 row 15 round 2: only Jo's typed words resolve the orchestrator's question (B1)", () => {
	test("the reviewer's probe: `draft q-…` with no input event and `withdraw q-…` from an extension's input leave the row open, write no row, and row 15 still refuses", async () => {
		const s = answerSession([WL_A]);
		const q = await s.raise(null);
		expect(await s.publish(`**QUESTION**\n(${q}) Draft or mine?`)).toBeNull();
		await s.command(`draft ${q}`, null);
		expect(s.question(q)).toMatchObject({ state: "open" });
		await s.command(`withdraw ${q}`, "extension");
		expect(s.question(q)).toMatchObject({ state: "open" });
		expect(s.instructions(STANDING_WORKLOAD_ID)).toEqual([]);
		expect((await s.call(...SCHEDULE))?.reason).toBe(answerFirstRefusal([q]));
	});

	test("a typed input that does not match the prompt, and the same prompt replayed with no new input, resolve nothing; the genuine typed command does, once", async () => {
		const s = answerSession([WL_A]);
		const q = await s.raise(null);
		expect(await s.publish(`**QUESTION**\n(${q}) Draft or mine?`)).toBeNull();
		// Jo typed `mine q-…`; the turn's prompt says `draft q-…`.
		await s.command(`mine ${q}`, "interactive", `draft ${q}`);
		expect(s.question(q)).toMatchObject({ state: "open" });
		// Typed once, the receipt is read by the first turn only: the next turn with the same prompt and no input is not Jo's.
		await s.f.emit("input", { text: "hello", source: "rpc" }, s.ctx);
		await s.f.emit("before_agent_start", { prompt: "hello", systemPrompt: [] }, s.ctx);
		await s.command("hello", null, `draft ${q}`);
		expect(s.question(q)).toMatchObject({ state: "open" });
		expect(s.instructions(STANDING_WORKLOAD_ID).filter((i) => i.kind !== "instruction")).toEqual([]);
		// Jo typed exactly this (rpc counts as typed): answered, mirrored nowhere (no subject), and the gate lifts.
		await s.command(`draft ${q}`, "rpc");
		expect(s.question(q)).toMatchObject({ state: "answered" });
		expect(await s.call(...SCHEDULE)).toBeUndefined();
	});

	test("a numbered batch and a paste naming the orchestrator's question apply nothing without the typed input, all-or-nothing, and say why; typed, they apply", async () => {
		const s = answerSession([WL_A]);
		const q = await s.raise(null);
		expect(await s.publish(`**QUESTION**\n(${q}) Draft or mine?`)).toBeNull();
		// The question is the one answerable row, so it is #1 in the session's numbering.
		for (const prompt of ["1 draft", `draft ${q}\nthen carry on with the README`, `production ${WL_A}\nwithdraw ${q}`]) {
			for (const source of [null, "extension"]) {
				await s.command(prompt, source);
				expect(s.question(q)).toMatchObject({ state: "open" });
				const echo = s.f.entries.filter((e) => e.type === "surface-input").at(-1) as { data: { receipt: string } } | undefined;
				expect(echo?.data.receipt).toContain(`${q} is the orchestrator's own question, and only words Jo typed at the surface answer or withdraw it`);
			}
		}
		// The paste's other command was refused with it: A's stakes are unchanged.
		expect(s.instructions(WL_A)).toEqual([]);
		await s.command(`production ${WL_A}\nwithdraw ${q}`);
		expect(s.question(q)).toMatchObject({ state: "withdrawn" });
		expect(s.instructions(WL_A).map((i) => i.body)).toEqual(["stakes: production"]);
	});
});

describe("P-11 row 15 round 2: the open set is every open row in the ledger (B2)", () => {
	test("separate turns: a subject-less row asked first and a row about B asked next; B answered, the older row still refuses a close or launch on another workload, direct and as devices, and every unscoped call", async () => {
		const s = answerSession([WL_A, WL_B]);
		const qGlobal = await s.raise(null);
		expect(await s.publish(`**QUESTION**\n(${qGlobal}) Rename the repo?`)).toBeNull();
		const qB = await s.raise(WL_B);
		expect(await s.publish(`**QUESTION**\n(${qB}) B's ceiling?`)).toBeNull();
		await s.command(`draft ${qB}`);
		expect(s.question(qB)).toMatchObject({ state: "answered" });
		for (const c of [...launchCalls(WL_A), ...launchCalls(WL_B)]) expect((await s.call(...c))?.reason).toBe(answerFirstRefusal([qGlobal]));
		expect((await s.call(...SCHEDULE))?.reason).toBe(answerFirstRefusal([qGlobal]));
	});

	test("newest answered, older open: the older row about A still holds A, B passes; withdrawn, everything passes", async () => {
		const s = answerSession([WL_A, WL_B]);
		const qA = await s.raise(WL_A);
		expect(await s.publish(`**QUESTION**\n(${qA}) A's stakes?`)).toBeNull();
		const qB = await s.raise(WL_B);
		expect(await s.publish(`**QUESTION**\n(${qB}) B's ceiling?`)).toBeNull();
		const input = await s.type("raise B's ceiling");
		expect(await s.record({ questionId: qB, inputId: input, reading: "raise B's ceiling" })).toStartWith(`Answered ${qB}`);
		for (const c of launchCalls(WL_A)) expect((await s.call(...c))?.reason).toBe(answerFirstRefusal([qA]));
		for (const c of launchCalls(WL_B)) expect(await s.call(...c)).toBeUndefined();
		expect((await s.call(...SCHEDULE))?.reason).toBe(answerFirstRefusal([qA]));
		await s.command(`withdraw ${qA}`);
		for (const c of [...launchCalls(WL_A), ...launchCalls(WL_B), SCHEDULE]) expect(await s.call(...c)).toBeUndefined();
	});

	test("a restart: a fresh session with an empty session file over the same ledger still refuses under every open row, the subject-less one globally", async () => {
		const first = answerSession([WL_A, WL_B]);
		const qGlobal = await first.raise(null);
		const qB = await first.raise(WL_B);
		expect(await first.publish(`**QUESTION**\n(${qGlobal}, ${qB}) Rename, and B's ceiling?`)).toBeNull();
		const s = answerSession([], first.db);
		expect(s.entries).toEqual([]);
		expect((await s.call(...SCHEDULE))?.reason).toBe(answerFirstRefusal([qGlobal, qB]));
		for (const c of [...launchCalls(WL_A), ...launchCalls(WL_B)]) expect((await s.call(...c))?.reason).toBe(answerFirstRefusal([qGlobal, qB]));
		await s.command(`draft ${qGlobal}`);
		for (const c of launchCalls(WL_A)) expect(await s.call(...c)).toBeUndefined();
		for (const c of launchCalls(WL_B)) expect((await s.call(...c))?.reason).toBe(answerFirstRefusal([qB]));
	});

	test("a row raised and never cited still binds (the needs-you render shows it), and an unpublished QUESTION in the transcript is still unrecorded", async () => {
		const s = answerSession([WL_A]);
		const q = await s.raise(null);
		expect((await s.call(...SCHEDULE))?.reason).toBe(answerFirstRefusal([q]));
		s.entries.push(said("assistant", "**QUESTION**\n(q-nope) Today?"));
		expect((await s.call(...SCHEDULE))?.reason).toBe(UNRECORDED_QUESTION_REFUSAL);
	});
});

describe("P-11 row 15 round 2: a QUESTION beside a tool call is bound to its row (B3)", () => {
	const read = { type: "toolCall", id: "read1", name: "read", arguments: { path: "README.md" } };

	test("the reviewer's probe: an unrecorded QUESTION beside a read is withheld with the read kept; the read passes, working calls are refused; a later PMDW reply does not end the turn, the stop delivers the hold, and the rewrite lifts it", async () => {
		const s = answerSession([WL_A]);
		const stored = await s.working("**QUESTION**\nDraft or mine?", read);
		expect(stored).toEqual([{ type: "text", text: "(Reply held by P-11 row 1. The corrected reply follows.)" }, read]);
		expect(await s.call("read", { path: "README.md" })).toBeUndefined();
		expect((await s.call(...SCHEDULE))?.reason).toBe(UNRECORDED_QUESTION_REFUSAL);
		expect(await s.publish("**PMDW**\nI will wait.")).toBe(`${UNRECORDED_QUESTION_REFUSAL}\n\nYour held reply was:\n\n**QUESTION**\nDraft or mine?\n`);
		expect(s.cited()).toEqual([]);
		// Delivered by that stop: the rewrite, raised and naming its row, passes and lifts the hold.
		const q = await s.raise(null);
		expect(await s.publish(`**QUESTION**\n(${q}) Draft or mine?`)).toBeNull();
		expect((await s.call(...SCHEDULE))?.reason).toBe(answerFirstRefusal([q]));
	});

	test("a valid QUESTION beside a tool call is published and cited once: the message is untouched, and a later reply re-citing its id is refused", async () => {
		const s = answerSession([WL_A]);
		const q = await s.raise(WL_A);
		const text = `**QUESTION**\n(${q}) Keep A at production?`;
		expect(await s.working(text, read)).toEqual([{ type: "text", text }, read]);
		expect(s.cited()).toEqual([`question-published: ${q}`]);
		expect(await s.publish("**PMDW**\nWaiting on you.")).toBeNull();
		expect(await s.publish(text)).toStartWith(reusedQuestionRefusal(q, "published"));
	});

	test("a message beside a tool call with no QUESTION is untouched and lifts no hold", async () => {
		const s = answerSession([WL_A]);
		expect(await s.working("**PMDW**\nReading the README first.", read)).toEqual([{ type: "text", text: "**PMDW**\nReading the README first." }, read]);
		expect(await s.call(...SCHEDULE)).toBeUndefined();
	});

	test("over an unreadable ledger (what the `_as2test` runner sees): a final reply and a tool-bearing message with no QUESTION never open it and pass; a QUESTION beside a tool call is held and the stop blocks (fail closed)", async () => {
		const env = { HOME: join(tmp("r15-home"), "empty"), AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("r15-no-ledger"), "missing", "ledger.db") };
		const f = fakePi();
		turnShapeRow(f.pi as unknown as GatesAPI, env);
		const ctx = { ...ctxOf(), sessionManager: { getHeader: () => null, getEntries: () => [] } };
		const emit = (name: string, event: unknown) => f.emit(name, event, ctx) as Promise<{ content?: unknown[]; decision?: string; reason?: string } | undefined>;
		const reply = message("**PMDW**\nNothing to ask.");
		expect(await emit("assistant_message", { message: reply })).toBeUndefined();
		expect(await emit("assistant_message", { message: { role: "assistant", content: [{ type: "text", text: "**PMDW**\nReading first." }, read] } })).toBeUndefined();
		expect(await emit("session_stop", { last_assistant_message: reply })).toBeUndefined();
		const held = await emit("assistant_message", { message: { role: "assistant", content: [{ type: "text", text: "**QUESTION**\n(q-abc) Draft or mine?" }, read] } });
		expect(held?.content).toEqual([{ type: "text", text: "(Reply held by P-11 row 1. The corrected reply follows.)" }, read]);
		expect(await emit("assistant_message", { message: reply })).toBeUndefined();
		const stop = await emit("session_stop", { last_assistant_message: reply });
		expect(stop?.decision).toBe("block");
		expect(stop?.reason).toStartWith("P-11 row 15 could not bind this reply's QUESTION to the ledger (");
	});
});

describe("P-11 row 15 round 3: only Jo's input lifts a hold (Codex review round 3 on PR #68, S1)", () => {
	const read = { type: "toolCall", id: "read1", name: "read", arguments: { path: "README.md" } };

	test("the reviewer's probe: an extension-sent input leaves an undelivered hold standing (working calls refused, the stop delivers it); Jo's interactive or rpc input lifts it", async () => {
		for (const source of ["interactive", "rpc"] as const) {
			const s = answerSession([WL_A]);
			await s.working("**QUESTION**\nDraft or mine?", read);
			await s.f.emit("input", { text: "background ping", source: "extension" }, s.ctx);
			expect((await s.call(...SCHEDULE))?.reason).toBe(UNRECORDED_QUESTION_REFUSAL);
			expect(await s.stop("**PMDW**\nI will wait.")).toBe(`${UNRECORDED_QUESTION_REFUSAL}\n\nYour held reply was:\n\n**QUESTION**\nDraft or mine?\n`);
			await s.f.emit("input", { text: "never mind", source }, s.ctx);
			expect(await s.call(...SCHEDULE)).toBeUndefined();
			expect(await s.stop("**PMDW**\nOK.")).toBeNull();
		}
	});
});

describe("P-11 row 15 round 3: every QUESTION block cites its own row (Codex review round 3 on PR #68)", () => {
	const read = { type: "toolCall", id: "read1", name: "read", arguments: { path: "README.md" } };
	const closeA: [string, Record<string, unknown>] = ["orchestrator_close_workload", { workloadId: WL_A }];

	test("each block is read on its own: a cited block beside an uncited one yields no ids (unrecorded); two cited blocks yield both ids", () => {
		expect(questionIdsOf("**QUESTION**\n(q-aaa) Raise B's ceiling?\n\n**QUESTION**\nClose A?")).toEqual([]);
		expect(questionIdsOf("**QUESTION**\nClose A?\n\n**QUESTION**\n(q-aaa) Raise B's ceiling?")).toEqual([]);
		expect(questionIdsOf("**QUESTION**\n(q-aaa) Keep A?\n\n**QUESTION**\n(q-bbb, q-aaa) Raise B?")).toEqual(["q-aaa", "q-bbb"]);
		expect(questionIdsOf("**PMDW**\nNo ask here.")).toBeNull();
	});

	test("two blocks beside a tool call, each citing its own row: the message is untouched and both rows are cited; item 72's scoping still frees a workload neither row is about", async () => {
		const s = answerSession([WL_A, WL_B, REAL_WL]);
		const qA = await s.raise(WL_A);
		const qB = await s.raise(WL_B);
		const text = `**QUESTION**\n(${qA}) Keep A at production?\n\n**QUESTION**\n(${qB}) Raise B's ceiling?`;
		expect(await s.working(text, read)).toEqual([{ type: "text", text }, read]);
		expect(s.cited()).toEqual([`question-published: ${qA} ${qB}`]);
		expect((await s.call(...closeA))?.reason).toBe(answerFirstRefusal([qA, qB]));
		expect(await s.call("orchestrator_close_workload", { workloadId: REAL_WL })).toBeUndefined();
	});

	test("a final reply with a cited block and an uncited one is held (row 1 allows one ask per turn) and closing A is refused", async () => {
		const s = answerSession([WL_A, WL_B]);
		const qB = await s.raise(WL_B);
		expect(await s.publish(`**QUESTION**\n(${qB}) Should B get a higher ceiling?\n\n**QUESTION**\nAnd should I close A now?`)).toStartWith(
			"P-11 row 1 refused this turn to Jo: it carries 2 QUESTIONs",
		);
		expect(s.cited()).toEqual([]);
		expect((await s.call(...closeA))?.block).toBe(true);
	});

	test("beside a tool call: a cited block and an uncited block are withheld with the read kept, and working calls are refused", async () => {
		const s = answerSession([WL_A, WL_B]);
		const qB = await s.raise(WL_B);
		expect(await s.working(`**QUESTION**\n(${qB}) Raise B's ceiling?\n\n**QUESTION**\nClose A?`, read)).toEqual([
			{ type: "text", text: "(Reply held by P-11 row 1. The corrected reply follows.)" },
			read,
		]);
		expect(s.cited()).toEqual([]);
		expect(await s.call("read", { path: "README.md" })).toBeUndefined();
		expect((await s.call(...closeA))?.reason).toBe(UNRECORDED_QUESTION_REFUSAL);
	});
});

