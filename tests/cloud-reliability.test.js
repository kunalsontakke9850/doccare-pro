const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createCloudClient, classifyCloudError } = require(path.join(__dirname, "..", "cloud-sync.js"));
const { formatSyncStatus } = require(path.join(__dirname, "..", "sync-recovery.js"));
const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
const expenseScript = fs.readFileSync(path.join(__dirname, "..", "expenses.js"), "utf8");
const appsScript = fs.readFileSync(path.join(__dirname, "..", "apps-script.gs"), "utf8");
const indexMarkup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

test("cloud errors are classified into safe actionable categories", () => {
  assert.deepEqual(classifyCloudError({ code: "TIMEOUT" }), {
    kind: "timeout",
    retryable: true,
    message: "Cloud request timed out. Retrying automatically."
  });
  assert.deepEqual(classifyCloudError({ status: 503 }), {
    kind: "server",
    retryable: true,
    message: "Cloud service is temporarily unavailable. Retrying automatically."
  });
  assert.deepEqual(classifyCloudError({ status: 400, message: "Patient Name: Jane" }), {
    kind: "request",
    retryable: false,
    message: "Cloud rejected this request. Check the app configuration or contact support."
  });
  assert.deepEqual(classifyCloudError({ status: 400, applicationError: true, message: "network is temporarily busy" }), {
    kind: "request",
    retryable: false,
    message: "Cloud rejected this request. Check the app configuration or contact support."
  });
  assert.deepEqual(classifyCloudError(new Error("Cloud endpoint is not configured for the active environment.")), {
    kind: "configuration",
    retryable: false,
    message: "Cloud endpoint is not configured. Check the app setup."
  });
  assert.equal(classifyCloudError({ status: 400, message: "Patient Name: Jane" }).message.includes("Jane"), false);
  assert.equal(require(path.join(__dirname, "..", "cloud-sync.js")).isTransientError({ status: 400, message: "network unavailable" }), false);
});

test("temporary Apps Script service errors are classified as retryable even inside HTTP-200 error envelopes", () => {
  const error = { applicationError: true, message: "Exception: Service Spreadsheets timed out while accessing document." };
  assert.deepEqual(classifyCloudError(error), {
    kind: "timeout",
    retryable: true,
    message: "Cloud request timed out. Retrying automatically."
  });
  assert.equal(require(path.join(__dirname, "..", "cloud-sync.js")).isTransientError(error), true);
});

test("cloud reads retry a temporary Apps Script error envelope and recover", async () => {
  let calls = 0;
  const client = createCloudClient({
    getUrl: () => "https://example.test/exec",
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response({ ok: false, error: "Exception: Service Spreadsheets timed out while accessing document." })
        : response({ ok: true, config: {} });
    },
    readDelaysMs: [0, 0],
    readMaxAttempts: 2,
    sleep: async () => {}
  });

  const result = await client.get("config");
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test("cloud reads retry bounded transient failures but do not retry permanent errors", async () => {
  const calls = [];
  const outcomes = [new Error("network down"), response({ ok: false, error: "busy" }, 503), response({ ok: true, rows: [] })];
  const client = createCloudClient({
    getUrl: () => "https://example.test/exec",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    sleep: async () => {},
    readMaxAttempts: 3
  });

  await assert.doesNotReject(() => client.get("records"));
  assert.equal(calls.length, 3);

  const permanentCalls = [];
  const permanentClient = createCloudClient({
    getUrl: () => "https://example.test/exec",
    fetchImpl: async () => {
      permanentCalls.push(true);
      return response({ ok: false, error: "invalid" }, 400);
    },
    sleep: async () => {}
  });
  await assert.rejects(() => permanentClient.get("records"), /HTTP 400/);
  assert.equal(permanentCalls.length, 1);
});

test("cloud GET accepts optional query parameters while preserving the legacy operation-only call", async () => {
  const calls = [];
  const client = createCloudClient({
    getUrl: () => "https://example.test/exec",
    readDelaysMs: [0],
    fetchImpl: async url => {
      calls.push(new URL(String(url)));
      return response({ ok: true, rows: [] });
    }
  });

  await client.get("recordsPage", { limit: 10, month: "2026-09", cursor: "abc+/=" });
  await client.get("records");

  assert.deepEqual(Object.fromEntries(calls[0].searchParams.entries()), {
    op: "recordsPage", limit: "10", month: "2026-09", cursor: "abc+/=", _: calls[0].searchParams.get("_")
  });
  assert.equal(calls[1].searchParams.get("op"), "records");
  assert.equal(calls[1].searchParams.has("limit"), false);
});

test("write retry preserves the same operationId and deduplicates the simulated server append", async () => {
  const calls = [];
  const processed = new Set();
  let appendCount = 0;
  const client = createCloudClient({
    getUrl: () => "https://example.test/exec",
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      if (!processed.has(payload.operationId)) {
        processed.add(payload.operationId);
        appendCount += 1;
        throw Object.assign(new Error("response lost after server save"), { code: "TIMEOUT", transient: true });
      }
      return response({ ok: true, operationId: payload.operationId, deduplicated: true });
    },
    sleep: async () => {},
    writeMaxAttempts: 2
  });

  const payload = { op: "addRecord", operationId: "record-op-123", row: { "Patient Name": "Example" } };
  const result = await client.postWithRetry(payload, { dedupeGuaranteed: true });

  assert.equal(result.deduplicated, true);
  assert.equal(appendCount, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].operationId, "record-op-123");
  assert.equal(calls[1].operationId, "record-op-123");
});

