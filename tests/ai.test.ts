import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactPii } from '../src/ai/data-policy.js';
import type { AIRequest } from '../src/ai/provider.js';
import { replayProvider } from '../src/ai/providers/replay.js';
import { ModelRouter } from '../src/ai/router.js';
import { AIConfig, ConfigSchema, type Config } from '../src/config/schema.js';
import { silentLogger } from '../src/core/logger.js';
import type { ResolvedRule } from '../src/core/model.js';
import { Registry, type AssessmentContext } from '../src/core/plugin.js';
import { Workspace } from '../src/core/workspace.js';
import { aiReviewEvaluator, ground } from '../src/evaluators/ai-review.js';
import { redactSecrets } from '../src/evaluators/secrets.js';
import { StaticMcpPool } from '../src/mcp/client.js';
import { makeFinding } from '../src/core/finding.js';
import { outcome, ruleFinding, skipped } from '../src/evaluators/util.js';

// A registry whose "scripted" provider type answers from a function, so
// tests can see exactly what was sent and control what comes back.
function registryWith(handler: (model: string, req: AIRequest) => unknown, failing: string[] = []): Registry {
  return new Registry().register({
    name: 'test',
    version: '0',
    providers: [
      {
        type: 'scripted',
        create: (name, config) =>
          replayProvider(
            name,
            (model, req) => {
              if (failing.includes(name)) throw new Error(`${name} is down`);
              return handler(model, req);
            },
            config.hosting,
          ),
      },
    ],
  });
}

const ai = (over: object) =>
  AIConfig.parse({
    enabled: true,
    audit_log: join(mkdtempSync(join(tmpdir(), 'cqr-audit-')), 'audit.jsonl'),
    providers: { vendor: { type: 'scripted', hosting: 'vendor' }, local: { type: 'scripted', hosting: 'local' } },
    models: {
      big: { provider: 'vendor', model: 'big-model', capabilities: { structured_output: true, reasoning: true } },
      small: { provider: 'local', model: 'small-model', capabilities: { structured_output: true }, context_tokens: 8000 },
      plain: { provider: 'local', model: 'plain-model' },
    },
    ...over,
  });

