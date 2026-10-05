import { createHash } from 'node:crypto';
import { Finding, type FindingInput } from './model.js';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Line numbers shift when unrelated code moves, so the fingerprint uses the
// rule, the file or asset, and the normalised message rather than the line.
// Two identical messages in one file are told apart by `discriminator`.
export function fingerprint(parts: {
  rule_id: string;
  file?: string | undefined;
  asset?: string | undefined;
  package?: string | undefined;
  message: string;
  discriminator?: string | number | undefined;
}): string {
  const normalised = parts.message.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const key = [parts.rule_id, parts.file ?? '', parts.asset ?? '', parts.package ?? '', normalised, parts.discriminator ?? ''].join('\u0000');
  return sha256(key).slice(0, 16);
}

// Every evaluator and connector builds findings through here, so the schema is
// enforced in one place and ids are always present.
export function makeFinding(input: Omit<FindingInput, 'id'> & { id?: string; discriminator?: string | number }): Finding {
  const { discriminator, ...rest } = input;
  const id =
    input.id ??
    fingerprint({
      rule_id: input.rule_id,
      file: input.location?.file,
      asset: input.location?.asset,
      package: input.location?.package,
      message: input.message,
      discriminator,
    });
  return Finding.parse({ ...rest, id });
}

// Same problem reported twice (a vulnerability reachable through two
// dependency paths, a rule hit by two evaluators): keep the strongest.
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byId = new Map<string, Finding>();
  for (const f of findings) {
    const existing = byId.get(f.id);
    if (!existing || f.confidence > existing.confidence) byId.set(f.id, f);
  }
  return [...byId.values()];
}
