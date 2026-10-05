import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { assess } from '../src/engine/assess.js';
import { builtinRegistry } from '../src/plugins/builtin.js';

function repo(ruleYaml: string): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cqr-plugin-'));
  writeFileSync(join(dir, 'a.py'), 'x = 1\n');
  writeFileSync(join(dir, 'rules.yaml'), ruleYaml);
  writeFileSync(join(dir, 'cqr.config.yaml'), 'rulesets: [{ path: rules.yaml }]\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return { dir, config: join(dir, 'cqr.config.yaml') };
}

const RULES = `apiVersion: cqr/v1
kind: RuleSet
metadata: { id: t, version: 1.0.0 }
rules:
  - { id: BAD-1, title: Bad plugin, category: code-quality, severity: high, evaluator: broken.plugin }
  - { id: OK-1, title: Fine rule, category: code-quality, severity: low, evaluator: pattern, params: { pattern: nothing-matches-this }, applies_to: { languages: [python] } }
`;

describe('plugins', () => {
  it('turn malformed findings into rule errors instead of corrupting the rating', async () => {
    const { dir, config } = repo(RULES);
    const registry = builtinRegistry().register({
      name: 'broken',
      version: '0',
      evaluators: [
        {
          id: 'broken.plugin',
          description: 'returns garbage',
          evidenceType: 'deterministic',
          evaluate: async (rules) => rules.map((rule) => ({ rule, status: 'failed', evidence_type: 'deterministic', confidence: 1, findings: [{ severity: 'apocalyptic' } as never] })),
        },
      ],
    });
    const a = await assess({ repo: dir, configFile: config, logger: silentLogger(), registry });
    expect(a.rules.find((r) => r.rule_id === 'BAD-1')).toMatchObject({ status: 'error' });
    expect(a.rules.find((r) => r.rule_id === 'OK-1')).toMatchObject({ status: 'passed' });
    expect(a.rating.explanation.join(' ')).toMatch(/1 rule\(s\) errored/);
  });

  it('cannot register an id that is already taken', () => {
    expect(() => builtinRegistry().register({ name: 'dup', version: '0', evaluators: [{ id: 'pattern', description: '', evidenceType: 'deterministic', evaluate: async () => [] }] })).toThrow(/already registered/);
  });
});
