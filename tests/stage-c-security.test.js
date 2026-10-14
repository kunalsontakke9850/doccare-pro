const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const {
  canonicalize,
  hashCanonicalJson,
  canonicalRequestString
} = require(path.join(__dirname, "..", "gateway", "canonicalize.js"));
const {
  createRequestEnvelope,
  verifyRequestEnvelope
} = require(path.join(__dirname, "..", "gateway", "signing.js"));
const { createSignedCloudClient } = require(path.join(__dirname, "..", "gateway", "cloud-client.js"));
const { createDeviceIdentity } = require(path.join(__dirname, "..", "gateway", "credentials.js"));
const { createGatewayServer } = require(path.join(__dirname, "..", "gateway", "server.js"));

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return body; } };
}

function start(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function stop(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test("canonical JSON sorts object keys recursively while preserving array order", () => {
  const left = { b: 2, nested: { z: true, a: null }, a: ["x", { d: 4, c: 3 }] };
  const right = { a: ["x", { c: 3, d: 4 }], nested: { a: null, z: true }, b: 2 };
  assert.equal(canonicalize(left), canonicalize(right));
  assert.equal(hashCanonicalJson(left), hashCanonicalJson(right));
  assert.notEqual(canonicalize({ a: [1, 2] }), canonicalize({ a: [2, 1] }));
  assert.throws(() => canonicalize({ bad: undefined }), /unsupported|undefined/i);
  assert.throws(() => canonicalize({ bad: Infinity }), /finite|unsupported/i);
});

test("canonical request string uses the approved field order", () => {
  const value = canonicalRequestString("POST", {
    protocolVersion: 1,
    requestId: "req-1",
    operationId: "op-1",
    deviceId: "dev-1",
    timestamp: "2026-09-20T12:00:00.000Z",
    nonce: "nonce-1",
    action: "records",
    payloadHash: "hash-1"
  });
  assert.equal(
    value,
    "POST\nrecords\n2026-09-20T12:00:00.000Z\nnonce-1\nreq-1\nop-1\nhash-1\n1"
  );
});

test("signed envelopes verify, preserve operation IDs, and reject payload tampering", () => {
  const secret = "stage-c-test-secret";
  const now = new Date("2026-09-20T12:00:00.000Z");
  const envelope = createRequestEnvelope({
    method: "POST",
    action: "addRecord",
    payload: { row: { "Patient Name": "Test Patient Alpha" } },
    operationId: "op_test_retry_1",
    deviceId: "dev_test_1",
    secret,
    now,
    requestId: "req_test_1",
    nonce: "nonce_test_1"
  });
  const replayStore = { seen: new Set(), has(key) { return this.seen.has(key); }, add(key) { this.seen.add(key); } };
  assert.equal(verifyRequestEnvelope({ envelope, method: "POST", secret, now, replayStore }).ok, true);
  assert.equal(envelope.operationId, "op_test_retry_1");
  assert.throws(
    () => verifyRequestEnvelope({ envelope, method: "POST", secret, now, replayStore }),
    error => error.code === "AUTH_REPLAY"
  );
  const tampered = { ...envelope, payload: { row: { "Patient Name": "Tampered" } } };
  assert.throws(
    () => verifyRequestEnvelope({ envelope: tampered, method: "POST", secret, now, replayStore: { has: () => false, add() {} } }),
    error => error.code === "AUTH_PAYLOAD_TAMPERED"
  );
});

test("signed cloud client creates fresh request metadata while preserving operation ID", async () => {
  const calls = [];
  const secret = "cloud-client-test-secret";
  const client = createSignedCloudClient({
    endpoint: "https://example.test/apps-script",
    secretProvider: () => secret,
    deviceIdProvider: () => "dev_test_cloud",
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    nonceFactory: (() => { let n = 0; return () => `nonce-${++n}`; })(),
    requestIdFactory: (() => { let n = 0; return () => `req-${++n}`; })(),
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return response({ ok: true, accepted: true });
    }
  });
  await client.request({ action: "addRecord", payload: { row: { value: 1 } }, operationId: "op-retry-1" });
  await client.request({ action: "addRecord", payload: { row: { value: 1 } }, operationId: "op-retry-1" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].operationId, calls[1].operationId);
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  assert.notEqual(calls[0].nonce, calls[1].nonce);
  const replayStore = { has: () => false, add() {} };
  assert.equal(verifyRequestEnvelope({ envelope: calls[0], method: "POST", secret, now: new Date("2026-09-20T12:00:00.000Z"), replayStore }).ok, true);
});

test("device identity is stable across provider instances", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "doccare-stage-c-"));
  try {
    const filePath = path.join(tempDir, "device-id");
    const first = createDeviceIdentity({ filePath });
    const second = createDeviceIdentity({ filePath });
    assert.match(first.get(), /^dev_[0-9a-f-]{36}$/i);
    assert.equal(first.get(), second.get());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gateway proxies only approved local API requests and rejects hostile origins and oversized payloads", async () => {
  const calls = [];
  const server = createGatewayServer({
    staticRoot: path.join(__dirname, ".."),
    runtimeConfigSource: "window.APP_CONFIG = { API_BASE_URL: '/api', ENVIRONMENT: 'test' };",
    cloudClient: { request: async request => { calls.push(request); return { ok: true, action: request.action }; } },
    maxBodyBytes: 120
  });
  const port = await start(server);
  try {
    const good = await fetch(`http://127.0.0.1:${port}/api?op=records`);
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { ok: true, action: "records" });
    assert.equal(calls[0].action, "records");

    const hostile = await fetch(`http://127.0.0.1:${port}/api?op=records`, { headers: { Origin: "http://evil.example" } });
    assert.equal(hostile.status, 403);

    const large = await fetch(`http://127.0.0.1:${port}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "addRecord", row: { value: "x".repeat(500) } })
    });
    assert.equal(large.status, 413);

    const config = await fetch(`http://127.0.0.1:${port}/config.js`);
    const configText = await config.text();
    assert.doesNotMatch(configText, /secret|hmac|script\.google\.com/i);
  } finally {
    await stop(server);
  }
});

