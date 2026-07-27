import { describe, expect, it } from 'vitest';
import { canonicalModelId, stripDateSuffix, stripVendorPrefix } from '../src/models.js';

describe('stripVendorPrefix', () => {
  it('drops an OpenRouter-style vendor prefix', () => {
    expect(stripVendorPrefix('anthropic/claude-opus-5')).toBe('claude-opus-5');
    expect(stripVendorPrefix('openai/gpt-5.6')).toBe('gpt-5.6');
  });

  it('leaves a bare id untouched', () => {
    expect(stripVendorPrefix('claude-opus-5')).toBe('claude-opus-5');
  });
});

describe('stripDateSuffix', () => {
  it('drops a trailing YYYYMMDD or YYYY-MM-DD pinned-snapshot date', () => {
    expect(stripDateSuffix('claude-opus-5-20260315')).toBe('claude-opus-5');
    expect(stripDateSuffix('claude-opus-5-2026-03-15')).toBe('claude-opus-5');
  });

  it('leaves an id with no date suffix untouched', () => {
    expect(stripDateSuffix('gpt-5.6-terra')).toBe('gpt-5.6-terra');
  });

  it('only strips a date suffix at the very end, not a date-like substring mid-id', () => {
    expect(stripDateSuffix('gpt-20260315-preview')).toBe('gpt-20260315-preview');
  });
});

describe('canonicalModelId', () => {
  it('merges an OpenRouter-prefixed id with a first-party platform id for the same model', () => {
    expect(canonicalModelId('anthropic/claude-opus-5')).toBe(canonicalModelId('claude-opus-5'));
    expect(canonicalModelId('openai/gpt-5.6')).toBe(canonicalModelId('gpt-5.6'));
  });

  it('merges a pinned-snapshot dated id with its undated form, vendor prefix and all', () => {
    expect(canonicalModelId('anthropic/claude-opus-5-20260315')).toBe(
      canonicalModelId('claude-opus-5'),
    );
  });

  it('does not merge genuinely different models', () => {
    expect(canonicalModelId('anthropic/claude-opus-5')).not.toBe(
      canonicalModelId('anthropic/claude-haiku-5'),
    );
  });
});
