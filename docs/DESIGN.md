# Design: organization-defined engineering rating

This document describes the framework in this repository: what it is for, how
it is put together, and why it is built the way it is. Everything described
here is implemented unless it is marked **planned**.

## The idea

Most AI code review tools give you their own opinion of your code. That's
useful, but it isn't your organization's opinion. Your organization already
has a definition of good software, spread across a style guide, architecture
decision records, a secure coding standard, a testing policy and the habits of
senior engineers. It also already runs Snyk, Sonar and a dozen linters, each
with its own dashboard and its own idea of severity.

This framework puts the organization's definition first and treats everything
else as evidence:

```
Overall rating = organization rules
               + deterministic scanning
               + security and quality tools
               + AI and MCP assessments
```

The principle everything follows from:

> The AI agent does not define what "good" means. The organization defines
> what good means, and the agent and the scanners provide evidence against
> that definition.

So the framework keeps six things separate:

| Concept | Question it answers | Where it lives |
| --- | --- | --- |
| Rules | What does good mean? | Versioned YAML rulesets (`rulesets/`, org repos) |
| Evaluators | How do we decide whether a rule holds? | `src/evaluators/`, plugins |
| Findings | What evidence did we find? | The normalized finding schema (`src/core/model.ts`) |
| Scoring | How much does each finding matter? | `src/scoring/engine.ts`, `scoring:` config |
| Policy and gates | What is unacceptable regardless of score? | `gates:` config, waivers |
| Reporting | How do we explain the result? | `src/report/`, the explanation builder |

A rule never names a model or a tool. An evaluator never decides severity. The
scoring engine never calls an LLM. Each can change without the others.

## Architecture

```
                         ┌──────────────────────┐
                         │  Source repository   │  git working tree (full or diff scope)
                         └──────────┬───────────┘
          ┌──────────────────────────┼──────────────────────────┐
          ▼                          ▼                          ▼
 ┌─────────────────┐       ┌───────────────────┐      ┌───────────────────┐
 │  Rule sources   │       │    Connectors     │      │  MCP servers and  │
 │ YAML, builtin,  │       │ Snyk  Sonar  Orca │      │  external agents  │
 │ knowledge units,│       │ SARIF  agent JSON │      │                   │
 │ MCP             │       └─────────┬─────────┘      └─────────┬─────────┘
 └────────┬────────┘                 │ normalized findings      │
          │ resolved rules           ▼                          │
          │              ┌──────────────────────────────────────┴──┐
          └─────────────►│              Evaluators                  │
                         │ deterministic: pattern, python.ast,      │
                         │   imports, secrets, files, tests, command│
                         │ tool-backed:   tool.findings             │
                         │ agentic:       ai.review, mcp.assess,    │
                         │                agent.findings            │
                         └──────────────────┬──────────────────────┘
                                            │ rule outcomes + findings (schema-validated)
                                            ▼
                         ┌──────────────────────────────────────────┐
                         │ Waivers → corroboration → scoring → gates │
                         └──────────────────┬───────────────────────┘
                                            ▼
                         ┌──────────────────────────────────────────┐
                         │ Assessment: grade, dimensions, findings,  │
                         │ explanation, provenance                   │
                         └──────┬─────────────┬──────────────┬──────┘
                                ▼             ▼              ▼
                            Markdown        JSON           SARIF      + run history
```

AI is an optional input, not a layer the rest depends on. With `ai.enabled:
false` (or `--no-ai`) the same pipeline runs and AI-evaluated rules are
reported as skipped, never as passed.

### Repository layout

```
src/
  core/         model.ts (finding, rule, severity, confidence), plugin.ts
                (interfaces + registry), workspace.ts, finding.ts (fingerprints)
  config/       schema.ts (every config option), loader.ts (extends, locks)
  rules/        schema.ts (RuleSet format), loader.ts (precedence),
                units.ts (knowledge units and MCP as rule sources)
  evaluators/   deterministic.ts, python.ts, secrets.ts, command.ts, tool.ts,
                ai-review.ts, mcp.ts
  connectors/   snyk.ts, sonar.ts, orca.ts, sarif.ts, agent.ts
  ai/           provider.ts (the one AI interface), router.ts (model routing),
                data-policy.ts, providers/ (anthropic, openai-compatible, replay)
  mcp/          client.ts (stdio MCP client pool)
  scoring/      engine.ts (dimensions, gates, corroboration, explanation),
                waivers.ts
  engine/       assess.ts (orchestration), bench.ts (model benchmarking)
  report/       markdown.ts, sarif.ts
  storage/      history.ts (run files and run comparison)
  context/      reviewer-style context for diffs (callers, tests, signals)
  plugins/      builtin.ts (built-ins registered like any plugin)
  cli.ts        the cqr command
rulesets/       builtin rulesets: python-zen, secure-baseline
scripts/        python_ast_metrics.py (stdlib-only AST metrics)
examples/       acme org standard, sample service, MCP server, plugin, CI
```

## Core abstractions

All of these are in `src/core/plugin.ts` and `src/core/model.ts`.

```ts
interface Evaluator {
  id: string;                              // what rules name in `evaluator:`
  evidenceType: 'deterministic' | 'tool' | 'agentic';
  validateParams?(params, rule): string[]; // run when rulesets load
  evaluate(rules: ResolvedRule[], ctx): Promise<RuleOutcome[]>;  // batched
}

interface Connector {
  type: string;                            // `type:` in connectors config
  collect(name, config, ctx): Promise<{ findings: Finding[]; tool; summary }>;
}

interface RuleSource {
  matches(sourceConfig): boolean;
  load(sourceConfig, ctx): Promise<RuleSetDocument[]>;
}

interface ProviderFactory {                // AI provider adapter
  type: string;
  create(name, providerConfig): AIProvider;
}

interface Plugin { name; version; evaluators?; connectors?; ruleSources?; providers? }
```

