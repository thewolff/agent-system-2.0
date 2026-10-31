// The orchestrator's ledger writes, each a tool through the ledger module (P-11 row 10: the module
// is the only writer): identity (first wake), open a workload with stakes and mode inferred and the
// repository's decision log rendered into the lane brief (§ A1.2, § B13.1, § B2.1, C7.5), close a
// workload with a decision-log entry rendered from the ledger, and schedule a row that surfaces
// under *needs you* once past due (M11).
//
// Lane launcher (DESIGN-lane-launcher.md): open writes the `done:` line (decision 16) and, when the
// trigger fires, `plan: first <trigger>` (decision 15), and Jo's `lane-model:` when `model` is given
// (MIGRATION.md item 85), all in the transaction that opens the workload, then runs the launch trigger
// (surface/extensions/launch.ts) and carries its one line; close (`closeWorkloadWithEntry`, shared
// by the close tool and the wake tick's auto-close of a workload awaiting close or withdrawn) refuses a workload
// held under a live lease or without the holder's `done-because:` receipt (unless Jo superseded or withdrew it), commits the rendered
// entry (decision 13) on the workload's lane branch wl/<id>, never on the checkout's current branch,
// and pushes it to an open PR (surface/src/close-entry.ts), through the extension API's exec, never
// the bash tool. Once the row has closed, the workload's scratch root is archived and then removed in-process
// (`closeScratchRoot`, PLAN wl-mv5oikd5jtquww § 1.5 as amended 2026-10-28); a failed archive keeps the root, and a failed
// archive or removal is an entry, never a failed close.
import { type InstructionRow, type Ledger, type MessageRow, TEST_RUNNER_BY } from "../../ledger/src/index";
import { classify, type KindJudge, loadKindQuestion } from "../../classifier/src/classify";
import { closeCheck, closeScratchRoot, commitCloseEntry, type EntryPublish, logDirOf, publishEntry, recordCloseReceipt, type StandIn, standInOf } from "../src/close-entry";
import { decisionLogContext, lastWorkloadOn, recordRepo, repoOf } from "../src/decision-log";
import { identityOf, recordIdentity } from "../src/identity";
import { ceilingBody, sizeFor } from "../src/ceiling";
import { attempts, controlEntries, doneBecause, doneBody, doneLine, holdersOf, laneCap, laneModelBody, modelProblem, planFirstBody, queuedBody, supersededBy, withdrawnBy } from "../src/launch";
import { stakesSource } from "../src/input";
import { answerOrchestratorQuestion, inputSpent, joInput, type OrchestratorAnswer, questionSubject, readingBody } from "../src/orchestrator-question";
import { queuePosition, startedIdle } from "../src/rank-launch";
import { oneLiner } from "../src/render";
import { surfaceSession } from "../src/session";
import { inferMode, inferStakes, type JudgedSize, judgedLarge, planFirstTrigger, saidNoPlan, saidPlanIt } from "../src/stakes";
import { parseSecurityRed, SECURITY_RED_PREFIX } from "../src/test-run";
import {
	CLOSE_WORKLOAD_TOOL, type Ctx, DUE_PREFIX, IDENTITY_TOOL, MODE_WORDS, OPEN_WORKLOAD_TOOL, ORCHESTRATOR_RECIPIENT, RECORD_INSTRUCTION_TOOL, SCHEDULE_TOOL,
	STAKES_WORDS, STANDING_WORKLOAD_ID, type SurfaceAPI, SURFACE_BY, type ToolResult,
} from "../src/types";
import { triggerLaunch } from "./launch";
import { askAtOpen, RANK_ASK_TIMEOUT_MS } from "./rank";

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });
const inactive = text("This session is not the orchestrator surface; nothing was written.");
/** Jo's input was spent by another call between the open's check and its transaction (PLAN wl-mvbcjadqgblr7k D3). */
class InputSpent extends Error {}

export interface WorkloadDeps {
	/** The judge that sizes a workload brief for plan-first (decision 15) and asks the new workload's Jev rank signal (PLAN wl-mv8k039gvogt8g D4): OMP's `judge` role, wired in surface/index.ts. Absent in tests that do not size. */
	judge?(ctx: Ctx): Promise<KindJudge>;
	/** The open-time rank ask's limit (surface/extensions/rank.ts RANK_ASK_TIMEOUT_MS unless a test sets it); also the one overall deadline a queued open waits for that ask (PLAN wl-mvbcjadqgblr7k D4). */
	askTimeoutMs?: number;
}

export interface CloseOutcome {
	closed: boolean;
	/** The one line for the tool result or the tick's notice. */
	text: string;
	details?: unknown;
	/** The holder's standing `done-because:` receipt; with none, on a close Jo's superseded or withdrawn word stood in for, the close receipt naming it; else null (a scheduled row, a workload with no done: line). */
	receipt: string | null;
	/** On a close, what became of the decision-log entry (committed where, pushed or not, the PR or why none), which the tick's notice carries too. */
	entry?: string;
}

