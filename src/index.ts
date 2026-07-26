/**
 * Library entry point.
 *
 * `aiusage` is a CLI first, but the collection → costing → aggregation pipeline
 * is plain functions over plain data, so it is usable directly: collect once and
 * aggregate several ways, or feed the records into something else. The HTTP
 * client is injectable, which is how the test suite runs against fixtures.
 */

export {
  type AggregateOptions,
  addTokens,
  aggregateByDimension,
  aggregateByPeriod,
  type Bucket,
  type CostSourceSummary,
  type PeriodBucket,
  SPLIT_DIMENSIONS,
  type SplitDimension,
  summarizeCostSource,
  totalsOf,
  totalTokens,
} from './aggregate.js';
export { type Collection, type CollectOptions, collectUsage, createHttpClient } from './collect.js';
export {
  ConfigError,
  CREDENTIAL_ENV_VARS,
  type Credentials,
  configuredProviders,
  loadConfig,
  type RuntimeConfig,
} from './config.js';
export {
  applyCosts,
  type CostedRecord,
  type CostingResult,
  type CostSource,
  deriveCost,
  type UnattributedCost,
} from './cost.js';
export {
  addDays,
  DateInputError,
  dayKey,
  defaultRange,
  isValidTimeZone,
  monthKey,
  parseDateInput,
  periodKey,
  weekKey,
} from './dates.js';
export {
  type ArrayFormat,
  buildQuery,
  type FetchLike,
  HttpClient,
  type HttpClientConfig,
  HttpError,
  type RequestOptions,
  redact,
} from './http.js';
export { allocateProportionally, formatUsd, microsToUsd, usdToMicros } from './money.js';
export {
  createCompositePriceBook,
  EMPTY_PRICE_BOOK,
  loadPriceBook,
  type ModelPrice,
  type PriceBook,
  type PriceLookup,
} from './pricing/index.js';
export { createProviders, DECLARED_CAPABILITIES, type Provider } from './providers/index.js';
export {
  buildDimensionReport,
  buildPeriodReport,
  type DimensionReport,
  type PeriodReport,
  type ReportMeta,
  type ReportOptions,
  type ReportRow,
  type ReportTotals,
} from './report.js';
export * from './types.js';
export { VERSION } from './version.js';
