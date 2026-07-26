import type { Credentials } from '../config.js';
import { NO_CAPABILITIES, type ProviderCapabilities, type ProviderId } from '../types.js';
import { ANTHROPIC_CAPABILITIES, createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider, OPENAI_CAPABILITIES } from './openai.js';
import { createOpenRouterProvider, OPENROUTER_CAPABILITIES } from './openrouter.js';
import { createTogetherProvider, TOGETHER_CAPABILITIES } from './together.js';
import type { Provider } from './types.js';

export type { CollectContext, Provider } from './types.js';

/**
 * What each platform can answer *at best*. A run's real capabilities come back
 * from `collect` and may be narrower — that is the number to trust.
 */
export const DECLARED_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  openrouter: OPENROUTER_CAPABILITIES,
  together: TOGETHER_CAPABILITIES,
  openai: OPENAI_CAPABILITIES,
  anthropic: ANTHROPIC_CAPABILITIES,
};

/** Providers in stable display order, for whatever credentials exist. */
export function createProviders(credentials: Credentials): Provider[] {
  const providers: Provider[] = [];
  if (credentials.openrouter) providers.push(createOpenRouterProvider(credentials.openrouter));
  if (credentials.together) providers.push(createTogetherProvider(credentials.together));
  if (credentials.openai) providers.push(createOpenAIProvider(credentials.openai));
  if (credentials.anthropic) providers.push(createAnthropicProvider(credentials.anthropic));
  return providers;
}

export const UNCONFIGURED_CAPABILITIES = NO_CAPABILITIES;
