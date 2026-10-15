// The Linear adapter (PLAN wl-mv66ylim0gahog § 13.2): the workflow state by type for every render
// state, GraphQL `errors` on HTTP 200 as a failure, the key only in the Authorization header and
// redacted from every error text, a missing key making no request, and the labelled list's paging.
// Linear is `FakeLinear` behind the injected fetch (issues-fakes.ts).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { NETWORK_MS } from "../src/issues/github";
import { Linear, LINEAR_LABELS, LINEAR_URL, linearStateFor, redact } from "../src/issues/linear";
import { LABEL, PROJECTION_LABELS, type Rendered } from "../src/issues/render";
import { Sidecar } from "../src/issues/sidecar";
import { ENG_2284, ENG_STATES, FakeLinear, linearMarkdown } from "./issues-fakes";
import { tmp } from "./helpers";

const KEY = "lin_api_TOPSECRET9876543210";
const T = 1_760_000_000_000;

function client(o: { key?: string | null; perTick?: number } = {}) {
	const fake = new FakeLinear();
	const sidecar = Sidecar.open(join(tmp("linear"), "issues.db"));
	expect(sidecar.claim("h1", T)).toBe(true);
	const key = o.key === undefined ? KEY : o.key;
	const linear = new Linear(fake.fetch, key, sidecar, { holder: "h1", perTick: o.perTick ?? 100, perHour: 1_000, now: () => T });
	return { fake, sidecar, linear };
}

const r = (state: Rendered["state"], reason: Rendered["reason"], labels: string[]): Pick<Rendered, "state" | "reason" | "labels"> => ({ state, reason, labels });

describe("workflow state by type", () => {
	test.each([
		["open, waiting", r("open", null, [LABEL.as2, LABEL.waiting]), "In Progress", "started"],
		["open, running, a question", r("open", null, [LABEL.as2, LABEL.question, LABEL.running]), "In Progress", "started"],
		["closed, awaiting merge", r("open", null, [LABEL.as2, LABEL.awaitingMerge]), "In Review", "started"],
		["closed completed", r("closed", "completed", [LABEL.as2]), "Done", "completed"],
		["closed not planned (unmerged)", r("closed", "not planned", [LABEL.as2, LABEL.unmerged]), "Canceled", "canceled"],
	])("%s ⇒ %s", (_name, rendered, name, type) => {
		expect(linearStateFor(rendered, ENG_STATES)).toMatchObject({ name, type });
	});

	test("a team with no In Review state keeps awaiting merge on In Progress; no state of the type ⇒ null", () => {
		const noReview = ENG_STATES.filter((s) => s.name !== "In Review");
		expect(linearStateFor(r("open", null, [LABEL.awaitingMerge]), noReview)?.name).toBe("In Progress");
		expect(linearStateFor(r("closed", "not planned", []), ENG_STATES.filter((s) => s.type !== "canceled"))).toBeNull();
	});

	test("the Linear label set is GitHub's projection set without intake", () => {
		expect([...LINEAR_LABELS].sort()).toEqual(PROJECTION_LABELS.filter((l) => l !== LABEL.intake).sort());
		expect(LINEAR_LABELS).toContain(LABEL.awaitingMerge);
	});
});

describe("requests and failures", () => {
	test("each request is a counted POST to the GraphQL URL, the key in the Authorization header only, with a timeout signal", async () => {
		const { fake, linear, sidecar } = client();
		const seen: { url: string; signal: AbortSignal; body: string; headers: Record<string, string> }[] = [];
		const wrapped = new Linear(
			async (url, init) => {
				seen.push({ url, signal: init.signal, body: init.body, headers: init.headers });
				return fake.fetch(url, init);
			},
			KEY,
			sidecar,
			{ holder: "h1", perTick: 100, perHour: 1_000, now: () => T },
		);
		const t = await wrapped.team("ENG");
		expect(t.ok && t.value.states.map((s) => s.name)).toContain("In Review");
		expect(seen).toHaveLength(1);
		expect(seen[0]!.url).toBe(LINEAR_URL);
		expect(seen[0]!.headers.Authorization).toBe(KEY);
		expect(seen[0]!.body).not.toContain(KEY);
		expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
		expect(NETWORK_MS).toBeGreaterThan(0);
		expect(sidecar.callsInHour(T + 1, "linear")).toBe(1);
		expect(sidecar.callsInHour(T + 1, "github")).toBe(0);
		expect(linear.calls).toBe(0);
	});

	test("GraphQL errors on HTTP 200, a non-2xx status, a reply that is not JSON, and a thrown fetch are failures with the key redacted", async () => {
		const { fake, linear } = client();
		const replies = [
			() => new Response(JSON.stringify({ data: { issue: null }, errors: [{ message: `Entity not found (auth ${KEY})` }] }), { status: 200 }),
			() => new Response(`rate limited for ${KEY}`, { status: 429 }),
			() => new Response("<html>bad gateway</html>", { status: 200 }),
			() => {
				throw new Error(`connect ECONNREFUSED with ${KEY}`);
			},
		];
		let i = 0;
		fake.reply = () => replies[i++]!();
		const errors: string[] = [];
		for (let n = 0; n < replies.length; n++) {
			const out = await linear.read("iss-1");
			expect(out.ok).toBe(false);
			if (!out.ok) errors.push(out.error);
		}
		expect(errors[0]).toContain("GraphQL error: Entity not found");
		expect(errors[1]).toContain("HTTP 429");
		expect(errors[2]).toContain("printed no JSON");
		expect(errors[3]).toContain("ECONNREFUSED");
		for (const e of errors) {
			expect(e).not.toContain(KEY);
			expect(e).toContain("Linear issue read iss-1");
		}
		expect(errors.filter((e) => e.includes("[redacted]"))).toHaveLength(3);
	});

	test("no key: every call fails without a request", async () => {
		const { fake, linear } = client({ key: null });
		const out = await linear.findByTitle("ENG", "wl-x —");
		expect(out).toEqual({ ok: false, error: "Linear issue search: LINEAR_API_KEY is not set" });
		expect(fake.requests).toHaveLength(0);
		expect(linear.hasKey).toBe(false);
	});

	test("redact replaces every occurrence and leaves text alone without a key", () => {
		expect(redact(`a ${KEY} b ${KEY}`, KEY)).toBe("a [redacted] b [redacted]");
		expect(redact("plain", null)).toBe("plain");
		expect(redact("plain", "")).toBe("plain");
	});
});