/** How many held messages the close line lists by id, sender and body before it names the rest by id only. */
const HELD_LISTED = 10;
/** The longest message body the close line carries, in characters. */
const HELD_BODY_MAX = 200;

/**
 * PLAN wl-mvbcjageg7o2yo § 2.5: inside the close transaction, ordinary held orchestrator-bound
 * messages move to `delivered`. Trusted security reds keep their dedicated closed-workload route
 * (`securityRedLines` / `consumeAllToOrchestrator`), so they still reach Jo before being delivered.
 * Returns only the rows delivered here.
 */
function deliverHeldAtClose(ledger: Ledger, id: string): MessageRow[] {
	const held = ledger.db.query<MessageRow, [string, string]>(
		"SELECT * FROM messages WHERE workload_id = ?1 AND state = 'held' AND recipient = ?2 ORDER BY created_at, rowid").all(id, ORCHESTRATOR_RECIPIENT)
		.filter((m) => !(m.created_by === TEST_RUNNER_BY && m.body.startsWith(SECURITY_RED_PREFIX) && parseSecurityRed(m.body)?.workloadId === id));
	for (const m of held) ledger.advanceMessage(m.id, "delivered", { by: SURFACE_BY });
	return held;
}

/** The close's one line naming the messages delivered at close: at most HELD_LISTED listed, then `+K more: <ids>`; null for none. */
function heldDeliveredLine(held: MessageRow[]): string | null {
	if (held.length === 0) return null;
	const one = (m: MessageRow): string => {
		const body = m.body.replace(/\s+/g, " ").trim();
		return `${m.id} ${m.sender}: ${body.length > HELD_BODY_MAX ? `${body.slice(0, HELD_BODY_MAX - 1)}…` : body}`;
	};
	const listed = held.slice(0, HELD_LISTED).map(one);
	const rest = held.slice(HELD_LISTED);
	if (rest.length > 0) listed.push(`+${rest.length} more: ${rest.map((m) => m.id).join(" ")}`);
	return `held messages delivered at close (${held.length}): ${listed.join("; ")}`;
}

/**
 * Close one workload (decision 13): the close tool's body, shared with the wake tick's auto-close
 * of a workload awaiting close. Refused — nothing written — for the standing workload, a closed
 * one, a holder under a live lease, open or paused slices, open questions, or a done: line with no
 * standing `done-because:` from its holder — unless Jo superseded the workload (`supersede <A> <B>`,
 * surface/src/launch.ts `supersededBy`, PLAN wl-mv5i3lulwwbbi8 D2) or withdrew it (`withdraw <wl>`,
 * `withdrawnBy`, PLAN wl-mv8s939084z1ts D4), which stands in for the receipt and is named (with the
 * successor, for a supersede) in the close receipt the entry carries; superseded wins when both stand.
 * For a repo the test runner serves, the close check (PLAN § 2.4 item 4; surface/src/close-entry.ts
 * `closeCheck`) runs next and refuses — fails closed — unless every PR in the workload's set is green
 * at its head (or merged with a run Jo waived, D3) and the candidate wl/<id> tip is covered; for a
 * superseded or withdrawn workload, unless no PR in the set is open and no bound branch carries a
 * commit origin's default lacks. Its pin then binds the commit and the push, and a commit that fails or does not
 * sit on the pin refuses too. Otherwise the decision-log entry is rendered from the ledger and
 * committed on the workload's lane branch wl/<id> through `pi.exec` (never on the checkout's
 * current branch; surface/src/close-entry.ts), then the row closes, stamped
 * `orchestrator-surface`, in one transaction with the ledger's own live-holder check, the close
 * receipt, which the entry carries and the ledger holds only once the row closes, and the
 * delivery of the workload's ordinary held orchestrator-bound messages, which the result and
 * entry name; trusted security-red signals stay held for display (a refused or failed close leaves all held). A closed
 * workload's branch is then pushed and an open PR made sure of. Past the check and the pinned
 * commit, a git or gh failure is named in the result and never blocks the close. `cwd` is the
 * repository when the workload has no `repo:` entry. Never throws for a refusal.
 */
