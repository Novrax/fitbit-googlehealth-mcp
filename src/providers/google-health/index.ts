import type { Env } from '../../env';
import { toLocalTimeString } from '../../lib/date';
import { UnsupportedOperationError } from '../../lib/errors';
import type {
  ActivityResourceT,
  BodyFatLog,
  BodyLog,
  CardioFitness,
  DailySummary,
  Device,
  ExerciseLog,
  FoodLog,
  FoodLogEntry,
  HealthProvider,
  HeartRateDay,
  HeartRateIntraday,
  HeartRateZone,
  HrvDay,
  IntradayDetailLevelT,
  LogActivityInput,
  LogBodyFatInput,
  LogFoodInput,
  LogMealInput,
  LogSleepInput,
  LogWaterInput,
  LogWeightInput,
  Profile,
  RespiratoryRateDay,
  SkinTempDay,
  SleepLog,
  SpO2Day,
  TimeSeries,
  WaterLogEntry,
  WeightLog,
} from '../types';
import { addDays, GoogleHealthClient, maxPageSize, rollupRangeCapDays } from './client';
import { dayRangeFilter, type TimeField } from './filters';
import {
  durationMs,
  fromCivilDate,
  GOOGLE_TO_MEAL_TYPE_ID,
  kebabToCamel,
  MEAL_TYPE_TO_GOOGLE,
  NUTRIENT,
  nameToNumericId,
  num,
  pointDate,
  pointTimestamp,
  SLEEP_STAGE_TO_LEVEL,
} from './map';

type Row = Record<string, unknown>;

/**
 * Fitbit's activity time-series resources mapped onto Google Health data
 * types, plus the rollup field carrying the value and a scale onto the unit
 * Fitbit used. `undefined` marks a resource with no equivalent.
 */
const ACTIVITY_RESOURCE_MAP: Record<
  ActivityResourceT,
  { dataType: string; field: string; scale?: number } | undefined
> = {
  steps: { dataType: 'steps', field: 'countSum' },
  // Google reports distance in millimetres; Fitbit's series is kilometres.
  distance: { dataType: 'distance', field: 'millimetersSum', scale: 1 / 1_000_000 },
  calories: { dataType: 'total-calories', field: 'kcalSum' },
  caloriesBMR: { dataType: 'basal-energy-burned', field: 'kcalSum' },
  activityCalories: { dataType: 'active-energy-burned', field: 'kcalSum' },
  floors: { dataType: 'floors', field: 'countSum' },
  elevation: undefined,
  minutesSedentary: { dataType: 'activity-level', field: 'SEDENTARY' },
  minutesLightlyActive: { dataType: 'activity-level', field: 'LIGHTLY_ACTIVE' },
  minutesFairlyActive: { dataType: 'activity-level', field: 'MODERATELY_ACTIVE' },
  minutesVeryActive: { dataType: 'activity-level', field: 'VERY_ACTIVE' },
};

export class GoogleHealthProvider implements HealthProvider {
  private readonly client: GoogleHealthClient;
  /**
   * Resolved once from the environment rather than read from module state, so
   * the provider behaves identically however it is constructed — a silently
   * UTC-defaulted instance is the kind of bug that only shows up as data an
   * hour out of place.
   */
  private readonly timeZone: string;

  constructor(env: Env) {
    this.client = new GoogleHealthClient(env);
    this.timeZone = env.TIMEZONE?.trim() || 'UTC';
  }

  // ---------------------------------------------------------------- helpers

  private async list(
    dataType: string,
    timeField: TimeField,
    start: string,
    end: string,
    opts: { limit?: number } = {},
  ): Promise<Row[]> {
    const rows = await this.client.listAll(dataType, {
      filter: dayRangeFilter(dataType, timeField, start, end, this.timeZone),
      pageSize: Math.min(maxPageSize(dataType), 1000),
      limit: opts.limit,
    });
    return rows as Row[];
  }

  /**
   * List a data type and unwrap each DataPoint to its payload.
   *
   * A DataPoint nests its values under a camelCase key named for the type, so
   * a `daily-resting-heart-rate` row arrives as
   * `{dailyRestingHeartRate: {date, beatsPerMinute}}` rather than with those
   * fields at the top level. Reading the wrapper directly yields undefined for
   * every field, which is silent rather than loud, so every read goes through
   * here.
   */
  private async listPayloads(
    dataType: string,
    timeField: TimeField,
    start: string,
    end: string,
    opts: { limit?: number } = {},
  ): Promise<Row[]> {
    const rows = await this.list(dataType, timeField, start, end, opts);
    const key = kebabToCamel(dataType);
    return rows.map((r) => GoogleHealthProvider.unwrap(r, key));
  }

