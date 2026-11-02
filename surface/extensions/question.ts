// The orchestrator's question to Jo as a ledger row (MIGRATION.md item 105; surface/src/orchestrator-question.ts).
// The tool writes the `questions` row on the standing slice before the closing ask is rendered,
// and returns the id the block must name: P-11 row 15 (gates/src/rows/r15-orchestrator-role.ts)
// refuses the reply that publishes a closing ask naming no open row, and the orchestrator's next
// working call while the row is open. The subject workload (the one the ask is about, which Jo's
// answer is mirrored onto) is a surface-written entry keyed by the question id, never the body
// (Codex review of PR #55, S1). Jo answers by id at the surface (`<option> q-…`, `withdraw q-…`)
// or in prose, which the orchestrator records with orchestrator_record_instruction naming the
// question and the input row the surface wrote for Jo's words (surface/extensions/workload.ts).
// Jo's standing rulings are checked first (gates/src/rulings.ts `askJo`): a question one of them decides is not raised, and the tool returns the ruling and what to do instead, with no id for a closing ask.
// `now` (one of NOW_CATEGORIES, PLAN wl-mvg1vs0rhnu3gg § 1.0) skips the rulings and reaches Jo at once; any other word is refused with nothing written.
// An ask repeating an open question about the same workload returns that id, reused, with no second subject entry; a body naming
// another workload's open question is a relay and is refused with nothing written (§ 3.5). A reused id an earlier reply already
// published (row 15's `question-published:` record) is in front of Jo: row 15 refuses a second closing ask naming it, so the
// reply says not to publish one (fix round 1, F2); a reused id never published is named in the closing ask as a new one is.
import { publishedQuestionIds } from "../../gates/src/rows/r15-orchestrator-role";
import { decidedText, installedReviewModel, isNowCategory, MODEL_SUBJECTS, type ModelSubject, NOW_CATEGORIES, type NowCategory, nowMarks, subjectProblem } from "../../gates/src/rulings";
import { raiseOrchestratorQuestion, relayedQuestion, relayRefusal, reservedQuestionBody } from "../src/orchestrator-question";
import { surfaceSession } from "../src/session";
import { RAISE_QUESTION_TOOL, STANDING_WORKLOAD_ID, type SurfaceAPI, type ToolResult } from "../src/types";

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });
const inactive = text("This session is not the orchestrator surface; nothing was written.");