export async function closeWorkloadWithEntry(
	pi: SurfaceAPI, ledger: Ledger, env: Record<string, string | undefined>, id: string, o: { now: string; cwd: string; receipt: string | null },
): Promise<CloseOutcome> {
	const refused = (t: string): CloseOutcome => ({ closed: false, text: t, receipt: null });
	if (id === STANDING_WORKLOAD_ID) return refused("The standing orchestrator workload is never closed.");
	const w = ledger.workload(id);
	if (!w) return refused(`No workload ${id}.`);
	if (w.status === "closed") return refused(`${id} is already closed (${w.closed_at}).`);
	if (w.holder !== null && (w.holder_lease_until === null || w.holder_lease_until >= o.now)) {
		return refused(`${id} cannot close: held by ${w.holder} under a live lease; stop it first: \`as2 lane stop ${id}\``);
	}
	if (w.open_slices > 0 || w.paused_slices > 0 || w.open_questions > 0) {
		return refused(`${id} cannot close: ${w.open_slices} open slice(s), ${w.paused_slices} paused, ${w.open_questions} open question(s). Settle them first.`);
	}
	const scheduled = w.brief.startsWith(DUE_PREFIX);
	let done: string | null = null;
	// PLAN wl-mv5i3lulwwbbi8 D2, wl-mv8s939084z1ts D4: Jo's `supersede <A> <B>` or `withdraw <wl>` stands in for the holder's receipt (G3)
	// and swaps the close check for supersededFreshness; superseded wins when both stand (it names a successor).
	let standIn: StandIn | null = null;
	if (!scheduled) {
		const entries = ledger.entries(id, "assumption");
		const holders = holdersOf(entries, w.holder, ledger.holders(id));
		const line = doneLine(controlEntries(entries, holders));
		done = doneBecause(entries, holders);
		const instructions = ledger.instructions(id);
		standIn = standInOf(supersededBy(entries, instructions), withdrawnBy(entries, instructions));
		if (line !== null && done === null && standIn === null) {
			return refused(`${id} cannot close: no \`done-because:\` receipt from its holder against the done: line (${line}), or a later note by the lane or the surface supersedes it. The lane writes it with lane_record_entry before it releases.`);
		}
	}
	// The entry and the ledger's close receipt name the successor (D2) or the withdrawal (wl-mv8s939084z1ts D4).
	const said = standIn?.kind === "superseded"
		? `${standIn.label} (Jo, ${standIn.instructionId})`
		: standIn?.kind === "withdrawn" ? `withdrawn by Jo (${standIn.instructionId}): closed with no done-because: receipt` : null;
	const receipt = said ? `${said}${o.receipt ? `; ${o.receipt}` : ""}` : o.receipt;
	const repo = repoOf(ledger, id) ?? o.cwd;
	// MIGRATION.md item 24: a served repo's close needs a green at every PR head and on the candidate; it fails closed (decision 13's one exception).
	const check = scheduled ? null : await closeCheck(pi, ledger, env, id, repo, standIn);
	if (check?.served && !check.decision.close) return refused(`${id} cannot close: ${check.decision.reason}`);
	const checked = check?.served && check.decision.close ? check.decision.why : null;
	// Decision 13 as amended (M7 follow-ups 11, 12): the entry is committed on wl/<id>, this path only; a failed commit never blocks an unserved repo's close.
	// The receipt is rendered into the entry here and recorded only with the close below, so a refused close leaves no receipt (review r1, kimi note 1).
	const entry = scheduled ? null : await commitCloseEntry(pi, ledger, env, id, repo, check?.served ? check.pin : null, receipt);
	if (entry?.refused) return refused(`${id} cannot close: ${entry.refused}`);
	const commit = entry?.commit ?? null;
	// The close is one transaction with its checks (Codex review S2): a lane that reserved the workload while git ran keeps it.
	// Ordinary held orchestrator-bound messages deliver before close; trusted security-red signals retain display-owned delivery. A failed close rolls delivery back.
	let held: MessageRow[] = [];
	try {
		held = ledger.write(() => {
			if (receipt) recordCloseReceipt(ledger, id, receipt);
			const delivered = deliverHeldAtClose(ledger, id);
			ledger.closeWorkload(id, { by: SURFACE_BY });
			return delivered;
		});
	} catch (err) {
		const kept = entry ? ` The decision-log entry at ${entry.path} is rendered${commit === null ? ` and committed on ${entry.branch}` : ""}; it is re-rendered at the next close.` : "";
		return {
			closed: false, text: `${id} stays open: ${String(err instanceof Error ? err.message : err)}.${kept}`,
			details: { id, path: entry?.path ?? null, branch: entry?.branch ?? null, commit, closed: false }, receipt: done,
		};
	}
	// PLAN wl-mv5oikd5jtquww § 1.5 (amended 2026-10-28): the closed workload's scratch root is archived, then removed; an archive
	// that fails keeps the root. The done-because is passed so a deliverable it names inside the root is reported with its archive.
	const scratch = closeScratchRoot(ledger, env, id, { doneBecause: done });
	const pub: EntryPublish | null = entry && commit === null ? await publishEntry(pi, entry, id) : null;
	const details = { id, path: entry?.path ?? null, branch: entry?.branch ?? null, commit, push: pub?.push ?? null, pr: pub?.pr ?? null, prReason: pub?.prReason ?? null, check: checked };
	pi.appendEntry("surface-close", details);
	let tail = " (scheduled row: no decision-log entry)";
	if (entry && pub) {
		const pr = pub.pr ? `${pub.prCreated ? "PR opened" : "PR open"}: ${pub.pr}` : `no PR: ${pub.prReason}`;
		tail = ` Decision-log entry ${entry.path} ${entry.already ? "already committed" : "committed"} on ${entry.branch}; ${pub.push === null ? "pushed to origin" : `not pushed: ${pub.push}`}; ${pr}.`;
	} else if (entry) {
		tail = ` Decision-log entry rendered at ${entry.path}; not committed: ${commit} (the file is untracked; commit it on ${entry.branch} by hand).`;
	}
	if (entry?.notes.length) tail += ` Also: ${entry.notes.join("; ")}.`;
	if (checked !== null) tail += ` Close check: ${checked}.`;
	const scratchNote = scratch ? ` ${scratch}` : "";
	const heldLine = heldDeliveredLine(held);
	const heldNote = heldLine ? `\n${heldLine}` : "";
	return { closed: true, text: `Closed ${id}.${scratchNote}${tail}${heldNote}`, details, receipt: done ?? said, entry: `${tail.trim()}${scratchNote}${heldNote}` };
}

