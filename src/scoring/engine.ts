import { globToRegExp } from '../config/glob.js';
import type { Dimension, Gate, GateCondition, ScoringConfig, Selector } from '../config/schema.js';
import { atLeast, maxSeverity, type Category, type Enforcement, type EvidenceType, type Finding, type Severity, type Source } from '../core/model.js';

// What the scoring engine works on: one entry per rule that was evaluated,
// whether it's an organization rule or a tool's own rule (e.g. snyk:SNYK-JS-…).
export interface ScoredRule {
  rule_id: string;
  title: string;
  ruleset?: string | undefined;
  source: Source;
  category: Category;
  severity: Severity;
  enforcement: Enforcement;
  evidence_type: EvidenceType;
  status: 'passed' | 'failed' | 'error' | 'skipped' | 'not_applicable';
  detail?: string | undefined;
  tool?: string | undefined;
  findings: Finding[];
}

export interface Deduction {
  rule_id: string;
  title: string;
  points: number;
  severity: Severity;
  evidence_type: EvidenceType;
  findings: string[];
  confidence: number;
  // e.g. "high, 3 findings, deterministic"
  basis: string;
}

export interface DimensionScore {
  id: string;
  label: string;
  weight: number;
  mode: Dimension['mode'];
  assessed: boolean;
  score: number | null;
  grade: string | null;
  rules: { evaluated: number; passed: number; failed: number; not_scored: number };
  deductions: Deduction[];
}

export interface GateResult {
  id: string;
  description: string;
  triggered: boolean;
  action: 'cap' | 'fail' | 'warn';
  cap?: string;
  findings: string[];
}

export interface Rating {
  score: number | null;
  grade: string;
  uncapped_grade: string;
  status: 'pass' | 'warn' | 'fail';
  dimensions: DimensionScore[];
  gates: GateResult[];
  // Rules that couldn't be assessed; a rating is only as good as its coverage.
  coverage: { rules: number; evaluated: number; passed: number; failed: number; errors: number; skipped: number; not_applicable: number };
  low_confidence: string[];
  // finding id -> the finding it corroborates (charged once, to the primary)
  corroborated: Record<string, string>;
  explanation: string[];
}

export function gradeFor(score: number, grades: ScoringConfig['grades']): string {
  const sorted = [...grades].sort((a, b) => b.min - a.min);
  return (sorted.find((g) => score >= g.min) ?? sorted.at(-1)!).grade;
}

function gradeRank(grade: string, grades: ScoringConfig['grades']): number {
  const sorted = [...grades].sort((a, b) => b.min - a.min);
  const i = sorted.findIndex((g) => g.grade === grade);
  return i < 0 ? sorted.length : i;
}

function matchesSelector(r: ScoredRule, s: Selector): boolean {
  return (
    (!s.sources || s.sources.includes(r.source)) &&
    (!s.categories || s.categories.includes(r.category)) &&
    (!s.evidence_types || s.evidence_types.includes(r.evidence_type)) &&
    (!s.rule_ids || s.rule_ids.some((g) => globToRegExp(g).test(r.rule_id))) &&
    (!s.tools || (r.tool !== undefined && s.tools.includes(r.tool))) &&
    (!s.tags || r.findings.some((f) => f.tags.some((t) => s.tags!.includes(t))))
  );
}

function isScored(r: ScoredRule): boolean {
  return r.enforcement === 'mandatory' || r.enforcement === 'scored';
}

// The findings that count: failed, not waived, confident enough.
export function activeFindings(r: ScoredRule, minConfidence: number): Finding[] {
  return r.findings.filter((f) => f.status === 'failed' && !f.waived && f.confidence >= minConfidence);
}

