// backend/lib/secrets.js
import {
    SecretsManagerClient,
    GetSecretValueCommand,
  } from "@aws-sdk/client-secrets-manager";
  
  const REGION = process.env.AWS_REGION || "ap-southeast-2";
  const SECRET_ID =
    process.env.SM_COGNITO_CLIENT_SECRET_ID || "n8870349-transcoding-app-secret";
  
  // Simple in-process cache with TTL 
  let _cache = { value: null, ts: 0 };
  const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
  
  async function fetchSecretRaw(secretId) {
    const client = new SecretsManagerClient({ region: REGION });
    const resp = await client.send(
      new GetSecretValueCommand({
        SecretId: secretId,
        VersionStage: "AWSCURRENT", // explicit for clarity
      })
    );
  
    // Either SecretString (text/JSON) or SecretBinary (base64)
    let raw =
      resp.SecretString ||
      (resp.SecretBinary &&
        Buffer.from(resp.SecretBinary, "base64").toString("utf8")) ||
      "";
    if (!raw) throw new Error("Secret payload is empty");
    return raw;
  }
  
  /**
   * Returns the Cognito client secret string.
   * Assumes the secret is a JSON object that contains key `COGNITO_CLIENT_SECRET`.
   * Falls back to the whole string if JSON parse fails.
   *
   * @param {Object} [opts]
   * @param {number} [opts.ttlMs] - cache TTL in ms (default 10 mins)
   */
  export async function getCognitoClientSecret({ ttlMs = DEFAULT_TTL_MS } = {}) {
    const now = Date.now();
    if (_cache.value && now - _cache.ts < ttlMs) return _cache.value;
  
    const raw = await fetchSecretRaw(SECRET_ID);
  
    // Try to parse JSON and extract COGNITO_CLIENT_SECRET
    let secretValue;
    try {
      const obj = JSON.parse(raw);
      secretValue = obj?.COGNITO_CLIENT_SECRET ?? null;
    } catch {
      // Not JSON → treat entire secret as the value
      secretValue = raw;
    }
  
    if (!secretValue) {
      throw new Error('Key "COGNITO_CLIENT_SECRET" not found in secret payload');
    }
  
    _cache = { value: String(secretValue), ts: now };
    return _cache.value;
  }
  
  /**
   * Hydrates process.env.COGNITO_CLIENT_SECRET unless already set (e.g., local override).
   * Call this at startup (after SSM Parameter Store hydration, before importing routes).
   */
  export async function hydrateEnvFromSecretsManager(opts) {
    if (process.env.COGNITO_CLIENT_SECRET) return true; // keep explicit overrides
    const val = await getCognitoClientSecret(opts);
    process.env.COGNITO_CLIENT_SECRET = val;
    return true;
  }
  
  export function clearSecretCache() {
    _cache = { value: null, ts: 0 };
  }
  