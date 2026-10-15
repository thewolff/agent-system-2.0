// orchestrator-session: which conversation `bin/as2` opens (PLAN wl-mv8wzipdczs2rk D1). Ilex resumes the
// designated orchestrator session: the file named by the newest valid `orchestrator-session:` entry the
// surface writes on wl-orchestrator (surface/extensions/wake.ts, only for a launch carrying
// AGENT_SYSTEM_AS2_LAUNCH=1). No session folder is scanned: with no valid pointer, Ilex starts fresh.
//
//   bun surface/scripts/orchestrator-session.ts <repo> <agentDir> -- <as2 args...>
//
// Jo's args are read with OMP's own parseArgs, imported from the installed package `omp` on PATH resolves
// to (<pkg>/dist/cli.js → <pkg>/src/cli/args.ts), so `--`, consumed values and hidden flags read exactly
// as omp reads them. When they choose a session (continue, resume, sessionDir, noSession, fork, a
// --from-claude/--from-codex import, goal), as2 adds no --resume. A pointer is valid when its file exists,
// is a regular file, has a `session` header whose cwd is <repo>, and holds an assistant message; a dead
// newer pointer falls back to the one before it, named on stderr.
//
// stdout, one line: `<launch> <guard> <file>`. launch 1: as2 exports AGENT_SYSTEM_AS2_LAUNCH=1 (an Ilex
// launch: plain, --resume…, --session…, -c/--continue; never sessionDir, goal, fork, noSession or an
// import). guard 1: the launch resumes, so as2 refuses while Ilex runs. file: as2 adds --resume=<file>,
// or empty. A parser that cannot be imported or that throws: one stderr line, `0 0 ` (today's argv).
// <agentDir> is the profile's agent dir omp runs with (OMP_PROFILE); OMP's env module reads its `.env`,
// which can set PI_CODING_AGENT_SESSION_DIR, before parseArgs runs, so the parse here reads it too.
// Exit: 0 decided · 2 usage
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { ORCHESTRATOR_SESSION_PREFIX } from "../src/launch";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";

export const NO_CONVERSATION_LINE = "as2: no recorded Ilex conversation; starting a new one (resume one with: as2 --resume=<file>)";

/** The fields of OMP's parsed `Args` that name a session choice (pi-coding-agent src/cli/args.ts `Args`). */
export interface SessionArgs {
	continue?: boolean;
	resume?: string | true;
	sessionDir?: string;
	noSession?: boolean;
	fork?: string;
	fromClaude?: boolean;
	fromCodex?: boolean;
	goal?: string;
}

export interface Decision {
	/** Export AGENT_SYSTEM_AS2_LAUNCH=1: an Ilex launch, whose session may become the designated one. */
	launch: boolean;
	/** The launch resumes a session: refuse while Ilex runs. */
	guard: boolean;
	/** The file as2 resumes with --resume=<file>, or null. */
	resume: string | null;
	/** Lines for stderr, in order. */
	notes: string[];
}

/** The installed OMP package `omp` on PATH resolves to, or why there is none. */
export function ompPackage(path: string | undefined): { pkg: string } | { error: string } {
	const omp = Bun.which("omp", { PATH: path ?? "" });
	if (!omp) return { error: "no omp on PATH" };
	// <pkg>/dist/cli.js: the package is two levels above the real file.
	return { pkg: dirname(dirname(realpathSync(omp))) };
}

