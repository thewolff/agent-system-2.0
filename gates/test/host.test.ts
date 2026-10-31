// The host pin (gates/src/host.ts): pure checks plus every listed host member checked against the
// repository's exact locked OMP package, which must match the `omp` executable on PATH before the
// installer writes anything.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkHostVersion, HOST_MEMBERS, HOST_SETTING_IDS, HostError, type HostModules, hostSettings, readSetting, unknownSetting, VERIFIED_HOST } from "../src/host";
import { MEASURED_HOST } from "../src/shell-start";
import { tmp } from "./helpers";

// The repository lock is the inspectable host package surface. A production OMP process serves the
// same modules in-process; package.json pins this tree to the executable version.
const OMP = join(import.meta.dir, "..", "..", "node_modules", "@oh-my-pi");
const HAS_OMP = existsSync(`${OMP}/pi-coding-agent/src/config/settings.ts`);
const moduleFile = (specifier: string): string => {
	const m = /^@oh-my-pi\/(pi-[a-z-]+)(?:\/(.+))?$/.exec(specifier);
	if (!m) throw new Error(`not an @oh-my-pi specifier: ${specifier}`);
	return `${OMP}/${m[1]}/src/${m[2] ?? "index"}.ts`;
};

describe("the version pin", () => {
	test("the verified major.minor passes at any patch level; another major.minor is refused naming both", () => {
		expect(checkHostVersion(`${VERIFIED_HOST}.0`)).toBe(`${VERIFIED_HOST}.0`);
		expect(checkHostVersion(`${VERIFIED_HOST}.99`)).toBe(`${VERIFIED_HOST}.99`);
		for (const v of ["18.5.0", "19.0.0", "17.9.9"]) {
			expect(() => checkHostVersion(v)).toThrow(new HostError(`the running OMP is ${v} and the gates were verified on OMP ${VERIFIED_HOST} (gates/src/host.ts VERIFIED_HOST); re-run gates/test/host.test.ts against this host and bump the pin before trusting its settings reads`));
		}
	});

	test("a version that is not a semver string is refused, never treated as the pinned one", () => {
		for (const v of [undefined, null, 18, "18.4", "omp/18.4.4", ""]) {
			expect(() => checkHostVersion(v)).toThrow(HostError);
			expect(() => checkHostVersion(v)).toThrow(`(@oh-my-pi/pi-utils/dirs VERSION is ${JSON.stringify(v)})`);
		}
	});
});

describe("the member checks name the host version and the member that moved", () => {
	const instance = { getGlobalSettings: () => ({ gates: { fence: { enabled: false } } }), flag: 7 };
	const good = (): HostModules => ({
		version: "18.12.6",
		Settings: { current: null, loadReadOnly: async () => instance },
		lookup: (id) => (id === "x.flag" ? { get: (s) => (s as typeof instance).flag } : undefined),
	});

	test("a good host: the disk read is used when current is null, the handle read returns the effective value, the raw layer carries the unknown key", async () => {
		const h = good();
		const s = await hostSettings(h, "/tmp");
		expect({ flag: readSetting(h, s, "x.flag"), unknown: unknownSetting(s, ["gates", "fence", "enabled"]), absent: unknownSetting(s, ["gates", "nope", "x"]) }).toEqual({ flag: 7, unknown: false, absent: undefined });
	});

	test("the version is checked before any member", async () => {
		const h = { ...good(), version: "18.5.0", Settings: undefined as never };
		await expect(hostSettings(h, "/tmp")).rejects.toThrow("the running OMP is 18.5.0");
	});

	for (const [name, mutate, expected] of [
		["Settings.current gone", (h: HostModules) => ({ ...h, Settings: { loadReadOnly: h.Settings.loadReadOnly } }), "OMP 18.12.6: Settings.current is missing from @oh-my-pi/pi-coding-agent/config/settings (found undefined)"],
		["Settings.loadReadOnly gone", (h: HostModules) => ({ ...h, Settings: { current: null } as never }), "OMP 18.12.6: Settings.loadReadOnly is missing from @oh-my-pi/pi-coding-agent/config/settings (found undefined)"],
		["lookup gone", (h: HostModules) => ({ ...h, lookup: undefined as never }), "OMP 18.12.6: lookup is missing from @oh-my-pi/pi-coding-agent/config/registry (found undefined)"],
		["instance without getGlobalSettings", (h: HostModules) => ({ ...h, Settings: { current: Promise.resolve({} as never), loadReadOnly: h.Settings.loadReadOnly } }), "OMP 18.12.6: Settings#getGlobalSettings is missing from @oh-my-pi/pi-coding-agent/config/settings (found undefined)"],
	] as const) {
		test(name, async () => {
			await expect(hostSettings(mutate(good()), "/tmp")).rejects.toThrow(new HostError(`${expected}; the gates were verified on OMP ${VERIFIED_HOST} with it present`));
		});
	}

	test("a setting id with no registered handle, and a handle without get, are named", async () => {
		const h = good();
		const s = await hostSettings(h, "/tmp");
		expect(() => readSetting(h, s, "bash.autoBackground.enabled")).toThrow('OMP 18.12.6: lookup("bash.autoBackground.enabled") is missing from @oh-my-pi/pi-coding-agent/config/registry (found undefined)');
		expect(() => readSetting({ ...h, lookup: () => ({}) as never }, s, "x.flag")).toThrow('OMP 18.12.6: lookup("x.flag").get is missing from @oh-my-pi/pi-coding-agent/config/registry (found undefined)');
	});
});

