const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ENVIRONMENTS,
  EnvironmentConfigError,
  resolveEnvironmentConfig,
  validateEnvironmentConfig
} = require(path.join(__dirname, "..", "config", "environment.js"));
const {
  ProductionSafetyError,
  assertSafeTestMutation,
  createGuardedFetch
} = require(path.join(__dirname, "..", "scripts", "test-safety.js"));
const { createTestBackend } = require(path.join(__dirname, "fixtures", "test-backend.js"));
const fixtures = require(path.join(__dirname, "fixtures", "stage-b-fixtures.js"));
const { resolveEndpoint } = require(path.join(__dirname, "..", "cloud-sync.js"));
const {
  buildRuntimeConfigSource,
  resolveStartConfiguration
} = require(path.join(__dirname, "..", "scripts", "start-safe-static.js"));
const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
const expenseScript = fs.readFileSync(path.join(__dirname, "..", "expenses.js"), "utf8");
const configScript = fs.readFileSync(path.join(__dirname, "..", "config.js.example"), "utf8");
const electronBuildPath = path.join(__dirname, "..", "build-electron.bat");
const electronBuildScript = fs.existsSync(electronBuildPath) ? fs.readFileSync(electronBuildPath, "utf8") : null;

const configs = {
  development: {
    environment: "development",
    endpoint: "http://127.0.0.1:3050/api",
    transport: "local-gateway"
  },
  test: {
    environment: "test",
    endpoint: "http://127.0.0.1:3051/test-api",
    transport: "fixture"
  },
  production: {
    environment: "production",
    endpoint: "https://script.google.com/macros/s/REDACTED/exec",
    transport: "apps-script-direct"
  }
};

test("visible maintenance sync is enabled and local Electron builds package the recovery coordinator", t => {
  assert.match(configScript, /AUTO_REFRESH_MS:\s*600000/);
  if (!electronBuildScript) return t.skip("Desktop packaging scripts are kept in the local installation.");
  assert.match(electronBuildScript, /for %%F in \([^\n]*sync-recovery\.js/);
});

test("environment resolver accepts only explicit development, test, or production", () => {
  assert.deepEqual(ENVIRONMENTS, ["development", "test", "production"]);
  assert.equal(resolveEnvironmentConfig({ environment: "test", configs }).environment, "test");
  assert.throws(
    () => resolveEnvironmentConfig({ configs }),
    error => error instanceof EnvironmentConfigError && error.code === "ENVIRONMENT_REQUIRED"
  );
  assert.throws(
    () => resolveEnvironmentConfig({ environment: "qa", configs }),
    error => error instanceof EnvironmentConfigError && error.code === "ENVIRONMENT_UNKNOWN"
  );
});

test("checked-in environment templates are explicit and test-safe", () => {
  const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "environments", name), "utf8"));
  const development = resolveEnvironmentConfig({ environment: "development", configs: { development: read("development.json") } });
  const testConfig = resolveEnvironmentConfig({ environment: "test", configs: { test: read("test.json") } });
  assert.equal(development.transport, "local-gateway");
  assert.equal(testConfig.transport, "fixture");
  assert.doesNotThrow(() => assertSafeTestMutation(testConfig, "fixture mutation"));
  assert.match(read("production.template.json").endpoint, /REPLACE_WITH_DEPLOYMENT/);
});

test("environment resolver fails safely when the selected environment is missing or invalid", () => {
  assert.throws(
    () => resolveEnvironmentConfig({ environment: "test", configs: {} }),
    error => error instanceof EnvironmentConfigError && error.code === "CONFIG_MISSING"
  );
  assert.throws(
    () => validateEnvironmentConfig({ environment: "test", endpoint: "not-a-url" }),
    error => error instanceof EnvironmentConfigError && error.code === "ENDPOINT_INVALID"
  );
  assert.throws(
    () => validateEnvironmentConfig({ environment: "test", endpoint: "https://script.google.com/macros/s/anything/exec" }),
    error => error instanceof EnvironmentConfigError && error.code === "TEST_ENDPOINT_PRODUCTION_HOST"
  );
});

test("test mutations are rejected before a production request can be sent", async () => {
  const config = resolveEnvironmentConfig({ environment: "test", configs });
  assert.throws(
    () => assertSafeTestMutation({ ...config, endpoint: "https://script.google.com/macros/s/live/exec" }, "addRecord"),
    error => error instanceof ProductionSafetyError && error.code === "PRODUCTION_ENDPOINT"
  );

  let calls = 0;
  const guardedFetch = createGuardedFetch({ config, fetchImpl: async () => { calls += 1; } });
  await assert.rejects(
    () => guardedFetch("https://script.google.com/macros/s/live/exec", { method: "POST" }),
    error => error instanceof ProductionSafetyError && error.code === "PRODUCTION_HOST"
  );
  assert.equal(calls, 0);
});

test("production environment cannot be used by the test mutation guard", () => {
  assert.throws(
    () => assertSafeTestMutation(configs.production, "deleteRecord"),
    error => error instanceof ProductionSafetyError && error.code === "TEST_ENVIRONMENT_REQUIRED"
  );
});

