import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { assess, type Assessment } from '../src/engine/assess.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderSarif } from '../src/report/sarif.js';
import { compareRuns } from '../src/storage/history.js';

// The full pipeline against examples/: Acme's org config, the payments sample
// service, recorded AI responses, five connectors and a live MCP server.
const repo = join(import.meta.dirname, '..', 'examples', 'sample-service');
const configFile = join(repo, 'cqr.config.yaml');

describe('end to end', () => {
  let withAI: Assessment;
  let withoutAI: Assessment;

  it('rates the sample service with every source', async () => {
    withAI = await assess({ repo, configFile, environment: 'demo', logger: silentLogger() });
    const r = withAI.rating;

    expect(withAI.provenance.connectors.every((c) => c.ok)).toBe(true);
    expect(withAI.provenance.rulesets.map((s) => s.id)).toEqual(['secure-baseline', 'python-zen', 'acme-engineering', 'acme-agent-architecture', 'acme-knowledge', 'payments-service']);
    expect(withAI.provenance.plugins.map((p) => p.name)).toEqual(['builtin', 'acme-license-policy']);
    expect(r.coverage.errors).toBe(0);
    expect(r.grade).toBe('F');
    expect(r.gates.filter((g) => g.triggered).map((g) => g.id)).toEqual(['critical-security-caps-at-C', 'mandatory-org-rule-caps-at-B', 'architecture-warn']);

    const status = (id: string) => withAI.rules.find((x) => x.rule_id === id)?.status;
    // deterministic, tool-backed, agent-report, MCP and AI rules all produced outcomes
    expect(status('ACME-MONEY-001')).toBe('failed');
    expect(status('ACME-SEC-002')).toBe('failed');
    expect(status('ACME-SDLC-001')).toBe('failed');
    expect(status('ACME-AGENT-ARCH-001')).toBe('failed');
    expect(status('ACME-API-001')).toBe('failed');
    expect(status('PY-ZEN-011')).toBe('passed');
    // third-party plugin evaluator
    expect(withAI.findings.find((f) => f.rule_id === 'PAY-LIC-001')).toMatchObject({ location: { package: 'pdfgen-lite@0.4.2' }, category: 'compliance' });
    // knowledge unit routed to a deterministic evaluator
    expect(withAI.rules.find((x) => x.rule_id === 'acme.code.timeouts-on-outbound-calls')).toMatchObject({ evaluator: 'pattern', status: 'passed' });

    // agentic and deterministic evidence stay distinguishable
    expect(new Set(withAI.findings.map((f) => f.evidence_type))).toEqual(new Set(['deterministic', 'tool', 'agentic']));
    // AI provenance is recorded
    expect(withAI.findings.find((f) => f.rule_id === 'ACME-API-001')!.ai).toMatchObject({ profile: 'recorded', prompt_version: 'ai-review/1.0' });
    // the hallucinated quote is kept but not scored
    expect(r.low_confidence).toHaveLength(1);
    // waiver applied, expired waiver and locked overrides warned about
    expect(withAI.findings.some((f) => f.rule_id === 'ACME-LOG-001' && f.waived)).toBe(true);
    expect(withAI.warnings.join('\n')).toMatch(/expired on 2026-01-31/);
    expect(withAI.warnings.join('\n')).toMatch(/cannot weaken locked rule ACME-MONEY-001/);
    expect(withAI.warnings.join('\n')).toMatch(/"scoring" is locked/);
    // infra code is classified restricted; only the local replay model may see it
    expect(withAI.provenance.ai.models).toEqual(['recorded/claude-opus-5-5']);
  }, 30_000);

  it('still rates the repository with AI switched off', async () => {
    withoutAI = await assess({ repo, configFile, disableAI: true, logger: silentLogger() });
    const ai = withoutAI.rating.dimensions.find((d) => d.id === 'ai')!;
    // MCP and agent-report evidence is still agentic, so the AI dimension has data;
    // the ai.review rules are skipped rather than passed.
    expect(withoutAI.rules.find((r) => r.rule_id === 'ACME-API-001')).toMatchObject({ status: 'skipped', detail: 'AI is disabled' });
    expect(ai.rules.evaluated).toBeLessThan(withAI.rating.dimensions.find((d) => d.id === 'ai')!.rules.evaluated);
    expect(withoutAI.provenance.ai.calls).toBe(0);
    expect(withoutAI.rating.score).not.toBeNull();
  }, 30_000);

  it('explains differences between runs', () => {
    const c = compareRuns(withoutAI, withAI);
    expect(c.models_changed).toBe(true);
    expect(c.new_findings.some((f) => f.rule_id === 'ACME-API-001')).toBe(true);
  });

  it('renders Markdown and SARIF reports', () => {
    const md = renderMarkdown(withAI);
    expect(md).toContain('# Engineering rating: payments-service');
    expect(md).toContain('| Org Standards |');
    const sarif = JSON.parse(renderSarif(withAI));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results.length).toBeGreaterThan(10);
    expect(sarif.runs[0].results.some((r: { suppressions?: unknown[] }) => r.suppressions)).toBe(true);
  });
});
