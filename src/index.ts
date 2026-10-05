// Public API for embedding the framework or writing plugins.
export { assess, type Assessment, type AssessOptions } from './engine/assess.js';
export { runBenchmark, scoreRun, type BenchDataset, type ProfileResult } from './engine/bench.js';
export { loadConfig, findConfig } from './config/loader.js';
export { ConfigSchema, type Config } from './config/schema.js';
export * from './core/model.js';
export { makeFinding, fingerprint } from './core/finding.js';
export type { Plugin, Evaluator, Connector, RuleSource, ProviderFactory, AssessmentContext } from './core/plugin.js';
export { Registry } from './core/plugin.js';
export { builtinRegistry, builtinPlugin } from './plugins/builtin.js';
export type { AIProvider, AIRequest, AIResponse } from './ai/provider.js';
export { replayProvider } from './ai/providers/replay.js';
export { AgentAssessment } from './connectors/agent.js';
export { rate, type Rating, type ScoredRule } from './scoring/engine.js';
export { renderMarkdown } from './report/markdown.js';
export { renderSarif } from './report/sarif.js';
export { compareRuns } from './storage/history.js';
export { outcome, ruleFinding, skipped } from './evaluators/util.js';
