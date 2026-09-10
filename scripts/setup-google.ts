#!/usr/bin/env tsx
/**
 * One-shot Google Health OAuth bootstrap CLI.
 *
 *   export GOOGLE_CLIENT_ID=...
 *   export GOOGLE_CLIENT_SECRET=...
 *   pnpm run setup:google
 *
 * Starts a localhost callback server, walks the Authorization Code + PKCE flow
 * in the system browser, exchanges the code for tokens, and prints the exact
 * `wrangler` commands that move them into Workers KV / Secrets.
 *
 * The Worker never runs this path. Google blocks OAuth inside embedded
 * WebViews (`disallowed_useragent`), which is exactly what Claude mobile would
 * use, so consent is collected once here in a real browser instead.
 */

import { exec } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import { envPath, loadEnv } from './load-env';

loadEnv();

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 8788;
const CALLBACK_PATH = '/google/callback';

/**
 * Read + write across every category this server touches.
 *
 * Google splits read and write into separate scopes; a `.writeonly` scope does
 * NOT imply read. `settings.readonly` is what backs `list_devices` and the
 * unit/timezone fields of `get_profile`.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.writeonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.writeonly',
  'https://www.googleapis.com/auth/googlehealth.nutrition.readonly',
  'https://www.googleapis.com/auth/googlehealth.nutrition.writeonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
];

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  token_type: z.string(),
});
type TokenResponseT = z.infer<typeof TokenResponse>;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function mask(value: string): string {
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open '${url}'`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open '${url}'`;
  exec(cmd, () => {
    // Best effort — the URL is printed too, so a failure here is not fatal.
  });
}

function waitForCallback(opts: { expectedState: string }): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? '';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Google authorization error</h1><pre>${error}\n${desc}</pre>`);
        server.close();
        reject(new Error(`Google OAuth error: ${error} ${desc}`));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code');
        return;
      }
      if (state !== opts.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('State mismatch');
        server.close();
        reject(new Error('State mismatch — possible CSRF'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Authorized</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 24px}</style></head>
<body>
<h1>&#10003; Authorized</h1>
<p>You can close this tab and return to the terminal.</p>
</body>
</html>`);
      server.close();
      resolve({ code });
    });

    server.on('error', reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST);
  });
}

async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponseT> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${res.statusText}\n${text}`);
  }

  const json = JSON.parse(text);
  if (!json.refresh_token) {
    throw new Error(
      'Google returned no refresh_token.\n\n' +
        'This happens when the account has already granted this client and Google ' +
        'suppresses the repeat consent. Revoke the app at ' +
        'https://myaccount.google.com/permissions and run this again.',
    );
  }
  return TokenResponse.parse(json);
}

function printSetupHelp(): void {
  console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.');
  console.error('');
  console.error('  Easiest: copy .env.example to .env and paste your credentials in.');
  console.error(`  Expected at: ${envPath}`);
  console.error('');
  console.error('      cp .env.example .env      # macOS / Linux / Git Bash');
  console.error('      copy .env.example .env    # Windows cmd / PowerShell');
  console.error('');
  console.error('  .env is gitignored and is only read by these local scripts.');
  console.error('');
  console.error('  To get those credentials:');
  console.error('  1. Create/select a Google Cloud project:');
  console.error('     https://console.cloud.google.com/projectcreate');
  console.error('  2. Enable the Google Health API:');
  console.error('     https://console.cloud.google.com/apis/api/health.googleapis.com');
  console.error('  3. Configure the OAuth consent screen (External) and PUBLISH it:');
  console.error('     https://console.cloud.google.com/auth/audience');
  console.error('     Publishing status must be "In production", or refresh tokens');
  console.error('     expire after 7 days and the Worker breaks every week.');
  console.error('  4. Create an OAuth client ID, application type "Desktop app":');
  console.error('     https://console.cloud.google.com/apis/credentials');
  console.error('  5. Put them in .env and run this again:');
  console.error('     pnpm run setup:google');
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    printSetupHelp();
    process.exit(1);
  }

  const state = base64url(randomBytes(16));
  const { verifier, challenge } = generatePkce();
  const redirectUri = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  // Both are required to be handed a refresh_token at all.
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  console.log('');
  console.log('Google Health OAuth bootstrap');
  console.log('─────────────────────────────');
  console.log('');
  console.log('Redirect URI (Desktop-app clients accept any loopback port):');
  console.log(`  ${redirectUri}`);
  console.log('');
  console.log('Requesting scopes:');
  for (const s of SCOPES) console.log(`  · ${s.split('googlehealth.')[1] ?? s}`);
  console.log('');
  console.log('Opening the authorization URL in your default browser…');
  console.log('(If it does not open, copy-paste this URL:)');
  console.log('');
  console.log(`  ${authUrl.toString()}`);
  console.log('');
  console.log(`Waiting for the callback on ${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH} …`);
  console.log('');

  openInBrowser(authUrl.toString());

  const { code } = await waitForCallback({ expectedState: state });
  const tokens = await exchangeCode({
    clientId,
    clientSecret,
    code,
    codeVerifier: verifier,
    redirectUri,
  });

  const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;

  console.log('✓ Got tokens');
  console.log('');
  console.log(`  access_token:  ${mask(tokens.access_token)}`);
  console.log(`  refresh_token: ${mask(tokens.refresh_token)}`);
  console.log(`  expires_in:    ${tokens.expires_in}s (unix epoch: ${expiresAt})`);
  if (tokens.scope) {
    console.log('  granted scopes:');
    for (const s of tokens.scope.split(' ')) {
      console.log(`    · ${s.split('googlehealth.')[1] ?? s}`);
    }
  }
  console.log('');
  console.log('Next: push these to Cloudflare Workers.');
  console.log('──────────────────────────────────────');
  console.log('');
  console.log('1) One-time KV namespaces (skip if they already exist):');
  console.log('   pnpm wrangler kv namespace create TOKENS');
  console.log('   pnpm wrangler kv namespace create CACHE');
  console.log('   # paste the returned ids into wrangler.toml');
  console.log('');
  console.log('2) Secrets:');
  console.log('   pnpm wrangler secret put GOOGLE_CLIENT_ID');
  console.log(`     ↳ value: ${clientId}`);
  console.log('   pnpm wrangler secret put GOOGLE_CLIENT_SECRET');
  console.log('     ↳ value: <your OAuth client secret>');
  console.log('   pnpm wrangler secret put MCP_SHARED_SECRET');
  console.log('     ↳ value: openssl rand -hex 32');
  console.log('');
  console.log('3) Tokens into the TOKENS KV namespace (--remote is required):');
  console.log(
    `   pnpm wrangler kv key put --remote --binding=TOKENS google_refresh_token '${tokens.refresh_token}'`,
  );
  console.log(
    `   pnpm wrangler kv key put --remote --binding=TOKENS google_access_token '${tokens.access_token}'`,
  );
  console.log(
    `   pnpm wrangler kv key put --remote --binding=TOKENS google_expires_at '${expiresAt}'`,
  );
  console.log('');
  console.log('4) Verify the token actually reads your data:');
  console.log(`   GOOGLE_ACCESS_TOKEN='${tokens.access_token}' pnpm run probe:google`);
  console.log('');
  console.log('5) Deploy: pnpm deploy');
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
