import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { sweepLegacyNativeTemps } from "../src/as2test-temp";
import { tmp } from "./helpers";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const legacy = (counter: string) => `.0123456789abcdef-${counter}.pi-natives-darwin-arm64`;
function directory(parent: string, name: string, mtime = 699_999): string {
  const path = join(parent, name);
  mkdirSync(path);
  utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

describe("sweepLegacyNativeTemps", () => {
  test("removes only exact, old, real, directly-owned native extraction directories", () => {
    const parent = realpathSync(tmp("native-sweep")); dirs.push(parent);
    const old = directory(parent, legacy("0000000B"));
    const recent = directory(parent, legacy("2"), 700_001);
    const boundary = directory(parent, legacy("3"), 700_000);
    const wrongFamily = directory(parent, ".0123456789abcdef-4.pi-natives-darwin-arm64-extra");
    const alteredHash = directory(parent, ".not-a-hash-5.pi-natives-darwin-arm64");
    const target = directory(parent, "outside-target");
    const link = join(parent, legacy("7")); symlinkSync(target, link);
    const result = sweepLegacyNativeTemps(parent, process.getuid!(), 1_000_000);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "removed", path: old });
    for (const path of [recent, boundary, wrongFamily, alteredHash, target, link]) expect(lstatSync(path)).toBeDefined();
  });

  test("preserves matching directories when their uid is not the requested owner", () => {
    const parent = realpathSync(tmp("native-uid")); dirs.push(parent);
    const foreign = directory(parent, legacy("1"));
    expect(sweepLegacyNativeTemps(parent, process.getuid!() + 1, 1_000_000)).toEqual([]);
    expect(lstatSync(foreign).isDirectory()).toBe(true);
  });
});
