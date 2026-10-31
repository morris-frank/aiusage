/**
 * The local ledger: a floor under local agent usage.
 *
 * ccusage reads the agents' own logs, and those logs are not permanent — Claude
 * Code deletes transcripts after `cleanupPeriodDays` (30 by default), and a
 * day's usage silently shrinks or vanishes from every later run. The ledger
 * keeps every (day × agent × model) row ccusage has ever reported, and a run
 * reports whichever of the live row and the ledger row holds more tokens. So a
 * local total only goes up as logs disappear, and every row that came from the
 * ledger rather than the logs says so (`tags.source: "ccusage-ledger"`).
 *
 * Whole rows are taken, never mixed field by field: a row is a figure ccusage
 * once stated, not one assembled here. Rows are keyed by the report timezone
 * too, because the same usage bucketed in two timezones would otherwise be
 * counted twice.
 *
 * A row may carry a `note` — how it got there when ccusage did not write it
 * (a restore from earlier reports). It travels into `tags.ledgerNote`. A noted
 * row is usage the logs never held again, so it sits beside the recorded row
 * for the same day, agent and model rather than competing with it.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { zonedDayEnd, zonedDayStart } from '../dates.js';
import type { Diagnostic, UsageRecord } from '../types.js';
import type { CollectContext } from './types.js';

type LedgerRow = {
  timeZone: string;
  bucketStart: string;
  bucketEnd: string;
  agent: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  costMicros: number | null;
  note?: string;
};

type LedgerFile = { version: 1; rows: LedgerRow[] };

export async function mergeWithLedger(
  path: string,
  live: readonly UsageRecord[],
  context: CollectContext,
): Promise<{ records: UsageRecord[]; diagnostics: Diagnostic[] }> {
  let ledger: LedgerFile;
  try {
    ledger = await read(path);
  } catch (error) {
    // An unreadable ledger is never overwritten: that would erase the floor.
    return {
      records: [...live],
      diagnostics: [
        {
          provider: 'ccusage',
          level: 'warning',
          code: 'local-ledger-unreadable',
          message: `The local ledger could not be read (${error instanceof Error ? error.message : String(error)}); local usage is what the agent logs hold today, which may be less than before.`,
        },
      ],
    };
  }

  const rows = new Map(ledger.rows.map((row) => [keyOf(row), row]));
  const windowStart = zonedDayStart(context.range.since, context.timeZone).toISOString();
  const windowEnd = zonedDayEnd(context.range.until, context.timeZone).toISOString();
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let fromLedger = 0;
  let ledgerTokens = 0;

  for (const record of live) {
    const row = toRow(record, context.timeZone);
    const key = keyOf(row);
    seen.add(key);
    const kept = rows.get(key);
    if (kept && tokensOf(kept) > tokensOf(row)) {
      records.push(toRecord(kept));
      fromLedger += 1;
      ledgerTokens += tokensOf(kept) - tokensOf(row);
    } else {
      records.push(record);
      rows.set(key, row);
    }
  }
  for (const [key, row] of rows) {
    if (seen.has(key) || row.timeZone !== context.timeZone) continue;
    if (row.bucketStart < windowStart || row.bucketStart >= windowEnd) continue;
    records.push(toRecord(row));
    fromLedger += 1;
    ledgerTokens += tokensOf(row);
  }

  const diagnostics: Diagnostic[] = [];
  try {
    await write(path, { version: 1, rows: [...rows.values()] });
  } catch (error) {
    diagnostics.push({
      provider: 'ccusage',
      level: 'warning',
      code: 'local-ledger-unwritable',
      message: `The local ledger could not be updated (${error instanceof Error ? error.message : String(error)}); this run's local rows are not protected against later log deletion.`,
    });
  }
  if (fromLedger > 0) {
    diagnostics.push({
      provider: 'ccusage',
      level: 'info',
      code: 'local-ledger-used',
      message: `${fromLedger} local row(s) come from the ledger, adding ${ledgerTokens} tokens the agent logs no longer hold (deleted or shrunk since they were recorded).`,
    });
  }
  return { records, diagnostics };
}

async function read(path: string): Promise<LedgerFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, rows: [] };
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<LedgerFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.rows)) {
    throw new Error('not a version 1 ledger');
  }
  return { version: 1, rows: parsed.rows };
}

/** Written beside itself and renamed, so a crash never leaves half a ledger. */
async function write(path: string, ledger: LedgerFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 1)}\n`, 'utf8');
  await rename(temporary, path);
}

function keyOf(row: LedgerRow): string {
  return [row.timeZone, row.bucketStart, row.agent ?? '', row.model ?? '', row.note ?? ''].join(
    '\u0000',
  );
}

function tokensOf(row: LedgerRow): number {
  return row.input + row.output + row.cacheCreation + row.cacheRead;
}

function toRow(record: UsageRecord, timeZone: string): LedgerRow {
  return {
    timeZone,
    bucketStart: record.bucketStart,
    bucketEnd: record.bucketEnd,
    agent: record.tags.agent ?? null,
    model: record.model,
    input: record.tokens.input,
    output: record.tokens.output,
    cacheCreation: record.tokens.cacheCreation,
    cacheRead: record.tokens.cacheRead,
    costMicros: record.reportedCostMicros,
  };
}

function toRecord(row: LedgerRow): UsageRecord {
  const tags: Record<string, string> = { source: 'ccusage-ledger' };
  if (row.agent) tags.agent = row.agent;
  if (row.note) tags.ledgerNote = row.note;
  return {
    provider: 'ccusage',
    bucketStart: row.bucketStart,
    bucketEnd: row.bucketEnd,
    model: row.model,
    account: null,
    apiKey: null,
    workspace: null,
    tokens: {
      input: row.input,
      output: row.output,
      cacheCreation: row.cacheCreation,
      cacheRead: row.cacheRead,
      reasoning: 0,
    },
    requests: null,
    reportedCostMicros: row.costMicros,
    costBasis: 'imported',
    extras: {},
    tags,
  };
}
