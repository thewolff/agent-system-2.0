// Every probe from the fourth astra review of M4 (review-astra-4/REVIEW.md and PROBES.md) and every
// M4 probe string from triad 1 (triad-1/REPORT.md, legs B and C), as regression tests with the
// verdict M4 fix round 4 requires (fix-4/BRIEF.md items B1-B5, S1-S7). Every bash and eval probe is
// inert: the gate only reads the strings; targets sit under /not-real/not-executed or /not-real, which
// nothing creates. Push and symlink fixtures run real git inside test-owned temp dirs.
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitDir } from "../src/exec";
import { checkToolCall } from "../src/gates";
import { checkBriefFields } from "../src/rows/r05-brief-fields";
import { checkTurnShape } from "../src/rows/r01-turn-shape";
import { checkPushRebase } from "../src/rows/r08-push-rebase";
import { checkRawLedgerWrite } from "../src/rows/r10-raw-ledger";
import { parseShell, shellQuote } from "../src/shell-parse";
import type { CallContext, Refusal } from "../src/types";
import { advanceOriginMain, brief, commit, git, repoWithOrigin, testRecord, tmp } from "./helpers";

const probeRoot = tmp("probe4-cwd");
mkdirSync(join(probeRoot, "work", "gates"), { recursive: true });
const ctx: CallContext = { role: "lane", cwd: join(probeRoot, "work"), env: { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: "/not-real/ledger.db" } };
const call = (toolName: string, input: Record<string, unknown>) => ({ toolName, input });
const verdict = (r: Refusal): "ALLOW" | "BLOCK" => (r === null ? "ALLOW" : "BLOCK");
const bash = (command: string) => verdict(checkToolCall(call("bash", { command }), ctx));
const evalCode = (language: "py" | "js", code: string) => verdict(checkRawLedgerWrite(call("eval", { language, code }), ctx));
const RM = "r" + "m";

describe("B1: `alias.*` is not a modeled -c key, and a non-builtin subcommand is refused (row 6)", () => {
	const refused = [
		// astra R4-B1, direct and transitive
		`git -c alias.outer="!git inner" -c alias.inner="reset --hard" outer`,
		`git -c alias.outer="!git reset --hard" outer`,
		`git -c alias.outer="!git inner" -c alias.inner="!printf inherited-alias" outer`,
		"git -c alias.lg='log --oneline' lg -5",
		// a subcommand git does not ship may be a configured alias or a git-X program
		"git st",
		"git lfs ls-files",
	];
	for (const command of refused) test(`BLOCK: ${command}`, () => expect(bash(command)).toBe("BLOCK"));
	const allowed = [
		"git status",
		"git -c user.name=x status",
		"git -c color.ui=false status",
		"git -c advice.detachedHead=false status",
		"git -c core.quotepath=false status",
		"git -c init.defaultbranch=main status",
		"git -c commit.gpgsign=false status",
		"git -c tag.gpgsign=false status",
		"git -c gc.auto=0 status",
	];
	for (const command of allowed) test(`ALLOW: ${command}`, () => expect(bash(command)).toBe("ALLOW"));
	test("the refusal names the allowed spelling, alias excluded", () => {
		const r = checkToolCall(call("bash", { command: "git -c alias.x x" }), ctx);
		expect(r?.reason).toContain("never `alias.*`");
		expect(r?.reason).toContain("one of git's own subcommands");
		// With a value, the text spells `alias` beside `=`: row 6's alias-definition check (MIGRATION.md
		// item 81, PLAN wl-mv0n5r9cbafe9s § 2 D t2) runs before the git model and refuses it first.
		expect(checkToolCall(call("bash", { command: "git -c alias.x='status' x" }), ctx)?.reason).toContain("an alias definition");
	});
});

describe("astra R4 matrix: the rest of the shell probes (rows 6 and 10)", () => {
	const refused = [
		"$'\\x67it' reset --hard",
		`"gi"t reset --hard`,
		"g\\it reset --hard",
		"${X:-git} reset --hard",
		"git -C ~ status",
		"git reset --hard > /not-real/not-executed",
		"(git reset --hard)",
		"f(){ git reset --hard; }; f",
		"true && git reset --hard",
	];
	for (const command of refused) test(`BLOCK: ${command}`, () => expect(bash(command)).toBe("BLOCK"));
	// `git reset -- --hard` unstages a path named `--hard`; after `--` it is not the option (live, fix-5:
	// the work-tree change survived). The positive git model reads it as a path (M4 fix round 5).
	for (const command of ["git -C /var -C .. status", "git -C . -C gates -C .. status", "git reset -- --hard"]) test(`ALLOW: ${command}`, () => expect(bash(command)).toBe("ALLOW"));
});

