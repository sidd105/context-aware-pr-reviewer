import { z } from 'zod';
import { Category, Enforcement, EvidenceType, Severity, Source } from '../core/model.js';

// ---------------------------------------------------------------------------
// Rule sources
// ---------------------------------------------------------------------------

const RuleSourceFile = z.object({ path: z.string() });
const RuleSourceBuiltin = z.object({ builtin: z.string() });

// Maps knowledge units (from context-engineering-sdlc or any similar store) to
// rules. Units become agentic rules unless `evaluators` routes them to a
// deterministic evaluator — the organization decides how each one is checked.
const UnitMapping = z.object({
  id_prefix: z.string().default(''),
  levels: z.record(z.string(), Enforcement).default({ must: 'mandatory', should: 'scored', may: 'advisory' }),
  kinds: z.record(z.string(), Category).default({}),
  default_category: Category.default('sdlc'),
  default_severity: Severity.default('medium'),
  default_evaluator: z.string().default('ai.review'),
  evaluators: z
    .record(z.string(), z.object({ evaluator: z.string(), params: z.record(z.string(), z.unknown()).default({}) }))
    .default({}),
  include_kinds: z.array(z.string()).optional(),
  include_layers: z.array(z.string()).optional(),
});
export type UnitMapping = z.infer<typeof UnitMapping>;

const RuleSourceUnits = z.object({
  type: z.literal('context-units'),
  path: z.string(),
  ruleset: z.string().optional(),
  version: z.string().default('0.0.0'),
  mapping: UnitMapping.default(UnitMapping.parse({})),
});

const RuleSourceMcp = z.object({
  type: z.literal('mcp'),
  server: z.string().describe('Name of an entry in mcp_servers'),
  tool: z.string().default('get_context'),
  arguments: z.record(z.string(), z.unknown()).default({}),
  ruleset: z.string().optional(),
  version: z.string().default('0.0.0'),
  mapping: UnitMapping.default(UnitMapping.parse({})),
});

// Typed sources first: a plain { path } would otherwise match them and drop `type`.
export const RuleSourceConfig = z.union([RuleSourceUnits, RuleSourceMcp, RuleSourceFile.strict(), RuleSourceBuiltin.strict()]);
export type RuleSourceConfig = z.infer<typeof RuleSourceConfig>;

export const RuleOverride = z.object({
  id: z.string().describe('Rule id or glob, e.g. "PEP8-*"'),
  severity: Severity.optional(),
  enforcement: Enforcement.optional(),
  enabled: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  applies_to: z
    .object({ paths: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() })
    .optional(),
  reason: z.string().optional(),
});
export type RuleOverride = z.infer<typeof RuleOverride>;

// ---------------------------------------------------------------------------
// Connectors (security and quality tools)
// ---------------------------------------------------------------------------

export const ConnectorConfig = z
  .object({
    type: z.string(),
    enabled: z.boolean().default(true),
    // Read an existing report instead of calling the tool.
    report: z.string().optional(),
  })
  .loose();
export type ConnectorConfig = z.infer<typeof ConnectorConfig>;

// ---------------------------------------------------------------------------
// Scoring and gates
// ---------------------------------------------------------------------------