test("gateway admin session uses challenge/proof without forwarding the password upstream", async () => {
  const password = "Stage-C-Admin-Password!";
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, "sha256");
  const calls = [];
  const server = createGatewayServer({
    staticRoot: path.join(__dirname, ".."),
    runtimeConfigSource: "window.APP_CONFIG = { API_BASE_URL: '/api', ENVIRONMENT: 'test' };",
    cloudClient: {
      request: async request => {
        calls.push(request);
        if (request.action === "adminChallenge") return { ok: true, challenge: "challenge-stage-c" };
        if (request.action === "adminCredential") return { ok: true, credential: { version: 1, algorithm: "PBKDF2-SHA-256", iterations: 210000, salt: salt.toString("base64"), hash: hash.toString("base64") } };
        if (request.action === "adminVerify") return { ok: true, sessionToken: "session-stage-c" };
        throw new Error("unexpected action");
      }
    }
  });
  const port = await start(server);
  try {
    const result = await fetch(`http://127.0.0.1:${port}/api/admin/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true, sessionToken: "session-stage-c" });
    assert.deepEqual(calls.map(call => call.action), ["adminChallenge", "adminCredential", "adminVerify"]);
    assert.equal(calls.some(call => JSON.stringify(call).includes(password)), false);
    assert.match(calls[2].payload.proof, /^[0-9a-f]{64}$/);
  } finally {
    await stop(server);
  }
});

test("example renderer configuration has a placeholder endpoint and no gateway secrets", () => {
  const rendererConfig = fs.readFileSync(path.join(__dirname, "..", "config.js.example"), "utf8");
  assert.match(rendererConfig, /REPLACE_WITH_YOUR_DEPLOYMENT/);
  assert.match(rendererConfig, /SCRIPT_URL(?::\s*SCRIPT_URL|\s*,)/);
  assert.doesNotMatch(rendererConfig, /DOCCARE_GATEWAY_SECRET|DOCCARE_APPS_SCRIPT_URL|hmac/i);
  const patient = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  assert.doesNotMatch(patient, /HARDCODED_ADMIN_PASSWORD|AKfycb/);
});

test.skip("Apps Script rejects unsigned protected reads and mutations before business logic", {
  skip: "Stage C Apps Script authentication is inactive while the direct legacy backend is restored."
}, () => {
  const appsScript = fs.readFileSync(path.join(__dirname, "..", "apps-script.gs"), "utf8");
  const context = createAppsScriptContext();
  vm.runInNewContext(appsScript, context);
  const readResponse = parseAppsScriptResponse(context.doPost({ postData: { contents: JSON.stringify({ op: "records" }) } }));
  const writeResponse = parseAppsScriptResponse(context.doPost({ postData: { contents: JSON.stringify({ op: "addRecord", operationId: "op-unsigned", row: {} }) } }));
  assert.equal(readResponse.ok, false);
  assert.equal(readResponse.error.code, "AUTH_REQUIRED");
  assert.equal(writeResponse.ok, false);
  assert.equal(writeResponse.error.code, "AUTH_REQUIRED");
});

test.skip("Apps Script accepts a valid signed read, rejects replay, and protects admin mutations", {
  skip: "Stage C Apps Script authentication is inactive while the direct legacy backend is restored."
}, () => {
  const appsScript = fs.readFileSync(path.join(__dirname, "..", "apps-script.gs"), "utf8");
  const context = createAppsScriptContext();
  vm.runInNewContext(appsScript, context);
  const secret = "apps-script-test-secret";
  const envelope = createRequestEnvelope({
    method: "POST",
    action: "records",
    payload: {},
    deviceId: "dev_stage_c_apps_script",
    secret,
    now: new Date(),
    requestId: "req_stage_c_records",
    nonce: "nonce_stage_c_records"
  });
  const success = parseAppsScriptResponse(context.doPost({ postData: { contents: JSON.stringify(envelope) } }));
  assert.equal(success.ok, true);
  assert.ok(Array.isArray(success.rows));
  const replay = parseAppsScriptResponse(context.doPost({ postData: { contents: JSON.stringify(envelope) } }));
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "AUTH_REPLAY");

  const adminEnvelope = createRequestEnvelope({
    method: "POST",
    action: "saveConfig",
    payload: { config: {}, version: "stage-c" },
    deviceId: "dev_stage_c_apps_script_admin",
    secret,
    now: new Date(),
    requestId: "req_stage_c_admin",
    nonce: "nonce_stage_c_admin"
  });
  const adminResponse = parseAppsScriptResponse(context.doPost({ postData: { contents: JSON.stringify(adminEnvelope) } }));
  assert.equal(adminResponse.ok, false);
  assert.equal(adminResponse.error.code, "AUTH_ADMIN_REQUIRED");
});

function parseAppsScriptResponse(output) {
  return JSON.parse(output.content);
}

function createAppsScriptContext() {
  const cache = new Map();
  const properties = new Map([["DOCCARE_GATEWAY_SECRET", "apps-script-test-secret"]]);
  const rows = [["Date", "Age", "Patient Name", "Scan Type", "2D Scan", "Purpose of CBCT", "Scan Fees", "Radiologist Name", "Radiologist Fees", "Referring Doctor", "Consultation Fees", "Total Fees", "Phone", "Payment Method", "Cash Amount", "Online Amount", "Edit History", "Operation ID"]];
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getRange: (row, column, rowCount, columnCount) => ({
      getValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => rows[row - 1 + r]?.[column - 1 + c] ?? "")),
      setValues: values => values.forEach((line, r) => { rows[row - 1 + r] = line.slice(); })
    }),
    appendRow: row => rows.push(row.slice())
  };
  const spreadsheet = { getSheetByName: name => name === "Records" ? sheet : null, getSheets: () => [sheet] };
  return {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key) || null, put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: content => ({ content, setMimeType() { return this; }, setContent(value) { this.content = value; return this; } }), MimeType: { JSON: "json" } },
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      computeDigest: (_algorithm, value) => Array.from(crypto.createHash("sha256").update(String(value), "utf8").digest()),
      computeHmacSha256Signature: (value, key) => Array.from(crypto.createHmac("sha256", Buffer.from(key)).update(Buffer.from(value)).digest()),
      base64Decode: value => Array.from(Buffer.from(value, "base64")),
      base64Encode: value => Buffer.from(value).toString("base64"),
      getUuid: () => "test-session-uuid",
      formatDate: () => "timestamp"
    },
    Session: { getScriptTimeZone: () => "GMT" },
    console
  };
}
