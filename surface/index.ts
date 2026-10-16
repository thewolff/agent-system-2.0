// The orchestrator surface (MIGRATION.md M5; SPEC-2.0.md § A1.2, § A3, § B3, § B7, § B13.1),
// loaded as one OMP extension beside the P-11 gates. Same layout as gates/: each row is its own file
// under extensions/ with pure modules under src/, so a profile lists either this file or the rows
// it wants, never both (a row loaded twice registers its handlers twice). Every row reads the role
// per session (surface/src/session.ts): only a top-level session with AGENT_SYSTEM_ROLE=orchestrator
// is a surface; lanes and hands get inert handlers — except the lane rows, which are the inverse:
// they write the lane-side signals the surface reads (claim/lease, death, leaked prompts, artifact
// outcomes; M5 fix round 1) and the lane's ledger tools (DESIGN-lane-launcher.md decision 4), and
// are inert on the orchestrator.
//
// Registration order is behaviour (OMP runs handlers in order): the input row reads Jo's one-word
// flip from the prompt and applies it first; the wake row's before_agent_start then renders the
// ledger (already reflecting the flip), injects the voice document and carries the receipt into the
// turn's context; the plan-path row then puts open plan questions' paths under the orchestrator's
// messages (PLAN wl-mv61a8dh4aeneo D3); the workload, launch, ceiling, question and rank rows only
// register tools (the rank row's `as2_rank` on every session, PLAN wl-mv8k039gvogt8g D4); the lane
// rows register last.
//
// This is the extension entry, so it is the one file here that may bare-import `@oh-my-pi/*`
// (loader rule, gates/src/host.ts): the plan-first size judge (decision 15) resolves through the
// host's judgment module and settings exactly as classifier/extension.ts does, lazily, so tests
// load the surface without the host on the module path and pass a stub judge instead.
import type { KindJudge } from "../classifier/src/classify";
import { type HostModules, hostSettings } from "../gates/src/host";
import ceilingRow from "./extensions/ceiling";
import laneRow from "./extensions/lane";
import laneToolsRow from "./extensions/lane-tools";
import launchRow from "./extensions/launch";
import planPathRow from "./extensions/plan-path";
import questionRow from "./extensions/question";
import rankRow from "./extensions/rank";
import surfaceInputRow from "./extensions/surface-input";
import wakeRow from "./extensions/wake";
import workloadRow, { type WorkloadDeps } from "./extensions/workload";
import { linkedApi } from "./src/linked-api";
import type { Ctx, ResultTextLoader, SurfaceAPI } from "./src/types";

export type { SurfaceAPI } from "./src/types";
export type SurfaceDeps = WorkloadDeps & { loadText?: ResultTextLoader };

/** Entry-relative lazy host import, as hostJudge below; no copied terminal layout. */
const hostText: ResultTextLoader = async () => (await import("@oh-my-pi/pi-tui")).Text;

/** OMP's `judge` role, resolved through the host's own modules (same entry-module rule as classifier/extension.ts). */
async function hostJudge(ctx: Ctx): Promise<KindJudge> {
	const [{ VERSION }, { Settings }, { lookup }, { resolveJudge }] = await Promise.all([
		import("@oh-my-pi/pi-utils/dirs"),
		import("@oh-my-pi/pi-coding-agent/config/settings"),
		import("@oh-my-pi/pi-coding-agent/config/registry"),
		import("@oh-my-pi/pi-coding-agent/judgment/index"),
	]);
	const host: HostModules = { version: VERSION, Settings, lookup } as HostModules;
	const settings = await hostSettings(host, ctx.cwd);
	return resolveJudge({ settings: settings as never, registry: ctx.modelRegistry as never }) as unknown as KindJudge;
}

export default function orchestratorSurface(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env, deps: SurfaceDeps = { judge: hostJudge }): Promise<void> {
	pi = linkedApi(pi);
	surfaceInputRow(pi, env);
	const textReady = wakeRow(pi, env, deps.loadText ?? hostText);
	planPathRow(pi, env);
	workloadRow(pi, env, deps);
	launchRow(pi, env);
	ceilingRow(pi, env);
	questionRow(pi, env);
	rankRow(pi, env, deps);
	laneRow(pi, env);
	laneToolsRow(pi, env);
	// OMP awaits extension factories before restoring tool displays. Registration above remains synchronous.
	return textReady;
}
