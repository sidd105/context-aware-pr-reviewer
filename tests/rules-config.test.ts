import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, mergeConfig } from '../src/config/loader.js';
import { ConfigSchema } from '../src/config/schema.js';
import { silentLogger } from '../src/core/logger.js';
import { StaticMcpPool } from '../src/mcp/client.js';
import { builtinRegistry } from '../src/plugins/builtin.js';
import { loadRules } from '../src/rules/loader.js';

function tmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cqr-rules-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const ctx = { mcp: new StaticMcpPool(), logger: silentLogger() };

const ORG = `
apiVersion: cqr/v1
kind: RuleSet
metadata: { id: org, version: 1.0.0, locked: true }
rules:
  - id: ORG-1
    title: No TODO
    category: code-quality
    severity: high
    evaluator: pattern
    params: { pattern: TODO }
overrides:
  - id: PY-ZEN-004
    params: { max: 7 }
    severity: high
`;

describe('rule loading', () => {
  it('layers builtin rules, org rules, ruleset overrides and repository overrides', async () => {
    const dir = tmp({ 'org.yaml': ORG });
    const { rules, rulesets } = await loadRules(
      [{ builtin: 'python-zen' }, { path: join(dir, 'org.yaml') }],
      [{ id: 'PY-ZEN-005', params: { max: 30 } }],
      builtinRegistry(),
      ctx,
    );
    expect(rulesets.map((r) => r.id)).toEqual(['python-zen', 'org']);
    const complexity = rules.find((r) => r.id === 'PY-ZEN-004')!;
    expect(complexity).toMatchObject({ severity: 'high', params: { check: 'complexity', max: 7 }, overridden_by: 'ruleset org' });
    expect(rules.find((r) => r.id === 'PY-ZEN-005')!.params.max).toBe(30);
  });

  it('refuses to let a repository weaken a locked rule', async () => {
    const dir = tmp({ 'org.yaml': ORG });
    const { rules, warnings } = await loadRules([{ path: join(dir, 'org.yaml') }], [{ id: 'ORG-1', enabled: false }, { id: 'ORG-1', severity: 'low' }, { id: 'ORG-1', applies_to: { exclude: ['**'] } }, { id: 'ORG-1', severity: 'critical' }], builtinRegistry(), ctx);
    expect(rules[0]).toMatchObject({ enabled: true, severity: 'critical', applies_to: { exclude: [] } });
    expect(warnings.filter((w) => w.includes('cannot weaken'))).toHaveLength(2);
    expect(warnings.filter((w) => w.includes('cannot change the scope'))).toHaveLength(1);
  });

  it('rejects two rulesets defining the same rule id', async () => {
    const dir = tmp({ 'a.yaml': ORG, 'b.yaml': ORG.replace('id: org,', 'id: other,') });
    await expect(loadRules([{ path: join(dir, 'a.yaml') }, { path: join(dir, 'b.yaml') }], [], builtinRegistry(), ctx)).rejects.toThrow(/defined in both/);
  });

  it('validates evaluator names and params up front', async () => {
    const bad = ORG.replace('evaluator: pattern', 'evaluator: patern');
    const dir = tmp({ 'org.yaml': bad.replace(/overrides:[\s\S]*/, '') });
    await expect(loadRules([{ path: join(dir, 'org.yaml') }], [], builtinRegistry(), ctx)).rejects.toThrow(/unknown evaluator "patern"/);
    const badParams = tmp({ 'org.yaml': ORG.replace('params: { pattern: TODO }', 'params: { pattern: "(" }').replace(/overrides:[\s\S]*/, '') });
    await expect(loadRules([{ path: join(badParams, 'org.yaml') }], [], builtinRegistry(), ctx)).rejects.toThrow(/not a valid regular expression/);
  });

  it('turns knowledge units into rules, routing some to deterministic evaluators', async () => {
    const dir = tmp({
      'k/units.yaml': `units:\n  - { id: sec.no-secrets, kind: security, level: must, title: No secrets }\n  - { id: api.idempotent, kind: business-rule, level: should, title: Idempotent }\n`,
    });
    const config = ConfigSchema.parse({
      rulesets: [{ type: 'context-units', path: join(dir, 'k'), ruleset: 'kb', mapping: { evaluators: { 'sec.no-secrets': { evaluator: 'secrets.scan' } } } }],
    });
    const { rules } = await loadRules(config.rulesets, [], builtinRegistry(), ctx);
    expect(rules.map((r) => [r.id, r.evaluator, r.enforcement, r.category])).toEqual([
      ['sec.no-secrets', 'secrets.scan', 'mandatory', 'security'],
      ['api.idempotent', 'ai.review', 'scored', 'reliability'],
    ]);
  });

  it('reads rules from an MCP server returning context-engineering-sdlc JSON', async () => {
    const mcp = new StaticMcpPool({
      kb: (tool, args) => {
        expect(tool).toBe('get_context');
        expect(args.format).toBe('json');
        return JSON.stringify({ items: [{ id: 'x.rule', kind: 'testing-rule', level: 'must', title: 'Tests ship with the change' }] });
      },
    });
    const config = ConfigSchema.parse({ rulesets: [{ type: 'mcp', server: 'kb', arguments: { task: 'review' } }] });
    const { rules } = await loadRules(config.rulesets, [], builtinRegistry(), { mcp, logger: silentLogger() });
    expect(rules[0]).toMatchObject({ id: 'x.rule', category: 'testing', enforcement: 'mandatory', evaluator: 'ai.review', ruleset: 'mcp:kb' });
  });
});

