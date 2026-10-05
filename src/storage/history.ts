import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Assessment } from '../engine/assess.js';

// Assessments are stored as plain JSON files, one per run. That's enough for
// trends and "why did the grade change" in a single repository, and the files
// can be shipped to a warehouse for organization-wide dashboards (see
// docs/DESIGN.md, Storage).

export async function saveRun(a: Assessment, dir: string, keep: number): Promise<string> {
  const root = isAbsolute(dir) ? dir : join(a.repository.root, dir);
  await mkdir(root, { recursive: true });
  const name = `${a.started_at.replace(/[:.]/g, '-')}-${(a.repository.commit ?? 'nocommit').slice(0, 8)}-${a.id}.json`;
  const path = join(root, name);
  await writeFile(path, JSON.stringify(a, null, 2));
  const runs = (await readdir(root)).filter((f) => f.endsWith('.json')).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - keep))) await rm(join(root, old));
  return path;
}

export async function loadRun(path: string): Promise<Assessment> {
  return JSON.parse(await readFile(path, 'utf8')) as Assessment;
}

export async function latestRuns(dir: string, n: number): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .slice(-n)
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export interface RunComparison {
  from: { id: string; grade: string; score: number | null; commit: string | null };
  to: { id: string; grade: string; score: number | null; commit: string | null };
  dimensions: Array<{ id: string; label: string; from: number | null; to: number | null }>;
  new_findings: Array<{ id: string; rule_id: string; severity: string; message: string }>;
  resolved_findings: Array<{ id: string; rule_id: string; severity: string; message: string }>;
  rulesets_changed: string[];
  config_changed: boolean;
  models_changed: boolean;
  summary: string[];
}

// Explains what changed between two runs, separating "the code changed" from
// "the rules, config or model changed", which is the first question anyone
// asks when a grade moves.
export function compareRuns(a: Assessment, b: Assessment): RunComparison {
  const active = (x: Assessment) => new Map(x.findings.filter((f) => f.status === 'failed' && !f.waived).map((f) => [f.id, f]));
  const before = active(a);
  const after = active(b);
  const brief = (f: Assessment['findings'][number]) => ({ id: f.id, rule_id: f.rule_id, severity: f.severity, message: f.message });
  const newFindings = [...after.values()].filter((f) => !before.has(f.id)).map(brief);
  const resolved = [...before.values()].filter((f) => !after.has(f.id)).map(brief);
  const sets = (x: Assessment) => new Map(x.provenance.rulesets.map((s) => [s.id, s.version]));
  const sa = sets(a);
  const sb = sets(b);
  const rulesetsChanged = [...new Set([...sa.keys(), ...sb.keys()])].filter((k) => sa.get(k) !== sb.get(k)).map((k) => `${k}: ${sa.get(k) ?? '—'} → ${sb.get(k) ?? '—'}`);
  const configChanged = a.provenance.config_sha256 !== b.provenance.config_sha256;
  const modelsChanged = a.provenance.ai.models.join(',') !== b.provenance.ai.models.join(',');
  const dims = b.rating.dimensions.map((d) => ({ id: d.id, label: d.label, from: a.rating.dimensions.find((x) => x.id === d.id)?.score ?? null, to: d.score }));

  const summary = [`${a.rating.grade} (${a.rating.score ?? '—'}) → ${b.rating.grade} (${b.rating.score ?? '—'})`];
  if (newFindings.length || resolved.length) summary.push(`${newFindings.length} new finding(s), ${resolved.length} resolved.`);
  for (const d of dims) if (d.from !== d.to) summary.push(`${d.label}: ${d.from ?? 'n/a'} → ${d.to ?? 'n/a'}`);
  if (rulesetsChanged.length) summary.push(`Ruleset versions changed (${rulesetsChanged.join('; ')}), so part of the change may come from the rules, not the code.`);
  if (configChanged) summary.push('Configuration changed between runs.');
  if (modelsChanged) summary.push(`AI models changed: ${a.provenance.ai.models.join(', ') || 'none'} → ${b.provenance.ai.models.join(', ') || 'none'}.`);

  return {
    from: { id: a.id, grade: a.rating.grade, score: a.rating.score, commit: a.repository.commit },
    to: { id: b.id, grade: b.rating.grade, score: b.rating.score, commit: b.repository.commit },
    dimensions: dims,
    new_findings: newFindings,
    resolved_findings: resolved,
    rulesets_changed: rulesetsChanged,
    config_changed: configChanged,
    models_changed: modelsChanged,
    summary,
  };
}
