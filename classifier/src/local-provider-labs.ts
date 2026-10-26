import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Lab } from "./lab";

const PROVIDER = /^[a-z0-9][a-z0-9._-]*$/;
const VALID_LABS: Record<Lab, true> = { anthropic: true, openai: true, kimi: true };
const BUILT_INS: Record<string, true> = { anthropic: true, openai: true, "openai-codex": true, "kimi-code": true, moonshot: true };

export const localConfigRoot = (env: Record<string, string | undefined> = process.env): string =>
	resolve(env.HOME || homedir(), ".as2");

export const localConfigPath = (name: "config.yml" | "models.yml" | "provider-labs.yml", env: Record<string, string | undefined> = process.env): string =>
	join(localConfigRoot(env), name);

export function secureLocalFile(path: string, uid: number | undefined = process.getuid?.()): string | null {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error(`${path} could not be opened securely: ${String(error)}`); }
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error(`${path} must be a regular file, not a symlink or special file`);
		if (uid !== undefined && stat.uid !== uid) throw new Error(`${path} must be owned by uid ${uid}`);
		if ((stat.mode & 0o077) !== 0) throw new Error(`${path} must have mode 0600 or stricter`);
		return readFileSync(fd, "utf8");
	} finally { closeSync(fd); }
}

export function parseProviderLabs(text: string, path = "provider-labs.yml"): Readonly<Record<string, Lab>> {
	let doc: unknown;
	try { doc = Bun.YAML.parse(text); } catch (error) { throw new Error(`${path} is not valid YAML: ${String(error)}`); }
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${path} must be a mapping with only a providers key`);
	const root = doc as Record<string, unknown>;
	if (Object.keys(root).some(key => key !== "providers")) throw new Error(`${path} has an unknown top-level key`);
	if (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers)) throw new Error(`${path} providers must be a mapping`);
	const out: Record<string, Lab> = {};
	for (const [provider, value] of Object.entries(root.providers as Record<string, unknown>)) {
		if (!PROVIDER.test(provider)) throw new Error(`${path} has invalid provider id ${JSON.stringify(provider)}`);
		if (Object.hasOwn(BUILT_INS, provider)) throw new Error(`${path} cannot remap built-in provider ${provider}`);
		if (typeof value !== "string" || !Object.hasOwn(VALID_LABS, value)) throw new Error(`${path} provider ${provider} must map to anthropic, openai, or kimi`);
		out[provider] = value as Lab;
	}
	return Object.freeze(out);
}

let cachedKey = "";
let cached: Readonly<Record<string, Lab>> = Object.freeze({});
export function localProviderLabs(env: Record<string, string | undefined> = process.env): Readonly<Record<string, Lab>> {
	const path = localConfigPath("provider-labs.yml", env);
	const text = secureLocalFile(path);
	const key = `${path}\0${text ?? ""}`;
	if (key !== cachedKey) { cachedKey = key; cached = text === null ? Object.freeze({}) : parseProviderLabs(text, path); }
	return cached;
}
