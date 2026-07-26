/**
 * Local agent usage, via ccusage.
 *
 * This is the one source that is not a billing API: [ccusage](https://github.com/ryoppippi/ccusage)
 * reads the coding agents' own logs on this machine (Claude Code, Codex, Gemini
 * CLI, …) and prices them from the LiteLLM table. It exists here so a single
 * report can cover both what the platforms billed and what the local agents ran.
 *
 * Three consequences are surfaced rather than smoothed over:
 *
 *   1. **Cost is `imported`, not `reported`.** No platform stated these amounts;
 *      ccusage calculated them. For an agent on a subscription (Claude Max, a
 *      Codex plan) the figure is what the same tokens *would* have cost on the
 *      API — not money spent.
 *   2. **It can double-count.** An agent billed through an API key belongs to a
 *      platform total as well, so including both counts the same traffic twice.
 *      Opt-in (`--local`) and a warning on every mixed run.
 *   3. **It is another program's output.** ccusage is executed as a subprocess
 *      with a fixed argument list, its JSON is parsed defensively, and a failure
 *      makes the source `error` — never a silent zero.
 */

import { execFile } from 'node:child_process';
import type { LocalSourceConfig } from '../config.js';
import { zonedDayEnd, zonedDayStart } from '../dates.js';
import { usdToMicros } from '../money.js';
import type {
  Diagnostic,
  ProviderCapabilities,
  ProviderIdentity,
  ProviderResult,
  UsageRecord,
} from '../types.js';
import type { CollectContext, Provider } from './types.js';

/**
 * ccusage's `daily --json` payload. Every field optional: this is another tool's
 * output, and a version bump must degrade rather than crash.
 */
type CcusageModelBreakdown = {
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cost?: number;
};

type CcusageAgentBreakdown = {
  agent?: string;
  modelBreakdowns?: CcusageModelBreakdown[];
};

type CcusageDay = {
  period?: string;
  agent?: string;
  /** Present with `--by-agent`: per-agent rows inside the day. */
  agents?: CcusageAgentBreakdown[];
  modelBreakdowns?: CcusageModelBreakdown[];
  metadata?: { agents?: string[] };
};

type CcusagePayload = { daily?: CcusageDay[] };

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/** Injected so tests never spawn a process. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

const DECLARED: ProviderCapabilities = {
  usage: true,
  // ccusage states a cost, but it calculated it; `imported` is the label that
  // earns, and `reportedCost` here would claim a platform billed it.
  reportedCost: false,
  splitByModel: true,
  splitByApiKey: false,
  splitByAccount: false,
  splitByWorkspace: false,
  livePricing: false,
  maxLookbackDays: null,
};

export function createCcusageProvider(
  config: LocalSourceConfig,
  run: CommandRunner = runCommand,
): Provider {
  return {
    id: 'ccusage',
    declaredCapabilities: DECLARED,
    collect: (context) => collect(context, config, run),
  };
}

/**
 * Candidate invocations, in order. A `ccusage` on PATH is preferred because it
 * needs nothing from the network; `npx` is the fallback that makes `--local` work
 * on a machine that has never installed it, and is skipped when `--offline` says
 * not to reach out.
 */
function candidates(config: LocalSourceConfig): string[][] {
  if (config.command) return [config.command];
  const installed = [['ccusage']];
  return config.offline ? installed : [...installed, ['npx', '--yes', 'ccusage@latest']];
}

async function collect(
  context: CollectContext,
  config: LocalSourceConfig,
  run: CommandRunner,
): Promise<ProviderResult> {
  const diagnostics: Diagnostic[] = [];
  const args = [
    'daily',
    '--json',
    // Per-agent breakdowns; without them a day's models cannot be attributed to
    // the agent that ran them.
    '--by-agent',
    '--since',
    context.range.since,
    '--until',
    context.range.until,
    '-z',
    context.timeZone,
    ...(config.offline ? ['--offline'] : []),
  ];

  let payload: CcusagePayload | null = null;
  let invocation: string[] = [];
  const attempts: string[] = [];

  for (const candidate of candidates(config)) {
    const [command, ...leading] = candidate;
    if (!command) continue;
    let outcome: CommandResult;
    try {
      outcome = await run(command, [...leading, ...args], config.timeoutMs);
    } catch (error) {
      // Not installed / not on PATH: try the next way of invoking it.
      attempts.push(`${command}: ${describe(error)}`);
      continue;
    }
    if (outcome.code !== 0) {
      attempts.push(`${command}: exit ${outcome.code}${firstLine(outcome.stderr)}`);
      continue;
    }
    const parsed = parsePayload(outcome.stdout);
    if (!parsed) {
      attempts.push(`${command}: output was not ccusage JSON`);
      continue;
    }
    payload = parsed;
    invocation = candidate;
    break;
  }

  if (!payload) {
    return {
      provider: 'ccusage',
      status: 'error',
      capabilities: { ...DECLARED, usage: false },
      records: [],
      costRecords: [],
      diagnostics: [
        {
          provider: 'ccusage',
          level: 'error',
          code: 'local-tool-unavailable',
          message: `ccusage could not be run, so local agent usage is missing from this report (tried ${attempts.join('; ')}). Install it (\`npm i -g ccusage\`) or set AIUSAGE_CCUSAGE_CMD.`,
        },
      ],
      identity: null,
    };
  }

  const { records, agents, undatedRows } = toRecords(payload, context);
  if (undatedRows > 0) {
    diagnostics.push({
      provider: 'ccusage',
      level: 'warning',
      code: 'bucket-unparseable',
      message: `${undatedRows} ccusage row(s) carried no readable date and are missing from this report.`,
    });
  }
  diagnostics.push({
    provider: 'ccusage',
    level: 'info',
    code: 'cost-imported',
    message:
      'Local agent cost is ccusage’s own calculation from published unit prices, labelled `imported`. For a subscription-billed agent it is the API-equivalent of those tokens, not money billed.',
  });

  const identity: ProviderIdentity = { tool: invocation.join(' ') };
  if (agents.size > 0) identity.agents = [...agents].sort().join(',');

  return {
    provider: 'ccusage',
    status: undatedRows > 0 ? 'partial' : 'ok',
    capabilities: { ...DECLARED, splitByModel: records.some((record) => record.model !== null) },
    records,
    costRecords: [],
    diagnostics,
    identity,
  };
}

