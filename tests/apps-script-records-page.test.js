const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createSheet(records, metrics = null, headerOrder = null) {
  const headers = headerOrder || [
    "Date", "Age", "Patient Name", "Scan Type", "2D Scan", "Purpose of CBCT", "Scan Fees",
    "Radiologist Name", "Radiologist Fees", "Referring Doctor", "Consultation Fees", "Total Fees",
    "Phone", "Payment Method", "Cash Amount", "Online Amount", "Edit History", "Operation ID"
  ];
  const values = [headers, ...records.map(record => headers.map(header => record[header] ?? ""))];
  return {
    getLastRow: () => values.length,
    getLastColumn: () => headers.length,
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues: () => {
          if (metrics) {
            metrics.ranges.push({ row, column, rowCount, columnCount });
            metrics.cellsRead += rowCount * columnCount;
          }
          return values.slice(row - 1, row - 1 + rowCount)
            .map(line => line.slice(column - 1, column - 1 + columnCount));
        },
        setValues: replacement => {
          replacement.forEach((line, rowOffset) => {
            values[row - 1 + rowOffset] = [...line];
          });
        }
      };
    }
  };
}

function createAppsScript(records, metrics = null, headerOrder = null) {
  const sheet = createSheet(records, metrics, headerOrder);
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: name => name === "Records" ? sheet : null }) },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: content => ({ getContent: () => content, setMimeType: () => ({ getContent: () => content }) })
    },
    Utilities: {
      base64EncodeWebSafe: value => Buffer.from(String(value), "utf8").toString("base64url"),
      base64DecodeWebSafe: value => [...Buffer.from(String(value), "base64url")],
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString("utf8") }),
      formatDate: (date, _timeZone, format) => format === "yyyy-MM-dd" ? date.toISOString().slice(0, 10) : ""
    },
    Session: { getScriptTimeZone: () => "Asia/Kolkata" }
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "apps-script.gs"), "utf8");
  vm.runInContext(source, context);
  return parameters => JSON.parse(context.doGet({ parameter: parameters }).getContent());
}

function records(count, dateFor = index => `2026-10-${String(count - index).padStart(2, "0")}`) {
  return Array.from({ length: count }, (_, index) => ({
    Date: dateFor(index),
    "Patient Name": `Patient ${index + 1}`,
    Phone: `900000${String(index).padStart(4, "0")}`
  }));
}

test("recordsPage returns ten rows by default with physical row indexes and a continuation cursor", () => {
  const get = createAppsScript(records(12));
  const page = get({ op: "recordsPage" });

  assert.equal(page.ok, true);
  assert.equal(page.rows.length, 10);
  assert.equal(page.rows[0]["Patient Name"], "Patient 1");
  assert.equal(page.rows[0]._sheetRowIndex, 0);
  assert.equal(page.rows[9]._sheetRowIndex, 9);
  assert.equal(page.hasMore, true);
  assert.equal(typeof page.nextCursor, "string");
});

