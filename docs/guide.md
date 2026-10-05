# context-aware-pr-reviewer

Most AI code review tools give you their opinion of your code. Your
organization already has its own opinion: a style guide, architecture
decisions, a secure coding standard, a testing policy. It also already runs
Snyk, Sonar and a pile of linters, each with its own dashboard and its own
idea of severity.

This project rates a repository against the organization's definition of good
software and uses everything else as evidence. Rules come first. Deterministic
checks, security tools, AI models and MCP servers provide evidence for or
against each rule, and a rating engine turns that evidence into one grade you
can trace back to the findings behind it.

```
Overall rating = organization rules
               + deterministic scanning
               + security and quality tools (Snyk, Sonar, Orca, SARIF)
               + AI and MCP assessments
```

The principle behind it: **the AI doesn't define what good means. The
organization does, and the AI and the scanners provide evidence.**

## What a result looks like

```
Overall: F (40.3/100)  WARN

The repository received F (40.3/100) because it passed 3 of 16 organization
rules (19%), has 1 critical security finding, has 4 high-or-worse sonar
findings, … and the AI assessment identified 6 issues (1 sdlc,
1 maintainability, 3 architecture and 1 reliability).
Gate "critical-security-caps-at-C" triggered (caps at C), but the score is
already at or below that.
3 finding(s) reported the same problem as a stronger finding from another
source and were counted once.

| Dimension       | Grade | Score | Top deduction                                       |
| AI Assessment   | B+    | 89.3  | ACME-AGENT-ARCH-001 −3 (medium, agentic ×0.6, 0.80) |
| Security        | F     | 12.5  | ACME-SEC-002 −45 (critical, 2 findings, tool)       |
| Architecture    | B     | 85    | ACME-ARCH-002 −15 (high, deterministic)             |
| Testing         | B-    | 81.3  | ACME-TEST-001 −18.75 (high, 2 findings)             |
| Org Standards   | F     | 31.6  | weighted pass rate over Acme's rules                |
```

That's the bundled example: a deliberately bad payments service rated
against a fictional company's standard. Every grade links to deductions, every
deduction to findings, and every finding to its rule, evidence, source and
location.

## How it's put together

| Concept | Question | Implemented as |
| --- | --- | --- |
| Rules | What does good mean? | Versioned YAML rulesets, plus knowledge units and MCP servers as rule sources |
| Evaluators | How do we check a rule? | Deterministic (AST, patterns, imports, secrets, files, tests, linters), tool-backed, agentic (AI, MCP, agent reports) |
| Findings | What evidence was found? | One normalized schema for every source |
| Scoring | How much does it matter? | Weighted dimensions, severity × confidence, repeats capped, corroboration |
| Gates | What's unacceptable regardless? | Caps, fails and warnings, waivers with expiry |
| Reports | Why this grade? | Markdown, JSON, SARIF, `cqr explain`, run comparison |

A few properties that make the rating trustworthy:

- **Deterministic and agentic evidence stay separate.** Every finding says
  whether it's `deterministic`, `tool` or `agentic`. AI findings count for
  less, sit in their own dimension (so its weight bounds AI influence), must
  quote real code, and can't fail a build unless the organization allows it.
- **Rules never name a model.** Models are chosen by configuration: per
  environment, rule complexity, category, evaluator, with fallbacks, checked
  against required capabilities and the data policy. Any provider works:
  Anthropic and OpenAI-compatible endpoints (OpenAI, Azure, Ollama, vLLM…)
  are built in, others are a plugin.
- **The core doesn't need AI.** With AI off, the same pipeline rates the
  repository from rules, scanners and tools, and AI-evaluated rules show as
  skipped, never as passed.
- **Gaps aren't passes.** A tool that didn't run, a rule that errored, or a
  dimension with no rules is reported as such and left out of the score.
- **Organizations can lock their standard.** Locked rulesets and config keys
  can be tightened by repositories but not weakened, and CI can pass the org
  config from a protected repository with `--org-config`.
- **Code sent to models is controlled.** Excluded paths, secret and PII
  redaction, provider and model allow-lists, and per-path classifications
  that require self-hosted models.

The full design, covering every abstraction, the rule format, the scoring
maths, connectors, the MCP integration model, AI routing, security and
testing, is in **[docs/DESIGN.md](DESIGN.md)**.

## Run it

Node 20+ and Python 3 (for the Python AST checks).

```bash
npm install
npm run example          # rate the sample service; AI uses recorded responses, no key needed
npm run example:no-ai    # the same with AI switched off
npm run example:bench    # compare two recorded "models" on Acme's labelled examples
npm test
```