Evaluators receive every rule that names them, so they can batch: one Python
AST pass serves all Python rules, and one model call evaluates several related
rules. A `RuleOutcome` is `passed | failed | error | skipped | not_applicable`
plus findings. Only `passed` counts as a pass; an evaluator that errors or
can't run never makes a rule look healthy.

## Rule definition format

Rules live in versioned RuleSet documents:

```yaml
apiVersion: cqr/v1
kind: RuleSet
metadata:
  id: acme-engineering
  version: 1.4.2               # semver, recorded in every assessment
  owner: platform-engineering@acme.example
  source: organization         # organization | industry
  locked: true                 # repositories may tighten but not weaken these rules
defaults:                      # applied to every rule below
  enforcement: scored
  applies_to: { languages: [python], exclude: ["tests/**"] }
rules:
  - id: ACME-ARCH-001
    title: The domain layer has no framework or infrastructure dependencies
    rationale: Domain code is the part we test hardest and change least.
    category: architecture     # security, code-quality, architecture, maintainability,
                               # testing, reliability, performance, documentation,
                               # compliance, sdlc
    severity: high             # critical | high | medium | low | info
    enforcement: mandatory     # mandatory | scored | advisory | informational
    evaluator: imports.forbidden
    params:
      to: ["app/api/**", "app/infra/**"]
      modules: [flask, requests, sqlalchemy]
    applies_to: { paths: ["app/domain/**"] }
    remediation: Move I/O behind an interface in app/infra.
    examples: { good: [...], bad: [...] }   # used by agentic evaluators
    ai: { complexity: medium }  # a routing hint; never a model name
overrides:                      # adjust inherited rules, explicitly
  - id: PY-ZEN-004
    params: { max: 8 }
    severity: high
    reason: Complex functions are an incident risk for on-call services.
```

Enforcement levels give organizations four kinds of rule:

| Enforcement | Scored | Can trip a gate | Shown in report |
| --- | --- | --- | --- |
| mandatory | yes | yes (via gates that select `enforcement: [mandatory]`) | yes |
| scored | yes | only if a gate selects it by other attributes | yes |
| advisory | no | no | yes |
| informational | no | no | in JSON |

`cqr schema ruleset` prints the JSON Schema; `cqr rules validate` checks a
configuration's rules, evaluator names and params before anything runs.

### Rule sources