  /** Unwrap a DataPoint into its type-specific payload plus resource name. */
  private static unwrap(row: Row, key: string): Row {
    const payload = (row[key] ?? {}) as Row;
    return { ...payload, __name: row.name };
  }

  /**
   * Minutes spent at each activity level, per local day.
   *
   * `activity-level` rejects both rollup verbs ("DailyRollup is not supported
   * for data type activity-level"), so the individual periods are listed and
   * summed here instead.
   */
  private async activityLevelMinutesByDay(
    start: string,
    end: string,
  ): Promise<Map<string, Record<string, number>>> {
    const rows = await this.listPayloads('activity-level', 'interval', start, end);
    const byDay = new Map<string, Record<string, number>>();

    for (const row of rows) {
      const interval = (row.interval ?? {}) as Row;
      const level = String(row.activityLevelType ?? '');
      const day = pointDate(row);
      if (!level || !day) continue;

      const from = Date.parse(interval.startTime as string);
      const to = Date.parse(interval.endTime as string);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;

      const bucket = byDay.get(day) ?? {};
      bucket[level] = (bucket[level] ?? 0) + (to - from) / 60000;
      byDay.set(day, bucket);
    }

    for (const bucket of byDay.values()) {
      for (const k of Object.keys(bucket)) bucket[k] = Math.round(bucket[k] as number);
    }
    return byDay;
  }

