import { readFile } from 'node:fs/promises';
import { makeFinding } from '../core/finding.js';
import type { Category, Finding, Severity } from '../core/model.js';
import type { Connector } from '../core/plugin.js';
import { parseJson } from './common.js';

// SonarQube / SonarCloud. Reads the Web API (`api/issues/search`, optionally
// `api/hotspots/search`) or a saved copy of those responses.
//
//   sonar:
//     type: sonar
//     url: https://sonarcloud.io
//     project_key: acme_payments
//     token_env: SONAR_TOKEN
//     branch: main              # or pull_request: "123"
//     include_hotspots: true

interface SonarIssue {
  key: string;
  rule: string;
  severity?: string;
  type?: string;
  component: string;
  line?: number;
  textRange?: { startLine?: number; endLine?: number };
  message: string;
  tags?: string[];
  status?: string;
  issueStatus?: string;
  impacts?: Array<{ softwareQuality: string; severity: string }>;
  cleanCodeAttribute?: string;
}

interface SonarHotspot {
  key: string;
  component: string;
  line?: number;
  message: string;
  vulnerabilityProbability?: string;
  securityCategory?: string;
  ruleKey?: string;
  status?: string;
}

interface SonarPage<T> {
  issues?: T[];
  hotspots?: T[];
  paging?: { pageIndex: number; pageSize: number; total: number };
  total?: number;
}

const LEGACY_SEVERITY: Record<string, Severity> = { BLOCKER: 'critical', CRITICAL: 'high', MAJOR: 'medium', MINOR: 'low', INFO: 'info' };
const IMPACT_SEVERITY: Record<string, Severity> = { BLOCKER: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' };
const TYPE_CATEGORY: Record<string, Category> = { VULNERABILITY: 'security', BUG: 'reliability', CODE_SMELL: 'maintainability', SECURITY_HOTSPOT: 'security' };
const QUALITY_CATEGORY: Record<string, Category> = { SECURITY: 'security', RELIABILITY: 'reliability', MAINTAINABILITY: 'maintainability' };
const HOTSPOT_SEVERITY: Record<string, Severity> = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

// "project:src/app.py" -> "src/app.py"
function componentPath(component: string): string {
  const i = component.indexOf(':');
  return i >= 0 ? component.slice(i + 1) : component;
}

export function normaliseSonarIssue(issue: SonarIssue, connector: string, url?: string): Finding {
  // Sonar 10+ reports "impacts" per software quality; older versions a single severity and type.
  const impact = issue.impacts?.reduce<{ softwareQuality: string; severity: string } | undefined>(
    (worst, i) => (!worst || Object.keys(IMPACT_SEVERITY).indexOf(i.severity) < Object.keys(IMPACT_SEVERITY).indexOf(worst.severity) ? i : worst),
    undefined,
  );
  const severity = impact ? IMPACT_SEVERITY[impact.severity] ?? 'medium' : LEGACY_SEVERITY[issue.severity ?? ''] ?? 'medium';
  const category = impact ? QUALITY_CATEGORY[impact.softwareQuality] ?? 'code-quality' : TYPE_CATEGORY[issue.type ?? ''] ?? 'code-quality';
  const line = issue.textRange?.startLine ?? issue.line;
  return makeFinding({
    rule_id: `sonar:${issue.rule}`,
    source: 'tool',
    evidence_type: 'tool',
    evaluator: `connector:${connector}`,
    tool: { name: 'sonar' },
    category,
    severity,
    confidence: 1,
    status: 'failed',
    location: { file: componentPath(issue.component), ...(line ? { start_line: line } : {}), ...(issue.textRange?.endLine ? { end_line: issue.textRange.endLine } : {}) },
    message: issue.message,
    references: url ? [`${url.replace(/\/$/, '')}/coding_rules?open=${encodeURIComponent(issue.rule)}`] : [],
    tags: [...(issue.tags ?? []), `connector:${connector}`],
    discriminator: issue.key,
  });
}

export function normaliseSonarHotspot(h: SonarHotspot, connector: string): Finding {
  return makeFinding({
    rule_id: `sonar:${h.ruleKey ?? 'hotspot'}`,
    source: 'tool',
    evidence_type: 'tool',
    evaluator: `connector:${connector}`,
    tool: { name: 'sonar' },
    category: 'security',
    severity: HOTSPOT_SEVERITY[h.vulnerabilityProbability ?? ''] ?? 'medium',
    // A hotspot is code that needs a human security review, not a confirmed
    // vulnerability, so it counts for less until someone reviews it.
    confidence: 0.5,
    status: 'failed',
    location: { file: componentPath(h.component), ...(h.line ? { start_line: h.line } : {}) },
    message: `Security hotspot: ${h.message}`,
    tags: ['hotspot', ...(h.securityCategory ? [h.securityCategory] : []), `connector:${connector}`],
    discriminator: h.key,
  });
}

async function fetchAll<T>(base: string, path: string, params: Record<string, string>, token: string | undefined, key: 'issues' | 'hotspots'): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const query = new URLSearchParams({ ...params, ps: '500', p: String(page) });
    const res = await fetch(`${base.replace(/\/$/, '')}${path}?${query}`, {
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`Sonar ${path} returned ${res.status} ${res.statusText}`);
    const body = (await res.json()) as SonarPage<T>;
    const items = body[key] ?? [];
    out.push(...items);
    const total = body.paging?.total ?? body.total ?? items.length;
    if (out.length >= total || items.length === 0) break;
    // Sonar's search API stops at 10,000 results.
    if (out.length >= 10_000) break;
  }
  return out;
}