/** Jo's args read by OMP's parser at `<pkg>/src/cli/args.ts`, or why they could not be. */
export async function parseOmpArgs(pkg: string, args: string[]): Promise<{ args: SessionArgs } | { error: string }> {
	const parser = join(pkg, "src", "cli", "args.ts");
	let parseArgs: (argv: string[]) => SessionArgs;
	try {
		// Runtime-selected module: the parser lives in whichever OMP package `omp` on PATH resolves to.
		const mod = (await import(parser)) as { parseArgs?: unknown };
		if (typeof mod.parseArgs !== "function") return { error: `${parser} exports no parseArgs` };
		parseArgs = mod.parseArgs as (argv: string[]) => SessionArgs;
	} catch (e) {
		return { error: `cannot import ${parser}: ${e instanceof Error ? e.message : String(e)}` };
	}
	try {
		return { args: parseArgs(args) };
	} catch (e) {
		return { error: `omp's parseArgs refused the arguments: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/** The `orchestrator-session:` files, newest first, each once (its newest mention). */
export function pointers(ledger: Ledger): string[] {
	const out: string[] = [];
	const rows = ledger.entries(STANDING_WORKLOAD_ID, "assumption");
	for (let i = rows.length - 1; i >= 0; i--) {
		const e = rows[i]!;
		if (e.created_by !== SURFACE_BY || !e.body.startsWith(ORCHESTRATOR_SESSION_PREFIX)) continue;
		// `<absolute file> <sessionId>`: the file may hold spaces, the id never does.
		const rest = e.body.slice(ORCHESTRATOR_SESSION_PREFIX.length).trim();
		const cut = rest.lastIndexOf(" ");
		const file = cut > 0 ? rest.slice(0, cut) : "";
		if (file !== "" && !out.includes(file)) out.push(file);
	}
	return out;
}

/** Why `file` cannot be resumed as Ilex's conversation in `repo`, or null when it can. */
export function deadReason(file: string, repo: string): string | null {
	if (!existsSync(file)) return "the file is missing";
	if (!statSync(file).isFile()) return "not a regular file";
	const lines = readFileSync(file, "utf8").split("\n");
	let cwd: string | null = null;
	for (const line of lines) {
		if (!line.includes('"session"')) continue;
		const e = parseLine(line);
		if (e?.type === "session") {
			cwd = typeof e.cwd === "string" ? e.cwd : "";
			break;
		}
	}
	if (cwd === null) return "no session header";
	if (cwd !== repo) return `its session cwd is ${cwd}, not ${repo}`;
	const replied = lines.some((line) => {
		if (!line.includes('"assistant"')) return false;
		const e = parseLine(line);
		const m = e?.message as { role?: unknown } | undefined;
		return e?.type === "message" && m?.role === "assistant";
	});
	return replied ? null : "no assistant message yet";
}

function parseLine(line: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(line);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The newest valid pointer, with a line per dead newer one; none valid → the no-conversation line. */
export function pick(files: readonly string[], repo: string): { resume: string | null; notes: string[] } {
	const notes: string[] = [];
	for (const file of files) {
		const why = deadReason(file, repo);
		if (why === null) {
			if (notes.length > 0) notes.push(`as2: resuming the previous recorded Ilex conversation: ${file}`);
			return { resume: file, notes };
		}
		notes.push(`as2: the recorded Ilex conversation ${file} cannot be resumed (${why})`);
	}
	return { resume: null, notes: [...notes, NO_CONVERSATION_LINE] };
}

export async function decide(repo: string, args: string[], env: Record<string, string | undefined>): Promise<Decision> {
	const found = ompPackage(env.PATH);
	const parsed = "pkg" in found ? await parseOmpArgs(found.pkg, args) : found;
	if ("error" in parsed) {
		return { launch: false, guard: false, resume: null, notes: [`as2: cannot read your arguments with omp's own parser (${parsed.error}); launching them as given, without resuming Ilex's conversation`] };
	}
	const a = parsed.args;
	// An independent session (OMP starts it fresh, main.ts) never moves the pointer: no AGENT_SYSTEM_AS2_LAUNCH.
	const launch = !(a.sessionDir || a.noSession || a.fork || a.fromClaude || a.fromCodex || a.goal !== undefined);
	if (!launch || a.continue || a.resume) {
		// Jo chose the session: as2 adds nothing. Only a resume or continue opens a file Ilex may be writing.
		return { launch, guard: !!(a.continue || a.resume) && !a.noSession && !a.fromClaude && !a.fromCodex, resume: null, notes: [] };
	}
	let files: string[];
	try {
		const ledger = Ledger.open(undefined, { readonly: true });
		try {
			files = pointers(ledger);
		} finally {
			ledger.close();
		}
	} catch (e) {
		return { launch, guard: false, resume: null, notes: [`as2: cannot read the ledger (${e instanceof Error ? e.message : String(e)})`, NO_CONVERSATION_LINE] };
	}
	const p = pick(files, repo);
	return { launch, guard: p.resume !== null, resume: p.resume, notes: p.notes };
}

if (import.meta.main) {
	const [repo, agentDir, sep, ...args] = process.argv.slice(2);
	if (!repo || !agentDir || sep !== "--") {
		process.stderr.write("usage: bun surface/scripts/orchestrator-session.ts <repo> <agentDir> -- <as2 args...>\n");
		process.exit(2);
	}
	// OMP's env and dirs modules read these at import: the agent dir omp resolves from its profile.
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const d = await decide(repo, args, process.env);
	for (const line of d.notes) process.stderr.write(`${line}\n`);
	process.stdout.write(`${d.launch ? 1 : 0} ${d.guard ? 1 : 0} ${d.resume ?? ""}\n`);
}