describe('config inheritance', () => {
  it('appends rulesets, resolves paths per file, and enforces locked keys', async () => {
    const dir = tmp({
      'org/cqr.config.yaml': `organization: acme\nlocked: [gates, scoring]\nrulesets: [{ path: rules.yaml }]\nscoring: { agentic_weight: 0.5 }\n`,
      'repo/cqr.config.yaml': `extends: [../org/cqr.config.yaml]\nrepository: svc\nrulesets: [{ builtin: python-zen }]\nscoring: { agentic_weight: 1 }\nwaivers: waivers.yaml\n`,
    });
    const { config, warnings, files } = await loadConfig(join(dir, 'repo/cqr.config.yaml'));
    expect(files).toHaveLength(2);
    expect(config.organization).toBe('acme');
    expect(config.repository).toBe('svc');
    expect(config.rulesets).toEqual([{ path: join(dir, 'org/rules.yaml') }, { builtin: 'python-zen' }]);
    expect(config.scoring.agentic_weight).toBe(0.5);
    expect(config.waivers).toBe(join(dir, 'repo/waivers.yaml'));
    expect(warnings[0]).toMatch(/"scoring" is locked/);
  });

  it('applies a trusted org config even when the repository config drops extends', async () => {
    const dir = tmp({
      'org/cqr.config.yaml': `organization: acme\nlocked: [gates]\ngates: { allow_agentic: false }\n`,
      'repo/cqr.config.yaml': `repository: svc\ngates: { allow_agentic: true }\n`,
    });
    const { config, warnings } = await loadConfig(join(dir, 'repo/cqr.config.yaml'), { orgConfig: join(dir, 'org/cqr.config.yaml') });
    expect(config.organization).toBe('acme');
    expect(config.gates.allow_agentic).toBe(false);
    expect(warnings[0]).toMatch(/"gates" is locked/);
  });

  it('merges nested objects and replaces scalars', () => {
    expect(mergeConfig({ a: { b: 1, c: 2 }, rulesets: [1] }, { a: { c: 3 }, rulesets: [2] })).toEqual({ a: { b: 1, c: 3 }, rulesets: [1, 2] });
  });

  it('reports invalid config with the path to the problem', async () => {
    const dir = tmp({ 'cqr.config.yaml': 'scoring: { agentic_weight: 3 }\n' });
    await expect(loadConfig(join(dir, 'cqr.config.yaml'))).rejects.toThrow(/scoring\.agentic_weight/);
  });
});