describe('model routing', () => {
  const router = (over: object, env?: string) => new ModelRouter(ai(over), registryWith(() => ({})), env, silentLogger(), '/dev/null');

  it('resolves from the most specific configuration to the least', () => {
    const r = router({ routing: { default: 'big', tiers: { low: 'small' }, categories: { security: 'big' }, environments: { ci: { evaluators: { 'ai.review': 'plain' } } } } });
    expect(r.candidates({ evaluator: 'ai.review', category: 'security', tier: 'low', files: [], needs: [] })).toEqual(['small', 'big']);
    const ci = router({ routing: { default: 'big', environments: { ci: { evaluators: { 'ai.review': 'plain' } } } } }, 'ci');
    expect(ci.candidates({ evaluator: 'ai.review', files: [], needs: [] })[0]).toBe('plain');
  });

  it('skips models without the capabilities or context the evaluator needs', () => {
    const r = router({ routing: { default: 'plain', fallback: ['small', 'big'] } });
    const route = r.route({ evaluator: 'ai.review', files: [], needs: ['reasoning'], promptTokens: 20_000 });
    expect('profileName' in route && route.profileName).toBe('big');
    expect('rejected' in route && route.rejected.map((x) => x.profile)).toEqual(['plain', 'small']);
  });

  it('enforces data classification by hosting', () => {
    const r = router({
      routing: { default: 'big', fallback: ['small'] },
      data_policy: { classifications: [{ name: 'restricted', paths: ['infra/**'], allowed_hosting: ['local'] }] },
    });
    const route = r.route({ evaluator: 'ai.review', files: ['infra/db.py'], needs: [] });
    expect('profileName' in route && route.profileName).toBe('small');
    const none = router({ routing: { default: 'big' }, data_policy: { allowed_providers: ['nobody'] } }).route({ evaluator: 'ai.review', files: [], needs: [] });
    expect('error' in none).toBe(true);
  });

  it('falls back to the next model when a call fails, and records provenance', async () => {
    const r = new ModelRouter(ai({ routing: { default: 'big', fallback: ['small'] } }), registryWith(() => ({ ok: true }), ['vendor']), undefined, silentLogger(), join(mkdtempSync(join(tmpdir(), 'a-')), 'audit.jsonl'));
    const route = r.route({ evaluator: 'ai.review', files: [], needs: [] });
    if ('error' in route) throw new Error(route.error);
    const { provenance } = await r.complete(route, { system: 's', prompt: 'p', schema: {}, schemaName: 'x' }, { evaluator: 'ai.review', promptVersion: 'v1', rules: [], files: [], redactions: { secrets: 0, pii: 0 } });
    expect(provenance).toMatchObject({ profile: 'small', provider: 'local', model: 'small-model', prompt_version: 'v1' });
    expect(provenance.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('redaction', () => {
  it('removes secrets and PII before text leaves the machine', () => {
    const { text, count } = redactSecrets('key = "AKIAABCDEFGHIJKLMNOP"\ntoken: ghp_' + 'a'.repeat(36));
    expect(count).toBe(2);
    expect(text).not.toContain('AKIA');
    const pii = redactPii('mail jane.doe@acme.io, card 4111 1111 1111 1111, ok@example.com');
    expect(pii.text).toBe('mail [REDACTED:email], card [REDACTED:card-number], ok@example.com');
  });
});

describe('grounding', () => {
  const sources = new Map([['a.py', 'def f():\n    return eval(x)\n\ndef g():\n    pass\n']]);
  it('keeps findings whose quote is on the cited line', () => {
    expect(ground({ file: 'a.py', line: 2, quote: 'return eval(x)', confidence: 0.9 }, sources, 0.5)).toEqual({ line: 2, confidence: 0.9, grounded: true });
  });
  it('moves findings whose quote is elsewhere in the file', () => {
    expect(ground({ file: 'a.py', line: 5, quote: 'return eval(x)', confidence: 0.9 }, sources, 0.5)?.line).toBe(2);
  });
  it('penalises findings whose quote does not exist', () => {
    expect(ground({ file: 'a.py', line: 2, quote: 'os.system(cmd)', confidence: 0.9 }, sources, 0.5)).toMatchObject({ confidence: 0.45, grounded: false });
  });
  it('drops findings in files that were not sent', () => {
    expect(ground({ file: 'b.py', line: 1, quote: 'x', confidence: 1 }, sources, 0.5)).toBeNull();
  });
});

describe('ai.review evaluator', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cqr-ai-'));
    const write = (p: string, c: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    };
    write('app/api.py', 'def handler():\n    try:\n        run()\n    except Exception as e:\n        return str(e), 500\n# contact ops@acme.io\n');
    write('app/secret.py', 'API_KEY = "sk-ant-' + 'x'.repeat(30) + '"\n');
    write('.env', 'PASSWORD=hunter2\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  }

  const rule = (id: string, over: Partial<ResolvedRule> = {}): ResolvedRule => ({
    id,
    title: `Rule ${id}`,
    description: '',
    rationale: '',
    category: 'architecture',
    severity: 'medium',
    enforcement: 'scored',
    evaluator: 'ai.review',
    params: {},
    applies_to: { languages: [], paths: ['**'], exclude: [] },
    remediation: '',
    references: [],
    tags: [],
    enabled: true,
    ruleset: 'test',
    ruleset_version: '1.0.0',
    source: 'organization',
    ...over,
  });

  async function run(handler: (model: string, req: AIRequest) => unknown, rules: ResolvedRule[], configOver: Partial<Config> = {}) {
    const dir = repo();
    const config = ConfigSchema.parse({ ...configOver });
    const aiConfig = ai({ routing: { default: 'big' } });
    const registry = registryWith(handler);
    const router = new ModelRouter(aiConfig, registry, undefined, silentLogger(), join(dir, '.cqr/audit.jsonl'));
    const ctx: AssessmentContext = {
      workspace: await Workspace.open(dir, { exclude: [] }),
      config,
      logger: silentLogger(),
      ai: router,
      toolFindings: [],
      connectorStatus: new Map(),
      environment: undefined,
      mcp: new StaticMcpPool(),
      signal: new AbortController().signal,
      sdk: { ruleFinding, outcome, skipped, makeFinding },
    };
    return aiReviewEvaluator.evaluate(rules, ctx);
  }

  it('sends redacted, policy-filtered files and maps results back to rules', async () => {
    let sent = '';
    const outcomes = await run(
      (_m, req) => {
        sent = req.prompt;
        return {
          results: [
            { rule_id: 'API-1', status: 'failed', confidence: 0.9, summary: 's', findings: [{ file: 'app/api.py', line: 5, quote: 'return str(e), 500', message: 'leaks exception', remediation: 'use problem()', confidence: 0.9 }] },
            { rule_id: 'API-2', status: 'passed', confidence: 0.8, summary: 'fine', findings: [] },
            { rule_id: 'NOT-ASKED', status: 'failed', confidence: 1, summary: 'x', findings: [] },
          ],
        };
      },
      [rule('API-1'), rule('API-2'), rule('API-3')],
    );
    expect(sent).not.toContain('sk-ant-');
    expect(sent).toContain('[REDACTED:anthropic-key]');
    expect(sent).not.toContain('ops@acme.io');
    expect(sent).not.toContain('hunter2');
    expect(outcomes.map((o) => [o.rule.id, o.status])).toEqual([
      ['API-1', 'failed'],
      ['API-2', 'passed'],
      ['API-3', 'skipped'],
    ]);
    const f = outcomes[0]!.findings[0]!;
    expect(f).toMatchObject({ evidence_type: 'agentic', location: { file: 'app/api.py', start_line: 5 }, confidence: 0.9 });
    expect(f.ai).toMatchObject({ provider: 'vendor', model: 'big-model', prompt_version: 'ai-review/1.0' });
  });

  it('treats a failure without locatable evidence as unknown, not failed', async () => {
    const outcomes = await run(() => ({ results: [{ rule_id: 'R', status: 'failed', confidence: 0.9, summary: 'vibes', findings: [] }] }), [rule('R')]);
    expect(outcomes[0]!.status).toBe('skipped');
  });

  it('reports invalid model output as an error for those rules', async () => {
    const outcomes = await run(() => ({ nonsense: true }), [rule('R')]);
    expect(outcomes[0]!.status).toBe('error');
  });
});
