import { bashCommand } from "./exec";
import type { ToolCall } from "./types";

export type ErrorDisposition = "block" | "warn" | "dedupe";

/** Policy by failure type: execution remains hard-stopped; presenting a fallback is advisory. */
export const ERROR_DISPOSITIONS = {
	"reserved-execution": "block",
	"command-presentation": "warn",
	"duplicate-approval": "dedupe",
} as const satisfies Record<string, ErrorDisposition>;

export type ErrorType = keyof typeof ERROR_DISPOSITIONS;
export const dispositionOf = (type: ErrorType): ErrorDisposition => ERROR_DISPOSITIONS[type];

export interface FallbackAuthorization {
	operation: "delete";
	target: string;
}

const LITERAL_PATH_SOURCE = String.raw`(?:~\/|\/)[A-Za-z0-9._@%+,:=\/-]+`;
const REQUEST_PATH = new RegExp(LITERAL_PATH_SOURCE, "g");
const AFFIRMATIVE_DELETE = new RegExp(String.raw`^(?:please\s+)?(?:(?:fucking|just|kindly)\s+){0,2}(?:purge|delete|remove)\s+(${LITERAL_PATH_SOURCE})[.!]?$`, "i");
export function affirmativeDeleteRequest(text: string): boolean {
	if (/[\p{Cc}\p{Cf}]/u.test(text)) return false;
	const normalized = text.replace(/\s+/g, " ").trim();
	return AFFIRMATIVE_DELETE.test(normalized);
}

/** Explicit authority for one concrete delete action, optionally completed by a later pronoun-only either/or clause. */
const pronounExecute = /^(?:please\s+)?(?:(?:fucking|just|kindly)\s+){0,2}(?:do|execute|run|perform|purge|delete|remove)\s+(?:it|this|that)(?:\s+for\s+me)?\s*$/i;
export function fallbackAuthorization(text: string, trustedAction?: string): FallbackAuthorization | null {
	if (/[\p{Cc}\p{Cf}]/u.test(text)) return null;
	const normalized = text.replace(/\s+/g, " ").trim();
	if (/[?？"“”'‘’`]/u.test(normalized) || /\b(?:do not|don't|never|without|not authorized|not allow|cannot|can't|must not|should not|is not allowed)\b/i.test(normalized)) return null;
	const execute = String.raw`(?:please\s+)?(?:[a-z-]+\s+){0,3}(?:do|execute|run|perform|purge|delete|remove)\b[^,;!?]{0,64}`;
	const handoff = String.raw`(?:please\s+)?(?:give|provide|show|tell|hand)\b[^,;!?]{0,48}\b(?:command|script|steps?)\b[^,;!?]{0,32}`;
	const separator = String.raw`\s*,?\s*\b(?:or|otherwise)\b\s+`;
	const affirmative = new RegExp(`^${execute}${separator}${handoff}[.!]?$`, "i").test(normalized) || new RegExp(`^${handoff}${separator}${execute}[.!]?$`, "i").test(normalized);
	if (!affirmative) return null;
	const clauses = normalized.split(new RegExp(separator, "i"));
	const direct = clauses.find(affirmativeDeleteRequest);
	if (!direct && ((normalized.match(REQUEST_PATH) ?? []).length > 0 || !clauses.some((clause) => pronounExecute.test(clause.trim())))) return null;
	const action = direct ?? trustedAction;
	if (!action || !affirmativeDeleteRequest(action)) return null;
	const targets = (action.match(REQUEST_PATH) ?? []).map((target) => target.replace(/[.)]+$/, ""));
	return targets.length === 1 ? { operation: "delete", target: targets[0]! } : null;
}

export interface CommandFallback {
	command: string;
	status: "not completed";
	impact: string;
	reversal: string;
}

function rmTarget(command: string): string | null {
	if (/[\p{Cc}\p{Cf}]/u.test(command)) return null;
	const executable = command.replace(/\s+#.*$/, "");
	const m = new RegExp(String.raw`^\s*(?:command\s+|exec\s+)?rm\s+(?:-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*|-r\s+-f|-f\s+-r)\s+(?:--\s+)?(${LITERAL_PATH_SOURCE})\s*$`).exec(executable);
	return m?.[1] ?? null;
}

/** Exact user-facing fallback facts for a refused shell execution. */
export function reservedFallback(call: ToolCall, action: string): CommandFallback {
	if (call.toolName !== "bash") throw new Error(`command fallback is unavailable for ${call.toolName}: it has no runnable command representation`);
	const command = bashCommand(call.input).trim();
	const target = /rm -rf|recursive force-delete/i.test(action) ? rmTarget(command) : null;
	if (target) {
		return {
			command,
			status: "not completed",
			impact: `Permanently deletes ${target} and everything below it.`,
			reversal: `No direct undo; restore ${target} from a backup or snapshot.`,
		};
	}
	return {
		command,
		status: "not completed",
		impact: `Runs the reserved action: ${action}.`,
		reversal: "No automatic reversal is known; identify and verify a recovery path before running it.",
	};
}

export function fallbackApplies(authorization: FallbackAuthorization, call: ToolCall, action: string): boolean {
	if (call.toolName !== "bash" || authorization.operation !== "delete" || !/rm -rf|recursive force-delete/i.test(action)) return false;
	return rmTarget(bashCommand(call.input).trim()) === authorization.target;
}

export function blockerSummary(action: string): string {
	return `P-11 row 6 blocked execution because ${action} is a reserved action.`;
}

export function fallbackInstruction(fallback: CommandFallback, blocker: string): string {
	return [
		blocker,
		"The user already authorized command handoff if execution is blocked. Do not ask again and do not raise an approval question.",
		"Reply immediately with exactly one command fallback and state:",
		`Execution status: ${fallback.status}.`,
		`Impact: ${fallback.impact}`,
		`Reversal: ${fallback.reversal}`,
		"Command:",
		fallback.command,
	].join("\n");
}