const Selector = z.object({
  sources: z.array(Source).optional(),
  categories: z.array(Category).optional(),
  evidence_types: z.array(EvidenceType).optional(),
  rule_ids: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
export type Selector = z.infer<typeof Selector>;

export const Dimension = z.object({
  id: z.string(),
  label: z.string(),
  weight: z.number().nonnegative(),
  // Exclusive dimensions (the default) split rules between them: each rule is
  // scored in the first exclusive dimension whose selector matches, in the
  // order listed, so order is precedence and nothing is counted twice.
  // A shared dimension is a view: it scores every matching rule without
  // claiming it (e.g. "Org Standards" as compliance across all org rules).
  select: Selector,
  shared: z.boolean().default(false),
  // compliance: weighted share of evaluated rules that passed.
  // deduction:  100 minus points for each failed rule, by severity.
  mode: z.enum(['compliance', 'deduction']).default('deduction'),
});
export type Dimension = z.infer<typeof Dimension>;

const DEFAULT_DIMENSIONS: z.input<typeof Dimension>[] = [
  // Agentic evidence is isolated in its own dimension, so its weight bounds
  // how far AI opinion can move the overall score.
  { id: 'ai', label: 'AI Assessment', weight: 10, select: { evidence_types: ['agentic'] } },
  { id: 'security', label: 'Security', weight: 30, select: { categories: ['security'] } },
  { id: 'architecture', label: 'Architecture', weight: 10, select: { categories: ['architecture'] } },
  { id: 'testing', label: 'Testing', weight: 10, select: { categories: ['testing'] } },
  { id: 'maintainability', label: 'Maintainability', weight: 5, select: { categories: ['maintainability', 'documentation'] } },
  { id: 'code_quality', label: 'Code Quality', weight: 15, select: {} },
  {
    id: 'organization',
    label: 'Org Standards',
    weight: 20,
    select: { sources: ['organization'], evidence_types: ['deterministic', 'tool'] },
    mode: 'compliance',
    shared: true,
  },
];

export const Grade = z.object({ grade: z.string(), min: z.number() });
const DEFAULT_GRADES = [
  { grade: 'A+', min: 97 },
  { grade: 'A', min: 93 },
  { grade: 'A-', min: 90 },
  { grade: 'B+', min: 87 },
  { grade: 'B', min: 83 },
  { grade: 'B-', min: 80 },
  { grade: 'C+', min: 77 },
  { grade: 'C', min: 73 },
  { grade: 'C-', min: 70 },
  { grade: 'D', min: 60 },
  { grade: 'F', min: 0 },
];

export const ScoringConfig = z.object({
  dimensions: z.array(Dimension).default(DEFAULT_DIMENSIONS.map((d) => Dimension.parse(d))),
  severity_points: z
    .record(Severity, z.number().nonnegative())
    .default({ critical: 40, high: 15, medium: 5, low: 1, info: 0 }),
  // Extra findings of one rule cost less than the first, up to a cap, so one
  // noisy lint rule can't flatten a dimension.
  repeat_factor: z.number().min(0).max(1).default(0.25),
  per_rule_cap: z.number().positive().default(45),
  // Agentic evidence counts for this fraction of deterministic evidence.
  agentic_weight: z.number().min(0).max(1).default(0.6),
  // Findings below this confidence are reported but not scored.
  min_confidence: z.number().min(0).max(1).default(0.5),
  // Independent sources reporting the same problem (Sonar, Semgrep and an org
  // rule on one SQL string) are charged once. Conservative by default: only
  // these categories, only findings this many lines apart.
  corroboration: z
    .object({ categories: z.array(Category).default(['security']), line_window: z.number().int().nonnegative().default(0) })
    .default({ categories: ['security'], line_window: 0 }),
  grades: z.array(Grade).default(DEFAULT_GRADES),
});
export type ScoringConfig = z.infer<typeof ScoringConfig>;

export const GateCondition = Selector.extend({
  severity_at_least: Severity.optional(),
  enforcement: z.array(Enforcement).optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  min_count: z.number().int().positive().default(1),
});
export type GateCondition = z.infer<typeof GateCondition>;

export const Gate = z.object({
  id: z.string(),
  description: z.string().default(''),
  when: GateCondition,
  action: z.union([z.object({ cap: z.string() }), z.object({ fail: z.literal(true) }), z.object({ warn: z.literal(true) })]),
});
export type Gate = z.infer<typeof Gate>;

const DEFAULT_GATES: z.input<typeof Gate>[] = [
  {
    id: 'no-secrets',
    description: 'A detected secret fails the assessment',
    when: { tags: ['secret'], evidence_types: ['deterministic', 'tool'] },
    action: { fail: true },
  },
  {
    id: 'critical-security-caps-at-C',
    description: 'A critical security finding caps the rating at C',
    when: { categories: ['security'], severity_at_least: 'critical', evidence_types: ['deterministic', 'tool'] },
    action: { cap: 'C' },
  },
  {
    id: 'mandatory-org-rule-caps-at-B',
    description: 'A failed mandatory organization rule caps the rating at B',
    when: { sources: ['organization'], enforcement: ['mandatory'], evidence_types: ['deterministic', 'tool'] },
    action: { cap: 'B' },
  },
];

export const GatesConfig = z.object({
  rules: z.array(Gate).default(DEFAULT_GATES.map((g) => Gate.parse(g))),
  // Off by default: an AI opinion alone should not fail a build.
  allow_agentic: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// AI: providers, model profiles, routing and data policy
// ---------------------------------------------------------------------------

export const Capabilities = z.object({
  structured_output: z.boolean().default(false),
  tool_calling: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  vision: z.boolean().default(false),
  long_context: z.boolean().default(false),
  embeddings: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof Capabilities>;

export const ProviderConfig = z
  .object({
    type: z.string().describe('Adapter: anthropic, openai-compatible, replay, or a plugin-provided type'),
    base_url: z.string().optional(),
    // Credentials are only ever read from the environment.
    api_key_env: z.string().optional(),
    // Where the provider runs, used by the data policy.
    hosting: z.enum(['vendor', 'cloud-tenant', 'self-hosted', 'local']).default('vendor'),
  })
  .loose();
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const ModelProfile = z.object({
  provider: z.string(),
  model: z.string(),
  capabilities: Capabilities.default(Capabilities.parse({})),
  context_tokens: z.number().int().positive().default(128_000),
  max_output_tokens: z.number().int().positive().default(16_000),
  temperature: z.number().min(0).max(2).optional(),
  // Provider-specific knobs passed through untouched (e.g. effort).
  options: z.record(z.string(), z.unknown()).default({}),
  cost_per_mtok: z.object({ input: z.number(), output: z.number() }).optional(),
});
export type ModelProfile = z.infer<typeof ModelProfile>;

export const Routing = z.object({
  default: z.string().optional(),
  fallback: z.array(z.string()).default([]),
  evaluators: z.record(z.string(), z.string()).default({}),
  categories: z.record(z.string(), z.string()).default({}),
  tiers: z.partialRecord(z.enum(['low', 'medium', 'high']), z.string()).default({}),
  environments: z
    .record(z.string(), z.object({ default: z.string().optional(), evaluators: z.record(z.string(), z.string()).optional() }))
    .default({}),
});
export type Routing = z.infer<typeof Routing>;

export const DataPolicy = z.object({
  send_source_code: z.boolean().default(true),
  // Never sent to any model, whatever the rule says.
  exclude_paths: z.array(z.string()).default(['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/secrets/**']),
  redact_secrets: z.boolean().default(true),
  redact_pii: z.boolean().default(true),
  allowed_providers: z.array(z.string()).optional(),
  allowed_models: z.array(z.string()).optional(),
  // Paths with a classification, and which hosting each classification allows.
  classifications: z
    .array(z.object({ name: z.string(), paths: z.array(z.string()), allowed_hosting: z.array(z.string()) }))
    .default([]),
  log_prompts: z.boolean().default(false),
});
export type DataPolicy = z.infer<typeof DataPolicy>;

export const AIConfig = z.object({
  enabled: z.boolean().default(false),
  providers: z.record(z.string(), ProviderConfig).default({}),
  models: z.record(z.string(), ModelProfile).default({}),
  routing: Routing.default(Routing.parse({})),
  data_policy: DataPolicy.default(DataPolicy.parse({})),
  audit_log: z.string().default('.cqr/audit.jsonl'),
});
export type AIConfig = z.infer<typeof AIConfig>;

export const McpServerConfig = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  // How much the organization trusts this server's findings. A server cannot
  // promote its own findings to deterministic; only config can.
  trust: EvidenceType.default('agentic'),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  organization: z.string().default('default'),
  repository: z.string().optional(),
  extends: z.array(z.string()).default([]),
  // Keys an organization config locks so repository configs can't weaken them.
  locked: z.array(z.string()).default([]),
  exclude: z
    .array(z.string())
    .default(['node_modules/**', '**/node_modules/**', 'dist/**', 'build/**', '.git/**', '.venv/**', '**/__pycache__/**', '.cqr/**', '**/*.min.js', '**/package-lock.json']),
  rulesets: z.array(RuleSourceConfig).default([]),
  rule_overrides: z.array(RuleOverride).default([]),
  connectors: z.record(z.string(), ConnectorConfig).default({}),
  // Tool findings that no org rule claims: score them under their tool's own
  // rule id, or ignore them.
  unmapped_tool_findings: z.enum(['include', 'ignore']).default('include'),
  evaluators: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  scoring: ScoringConfig.default(ScoringConfig.parse({})),
  gates: GatesConfig.default(GatesConfig.parse({})),
  waivers: z.string().optional(),
  ai: AIConfig.default(AIConfig.parse({})),
  mcp_servers: z.record(z.string(), McpServerConfig).default({}),
  execution: z
    .object({
      // Running commands from config is code execution. Only enable it for
      // configs you trust (see docs/DESIGN.md, Security).
      allow_commands: z.boolean().default(false),
      timeout_seconds: z.number().positive().default(600),
      concurrency: z.number().int().positive().default(4),
    })
    .default({ allow_commands: false, timeout_seconds: 600, concurrency: 4 }),
  storage: z.object({ dir: z.string().default('.cqr/runs'), keep: z.number().int().positive().default(100) }).default({ dir: '.cqr/runs', keep: 100 }),
  plugins: z.array(z.string()).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;
