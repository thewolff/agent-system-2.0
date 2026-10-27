// The Jo-only boundary, accident grade, layer 2 (PLAN wl-mv654hoqwpfhmo § 6.3 item 2).
//
// Interface these tests fix for the boundary (sl-auth-boundary): `checkToolCall` (gates/src/gates.ts) refuses, with a
// reason containing "Jo-only boundary", eval code (gates/src/eval-code.ts) and bash commands (gates/src/rows/
// r10-raw-ledger.ts, which owns "the ledger is written only through the module") that
// - import the ledger module (`ledger/src`), statically, dynamically or by require;
// - name the ledger file `ledger.db` in an open or a write;
// - construct a bun:sqlite `Database` on any path under `~/.agent-system-2/` (HOME's and the passwd home's);
// - set, unset or override AGENT_SYSTEM_ROLE, AGENT_SYSTEM_LANE_ID, AGENT_SYSTEM_WORKLOAD_ID, AGENT_SYSTEM_LEDGER_DB
//   or any AS2_TEST_* name: `env -u`, `env -i`, a prefix assignment, `export`, `unset`, the bash tool's own `env`
//   input, and in eval `process.env.X = …`, `delete process.env.X`, `os.environ[…] = …`, `os.environ.pop(…)`.
// The refusal holds for every role: a lane, a hand, and the orchestrator agent (§ 6.1: layer 1 does not cover the
// orchestrator's process, so layers 2 and 3 are its boundary). Reading stays allowed: `sqlite3 -readonly <ledger>`
// with SELECT, `echo $AGENT_SYSTEM_ROLE`, eval reading process.env, and `bun test` of this repository's test files from
// a directory whose bunfig.toml isolates the ledger.
// Every probe is inert: the gate only reads the strings and the script files this test writes into its own temp
// directory; nothing here runs, and every path sits under a home this test makes up.
//
// G1 (scratch auth-forgery AUDIT.md § (e)): a script bun or node runs (`bun f.ts`, `bun run f.ts`, `node f.js`, a
// heredoc that writes the script in the same call) is read and judged like eval code; a computed `import()` or
// `require()` is refused in eval, inline code and scripts outside every git repository; this repository's own
// scripts are not read. G1 review round 1 (sl-auth-forgery-review): a script word with a `$NAME`,
// `${NAME}` or `~` is resolved and read, and one the gate cannot resolve is refused; bun's and node's options before
// the script are skipped and a preloaded module is read; `bun exec`, `bun x`, `bunx` and `npx` running tsx, ts-node,
// node or bun on a file are read; python, perl, ruby and deno scripts are read; every script directory of a checkout
// (skills/*/…/scripts/ included) runs unread. G1 review round 2 (sl-auth-forgery-review-r3): `bun test` files and
// preloads outside an isolated checkout run are read; eval reads a file it loads by a literal path; a package.json
// script, a bunfig.toml preload and `python3 -m <name>` are read; bunx/npx read a file argument of any package; a
// checkout's tracked files run unread. G1 review round 3 (sl-auth-forgery-review-r4, finding 4): test isolation is
// recognised apart from the git-tracked trust exemption, so a `git archive` copy's tests (no `.git`) run unread from
// its isolating bunfig, as does a CLI `--preload` of a tree's isolate-preload.ts running that tree's test files.
// The probe strings below load modules on purpose: they are the module-loading boundary under test.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "../src/gates";
import type { CallContext, Refusal, Role } from "../src/types";
import { tmp } from "./helpers";

const REPO = join(import.meta.dir, "..", "..");

