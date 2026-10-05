import { readFile } from 'node:fs/promises';
import { matcher } from '../config/glob.js';
import { makeFinding } from '../core/finding.js';
import type { Category, Finding } from '../core/model.js';
import type { Connector } from '../core/plugin.js';
import { normaliseSeverity, parseJson, str } from './common.js';

// Orca Security reports on cloud assets (VMs, containers, buckets, IAM), not
// files, so findings carry an asset location. `match_assets` scopes alerts to
// the assets this repository deploys; without it every alert in the tenant
// would land on every repository.
//
//   orca:
//     type: orca
//     url: https://api.orcasecurity.io
//     endpoint: /api/alerts          # check against your tenant's API docs
//     token_env: ORCA_API_TOKEN
//     match_assets: ["payments-*", "acme/payments:*"]
//
// Field names differ between Orca API versions and exports, so the mapping
// below reads the common variants. Verify against a sample from your tenant
// and adjust `field_map` in config if needed.

type Alert = Record<string, unknown>;

function pick(alert: Alert, paths: string[]): unknown {
  for (const path of paths) {
    const value = path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), alert);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

const DEFAULT_FIELDS = {
  id: ['alert_id', 'id', 'state.alert_id'],
  title: ['title', 'description', 'type_string', 'details.title'],
  severity: ['state.risk_level', 'risk_level', 'state.severity', 'severity'],
  status: ['state.status', 'status'],
  category: ['category', 'type'],
  asset: ['asset_name', 'asset.name', 'asset_unique_id', 'cloud_asset_name'],
  remediation: ['recommendation', 'remediation', 'details.recommendation'],
  cves: ['cve_list', 'cves', 'details.cve_ids'],
  link: ['url', 'alert_url'],
} as const;

type FieldMap = { [K in keyof typeof DEFAULT_FIELDS]: string[] };

const OPEN = new Set(['open', 'in_progress', 'in progress', 'new', '']);

function categoryOf(raw: string): Category {
  const v = raw.toLowerCase();
  if (v.includes('compliance') || v.includes('cis')) return 'compliance';
  return 'security';
}

export function normaliseOrcaAlerts(alerts: Alert[], options: { connector: string; matchAssets: string[]; fields?: Partial<FieldMap> }): Finding[] {
  const fields: FieldMap = { ...(DEFAULT_FIELDS as unknown as FieldMap), ...options.fields };
  const inScope = options.matchAssets.length > 0 ? matcher(options.matchAssets) : () => true;
  const findings: Finding[] = [];
  for (const alert of alerts) {
    const status = String(pick(alert, fields.status) ?? '').toLowerCase();
    if (!OPEN.has(status)) continue;
    const asset = str(pick(alert, fields.asset));
    if (!inScope(asset ?? '')) continue;
    const id = String(pick(alert, fields.id) ?? 'unknown');
    const title = String(pick(alert, fields.title) ?? id);
    const cves = pick(alert, fields.cves);
    const link = str(pick(alert, fields.link));
    findings.push(
      makeFinding({
        rule_id: `orca:${String(pick(alert, ['type', 'rule_id']) ?? id)}`,
        source: 'tool',
        evidence_type: 'tool',
        evaluator: `connector:${options.connector}`,
        tool: { name: 'orca' },
        category: categoryOf(String(pick(alert, fields.category) ?? '')),
        severity: normaliseSeverity(pick(alert, fields.severity)),
        confidence: 1,
        status: 'failed',
        location: asset ? { asset } : {},
        message: title,
        remediation: str(pick(alert, fields.remediation)),
        references: link ? [link] : [],
        tags: ['cloud', `connector:${options.connector}`],
        cve: Array.isArray(cves) ? cves.map(String) : [],
        discriminator: id,
      }),
    );
  }
  return findings;
}

export const orcaConnector: Connector = {
  type: 'orca',
  description: 'Orca Security cloud alerts, scoped to this repository\'s assets',
  async collect(name, config, ctx) {
    let alerts: Alert[];
    if (config.report) {
      const data = parseJson<Alert[] | { data?: Alert[]; alerts?: Alert[] }>(await readFile(config.report, 'utf8'), 'Orca report');
      alerts = Array.isArray(data) ? data : data.data ?? data.alerts ?? [];
    } else {
      if (typeof config.url !== 'string') throw new Error(`connector ${name}: set "report" or "url"`);
      const token = process.env[typeof config.token_env === 'string' ? config.token_env : 'ORCA_API_TOKEN'];
      if (!token) throw new Error(`connector ${name}: no API token in the environment`);
      const endpoint = typeof config.endpoint === 'string' ? config.endpoint : '/api/alerts';
      const query = new URLSearchParams((config.query as Record<string, string> | undefined) ?? {});
      const res = await fetch(`${config.url.replace(/\/$/, '')}${endpoint}?${query}`, {
        headers: { Accept: 'application/json', Authorization: `Token ${token}` },
        signal: ctx.signal,
      });
      if (!res.ok) throw new Error(`Orca API returned ${res.status} ${res.statusText}`);
      const body = (await res.json()) as { data?: Alert[] } | Alert[];
      alerts = Array.isArray(body) ? body : body.data ?? [];
    }
    const findings = normaliseOrcaAlerts(alerts, {
      connector: name,
      matchAssets: (config.match_assets as string[] | undefined) ?? [],
      ...(config.field_map ? { fields: config.field_map as Partial<FieldMap> } : {}),
    });
    return { findings, tool: { name: 'orca' }, summary: `${findings.length} of ${alerts.length} Orca alerts in scope` };
  },
};
