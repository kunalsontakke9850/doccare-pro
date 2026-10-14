const test = require("node:test");
const assert = require("node:assert/strict");

const { createFetch } = require("../demo-backend.js");

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values
  };
}

async function json(fetchImpl, path, init) {
  const response = await fetchImpl(path, init);
  return { response, body: await response.json() };
}

function getPath(op, params = {}) {
  const query = new URLSearchParams({ op, ...params });
  return `/demo-api?${query}`;
}

function post(payload) {
  return {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  };
}

test("demo reads seed only fictional records, expenses, and clinic config", async () => {
  const fetchImpl = createFetch({ storage: makeStorage() });
  const [{ body: records }, { body: expenses }, { body: config }] = await Promise.all([
    json(fetchImpl, getPath("records")),
    json(fetchImpl, getPath("expenses")),
    json(fetchImpl, getPath("config"))
  ]);

  assert.equal(records.ok, true);
  assert.ok(records.rows.length >= 2);
  assert.ok(records.rows.every(row => /^(Sample|Demo)\b/.test(row["Patient Name"])));
  assert.ok(records.rows.every(row => !row.Phone || row.Phone === "0000000000"));
  assert.equal(expenses.ok, true);
  assert.ok(expenses.rows.every(row => /^(Sample|Demo)\b/.test(row.Description)));
  assert.equal(config.ok, true);
  assert.ok(config.config.referringDoctors.every(name => /^Demo\b/.test(name)));
});

test("demo record pages filter months, sort newest first, and return synthetic metadata", async () => {
  const fetchImpl = createFetch({ storage: makeStorage() });
  const { body } = await json(fetchImpl, getPath("recordsPage", { month: "2026-03", limit: "1" }));

  assert.equal(body.ok, true);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0]["Patient Name"], "Sample Patient B");
  assert.equal(body.rows[0]._sheetRowIndex, 1);
  assert.equal(body.hasMore, true);
  assert.match(body.nextCursor, /^demo:/);
  assert.ok(body.availableMonths.every(month => /^2026-/.test(month)));
  assert.ok(body.referringDoctors.every(name => /^Demo\b/.test(name)));
});

test("demo duplicate lookup returns a boolean without patient details", async () => {
  const fetchImpl = createFetch({ storage: makeStorage() });
  const found = await json(fetchImpl, getPath("recordDuplicate", {
    date: "2026-03-20", patientName: "  SAMPLE   PATIENT B "
  }));
  const missing = await json(fetchImpl, getPath("recordDuplicate", {
    date: "2026-03-20", patientName: "Unknown"
  }));

  assert.deepEqual(found.body, { ok: true, duplicate: true });
  assert.deepEqual(missing.body, { ok: true, duplicate: false });
});

test("demo record writes persist and repeated operation IDs are deduplicated", async () => {
  const storage = makeStorage();
  const firstClient = createFetch({ storage, now: () => new Date("2026-03-21T12:00:00Z") });
  const { body: added } = await json(firstClient, "/demo-api", post({
    op: "addRecord",
    operationId: "demo-add-1",
    row: { Date: "2026-03-21", "Patient Name": "Sample Patient C", "Total Fees": 900 }
  }));
  const { body: repeated } = await json(firstClient, "/demo-api", post({
    op: "addRecord",
    operationId: "demo-add-1",
    row: { Date: "2026-03-21", "Patient Name": "Sample Patient C", "Total Fees": 900 }
  }));
  const secondClient = createFetch({ storage });
  const { body: records } = await json(secondClient, getPath("records"));

  assert.equal(added.ok, true);
  assert.equal(repeated.deduplicated, true);
  assert.equal(records.rows.filter(row => row.recordId === added.recordId).length, 1);
});

test("demo rejects a real-looking phone value and repairs stored records that contain one", async () => {
  const storage = makeStorage();
  const fetchImpl = createFetch({ storage });
  const rejected = await json(fetchImpl, "/demo-api", post({
    op: "addRecord",
    row: { "Patient Name": "Sample Patient C", Phone: "9876543210" }
  }));
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.code, "DEMO_DATA_ONLY");

  storage.setItem("doccare-pro-demo-v1", JSON.stringify({
    records: [{ "Patient Name": "Sample Patient C", Phone: "9876543210" }],
    expenses: [], config: {}, operations: {}
  }));
  const repaired = createFetch({ storage });
  const { body } = await json(repaired, getPath("records"));
  assert.ok(body.rows.every(row => !row.Phone || row.Phone === "0000000000"));
});