const HOME = "/nonexistent-home";
const LIVE = `${HOME}/.agent-system-2/ledger.db`;
const cwd = tmp("authority-gate");
/** A forgery script: loads the ledger module and writes machinery stamps (the audit's probe-a shape). */
const FORGE = `import { Ledger } from "${REPO}/ledger/src/index.ts";\nconst l = Ledger.open();\nl.recordEntry({ by: "escalation", workloadId: "wl-x", kind: "assumption", body: "plan: approved auto g1" });\nl.enqueue({ by: "escalation", workloadId: "wl-x", sender: "escalation", recipient: "orchestrator", body: "notice: plan started" });\n`;
/** Module acquisition with a specifier built at run time. */
const COMPUTED = `const p = ["${REPO}", "ledger", "src", "index"].join("/");\nconst { Ledger } = await import(p);\nLedger.open();\n`;
writeFileSync(join(cwd, "forge.ts"), FORGE);
writeFileSync(join(cwd, "forge.js"), FORGE);
writeFileSync(join(cwd, "computed.ts"), COMPUTED);
writeFileSync(join(cwd, "db.ts"), `import { Database } from "bun:sqlite";\nnew Database("${LIVE}").run("DELETE FROM entries");\n`);
writeFileSync(join(cwd, "root.ts"), `import { Database } from "bun:sqlite";\nnew Database(process.env.HOME + "/.agent-system-2/copy.db");\n`);
writeFileSync(join(cwd, "benign.ts"), `import { join } from "node:path";\nconst { x } = await import("./other.ts").catch(() => ({ x: 1 }));\nconsole.log(join("a", "b"), x);\n`);
/** A Python script opening the live ledger raw and writing a surface-stamped Jo row (the review's probe; no layer 1 on such a connection). */
const PYFORGE = `import sqlite3\nc = sqlite3.connect("${LIVE}")\nc.execute("INSERT INTO instructions (id, workload_id, kind, channel, author, body, created_by, created_at) VALUES ('in-x','wl-x','instruction','surface','jo','ceiling: 500 12','orchestrator-surface','2026-10-19T00:00:00.000Z')")\nc.commit()\n`;
writeFileSync(join(cwd, "forge.py"), PYFORGE);
writeFileSync(join(cwd, "forge.pl"), `open(my $fh, ">>", "${LIVE}") or die;\nprint $fh "x";\n`);
writeFileSync(join(cwd, "forge.rb"), `File.open("${LIVE}", "a") { |f| f.write("x") }\n`);
writeFileSync(join(cwd, "hello.py"), `import json\nprint(json.dumps({"a": 1}))\n`);
/** Text that mentions `require(` inside a template literal: not a module load. */
writeFileSync(join(cwd, "tmpl.ts"), "const name = `x`;\nconsole.log(`run require(${name})`);\n");
/** Another product's build script in a git repository: a runtime-selected import() and no ledger name. */
mkdirSync(join(cwd, "product", ".git"), { recursive: true });
writeFileSync(join(cwd, "product", "build.ts"), "const p = process.argv[2] ?? \"./plugin.ts\";\nconst m = await import(p);\nconsole.log(m);\n");
// G1 review round 2 fixtures.
const RAW_TS = `import { Database } from "bun:sqlite";\nnew Database(process.env.HOME + "/.agent-system-2/ledger.db").run("DELETE FROM entries");\n`;
writeFileSync(join(cwd, "forge.test.ts"), FORGE);
writeFileSync(join(cwd, "raw.test.ts"), RAW_TS);
writeFileSync(join(cwd, "rawabs.test.ts"), `import { Database } from "bun:sqlite";\nnew Database("${LIVE}").run("DELETE FROM entries");\n`);
writeFileSync(join(cwd, "benign.test.ts"), `import { test } from "bun:test";\ntest("x", () => {});\n`);
writeFileSync(join(cwd, "pyrun.py"), "import runpy, sys\nrunpy.run_path(sys.argv[1])\n");
mkdirSync(join(cwd, "pymod"));
writeFileSync(join(cwd, "pymod", "__main__.py"), PYFORGE);
/** package.json scripts that run the forgery under another name, and one with a pre-script. */
mkdirSync(join(cwd, "pkg", "sub"), { recursive: true });
writeFileSync(join(cwd, "pkg", "package.json"), JSON.stringify({ name: "pkg", scripts: { go: "bun ../forge.ts", start: "bun ../forge.ts", test: "bun ../forge.ts", hush: "echo hi", prehush: "bun ../forge.ts", tool: "bun" } }));
/** Both a script `hello` and a benign `hello.ts`: bun runs the script (minor 6). */
mkdirSync(join(cwd, "both"));
writeFileSync(join(cwd, "both", "package.json"), JSON.stringify({ name: "both", scripts: { hello: "bun ../forge.ts" } }));
writeFileSync(join(cwd, "both", "hello.ts"), `console.log("hi");\n`);
mkdirSync(join(cwd, "pkgok"));
writeFileSync(join(cwd, "pkgok", "package.json"), JSON.stringify({ name: "pkgok", scripts: { hi: "echo hi", start: "bun ../benign.ts", build: "tsc -p ." } }));
/** A bunfig.toml whose runtime preload is the forgery, and one whose test preload is. */
mkdirSync(join(cwd, "cfg"));
writeFileSync(join(cwd, "cfg", "bunfig.toml"), `preload = ["./forge.ts"]\n`);
writeFileSync(join(cwd, "cfg", "forge.ts"), FORGE);
writeFileSync(join(cwd, "cfg", "benign.ts"), `console.log("hi");\n`);
mkdirSync(join(cwd, "tcfg"));
writeFileSync(join(cwd, "tcfg", "bunfig.toml"), `[test]\npreload = ["../forge.ts"]\n`);
mkdirSync(join(cwd, "dn"));
writeFileSync(join(cwd, "dn", "deno.json"), JSON.stringify({ tasks: { forge: "deno run -A ../forge.ts" } }));
/**
 * Round 3, finding 4: a `git archive` copy of this repository (the isolating bunfig files, no `.git`), and one whose
 * isolate-preload.ts is the forgery. Built under $AS2_SCRATCH (the system temp dir when it is unset) and removed after
 * the run; nothing in them runs.
 */
const R3_ROOT = mkdtempSync(join(process.env.AS2_SCRATCH ?? tmpdir(), "narrow-"));
afterAll(() => rmSync(R3_ROOT, { recursive: true, force: true }));
const ARCHIVE = join(R3_ROOT, "archive");
const FORGED = join(R3_ROOT, "forged");
for (const tree of [ARCHIVE, FORGED]) {
	for (const p of ["bunfig.toml", "ledger/schema.sql", "ledger/src", "ledger/test/bunfig.toml", "ledger/test/isolate-preload.ts", "ledger/test/authority.test.ts"]) {
		cpSync(join(REPO, p), join(tree, p), { recursive: true });
	}
}
writeFileSync(join(FORGED, "ledger", "test", "isolate-preload.ts"), FORGE);
/** Round 4, the major: the same tree as a git checkout (its six files tracked) holding an UNTRACKED test file that forges. */
const GIT_TREE = join(R3_ROOT, "checkout");
cpSync(ARCHIVE, GIT_TREE, { recursive: true });
for (const args of [["init", "-q"], ["add", "."]]) spawnSync("git", ["-C", GIT_TREE, ...args]);
writeFileSync(join(GIT_TREE, "forge.test.ts"), FORGE);
writeFileSync(join(GIT_TREE, "ledger", "test", "forge.test.ts"), FORGE);
const ctxFor = (role: Role): CallContext => ({ role, cwd, env: { HOME, AS2_SCRATCH: cwd, AGENT_SYSTEM_LANE_ID: role === "orchestrator" ? undefined : "lane-x", AGENT_SYSTEM_WORKLOAD_ID: role === "orchestrator" ? undefined : "wl-x" } });
const ROLES: Role[] = ["lane", "hand", "orchestrator"];
const BOUNDARY = "Jo-only boundary";

