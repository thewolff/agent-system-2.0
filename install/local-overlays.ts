import { closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { localConfigPath, parseProviderLabs, secureLocalFile } from "../classifier/src/local-provider-labs";

function mapping(text: string, path: string): Record<string, unknown> {
	let value: unknown;
	try { value = Bun.YAML.parse(text); } catch (error) { throw new Error(`${path} is not valid YAML: ${String(error)}`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be a YAML mapping`);
	return value as Record<string, unknown>;
}

export function configOverlayPath(env: Record<string, string | undefined> = process.env): string | null {
	const path = localConfigPath("config.yml", env);
	return secureLocalFile(path) === null ? null : path;
}

function atomicWrite(destination: string, text: string): void {
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	const tmp = join(dirname(destination), `.${basename(destination)}.${crypto.randomUUID()}.tmp`);
	let fd = -1;
	try {
		fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		writeSync(fd, text); fsyncSync(fd); closeSync(fd); fd = -1;
		renameSync(tmp, destination);
	} finally { if (fd >= 0) closeSync(fd); rmSync(tmp, { force: true }); }
}

export function snapshotConfig(destinationDir: string, env: Record<string, string | undefined> = process.env): string | null {
	const source = localConfigPath("config.yml", env);
	const text = secureLocalFile(source);
	if (text === null) return null;
	mapping(text, source);
	const destination = join(destinationDir, "config.yml");
	atomicWrite(destination, text);
	return destination;
}

export function validateLocalOverlays(env: Record<string, string | undefined> = process.env): void {
	const config = localConfigPath("config.yml", env);
	const configText = secureLocalFile(config);
	if (configText !== null) mapping(configText, config);
	const models = localConfigPath("models.yml", env);
	const modelText = secureLocalFile(models);
	if (modelText !== null) {
		const parsed = mapping(modelText, models);
		if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) throw new Error(`${models} must contain a providers mapping`);
	}
	const labs = localConfigPath("provider-labs.yml", env);
	const labText = secureLocalFile(labs);
	if (labText !== null) parseProviderLabs(labText, labs);
}

export function mergeModels(baseText: string, env: Record<string, string | undefined> = process.env): { text: string; overlaid: boolean } {
	const path = localConfigPath("models.yml", env);
	const localText = secureLocalFile(path);
	if (localText === null) return { text: baseText, overlaid: false };
	const base = mapping(baseText, "profile/models.yml");
	const local = mapping(localText, path);
	const providers = local.providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) throw new Error(`${path} must contain a providers mapping`);
	const publicProviders = (base.providers && typeof base.providers === "object" && !Array.isArray(base.providers)) ? base.providers as Record<string, unknown> : {};
	for (const provider of Object.keys(providers)) if (Object.hasOwn(publicProviders, provider)) throw new Error(`${path} cannot replace public provider ${provider}`);
	return { text: Bun.YAML.stringify({ ...base, providers: { ...publicProviders, ...providers } }), overlaid: true };
}

export async function installModels(basePath: string, destination: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
	const merged = mergeModels(await Bun.file(basePath).text(), env);
	atomicWrite(destination, merged.text);
	return merged.overlaid;
}

if (import.meta.main) {
	try {
		const [command, ...args] = process.argv.slice(2);
		if (command === "validate") validateLocalOverlays();
		else if (command === "snapshot-config" && args.length === 1) process.stdout.write(`${snapshotConfig(args[0]!) ?? ""}\n`);
		else if (command === "install-models" && args.length === 2) process.stdout.write((await installModels(args[0]!, args[1]!)) ? "overlaid\n" : "public-only\n");
		else throw new Error("usage: bun install/local-overlays.ts validate | snapshot-config <dir> | install-models <base> <destination>");
	} catch (error) {
		process.stderr.write(`local overlays: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	}
}
