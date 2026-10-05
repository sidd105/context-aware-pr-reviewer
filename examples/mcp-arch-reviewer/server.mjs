#!/usr/bin/env node
// A minimal MCP server that evaluates architecture rules and returns an
// AgentAssessment. It stands in for a real agent (or for an MCP server such as
// context-engineering-sdlc extended with an assessment tool) so the
// end-to-end example runs offline.
//
// Tool: assess_rules({ repository_root, files, rules }) -> AgentAssessment JSON
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'arch-reviewer', version: '0.1.0' });

// Each known rule id maps to a check. A real server would ask a model here.
const checks = {
  // Services talk to the outside world only through app/infra adapters.
  'ACME-AGENT-ARCH-001': (root, files) => {
    const findings = [];
    for (const file of files.filter((f) => f.startsWith('app/services/') || f.startsWith('app/domain/'))) {
      const lines = readFileSync(join(root, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/requests\.(get|post|put|delete)\(/.test(line)) {
          findings.push({
            file,
            line: i + 1,
            message: 'Outbound HTTP call made directly from a service instead of through an infra adapter',
            evidence: line.trim(),
            remediation: 'Move the call behind an adapter in app/infra and inject it.',
            confidence: 0.8,
          });
        }
      });
    }
    return findings;
  },
};

server.registerTool(
  'assess_rules',
  {
    description: 'Evaluate architecture rules against repository files and return an AgentAssessment',
    inputSchema: {
      repository_root: z.string(),
      files: z.array(z.string()),
      rules: z.array(z.object({ id: z.string() }).passthrough()),
    },
  },
  async ({ repository_root, files, rules }) => {
    const rule_results = rules.map((rule) => {
      const check = checks[rule.id];
      if (!check) return { rule_id: rule.id, status: 'skipped', confidence: 0, summary: 'No check for this rule' };
      const findings = check(repository_root, files);
      return findings.length
        ? { rule_id: rule.id, status: 'failed', confidence: 0.8, findings }
        : { rule_id: rule.id, status: 'passed', confidence: 0.8, summary: 'No violations found' };
    });
    const assessment = { agent: { name: 'arch-reviewer', version: '0.1.0' }, rule_results };
    return { content: [{ type: 'text', text: JSON.stringify(assessment) }] };
  },
);

await server.connect(new StdioServerTransport());