type Probe = { tool: "bash"; command: string; env?: Record<string, string> } | { tool: "eval"; language: "js" | "py"; code: string };
const call = (p: Probe, role: Role): Refusal =>
	checkToolCall(
		p.tool === "bash" ? { toolName: "bash", input: p.env ? { command: p.command, env: p.env } : { command: p.command } } : { toolName: "eval", input: { language: p.language, code: p.code } },
		ctxFor(role),
	);
const label = (p: Probe) => (p.tool === "bash" ? `bash ${p.command}${p.env ? ` env=${JSON.stringify(p.env)}` : ""}` : `eval ${p.language} ${p.code}`);

const IMPORTS: Probe[] = [
	{ tool: "eval", language: "js", code: `import { Ledger } from "${cwd}/ledger/src/index";\nconst l = Ledger.open("${LIVE}");` },
	{ tool: "eval", language: "js", code: `import { Ledger } from "../ledger/src/index.ts";` },
	{ tool: "eval", language: "js", code: `const { Ledger } = await import("./ledger/src/index.ts");` },
	{ tool: "eval", language: "js", code: `const m = require("./ledger/src/index");` },
	{ tool: "eval", language: "js", code: `import { liveRoots } from "./ledger/src/locality";` },
	{ tool: "bash", command: `bun -e 'import { Ledger } from "./ledger/src/index"; console.log(Ledger)'` },
	{ tool: "bash", command: `bun --eval "const { Ledger } = await import('./ledger/src/index.ts')"` },
];

const LEDGER_FILE: Probe[] = [
	{ tool: "eval", language: "js", code: `import { Database } from "bun:sqlite";\nconst db = new Database("ledger.db");` },
	{ tool: "eval", language: "js", code: `import { Database } from "bun:sqlite";\nconst db = new Database("${LIVE}");\ndb.run("UPDATE workloads SET stakes = 'throwaway'");` },
	{ tool: "eval", language: "py", code: `import sqlite3\nsqlite3.connect("ledger.db").execute("DELETE FROM entries")` },
	{ tool: "bash", command: `sqlite3 ${LIVE} "INSERT INTO entries (id, workload_id, kind, body, created_by, created_at) VALUES ('en-x', 'wl-x', 'assumption', 'plan: approved in-x', 'orchestrator-surface', '2026-10-19')"` },
	{ tool: "bash", command: `sqlite3 ledger.db "UPDATE questions SET status = 'answered'"` },
	{ tool: "bash", command: `bun -e 'import { Database } from "bun:sqlite"; new Database("ledger.db").run("DELETE FROM entries")'` },
];

const UNDER_ROOT: Probe[] = [
	{ tool: "eval", language: "js", code: `import { Database } from "bun:sqlite";\nconst db = new Database("${HOME}/.agent-system-2/scratch.db");` },
	{ tool: "eval", language: "js", code: `import { Database } from "bun:sqlite";\nconst db = new Database(process.env.HOME + "/.agent-system-2/copy.sqlite");` },
	{ tool: "eval", language: "js", code: `import { Database } from "bun:sqlite";\nimport { homedir } from "node:os";\nconst db = new Database(\`\${homedir()}/.agent-system-2/backups/2026-10-19.db\`);` },
	{ tool: "bash", command: `bun -e 'import { Database } from "bun:sqlite"; new Database("${HOME}/.agent-system-2/backup.db")'` },
];

const NAMES = ["AGENT_SYSTEM_ROLE", "AGENT_SYSTEM_LANE_ID", "AGENT_SYSTEM_WORKLOAD_ID", "AGENT_SYSTEM_LEDGER_DB", "AS2_TEST_ISOLATED", "AS2_TEST_LIVE_ROOTS", "AS2_TEST_REAL_HOME"];
const ENV_OVERRIDES: Probe[] = [
	...NAMES.flatMap((n): Probe[] => [
		{ tool: "bash", command: `${n}=orchestrator bun test ledger/test/authority.test.ts` },
		{ tool: "bash", command: `env -u ${n} bun test ledger/test/authority.test.ts` },
		{ tool: "bash", command: `export ${n}=x && bun test ledger/test/authority.test.ts` },
		{ tool: "bash", command: `unset ${n}; bun test ledger/test/authority.test.ts` },
		{ tool: "bash", command: "bun test ledger/test/authority.test.ts", env: { [n]: "x" } },
		{ tool: "eval", language: "js", code: `process.env.${n} = "x";` },
		{ tool: "eval", language: "js", code: `delete process.env.${n};` },
		{ tool: "eval", language: "py", code: `import os\nos.environ["${n}"] = "x"` },
		{ tool: "eval", language: "py", code: `import os\nos.environ.pop("${n}", None)` },
	]),
	{ tool: "bash", command: "env -i PATH=/usr/bin:/bin bun test ledger/test/authority.test.ts" },
	{ tool: "bash", command: "env -i bun -e 'console.log(1)'" },
	{ tool: "bash", command: "AS2_TEST_ANYTHING=1 bun test gates/test/authority-gate.test.ts" },
];