  private assertRollupRange(dataType: string, start: string, end: string): void {
    const cap = rollupRangeCapDays(dataType);
    const days = Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
    );
    if (days > cap) {
      throw new UnsupportedOperationError(
        `Google Health caps ${dataType} rollups at ${cap} days per request; ${days} were requested.`,
        `Split the range into chunks of ${cap} days or fewer.`,
      );
    }
  }

  // ------------------------------------------------------------------ read

  async getProfile(): Promise<Profile> {
    // Fitbit returned identity, profile and unit settings from one endpoint;
    // Google splits them across three. Settings needs `settings.readonly`,
    // which a token minted before that scope was granted will not carry, so a
    // failure there degrades to a partial profile rather than failing the call.
    const [identity, profile, settings] = await Promise.all([
      this.getJsonOrEmpty('/users/me/identity'),
      this.getJsonOrEmpty('/users/me/profile'),
      this.getJsonOrEmpty('/users/me/settings'),
    ]);

    return {
      user: {
        encodedId: String(identity.legacyUserId ?? identity.healthUserId ?? ''),
        // `name` on these resources is the API resource path
        // ("users/123/settings"), not a human name — there is no display name
        // in the v4 profile, so leave it unset rather than echo a path.
        age: num(profile.age),
        timezone: (settings.timeZone as string) ?? undefined,
        locale: (settings.languageLocale as string) ?? undefined,
        memberSince: fromCivilDate(profile.membershipStartDate),
        offsetFromUTCMillis: durationMs(settings.utcOffset),
        heightUnit: (settings.heightUnit as string) ?? undefined,
        weightUnit: (settings.weightUnit as string) ?? undefined,
      },
    };
  }

  private async getJsonOrEmpty(path: string): Promise<Row> {
    try {
      return JSON.parse(await this.client.requestText({ path })) as Row;
    } catch {
      return {};
    }
  }

  async listDevices(): Promise<Device[]> {
    const text = await this.client.requestText({ path: '/users/me/pairedDevices' });
    const body = JSON.parse(text) as { pairedDevices?: Row[] };
    return (body.pairedDevices ?? []).map((d) => ({
      id: String(d.name ?? ''),
      deviceVersion: (d.deviceVersion as string) ?? undefined,
      type: (d.deviceType as string) ?? undefined,
      battery: (d.batteryStatus as string) ?? undefined,
      batteryLevel: num(d.batteryLevel),
      lastSyncTime: (d.lastSyncTime as string) ?? undefined,
      mac: (d.macAddress as string) ?? undefined,
      features: Array.isArray(d.features) ? (d.features as string[]) : undefined,
    }));
  }

  async getDailySummary(date: string): Promise<DailySummary> {
    // Fitbit served this from one endpoint; Google needs one rollup per
    // metric. They are independent, so fire them together and let a single
    // unavailable metric come back undefined rather than failing the summary.
    const [steps, calories, distance, floors, activity, azm, rhr] = await Promise.all([
      this.client.dailyRollUp('steps', date, date).catch(() => []),
      this.client.dailyRollUp('total-calories', date, date).catch(() => []),
      this.client.dailyRollUp('distance', date, date).catch(() => []),
      this.client.dailyRollUp('floors', date, date).catch(() => []),
      this.activityLevelMinutesByDay(date, date).catch(() => new Map()),
      this.client.dailyRollUp('active-zone-minutes', date, date).catch(() => []),
      this.listPayloads('daily-resting-heart-rate', 'daily', date, date).catch(() => []),
    ]);

    const levels = activity.get(date) ?? {};
    const distanceMm = num(pickRollup(distance[0], 'millimetersSum'));

    return {
      summary: {
        steps: num(pickRollup(steps[0], 'countSum')),
        caloriesOut: num(pickRollup(calories[0], 'kcalSum')),
        floors: num(pickRollup(floors[0], 'countSum')),
        distances:
          distanceMm === undefined
            ? undefined
            : [{ activity: 'total', distance: distanceMm / 1_000_000 }],
        sedentaryMinutes: levels.SEDENTARY,
        lightlyActiveMinutes: levels.LIGHTLY_ACTIVE,
        fairlyActiveMinutes: levels.MODERATELY_ACTIVE,
        veryActiveMinutes: levels.VERY_ACTIVE,
        restingHeartRate: num((rhr[0] as Row | undefined)?.beatsPerMinute),
        heartRateZones: readAzmZones(azm[0]),
      },
    };
  }

  async getActivityTimeSeries(
    resource: ActivityResourceT,
    start: string,
    end: string,
  ): Promise<TimeSeries> {
    const mapping = ACTIVITY_RESOURCE_MAP[resource];
    if (!mapping) {
      throw new UnsupportedOperationError(
        `Google Health has no equivalent for the "${resource}" time series.`,
        'Supported: steps, distance, calories, caloriesBMR, activityCalories, floors, and the four minutes* levels.',
      );
    }
    this.assertRollupRange(mapping.dataType, start, end);

    // activity-level has no rollup verb, so its series is summed from listed
    // periods instead.
    if (mapping.dataType === 'activity-level') {
      const byDay = await this.activityLevelMinutesByDay(start, end);
      const points = [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, levels]) => ({ dateTime: day, value: levels[mapping.field] ?? 0 }));
      return { resource, points };
    }

    const buckets = await this.client.dailyRollUp(mapping.dataType, start, end);
    const points = buckets.map((b) => {
      const raw = num(pickRollup(b, mapping.field));
      const scaled = raw === undefined ? 0 : raw * (mapping.scale ?? 1);
      return { dateTime: rollupDate(b) ?? start, value: scaled };
    });
    return { resource, points };
  }

  async getExerciseList(opts: { beforeDate?: string; limit?: number }): Promise<ExerciseLog[]> {
    // Fitbit paged backwards from a date; Google filters a window instead, so
    // a 90-day lookback stands in for "the most recent N".
    const end = opts.beforeDate ?? new Date().toISOString().slice(0, 10);
    const start = addDays(end, -90);
    const rows = await this.list('exercise', 'interval', start, end, { limit: opts.limit ?? 20 });

    return rows.map((row) => {
      const e = GoogleHealthProvider.unwrap(row, 'exercise');
      const metrics = (e.metricsSummary ?? {}) as Row;
      const distanceMm = num(metrics.distanceMillimeters);
      return {
        logId: nameToNumericId(e.__name),
        activityName: (e.displayName as string) ?? (e.exerciseType as string) ?? undefined,
        startTime: pointTimestamp(e),
        duration: durationMs(e.activeDuration),
        calories: num(metrics.caloriesKcal),
        steps: num(metrics.steps),
        distance: distanceMm === undefined ? undefined : distanceMm / 1_000_000,
        distanceUnit: 'km',
        averageHeartRate: num(metrics.averageHeartRateBeatsPerMinute),
      };
    });
  }

  async getHeartRateRange(start: string, end: string): Promise<HeartRateDay[]> {
    const rows = await this.listPayloads('daily-resting-heart-rate', 'daily', start, end);
    return rows.map((r) => ({
      dateTime: fromCivilDate(r.date) ?? start,
      value: { restingHeartRate: num(r.beatsPerMinute) },
    }));
  }

  async getHeartRateIntraday(
    date: string,
    detailLevel: IntradayDetailLevelT,
  ): Promise<HeartRateIntraday> {
    // Google exposes raw ~5-second samples with no detailLevel buckets, so the
    // requested granularity is produced here by down-sampling.
    const bucketSec = { '1sec': 1, '1min': 60, '5min': 300, '15min': 900 }[detailLevel];
    const rows = await this.list('heart-rate', 'sample', date, date);

    const buckets = new Map<number, { sum: number; n: number }>();
    for (const row of rows) {
      const hr = GoogleHealthProvider.unwrap(row, 'heartRate');
      const bpm = num(hr.beatsPerMinute);
      const ts = pointTimestamp(hr);
      if (bpm === undefined || !ts) continue;
      const ms = Date.parse(ts.endsWith('Z') ? ts : `${ts}Z`);
      if (!Number.isFinite(ms)) continue;
      const key = Math.floor(ms / 1000 / bucketSec) * bucketSec;
      const b = buckets.get(key) ?? { sum: 0, n: 0 };
      b.sum += bpm;
      b.n += 1;
      buckets.set(key, b);
    }

    const points = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([key, b]) => ({
        // Local wall-clock, so a reading taken at 09:00 reads as 09:00.
        time: toLocalTimeString(key * 1000, this.timeZone),
        value: Math.round(b.sum / b.n),
      }));

    const [rhr, azm] = await Promise.all([
      this.listPayloads('daily-resting-heart-rate', 'daily', date, date).catch(() => []),
      this.client.dailyRollUp('active-zone-minutes', date, date).catch(() => []),
    ]);

    return {
      date,
      detailLevel,
      restingHeartRate: num((rhr[0] as Row | undefined)?.beatsPerMinute),
      heartRateZones: readAzmZones(azm[0]),
      points,
    };
  }

  async getSleep(date: string): Promise<SleepLog[]> {
    return this.getSleepRange(date, date);
  }

  async getSleepRange(start: string, end: string): Promise<SleepLog[]> {
    const rows = await this.list('sleep', 'interval', start, end);
    return rows.map((row) => {
      const s = GoogleHealthProvider.unwrap(row, 'sleep');
      const interval = (s.interval ?? {}) as Row;
      const summary = (s.summary ?? {}) as Row;

      const startTime = (interval.startTime as string) ?? '';
      const endTime = (interval.endTime as string) ?? '';
      const spanMs =
        Date.parse(endTime) && Date.parse(startTime)
          ? Date.parse(endTime) - Date.parse(startTime)
          : 0;

      const minutesAsleep = num(summary.minutesAsleep) ?? 0;
      const inPeriod = num(summary.minutesInSleepPeriod);

      const stageSummary: Record<string, Record<string, number>> = {};
      for (const st of (summary.stagesSummary as Row[] | undefined) ?? []) {
        const level = SLEEP_STAGE_TO_LEVEL[String(st.type)] ?? String(st.type).toLowerCase();
        stageSummary[level] = { count: num(st.count) ?? 0, minutes: num(st.minutes) ?? 0 };
      }

      return {
        logId: nameToNumericId(s.__name),
        dateOfSleep: fromCivilDate((interval.civilEndTime as Row | undefined)?.date) ?? end,
        startTime,
        endTime,
        duration: spanMs,
        minutesAsleep,
        minutesAwake: num(summary.minutesAwake),
        minutesToFallAsleep: num(summary.minutesToFallAsleep),
        timeInBed: inPeriod,
        efficiency:
          inPeriod && inPeriod > 0 ? Math.round((minutesAsleep / inPeriod) * 100) : undefined,
        type: (s.type as string) ?? undefined,
        levels: {
          summary: stageSummary,
          data: ((s.stages as Row[] | undefined) ?? []).map((st) => ({
            dateTime: (st.startTime as string) ?? '',
            level: SLEEP_STAGE_TO_LEVEL[String(st.type)] ?? String(st.type).toLowerCase(),
            seconds: stageSeconds(st),
          })),
        },
      };
    });
  }

  async getBodyLog(start: string, end: string): Promise<BodyLog> {
    const [weightRows, fatRows] = await Promise.all([
      this.list('weight', 'sample', start, end),
      this.list('body-fat', 'sample', start, end),
    ]);

    const weight: WeightLog[] = weightRows.map((row) => {
      const w = GoogleHealthProvider.unwrap(row, 'weight');
      return {
        logId: nameToNumericId(w.__name),
        date: pointDate(w) ?? start,
        time: pointTimestamp(w)?.slice(11, 19),
        weight: (num(w.weightGrams) ?? 0) / 1000,
      };
    });

    const fat: BodyFatLog[] = fatRows.map((row) => {
      const f = GoogleHealthProvider.unwrap(row, 'bodyFat');
      return {
        logId: nameToNumericId(f.__name),
        date: pointDate(f) ?? start,
        time: pointTimestamp(f)?.slice(11, 19),
        fat: num(f.percentage) ?? 0,
      };
    });

    return { weight, fat };
  }

  async getFoodLog(date: string): Promise<FoodLog> {
    const [foodRows, waterRows] = await Promise.all([
      this.list('nutrition-log', 'interval', date, date),
      this.list('hydration-log', 'interval', date, date).catch(() => []),
    ]);

    const foods: FoodLogEntry[] = foodRows.map((row) => {
      const n = GoogleHealthProvider.unwrap(row, 'nutritionLog');
      return {
        logId: nameToNumericId(n.__name),
        loggedFood: {
          name: (n.foodDisplayName as string) ?? undefined,
          mealTypeId: GOOGLE_TO_MEAL_TYPE_ID[String(n.mealType)] ?? 7,
          amount: num((n.serving as Row | undefined)?.amount),
          calories: num((n.energy as Row | undefined)?.kcal),
        },
        nutritionalValues: readNutrients(n),
        logDate: pointDate(n) ?? date,
      };
    });

    const water: WaterLogEntry[] = waterRows.map((row) => {
      const h = GoogleHealthProvider.unwrap(row, 'hydrationLog');
      return {
        logId: nameToNumericId(h.__name),
        amount: num((h.amountConsumed as Row | undefined)?.milliliters) ?? 0,
      };
    });

    const summary: Record<string, number> = {};
    for (const f of foods) {
      const v = f.nutritionalValues ?? {};
      summary.calories = (summary.calories ?? 0) + (f.loggedFood?.calories ?? 0);
      summary.protein = (summary.protein ?? 0) + (v.protein ?? 0);
      summary.carbs = (summary.carbs ?? 0) + (v.carbs ?? 0);
      summary.fat = (summary.fat ?? 0) + (v.fat ?? 0);
      summary.fiber = (summary.fiber ?? 0) + (v.fiber ?? 0);
      summary.sodium = (summary.sodium ?? 0) + (v.sodium ?? 0);
    }

    const totalWater = water.reduce((a, w) => a + w.amount, 0);
    return {
      foods,
      summary: { ...summary, water: totalWater },
      water: { summary: { water: totalWater }, water },
    };
  }

  async getSpO2(start: string, end: string): Promise<SpO2Day[]> {
    const rows = await this.listPayloads('daily-oxygen-saturation', 'daily', start, end);
    return rows.map((r) => ({
      dateTime: fromCivilDate(r.date) ?? start,
      value: {
        avg: num(r.averagePercentage),
        min: num(r.lowerBoundPercentage),
        max: num(r.upperBoundPercentage),
      },
    }));
  }

  async getRespiratoryRate(start: string, end: string): Promise<RespiratoryRateDay[]> {
    const rows = await this.listPayloads('daily-respiratory-rate', 'daily', start, end);
    return rows.map((r) => ({
      dateTime: fromCivilDate(r.date) ?? start,
      value: { breathingRate: num(r.breathsPerMinute) },
    }));
  }

  async getSkinTemperature(start: string, end: string): Promise<SkinTempDay[]> {
    const rows = await this.listPayloads(
      'daily-sleep-temperature-derivations',
      'daily',
      start,
      end,
    );
    return rows.map((r) => {
      const nightly = num(r.nightlyTemperatureCelsius);
      const baseline = num(r.baselineTemperatureCelsius);
      return {
        dateTime: fromCivilDate(r.date) ?? start,
        // Google reports an absolute nightly temperature plus a baseline;
        // Fitbit reported only the deviation, so derive it to keep the field
        // comparable with historical data.
        value: {
          nightlyRelative:
            nightly !== undefined && baseline !== undefined
              ? Number((nightly - baseline).toFixed(2))
              : undefined,
        },
        logType: 'nightly',
      };
    });
  }

  async getHRV(start: string, end: string): Promise<HrvDay[]> {
    const rows = await this.listPayloads('daily-heart-rate-variability', 'daily', start, end);
    return rows.map((r) => ({
      dateTime: fromCivilDate(r.date) ?? start,
      value: {
        dailyRmssd: num(r.averageHeartRateVariabilityMilliseconds),
        deepRmssd: num(r.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds),
      },
    }));
  }

  async getCardioFitness(date: string): Promise<CardioFitness> {
    // VO2 max is not recomputed daily, so look back a month and take the most
    // recent reading rather than returning nothing for a quiet day.
    const rows = await this.listPayloads('daily-vo2-max', 'daily', addDays(date, -30), date);
    const latest = rows[rows.length - 1] as Row | undefined;
    return {
      dateTime: latest ? (fromCivilDate(latest.date) ?? date) : date,
      value: { vo2Max: num(latest?.vo2Max) },
    };
  }

  // ----------------------------------------------------------------- write

  async logFood(input: LogFoodInput): Promise<FoodLogEntry> {
    const v = input.nutritionalValues ?? {};
    const nutrients: Array<Record<string, unknown>> = [];
    for (const [key, enumName] of Object.entries(NUTRIENT)) {
      const grams = v[key as keyof typeof v];
      if (grams !== undefined) nutrients.push({ nutrient: enumName, quantity: { grams } });
    }

    const text = await this.client.requestText({
      path: '/users/me/dataTypes/nutrition-log/dataPoints',
      method: 'POST',
      json: {
        nutritionLog: {
          foodDisplayName: input.foodName,
          mealType: googleMealType(input.mealType),
          energy: { kcal: input.calories },
          interval: mealInterval(input.date, input.mealType),
          ...(v.fat !== undefined ? { totalFat: { grams: v.fat } } : {}),
          ...(v.carbs !== undefined ? { totalCarbohydrate: { grams: v.carbs } } : {}),
          ...(nutrients.length ? { nutrients } : {}),
        },
      },
    });

    const created = JSON.parse(text) as Row;
    return {
      logId: nameToNumericId(created.name),
      loggedFood: {
        name: input.foodName,
        mealTypeId: GOOGLE_TO_MEAL_TYPE_ID[googleMealType(input.mealType)] ?? 7,
        calories: input.calories,
        amount: input.amount ?? 1,
      },
      nutritionalValues: readNutrients(GoogleHealthProvider.unwrap(created, 'nutritionLog')),
      logDate: input.date,
    };
  }

  async logMeal(input: LogMealInput): Promise<FoodLogEntry[]> {
    const out: FoodLogEntry[] = [];
    // Sequential on purpose: a partial failure stays attributable to one item
    // rather than collapsing the whole meal into a single opaque error.
    for (const item of input.items) {
      out.push(
        await this.logFood({
          date: input.date,
          mealType: input.mealType,
          foodName: item.name,
          calories: item.calories,
          nutritionalValues: { protein: item.protein, carbs: item.carbs, fat: item.fat },
        }),
      );
    }
    return out;
  }

  async logWater(input: LogWaterInput): Promise<WaterLogEntry> {
    const text = await this.client.requestText({
      path: '/users/me/dataTypes/hydration-log/dataPoints',
      method: 'POST',
      json: {
        hydrationLog: {
          amountConsumed: { milliliters: input.amountMl },
          interval: instantInterval(input.date),
        },
      },
    });
    return { logId: nameToNumericId((JSON.parse(text) as Row).name), amount: input.amountMl };
  }

  async logWeight(input: LogWeightInput): Promise<WeightLog> {
    const text = await this.client.requestText({
      path: '/users/me/dataTypes/weight/dataPoints',
      method: 'POST',
      json: {
        weight: {
          weightGrams: Math.round(input.weightKg * 1000),
          sampleTime: sampleTime(input.date, input.time),
        },
      },
    });
    return {
      logId: nameToNumericId((JSON.parse(text) as Row).name),
      date: input.date,
      time: input.time,
      weight: input.weightKg,
    };
  }

  async logBodyFat(input: LogBodyFatInput): Promise<BodyFatLog> {
    const text = await this.client.requestText({
      path: '/users/me/dataTypes/body-fat/dataPoints',
      method: 'POST',
      json: {
        bodyFat: {
          percentage: input.fatPercent,
          sampleTime: sampleTime(input.date, input.time),
        },
      },
    });
    return {
      logId: nameToNumericId((JSON.parse(text) as Row).name),
      date: input.date,
      time: input.time,
      fat: input.fatPercent,
    };
  }

  async logActivity(input: LogActivityInput): Promise<ExerciseLog> {
    const startIso = `${input.date}T${input.startTime}Z`;
    const endIso = isoSecond(Date.parse(startIso) + input.durationMs);

    const text = await this.client.requestText({
      path: '/users/me/dataTypes/exercise/dataPoints',
      method: 'POST',
      json: {
        exercise: {
          displayName: input.activityName ?? 'Workout',
          exerciseType: 'EXERCISE_TYPE_UNSPECIFIED',
          activeDuration: `${Math.round(input.durationMs / 1000)}s`,
          interval: { startTime: startIso, endTime: endIso },
          ...(input.manualCalories !== undefined || input.distanceKm !== undefined
            ? {
                metricsSummary: {
                  ...(input.manualCalories !== undefined
                    ? { caloriesKcal: input.manualCalories }
                    : {}),
                  ...(input.distanceKm !== undefined
                    ? { distanceMillimeters: Math.round(input.distanceKm * 1_000_000) }
                    : {}),
                },
              }
            : {}),
        },
      },
    });

    return {
      logId: nameToNumericId((JSON.parse(text) as Row).name),
      activityName: input.activityName,
      startTime: startIso,
      duration: input.durationMs,
      calories: input.manualCalories,
      distance: input.distanceKm,
      distanceUnit: 'km',
    };
  }

  async logSleep(input: LogSleepInput): Promise<SleepLog> {
    const startIso = `${input.date}T${input.startTime}:00Z`;
    const endIso = isoSecond(Date.parse(startIso) + input.durationMs);
    const minutes = Math.round(input.durationMs / 60000);

    const text = await this.client.requestText({
      path: '/users/me/dataTypes/sleep/dataPoints',
      method: 'POST',
      json: {
        sleep: {
          type: 'CLASSIC',
          interval: { startTime: startIso, endTime: endIso },
          // int64 fields go over the wire as strings.
          summary: { minutesAsleep: String(minutes), minutesInSleepPeriod: String(minutes) },
        },
      },
    });

    return {
      logId: nameToNumericId((JSON.parse(text) as Row).name),
      dateOfSleep: input.date,
      startTime: startIso,
      endTime: endIso,
      duration: input.durationMs,
      minutesAsleep: minutes,
    };
  }

  // ---------------------------------------------------------------- delete

  async deleteFoodLog(logId: number): Promise<void> {
    await this.deleteByNumericId('nutrition-log', 'interval', logId);
  }

  async deleteWaterLog(logId: number): Promise<void> {
    await this.deleteByNumericId('hydration-log', 'interval', logId);
  }

  async deleteWeightLog(logId: number): Promise<void> {
    await this.deleteByNumericId('weight', 'sample', logId);
  }

  async deleteBodyFatLog(logId: number): Promise<void> {
    await this.deleteByNumericId('body-fat', 'sample', logId);
  }

  async deleteActivityLog(logId: number): Promise<void> {
    await this.deleteByNumericId('exercise', 'interval', logId);
  }

  async deleteSleepLog(logId: number): Promise<void> {
    await this.deleteByNumericId('sleep', 'interval', logId);
  }

  /**
   * Resolve one of this server's synthetic numeric ids back to a Google
   * resource name, then delete it.
   *
   * Google identifies a data point by an opaque resource path, but the tool
   * schemas inherited from the Fitbit era hand the model a number. That number
   * is a stable hash of the resource name, so the owning point is found by
   * scanning a recent window and re-hashing. 35 days covers anything this
   * server wrote; older entries have to be removed in the Google Health app.
   */
  private async deleteByNumericId(
    dataType: string,
    timeField: TimeField,
    logId: number,
  ): Promise<void> {
    const end = new Date().toISOString().slice(0, 10);
    const rows = await this.list(dataType, timeField, addDays(end, -35), end);

    const match = rows.find((r) => nameToNumericId(r.name) === logId);
    if (!match?.name) {
      throw new UnsupportedOperationError(
        `No ${dataType} entry with id ${logId} was found in the last 35 days.`,
        'Re-read the log to get a current id, or delete the entry in the Google Health app.',
      );
    }

    await this.client.requestText({
      path: `/users/me/dataTypes/${dataType}/dataPoints:batchDelete`,
      method: 'POST',
      json: { names: [match.name] },
    });
  }
}

