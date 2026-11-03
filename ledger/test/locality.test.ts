// The locality guards and their native lookups (PLAN wl-mvq8x4l6zubxfk "Permanent tests" T2-T7, the
// Linux mountinfo cases and N1-N4). A "probe" case runs a guard set built with localityGuards(probe);
// a real-answer case runs the production exports or the native module against this machine.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertLocalPath,
	assertNotLiveLedgerUnderTest,
	LedgerLocationError,
	LiveLedgerUnderTestError,
	type LocalityProbe,
	linuxLocality,
	localityGuards,
	mountLocality,
	TEST_REAL_HOME_ENV,
	TEST_REAL_LEDGER_DB_ENV,
} from "../src/locality";
import { decodePasswd, decodeStatfs, native, openNative, type PasswdCall } from "../src/native";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "as2-locality-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const darwin = process.platform === "darwin";
const uid = process.getuid!();

/** A darwin probe whose statfs says local and records each path it is asked about; `over` replaces any answer. */
function recordingProbe(over: Partial<LocalityProbe> = {}): { probe: LocalityProbe; statfsCalls: string[] } {
	const statfsCalls: string[] = [];
	const probe: LocalityProbe = {
		platform: "darwin",
		statfs: (path) => {
			statfsCalls.push(path);
			return { ok: true, local: true, mountOn: "/", fsType: "apfs" };
		},
		mountinfo: () => null,
		passwdHome: () => ({ ok: true, home: join(scratch, "passwd-home") }),
		...over,
	};
	return { probe, statfsCalls };
}

/** glibc's gnu_dev_makedev: the dev_t mountinfo prints as `major:minor`. */
function makedev(major: bigint, minor: bigint): bigint {
	return ((major & 0xfffn) << 8n) | ((major & 0xfffff000n) << 32n) | (minor & 0xffn) | ((minor & 0xffffff00n) << 12n);
}

const ROOT_LINE = "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw";

describe("T2 local accepted", () => {
	test("a temp dir is local and its ledger path comes back canonical", () => {
		expect(mountLocality(scratch)).toBe("local");
		expect(assertLocalPath(join(scratch, "x", "l.db"))).toBe(join(scratch, "x", "l.db"));
	});

	// /Users is firmlinked to the Data volume on current macOS; skipped where this host says otherwise.
	const firmlinked = darwin ? native.statfsMount("/Users") : null;
	test.skipIf(!(firmlinked?.ok && firmlinked.mountOn === "/System/Volumes/Data"))(
		"a path whose mount-on is not a prefix of it (the firmlinked Data volume) is local",
		() => {
			expect(firmlinked).toMatchObject({ ok: true, local: true });
			expect(assertLocalPath(join("/Users", "x", "l.db"))).toBe(join("/Users", "x", "l.db"));
		},
	);
});

describe("T3 non-local refused", () => {
	const autofsHome = "/System/Volumes/Data/home";
	const autofsAnswer = darwin && existsSync(autofsHome) ? native.statfsMount(autofsHome) : null;
	const realAutofs = autofsAnswer?.ok === true && autofsAnswer.fsType === "autofs";
	test.skipIf(!realAutofs)("the kernel's autofs /System/Volumes/Data/home is network", () => {
		expect(mountLocality(autofsHome)).toStartWith("network:/System/Volumes/Data/home is mounted without the local flag (autofs)");
	});

	test("a statfs answer without MNT_LOCAL is refused", () => {
		const { probe } = recordingProbe({ statfs: () => ({ ok: true, local: false, mountOn: "/Volumes/share", fsType: "smbfs" }) });
		const guards = localityGuards(probe);
		expect(guards.mountLocality(scratch)).toBe("network:/Volumes/share is mounted without the local flag (smbfs)");
		expect(() => guards.assertLocalPath(join(scratch, "l.db"), join(scratch, "home"))).toThrow(LedgerLocationError);
		expect(() => guards.assertLocalPath(join(scratch, "l.db"), join(scratch, "home"))).toThrow("is not on a local filesystem (network:");
	});

	test.each(["nfs4", "fuse.sshfs", "fuse.rclone"])("a %s entry for the device is network", (fsType) => {
		const mountinfo = `${ROOT_LINE}\n40 22 0:52 / /mnt/remote rw,relatime shared:9 - ${fsType} server:/export rw\n`;
		expect(linuxLocality(mountinfo, makedev(0n, 52n), "/mnt/remote/l.db")).toBe(`network:/mnt/remote is ${fsType}`);
	});
});

