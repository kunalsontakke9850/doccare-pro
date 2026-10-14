(function attachSyncRecovery(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SyncRecovery = factory();
})(typeof window !== "undefined" ? window : globalThis, function createSyncRecoveryModule() {
  const RETRY_DELAYS_MS = [5000, 15000, 60000, 300000];

  function serializeSyncHealth(value = {}) {
    const safeTimestamp = input => {
      if (typeof input !== "string" || !input || !Number.isFinite(Date.parse(input))) return null;
      return new Date(input).toISOString();
    };
    const allowedKinds = new Set(["offline", "timeout", "network", "server", "configuration", "request", "unknown"]);
    return JSON.stringify({
      lastSuccessfulRecordsSyncAt: safeTimestamp(value.lastSuccessfulRecordsSyncAt),
      lastSuccessfulConfigSyncAt: safeTimestamp(value.lastSuccessfulConfigSyncAt),
      lastFailureAt: safeTimestamp(value.lastFailureAt),
      failureKind: allowedKinds.has(value.failureKind) ? value.failureKind : null,
      consecutiveFailures: Math.max(0, Math.floor(Number(value.consecutiveFailures) || 0)),
      nextRetryAt: Number.isFinite(Number(value.nextRetryAt)) && value.nextRetryAt !== null ? Number(value.nextRetryAt) : null
    });
  }

  function formatSyncStatus({ status, pendingCount = 0, nextRetryAt = null, lastSuccessfulAt = null, failureKind = null, now = Date.now() } = {}) {
    const pending = Math.max(0, Math.floor(Number(pendingCount) || 0));
    const pendingText = pending
      ? ` · ${pending} ${pending === 1 ? "entry" : "entries"} safely saved on this computer`
      : "";
    if (status === "retrying") {
      const minutes = nextRetryAt ? Math.max(1, Math.ceil((Number(nextRetryAt) - Number(now)) / 60000)) : null;
      return `Reconnecting${minutes ? ` in ${minutes} min` : ""}${pendingText}`;
    }
    if (status === "offline") return `Offline${pendingText}`;
    if (status === "attention") {
      const detail = failureKind === "request" ? "Cloud rejected this request" : "Check the cloud setup or contact support";
      return `Sync needs attention · ${detail}${pendingText}`;
    }
    if (status === "syncing") return `Connecting to cloud${pendingText}`;
    if (status === "synced") {
      const time = lastSuccessfulAt && Number.isFinite(Date.parse(lastSuccessfulAt))
        ? new Date(lastSuccessfulAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })
        : "just now";
      return `Synced · ${time}${pendingText}`;
    }
    return `Cloud sync status unavailable${pendingText}`;
  }

  function createSyncRecovery({
    refresh,
    onStateChange = () => {},
    classifyError = () => ({ kind: "unknown", retryable: false, message: "Cloud sync needs attention. Try Refresh or contact support." }),
    now = () => Date.now(),
    setTimeoutImpl = (callback, delay) => setTimeout(callback, delay),
    clearTimeoutImpl = id => clearTimeout(id),
    isOnline = () => true,
    isVisible = () => true,
    refreshIntervalMs = 600000,
    initialState = {}
  } = {}) {
    if (typeof refresh !== "function") throw new Error("Sync recovery requires refresh().");
    const allowedFailureKinds = new Set(["offline", "timeout", "network", "server", "configuration", "request", "unknown"]);
    const restoredFailureKind = allowedFailureKinds.has(initialState.failureKind) ? initialState.failureKind : null;
    const restoredLastSuccess = typeof initialState.lastSuccessfulAt === "string" && Number.isFinite(Date.parse(initialState.lastSuccessfulAt))
      ? new Date(initialState.lastSuccessfulAt).toISOString() : null;
    const restoredFailureCount = Math.max(0, Math.floor(Number(initialState.consecutiveFailures) || 0));
    const restoredNextRetry = initialState.nextRetryAt !== null && initialState.nextRetryAt !== undefined && Number.isFinite(Number(initialState.nextRetryAt))
      ? Number(initialState.nextRetryAt) : null;
    const defaultRestoredStatus = restoredFailureKind === "offline" ? "offline"
      : restoredFailureKind === "request" || restoredFailureKind === "configuration" || restoredFailureKind === "unknown" ? "attention"
      : restoredFailureKind ? "retrying" : (restoredLastSuccess ? "synced" : "idle");
    const restoredStatus = ["idle", "synced", "retrying", "offline", "attention"].includes(initialState.status)
      ? initialState.status : defaultRestoredStatus;
    let state = Object.freeze({
      status: restoredStatus,
      reason: "",
      isRefreshing: false,
      lastSuccessfulAt: restoredLastSuccess,
      failureKind: restoredFailureKind,
      failureMessage: "",
      consecutiveFailures: restoredFailureCount,
      nextRetryAt: restoredNextRetry
    });
    let inFlight = null;
    let retryTimer = null;
    let maintenanceTimer = null;
    let disposed = false;
    let wasVisible = Boolean(isVisible());

    function publish(changes) {
      state = Object.freeze({ ...state, ...changes });
      try { onStateChange(state); } catch (error) { console.error("Sync status listener failed:", error); }
      return state;
    }

    function clearTimer(which) {
      if (which === "retry" && retryTimer !== null) {
        clearTimeoutImpl(retryTimer);
        retryTimer = null;
      }
      if (which === "maintenance" && maintenanceTimer !== null) {
        clearTimeoutImpl(maintenanceTimer);
        maintenanceTimer = null;
      }
    }

    function scheduleMaintenance() {
      clearTimer("maintenance");
      if (disposed || !(refreshIntervalMs > 0) || !isVisible()) return;
      maintenanceTimer = setTimeoutImpl(() => {
        maintenanceTimer = null;
        if (!disposed && isVisible()) void requestRefresh("maintenance");
      }, refreshIntervalMs);
    }

    function scheduleRetry(failure) {
      clearTimer("retry");
      if (!failure.retryable || disposed) {
        publish({
          status: failure.kind === "offline" ? "offline" : "attention",
          failureKind: failure.kind,
          failureMessage: failure.message,
          nextRetryAt: null
        });
        return;
      }
      const failureCount = state.consecutiveFailures + 1;
      const delay = RETRY_DELAYS_MS[Math.min(failureCount - 1, RETRY_DELAYS_MS.length - 1)];
      publish({
        status: isOnline() ? "retrying" : "offline",
        failureKind: failure.kind,
        failureMessage: failure.message,
        consecutiveFailures: failureCount,
        nextRetryAt: now() + delay
      });
      if (isOnline()) {
        retryTimer = setTimeoutImpl(() => {
          retryTimer = null;
          if (!disposed) void requestRefresh("retry");
        }, delay);
      } else {
        publish({ nextRetryAt: null });
      }
    }

    function requestRefresh(reason = "manual") {
      if (disposed) return Promise.resolve(state);
      if (inFlight) return inFlight;
      clearTimer("retry");
      clearTimer("maintenance");
      publish({ status: "syncing", reason, isRefreshing: true, nextRetryAt: null });

      const run = Promise.resolve()
        .then(() => refresh({ reason }))
        .then(result => {
          if (result && result.ok === false) {
            const failure = result.failure || classifyError(result.error);
            scheduleRetry(failure);
            return state;
          }
          publish({
            status: "synced",
            isRefreshing: false,
            lastSuccessfulAt: now(),
            failureKind: null,
            failureMessage: "",
            consecutiveFailures: 0,
            nextRetryAt: null
          });
          scheduleMaintenance();
          return state;
        })
        .catch(error => {
          scheduleRetry(classifyError(error));
          return state;
        })
        .finally(() => {
          if (inFlight === run) inFlight = null;
          if (state.isRefreshing) publish({ isRefreshing: false });
        });
      inFlight = run;
      return run;
    }

    function notifyOnline() {
      if (!isOnline()) return Promise.resolve(state);
      return requestRefresh("online");
    }

    function notifyFocus() {
      if (!isVisible()) return Promise.resolve(state);
      return requestRefresh("focus");
    }

    function notifyVisibility(visible = Boolean(isVisible())) {
      const isNowVisible = Boolean(visible);
      const becameVisible = !wasVisible && isNowVisible;
      wasVisible = isNowVisible;
      if (!isNowVisible) {
        clearTimer("maintenance");
        return Promise.resolve(state);
      }
      if (becameVisible) return requestRefresh("visible");
      return Promise.resolve(state);
    }

    function start() { return requestRefresh("startup"); }

    function dispose() {
      disposed = true;
      clearTimer("retry");
      clearTimer("maintenance");
    }

    return {
      start,
      requestRefresh,
      notifyOnline,
      notifyFocus,
      notifyVisibility,
      getState: () => state,
      dispose
    };
  }

  return { RETRY_DELAYS_MS, createSyncRecovery, serializeSyncHealth, formatSyncStatus };
});
