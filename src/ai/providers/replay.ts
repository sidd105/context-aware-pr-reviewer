import { readFileSync } from 'node:fs';
import type { ProviderFactory } from '../../core/plugin.js';
import type { AIProvider, AIRequest, AIResponse } from '../provider.js';

// Returns recorded responses instead of calling a model. Used for tests,
// offline demos, and reproducing a past assessment exactly.
//
//   providers:
//     recorded:
//       type: replay
//       file: ai-recordings.json
//
// The file holds { "responses": [ { "match": { "schema": "...", "contains": ["RULE-ID"] }, "output": {...} } ] }.
// The first entry whose match fits the request wins.

export interface Recording {
  match?: { schema?: string; contains?: string[] };
  model?: string;
  output: unknown;
}

export type ReplayHandler = (model: string, request: AIRequest) => unknown;

export function replayProvider(name: string, source: Recording[] | ReplayHandler, hosting: AIProvider['hosting'] = 'local'): AIProvider {
  return {
    name,
    type: 'replay',
    hosting,
    async complete(model, request): Promise<AIResponse> {
      let output: unknown;
      let served = model;
      if (typeof source === 'function') {
        output = source(model, request);
      } else {
        const hit = source.find(
          (r) =>
            (!r.match?.schema || r.match.schema === request.schemaName) &&
            (r.match?.contains ?? []).every((s) => request.prompt.includes(s)),
        );
        if (!hit) throw new Error(`replay provider ${name}: no recording matches this request`);
        output = hit.output;
        served = hit.model ?? model;
      }
      return {
        output,
        model: served,
        usage: { inputTokens: Math.ceil((request.system.length + request.prompt.length) / 4), outputTokens: Math.ceil(JSON.stringify(output).length / 4) },
        stopReason: 'end_turn',
        latencyMs: 0,
      };
    },
  };
}

export const replayProviderFactory: ProviderFactory = {
  type: 'replay',
  create(name, config) {
    if (typeof config.file !== 'string') throw new Error(`AI provider ${name}: replay needs "file"`);
    const data = JSON.parse(readFileSync(config.file, 'utf8')) as { responses?: Recording[] };
    return replayProvider(name, data.responses ?? [], config.hosting);
  },
};
