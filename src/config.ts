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

/**
 * `management` keys enumerate an OpenRouter workspace's keys and read any of
 * their activity; `inference` keys see only their own. Which kind an env var
 * *claims* to hold is only a hint — `providers/openrouter.ts` asks
 * `GET /api/v1/key` and reports what the key actually is.
 */
export type OpenRouterKeyKind = 'management' | 'inference';

export type OpenRouterKey = {
  /**
   * Where this key came from, for messages and for naming its workspace:
   * `OPENROUTER_MANAGEMENT_KEY_ACME` → `acme`.
   */
  label: string;
  secret: string;
  declaredKind: OpenRouterKeyKind;
  /** True when `label` came from an env-var suffix rather than being derived. */
  labelled: boolean;
};

/**
 * OpenRouter credentials are a *list*: a provisioning key is scoped to one
 * workspace, so an org spanning several workspaces needs one key per workspace
 * (`OPENROUTER_MANAGEMENT_KEY_<LABEL>`, repeatable).
 */
export type OpenRouterCredentials = {
  keys: OpenRouterKey[];
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

/**
 * How to run the local-agent source. Assembled by the caller rather than read
 * from the environment alone: `offline` is a flag, not a credential.
 * See `providers/ccusage.ts`.
 */
export type LocalSourceConfig = {
  /** Explicit argv from `AIUSAGE_CCUSAGE_CMD`; null means discover it. */
  command: string[] | null;
  /** Never reach the network to obtain or price with ccusage. */
  offline: boolean;
  timeoutMs: number;
};

export type RuntimeConfig = {
  credentials: Credentials;
  /** Where the pricing cache lives. */
  cacheDir: string;
  /**
   * Where `aiusage report` writes its figure when neither `--out` nor `--print`
   * says otherwise, from `AIUSAGE_REPORT_DIR`. Null means "the working
   * directory" — the caller supplies that, because config has no cwd of its own.
   */
  reportDir: string | null;
  timeoutMs: number;
  /** Max in-flight requests per provider. */
  concurrency: number;
  /** Every literal secret in play, for redaction in error paths. */
  secrets: string[];
  /**
   * How to run ccusage for `--local`, from `AIUSAGE_CCUSAGE_CMD`. Null means the
   * provider discovers it (a `ccusage` on PATH, else `npx`).
   */
  ccusageCommand: string[] | null;
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

/**
 * `~` is expanded here rather than left to the shell: these variables are
 * typically set in a dotenv file or a launchd/systemd unit, where nothing
 * expands it and a literal `~` directory would be created instead.
 */
function directory(value: string | undefined): string | null {
  const text = trimmed(value);
  if (text === null) return null;
  if (text === '~') return homedir();
  return text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
}

/**
 * `OPENROUTER_API_KEY`, `OPENROUTER_MANAGEMENT_KEY` and
 * `OPENROUTER_PROVISIONING_KEY` (OpenRouter's own name for a management key),
 * each optionally suffixed with a label: `OPENROUTER_MANAGEMENT_KEY_ACME`.
 */
const OPENROUTER_KEY_VAR = /^OPENROUTER_(API|MANAGEMENT|PROVISIONING)_KEY(?:_([A-Z0-9_]+))?$/;

/** One env var may also hold several keys, comma- or whitespace-separated. */
function splitKeyList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseOpenRouterKeys(env: NodeJS.ProcessEnv): OpenRouterKey[] {
  const keys: OpenRouterKey[] = [];
  const seen = new Set<string>();

  // Sorted so the key list is stable regardless of environment iteration order —
  // it decides which credential is used first for a shared workspace.
  for (const name of Object.keys(env).sort()) {
    const match = OPENROUTER_KEY_VAR.exec(name);
    if (!match) continue;
    const value = trimmed(env[name]);
    if (!value) continue;

    const [, kindWord, suffix] = match;
    const declaredKind: OpenRouterKeyKind = kindWord === 'API' ? 'inference' : 'management';
    const secrets = splitKeyList(value);

    secrets.forEach((secret, index) => {
      // The same key in two variables is one key, not two: enumerating it twice
      // would double every row it reports.
      if (seen.has(secret)) return;
      seen.add(secret);
      const base = suffix ? suffix.toLowerCase() : declaredKind;
      keys.push({
        label: secrets.length > 1 ? `${base}-${index + 1}` : base,
        secret,
        declaredKind,
        labelled: suffix !== undefined,
      });
    });
  }
  return keys;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const openrouterKeys = parseOpenRouterKeys(env);
  const openaiAdminKey = trimmed(env.OPENAI_ADMIN_KEY);
  const anthropicAdminKey = trimmed(env.ANTHROPIC_ADMIN_KEY);
  const togetherApiKey = trimmed(env.TOGETHER_API_KEY);

  const credentials: Credentials = {
    openrouter: openrouterKeys.length > 0 ? { keys: openrouterKeys } : null,
    openai: openaiAdminKey ? { adminKey: openaiAdminKey, orgId: trimmed(env.OPENAI_ORG_ID) } : null,
    anthropic: anthropicAdminKey ? { adminKey: anthropicAdminKey } : null,
    together: togetherApiKey ? { apiKey: togetherApiKey } : null,
  };

  const secrets = [
    ...openrouterKeys.map((key) => key.secret),
    openaiAdminKey,
    anthropicAdminKey,
    togetherApiKey,
  ].filter((value): value is string => value !== null);

  const ccusageCommand = trimmed(env.AIUSAGE_CCUSAGE_CMD);

  return {
    credentials,
    cacheDir: defaultCacheDir(env),
    reportDir: directory(env.AIUSAGE_REPORT_DIR),
    timeoutMs: positiveInt(env.AIUSAGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'AIUSAGE_TIMEOUT_MS'),
    concurrency: positiveInt(env.AIUSAGE_CONCURRENCY, DEFAULT_CONCURRENCY, 'AIUSAGE_CONCURRENCY'),
    secrets,
    // Split on whitespace only: this is an argv, not a shell line — no quoting,
    // no globbing, nothing that would need a shell to interpret it.
    ccusageCommand: ccusageCommand ? ccusageCommand.split(/\s+/) : null,
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
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY[_LABEL]'],
  together: ['TOGETHER_API_KEY'],
  openai: ['OPENAI_ADMIN_KEY'],
  anthropic: ['ANTHROPIC_ADMIN_KEY'],
  // Not a credential: the local source is enabled by a flag, not by a key.
  ccusage: [],
};
