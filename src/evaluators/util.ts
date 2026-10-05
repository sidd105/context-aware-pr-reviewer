import { makeFinding } from '../core/finding.js';
import type { EvidenceType, Finding, FindingInput, ResolvedRule, RuleOutcome } from '../core/model.js';
import type { AssessmentContext } from '../core/plugin.js';

export interface RuleFindingInput {
  file?: string | undefined;
  line?: number | undefined;
  endLine?: number | undefined;
  message: string;
  evidence?: string | undefined;
  confidence?: number;
  discriminator?: string | number;
  extra?: Partial<FindingInput>;
}

// A failed finding for an org/industry rule, carrying the rule's metadata.
export function ruleFinding(rule: ResolvedRule, evaluator: string, evidenceType: EvidenceType, f: RuleFindingInput): Finding {
  return makeFinding({
    rule_id: rule.id,
    rule_version: rule.ruleset_version,
    ruleset: rule.ruleset,
    source: rule.source,
    evidence_type: evidenceType,
    evaluator,
    category: rule.category,
    severity: rule.severity,
    enforcement: rule.enforcement,
    confidence: f.confidence ?? 1,
    status: 'failed',
    location: {
      ...(f.file ? { file: f.file } : {}),
      ...(f.line ? { start_line: f.line } : {}),
      ...(f.endLine ? { end_line: f.endLine } : {}),
    },
    message: f.message,
    ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
    ...(rule.remediation ? { remediation: rule.remediation } : {}),
    references: rule.references,
    tags: rule.tags,
    ...(f.discriminator !== undefined ? { discriminator: f.discriminator } : {}),
    ...f.extra,
  });
}

export function outcome(
  rule: ResolvedRule,
  evidenceType: EvidenceType,
  findings: Finding[],
  options: { scope?: number; detail?: string } = {},
): RuleOutcome {
  if (options.scope === 0 && findings.length === 0) {
    return { rule, status: 'not_applicable', evidence_type: evidenceType, confidence: 1, findings, detail: options.detail ?? 'No files in scope' };
  }
  const failed = findings.filter((f) => f.status === 'failed');
  return {
    rule,
    status: failed.length > 0 ? 'failed' : 'passed',
    evidence_type: evidenceType,
    confidence: failed.length > 0 ? Math.max(...failed.map((f) => f.confidence)) : 1,
    findings,
    ...(options.detail ? { detail: options.detail } : {}),
  };
}

export function errorOutcome(rule: ResolvedRule, evidenceType: EvidenceType, error: unknown): RuleOutcome {
  return { rule, status: 'error', evidence_type: evidenceType, confidence: 0, findings: [], detail: error instanceof Error ? error.message : String(error) };
}

export function skipped(rule: ResolvedRule, evidenceType: EvidenceType, detail: string): RuleOutcome {
  return { rule, status: 'skipped', evidence_type: evidenceType, confidence: 0, findings: [], detail };
}

// Numbered lines around `line`, for evidence.
export function excerpt(source: string, line: number, radius = 1): string {
  const lines = source.split('\n');
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(`${String(n).padStart(4)} | ${lines[n - 1]}`);
  return out.join('\n');
}

export function num(params: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const v = params[key];
  return typeof v === 'number' ? v : fallback;
}

export function requireParams(params: Record<string, unknown>, spec: Record<string, 'string' | 'number' | 'string[]' | 'boolean'>): string[] {
  const problems: string[] = [];
  for (const [key, type] of Object.entries(spec)) {
    const v = params[key];
    const ok =
      type === 'string[]' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === type;
    if (!ok) problems.push(`param "${key}" must be a ${type}`);
  }
  return problems;
}

export type Ctx = AssessmentContext;
