// backend/routes/auth_cognito.js
import express from 'express';
import crypto from 'crypto';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { jwtVerify, createRemoteJWKSet } from 'jose';

const REGION     = process.env.COGNITO_REGION || process.env.AWS_REGION;
const USER_POOL  = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID  = process.env.COGNITO_CLIENT_ID;
const CLIENT_SEC = process.env.COGNITO_CLIENT_SECRET || null;

if (!REGION || !USER_POOL || !CLIENT_ID) {
  throw new Error('Missing Cognito env: COGNITO_REGION, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID');
}

const cip = new CognitoIdentityProviderClient({ region: REGION });

// ----- helpers -----
function secretHash(username) {
  if (!CLIENT_SEC) return undefined;
  const h = crypto.createHmac('sha256', CLIENT_SEC);
  h.update(String(username) + CLIENT_ID);
  return h.digest('base64');
}
function mapCognitoError(err, context = 'generic') {
  const name = err?.name || err?.__type || 'UnknownError';
  const msg  = err?.message || String(err);
  let status = 400;
  let friendly = msg;

  if (name === 'NotAuthorizedException' && /secret hash/i.test(msg)) {
    return {
      status: 500,
      code: name,
      message: 'Server configuration error: client secret mismatch (COGNITO_CLIENT_SECRET) or wrong ClientId.',
      raw: msg
    };
  }
  switch (name) {
    case 'CodeMismatchException':        friendly = 'The code is incorrect.'; break;
    case 'ExpiredCodeException':         friendly = 'The code has expired.'; break;
    case 'UserNotFoundException':        friendly = 'User not found.'; break;
    case 'InvalidParameterException':    friendly = 'Invalid parameter.'; break;
    case 'TooManyFailedAttemptsException':
    case 'TooManyRequestsException':
    case 'LimitExceededException':       friendly = 'Attempt limit exceeded. Try again later.'; break;
    case 'UserNotConfirmedException':    status = 403; friendly = 'Your account is not confirmed.'; break;
    case 'NotAuthorizedException':
      if (context === 'login') { status = 401; friendly = 'Incorrect username or password.'; }
      break;
    case 'UsernameExistsException':      friendly = 'That username already exists.'; break;
    default: break;
  }
  return { status, code: name, message: friendly, raw: msg };
}

