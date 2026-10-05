import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ModelRouter } from '../ai/router.js';
import { loadConfig, type LoadedConfig } from '../config/loader.js';
import type { Config } from '../config/schema.js';
import { dedupeFindings, sha256 } from '../core/finding.js';
import type { Logger } from '../core/logger.js';
import { maxSeverity, type AIProvenance, type Finding, type ResolvedRule, type RuleOutcome } from '../core/model.js';
import { loadPluginModule, type AssessmentContext, type McpClientPool, type Registry } from '../core/plugin.js';
import { Workspace } from '../core/workspace.js';
import { makeFinding } from '../core/finding.js';
import { Finding as FindingSchema } from '../core/model.js';
import { errorOutcome, outcome as makeOutcome, ruleFinding, skipped } from '../evaluators/util.js';
import { StaticMcpPool, StdioMcpPool } from '../mcp/client.js';
import { builtinRegistry } from '../plugins/builtin.js';
import { loadRules } from '../rules/loader.js';
import { rate, type Rating, type ScoredRule } from '../scoring/engine.js';
import { applyWaivers, loadWaivers } from '../scoring/waivers.js';

export const ASSESSMENT_SCHEMA_VERSION = '1.0';

export interface AssessOptions {
  repo: string;
  configFile: string;
  // Trusted organization config, always applied as the base layer.
  orgConfig?: string | undefined;
  diff?: { base: string; head: string } | undefined;
  environment?: string | undefined;
  // Force AI off regardless of config (e.g. --no-ai).
  disableAI?: boolean;
  // Adjust the loaded config before the run (used by the model benchmark).
  configOverride?: (config: Config) => Config;
  logger: Logger;
  // Injection points for tests and embedding.
  registry?: Registry;
  mcp?: McpClientPool;
  signal?: AbortSignal;
}

export interface RuleRecord {
  rule_id: string;
  title: string;
  ruleset?: string | undefined;
  ruleset_version?: string | undefined;
  source: string;
  category: string;
  severity: string;
  enforcement: string;
  evaluator: string;
  evidence_type: string;
  status: string;
  confidence: number;
  detail?: string | undefined;
  finding_ids: string[];
  overridden_by?: string | undefined;
}

export interface Assessment {
  schema_version: string;
  id: string;
  started_at: string;
  duration_ms: number;
  repository: { name: string; root: string; commit: string | null };
  scope: { mode: 'full' | 'diff'; base?: string; head?: string; files: number };
  environment?: string | undefined;
  provenance: {
    tool_version: string;
    config_files: string[];
    config_sha256: string;
    rulesets: Array<{ id: string; version: string; source: string; owner?: string | undefined; rules: number }>;
    plugins: Array<{ name: string; version: string }>;
    connectors: Array<{ name: string; type: string; ok: boolean; summary: string; tool?: { name: string; version?: string } }>;
    ai: { enabled: boolean; calls: number; models: string[]; input_tokens: number; output_tokens: number };
  };
  rating: Rating;
  rules: RuleRecord[];
  findings: Finding[];
  warnings: string[];
}

async function runWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

