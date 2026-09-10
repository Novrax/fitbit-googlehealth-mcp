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
