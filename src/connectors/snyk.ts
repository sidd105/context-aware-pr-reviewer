import { makeFinding } from '../core/finding.js';
import type { Finding } from '../core/model.js';
import type { Connector } from '../core/plugin.js';
import { normaliseSeverity, parseJson, readReport, repoPath } from './common.js';
import { parseSarif } from './sarif.js';

// Snyk has several products with different outputs:
//   snyk test --json          open source dependencies  -> { vulnerabilities: [...] } (or an array, one per project)
//   snyk iac test --json      infrastructure as code    -> { infrastructureAsCodeIssues: [...] }
//   snyk container test --json                          -> { vulnerabilities: [...] } with docker image info
//   snyk code test --sarif    first-party code (SAST)   -> SARIF
// The connector detects which one it was given.

interface SnykVuln {
  id: string;
  title: string;
  severity: string;
  packageName?: string;
  version?: string;
  from?: string[];
  identifiers?: { CVE?: string[]; CWE?: string[] };
  cvssScore?: number;
  isUpgradable?: boolean;
  isPatchable?: boolean;
  upgradePath?: Array<string | boolean>;
  fixedIn?: string[];
  url?: string;
  exploit?: string;
}

interface SnykProject {
  vulnerabilities?: SnykVuln[];
  infrastructureAsCodeIssues?: Array<{
    id: string;
    publicId?: string;
    title: string;
    severity: string;
    msg?: string;
    path?: string[];
    lineNumber?: number;
    impact?: string;
    resolve?: string;
    documentation?: string;
  }>;
  targetFile?: string;
  displayTargetFile?: string;
  docker?: { image?: string };
  path?: string;
  projectName?: string;
  packageManager?: string;
  error?: string;
}

export function parseSnyk(text: string, options: { root: string; connector: string }): { findings: Finding[]; tool: { name: string } } {
  const data = parseJson<SnykProject | SnykProject[] | { runs?: unknown }>(text, 'Snyk report');
  if (!Array.isArray(data) && 'runs' in data) {
    const sarif = parseSarif(text, { root: options.root, connector: options.connector, toolName: 'snyk-code', defaultCategory: 'security' });
    return { findings: sarif.findings, tool: { name: 'snyk' } };
  }
  const projects = Array.isArray(data) ? data : [data as SnykProject];
  const findings: Finding[] = [];
  const tool = { name: 'snyk' };

  for (const project of projects) {
    if (project.error) throw new Error(`Snyk reported an error: ${project.error}`);
    const target = repoPath(project.displayTargetFile ?? project.targetFile, options.root);
    const asset = project.docker?.image;

    // Snyk lists a vulnerability once per dependency path; one finding per
    // (vulnerability, package version) is what a developer acts on.
    const seen = new Set<string>();
    for (const v of project.vulnerabilities ?? []) {
      const key = `${v.id}|${v.packageName}@${v.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const upgrade = v.upgradePath?.find((p): p is string => typeof p === 'string' && p !== v.from?.[0]);
      const fix = upgrade ? `Upgrade to ${upgrade}` : v.fixedIn?.length ? `Fixed in ${v.packageName} ${v.fixedIn.join(', ')}` : 'No fix available yet; assess exposure';
      findings.push(
        makeFinding({
          rule_id: `snyk:${v.id}`,
          source: 'tool',
          evidence_type: 'tool',
          evaluator: `connector:${options.connector}`,
          tool,
          category: 'security',
          severity: normaliseSeverity(v.severity),
          confidence: 1,
          status: 'failed',
          location: { ...(target ? { file: target } : {}), ...(asset ? { asset } : {}), package: `${v.packageName}@${v.version}` },
          message: `${v.title} in ${v.packageName}@${v.version}`,
          evidence: v.from?.length ? `Introduced through: ${v.from.join(' > ')}` : undefined,
          remediation: fix,
          references: v.url ? [v.url] : [],
          tags: ['dependency', `connector:${options.connector}`, ...(v.exploit && v.exploit !== 'Not Defined' ? [`exploit:${v.exploit.toLowerCase()}`] : [])],
          cve: v.identifiers?.CVE ?? [],
          cwe: v.identifiers?.CWE ?? [],
        }),
      );
    }

    for (const issue of project.infrastructureAsCodeIssues ?? []) {
      findings.push(
        makeFinding({
          rule_id: `snyk:${issue.publicId ?? issue.id}`,
          source: 'tool',
          evidence_type: 'tool',
          evaluator: `connector:${options.connector}`,
          tool,
          category: 'security',
          severity: normaliseSeverity(issue.severity),
          confidence: 1,
          status: 'failed',
          location: { ...(target ? { file: target } : {}), ...(issue.lineNumber && issue.lineNumber > 0 ? { start_line: issue.lineNumber } : {}) },
          message: issue.title,
          evidence: [issue.msg, issue.impact].filter(Boolean).join(' — ') || undefined,
          remediation: issue.resolve,
          references: issue.documentation ? [issue.documentation] : [],
          tags: ['iac', `connector:${options.connector}`],
          discriminator: issue.path?.join('.'),
        }),
      );
    }
  }
  return { findings, tool };
}

export const snykConnector: Connector = {
  type: 'snyk',
  description: 'Snyk Open Source, Container, IaC (JSON) and Code (SARIF) results',
  async collect(name, config, ctx) {
    const { findings, tool } = parseSnyk(await readReport(name, config, ctx), { root: ctx.workspace.root, connector: name });
    return { findings, tool, summary: `${findings.length} Snyk issues` };
  },
};
