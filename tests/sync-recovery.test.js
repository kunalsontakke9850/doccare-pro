const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSyncRecovery, serializeSyncHealth } = require(path.join(__dirname, "..", "sync-recovery.js"));

function makeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    get now() { return now; },
    setTimeout(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    async advanceBy(ms) {
      const target = now + ms;
      while (true) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      }
      now = target;
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    },
    get size() { return pending.size; }
  };
}

function classify(error) {
  return error.permanent
    ? { kind: "request", retryable: false, message: "Rejected safely." }
    : { kind: "server", retryable: true, message: "Retrying safely." };
}

test("retries at bounded backoff delays and resets after recovery", async () => {
  const timers = makeTimers();
  let calls = 0;
  const recovery = createSyncRecovery({
    refresh: async () => {
      calls += 1;
      if (calls < 5) throw new Error("temporary");
      return { ok: true };
    },
    classifyError: classify,
    now: () => timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    isOnline: () => true,
    isVisible: () => true,
    refreshIntervalMs: 600000
  });

  await recovery.requestRefresh("startup");
  assert.equal(recovery.getState().nextRetryAt, 5000);
  await timers.advanceBy(5000);
  assert.equal(recovery.getState().nextRetryAt, 20000);
  await timers.advanceBy(15000);
  assert.equal(recovery.getState().nextRetryAt, 80000);
  await timers.advanceBy(60000);
  assert.equal(recovery.getState().nextRetryAt, 380000);
  await timers.advanceBy(300000);
  assert.equal(calls, 5);
  assert.equal(recovery.getState().status, "synced");
  assert.equal(recovery.getState().consecutiveFailures, 0);
  assert.equal(recovery.getState().nextRetryAt, null);
  recovery.dispose();
});

test("online, focus, and visibility triggers join one active refresh", async () => {
  const timers = makeTimers();
  let release;
  let calls = 0;
  const recovery = createSyncRecovery({
    refresh: () => { calls += 1; return new Promise(resolve => { release = resolve; }); },
    classifyError: classify,
    now: () => timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    isOnline: () => true,
    isVisible: () => true
  });
  const first = recovery.requestRefresh("startup");
  await Promise.resolve();
  const online = recovery.notifyOnline();
  const focus = recovery.notifyFocus();
  const visible = recovery.notifyVisibility(true);
  assert.equal(calls, 1);
  release({ ok: true });
  await Promise.all([first, online, focus, visible]);
  assert.equal(calls, 1);
  recovery.dispose();
});

test("permanent failures stop automatic retries but manual retry remains available", async () => {
  const timers = makeTimers();
  let calls = 0;
  const recovery = createSyncRecovery({
    refresh: async () => { calls += 1; throw Object.assign(new Error("sensitive data"), { permanent: true }); },
    classifyError: classify,
    now: () => timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    isOnline: () => true,
    isVisible: () => true
  });
  await recovery.requestRefresh("startup");
  assert.equal(recovery.getState().status, "attention");
  assert.equal(recovery.getState().nextRetryAt, null);
  assert.equal(timers.size, 0);
  await recovery.requestRefresh("manual");
  assert.equal(calls, 2);
  recovery.dispose();
});

test("maintenance refresh pauses while hidden and dispose clears scheduled timers", async () => {
  const timers = makeTimers();
  let visible = true;
  let calls = 0;
  const recovery = createSyncRecovery({
    refresh: async () => { calls += 1; return { ok: true }; },
    classifyError: classify,
    now: () => timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    isOnline: () => true,
    isVisible: () => visible,
    refreshIntervalMs: 600000
  });
  await recovery.requestRefresh("startup");
  visible = false;
  await recovery.notifyVisibility(false);
  await timers.advanceBy(600000);
  assert.equal(calls, 1);
  visible = true;
  await recovery.notifyVisibility(true);
  assert.equal(calls, 2);
  assert.equal(timers.size, 1);
  recovery.dispose();
  assert.equal(timers.size, 0);
});

test("a failed cloud read retains cached records and the original queued operation until confirmation", async () => {
  const timers = makeTimers();
  const cachedRecords = [{ operationId: "record-1", patientName: "Local patient" }];
  const outbox = [{ operationId: "record-1", payload: { operationId: "record-1" } }];
  let attempts = 0;
  const recovery = createSyncRecovery({
    refresh: async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, failure: { kind: "server", retryable: true, message: "Retrying safely." } };
      const confirmed = { operationId: "record-1", patientName: "Cloud patient" };
      outbox.splice(0, 1);
      return { ok: true, entries: [confirmed] };
    },
    classifyError: classify,
    now: () => timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    isOnline: () => true,
    isVisible: () => true
  });
  await recovery.requestRefresh("startup");
  assert.equal(cachedRecords[0].operationId, "record-1");
  assert.equal(outbox[0].operationId, "record-1");
  await timers.advanceBy(5000);
  assert.equal(outbox.length, 0);
  assert.equal(attempts, 2);
  recovery.dispose();
});

test("persisted sync health contains only an allowlist of safe status metadata", () => {
  const serialized = serializeSyncHealth({
    lastSuccessfulRecordsSyncAt: "2026-10-02T10:00:00.000Z",
    lastSuccessfulConfigSyncAt: "2026-10-02T10:00:00.000Z",
    lastFailureAt: "2026-10-02T10:01:00.000Z",
    failureKind: "server",
    consecutiveFailures: 2,
    nextRetryAt: 1790935260000,
    patientName: "Private patient",
    rawError: "Sensitive exception payload",
    endpoint: "https://private.example/exec"
  });
  assert.deepEqual(JSON.parse(serialized), {
    lastSuccessfulRecordsSyncAt: "2026-10-02T10:00:00.000Z",
    lastSuccessfulConfigSyncAt: "2026-10-02T10:00:00.000Z",
    lastFailureAt: "2026-10-02T10:01:00.000Z",
    failureKind: "server",
    consecutiveFailures: 2,
    nextRetryAt: 1790935260000
  });
  assert.equal(serialized.includes("Private patient"), false);
  assert.equal(serialized.includes("Sensitive exception"), false);
  assert.equal(serialized.includes("https://"), false);
});

test("restored health metadata continues the saved backoff sequence and last-success timestamp", async () => {
  const timers = makeTimers();
  const lastSuccessfulAt = "2026-10-02T10:00:00.000Z";
  const recovery = createSyncRecovery({
    refresh: async () => { throw new Error("temporary"); },
    classifyError: classify,
    initialState: { consecutiveFailures: 3, failureKind: "server", lastSuccessfulAt, nextRetryAt: 180000 },
    now: () => timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    isOnline: () => true,
    isVisible: () => true
  });
  assert.equal(recovery.getState().lastSuccessfulAt, lastSuccessfulAt);
  await recovery.start();
  assert.equal(recovery.getState().nextRetryAt, 300000);
  assert.equal(recovery.getState().consecutiveFailures, 4);
  recovery.dispose();
});
