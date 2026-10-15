// PLAN wl-muzs0ytnaet1v4 (Jo, 2026-10-08: "deny any reserved request that launches a command from
// eval or a subprocess, without asking me, and tell the lane to use bash"). Eval code that starts a
// process is refused outright with "use the bash tool": never a reserved action, so no request reaches
// Jo. The four holds of 2026-10-08 are replayed verbatim from the ledger (HOLDS.md), then every
// spelling of a process start, the `%load` magic, the controls that stay allowed, inline interpreter
// code's unreadable launches (D2), the respelling text (D3) and row 10's precedence (D1 (f)).
// Every probe is inert: the gate only reads the strings; nothing here runs a process.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolCall } from "../src/gates";
import { checkReserved, reservedAction } from "../src/rows/r06-reserved";
import type { CallContext, Refusal } from "../src/types";
import { tmpDir } from "../../ledger/test/tmp";

const dir = tmpDir("gates-r06-eval-process-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "a.py"), 'import subprocess; subprocess.run(["git","status"])\n');
writeFileSync(join(dir, "b.py"), 'c = "kubectl delete deployment app"; print(c)\n');
writeFileSync(join(dir, "c.py"), "print(1)\n");

const ctx: CallContext = { role: "lane", cwd: dir, env: { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: "/not-real/ledger.db" } };
const row6 = (language: "py" | "js", code: string): Refusal => checkReserved({ toolName: "eval", input: { language, code } }, ctx);

/** Refused outright with the bash-tool text, and not a reserved action (no request for Jo). */
function expectBashToolRefusal(r: Refusal): void {
	expect(r?.block).toBe(true);
	expect(r?.reason).toContain("bash tool");
	expect(r?.reason).not.toContain("§ A4 reserved list");
	expect(reservedAction(r)).toBeNull();
}

// The four holds, verbatim from HOLDS.md (the ledger's `entries` bodies).
const HOLD_1 = `const root = '/Users/jowolff/code/agent-system-2.0-lanes/wl-muraerdsgw7gn4'; const script = \`import { expandShell, gitCall } from './gates/src/exec.ts'; import { gitModel } from './gates/src/git-model.ts'; const cmd = 'git switch wl/other && git push origin'; for (const e of expandShell(cmd, process.cwd(), process.env).commands) { const g = gitCall(e); console.log(JSON.stringify({sub:g?.sub,dir:g?.dir,args:g?.args.map(x=>x.text),model:g ? gitModel(g) : null})); }\`; const probe = Bun.spawnSync(['bun','-e',script], {cwd:root}); console.log({command:'bun -e <read-only expandShell/gitCall/gitModel probe>',exitCode:probe.exitCode,stdout:probe.stdout.toString(),stderr:probe.stderr.toString()});`;
const HOLD_2 = `import time, subprocess; time.sleep(100)
print(subprocess.run(["git","status","--short"],cwd="/Users/jowolff/code/agent-system-2.0-lanes/wl-muq1v31q5ly7ls",capture_output=True,text=True).stdout)`;
const HOLD_3 = `import subprocess
r = subprocess.run(["bun", "/tmp/redrun.ts", "/tmp/redbefore", "surface/test/turn-end.test.ts", "surface/test/launch.test.ts", "surface/test/lane.test.ts", "surface/test/lane-tools.test.ts"], capture_output=True, text=True, timeout=300)
print(r.stdout[-6000:], r.stderr[-2000:])`;
const HOLD_4 = `const r = Bun.spawnSync(["bun", "/tmp/red1.ts", "/tmp/redbefore"], { stdout: "pipe", stderr: "pipe" });
return r.stdout.toString() + r.stderr.toString();`;

describe("the four holds of 2026-10-08: refused, not reserved", () => {
	test("en-muzr4xg7eapkw0 (js Bun.spawnSync bun -e probe)", () => expectBashToolRefusal(row6("js", HOLD_1)));
	test("en-muzrj6i64vnj7k (py subprocess.run git status)", () => expectBashToolRefusal(row6("py", HOLD_2)));
	test("en-muzrrgjmnotngg (py subprocess.run bun /tmp/redrun.ts)", () => expectBashToolRefusal(row6("py", HOLD_3)));
	test("en-muzrtqgbcqo4qo (js Bun.spawnSync bun /tmp/red1.ts)", () => expectBashToolRefusal(row6("js", HOLD_4)));
});

/** [language, code] pairs each refused outright, not reserved. */
const REFUSE: [string, "py" | "js", string][] = [
	// A readable reserved command: the bash gate holds it there, with the real command in the request.
	["readable reserved command", "js", "await Bun.$`git push --force origin main`;"],
	// The nested bash tool, in every member spelling and as a reference.
	["nested tool.bash", "js", 'await tool.bash({command: "git push --force origin main"})'],
	["nested tool?.bash", "js", 'await tool?.bash({command: "git push --force origin main"})'],
	['nested tool["bash"]', "js", 'await tool["bash"]({command: "git push --force origin main"})'],
	["nested tool . bash", "js", 'await tool . bash({command: "git push --force origin main"})'],
	['nested tool?.["bash"]', "js", 'await tool?.["bash"]({command: "git push --force origin main"})'],
	["a reference to tool.bash", "js", 'const b = tool.bash; await b({command: "git push --force origin main"})'],
	// Readable harmless commands.
	["Bun.$ git status", "js", "await Bun.$`git status`;"],
	["subprocess.run ls", "py", "subprocess.run(['ls'])"],
	["nested tool.bash git status", "js", 'await tool.bash({command: "git status"})'],
	// Gap spellings.
	["from subprocess import run", "py", "from subprocess import run"],
	["import subprocess as sp", "py", "import subprocess as sp; sp.run(['git','status'])"],
	["an os alias", "py", 'import os as o; o.system("git status")'],
	["from os import system", "py", "from os import system"],
	["multiprocessing alias", "py", "import multiprocessing as mp; mp.Process(target=f).start()"],
	["os.fork", "py", "import os; os.fork()"],
	["posix.system", "py", 'import posix; posix.system("ls")'],
	["importing multiprocessing is a process start (the named trade-off)", "py", "import multiprocessing; print(multiprocessing.cpu_count())"],
	["importing subprocess is a process start (unchanged)", "py", "import subprocess; print(subprocess.PIPE)"],
	["asyncio.create_subprocess_exec", "py", 'import asyncio\nawait asyncio.create_subprocess_exec("git", "status")'],
	['import {spawn} from "bun"', "js", 'import {spawn} from "bun"'],
	["const {spawn} = Bun", "js", "const {spawn} = Bun"],
	['await import("bun")', "js", 'const {spawn} = await import("bun"); spawn(["git","push","--force","origin","main"])'],
	['require("bun")', "js", 'const b = require("bun"); b.spawn(["git","status"])'],
	["!cmd", "py", "!git status"],
	["%pip", "py", "%pip install x"],
	["%bun add", "js", "%bun add x"],
	// codeOnly (round 4): a call inside a template expression, a module named in a string, a live magic after a triple quote.
	["tool.bash inside a template expression", "js", 'const s = `${await tool.bash({command: "git status"})}`'],
	["a module name inside a string (a)", "js", 'require("child_process").execSync("ls")'],
	["a magic after a closing triple quote", "py", "'''note\n#end'''\n%pip install x"],
	// Optional chaining (round 6).
	["Bun?.spawn", "js", 'Bun?.spawn(["kubectl","delete","deployment","app"])'],
	// An import after the `:` of a one-line compound statement (review round 1).
	["import after if:", "py", 'if ready: import subprocess as sp; sp.run(["git", "status"])'],
	["import after else:", "py", 'if ready: pass\nelse: import subprocess as sp; sp.run(["git", "status"])'],
	["import after try:", "py", 'try: import subprocess as sp; sp.run(["git", "status"])\nexcept OSError: pass'],
	["import after with x:", "py", 'with lock: import subprocess as sp; sp.run(["git", "status"])'],
	["import after for a in b:", "py", 'for a in b: import subprocess as sp; sp.run(["git", "status"])'],
	["import after def f():", "py", 'def f(): import subprocess as sp; sp.run(["git", "status"])'],
	["an os alias imported after if:", "py", 'if ready: import os as o; o.system("git status")'],
	["from subprocess import after try:", "py", 'try: from subprocess import run\nexcept ImportError: pass\nrun(["git", "status"])'],
	// Division stays division: `(a) / b` and a member named `if` do not open a regex that would hide the call.
	["a call between two divisions after (a)", "js", 'const n = (4) / subprocess.run(["ls"]) / 2'],
	["a call between two divisions after o.if(a)", "js", 'const n = o.if(4) / subprocess.run(["ls"]) / 2'],
];

describe("eval code that starts a process is refused outright, not reserved", () => {
	for (const [name, language, code] of REFUSE) {
		test(`${name}: ${JSON.stringify(code)}`, () => expectBashToolRefusal(row6(language, code)));
	}
});

/** Eval code that starts no process: row 6 lets it through. */
const ALLOW: [string, "py" | "js", string][] = [
	["%load of a file with no process start", "py", `%load ${join(dir, "c.py")}`],
	["Bun.file().text()", "js", "const t = await Bun.file(p).text()"],
	["open().read()", "py", "t = open(p).read()"],
	["re.exec is not os.exec", "js", "const m = re.exec(s)"],
	["another omp tool", "js", 'await tool.read({path: "x"})'],
	["os.path.join", "py", 'import os; print(os.path.join("a","b"))'],
	["os.cpu_count", "py", "import os; print(os.cpu_count())"],
	["an identifier containing the words", "py", "toolbash = 1; print(toolbash)"],
	["a # comment", "py", "# import subprocess\nprint(1)"],
	["a single-line docstring", "py", '"""import subprocess"""\nprint(1)'],
	["a multi-line docstring", "py", "'''notes\nimport subprocess\n'''\nprint(1)"],
	["a mid-line %", "py", "x = 5 % 2"],
	// Round 3.
	['tool?.["bash"] in a string', "js", "const note = 'tool?.[\"bash\"]'; print(note)"],
	['tool?.["bash"] in a comment', "js", '// tool?.["bash"]\nprint(1)'],
	["a magic inside a triple-quoted string", "py", "'''notes\n%pip install x\n'''; print(1)"],
	// codeOnly (round 4).
	["a comment right after a word character", "js", 'const n = 1// tool?.["bash"]\nprint(n)'],
	["the static text of an interpolated template", "js", 'const name="Ada"; const note=`Example tool?.["bash"] ${name}`; print(note)'],
	["a magic line in a multi-line interpolated template", "js", "const v = 1;\nconst note = `steps ${v}:\n%bun add x\nthen run`;\nprint(note)"],
	["a magic inside a triple-quoted string, alone", "py", "'''x\n%pip install x\n'''"],
	// (a) on codeAndStrings (round 5): a regex literal or a comment naming a spawn API.
	["a regex literal", "js", "const pattern = /subprocess.run/; print(pattern.test(text))"],
	["a js comment", "js", "// subprocess.run is not used here\nprint(1)"],
	["a py comment", "py", "# os.system is not used here\nprint(1)"],
	// A regex literal after a statement head's `)` (review round 1), and division after a plain `(a)`.
	["a regex literal after if (…)", "js", 'const text = "x"; if (true) /subprocess.run/.test(text);'],
	["a regex literal after while (…)", "js", 'const text = "x"; while (false) /subprocess.run/.test(text);'],
	["a regex literal after for (…)", "js", 'const text = "x"; for (const t of [text]) /subprocess.run/.test(t);'],
	["a regex literal after for await (…) (review round 2)", "js", "const values = []; for await (const x of values) /subprocess.run/.test(x);"],
	["division after (a)", "js", "const n = (4) / 2 / 1; print(n)"],
];

describe("eval code that starts no process stays allowed", () => {
	for (const [name, language, code] of ALLOW) {
		test(`${name}: ${JSON.stringify(code)}`, () => expect(row6(language, code)).toBeNull());
	}
});

describe("%load: the loaded file is judged as the cell's code", () => {
	test("a loaded process start is refused, not reserved", () => expectBashToolRefusal(row6("py", `%load ${join(dir, "a.py")}`)));
	test("a loaded reserved text is reserved, like the same text in a cell", () => {
		const r = row6("py", `%load ${join(dir, "b.py")}`);
		expect(r?.reason).toContain("kubectl delete");
		expect(reservedAction(r)).not.toBeNull();
	});
	for (const arg of [join(dir, "missing.py"), "local://x.py"]) {
		test(`a load the gate cannot read is a respelling: ${arg}`, () => {
			const r = row6("py", `%load ${arg}`);
			expect(r?.block).toBe(true);
			expect(r?.reason).toContain("paste the code into the cell");
			expect(r?.reason).not.toContain("§ A4 reserved list");
			expect(reservedAction(r)).toBeNull();
		});
	}
});

describe("the D1-miss rule: no process start means no process pass", () => {
	test("a spawn API only in a comment and a reserved phrase in a literal: the quote-blind pass alone", () => {
		const r = row6("js", '// Bun.spawn\nconst c = "kubectl delete deployment app"');
		expect(r?.reason).toBe(row6("js", 'const c = "kubectl delete deployment app"')!.reason);
		expect(r?.reason).toContain("kubectl delete");
		expect(r?.reason).not.toContain("cannot read");
		expect(reservedAction(r)).not.toBeNull();
	});
});

describe("D2 and D3: inline interpreter code and respellings", () => {
	const bash = (command: string): Refusal => checkReserved({ toolName: "bash", input: { command } }, ctx);
	test("an unreadable launch in inline code is a respelling", () => {
		const r = bash("bun -e 'await Bun.$`${x}`'");
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("inline interpreter code");
		expect(reservedAction(r)).toBeNull();
	});
	test("control: a readable reserved command in inline code stays reserved", () => {
		expect(reservedAction(bash("bun -e 'await Bun.$`git push --force origin main`'"))).not.toBeNull();
	});
	test("the bash blind refusal no longer says it is on the reserved list", () => {
		const r = bash("cat 'notes");
		expect(r?.block).toBe(true);
		expect(r?.reason).not.toContain("§ A4 reserved list");
		expect(r?.reason).toContain("It is not a reserved action and nothing is raised to Jo");
		expect(reservedAction(r)).toBeNull();
	});
});

describe("row 10 precedence (D1 (f))", () => {
	test("row 10's eval refusal carries the bash-tool sentence when the eval starts a process", () => {
		const r = checkToolCall({ toolName: "eval", input: { language: "js", code: "await Bun.$`NODE_REDIRECT_WARNINGS=/not-real/ledger.db node -e 0`;" } }, ctx);
		expect(r?.reason).toContain("P-11 row 10");
		expect(r?.reason).toContain("bash tool");
	});
});