On your own repository:

```bash
npx tsx src/cli.ts init --repo ../my-service      # writes a starter cqr.config.yaml
npx tsx src/cli.ts assess --repo ../my-service
npx tsx src/cli.ts assess --repo ../my-service --base main --head HEAD   # just the change
```

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

## Defining your standard

A rule says what good means and which evaluator checks it:

```yaml
apiVersion: cqr/v1
kind: RuleSet
metadata: { id: acme-engineering, version: 1.4.2, source: organization, locked: true }
rules:
  - id: ACME-ARCH-002
    title: API handlers don't talk to the database directly
    category: architecture
    severity: high
    enforcement: mandatory          # mandatory | scored | advisory | informational
    evaluator: imports.forbidden
    applies_to: { paths: ["app/api/**"] }
    params: { modules: [sqlite3, psycopg2, sqlalchemy] }

  - id: ACME-SEC-002
    title: No high or critical vulnerabilities in dependencies
    category: security
    severity: high
    enforcement: mandatory
    evaluator: tool.findings        # Acme's rule, Snyk's evidence
    params: { tools: [snyk], severity_at_least: high }

  - id: ACME-API-001
    title: API errors are structured problem responses
    category: architecture
    severity: medium
    evaluator: ai.review            # judgement call; the model is chosen by config
    ai: { complexity: medium }
```

Built-in rulesets: `python-zen` (PEP 20 and PEP 8 basics) and
`secure-baseline`. The `examples/acme` directory has a complete organization
setup: rulesets, org config with locks, gates and AI routing, knowledge units,
waivers, recorded AI responses and a benchmark dataset.

## Evaluators and connectors

| Evaluator | Evidence | Checks |
| --- | --- | --- |
| `python.ast` | deterministic | complexity, function length, nesting, params, bare/silent except, mutable defaults, wildcard imports, docstrings, globals, syntax |
| `pattern` | deterministic | forbid or require a regex |
| `imports.forbidden` | deterministic | architecture boundaries (JS/TS and Python) |
| `secrets.scan` | deterministic | committed credentials and keys |
| `files.required` / `files.forbidden` | deterministic | repository structure |
| `tests.required` | deterministic | source files without tests |
| `metrics.file_length` / `metrics.line_length` | deterministic | size limits |
| `command` | deterministic | run ruff, ESLint or any SARIF tool as a rule's evaluator |
| `tool.findings` | tool | an org rule evaluated from Snyk, Sonar, Orca or SARIF findings |
| `ai.review` | agentic | rules evaluated by a configured model, findings grounded against the source |
| `mcp.assess` | agentic | rules delegated to an MCP server |
| `agent.findings` | agentic | an org rule evaluated from an external agent's report |

Connectors: `snyk` (open source, container, IaC, code), `sonar` (issues and
hotspots, API or file), `orca` (cloud alerts scoped to the repository's
assets), `sarif` (Semgrep, CodeQL, Checkov, Trivy, Gitleaks…), and
`agent-report`.

Rule sources: YAML files, builtins, knowledge-unit directories in
[context-engineering-sdlc](https://github.com/sidd105/context-engineering-sdlc)
format, and MCP servers (e.g. context-engineering-sdlc's `get_context`).

Anything else is a plugin. `examples/plugins/license-plugin.mjs` adds a
license compliance evaluator in about 40 lines.

## CI

`examples/ci/github-actions.yml` runs the tools, rates the repository (diff
scope on pull requests), uploads SARIF to code scanning, posts the Markdown
report on the PR, archives the JSON, and fails the job when a gate fails.

## Layout

```
src/core/         finding, rule and plugin model; workspace
src/config/       config schema, inheritance and locks
src/rules/        ruleset format, precedence, knowledge units and MCP sources
src/evaluators/   deterministic, tool-backed and agentic evaluators
src/connectors/   Snyk, Sonar, Orca, SARIF, agent reports
src/ai/           provider interface, adapters, routing, data policy
src/scoring/      dimensions, gates, corroboration, explanation, waivers
src/engine/       assessment orchestration, model benchmark
src/report/       Markdown, SARIF
src/context/      reviewer-style context for diffs (callers, tests, signals)
rulesets/         builtin rulesets
examples/         acme org, sample service, MCP server, plugin, CI workflow
docs/DESIGN.md    the full design
```

This started as a context-aware PR reviewer. That work lives on in
`src/context/`, which gives the AI evaluator the code that calls a change,
the tests that cover it and the mechanical signals a reviewer would notice.
