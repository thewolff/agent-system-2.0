// The issues switch (PLAN wl-mv66ylim0gahog § 7), in wl-mv654hoqwpfhmo's registry shape from the
// start: an `assumption` entry on wl-orchestrator by the surface, `switch: issues on|off
// orchestrator by <in-id>`, written with the Jo instruction row it cites. The newest such entry is
// the state; none means off. When the registry lands it reads these same entries.
import type { EntryRow, Ledger } from "../../../ledger/src/index";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../types";

const SWITCH_RE = /^switch: issues (on|off) orchestrator by (in-\S+)$/;

/** `switch: issues on|off orchestrator by <in-id>`: the body the `issues on` / `issues off` word records. */
export function switchBody(on: boolean, instructionId: string): string {
	if (!/^in-\S+$/.test(instructionId)) throw new Error(`${instructionId} is not an instruction id`);
	return `switch: issues ${on ? "on" : "off"} orchestrator by ${instructionId}`;
}

export interface SwitchState {
	on: boolean;
	/** The newest switch entry, or null when there is none (off). */
	entryId: string | null;
	/** Its `created_at`: for an `on`, intake's cutoff when it seeds (§ 3). */
	at: string | null;
	instructionId: string | null;
}

/** The switch as the newest valid entry among `entries` (wl-orchestrator's, oldest first) says. */
export function switchOf(entries: readonly EntryRow[]): SwitchState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.kind !== "assumption" || e.created_by !== SURFACE_BY) continue;
		const m = SWITCH_RE.exec(e.body.trim());
		if (m) return { on: m[1] === "on", entryId: e.id, at: e.created_at, instructionId: m[2]! };
	}
	return { on: false, entryId: null, at: null, instructionId: null };
}

/** The switch now, read from the ledger. */
export function readSwitch(ledger: Ledger): SwitchState {
	return switchOf(ledger.entries(STANDING_WORKLOAD_ID, "assumption"));
}