function deduction(r: ScoredRule, config: ScoringConfig, corroborating: Set<string> = new Set()): Deduction | null {
  const active = activeFindings(r, config.min_confidence).filter((f) => !corroborating.has(f.id));
  if (active.length === 0) return null;
  const severity = maxSeverity(active.map((f) => f.severity));
  const confidence = Math.max(...active.map((f) => f.confidence));
  const evidence = r.evidence_type === 'agentic' ? config.agentic_weight : 1;
  const repeat = 1 + config.repeat_factor * (active.length - 1);
  const raw = config.severity_points[severity] * evidence * confidence * repeat;
  const points = Math.min(raw, config.per_rule_cap);
  if (points <= 0) return null;
  return {
    rule_id: r.rule_id,
    title: r.title,
    points: Number(points.toFixed(2)),
    severity,
    evidence_type: r.evidence_type,
    findings: active.map((f) => f.id),
    confidence: Number(confidence.toFixed(2)),
    basis: `${severity}, ${active.length} finding${active.length === 1 ? '' : 's'}, ${r.evidence_type}${r.evidence_type === 'agentic' ? ` ×${config.agentic_weight}` : ''}${confidence < 1 ? `, confidence ${confidence.toFixed(2)}` : ''}${raw > config.per_rule_cap ? ' (capped)' : ''}`,
  };
}

// Different sources often report the same problem: Sonar, Semgrep and an org
// pattern rule all flagging one SQL string. In deduction mode the problem is
// charged once, to the strongest finding; the others are recorded as
// corroboration. Compliance mode is per rule, so every failed rule still fails.
export function corroboration(rules: ScoredRule[], config: ScoringConfig): Map<string, string> {
  const claimed = new Map<string, { id: string; rule: string; evaluator: string }>(); // location key -> primary finding
  const corroborates = new Map<string, string>(); // finding id -> primary finding id
  const candidates = rules
    .filter((r) => isScored(r) && r.status === 'failed')
    .flatMap((r) => activeFindings(r, config.min_confidence).map((f) => ({ f, r })))
    .filter(({ f }) => f.location.file && f.location.start_line && config.corroboration.categories.includes(f.category))
    .sort(
      (a, b) =>
        config.severity_points[b.f.severity] * b.f.confidence * (b.r.evidence_type === 'agentic' ? config.agentic_weight : 1) -
          config.severity_points[a.f.severity] * a.f.confidence * (a.r.evidence_type === 'agentic' ? config.agentic_weight : 1) || a.f.id.localeCompare(b.f.id),
    );
  for (const { f, r } of candidates) {
    const line = f.location.start_line!;
    const w = config.corroboration.line_window;
    const keys = Array.from({ length: 2 * w + 1 }, (_, i) => line - w + i).map((n) => `${f.category}|${f.location.file}|${n}`);
    const primary = keys.map((k) => claimed.get(k)).find((p) => p !== undefined);
    // Only an independent source corroborates: two rules from the same
    // evaluator at one line (complexity and nesting, say) are two problems.
    const source = f.tool?.name ?? f.evaluator;
    if (primary && primary.rule !== r.rule_id && primary.evaluator !== source) {
      corroborates.set(f.id, primary.id);
      continue;
    }
    if (!primary) claimed.set(keys[w]!, { id: f.id, rule: r.rule_id, evaluator: source });
  }
  return corroborates;
}

function scoreDimension(d: Dimension, rules: ScoredRule[], config: ScoringConfig, corroborating: Set<string>): DimensionScore {
  const scorable = rules.filter((r) => isScored(r) && (r.status === 'passed' || r.status === 'failed'));
  const skip = d.mode === 'deduction' ? corroborating : new Set<string>();
  const deductions = scorable.flatMap((r) => (r.status === 'failed' ? [deduction(r, config, skip)].filter((x): x is Deduction => x !== null) : []));
  const counts = {
    evaluated: scorable.length,
    passed: scorable.filter((r) => r.status === 'passed').length,
    failed: scorable.filter((r) => r.status === 'failed' && activeFindings(r, config.min_confidence).length > 0).length,
    not_scored: rules.length - scorable.length,
  };
  if (scorable.length === 0) {
    return { id: d.id, label: d.label, weight: d.weight, mode: d.mode, assessed: false, score: null, grade: null, rules: counts, deductions: [] };
  }

  let score: number;
  if (d.mode === 'compliance') {
    // Weighted pass rate: a failed critical rule costs more than a failed low one.
    const weight = (s: Severity) => config.severity_points[s] + 1;
    const total = scorable.reduce((sum, r) => sum + weight(r.severity), 0);
    const failedMass = deductions.reduce((sum, x) => {
      const r = scorable.find((s) => s.rule_id === x.rule_id)!;
      return sum + weight(r.severity) * x.confidence * (x.evidence_type === 'agentic' ? config.agentic_weight : 1);
    }, 0);
    score = 100 * (1 - failedMass / total);
  } else {
    score = Math.max(0, 100 - deductions.reduce((s, x) => s + x.points, 0));
  }
  score = Number(score.toFixed(1));
  deductions.sort((a, b) => b.points - a.points);
  return { id: d.id, label: d.label, weight: d.weight, mode: d.mode, assessed: true, score, grade: gradeFor(score, config.grades), rules: counts, deductions };
}