- `- path: rulesets/acme.yaml`: a RuleSet file.
- `- builtin: python-zen`: a ruleset shipped in `rulesets/`.
- `- type: context-units`: a directory of knowledge units in
  [context-engineering-sdlc](https://github.com/sidd105/context-engineering-sdlc)'s
  format (`id`, `level: must|should|may`, `kind`, `title`, `body`).
- `- type: mcp`: rules fetched live from an MCP server, for example
  context-engineering-sdlc's `get_context` tool with `format: json`.

Knowledge units become rules through a `mapping`. `level` maps to enforcement
(`must` → mandatory) and `kind` to category, and the organization chooses an
evaluator per unit. Units with no evaluator chosen go to `ai.review`:

```yaml
- type: context-units
  path: knowledge
  mapping:
    evaluators:
      baseline.sec.no-secrets-in-code: { evaluator: secrets.scan }   # now deterministic
      acme.code.timeouts-on-outbound-calls:
        evaluator: pattern
        params: { pattern: 'requests\.(?:get|post)\((?![^)]*timeout=)' }
```

This is how written-down organizational knowledge turns into checkable rules,
and how a rule can move from AI judgement to a deterministic check once
someone writes one, without changing its id or history.

## Rule engine and precedence

`src/rules/loader.ts` resolves rules in layers, lowest precedence first:

1. rulesets a ruleset `extends` (e.g. `builtin:python-zen`)
2. rulesets in the order the config lists them
3. each ruleset's own `overrides` of rules it inherited
4. the repository config's `rule_overrides`

Two rulesets defining the same rule id is a load error, not a silent
last-one-wins. Changing someone else's rule has to be an explicit override,
which then shows up in code review and in the report (`overridden_by`).

Later layers may raise the severity or enforcement of a rule from a `locked`
ruleset, but an attempt to disable it, lower its severity or enforcement, or
change its scope or params is ignored with a warning (scope and params can
loosen a rule as easily as tighten it). Only the ruleset's owner changes
those, by releasing a new version. Configuration has
the same mechanism: an organization config lists `locked` keys (e.g. `gates`,
`scoring`, `ai.data_policy`) that repository configs can't override.

Config files compose with `extends`. Arrays of rulesets, overrides and
plugins accumulate; everything else from a later file replaces the earlier
value. Paths are resolved relative to the file that declares them.

## Normalized finding schema

Every source produces the same shape (`cqr schema finding`):

```json
{
  "id": "1f0c9a2e4b7d8c31",
  "rule_id": "ACME-SEC-002",
  "rule_version": "1.4.2",
  "ruleset": "acme-engineering",
  "source": "organization",
  "evidence_type": "tool",
  "evaluator": "tool.findings",
  "tool": { "name": "snyk" },
  "category": "security",
  "severity": "critical",
  "confidence": 1,
  "status": "failed",
  "enforcement": "mandatory",
  "location": { "file": "requirements.txt", "package": "pyyaml@5.3" },
  "message": "Arbitrary Code Execution in pyyaml@5.3",
  "evidence": "Introduced through: payments-service@0.0.0 > pyyaml@5.3",
  "remediation": "Upgrade to pyyaml@5.3.1",
  "references": ["https://security.snyk.io/vuln/SNYK-PYTHON-PYYAML-559098"],
  "tags": ["dependency", "connector:snyk"],
  "cwe": ["CWE-20"],
  "cve": ["CVE-2020-1747"],
  "ai": null,
  "waived": null
}
```

Design choices worth calling out:

- **`source` and `evidence_type` are separate.** `source` says whose rule it
  is (organization, industry, tool, agent, mcp). `evidence_type` says how the
  evidence was produced: `deterministic` ("this rule definitely failed"),
  `tool` (a scanner's result), or `agentic` ("a model believes this rule
  failed"). An organization rule evaluated by Snyk is `source: organization,
  evidence_type: tool`.
- **Locations aren't only files.** Cloud findings (Orca) have an `asset`;
  dependency findings have a `package`.
- **The id is a fingerprint** of rule, file or asset, package and normalized
  message, not the line number, so a finding keeps its id when unrelated code
  moves. That is what makes waivers by `finding_id` and run-to-run comparison
  work.
- **AI findings carry provenance** (`ai`: provider, served model, profile,
  prompt version, prompt hash, tokens, latency).
- **Plugin output is validated** against this schema by the engine. A plugin
  that returns a malformed finding turns that rule into an `error`; it can't
  corrupt the rating.

## Severity and confidence model

Severity (`critical`, `high`, `medium`, `low`, `info`) is the impact if the
finding is real. Confidence (0–1) is the probability that it is real.

| Evidence | Confidence comes from |
| --- | --- |
| Deterministic evaluators | Always 1 |
| Tools | What the tool implies: a CVE match is 1, SARIF `precision` maps very-high/high/medium/low to 1/0.9/0.7/0.5, a Sonar security hotspot ("needs review") is 0.5 |
| Agentic | The model's own estimate, then adjusted: findings whose quoted code isn't in the file are multiplied by `ungrounded_penalty` (0.5) and tagged `ungrounded` |

Severity normalization from tools: CVSS 9+ critical, 7+ high, 4+ medium, >0
low. Sonar's BLOCKER/CRITICAL/MAJOR/MINOR/INFO and Sonar 10 "impacts" are
both handled. SARIF `level` error/warning/note maps to high/medium/low when no
`security-severity` is present.

Findings below `scoring.min_confidence` (0.5) are reported but not scored.

## Scoring and rating engine

The engine (`src/scoring/engine.ts`) works on one entry per evaluated rule:
org and industry rules, plus each tool's own rules for tool findings that no
org rule claimed (`unmapped_tool_findings: include`).

### Dimensions

Dimensions are configured, weighted groups. Each has a selector (sources,
categories, evidence types, rule ids, tools, tags) and a mode:

- **deduction**: start at 100, subtract points for each failed rule.
- **compliance**: severity-weighted share of evaluated rules that passed.

Rules are assigned to the first **exclusive** dimension whose selector matches,
in listed order, so order is precedence and nothing is counted twice. A
**shared** dimension is a view that scores every matching rule without
claiming it. The default config makes "Org Standards" a shared compliance
view across all organization rules, so it reports "92% of our rules pass"
while each rule is still scored once in its category.

Agentic evidence goes to its own exclusive "AI Assessment" dimension by
default. Its weight is therefore a hard bound on how far AI opinion can move
the overall score.

A dimension with no evaluated rules is reported as **not assessed** and left
out of the weighted average. It is never counted as 100. A repository with
no tests and no testing rules doesn't get a free A for testing.

### Points

For a failed rule in a deduction dimension:

```
points = severity_points[max severity of active findings]   (critical 40, high 15, medium 5, low 1)
       × agentic_weight (0.6) if the evidence is agentic
       × max confidence of the active findings
       × (1 + repeat_factor (0.25) × (number of findings − 1))
capped at per_rule_cap (45)
```

The repeat factor and cap keep one noisy rule from flattening a dimension
while still making 30 violations worse than 1.

### Corroboration

Independent sources often report the same problem. In the example, Sonar,
Semgrep and an org pattern rule all flag the SQL string on
`handlers.py:12`. In deduction mode the problem is charged once, to the
strongest finding; the others are recorded in `rating.corroborated` and shown
as "counted once, with another source". Only findings from *different*
evaluators or tools corroborate, and by default only for `security`
findings on the same line (`scoring.corroboration`). Compliance mode is per
rule, so an org rule that failed still fails there.

### Overall

```
overall = Σ weight(d) × score(d) / Σ weight(d)   over assessed dimensions
grade   = scale lookup (A+ ≥ 97, A ≥ 93, A- ≥ 90, B+ ≥ 87 … F < 60), configurable
```

### Weighting example

The weighting in the original brief maps directly onto dimensions:

```yaml
scoring:
  dimensions:
    - { id: organization, label: Org Standards, weight: 40, mode: compliance, shared: true,
        select: { sources: [organization], evidence_types: [deterministic, tool] } }
    - { id: security, label: Security, weight: 30, select: { categories: [security] } }
    - { id: code_quality, label: Code Quality, weight: 15, select: { categories: [code-quality, reliability] } }
    - { id: ai, label: AI Assessment, weight: 10, select: { evidence_types: [agentic] } }
    - { id: maintainability, label: Maintainability, weight: 5, select: {} }
```

(Put `ai` before `security` if AI-raised security findings should be bounded
by the AI weight rather than counted as security.)

## Hard gates

Gates express what is unacceptable regardless of the score:

```yaml
gates:
  allow_agentic: false          # an AI opinion alone can't fail a build
  rules:
    - id: no-secrets
      when: { tags: [secret], evidence_types: [deterministic, tool] }
      action: { fail: true }
    - id: critical-security-caps-at-C
      when: { categories: [security], severity_at_least: critical, evidence_types: [deterministic, tool] }
      action: { cap: C }
    - id: mandatory-org-rule-caps-at-B
      when: { sources: [organization], enforcement: [mandatory] }
      action: { cap: B }
    - id: architecture-warn
      when: { categories: [architecture] }
      action: { warn: true }
```

A gate's `when` uses the same selector as dimensions plus
`severity_at_least`, `enforcement`, `min_confidence` and `min_count`. Actions:
`cap` (the grade can't exceed this), `fail` (status FAIL, grade F, non-zero
exit), `warn` (status WARN). Waived findings never trip gates. Agentic findings
trip gates only when `allow_agentic: true`, a deliberate opt-in per
organization.

The explanation says exactly what a gate did: "capped the grade at C (the
score alone would give B+)", or "triggered, but the score is already at or
below that".

### Waivers

```yaml
waivers:
  - rule_id: ACME-LOG-001
    paths: ["app/api/handlers.py"]     # or finding_id: <fingerprint>
    reason: Temporary debug output while PAY-1432 is investigated.
    approver: jordan.lee@acme.example
    expires: "2027-03-31"
```

A waived finding stays in every report, marked as waived with its reason and
approver, but doesn't count toward score or gates. Expired waivers stop
applying and produce a warning. So do waivers that match nothing.

## Explainability

Every number is traceable:

- The headline explanation is generated only from computed values: "received
  F (40.3/100) because it passed 3 of 16 organization rules (19%), has 1
  critical security finding, has 4 high-or-worse sonar findings… and the AI
  assessment identified 6 issues".
- Each dimension lists its deductions: rule, points, and basis ("high, 2
  findings, tool (capped)").
- Each deduction lists the finding ids it came from; each finding has its
  evidence, location, source and, for AI, provenance.
- `cqr explain run.json --rule ACME-SEC-003` shows one rule's ruleset and
  version, evaluator, outcome, score cost, gates it triggered, overrides, and
  each finding, including whether it was corroborated or below threshold.
- Coverage is part of the result: rules that errored or were skipped are
  listed, and the explanation says they don't count as passes.

## Plugin architecture and extension

Built-in evaluators, connectors, rule sources and AI providers are registered
through the same `Plugin` interface third parties use (`src/plugins/builtin.ts`).
There is one extension path and no special cases in the core.

A plugin is an ES module with a default export:

```js
// examples/plugins/license-plugin.mjs
export default {
  name: 'acme-license-policy',
  version: '1.0.0',
  evaluators: [{
    id: 'licenses.allowed',
    evidenceType: 'deterministic',
    validateParams: (p) => (Array.isArray(p.allowed) ? [] : ['allowed must list SPDX ids']),
    async evaluate(rules, ctx) {
      return Promise.all(rules.map(async (rule) => {
        const report = JSON.parse(await ctx.workspace.read(rule.params.report));
        const findings = report
          .filter((p) => !rule.params.allowed.includes(p.License))
          .map((p) => ctx.sdk.ruleFinding(rule, 'licenses.allowed', 'deterministic', { message: `${p.Name} is ${p.License}` }));
        return ctx.sdk.outcome(rule, 'deterministic', findings);
      }));
    },
  }],
};
```

and is enabled with `plugins: ["./plugins/license-plugin.mjs"]` (or an npm
package name). Plugins get everything through the context (`workspace`,
`toolFindings`, `ai` router, `mcp`, `sdk` helpers), so they need no imports
from this package. Duplicate ids are rejected at registration.

Adding a future tool means one of:

| You have | Write |
| --- | --- |
| A tool that emits SARIF | Nothing: `type: sarif` |
| A tool with its own JSON/API | A `Connector` that maps to `Finding` |
| A new kind of check | An `Evaluator` |
| A rule store (wiki, Backstage, OPA bundle) | A `RuleSource` |
| A model API without an OpenAI-compatible endpoint | A `ProviderFactory` |

## Connectors

All connectors read a saved report (`report: path`), which is how they're
used in CI after the tool's own step, or run the tool (`run: [argv]`) when
`execution.allow_commands` is on. API-backed ones can also call the vendor
API. Every connector tags its findings `connector:<name>`.

### Snyk (`src/connectors/snyk.ts`)

Reads `snyk test --json` (open source), `snyk container test --json`, `snyk
iac test --json`, and `snyk code test --sarif`, detecting which it got. A
vulnerability reachable through several dependency paths becomes one finding
per (vulnerability, package version), with the paths as evidence and the
upgrade path or fixed versions as remediation. CVE and CWE identifiers are
kept.

### SonarQube / SonarCloud (`src/connectors/sonar.ts`)

Reads `api/issues/search` (paginated, up to Sonar's 10,000 limit) and
optionally `api/hotspots/search`, or a saved copy of those responses. Uses
Sonar 10 "impacts" (software quality + severity) when present, legacy
severity and type otherwise. VULNERABILITY → security, BUG → reliability,
CODE_SMELL → maintainability. Closed, resolved, fixed, accepted and
false-positive issues are dropped. Hotspots are security findings with
confidence 0.5, since a hotspot means "a human should review this".

```yaml
sonar: { type: sonar, url: https://sonarcloud.io, project_key: acme_payments,
         token_env: SONAR_TOKEN, pull_request: "123", include_hotspots: true }
```

### Orca Security (`src/connectors/orca.ts`)

Orca reports on cloud assets, not files, so its findings carry an `asset`
location, and `match_assets` scopes alerts to the assets this repository
deploys. Without that, every tenant-wide alert would land on every
repository. Only open alerts count. Field names vary between Orca API
versions and exports, so the mapping reads common variants and accepts a
`field_map` override. **Verify the endpoint and fields against your tenant**
before relying on the API mode; the report mode works with any JSON export.

### SARIF (`src/connectors/sarif.ts`)

One reader covers Semgrep, CodeQL, Snyk Code, Checkov, Trivy, Gitleaks and
anything else that emits SARIF 2.1.0: `security-severity` → severity,
`precision` → confidence, CWE tags kept, results the tool marks suppressed
respected, secret-like rules tagged `secret`.

### Tool findings and org rules

Tool findings reach the score two ways:

1. **Claimed by an org rule** through the `tool.findings` evaluator:

   ```yaml
   - id: ACME-SEC-002
     title: No high or critical vulnerabilities in dependencies
     severity: high
     enforcement: mandatory
     evaluator: tool.findings
     params: { tools: [snyk], severity_at_least: high }
   ```

   The rule stays the organization's (id, enforcement, gates), and the tool
   supplies the evidence. If the connector didn't run, the rule is `skipped`;
   if it failed, `error`. Neither ever counts as passed.

2. **Unmapped**: findings no rule claims are scored under the tool's own rule
   id (`snyk:SNYK-…`, `sonar:python:S3776`), or ignored with
   `unmapped_tool_findings: ignore`.

## Agent and MCP integration

Three ways AI agents feed in, all producing agentic evidence by default:

1. **`ai.review`**: the framework calls a configured model itself (next
   section).
2. **`mcp.assess`**: delegate rules to an MCP server tool. The server
   receives the rules (id, title, description, rationale, category, severity,
   scope), the file list, the repository root and diff scope, and must return
   an **AgentAssessment** (`cqr schema agent-assessment`):

   ```json
   {
     "agent": { "name": "arch-reviewer", "version": "0.1.0", "model": "…" },
     "rule_results": [
       { "rule_id": "ACME-AGENT-ARCH-001", "status": "failed", "confidence": 0.8,
         "findings": [{ "file": "app/services/notifier.py", "line": 11,
                        "message": "…", "evidence": "…", "remediation": "…" }] },
       { "rule_id": "ACME-AGENT-ARCH-002", "status": "passed", "confidence": 0.9 }
     ]
   }
   ```

   This answers the brief's questions directly: which rules it evaluated
   (every `rule_results` entry, including passes), which passed or failed,
   the evidence, severity, confidence and affected files and lines.
   `examples/mcp-arch-reviewer/server.mjs` is a working server.
3. **`agent-report` connector + `agent.findings` evaluator**: an agent that
   runs elsewhere (a PR bot, a nightly job) writes an AgentAssessment file;
   org rules opt in to its results with `evaluator: agent.findings, params:
   { connector: review-agent }`. A rule the agent didn't report on is
   `skipped`.

MCP is also a **rule source** (above), so the same MCP server that gives an
agent context can give this framework its rules.

**Trust is configured, not claimed.** Each MCP server and agent report has a
`trust` level in the organization's config (default `agentic`). A server
cannot promote its own findings to deterministic. MCP servers start with only
`PATH` and the variables their config names in their environment, not
everything in the CI job.

## AI: providers, models and routing

### Provider abstraction

`src/ai/provider.ts` is the only AI interface the framework uses:

```ts
interface AIProvider {
  name: string; type: string;
  hosting: 'vendor' | 'cloud-tenant' | 'self-hosted' | 'local';
  complete(model: string, request: AIRequest): Promise<AIResponse>;
}
// AIRequest: system, prompt, JSON schema, max tokens, temperature?, options, structuredOutput
// AIResponse: parsed output, served model id, request id, usage, stop reason, latency
```

Adapters shipped:

| Type | Covers |
| --- | --- |
| `anthropic` | Claude models via the official SDK, native JSON-schema output; uses server-side fallbacks on models that support them |
| `openai-compatible` | OpenAI, Azure OpenAI (custom auth header and query), vLLM, Ollama, LM Studio, LiteLLM and other gateways |
| `replay` | Recorded responses, for tests, offline demos and reproducing a past run |

**Planned:** native Google (Gemini/Vertex) and AWS Bedrock adapters. Both are
reachable today through an OpenAI-compatible gateway, and adding one is a
`ProviderFactory` plugin.

### Model profiles and capabilities

```yaml
ai:
  enabled: true
  providers:
    anthropic: { type: anthropic, api_key_env: ANTHROPIC_API_KEY, hosting: vendor }
    local:     { type: openai-compatible, base_url: "http://localhost:11434/v1", hosting: local }
  models:
    reasoning:
      provider: anthropic
      model: claude-opus-5-5
      capabilities: { structured_output: true, tool_calling: true, reasoning: true, long_context: true }
      context_tokens: 1000000
      options: { effort: high }
      cost_per_mtok: { input: 4, output: 20 }
    fast:
      provider: local
      model: qwen2.5-coder:14b
      capabilities: { structured_output: true }
      context_tokens: 32000
      temperature: 0
```

Credentials are only read from environment variables named in config. A
profile without `structured_output` still works: the adapter asks for JSON in
the prompt and the response is validated either way.

### Routing

Rules never name a model. A rule may give a hint (`ai: { complexity: high }`),
and configuration maps hints, categories, evaluators and environments to
profiles. Resolution, most specific first:

1. `routing.environments.<env>.evaluators.<evaluator>`
2. `routing.tiers.<rule complexity>`
3. `routing.categories.<rule category>`
4. `routing.evaluators.<evaluator>`
5. `routing.environments.<env>.default`
6. `routing.default`
7. `routing.fallback`, in order

Global, organization and repository levels come from config `extends`; the
environment comes from `--env` or `CQR_ENV`. Each candidate must have the
capabilities the evaluator needs, a context window that fits the prompt, and
pass the data policy for the files being sent. The first that qualifies is
used and later ones become runtime fallbacks if it errors. Candidates passed
over, and why, go to the audit log.

So "cheap model for simple rules, strongest model for architecture,
self-hosted model for restricted code" is configuration:

```yaml
routing:
  default: reasoning
  tiers: { low: fast }
  categories: { security: reasoning }
  fallback: [fast]
  environments:
    ci: { default: fast }
```

### Data policy

```yaml
ai:
  data_policy:
    send_source_code: true
    exclude_paths: ["**/.env", "**/*.pem", "**/secrets/**"]   # never sent to any model
    redact_secrets: true          # same detectors as secrets.scan
    redact_pii: true              # emails, card numbers (Luhn-checked), SSNs, phone numbers
    allowed_providers: [anthropic, local]
    allowed_models: [claude-opus-5-5, fast]
    classifications:
      - { name: restricted, paths: ["app/infra/**", "src/crypto/**"], allowed_hosting: [self-hosted, local] }
    log_prompts: false
```

Every byte sent to a model passes through `DataPolicyGate`: excluded paths
are dropped, secrets and PII are redacted, and a model whose hosting isn't
allowed for a file's classification isn't routed to. Organizations lock
`ai.data_policy` and `ai.providers` so repositories can't loosen them.
**Planned:** retention settings passed through to providers that support them.

### The `ai.review` evaluator

`src/evaluators/ai-review.ts`:

- Batches rules by category and complexity tier (`max_rules_per_call`) so
  related rules share a call and a model.
- Selects files in each rule's scope (changed files first in diff mode),
  applies the data policy, and fits them into `budget_tokens`. Files left out
  are named in the prompt so the model doesn't guess about them.
- In diff mode, adds reviewer-style context from `src/context/`: callers of
  changed symbols, existing tests, and mechanical signals such as "a renamed
  function is still referenced".
- Asks for a structured verdict per rule (`passed`, `failed`,
  `not_applicable`), with file, line, an exact quote, explanation,
  remediation and confidence for each failure.
- **Grounds** every finding. The file must have been sent and in the rule's
  scope; the quote must appear on or near the cited line (moved if it's
  elsewhere, confidence penalized and tagged `ungrounded` if it's nowhere).
  A "failed" with no locatable evidence becomes `skipped`, not a failure. A
  rule the model didn't answer is `skipped`. Unknown rule ids are dropped.
- Marks repository content as untrusted data in the system prompt, as a
  defence against prompt injection from code comments.

### Reproducibility and audit

Each AI finding records provider, served model id, profile, prompt version
(`ai-review/1.0`), temperature if set, request id, prompt SHA-256, tokens and
latency. Each assessment records tool version, config file paths and hash,
ruleset ids and versions, plugin versions, connector results and AI totals.
The audit log (`ai.audit_log`, JSONL) has one line per model call: evaluator,
rules, files, redaction counts, rejected candidates, errors, and the prompt
only if `log_prompts` is on.

`cqr compare old.json new.json` separates "the code changed" from "the
rules, config or model changed": new and resolved findings, dimension deltas,
and whether ruleset versions, config hash or models differ between runs.

### Benchmarking evaluators

`cqr bench dataset.yaml` runs the assessment several times per model profile
and scores AI findings against labelled expectations:

```yaml
repository: ../sample-service
config: ../sample-service/cqr.config.yaml
profiles: [reasoning, fast]
runs: 3
expected:
  - { rule_id: ACME-API-001, file: app/api/handlers.py, line: 23 }
  - { rule_id: PY-ZEN-011, status: passed }    # any finding here is a false positive
```

It reports precision, recall, F1, consistency (mean pairwise Jaccard
similarity of finding sets across runs), false positives and negatives,
tokens, estimated cost and latency per profile. The example compares two
recorded "models":

| Profile | Precision | Recall | F1 | Consistency | FP | FN |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| recorded (claude-opus-5-5 responses) | 0.75 | 1 | 0.857 | 1 | 2 | 0 |
| recorded-alt (smaller model responses) | 0.5 | 0.667 | 0.571 | 1 | 4 | 2 |

The point is to choose evaluator models on the organization's own rules and
labelled examples, not on general benchmarks.

## Configuration format

One file, `cqr.config.yaml`, validated by `ConfigSchema` (`cqr schema config`):

```yaml
version: 1
organization: acme
repository: payments-service
extends: [../acme/cqr.config.yaml]      # org config; or pass --org-config in CI
locked: [gates, scoring, ai.data_policy] # (in the org config)
exclude: ["node_modules/**", "dist/**"]
rulesets: [...]                          # sources, see above
rule_overrides: [...]                    # repository-level adjustments
connectors: { snyk: {...}, sonar: {...}, orca: {...}, semgrep: {...} }
unmapped_tool_findings: include
evaluators:                              # per-evaluator settings
  ai.review: { budget_tokens: 40000, max_rules_per_call: 8, ungrounded_penalty: 0.5 }
  python.ast: { python: python3 }
scoring: { dimensions: [...], severity_points: {...}, agentic_weight: 0.6, min_confidence: 0.5,
           repeat_factor: 0.25, per_rule_cap: 45, corroboration: {...}, grades: [...] }
gates: { allow_agentic: false, rules: [...] }
waivers: waivers.yaml
ai: { enabled, providers, models, routing, data_policy, audit_log }
mcp_servers: { arch-reviewer: { command, args, env, cwd, trust } }
execution: { allow_commands: false, timeout_seconds: 600, concurrency: 4 }
storage: { dir: .cqr/runs, keep: 100 }
plugins: ["./plugins/license-plugin.mjs"]
```

## CLI and API

```
cqr assess   [--repo .] [--config file] [--org-config file] [--base ref --head ref]
             [--env name] [--no-ai] [--format md,json,sarif] [--out-dir dir] [--save]
             [--fail-on fail|warn|never] [--min-grade B]
cqr rules    list|validate
cqr explain  <run.json> [--rule ID]
cqr compare  <old.json> <new.json> | --last
cqr bench    <dataset.yaml>
cqr schema   finding|agent-assessment|ruleset|config
cqr init
```

Exit codes: 0 ok, 1 a gate or threshold failed, 2 usage or configuration
error. `--base/--head` switches to diff scope: file-level rules look at changed
files only, and AI evaluation gets reviewer context for the change.

Library API (`src/index.ts`): `assess(options)`, `runBenchmark`,
`loadConfig`, `rate`, the schemas, `Registry`, `builtinRegistry`, report
renderers and plugin helpers.

**Planned:** an HTTP service mode (`POST /assessments`, `GET
/assessments/:id`, webhooks for GitHub/GitLab) wrapping the same `assess()`
call, for organizations that want a central rating service instead of CI
jobs.

## Storage

Assessments are self-contained JSON documents. `--save` writes them to
`storage.dir` (default `.cqr/runs`, oldest pruned past `storage.keep`), which
is enough for trends and run comparison in one repository. For organization
dashboards, ship the JSON files to object storage or a warehouse; the
document has stable ids (assessment, finding fingerprints, rule ids and
versions) for joining. **Planned:** a Postgres schema (`assessments`,
`rule_outcomes`, `findings`, `waivers`) for the service mode.

## Reports

- **Markdown**: headline grade, explanation, dimension table with top
  deductions, gates, per-dimension scoring detail, findings with evidence type
  and whether each was scored, waivers, remediation list, coverage and
  provenance. Suited to PR comments and CI summaries.
- **JSON**: the full assessment, for machines, history and dashboards.
- **SARIF 2.1.0**: findings with file locations, for GitHub code scanning and
  IDE viewers; waivers become SARIF suppressions, and AI findings say so and
  give their confidence in the message.

**Planned:** an HTML report and JUnit output.

## CI/CD integration

`examples/ci/github-actions.yml` shows the full setup for a rated repository:

1. Check out the repository with history (for diff mode) and the
   organization's standard repository.
2. Run the tools (Semgrep, Snyk…) to produce reports.
3. `cqr assess --org-config .org-standard/cqr.config.yaml --format
   md,json,sarif --out-dir cqr-out --save`, with `--base` on pull requests.
4. Upload SARIF to code scanning, write the Markdown to the job summary and a
   PR comment, archive the JSON.
5. Fail the job when a gate fails (`--fail-on fail`) or below a minimum grade
   (`--min-grade B`).

This repository's own CI (`.github/workflows/ci.yml`) runs the tests and the
offline example.

## Security considerations

| Risk | Mitigation |
| --- | --- |
| A pull request edits its own config to weaken gates or drop rules | `--org-config` from a protected repository is always the base layer; `locked` keys and `locked` rulesets can't be weakened; attempts produce warnings in the report |
| Config-driven command execution (`command` evaluator, `run:` connectors) runs code from the repository being assessed | Off by default (`execution.allow_commands: false`). Enable it only in the organization config. Commands run without a shell, with a timeout |
| Source code or secrets leaking to AI vendors | Data policy: excluded paths, secret and PII redaction before any request, provider/model allow-lists, hosting requirements per classification; all lockable |
| Prompt injection via code comments | Repository content is marked untrusted in the system prompt; outputs are schema-validated; findings must quote real code; agentic findings can't trip gates by default and their weight is bounded |
| A hallucinated or manipulated AI result moving the rating | Grounding checks, confidence threshold, agentic weight, separate AI dimension, `allow_agentic: false` |
| A compromised MCP server or agent claiming certainty | Trust level set by the organization, not the server; servers get a minimal environment |
| Secrets in reports | `secrets.scan` evidence shows only a masked prefix; prompts aren't logged unless `log_prompts` is on |
| Credential exfiltration through connector URLs | Tokens come only from env vars; lock `connectors` in the org config if repositories shouldn't choose endpoints |
| A buggy or malicious plugin corrupting results | Plugin outputs are schema-validated; errors are isolated per rule; duplicate ids are rejected. Plugins still run in-process, so only install trusted ones |
| Silent gaps (a tool didn't run) read as a pass | Connector failures, skipped and errored rules are reported as such and never count as passes |

## Testing strategy

`npm test` runs about 80 tests:

- **Unit**: diff parsing, symbol and import extraction, globbing, token
  packing, severity and connector normalization (against real report
  fixtures), grounding, redaction.
- **Scoring**: every rule of the scoring model (points, repeats, caps,
  agentic weight, thresholds, shared vs exclusive dimensions, unassessed
  dimensions, compliance), gates (cap, fail, warn, agentic opt-in, waivers)
  and corroboration.
- **Rules and config**: layer precedence, overrides, locks, duplicate ids,
  param validation, knowledge units and MCP as rule sources, config
  inheritance, `--org-config`, path resolution.
- **AI**: routing order, capability and context checks, data classification,
  runtime fallback and provenance, and the `ai.review` evaluator with a
  scripted provider (redaction actually applied to the prompt, unknown rule
  ids dropped, evidence-free failures demoted, invalid output).
- **Evaluators**: each deterministic evaluator against a temporary git repo,
  including the Python AST checks (skipped if no python3).
- **Plugins**: malformed plugin output becomes a rule error.
- **End to end**: the whole Acme example (five connectors, a live MCP server
  over stdio, recorded AI, a plugin, waivers, locks), with and without AI,
  plus run comparison and report rendering.

For organizations adopting the framework: keep a labelled benchmark dataset
per ruleset (`cqr bench`), and re-run it when changing models, prompts or
rule wording, the same way you'd run tests on code.

## End-to-end example

```bash
npm install
npm run example         # cqr assess --repo examples/sample-service --env demo
```

What happens:

1. `examples/sample-service/cqr.config.yaml` extends Acme's org config
   (`examples/acme/cqr.config.yaml`). Its attempt to switch off the locked
   `ACME-MONEY-001` and to change locked `scoring` is ignored, with warnings.
2. Rules load from six rulesets: `secure-baseline`, `python-zen`,
   `acme-engineering@1.4.2` (which tightens two Zen rules),
   `acme-agent-architecture`, Acme's knowledge units (two routed to
   deterministic evaluators, one to AI), and the repository's own
   `payments-service` ruleset, which uses the license plugin.
3. Connectors read Snyk (3 vulnerabilities after de-duplicating dependency
   paths), Sonar (4 open issues and 1 hotspot; the fixed issue is dropped),
   Orca (1 of 3 alerts in scope), Semgrep SARIF, and an external agent's
   report.
4. Evaluators run. The AST script finds the mutable default, the silent
   `except`, complexity 12 against Acme's limit of 8. `imports.forbidden`
   catches the handler importing `sqlite3`. `tool.findings` turns Snyk's
   critical PyYAML CVE into a failure of Acme's mandatory `ACME-SEC-002`. The
   MCP server flags direct HTTP calls from a service. `ai.review` (recorded
   responses in demo mode) flags raw exceptions returned to clients and a
   non-idempotent payment endpoint, and one of its findings quotes code that
   doesn't exist, so it's kept at confidence 0.35 and not scored.
   `app/infra/**` is classified restricted, so only a local model may see it.
5. Waivers apply (`ACME-LOG-001` until 2027-03-31; an expired waiver is
   reported). Corroboration charges the SQL injection that Sonar, Semgrep
   and `SEC-SQL-001` all found once.
6. The rating:

```
Overall: F (40.3/100)  WARN

The repository received F (40.3/100) because it passed 3 of 16 organization
rules (19%), has 1 critical security finding, has 2 high-or-worse snyk
findings, has 4 high-or-worse sonar findings, has 1 high-or-worse orca
finding, has 1 high-or-worse Semgrep OSS finding and the AI assessment
identified 6 issues (1 sdlc, 1 maintainability, 3 architecture and 1
reliability).
Gate "critical-security-caps-at-C" triggered (caps at C), but the score is
already at or below that.
Gate "mandatory-org-rule-caps-at-B" triggered (caps at B), but the score is
already at or below that.
3 finding(s) reported the same problem as a stronger finding from another
source and were counted once.

| Dimension       | Grade | Score | Weight |
| AI Assessment   | B+    | 89.3  | 10     |
| Security        | F     | 12.5  | 30     |
| Architecture    | B     | 85    | 10     |
| Testing         | B-    | 81.3  | 10     |
| Maintainability | D     | 62.8  | 5      |
| Code Quality    | F     | 10    | 15     |
| Org Standards   | F     | 31.6  | 20     |
```

The sample service is deliberately bad; every problem in it exists to
exercise a rule. `npm run example:no-ai` produces a rating from the same
pipeline with AI off, and `npm run example:bench` runs the model benchmark.

## Known limitations and next steps

- Language depth: the AST evaluator is Python-only. JS/TS rely on patterns,
  imports and external linters through `command`/SARIF. Tree-sitter-based
  evaluators would add structural rules for more languages.
- `tests.required` uses naming conventions, not coverage. A coverage
  connector (Cobertura/LCOV) is the natural next connector.
- Native Google and Bedrock provider adapters, HTML/JUnit reports, the
  service mode and a Postgres store are planned, as noted above.
- Orca's API mode needs checking against a real tenant.
- Scoring constants (severity points, weights, caps) are sensible defaults,
  not calibrated. Organizations should tune them against repositories whose
  quality they already agree on.
