// plugins/index.ts — the one OMP extension entry for Jo's vendored plugins (plugins/VENDOR.md):
// i-have-audhd (the AuDHD writing core at session start, a warn-only Stop check whose findings reach
// the next turn) and ask-graham (a hidden "should we build this?" nudge at each agent start at
// intensity every-idea, and a once-per-turn Stop check for the verdict line, VENDOR.md C12).
//
// Orchestrator session only (AGENT_SYSTEM_ROLE=orchestrator, set by bin/as2). A lane is an
// `omp --mode rpc` session (surface/src/launch.ts laneArgv), so every runner prompt arrives as an
// rpc `input` and would get ask-graham's nudge (VENDOR.md clash C1), and a lane's reader is the
// orchestrator, not the person i-have-audhd writes for (C2). Hands have no role and load nothing.
// Listed last in profile/config.yml's extensions: OMP returns the first session_stop block, so the
// surface's and the gates' blocks come first (C3).

import askGrahamOmp from "./ask-graham/omp/ask-graham-omp.ts";
import iHaveAudhdOmp from "./i-have-audhd/omp/i-have-audhd-omp.ts";

type AskGrahamPi = Parameters<typeof askGrahamOmp>[0];
type IHaveAudhdPi = Parameters<typeof iHaveAudhdOmp>[0];

export interface PluginsDeps {
	/** The environment the role is read from (default process.env); ask-graham also reads XDG_CONFIG_HOME from it. */
	env?: Record<string, string | undefined>;
	/** ask-graham's home for its user config file (default os.homedir()). */
	home?: string;
}

export default function jowolffPlugins(pi: AskGrahamPi & IHaveAudhdPi, deps: PluginsDeps = {}): void {
	const env = deps.env ?? process.env;
	if (env.AGENT_SYSTEM_ROLE !== "orchestrator") return;
	iHaveAudhdOmp(pi);
	askGrahamOmp(pi, { env, home: deps.home });
}