describe("T4 unknown refused", () => {
	const cases: [string, Partial<LocalityProbe>][] = [
		["statfs failed", { statfs: () => ({ ok: false, why: "errno 5" }) }],
		["mountinfo unreadable", { platform: "linux", mountinfo: () => null }],
		["no mountinfo entry for the device", { platform: "linux", mountinfo: () => "1 0 4095:1048575 / / rw - ext4 /dev/x rw\n" }],
		["a malformed mountinfo line", { platform: "linux", mountinfo: () => `${ROOT_LINE}\nnot a mountinfo line\n` }],
		["an unsupported platform", { platform: "win32" }],
	];
	test.each(cases)("%s: unknown, and assertLocalPath throws", (_, over) => {
		const guards = localityGuards(recordingProbe(over).probe);
		expect(guards.mountLocality(scratch)).toStartWith("unknown:");
		expect(() => guards.assertLocalPath(join(scratch, "l.db"), join(scratch, "home"))).toThrow("is not on a local filesystem (unknown:");
	});
});

describe("T5 a synced path is refused before any mount lookup", () => {
	test("under Library/CloudStorage, and through a symlink into Dropbox", () => {
		const home = join(scratch, "home5");
		mkdirSync(join(home, "Dropbox"), { recursive: true });
		const link = join(scratch, "into-dropbox");
		symlinkSync(join(home, "Dropbox"), link);
		const { probe, statfsCalls } = recordingProbe();
		const guards = localityGuards(probe);
		expect(() => guards.assertLocalPath(join(home, "Library", "CloudStorage", "Box", "l.db"), home)).toThrow("a synced folder");
		expect(() => guards.assertLocalPath(join(link, "l.db"), home)).toThrow("a synced folder");
		expect(statfsCalls).toEqual([]);
	});
});

describe("T6 a nonexistent path is judged by its nearest existing ancestor", () => {
	const path = join(scratch, "a", "b", "c", "l.db");
	test("statfs is handed the canonical existing ancestor", () => {
		const { probe, statfsCalls } = recordingProbe();
		expect(localityGuards(probe).assertLocalPath(path, join(scratch, "home"))).toBe(path);
		expect(statfsCalls).toEqual([scratch]);
	});

	test("the real probe answers local", () => {
		expect(mountLocality(path)).toBe("local");
		expect(assertLocalPath(path)).toBe(path);
	});
});