// -------------------------------------------------------------- local utils

/** Pull a named field out of a rollup bucket, whatever nesting it arrives in. */
function pickRollup(bucket: Row | undefined, field: string): unknown {
  if (!bucket) return undefined;
  if (bucket[field] !== undefined) return bucket[field];
  for (const v of Object.values(bucket)) {
    if (v && typeof v === 'object' && field in (v as Row)) return (v as Row)[field];
  }
  return undefined;
}

/**
 * The local date a rollup bucket covers.
 *
 * Buckets label themselves with `civilStartTime`, not `date` — getting this
 * wrong collapses an entire time series onto a single day.
 */
function rollupDate(bucket: Row | undefined): string | undefined {
  if (!bucket) return undefined;
  return (
    fromCivilDate((bucket.civilStartTime as Row | undefined)?.date) ??
    fromCivilDate(bucket.date) ??
    fromCivilDate((bucket.startDate as Row | undefined)?.date) ??
    fromCivilDate((bucket.start as Row | undefined)?.date)
  );
}

/**
 * Heart-rate zones from an `active-zone-minutes` rollup bucket.
 *
 * The bucket carries one flat key per zone — `sumInFatBurnHeartZone`,
 * `sumInCardioHeartZone`, `sumInPeakHeartZone` — rather than an array of zone
 * objects, and no zone bounds at all.
 */
