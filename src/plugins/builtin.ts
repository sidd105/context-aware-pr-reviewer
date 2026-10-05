import { anthropicProvider } from '../ai/providers/anthropic.js';
import { openAICompatibleProvider } from '../ai/providers/openai-compatible.js';
import { replayProviderFactory } from '../ai/providers/replay.js';
import { agentFindingsEvaluator, agentReportConnector } from '../connectors/agent.js';
import { orcaConnector } from '../connectors/orca.js';
import { sarifConnector } from '../connectors/sarif.js';
import { snykConnector } from '../connectors/snyk.js';
import { sonarConnector } from '../connectors/sonar.js';
import { Registry, type Plugin } from '../core/plugin.js';
import { aiReviewEvaluator } from '../evaluators/ai-review.js';
import { commandEvaluator } from '../evaluators/command.js';
import {
  fileLengthEvaluator,
  filesForbiddenEvaluator,
  filesRequiredEvaluator,
  importsForbiddenEvaluator,
  lineLengthEvaluator,
  patternEvaluator,
  testsRequiredEvaluator,
} from '../evaluators/deterministic.js';
import { mcpAssessEvaluator } from '../evaluators/mcp.js';
import { pythonAstEvaluator } from '../evaluators/python.js';
import { secretsEvaluator } from '../evaluators/secrets.js';
import { toolFindingsEvaluator } from '../evaluators/tool.js';
import { builtinRuleSource, fileRuleSource } from '../rules/loader.js';
import { contextUnitsRuleSource, mcpRuleSource } from '../rules/units.js';

// Built-in capabilities are registered the same way third-party plugins are,
// so there's one extension path and the core has no special cases.
export const builtinPlugin: Plugin = {
  name: 'builtin',
  version: '0.2.0',
  evaluators: [
    patternEvaluator,
    filesRequiredEvaluator,
    filesForbiddenEvaluator,
    fileLengthEvaluator,
    lineLengthEvaluator,
    testsRequiredEvaluator,
    importsForbiddenEvaluator,
    secretsEvaluator,
    pythonAstEvaluator,
    commandEvaluator,
    toolFindingsEvaluator,
    agentFindingsEvaluator,
    aiReviewEvaluator,
    mcpAssessEvaluator,
  ],
  connectors: [sarifConnector, snykConnector, sonarConnector, orcaConnector, agentReportConnector],
  ruleSources: [fileRuleSource, builtinRuleSource, contextUnitsRuleSource, mcpRuleSource],
  providers: [anthropicProvider, openAICompatibleProvider, replayProviderFactory],
};

export function builtinRegistry(): Registry {
  return new Registry().register(builtinPlugin);
}
