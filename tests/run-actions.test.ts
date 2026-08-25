import { describe, expect, it } from 'vitest';

import { canCancelRun, normalizeFollowUpPrompt } from '../src/shared/domain/runActions';

describe('Run action UI policy', () => {
  it('offers cancellation only while a Run is preparing or running', () => {
    expect(canCancelRun('preparing')).toBe(true);
    expect(canCancelRun('running')).toBe(true);
    expect(canCancelRun('cancel_requested')).toBe(false);
    expect(canCancelRun('cancelled')).toBe(false);
    expect(canCancelRun('completed')).toBe(false);
  });

  it('rejects empty follow-up prompts before creating a Run', () => {
    expect(normalizeFollowUpPrompt('  \n  ')).toBeNull();
    expect(normalizeFollowUpPrompt('  Correct the test failure.  ')).toBe('Correct the test failure.');
  });
});
