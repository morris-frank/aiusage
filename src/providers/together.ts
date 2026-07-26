/**
 * Together AI.
 *
 * Together publishes **no usage or cost API**. Its cost analytics live in the
 * dashboard only (organization billing settings and a per-project cost-analytics
 * page); the public API reference — inference, batch, files, fine-tuning,
 * endpoints, clusters, deployments — contains no usage, cost, billing or audit
 * endpoint (checked 2026-07-26).
 *
 * Rather than scrape a session-authenticated dashboard route or infer spend from
 * something that is not spend, this provider does what it honestly can:
 *
 *   - verifies the key and reports the identity it belongs to (`/v1/whoami`),
 *     so the row in `aiusage providers` is real rather than a placeholder;
 *   - contributes live per-model pricing from `/v1/models`, which is what
 *     `aiusage pricing --provider together` answers from;
 *   - reports usage as `unsupported` with a diagnostic, so a Together total of
 *     zero can never be mistaken for "no spend".
 *
 * When Together ships a usage endpoint, only `collect` below needs to change.
 */

import type { TogetherCredentials } from '../config.js';
import { HttpError } from '../http.js';
import type { Diagnostic, ProviderCapabilities, ProviderResult } from '../types.js';
import type { CollectContext, Provider } from './types.js';

const BASE_URL = 'https://api.together.xyz/v1';

type WhoamiResponse = {
  api_key_id?: string;
  project_id?: string;
  project_name?: string;
  organization_id?: string;
  organization_name?: string;
  user_id?: string;
};

const DECLARED: ProviderCapabilities = {
  usage: false,
  reportedCost: false,
  splitByModel: false,
  splitByApiKey: false,
  splitByAccount: false,
  splitByWorkspace: false,
  livePricing: true,
  maxLookbackDays: null,
};

export const TOGETHER_USAGE_DIAGNOSTIC: Diagnostic = {
  provider: 'together',
  level: 'warning',
  code: 'usage-api-unavailable',
  message:
    'Together AI exposes no usage or cost API — its cost analytics are dashboard-only (api.together.ai → billing / project cost analytics). Together contributes live pricing and identity here, but no usage rows; treat its absence from totals as unknown, not zero.',
};

export function createTogetherProvider(credentials: TogetherCredentials): Provider {
  return {
    id: 'together',
    declaredCapabilities: DECLARED,
    collect: (context) => collect(context, credentials),
  };
}

async function collect(
  context: CollectContext,
  credentials: TogetherCredentials,
): Promise<ProviderResult> {
  const diagnostics: Diagnostic[] = [TOGETHER_USAGE_DIAGNOSTIC];

  try {
    const whoami = await context.http.json<WhoamiResponse>(`${BASE_URL}/whoami`, {
      headers: { authorization: `Bearer ${credentials.apiKey}` },
    });

    return {
      provider: 'together',
      status: 'unsupported',
      capabilities: DECLARED,
      records: [],
      costRecords: [],
      diagnostics,
      identity: identityOf(whoami),
    };
  } catch (error) {
    diagnostics.push(toDiagnostic(error));
    return {
      provider: 'together',
      status: 'error',
      capabilities: { ...DECLARED, livePricing: false },
      records: [],
      costRecords: [],
      diagnostics,
      identity: null,
    };
  }
}

function identityOf(whoami: WhoamiResponse): ProviderResult['identity'] {
  const identity: NonNullable<ProviderResult['identity']> = {};
  if (whoami.organization_id) identity.organizationId = whoami.organization_id;
  if (whoami.organization_name) identity.organizationName = whoami.organization_name;
  if (whoami.project_id) identity.projectId = whoami.project_id;
  if (whoami.project_name) identity.projectName = whoami.project_name;
  if (whoami.api_key_id) identity.apiKeyId = whoami.api_key_id;
  if (whoami.user_id) identity.userId = whoami.user_id;
  return identity;
}

function toDiagnostic(error: unknown): Diagnostic {
  if (error instanceof HttpError && error.isAuthFailure) {
    return {
      provider: 'together',
      level: 'error',
      code: 'auth-failed',
      message: `Together AI rejected the credentials (HTTP ${error.status}). Check TOGETHER_API_KEY.`,
    };
  }
  return {
    provider: 'together',
    level: 'error',
    code: 'identity-failed',
    message: `Together AI identity could not be read: ${error instanceof Error ? error.message : String(error)}`,
  };
}

export { DECLARED as TOGETHER_CAPABILITIES };