export async function assess(options: AssessOptions): Promise<Assessment> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const { logger } = options;
  const warnings: string[] = [];

  const loaded: LoadedConfig = await loadConfig(options.configFile, options.orgConfig ? { orgConfig: options.orgConfig } : {});
  let config: Config = options.configOverride ? options.configOverride(loaded.config) : loaded.config;
  if (options.disableAI) config = { ...config, ai: { ...config.ai, enabled: false } };
  warnings.push(...loaded.warnings);

  const registry = options.registry ?? builtinRegistry();
  for (const spec of config.plugins) registry.register(await loadPluginModule(spec));

  const workspace = await Workspace.open(options.repo, { exclude: config.exclude, ...(options.diff ? { diff: options.diff } : {}) });
  const mcp = options.mcp ?? (Object.keys(config.mcp_servers).length > 0 ? new StdioMcpPool(config.mcp_servers, logger) : new StaticMcpPool());
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort());

  try {
    // ---- Rules ---------------------------------------------------------------
    const { rules: allRules, rulesets, warnings: ruleWarnings } = await loadRules(config.rulesets, config.rule_overrides, registry, { mcp, logger });
    warnings.push(...ruleWarnings);
    const rules = allRules.filter((r) => r.enabled);
    logger.info(`Loaded ${rules.length} rules from ${rulesets.length} ruleset(s)`);

    // ---- Connectors -----------------------------------------------------------
    const baseCtx: Omit<AssessmentContext, 'toolFindings' | 'connectorStatus'> = {
      sdk: { ruleFinding, outcome: makeOutcome, skipped, makeFinding },
      workspace,
      config,
      logger,
      ai: ModelRouter.create(config.ai, registry, options.environment, logger, workspace.root),
      environment: options.environment,
      mcp,
      signal: controller.signal,
    };
    const toolFindings: Finding[] = [];
    const connectorStatus = new Map<string, { ok: boolean; detail: string }>();
    const connectorRecords: Assessment['provenance']['connectors'] = [];
    const connectorEntries = Object.entries(config.connectors).filter(([, c]) => c.enabled);
    await runWithLimit(connectorEntries, config.execution.concurrency, async ([name, c]) => {
      const connector = registry.connectors.get(c.type);
      if (!connector) {
        connectorStatus.set(name, { ok: false, detail: `unknown connector type ${c.type}` });
        connectorRecords.push({ name, type: c.type, ok: false, summary: `unknown connector type ${c.type}` });
        return;
      }
      try {
        const result = await withTimeout(
          connector.collect(name, c, { ...baseCtx, toolFindings: [], connectorStatus }),
          config.execution.timeout_seconds * 1000,
          `connector ${name}`,
        );
        // Plugins are untrusted code: their findings must match the schema.
        const valid = result.findings.map((f) => FindingSchema.parse(f));
        // Every connector's findings carry its name, so rules can reference it.
        toolFindings.push(...valid.map((f) => (f.tags.includes(`connector:${name}`) ? f : { ...f, tags: [...f.tags, `connector:${name}`] })));
        connectorStatus.set(name, { ok: true, detail: result.summary });
        connectorRecords.push({ name, type: c.type, ok: true, summary: result.summary, tool: result.tool });
        logger.info(`Connector ${name}: ${result.summary}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        connectorStatus.set(name, { ok: false, detail: message });
        connectorRecords.push({ name, type: c.type, ok: false, summary: message });
        warnings.push(`Connector ${name} failed: ${message}`);
      }
    });
    const ctx: AssessmentContext = { ...baseCtx, toolFindings: dedupeFindings(toolFindings), connectorStatus };

    // ---- Evaluators -----------------------------------------------------------
    const byEvaluator = new Map<string, ResolvedRule[]>();
    for (const r of rules) byEvaluator.set(r.evaluator, [...(byEvaluator.get(r.evaluator) ?? []), r]);
    const outcomes: RuleOutcome[] = [];
    await runWithLimit([...byEvaluator], config.execution.concurrency, async ([id, group]) => {
      const evaluator = registry.evaluator(id);
      try {
        const raw = await withTimeout(evaluator.evaluate(group, ctx), config.execution.timeout_seconds * 1000, `evaluator ${id}`);
        // A malformed finding turns that rule into an error instead of corrupting the rating.
        const results = raw.map((o) => {
          try {
            return { ...o, findings: o.findings.map((f) => FindingSchema.parse(f)) };
          } catch (error) {
            return errorOutcome(o.rule, evaluator.evidenceType, new Error(`${id} produced an invalid finding: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`));
          }
        });
        // An evaluator that forgets a rule must not make it look passed.
        const seen = new Set(results.map((o) => o.rule.id));
        outcomes.push(...results, ...group.filter((r) => !seen.has(r.id)).map((r) => errorOutcome(r, evaluator.evidenceType, new Error(`${id} returned no outcome`))));
      } catch (error) {
        outcomes.push(...group.map((r) => errorOutcome(r, evaluator.evidenceType, error)));
      }
    });

    // ---- Unmapped tool findings ---------------------------------------------
    const claimed = new Set(outcomes.flatMap((o) => o.findings.flatMap((f) => f.tags.filter((t) => t.startsWith('claimed:')).map((t) => t.slice(8)))));
    // Agent reports evaluate org rules by id; their records are claimed by agent.findings rules.
    const unmapped = config.unmapped_tool_findings === 'include' ? ctx.toolFindings.filter((f) => f.status === 'failed' && !claimed.has(f.id) && f.source === 'tool') : [];

    // ---- Waivers ----------------------------------------------------------------
    const allFindings = dedupeFindings([...outcomes.flatMap((o) => o.findings), ...unmapped]);
    const waived = applyWaivers(allFindings, await loadWaivers(config.waivers));
    warnings.push(...waived.warnings);
    const finalFindings = new Map(waived.findings.map((f) => [f.id, f]));

    // ---- Score ------------------------------------------------------------------
    const scored: ScoredRule[] = outcomes.map((o) => ({
      rule_id: o.rule.id,
      title: o.rule.title,
      ruleset: o.rule.ruleset,
      source: o.rule.source,
      category: o.rule.category,
      severity: o.rule.severity,
      enforcement: o.rule.enforcement,
      evidence_type: o.evidence_type,
      status: o.status,
      detail: o.detail,
      findings: o.findings.map((f) => finalFindings.get(f.id) ?? f),
    }));
    const unmappedByRule = new Map<string, Finding[]>();
    for (const f of unmapped) unmappedByRule.set(f.rule_id, [...(unmappedByRule.get(f.rule_id) ?? []), finalFindings.get(f.id) ?? f]);
    for (const [ruleId, findings] of unmappedByRule) {
      const first = findings[0]!;
      scored.push({
        rule_id: ruleId,
        title: first.message,
        source: 'tool',
        category: first.category,
        severity: maxSeverity(findings.map((f) => f.severity)),
        enforcement: 'scored',
        evidence_type: first.evidence_type,
        status: 'failed',
        tool: first.tool?.name,
        findings,
      });
    }
    const rating = rate(scored, config.scoring, config.gates);

    // ---- Provenance ---------------------------------------------------------------
    const findings = [...finalFindings.values()];
    const aiCalls = new Map<string, AIProvenance>();
    for (const f of findings) if (f.ai) aiCalls.set(f.ai.prompt_sha256, f.ai);
    const configText = (await Promise.all(loaded.files.map((f) => readFile(f, 'utf8')))).join('\n---\n');
    const toolVersion = '0.2.0';

    return {
      schema_version: ASSESSMENT_SCHEMA_VERSION,
      id: sha256(`${workspace.commit ?? ''}|${startedAt}|${options.configFile}`).slice(0, 12),
      started_at: startedAt,
      duration_ms: Date.now() - started,
      repository: { name: config.repository ?? basename(workspace.root), root: workspace.root, commit: workspace.commit },
      scope: workspace.diff
        ? { mode: 'diff', base: workspace.diff.base, head: workspace.diff.head, files: workspace.diff.changedFiles.length }
        : { mode: 'full', files: workspace.files.length },
      environment: options.environment,
      provenance: {
        tool_version: toolVersion,
        config_files: loaded.files,
        config_sha256: sha256(configText),
        rulesets,
        plugins: registry.plugins,
        connectors: connectorRecords,
        ai: {
          enabled: config.ai.enabled,
          calls: aiCalls.size,
          models: [...new Set([...aiCalls.values()].map((a) => `${a.provider}/${a.model}`))],
          input_tokens: [...aiCalls.values()].reduce((s, a) => s + (a.input_tokens ?? 0), 0),
          output_tokens: [...aiCalls.values()].reduce((s, a) => s + (a.output_tokens ?? 0), 0),
        },
      },
      rating,
      rules: scored
        .map((r) => {
          const o = outcomes.find((x) => x.rule.id === r.rule_id);
          return {
            rule_id: r.rule_id,
            title: r.title,
            ruleset: r.ruleset,
            ruleset_version: o?.rule.ruleset_version,
            source: r.source,
            category: r.category,
            severity: r.severity,
            enforcement: r.enforcement,
            evaluator: o?.rule.evaluator ?? `connector`,
            evidence_type: r.evidence_type,
            status: r.status,
            confidence: o?.confidence ?? 1,
            detail: r.detail,
            finding_ids: r.findings.map((f) => f.id),
            overridden_by: o?.rule.overridden_by,
          };
        })
        .sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
      findings: findings.sort((a, b) => (a.location.file ?? '').localeCompare(b.location.file ?? '') || (a.location.start_line ?? 0) - (b.location.start_line ?? 0)),
      warnings,
    };
  } finally {
    if (mcp instanceof StdioMcpPool) await mcp.close();
  }
}
