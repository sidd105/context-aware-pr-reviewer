import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentAssessment, normaliseAgentAssessment } from '../src/connectors/agent.js';
import { normaliseOrcaAlerts } from '../src/connectors/orca.js';
import { parseSarif } from '../src/connectors/sarif.js';
import { parseSnyk } from '../src/connectors/snyk.js';
import { normaliseSonarHotspot, normaliseSonarIssue } from '../src/connectors/sonar.js';
import { matchToolFindings } from '../src/evaluators/tool.js';

const reports = join(import.meta.dirname, '..', 'examples', 'sample-service', 'reports');
const read = (f: string) => readFileSync(join(reports, f), 'utf8');

describe('snyk', () => {
  const { findings } = parseSnyk(read('snyk.json'), { root: '/repo', connector: 'snyk' });

  it('reports each vulnerable package once, however many paths lead to it', () => {
    expect(findings.map((f) => f.rule_id).sort()).toEqual(['snyk:SNYK-PYTHON-FLASK-5490129', 'snyk:SNYK-PYTHON-PYYAML-559098', 'snyk:SNYK-PYTHON-REQUESTS-5595532']);
  });

  it('normalises severity, location, identifiers and fix', () => {
    const yaml = findings.find((f) => f.rule_id.includes('PYYAML'))!;
    expect(yaml).toMatchObject({ severity: 'critical', category: 'security', evidence_type: 'tool', confidence: 1 });
    expect(yaml.location).toMatchObject({ file: 'requirements.txt', package: 'pyyaml@5.3' });
    expect(yaml.cve).toEqual(['CVE-2020-1747']);
    expect(yaml.remediation).toBe('Upgrade to pyyaml@5.3.1');
  });
});

describe('sonar', () => {
  it('uses Sonar 10 impacts when present', () => {
    const f = normaliseSonarIssue(
      { key: 'k', rule: 'python:S3776', component: 'proj:src/a.py', textRange: { startLine: 4 }, message: 'm', severity: 'CRITICAL', type: 'CODE_SMELL', impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'MEDIUM' }] },
      'sonar',
    );
    expect(f).toMatchObject({ severity: 'medium', category: 'maintainability', location: { file: 'src/a.py', start_line: 4 } });
  });

  it('falls back to legacy severity and type', () => {
    const f = normaliseSonarIssue({ key: 'k', rule: 'r', component: 'p:a.py', message: 'm', severity: 'BLOCKER', type: 'VULNERABILITY' }, 'sonar');
    expect(f).toMatchObject({ severity: 'critical', category: 'security' });
  });

  it('treats hotspots as lower-confidence security findings', () => {
    const f = normaliseSonarHotspot({ key: 'h', component: 'p:a.py', line: 3, message: 'm', vulnerabilityProbability: 'HIGH' }, 'sonar');
    expect(f).toMatchObject({ severity: 'high', category: 'security', confidence: 0.5 });
  });
});

describe('orca', () => {
  const alerts = JSON.parse(read('orca-alerts.json')).data;

  it('keeps open alerts for this repository\'s assets only', () => {
    const findings = normaliseOrcaAlerts(alerts, { connector: 'orca', matchAssets: ['payments-*'] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', location: { asset: 'payments-exports' } });
  });

  it('accepts a custom field map for other API versions', () => {
    const findings = normaliseOrcaAlerts([{ uid: 'x1', name: 'Open port', level: 'critical', status: 'open', resource: 'payments-db' }], {
      connector: 'orca',
      matchAssets: [],
      fields: { id: ['uid'], title: ['name'], severity: ['level'], asset: ['resource'] },
    });
    expect(findings[0]).toMatchObject({ severity: 'critical', message: 'Open port', location: { asset: 'payments-db' } });
  });
});

describe('sarif', () => {
  it('maps security-severity, CWE tags, precision and tool name', () => {
    const { findings, tool } = parseSarif(read('semgrep.sarif'), { root: '/repo', connector: 'semgrep' });
    expect(tool).toEqual({ name: 'Semgrep OSS', version: '1.85.0' });
    expect(findings[0]).toMatchObject({
      rule_id: 'semgrep-oss:python.flask.security.injection.tainted-sql-string.tainted-sql-string',
      severity: 'high',
      category: 'security',
      confidence: 0.9,
      cwe: ['CWE-89'],
      location: { file: 'app/api/handlers.py', start_line: 12 },
    });
  });

  it('respects suppressions recorded in the report', () => {
    const log = { version: '2.1.0', runs: [{ tool: { driver: { name: 't' } }, results: [{ ruleId: 'x', message: { text: 'm' }, suppressions: [{ kind: 'inSource' }] }] }] };
    expect(parseSarif(JSON.stringify(log), { root: '/', connector: 't' }).findings).toHaveLength(0);
  });
});

describe('agent assessments', () => {
  it('keep passing results as records and use the trust level config gives', () => {
    const data = AgentAssessment.parse({
      agent: { name: 'bot' },
      rule_results: [
        { rule_id: 'A', status: 'passed', confidence: 0.9 },
        { rule_id: 'B', status: 'failed', findings: [{ message: 'bad', file: 'x.py', line: 2 }] },
      ],
    });
    const findings = normaliseAgentAssessment(data, { connector: 'bot', trust: 'agentic', source: 'agent' });
    expect(findings.map((f) => [f.rule_id, f.status, f.evidence_type])).toEqual([
      ['A', 'passed', 'agentic'],
      ['B', 'failed', 'agentic'],
    ]);
  });

  it('reject malformed reports', () => {
    expect(AgentAssessment.safeParse({ rule_results: [] }).success).toBe(false);
  });
});

describe('tool-backed rules', () => {
  it('select findings by connector, severity and category', () => {
    const { findings } = parseSnyk(read('snyk.json'), { root: '/repo', connector: 'snyk' });
    const matched = matchToolFindings({ tools: ['snyk'], severity_at_least: 'high' }, findings);
    expect(matched.map((f) => f.severity).sort()).toEqual(['critical', 'high']);
    expect(matchToolFindings({ tools: ['sonar'] }, findings)).toHaveLength(0);
  });
});
