const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRecordPager, createSubmissionGate, queueRecordSave, formatRecordPageInfo, hasDuplicateRecord, checkRecordDuplicate } = require("../records-paging.js");

function page(rows, { hasMore = false, nextCursor = null, extra = {} } = {}) {
  return { ok: true, rows, hasMore, nextCursor, ...extra };
}

test("record pager requests only the first ten rows and formats a count-free range", async () => {
  const requests = [];
  const pager = createRecordPager({
    fetchPage: async query => {
      requests.push(query);
      return page(Array.from({ length: 10 }, (_, index) => ({ patientName: `Patient ${index + 1}` })));
    }
  });

  const state = await pager.loadFirst();

  assert.deepEqual(requests, [{ month: "", cursor: null, limit: 10 }]);
  assert.equal(state.rows.length, 10);
  assert.equal(state.page, 1);
  assert.equal(formatRecordPageInfo(state.page, state.rows.length), "Showing 1 - 10");
  assert.equal(formatRecordPageInfo(2, 10), "Showing 11 - 20");
  assert.equal("total" in state, false);
});

test("next requests the cursor page and previous reuses the exact cached rows and sheet indexes", async () => {
  const requests = [];
  const firstRows = [{ patientName: "First", sheetRowIndex: 0 }];
  const secondRows = [{ patientName: "Second", sheetRowIndex: 13 }];
  const pager = createRecordPager({
    fetchPage: async query => {
      requests.push(query);
      return query.cursor
        ? page(secondRows)
        : page(firstRows, { hasMore: true, nextCursor: "cursor-1" });
    }
  });

  await pager.loadFirst();
  const second = await pager.next();
  const previous = await pager.previous();

  assert.deepEqual(requests, [
    { month: "", cursor: null, limit: 10 },
    { month: "", cursor: "cursor-1", limit: 10 }
  ]);
  assert.equal(second.rows[0].sheetRowIndex, 13);
  assert.equal(previous.rows[0], firstRows[0]);
  assert.equal(previous.page, 1);
});

test("changing month resets to page one and sends the selected month", async () => {
  const requests = [];
  const pager = createRecordPager({
    fetchPage: async query => {
      requests.push(query);
      return query.month === "2026-09"
        ? page([{ patientName: "September" }])
        : page([{ patientName: "October" }], { hasMore: true, nextCursor: "oct-next" });
    }
  });

  await pager.loadFirst();
  await pager.next();
  const state = await pager.setMonth("2026-09");

  assert.equal(state.page, 1);
  assert.equal(state.month, "2026-09");
  assert.equal(state.rows[0].patientName, "September");
  assert.deepEqual(requests.at(-1), { month: "2026-09", cursor: null, limit: 10 });
});

test("failed refresh retains the same query page as stale cache and does not change the page boundary", async () => {
  const cachedRows = [{ patientName: "Cached", sheetRowIndex: 8 }];
  let fail = false;
  const pager = createRecordPager({
    fetchPage: async () => {
      if (fail) throw new Error("offline");
      return page(cachedRows);
    }
  });

  await pager.loadFirst();
  fail = true;
  const stale = await pager.refresh();

  assert.equal(stale.rows[0], cachedRows[0]);
  assert.equal(stale.source, "cache");
  assert.equal(stale.status, "stale");
  assert.equal(stale.error.message, "offline");
  assert.equal(stale.page, 1);
});

test("a cache miss on another month remains an explicit error with no unrelated rows", async () => {
  const pager = createRecordPager({ fetchPage: async () => { throw new Error("offline"); } });
  await pager.loadFirst();
  const state = await pager.setMonth("2026-08");

  assert.equal(state.rows.length, 0);
  assert.equal(state.source, "none");
  assert.equal(state.status, "error");
  assert.equal(state.error.message, "offline");
});

test("a late response for an old month cannot overwrite the newly selected month", async () => {
  let resolveOld;
  const pager = createRecordPager({
    fetchPage: query => query.month === ""
      ? new Promise(resolve => { resolveOld = resolve; })
      : Promise.resolve(page([{ patientName: "September" }]))
  });

  const oldRequest = pager.loadFirst();
  const newState = await pager.setMonth("2026-09");
  resolveOld(page([{ patientName: "Old response" }]));
  await oldRequest;

  assert.equal(newState.rows[0].patientName, "September");
  assert.equal(pager.getState().month, "2026-09");
  assert.equal(pager.getState().rows[0].patientName, "September");
});