describe("B2: only `r`, `rb`, `rt` string modes prove a read-only open (row 10)", () => {
	const fsOpen = (mode: string) => `const fs=await import("node:fs/promises"); await fs.open("/not-real/ledger.db",${JSON.stringify(mode)})`;
	for (const mode of ["as", "as+", "rs+", "w", "a", "r+", "wx"]) test(`BLOCK: fs.open mode ${mode}`, () => expect(evalCode("js", fsOpen(mode))).toBe("BLOCK"));
	for (const mode of ["r", "rb"]) test(`ALLOW: fs.open mode ${mode}`, () => expect(evalCode("js", fsOpen(mode))).toBe("ALLOW"));
	test("BLOCK: numeric flags are over-approximated as writable, 0 included", () => {
		expect(evalCode("js", 'const fs=require("fs"); fs.openSync("/not-real/ledger.db", 0)')).toBe("BLOCK");
		expect(evalCode("py", 'import os; os.open("/not-real/ledger.db",os.O_RDONLY | 1)')).toBe("BLOCK");
	});
	test("BLOCK: a mode computed at run time", () => expect(evalCode("py", 'open("/not-real/ledger.db", getmode())')).toBe("BLOCK"));
	test("ALLOW: Python open with rb", () => {
		expect(evalCode("py", 'open("/not-real/ledger.db","rb").read()')).toBe("ALLOW");
		expect(evalCode("py", 'open("/not-real/ledger.db", "rb")')).toBe("ALLOW");
	});
	// An open reached under another name: the gate cannot see which call is the open.
	const aliased = [
		'import os; f=os.open; fd=f("/not-real/ledger.db", 1); os.write(fd, b"x")',
		'const fs=require("fs"); const o=fs.openSync; o("/not-real/ledger.db","w")',
		'const fs=require("fs"); fs["open"]("/not-real/ledger.db","w",()=>{})',
		'import os; fd=getattr(os,"open")("/not-real/ledger.db", 1); os.write(fd,b"x")',
		'import io; io.FileIO("/not-real/ledger.db", "w").write(b"x")',
		'import os; os.truncate("/not-real/ledger.db", 0)',
		'const fs=require("fs"); const {openSync: o}=fs; o("/not-real/ledger.db","w")',
	];
	for (const code of aliased) test(`BLOCK: ${code}`, () => expect(evalCode(code.startsWith("const") ? "js" : "py", code)).toBe("BLOCK"));
});

describe("B3: a named constant is proof only when nothing can rebind it (row 10)", () => {
	test("BLOCK: astra's rebinding probe", () => expect(evalCode("py", 'import os; os.O_RDONLY=1; os.open("/not-real/ledger.db",os.O_RDONLY)')).toBe("BLOCK"));
	for (const code of [
		'import os; os.open = print; os.open("/not-real/ledger.db", os.O_RDONLY)',
		'import os as o; o.O_RDONLY=1; o.open("/not-real/ledger.db", o.O_RDONLY)',
		'import os; setattr(os, "O_RDONLY", 1); os.open("/not-real/ledger.db", os.O_RDONLY)',
		'from os import O_WRONLY as O_RDONLY; import os; os.open("/not-real/ledger.db", O_RDONLY)',
	]) {
		test(`BLOCK: ${code}`, () => expect(evalCode("py", code)).toBe("BLOCK"));
	}
	test("ALLOW: import os; os.open(p, os.O_RDONLY)", () => expect(evalCode("py", 'import os; os.open("/not-real/ledger.db", os.O_RDONLY)')).toBe("ALLOW"));
});

