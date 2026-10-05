import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, type Config } from './schema.js';

export const CONFIG_FILES = ['cqr.config.yaml', 'cqr.config.yml', '.cqr.yaml'];

export interface LoadedConfig {
  config: Config;
  // Absolute paths of every config file that contributed, base first.
  files: string[];
  // Directory relative paths in each file are resolved against.
  baseDirs: Map<string, string>;
  warnings: string[];
}

// Arrays that accumulate across extends (an org's rulesets plus a repo's);
// every other value from a later file replaces the earlier one.
const APPEND = new Set(['rulesets', 'rule_overrides', 'plugins', 'exclude']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function mergeConfig(base: Record<string, unknown>, over: Record<string, unknown>, path = ''): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    if (path === '' && APPEND.has(key) && Array.isArray(prev) && Array.isArray(value)) {
      out[key] = [...prev, ...value];
    } else if (isObject(prev) && isObject(value)) {
      out[key] = mergeConfig(prev, value, `${path}${key}.`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split('.');
  let o: Record<string, unknown> = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObject(o[k])) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  if (value === undefined) delete o[keys.at(-1)!];
  else o[keys.at(-1)!] = value;
}

// Paths in a config file are relative to that file. Rewrite them to absolute
// before merging so an org config in another directory keeps working.
function absolutize(raw: Record<string, unknown>, dir: string): Record<string, unknown> {
  const abs = (p: unknown) => (typeof p === 'string' && !isAbsolute(p) ? resolve(dir, p) : p);
  const out = structuredClone(raw);
  if (Array.isArray(out.rulesets)) {
    out.rulesets = out.rulesets.map((r) => (isObject(r) && 'path' in r ? { ...r, path: abs(r.path) } : r));
  }
  if (isObject(out.connectors)) {
    for (const c of Object.values(out.connectors)) if (isObject(c) && 'report' in c) c.report = abs(c.report);
  }
  if (typeof out.waivers === 'string') out.waivers = abs(out.waivers);
  const ai = out.ai;
  if (isObject(ai) && isObject(ai.providers)) {
    for (const p of Object.values(ai.providers)) if (isObject(p) && typeof p.file === 'string') p.file = abs(p.file);
  }
  if (Array.isArray(out.plugins)) out.plugins = out.plugins.map((p) => (typeof p === 'string' && p.startsWith('.') ? abs(p) : p));
  if (isObject(out.mcp_servers)) {
    for (const s of Object.values(out.mcp_servers)) if (isObject(s) && typeof s.cwd === 'string') s.cwd = abs(s.cwd);
  }
  return out;
}

async function readRaw(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(file, 'utf8');
  const parsed: unknown = parseYaml(text);
  if (parsed == null) return {};
  if (!isObject(parsed)) throw new Error(`${file}: expected a mapping at the top level`);
  return parsed;
}

// `orgConfig` is applied as the base layer whether or not the repository
// config extends it. CI passes it from a trusted checkout, so a pull request
// can't escape organization locks by deleting its `extends:` line.
export async function loadConfig(file: string, options: { orgConfig?: string } = {}): Promise<LoadedConfig> {
  const files: string[] = [];
  const baseDirs = new Map<string, string>();
  const warnings: string[] = [];

  async function load(path: string, seen: string[]): Promise<{ merged: Record<string, unknown>; locked: string[] }> {
    const abs = resolve(path);
    if (seen.includes(abs)) throw new Error(`Config extends itself: ${[...seen, abs].join(' -> ')}`);
    const raw = absolutize(await readRaw(abs), dirname(abs));
    let merged: Record<string, unknown> = {};
    let locked: string[] = [];
    let parents = (Array.isArray(raw.extends) ? (raw.extends as string[]) : []).map((p) => resolve(dirname(abs), p));
    if (seen.length === 0 && options.orgConfig) {
      const org = resolve(options.orgConfig);
      if (org !== abs) parents = [org, ...parents.filter((p) => p !== org)];
    }
    for (const parent of parents) {
      const loaded = await load(parent, [...seen, abs]);
      merged = mergeConfig(merged, loaded.merged);
      locked = [...locked, ...loaded.locked];
    }
    // Locked keys from a parent win over this file.
    const own = { ...raw };
    delete own.extends;
    for (const key of locked) {
      if (getPath(own, key) !== undefined) {
        warnings.push(`${abs}: "${key}" is locked by an organization config; the local value is ignored.`);
        setPath(own, key, undefined);
      }
    }
    merged = mergeConfig(merged, own);
    files.push(abs);
    baseDirs.set(abs, dirname(abs));
    const ownLocks = Array.isArray(raw.locked) ? (raw.locked as string[]) : [];
    return { merged, locked: [...locked, ...ownLocks] };
  }

  const { merged } = await load(file, []);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration in ${file}:\n${issues}`);
  }
  return { config: result.data, files, baseDirs, warnings };
}

export async function findConfig(repoRoot: string): Promise<string | null> {
  for (const name of CONFIG_FILES) {
    const candidate = resolve(repoRoot, name);
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // try the next name
    }
  }
  return null;
}