export default function workloadRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env, deps: WorkloadDeps = {}): void {
	const z = pi.zod;
	/**
	 * Size the brief for plan-first and the ceiling: the classifier's judge and question over the brief
	 * as one item. `judged` is the raw answer, null when no judge is wired, it failed or it answered
	 * malformed (planFirstTrigger fails that toward a plan at normal stakes); `entry` is the body
	 * recording the answer (the routings table needs a slice, which a workload brief has none of).
	 */
	const judgeSize = async (brief: string, ctx: Ctx): Promise<{ judged: JudgedSize | null; note: string; entry: string | null }> => {
		if (!deps.judge) return { judged: null, note: "plan-first size check skipped: no judge is wired into this surface.", entry: null };
		try {
			const c = await classify(brief, await deps.judge(ctx), loadKindQuestion());
			return {
				judged: { choice: c.choice, confidence: c.confidence },
				note: `brief judged ${c.choice} (confidence ${c.confidence.toFixed(2)}, ${c.judgeModel}).`,
				entry: `brief-judged: ${c.choice} confidence ${c.confidence.toFixed(2)} judge ${c.judgeModel}`,
			};
		} catch (err) {
			return { judged: null, note: `plan-first size check skipped: the judge was unavailable (${String(err).split("\n")[0]}); the brief was not sized.`, entry: null };
		}
	};

	pi.registerTool({
		name: IDENTITY_TOOL,
		loadMode: "essential",
		label: "Record Orchestrator Identity",
		description: "First wake only (or a rename): record your chosen name and pronouns as one ledger entry. Hands and lanes do not name themselves.",
		parameters: z.object({
			name: z.string().describe("Your name."),
			pronouns: z.string().describe("Your pronouns, e.g. they/them."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const before = identityOf(s.ledger());
			const id = recordIdentity(s.ledger(), String(params.name ?? ""), String(params.pronouns ?? ""));
			return text(`${before ? `Renamed from ${before.name} (${before.pronouns}) to` : "You are now"} ${id.name} (${id.pronouns}); entry ${id.entryId} on ${STANDING_WORKLOAD_ID}.`, id);
		},
	});

	pi.registerTool({
		name: OPEN_WORKLOAD_TOOL,
		loadMode: "essential",
		label: "Open Workload",
		description:
			"Open a workload from what Jo said. Stakes (throwaway/normal/production) and mode (autonomous/user-driven) are inferred and shown; pass them only to override. " +
			"`done` is required: one sentence, what is true when this workload is over, inferred from Jo's words — when you cannot infer it, ask Jo first (a plain reply, no workload) and open afterwards. " +
			"Plan-first (the lane's first slice is the plan) is the default at normal stakes: it is skipped only when the brief is judged change-small at 0.9 or higher, or when Jo says no plan (pass `plan: \"none\"`; an unquoted 'no plan' in the brief counts too). " +
			"Production stakes are always plan-first; Jo's 'plan it' (or `plan: \"first\"`) sets it and wins over no plan; at throwaway stakes only a brief judged a large change is plan-first. " +
			"An autonomous workload's lane is launched here; a user-driven one gets its by-hand command. " +
			"`model` (Jo's word only) names the model the workload's lanes run on, kept across relaunches: an exact `provider/model` (e.g. `openai-codex/gpt-6-sol`) on a provider with a known lab, no `:level` suffix; a bad value opens nothing. " +
			"Intake queue: while started-but-idle workloads outnumber the lane slots the ask is opened queued and the result says `queued, position N of M` (Jev rank order among queued asks); tell Jo that position. " +
			"`intake: \"queue\"` queues the ask whatever the count; `intake: \"now\"` with `inputId` (Jo's unspent input row) opens past the cap and spends that input, and without one opens nothing. " +
			"Returns the id, the one-liner, the launch line, and the repository's decision-log entries newer than the last 2.0 workload on it.",
		parameters: z.object({
			brief: z.string().describe("What Jo said, as the workload brief."),
			done: z.string().optional().describe("One sentence: what is true when this workload is over. Required; ask Jo when you cannot infer it."),
			repo: z.string().optional().describe("Absolute path of the target repository. Default: the session's cwd."),
			branch: z.string().optional().describe("Target branch, when known."),
			reservedTarget: z.string().optional().describe("'yes' when the work names a reserved target (protected-branch push, deploy, spend)."),
			stakes: z.string().optional().describe("Override: throwaway | normal | production."),
			mode: z.string().optional().describe("Override: autonomous | user-driven."),
			plan: z.string().optional().describe("'first' to require a plan slice before any change slice (Jo's word); 'none' when Jo said no plan (not at production stakes)."),
			model: z.string().optional().describe("Jo's named model for the lanes: exact provider/model (e.g. openai-codex/gpt-6-sol), no :level. Omit for the profile default."),
			intake: z.string().optional().describe("'queue' to put the ask in the intake queue whatever the count; 'now' (Jo's word, with inputId) to open past the intake cap. Omit for the cap rule."),
			inputId: z.string().optional().describe("With intake 'now': the input row (in-…) the surface named for Jo's words; spent once."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const brief = String(params.brief ?? "").trim();
			if (!brief) return text("A workload needs a brief; nothing was opened.");
			const done = String(params.done ?? "").trim().replace(/\s*\n\s*/g, " ");
			if (!done) {
				return text("A workload states its outcome: pass `done` — one sentence, what is true when this workload is over. When Jo's words do not say, ask Jo first (a plain reply) and open once they answer. Nothing was opened.");
			}
			const model = typeof params.model === "string" ? params.model.trim() : null;
			const problem = model === null ? null : modelProblem(model);
			if (problem !== null) return text(`Refused: ${problem}. Nothing was opened.`);
			// The intake queue (PLAN wl-mvbcjadqgblr7k D3): `queue` queues whatever the count; `now` opens past the cap only on Jo's unspent input.
			const intake = typeof params.intake === "string" ? params.intake.trim().toLowerCase() : "";
			const inputId = typeof params.inputId === "string" ? params.inputId.trim() : "";
			if (intake !== "" && intake !== "queue" && intake !== "now") return text(`Refused: intake is queue or now, not ${intake}. Nothing was opened.`);
			if (inputId && intake !== "now") return text("Refused: inputId spends Jo's input on intake now, and intake now was not given. Nothing was opened.");
			const ledger = s.ledger();
			let inputSlice: string | null = null;
			if (intake === "now") {
				if (!inputId) return text("Refused: intake now opens past the intake cap on Jo's word: pass inputId, the input row the surface named for his words (`Jo's words above are input in-…`). Nothing was opened.");
				const input = joInput(ledger, inputId);
				if (!input) return text(`Refused: ${inputId} is not an input Jo typed at the surface. Nothing was opened.`);
				const spent = inputSpent(ledger, inputId);
				if (spent) return text(`Refused: ${inputId} already ${spent.startsWith("q-") ? "answered" : "instructed"} ${spent}, and one input is recorded once. Nothing was opened.`);
				inputSlice = input.slice_id;
			}
			const repo = typeof params.repo === "string" && params.repo ? params.repo : ctx.cwd;
			const stakes = inferStakes({ said: brief, repo, branch: typeof params.branch === "string" ? params.branch : null, reservedTarget: /^(yes|true|1)$/i.test(String(params.reservedTarget ?? "")) });
			const mode = inferMode(brief);
			const stakesOverride = (STAKES_WORDS as readonly string[]).includes(String(params.stakes)) ? (String(params.stakes) as (typeof STAKES_WORDS)[number]) : null;
			const modeOverride = (MODE_WORDS as readonly string[]).includes(String(params.mode)) ? (String(params.mode) as (typeof MODE_WORDS)[number]) : null;
			const finalStakes = stakesOverride ?? stakes.value;
			// Plan-first trigger (decision 15, MIGRATION.md item 42): production always; Jo's plan word; Jo's "no plan"; else the judge (normal: plan-first unless change-small ≥ 0.9; throwaway: only a large change).
			const planWord = String(params.plan ?? "").trim().toLowerCase();
			const saidPlan = saidPlanIt(brief) || planWord === "first";
			// The judge is skipped for production and Jo's plan word, as before; on "no plan" it still runs, so the ceiling follows the judgment (DESIGN-workload-ceiling.md § 1 B: ×3 only for a judged large change).
			const sized = finalStakes === "production" || saidPlan ? null : await judgeSize(brief, ctx);
			const noPlan = saidNoPlan(brief) ? "brief" : planWord === "none" ? "argument" : null;
			const plan = planFirstTrigger({ stakes: finalStakes, saidPlan, noPlan, judged: sized?.judged ?? null });
			const judgedKind = judgedLarge(sized?.judged ?? null) ? "change-large" : null;
			let opened: { id: string; queued: string | null };
			try {
				opened = ledger.write(() => {
					if (intake === "now") {
						const spentNow = inputSpent(ledger, inputId);
						if (spentNow) throw new InputSpent(`${inputId} was spent on ${spentNow} meanwhile`);
					}
					// D2: counted inside the open's own transaction, so two opens never both read the count before either writes.
					const cap = laneCap(env);
					const idle = intake === "" ? startedIdle(ledger, ledger.now()).length : 0;
					const queued = intake === "queue" ? "intake queue" : idle > cap ? `${idle} started-idle workloads over ${cap} lane slots` : null;
					const wl = ledger.openWorkload({ by: SURFACE_BY, brief, stakes: finalStakes, mode: modeOverride ?? mode.value });
					recordRepo(ledger, wl, repo);
					ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody(done) });
					if (plan.trigger !== null) ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody(plan.trigger) });
					if (sized?.entry) ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: sized.entry });
					ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: ceilingBody(sizeFor(finalStakes, judgedKind), stakesSource(finalStakes, judgedKind)) });
					if (model !== null) ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneModelBody(model, s.now()) });
					if (queued !== null) ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: queuedBody(queued) });
					if (intake === "now") {
						ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: inputSlice, kind: "assumption", body: readingBody("open past the intake cap", inputId, wl) });
					}
					return { id: wl, queued };
				});
			} catch (err) {
				if (err instanceof InputSpent) return text(`Refused: ${err.message}, and one input is recorded once. Nothing was opened.`);
				throw err;
			}
			const id = opened.id;
			const since = lastWorkloadOn(ledger, repo);
			const context = decisionLogContext(logDirOf(env, repo), { since });
			const row = ledger.workload(id)!;
			// Jev rank (PLAN wl-mv8k039gvogt8g D4): the new workload's signal is asked in the background and written on its own; a throwing or hanging judge never fails the open.
			let asked = false;
			const ask = askAtOpen(ledger, id, deps, ctx, (line) => process.stderr.write(`surface: ${line}\n`)).then(() => {
				asked = true;
			});
			// A queued ask (PLAN wl-mvbcjadqgblr7k D4) waits for that signal under one overall deadline, judge resolution included,
			// so its position is by rank; at the deadline the ask keeps running in the background. N is read after the wait and
			// before the launch trigger runs; a launch attempt made during the wait (a drain or the tick) ends the queued state.
			const intakeLines: string[] = [];
			let intakeDetail: { position: number; of: number } | { started: string } | null = null;
			if (opened.queued !== null) {
				const deadline = deps.askTimeoutMs ?? RANK_ASK_TIMEOUT_MS;
				let timer: Timer | undefined;
				await Promise.race([ask, new Promise<void>((resolve) => (timer = setTimeout(resolve, deadline)))]);
				clearTimeout(timer);
				const control = controlEntries(ledger.entries(id, "assumption"));
				const attempt = attempts(control).at(-1);
				if (attempt !== undefined) {
					const started = control.find((c) => c.id === attempt.entryId)!.body;
					intakeDetail = { started };
					intakeLines.push(`queued, then started at once: ${started}`);
				} else {
					const pos = queuePosition(ledger, id, ledger.now());
					if (pos !== null) {
						intakeDetail = { position: pos.position, of: pos.of };
						intakeLines.push(`queued, position ${pos.position} of ${pos.of} (rank order; moves as ranks change)`);
						if (pos.item.unscored !== undefined) {
							intakeLines.push(asked
								? `rank: unscored (${pos.item.unscored}); the position is unscored oldest-first among the queued asks.`
								: `rank: still unscored: the open-time Jev ask did not land within ${deadline / 1000}s; it keeps running and the position moves when it lands.`);
						}
					}
				}
			}
			const launch = intakeDetail !== null && "started" in intakeDetail ? { attempted: false, code: null, line: null } : await triggerLaunch(pi, ledger, env, id, "open");
			if (intakeDetail !== null && "position" in intakeDetail && launch.code === 0) intakeLines[0] += "; started at once into a free slot";
			const lines = [
				`Opened ${id} on ${repo}.`,
				...intakeLines,
				`done: ${done}`,
				oneLiner(ledger, row),
				`stakes ${stakesOverride ? `overridden to ${stakesOverride}` : `inferred ${stakes.value}: ${stakes.reason}`}; mode ${modeOverride ? `overridden to ${modeOverride}` : `inferred ${mode.value}: ${mode.reason}`}.`,
				...(sized ? [sized.note] : []),
				plan.note,
				...(model !== null ? [`lane model: ${model} (Jo's word; kept across relaunches).`] : []),
				...(launch.line ? [launch.line] : []),
				"",
				context || `No decision-log entries to carry (${since ? `none newer than ${since}` : `none in ${logDirOf(env, repo)} from the last 14 days`}).`,
			];
			pi.appendEntry("surface-open", { id, repo, stakes: row.stakes, mode: row.mode, planFirst: plan.trigger, launch: launch.line, intake: intakeDetail });
			return text(lines.join("\n"), { id, stakes: row.stakes, mode: row.mode, since, context, planFirst: plan.trigger, launch, intake: intakeDetail, queued: opened.queued });
		},
	});

	pi.registerTool({
		name: CLOSE_WORKLOAD_TOOL,
		loadMode: "essential",
		label: "Close Workload",
		description:
			"Close a workload: one decision-log entry is rendered from the ledger into the repository's .ai/decision-log/ (filename YYYY-MM-DD--HHMM--<your name>--<slug>.md) and committed on the workload's lane branch wl/<id> and pushed to its PR, then the row closes. " +
			"Refused while slices are open or paused, a question is open, a lane holds it under a live lease, or the holder has not written its `done-because:` receipt (unless Jo superseded or withdrew it). " +
			"For a repository the test runner serves, also refused when a PR of the workload is not green at its head, local wl/<id> carries code no green covers, or git or gh cannot answer. For a scheduled row, `receipt` is the receipt it closes with.",
		parameters: z.object({
			workloadId: z.string().describe("The workload id (wl-…)."),
			receipt: z.string().optional().describe("What closes it (a scheduled row's receipt, or a one-line summary); recorded as an instruction."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const receipt = typeof params.receipt === "string" && params.receipt.trim() ? params.receipt.trim() : null;
			const r = await closeWorkloadWithEntry(pi, s.ledger(), env, String(params.workloadId ?? ""), { now: s.now(), cwd: ctx.cwd, receipt });
			return text(r.text, r.details);
		},
	});

	pi.registerTool({
		name: SCHEDULE_TOOL,
		loadMode: "essential",
		label: "Schedule A Row",
		description: "Schedule something for a date: a workload of its own whose brief starts `due:<date>`; it is listed under needs-you at every wake once past due, until closed with a receipt.",
		parameters: z.object({
			due: z.string().describe("ISO date or datetime (e.g. 2026-11-01)."),
			text: z.string().describe("What to do when due, including the method pointer."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const due = String(params.due ?? "").trim();
			const what = String(params.text ?? "").trim();
			if (Number.isNaN(Date.parse(due)) || !what) return text("A scheduled row needs a parseable due date and a text; nothing was opened.");
			const id = s.ledger().openWorkload({ by: SURFACE_BY, brief: `${DUE_PREFIX}${due} ${what}`, stakes: "throwaway", mode: "autonomous" });
			return text(`Scheduled ${id}, due ${due}: ${what}`, { id, due });
		},
	});

	pi.registerTool({
		name: RECORD_INSTRUCTION_TOOL,
		loadMode: "essential",
		label: "Record Jo's Instruction",
		description:
			"When Jo's message answers a QUESTION you asked about an open workload, or instructs you about one, record it here before anything else, so a lane picking the workload up reads the decision from the ledger. " +
			"Jo's words are never a parameter: the surface writes what Jo typed as an input row and names it to you (`Jo's words above are input in-…`); pass that inputId with your one-line reading. With questionId (a question you raised with orchestrator_raise_question), the question row is answered with the input row's body and the instruction row goes on the workload the question is about, in one transaction; with workloadId alone, the instruction row goes on that workload with the input row's body. Your reading goes in its own entry either way. " +
			"An input is spent once; a message the surface gave no input id has no receipt and records nothing. A message that neither answers nor instructs (a question about your question, something unrelated) records nothing. Until the row exists, your next working call on the workload is refused (P-11 row 15).",
		parameters: z.object({
			workloadId: z.string().optional().describe("The open workload the instruction is about (wl-…); with questionId, the question's own subject when omitted."),
			reading: z.string().describe("Your one-line reading of what Jo decided, with the referent restored (e.g. \"use the drafted README line: <the line>\")."),
			questionId: z.string().optional().describe("The open question (q-…) you raised with orchestrator_raise_question that Jo's input answers."),
			inputId: z.string().describe("The input row (in-…) the surface named for Jo's words."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const id = String(params.workloadId ?? "").trim();
			const reading = String(params.reading ?? "").trim().replace(/\s*\n\s*/g, " ");
			const questionId = String(params.questionId ?? "").trim();
			const inputId = String(params.inputId ?? "").trim();
			if (!reading) return text("An instruction needs your one-line reading; nothing was recorded.");
			const ledger = s.ledger();
			/** Jo's input row, bound once: the refusal, or the row. */
			const receipt = (): InstructionRow | string => {
				if (!inputId) return `Jo's words are the input row the surface named (\`Jo's words above are input in-…\`): pass inputId, and when none was named there is no receipt`;
				const input = joInput(ledger, inputId);
				if (!input) return `${inputId} is not an input Jo typed at the surface`;
				const spent = inputSpent(ledger, inputId);
				if (spent) return `${inputId} already ${spent.startsWith("q-") ? "answered" : "instructed"} ${spent}, and one input is recorded once`;
				return input;
			};
			if (questionId) {
				// The answer path (MIGRATION.md item 105, fix round 1): the one write that touches the standing workload, through the
				// question row, with Jo's words read from the input row the surface wrote — never from this call's parameters.
				const q = ledger.question(questionId);
				if (!q || q.workload_id !== STANDING_WORKLOAD_ID) return text(`${questionId} is not a question you raised with orchestrator_raise_question; nothing was recorded.`);
				if (q.state !== "open") return text(`${questionId} is already ${q.state} (by ${q.resolved_by}); nothing was recorded.`);
				const input = receipt();
				if (typeof input === "string") return text(`${input}; nothing was recorded.`);
				if (input.created_at <= q.created_at) return text(`${inputId} was not typed after ${questionId} was raised, so it cannot answer it; nothing was recorded.`);
				const subject = questionSubject(ledger, questionId);
				if (id && id !== STANDING_WORKLOAD_ID && id !== subject) return text(subject ? `${questionId} is about ${subject}, not ${id}; nothing was recorded.` : `${questionId} has no subject workload: its answer is recorded on the question alone, not on ${id}; nothing was recorded.`);
				let answered: { answer: OrchestratorAnswer; reading: string };
				try {
					answered = ledger.write(() => {
						const answer = answerOrchestratorQuestion(ledger, q, { answer: input.body, mirrorBody: `Jo: "${input.body}" — reading: ${reading} (answers ${questionId})` });
						const entry = ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: q.slice_id, kind: "assumption", body: readingBody(reading, inputId, questionId) });
						return { answer, reading: entry };
					});
				} catch (err) {
					return text(`${err instanceof Error ? err.message : String(err)}; nothing was recorded.`);
				}
				const { answer: r, reading: entry } = answered;
				pi.appendEntry("surface-instruction", { id: r.answerId, workloadId: STANDING_WORKLOAD_ID, questionId, inputId, mirrorId: r.mirrorId, about: r.about });
				const mirror = r.mirrorId ? `; instruction ${r.mirrorId} on ${r.about} (author jo, channel surface): "${input.body}" — ${reading}` : "";
				return text(`Answered ${questionId} with Jo's input ${inputId} (answer ${r.answerId}, reading ${entry})${mirror}`, { id: r.answerId, questionId, inputId, workloadId: r.about, mirrorId: r.mirrorId, readingId: entry });
			}
			if (id === STANDING_WORKLOAD_ID) return text("Jo's instructions are recorded on the workload they are about, not the standing one (an answer to your own question names its questionId); nothing was recorded.");
			if (!id) return text("An instruction names the open workload it is about (wl-…), or the questionId it answers; nothing was recorded.");
			const w = ledger.workload(id);
			if (!w) return text(`No workload ${id}; nothing was recorded.`);
			if (w.status === "closed") return text(`${id} is closed (${w.closed_at}); nothing was recorded.`);
			const input = receipt();
			if (typeof input === "string") return text(`${input}; nothing was recorded.`);
			const recorded = ledger.write(() => {
				const row = ledger.recordInstruction({ by: SURFACE_BY, workloadId: id, body: `Jo: "${input.body}" — reading: ${reading}`, author: "jo", channel: "surface" });
				const entry = ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: input.slice_id, kind: "assumption", body: readingBody(reading, inputId, id) });
				return { row, entry };
			});
			pi.appendEntry("surface-instruction", { id: recorded.row, workloadId: id, inputId, readingId: recorded.entry });
			return text(`Recorded instruction ${recorded.row} on ${id} from Jo's input ${inputId} (author jo, channel surface; reading ${recorded.entry}): "${input.body}" — ${reading}`, { id: recorded.row, workloadId: id, inputId, readingId: recorded.entry });
		},
	});
}
