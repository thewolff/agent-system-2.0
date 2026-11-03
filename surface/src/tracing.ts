// The per-workload tracing switch (wl-mv65t5d34lts00 PLAN.md § 2): which omp processes export their
// OpenTelemetry spans to the local Phoenix, and with what env. One setting in the installed profile's
// config.yml,
//
//   observability:
//     phoenix: all            # all (shipped) | off | [wl-…, wl-…]
//     otel: { OTEL_…: value } # the env omp gets when the switch is on for it
//
// read at launch by the places that start omp: surface/scripts/lane.ts (lanes, both spawn sites), bin/as2
// (the orchestrator) and Jo's seat launcher (every other OMP seat), the last two through
// surface/scripts/tracing.ts. OMP reads the OTEL_* env itself (pi-coding-agent src/telemetry-export.ts
// initTelemetryExport); no profile key carries it.
//
// Off is not "unset": OMP fills unset or empty env names from dotenv files before telemetry starts
// (pi-utils src/env.ts), so a `.env` endpoint could turn an unselected lane back on. Off therefore
// strips every inherited OTEL_* name and sets OTEL_SDK_DISABLED=true, which initTelemetryExport
// honours before it reads any endpoint and no dotenv file replaces. On sets every name of the otel map
// plus OTEL_SDK_DISABLED=false, the service name and the resource attributes that join a span to its
// ledger rows. For the same reason an enabled setting whose otel map lacks a name of OTEL_REQUIRED, or
// carries it empty or outside the value shape, is off: OMP would fill that name from a dotenv file. A
// missing, unreadable or malformed setting is off and never fails a launch.
import { readFileSync } from "node:fs";

/** A name the otel map may set. */
export const OTEL_NAME = /^OTEL_[A-Z0-9_]+$/;
/** A value the otel map may set (PLAN § 2): no whitespace, quotes or shell metacharacters, so bin/as2 can pass it as one word. */
export const OTEL_VALUE = /^[A-Za-z0-9_./:=,@%+-]*$/;
/** A workload id as the ledger mints it. */
export const WORKLOAD_ID = /^wl-[a-z0-9]+$/;
/** A seat name as the seat launcher spells it (wren, plumb, lintel, …). */
export const SEAT_NAME = /^[a-z][a-z0-9-]*$/;
/**
 * The names an enabled setting must set, each non-empty and inside OTEL_VALUE: the names of profile/config.yml's
 * observability.otel template. OMP fills an unset or empty name from the project's dotenv files, so a setting
 * without one of them would let a workload repo's `.env` pick the endpoint or turn on prompt-content capture.
 */
export const OTEL_REQUIRED = [
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
	"OTEL_TRACES_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
] as const;

export type TracingScope = { role: "lane"; workloadId: string; laneId: string } | { role: "orchestrator" } | { role: "seat"; seat: string };

export interface TracingSetting {
	/** `off`, `all` (every lane, the orchestrator and every seat), or the workloads whose lanes are on (the orchestrator and seats stay off). */
	phoenix: "off" | "all" | string[];
	/** The env set on a process the switch covers; names and values already checked against OTEL_NAME and OTEL_VALUE. */
	otel: Record<string, string>;
}

/** The parsed setting (null: off) and one note per thing dropped or refused, for the runner log or as2's stderr. */
export interface TracingRead {
	setting: TracingSetting | null;
	notes: string[];
}

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The names of OTEL_REQUIRED that `otel` lacks, or carries empty or outside OTEL_VALUE. */
const unmetRequired = (otel: Record<string, string>): string[] =>
	OTEL_REQUIRED.filter((name) => {
		const value = Object.hasOwn(otel, name) ? otel[name] : undefined;
		return !value || !OTEL_VALUE.test(value);
	});

/**
 * The `observability:` value of a parsed config.yml (`Bun.YAML.parse`). Absent is off with no note. A block
 * that is not a mapping, a `phoenix` that is not off/all/a list of workload ids, or an `otel` that is not a
 * mapping is malformed: off, with a note. An otel name or value outside the allowed shape is dropped with a
 * note and the rest still applies, unless the setting is enabled and a name of OTEL_REQUIRED is then missing
 * or empty: the whole setting is off, with a note naming each such name.
 */
