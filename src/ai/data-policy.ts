import { matcher } from '../config/glob.js';
import type { AIConfig, DataPolicy, ModelProfile } from '../config/schema.js';
import { redactSecrets } from '../evaluators/secrets.js';
import type { AIProvider } from './provider.js';

const PII_PATTERNS: Array<{ id: string; pattern: RegExp; check?: (m: string) => boolean }> = [
  { id: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { id: 'us-ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { id: 'card-number', pattern: /\b(?:\d[ -]?){13,19}\b/g, check: luhn },
  { id: 'phone', pattern: /(?<![\w.])\+?\d{1,3}[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g },
];

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function redactPii(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const p of PII_PATTERNS) {
    out = out.replace(p.pattern, (m) => {
      if (p.check && !p.check(m)) return m;
      // Leave obvious placeholders alone so examples stay readable.
      if (p.id === 'email' && /@(?:example\.(?:com|org|net)|test\.com|localhost)$/i.test(m)) return m;
      count++;
      return `[REDACTED:${p.id}]`;
    });
  }
  return { text: out, count };
}

export interface PreparedText {
  text: string;
  redactions: { secrets: number; pii: number };
}

// Everything that leaves the machine for a model goes through here.
export class DataPolicyGate {
  private excluded: (p: string) => boolean;
  private classes: Array<{ name: string; test: (p: string) => boolean; allowed: string[] }>;

  constructor(private readonly policy: DataPolicy) {
    this.excluded = matcher(policy.exclude_paths);
    this.classes = policy.classifications.map((c) => ({ name: c.name, test: matcher(c.paths), allowed: c.allowed_hosting }));
  }

  get sendsSource(): boolean {
    return this.policy.send_source_code;
  }

  allowedFiles(paths: string[]): { allowed: string[]; excluded: string[] } {
    const allowed: string[] = [];
    const excluded: string[] = [];
    for (const p of paths) (this.excluded(p) ? excluded : allowed).push(p);
    return { allowed, excluded };
  }

  prepare(text: string): PreparedText {
    let out = text;
    let secrets = 0;
    let pii = 0;
    if (this.policy.redact_secrets) ({ text: out, count: secrets } = redactSecrets(out));
    if (this.policy.redact_pii) ({ text: out, count: pii } = redactPii(out));
    return { text: out, redactions: { secrets, pii } };
  }

  // Why a model may not receive these files, or null if it may.
  rejects(profileName: string, profile: ModelProfile, provider: AIProvider, files: string[]): string | null {
    const p = this.policy;
    if (p.allowed_providers && !p.allowed_providers.includes(profile.provider)) return `provider ${profile.provider} is not in data_policy.allowed_providers`;
    if (p.allowed_models && !p.allowed_models.includes(profile.model) && !p.allowed_models.includes(profileName)) {
      return `model ${profile.model} is not in data_policy.allowed_models`;
    }
    for (const c of this.classes) {
      const hit = files.find((f) => c.test(f));
      if (hit && !c.allowed.includes(provider.hosting)) {
        return `${hit} is classified "${c.name}", which allows ${c.allowed.join('/')} hosting; ${provider.name} is ${provider.hosting}`;
      }
    }
    return null;
  }
}

export function dataPolicyFor(ai: AIConfig): DataPolicyGate {
  return new DataPolicyGate(ai.data_policy);
}
