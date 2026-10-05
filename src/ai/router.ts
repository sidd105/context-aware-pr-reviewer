import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { AIConfig, Capabilities, ModelProfile } from '../config/schema.js';
import { sha256 } from '../core/finding.js';
import type { Logger } from '../core/logger.js';
import type { AIProvenance } from '../core/model.js';
import type { Registry } from '../core/plugin.js';
import { DataPolicyGate } from './data-policy.js';
import { AIRefusalError, type AIProvider, type AIRequest, type AIResponse } from './provider.js';

export interface RouteRequest {
  evaluator: string;
  category?: string | undefined;
  tier?: 'low' | 'medium' | 'high' | undefined;
  // Files whose content will be sent; used for data classification checks.
  files: string[];
  needs: Array<keyof Capabilities>;
  // Roughly how many tokens the prompt is; long prompts need long-context models.
  promptTokens?: number;
}

export interface Route {
  profileName: string;
  profile: ModelProfile;
  provider: AIProvider;
  // Candidates considered before this one and why they were passed over.
  rejected: Array<{ profile: string; reason: string }>;
  // Remaining candidates, in order, if this one fails.
  fallbacks: Array<{ profileName: string; profile: ModelProfile; provider: AIProvider }>;
}

export interface CallRecord {
  evaluator: string;
  promptVersion: string;
  rules: string[];
  files: string[];
  redactions: { secrets: number; pii: number };
}

// Picks a model for each evaluation from configuration, never from rules.
// Resolution order, most specific first:
//   1. environments.<env>.evaluators.<evaluator>
//   2. tiers.<rule complexity hint>
//   3. categories.<rule category>
//   4. evaluators.<evaluator>
//   5. environments.<env>.default
//   6. default
//   7. fallback, in order
// Each candidate must have the capabilities the evaluator needs and pass the
// data policy for the files being sent; the first that does is used.
export class ModelRouter {
  private providers = new Map<string, AIProvider>();
  readonly policy: DataPolicyGate;

  constructor(
    private readonly ai: AIConfig,
    registry: Registry,
    private readonly environment: string | undefined,
    private readonly logger: Logger,
    private readonly auditPath: string,
  ) {
    for (const [name, config] of Object.entries(ai.providers)) {
      const factory = registry.providers.get(config.type);
      if (!factory) throw new Error(`AI provider ${name}: unknown type "${config.type}". Registered: ${[...registry.providers.keys()].join(', ')}`);
      this.providers.set(name, factory.create(name, config));
    }
    for (const [name, profile] of Object.entries(ai.models)) {
      if (!this.providers.has(profile.provider)) throw new Error(`Model profile ${name} uses unknown provider "${profile.provider}"`);
    }
    this.policy = new DataPolicyGate(ai.data_policy);
  }

  static create(ai: AIConfig, registry: Registry, environment: string | undefined, logger: Logger, repoRoot: string): ModelRouter | null {
    if (!ai.enabled) return null;
    if (Object.keys(ai.models).length === 0) {
      logger.warn('ai.enabled is true but no ai.models are configured; AI evaluators will be skipped.');
      return null;
    }
    const audit = isAbsolute(ai.audit_log) ? ai.audit_log : join(repoRoot, ai.audit_log);
    return new ModelRouter(ai, registry, environment, logger, audit);
  }

  candidates(req: RouteRequest): string[] {
    const r = this.ai.routing;
    const env = this.environment ? r.environments[this.environment] : undefined;
    const ordered = [
      env?.evaluators?.[req.evaluator],
      req.tier ? r.tiers[req.tier] : undefined,
      req.category ? r.categories[req.category] : undefined,
      r.evaluators[req.evaluator],
      env?.default,
      r.default,
      ...r.fallback,
    ].filter((x): x is string => typeof x === 'string');
    if (ordered.length === 0) ordered.push(...Object.keys(this.ai.models).slice(0, 1));
    return [...new Set(ordered)];
  }

  route(req: RouteRequest): Route | { error: string; rejected: Route['rejected'] } {
    const rejected: Route['rejected'] = [];
    const usable: Route['fallbacks'] = [];
    for (const name of this.candidates(req)) {
      const profile = this.ai.models[name];
      if (!profile) {
        rejected.push({ profile: name, reason: 'no such model profile' });
        continue;
      }
      const provider = this.providers.get(profile.provider)!;
      const missing = req.needs.filter((c) => !profile.capabilities[c]);
      if (missing.length > 0) {
        rejected.push({ profile: name, reason: `lacks ${missing.join(', ')}` });
        continue;
      }
      if (req.promptTokens && req.promptTokens > profile.context_tokens * 0.8) {
        rejected.push({ profile: name, reason: `prompt (~${req.promptTokens} tokens) exceeds its context window` });
        continue;
      }
      const denied = this.policy.rejects(name, profile, provider, req.files);
      if (denied) {
        rejected.push({ profile: name, reason: denied });
        continue;
      }
      usable.push({ profileName: name, profile, provider });
    }
    const [first, ...rest] = usable;
    if (!first) return { error: 'no configured model satisfies capabilities and data policy', rejected };
    return { ...first, rejected, fallbacks: rest };
  }

  // Calls the routed model, falling back to the next candidate on failure,
  // and writes an audit record for every attempt.
  async complete(route: Route, request: Omit<AIRequest, 'maxOutputTokens' | 'temperature' | 'options' | 'structuredOutput'>, record: CallRecord): Promise<{ response: AIResponse; provenance: AIProvenance }> {
    const attempts = [{ profileName: route.profileName, profile: route.profile, provider: route.provider }, ...route.fallbacks];
    const errors: string[] = [];
    const promptSha = sha256(`${request.system}\u0000${request.prompt}`);
    for (const attempt of attempts) {
      const { profile, provider } = attempt;
      try {
        const response = await provider.complete(profile.model, {
          ...request,
          maxOutputTokens: profile.max_output_tokens,
          temperature: profile.temperature,
          options: profile.options,
          structuredOutput: profile.capabilities.structured_output,
        });
        const provenance: AIProvenance = {
          provider: provider.name,
          model: response.model,
          profile: attempt.profileName,
          prompt_version: record.promptVersion,
          ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
          ...(response.requestId ? { request_id: response.requestId } : {}),
          prompt_sha256: promptSha,
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
          latency_ms: response.latencyMs,
        };
        await this.audit({ ...record, outcome: 'ok', provenance, rejected: route.rejected, errors, prompt: this.ai.data_policy.log_prompts ? request.prompt : undefined });
        return { response, provenance };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${attempt.profileName}: ${message}`);
        this.logger.warn(`AI call via ${attempt.profileName} failed: ${message}${attempts.indexOf(attempt) < attempts.length - 1 ? '; trying next model' : ''}`);
        if (error instanceof AIRefusalError && attempts.indexOf(attempt) === attempts.length - 1) break;
      }
    }
    await this.audit({ ...record, outcome: 'failed', errors, rejected: route.rejected, promptSha });
    throw new Error(`All models failed: ${errors.join(' | ')}`);
  }

  private async audit(entry: Record<string, unknown>) {
    try {
      await mkdir(dirname(this.auditPath), { recursive: true });
      await appendFile(this.auditPath, `${JSON.stringify({ timestamp: new Date().toISOString(), environment: this.environment, ...entry })}\n`);
    } catch (error) {
      this.logger.warn(`could not write AI audit log: ${(error as Error).message}`);
    }
  }
}
