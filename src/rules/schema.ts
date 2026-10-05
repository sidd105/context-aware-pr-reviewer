import { z } from 'zod';
import { RuleOverride } from '../config/schema.js';
import { AppliesTo, Category, Enforcement, Rule, Severity, Source } from '../core/model.js';

export const RuleSetDocument = z.object({
  apiVersion: z.literal('cqr/v1'),
  kind: z.literal('RuleSet'),
  metadata: z.object({
    id: z.string(),
    version: z.string().regex(/^\d+\.\d+\.\d+/, 'use semantic versioning, e.g. 1.4.2'),
    owner: z.string().optional(),
    description: z.string().default(''),
    source: Source.default('organization'),
    // Later layers (repository configs) may tighten these rules but not
    // disable them or lower their severity or enforcement.
    locked: z.boolean().default(false),
  }),
  extends: z.array(z.string()).default([]),
  defaults: z
    .object({
      category: Category.optional(),
      severity: Severity.optional(),
      enforcement: Enforcement.optional(),
      applies_to: AppliesTo.partial().optional(),
    })
    .default({}),
  // Rules are validated after defaults are applied, so fields may be omitted here.
  rules: z.array(z.record(z.string(), z.unknown())).default([]),
  overrides: z.array(RuleOverride).default([]),
});
export type RuleSetDocument = z.infer<typeof RuleSetDocument>;

export function applyDefaults(raw: Record<string, unknown>, defaults: RuleSetDocument['defaults']): unknown {
  const appliesTo = { ...(defaults.applies_to ?? {}), ...((raw.applies_to as object | undefined) ?? {}) };
  return {
    ...(defaults.category ? { category: defaults.category } : {}),
    ...(defaults.severity ? { severity: defaults.severity } : {}),
    ...(defaults.enforcement ? { enforcement: defaults.enforcement } : {}),
    ...raw,
    applies_to: appliesTo,
  };
}

export { Rule };