// ----- JWT verification for protected routes -----
const issuer = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL}`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

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
async function verifyCognitoJwt(token) {
  try { return await verifyAsAccessToken(token); }
  catch { return await verifyAsIdToken(token); }
}

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

      const identityKey = email || username || sub;
      if (!identityKey) return res.status(401).json({ error: 'Token missing identity (email/username/sub).' });

      req.user = { id: sub, sub, email, username, identityKey, tokenKind: verified.kind, claims };
      next();
    } catch (e) {
      res.status(401).json({ error: 'Invalid/expired token: ' + (e?.message || e) });
    }
  };
}

// ----- router -----
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
      Username: String(username).trim(),
      Password: password,
      UserAttributes: [{ Name: 'email', Value: String(email).trim() }]
    };
    const sh = secretHash(params.Username);
    if (sh) params.SecretHash = sh;
    const r = await cip.send(new SignUpCommand(params));
    const cd = r?.CodeDeliveryDetails;
    res.json({
      ok: true,
      message: 'Check your email for a confirmation code',
      codeDelivery: cd ? {
        destination: cd.Destination, deliveryMedium: cd.DeliveryMedium, attributeName: cd.AttributeName
      } : null
    });
  } catch (e) {
    const mapped = mapCognitoError(e, 'register');
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// POST /api/confirm { username, code }
router.post('/confirm', async (req, res) => {
  const username = String((req.body?.username || '')).trim();
  const code     = String((req.body?.code || '')).trim();
  if (!username || !code) return res.status(400).json({ error: 'username and code required' });
  try {
    const params = { ClientId: CLIENT_ID, Username: username, ConfirmationCode: code };
    const sh = secretHash(username);
    if (sh) params.SecretHash = sh;
    await cip.send(new ConfirmSignUpCommand(params));
    res.json({ ok: true, message: 'Account confirmed. You can now log in.' });
  } catch (e) {
    const mapped = mapCognitoError(e, 'confirm');
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// POST /api/resend { username }
router.post('/resend', async (req, res) => {
  const username = String((req.body?.username || '')).trim();
  if (!username) return res.status(400).json({ error: 'username required' });
  try {
    const params = { ClientId: CLIENT_ID, Username: username };
    const sh = secretHash(username);
    if (sh) params.SecretHash = sh;
    const r = await cip.send(new ResendConfirmationCodeCommand(params));
    const cd = r?.CodeDeliveryDetails;
    res.json({
      ok: true,
      message: 'A new confirmation code was sent.',
      codeDelivery: cd ? {
        destination: cd.Destination, deliveryMedium: cd.DeliveryMedium, attributeName: cd.AttributeName
      } : null
    });
  } catch (e) {
    const mapped = mapCognitoError(e, 'resend');
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * POST /api/login { username, password }
 * - Returns tokens on success
 * - OR returns an MFA challenge description (EMAIL_OTP, possibly SELECT_MFA_TYPE)
 */
router.post('/login', async (req, res) => {
  const username = String((req.body?.username || '')).trim();
  const password = req.body?.password;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  try {
    const params = {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password }
    };
    const sh = secretHash(username);
    if (sh) params.AuthParameters.SECRET_HASH = sh;

    const r = await cip.send(new InitiateAuthCommand(params));

    // Tokens immediately?
    if (r.AuthenticationResult) {
      const { AccessToken, IdToken, RefreshToken, ExpiresIn, TokenType } = r.AuthenticationResult;
      return res.json({ token: AccessToken, idToken: IdToken, refreshToken: RefreshToken, expiresIn: ExpiresIn, tokenType: TokenType });
    }

    // If Cognito asks the client to choose a factor, auto-choose Email OTP.
    if (r.ChallengeName === 'SELECT_MFA_TYPE' && r.Session) {
      // Example in docs shows ANSWER=<MFA type>; we'll answer EMAIL_OTP here. :contentReference[oaicite:2]{index=2}
      const cr = { USERNAME: username, ANSWER: 'EMAIL_OTP' };
      const sh2 = secretHash(username);
      if (sh2) cr.SECRET_HASH = sh2;

      const next = await cip.send(new RespondToAuthChallengeCommand({
        ClientId: CLIENT_ID,
        ChallengeName: 'SELECT_MFA_TYPE',
        Session: r.Session,
        ChallengeResponses: cr
      }));
      // Typically returns ChallengeName: 'EMAIL_OTP'
      if (next.ChallengeName === 'EMAIL_OTP') {
        return res.json({
          mfaRequired: true,
          challengeName: 'EMAIL_OTP',
          session: next.Session || r.Session,
          parameters: next.ChallengeParameters || {},
          message: 'We emailed you a one-time code.'
        });
      }
      // Fallthrough (SMS/TOTP, etc.)
      if (next.ChallengeName) {
        return res.json({
          mfaRequired: true,
          challengeName: next.ChallengeName,
          session: next.Session || r.Session,
          parameters: next.ChallengeParameters || {}
        });
      }
    }

    // Already an EMAIL_OTP challenge?
    if (r.ChallengeName === 'EMAIL_OTP') {
      return res.json({
        mfaRequired: true,
        challengeName: 'EMAIL_OTP',
        session: r.Session || null,
        parameters: r.ChallengeParameters || {},
        message: 'We emailed you a one-time code.'
      });
    }

    // Other challenges (kept for completeness): SMS_MFA, SOFTWARE_TOKEN_MFA, NEW_PASSWORD_REQUIRED, etc.
    if (r.ChallengeName) {
      return res.json({
        mfaRequired: true,
        challengeName: r.ChallengeName,
        session: r.Session || null,
        parameters: r.ChallengeParameters || {}
      });
    }

    return res.status(401).json({ error: 'Login failed', details: r });
  } catch (e) {
    const mapped = mapCognitoError(e, 'login');
    res.status(mapped.status === 400 ? 401 : mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

/**
 * POST /api/mfa/respond
 * Body: { username, code, session, challengeName }
 * Supports EMAIL_OTP (and SMS_MFA / SOFTWARE_TOKEN_MFA if you leave them enabled).
 */
router.post('/mfa/respond', async (req, res) => {
  const username = String((req.body?.username || '')).trim();
  const code     = String((req.body?.code || '')).trim();
  const session  = req.body?.session || null;
  const challengeName = req.body?.challengeName;

  if (!username || !code || !session || !challengeName) {
    return res.status(400).json({ error: 'username, code, session, challengeName required' });
  }

  try {
    const responses = { USERNAME: username };
    // EMAIL MFA (new built-in): respond with EMAIL_OTP_CODE :contentReference[oaicite:3]{index=3}
    if (challengeName === 'EMAIL_OTP') {
      responses.EMAIL_OTP_CODE = code;
    } else if (challengeName === 'SMS_MFA') {
      responses.SMS_MFA_CODE = code;
    } else if (challengeName === 'SOFTWARE_TOKEN_MFA') {
      responses.SOFTWARE_TOKEN_MFA_CODE = code;
    } else {
      return res.status(400).json({ error: `Unsupported challengeName: ${challengeName}` });
    }
    const sh = secretHash(username);
    if (sh) responses.SECRET_HASH = sh;

    const r = await cip.send(new RespondToAuthChallengeCommand({
      ClientId: CLIENT_ID,
      ChallengeName: challengeName,
      Session: session,
      ChallengeResponses: responses
    }));

    if (r.AuthenticationResult) {
      const { AccessToken, IdToken, RefreshToken, ExpiresIn, TokenType } = r.AuthenticationResult;
      return res.json({ token: AccessToken, idToken: IdToken, refreshToken: RefreshToken, expiresIn: ExpiresIn, tokenType: TokenType });
    }

    // If another challenge comes back (rare), surface it.
    if (r.ChallengeName) {
      return res.json({
        mfaRequired: true,
        challengeName: r.ChallengeName,
        session: r.Session || null,
        parameters: r.ChallengeParameters || {},
        message: 'Additional verification required.'
      });
    }

    return res.status(401).json({ error: 'MFA response failed' });
  } catch (e) {
    const mapped = mapCognitoError(e, 'mfa-respond');
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// GET /api/me
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
