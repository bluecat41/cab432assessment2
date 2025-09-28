// backend/routes/auth_cognito.js
import express from 'express';
import crypto from 'crypto';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand
} from '@aws-sdk/client-cognito-identity-provider';
import { jwtVerify, createRemoteJWKSet } from 'jose';

const REGION     = process.env.COGNITO_REGION || process.env.AWS_REGION;
const USER_POOL  = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID  = process.env.COGNITO_CLIENT_ID;
const CLIENT_SEC = process.env.COGNITO_CLIENT_SECRET || null; // optional

if (!REGION || !USER_POOL || !CLIENT_ID) {
  throw new Error('Missing Cognito env: COGNITO_REGION, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID');
}

const cip = new CognitoIdentityProviderClient({ region: REGION });

// Compute Cognito SECRET_HASH = Base64(HMAC_SHA256(clientSecret, username + clientId))
function secretHash(username) {
  if (!CLIENT_SEC) return undefined;
  const h = crypto.createHmac('sha256', CLIENT_SEC);
  h.update(username + CLIENT_ID);
  return h.digest('base64');
}

// ---------- JWT verification (jose) ----------
const issuer = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL}`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

// Verify as Access Token (no aud, check client_id + token_use)
async function verifyAsAccessToken(token) {
  const { payload } = await jwtVerify(token, jwks, { issuer });
  if (payload.token_use !== 'access') throw new Error('not an access token');
  if (payload.client_id !== CLIENT_ID) throw new Error('client_id mismatch');
  return {
    kind: 'access',
    claims: payload,
    sub: payload.sub || null,
    username: payload.username || payload['cognito:username'] || null,
    email: payload.email || null
  };
}

// Verify as ID Token (aud = clientId + token_use)
async function verifyAsIdToken(token) {
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: CLIENT_ID });
  if (payload.token_use !== 'id') throw new Error('not an id token');
  return {
    kind: 'id',
    claims: payload,
    sub: payload.sub || null,
    username: payload['cognito:username'] || payload.username || null,
    email: payload.email || null
  };
}

// Try Access first, then ID
async function verifyCognitoJwt(token) {
  try {
    return await verifyAsAccessToken(token);
  } catch {
    return await verifyAsIdToken(token);
  }
}

// ---------- Auth middleware ----------
export function authRequired() {
  return async (req, res, next) => {
    try {
      const raw = req.get('authorization') || '';
      const m = /^Bearer\s+(.+)$/.exec(raw);
      if (!m) return res.status(401).json({ error: 'Missing bearer token' });

      const verified = await verifyCognitoJwt(m[1]);
      const claims   = verified.claims || {};

      const email    = (verified.email || '').toLowerCase() || null;
      const username = (verified.username || '').toLowerCase() || null;
      const sub      = verified.sub || null;

      // Prefer email, else username, else sub — must have one
      const identityKey = email || username || sub;
      if (!identityKey) {
        return res.status(401).json({ error: 'Token missing identity (email/username/sub).' });
      }

      req.user = {
        id: sub,
        sub,
        email,
        username,
        identityKey,
        tokenKind: verified.kind,
        claims
      };

      next();
    } catch (e) {
      res.status(401).json({ error: 'Invalid/expired token: ' + (e?.message || e) });
    }
  };
}

// ---------- Router & auth endpoints ----------
const router = express.Router();

// POST /api/register { username, password, email }
router.post('/register', async (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password || !email) {
    return res.status(400).json({ error: 'username, password, email required' });
  }
  try {
    const params = {
      ClientId: CLIENT_ID,
      Username: username,
      Password: password,
      UserAttributes: [{ Name: 'email', Value: email }]
    };
    const sh = secretHash(username);
    if (sh) params.SecretHash = sh; // required if app client has a secret
    await cip.send(new SignUpCommand(params));
    res.json({ ok: true, message: 'Check email for confirmation code' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/confirm { username, code }
router.post('/confirm', async (req, res) => {
  const { username, code } = req.body || {};
  if (!username || !code) return res.status(400).json({ error: 'username and code required' });
  try {
    const params = { ClientId: CLIENT_ID, Username: username, ConfirmationCode: code };
    const sh = secretHash(username);
    if (sh) params.SecretHash = sh;
    await cip.send(new ConfirmSignUpCommand(params));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/login { username, password }
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  try {
    const params = {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password
      }
    };
    const sh = secretHash(username);
    if (sh) params.AuthParameters.SECRET_HASH = sh;

    const r = await cip.send(new InitiateAuthCommand(params));
    if (!r.AuthenticationResult) {
      return res.status(401).json({ error: 'Login failed', details: r });
    }

    const { AccessToken, IdToken, RefreshToken, ExpiresIn, TokenType } = r.AuthenticationResult;
    // Return both; frontend can choose (we prefer ID token for email claim)
    res.json({
      token: AccessToken,
      idToken: IdToken,
      refreshToken: RefreshToken,
      expiresIn: ExpiresIn,
      tokenType: TokenType
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// GET /api/me (protected)
router.get('/me', authRequired(), (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.user.id,
      sub: req.user.sub,
      username: req.user.username,
      email: req.user.email,
      identityKey: req.user.identityKey,
      tokenKind: req.user.tokenKind
    }
  });
});

export default router;
