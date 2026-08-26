import { describe, expect, test } from 'vitest';
import { formatRunDuration } from '../src/shared/domain/formatRunDuration';

describe('formatRunDuration', () => {
  test('negative or non-finite values treated as 0', () => {
    expect(formatRunDuration(-1)).toBe('<1s');
    expect(formatRunDuration(-1000)).toBe('<1s');
    expect(formatRunDuration(NaN)).toBe('<1s');
    expect(formatRunDuration(Infinity)).toBe('<1s');
    expect(formatRunDuration(-Infinity)).toBe('<1s');
  });

  test('less than 1 second returns "<1s"', () => {
    expect(formatRunDuration(0)).toBe('<1s');
    expect(formatRunDuration(1)).toBe('<1s');
    expect(formatRunDuration(9)).toBe('<1s');
    expect(formatRunDuration(99)).toBe('<1s');
    expect(formatRunDuration(999)).toBe('<1s');
  });

  test('1-59 seconds returns whole seconds with "s" suffix', () => {
    expect(formatRunDuration(1000)).toBe('1s');
    expect(formatRunDuration(1500)).toBe('1s'); // floor to 1 second
    expect(formatRunDuration(2000)).toBe('2s');
    expect(formatRunDuration(30000)).toBe('30s');
    expect(formatRunDuration(59000)).toBe('59s');
    expect(formatRunDuration(59999)).toBe('59s');
  });

  test('60 seconds or more returns whole minutes and remaining whole seconds', () => {
    expect(formatRunDuration(60000)).toBe('1m'); // exactly 1 minute
    expect(formatRunDuration(61000)).toBe('1m 1s');
    expect(formatRunDuration(119000)).toBe('1m 59s'); // 1m59s
    expect(formatRunDuration(120000)).toBe('2m'); // exactly 2 minutes
    expect(formatRunDuration(121000)).toBe('2m 1s');
  });

  test('60 minutes or more uses hours, minutes, and seconds', () => {
    expect(formatRunDuration(3600000)).toBe('1h'); // exactly 1 hour
    expect(formatRunDuration(3660000)).toBe('1h 1m'); // 1h 1m
    expect(formatRunDuration(3660000 + 30000)).toBe('1h 1m 30s'); // 1h 1m 30s
    expect(formatRunDuration(7200000)).toBe('2h'); // exactly 2 hours
    expect(formatRunDuration(7260000)).toBe('2h 1m'); // 2h 1m
    expect(formatRunDuration(7260000 + 30000)).toBe('2h 1m 30s'); // 2h 1m 30s
    // Test with seconds only when minutes and hours are zero? Already covered above.
  });

  test('exact whole minutes omit zero seconds', () => {
    expect(formatRunDuration(60000)).toBe('1m');
    expect(formatRunDuration(120000)).toBe('2m');
    expect(formatRunDuration(3600000)).toBe('1h');
    expect(formatRunDuration(7200000)).toBe('2h');
    expect(formatRunDuration(3660000)).toBe('1h 1m'); // minutes present, no seconds
    expect(formatRunDuration(7260000)).toBe('2h 1m');
  });

  test('edge case: 59 seconds 999 ms still shows as 59s', () => {
    expect(formatRunDuration(59999)).toBe('59s');
  });

  test('edge case: 60 seconds exactly shows as 1m', () => {
    expect(formatRunDuration(60000)).toBe('1m');
  });

  test('edge case: 3599 seconds 999 ms shows as 59m 59s', () => {
    // 3599.999 seconds -> floor to 3599 seconds -> 59 minutes 59 seconds
    expect(formatRunDuration(3599999)).toBe('59m 59s');
  });

  test('edge case: 3600 seconds exactly shows as 1h', () => {
    expect(formatRunDuration(3600000)).toBe('1h');
  });

  test('edge case: 3600001 ms shows as 1h 0m 0s? Actually 3600001 ms -> 3600 seconds and 1 ms -> floor 3600 seconds -> 1h', () => {
    expect(formatRunDuration(3600001)).toBe('1h');
  });

  test('edge case: 3660000 ms shows as 1h 1m', () => {
    expect(formatRunDuration(3660000)).toBe('1h 1m');
  });

  test('edge case: 3660001 ms shows as 1h 1m', () => {
    expect(formatRunDuration(3660001)).toBe('1h 1m');
  });

  test('edge case: 3661000 ms shows as 1h 1m 1s', () => {
    expect(formatRunDuration(3661000)).toBe('1h 1m 1s');
  });
});