const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");

test("admin login checks the cached password before refreshing cloud configuration", () => {
  const loginStart = patientScript.indexOf("adminLoginSubmitBtn.addEventListener(\"click\"");
  const loginEnd = patientScript.indexOf("adminLogoutBtn.addEventListener", loginStart);
  const loginHandler = patientScript.slice(loginStart, loginEnd);
  const localVerification = loginHandler.indexOf("await window.AdminAuth.verifyPassword");
  const cloudRefresh = loginHandler.indexOf("await loadConfigFromCloud()");

  assert.ok(localVerification >= 0, "login must verify the entered password");
  assert.ok(cloudRefresh >= 0, "login must still refresh cloud configuration when needed");
  assert.ok(
    localVerification < cloudRefresh,
    "a valid cached password should not wait for a cloud request"
  );
});

test("cloud requests have an abort timeout so authentication cannot remain stuck forever", () => {
  assert.match(patientScript, /const CLOUD_REQUEST_TIMEOUT_MS\s*=\s*\d+/);
  assert.match(patientScript, /function fetchWithTimeout\(/);
  assert.match(patientScript, /controller\.abort\(\)/);
  assert.match(patientScript, /fetchWithTimeout\(url/);
});

test("cloud timeout allows the deployed Apps Script redirect to complete", () => {
  const timeoutMatch = patientScript.match(/const CLOUD_REQUEST_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(timeoutMatch, "the renderer cloud timeout must be explicit");
  assert.ok(
    Number(timeoutMatch[1]) >= 30000,
    "the timeout must exceed the observed Apps Script response latency"
  );
});
