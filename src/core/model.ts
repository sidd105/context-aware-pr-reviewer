import { z } from 'zod';

// ---------------------------------------------------------------------------
// Severity and confidence
// ---------------------------------------------------------------------------

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const Severity = z.enum(SEVERITIES);
export type Severity = z.infer<typeof Severity>;

export function severityRank(s: Severity): number {
  return SEVERITIES.length - SEVERITIES.indexOf(s); // critical = 5 … info = 1
}

export function atLeast(s: Severity, floor: Severity): boolean {
  return severityRank(s) >= severityRank(floor);
}

export function maxSeverity(values: Severity[]): Severity {
  return values.reduce<Severity>((best, s) => (severityRank(s) > severityRank(best) ? s : best), 'info');
}

// Confidence is a probability that the finding is real, 0..1. Deterministic
// evaluators report 1. Tool connectors report what the tool implies (a
// confirmed CVE is 1, a Sonar hotspot "to review" is lower). Agentic findings
// carry the model's own estimate, adjusted by grounding checks.
export const Confidence = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// How the evidence was produced. This is the line between "this rule
// definitely failed" and "an agent believes this rule failed".
// ---------------------------------------------------------------------------

export const EvidenceType = z.enum(['deterministic', 'tool', 'agentic']);
export type EvidenceType = z.infer<typeof EvidenceType>;

export const Source = z.enum(['organization', 'industry', 'tool', 'agent', 'mcp']);
export type Source = z.infer<typeof Source>;

export const CATEGORIES = [
  'security',
  'code-quality',
  'architecture',
  'maintainability',
  'testing',
  'reliability',
  'performance',
  'documentation',
  'compliance',
  'sdlc',
] as const;
export const Category = z.enum(CATEGORIES);
export type Category = z.infer<typeof Category>;

// How a rule's result is allowed to affect the outcome.
//   mandatory      scored, and a failure can trip a gate
//   scored         scored only
//   advisory       reported and shown in the explanation, never scored
//   informational  recorded for context only
export const Enforcement = z.enum(['mandatory', 'scored', 'advisory', 'informational']);
export type Enforcement = z.infer<typeof Enforcement>;

export const FindingStatus = z.enum(['failed', 'passed', 'error', 'skipped', 'not_applicable']);
export type FindingStatus = z.infer<typeof FindingStatus>;

// ---------------------------------------------------------------------------
// Normalized finding: the one shape every source is converted into
// ---------------------------------------------------------------------------

export const Location = z.object({
  file: z.string().optional(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  // For findings that aren't in source: a package, container image, cloud asset.
  asset: z.string().optional(),
  package: z.string().optional(),
});
export type Location = z.infer<typeof Location>;

export const AIProvenance = z.object({
  provider: z.string(),
  model: z.string(),
  profile: z.string(),
  prompt_version: z.string(),
  temperature: z.number().optional(),
  request_id: z.string().optional(),
  prompt_sha256: z.string(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  latency_ms: z.number().optional(),
});
export type AIProvenance = z.infer<typeof AIProvenance>;

export const Finding = z.object({
  id: z.string().describe('Stable fingerprint: same problem in the same place gives the same id across runs'),
  rule_id: z.string(),
  rule_version: z.string().optional(),
  ruleset: z.string().optional(),
  source: Source,
  evidence_type: EvidenceType,
  evaluator: z.string(),
  tool: z.object({ name: z.string(), version: z.string().optional() }).optional(),
  category: Category,
  severity: Severity,
  confidence: Confidence,
  status: FindingStatus,
  enforcement: Enforcement.default('scored'),
  location: Location.default({}),
  message: z.string(),
  evidence: z.string().optional(),
  remediation: z.string().optional(),
  references: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  cwe: z.array(z.string()).default([]),
  cve: z.array(z.string()).default([]),
  ai: AIProvenance.optional(),
  // Set by the waiver step, never by an evaluator.
  waived: z.object({ reason: z.string(), expires: z.string().optional(), approver: z.string().optional() }).optional(),
});
export type Finding = z.infer<typeof Finding>;
export type FindingInput = z.input<typeof Finding>;

// ---------------------------------------------------------------------------
// Rules: what "good" means. A rule names an evaluator; it never names a model.
// ---------------------------------------------------------------------------

export const AppliesTo = z.object({
  languages: z.array(z.string()).default([]),
  paths: z.array(z.string()).default(['**']),
  exclude: z.array(z.string()).default([]),
});

export const Rule = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'rule ids are letters, digits, . _ : -'),
  title: z.string(),
  description: z.string().default(''),
  rationale: z.string().default(''),
  category: Category,
  severity: Severity,
  enforcement: Enforcement.default('scored'),
  evaluator: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  applies_to: AppliesTo.default({ languages: [], paths: ['**'], exclude: [] }),
  remediation: z.string().default(''),
  references: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  // Examples help agentic evaluators; deterministic evaluators ignore them.
  examples: z.object({ good: z.array(z.string()).default([]), bad: z.array(z.string()).default([]) }).optional(),
  // A hint for model routing (tiers are mapped to models in config). Never a model name.
  ai: z.object({ complexity: z.enum(['low', 'medium', 'high']).optional() }).optional(),
  enabled: z.boolean().default(true),
});
export type Rule = z.infer<typeof Rule>;

// A rule after loading, with where it came from.
export interface ResolvedRule extends Rule {
  ruleset: string;
  ruleset_version: string;
  source: Source;
  // Set when an override changed the rule, so reports can say so.
  overridden_by?: string;
}

// The outcome of evaluating one rule, which the scoring engine consumes.
export interface RuleOutcome {
  rule: ResolvedRule;
  status: 'passed' | 'failed' | 'error' | 'skipped' | 'not_applicable';
  evidence_type: EvidenceType;
  confidence: number;
  findings: Finding[];
  detail?: string;
}
