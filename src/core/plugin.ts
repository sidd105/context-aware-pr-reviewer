import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AIProvider } from '../ai/provider.js';
import type { ModelRouter } from '../ai/router.js';
import type { Config, ConnectorConfig, McpServerConfig, ProviderConfig, RuleSourceConfig } from '../config/schema.js';
import type { Logger } from './logger.js';
import type { EvidenceType, Finding, ResolvedRule, RuleOutcome } from './model.js';
import type { RuleSetDocument } from '../rules/schema.js';
import type { Workspace } from './workspace.js';

// Everything an evaluator or connector may use. Nothing in here lets a plugin
// change the rules, the scoring or another plugin's results.
export interface AssessmentContext {
  workspace: Workspace;
  config: Config;
  logger: Logger;
  // Present only when AI is enabled and at least one model is configured.
  ai: ModelRouter | null;
  // Findings collected from tool connectors, for tool-backed rules.
  toolFindings: readonly Finding[];
  // Which connectors ran, by config name, and whether they succeeded.
  connectorStatus: ReadonlyMap<string, { ok: boolean; detail: string }>;
  environment: string | undefined;
  mcp: McpClientPool;
  signal: AbortSignal;
  // Helpers for plugins, so a plugin package needn't import this one's internals.
  sdk: PluginSdk;
}

export interface PluginSdk {
  ruleFinding: typeof import('../evaluators/util.js').ruleFinding;
  outcome: typeof import('../evaluators/util.js').outcome;
  skipped: typeof import('../evaluators/util.js').skipped;
  makeFinding: typeof import('./finding.js').makeFinding;
}

export interface McpClientPool {
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string>;
  serverConfig(server: string): McpServerConfig;
}

// ---------------------------------------------------------------------------
// Evaluators: how to decide whether a rule is satisfied
// ---------------------------------------------------------------------------

export interface Evaluator {
  id: string;
  description: string;
  evidenceType: EvidenceType;
  // Validate a rule's params when rulesets load, so mistakes surface before a
  // run rather than as a runtime error halfway through.
  validateParams?(params: Record<string, unknown>, rule: ResolvedRule): string[];
  // Evaluators receive every rule that names them, so they can batch work
  // (one AST pass for all Python rules, one model call for related rules).
  evaluate(rules: ResolvedRule[], ctx: AssessmentContext): Promise<RuleOutcome[]>;
}

// ---------------------------------------------------------------------------
// Connectors: bring in findings from external tools
// ---------------------------------------------------------------------------

export interface Connector {
  type: string;
  description: string;
  collect(name: string, config: ConnectorConfig, ctx: AssessmentContext): Promise<ConnectorResult>;
}

export interface ConnectorResult {
  findings: Finding[];
  tool: { name: string; version?: string };
  // e.g. "read 214 issues from SonarQube project acme_payments"
  summary: string;
}

// ---------------------------------------------------------------------------
// Rule sources: where rules come from
// ---------------------------------------------------------------------------

export interface RuleSource {
  type: string;
  matches(config: RuleSourceConfig): boolean;
  load(config: RuleSourceConfig, ctx: Pick<AssessmentContext, 'mcp' | 'logger'>): Promise<RuleSetDocument[]>;
}

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------

export interface ProviderFactory {
  type: string;
  create(name: string, config: ProviderConfig): AIProvider;
}

// ---------------------------------------------------------------------------
// Plugins bundle any of the above
// ---------------------------------------------------------------------------

export interface Plugin {
  name: string;
  version: string;
  evaluators?: Evaluator[];
  connectors?: Connector[];
  ruleSources?: RuleSource[];
  providers?: ProviderFactory[];
}

export class Registry {
  readonly evaluators = new Map<string, Evaluator>();
  readonly connectors = new Map<string, Connector>();
  readonly ruleSources: RuleSource[] = [];
  readonly providers = new Map<string, ProviderFactory>();
  readonly plugins: Array<{ name: string; version: string }> = [];

  register(plugin: Plugin): this {
    const claim = <T>(map: Map<string, T>, key: string, value: T, kind: string) => {
      if (map.has(key)) throw new Error(`Plugin ${plugin.name}: ${kind} "${key}" is already registered`);
      map.set(key, value);
    };
    for (const e of plugin.evaluators ?? []) claim(this.evaluators, e.id, e, 'evaluator');
    for (const c of plugin.connectors ?? []) claim(this.connectors, c.type, c, 'connector');
    for (const p of plugin.providers ?? []) claim(this.providers, p.type, p, 'AI provider');
    this.ruleSources.push(...(plugin.ruleSources ?? []));
    this.plugins.push({ name: plugin.name, version: plugin.version });
    return this;
  }

  evaluator(id: string): Evaluator {
    const e = this.evaluators.get(id);
    if (!e) throw new Error(`Unknown evaluator "${id}". Registered: ${[...this.evaluators.keys()].sort().join(', ')}`);
    return e;
  }
}

// External plugins are ES modules whose default export is a Plugin.
export async function loadPluginModule(specifier: string): Promise<Plugin> {
  const target = isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
  const mod = (await import(target)) as { default?: Plugin };
  const plugin = mod.default;
  if (!plugin || typeof plugin.name !== 'string') {
    throw new Error(`${specifier} does not export a plugin as its default export`);
  }
  return plugin;
}