describe("operations", () => {
	test("create, find by title, read, update title/description/labels/state, comment", async () => {
		const { fake, linear } = client();
		const team = await linear.team("ENG");
		if (!team.ok) throw new Error(team.error);
		const label = await linear.createLabel(team.value.id, "as2");
		if (!label.ok) throw new Error(label.error);
		const inProgress = team.value.states.find((s) => s.name === "In Progress")!;
		const done = team.value.states.find((s) => s.name === "Done")!;
		const created = await linear.create(team.value.id, { title: "wl-a — work", description: "<!-- as2:begin -->\nx\n<!-- as2:end -->", labelIds: [label.value.id], stateId: inProgress.id });
		if (!created.ok) throw new Error(created.error);
		expect(created.value.description).toBe("<!-- as2:begin -->\nx\n<!-- as2:end -->");
		expect(await linear.findByTitle("ENG", "wl-a —")).toEqual({ ok: true, value: { id: created.value.id, identifier: created.value.identifier } });
		expect(await linear.findByTitle("ENG", "wl-b —")).toEqual({ ok: true, value: null });
		expect(await linear.update(created.value.id, { title: "wl-a — renamed", stateId: done.id, labelIds: [] })).toEqual({ ok: true, value: { description: "<!-- as2:begin -->\nx\n<!-- as2:end -->" } });
		const read = await linear.read(created.value.id);
		expect(read.ok && read.value).toMatchObject({ title: "wl-a — renamed", state: { name: "Done", type: "completed" }, labels: [] });
		expect(await linear.comment(created.value.id, "moved")).toEqual({ ok: true, value: true });
		expect(fake.issues.get(created.value.id)!.comments).toEqual(["moved"]);
	});

	test("create and update select the description Linear stored and return it normalised; a reply without one is null", async () => {
		const { fake, linear } = client();
		fake.normalise = true;
		const team = await linear.team("ENG");
		if (!team.ok) throw new Error(team.error);
		const state = team.value.states[0]!.id;
		const sent = "<!-- as2:begin -->\nPRs:\n- https://github.com/o/r/pull/4 open\nledger seq: 3\n<!-- as2:end -->";
		const stored = "<!-- as2:begin -->\nPRs:\n\n* [https://github.com/o/r/pull/4](<https://github.com/o/r/pull/4>) open\n  ledger seq: 3\n  <!-- as2:end -->";
		const created = await linear.create(team.value.id, { title: "wl-a — w", description: sent, labelIds: [], stateId: state });
		expect(created).toEqual({ ok: true, value: { id: expect.any(String), identifier: expect.any(String), description: stored } });
		if (!created.ok) throw new Error(created.error);
		expect(fake.made("create")[0]!.variables).toMatchObject({ input: { description: sent } });
		expect(await linear.update(created.value.id, { description: sent.replace("seq: 3", "seq: 4") })).toEqual({ ok: true, value: { description: stored.replace("seq: 3", "seq: 4") } });
		// A reply whose issue has no description (or a null one) is null, never "".
		fake.reply = (r) => (r.op === "update" ? new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: created.value.id, description: null } } } }), { status: 200 }) : null);
		expect(await linear.update(created.value.id, { title: "t" })).toEqual({ ok: true, value: { description: null } });
		fake.reply = (r) => (r.op === "create" ? new Response(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "iss-9", identifier: "ENG-9" } } } }), { status: 200 }) : null);
		expect(await linear.create(team.value.id, { title: "wl-b — w", description: sent, labelIds: [], stateId: state })).toEqual({ ok: true, value: { id: "iss-9", identifier: "ENG-9", description: null } });
	});

	test("the fake's normalisation reproduces the description Linear returned live for ENG-2284, and is idempotent", () => {
		expect(linearMarkdown(ENG_2284.pushed)).toBe(ENG_2284.returned);
		expect(linearMarkdown(ENG_2284.returned)).toBe(ENG_2284.returned);
	});

	test("the labelled list follows hasNextPage across pages within one call", async () => {
		const { fake, linear } = client();
		fake.pageSize = 2;
		for (let i = 0; i < 5; i++) fake.addIssue({ title: `wl-${i} — w`, labels: ["as2"] });
		fake.addIssue({ title: "not ours" });
		const all = await linear.listLabelled("ENG", "as2");
		expect(all.ok && all.value.map((x) => x.title)).toEqual(["wl-0 — w", "wl-1 — w", "wl-2 — w", "wl-3 — w", "wl-4 — w"]);
		expect(fake.made("list")).toHaveLength(3);
		expect(fake.made("list").map((q) => q.variables.after)).toEqual([null, "2", "4"]);
	});

	test("an issue's labels are read 50 a page, one counted call each, following endCursor; past 10 pages it is a failure, never a short set", async () => {
		const { fake, linear } = client();
		const names = (n: number) => Array.from({ length: n }, (_, i) => `jo-${String(i).padStart(3, "0")}`);
		const some = fake.addIssue({ title: "wl-a — w", labels: names(120) });
		const all = await linear.labels(some.id);
		expect(all.ok && all.value.map((l) => l.name)).toEqual(names(120));
		expect(fake.made("labels").map((q) => q.variables.after)).toEqual([null, "50", "100"]);
		const many = fake.addIssue({ title: "wl-b — w", labels: names(501) });
		fake.requests.length = 0;
		const capped = await linear.labels(many.id);
		expect(capped.ok).toBe(false);
		expect(!capped.ok && capped.error).toContain("more than 500 labels");
		expect(fake.made("labels")).toHaveLength(10);
		fake.reply = () => new Response(JSON.stringify({ data: { issue: { labels: { nodes: [{ id: "x" }], pageInfo: { hasNextPage: false, endCursor: "1" } } } } }), { status: 200 });
		expect((await linear.labels(some.id)).ok).toBe(false);
	});

	test("a malformed list connection, a malformed node or a non-boolean hasNextPage is a failure, never an empty or short list", async () => {
		const { fake, linear } = client();
		const good = { id: "iss-1", identifier: "ENG-1", title: "wl-a — w", description: "", state: null, labels: { nodes: [], pageInfo: { hasNextPage: false } } };
		const pageInfo = { hasNextPage: false, endCursor: "1" };
		const lists: [string, unknown][] = [
			["no connection", { issues: null }],
			["nodes not a list", { issues: { nodes: "none", pageInfo } }],
			["a node without an id", { issues: { nodes: [good, { identifier: "ENG-2", title: "wl-b — w" }], pageInfo } }],
			["a node whose labels are malformed", { issues: { nodes: [{ ...good, labels: { nodes: null } }], pageInfo } }],
			["a node whose labels have no hasNextPage", { issues: { nodes: [{ ...good, labels: { nodes: [] } }], pageInfo } }],
			["hasNextPage a string", { issues: { nodes: [good], pageInfo: { hasNextPage: "false", endCursor: "1" } } }],
			["no pageInfo", { issues: { nodes: [good] } }],
		];
		let data: unknown = null;
		fake.reply = () => new Response(JSON.stringify({ data }), { status: 200 });
		for (const [name, d] of lists) {
			data = d;
			const out = await linear.listLabelled("ENG", "as2");
			expect({ name, ok: out.ok }).toEqual({ name, ok: false });
		}
		data = { issues: { nodes: [good], pageInfo } };
		expect(await linear.listLabelled("ENG", "as2")).toMatchObject({ ok: true, value: [{ id: "iss-1", labels: [], labelsComplete: true }] });
		// The team read and the lost-create search: a malformed list is a failure, not "no labels" or "not found".
		data = { teams: { nodes: [{ id: "team-ENG", key: "ENG", states: { nodes: ENG_STATES }, labels: null }] } };
		expect((await linear.team("ENG")).ok).toBe(false);
		data = { issues: { nodes: [{ id: "iss-1" }] } };
		expect((await linear.findByTitle("ENG", "wl-a —")).ok).toBe(false);
	});

	test("a call over the tick's Linear budget is not made", async () => {
		const { fake, linear } = client({ perTick: 1 });
		await linear.team("ENG");
		await expect(linear.team("ENG")).rejects.toMatchObject({ reason: "budget", kind: "linear" });
		expect(fake.requests).toHaveLength(1);
	});
});
