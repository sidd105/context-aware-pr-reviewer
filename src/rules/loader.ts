import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageRoot } from '../core/paths.js';
import { parseAllDocuments } from 'yaml';
import { globToRegExp } from '../config/glob.js';
import type { RuleOverride, RuleSourceConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import { Rule, severityRank, type Enforcement, type ResolvedRule } from '../core/model.js';
import type { AssessmentContext, Registry, RuleSource } from '../core/plugin.js';
import { applyDefaults, RuleSetDocument } from './schema.js';

export const BUILTIN_DIR = join(packageRoot(), 'rulesets');

export async function readRuleSetFile(path: string): Promise<RuleSetDocument[]> {
  const text = await readFile(path, 'utf8');
  return parseAllDocuments(text).map((doc, i) => {
    if (doc.errors.length > 0) throw new Error(`${path}: ${doc.errors[0]!.message}`);
    const result = RuleSetDocument.safeParse(doc.toJS());
    if (!result.success) {
      const issues = result.error.issues.map((x) => `  ${x.path.join('.')}: ${x.message}`).join('\n');
      throw new Error(`${path} (document ${i + 1}) is not a valid RuleSet:\n${issues}`);
    }
    return result.data;
  });
}

export const fileRuleSource: RuleSource = {
  type: 'file',
  matches: (c) => 'path' in c && !('type' in c),
  load: (c) => readRuleSetFile((c as { path: string }).path),
};

export const builtinRuleSource: RuleSource = {
  type: 'builtin',
  matches: (c) => 'builtin' in c,
  load: (c) => readRuleSetFile(join(BUILTIN_DIR, `${(c as { builtin: string }).builtin}.yaml`)),
};

const ENFORCEMENT_RANK: Record<Enforcement, number> = { informational: 0, advisory: 1, scored: 2, mandatory: 3 };

function idMatches(pattern: string, id: string): boolean {
  return pattern === id || (pattern.includes('*') && globToRegExp(pattern).test(id));
}

function applyOverride(rule: ResolvedRule, o: RuleOverride, origin: string, locked: boolean, warnings: string[]): ResolvedRule {
  if (locked) {
    // Scope and params can loosen a rule as easily as tighten it, so only
    // severity and enforcement may be raised on a locked rule.
    if (o.applies_to || o.params) {
      warnings.push(`${origin}: cannot change the scope or params of locked rule ${rule.id} (from ${rule.ruleset}); override ignored.`);
      return rule;
    }
    const weakens =
      o.enabled === false ||
      (o.severity && severityRank(o.severity) < severityRank(rule.severity)) ||
      (o.enforcement && ENFORCEMENT_RANK[o.enforcement] < ENFORCEMENT_RANK[rule.enforcement]);
    if (weakens) {
      warnings.push(`${origin}: cannot weaken locked rule ${rule.id} (from ${rule.ruleset}); override ignored.`);
      return rule;
    }
  }
  return {
    ...rule,
    ...(o.severity ? { severity: o.severity } : {}),
    ...(o.enforcement ? { enforcement: o.enforcement } : {}),
    ...(o.enabled !== undefined ? { enabled: o.enabled } : {}),
    ...(o.params ? { params: { ...rule.params, ...o.params } } : {}),
    applies_to: {
      ...rule.applies_to,
      ...(o.applies_to?.paths ? { paths: o.applies_to.paths } : {}),
      ...(o.applies_to?.exclude ? { exclude: [...rule.applies_to.exclude, ...o.applies_to.exclude] } : {}),
    },
    overridden_by: origin,
  };
}

export interface LoadedRules {
  rules: ResolvedRule[];
  rulesets: Array<{ id: string; version: string; source: string; owner?: string | undefined; rules: number }>;
  warnings: string[];
}

// Precedence, lowest to highest:
//   1. rulesets a ruleset extends (e.g. builtin:python-zen)
//   2. rulesets, in the order the config lists them
//   3. each ruleset's own `overrides` of rules it inherited
//   4. the config's `rule_overrides` (repository level)
// Two rulesets defining the same id is an error: changing someone else's rule
// has to be an explicit override, so it shows up in review.
export async function loadRules(
  sources: RuleSourceConfig[],
  overrides: RuleOverride[],
  registry: Registry,
  ctx: Pick<AssessmentContext, 'mcp' | 'logger'>,
): Promise<LoadedRules> {
  const rules = new Map<string, ResolvedRule>();
  const locked = new Set<string>();
  const rulesets: LoadedRules['rulesets'] = [];
  const warnings: string[] = [];
  const loadedIds = new Set<string>();

  async function loadDocument(doc: RuleSetDocument, chain: string[]) {
    const setId = doc.metadata.id;
    if (chain.includes(setId)) throw new Error(`RuleSet extends itself: ${[...chain, setId].join(' -> ')}`);
    if (loadedIds.has(setId)) return;
    for (const parent of doc.extends) {
      const [kind, name] = parent.includes(':') ? parent.split(':', 2) : ['builtin', parent];
      if (kind !== 'builtin') throw new Error(`${setId}: extends "${parent}" — only builtin:<name> is supported in extends`);
      for (const d of await readRuleSetFile(join(BUILTIN_DIR, `${name}.yaml`))) await loadDocument(d, [...chain, setId]);
    }
    loadedIds.add(setId);
    let count = 0;
    for (const raw of doc.rules) {
      const parsed = Rule.safeParse(applyDefaults(raw, doc.defaults));
      if (!parsed.success) {
        const issues = parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ');
        throw new Error(`RuleSet ${setId}: rule ${String(raw.id ?? '(no id)')} is invalid: ${issues}`);
      }
      const existing = rules.get(parsed.data.id);
      if (existing) {
        throw new Error(
          `Rule ${parsed.data.id} is defined in both ${existing.ruleset} and ${setId}. Use "overrides" in ${setId} to change an inherited rule.`,
        );
      }
      rules.set(parsed.data.id, { ...parsed.data, ruleset: setId, ruleset_version: doc.metadata.version, source: doc.metadata.source });
      if (doc.metadata.locked) locked.add(parsed.data.id);
      count++;
    }
    for (const o of doc.overrides) {
      const targets = [...rules.values()].filter((r) => idMatches(o.id, r.id) && r.ruleset !== setId);
      if (targets.length === 0) warnings.push(`RuleSet ${setId}: override ${o.id} matches no inherited rule.`);
      for (const r of targets) rules.set(r.id, applyOverride(r, o, `ruleset ${setId}`, locked.has(r.id), warnings));
    }
    rulesets.push({ id: setId, version: doc.metadata.version, source: doc.metadata.source, owner: doc.metadata.owner, rules: count });
  }

  for (const source of sources) {
    const handler = registry.ruleSources.find((s) => s.matches(source));
    if (!handler) throw new Error(`No rule source handles ${JSON.stringify(source)}`);
    for (const doc of await handler.load(source, ctx)) await loadDocument(doc, []);
  }

  for (const o of overrides) {
    const targets = [...rules.values()].filter((r) => idMatches(o.id, r.id));
    if (targets.length === 0) warnings.push(`rule_overrides: ${o.id} matches no rule.`);
    for (const r of targets) rules.set(r.id, applyOverride(r, o, 'repository config', locked.has(r.id), warnings));
  }

  // Catch typos in evaluator names and params now, not mid-run.
  const errors: string[] = [];
  for (const rule of rules.values()) {
    const evaluator = registry.evaluators.get(rule.evaluator);
    if (!evaluator) {
      errors.push(`${rule.id}: unknown evaluator "${rule.evaluator}"`);
      continue;
    }
    for (const problem of evaluator.validateParams?.(rule.params, rule) ?? []) errors.push(`${rule.id}: ${problem}`);
  }
  if (errors.length > 0) throw new Error(`Rule validation failed:\n  ${errors.join('\n  ')}`);

  return { rules: [...rules.values()], rulesets, warnings };
}

export function logWarnings(logger: Logger, warnings: string[]) {
  for (const w of warnings) logger.warn(w);
}
