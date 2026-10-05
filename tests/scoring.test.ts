import { describe, expect, it } from 'vitest';
import { GatesConfig, ScoringConfig } from '../src/config/schema.js';
import { makeFinding } from '../src/core/finding.js';
import type { Finding, FindingInput } from '../src/core/model.js';
import { gradeFor, rate, type ScoredRule } from '../src/scoring/engine.js';
import { applyWaivers } from '../src/scoring/waivers.js';

const scoring = ScoringConfig.parse({});
const gates = GatesConfig.parse({});

function finding(over: Partial<FindingInput> = {}): Finding {
  return makeFinding({
    rule_id: 'R',
    source: 'organization',
    evidence_type: 'deterministic',
    evaluator: 'pattern',
    category: 'code-quality',
    severity: 'high',
    confidence: 1,
    status: 'failed',
    message: 'problem',
    location: { file: 'a.py', start_line: 1 },
    ...over,
  });
}

function rule(over: Partial<ScoredRule> & { rule_id: string }): ScoredRule {
  return {
    title: over.rule_id,
    source: 'organization',
    category: 'code-quality',
    severity: 'high',
    enforcement: 'scored',
    evidence_type: 'deterministic',
    status: 'failed',
    findings: [],
    ...over,
  };
}

const dim = (r: ReturnType<typeof rate>, id: string) => r.dimensions.find((d) => d.id === id)!;

describe('grades', () => {
  it('maps scores onto the default scale', () => {
    expect(gradeFor(97, scoring.grades)).toBe('A+');
    expect(gradeFor(88, scoring.grades)).toBe('B+');
    expect(gradeFor(12, scoring.grades)).toBe('F');
  });
});

describe('deduction scoring', () => {
  it('charges severity points, with repeats costing less and a per-rule cap', () => {
    const one = rate([rule({ rule_id: 'A', findings: [finding({ rule_id: 'A' })] })], scoring, gates);
    expect(dim(one, 'code_quality').score).toBe(85);

    const many = Array.from({ length: 30 }, (_, i) => finding({ rule_id: 'B', message: `p${i}`, location: { file: `f${i}.py`, start_line: 1 } }));
    const capped = rate([rule({ rule_id: 'B', findings: many })], scoring, gates);
    expect(dim(capped, 'code_quality').deductions[0]!.points).toBe(scoring.per_rule_cap);
  });

  it('weights agentic evidence and its confidence', () => {
    const r = rate(
      [rule({ rule_id: 'AI', evidence_type: 'agentic', severity: 'medium', findings: [finding({ rule_id: 'AI', evidence_type: 'agentic', severity: 'medium', confidence: 0.8 })] })],
      scoring,
      gates,
    );
    // 5 points × 0.6 agentic weight × 0.8 confidence
    expect(dim(r, 'ai').deductions[0]!.points).toBe(2.4);
  });

  it('reports but does not score findings below the confidence threshold', () => {
    const r = rate([rule({ rule_id: 'L', findings: [finding({ rule_id: 'L', confidence: 0.3 })] })], scoring, gates);
    expect(r.low_confidence).toHaveLength(1);
    expect(dim(r, 'code_quality').deductions).toHaveLength(0);
  });

  it('ignores advisory and informational rules in the score', () => {
    const r = rate([rule({ rule_id: 'ADV', enforcement: 'advisory', findings: [finding({ rule_id: 'ADV' })] })], scoring, gates);
    expect(r.score).toBeNull();
  });
});

describe('dimensions', () => {
  it('leaves unassessed dimensions out of the overall score instead of counting them as 100', () => {
    const r = rate([rule({ rule_id: 'S', category: 'security', findings: [finding({ rule_id: 'S', category: 'security' })] })], scoring, gates);
    expect(dim(r, 'security').score).toBe(85);
    expect(dim(r, 'testing').assessed).toBe(false);
    // Org Standards (shared, compliance) also sees the org rule: 0% pass.
    expect(dim(r, 'organization').score).toBe(0);
    expect(r.score).toBe(Number(((30 * 85 + 20 * 0) / 50).toFixed(1)));
    expect(r.explanation.join(' ')).toMatch(/Not assessed.*Testing/);
  });

  it('scores org compliance as a severity-weighted pass rate', () => {
    const r = rate(
      [
        rule({ rule_id: 'P1', status: 'passed', severity: 'high' }),
        rule({ rule_id: 'P2', status: 'passed', severity: 'high' }),
        rule({ rule_id: 'F1', severity: 'high', findings: [finding({ rule_id: 'F1' })] }),
      ],
      scoring,
      gates,
    );
    expect(dim(r, 'organization').score).toBe(66.7);
    expect(r.explanation[0]).toContain('passed 2 of 3 organization rules (67%)');
  });

  it('keeps agentic evidence in its own dimension', () => {
    const r = rate(
      [rule({ rule_id: 'AI-SEC', category: 'security', evidence_type: 'agentic', findings: [finding({ rule_id: 'AI-SEC', category: 'security', evidence_type: 'agentic' })] })],
      scoring,
      gates,
    );
    expect(dim(r, 'ai').assessed).toBe(true);
    expect(dim(r, 'security').assessed).toBe(false);
  });
});