describe("B4: `sqlite3 -readonly <ledger>` is one modeled inspection (row 10)", () => {
	const db = "/not-real/ledger.db";
	const refused = [
		// astra R4-B4: `.open` replaces the read-only connection with a read-write one
		`sqlite3 -readonly ${db} ".open ${db}" "DELETE FROM entries"`,
		`sqlite3 -readonly ${db} ".shell ${RM} -rf /not-real/not-executed"`,
		`sqlite3 -readonly ${db} ".system true"`,
		`sqlite3 -readonly ${db} ".read /not-real/not-executed"`,
		`sqlite3 -readonly ${db} ".import /not-real/not-executed t"`,
		`sqlite3 -readonly ${db} ".restore /not-real/not-executed"`,
		`sqlite3 -readonly ${db} ".load /not-real/not-executed"`,
		`sqlite3 -readonly ${db} "PRAGMA query_only=OFF; DELETE FROM entries"`,
		`sqlite3 -readonly ${db} "PRAGMA journal_mode=DELETE"`,
		// -readonly does not stop writefile() (live-tested in fix round 4)
		`sqlite3 -readonly ${db} "SELECT writefile('/not-real/not-executed','x')"`,
		`sqlite3 -readonly ${db} -cmd ".open ${db}" "SELECT 1"`,
		`sqlite3 -readonly ${db}`,
		`sqlite3 -readonly ${db} < /not-real/not-executed`,
		`sqlite3 -readonly "file:${db}?mode=rw"`,
		`sqlite3 ${db} .tables`,
	];
	for (const command of refused) test(`BLOCK: ${command}`, () => expect(bash(command)).toBe("BLOCK"));
	const allowed = [
		`sqlite3 -readonly ${db} .tables`,
		`sqlite3 -readonly ${db} ".schema entries"`,
		`sqlite3 -readonly ${db} "SELECT count(*) FROM entries"`,
		`sqlite3 -readonly ${db} "PRAGMA user_version"`,
		`sqlite3 -readonly ${db} "PRAGMA table_info(entries)"`,
	];
	for (const command of allowed) test(`ALLOW: ${command}`, () => expect(bash(command)).toBe("ALLOW"));
	test("initial versus replacement connection: the same DELETE is refused with or without `.open` before it", () => {
		expect(bash(`sqlite3 -readonly ${db} "DELETE FROM entries"`)).toBe("BLOCK");
		expect(bash(`sqlite3 -readonly ${db} ".open ${db}" "SELECT 1"`)).toBe("BLOCK");
	});
});

describe("B5: no in-process database handle to the ledger, readonly included (row 10)", () => {
	for (const opts of ["{readonly:true}", "{readonly:false}"]) {
		test(`BLOCK: new Database(ledger, ${opts})`, () => expect(evalCode("js", `import {Database} from "bun:sqlite"; new Database("/not-real/ledger.db", ${opts})`)).toBe("BLOCK"));
	}
	test("the refusal names both read paths and no readonly exception", () => {
		const r = checkRawLedgerWrite(call("eval", { language: "js", code: 'import {Database} from "bun:sqlite"; new Database("/not-real/ledger.db", {readonly:true})' }), ctx);
		expect(r?.reason).toContain("sqlite3 -readonly");
		expect(r?.reason).toContain("ledger module");
		expect(r?.reason).toContain("`readonly: true` included");
	});
});

describe("S1: one effective-directory resolver, realpath per hop", () => {
	test("git -C /var -C .. resolves like live git (the physical parent of /var)", () => {
		expect(gitDir("/", ["/var", ".."])).toBe(dirname(realpathSync("/var")));
	});
	test("symlink + .. resolves to the directory live `git rev-parse --show-toplevel` reports", () => {
		const t = realpathSync(tmp("s1-link"));
		mkdirSync(join(t, "a", "b", "sub"), { recursive: true });
		git(join(t, "a", "b"), "init", "-q");
		symlinkSync(join(t, "a", "b", "sub"), join(t, "link"));
		const live = git(t, "-C", "link", "-C", "..", "rev-parse", "--show-toplevel").trim();
		expect(gitDir(t, ["link", ".."])).toBe(live);
		expect(live).toBe(join(t, "a", "b"));
	});
	test("a push through symlink + .. is judged in the repository git actually pushes from", () => {
		const r = repoWithOrigin();
		git(r.work, "switch", "-q", "-c", "feature");
		commit(r.work, "f.txt", "f\n");
		advanceOriginMain(r.root, r.origin);
		git(r.work, "fetch", "-q", "origin");
		git(r.work, "rebase", "-q", "origin/main");
		mkdirSync(join(r.work, "sub"));
		const link = join(tmp("s1-evidence"), "link");
		symlinkSync(join(r.work, "sub"), link);
		const command = `git -C ${shellQuote(link)} -C .. push origin feature`;
		expect(verdict(checkPushRebase(call("bash", { command }), ctx, () => [testRecord(r.work)]))).toBe("ALLOW");
	});
	test("`-C \"\"` leaves the directory unchanged; a hop that does not exist resolves to nothing", () => {
		expect(gitDir(ctx.cwd, [""])).toBe(realpathSync(ctx.cwd));
		expect(gitDir(ctx.cwd, ["/not-real/not-executed"])).toBeNull();
		expect(bash("git -C /not-real/not-executed status")).toBe("BLOCK");
	});
});

