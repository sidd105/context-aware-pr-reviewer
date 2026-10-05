import Anthropic from '@anthropic-ai/sdk';
import type { ProviderFactory } from '../../core/plugin.js';
import { AIOutputError, AIRefusalError, extractJson, jsonInstruction, type AIProvider } from '../provider.js';

// Models that accept the server-side `fallbacks: "default"` option. When a
// safety classifier declines a request (security-heavy code can trip one),
// the API retries it on Anthropic's recommended fallback model.
const SERVER_FALLBACK_MODELS = /^claude-(?:opus-5|fable-5-1|sonnet-5-5)/;

export const anthropicProvider: ProviderFactory = {
  type: 'anthropic',
  create(name, config): AIProvider {
    // Credentials come from the named env var, or the SDK's own resolution
    // (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, `ant auth login` profile).
    const apiKey = config.api_key_env ? process.env[config.api_key_env] : undefined;
    const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(config.base_url ? { baseURL: config.base_url } : {}) });

    return {
      name,
      type: 'anthropic',
      hosting: config.hosting,
      async complete(model, request) {
        const started = Date.now();
        const useFallbacks = request.options.server_fallbacks !== false && SERVER_FALLBACK_MODELS.test(model);
        const effort = request.options.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
        const response = await client.beta.messages.create(
          {
            model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.structuredOutput ? request.prompt : request.prompt + jsonInstruction(request.schema) }],
            output_config: {
              ...(effort ? { effort } : {}),
              ...(request.structuredOutput ? { format: { type: 'json_schema' as const, schema: request.schema } } : {}),
            },
            // Current Claude models reject sampling parameters; only send one
            // when the profile sets it explicitly.
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          },
          { ...(request.signal ? { signal: request.signal } : {}) },
        );

        if (response.stop_reason === 'refusal') {
          throw new AIRefusalError(`${model} declined the request${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}`);
        }
        if (response.stop_reason === 'max_tokens') {
          throw new AIOutputError(`${model} hit max_tokens (${request.maxOutputTokens}) before finishing`);
        }
        const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
        return {
          output: extractJson(text),
          model: response.model,
          requestId: response.id,
          usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
          stopReason: response.stop_reason ?? 'unknown',
          latencyMs: Date.now() - started,
        };
      },
    };
  },
};