describe('gates', () => {
  it('caps the grade on a critical security finding', () => {
    const r = rate(
      [
        rule({ rule_id: 'OK', status: 'passed', category: 'testing' }),
        rule({ rule_id: 'CVE', source: 'tool', category: 'security', severity: 'critical', evidence_type: 'tool', findings: [finding({ rule_id: 'CVE', source: 'tool', category: 'security', severity: 'critical', evidence_type: 'tool', location: { package: 'x@1' } })] }),
      ],
      ScoringConfig.parse({ dimensions: [{ id: 't', label: 'T', weight: 1, select: { categories: ['testing'] } }, { id: 's', label: 'S', weight: 0, select: {} }] }),
      gates,
    );
    expect(r.uncapped_grade).toBe('A+');
    expect(r.grade).toBe('C');
    expect(r.explanation.join(' ')).toContain('capped the grade at C');
  });

  it('fails on a detected secret', () => {
    const r = rate([rule({ rule_id: 'SEC', category: 'security', severity: 'critical', findings: [finding({ rule_id: 'SEC', category: 'security', tags: ['secret'] })] })], scoring, gates);
    expect(r.status).toBe('fail');
    expect(r.grade).toBe('F');
  });

  it('does not let agentic findings trip gates unless allowed', () => {
    const agentic = rule({ rule_id: 'AI', category: 'security', severity: 'critical', evidence_type: 'agentic', findings: [finding({ rule_id: 'AI', category: 'security', severity: 'critical', evidence_type: 'agentic', tags: ['secret'] })] });
    // A gate with no evidence restriction, so only allow_agentic decides.
    const open = GatesConfig.parse({ rules: [{ id: 'secrets', when: { tags: ['secret'] }, action: { fail: true } }] });
    expect(rate([agentic], scoring, open).status).toBe('pass');
    expect(rate([agentic], scoring, { ...open, allow_agentic: true }).status).toBe('fail');
  });

  it('ignores waived findings', () => {
    const f = finding({ rule_id: 'SEC', category: 'security', tags: ['secret'] });
    const { findings } = applyWaivers([f], [{ rule_id: 'SEC', reason: 'test fixture, revoked key', approver: 'x', expires: '2999-01-01' }]);
    const r = rate([rule({ rule_id: 'SEC', category: 'security', findings })], scoring, gates);
    expect(r.status).toBe('pass');
  });
});

describe('waivers', () => {
  it('expire, and warn when unused', () => {
    const f = finding({ rule_id: 'A' });
    const { findings, warnings } = applyWaivers(
      [f],
      [
        { rule_id: 'A', reason: 'expired waiver here', approver: 'x', expires: '2020-01-01' },
        { rule_id: 'Z', reason: 'matches nothing at all', approver: 'y', expires: '2999-01-01' },
      ],
      '2026-10-05',
    );
    expect(findings[0]!.waived).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/expired/);
    expect(warnings.join(' ')).toMatch(/matched nothing/);
  });
});

describe('corroboration', () => {
  it('charges one security problem once when independent sources report it', () => {
    const at = { file: 'api.py', start_line: 12 };
    const rules = [
      rule({ rule_id: 'ORG-SQL', category: 'security', findings: [finding({ rule_id: 'ORG-SQL', category: 'security', location: at })] }),
      rule({ rule_id: 'semgrep:sql', source: 'tool', evidence_type: 'tool', category: 'security', findings: [finding({ rule_id: 'semgrep:sql', source: 'tool', evidence_type: 'tool', evaluator: 'connector:semgrep', tool: { name: 'semgrep' }, category: 'security', location: at })] }),
    ];
    const r = rate(rules, scoring, gates);
    expect(Object.keys(r.corroborated)).toHaveLength(1);
    expect(dim(r, 'security').score).toBe(85);
    // Compliance is per rule, so the org rule still fails there.
    expect(dim(r, 'organization').rules.failed).toBe(1);
  });

  it('does not merge two rules from the same evaluator', () => {
    const at = { file: 'api.py', start_line: 12 };
    const rules = ['A', 'B'].map((id) => rule({ rule_id: id, category: 'security', findings: [finding({ rule_id: id, category: 'security', location: at })] }));
    expect(Object.keys(rate(rules, scoring, gates).corroborated)).toHaveLength(0);
  });
});
