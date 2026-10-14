const crypto = require("node:crypto");
const { hashCanonicalJson, canonicalRequestString } = require("./canonicalize.js");

function authError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function randomToken(prefix) {
  return `${prefix}${crypto.randomUUID()}`;
}

function createRequestEnvelope({
  method = "POST",
  protocolVersion = 1,
  action,
  payload = {},
  operationId = "",
  deviceId,
  secret,
  now = new Date(),
  requestId = randomToken("req_"),
  nonce = randomToken("nonce_"),
  adminSessionToken
} = {}) {
  if (!action) throw new Error("Signed requests require an action.");
  if (!deviceId) throw new Error("Signed requests require a device ID.");
  if (!secret) throw new Error("Signed requests require a gateway secret.");
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const envelope = {
    protocolVersion,
    requestId,
    operationId,
    deviceId,
    timestamp,
    nonce,
    action,
    payload,
    payloadHash: hashCanonicalJson(payload)
  };
  if (adminSessionToken) envelope.adminSessionToken = adminSessionToken;
  envelope.signature = crypto
    .createHmac("sha256", Buffer.from(String(secret), "utf8"))
    .update(canonicalRequestString(method, envelope), "utf8")
    .digest("hex");
  return envelope;
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyRequestEnvelope({
  envelope,
  method = "POST",
  secret,
  now = new Date(),
  maxClockSkewMs = 5 * 60 * 1000,
  replayStore
} = {}) {
  if (!envelope || typeof envelope !== "object") throw authError("AUTH_REQUIRED", "Authenticated request required.");
  for (const field of ["protocolVersion", "requestId", "deviceId", "timestamp", "nonce", "action", "payloadHash", "signature"]) {
    if (envelope[field] === undefined || envelope[field] === null || envelope[field] === "") {
      throw authError("AUTH_REQUIRED", "Authenticated request required.");
    }
  }
  if (Number(envelope.protocolVersion) !== 1) throw authError("AUTH_PROTOCOL", "Unsupported authentication protocol.");
  if (!secret) throw authError("AUTH_CONFIG", "Authentication is not configured.");
  let timestamp;
  try { timestamp = new Date(envelope.timestamp).getTime(); } catch { timestamp = NaN; }
  if (!Number.isFinite(timestamp) || Math.abs((now instanceof Date ? now : new Date(now)).getTime() - timestamp) > maxClockSkewMs) {
    throw authError("AUTH_EXPIRED", "Authenticated request has expired.");
  }
  const expectedHash = hashCanonicalJson(envelope.payload === undefined ? {} : envelope.payload);
  if (!timingSafeEqualText(expectedHash, envelope.payloadHash)) throw authError("AUTH_PAYLOAD_TAMPERED", "Request payload is invalid.");
  const expectedSignature = crypto
    .createHmac("sha256", Buffer.from(String(secret), "utf8"))
    .update(canonicalRequestString(method, envelope), "utf8")
    .digest("hex");
  if (!timingSafeEqualText(expectedSignature, envelope.signature)) throw authError("AUTH_INVALID", "Authenticated request is invalid.");
  const replayKey = `${envelope.deviceId}:${envelope.requestId}:${envelope.nonce}`;
  if (replayStore?.has(replayKey)) throw authError("AUTH_REPLAY", "Authenticated request has already been used.");
  replayStore?.add(replayKey);
  return { ok: true, replayKey, envelope };
}

module.exports = { createRequestEnvelope, verifyRequestEnvelope, authError };
