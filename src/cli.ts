#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { AgentAssessment } from './connectors/agent.js';
import { findConfig, loadConfig } from './config/loader.js';
import { ConfigSchema } from './config/schema.js';
import { consoleLogger } from './core/logger.js';
import { Finding } from './core/model.js';
import { StaticMcpPool, StdioMcpPool } from './mcp/client.js';
import { assess, type Assessment } from './engine/assess.js';
import { renderBenchmark, runBenchmark } from './engine/bench.js';
import { builtinRegistry } from './plugins/builtin.js';
import { renderMarkdown } from './report/markdown.js';
import { renderSarif } from './report/sarif.js';
import { loadRules } from './rules/loader.js';
import { RuleSetDocument } from './rules/schema.js';
import { compareRuns, latestRuns, loadRun, saveRun } from './storage/history.js';

const HELP = `cqr — organization-defined code quality and security rating

Usage:
  cqr assess   [--repo .] [--config file] [--org-config file] [--base ref --head ref] [--env name]
               [--no-ai] [--format md,json,sarif] [--out-dir dir] [--save]
               [--fail-on fail|warn|never] [--min-grade B]
  cqr rules    list|validate [--config file]
  cqr explain  <run.json> [--rule ID]
  cqr compare  <old-run.json> <new-run.json>   (or --last to compare the two latest saved runs)
  cqr bench    <dataset.yaml>
  cqr schema   finding|agent-assessment|ruleset|config
  cqr init     [--repo .]

Exit codes: 0 ok, 1 gate or threshold failed, 2 usage or configuration error.
`;

const STARTER_CONFIG = `# cqr configuration. See docs/DESIGN.md for every option.
version: 1
organization: my-org

rulesets:
  - builtin: secure-baseline
  - builtin: python-zen
  # - path: rulesets/my-org.yaml

connectors: {}
  # semgrep: { type: sarif, report: reports/semgrep.sarif }
  # snyk:    { type: snyk, report: reports/snyk.json }

ai:
  enabled: false
`;

function fail(message: string): never {
  process.stderr.write(`cqr: ${message}\n`);
  process.exit(2);
}

