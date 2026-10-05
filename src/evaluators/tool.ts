import { globToRegExp } from '../config/glob.js';
import { atLeast, Category, Severity, type Finding } from '../core/model.js';
import type { Evaluator } from '../core/plugin.js';
import { outcome } from './util.js';

// Lets an organization say "our rule ORG-SEC-002 is evaluated by Snyk": the
// rule stays the organization's (its id, severity and enforcement), and the
// tool supplies the evidence. Matching tool findings are re-keyed to the rule
// and claimed, so they aren't also scored as unmapped tool findings.
export function matchToolFindings(params: Record<string, unknown>, findings: readonly Finding[]): Finding[] {
  const tools = (params.tools as string[] | undefined) ?? [];
  const minSeverity = Severity.safeParse(params.severity_at_least);
  const categories = (params.categories as string[] | undefined) ?? [];
  const ruleIds = ((params.rule_ids as string[] | undefined) ?? []).map((g) => globToRegExp(g));
  const cwe = (params.cwe as string[] | undefined) ?? [];
  const tags = (params.tags as string[] | undefined) ?? [];
  return findings.filter(
    (f) =>
      f.status === 'failed' &&
      (tools.length === 0 || tools.some((t) => f.tags.includes(`connector:${t}`) || f.tool?.name === t)) &&
      (!minSeverity.success || atLeast(f.severity, minSeverity.data)) &&
      (categories.length === 0 || categories.includes(f.category)) &&
      (ruleIds.length === 0 || ruleIds.some((r) => r.test(f.rule_id))) &&
      (cwe.length === 0 || f.cwe.some((c) => cwe.includes(c))) &&
      (tags.length === 0 || f.tags.some((t) => tags.includes(t))),
  );
}

export const toolFindingsEvaluator: Evaluator = {
  id: 'tool.findings',
  description: 'Evaluates a rule using findings from connected tools (Snyk, Sonar, Orca, SARIF…)',
  evidenceType: 'tool',
  validateParams(p) {
    const problems: string[] = [];
    if (!Array.isArray(p.tools) || p.tools.length === 0) problems.push('param "tools" must list at least one connector name');
    if (p.severity_at_least !== undefined && !Severity.safeParse(p.severity_at_least).success) problems.push('param "severity_at_least" is not a severity');
    for (const c of (p.categories as unknown[] | undefined) ?? []) if (!Category.safeParse(c).success) problems.push(`unknown category ${String(c)}`);
    return problems;
  },
  async evaluate(rules, ctx) {
    return rules.map((rule) => {
      const wanted = rule.params.tools as string[];
      const status = wanted.map((t) => ctx.connectorStatus.get(t));
      if (status.every((st) => st === undefined)) {
        return { rule, status: 'skipped' as const, evidence_type: 'tool' as const, confidence: 0, findings: [], detail: `No connector named ${wanted.join(' or ')} ran` };
      }
      if (status.every((st) => st === undefined || !st.ok)) {
        const detail = status.flatMap((st) => (st ? [st.detail] : [])).join('; ');
        return { rule, status: 'error' as const, evidence_type: 'tool' as const, confidence: 0, findings: [], detail: `Connector failed: ${detail}` };
      }
      const matched = matchToolFindings(rule.params, ctx.toolFindings).map((f) => ({
        ...f,
        id: `${rule.id}:${f.id}`,
        rule_id: rule.id,
        rule_version: rule.ruleset_version,
        ruleset: rule.ruleset,
        source: rule.source,
        evaluator: 'tool.findings',
        category: rule.category,
        enforcement: rule.enforcement,
        // The tool's own severity is kept when it's higher than the rule's.
        severity: atLeast(f.severity, rule.severity) ? f.severity : rule.severity,
        tags: [...new Set([...f.tags, ...rule.tags, `claimed:${f.id}`])],
        remediation: f.remediation ?? rule.remediation,
      }));
      // Findings from an agent-report connector stay agentic when re-keyed.
      return outcome(rule, matched.some((f) => f.evidence_type === 'agentic') ? 'agentic' : 'tool', matched);
    });
  },
};
