const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  resolveEndpoint,
  createCloudClient
} = require("../cloud-sync.js");
const {
  buildRuntimeConfigSource,
  resolveStartConfiguration
} = require("../scripts/start-safe-static.js");

const SCRIPT_URL = "https://script.google.com/macros/s/existing-deployment/exec";

function response(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; }
  };
}

test("production endpoint prefers the configured Apps Script URL over the gateway path", () => {
  assert.equal(
    resolveEndpoint({
      appConfig: {
        ENVIRONMENT: "production",
        API_BASE_URL: "/api",
        SCRIPT_URL
      }
    }),
    SCRIPT_URL
  );
});

test("bundled production configuration exposes SCRIPT_URL without an API gateway override", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "config.js.example"), "utf8");
  assert.match(source, /SCRIPT_URL\s*=\s*["']https:\/\/script\.google\.com\/macros\/s\//);
  assert.doesNotMatch(source, /API_BASE_URL\s*:/);
});

test("production startup preserves the direct renderer configuration", () => {
  const production = resolveStartConfiguration("production");
  const source = buildRuntimeConfigSource(production, {
    productionSource: "var SCRIPT_URL = 'https://script.google.com/macros/s/existing/exec';"
  });
  assert.match(source, /script\.google\.com\/macros\/s\/existing\/exec/);
  assert.doesNotMatch(source, /DOCCARE_GATEWAY_SECRET|hmac/i);
});

test("direct cloud reads call each supported operation on SCRIPT_URL", async () => {
  const calls = [];
  const client = createCloudClient({
    getUrl: () => SCRIPT_URL,
    readDelaysMs: [0],
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return response({ ok: true, rows: [] });
    }
  });

  for (const operation of ["ping", "capabilities", "config", "records", "expenses"]) {
    await client.get(operation);
  }

  assert.deepEqual(
    calls.map(call => new URL(call.url).origin + new URL(call.url).pathname),
    Array(5).fill(SCRIPT_URL)
  );
  assert.deepEqual(
    calls.map(call => new URL(call.url).searchParams.get("op")),
    ["ping", "capabilities", "config", "records", "expenses"]
  );
});

test("direct cloud writes post the legacy operation envelope without gateway fields", async () => {
  let request;
  const client = createCloudClient({
    getUrl: () => SCRIPT_URL,
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return response({ ok: true });
    }
  });

  await client.post({ op: "addRecord", operationId: "op_direct_test", row: { "Patient Name": "Synthetic" } });

  assert.equal(request.url, SCRIPT_URL);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["Content-Type"], "text/plain;charset=utf-8");
  assert.deepEqual(JSON.parse(request.init.body), {
    op: "addRecord",
    operationId: "op_direct_test",
    row: { "Patient Name": "Synthetic" }
  });
  assert.doesNotMatch(request.init.body, /protocolVersion|signature|payloadHash|nonce|deviceId/);
});
