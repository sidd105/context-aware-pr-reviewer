import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { loadConfig } from '../config/loader.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import type { Finding } from '../core/model.js';
import type { McpClientPool, Registry } from '../core/plugin.js';
import { assess, type Assessment } from './assess.js';

// Benchmarks AI evaluators against an organization's own labelled examples,
// so model choice is based on how well a model applies *your* rules rather
// than on general leaderboards.

export const BenchDataset = z.object({
  repository: z.string(),
  config: z.string(),
  profiles: z.array(z.string()).min(1),
  runs: z.number().int().positive().default(3),
  // Lines within this distance count as the same finding.
  line_tolerance: z.number().int().nonnegative().default(3),
  expected: z.array(
    z.object({
      rule_id: z.string(),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
      // "failed": the rule should fire here. "passed": any finding for this rule is a false positive.
      status: z.enum(['failed', 'passed']).default('failed'),
      note: z.string().optional(),
    }),
  ),
});
export type BenchDataset = z.infer<typeof BenchDataset>;

export interface ProfileResult {
  profile: string;
  models: string[];
  runs: number;
  precision: number;
  recall: number;
  f1: number;
  // Mean pairwise Jaccard similarity of finding sets across runs: 1 = identical every run.
  consistency: number;
  false_positives: number;
  false_negatives: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number | null;
  mean_latency_ms: number;
  errors: number;
}

export function scoreRun(findings: Finding[], dataset: BenchDataset): { tp: number; fp: number; fn: number } {
  const agentic = findings.filter((f) => f.evidence_type === 'agentic' && f.status === 'failed');
  const labelledRules = new Set(dataset.expected.map((e) => e.rule_id));
  const expectedFails = dataset.expected.filter((e) => e.status === 'failed');
  const matched = new Set<Finding>();
  let tp = 0;
  for (const e of expectedFails) {
    const hit = agentic.find(
      (f) =>
        !matched.has(f) &&
        f.rule_id === e.rule_id &&
        (!e.file || f.location.file === e.file) &&
        (!e.line || (f.location.start_line !== undefined && Math.abs(f.location.start_line - e.line) <= dataset.line_tolerance)),
    );
    if (hit) {
      matched.add(hit);
      tp++;
    }
  }
  // Only findings for rules the dataset labels are judged; others are unknown.
  const fp = agentic.filter((f) => labelledRules.has(f.rule_id) && !matched.has(f)).length;
  return { tp, fp, fn: expectedFails.length - tp };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / (a.size + b.size - inter);
}

function onlyProfile(config: Config, profile: string): Config {
  if (!config.ai.models[profile]) throw new Error(`Model profile ${profile} is not defined in ai.models`);
  return {
    ...config,
    ai: {
      ...config.ai,
      enabled: true,
      routing: { default: profile, fallback: [], evaluators: {}, categories: {}, tiers: {}, environments: {} },
    },
  };
}

export async function runBenchmark(
  datasetFile: string,
  options: { logger: Logger; registry?: () => Registry; mcp?: McpClientPool },
): Promise<{ dataset: BenchDataset; results: ProfileResult[] }> {
  const raw = parseYaml(await readFile(datasetFile, 'utf8'));
  const dataset = BenchDataset.parse(raw);
  const base = dirname(resolve(datasetFile));
  const results: ProfileResult[] = [];

  for (const profile of dataset.profiles) {
    const runs: Assessment[] = [];
    let errors = 0;
    for (let i = 0; i < dataset.runs; i++) {
      options.logger.info(`bench: ${profile} run ${i + 1}/${dataset.runs}`);
      const a = await assess({
        repo: resolve(base, dataset.repository),
        configFile: resolve(base, dataset.config),
        logger: options.logger,
        configOverride: (c) => onlyProfile(c, profile),
        ...(options.registry ? { registry: options.registry() } : {}),
        ...(options.mcp ? { mcp: options.mcp } : {}),
      });
      errors += a.rules.filter((r) => r.evidence_type === 'agentic' && r.status === 'error').length;
      runs.push(a);
    }
    const scores = runs.map((r) => scoreRun(r.findings, dataset));
    const tp = scores.reduce((s, x) => s + x.tp, 0);
    const fp = scores.reduce((s, x) => s + x.fp, 0);
    const fn = scores.reduce((s, x) => s + x.fn, 0);
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const sets = runs.map((r) => new Set(r.findings.filter((f) => f.evidence_type === 'agentic' && f.status === 'failed').map((f) => f.id)));
    const pairs: number[] = [];
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) pairs.push(jaccard(sets[i]!, sets[j]!));
    const input = runs.reduce((s, r) => s + r.provenance.ai.input_tokens, 0);
    const output = runs.reduce((s, r) => s + r.provenance.ai.output_tokens, 0);
    const cost = (await loadConfig(resolve(base, dataset.config))).config.ai.models[profile]?.cost_per_mtok;
    const latencies = runs.flatMap((r) => r.findings.flatMap((f) => (f.ai?.latency_ms !== undefined ? [f.ai.latency_ms] : [])));
    results.push({
      profile,
      models: [...new Set(runs.flatMap((r) => r.provenance.ai.models))],
      runs: runs.length,
      precision: Number(precision.toFixed(3)),
      recall: Number(recall.toFixed(3)),
      f1: Number((precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)).toFixed(3)),
      consistency: Number((pairs.length ? pairs.reduce((s, x) => s + x, 0) / pairs.length : 1).toFixed(3)),
      false_positives: fp,
      false_negatives: fn,
      input_tokens: input,
      output_tokens: output,
      estimated_cost_usd: cost ? Number(((input * cost.input + output * cost.output) / 1_000_000).toFixed(4)) : null,
      mean_latency_ms: latencies.length ? Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length) : 0,
      errors,
    });
  }
  return { dataset, results };
}

export function renderBenchmark(results: ProfileResult[]): string {
  const lines = [
    '| Profile | Models | Precision | Recall | F1 | Consistency | FP | FN | Tokens (in/out) | Est. cost | Mean latency | Errors |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.profile} | ${r.models.join(', ')} | ${r.precision} | ${r.recall} | ${r.f1} | ${r.consistency} | ${r.false_positives} | ${r.false_negatives} | ${r.input_tokens}/${r.output_tokens} | ${r.estimated_cost_usd === null ? '—' : `$${r.estimated_cost_usd}`} | ${r.mean_latency_ms} ms | ${r.errors} |`,
    );
  }
  return lines.join('\n');
}
