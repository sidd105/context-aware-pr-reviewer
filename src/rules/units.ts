import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RuleSourceConfig, UnitMapping } from '../config/schema.js';
import type { RuleSource } from '../core/plugin.js';
import type { RuleSetDocument } from './schema.js';

// A knowledge unit as context-engineering-sdlc (or a similar store) describes
// it: an id, a level (must/should/may), a kind, a title and a body.
export interface KnowledgeUnit {
  id: string;
  title: string;
  level?: string;
  kind?: string;
  layer?: string;
  body?: string;
  content?: string;
  tags?: string[];
}

const DEFAULT_KINDS: Record<string, string> = {
  security: 'security',
  'testing-rule': 'testing',
  'coding-standard': 'code-quality',
  convention: 'code-quality',
  practice: 'sdlc',
  principle: 'architecture',
  adr: 'architecture',
  decision: 'architecture',
  'deployment-rule': 'sdlc',
  'business-rule': 'reliability',
};

export function unitsToRuleSet(units: KnowledgeUnit[], mapping: UnitMapping, meta: { id: string; version: string }): RuleSetDocument {
  const rules = units
    .filter((u) => !mapping.include_kinds || mapping.include_kinds.includes(u.kind ?? ''))
    .filter((u) => !mapping.include_layers || mapping.include_layers.includes(u.layer ?? ''))
    .map((u) => {
      const routed = mapping.evaluators[u.id];
      const category = mapping.kinds[u.kind ?? ''] ?? DEFAULT_KINDS[u.kind ?? ''] ?? mapping.default_category;
      return {
        id: `${mapping.id_prefix}${u.id}`,
        title: u.title,
        description: (u.body ?? u.content ?? '').trim(),
        category,
        severity: u.level === 'must' ? 'high' : mapping.default_severity,
        enforcement: mapping.levels[u.level ?? ''] ?? 'advisory',
        evaluator: routed?.evaluator ?? mapping.default_evaluator,
        params: routed?.params ?? {},
        tags: u.tags ?? [],
        references: [`unit:${u.id}`],
      };
    });
  return {
    apiVersion: 'cqr/v1',
    kind: 'RuleSet',
    metadata: { id: meta.id, version: meta.version, description: 'Imported from organizational knowledge units', source: 'organization', locked: false },
    extends: [],
    defaults: {},
    rules,
    overrides: [],
  };
}

async function yamlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await yamlFiles(full)));
    else if (/\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

export const contextUnitsRuleSource: RuleSource = {
  type: 'context-units',
  matches: (c) => 'type' in c && c.type === 'context-units',
  async load(c) {
    const config = c as Extract<RuleSourceConfig, { type: 'context-units' }>;
    const units: KnowledgeUnit[] = [];
    for (const file of await yamlFiles(config.path)) {
      const doc = parseYaml(await readFile(file, 'utf8')) as { units?: KnowledgeUnit[] } | null;
      for (const u of doc?.units ?? []) {
        if (u && typeof u.id === 'string' && typeof u.title === 'string') units.push(u);
      }
    }
    const id = config.ruleset ?? `units:${relative(process.cwd(), config.path) || config.path}`;
    return [unitsToRuleSet(units, config.mapping, { id, version: config.version })];
  },
};

// Asks an MCP server for rules. Built for context-engineering-sdlc's
// get_context tool with format=json, which returns { items: [...] }; any
// server returning { units: [...] } or { items: [...] } works the same way.
export const mcpRuleSource: RuleSource = {
  type: 'mcp',
  matches: (c) => 'type' in c && c.type === 'mcp',
  async load(c, ctx) {
    const config = c as Extract<RuleSourceConfig, { type: 'mcp' }>;
    const args = { format: 'json', ...config.arguments };
    const text = await ctx.mcp.callTool(config.server, config.tool, args);
    let parsed: { items?: KnowledgeUnit[]; units?: KnowledgeUnit[] };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`MCP server ${config.server} tool ${config.tool} did not return JSON. Pass arguments that request JSON output.`);
    }
    const units = (parsed.units ?? parsed.items ?? []).filter((u) => typeof u?.id === 'string');
    ctx.logger.info(`Loaded ${units.length} rules from MCP server ${config.server}`);
    return [unitsToRuleSet(units, config.mapping, { id: config.ruleset ?? `mcp:${config.server}`, version: config.version })];
  },
};