function parsePayload(stdout: string): CcusagePayload | null {
  // ccusage prints only JSON with --json, but a wrapper script might add a line;
  // take from the first brace so a stray banner does not lose the whole run.
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!Array.isArray((parsed as CcusagePayload).daily)) return null;
    return parsed as CcusagePayload;
  } catch {
    return null;
  }
}

function toRecords(
  payload: CcusagePayload,
  context: CollectContext,
): { records: UsageRecord[]; agents: Set<string>; undatedRows: number } {
  const records: UsageRecord[] = [];
  const agents = new Set<string>();
  let undatedRows = 0;

  for (const day of payload.daily ?? []) {
    const period = typeof day.period === 'string' ? day.period.slice(0, 10) : null;
    if (!period || !/^\d{4}-\d{2}-\d{2}$/.test(period)) {
      undatedRows += 1;
      continue;
    }
    if (period < context.range.since || period > context.range.until) continue;
    records.push(...dayRecords(day, period, context, agents));
  }

  return { records, agents, undatedRows };
}

function dayRecords(
  day: CcusageDay,
  period: string,
  context: CollectContext,
  agents: Set<string>,
): UsageRecord[] {
  // ccusage groups by the timezone it was asked for, so its dates are *local*
  // days; the bucket instant has to be that day's local start.
  const bucketStart = zonedDayStart(period, context.timeZone).toISOString();
  const bucketEnd = zonedDayEnd(period, context.timeZone).toISOString();
  const perAgent = Array.isArray(day.agents) ? day.agents : [];

  if (perAgent.length === 0) {
    // Without per-agent rows the day's models cannot be attributed to an agent,
    // so they are recorded unattributed rather than guessed at.
    for (const name of day.metadata?.agents ?? []) agents.add(name);
    return (day.modelBreakdowns ?? []).map((breakdown) =>
      toRecord(breakdown, bucketStart, bucketEnd, null),
    );
  }

  const records: UsageRecord[] = [];
  for (const entry of perAgent) {
    const agent = typeof entry.agent === 'string' ? entry.agent : null;
    if (agent) agents.add(agent);
    for (const breakdown of entry.modelBreakdowns ?? []) {
      records.push(toRecord(breakdown, bucketStart, bucketEnd, agent));
    }
  }
  return records;
}

function toRecord(
  breakdown: CcusageModelBreakdown,
  bucketStart: string,
  bucketEnd: string,
  agent: string | null,
): UsageRecord {
  const tags: Record<string, string> = { source: 'ccusage' };
  if (agent) tags.agent = agent;

  return {
    provider: 'ccusage',
    bucketStart,
    bucketEnd,
    model: typeof breakdown.modelName === 'string' ? breakdown.modelName : null,
    // Local logs know the agent, never a platform account, key or workspace.
    account: null,
    apiKey: null,
    workspace: null,
    tokens: {
      input: breakdown.inputTokens ?? 0,
      output: breakdown.outputTokens ?? 0,
      cacheCreation: breakdown.cacheCreationTokens ?? 0,
      cacheRead: breakdown.cacheReadTokens ?? 0,
      // ccusage folds reasoning into output and does not report it separately.
      reasoning: 0,
    },
    // ccusage counts messages, not API requests, and does not emit a count here.
    requests: null,
    reportedCostMicros: typeof breakdown.cost === 'number' ? usdToMicros(breakdown.cost) : null,
    costBasis: 'imported',
    extras: {},
    tags,
  };
}

/**
 * The overlap warning. Local agent traffic that was billed to an API key is in a
 * platform total too, and this tool cannot tell which rows those are — the logs
 * carry no key id. Saying so is the only honest option.
 */
export function localOverlapDiagnostic(platforms: readonly string[]): Diagnostic {
  return {
    provider: 'ccusage',
    level: 'warning',
    code: 'local-overlap-possible',
    message: `Local agent usage is included alongside ${platforms.join(', ')}. Any agent billed through one of those platforms’ API keys is counted twice: ccusage cannot say which key a session used. Subscription-billed agents (Claude Max, Codex plans) do not overlap.`,
  };
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0];
  return line ? ` (${line})` : '';
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}` : error.message;
  }
  return String(error);
}

/** The real runner: no shell, fixed argv, output capped. */
const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
          // ENOENT and friends mean "not installed", which is a different answer
          // from "ran and failed".
          reject(error);
          return;
        }
        const code =
          error && typeof (error as { code?: number }).code === 'number'
            ? ((error as { code?: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });

export { DECLARED as CCUSAGE_CAPABILITIES, runCommand };