export function parseObservability(block: unknown): TracingRead {
	if (block === undefined || block === null) return { setting: null, notes: [] };
	if (!isMap(block)) return { setting: null, notes: ["observability is not a mapping; tracing off"] };
	const p = block.phoenix;
	let phoenix: TracingSetting["phoenix"];
	if (p === undefined || p === null || p === "off") phoenix = "off";
	else if (p === "all") phoenix = "all";
	else if (Array.isArray(p) && p.every((id) => typeof id === "string" && WORKLOAD_ID.test(id))) phoenix = [...new Set(p as string[])];
	else return { setting: null, notes: [`observability.phoenix is ${JSON.stringify(p)}, not off, all or a list of workload ids; tracing off`] };
	const notes: string[] = [];
	const otel: Record<string, string> = {};
	if (block.otel !== undefined && block.otel !== null) {
		if (!isMap(block.otel)) return { setting: null, notes: ["observability.otel is not a mapping; tracing off"] };
		for (const [name, raw] of Object.entries(block.otel)) {
			const value = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : null;
			if (!OTEL_NAME.test(name)) notes.push(`observability.otel: name ${JSON.stringify(name)} dropped (not OTEL_[A-Z0-9_]+)`);
			else if (value === null || !OTEL_VALUE.test(value)) notes.push(`observability.otel.${name}: value dropped (outside ${OTEL_VALUE.source})`);
			else otel[name] = value;
		}
	}
	if (phoenix !== "off") {
		const unmet = unmetRequired(otel);
		if (unmet.length) return { setting: null, notes: [...notes, ...unmet.map((name) => `observability.otel.${name} is missing, empty or dropped; tracing off`)] };
	}
	return { setting: { phoenix, otel }, notes };
}

/** The setting in the config.yml at `path`. An unreadable or unparseable file is off with a note; it never throws. */
export function readTracingSetting(path: string): TracingRead {
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(readFileSync(path, "utf8"));
	} catch (err) {
		return { setting: null, notes: [`${path} could not be read (${String(err instanceof Error ? err.message : err).split("\n")[0]}); tracing off`] };
	}
	return parseObservability(isMap(doc) ? doc.observability : undefined);
}

/** Is the switch on for this process: `all` covers every lane, the orchestrator and every seat; a list covers the lanes of its workloads only. */
export function tracingCovers(setting: TracingSetting | null, scope: TracingScope): boolean {
	if (setting === null || setting.phoenix === "off") return false;
	if (setting.phoenix === "all") return true;
	return scope.role === "lane" && setting.phoenix.includes(scope.workloadId);
}

/**
 * The env an omp process starts with: `base` without any OTEL_* name, then off (`OTEL_SDK_DISABLED=true`) or,
 * when the switch covers `scope`, the otel map, `OTEL_SDK_DISABLED=false`, the service name and
 * `OTEL_RESOURCE_ATTRIBUTES=openinference.project.name=…,as2.role=…[,…]`. Phoenix 20.3.0 keeps only
 * `openinference.project.name` of a span's resource (phoenix/utilities/project.py get_project_name) and files the
 * span under that project, so the project name is the one attribute that reaches the UI: `as2-<workload>` for a lane
 * (its hands share it), `as2-orchestrator` for the orchestrator, `seat-<name>` for a seat. A name or value outside
 * the allowed shape is never set, whoever built the setting, and a setting without every name of OTEL_REQUIRED set
 * inside the shape is off.
 */
export function tracingEnv(base: Record<string, string | undefined>, setting: TracingSetting | null, scope: TracingScope): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(base)) if (v !== undefined && !k.startsWith("OTEL_")) out[k] = v;
	if (setting === null || !tracingCovers(setting, scope) || unmetRequired(setting.otel).length) {
		out.OTEL_SDK_DISABLED = "true";
		return out;
	}
	for (const [k, v] of Object.entries(setting.otel)) if (OTEL_NAME.test(k) && OTEL_VALUE.test(v)) out[k] = v;
	const [project, service, scoped]: [string, string, string[]] =
		scope.role === "lane"
			? [`as2-${scope.workloadId}`, "as2-lane", [`as2.workload=${scope.workloadId}`, `as2.lane=${scope.laneId}`]]
			: scope.role === "seat"
				? [`seat-${scope.seat}`, "omp-seat", [`as2.seat=${scope.seat}`]]
				: ["as2-orchestrator", "as2-orchestrator", []];
	const attrs = [`openinference.project.name=${project}`, `as2.role=${scope.role}`, ...scoped];
	out.OTEL_SDK_DISABLED = "false";
	out.OTEL_SERVICE_NAME = service;
	// The ids come from the ledger; one outside the value shape leaves the attribute out rather than corrupt the list.
	out.OTEL_RESOURCE_ATTRIBUTES = attrs.filter((a) => OTEL_VALUE.test(a)).join(",");
	return out;
}

/** The setting's value as config.yml spells it: `off`, `all`, or a one-line flow list. */
export const phoenixText = (p: TracingSetting["phoenix"]): string => (Array.isArray(p) ? `[${p.join(", ")}]` : p);