/** Scripts bun or node runs from a scratch directory that load the ledger module or open a ledger (G1). */
const SCRIPTS: Probe[] = [
	{ tool: "bash", command: `bun ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun run ${cwd}/forge.ts` },
	{ tool: "bash", command: `node ${cwd}/forge.js` },
	{ tool: "bash", command: `cd ${cwd} && bun forge` },
	{ tool: "bash", command: `bun ${cwd}/db.ts` },
	{ tool: "bash", command: `bun ${cwd}/root.ts` },
	{ tool: "bash", command: `bun ${cwd}/computed.ts` },
	{ tool: "bash", command: `cat > ${cwd}/forge-here.ts <<'EOF'\n${FORGE}EOF\nbun ${cwd}/forge-here.ts` },
	{ tool: "bash", command: `cat > ${cwd}/benign.ts <<'EOF'\n${FORGE}EOF\nbun run ${cwd}/benign.ts` },
	{ tool: "bash", command: `bun - <<'EOF'\n${FORGE}EOF` },
	{ tool: "bash", command: `cp ${cwd}/forge.ts ${cwd}/copied.ts && bun ${cwd}/copied.ts` },
];

/** Module acquisition the gate cannot name, in eval and inline code (G1). */
const COMPUTED_IMPORTS: Probe[] = [
	{ tool: "eval", language: "js", code: COMPUTED },
	{ tool: "eval", language: "js", code: `const r = require; const m = r("${REPO}/" + "ledger/" + "src/index");\nm.Ledger.open();` },
	{ tool: "eval", language: "js", code: `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nconst name = ["..", "ledger", "src", "index"].join("/");\nreq(name);` },
	{ tool: "eval", language: "js", code: "const spec = `${process.cwd()}/ledger/src/index.ts`;\nawait import(spec);" },
	{ tool: "bash", command: `bun -e 'const m = await import(["${REPO}","ledger","src","index"].join("/")); m.Ledger.open()'` },
	{ tool: "bash", command: `node -e 'const p = process.argv[1]; require(p)' ${REPO}/ledger/src/index.ts` },
	{ tool: "bash", command: `bun - <<'EOF'\n${COMPUTED}EOF` },
];

/** Review round 1, finding 2: a script word that carries an expansion is resolved and read, or refused when it cannot be resolved. */
const SCRIPT_SPELLINGS: Probe[] = [
	{ tool: "bash", command: `bun "$AS2_SCRATCH/forge.ts"` },
	{ tool: "bash", command: "bun $AS2_SCRATCH/forge.ts" },
	{ tool: "bash", command: `bun "$AS2_SCRATCH"/forge.ts` },
	{ tool: "bash", command: "bun ${AS2_SCRATCH}/forge.ts" },
	{ tool: "bash", command: `node "$AS2_SCRATCH/forge.js"` },
	{ tool: "bash", command: `cd "$AS2_SCRATCH" && bun forge.ts` },
	{ tool: "bash", command: "bun ~/forge.ts", env: { HOME: cwd } },
	{ tool: "bash", command: "bun $HOME/forge.ts", env: { HOME: cwd } },
	{ tool: "bash", command: "bun $NOT_SET_ANYWHERE/forge.ts" },
	{ tool: "bash", command: `bun "$(dirname ${cwd}/forge.ts)/forge.ts"` },
];

/** Review round 1, finding 3: options before the script are skipped; a preloaded or imported module is read; `--cwd` moves the script. */
const SCRIPT_OPTIONS: Probe[] = [
	{ tool: "bash", command: `bun --smol ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun --bun ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun --watch ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun --hot ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun run --silent ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun run --bun ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun -- ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun run -- ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun --env-file=${cwd}/.env ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun --env-file ${cwd}/.env ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun --title x ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun --preload ${cwd}/forge.ts ${cwd}/benign.ts` },
	{ tool: "bash", command: `bun -r ${cwd}/forge.ts ${cwd}/benign.ts` },
	{ tool: "bash", command: `bun --preload=${cwd}/forge.ts -e 1` },
	{ tool: "bash", command: `bun --cwd ${cwd} forge.ts` },
	{ tool: "bash", command: `bun run --cwd ${cwd} forge.ts` },
	{ tool: "bash", command: `bun run --cwd=${cwd} forge` },
	{ tool: "bash", command: `node --no-warnings ${cwd}/forge.js` },
	{ tool: "bash", command: `node --experimental-strip-types ${cwd}/forge.ts` },
	{ tool: "bash", command: `node --import ${cwd}/forge.js -e 1` },
	{ tool: "bash", command: `node --import=${cwd}/forge.js ${cwd}/benign.ts` },
	{ tool: "bash", command: `node -r ${cwd}/forge.js ${cwd}/benign.ts` },
	{ tool: "bash", command: `node --require ${cwd}/forge.js ${cwd}/benign.ts` },
	{ tool: "bash", command: `node --loader ${cwd}/forge.js ${cwd}/benign.ts` },
];

/** Review round 1, finding 4: bun exec, bun x, bunx and npx running tsx, ts-node, node or bun on a file. */
const PACKAGE_RUNNERS: Probe[] = [
	{ tool: "bash", command: `bun exec 'bun ${cwd}/forge.ts'` },
	{ tool: "bash", command: `bun x tsx ${cwd}/forge.ts` },
	{ tool: "bash", command: `bunx tsx ${cwd}/forge.ts` },
	{ tool: "bash", command: `bunx --bun tsx@4 ${cwd}/forge.ts` },
	{ tool: "bash", command: `npx tsx ${cwd}/forge.ts` },
	{ tool: "bash", command: `npx -y ts-node ${cwd}/forge.ts` },
	{ tool: "bash", command: `npx --package=tsx tsx ${cwd}/forge.ts` },
	{ tool: "bash", command: `tsx ${cwd}/forge.ts` },
	{ tool: "bash", command: `npx -c 'node ${cwd}/forge.js'` },
];

