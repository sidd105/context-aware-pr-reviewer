import { AgentAssessment, normaliseAgentAssessment } from '../connectors/agent.js';
import type { ResolvedRule, RuleOutcome } from '../core/model.js';
import type { Evaluator } from '../core/plugin.js';
import { errorOutcome, outcome, skipped } from './util.js';

// Asks an MCP server to evaluate rules. The server receives the rules and the
// files in scope (paths, plus the repository root so a local server can read
// them) and must return an AgentAssessment. Its findings are agentic unless
// the organization's config sets the server's `trust` higher.
//
//   - id: ARCH-001
//     evaluator: mcp.assess
//     params: { server: arch-reviewer, tool: assess_rules }

export const mcpAssessEvaluator: Evaluator = {
  id: 'mcp.assess',
  description: 'Delegates rule evaluation to an MCP server tool that returns an AgentAssessment',
  evidenceType: 'agentic',
  validateParams: (p) => (typeof p.server === 'string' && typeof p.tool === 'string' ? [] : ['params "server" and "tool" are required']),
  async evaluate(rules, ctx) {
    // One call per (server, tool) with all the rules routed to it.
    const groups = new Map<string, ResolvedRule[]>();
    for (const r of rules) {
      const key = `${String(r.params.server)}\u0000${String(r.params.tool)}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const outcomes: RuleOutcome[] = [];
    for (const [key, group] of groups) {
      const [server, tool] = key.split('\u0000') as [string, string];
      try {
        const trust = ctx.mcp.serverConfig(server).trust;
        const files = [...new Set(group.flatMap((r) => ctx.workspace.filesFor(r)))];
        const text = await ctx.mcp.callTool(server, tool, {
          repository_root: ctx.workspace.root,
          files,
          ...(ctx.workspace.diff ? { diff: { base: ctx.workspace.diff.base, head: ctx.workspace.diff.head } } : {}),
          rules: group.map((r) => ({ id: r.id, title: r.title, description: r.description, rationale: r.rationale, category: r.category, severity: r.severity, applies_to: r.applies_to })),
          ...((group[0]!.params.arguments as Record<string, unknown> | undefined) ?? {}),
        });
        const parsed = AgentAssessment.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`MCP ${server}.${tool} did not return an AgentAssessment: ${parsed.error.issues[0]?.message}`);
        const findings = normaliseAgentAssessment(parsed.data, { connector: `mcp:${server}`, trust, source: 'mcp' });
        for (const rule of group) {
          const own = findings.filter((f) => f.rule_id === rule.id);
          if (own.length === 0) {
            outcomes.push(skipped(rule, trust, `MCP server ${server} did not report on this rule`));
            continue;
          }
          const failed = own
            .filter((f) => f.status === 'failed')
            .map((f) => ({ ...f, ruleset: rule.ruleset, rule_version: rule.ruleset_version, source: rule.source, category: rule.category, enforcement: rule.enforcement, severity: rule.severity, evaluator: 'mcp.assess' }));
          if (failed.length === 0 && own.every((f) => f.status === 'not_applicable')) {
            outcomes.push({ rule, status: 'not_applicable', evidence_type: trust, confidence: own[0]!.confidence, findings: [] });
          } else {
            outcomes.push(outcome(rule, trust, failed));
          }
        }
      } catch (error) {
        outcomes.push(...group.map((r) => errorOutcome(r, 'agentic', error)));
      }
    }
    return outcomes;
  },
};
