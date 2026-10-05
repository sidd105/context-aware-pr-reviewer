import type { ProviderFactory } from '../../core/plugin.js';
import { AIOutputError, AIRefusalError, extractJson, jsonInstruction, type AIProvider } from '../provider.js';

// Any endpoint that speaks the Chat Completions wire format: OpenAI, Azure
// OpenAI, vLLM, Ollama, LM Studio, LiteLLM, and most self-hosted gateways.
//
//   providers:
//     local:
//       type: openai-compatible
//       base_url: http://localhost:11434/v1
//       hosting: local
//     azure:
//       type: openai-compatible
//       base_url: https://<resource>.openai.azure.com/openai/deployments/<deployment>
//       api_key_env: AZURE_OPENAI_KEY
//       auth_header: api-key            # Azure uses its own header
//       query: { api-version: "2024-10-21" }

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export const openAICompatibleProvider: ProviderFactory = {
  type: 'openai-compatible',
  create(name, config): AIProvider {
    if (!config.base_url) throw new Error(`AI provider ${name}: openai-compatible needs base_url`);
    const base = config.base_url.replace(/\/$/, '');
    const authHeader = typeof config.auth_header === 'string' ? config.auth_header : 'Authorization';
    const query = new URLSearchParams((config.query as Record<string, string> | undefined) ?? {}).toString();
    const tokenParam = typeof config.max_tokens_param === 'string' ? config.max_tokens_param : 'max_tokens';

    return {
      name,
      type: 'openai-compatible',
      hosting: config.hosting,
      async complete(model, request) {
        const started = Date.now();
        const key = config.api_key_env ? process.env[config.api_key_env] : undefined;
        if (config.api_key_env && !key) throw new Error(`AI provider ${name}: ${config.api_key_env} is not set`);
        const body = {
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.structuredOutput ? request.prompt : request.prompt + jsonInstruction(request.schema) },
          ],
          [tokenParam]: request.maxOutputTokens,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          response_format: request.structuredOutput
            ? { type: 'json_schema', json_schema: { name: request.schemaName, schema: request.schema } }
            : { type: 'json_object' },
          ...((request.options.extra_body as Record<string, unknown> | undefined) ?? {}),
        };
        const res = await fetch(`${base}/chat/completions${query ? `?${query}` : ''}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(key ? { [authHeader]: authHeader === 'Authorization' ? `Bearer ${key}` : key } : {}),
          },
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        const data = (await res.json().catch(() => ({}))) as ChatResponse;
        if (!res.ok) throw new Error(`AI provider ${name} returned ${res.status}: ${data.error?.message ?? res.statusText}`);
        const choice = data.choices?.[0];
        if (choice?.message?.refusal) throw new AIRefusalError(`${model} declined: ${choice.message.refusal}`);
        if (choice?.finish_reason === 'length') throw new AIOutputError(`${model} hit the output limit before finishing`);
        const content = choice?.message?.content;
        if (!content) throw new AIOutputError(`${model} returned no content`);
        return {
          output: extractJson(content),
          model: data.model ?? model,
          requestId: data.id,
          usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
          stopReason: choice?.finish_reason ?? 'unknown',
          latencyMs: Date.now() - started,
        };
      },
    };
  },
};