const AZM_ZONE_FIELDS: Array<[field: string, name: string]> = [
  ['sumInFatBurnHeartZone', 'Fat Burn'],
  ['sumInCardioHeartZone', 'Cardio'],
  ['sumInPeakHeartZone', 'Peak'],
];

function readAzmZones(bucket: Row | undefined): HeartRateZone[] | undefined {
  if (!bucket) return undefined;
  const zones: HeartRateZone[] = [];
  for (const [field, name] of AZM_ZONE_FIELDS) {
    const minutes = num(pickRollup(bucket, field));
    if (minutes !== undefined) {
      // Bounds are not reported by this endpoint; only the minutes are real.
      zones.push({ name, min: 0, max: 0, minutes });
    }
  }
  return zones.length ? zones : undefined;
}

/** Seconds covered by one sleep stage segment. */
function stageSeconds(st: Row): number {
  const a = Date.parse(st.startTime as string);
  const b = Date.parse(st.endTime as string);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 1000) : 0;
}

/** Macro values off a NutritionLog payload, under the legacy field names. */
function readNutrients(n: Row): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {
    calories: num((n.energy as Row | undefined)?.kcal),
    fat: num((n.totalFat as Row | undefined)?.grams),
    carbs: num((n.totalCarbohydrate as Row | undefined)?.grams),
  };
  for (const entry of (n.nutrients as Row[] | undefined) ?? []) {
    const grams = num((entry.quantity as Row | undefined)?.grams);
    switch (entry.nutrient) {
      case 'PROTEIN':
        out.protein = grams;
        break;
      case 'DIETARY_FIBER':
        out.fiber = grams;
        break;
      case 'SODIUM':
        out.sodium = grams;
        break;
      case 'SUGAR':
        out.sugar = grams;
        break;
    }
  }
  return out;
}

