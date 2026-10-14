(function attachDemoBackend(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DemoBackend = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDemoBackend(root) {
  const STORAGE_KEY = "doccare-pro-demo-v1";

  const SEED = Object.freeze({
    records: [
      {
        Date: "2026-03-10", Age: 34, "Patient Name": "Sample Patient A", ScanType: "CBCT",
        "2D Scan": "", "Purpose of CBCT": "Implant planning", "Scan Fees": 2400,
        "Radiologist Name": "Demo Radiologist", "Radiologist Fees": 500,
        "Referring Doctor": "Demo Doctor One", "Consultation Fees": 700,
        "Total Fees": 3600, Phone: "0000000000", "Payment Method": "Cash",
        "Cash Amount": 3600, "Online Amount": 0, "Edit History": "",
        recordId: "demo-record-a", version: 1, updatedAt: "2026-03-10T09:00:00.000Z"
      },
      {
        Date: "2026-03-20", Age: 42, "Patient Name": "Sample Patient B", ScanType: "2D",
        "2D Scan": "OPG", "Purpose of CBCT": "", "Scan Fees": 900,
        "Radiologist Name": "Demo Radiologist", "Radiologist Fees": 0,
        "Referring Doctor": "Demo Doctor One", "Consultation Fees": 300,
        "Total Fees": 1200, Phone: "0000000000", "Payment Method": "Online",
        "Cash Amount": 0, "Online Amount": 1200, "Edit History": "",
        recordId: "demo-record-b", version: 1, updatedAt: "2026-03-20T11:30:00.000Z"
      }
    ],
    expenses: [
      {
        Date: "2026-03-18", Type: "Operating", Category: "Supplies",
        Description: "Demo supplies", Amount: 450, "Payment Method": "Cash",
        id: "demo-expense-a", createdAt: "2026-03-18T08:00:00.000Z"
      }
    ],
    config: {
      scanTypes: ["CBCT", "2D"],
      twoDScanTypes: ["OPG", "Lateral Ceph"],
      purposes: ["Implant planning", "Orthodontic assessment"],
      referringDoctors: ["Demo Doctor One", "Demo Doctor Two"],
      radiologists: [{ name: "Demo Radiologist", defaultFee: 500, scanFees: { CBCT: 2400, "2D": 900 } }],
      configVersion: "demo-v1"
    },
    operations: {}
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function memoryStorage() {
    const values = new Map();
    return {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    };
  }

  function response(status, body) {
    const copy = clone(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() { return clone(copy); }
    };
  }

  function safeCloneState(state) {
    if (!state || typeof state !== "object" ||
        !Array.isArray(state.records) || !Array.isArray(state.expenses) ||
        !state.config || typeof state.config !== "object" ||
        !state.operations || typeof state.operations !== "object") return null;
    if (state.records.some(row => !isSafeDemoRecord(row))) return null;
    if (state.expenses.some(row => !row || typeof row !== "object" ||
        !/^(Sample|Demo)\b/.test(String(row.Description || "")))) return null;
    return clone(state);
  }

  function isSafeDemoRecord(row) {
    if (!row || typeof row !== "object" || !/^(Sample|Demo)\b/.test(String(row["Patient Name"] || ""))) return false;
    const phone = String(row.Phone || row["Patient Phone"] || "").replace(/\D/g, "");
    return !phone || phone === "0000000000";
  }

  function getBrowserStorage() {
    try { return root.localStorage || memoryStorage(); }
    catch (_error) { return memoryStorage(); }
  }

  function createFetch({ storage = getBrowserStorage(), now = () => new Date() } = {}) {
    let state = null;
    const demoOrigin = root.location?.origin || "https://doccare-demo.invalid";

    function persist() {
      try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_error) { /* Keep this session usable if storage is disabled. */ }
    }

    try {
      state = safeCloneState(JSON.parse(storage.getItem(STORAGE_KEY) || "null"));
    } catch (_error) {
      state = null;
    }
    if (!state) {
      state = clone(SEED);
      persist();
    }

    function jsonFailure(status, message, code) {
      return response(status, { ok: false, error: message, code });
    }

    function pageRecords(params) {
      const limitValue = Number(params.get("limit"));
      const limit = Math.min(50, Math.max(1, Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 10));
      const month = params.get("month") || "";
      if (month && !/^\d{4}-\d{2}$/.test(month)) return null;

      const cursorValue = params.get("cursor") || "demo:0";
      const match = /^demo:(\d+)$/.exec(cursorValue);
      if (!match) return null;
      const offset = Number(match[1]);
      const indexed = state.records.map((row, index) => ({ ...clone(row), _sheetRowIndex: index }));
      const filtered = indexed.filter(row => !month || String(row.Date || "").slice(0, 7) === month)
        .sort((left, right) => String(right.Date || "").localeCompare(String(left.Date || "")) ||
          right._sheetRowIndex - left._sheetRowIndex);
      const rows = filtered.slice(offset, offset + limit);
      const hasMore = offset + limit < filtered.length;
      return {
        ok: true,
        rows,
        hasMore,
        nextCursor: hasMore ? `demo:${offset + limit}` : null,
        ...(offset === 0 ? {
          availableMonths: [...new Set(indexed.map(row => String(row.Date || "").slice(0, 7)).filter(Boolean))].sort().reverse(),
          referringDoctors: [...new Set(indexed.map(row => String(row["Referring Doctor"] || "").trim()).filter(Boolean))].sort()
        } : {})
      };
    }

    function read(operation, params) {
      if (operation === "ping") return { ok: true, msg: "DocCare Pro demo data is ready" };
      if (operation === "capabilities") return { ok: true, capabilities: { idempotentWrites: true, operationSheet: "DemoLocalStorage" } };
      if (operation === "records") return { ok: true, rows: clone(state.records) };
      if (operation === "recordsPage") {
        const page = pageRecords(params);
        return page || { ok: false, error: "Invalid demo page query." };
      }
      if (operation === "recordDuplicate") {
        const date = String(params.get("date") || "").slice(0, 10);
        const name = String(params.get("patientName") || "").trim().replace(/\s+/g, " ").toLowerCase();
        return { ok: true, duplicate: state.records.some(row =>
          String(row.Date || "").slice(0, 10) === date &&
          String(row["Patient Name"] || "").trim().replace(/\s+/g, " ").toLowerCase() === name) };
      }
      if (operation === "expenses") return { ok: true, rows: clone(state.expenses) };
      if (operation === "config") return { ok: true, config: clone(state.config) };
      return null;
    }

    function mutate(payload) {
      const operationId = String(payload.operationId || "");
      if (operationId && state.operations[operationId]) {
        return { ...clone(state.operations[operationId]), deduplicated: true };
      }

      let result;
      if (payload.op === "addRecord") {
        const row = clone(payload.row || {});
        if (!isSafeDemoRecord(row)) {
          return jsonFailure(400, "Demo entries must use a sample name and fictional phone value.", "DEMO_DATA_ONLY");
        }
        row.recordId = row.recordId || `demo-record-${Date.now().toString(36)}-${state.records.length}`;
        row.version = Number(row.version) || 1;
        row.updatedAt = now().toISOString();
        state.records.push(row);
        result = { ok: true, recordId: row.recordId, version: row.version, deduplicated: false };
      } else if (payload.op === "updateRecord") {
        const index = Number.isInteger(Number(payload.rowIndex))
          ? Number(payload.rowIndex)
          : state.records.findIndex(row => row.recordId === payload.recordId);
        if (index < 0 || index >= state.records.length) result = { ok: false, error: "Sample record not found." };
        else {
          const updated = { ...state.records[index], ...clone(payload.row || payload.changes || {}) };
          if (!isSafeDemoRecord(updated)) {
            return jsonFailure(400, "Demo entries must use a sample name and fictional phone value.", "DEMO_DATA_ONLY");
          }
          updated.version = Number(state.records[index].version || 0) + 1;
          updated.updatedAt = now().toISOString();
          state.records[index] = updated;
          result = { ok: true, recordId: updated.recordId, version: updated.version };
        }
      } else if (payload.op === "deleteRecord") {
        const index = Number.isInteger(Number(payload.rowIndex))
          ? Number(payload.rowIndex)
          : state.records.findIndex(row => row.recordId === payload.recordId);
        const deleted = index >= 0 && index < state.records.length;
        if (deleted) state.records.splice(index, 1);
        result = { ok: true, recordId: payload.recordId || null, deleted };
      } else if (payload.op === "addExpense") {
        const expense = clone(payload.expense || {});
        if (!/^(Sample|Demo)\b/.test(String(expense.Description || ""))) {
          return jsonFailure(400, "Demo expenses must use a sample description.", "DEMO_DATA_ONLY");
        }
        expense.id = expense.id || `demo-expense-${Date.now().toString(36)}-${state.expenses.length}`;
        expense.createdAt = now().toISOString();
        state.expenses.push(expense);
        result = { ok: true, expenseId: expense.id };
      } else if (payload.op === "saveConfig") {
        state.config = { ...state.config, ...clone(payload.config || {}) };
        state.config.configVersion = payload.version || `demo-${Date.now().toString(36)}`;
        result = { ok: true, configVersion: state.config.configVersion };
      } else if (payload.op === "renameReferringDoctor") {
        const oldName = String(payload.oldName || payload.from || "").trim();
        const newName = String(payload.newName || payload.to || "").trim();
        if (!/^Demo\b/.test(oldName) || !/^Demo\b/.test(newName)) {
          return jsonFailure(400, "Demo doctor names must use the Demo prefix.", "DEMO_DATA_ONLY");
        }
        state.records.forEach(row => {
          if (row["Referring Doctor"] === oldName) row["Referring Doctor"] = newName;
        });
        state.config.referringDoctors = (state.config.referringDoctors || [])
          .map(name => name === oldName ? newName : name);
        result = { ok: true, renamed: true };
      } else {
        return jsonFailure(400, "Unknown demo operation.", "DEMO_OPERATION_UNKNOWN");
      }

      if (operationId) {
        state.operations[operationId] = clone(result);
        const ids = Object.keys(state.operations);
        ids.slice(0, Math.max(0, ids.length - 200)).forEach(id => delete state.operations[id]);
      }
      if (result.ok) persist();
      return result;
    }

    return async function demoFetch(input, init = {}) {
      let url;
      try {
        const raw = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
        url = new URL(raw, demoOrigin);
      } catch (_error) {
        return jsonFailure(400, "Invalid demo request URL.", "DEMO_URL_INVALID");
      }
      if (url.origin !== demoOrigin) return jsonFailure(403, "External requests are disabled in demo mode.", "DEMO_EXTERNAL_REQUEST_BLOCKED");
      if (url.pathname === "/demo-api/admin/session") return jsonFailure(403, "Admin access is not available in the public demo.", "DEMO_ADMIN_DISABLED");
      if (url.pathname !== "/demo-api" && url.pathname !== "/demo-api/") {
        return jsonFailure(404, "Route not available in demo mode.", "DEMO_ROUTE_NOT_FOUND");
      }

      const method = String(init.method || input?.method || "GET").toUpperCase();
      if (method === "GET") {
        const operation = url.searchParams.get("op") || "";
        const result = read(operation, url.searchParams);
        return result ? response(result.ok === false ? 400 : 200, result) : jsonFailure(400, "Unknown demo operation.", "DEMO_OPERATION_UNKNOWN");
      }
      if (method !== "POST") return jsonFailure(405, "Method not allowed in demo mode.", "DEMO_METHOD_NOT_ALLOWED");

      let payload;
      try {
        payload = JSON.parse(String(init.body ?? "{}"));
      } catch (_error) {
        return jsonFailure(400, "Invalid demo request body.", "DEMO_BODY_INVALID");
      }
      const result = mutate(payload && typeof payload === "object" ? payload : {});
      return result?.status ? result : response(result?.ok === false ? 400 : 200, result);
    };
  }

  return { STORAGE_KEY, createFetch };
});
