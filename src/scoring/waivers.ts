import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { globToRegExp, matcher } from '../config/glob.js';
import type { Finding } from '../core/model.js';

// Accepted risk, recorded in the repository and reviewed like code. A waiver
// stops a finding from counting toward the score and gates, but the finding
// stays in every report, marked as waived, until the waiver expires.
export const Waiver = z.object({
  rule_id: z.string().describe('Rule id or glob'),
  paths: z.array(z.string()).optional(),
  finding_id: z.string().optional(),
  reason: z.string().min(10, 'give a real reason'),
  approver: z.string(),
  expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expires must be YYYY-MM-DD'),
});
export type Waiver = z.infer<typeof Waiver>;

export const WaiverFile = z.object({ waivers: z.array(Waiver).default([]) });

export async function loadWaivers(path: string | undefined): Promise<Waiver[]> {
  if (!path) return [];
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const parsed = WaiverFile.safeParse(parseYaml(text) ?? {});
  if (!parsed.success) throw new Error(`Invalid waivers file ${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data.waivers;
}

export function applyWaivers(findings: Finding[], waivers: Waiver[], today = new Date().toISOString().slice(0, 10)): { findings: Finding[]; warnings: string[] } {
  const warnings: string[] = [];
  const active = waivers.filter((w) => {
    if (w.expires < today) {
      warnings.push(`Waiver for ${w.rule_id} (approved by ${w.approver}) expired on ${w.expires} and no longer applies.`);
      return false;
    }
    return true;
  });
  const compiled = active.map((w) => ({ w, rule: globToRegExp(w.rule_id), path: w.paths ? matcher(w.paths) : null, used: false }));
  const out = findings.map((f) => {
    if (f.status !== 'failed') return f;
    const hit = compiled.find(
      (c) =>
        c.rule.test(f.rule_id) &&
        (!c.w.finding_id || c.w.finding_id === f.id) &&
        (!c.path || (f.location.file !== undefined && c.path(f.location.file))),
    );
    if (!hit) return f;
    hit.used = true;
    return { ...f, waived: { reason: hit.w.reason, expires: hit.w.expires, approver: hit.w.approver } };
  });
  for (const c of compiled) if (!c.used) warnings.push(`Waiver for ${c.w.rule_id} matched nothing; consider removing it.`);
  return { findings: out, warnings };
}
