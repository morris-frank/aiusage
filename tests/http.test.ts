import { describe, expect, it } from 'vitest';
import { buildQuery, HttpClient, HttpError, redact } from '../src/index.js';
import { stubFetch } from './helpers/http.js';

describe('buildQuery', () => {
  it('repeats array params for OpenAI', () => {
    expect(buildQuery({ group_by: ['model', 'project_id'], limit: 7 }, 'repeat')).toBe(
      '?group_by=model&group_by=project_id&limit=7',
    );
  });

  it('brackets array params for Anthropic', () => {
    expect(buildQuery({ group_by: ['model'] }, 'bracket')).toBe('?group_by%5B%5D=model');
  });

  it('drops undefined but keeps false and zero', () => {
    expect(buildQuery({ a: undefined, b: false, c: 0 })).toBe('?b=false&c=0');
  });

  it('returns an empty string for an empty query', () => {
    expect(buildQuery({})).toBe('');
  });
});

describe('redact', () => {
  it('removes known secrets and anything key-shaped', () => {
    const text = 'failed with sk-admin-abcdefghijklmnop and token supersecretvalue123';
    const output = redact(text, ['supersecretvalue123']);
    expect(output).not.toContain('supersecretvalue123');
    expect(output).not.toContain('sk-admin-abcdefghijklmnop');
    expect(output).toContain('[redacted]');
  });

  it('ignores short strings that would redact half the message', () => {
    expect(redact('cost was 12', ['12'])).toBe('cost was 12');
  });
});

describe('HttpClient', () => {
  it('retries a 429 and returns the eventual body', async () => {
    const fetchImpl = stubFetch([
      { when: '/usage', status: 429, body: { error: 'slow down' }, times: 2 },
      { when: '/usage', body: { data: ['ok'] } },
    ]);
    const client = new HttpClient({ fetchImpl, sleep: async () => {} });

    await expect(client.json('https://example.test/usage')).resolves.toEqual({ data: ['ok'] });
    expect(fetchImpl.calls).toHaveLength(3);
  });

  it('does not retry a 401 — the credential will not improve', async () => {
    const fetchImpl = stubFetch([{ when: '/usage', status: 401, body: { error: 'nope' } }]);
    const client = new HttpClient({ fetchImpl, sleep: async () => {} });

    await expect(client.json('https://example.test/usage')).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('gives up after the retry budget and reports the status', async () => {
    const fetchImpl = stubFetch([{ when: '/usage', status: 503, body: { error: 'down' } }]);
    const client = new HttpClient({ fetchImpl, sleep: async () => {}, maxRetries: 1 });

    const error = await client
      .json('https://example.test/usage')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('keeps secrets out of error messages', async () => {
    const secret = 'sk-test-secret-value';
    const fetchImpl = stubFetch([
      { when: '/usage', status: 400, body: { error: `bad key ${secret}` } },
    ]);
    const client = new HttpClient({ fetchImpl, sleep: async () => {}, secrets: [secret] });

    const error = await client
      .json(`https://example.test/usage?key=${secret}`)
      .catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).toContain('[redacted]');
  });

  it('flags auth failures distinctly from other errors', () => {
    expect(new HttpError(403, 'u', 'b').isAuthFailure).toBe(true);
    expect(new HttpError(400, 'u', 'b').isAuthFailure).toBe(false);
  });

  it('sends a JSON body as POST when one is given', async () => {
    const fetchImpl = stubFetch([{ when: '/analytics/query', body: { data: { data: [] } } }]);
    const client = new HttpClient({ fetchImpl, sleep: async () => {} });

    await client.json('https://example.test/analytics/query', { body: { metrics: ['cost'] } });
    expect(fetchImpl.calls[0]).toContain('/analytics/query');
  });
});
