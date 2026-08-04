import type { HttpClient } from '../http.js';
import type { DateRange, ProviderCapabilities, ProviderId, ProviderResult } from '../types.js';

export type CollectContext = {
  http: HttpClient;
  /** Inclusive calendar-date window the caller asked for. */
  range: DateRange;
  /** Timezone the caller will group rows in; drives bucket-width choice. */
  timeZone: string;
  /**
   * Ask for sub-daily buckets wherever the platform has them, so time-of-day
   * statistics have something to stand on. Off by default because it is not
   * free: an hourly window is 24× the buckets and several times the pages of
   * the same window in days, for a shape the daily/weekly/monthly commands
   * never draw. A platform without hourly buckets ignores this and says so via
   * `ProviderCapabilities.hourly`.
   */
  hourlyBuckets: boolean;
  /** Max in-flight requests this provider may use. */
  concurrency: number;
  /** Injected clock, so runs are reproducible in tests. */
  now: Date;
};

export interface Provider {
  readonly id: ProviderId;
  /**
   * What the platform could answer with ideal credentials. The *actual*
   * capabilities of a run are returned from `collect`, since they depend on the
   * kind of key configured.
   */
  readonly declaredCapabilities: ProviderCapabilities;
  collect(context: CollectContext): Promise<ProviderResult>;
}