export default function questionRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	const z = pi.zod;
	pi.registerTool({
		name: RAISE_QUESTION_TOOL,
		loadMode: "essential",
		label: "Ask Jo",
		description:
			"Before any closing ask to Jo, raise the question here: it becomes a ledger row on your standing slice, so Jo can answer it by id, the needs-you lines show it, and a restart re-renders it. " +
			"Put the returned q-… id in the closing ask (e.g. `**Closing ask**\\n(q-…) Should …? Options: a / b`). A closing ask naming no such row leaves your next working call refused (P-11 row 15). " +
			"Name the open workload the ask is about: Jo's answer is mirrored there as an instruction row, where its lanes read it. " +
			"Jo's standing rulings are checked first: a question one of them already answers is not raised, and the tool returns the ruling and what to do instead. " +
			"When every option is a provider/model id, `subject` says what the model is for (lane-model or review-model); otherwise it is left out. " +
			`\`now\` (one of ${NOW_CATEGORIES.join(", ")}) puts the question before Jo at once, past every ruling: a credible data-integrity or security risk or an urgent incident, weakening a guard or crossing a boundary Jo stated, or an irreversible effect or money commitment no plan authorizes. ` +
			"Asking an open question again returns its id; never relay a question already on Jo's needs-you list by naming its q-… id.",
		parameters: z.object({
			body: z.string().describe("The question, in plain words, with the referent restored (no `this`/`that`)."),
			options: z.array(z.string()).describe("At least two answers Jo can give in one word each; recommend one in the body."),
			about: z.string().optional().describe("The open workload the ask is about (wl-…), when there is one; Jo's answer is mirrored onto it."),
			subject: z
				.enum(MODEL_SUBJECTS)
				.optional()
				.describe("Required when every option is a provider/model id: lane-model (the model a lane runs on) or review-model (the model a review runs on)."),
			now: z.enum(NOW_CATEGORIES).optional().describe("Only when Jo must hear it at once: the category of the now trigger."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const body = String(params.body ?? "").trim().replace(/\s*\n\s*/g, " ");
			const options = Array.isArray(params.options) ? params.options.map((x) => String(x).trim()).filter((x) => x.length > 0) : [];
			const about = typeof params.about === "string" && params.about.trim() ? params.about.trim() : null;
			if (!body) return text("A question needs a body; nothing was asked.");
			if (reservedQuestionBody(body)) return text("A question's body is its text alone: name the workload it is about in `about`, never as an `about wl-…:` prefix. Nothing was asked.");
			if (new Set(options.map((x) => x.toLowerCase())).size < 2) return text("A question offers at least two distinct options Jo can answer with; nothing was asked.");
			if (options.some((x) => /\s/.test(x))) return text("Each option is one word (Jo answers with it alone or as `<option> q-…`); nothing was asked.");
			const subject = typeof params.subject === "string" && params.subject !== "" ? params.subject : null;
			const subjectWrong = subjectProblem(options, subject);
			if (subjectWrong !== null) return text(`${subjectWrong}; nothing was asked.`);
			const nowWord = typeof params.now === "string" && params.now.trim() !== "" ? params.now.trim() : null;
			if (nowWord !== null && !isNowCategory(nowWord)) return text(`\`now\` is one of ${NOW_CATEGORIES.join(", ")}, not ${nowWord}; nothing was asked.`);
			const now: NowCategory | null = nowWord;
			const ledger = s.ledger();
			const relayed = relayedQuestion(ledger, body);
			if (relayed !== null) return text(relayRefusal(relayed), { relayed });
			if (about !== null) {
				if (about === STANDING_WORKLOAD_ID) return text("The standing workload is never a question's subject; name the workload the ask is about, or none. Nothing was asked.");
				if (!/^wl-[a-z0-9]+$/.test(about)) return text(`${about} is not a workload id (wl-…); nothing was asked.`);
				const w = ledger.workload(about);
				if (!w) return text(`No workload ${about}; nothing was asked.`);
				if (w.status === "closed") return text(`${about} is closed (${w.closed_at}); a question is about an open workload, or none. Nothing was asked.`);
			}
			const asked = raiseOrchestratorQuestion(ledger, { body, options, about, subject: subject as ModelSubject | null, now }, () => installedReviewModel(env));
			if ("decided" in asked) return text(`${decidedText(asked.decided)}.`, { ruling: asked.decided.ruling, answer: asked.decided.answer, about });
			const id = asked.raised;
			const mark = nowMarks(ledger.entries(STANDING_WORKLOAD_ID, "assumption")).get(id) ?? null;
			const nowNote = mark === null ? "" : ` It reaches Jo at once, marked NOW (${mark}).`;
			const answers = `Jo answers with \`<option> ${id}\` or \`withdraw ${id}\`, or in prose you record with orchestrator_record_instruction naming questionId ${id} and the inputId the surface gives Jo's words.`;
			if ("reused" in asked) {
				const reused = `Question ${id}${about ? ` about ${about}` : ""} is already open with this body and options; nothing new was raised.${nowNote}`;
				if (publishedQuestionIds(ledger).has(id)) {
					return text(
						`${reused} An earlier reply already put ${id} in front of Jo: send no new closing ask for it (P-11 row 15 holds a reply that asks a row twice); if you mention it, name ${id} in plain words. ${answers}`,
						{ id, about, options, reused: true, published: true, now: mark },
					);
				}
				return text(`${reused} Name ${id} in your closing ask. ${answers}`, { id, about, options, reused: true, published: false, now: mark });
			}
			pi.appendEntry("surface-question", { id, about });
			return text(`Raised question ${id}${about ? ` about ${about}` : ""} (${options.join(" / ")}); name ${id} in your closing ask.${nowNote} ${answers}`, { id, about, options, now: mark });
		},
	});
}
