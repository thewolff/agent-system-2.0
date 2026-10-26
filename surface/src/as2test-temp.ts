import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { removeChild } from "./scratch-remove";
import type { Removal } from "./scratch-remove";

const LEGACY_NATIVE_TEMP = /^\.[0-9a-f]+-[0-9a-fA-F]+\.pi-natives-darwin-arm64$/;
const MAX_AGE_MS = 300_000;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Remove only old, directly-owned legacy native extraction directories immediately under a physical parent. */
export function sweepLegacyNativeTemps(parent: string, ownerUid: number, nowMs = Date.now()): Removal[] {
  let physicalParent: string;
  let names: string[];
  try {
    physicalParent = realpathSync.native(parent);
    if (physicalParent !== parent) return [{ kind: "refused", path: parent, reason: `${parent} resolves to ${physicalParent}: not the physical parent` }];
    names = readdirSync(physicalParent);
  } catch (error) {
    return [{ kind: "failed", path: parent, error: `enumerating ${parent}: ${message(error)}` }];
  }

  const results: Removal[] = [];
  for (const name of names) {
    if (!LEGACY_NATIVE_TEMP.test(name)) continue;
    const path = join(physicalParent, name);
    let stats;
    try {
      stats = lstatSync(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") results.push({ kind: "failed", path, error: `checking ${path}: ${message(error)}` });
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
    if (stats.uid !== BigInt(ownerUid) || Number(stats.mtimeMs) >= nowMs - MAX_AGE_MS) continue;

    const resolved = relative(physicalParent, path);
    if (resolved === "" || resolved === ".." || resolved.startsWith(`..${sep}`) || resolved.includes(sep)) continue;
    results.push(removeChild(physicalParent, name, { dev: stats.dev, ino: stats.ino }));
  }
  return results;
}
