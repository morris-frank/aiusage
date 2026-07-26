/**
 * Credentials and runtime knobs, read straight from the environment.
 *
 * No config framework and no implicit fallbacks: a provider whose credentials
 * are absent is *skipped* (reported as such), never silently reported as zero
 * usage. A provider whose credentials are the wrong *kind* (an OpenAI project
 * key instead of an admin key) fails loudly at collection time, because the
 * platform is the only authority on what a key can read.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId } from './types.js';

export class ConfigError extends Error {}

export type OpenRouterCredentials = {
  /** Inference key: reports its own activity. */
  apiKey: string | null;
  /** Management/provisioning key: enumerates keys and org-wide activity. */
  managementKey: string | null;
};

export type OpenAICredentials = {
  /** Admin key (`sk-admin-…`). Project keys cannot read organization usage. */
  adminKey: string;
  orgId: string | null;
};

export type AnthropicCredentials = {
  /** Admin key (`sk-ant-admin…`) or an org-scoped OAuth token. */
  adminKey: string;
};

export type TogetherCredentials = {
  apiKey: string;
};

export type Credentials = {
  openrouter: OpenRouterCredentials | null;
  openai: OpenAICredentials | null;
  anthropic: AnthropicCredentials | null;
  together: TogetherCredentials | null;
};

export type RuntimeConfig = {
  credentials: Credentials;
  /** Where the pricing cache lives. */
  cacheDir: string;
  timeoutMs: number;
  /** Max in-flight requests per provider. */
  concurrency: number;
  /** Every literal secret in play, for redaction in error paths. */
  secrets: string[];
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 4;

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  const text = trimmed(value);
  if (text === null) return fallback;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${text}"`);
  }
  return parsed;
}

function defaultCacheDir(env: NodeJS.ProcessEnv): string {
  const explicit = trimmed(env.AIUSAGE_CACHE_DIR);
  if (explicit) return explicit;
  const xdg = trimmed(env.XDG_CACHE_HOME);
  return xdg ? join(xdg, 'aiusage') : join(homedir(), '.cache', 'aiusage');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const openrouterApiKey = trimmed(env.OPENROUTER_API_KEY);
  const openrouterManagementKey = trimmed(env.OPENROUTER_MANAGEMENT_KEY);
  const openaiAdminKey = trimmed(env.OPENAI_ADMIN_KEY);
  const anthropicAdminKey = trimmed(env.ANTHROPIC_ADMIN_KEY);
  const togetherApiKey = trimmed(env.TOGETHER_API_KEY);

  const credentials: Credentials = {
    openrouter:
      openrouterApiKey || openrouterManagementKey
        ? { apiKey: openrouterApiKey, managementKey: openrouterManagementKey }
        : null,
    openai: openaiAdminKey ? { adminKey: openaiAdminKey, orgId: trimmed(env.OPENAI_ORG_ID) } : null,
    anthropic: anthropicAdminKey ? { adminKey: anthropicAdminKey } : null,
    together: togetherApiKey ? { apiKey: togetherApiKey } : null,
  };

  const secrets = [
    openrouterApiKey,
    openrouterManagementKey,
    openaiAdminKey,
    anthropicAdminKey,
    togetherApiKey,
  ].filter((value): value is string => value !== null);

  return {
    credentials,
    cacheDir: defaultCacheDir(env),
    timeoutMs: positiveInt(env.AIUSAGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'AIUSAGE_TIMEOUT_MS'),
    concurrency: positiveInt(env.AIUSAGE_CONCURRENCY, DEFAULT_CONCURRENCY, 'AIUSAGE_CONCURRENCY'),
    secrets,
  };
}

/** Which providers have credentials configured, in stable display order. */
export function configuredProviders(credentials: Credentials): ProviderId[] {
  const configured: ProviderId[] = [];
  if (credentials.openrouter) configured.push('openrouter');
  if (credentials.together) configured.push('together');
  if (credentials.openai) configured.push('openai');
  if (credentials.anthropic) configured.push('anthropic');
  return configured;
}

/** The env var names a provider reads, for "how do I enable this" messages. */
export const CREDENTIAL_ENV_VARS: Record<ProviderId, string[]> = {
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY'],
  together: ['TOGETHER_API_KEY'],
  openai: ['OPENAI_ADMIN_KEY'],
  anthropic: ['ANTHROPIC_ADMIN_KEY'],
};
