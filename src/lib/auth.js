// =====================================================================
// LIYOG WORLD — src/lib/auth.js
// Verifies Google Sign-In ID tokens server-side. Never trust a token
// the browser hands you without verifying it against Google's own
// public keys — anyone could otherwise forge a fake "logged in as X".
// =====================================================================

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUER = "https://accounts.google.com";

/**
 * Verifies a Google ID token and returns the decoded payload if valid.
 * Returns null if the token is invalid, expired, or from the wrong app.
 *
 * @param {string} idToken - the raw JWT from Google Sign-In on the client
 * @param {string} expectedClientId - your Google OAuth Client ID
 */
export async function verifyGoogleToken(idToken, expectedClientId) {
  try {
    const [headerB64, payloadB64, signatureB64] = idToken.split(".");
    if (!headerB64 || !payloadB64 || !signatureB64) return null;

    const header = JSON.parse(base64UrlDecode(headerB64));
    const payload = JSON.parse(base64UrlDecode(payloadB64));

    // Basic claim checks before we even verify the signature — cheap
    // rejects that avoid unnecessary key fetches for obviously bad tokens.
    if (payload.iss !== GOOGLE_ISSUER && payload.iss !== "accounts.google.com") return null;
    if (payload.aud !== expectedClientId) return null;
    if (payload.exp * 1000 < Date.now()) return null;

    const cert = await getGoogleCert(header.kid);
    if (!cert) return null;

    const isValid = await verifySignature(`${headerB64}.${payloadB64}`, signatureB64, cert);
    if (!isValid) return null;

    return {
      googleId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified,
      name: payload.name,
      picture: payload.picture
    };
  } catch (err) {
    console.error("Token verification failed:", err);
    return null;
  }
}

async function getGoogleCert(kid) {
  const res = await fetch(GOOGLE_CERTS_URL);
  const { keys } = await res.json();
  const key = keys.find((k) => k.kid === kid);
  if (!key) return null;
  return crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

async function verifySignature(signedData, signatureB64, cert) {
  const signature = base64UrlDecodeToBuffer(signatureB64);
  const data = new TextEncoder().encode(signedData);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", cert, signature, data);
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + (4 - (str.length % 4)) % 4, "=");
  return atob(padded);
}

function base64UrlDecodeToBuffer(str) {
  const decoded = base64UrlDecode(str);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Finds an existing user by Google ID, or creates one. This is the
 * single entry point every login/signup flow should call — keeping
 * user creation in one place avoids subtle duplicate-account bugs.
 */
export async function findOrCreateUser(env, googlePayload, consentToUpdates) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM users WHERE id = ?"
  ).bind(googlePayload.googleId).all();

  if (results.length > 0) {
    await env.DB.prepare(
      "UPDATE users SET last_login_at = datetime('now') WHERE id = ?"
    ).bind(googlePayload.googleId).run();
    return results[0];
  }

  const newUser = {
    id: googlePayload.googleId,
    email: googlePayload.email,
    display_name: googlePayload.name,
    avatar_url: googlePayload.picture
  };

  await env.DB.prepare(
    "INSERT INTO users (id, email, display_name, avatar_url) VALUES (?, ?, ?, ?)"
  ).bind(newUser.id, newUser.email, newUser.display_name, newUser.avatar_url).run();

  // Consent is stored separately from the core identity row, so the
  // users table itself never silently implies marketing permission —
  // anyone auditing the schema sees consent as its own explicit fact.
  await env.DB.prepare(
    "INSERT INTO user_consent (user_id, marketing_opt_in, consented_at) VALUES (?, ?, datetime('now'))"
  ).bind(newUser.id, consentToUpdates ? 1 : 0).run();

  return newUser;
}

/**
 * Issues a signed session token the browser stores and sends back on
 * future requests. Simple HMAC-signed payload — no external session
 * store needed, verifiable statelessly by the Worker.
 */
export async function createSessionToken(env, userId) {
  const payload = { uid: userId, iat: Date.now(), exp: Date.now() + 30 * 24 * 60 * 60 * 1000 };
  const payloadStr = JSON.stringify(payload);
  const signature = await signPayload(env, payloadStr);
  return btoa(payloadStr) + "." + signature;
}

export async function verifySessionToken(env, token) {
  try {
    const [payloadB64, signature] = token.split(".");
    const payloadStr = atob(payloadB64);
    const expectedSig = await signPayload(env, payloadStr);
    if (signature !== expectedSig) return null;

    const payload = JSON.parse(payloadStr);
    if (payload.exp < Date.now()) return null;
    return payload.uid;
  } catch (err) {
    return null;
  }
}

async function signPayload(env, payloadStr) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET || "liyog-fallback-secret-change-me"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadStr));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
