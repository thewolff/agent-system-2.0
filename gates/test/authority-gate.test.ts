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
// with SELECT, `echo $AGENT_SYSTEM_ROLE`, eval reading process.env, and `bun test` of a test file.
// Every probe is inert: the gate only reads the strings and the script files this test writes into its own temp
// directory; nothing here runs, and every path sits under a home this test makes up.
//
// G1 (scratch auth-forgery AUDIT.md § (e)): a script bun or node runs (`bun f.ts`, `bun run f.ts`, `node f.js`, a
// heredoc that writes the script in the same call) is read and judged like eval code; a computed `import()` or
// `require()` is refused in eval, inline code and scripts outside every git repository; `bun test` and this
// repository's own scripts are not read. G1 review round 1 (sl-auth-forgery-review): a script word with a `$NAME`,
// `${NAME}` or `~` is resolved and read, and one the gate cannot resolve is refused; bun's and node's options before
// the script are skipped and a preloaded module is read; `bun exec`, `bun x`, `bunx` and `npx` running tsx, ts-node,
// node or bun on a file are read; python, perl, ruby and deno scripts are read; every script directory of a checkout
// (skills/*/…/scripts/ included) runs unread.
// The probe strings below load modules on purpose: they are the module-loading boundary under test.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
	{ tool: "bash", command: `bun test ${cwd}/forge.ts` },
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