test("plain writes are single-attempt until callers explicitly opt into durable deduplication", async () => {
  let calls = 0;
  const client = createCloudClient({
    getUrl: () => "https://example.test/exec",
    fetchImpl: async () => {
      calls += 1;
      throw Object.assign(new Error("timeout"), { code: "TIMEOUT", transient: true });
    },
    sleep: async () => {}
  });

  await assert.rejects(() => client.post({ op: "saveConfig", config: {} }), /timeout/);
  assert.equal(calls, 1);
  await assert.rejects(() => client.postWithRetry({ op: "addRecord", operationId: "x" }), /dedupeGuaranteed/);
});

test("application wires cached-first loading, outbox statuses, refresh guards, and shared requests", () => {
  assert.match(patientScript, /const LS_OUTBOX_KEY\s*=\s*["'][^"']+["']/);
  assert.match(patientScript, /syncStatus\s*=\s*["']pending["']/);
  assert.match(patientScript, /recordsRefreshPromise/);
  assert.match(patientScript, /cloudPostWithRetry/);
  assert.match(patientScript, /cloudGet\(["']capabilities["']\)/);
  assert.match(patientScript, /operationId/);
  assert.match(expenseScript, /cloudGet\(["']expenses["']\)/);
  assert.match(expenseScript, /CloudOutbox\.sync/);
  assert.match(indexMarkup, /id="syncStatus"/);
});

test("coordinated startup refresh stays lightweight and syncs durable writes without fetching inactive records", () => {
  assert.match(patientScript, /async function loadRecordsFromCloud\(\{ reportFailure = true \} = \{\}\)/);
  assert.match(patientScript, /area: "records", ok: false, source: "cache", entries: entriesCache,\s+error/);
  assert.match(patientScript, /async function refreshCloudState\(\{ reason = "manual" \} = \{\}\)/);
  const refresh = patientScript.slice(patientScript.indexOf("async function refreshCloudState("), patientScript.indexOf("async function ensureReportRecordsLoaded("));
  assert.match(refresh, /const outbox = await syncCloudOutbox\(\)/);
  assert.doesNotMatch(refresh, /loadRecordsFromCloud\s*\(/);
  assert.match(patientScript, /return \{ ok: !failed && !outbox\.length/);
  assert.match(patientScript, /initializeSyncRecovery\(\)/);
  assert.match(patientScript, /addEventListener\("online"/);
  assert.match(patientScript, /addEventListener\("focus"/);
  assert.match(patientScript, /addEventListener\("visibilitychange"/);
  assert.match(patientScript, /state\.status === "synced" && recordsListObserved && \["stale", "error"\]\.includes\(recordsPager\?\.getState\(\)\.status\)\)\s*\{\s*void recordsPager\.refresh\(\)/);
});

test("sync status copy and controls are actionable and accessible", () => {
  assert.equal(formatSyncStatus({ status: "retrying", pendingCount: 2, nextRetryAt: 60000, now: 0 }),
    "Reconnecting in 1 min · 2 entries safely saved on this computer");
  assert.equal(formatSyncStatus({ status: "attention", failureKind: "request", pendingCount: 0 }),
    "Sync needs attention · Cloud rejected this request");
  assert.match(indexMarkup, /id="syncStatusDetail"/);
  assert.match(indexMarkup, /aria-live="polite"/);
  assert.match(indexMarkup, /aria-label="Refresh cloud data now"/);
});

test("temporary outbox failures remain queued for a later retry", () => {
  assert.match(patientScript, /let capabilityError = null/);
  assert.match(patientScript, /capabilityError = error/);
  assert.match(patientScript, /status: "pending",\s+lastError: retryMessage/);
  assert.match(patientScript, /const nextStatus = retryable \? "pending" : "failed"/);
  assert.match(patientScript, /retryCount: Number\(operation\.retryCount \|\| 0\) \+ 1/);
});

test("Apps Script uses persistent operation records and a script lock around check-append-mark", () => {
  assert.match(appsScript, /SyncOperations/);
  assert.match(appsScript, /idempotentWrites/);
  assert.match(appsScript, /LockService\.getScriptLock\(\)/);
  assert.match(appsScript, /findProcessedOperation/);
  assert.match(appsScript, /markOperationProcessed/);
  assert.match(appsScript, /operationId/);
  assert.match(appsScript, /appendRow/);
});

test("Apps Script idempotency harness appends one row for two identical operations", () => {
  class FakeRange {
    constructor(sheet, row, column, numRows, numColumns) {
      this.sheet = sheet;
      this.row = row;
      this.column = column;
      this.numRows = numRows;
      this.numColumns = numColumns;
    }
    getValues() {
      const result = [];
      for (let r = 0; r < this.numRows; r += 1) {
        const source = this.sheet.rows[this.row - 1 + r] || [];
        result.push(Array.from({ length: this.numColumns }, (_, c) => source[this.column - 1 + c] ?? ""));
      }
      return result;
    }
    setValues(values) {
      values.forEach((row, r) => {
        const target = this.sheet.rows[this.row - 1 + r] || [];
        row.forEach((value, c) => { target[this.column - 1 + c] = value; });
        this.sheet.rows[this.row - 1 + r] = target;
      });
    }
  }
  class FakeSheet {
    constructor(name) { this.name = name; this.rows = []; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return this.rows.reduce((max, row) => Math.max(max, row.length), 0); }
    getRange(row, column, numRows, numColumns) { return new FakeRange(this, row, column, numRows, numColumns); }
    appendRow(row) { this.rows.push(row.slice()); }
  }
  class FakeSpreadsheet {
    constructor() { this.sheets = new Map(); }
    getSheetByName(name) { return this.sheets.get(name) || null; }
    insertSheet(name) { const sheet = new FakeSheet(name); this.sheets.set(name, sheet); return sheet; }
  }

  const spreadsheet = new FakeSpreadsheet();
  let lockWaits = 0;
  let lockReleases = 0;
  const context = {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => { lockWaits += 1; },
        releaseLock: () => { lockReleases += 1; }
      })
    },
    ContentService: { createTextOutput: () => ({ setMimeType() { return this; }, setContent() { return this; } }), MimeType: { JSON: "json" } },
    Utilities: { formatDate: () => "timestamp" },
    Session: { getScriptTimeZone: () => "GMT" },
    console
  };
  vm.runInNewContext(appsScript, context);

  const first = context.appendIdempotentOperation(
    "record-op-1", "addRecord", "Records", ["Operation ID", "Value"], { Value: "example" }
  );
  const second = context.appendIdempotentOperation(
    "record-op-1", "addRecord", "Records", ["Operation ID", "Value"], { Value: "example" }
  );

  assert.equal(first.ok, true);
  assert.equal(first.deduplicated, false);
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(first.rowNumber, 2);
  assert.equal(second.rowNumber, 2);
  assert.equal(spreadsheet.getSheetByName("Records").getLastRow(), 2);
  assert.equal(lockWaits, 2);
  assert.equal(lockReleases, 2);
});
