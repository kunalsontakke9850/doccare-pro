const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { createSignedCloudClient } = require("./cloud-client.js");
const { createDeviceIdentity } = require("./credentials.js");

const DEFAULT_ACTIONS = new Set([
  "ping", "capabilities", "records", "expenses", "config",
  "addRecord", "updateRecord", "deleteRecord", "addExpense",
  "saveConfig", "renameReferringDoctor", "adminChallenge", "adminVerify"
]);

function contentType(filePath) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

function validLoopbackHost(host) {
  const raw = String(host || "");
  const hostname = raw.startsWith("[")
    ? raw.slice(1, raw.indexOf("]"))
    : raw.replace(/:\d+$/, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function validOrigin(origin) {
  if (!origin) return true;
  try { return validLoopbackHost(new URL(origin).hostname); } catch { return false; }
}

function safeRuntimeConfig(source) {
  if (source) return source;
  return "window.APP_CONFIG = { API_BASE_URL: '/api', ENVIRONMENT: 'development', AUTO_REFRESH_MS: 0 };\n";
}

function createGatewayServer({
  staticRoot,
  runtimeConfigSource,
  cloudClient,
  upstreamEndpoint,
  secretProvider,
  deviceIdProvider,
  deviceIdFilePath,
  fetchImpl,
  maxBodyBytes = 1024 * 1024,
  allowedActions = DEFAULT_ACTIONS
} = {}) {
  if (!staticRoot) throw new Error("Gateway requires a static root.");
  let client = cloudClient;
  let getDeviceId = deviceIdProvider;
  if (!client) {
    if (!upstreamEndpoint || typeof secretProvider !== "function") throw new Error("Gateway requires explicit upstream endpoint and secret provider.");
    const identity = deviceIdProvider ? null : createDeviceIdentity({ filePath: deviceIdFilePath });
    getDeviceId = deviceIdProvider || identity.get;
    client = createSignedCloudClient({ endpoint: upstreamEndpoint, secretProvider, deviceIdProvider: getDeviceId, fetchImpl });
  }
  if (!getDeviceId) getDeviceId = () => "gateway-test-device";
  const actionSet = new Set(allowedActions);
  return http.createServer((request, response) => {
    if (!validLoopbackHost(request.headers.host) || !validOrigin(request.headers.origin)) return json(response, 403, { ok: false, error: { code: "GATEWAY_FORBIDDEN", message: "Local gateway request rejected." } });
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/config.js" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(safeRuntimeConfig(runtimeConfigSource));
      return;
    }
    if (url.pathname === "/api/admin/session") {
      if (request.method !== "POST") return json(response, 405, { ok: false, error: { code: "GATEWAY_METHOD", message: "Method not allowed." } });
      const declaredLength = Number(request.headers["content-length"] || 0);
      if (declaredLength > Math.min(maxBodyBytes, 4096)) return json(response, 413, { ok: false, error: { code: "GATEWAY_BODY_TOO_LARGE", message: "Request body is too large." } });
      let size = 0; const chunks = [];
      request.on("data", chunk => { size += chunk.length; if (size <= Math.min(maxBodyBytes, 4096)) chunks.push(chunk); });
      request.on("end", async () => {
        try {
          if (size > Math.min(maxBodyBytes, 4096)) throw Object.assign(new Error("Request body is too large."), { code: "GATEWAY_BODY_TOO_LARGE", status: 413 });
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          const password = typeof body.password === "string" ? body.password : "";
          if (!password || password.length > 512) throw Object.assign(new Error("Password is invalid."), { code: "AUTH_ADMIN_INVALID", status: 400 });
          const deviceId = getDeviceId();
          const challengeResult = await client.request({ action: "adminChallenge", payload: {}, deviceId });
          const credentialResult = await client.request({ action: "adminCredential", payload: {}, deviceId });
          const credential = credentialResult && credentialResult.credential;
          if (!credential || credential.algorithm !== "PBKDF2-SHA-256" || !Number.isInteger(Number(credential.iterations))) throw Object.assign(new Error("Admin authentication is not initialized."), { code: "AUTH_ADMIN_NOT_BOOTSTRAPPED", status: 503 });
          const salt = Buffer.from(String(credential.salt || ""), "base64");
          const expectedHash = Buffer.from(String(credential.hash || ""), "base64");
          if (salt.length < 16 || expectedHash.length !== 32 || Number(credential.iterations) < 100000 || Number(credential.iterations) > 1000000) throw Object.assign(new Error("Admin authentication is invalid."), { code: "AUTH_ADMIN_NOT_BOOTSTRAPPED", status: 503 });
          const actualHash = crypto.pbkdf2Sync(password, salt, Number(credential.iterations), expectedHash.length, "sha256");
          if (actualHash.length !== expectedHash.length || !crypto.timingSafeEqual(actualHash, expectedHash)) throw Object.assign(new Error("Invalid admin password."), { code: "AUTH_ADMIN_INVALID", status: 401 });
          const proof = crypto.createHmac("sha256", actualHash).update(String(challengeResult.challenge), "utf8").digest("hex");
          const verified = await client.request({ action: "adminVerify", payload: { challenge: challengeResult.challenge, proof }, deviceId });
          json(response, 200, verified);
        } catch (error) {
          json(response, error.status || 502, { ok: false, error: { code: error.code || "AUTH_ADMIN_FAILED", message: error.code === "AUTH_ADMIN_INVALID" ? "Invalid admin password." : error.message } });
        }
      });
      return;
    }
    if (url.pathname === "/api") {
      if (request.method === "GET") {
        const action = url.searchParams.get("op") || "";
        if (!actionSet.has(action)) return json(response, 400, { ok: false, error: { code: "GATEWAY_ACTION", message: "Unsupported API action." } });
        client.request({ action, payload: {}, operationId: "" }).then(result => json(response, 200, result)).catch(error => json(response, error.status || 502, { ok: false, error: { code: error.code || "GATEWAY_UPSTREAM", message: error.message } }));
        return;
      }
      if (request.method !== "POST") return json(response, 405, { ok: false, error: { code: "GATEWAY_METHOD", message: "Method not allowed." } });
      const declaredLength = Number(request.headers["content-length"] || 0);
      if (declaredLength > maxBodyBytes) return json(response, 413, { ok: false, error: { code: "GATEWAY_BODY_TOO_LARGE", message: "Request body is too large." } });
      let size = 0; const chunks = [];
      request.on("data", chunk => { size += chunk.length; if (size <= maxBodyBytes) chunks.push(chunk); });
      request.on("end", () => {
        if (size > maxBodyBytes) return json(response, 413, { ok: false, error: { code: "GATEWAY_BODY_TOO_LARGE", message: "Request body is too large." } });
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return json(response, 400, { ok: false, error: { code: "GATEWAY_JSON", message: "Request body must be valid JSON." } }); }
        const action = body.op || body.action;
        if (!actionSet.has(action)) return json(response, 400, { ok: false, error: { code: "GATEWAY_ACTION", message: "Unsupported API action." } });
        const payload = { ...body }; delete payload.op; delete payload.action;
        client.request({ action, payload, operationId: body.operationId || "", adminSessionToken: body.adminSessionToken }).then(result => json(response, 200, result)).catch(error => json(response, error.status || 502, { ok: false, error: { code: error.code || "GATEWAY_UPSTREAM", message: error.message } }));
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { ok: false, error: { code: "GATEWAY_METHOD", message: "Method not allowed." } });
    let filePath;
    try {
      const relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.replace(/^[/\\]+/, ""));
      const root = path.resolve(staticRoot); filePath = path.resolve(root, relative);
      if (filePath !== root && !filePath.startsWith(root + path.sep)) throw new Error("Path traversal");
    } catch { return json(response, 400, { ok: false, error: { code: "GATEWAY_PATH", message: "Invalid path." } }); }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return json(response, 404, { ok: false, error: { code: "GATEWAY_NOT_FOUND", message: "Not found." } });
    response.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (request.method === "HEAD") response.end(); else response.end(fs.readFileSync(filePath));
  });
}

module.exports = { createGatewayServer, validLoopbackHost, validOrigin };
