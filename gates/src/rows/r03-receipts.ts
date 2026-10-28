// P-11 row 3 (DESIGN-2.0.md:340; C4.7; SPEC-2.0.md § B15 item 5): receipts verified. A CLAIM's
// file:line was read this session and its quote matches disk; a CITE's URL was fetched with no
// redirect; a command reported with its exit code (`cmd` → exit N, in plain prose: the contract
// reports actions unlabeled) matches the recorded run; "tests pass" has a test run after the last
// edit. Informational: returns flags, never blocks. Label syntax ported from 1.x
// `output-types-guard.mjs` (LABEL_RE / ANCHOR_RE), narrowed to the contract's two labels
// (plugins/output-types/skills/output-types/reference.md): CLAIM and CITE. Unlabeled prose is
// not backed by a receipt and is not checked.
//
// Zero labels (contract § Degraded reports, Parent-side: a report of findings with no CLAIM or CITE
// is unverified) is flagged on a top-level turn's reply, with one carve-out, the trivial-ask path
// (SPEC-2.0.md § B15, amended 2026-09-30; tiers/orchestrator.md § Trivial asks). Mechanical
// criterion: a reply with no block-leading CLAIM or CITE is NOT flagged when its turn made no
// working call (workCall): no `task` or `eval`, no file write or edit, no `bash` that row 15's read
// tables do not call read-only (r15-orchestrator-role.ts readOnlyBash), and no surface ledger tool
// but the two reads (the wake read and orchestrator_ledger), whether called by name or written as
// its `xd://` device. Opening a workload is such a call (orchestrator_open_workload), so "no working
// call" covers "opened no workload". Reads — `read`, `grep`, `find`, a read-only command — stay
// trivial. The turn runs from `before_agent_start` to `session_stop`
// (gates/extensions/r03-receipts.ts). A hand's yield carries no turn record and is never checked
// for zero labels: the lane reads it, and every string field of it would flag.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SURFACE_READ_TOOLS, SURFACE_TOOLS } from "../../../surface/src/types";
import { bashCommand } from "../exec";
import { linkedPaths } from "../links";
import { WRITE_TOOLS } from "../targets";
import { TEST_RUN } from "../test-run";
import { readOnlyBash } from "./r15-orchestrator-role";

/** Tools that are work whatever their input: dispatch and code execution. */
const WORK_TOOLS: Record<string, true> = { task: true, eval: true };
/** The surface's ledger-writing tools: every one but the reads (the wake read and the on-demand ledger render). */
const READS: readonly string[] = SURFACE_READ_TOOLS;
const LEDGER_WRITERS: Record<string, true> = Object.fromEntries(SURFACE_TOOLS.filter((t) => !READS.includes(t)).map((t) => [t, true]));

/** True when one tool call is work — it changes state, dispatches, or writes a ledger row — rather than a read. */
export function workCall(toolName: string, input: Record<string, unknown>, cwd: string, env: Record<string, string | undefined>): boolean {
	if (WORK_TOOLS[toolName] || LEDGER_WRITERS[toolName]) return true;
	if (toolName === "write" && typeof input.path === "string" && READS.some((t) => input.path === `xd://${t}`)) return false;
	if (WRITE_TOOLS[toolName]) return true;
	if (toolName === "bash") {
		const at = typeof input.cwd === "string" ? resolve(cwd, input.cwd) : cwd;
		return !readOnlyBash(bashCommand(input), at, env, input.env);
	}
	return false;
}

/** What the session did, recorded from `tool_result` events. */
export type HistoryEvent =
	| { kind: "read"; path: string }
	| { kind: "fetch"; url: string; finalUrl: string }
	| { kind: "bash"; command: string; exitCode: number }
	| { kind: "write"; path: string };

/** A block-leading label, `**CLAIM**` or `**CITE**`, alone on its line. */
const ANCHOR = /^\*\*(CLAIM|CITE)\*\*\s*$/;
const TESTS_PASS = /\b(?:tests?\s+(?:all\s+)?pass(?:ed|es|ing)?|all\s+(?:tests\s+)?green|\d+\s+pass\b)/i;

/** One history event from an OMP `tool_result` (field names: pi-tui src/tools/{read,bash}.ts, fetch details). */
export function historyEvent(toolName: string, input: Record<string, unknown>, details: unknown, isError: boolean): HistoryEvent | null {
	const d = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
	if (toolName === "read" || toolName === "fetch") {
		// A read or fetch that errored read nothing: it is no evidence for a receipt (astra review S2).
		if (isError) return null;
		if (typeof d.url === "string" && typeof d.finalUrl === "string") return { kind: "fetch", url: d.url, finalUrl: d.finalUrl };
		const p = typeof d.resolvedPath === "string" ? d.resolvedPath : typeof input.path === "string" ? input.path : null;
		return p ? { kind: "read", path: p.replace(/:[\d+,-]+$/, "") } : null;
	}
	if (toolName === "bash") {
		// BashToolDetails.exitCode is set only for a completed non-zero exit (pi-tui src/tools/bash.ts:38-39).
		const code = typeof d.exitCode === "number" ? d.exitCode : isError ? 1 : 0;
		return { kind: "bash", command: bashCommand(input), exitCode: code };
	}
	if ((toolName === "write" || toolName === "edit" || toolName === "ast_edit") && !isError) {
		const p = typeof input.path === "string" ? input.path : Array.isArray(input.paths) ? String(input.paths[0]) : null;
		return p ? { kind: "write", path: p } : null;
	}
	return null;
}

