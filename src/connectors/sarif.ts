import { makeFinding } from '../core/finding.js';
import { Category, type Finding, type Severity } from '../core/model.js';
import type { Connector } from '../core/plugin.js';
import { normaliseSeverity, parseJson, readReport, repoPath, severityFromCvss, str } from './common.js';

// SARIF 2.1.0 is what most scanners can emit (Semgrep, CodeQL, Snyk Code,
// Checkov, Trivy, Gitleaks, ESLint with a formatter), so one good SARIF
// reader covers a long tail of tools.

interface SarifRule {
  id: string;
  name?: string;
  shortDescription?: { text?: string };
  fullDescription?: { text?: string };
  help?: { text?: string };
  helpUri?: string;
  defaultConfiguration?: { level?: string };
  properties?: { tags?: string[]; 'security-severity'?: string; precision?: string; [k: string]: unknown };
}

interface SarifResult {
  ruleId?: string;
  rule?: { id?: string };
  level?: string;
  message?: { text?: string; markdown?: string };
  locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number; endLine?: number; snippet?: { text?: string } } } }>;
  partialFingerprints?: Record<string, string>;
  fingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
  suppressions?: Array<{ kind?: string; status?: string }>;
}

interface SarifLog {
  version?: string;
  runs?: Array<{ tool?: { driver?: { name?: string; version?: string; semanticVersion?: string; rules?: SarifRule[] } }; results?: SarifResult[] }>;
}

const PRECISION: Record<string, number> = { 'very-high': 1, high: 0.9, medium: 0.7, low: 0.5 };

function categorise(tags: string[], fallback: Category): Category {
  const lower = tags.map((t) => t.toLowerCase());
  if (lower.some((t) => t === 'security' || t.startsWith('cwe') || t.includes('owasp') || t.includes('secret'))) return 'security';
  for (const t of lower) {
    const parsed = Category.safeParse(t);
    if (parsed.success) return parsed.data;
  }
  if (lower.includes('maintainability')) return 'maintainability';
  if (lower.includes('correctness') || lower.includes('reliability')) return 'reliability';
  return fallback;
}

export function parseSarif(
  text: string,
  options: { root: string; connector: string; defaultCategory?: Category; toolName?: string },
): { findings: Finding[]; tool: { name: string; version?: string } } {
  const log = parseJson<SarifLog>(text, 'SARIF report');
  if (!Array.isArray(log.runs)) throw new Error('SARIF report has no runs');
  const findings: Finding[] = [];
  let tool = { name: options.toolName ?? 'sarif' } as { name: string; version?: string };

  for (const run of log.runs) {
    const driver = run.tool?.driver ?? {};
    const toolName = options.toolName ?? driver.name ?? 'sarif';
    const version = driver.semanticVersion ?? driver.version;
    tool = { name: toolName, ...(version ? { version } : {}) };
    const rules = new Map((driver.rules ?? []).map((r) => [r.id, r]));

    for (const result of run.results ?? []) {
      // Results the tool itself marks as suppressed are respected.
      if (result.suppressions?.some((s) => s.status !== 'rejected')) continue;
      const ruleId = result.ruleId ?? result.rule?.id ?? 'unknown';
      const rule = rules.get(ruleId);
      const tags = [...(rule?.properties?.tags ?? []), ...((result.properties?.tags as string[] | undefined) ?? [])];
      const cvss = Number(rule?.properties?.['security-severity'] ?? result.properties?.['security-severity']);
      const severity: Severity = Number.isFinite(cvss) && cvss > 0 ? severityFromCvss(cvss) : normaliseSeverity(result.level ?? rule?.defaultConfiguration?.level, 'medium');
      const loc = result.locations?.[0]?.physicalLocation;
      const file = repoPath(loc?.artifactLocation?.uri, options.root);
      const isSecret = /secret|credential|password|token|api[-_]?key/i.test(`${ruleId} ${tags.join(' ')}`);
      const message = result.message?.text ?? rule?.shortDescription?.text ?? ruleId;
      findings.push(
        makeFinding({
          rule_id: `${toolName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}:${ruleId}`,
          source: 'tool',
          evidence_type: 'tool',
          evaluator: `connector:${options.connector}`,
          tool,
          category: categorise(tags, options.defaultCategory ?? 'code-quality'),
          severity,
          confidence: PRECISION[String(rule?.properties?.precision ?? '')] ?? 0.9,
          status: 'failed',
          location: {
            ...(file ? { file } : {}),
            ...(loc?.region?.startLine ? { start_line: loc.region.startLine } : {}),
            ...(loc?.region?.endLine ? { end_line: loc.region.endLine } : {}),
          },
          message,
          ...(str(loc?.region?.snippet?.text) ? { evidence: loc!.region!.snippet!.text! } : {}),
          ...(str(rule?.help?.text) ? { remediation: rule!.help!.text! } : {}),
          references: rule?.helpUri ? [rule.helpUri] : [],
          tags: [...new Set([...tags, `connector:${options.connector}`, ...(isSecret ? ['secret'] : [])])],
          cwe: tags.filter((t) => /^cwe[-:]?\d+/i.test(t)).map((t) => `CWE-${t.replace(/\D/g, '')}`),
          discriminator: result.partialFingerprints ? Object.values(result.partialFingerprints).join('|') : loc?.region?.startLine,
        }),
      );
    }
  }
  return { findings, tool };
}

export const sarifConnector: Connector = {
  type: 'sarif',
  description: 'Any SARIF 2.1.0 report (Semgrep, CodeQL, Snyk Code, Checkov, Trivy, Gitleaks…)',
  async collect(name, config, ctx) {
    const category = Category.safeParse(config.category);
    const { findings, tool } = parseSarif(await readReport(name, config, ctx), {
      root: ctx.workspace.root,
      connector: name,
      ...(category.success ? { defaultCategory: category.data } : {}),
      ...(typeof config.tool_name === 'string' ? { toolName: config.tool_name } : {}),
    });
    return { findings, tool, summary: `${findings.length} results from ${tool.name}` };
  },
};