test("two next actions during one request issue a single page fetch", async () => {
  const requests = [];
  let resolveNext;
  const pager = createRecordPager({
    fetchPage: query => {
      requests.push(query);
      if (query.cursor) return new Promise(resolve => { resolveNext = resolve; });
      return Promise.resolve(page([{ patientName: "First" }], { hasMore: true, nextCursor: "next" }));
    }
  });

  await pager.loadFirst();
  const firstNext = pager.next();
  const duplicateNext = pager.next();
  await Promise.resolve();
  resolveNext(page([{ patientName: "Second" }]));
  await Promise.all([firstNext, duplicateNext]);

  assert.equal(requests.length, 2);
  assert.equal(requests[1].cursor, "next");
  assert.equal(pager.getState().rows[0].patientName, "Second");
});

test("submission gate rejects a second submit while duplicate lookup or save is pending", async () => {
  const gate = createSubmissionGate();
  let finishFirst;
  const releaseFirst = gate.acquire();
  assert.equal(typeof releaseFirst, "function");
  const pending = new Promise(resolve => { finishFirst = resolve; });
  assert.equal(gate.acquire(), null);
  finishFirst();
  await pending;
  releaseFirst();
  assert.equal(typeof gate.acquire(), "function");
});

test("record save returns after durable enqueue without waiting for cloud sync", async () => {
  const events = [];
  let finishSync;
  const sync = new Promise(resolve => { finishSync = resolve; });
  const accepted = queueRecordSave({
    enqueue: () => { events.push("enqueued"); return "saved-locally"; },
    sync: () => { events.push("sync-started"); return sync; },
    refresh: () => { events.push("refreshed"); }
  });
  assert.equal(accepted, "saved-locally");
  assert.deepEqual(events, ["enqueued"]);
  await Promise.resolve();
  assert.deepEqual(events, ["enqueued", "sync-started"]);
  finishSync();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["enqueued", "sync-started", "refreshed"]);
});

test("duplicate detection normalizes date, case, and repeated whitespace", () => {
  const records = [
    { date: "2026-09-02", patientName: "Sukhada Patil" },
    { date: "2026-09-02", patientName: "Different Patient" }
  ];

  assert.equal(hasDuplicateRecord(records, "2026-09-02", "  SUKHADA   PATIL "), true);
  assert.equal(hasDuplicateRecord(records, "2026-09-03", "Sukhada Patil"), false);
});

test("cloud duplicate lookup checks records beyond the loaded page and returns only verification status", async () => {
  const calls = [];
  const result = await checkRecordDuplicate({
    entry: { date: "2026-09-02", patientName: "Sukhada Patil" },
    records: [{ date: "2026-10-01", patientName: "Another Patient" }],
    cloudConfigured: true,
    online: true,
    cloudGet: async (operation, params) => {
      calls.push({ operation, params });
      return { duplicate: true };
    }
  });

  assert.deepEqual(calls, [{ operation: "recordDuplicate", params: { date: "2026-09-02", patientName: "Sukhada Patil" } }]);
  assert.deepEqual(result, { duplicate: true, verified: true, source: "cloud" });
});

test("offline duplicate lookup checks known records but permits saving when unknown", async () => {
  const entry = { date: "2026-09-02", patientName: "Sukhada Patil" };
  const duplicate = await checkRecordDuplicate({ entry, records: [entry], online: false, cloudConfigured: true });
  const unknown = await checkRecordDuplicate({ entry, records: [], online: false, cloudConfigured: true });

  assert.deepEqual(duplicate, { duplicate: true, verified: true, source: "cache" });
  assert.deepEqual(unknown, { duplicate: false, verified: false, source: "cache" });
});

test("mutation invalidation clears persisted pages for every month before reloading page one", async () => {
  const requests = [];
  const cleared = [];
  const pager = createRecordPager({
    fetchPage: async query => {
      requests.push(query);
      return page([{ patientName: "Fresh" }]);
    },
    clearCache: month => cleared.push(month)
  });
  await pager.loadFirst();
  const state = await pager.invalidate();
  assert.deepEqual(cleared, [null]);
  assert.deepEqual(requests, [
    { month: "", cursor: null, limit: 10 },
    { month: "", cursor: null, limit: 10 }
  ]);
  assert.equal(state.rows[0].patientName, "Fresh");
});

test("the paging module loads before patient.js and local Electron builds include it", t => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<script src="records-paging\.js[^>]*><\/script>[\s\S]*?<dialog id="appPromptDialog"[\s\S]*?<\/dialog>\s*<script src="app-dialog\.js[^>]*><\/script>\s*<script src="patient\.js/);
  const buildPath = path.join(__dirname, "..", "build-electron.bat");
  if (!fs.existsSync(buildPath)) return t.skip("Desktop packaging scripts are kept in the local installation.");
  const buildScript = fs.readFileSync(buildPath, "utf8");
  assert.match(buildScript, /for %%F in \([^\n]*app-dialog\.js/);
});