async function configPath(repo: string, explicit: string | undefined): Promise<string> {
  if (explicit) return resolve(explicit);
  const found = await findConfig(repo);
  if (!found) fail(`no cqr.config.yaml in ${repo}; pass --config or run "cqr init"`);
  return found;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      repo: { type: 'string', default: '.' },
      config: { type: 'string' },
      'org-config': { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      env: { type: 'string' },
      'no-ai': { type: 'boolean', default: false },
      format: { type: 'string', default: 'md' },
      'out-dir': { type: 'string' },
      save: { type: 'boolean', default: false },
      'fail-on': { type: 'string', default: 'fail' },
      'min-grade': { type: 'string' },
      rule: { type: 'string' },
      last: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (!command || values.help || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  const logger = consoleLogger({ verbose: values.verbose, quiet: values.quiet });
  const repo = resolve(values.repo);

  switch (command) {
    case 'assess': {
      const config = await configPath(repo, values.config);
      const a = await assess({
        repo,
        configFile: config,
        orgConfig: values['org-config'] ?? process.env.CQR_ORG_CONFIG,
        diff: values.base ? { base: values.base, head: values.head } : undefined,
        environment: values.env ?? process.env.CQR_ENV,
        disableAI: values['no-ai'],
        logger,
      });
      const formats = values.format.split(',').map((f) => f.trim());
      const rendered: Record<string, string> = {};
      for (const f of formats) {
        if (f === 'md' || f === 'markdown') rendered.md = renderMarkdown(a);
        else if (f === 'json') rendered.json = JSON.stringify(a, null, 2);
        else if (f === 'sarif') rendered.sarif = renderSarif(a);
        else fail(`unknown format ${f}`);
      }
      if (values['out-dir']) {
        const dir = resolve(values['out-dir']);
        await mkdir(dir, { recursive: true });
        for (const [ext, text] of Object.entries(rendered)) await writeFile(join(dir, `cqr-report.${ext}`), text);
        logger.info(`Reports written to ${dir}`);
        process.stdout.write(`${a.rating.grade} ${a.rating.score ?? ''} ${a.rating.status}\n`);
      } else {
        process.stdout.write(`${rendered.md ?? rendered.json ?? rendered.sarif}\n`);
      }
      if (values.save) {
        const { config: c } = await loadConfig(config, values['org-config'] ? { orgConfig: values['org-config'] } : {});
        logger.info(`Saved run to ${await saveRun(a, c.storage.dir, c.storage.keep)}`);
      }
      return exitCode(a, values['fail-on'], values['min-grade']);
    }

    case 'rules': {
      const sub = positionals[0] ?? 'list';
      const { config } = await loadConfig(await configPath(repo, values.config));
      const mcp = Object.keys(config.mcp_servers).length ? new StdioMcpPool(config.mcp_servers, logger) : new StaticMcpPool();
      try {
        const loaded = await loadRules(config.rulesets, config.rule_overrides, builtinRegistry(), { mcp, logger });
        for (const w of loaded.warnings) logger.warn(w);
        if (sub === 'validate') {
          process.stdout.write(`OK: ${loaded.rules.length} rules from ${loaded.rulesets.map((s) => `${s.id}@${s.version}`).join(', ')}\n`);
          return 0;
        }
        const rows = loaded.rules.map((r) => `${r.enabled ? ' ' : '-'} ${r.id.padEnd(28)} ${r.enforcement.padEnd(13)} ${r.severity.padEnd(8)} ${r.category.padEnd(15)} ${r.evaluator.padEnd(20)} ${r.title}`);
        process.stdout.write(`${rows.join('\n')}\n\n${loaded.rules.length} rules ("-" = disabled)\n`);
        return 0;
      } finally {
        if (mcp instanceof StdioMcpPool) await mcp.close();
      }
    }

    case 'explain': {
      if (!positionals[0]) fail('explain needs a saved run (JSON report)');
      const a = await loadRun(positionals[0]);
      if (!values.rule) {
        process.stdout.write(`${a.rating.explanation.join('\n')}\n`);
        return 0;
      }
      const rule = a.rules.find((r) => r.rule_id === values.rule);
      if (!rule) fail(`rule ${values.rule} is not in this run`);
      const findings = a.findings.filter((f) => rule.finding_ids.includes(f.id));
      const deduction = a.rating.dimensions.flatMap((d) => d.deductions.map((x) => ({ d, x }))).find(({ x }) => x.rule_id === rule.rule_id);
      const gates = a.rating.gates.filter((g) => g.triggered && g.findings.some((id) => rule.finding_ids.includes(id)));
      const lines = [
        `${rule.rule_id}: ${rule.title}`,
        `  ruleset ${rule.ruleset ?? '—'}@${rule.ruleset_version ?? '—'}, ${rule.enforcement}, ${rule.severity}, ${rule.category}`,
        `  evaluated by ${rule.evaluator} (${rule.evidence_type}) -> ${rule.status}${rule.detail ? ` (${rule.detail})` : ''}`,
        deduction ? `  cost ${deduction.x.points} points in ${deduction.d.label} (${deduction.x.basis})` : '  no score impact',
        ...gates.map((g) => `  triggered gate ${g.id} (${g.action}${g.cap ? ` ${g.cap}` : ''})`),
        ...(rule.overridden_by ? [`  overridden by ${rule.overridden_by}`] : []),
        ...findings.map((f) => {
          const primary = a.rating.corroborated[f.id];
          const counted = primary ? `, counted once under ${a.findings.find((x) => x.id === primary)?.rule_id ?? primary}` : '';
          const low = a.rating.low_confidence.includes(f.id) ? ', below confidence threshold' : '';
          return `  - ${f.location.file ?? f.location.asset ?? ''}${f.location.start_line ? `:${f.location.start_line}` : ''} ${f.message} [confidence ${f.confidence}${f.waived ? ', waived' : ''}${counted}${low}]${f.ai ? ` via ${f.ai.provider}/${f.ai.model}` : ''}`;
        }),
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }

    case 'compare': {
      let [from, to] = positionals;
      if (values.last) {
        const { config } = await loadConfig(await configPath(repo, values.config));
        [from, to] = await latestRuns(resolve(repo, config.storage.dir), 2);
      }
      if (!from || !to) fail('compare needs two runs, or --last with at least two saved runs');
      const c = compareRuns(await loadRun(from), await loadRun(to));
      process.stdout.write(`${c.summary.join('\n')}\n`);
      for (const f of c.new_findings.slice(0, 20)) process.stdout.write(`  + ${f.severity} ${f.rule_id}: ${f.message}\n`);
      for (const f of c.resolved_findings.slice(0, 20)) process.stdout.write(`  - ${f.severity} ${f.rule_id}: ${f.message}\n`);
      return 0;
    }

    case 'bench': {
      if (!positionals[0]) fail('bench needs a dataset file');
      const { results } = await runBenchmark(positionals[0], { logger });
      process.stdout.write(`${renderBenchmark(results)}\n`);
      return 0;
    }

    case 'schema': {
      const schemas: Record<string, z.ZodType> = { finding: Finding, 'agent-assessment': AgentAssessment, ruleset: RuleSetDocument, config: ConfigSchema };
      const which = positionals[0] ?? 'finding';
      const schema = schemas[which];
      if (!schema) fail(`unknown schema ${which}; one of ${Object.keys(schemas).join(', ')}`);
      process.stdout.write(`${JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), null, 2)}\n`);
      return 0;
    }

    case 'init': {
      const target = join(repo, 'cqr.config.yaml');
      if (existsSync(target)) fail(`${target} already exists`);
      await writeFile(target, STARTER_CONFIG);
      process.stdout.write(`Wrote ${target}\n`);
      return 0;
    }

    default:
      fail(`unknown command "${command}"\n\n${HELP}`);
  }
}

function exitCode(a: Assessment, failOn: string, minGrade: string | undefined): number {
  if (failOn === 'fail' && a.rating.status === 'fail') return 1;
  if (failOn === 'warn' && a.rating.status !== 'pass') return 1;
  if (minGrade && a.rating.score !== null) {
    // Compare by grade order using the default scale.
    const order = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'];
    const have = order.indexOf(a.rating.grade);
    const want = order.indexOf(minGrade);
    if (want < 0) fail(`unknown grade ${minGrade}`);
    if (have > want) return 1;
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((error: unknown) => {
    process.stderr.write(`cqr: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });

