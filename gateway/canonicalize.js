const crypto = require("node:crypto");

function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON only supports finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalize(item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
}

function hashCanonicalJson(value) {
  return crypto.createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function canonicalRequestString(method, envelope) {
  return [
    String(method || "").toUpperCase(),
    envelope.action || "",
    envelope.timestamp || "",
    envelope.nonce || "",
    envelope.requestId || "",
    envelope.operationId || "",
    envelope.payloadHash || "",
    String(envelope.protocolVersion ?? "")
  ].concat(envelope.adminSessionToken ? [envelope.adminSessionToken] : []).join("\n");
}

module.exports = { canonicalize, hashCanonicalJson, canonicalRequestString };
