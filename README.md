# context-aware-pr-reviewer

Assess code against your organization's definition of good software. Rules
come from versioned policies; deterministic checks, scanners and optional AI
provide evidence. The result is an explainable grade with findings and gates.

The reviewer runs independently. It does not plan deliveries, approve releases
or deploy software, and it does not require the context engine or Relay.

## Quick start

Requires **Node 20+** and **Python 3** for Python AST checks. From a clone:

```bash
npm ci
npm run example          # fictional payments service; recorded AI, no key needed
npm run example:no-ai    # deterministic checks and tool evidence
```

The intentionally flawed example produces a low grade with traceable
security, architecture, testing and maintainability findings. Real AI use is
optional and requires provider configuration.

## Review your repository

```bash
npx --no-install tsx src/cli.ts init --repo ../my-service
npx --no-install tsx src/cli.ts assess --repo ../my-service
npx --no-install tsx src/cli.ts assess --repo ../my-service --base main --head HEAD --format json
```

Customize the generated `cqr.config.yaml` and rulesets. Use a protected
`--org-config /absolute/org.yaml` for organization policy that a PR cannot
weaken. Outputs include Markdown, JSON and SARIF.

**Assessments read working-tree files.** For a commit-bound CI result, use a
clean checkout of that exact commit. `--base` and `--head` choose the diff;
they do not materialize the requested revision's file contents.

## Rules, evidence and results

| Component | Purpose |
| --- | --- |
| Rulesets | Define your standard, severity and enforcement |
| Evaluators | Check source, AST, imports, tests, commands, tool findings or AI reports |
| Connectors | Normalize Snyk, Sonar, Orca, SARIF and external agent evidence |
| Scoring and gates | Produce grades, deductions, warnings and blocking verdicts |
| Reports | Explain findings and compare assessments |

AI findings remain distinguishable from deterministic evidence. Skipped or
failed evaluations are reported as coverage gaps, not passing checks. Built-in
rulesets include `python-zen` and `secure-baseline`; `examples/acme` provides a
fictional organization's full configuration.

Use `cqr explain`, `compare`, `rules`, `schema` and `bench` through the same
source CLI. See [the usage guide](docs/guide.md) for commands, a ruleset example
and the evaluator catalogue; [the design reference](docs/DESIGN.md) explains
scoring, policy locks, AI routing and data handling.

## Optional integrations

- [context-engineering-sdlc](https://github.com/sidd105/context-engineering-sdlc)
  supplies organizational knowledge. Its YAML format and MCP tools can be
  configured as rule sources; the engine remains independent.
- [Relay](https://github.com/sidd105/agentic-feature-delivery-workflow)
  orchestrates delivery. It invokes `cqr assess`, validates the Assessment JSON
  and uses the verdict to gate progression. Relay's built-in bridge reviews a
  temporary checkout of the delivery commit.
- `examples/ci/github-actions.yml` demonstrates PR assessment, report upload
  and gate-based CI failure. Adapt its permissions and tools before use.

## Development

```bash
npm run check
npm run example:bench
```

`src/` contains configuration, rules, evaluators, connectors, AI, scoring and
reporting. `rulesets/` contains built-ins; `examples/` contains sample policies,
plugins and CI. The detailed guide preserves the longer walkthrough.
