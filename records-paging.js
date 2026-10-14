(function attachRecordsPaging(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RecordsPaging = factory();
})(typeof window !== "undefined" ? window : globalThis, function createRecordsPagingModule() {
  function formatRecordPageInfo(pageNumber, rowCount, pageSize = 10) {
    if (!(rowCount > 0)) return "";
    const first = (Math.max(1, Number(pageNumber) || 1) - 1) * pageSize + 1;
    return `Showing ${first} - ${first + rowCount - 1}`;
  }

  function createSubmissionGate() {
    let locked = false;
    return Object.freeze({
      acquire() {
        if (locked) return null;
        locked = true;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          locked = false;
        };
      }
    });
  }

  function queueRecordSave({ enqueue, sync, refresh = () => {}, onError = () => {} } = {}) {
    const queued = enqueue();
    Promise.resolve()
      .then(() => sync())
      .then(() => refresh())
      .catch(error => {
        try { onError(error); } catch (_) { /* reporting must not affect the saved queue item */ }
      });
    return queued;
  }

  function hasDuplicateRecord(records, date, patientName) {
    const normalizedDate = String(date || "").trim().slice(0, 10);
    const normalizedName = String(patientName || "").trim().replace(/\s+/g, " ").toLowerCase();
    if (!normalizedDate || !normalizedName) return false;
    return (Array.isArray(records) ? records : []).some(record =>
      String(record.date || "").trim().slice(0, 10) === normalizedDate &&
      String(record.patientName || "").trim().replace(/\s+/g, " ").toLowerCase() === normalizedName
    );
  }

  async function checkRecordDuplicate({ entry, records = [], cloudGet, cloudConfigured = true, online = true } = {}) {
    const record = entry || {};
    if (hasDuplicateRecord(records, record.date, record.patientName)) {
      return { duplicate: true, verified: true, source: "cache" };
    }
    if (!cloudConfigured || !online || typeof cloudGet !== "function") {
      return { duplicate: false, verified: false, source: "cache" };
    }
    try {
      const result = await cloudGet("recordDuplicate", {
        date: String(record.date || "").trim(),
        patientName: String(record.patientName || "").trim()
      });
      if (!result || typeof result.duplicate !== "boolean") throw new Error("Cloud returned an invalid duplicate-check response.");
      return { duplicate: result.duplicate, verified: true, source: "cloud" };
    } catch (error) {
      return { duplicate: false, verified: false, source: "cache", error };
    }
  }

  function createRecordPager({
    fetchPage,
    onStateChange = () => {},
    readCache = () => null,
    writeCache = () => {},
    clearCache = () => {},
    pageSize = 10,
    maxCachedPages = 30
  } = {}) {
    if (typeof fetchPage !== "function") throw new Error("Record pager requires fetchPage().");
    const cache = new Map();
    let queryVersion = 0;
    let inFlight = null;
    let cursorHistory = [null];
    let historyIndex = 0;
    let state = Object.freeze({
      month: "",
      page: 1,
      cursor: null,
      nextCursor: null,
      hasMore: false,
      rows: [],
      availableMonths: [],
      referringDoctors: [],
      loading: false,
      status: "idle",
      source: "none",
      error: null
    });

    function keyFor(month, cursor) {
      return JSON.stringify([month || "", cursor || ""]);
    }

    function publish(changes) {
      state = Object.freeze({ ...state, ...changes });
      try { onStateChange(state); } catch (error) { console.error("Record pager listener failed:", error); }
      return state;
    }

    function cachedPage(month, cursor) {
      const key = keyFor(month, cursor);
      if (cache.has(key)) return cache.get(key);
      const persisted = readCache(month || "", cursor || null);
      if (persisted && Array.isArray(persisted.rows)) {
        cache.set(key, persisted);
        return persisted;
      }
      return null;
    }

    function rememberPage(month, cursor, value) {
      const key = keyFor(month, cursor);
      cache.delete(key);
      cache.set(key, value);
      while (cache.size > maxCachedPages) cache.delete(cache.keys().next().value);
      try { writeCache(month || "", cursor || null, value); } catch (error) {
        console.warn("Could not persist patient-record page:", error);
      }
    }

    function applyPage(value, { month, page, cursor, source, status = "ready", error = null }) {
      return publish({
        month,
        page,
        cursor: cursor || null,
        nextCursor: value.nextCursor || null,
        hasMore: Boolean(value.hasMore),
        rows: value.rows.slice(),
        availableMonths: Array.isArray(value.availableMonths) ? value.availableMonths.slice() : state.availableMonths,
        referringDoctors: Array.isArray(value.referringDoctors) ? value.referringDoctors.slice() : state.referringDoctors,
        loading: false,
        status,
        source,
        error
      });
    }

    async function loadPage(cursor, pageNumber, { refresh = false } = {}) {
      const month = state.month;
      const key = keyFor(month, cursor);
      const saved = cachedPage(month, cursor);
      if (saved && !refresh) {
        return applyPage(saved, { month, page: pageNumber, cursor, source: "cache" });
      }
      if (inFlight && inFlight.key === key) return inFlight.promise;

      const requestVersion = queryVersion;
      if (saved) applyPage(saved, { month, page: pageNumber, cursor, source: "cache", status: "stale" });
      publish({ loading: true, status: saved ? "stale" : "loading", error: null });

      const promise = Promise.resolve()
        .then(() => fetchPage({ month, cursor: cursor || null, limit: pageSize }))
        .then(result => {
          if (requestVersion !== queryVersion) return state;
          if (!result || !Array.isArray(result.rows) || typeof result.hasMore !== "boolean") {
            throw new Error("Cloud returned an invalid records page.");
          }
          rememberPage(month, cursor, result);
          return applyPage(result, { month, page: pageNumber, cursor, source: "cloud" });
        })
        .catch(error => {
          if (requestVersion !== queryVersion) return state;
          const fallback = cachedPage(month, cursor);
          if (fallback) return applyPage(fallback, { month, page: pageNumber, cursor, source: "cache", status: "stale", error });
          return publish({
            month, page: pageNumber, cursor: cursor || null, nextCursor: null, hasMore: false,
            rows: [], loading: false, status: "error", source: "none", error
          });
        })
        .finally(() => {
          if (inFlight && inFlight.promise === promise) inFlight = null;
        });
      inFlight = { key, promise };
      return promise;
    }

    function loadFirst({ refresh = false } = {}) {
      queryVersion += 1;
      cursorHistory = [null];
      historyIndex = 0;
      return loadPage(null, 1, { refresh });
    }

    async function next() {
      if (inFlight) return inFlight.promise;
      if (!state.hasMore || !state.nextCursor) return state;
      cursorHistory = cursorHistory.slice(0, historyIndex + 1);
      cursorHistory.push(state.nextCursor);
      historyIndex += 1;
      return loadPage(cursorHistory[historyIndex], historyIndex + 1);
    }

    async function previous() {
      if (inFlight) return inFlight.promise;
      if (historyIndex <= 0) return state;
      historyIndex -= 1;
      return loadPage(cursorHistory[historyIndex], historyIndex + 1);
    }

    function setMonth(month) {
      const nextMonth = String(month || "").trim();
      if (nextMonth === state.month) return loadFirst({ refresh: true });
      queryVersion += 1;
      cursorHistory = [null];
      historyIndex = 0;
      publish({
        month: nextMonth, page: 1, cursor: null, nextCursor: null, hasMore: false,
        rows: [], loading: false, status: "idle", source: "none", error: null
      });
      return loadPage(null, 1, { refresh: true });
    }

    function refresh() {
      return loadPage(cursorHistory[historyIndex], historyIndex + 1, { refresh: true });
    }

    function invalidate() {
      cache.clear();
      try { clearCache(null); } catch (error) { console.warn("Could not clear persisted patient-record pages:", error); }
      queryVersion += 1;
      cursorHistory = [null];
      historyIndex = 0;
      return loadPage(null, 1, { refresh: true });
    }

    return Object.freeze({
      getState: () => state,
      loadFirst,
      next,
      previous,
      setMonth,
      refresh,
      invalidate
    });
  }

  return { createRecordPager, createSubmissionGate, queueRecordSave, formatRecordPageInfo, hasDuplicateRecord, checkRecordDuplicate };
});
