// An example third-party plugin: license compliance.
//
// A plugin is an ES module whose default export lists evaluators, connectors,
// rule sources and/or AI providers. It needs no imports from cqr: everything
// it may use arrives on the context (`ctx.workspace`, `ctx.sdk`, ...), and
// whatever it returns is validated against the finding schema.
//
// Enable it in cqr.config.yaml:   plugins: ["./plugins/license-plugin.mjs"]

export default {
  name: 'acme-license-policy',
  version: '1.0.0',
  evaluators: [
    {
      id: 'licenses.allowed',
      description: 'Dependencies must use an allowed license (reads pip-licenses / license-checker JSON)',
      evidenceType: 'deterministic',
      validateParams(params) {
        const problems = [];
        if (typeof params.report !== 'string') problems.push('param "report" must be a path to a license report');
        if (!Array.isArray(params.allowed)) problems.push('param "allowed" must list SPDX license ids');
        return problems;
      },
      async evaluate(rules, ctx) {
        return Promise.all(
          rules.map(async (rule) => {
            const text = await ctx.workspace.read(rule.params.report);
            if (text === null) return ctx.sdk.skipped(rule, 'deterministic', `${rule.params.report} not found`);
            const allowed = new Set(rule.params.allowed);
            // pip-licenses --format=json: [{ Name, Version, License }]
            const packages = JSON.parse(text);
            const findings = packages
              .filter((p) => !p.License.split(/\s+(?:OR|AND)\s+|;\s*/).some((l) => allowed.has(l.trim())))
              .map((p) =>
                ctx.sdk.ruleFinding(rule, 'licenses.allowed', 'deterministic', {
                  message: `${p.Name} ${p.Version} is licensed ${p.License}, which is not on the allow list`,
                  discriminator: p.Name,
                  extra: { location: { file: rule.params.report, package: `${p.Name}@${p.Version}` } },
                }),
              );
            return ctx.sdk.outcome(rule, 'deterministic', findings);
          }),
        );
      },
    },
  ],
};
