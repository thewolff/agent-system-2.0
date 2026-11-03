// The chaos run's stub provider and refusing proxy (the approved plan of workload wl-mv45yxnkw2251c,
// revision 4: § 2.1 "Stub provider", "Every role routed", "Egress proxy (enforcing)", § 2.3, § 2.4
// fault 4), driven through the installed omp in a scratch HOME so nothing reaches a real provider:
//   (1) `omp -p` on routed models of three providers (anthropic, openai-codex, moonshot) gets the
//       stub's nonce reply, after a tool turn the stub scripted;
//   (2) one classification through OMP's own judge client (openStandaloneJudge → TypeSafeJudge) reaches
//       the stub's /v1/systemone and decodes, and the stub's log names the entry it served;
//   (3) refuse mode surfaces as omp's prompt error `Refusal (cyber): …` with retryable false;
//   (4) an un-routed real model id is sent to the proxy, refused there, and never answered.
// Plus the stub's stall / blackhole / reset mechanics in-process, and the proxy's parsing.
// Skipped when omp is not on PATH. Keys are the literal chaos-stub and fake strings; no credential is read.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseHead, type Proxy, startProxy } from "../scripts/chaos-proxy";
import { installedRoleIds, ROLE_IDS, REFUSAL_EXPLANATION, type Stub, type StubProfile, type StubScript, startStub, writeStubProfile } from "../scripts/chaos-stub";

const REPO = join(import.meta.dir, "..", "..");
const STUB_SCRIPT = join(REPO, "surface", "scripts", "chaos-stub.ts");
const OMP = Bun.which("omp");
const BUN = process.execPath;
const PROFILE = "chaos-test";
const NONCE = `chaos-${Date.now().toString(36)}`;
const CHAT = "anthropic/claude-haiku-5-5";
const PROBE_TOOL_OUT = "chaos-tool-ok";

/** One scripted kind: a bash tool turn, then a text reply. Every request matches it. */
const PROBE: StubScript = {
	kind: "probe",
	match: () => true,
	steps: [{ text: "running the probe", tool: { name: "bash", input: { command: `printf ${PROBE_TOOL_OUT}` } } }],
	after: ({ request }) => ({ text: `probe done; tool said ${request.results.at(-1)?.text.trim() ?? "nothing"}` }),
};

interface Ran {
	code: number | null;
	out: string;
	err: string;
	timedOut: boolean;
}

/** Run a command to its end or `ms`, whichever comes first (then SIGKILL): a real omp's wall clock, not a fakeable timer. */
async function run(cmd: string[], env: Record<string, string>, cwd: string, ms: number): Promise<Ran> {
	const p = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		p.kill("SIGKILL");
	}, ms);
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	clearTimeout(timer);
	return { code, out, err, timedOut };
}

