import type { Finding } from '../core/model.js';
import type { Assessment } from '../engine/assess.js';

const ICON: Record<string, string> = { pass: '✅', warn: '⚠️', fail: '❌' };

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function where(f: Finding): string {
  const l = f.location;
  if (l.file) return l.start_line ? `${l.file}:${l.start_line}` : l.file;
  return l.asset ?? l.package ?? '—';
}

export function renderMarkdown(a: Assessment, options: { maxFindings?: number } = {}): string {
  const r = a.rating;
  const out: string[] = [];
  const max = options.maxFindings ?? 50;

  out.push(`# Engineering rating: ${a.repository.name}`, '');
  out.push(`**Overall: ${r.grade}**${r.score !== null ? ` (${r.score}/100)` : ''} ${ICON[r.status] ?? ''} ${r.status.toUpperCase()}`, '');
  out.push(...r.explanation.map((l) => `> ${l}`), '');

  out.push('| Dimension | Grade | Score | Weight | Rules (pass/fail) | Top deduction |', '| --- | :---: | ---: | ---: | :---: | --- |');
  for (const d of r.dimensions) {
    const top = d.deductions[0];
    out.push(
      `| ${d.label} | ${d.grade ?? '—'} | ${d.score ?? 'not assessed'} | ${d.weight} | ${d.rules.passed}/${d.rules.failed} | ${top ? `${esc(top.rule_id)} −${top.points} (${top.basis})` : ''} |`,
    );
  }
  out.push('');

  const triggered = r.gates.filter((g) => g.triggered);
  if (triggered.length > 0) {
    out.push('## Gates', '');
    for (const g of triggered) out.push(`- **${g.id}** → ${g.action === 'cap' ? `cap at ${g.cap}` : g.action}: ${g.description} (${g.findings.length} finding${g.findings.length === 1 ? '' : 's'})`);
    out.push('');
  }

  out.push('## How each dimension was scored', '');
  for (const d of r.dimensions.filter((x) => x.assessed && x.deductions.length > 0)) {
    out.push(`### ${d.label}: ${d.grade} (${d.score})`, '');
    out.push(d.mode === 'compliance' ? `Weighted pass rate over ${d.rules.evaluated} rules.` : `100 minus the points below.`, '');
    for (const x of d.deductions.slice(0, 10)) out.push(`- \`${x.rule_id}\` ${esc(x.title)}: −${x.points} (${x.basis})`);
    if (d.deductions.length > 10) out.push(`- …and ${d.deductions.length - 10} more`);
    out.push('');
  }

  const active = a.findings.filter((f) => f.status === 'failed' && !f.waived);
  const order = ['critical', 'high', 'medium', 'low', 'info'];
  active.sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity));
  out.push(`## Findings (${active.length})`, '');
  if (active.length > 0) {
    const lowConfidence = new Set(r.low_confidence);
    out.push('| Severity | Rule | Evidence | Where | Message | Confidence | Scored |', '| --- | --- | --- | --- | --- | ---: | --- |');
    for (const f of active.slice(0, max)) {
      const scored = lowConfidence.has(f.id) ? 'no: low confidence' : r.corroborated[f.id] ? 'once, with another source' : 'yes';
      const flags = f.tags.includes('ungrounded') ? ' ⚠ quote not found in file' : '';
      out.push(
        `| ${f.severity} | \`${esc(f.rule_id)}\` | ${f.evidence_type}${f.tool ? ` (${esc(f.tool.name)})` : ''} | \`${esc(where(f))}\` | ${esc(f.message)}${flags} | ${f.confidence.toFixed(2)} | ${scored} |`,
      );
    }
    if (active.length > max) out.push('', `…and ${active.length - max} more in the JSON report.`);
    out.push('');
  }

  const waived = a.findings.filter((f) => f.waived);
  if (waived.length > 0) {
    out.push(`## Waived (${waived.length})`, '');
    for (const f of waived) out.push(`- \`${f.rule_id}\` at \`${where(f)}\`: ${f.waived!.reason} (approved by ${f.waived!.approver}, expires ${f.waived!.expires})`);
    out.push('');
  }

  const remediation = active.filter((f) => f.remediation).slice(0, 10);
  if (remediation.length > 0) {
    out.push('## Remediation, highest severity first', '');
    for (const f of remediation) out.push(`- \`${where(f)}\` **${esc(f.rule_id)}**: ${esc(f.remediation!)}`);
    out.push('');
  }

  const c = r.coverage;
  out.push('## Coverage and provenance', '');
  out.push(`- Rules: ${c.rules} (${c.passed} passed, ${c.failed} failed, ${c.not_applicable} not applicable, ${c.skipped} skipped, ${c.errors} errors)`);
  out.push(`- Rulesets: ${a.provenance.rulesets.map((s) => `${s.id}@${s.version}`).join(', ')}`);
  out.push(`- Connectors: ${a.provenance.connectors.map((x) => `${x.name} ${x.ok ? '✓' : '✗'} (${esc(x.summary)})`).join('; ') || 'none'}`);
  out.push(`- AI: ${a.provenance.ai.enabled ? `${a.provenance.ai.calls} call(s) to ${a.provenance.ai.models.join(', ') || 'no model'}, ${a.provenance.ai.input_tokens + a.provenance.ai.output_tokens} tokens` : 'disabled'}`);
  out.push(`- Scope: ${a.scope.mode === 'diff' ? `diff ${a.scope.base}...${a.scope.head}` : 'full repository'}, ${a.scope.files} files, commit ${a.repository.commit?.slice(0, 12) ?? 'n/a'}`);
  out.push(`- Config sha256 ${a.provenance.config_sha256.slice(0, 12)}, run ${a.id}, ${a.duration_ms} ms`);
  const problems = a.rules.filter((x) => x.status === 'error' || x.status === 'skipped');
  if (problems.length > 0) {
    out.push('', '<details><summary>Rules not evaluated</summary>', '');
    for (const p of problems) out.push(`- \`${p.rule_id}\` ${p.status}: ${esc(p.detail ?? '')}`);
    out.push('', '</details>');
  }
  if (a.warnings.length > 0) {
    out.push('', '<details><summary>Warnings</summary>', '', ...a.warnings.map((w) => `- ${esc(w)}`), '', '</details>');
  }
  return out.join('\n');
}
