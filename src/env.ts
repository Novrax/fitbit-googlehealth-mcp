export type Env = {
  TOKENS: KVNamespace;
  CACHE: KVNamespace;

  /**
   * Which health backend to serve. Defaults to `google` when unset.
   *
   * `fitbit` targets the legacy Fitbit Web API (api.fitbit.com), which Google
   * is decommissioning in September 2026. It is kept only so an existing
   * deployment can fall back mid-migration; new deployments should use
   * `google`.
   */
  HEALTH_PROVIDER?: 'google' | 'fitbit';

  /** Google Health API (health.googleapis.com/v4) — the current backend. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;

  /** Legacy Fitbit Web API credentials. Only needed when HEALTH_PROVIDER=fitbit. */
  FITBIT_CLIENT_ID?: string;
  FITBIT_CLIENT_SECRET?: string;

  /**
   * IANA timezone used to resolve "today" for tools with an optional `date`.
   * Defaults to UTC when unset. Example: "Europe/London".
   */
  TIMEZONE?: string;

  MCP_SHARED_SECRET: string;
  ALLOWED_CIDRS: string;
};
