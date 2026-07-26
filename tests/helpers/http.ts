import { type FetchLike, HttpClient } from '../../src/index.js';

export type StubRoute = {
  /** Substring the request URL must contain (path and/or query). */
  when: string;
  /** Additional substrings that must all be present — for query matching. */
  and?: string[];
  status?: number;
  body: unknown;
  /** Number of times this route may serve before the next matching one is used. */
  times?: number;
};

export type StubFetch = FetchLike & {
  calls: string[];
};

/**
 * A fetch that answers from a route table and records every URL it was asked
 * for. Routes are matched in order and consumed when `times` is set, which is
 * how retry and pagination behaviour is asserted without a server.
 */
export function stubFetch(routes: StubRoute[]): StubFetch {
  const remaining = routes.map((route) => ({
    ...route,
    left: route.times ?? Number.POSITIVE_INFINITY,
  }));
  const calls: string[] = [];

  const impl = (async (url: string) => {
    calls.push(url);
    const route = remaining.find(
      (candidate) =>
        candidate.left > 0 &&
        url.includes(candidate.when) &&
        (candidate.and ?? []).every((fragment) => url.includes(fragment)),
    );
    if (!route) {
      return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 599 });
    }
    route.left -= 1;
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as StubFetch;

  impl.calls = calls;
  return impl;
}

/** An HttpClient wired to a stub, with retry sleeps collapsed to nothing. */
export function stubClient(routes: StubRoute[]): { http: HttpClient; fetch: StubFetch } {
  const fetchImpl = stubFetch(routes);
  return {
    fetch: fetchImpl,
    http: new HttpClient({ fetchImpl, sleep: async () => {}, secrets: ['sk-test-secret-value'] }),
  };
}
