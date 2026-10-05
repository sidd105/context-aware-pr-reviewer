import { z } from 'zod';
import { makeFinding } from '../core/finding.js';
import { Category, Confidence, EvidenceType, FindingStatus, Severity, type Finding, type FindingInput } from '../core/model.js';
import type { Connector, Evaluator } from '../core/plugin.js';
import { outcome } from '../evaluators/util.js';
import { parseJson, readReport } from './common.js';

// The format an external agent or MCP server uses to hand in an assessment.
// `cqr schema agent-assessment` prints it as JSON Schema for agent authors.
export const AgentAssessment = z.object({
  agent: z.object({
    name: z.string(),
    version: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
  }),
  ruleset: z.object({ id: z.string(), version: z.string().optional() }).optional(),
  generated_at: z.string().optional(),
  // One entry per rule the agent evaluated, including the ones that passed,
  // so "which rules did it check" has an answer.
  rule_results: z
    .array(
      z.object({
        rule_id: z.string(),
        status: FindingStatus,
        confidence: Confidence.default(0.7),
        summary: z.string().optional(),
        findings: z
          .array(
            z.object({
              file: z.string().optional(),
              line: z.number().int().positive().optional(),
              end_line: z.number().int().positive().optional(),
              message: z.string(),
              evidence: z.string().optional(),
              remediation: z.string().optional(),
              severity: Severity.optional(),
              confidence: Confidence.optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  category_hints: z.record(z.string(), Category).default({}),
});
export type AgentAssessment = z.infer<typeof AgentAssessment>;

export function normaliseAgentAssessment(
  data: AgentAssessment,
  options: { connector: string; trust: z.infer<typeof EvidenceType>; source: 'agent' | 'mcp' },
): Finding[] {
  const findings: Finding[] = [];
  const tool = { name: data.agent.name, ...(data.agent.version ? { version: data.agent.version } : {}) };
  for (const r of data.rule_results) {
    const category = data.category_hints[r.rule_id] ?? 'code-quality';
    const base: Pick<FindingInput, 'rule_id' | 'source' | 'evidence_type' | 'evaluator' | 'tool' | 'category' | 'tags'> = {
      rule_id: r.rule_id,
      source: options.source,
      evidence_type: options.trust,
      evaluator: `connector:${options.connector}`,
      tool,
      category,
      tags: [`connector:${options.connector}`],
    };
    if (r.status !== 'failed' || r.findings.length === 0) {
      // Passing (or not-applicable) results are kept as records so the rule
      // shows as evaluated by the agent.
      findings.push(makeFinding({ ...base, severity: 'info', confidence: r.confidence, status: r.status, message: r.summary ?? `${r.rule_id}: ${r.status}` }));
      continue;
    }
    r.findings.forEach((f, i) =>
      findings.push(
        makeFinding({
          ...base,
          severity: f.severity ?? 'medium',
          confidence: f.confidence ?? r.confidence,
          status: 'failed',
          location: { ...(f.file ? { file: f.file } : {}), ...(f.line ? { start_line: f.line } : {}), ...(f.end_line ? { end_line: f.end_line } : {}) },
          message: f.message,
          evidence: f.evidence,
          remediation: f.remediation,
          discriminator: i,
        }),
      ),
    );
  }
  return findings;
}

export const agentReportConnector: Connector = {
  type: 'agent-report',
  description: 'An assessment file produced by an external AI agent, in the AgentAssessment format',
  async collect(name, config, ctx) {
    const raw = parseJson<unknown>(await readReport(name, config, ctx), `agent report ${name}`);
    const parsed = AgentAssessment.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`agent report ${name} does not match the AgentAssessment schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    // The organization decides how far to trust an agent, not the agent.
    const trust = EvidenceType.safeParse(config.trust);
    const findings = normaliseAgentAssessment(parsed.data, { connector: name, trust: trust.success ? trust.data : 'agentic', source: 'agent' });
    return { findings, tool: { name: parsed.data.agent.name }, summary: `${parsed.data.rule_results.length} rule results from agent ${parsed.data.agent.name}` };
  },
};

// Evaluates an organization rule from an agent's report: the agent's result
// for this rule id becomes the rule's outcome. A rule the agent didn't report
// on is "skipped", not "passed".
export const agentFindingsEvaluator: Evaluator = {
  id: 'agent.findings',
  description: 'Uses an agent-report connector\'s result for the rule (params: connector)',
  evidenceType: 'agentic',
  validateParams: (p) => (typeof p.connector === 'string' ? [] : ['param "connector" must name an agent-report connector']),
  async evaluate(rules, ctx) {
    return rules.map((rule) => {
      const connector = rule.params.connector as string;
      const records = ctx.toolFindings.filter((f) => f.tags.includes(`connector:${connector}`) && f.rule_id === (rule.params.agent_rule_id ?? rule.id));
      if (records.length === 0) {
        return { rule, status: 'skipped' as const, evidence_type: 'agentic' as const, confidence: 0, findings: [], detail: `Agent ${connector} did not report on this rule` };
      }
      const failed = records
        .filter((f) => f.status === 'failed')
        .map((f) => ({ ...f, id: `${rule.id}:${f.id}`, rule_id: rule.id, ruleset: rule.ruleset, rule_version: rule.ruleset_version, source: rule.source, category: rule.category, enforcement: rule.enforcement, severity: rule.severity, evaluator: 'agent.findings', tags: [...f.tags, `claimed:${f.id}`] }));
      const trust = records[0]!.evidence_type;
      if (failed.length === 0 && records.every((r) => r.status === 'not_applicable')) {
        return { rule, status: 'not_applicable' as const, evidence_type: trust, confidence: records[0]!.confidence, findings: [] };
      }
      const result = outcome(rule, trust, failed);
      return failed.length === 0 ? { ...result, confidence: Math.min(...records.map((r) => r.confidence)) } : result;
    });
  },
};