/** Review round 1, finding 5: python, perl, ruby and deno scripts are read and judged by the ledger-path rules. */
const OTHER_INTERPRETERS: Probe[] = [
	{ tool: "bash", command: `python3 ${cwd}/forge.py` },
	{ tool: "bash", command: `python ${cwd}/forge.py` },
	{ tool: "bash", command: `python3 -u -W ignore ${cwd}/forge.py` },
	{ tool: "bash", command: `cd ${cwd} && python3 forge.py` },
	{ tool: "bash", command: `python3 "$AS2_SCRATCH/forge.py"` },
	{ tool: "bash", command: `cat > ${cwd}/here.py <<'EOF'\n${PYFORGE}EOF\npython3 ${cwd}/here.py` },
	{ tool: "bash", command: `python3 - <<'EOF'\n${PYFORGE}EOF` },
	{ tool: "bash", command: `python3 -c '${PYFORGE.replaceAll("'", "'\\''")}'` },
	{ tool: "bash", command: `perl ${cwd}/forge.pl` },
	{ tool: "bash", command: `ruby ${cwd}/forge.rb` },
	{ tool: "bash", command: `deno run -A ${cwd}/forge.ts` },
	{ tool: "bash", command: `deno ${cwd}/forge.ts` },
	{ tool: "bash", command: `deno run --preload ${cwd}/forge.ts ${cwd}/benign.ts` },
	{ tool: "bash", command: `ruby -C ${cwd} forge.rb` },
];

/** Review round 2, finding 1: `bun test` files and preloads outside an isolated checkout run are read. */
const R2_BUN_TEST: Probe[] = [
	{ tool: "bash", command: `cd ${cwd} && bun test forge.test.ts` },
	{ tool: "bash", command: `cd ${cwd} && bun test raw.test.ts` },
	{ tool: "bash", command: `cd ${cwd} && bun test` },
	{ tool: "bash", command: `cd ${cwd} && bun test ./rawabs.test.ts` },
	{ tool: "bash", command: `cd ${REPO} && bun test ${cwd}/raw.test.ts` },
	{ tool: "bash", command: `cd ${REPO} && bun test ${cwd}/rawabs.test.ts` },
	{ tool: "bash", command: `bun test ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun test --preload ${cwd}/forge.ts ${cwd}/benign.test.ts` },
	{ tool: "bash", command: `cd ${REPO} && bun test -r ${cwd}/forge.ts gates/test/authority-gate.test.ts` },
	{ tool: "bash", command: `cd ${REPO} && bun test --preload=${cwd}/forge.ts gates/test/authority-gate.test.ts` },
	// a repository test file run from a directory with no isolating bunfig.toml runs with the real HOME
	{ tool: "bash", command: `bun test ${REPO}/ledger/test/authority.test.ts` },
];

/** Review round 2, finding 2: eval code that loads a file by a literal path reads that file. */
const R2_EVAL_LOADS: Probe[] = [
	{ tool: "eval", language: "js", code: `await import("${cwd}/forge.ts");` },
	{ tool: "eval", language: "js", code: `const m = require("${cwd}/forge.js");` },
	{ tool: "eval", language: "js", code: `import "${cwd}/forge.ts";` },
	{ tool: "eval", language: "py", code: `exec(open("${cwd}/forge.py").read())` },
	{ tool: "eval", language: "py", code: `import runpy\nrunpy.run_path("${cwd}/forge.py")` },
	{ tool: "eval", language: "py", code: `import sys\nsys.path.insert(0, "${cwd}")\nimport forge` },
	{ tool: "eval", language: "py", code: `%load "${cwd}/forge.py"` },
	{ tool: "eval", language: "py", code: "import runpy, sys\nrunpy.run_path(sys.argv[1])" },
	{ tool: "eval", language: "py", code: "code = open(p).read()\nexec(code)" },
	{ tool: "bash", command: `cd ${cwd} && python3 -c 'import forge'` },
	{ tool: "bash", command: `bun -e 'await import("${cwd}/forge.ts")'` },
	{ tool: "bash", command: `python3 ${cwd}/pyrun.py ${cwd}/forge.py` },
];

/** Review round 2, finding 3 (and minor 6): a package.json script, a bunfig.toml preload, deno task. */
const R2_LAUNCH_CONFIG: Probe[] = [
	{ tool: "bash", command: `cd ${cwd}/pkg && bun run go` },
	{ tool: "bash", command: `cd ${cwd}/pkg && bun go` },
	{ tool: "bash", command: `cd ${cwd}/pkg && bun start` },
	{ tool: "bash", command: `cd ${cwd}/pkg/sub && bun run go` },
	{ tool: "bash", command: `bun --cwd ${cwd}/pkg run go` },
	{ tool: "bash", command: `cd ${cwd}/pkg && npm run go` },
	{ tool: "bash", command: `cd ${cwd}/pkg && npm start` },
	{ tool: "bash", command: `cd ${cwd}/pkg && npm test` },
	{ tool: "bash", command: `cd ${cwd}/pkg && npm run hush` },
	{ tool: "bash", command: `cd ${cwd}/pkg && npm run tool -- ${cwd}/forge.ts` },
	{ tool: "bash", command: `cd ${cwd}/pkg/sub && node --run go` },
	{ tool: "bash", command: `cd ${cwd}/both && bun run hello` },
	{ tool: "bash", command: `cd ${cwd}/both && bun hello` },
	{ tool: "bash", command: `cd ${cwd}/cfg && bun benign.ts` },
	{ tool: "bash", command: `bun --config=${cwd}/cfg/bunfig.toml ${cwd}/cfg/benign.ts` },
	{ tool: "bash", command: `cd ${cwd}/tcfg && bun test x.test.ts` },
	{ tool: "bash", command: `cd ${cwd}/dn && deno task forge` },
];

