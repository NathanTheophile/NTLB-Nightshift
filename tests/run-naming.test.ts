import { describe, expect, it } from 'vitest';

import { candidateBranchForRunName, readableRunNameWithSuffix, readableRunSlug } from '../src/main/services/RunNaming';

describe('human-readable Run naming', () => {
  it('creates lowercase ASCII-safe slugs', () => {
    expect(readableRunSlug('Improve Delegated Leader Run observability')).toBe('improve-delegated-leader-run-observability');
    expect(readableRunSlug('Été / déjà-vu — UI!!!')).toBe('ete-deja-vu-ui');
  });

  it('bounds names, provides a deterministic fallback, and keeps numeric collision suffixes readable', () => {
    expect(readableRunSlug('***')).toBe('run');
    expect(readableRunSlug('x'.repeat(200))).toHaveLength(64);
    expect(readableRunNameWithSuffix('foo', 1)).toBe('foo');
    expect(readableRunNameWithSuffix('foo', 2)).toBe('foo-2');
    expect(readableRunNameWithSuffix('x'.repeat(64), 123)).toHaveLength(64);
    expect(candidateBranchForRunName('foo-2')).toBe('nightshift/run/foo-2');
  });
});
