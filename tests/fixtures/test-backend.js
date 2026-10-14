const fixtures = require("./stage-b-fixtures.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createTestBackend() {
  const records = [
    { ...clone(fixtures.completeRecord), recordId: "rec_test_seed" },
    clone(fixtures.legacyRecord)
  ];
  const expenses = [];
  const config = clone(fixtures.validConfig);
  const operations = new Map();
  const requests = [];

  function remember(operationId, response) {
    if (operationId) operations.set(operationId, clone(response));
    return response;
  }

  async function get(op, params = {}) {
    requests.push({ op, params: clone(params) });
    if (op === "ping") return { ok: true, msg: "DocCare Pro test backend" };
    if (op === "capabilities") return { ok: true, capabilities: { idempotentWrites: true, operationSheet: "SyncOperations" } };
    if (op === "records") return { ok: true, rows: clone(records) };
    if (op === "recordsPage") {
      const limit = Math.min(50, Math.max(1, Number(params.limit) || 10));
      const month = String(params.month || "");
      const offset = /^test:\d+$/.test(String(params.cursor || "")) ? Number(String(params.cursor).slice(5)) : 0;
      const indexed = records.map((row, index) => ({ ...clone(row), _sheetRowIndex: index }));
      const filtered = indexed.filter(row => {
        const date = String(row.Date || "").slice(0, 10);
        return !month || date.slice(0, 7) === month;
      }).sort((a, b) => String(b.Date || "").localeCompare(String(a.Date || "")) || b._sheetRowIndex - a._sheetRowIndex);
      const rows = filtered.slice(offset, offset + limit);
      const hasMore = offset + limit < filtered.length;
      return {
        ok: true,
        rows,
        hasMore,
        nextCursor: hasMore ? `test:${offset + limit}` : null,
        ...(offset === 0 ? {
          availableMonths: [...new Set(indexed.map(row => String(row.Date || "").slice(0, 7)).filter(Boolean))].sort().reverse(),
          referringDoctors: [...new Set(indexed.map(row => String(row["Referring Doctor"] || "").trim()).filter(Boolean))].sort()
        } : {})
      };
    }
    if (op === "recordDuplicate") {
      const date = String(params.date || "").slice(0, 10);
      const name = String(params.patientName || "").trim().replace(/\s+/g, " ").toLowerCase();
      return { ok: true, duplicate: records.some(row => String(row.Date || "").slice(0, 10) === date && String(row["Patient Name"] || "").trim().replace(/\s+/g, " ").toLowerCase() === name) };
    }
    if (op === "expenses") return { ok: true, rows: clone(expenses) };
    if (op === "config") return { ok: true, config: clone(config) };
    return { ok: false, error: "Unknown test read operation" };
  }

  async function post(payload = {}) {
    if (payload.operationId && operations.has(payload.operationId)) {
      return { ...clone(operations.get(payload.operationId)), deduplicated: true };
    }
    let response;
    switch (payload.op) {
      case "addRecord": {
        const row = clone(payload.row || {});
        if (!row.recordId) row.recordId = `rec_test_${records.length + 1}`;
        if (!row.version) row.version = 1;
        records.push(row);
        response = { ok: true, recordId: row.recordId, version: row.version, deduplicated: false };
        break;
      }
      case "updateRecord": {
        const index = records.findIndex(row => row.recordId === payload.recordId);
        if (index < 0) response = { ok: false, error: "Record not found" };
        else {
          records[index] = { ...records[index], ...clone(payload.changes || {}), version: Number(records[index].version || 0) + 1 };
          response = { ok: true, recordId: records[index].recordId, version: records[index].version };
        }
        break;
      }
      case "deleteRecord": {
        const index = records.findIndex(row => row.recordId === payload.recordId);
        if (index >= 0) records.splice(index, 1);
        response = { ok: true, recordId: payload.recordId, deleted: index >= 0 };
        break;
      }
      case "addExpense":
        expenses.push(clone(payload.expense || {}));
        response = { ok: true, expenseId: payload.expense?.id || null };
        break;
      case "saveConfig":
        Object.assign(config, clone(payload.config || {}));
        config.configVersion = payload.version || config.configVersion;
        response = { ok: true, configVersion: config.configVersion };
        break;
      case "renameReferringDoctor":
        for (const row of records) {
          if (row["Referring Doctor"] === payload.from) row["Referring Doctor"] = payload.to;
        }
        response = { ok: true, renamed: true };
        break;
      default:
        response = { ok: false, error: "Unknown test mutation operation" };
    }
    return remember(payload.operationId, response);
  }

  return { get, post, requests };
}

module.exports = { createTestBackend };