function matchesGate(f: Finding, r: ScoredRule, c: GateCondition, allowAgentic: boolean): boolean {
  if (f.status !== 'failed' || f.waived) return false;
  if (r.evidence_type === 'agentic' && !allowAgentic) return false;
  return (
    matchesSelector(r, c) &&
    (!c.severity_at_least || atLeast(f.severity, c.severity_at_least)) &&
    (!c.enforcement || c.enforcement.includes(r.enforcement)) &&
    f.confidence >= (c.min_confidence ?? 0) &&
    (!c.tags || f.tags.some((t) => c.tags!.includes(t)))
  );
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function pct(n: number, d: number): string {
  return d === 0 ? '0%' : `${Math.round((100 * n) / d)}%`;
}

export function rate(rules: ScoredRule[], config: ScoringConfig, gates: { rules: Gate[]; allow_agentic: boolean }): Rating {
  // Each rule goes to the first exclusive dimension that matches; shared
  // dimensions see every rule they match.
  const assigned = new Map<string, ScoredRule[]>(config.dimensions.map((d) => [d.id, []]));
  for (const r of rules) {
    const d = config.dimensions.find((dim) => !dim.shared && matchesSelector(r, dim.select));
    if (d) assigned.get(d.id)!.push(r);
    for (const s of config.dimensions.filter((dim) => dim.shared && matchesSelector(r, dim.select))) assigned.get(s.id)!.push(r);
  }
  const corroborates = corroboration(rules, config);
  const dimensions = config.dimensions.map((d) => scoreDimension(d, assigned.get(d.id)!, config, new Set(corroborates.keys())));
  const assessed = dimensions.filter((d) => d.assessed && d.weight > 0);
  const totalWeight = assessed.reduce((s, d) => s + d.weight, 0);
  const score = totalWeight > 0 ? Number((assessed.reduce((s, d) => s + d.weight * d.score!, 0) / totalWeight).toFixed(1)) : null;
  const uncapped = score === null ? 'N/A' : gradeFor(score, config.grades);

  const gateResults: GateResult[] = gates.rules.map((g) => {
    const hits = rules.flatMap((r) => r.findings.filter((f) => matchesGate(f, r, g.when, gates.allow_agentic)).map((f) => f.id));
    const action = 'cap' in g.action ? 'cap' : 'fail' in g.action ? 'fail' : 'warn';
    return {
      id: g.id,
      description: g.description,
      triggered: hits.length >= g.when.min_count,
      action,
      ...('cap' in g.action ? { cap: g.action.cap } : {}),
      findings: hits,
    };
  });

  let grade = uncapped;
  for (const g of gateResults) {
    if (g.triggered && g.action === 'cap' && g.cap && grade !== 'N/A' && gradeRank(g.cap, config.grades) > gradeRank(grade, config.grades)) grade = g.cap;
  }
  const failed = gateResults.some((g) => g.triggered && g.action === 'fail');
  if (failed) grade = 'F';
  const status = failed ? 'fail' : gateResults.some((g) => g.triggered) ? 'warn' : 'pass';

  const coverage = {
    rules: rules.length,
    evaluated: rules.filter((r) => r.status === 'passed' || r.status === 'failed').length,
    passed: rules.filter((r) => r.status === 'passed').length,
    failed: rules.filter((r) => r.status === 'failed').length,
    errors: rules.filter((r) => r.status === 'error').length,
    skipped: rules.filter((r) => r.status === 'skipped').length,
    not_applicable: rules.filter((r) => r.status === 'not_applicable').length,
  };
  const lowConfidence = rules.flatMap((r) => r.findings.filter((f) => f.status === 'failed' && !f.waived && f.confidence < config.min_confidence).map((f) => f.id));

  const rating: Rating = {
    score,
    grade,
    uncapped_grade: uncapped,
    status,
    dimensions,
    gates: gateResults,
    coverage,
    low_confidence: lowConfidence,
    corroborated: Object.fromEntries(corroborates),
    explanation: [],
  };
  rating.explanation = explain(rating, rules, config);
  return rating;
}

// Plain sentences built only from the numbers above, so every claim in the
// explanation can be traced to a rule or finding.
export function explain(rating: Rating, rules: ScoredRule[], config: ScoringConfig): string[] {
  const lines: string[] = [];
  const reasons: string[] = [];

  const org = rules.filter((r) => r.source === 'organization' && isScored(r) && (r.status === 'passed' || r.status === 'failed'));
  if (org.length > 0) reasons.push(`it passed ${org.filter((r) => r.status === 'passed').length} of ${org.length} organization rules (${pct(org.filter((r) => r.status === 'passed').length, org.length)})`);

  const active = rules.flatMap((r) => activeFindings(r, config.min_confidence).map((f) => ({ f, r })));
  const security = active.filter(({ f }) => f.category === 'security' && f.evidence_type !== 'agentic');
  const critical = security.filter(({ f }) => f.severity === 'critical');
  reasons.push(critical.length === 0 ? 'has no critical security findings' : `has ${critical.length} critical security finding${critical.length === 1 ? '' : 's'}`);

  const byTool = new Map<string, { high: number; total: number }>();
  for (const { f } of active) {
    if (f.evidence_type !== 'tool' || !f.tool) continue;
    const t = byTool.get(f.tool.name) ?? { high: 0, total: 0 };
    t.total++;
    if (atLeast(f.severity, 'high')) t.high++;
    byTool.set(f.tool.name, t);
  }
  for (const [tool, t] of byTool) {
    if (t.high > 0) reasons.push(`has ${t.high} high-or-worse ${tool} finding${t.high === 1 ? '' : 's'}`);
  }

  const agentic = active.filter(({ f }) => f.evidence_type === 'agentic');
  if (agentic.length > 0) {
    const cats = new Map<string, number>();
    for (const { f } of agentic) cats.set(f.category, (cats.get(f.category) ?? 0) + 1);
    const summary = joinList([...cats].map(([c, n]) => `${n} ${c}`));
    reasons.push(`the AI assessment identified ${agentic.length} issue${agentic.length === 1 ? '' : 's'} (${summary})`);
  }

  const head =
    rating.score === null
      ? 'The repository could not be rated: no scored rule was evaluated.'
      : `The repository received ${rating.grade} (${rating.score}/100) because ${joinList(reasons)}.`;
  lines.push(head);

  for (const g of rating.gates.filter((x) => x.triggered)) {
    if (g.action === 'cap') {
      const lowered = g.cap !== undefined && rating.uncapped_grade !== 'N/A' && gradeRank(g.cap, config.grades) > gradeRank(rating.uncapped_grade, config.grades);
      lines.push(
        lowered
          ? `Gate "${g.id}" capped the grade at ${g.cap} (the score alone would give ${rating.uncapped_grade}): ${g.description}.`
          : `Gate "${g.id}" triggered (caps at ${g.cap}), but the score is already at or below that: ${g.description}.`,
      );
    }
    else if (g.action === 'fail') lines.push(`Gate "${g.id}" failed the assessment: ${g.description}.`);
    else lines.push(`Gate "${g.id}" raised a warning: ${g.description}.`);
  }

  const notAssessed = rating.dimensions.filter((d) => !d.assessed && d.weight > 0).map((d) => d.label);
  if (notAssessed.length > 0) lines.push(`Not assessed (no evaluated rules), and left out of the overall score: ${notAssessed.join(', ')}.`);
  if (rating.coverage.errors + rating.coverage.skipped > 0) {
    lines.push(`${rating.coverage.errors} rule(s) errored and ${rating.coverage.skipped} were skipped; they don't count as passes.`);
  }
  const corroborated = Object.keys(rating.corroborated).length;
  if (corroborated > 0) lines.push(`${corroborated} finding(s) reported the same problem as a stronger finding from another source and were counted once.`);
  if (rating.low_confidence.length > 0) lines.push(`${rating.low_confidence.length} finding(s) fell below the ${config.min_confidence} confidence threshold and were reported without being scored.`);
  return lines;
}
