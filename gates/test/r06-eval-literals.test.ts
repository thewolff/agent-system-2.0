// MIGRATION.md follow-up 29: row 6 read every string literal in eval code as shell, even in code
// that starts no process, and a literal that is a path to an existing file was opened and parsed
// as a script. Three read-only evals that only opened MIGRATION.md as data were held as
// `kubectl delete` (a review note quoting `kubectl --context X delete`), and one that only printed
// a list of test-command strings was held for its `bun test $(cat list)`. Each hold's code is
// replayed here as the ledger recorded it, with the MIGRATION.md path it opened pointed at a temp
// copy holding the line that matched. Controls: the same path inside code that starts a process
// (refused outright as a process started from eval, PLAN wl-muzs0ytnaet1v4 D1; inline interpreter
// code still reads the path as a script), a reserved spelling in a non-spawning literal, and a
// quoted-word form in Bun's shell tag still refuse.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkReserved, reservedAction } from "../src/rows/r06-reserved";
import type { CallContext } from "../src/types";
import { tmpDir } from "../../ledger/test/tmp";

const dir = tmpDir("gates-r06-eval-literals-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const mig = join(dir, "MIGRATION.md");
// MIGRATION.md line 49 at cc34784^, the text the 17:56Z hold matched.
writeFileSync(mig, "- review round: infra verbs hidden behind global options like `kubectl --context X delete`) + 1 should-fix\n");

const ctx: CallContext = { role: "lane", cwd: dir, env: { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: "/not-real/ledger.db" } };
const row6 = (language: "py" | "js", code: string) => checkReserved({ toolName: "eval", input: { language, code } }, ctx);

// en-mupu5ly5ur4s1s (py).
const HOLD_PY = `import textwrap
lines=open('${mig}').read().split('\\n')
for chunk in textwrap.wrap(lines[88],300): print(chunk)`;

// en-mupub3ulxymsjk and its retry en-mupuh35ko3eps0 (js, the same code).
const HOLD_JS = `const repo = "/Users/jowolff/code/agent-system-2.0-lanes/wl-mupu0sx2o046io";
const dir = "/Users/jowolff/agent-scratch/agent-system-2.0/wl-mupu0sx2o046io";
const lines = async (p, a, b) => {
  const t = (await Bun.file(\`\${repo}/\${p}\`).text()).split("\\n");
  const s = a ?? 1, e = b ?? t.length;
  return \`\\n\\n===== FILE \${p} lines \${s}-\${e} =====\\n\` + t.slice(s - 1, e).map((l, i) => \`\${s + i}: \${l}\`).join("\\n");
};
const prompt = (await Bun.file(\`\${dir}/review-prompt.md\`).text()).replace(
  "Read-only: do not edit any file.",
  "Read-only: do not edit any file. Your shell tools may not work in this environment, so the plan and every named source file are pasted below with line numbers; review from them.");
let pack = prompt + "\\n\\n===== PLAN.md =====\\n" + await Bun.file(\`\${dir}/PLAN.md\`).text();
pack += await lines("classifier/extension.ts");
pack += await lines("classifier/src/route.ts");
pack += await lines("classifier/src/tier-table.ts");
pack += await lines("classifier/src/ledger-port.ts");
pack += await lines("ledger/src/index.ts", 740, 870);
pack += await lines("ledger/schema.sql", 58, 200);
pack += await lines("profile/config.yml", 134, 167);
pack += await lines("surface/src/input.ts", 40, 120);
pack += await lines("tiers/lane.md");
pack += await lines("SPEC-2.0.md", 451, 470);
const mig = (await Bun.file("${mig}").text()).split("\\n")[104];
pack += "\\n\\n===== MIGRATION.md item 23 (main checkout) =====\\n" + mig;
await Bun.write(\`\${dir}/review-pack.md\`, pack);
return pack.length;
`;

// en-mupv139zgbc1z4 (js): opens no file; one string in its list is `bun test $(cat list)`.
const HOLD_BUN = `const RUNNER = /^(?:bun\\s+test|npm\\s+(?:run\\s+)?test|pnpm\\s+(?:run\\s+)?test|yarn\\s+test|(?:npx\\s+|bunx\\s+)?(?:vitest|jest)|pytest|go\\s+test|cargo\\s+test|just\\s+[\\w-]*test[\\w-]*)(?:\\s|$)/;
const isTestCommand = (command) => { const c = command.trim(); return !/[;&|<>\`$()#\\\\'"\\n]/.test(c) && !/(?:^|\\s)(?:-h|--help|--version)(?=\\s|$)/.test(c) && RUNNER.test(c); };
for (const c of ["bun test", "bun test gates/test/a.test.ts surface/test/b.test.ts", "bun test -t name x.test.ts", "pytest -v tests", "echo bun test", "true # bun test", "bun test --help", "bun test x.test.ts 2>&1 | tail -n 40", "bun test x.test.ts || true", "bun test x; exit 0", "grep -rn 'bun test' tiers", "cd /tmp/x && bun test", "bunx vitest --version", "bun test $(cat list)"]) console.log(isTestCommand(c), JSON.stringify(c));`;

describe("follow-up 29: code that starts no process does not run its literals", () => {
	test("en-mupu5ly5ur4s1s: py reading MIGRATION.md as data is allowed", () => expect(row6("py", HOLD_PY)).toBeNull());
	test("en-mupub3ulxymsjk / en-mupuh35ko3eps0: js reading MIGRATION.md as data is allowed", () => expect(row6("js", HOLD_JS)).toBeNull());
	test("en-mupv139zgbc1z4: js printing a list of test-command strings is allowed", () => expect(row6("js", HOLD_BUN)).toBeNull());
});

describe("follow-up 29 controls: still refused", () => {
	test("the same MIGRATION.md path run by a process the code starts", () => {
		// Eval code that starts a process is refused outright for the bash tool, not reserved (PLAN wl-muzs0ytnaet1v4 D1),
		// so the path is never read as a script there; inline interpreter code in bash still reads it.
		const r = row6("py", `import subprocess\nsubprocess.run(['${mig}'])`);
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("eval code that starts a process");
		expect(reservedAction(r)).toBeNull();
		const inline = checkReserved({ toolName: "bash", input: { command: `python3 -c "import subprocess; subprocess.run(['${mig}'])"` } }, ctx);
		expect(inline?.reason).toContain("kubectl delete");
	});
	test("a reserved spelling in a literal of non-spawning code (the quote-blind text pass)", () => {
		const r = row6("js", 'const c = "kubectl delete deployment app"; console.log(c)');
		expect(r?.reason).toContain("kubectl delete");
		// The refusal tells the lane how to drop the request once it has gone past it (MIGRATION.md follow-up 31).
		expect(r?.reason).toContain("lane_withdraw_reserved");
	});
	test("a quoted-word hard reset in Bun's shell tag", () => {
		expect(row6("js", 'await Bun.$`git "reset" --hard`;')?.block).toBe(true);
	});
});
