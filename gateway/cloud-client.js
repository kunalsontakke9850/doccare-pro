const { createRequestEnvelope } = require("./signing.js");

function createSignedCloudClient({
  endpoint,
  secretProvider,
  deviceIdProvider,
  fetchImpl = fetch,
  timeoutMs = 8000,
  now = () => new Date(),
  requestIdFactory,
  nonceFactory
} = {}) {
  if (!endpoint) throw new Error("Signed cloud client requires an upstream endpoint.");
  if (typeof secretProvider !== "function") throw new Error("Signed cloud client requires secretProvider().");
  if (typeof deviceIdProvider !== "function") throw new Error("Signed cloud client requires deviceIdProvider().");
  const makeId = requestIdFactory || (() => `req_${require("node:crypto").randomUUID()}`);
  const makeNonce = nonceFactory || (() => `nonce_${require("node:crypto").randomUUID()}`);

  async function request({ action, payload = {}, operationId = "", adminSessionToken } = {}) {
    const envelope = createRequestEnvelope({
      method: "POST", action, payload, operationId,
      deviceId: deviceIdProvider(), secret: secretProvider(), now: now(),
      requestId: makeId(), nonce: makeNonce(), adminSessionToken
    });
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(envelope),
        ...(controller ? { signal: controller.signal } : {})
      });
      let data;
      try { data = await response.json(); } catch { data = { ok: false, error: { code: "CLOUD_INVALID_RESPONSE", message: "Cloud returned invalid JSON." } }; }
      if (!response.ok || !data?.ok) {
        const error = new Error(data?.error?.message || `Cloud request failed with HTTP ${response.status}.`);
        Object.assign(error, { code: data?.error?.code || "CLOUD_HTTP", status: response.status, applicationError: true });
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Cloud request timed out.");
        timeout.code = "TIMEOUT";
        timeout.transient = true;
        throw timeout;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { request };
}

module.exports = { createSignedCloudClient };