/** Review round 2, finding 4: `python3 -m <name>` runs `<cwd>/<name>.py` or its package's `__main__.py`. */
const R2_PYTHON_MODULE: Probe[] = [
	{ tool: "bash", command: `cd ${cwd} && python3 -m forge` },
	{ tool: "bash", command: "python3 -m forge" },
	{ tool: "bash", command: `cd ${cwd} && python3 -u -m pymod` },
	{ tool: "bash", command: `cd ${cwd} && python3 -mforge` },
];

/** Review round 2, finding 5 (and minor 9): bunx or npx with any package reads a file argument; versioned interpreter names. */
const R2_ANY_PACKAGE: Probe[] = [
	{ tool: "bash", command: `bunx vite-node ${cwd}/forge.ts` },
	{ tool: "bash", command: `bunx jiti ${cwd}/forge.ts` },
	{ tool: "bash", command: `bunx ts-node-dev ${cwd}/forge.ts` },
	{ tool: "bash", command: `bunx nodemon ${cwd}/forge.ts` },
	{ tool: "bash", command: `bunx esno ${cwd}/forge.ts` },
	{ tool: "bash", command: `bunx zx ${cwd}/forge.js` },
	{ tool: "bash", command: `npx vite-node ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun x jiti ${cwd}/forge.ts` },
	{ tool: "bash", command: `cd ${cwd} && bunx esno forge` },
	{ tool: "bash", command: `node22 ${cwd}/forge.js` },
	{ tool: "bash", command: `bun-canary ${cwd}/forge.ts` },
	{ tool: "bash", command: `bun-profile ${cwd}/forge.ts` },
];

/** Review round 3, finding 4: isolation is not trust. An archive copy's files outside its isolated `bun test`, a test file of another tree, a forged isolate preload, and a run whose isolation code this same call rewrites stay read. */
const R3_NOT_ISOLATED: Probe[] = [
	{ tool: "bash", command: `cd ${ARCHIVE} && bun ledger/test/authority.test.ts` },
	{ tool: "bash", command: `bun test ${ARCHIVE}/ledger/test/authority.test.ts` },
	{ tool: "bash", command: `cd ${ARCHIVE} && bun test ${cwd}/forge.test.ts` },
	{ tool: "bash", command: `bun test --preload ${ARCHIVE}/ledger/test/isolate-preload.ts ${cwd}/forge.test.ts` },
	{ tool: "bash", command: `bun test --preload ${REPO}/ledger/test/isolate-preload.ts ${ARCHIVE}/ledger/test/authority.test.ts` },
	{ tool: "bash", command: `bun test --preload ${ARCHIVE}/ledger/test/isolate-preload.ts ${REPO}/ledger/test/authority.test.ts` },
	{ tool: "bash", command: `cd ${FORGED} && bun test ./ledger/test/authority.test.ts` },
	{ tool: "bash", command: `bun test --preload ${FORGED}/ledger/test/isolate-preload.ts ${FORGED}/ledger/test/authority.test.ts` },
	{ tool: "bash", command: `cat > ${ARCHIVE}/ledger/src/locality.ts <<'EOF'\n${FORGE}EOF\ncd ${ARCHIVE} && bun test ./ledger/test/authority.test.ts` },
	// Review round 4: in a git checkout, isolation does not make an untracked test file the checkout's own code.
	{ tool: "bash", command: `cd ${GIT_TREE} && bun test ./forge.test.ts` },
	{ tool: "bash", command: `cd ${GIT_TREE} && bun test ./ledger/test/forge.test.ts` },
	{ tool: "bash", command: `cd ${GIT_TREE}/ledger/test && bun test forge.test.ts` },
	{ tool: "bash", command: `bun test --preload ${GIT_TREE}/ledger/test/isolate-preload.ts ${GIT_TREE}/forge.test.ts` },
];

const ALLOWED: Probe[] = [
	{ tool: "bash", command: `sqlite3 -readonly ${LIVE} "SELECT id, stakes FROM workloads"` },
	{ tool: "bash", command: `sqlite3 -readonly ${LIVE} ".tables"` },
	{ tool: "bash", command: "bun test ledger/test/authority.test.ts" },
	{ tool: "bash", command: 'echo "$AGENT_SYSTEM_ROLE $AGENT_SYSTEM_LANE_ID"' },
	{ tool: "bash", command: "printenv AGENT_SYSTEM_WORKLOAD_ID" },
	{ tool: "bash", command: "git status --short" },
	{ tool: "eval", language: "js", code: "const role = process.env.AGENT_SYSTEM_ROLE;\nconsole.log(role);" },
	{ tool: "eval", language: "js", code: `import { Database } from "bun:sqlite";\nconst mem = new Database(":memory:");` },
	{ tool: "eval", language: "py", code: `import os\nprint(os.environ.get("AGENT_SYSTEM_LANE_ID"))` },
	// G1: a repo script, a test run, a package script name, and a scratch script with no ledger import are not refused.
	{ tool: "bash", command: `cd ${REPO} && bun surface/scripts/invariants.ts` },
	{ tool: "bash", command: `bun ${REPO}/surface/scripts/invariants.ts` },
	{ tool: "bash", command: `bun run ${REPO}/ledger/scripts/backup.ts` },
	{ tool: "bash", command: "bun test x.test.ts" },
	{ tool: "bash", command: "bun run typecheck" },
	{ tool: "bash", command: `bun ${cwd}/benign.ts` },
	{ tool: "bash", command: `cat > ${cwd}/fresh.ts <<'EOF'\nconsole.log("fresh");\nEOF\nbun ${cwd}/fresh.ts` },
	{ tool: "bash", command: `NODE_OPTIONS=--max-old-space-size=4096 node ${cwd}/missing.js` },
	{ tool: "bash", command: `mkdir -p ${cwd}/d; bun ${cwd}/d/missing.ts` },
	{ tool: "eval", language: "js", code: `const { join } = await import("node:path");\nconst m = require("node:fs");\nconsole.log(join("a", "b"), typeof m);` },
];