export const sonarConnector: Connector = {
  type: 'sonar',
  description: 'SonarQube / SonarCloud issues and security hotspots (Web API or saved JSON)',
  async collect(name, config, ctx) {
    let issues: SonarIssue[] = [];
    let hotspots: SonarHotspot[] = [];
    const url = typeof config.url === 'string' ? config.url : undefined;
    if (config.report) {
      const page = parseJson<SonarPage<SonarIssue> & { hotspots?: SonarHotspot[] }>(await readFile(config.report, 'utf8'), 'Sonar report');
      issues = page.issues ?? [];
      hotspots = page.hotspots ?? [];
    } else {
      if (!url || typeof config.project_key !== 'string') throw new Error(`connector ${name}: set "report", or "url" and "project_key"`);
      const tokenEnv = typeof config.token_env === 'string' ? config.token_env : 'SONAR_TOKEN';
      const token = process.env[tokenEnv];
      const scope: Record<string, string> = {};
      if (typeof config.branch === 'string') scope.branch = config.branch;
      if (typeof config.pull_request === 'string') scope.pullRequest = config.pull_request;
      issues = await fetchAll<SonarIssue>(url, '/api/issues/search', { componentKeys: config.project_key, resolved: 'false', ...scope }, token, 'issues');
      if (config.include_hotspots) {
        hotspots = await fetchAll<SonarHotspot>(url, '/api/hotspots/search', { projectKey: config.project_key, status: 'TO_REVIEW', ...scope }, token, 'hotspots');
      }
    }
    const closed = ['CLOSED', 'RESOLVED', 'FIXED', 'ACCEPTED', 'FALSE_POSITIVE', 'WONTFIX'];
    const open = issues.filter((i) => !closed.includes(i.issueStatus ?? 'OPEN') && !closed.includes(i.status ?? 'OPEN'));
    const findings = [
      ...open.map((i) => normaliseSonarIssue(i, name, url)),
      ...hotspots.filter((h) => (h.status ?? 'TO_REVIEW') === 'TO_REVIEW').map((h) => normaliseSonarHotspot(h, name)),
    ];
    ctx.logger.debug(`sonar: ${issues.length} issues, ${hotspots.length} hotspots`);
    return { findings, tool: { name: 'sonar' }, summary: `${open.length} open issues, ${hotspots.length} hotspots from Sonar` };
  },
};
