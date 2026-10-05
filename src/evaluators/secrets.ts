import type { Evaluator } from '../core/plugin.js';
import { errorOutcome, outcome, ruleFinding } from './util.js';

interface SecretPattern {
  id: string;
  label: string;
  pattern: RegExp;
  // Generic patterns also need high-entropy values to avoid flagging
  // `password = "changeme"` in docs.
  minEntropy?: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'aws-access-key', label: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'gitlab-token', label: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', label: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-live-key', label: 'Stripe live key', pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { id: 'google-api-key', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-key', label: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { id: 'private-key', label: 'Private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  {
    id: 'generic-credential',
    label: 'Hard-coded credential',
    // A prefix is allowed so DB_PASSWORD and stripe_api_key are caught too.
    pattern: /\b[\w-]*?(?:api[_-]?key|secret|token|passwd|password|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi,
    minEntropy: 3.5,
  },
];

export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function mask(secret: string): string {
  return secret.length <= 8 ? '********' : `${secret.slice(0, 4)}…${'*'.repeat(8)}`;
}

export interface SecretHit {
  line: number;
  kind: string;
  label: string;
  match: string;
}

export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const p of SECRET_PATTERNS) {
      for (const m of line.matchAll(p.pattern)) {
        const value = m[1] ?? m[0];
        if (p.minEntropy && shannonEntropy(value) < p.minEntropy) continue;
        hits.push({ line: i + 1, kind: p.id, label: p.label, match: value });
      }
    }
  });
  return hits;
}

// Used by the AI data policy before any text leaves the machine.
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.pattern, (whole: string, group?: string) => {
      const value = typeof group === 'string' ? group : whole;
      if (value.startsWith('[REDACTED:')) return whole;
      if (p.minEntropy && shannonEntropy(value) < p.minEntropy) return whole;
      count++;
      return whole.replace(value, `[REDACTED:${p.id}]`);
    });
  }
  return { text: out, count };
}

export const secretsEvaluator: Evaluator = {
  id: 'secrets.scan',
  description: 'Detects credentials and private keys committed to the repository',
  evidenceType: 'deterministic',
  async evaluate(rules, ctx) {
    return Promise.all(
      rules.map(async (rule) => {
        try {
          const files = ctx.workspace.filesFor(rule);
          const findings = [];
          for (const file of files) {
            const text = await ctx.workspace.read(file);
            if (!text) continue;
            for (const hit of findSecrets(text)) {
              findings.push(
                ruleFinding(rule, this.id, 'deterministic', {
                  file,
                  line: hit.line,
                  message: `${hit.label} committed to source`,
                  // Never echo the secret itself.
                  evidence: `${hit.label}: ${mask(hit.match)}`,
                  discriminator: hit.line,
                  extra: { tags: [...new Set([...rule.tags, 'secret', hit.kind])] },
                }),
              );
            }
          }
          return outcome(rule, 'deterministic', findings, { scope: files.length });
        } catch (error) {
          return errorOutcome(rule, 'deterministic', error);
        }
      }),
    );
  },
};