describe("T7 the live ledger is refused with HOME changed", () => {
	test("a path under the passwd home's .agent-system-2 throws LiveLedgerUnderTestError", () => {
		const passwd = native.passwdHomeOf(uid);
		if (!passwd.ok) throw new Error(passwd.why);
		const saved = { HOME: process.env.HOME, real: process.env[TEST_REAL_HOME_ENV], realDb: process.env[TEST_REAL_LEDGER_DB_ENV] };
		process.env.HOME = mkdtempSync(join(scratch, "home7-"));
		// Only the passwd lookup names the real home now.
		process.env[TEST_REAL_HOME_ENV] = "";
		process.env[TEST_REAL_LEDGER_DB_ENV] = "";
		try {
			const live = join(passwd.home, ".agent-system-2");
			let thrown: unknown;
			try {
				assertNotLiveLedgerUnderTest(join(live, "ledger.db"));
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(LiveLedgerUnderTestError);
			expect(thrown).toHaveProperty("root", live);
		} finally {
			process.env.HOME = saved.HOME;
			process.env[TEST_REAL_HOME_ENV] = saved.real;
			process.env[TEST_REAL_LEDGER_DB_ENV] = saved.realDb;
		}
	});

	test("a failed passwd lookup fails closed", () => {
		const guards = localityGuards(recordingProbe({ passwdHome: () => ({ ok: false, why: "no entry" }) }).probe);
		expect(() => guards.assertNotLiveLedgerUnderTest(join(scratch, "l.db"))).toThrow("cannot look up this user's passwd home (no entry)");
	});
});

describe("linuxLocality reads /proc/self/mountinfo", () => {
	test("octal escapes in the mount point are decoded", () => {
		const mountinfo = `${ROOT_LINE}\n41 22 0:60 / /mnt/my\\040share\\011tab\\012nl\\134bs rw - cifs //srv/s rw\n`;
		expect(linuxLocality(mountinfo, makedev(0n, 60n), "/mnt/x")).toBe("network:/mnt/my share\ttab\nnl\\bs is cifs");
	});

	test("the path's device wins over a longer-prefix entry of another device (local hidden under a network over-mount)", () => {
		const mountinfo = [
			ROOT_LINE,
			"30 22 8:2 / /mnt/data rw - ext4 /dev/sda2 rw",
			"31 30 8:3 / /mnt/data/sub rw - ext4 /dev/sda3 rw",
			"32 22 0:50 / /mnt/data rw shared:7 - nfs4 server:/export rw",
		].join("\n");
		expect(linuxLocality(mountinfo, makedev(0n, 50n), "/mnt/data/sub/l.db")).toBe("network:/mnt/data is nfs4");
	});

	test("a bind mount of a local device is local", () => {
		const mountinfo = `${ROOT_LINE}\n50 22 8:1 /srv/data /bind rw shared:1 - ext4 /dev/sda1 rw\n`;
		expect(linuxLocality(mountinfo, makedev(8n, 1n), "/bind/l.db")).toBe("local");
	});

	test("a high major and minor (dev_t above 2^32) match their major:minor", () => {
		const dev = makedev(0x1234n, 0xabcdefn);
		expect(dev > 2n ** 32n).toBe(true);
		const mountinfo = `${ROOT_LINE}\n60 22 4660:11259375 / /mnt/big rw - xfs /dev/big rw\n`;
		expect(linuxLocality(mountinfo, dev, "/mnt/big")).toBe("local");
		expect(linuxLocality(mountinfo.replace("xfs", "nfs"), dev, "/mnt/big")).toBe("network:/mnt/big is nfs");
	});

	test("no entry for the device is unknown", () => {
		expect(linuxLocality(ROOT_LINE, makedev(0n, 99n), "/x")).toBe("unknown:no mountinfo entry for device 0:99 (/x)");
	});

	test.each([
		["a line without the separator", "22 1 8:1 / / rw shared:1 ext4 /dev/sda1 rw"],
		["a line with a bad device", "22 1 8-1 / / rw - ext4 /dev/sda1 rw"],
		["a line missing the super options", "22 1 8:1 / / rw - ext4 /dev/sda1"],
		["a line with an empty filesystem type", "22 1 8:1 / / rw -  /dev/sda1 rw"],
		["a line with a relative mount point", "22 1 8:1 / relative rw - ext4 /dev/sda1 rw"],
	])("%s is unknown, not skipped", (_, line) => {
		expect(linuxLocality(`${line}\n${ROOT_LINE}\n`, makedev(8n, 1n), "/x")).toStartWith("unknown:malformed /proc/self/mountinfo line: ");
	});
});

describe("native boundary", () => {
	test("N1 a library that does not load fails both lookups, on every call", () => {
		const n = openNative({ libPath: "/nonexistent/libnone.dylib" });
		for (let i = 0; i < 2; i++) {
			expect(n.statfsMount("/").ok).toBe(false);
			const pw = n.passwdHomeOf(uid);
			expect(pw).toEqual({ ok: false, why: expect.stringContaining("/nonexistent/libnone.dylib") });
		}
	});

	test("N2 a symbol the real library lacks fails both lookups", () => {
		const n = openNative({ symbols: { statfs: "as2_no_such_symbol_statfs", getpwuid_r: "as2_no_such_symbol_getpwuid_r" } });
		for (let i = 0; i < 2; i++) {
			expect(n.statfsMount("/")).toEqual(darwin ? { ok: false, why: expect.stringContaining("as2_no_such_symbol_statfs") } : { ok: false, why: expect.any(String) });
			expect(n.passwdHomeOf(uid)).toEqual({ ok: false, why: expect.stringContaining("as2_no_such_symbol_getpwuid_r") });
		}
	});

	test.skipIf(!darwin)("N3 statfs of a missing path fails with its errno", () => {
		const missing = join(scratch, "missing", "deeper");
		expect(native.statfsMount(missing)).toEqual({ ok: false, why: `statfs ${missing}: errno 2` });
	});

	test("N3 an unused uid has no passwd home", () => {
		expect(native.passwdHomeOf(2147483000)).toEqual({ ok: false, why: "no passwd entry for uid 2147483000" });
	});

	test("the real lookups answer", () => {
		expect(native.passwdHomeOf(uid)).toMatchObject({ ok: true, home: expect.stringMatching(/^\//) });
		if (darwin) expect(native.statfsMount("/")).toEqual({ ok: true, local: true, mountOn: "/", fsType: expect.stringMatching(/^[a-z0-9]+$/) });
	});
});

describe("N4 decoders refuse what they cannot trust", () => {
	function statfsBytes(fields: { flags?: number; type?: Uint8Array | string; on?: Uint8Array | string }): Uint8Array {
		const bytes = new Uint8Array(2168);
		new DataView(bytes.buffer).setUint32(64, fields.flags ?? 0x1000, true);
		const put = (value: Uint8Array | string, at: number) => bytes.set(typeof value === "string" ? new TextEncoder().encode(value) : value, at);
		put(fields.type ?? "apfs", 72);
		put(fields.on ?? "/System/Volumes/Data", 88);
		return bytes;
	}

	test("a well-formed statfs decodes, MNT_LOCAL deciding local", () => {
		expect(decodeStatfs(statfsBytes({}))).toEqual({ ok: true, local: true, mountOn: "/System/Volumes/Data", fsType: "apfs" });
		expect(decodeStatfs(statfsBytes({ flags: 0x1, type: "autofs", on: "/home" }))).toEqual({ ok: true, local: false, mountOn: "/home", fsType: "autofs" });
	});

	test.each([
		["an unterminated type name", { type: new Uint8Array(16).fill(0x61) }],
		["an empty type name", { type: new Uint8Array([0]) }],
		["an unprintable type name", { type: "ap\x01fs" }],
		["a relative mount-on", { on: "Volumes/Data" }],
		["an unterminated mount-on", { on: `/${"a".repeat(1023)}` }],
	])("statfs with %s is refused", (_, fields) => {
		expect(decodeStatfs(statfsBytes(fields)).ok).toBe(false);
	});

	test("a short statfs buffer is refused", () => {
		expect(decodeStatfs(new Uint8Array(1000)).ok).toBe(false);
	});

	const DARWIN = { size: 72, uid: 16, dir: 48 };
	const BUF_ADDR = 0x10000;
	const PWD_ADDR = 0x20000;
	function passwdCall(over: { dir?: string | Uint8Array; dirAddr?: number; pwUid?: number; resultAddr?: number; layout?: typeof DARWIN } = {}): PasswdCall {
		const layout = over.layout ?? DARWIN;
		const bufBytes = new Uint8Array(64);
		const dir = over.dir ?? "/Users/someone\0";
		bufBytes.set(typeof dir === "string" ? new TextEncoder().encode(dir) : dir, 8);
		const pwdBytes = new Uint8Array(layout.size);
		const pwd = new DataView(pwdBytes.buffer);
		pwd.setUint32(layout.uid, over.pwUid ?? 501, true);
		pwd.setBigUint64(layout.dir, BigInt(over.dirAddr ?? BUF_ADDR + 8), true);
		return { pwdBytes, pwdAddr: PWD_ADDR, resultAddr: over.resultAddr ?? PWD_ADDR, bufBytes, bufAddr: BUF_ADDR, uid: 501, layout };
	}

	test("a well-formed passwd answer decodes, Darwin and glibc layouts", () => {
		expect(decodePasswd(passwdCall())).toEqual({ ok: true, home: "/Users/someone" });
		expect(decodePasswd(passwdCall({ layout: { size: 48, uid: 16, dir: 32 } }))).toEqual({ ok: true, home: "/Users/someone" });
	});

	test.each([
		["a result that is not the struct passed in", { resultAddr: PWD_ADDR + 8 }],
		["a null result", { resultAddr: 0 }],
		["another uid", { pwUid: 502 }],
		["pw_dir past the buffer", { dirAddr: BUF_ADDR + 64 }],
		["pw_dir before the buffer", { dirAddr: BUF_ADDR - 1 }],
		["no NUL in the buffer", { dir: new Uint8Array(56).fill(0x61) }],
		["a relative dir", { dir: "Users/someone\0" }],
	])("passwd with %s is refused", (_, over) => {
		expect(decodePasswd(passwdCall(over)).ok).toBe(false);
	});
});