describe("S3: row 1 reads structural blocks after one quote/code normalization", () => {
	// The accepted/refused example table (triad 1, leg C). A "decision" is one choice; `and`, a
	// comma, `;`, `:` and `also` join two.
	const table: [string, "ALLOW" | "BLOCK", string][] = [
		["**Closing ask**\nChoose main or feature and deploy today or tomorrow?", "BLOCK", "two choices joined by and"],
		["**Closing ask**\nChoose main or feature, deploy today or tomorrow?", "BLOCK", "two choices joined by a comma"],
		["**Closing ask**\nChoose main or feature; also deploy today or tomorrow?", "BLOCK", "two choices joined by ; also"],
		["**Closing ask**\nThe quoted message was “Ready?”\nKeep or revert?", "ALLOW", "a quoted question mark is not an ask"],
		["**CLAIM**\nThe token is `**Closing ask**`.\n\n**Closing ask**\nKeep or revert?", "ALLOW", "an inline-code label is not a block"],
		["**CLAIM**\nThey wrote “She asked ‘Ready?’ yesterday.”\n\n**Closing ask**\nKeep or revert?", "ALLOW", "nested curly quotes are stripped"],
		["**Closing ask**\nKeep or revert?", "ALLOW", "one choice, last"],
		["**Closing ask**\nShip now or wait?\n\n**Closing ask**\nDeploy or hold?", "BLOCK", "two closing asks"],
		["**CLAIM**\nThe gate is built.\n\nShip now or wait?", "BLOCK", "a decision outside the closing ask"],
		["**CLAIM**\nThe label `**Closing ask**` stays inline.\n\nWant me to proceed?", "ALLOW", "a check-in with an inline-code label"],
	];
	for (const [text, want, why] of table) test(`${want} (${why}): ${JSON.stringify(text)}`, () => expect(verdict(checkTurnShape(text))).toBe(want));
});

describe("S4: git arguments follow command names on `expanded` (row 6)", () => {
	for (const command of ["git checkout $'master'", "git log $'main'", "git log {main,x}"]) test(`BLOCK: ${command}`, () => expect(bash(command)).toBe("BLOCK"));
	test("ALLOW: git log main", () => expect(bash("git log main")).toBe("ALLOW"));
});

describe("S6: row 5 cross-checks `workload:` against the session's bound workload", () => {
	const item = (workload: string) => ({ tasks: [{ agent: "fast", name: "slice-a", task: brief({ workload }) }] });
	test("BLOCK: a brief naming another workload in a bound session", () => {
		const r = checkBriefFields(item("wl-other"), "wl-test1");
		expect(r?.reason).toContain(`"workload: wl-other" is not this session's workload wl-test1`);
	});
	test("ALLOW: the bound workload, and any well-formed workload when unbound", () => {
		expect(checkBriefFields(item("wl-test1"), "wl-test1")).toBeNull();
		expect(checkBriefFields(item("wl-other"), null)).toBeNull();
	});
	test("the Shape text names the slice-id rule for `name`", () => {
		const r = checkBriefFields({ tasks: [{ agent: "fast", task: "just do it" }] }, "wl-test1");
		expect(r?.reason).toContain("the item's `name` is the slice id: [A-Za-z0-9_-]{1,48}, an existing slice of the workload");
		expect(r?.reason).toContain("workload: wl-test1 (this session's workload)");
	});
});

describe("S7: parser reads no extended glob", () => {
	test("an extglob pattern on a line after `shopt -s extglob` is unreadable", () => {
		const p = parseShell("shopt -s extglob\nls @(a|b)", { cwd: "/tmp", env: {} });
		expect(p.failures).toContain("extended glob pattern @( … )");
	});
	test("a function definition and a subshell stay readable", () => {
		expect(parseShell("f() { echo hi; }; (echo x)", { cwd: "/tmp", env: {} }).failures).toEqual([]);
	});
});
