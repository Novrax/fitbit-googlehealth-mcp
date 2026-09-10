import { afterEach, describe, expect, it } from 'vitest';
import {
  assertIsoDate,
  getTimeZone,
  normalizeRange,
  setTimeZone,
  today,
  toLocalDateString,
} from '../../src/lib/date';

afterEach(() => setTimeZone('UTC'));

describe('toLocalDateString', () => {
  it('formats an epoch instant in the requested zone', () => {
    // 1970-01-01T00:00:00Z is already 09:00 on the 1st in Tokyo.
    expect(toLocalDateString(0, 'Asia/Tokyo')).toBe('1970-01-01');
    // ...but still 1969-12-31 in New York.
    expect(toLocalDateString(0, 'America/New_York')).toBe('1969-12-31');
    expect(toLocalDateString(0, 'UTC')).toBe('1970-01-01');
  });

  it('rolls the local day over at the zone boundary, not at UTC midnight', () => {
    expect(toLocalDateString('2026-04-22T15:00:00Z', 'Asia/Tokyo')).toBe('2026-04-23');
    expect(toLocalDateString('2026-04-22T14:59:59Z', 'Asia/Tokyo')).toBe('2026-04-22');
  });

  it('respects a zone that is behind UTC', () => {
    // 00:30 UTC is still the previous evening in Los Angeles.
    expect(toLocalDateString('2026-09-10T00:30:00Z', 'America/Los_Angeles')).toBe('2026-09-09');
  });

  it('handles a British Summer Time offset', () => {
    expect(toLocalDateString('2026-06-15T23:30:00Z', 'Europe/London')).toBe('2026-06-16');
    expect(toLocalDateString('2026-01-15T23:30:00Z', 'Europe/London')).toBe('2026-01-15');
  });

  it('falls back to UTC rather than throwing on an unknown zone', () => {
    expect(toLocalDateString('2026-04-22T12:00:00Z', 'Not/AZone')).toBe('2026-04-22');
  });

  it('throws on invalid input', () => {
    expect(() => toLocalDateString('not-a-date')).toThrow(RangeError);
  });
});

describe('setTimeZone / today', () => {
  it('defaults to UTC when given nothing', () => {
    setTimeZone(undefined);
    expect(getTimeZone()).toBe('UTC');
    setTimeZone('');
    expect(getTimeZone()).toBe('UTC');
  });

  it('makes today() follow the configured zone', () => {
    setTimeZone('Asia/Tokyo');
    expect(today()).toBe(toLocalDateString(new Date(), 'Asia/Tokyo'));
    setTimeZone('America/New_York');
    expect(today()).toBe(toLocalDateString(new Date(), 'America/New_York'));
  });

  it('returns a 10-char YYYY-MM-DD', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('assertIsoDate', () => {
  it.each(['2026-01-01', '2026-12-31', '2024-02-29'])('accepts %s', (v) => {
    expect(() => assertIsoDate(v)).not.toThrow();
  });

  it.each([
    '2026-13-01',
    '2026-00-01',
    '2026-01-32',
    '2026-1-1',
    '2026/01/01',
    '',
    '2026-04-22T00:00:00Z',
  ])('rejects %s', (v) => {
    expect(() => assertIsoDate(v)).toThrow(RangeError);
  });
});

describe('normalizeRange', () => {
  it('returns both dates when start <= end', () => {
    expect(normalizeRange('2026-04-01', '2026-04-22')).toEqual({
      start: '2026-04-01',
      end: '2026-04-22',
    });
    expect(normalizeRange('2026-04-22', '2026-04-22')).toEqual({
      start: '2026-04-22',
      end: '2026-04-22',
    });
  });

  it('throws when start > end', () => {
    expect(() => normalizeRange('2026-04-23', '2026-04-22')).toThrow(/inverted/);
  });

  it('throws when either date is malformed', () => {
    expect(() => normalizeRange('2026-4-1', '2026-04-22')).toThrow(RangeError);
    expect(() => normalizeRange('2026-04-01', 'tomorrow')).toThrow(RangeError);
  });
});
