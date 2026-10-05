import type { Assessment } from '../engine/assess.js';

// SARIF output, so findings show up in GitHub code scanning and other viewers.
// Only findings with a file location are included; cloud and package findings
// stay in the JSON and Markdown reports.

const LEVEL: Record<string, 'error' | 'warning' | 'note'> = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' };
const SECURITY_SEVERITY: Record<string, string> = { critical: '9.5', high: '8.0', medium: '5.5', low: '3.0', info: '0.0' };

export function renderSarif(a: Assessment): string {
  const findings = a.findings.filter((f) => f.status === 'failed' && f.location.file);
  const ruleIds = [...new Set(findings.map((f) => f.rule_id))].sort();
  const ruleMeta = new Map(a.rules.map((r) => [r.rule_id, r]));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'cqr',
            version: a.provenance.tool_version,
            informationUri: 'https://github.com/sidd105/context-aware-pr-reviewer',
            rules: ruleIds.map((id) => {
              const r = ruleMeta.get(id);
              const sample = findings.find((f) => f.rule_id === id)!;
              return {
                id,
                shortDescription: { text: r?.title ?? sample.message },
                properties: {
                  tags: [sample.category, sample.evidence_type, ...(r?.ruleset ? [r.ruleset] : [])],
                  ...(sample.category === 'security' ? { 'security-severity': SECURITY_SEVERITY[sample.severity] } : {}),
                },
              };
            }),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.rule_id,
          level: LEVEL[f.severity],
          message: { text: `${f.message}${f.evidence_type === 'agentic' ? ` (AI assessment, confidence ${f.confidence.toFixed(2)})` : ''}${f.remediation ? `\nFix: ${f.remediation}` : ''}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.location.file },
                ...(f.location.start_line ? { region: { startLine: f.location.start_line, ...(f.location.end_line ? { endLine: f.location.end_line } : {}) } } : {}),
              },
            },
          ],
          partialFingerprints: { cqrFindingId: f.id },
          ...(f.waived ? { suppressions: [{ kind: 'external', justification: f.waived.reason }] } : {}),
          properties: { evidence_type: f.evidence_type, confidence: f.confidence, source: f.source },
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
