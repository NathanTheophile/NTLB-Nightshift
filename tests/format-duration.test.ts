import { describe, expect, test } from 'vitest';
import { formatDuration } from '../src/shared/domain/formatDuration';

describe('formatDuration', () => {
  test('returns <1s for less than 1 second', () => {
    expect(formatDuration(0)).toBe('<1s');
    expect(formatDuration(1)).toBe('<1s');
    expect(formatDuration(9)).toBe('<1s');
    expect(formatDuration(99)).toBe('<1s');
    expect(formatDuration(999)).toBe('<1s');
  });

  test('returns whole seconds for 1 to 59 seconds', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(1500)).toBe('1s');
    expect(formatDuration(2000)).toBe('2s');
    expect(formatDuration(59000)).toBe('59s');
    expect(formatDuration(59999)).toBe('59s');
  });

  test('returns minutes and seconds for 60 seconds or more', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(61000)).toBe('1m 1s');
    expect(formatDuration(119000)).toBe('1m 59s');
    expect(formatDuration(120000)).toBe('2m 0s');
    expect(formatDuration(3599000)).toBe('59m 59s');
    expect(formatDuration(3600000)).toBe('60m 0s');
  });

  test('treats negative and non-finite values as 0', () => {
    expect(formatDuration(-1)).toBe('<1s');
    expect(formatDuration(-1000)).toBe('<1s');
    expect(formatDuration(NaN)).toBe('<1s');
    expect(formatDuration(Infinity)).toBe('<1s');
    expect(formatDuration(-Infinity)).toBe('<1s');
  });
});