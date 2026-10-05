// The only interface the rest of the framework uses to talk to a model.
// Adapters (Anthropic, OpenAI-compatible, replay, or a plugin) implement it;
// nothing outside src/ai/providers knows a vendor SDK exists.

export interface AIRequest {
  system: string;
  prompt: string;
  // JSON Schema the response must satisfy. Adapters use native structured
  // output when the model supports it and fall back to "reply with JSON".
  schema: Record<string, unknown>;
  schemaName: string;
  maxOutputTokens: number;
  temperature?: number | undefined;
  structuredOutput: boolean;
  // Profile `options`, passed through untouched (e.g. { effort: "high" }).
  options: Record<string, unknown>;
  signal?: AbortSignal | undefined;
}

export interface AIResponse {
  output: unknown;
  // The model id the provider says served the request, which can differ from
  // the one requested (aliases, server-side fallbacks).
  model: string;
  requestId?: string | undefined;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
  latencyMs: number;
}

export interface AIProvider {
  name: string;
  type: string;
  hosting: 'vendor' | 'cloud-tenant' | 'self-hosted' | 'local';
  complete(model: string, request: AIRequest): Promise<AIResponse>;
}

export class AIRefusalError extends Error {}
export class AIOutputError extends Error {}

// Pull a JSON value out of a model reply that may wrap it in prose or fences.
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        // fall through
      }
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new AIOutputError('Model response was not valid JSON');
  }
}

export function jsonInstruction(schema: Record<string, unknown>): string {
  return `\n\nRespond with a single JSON object and nothing else. It must validate against this JSON Schema:\n${JSON.stringify(schema)}`;
}