describe("the installed host has every member the extensions depend on, at the pinned version", () => {
	test.skipIf(!HAS_OMP)("the installed OMP's version is the pinned major.minor", async () => {
		const { VERSION } = await import(moduleFile("@oh-my-pi/pi-utils/dirs"));
		expect(checkHostVersion(VERSION)).toBe(VERSION);
	});

	test.skipIf(!HAS_OMP)("the installed OMP is exactly the version the shell-start facts were measured on (gates/src/shell-start.ts MEASURED_HOST)", async () => {
		// A patch bump fails here: re-run gates/test/shell-start-bash.test.ts and the shell-start session
		// tests on the new host, then move MEASURED_HOST (PLAN.md wl-mv5lrh0drbg0zk § 2.5).
		const { VERSION } = await import(moduleFile("@oh-my-pi/pi-utils/dirs"));
		expect(VERSION).toBe(MEASURED_HOST);
	});

	test.skipIf(!HAS_OMP)("every HOST_MEMBERS row resolves on the installed host with the listed kind", async () => {
		const found: Record<string, string> = {};
		for (const { module, member, kind } of HOST_MEMBERS) {
			const mod = (await import(moduleFile(module))) as Record<string, unknown>;
			let value: unknown;
			let m: RegExpExecArray | null;
			if ((m = /^(\w+)#(\w+)\(\)\.(\w+)$/.exec(member))) {
				// A bare instance (the runner's constructor only stores its arguments; runner.ts:702-719) and the member of what the method returns.
				const Cls = mod[m[1]!] as new (...args: unknown[]) => Record<string, () => Record<string, unknown>>;
				const instance = m[1] === "ExtensionRunner" ? new Cls([], {}, "/", { getCwd: () => "/" }, {}) : new Cls();
				value = instance[m[2]!]?.()?.[m[3]!];
			} else if ((m = /^(\w+)\.(\w+)$/.exec(member))) {
				const owner = mod[m[1]!] as Record<string, unknown>;
				const desc = Object.getOwnPropertyDescriptor(owner, m[2]!);
				value = kind === "static-getter" ? desc?.get : owner[m[2]!];
			} else if ((m = /^(\w+)#(\w+)$/.exec(member))) {
				value = (mod[m[1]!] as { prototype: Record<string, unknown> }).prototype[m[2]!];
			} else if ((m = /^(\w+)\(id\)\.(\w+)$/.exec(member))) {
				const handle = (mod[m[1]!] as (id: string) => Record<string, unknown> | undefined)(HOST_SETTING_IDS[0]);
				value = handle?.[m[2]!];
			} else value = mod[member];
			found[`${module} ${member}`] = value === undefined ? "missing" : kind === "string" ? typeof value : typeof value === "function" ? "function" : typeof value;
		}
		const want = Object.fromEntries(HOST_MEMBERS.map(({ module, member, kind }) => [`${module} ${member}`, kind === "static-getter" ? "function" : kind]));
		expect(found).toEqual(want);
	});

	test.skipIf(!HAS_OMP)("every setting id the extensions read is registered on the installed host", async () => {
		const { lookup } = await import(moduleFile("@oh-my-pi/pi-coding-agent/config/registry"));
		expect(Object.fromEntries(HOST_SETTING_IDS.map((id) => [id, typeof lookup(id)?.get]))).toEqual(Object.fromEntries(HOST_SETTING_IDS.map((id) => [id, "function"])));
	});

	test.skipIf(!HAS_OMP)("a real disk read: the handle returns the configured auto-background value and the raw layer keeps gates.fence.enabled", async () => {
		const [{ VERSION }, { Settings }, { lookup }] = await Promise.all([
			import(moduleFile("@oh-my-pi/pi-utils/dirs")),
			import(moduleFile("@oh-my-pi/pi-coding-agent/config/settings")),
			import(moduleFile("@oh-my-pi/pi-coding-agent/config/registry")),
		]);
		const agentDir = tmp("host-agent");
		const cwd = tmp("host-cwd");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "config.yml"), "bash:\n  autoBackground:\n    enabled: false\ngates:\n  fence:\n    enabled: false\n");
		// The disk read from this test's own agentDir; `current` is null in this second copy of OMP.
		const host: HostModules = { version: VERSION, Settings: { current: null, loadReadOnly: (o) => Settings.loadReadOnly({ ...o, agentDir }) }, lookup };
		const s = await hostSettings(host, cwd);
		expect({
			autoBackground: readSetting(host, s, "bash.autoBackground.enabled"),
			flag: unknownSetting(s, ["gates", "fence", "enabled"]),
			disabledProviders: readSetting(host, s, "disabledProviders"),
		}).toEqual({ autoBackground: false, flag: false, disabledProviders: [] });
		// And the default when the key is absent: the handle supplies it (registry, not `getGlobalSettings`).
		const s2 = await Settings.isolated({});
		expect({ autoBackground: readSetting(host, s2, "bash.autoBackground.enabled"), flag: unknownSetting(s2, ["gates", "fence", "enabled"]) }).toEqual({ autoBackground: true, flag: undefined });
	});
});