/** Wait for a condition the stub's server reaches on its own socket events (no fixed delay). */
async function until(what: string, cond: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

describe.skipIf(OMP === null)("chaos stub and proxy against the installed omp", () => {
	let root: string;
	let home: string;
	let cwd: string;
	let agentDir: string;
	let stub: Stub;
	let proxy: Proxy;
	let env: Record<string, string>;
	let profile: StubProfile;
	let rowProviders: string[];

	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "chaos-stub-")));
		home = join(root, "home");
		cwd = join(root, "work");
		mkdirSync(cwd, { recursive: true });
		agentDir = join(home, ".omp", "profiles", PROFILE, "agent");
		mkdirSync(agentDir, { recursive: true });
		// The shipped profile's judge provider (typesafe/jev-1.13.0) and a minimal config: no extensions, and no
		// provider retries so the un-routed probe fails once instead of backing off for minutes. The shipped
		// tier rows (task.agentModelOverrides) name the providers the run's hands use, which stay enabled.
		copyFileSync(join(REPO, "profile", "models.yml"), join(agentDir, "models.yml"));
		const shipped = Bun.YAML.parse(readFileSync(join(REPO, "profile", "config.yml"), "utf8")) as { task: { agentModelOverrides: Record<string, string[]> } };
		// The providers the shipped tier rows name; moonshot is among them again once migration/items/kimi-off-tier-rows-until-paid.md restores its entries.
		rowProviders = [...new Set(Object.values(shipped.task.agentModelOverrides).flat().map((m) => m.split("/")[0]!))];
		const config = { setupVersion: 2, modelRoles: { judge: "typesafe/jev-1.13.0" }, retry: { enabled: false, fallbackChains: { judge: [] } }, task: shipped.task };
		writeFileSync(join(agentDir, "config.yml"), `${JSON.stringify(config)}\n`);
		proxy = startProxy();
		stub = startStub({ nonce: NONCE, scripts: [PROBE] });
		// moonshot stays routed and enabled: run (1) names a moonshot model explicitly, whether or not the shipped tier rows do.
		profile = writeStubProfile(agentDir, stub.port, { unrouted: ["minimax", "groq"], enabled: ["moonshot"] });
		const proxyUrl = proxy.url;
		env = {
			PATH: [dirname(BUN), dirname(OMP!), "/usr/bin", "/bin"].join(":"),
			HOME: home,
			TMPDIR: join(root, "tmp"),
			OMP_PROFILE: PROFILE,
			HTTP_PROXY: proxyUrl,
			HTTPS_PROXY: proxyUrl,
			ALL_PROXY: proxyUrl,
			http_proxy: proxyUrl,
			https_proxy: proxyUrl,
			all_proxy: proxyUrl,
			NO_PROXY: "127.0.0.1,localhost",
			no_proxy: "127.0.0.1,localhost",
		};
		mkdirSync(env.TMPDIR!, { recursive: true });
	});

	afterAll(() => {
		stub?.stop();
		proxy?.stop();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	test("the profile routes every built-in role to the stub, disables what the run does not name, and matches the installed role list", () => {
		expect(installedRoleIds()).toEqual([...ROLE_IDS]);
		const config = Bun.YAML.parse(readFileSync(join(agentDir, "config.yml"), "utf8")) as {
			modelRoles: Record<string, string>;
			retry: { enabled: boolean; fallbackChains: Record<string, unknown[]> };
			disabledProviders: string[];
		};
		expect(Object.keys(config.modelRoles).sort()).toEqual([...ROLE_IDS].sort());
		expect(config.modelRoles.default).toBe(CHAT);
		expect(config.modelRoles.judge).toBe("typesafe/jev-1.13.0");
		expect(config.retry.enabled).toBe(false); // keys the writer does not own are kept
		for (const role of ROLE_IDS) expect(config.retry.fallbackChains[role]).toEqual([]);
		for (const p of [...rowProviders, "typesafe", "minimax", "groq"]) expect(profile.enabledProviders).toContain(p);
		for (const p of ["openrouter", "bedrock-mantle", "ollama"]) expect(config.disabledProviders).toContain(p);
		expect(config.disabledProviders.filter((p) => profile.enabledProviders.includes(p))).toEqual([]);
		for (const selector of Object.values(config.modelRoles)) expect(config.disabledProviders).not.toContain(selector.split("/")[0]);
		const models = Bun.YAML.parse(readFileSync(join(agentDir, "models.yml"), "utf8")) as { providers: Record<string, { baseUrl?: string; apiKey?: string }> };
		expect(models.providers.typesafe).toMatchObject({ baseUrl: stub.baseUrl, apiKey: "chaos-stub", auth: "apiKey" });
		expect(models.providers["openai-codex"]).toMatchObject({ baseUrl: stub.baseUrl, apiKey: "chaos-stub" });
		expect(models.providers.minimax).toBeUndefined();
		expect(models.providers.groq).toBeUndefined();
	});

	test("(1) omp -p on routed models of three providers returns the stub's nonce reply after the scripted tool turn", async () => {
		// One omp start in the setup phase first: the shared catalog fetch (catalog.stencil.so) of a fresh
		// profile lands there, as it would in the chaos CLI's scratch setup.
		const warm = await run([OMP!, "-p", "--no-session", "--model", CHAT, "warm up"], env, cwd, 20_000);
		expect({ timedOut: warm.timedOut, code: warm.code }).toEqual({ timedOut: false, code: 0 });
		proxy.setPhase("routed");
		const models = [CHAT, "openai-codex/gpt-6-luna", "moonshot/kimi-k2.5"];
		const runs = await Promise.all(
			models.map((m) => run([OMP!, "-p", "--no-session", "--model", m, "run the chaos probe"], env, cwd, 30_000)),
		);
		for (const [i, r] of runs.entries()) {
			expect({ model: models[i], timedOut: r.timedOut, code: r.code }).toEqual({ model: models[i], timedOut: false, code: 0 });
			expect(r.out).toContain(`[${NONCE}] probe done; tool said ${PROBE_TOOL_OUT}`);
		}
		const counts = stub.counts();
		for (const m of models) expect(counts.messages[m.split("/")[1]!]).toBeGreaterThanOrEqual(2);
		expect(counts.foreignKey).toBe(0);
		// every model turn went through the probe's tool turn: a turn-1 request carried the tool's output
		const turnOne = stub.log().filter((e) => e.kind === "probe" && e.turn === 1);
		expect(turnOne.length).toBeGreaterThanOrEqual(models.length);
		expect(stub.log().some((e) => e.turn === 0 && e.tool === "bash")).toBe(true);
		// nothing those omp processes did left the machine: no attempt reached the proxy
		expect(proxy.attempts("routed").map((a) => a.host)).toEqual([]);
	}, 45_000);

	test("(2) one judge call through omp's own judge client reaches /v1/systemone and decodes", async () => {
		const before = stub.counts().judge["jev-1.13.0"] ?? 0;
		const r = await run([BUN, STUB_SCRIPT, "judge-probe", cwd, "review the change on this branch"], env, cwd, 30_000);
		expect({ code: r.code, err: r.err.trim() }).toEqual({ code: 0, err: "" });
		const c = JSON.parse(r.out.trim()) as { choice: string; judgeModel: string };
		expect(c.judgeModel).toBe("typesafe/jev-1.13.0");
		expect(c.choice).toBe("judge");
		expect(stub.counts().judge["jev-1.13.0"]).toBe(before + 1);
		const served = stub.log().filter((e) => e.outcome === "judged");
		expect(served.at(-1)).toMatchObject({ path: "/v1/systemone", model: "jev-1.13.0", key: "chaos-stub" });
	}, 35_000);

	test("(3) refuse mode surfaces as omp's prompt error `Refusal (cyber): …` with retryable false", async () => {
		stub.setMode({ mode: "refuse", kind: "probe" });
		const refusedBefore = stub.counts().refused.probe ?? 0;
		const p = Bun.spawn([OMP!, "--mode", "rpc", "--no-ui", "--no-session", "--model", CHAT], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
		let result: { status?: string; error?: { message?: string; retryable?: boolean } } | null = null;
		let sent = false;
		const decoder = new TextDecoder();
		let buf = "";
		try {
			for await (const chunk of p.stdout) {
				buf += decoder.decode(chunk, { stream: true });
				let nl = buf.indexOf("\n");
				while (nl >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					nl = buf.indexOf("\n");
					if (!line.startsWith("{")) continue;
					const frame = JSON.parse(line) as { type?: string; id?: string };
					if (frame.type === "ready" && !sent) {
						sent = true;
						p.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "run the chaos probe" })}\n`);
						p.stdin.flush();
					}
					if (frame.type === "prompt_result" && frame.id === "p1") result = frame as typeof result;
				}
				if (result) break;
			}
		} finally {
			clearTimeout(timer);
			p.kill("SIGKILL");
			stub.setMode({ mode: "normal" });
		}
		expect(sent).toBe(true);
		expect(result).toMatchObject({ status: "error", error: { retryable: false } });
		expect(result!.error!.message).toStartWith(`Refusal (cyber): ${REFUSAL_EXPLANATION}`);
		expect(result!.error!.message).toContain(NONCE);
		expect(stub.counts().refused.probe).toBeGreaterThan(refusedBefore);
	}, 35_000);

	test("(4) an un-routed real model id lands in the proxy log and never succeeds over the network", async () => {
		proxy.setPhase("preflight");
		const probes = [
			{ model: "minimax/MiniMax-M2", host: "api.minimax.io", key: "MINIMAX_API_KEY" },
			{ model: "groq/gemma2-9b-it", host: "api.groq.com", key: "GROQ_API_KEY" },
		];
		const runs = await Promise.all(
			probes.map((p) => run([OMP!, "-p", "--no-session", "--model", p.model, "say hi"], { ...env, [p.key]: "chaos-egress-probe" }, cwd, 30_000)),
		);
		proxy.setPhase("after");
		const attempts = proxy.attempts("preflight");
		for (const [i, p] of probes.entries()) {
			const r = runs[i]!;
			expect({ model: p.model, timedOut: r.timedOut }).toEqual({ model: p.model, timedOut: false });
			expect(r.code).not.toBe(0);
			expect(r.out).not.toContain(NONCE);
			expect(attempts.some((a) => a.kind === "connect" && a.host === p.host)).toBe(true);
			expect(stub.counts().messages[p.model.split("/")[1]!]).toBeUndefined();
		}
		// the preflight bucket holds exactly the probed hosts (plan § 2.1: any other host there is HARNESS-ERROR),
		// and the only egress any omp attempted outside it is the setup phase's shared-catalog fetch
		expect([...new Set(attempts.map((a) => a.host))].sort()).toEqual(["api.groq.com", "api.minimax.io"]);
		expect([...new Set(proxy.attempts("setup").map((a) => a.host))]).toEqual(["catalog.stencil.so"]);
		expect(proxy.attempts().filter((a) => a.phase !== "setup" && a.phase !== "preflight")).toEqual([]);
	}, 35_000);
});

describe("chaos stub mechanics", () => {
	const post = (stub: Stub, body: unknown, signal?: AbortSignal) =>
		fetch(`${stub.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": "chaos-stub", "content-type": "application/json" }, body: JSON.stringify(body), signal });
	const msg = (system: string) => ({ model: "m-1", system, stream: false, messages: [{ role: "user", content: "hi" }] });
	const scripts: StubScript[] = [
		{ kind: "hand", match: /HAND/, steps: [{ text: "hand step" }] },
		{ kind: "lane", match: /LANE/, steps: [{ text: "lane step" }] },
	];

	test("normal mode answers by script with the nonce, and counts per model and kind", async () => {
		const stub = startStub({ nonce: "n1", scripts });
		try {
			const r = (await (await post(stub, msg("HAND brief"))).json()) as { content: { text: string }[] };
			expect(r.content[0]!.text).toBe("[n1] hand step");
			expect(stub.counts()).toMatchObject({ messages: { "m-1": 1 }, kinds: { hand: 1 } });
		} finally {
			stub.stop();
		}
	});

	test("a stall holds only its kind; a client that hangs up is recorded as dropped; leaving the stall answers what it holds", async () => {
		const stub = startStub({ nonce: "n2", scripts });
		try {
			stub.setMode({ mode: "stall", kind: "hand", ms: 60_000 });
			expect((await post(stub, msg("LANE"))).status).toBe(200);
			const ac = new AbortController();
			const dropped = post(stub, msg("HAND one"), ac.signal).catch((e: Error) => e.name);
			await until("the first hand request held", () => stub.held().length === 1);
			const kept = post(stub, msg("HAND two"));
			await until("both hand requests held", () => stub.held().length === 2);
			expect(stub.held().map((h) => h.outcome)).toEqual(["open", "open"]);
			ac.abort();
			expect(await dropped).toBe("AbortError");
			await until("the server saw the hang-up", () => stub.held()[0]!.outcome !== "open");
			expect(stub.held()[0]!.outcome).toBe("dropped");
			stub.setMode({ mode: "normal" });
			const r = (await (await kept).json()) as { content: { text: string }[] };
			expect(r.content[0]!.text).toBe("[n2] hand step");
			expect(stub.held()[1]).toMatchObject({ kind: "hand", reason: "stall", outcome: "answered" });
		} finally {
			stub.stop();
		}
	});

	test("a blackhole holds every request and resets the connections when its window ends", async () => {
		const stub = startStub({ nonce: "n3", scripts });
		try {
			stub.setMode({ mode: "blackhole", ms: 300 });
			const r = await post(stub, msg("LANE")).then(
				(res) => `status ${res.status}`,
				(e: Error & { code?: string }) => e.code ?? e.name,
			);
			expect(r).toBe("ECONNRESET");
			expect(stub.windows()).toEqual([expect.objectContaining({ ms: 300, held: 1, reset: 1, end: expect.any(Number) })]);
			expect(stub.held()[0]).toMatchObject({ reason: "blackhole", outcome: "reset" });
			expect(stub.mode()).toEqual({ mode: "normal" });
			expect((await post(stub, msg("LANE"))).status).toBe(200);
		} finally {
			stub.stop();
		}
	}, 15_000);
});

describe("chaos proxy", () => {
	test("refuses CONNECT and plain requests with 403, logs host and phase, and logs a non-HTTP client as other", async () => {
		const proxy = startProxy();
		const raw = (bytes: string) => {
			const { promise, resolve } = Promise.withResolvers<string>();
			const s = connect(proxy.port, "127.0.0.1", () => s.write(bytes));
			let got = "";
			s.on("data", (d) => {
				got += d.toString();
			});
			s.on("close", () => resolve(got));
			s.on("error", () => resolve(got));
			return promise;
		};
		try {
			expect(await raw("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n")).toStartWith("HTTP/1.1 403 Forbidden");
			proxy.setPhase("preflight");
			const viaFetch = await fetch("http://example.invalid/x", { proxy: proxy.url });
			expect(viaFetch.status).toBe(403);
			expect(await raw("\x05\x01\x00")).toStartWith("HTTP/1.1 403");
			expect(proxy.attempts("setup")).toEqual([expect.objectContaining({ kind: "connect", host: "api.anthropic.com", target: "api.anthropic.com:443" })]);
			expect(proxy.attempts("preflight").map((a) => [a.kind, a.host])).toEqual([["http", "example.invalid"], ["other", ""]]);
		} finally {
			proxy.stop();
		}
	});

	test("parseHead reads the Host header for an origin-form target and brackets off IPv6", () => {
		expect(parseHead(Buffer.from("GET / HTTP/1.1\r\nHost: Api.Example.com:8080\r\n\r\n"))).toMatchObject({ kind: "http", host: "api.example.com" });
		expect(parseHead(Buffer.from("CONNECT [::1]:443 HTTP/1.1\r\n\r\n"))).toMatchObject({ kind: "connect", host: "::1" });
	});
});