test("demo record update and delete accept the current row index contract", async () => {
  const fetchImpl = createFetch({ storage: makeStorage() });
  const update = await json(fetchImpl, "/demo-api", post({
    op: "updateRecord",
    rowIndex: 0,
    row: { "Patient Name": "Sample Patient Updated" }
  }));
  const { body: afterUpdate } = await json(fetchImpl, getPath("records"));
  const remove = await json(fetchImpl, "/demo-api", post({ op: "deleteRecord", rowIndex: 0 }));
  const { body: afterDelete } = await json(fetchImpl, getPath("records"));

  assert.equal(update.body.ok, true);
  assert.equal(afterUpdate.rows[0]["Patient Name"], "Sample Patient Updated");
  assert.equal(remove.body.ok, true);
  assert.equal(afterDelete.rows.length, afterUpdate.rows.length - 1);
});

test("demo expense and config mutations update browser-local data", async () => {
  const fetchImpl = createFetch({ storage: makeStorage() });
  const expense = await json(fetchImpl, "/demo-api", post({
    op: "addExpense",
    operationId: "demo-expense-1",
    expense: { Date: "2026-03-21", Description: "Demo stationery", Amount: 125 }
  }));
  const config = await json(fetchImpl, "/demo-api", post({
    op: "saveConfig",
    config: { referringDoctors: ["Demo Doctor Updated"] }
  }));
  const { body: expenses } = await json(fetchImpl, getPath("expenses"));
  const { body: configAfter } = await json(fetchImpl, getPath("config"));

  assert.equal(expense.body.ok, true);
  assert.equal(config.body.ok, true);
  assert.equal(expenses.rows.at(-1).Description, "Demo stationery");
  assert.deepEqual(configAfter.config.referringDoctors, ["Demo Doctor Updated"]);
});

test("demo doctor rename changes only synthetic records and config", async () => {
  const fetchImpl = createFetch({ storage: makeStorage() });
  const renamed = await json(fetchImpl, "/demo-api", post({
    op: "renameReferringDoctor",
    oldName: "Demo Doctor One",
    newName: "Demo Doctor Two"
  }));
  const { body: records } = await json(fetchImpl, getPath("records"));

  assert.equal(renamed.body.ok, true);
  assert.ok(records.rows.some(row => row["Referring Doctor"] === "Demo Doctor Two"));
  assert.ok(records.rows.every(row => !row["Patient Name"] || /^(Sample|Demo)\b/.test(row["Patient Name"])));
});

test("malformed demo storage is replaced with clean synthetic seed data", async () => {
  const storage = makeStorage({ "doccare-pro-demo-v1": "{broken" });
  const fetchImpl = createFetch({ storage });
  const { body } = await json(fetchImpl, getPath("records"));

  assert.equal(body.ok, true);
  assert.ok(body.rows.length >= 2);
  assert.ok(body.rows.every(row => /^(Sample|Demo)\b/.test(row["Patient Name"])));
});

test("demo rejects external hosts, protected admin sessions, and unknown routes without network fallback", async () => {
  const originalFetch = global.fetch;
  let networkCalls = 0;
  global.fetch = async () => { networkCalls += 1; throw new Error("network must stay unused"); };
  try {
    const fetchImpl = createFetch({ storage: makeStorage() });
    const external = await json(fetchImpl, "https://script.google.com/macros/s/example/exec?op=records");
    const admin = await json(fetchImpl, "/demo-api/admin/session", post({ password: "anything" }));
    const unknown = await json(fetchImpl, "/not-demo-api?op=records");

    assert.equal(external.response.status, 403);
    assert.equal(admin.response.status, 403);
    assert.equal(unknown.response.status, 404);
    assert.equal(networkCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("unknown demo operations return a bounded error response", async () => {
  const fetchImpl = createFetch({ storage: makeStorage() });
  const { response, body } = await json(fetchImpl, getPath("unknown-operation"));

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.ok(body.error);
});
