/**
 * Local-date helpers.
 *
 * Every tool with an optional `date` argument falls back to "today", which is
 * only meaningful in a specific zone. The original Fitbit-era implementation
 * hardcoded JST; this version reads the deployment's zone from the `TIMEZONE`
 * variable in wrangler.toml so a fork runs correctly wherever its owner lives.
 */

/** IANA zone used when no date is supplied. Overridden once per request. */
let activeTimeZone = 'UTC';

/**
 * Set the zone used by `today()`. Called from `buildServer(env)`.
 *
 * The value is a deployment-wide constant, so holding it at module scope is
 * safe even though a Worker isolate can serve more than one request.
 */
export function setTimeZone(tz: string | undefined): void {
  activeTimeZone = tz && tz.trim() !== '' ? tz : 'UTC';
}

export function getTimeZone(): string {
  return activeTimeZone;
}

/**
 * Format a Date/ms/ISO input as `YYYY-MM-DD` in the given IANA zone.
 *
 * `en-CA` is used because it formats as `YYYY-MM-DD` natively, which avoids
 * reassembling parts by hand. An unknown zone would make `Intl` throw, so it
 * falls back to UTC rather than failing the tool call.
 */
export function toLocalDateString(
  input: Date | string | number = new Date(),
  timeZone: string = activeTimeZone,
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Invalid date input: ${String(input)}`);
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Today's date in the configured zone, as `YYYY-MM-DD`. */
export function today(timeZone: string = activeTimeZone): string {
  return toLocalDateString(new Date(), timeZone);
}

/**
 * Offset of `timeZone` from UTC at a given instant, in milliseconds.
 *
 * Derived by formatting the instant in that zone and reading the wall-clock
 * back, so DST is handled by the platform rather than by a table here.
 */
export function zoneOffsetMs(instant: Date, timeZone?: string): number {
  timeZone = timeZone ?? activeTimeZone;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
    const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
    // hour can come back as 24 at midnight in some ICU versions.
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return asUtc - instant.getTime();
  } catch {
    return 0; // unknown zone -> behave as UTC
  }
}

/**
 * The UTC instants bounding a local calendar day, as `[start, end)`.
 *
 * Needed because instant-valued data (heart rate samples, weight readings) is
 * filtered on true UTC time, while a user means their own midnight. In
 * Europe/London during summer, "10 September" starts at 23:00Z on the 9th.
 *
 * The offset is resolved twice: once from the naive guess and once from the
 * corrected instant, so a day that begins on a DST boundary still lands right.
 */
export function localDayStartUtc(date: string, timeZone?: string): Date {
  timeZone = timeZone ?? activeTimeZone;
  const naive = Date.parse(`${date}T00:00:00Z`);
  const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
  const refined = naive - zoneOffsetMs(new Date(firstPass), timeZone);
  return new Date(refined);
}

/** Format an instant as local `HH:mm:ss` in the configured zone. */
export function toLocalTimeString(instant: Date | number, timeZone?: string): string {
  timeZone = timeZone ?? activeTimeZone;
  const d = instant instanceof Date ? instant : new Date(instant);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(11, 19);
  }
}

const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function assertIsoDate(value: string, field = 'date'): asserts value is string {
  if (!ISO_DATE_RE.test(value)) {
    throw new RangeError(`${field} must be YYYY-MM-DD (got: ${value})`);
  }
}

/**
 * Return `start,end` as YYYY-MM-DD after validating both are present and
 * `start <= end`.
 */
export function normalizeRange(start: string, end: string): { start: string; end: string } {
  assertIsoDate(start, 'start');
  assertIsoDate(end, 'end');
  if (start > end) {
    throw new RangeError(`Range is inverted: start=${start} > end=${end}`);
  }
  return { start, end };
}
