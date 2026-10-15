// The orchestrator's question to Jo as a ledger row (MIGRATION.md item 105; surface/src/orchestrator-question.ts).
// The tool writes the `questions` row on the standing slice before the QUESTION block is rendered,
// and returns the id the block must name: P-11 row 15 (gates/src/rows/r15-orchestrator-role.ts)
// refuses the reply that publishes a QUESTION naming no open row, and the orchestrator's next
// working call while the row is open. The subject workload (the one the ask is about, which Jo's
// answer is mirrored onto) is a surface-written entry keyed by the question id, never the body
// (Codex review of PR #55, S1). Jo answers by id at the surface (`<option> q-…`, `withdraw q-…`)
// or in prose, which the orchestrator records with orchestrator_record_instruction naming the
// question and the input row the surface wrote for Jo's words (surface/extensions/workload.ts).
// A question offering approve, accept or extend is linked (PLAN wl-mv66q5b148uznk § Question kinds): it must
// name `about`, and its body must start with the link header computed for that workload (`linkProblem`):
// the plan file, every reviewed slice's newest round's verdict files (labelled), the open PRs. The header
// lines stay lines; the rest of the body is flattened to one line, as every body is.
import { raiseOrchestratorQuestion, reservedQuestionBody } from "../src/orchestrator-question";
import { type Exec, isLinkedQuestion, type Links, linkProblem, linksAtRaise } from "../src/question-links";
import { surfaceSession } from "../src/session";
import { RAISE_QUESTION_TOOL, STANDING_WORKLOAD_ID, SURFACE_BY, type SurfaceAPI, type ToolResult } from "../src/types";

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });
const inactive = text("This session is not the orchestrator surface; nothing was written.");
/** A header line `linkHeader` writes (`plan:`, `review:`, `review (sl-…, round n):`, `pr:`), as `linkProblem` reads one. */
const LINK_LINE = /^(plan|review|pr)(\s\([^)]*\))?:/;

/** A linked question's body: its leading link lines kept as lines, the rest flattened to one line; any other body flattened whole. */
function questionBody(raw: string, linked: boolean): string {
	const lines = raw.trim().split("\n");
	let n = 0;
	while (linked && n < lines.length && LINK_LINE.test(lines[n]!.trim())) n++;
	const rest = lines.slice(n).join("\n").trim().replace(/\s*\n\s*/g, " ");
	return [...lines.slice(0, n).map((l) => l.trim()), ...(rest ? [rest] : [])].join("\n");
}

export default function questionRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	const z = pi.zod;
	pi.registerTool({
		name: RAISE_QUESTION_TOOL,
		loadMode: "essential",
		label: "Ask Jo",
		description:
			"Before any **QUESTION** block to Jo, raise the question here: it becomes a ledger row on your standing slice, so Jo can answer it by id, the needs-you lines show it, and a restart re-renders it. " +
			"Put the returned q-… id in the QUESTION block (e.g. `**QUESTION**\\n(q-…) Should …? Options: a / b`). A QUESTION block naming no such row leaves your next working call refused (P-11 row 15). " +
			"Name the open workload the ask is about: Jo's answer is mirrored there as an instruction row, where its lanes read it. " +
			"A question offering approve, accept or extend must name `about` and start with its link lines (plan, review, pr), computed from the ledger; a body without them is refused with the exact lines to paste.",
		parameters: z.object({
			body: z.string().describe("The question, in plain words, with the referent restored (no `this`/`that`); a linked question's link lines first, one per line."),
			options: z.array(z.string()).describe("At least two answers Jo can give in one word each; recommend one in the body."),
			about: z.string().optional().describe("The open workload the ask is about (wl-…), when there is one; Jo's answer is mirrored onto it."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const options = Array.isArray(params.options) ? params.options.map((x) => String(x).trim()).filter((x) => x.length > 0) : [];
			const linked = isLinkedQuestion(options);
			const body = questionBody(String(params.body ?? ""), linked);
			const about = typeof params.about === "string" && params.about.trim() ? params.about.trim() : null;
			if (!body) return text("A question needs a body; nothing was asked.");
			// A linked body's link lines are held to the computed header below; its question text is the last line.
			if (reservedQuestionBody(body.split("\n").at(-1)!)) return text("A question's body is its text alone: name the workload it is about in `about`, never as an `about wl-…:` prefix. Nothing was asked.");
			if (new Set(options.map((x) => x.toLowerCase())).size < 2) return text("A question offers at least two distinct options Jo can answer with; nothing was asked.");
			if (options.some((x) => /\s/.test(x))) return text("Each option is one word (Jo answers with it alone or as `<option> q-…`); nothing was asked.");
			if (linked && about === null) {
				return text("A question offering approve, accept or extend is about a workload: name it in `about` (open one first when there is none), and start the body with the link lines the refusal then prints. Nothing was asked.");
			}
			const ledger = s.ledger();
			if (about !== null) {
				if (about === STANDING_WORKLOAD_ID) return text("The standing workload is never a question's subject; name the workload the ask is about, or none. Nothing was asked.");
				if (!/^wl-[a-z0-9]+$/.test(about)) return text(`${about} is not a workload id (wl-…); nothing was asked.`);
				const w = ledger.workload(about);
				if (!w) return text(`No workload ${about}; nothing was asked.`);
				if (w.status === "closed") return text(`${about} is closed (${w.closed_at}); a question is about an open workload, or none. Nothing was asked.`);
			}
			let links: Links | null = null;
			if (linked && about !== null) {
				// OMP's runner for the PR read; a host without one fails the read, so the question is refused (retry), never asked unlinked.
				const exec: Exec = pi.exec ? pi.exec.bind(pi) : () => Promise.reject(new Error("the host has no exec for extensions"));
				try {
					links = await linksAtRaise(exec, ledger, { workloadId: about, sliceId: null, by: SURFACE_BY });
				} catch (error) {
					return text(`The question links could not be prepared (${error instanceof Error ? error.message : String(error)}); retry after the ledger or verdict files are available. Nothing was asked.`);
				}
				const problem = linkProblem(body, links);
				if (problem !== null) return text(`${problem}. Nothing was asked.`);
			}
			const id = raiseOrchestratorQuestion(ledger, { body, options, about, links });
			pi.appendEntry("surface-question", { id, about });
			return text(`Raised question ${id}${about ? ` about ${about}` : ""} (${options.join(" / ")}); name ${id} in your QUESTION block. Jo answers with \`<option> ${id}\` or \`withdraw ${id}\`, or in prose you record with orchestrator_record_instruction naming questionId ${id} and the inputId the surface gives Jo's words.`, { id, about, options });
		},
	});
}