for (const [group, probes] of [
	["imports the ledger module", IMPORTS],
	["names ledger.db in an open or a write", LEDGER_FILE],
	["constructs a bun:sqlite Database under ~/.agent-system-2/", UNDER_ROOT],
	["sets, unsets or overrides the agent-context or test-isolation names", ENV_OVERRIDES],
	["runs a script that loads the ledger module or opens a ledger (G1)", SCRIPTS],
	["loads a module whose specifier is computed (G1)", COMPUTED_IMPORTS],
	["a script word with an expansion (G1 review 1, finding 2)", SCRIPT_SPELLINGS],
	["a script after bun or node options, or preloaded (G1 review 1, finding 3)", SCRIPT_OPTIONS],
	["a script run through bun exec, bun x, bunx or npx (G1 review 1, finding 4)", PACKAGE_RUNNERS],
	["a python, perl, ruby or deno script (G1 review 1, finding 5)", OTHER_INTERPRETERS],
	["a bun test file or preload outside an isolated checkout run (G1 review 2, finding 1)", R2_BUN_TEST],
	["eval or inline code loading a file by a literal path (G1 review 2, finding 2)", R2_EVAL_LOADS],
	["a package.json script, bunfig.toml preload or deno task (G1 review 2, finding 3, minor 6)", R2_LAUNCH_CONFIG],
	["python -m on a module in the working directory (G1 review 2, finding 4)", R2_PYTHON_MODULE],
	["bunx or npx with any package on a file, and versioned runtimes (G1 review 2, finding 5, minor 9)", R2_ANY_PACKAGE],
	["an archive copy's files outside an isolated bun test, or a forged isolate preload (G1 review 3, finding 4)", R3_NOT_ISOLATED],
] as const) {
	describe(`refused with "${BOUNDARY}": ${group}`, () => {
		for (const role of ROLES) {
			test(`role ${role}: every probe is refused and the reason names the boundary`, () => {
				const missed = probes.flatMap((p) => {
					const r = call(p, role);
					return r !== null && r.reason.includes(BOUNDARY) ? [] : [`${label(p)} → ${r === null ? "ALLOW" : `REFUSE without the boundary: ${r.reason.slice(0, 120)}`}`];
				});
				expect(missed).toEqual([]);
			});
		}
	});
}

describe("reading stays allowed", () => {
	for (const role of ROLES) {
		test(`role ${role}: read-only probes pass`, () => {
			const refused = ALLOWED.flatMap((p) => {
				const r = call(p, role);
				return r === null ? [] : [`${label(p)} → ${r.reason.slice(0, 160)}`];
			});
			expect(refused).toEqual([]);
		});
	}
});

/** G1 review round 1: what must keep running, by finding. */
const ALLOWED_R1: [string, Probe[]][] = [
	[
		"finding 1: every scripts/ directory of a checkout, skills/ included, runs unread",
		[
			{ tool: "bash", command: `bun ${REPO}/skills/cross-model-review/references/panel/scripts/panel.ts check /x` },
			{ tool: "bash", command: `cd ${REPO} && bun skills/cross-model-review/references/panel/scripts/panel.ts prep quorum --run /x --workload wl-x --slice sl-x` },
			{ tool: "bash", command: `bun ${REPO}/skills/seo-audit/scripts/audit.ts https://example.com` },
			{ tool: "bash", command: `bun ${REPO}/bin/as2` },
		],
	],
	[
		"finding 2: a resolved spelling of a script with no ledger use",
		[
			{ tool: "bash", command: `bun "$AS2_SCRATCH/benign.ts"` },
			{ tool: "bash", command: `bun --smol "$AS2_SCRATCH/benign.ts" --flag` },
		],
	],
	[
		"finding 4: package runners on no file, and bun test",
		[
			{ tool: "bash", command: "bunx prettier --check ." },
			{ tool: "bash", command: "npx tsc --noEmit" },
			{ tool: "bash", command: `bun x tsx ${cwd}/benign.ts` },
			{ tool: "bash", command: `bun test --preload ${cwd}/benign.ts x.test.ts` },
		],
	],
	["finding 5: a python script with no ledger use", [{ tool: "bash", command: `python3 ${cwd}/hello.py` }]],
	[
		"finding 6: a script in another git repository with a runtime import() and no ledger name",
		[
			{ tool: "bash", command: `bun ${cwd}/product/build.ts ./plugin.ts` },
			{ tool: "bash", command: `cd ${cwd}/product && node build.ts` },
		],
	],
	[
		"minor: a template literal whose text mentions require( is not a load",
		[
			{ tool: "bash", command: `bun ${cwd}/tmpl.ts` },
			{ tool: "eval", language: "js", code: "const x = 1;\nconsole.log(`please require(${x}) it and import(${x})`);" },
		],
	],
];

for (const [group, probes] of ALLOWED_R1) {
	describe(`G1 review 1 stays allowed: ${group}`, () => {
		for (const role of ROLES) {
			test(`role ${role}`, () => {
				const refused = probes.flatMap((p) => {
					const r = call(p, role);
					return r === null ? [] : [`${label(p)} → ${r.reason.slice(0, 160)}`];
				});
				expect(refused).toEqual([]);
			});
		}
	});
}

