import type { HttpClient } from '../http.js';
import type { DateRange, ProviderCapabilities, ProviderId, ProviderResult } from '../types.js';

export type CollectContext = {
  http: HttpClient;
  /** Inclusive calendar-date window the caller asked for. */
  range: DateRange;
  /** Timezone the caller will group rows in; drives bucket-width choice. */
  timeZone: string;
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
