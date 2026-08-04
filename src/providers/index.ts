import type { Credentials, LocalSourceConfig } from '../config.js';
import { NO_CAPABILITIES, type ProviderCapabilities, type ProviderId } from '../types.js';
import { ANTHROPIC_CAPABILITIES, createAnthropicProvider } from './anthropic.js';
import { CCUSAGE_CAPABILITIES, type CommandRunner, createCcusageProvider } from './ccusage.js';
import { createOpenAIProvider, OPENAI_CAPABILITIES } from './openai.js';
import { createOpenRouterProvider, OPENROUTER_CAPABILITIES } from './openrouter.js';
import type { Provider } from './types.js';

export type { CollectContext, Provider } from './types.js';

/**
 * What each source can answer *at best*. A run's real capabilities come back
 * from `collect` and may be narrower — that is the number to trust.
 */
export const DECLARED_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  openrouter: OPENROUTER_CAPABILITIES,
  openai: OPENAI_CAPABILITIES,
  anthropic: ANTHROPIC_CAPABILITIES,
  ccusage: CCUSAGE_CAPABILITIES,
};

/**
 * Sources in stable display order, for whatever credentials exist. The local
 * source is only created when the caller asked for it: it changes what a total
 * means (see `providers/ccusage.ts`), so it is never on by default.
 */
export function createProviders(
  credentials: Credentials,
  local: LocalSourceConfig | null = null,
  localRunner?: CommandRunner,
): Provider[] {
  const providers: Provider[] = [];
  if (credentials.openrouter) providers.push(createOpenRouterProvider(credentials.openrouter));
  if (credentials.openai) providers.push(createOpenAIProvider(credentials.openai));
  if (credentials.anthropic) providers.push(createAnthropicProvider(credentials.anthropic));
  if (local) providers.push(createCcusageProvider(local, localRunner));
  return providers;
}

export const UNCONFIGURED_CAPABILITIES = NO_CAPABILITIES;