/** G1 review round 2: what must keep running, by finding. */
const ALLOWED_R2: [string, Probe[]][] = [
	[
		"finding 1: this repository's tests from an isolating bunfig, and scratch tests with no ledger use",
		[
			{ tool: "bash", command: `cd ${REPO} && bun test gates/test/authority-gate.test.ts` },
			{ tool: "bash", command: `cd ${REPO} && bun test ledger/test/authority.test.ts classifier/test/authority-readers.test.ts gates/test/authority-gate.test.ts gates/test/guard-replay.test.ts` },
			{ tool: "bash", command: `cd ${REPO} && bun test ./ledger/test/authority.test.ts` },
			{ tool: "bash", command: `cd ${REPO}/gates && bun test test/authority-gate.test.ts` },
			{ tool: "bash", command: `cd ${REPO} && bun test` },
			{ tool: "bash", command: `cd ${REPO} && bun test --preload ${cwd}/benign.ts gates/test/authority-gate.test.ts` },
			{ tool: "bash", command: `cd ${cwd} && bun test benign.test.ts` },
			{ tool: "bash", command: `bun test ${cwd}/benign.test.ts` },
		],
	],
	[
		"finding 2: eval loading a file with no ledger use, or a package",
		[
			{ tool: "eval", language: "js", code: `await import("${cwd}/cfg/benign.ts");` },
			{ tool: "eval", language: "py", code: `exec(open("${cwd}/hello.py").read())` },
			{ tool: "eval", language: "py", code: `import sys\nsys.path.insert(0, "${cwd}")\nimport hello` },
			{ tool: "eval", language: "py", code: `exec("print(1)")` },
			{ tool: "eval", language: "js", code: `await import("${REPO}/surface/scripts/lane.ts");` },
		],
	],
	[
		"finding 3: package.json scripts and bunfig preloads with no ledger use",
		[
			{ tool: "bash", command: `cd ${cwd}/pkgok && bun run hi` },
			{ tool: "bash", command: `cd ${cwd}/pkgok && bun start` },
			{ tool: "bash", command: `cd ${cwd}/pkgok && npm run build` },
			{ tool: "bash", command: `cd ${cwd}/pkgok && node --run hi` },
			{ tool: "bash", command: `cd ${cwd}/pkgok && npm run missing` },
			{ tool: "bash", command: `cd ${REPO} && bun run typecheck` },
		],
	],
	["finding 4: python -m on a standard or benign module", [{ tool: "bash", command: "echo '{}' | python3 -m json.tool" }, { tool: "bash", command: `cd ${cwd} && python3 -m hello` }]],
	[
		"finding 5: bunx or npx on directories, repository files and benign files",
		[
			{ tool: "bash", command: `cd ${REPO} && bunx tsc --noEmit -p gates` },
			{ tool: "bash", command: `cd ${REPO} && bunx biome check surface/src/launch.ts` },
			{ tool: "bash", command: `bunx prettier --check ${cwd}/benign.ts` },
		],
	],
	[
		"minor 8: this repository's tracked files outside scripts/ and bin/",
		[
			{ tool: "bash", command: `cd ${REPO} && bun surface/src/as2test.ts render-refresh` },
			{ tool: "bash", command: `cd ${REPO} && bun surface/src/launch.ts` },
		],
	],
];

for (const [group, probes] of ALLOWED_R2) {
	describe(`G1 review 2 stays allowed: ${group}`, () => {
		for (const role of ROLES) {
			test(`role ${role}`, () => {
				const refused = probes.flatMap((p) => {
					const r = call(p, role);
					return r === null ? [] : [`${label(p)} → ${r.reason.slice(0, 160)}`];
				});
				expect(refused).toEqual([]);
			});
		}
	});
}

/** G1 review round 3, finding 4: isolated runs that main allowed, the trust exemption aside. */
const ALLOWED_R3: Probe[] = [
	{ tool: "bash", command: `cd ${ARCHIVE} && bun test ./ledger/test/authority.test.ts` },
	{ tool: "bash", command: `cd ${ARCHIVE} && bun test ledger/test/authority.test.ts` },
	{ tool: "bash", command: `cd ${ARCHIVE}/ledger/test && bun test authority.test.ts` },
	{ tool: "bash", command: `cd ${cwd} && bun test --preload ${ARCHIVE}/ledger/test/isolate-preload.ts ${ARCHIVE}/ledger/test/authority.test.ts` },
	{ tool: "bash", command: `cd ${cwd} && bun test --preload=${ARCHIVE}/ledger/test/isolate-preload.ts ${ARCHIVE}/ledger/test/authority.test.ts` },
	{ tool: "bash", command: `cd ${cwd} && bun test --preload ${REPO}/ledger/test/isolate-preload.ts ${REPO}/ledger/test/authority.test.ts` },
	{ tool: "bash", command: `cd ${cwd} && bun test -r ${REPO}/ledger/test/isolate-preload.ts ${REPO}/ledger/test/authority.test.ts` },
	{ tool: "bash", command: `cd ${GIT_TREE} && bun test ./ledger/test/authority.test.ts` },
];

describe("G1 review 3 stays allowed: finding 4, an archive copy's or a CLI --preload's isolated tests", () => {
	for (const role of ROLES) {
		test(`role ${role}`, () => {
			const refused = ALLOWED_R3.flatMap((p) => {
				const r = call(p, role);
				return r === null ? [] : [`${label(p)} → ${r.reason.slice(0, 200)}`];
			});
			expect(refused).toEqual([]);
		});
	}
});