test("recordsPage cursor returns the next date-sorted page without duplicates", () => {
  const get = createAppsScript(records(12));
  const first = get({ op: "recordsPage", limit: "10" });
  const second = get({ op: "recordsPage", limit: "10", cursor: first.nextCursor });

  assert.equal(second.ok, true);
  assert.deepEqual(second.rows.map(row => row["Patient Name"]), ["Patient 11", "Patient 12"]);
  assert.deepEqual(second.rows.map(row => row._sheetRowIndex), [10, 11]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
});

test("recordsPage caps requested page size at fifty", () => {
  const page = createAppsScript(records(55))({ op: "recordsPage", limit: "500" });

  assert.equal(page.rows.length, 50);
  assert.equal(page.hasMore, true);
});

test("recordsPage reads a narrow index and only selected rows for chronological data", () => {
  const metrics = { ranges: [], cellsRead: 0 };
  const get = createAppsScript(records(120), metrics);

  const page = get({ op: "recordsPage", limit: "10" });

  assert.equal(page.rows.length, 10);
  assert.ok(metrics.cellsRead < 120 * 18 * 0.75, `expected at least 25% fewer cells than a full-table read; read ${metrics.cellsRead} cells`);
  assert.ok(metrics.ranges.length <= 3, `expected no more than three range reads, got ${metrics.ranges.length}`);
  assert.ok(metrics.ranges.every(range => range.rowCount < 121), "no range should read all data rows");
});

test("recordsPage preserves page results and bounds range reads when selected rows are scattered", () => {
  const shuffled = records(120, index => `2026-10-${String(index % 28 + 1).padStart(2, "0")}`);
  const metrics = { ranges: [], cellsRead: 0 };
  const get = createAppsScript(shuffled, metrics);

  const page = get({ op: "recordsPage", limit: "10" });

  assert.deepEqual(page.rows.map(row => row._sheetRowIndex), [111, 83, 55, 27, 110, 82, 54, 26, 109, 81]);
  assert.ok(metrics.ranges.length <= 3, `expected bounded reads including header, got ${metrics.ranges.length}`);

  const expectedOrder = shuffled.map((record, rowIndex) => ({ record, rowIndex }))
    .sort((a, b) => b.record.Date.localeCompare(a.record.Date) || b.rowIndex - a.rowIndex)
    .map(row => row.rowIndex);
  const allPageIndexes = [...page.rows.map(row => row._sheetRowIndex)];
  let cursor = page.nextCursor;
  while (cursor) {
    const next = get({ op: "recordsPage", limit: "10", cursor });
    allPageIndexes.push(...next.rows.map(row => row._sheetRowIndex));
    cursor = next.nextCursor;
  }
  assert.deepEqual(allPageIndexes, expectedOrder);
});

test("recordsPage maps indexed and selected fields when sheet columns are reordered", () => {
  const headers = [
    "Patient Name", "Referring Doctor", "Date", "Phone", "Age", "Scan Type", "2D Scan",
    "Purpose of CBCT", "Scan Fees", "Radiologist Name", "Radiologist Fees", "Consultation Fees",
    "Total Fees", "Payment Method", "Cash Amount", "Online Amount", "Edit History", "Operation ID"
  ];
  const page = createAppsScript([{
    Date: "2026-10-02", "Patient Name": "Reordered", "Referring Doctor": "Dr Example", Phone: "900"
  }], null, headers)({ op: "recordsPage" });

  assert.equal(page.rows[0]["Patient Name"], "Reordered");
  assert.equal(page.rows[0].Phone, "900");
  assert.deepEqual(page.availableMonths, ["2026-10"]);
  assert.deepEqual(page.referringDoctors, ["Dr Example"]);
});

test("recordsPage filters the selected month before pagination and sorts date ties deterministically", () => {
  const get = createAppsScript([
    { Date: "2026-10-01", "Patient Name": "October", Phone: "1" },
    { Date: "02/09/2026", "Patient Name": "September first", Phone: "2" },
    { Date: "2 Sept 2026", "Patient Name": "September second", Phone: "3" },
    { Date: "2026-08-31", "Patient Name": "August", Phone: "4" },
    { Date: "", "Patient Name": "No date", Phone: "5" }
  ]);
  const page = get({ op: "recordsPage", limit: "1", month: "2026-09" });
  const next = get({ op: "recordsPage", limit: "1", month: "2026-09", cursor: page.nextCursor });

  assert.deepEqual(page.rows.map(row => row["Patient Name"]), ["September second"]);
  assert.deepEqual(next.rows.map(row => row["Patient Name"]), ["September first"]);
  assert.equal(page.rows[0]._sheetRowIndex, 2);
  assert.equal(next.hasMore, false);
});

test("the first records page returns compact month and referring-doctor metadata without counts", () => {
  const get = createAppsScript([
    { Date: "2026-10-01", "Patient Name": "A", "Referring Doctor": "Dr Zed" },
    { Date: "2026-09-01", "Patient Name": "B", "Referring Doctor": "Dr Alpha" },
    { Date: "2026-10-02", "Patient Name": "C", "Referring Doctor": "Dr Zed" }
  ]);
  const first = get({ op: "recordsPage", limit: "1" });
  const second = get({ op: "recordsPage", limit: "1", cursor: first.nextCursor });

  assert.deepEqual(first.availableMonths, ["2026-10", "2026-09"]);
  assert.deepEqual(first.referringDoctors, ["Dr Alpha", "Dr Zed"]);
  assert.equal(Object.hasOwn(first, "total"), false);
  assert.equal(Object.hasOwn(second, "availableMonths"), false);
  assert.equal(Object.hasOwn(second, "referringDoctors"), false);
});

test("recordDuplicate checks normalized date and patient name but returns no patient details", () => {
  const get = createAppsScript([
    { Date: "2026-09-02", "Patient Name": "Sample Patient Delta" },
    { Date: "2026-09-02", "Patient Name": "Different Patient" }
  ]);
  const match = get({ op: "recordDuplicate", date: "02/09/2026", patientName: "  SAMPLE   PATIENT DELTA " });
  const miss = get({ op: "recordDuplicate", date: "2026-09-03", patientName: "Sample Patient Delta" });

  assert.deepEqual(Object.keys(match).sort(), ["duplicate", "ok"]);
  assert.equal(match.duplicate, true);
  assert.equal(miss.duplicate, false);
});

test("recordsPage rejects invalid month filters and non-positive limits", () => {
  const get = createAppsScript(records(1));

  assert.match(get({ op: "recordsPage", month: "2026-13" }).error, /month/i);
  assert.match(get({ op: "recordsPage", limit: "0" }).error, /limit/i);
});

test("recordsPage rejects a malformed cursor without restarting at page one", () => {
  const page = createAppsScript(records(2))({ op: "recordsPage", cursor: "not-a-valid-cursor" });

  assert.equal(page.ok, false);
  assert.match(page.error, /cursor/i);
});

test("legacy records operation keeps its existing response shape and row objects", () => {
  const get = createAppsScript([{ Date: "2026-10-01", "Patient Name": "Legacy", Phone: "900" }]);
  const response = get({ op: "records" });

  assert.deepEqual(Object.keys(response).sort(), ["ok", "rows"]);
  assert.equal(response.rows.length, 1);
  assert.equal(response.rows[0].Date, "2026-10-01");
  assert.equal(response.rows[0]["Patient Name"], "Legacy");
  assert.equal(response.rows[0].Phone, "900");
  assert.equal(Object.hasOwn(response.rows[0], "_sheetRowIndex"), false);
});