interface Block {
	label: "CLAIM" | "CITE";
	text: string;
}

function blocks(message: string): Block[] {
	const out: Block[] = [];
	let cur: Block | null = null;
	for (const line of message.split("\n")) {
		const m = ANCHOR.exec(line.trim());
		if (m) {
			cur = { label: m[1] as Block["label"], text: "" };
			out.push(cur);
		} else if (cur) cur.text += `${line}\n`;
	}
	return out;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Row 3: flags on a report. Empty = every checkable receipt checked out. Never a refusal.
 * `work` (top-level replies only): the names of this turn's working calls (workCall), for the
 * zero-label check.
 */
export function checkReceipts(message: string, history: HistoryEvent[], cwd: string, work?: readonly string[]): string[] {
	const flags: string[] = [];
	const bs = blocks(message);
	if (work && work.length > 0 && bs.length === 0 && message.trim()) {
		flags.push(
			`the reply carries no CLAIM or CITE after ${work.length} working call${work.length === 1 ? "" : "s"} this turn (${[...new Set(work)].join(", ")}): nothing in it is backed by a receipt (contract § Degraded reports, Parent-side); ` +
				`a plain reply is the trivial-ask path only when the turn made no working call`,
		);
	}
	const readPaths = new Set(history.flatMap((h) => (h.kind === "read" ? [resolve(cwd, h.path)] : [])));
	// Only a successful read tool call counts; a bash command merely naming the path is no evidence
	// that the lines were read (astra review S2).
	for (const b of bs) {
		if (b.label === "CLAIM") {
			const receipts=linkedPaths(b.text,true);
			for (const [index, { path, line, end:receiptEnd }] of receipts.entries()) {
				if (!line) continue;
				const [position, to] = line.split("-");
				const from = position!.split(":")[0]!;
				if (!existsSync(path!) || !statSync(path!).isFile()) {
					flags.push(`CLAIM cites ${path}:${from}, which does not exist on disk`);
					continue;
				}
				const fileLines = readFileSync(path!, "utf8").split("\n");
				const start = Number(from);
				const end = to ? Number(to) : start;
				if (start < 1 || end > fileLines.length) flags.push(`CLAIM cites ${path}:${from}${to ? `-${to}` : ""}, past the file's ${fileLines.length} lines`);
				if (!readPaths.has(path!)) flags.push(`CLAIM cites ${path}, which was not read this session`);
				const after = b.text.slice(receiptEnd,receipts[index+1]?.start ?? b.text.length);
				const quote = /`([^`\n]{8,})`|"([^"\n]{8,})"/.exec(after);
				if (quote) {
					const want = norm(quote[1] ?? quote[2]!);
					const window = norm(fileLines.slice(Math.max(0, start - 4), end + 3).join("\n"));
					if (!window.includes(want)) flags.push(`CLAIM quote "${want}" does not match ${path} near line ${from}`);
				}
			}
		} else if (b.label === "CITE") {
			for (const m of b.text.matchAll(/https?:\/\/[^\s`<>)\]]+/g)) {
				const url = m[0].replace(/[.,;:]+$/, "");
				const same = (a: string): boolean => a.replace(/\/$/, "") === url.replace(/\/$/, "");
				const hit = history.find((h) => h.kind === "fetch" && (same(h.url) || same(h.finalUrl)));
				if (!hit || hit.kind !== "fetch") flags.push(`CITE ${url} was not fetched this session`);
				else if (hit.url.replace(/\/$/, "") !== hit.finalUrl.replace(/\/$/, "")) flags.push(`CITE ${url} redirected to ${hit.finalUrl}; cite what was actually read`);
			}
		}
	}
	// A reported exit code, wherever it sits in the prose.
	for (const m of message.matchAll(/`([^`\n]+)`\s*(?:→|->)\s*exit\s+(\d+)/g)) {
		const cmd = m[1]!.trim();
		const said = Number(m[2]);
		const run = [...history].reverse().find((h) => h.kind === "bash" && h.command.includes(cmd));
		if (!run || run.kind !== "bash") flags.push(`\`${cmd}\` → exit ${said}: no such run recorded this session`);
		else if (run.exitCode !== said) flags.push(`\`${cmd}\` reports exit ${said}; the recorded run exited ${run.exitCode}`);
	}

	if (TESTS_PASS.test(message)) {
		const lastWrite = history.map((h) => h.kind).lastIndexOf("write");
		const runs = history.map((h, i) => ({ h, i })).filter(({ h, i }) => i > lastWrite && h.kind === "bash" && TEST_RUN.test(h.command));
		if (runs.length === 0) flags.push(`the report says tests pass, but no test run is recorded after the last edit`);
		else {
			const last = runs[runs.length - 1]!.h;
			if (last.kind === "bash" && last.exitCode !== 0) flags.push(`the report says tests pass; the last test run after the last edit exited ${last.exitCode}`);
		}
	}
	return flags;
}

/** The flag block appended to a report. */
export function renderFlags(flags: string[]): string {
	return `\n\n---\nP-11 row 3 receipt check (informational, not a refusal; SPEC-2.0.md § B15 item 5):\n${flags.map((f) => `- ${f}`).join("\n")}\n`;
}