test("cloud endpoint resolution is centralized and rejects ambiguous configuration", () => {
  assert.equal(
    resolveEndpoint({ runtimeConfig: { environment: "test", endpoint: "http://127.0.0.1:3051/test-api" } }),
    "http://127.0.0.1:3051/test-api"
  );
  assert.equal(
    resolveEndpoint({ appConfig: { ENVIRONMENT: "production", SCRIPT_URL: "https://script.google.com/macros/s/legacy/exec" } }),
    "https://script.google.com/macros/s/legacy/exec"
  );
  assert.throws(() => resolveEndpoint({}), /explicit .* environment/i);
});

test("renderer cloud access has one logical endpoint boundary", () => {
  assert.match(patientScript, /CloudSync\.resolveEndpoint/);
  assert.doesNotMatch(expenseScript, /fetch\(url\s*\+\s*["']\?op=expenses/);
  assert.match(expenseScript, /window\.cloudGet\(["']expenses["']\)/);
  assert.match(configScript, /ENVIRONMENT:\s*["']production["']/);
});

test("development startup cannot inject the production endpoint into the renderer", () => {
  const development = resolveStartConfiguration("development");
  const source = buildRuntimeConfigSource(development);
  assert.match(source, /["']ENVIRONMENT["']:\s*["']development["']/);
  assert.doesNotMatch(source, /script\.google\.com/i);
  assert.match(source, /127\.0\.0\.1:3050/);
  assert.throws(() => resolveStartConfiguration("unknown"), /environment/i);
});

test("synthetic fixtures cover the Stage B test data contract", () => {
  assert.equal(fixtures.completeRecord["Patient Name"], "Test Patient Alpha");
  assert.equal(fixtures.legacyRecord["Patient Name"], "Test Patient Beta");
  assert.equal(fixtures.cashRecord["Payment Method"], "Cash");
  assert.equal(fixtures.onlineRecord["Payment Method"], "Online");
  assert.equal(fixtures.splitRecord["Payment Method"], "Split");
  assert.equal(fixtures.expense.Amount, 1250);
  assert.equal(fixtures.staleVersionRecord.version, 1);
});

test("isolated test backend supports current mutation operation names without cloud access", async () => {
  const backend = createTestBackend();
  const initial = await backend.get("records");
  assert.equal(initial.ok, true);
  assert.equal(initial.rows.length, 2);

  const added = await backend.post({ op: "addRecord", operationId: "op_test_add_1", row: fixtures.completeRecord });
  assert.equal(added.ok, true);
  assert.equal(added.deduplicated, false);
  assert.equal((await backend.get("records")).rows.length, 3);

  const duplicate = await backend.post({ op: "addRecord", operationId: "op_test_add_1", row: fixtures.completeRecord });
  assert.equal(duplicate.deduplicated, true);
  assert.equal((await backend.get("records")).rows.length, 3);

  const expense = await backend.post({ op: "addExpense", operationId: "op_test_expense_1", expense: fixtures.expense });
  assert.equal(expense.ok, true);
  assert.equal((await backend.get("expenses")).rows.length, 1);

  const updated = await backend.post({
    op: "updateRecord",
    operationId: "op_test_update_1",
    recordId: "rec_test_alpha",
    changes: { Phone: "9000000099" }
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.version, 3);

  const renamed = await backend.post({
    op: "renameReferringDoctor",
    operationId: "op_test_rename_1",
    from: "Test Doctor",
    to: "Test Doctor Renamed"
  });
  assert.equal(renamed.ok, true);

  const savedConfig = await backend.post({
    op: "saveConfig",
    operationId: "op_test_config_1",
    version: "test-config-v2",
    config: { referringDoctors: ["Test Doctor Renamed"] }
  });
  assert.equal(savedConfig.configVersion, "test-config-v2");

  const deleted = await backend.post({
    op: "deleteRecord",
    operationId: "op_test_delete_1",
    recordId: "rec_test_alpha"
  });
  assert.equal(deleted.ok, true);
  assert.equal((await backend.get("records")).rows.some(row => row.recordId === "rec_test_alpha"), false);

  const config = await backend.get("config");
  assert.equal(config.ok, true);
  assert.equal(config.config.referringDoctors.length > 0, true);
  assert.equal(config.config.configVersion, "test-config-v2");
});

test("isolated test backend supports bounded record pages and boolean duplicate lookup", async () => {
  const backend = createTestBackend();
  const first = await backend.get("recordsPage", { limit: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0]._sheetRowIndex, 0);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.availableMonths, ["2026-01", "2025-12"]);
  assert.equal("total" in first, false);

  const next = await backend.get("recordsPage", { limit: 1, cursor: first.nextCursor });
  assert.equal(next.rows[0]._sheetRowIndex, 1);
  assert.equal(next.hasMore, false);
  assert.deepEqual(backend.requests.slice(-2).map(request => request.op), ["recordsPage", "recordsPage"]);

  const duplicate = await backend.get("recordDuplicate", { date: "2026-01-15", patientName: " test   patient alpha " });
  assert.deepEqual(duplicate, { ok: true, duplicate: true });
});
