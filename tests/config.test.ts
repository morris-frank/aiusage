import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * The OpenRouter credential family. A provisioning key is scoped to one
 * workspace, so an org with several workspaces has several keys — and getting
 * that list wrong either loses a workspace or counts one twice.
 */
describe('OpenRouter credentials', () => {
  it('is absent, not empty, when nothing is set', () => {
    expect(loadConfig({}).credentials.openrouter).toBeNull();
  });

  it('reads a management key and an inference key as two credentials', () => {
    const { credentials } = loadConfig({
      OPENROUTER_API_KEY: 'sk-or-v1-inference',
      OPENROUTER_MANAGEMENT_KEY: 'sk-or-v1-management',
    });
    expect(credentials.openrouter?.keys).toEqual([
      {
        label: 'inference',
        secret: 'sk-or-v1-inference',
        declaredKind: 'inference',
        labelled: false,
      },
      {
        label: 'management',
        secret: 'sk-or-v1-management',
        declaredKind: 'management',
        labelled: false,
      },
    ]);
  });

  it('takes one labelled management key per workspace', () => {
    const { credentials } = loadConfig({
      OPENROUTER_MANAGEMENT_KEY_ACME: 'sk-or-v1-acme',
      OPENROUTER_MANAGEMENT_KEY_BETA_LABS: 'sk-or-v1-beta',
    });
    expect(credentials.openrouter?.keys.map((key) => [key.label, key.labelled])).toEqual([
      ['acme', true],
      ['beta_labs', true],
    ]);
  });

  it('accepts OpenRouter’s own name for a management key', () => {
    const { credentials } = loadConfig({ OPENROUTER_PROVISIONING_KEY: 'sk-or-v1-prov' });
    expect(credentials.openrouter?.keys[0]?.declaredKind).toBe('management');
  });

  it('splits a comma- or space-separated list into separate keys', () => {
    const { credentials } = loadConfig({
      OPENROUTER_MANAGEMENT_KEY: 'sk-or-v1-one, sk-or-v1-two',
    });
    expect(credentials.openrouter?.keys.map((key) => [key.label, key.secret])).toEqual([
      ['management-1', 'sk-or-v1-one'],
      ['management-2', 'sk-or-v1-two'],
    ]);
  });

  it('counts the same key set twice as one key', () => {
    const { credentials } = loadConfig({
      OPENROUTER_API_KEY: 'sk-or-v1-same',
      OPENROUTER_MANAGEMENT_KEY: 'sk-or-v1-same',
    });
    expect(credentials.openrouter?.keys).toHaveLength(1);
  });

  it('lists every key as a secret to redact', () => {
    const config = loadConfig({
      OPENROUTER_MANAGEMENT_KEY_ACME: 'sk-or-v1-acme',
      OPENROUTER_API_KEY: 'sk-or-v1-inference',
    });
    expect(config.secrets).toContain('sk-or-v1-acme');
    expect(config.secrets).toContain('sk-or-v1-inference');
  });
});

describe('local source configuration', () => {
  it('discovers ccusage by default', () => {
    expect(loadConfig({}).ccusageCommand).toBeNull();
  });

  it('takes an explicit command as an argv, not a shell line', () => {
    expect(loadConfig({ AIUSAGE_CCUSAGE_CMD: 'bunx ccusage@latest' }).ccusageCommand).toEqual([
      'bunx',
      'ccusage@latest',
    ]);
  });
});