/** Meal slot → API enum, falling back to ANYTIME for anything unmapped. */
function googleMealType(mealType: string): string {
  return MEAL_TYPE_TO_GOOGLE[mealType] ?? 'ANYTIME';
}

/** Nominal clock hour for each meal slot, so entries land in a sensible order. */
const MEAL_HOUR: Record<string, number> = {
  Breakfast: 8,
  MorningSnack: 10,
  Lunch: 12,
  AfternoonSnack: 15,
  Dinner: 19,
  Anytime: 12,
};

/**
 * A nutrition log needs an interval — the API has no date-only form — so each
 * meal slot is anchored at a nominal hour and given a 30-minute window.
 */
function mealInterval(date: string, mealType: string): Record<string, unknown> {
  const hh = String(MEAL_HOUR[mealType] ?? 12).padStart(2, '0');
  return { startTime: `${date}T${hh}:00:00Z`, endTime: `${date}T${hh}:30:00Z` };
}

/** A zero-width interval for point-in-time logs such as hydration. */
function instantInterval(date: string): Record<string, unknown> {
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const at = `${date}T${hh}:${mm}:00Z`;
  return { startTime: at, endTime: at };
}

/** `ObservationSampleTime` for a date plus optional `HH:mm:ss`. */
function sampleTime(date: string, time?: string): Record<string, unknown> {
  return { physicalTime: `${date}T${time ?? '12:00:00'}Z` };
}

/** Epoch millis → RFC-3339 with whole seconds (the API rejects fractions). */
function isoSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}
