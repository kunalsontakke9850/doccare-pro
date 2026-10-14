const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("referring-doctor autocomplete documentation does not execute as JavaScript", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const sectionStart = source.indexOf("// SMART FUZZY AUTOCOMPLETE FOR REFERRING DOCTOR");
  const sectionEnd = source.indexOf("/** Compute Levenshtein edit distance", sectionStart);

  assert.notEqual(sectionStart, -1, "autocomplete section should exist");
  assert.notEqual(sectionEnd, -1, "autocomplete implementation should follow its documentation");
  assert.doesNotThrow(() => vm.runInNewContext(source.slice(sectionStart, sectionEnd)));
});

test("default date initialization assigns a valid date without throwing", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const sectionStart = source.indexOf("function getTodayDateValue() {");
  const sectionEnd = source.indexOf("function escapeHtml(", sectionStart);
  const dateInput = { value: "", defaultValue: "" };
  const context = vm.createContext({ dateInput });

  assert.notEqual(sectionStart, -1, "date helpers should exist");
  assert.notEqual(sectionEnd, -1, "date helpers should precede HTML escaping");
  vm.runInContext(source.slice(sectionStart, sectionEnd), context);
  vm.runInContext("setDefaultDate(true)", context);

  assert.match(dateInput.value, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dateInput.defaultValue, dateInput.value);
});

test("ordinary startup does not fetch full records or expenses", () => {
  const patient = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const expenses = fs.readFileSync(path.join(__dirname, "..", "expenses.js"), "utf8");
  const initialize = patient.slice(patient.indexOf("function initialize() {"), patient.indexOf("// ============================================================================\n// BILL GENERATION FUNCTIONALITY"));
  const recovery = patient.slice(patient.indexOf("async function refreshCloudState("), patient.indexOf("async function ensureReportRecordsLoaded("));
  const expensesInit = expenses.slice(expenses.indexOf("function initExpensesForm()"), expenses.indexOf("document.addEventListener('DOMContentLoaded'"));

  assert.doesNotMatch(initialize, /loadRecordsFromCloud\s*\(/);
  assert.doesNotMatch(recovery, /loadRecordsFromCloud\s*\(|cloudGet\(["']expenses["']\)/);
  assert.match(initialize, /initializeSyncRecovery\(\)/);
  assert.doesNotMatch(expensesInit, /\(async\s*\(\)\s*=>/);
  assert.match(expenses, /window\.ensureExpensesLoaded\s*=\s*ensureExpensesLoaded/);
});

test("Patient Records activates through its paged API and report loading stays separate", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const fetchPage = source.slice(source.indexOf("async function fetchRecordPage("), source.indexOf("function ensureRecordsPager("));
  const reportLoader = source.slice(source.indexOf("async function ensureReportRecordsLoaded("), source.indexOf("async function appendEntryToCloud("));
  assert.match(fetchPage, /cloudGet\("recordsPage"/);
  assert.doesNotMatch(fetchPage, /cloudGet\("records"/);
  assert.match(reportLoader, /loadRecordsFromCloud\(\{ reportFailure: false \}\)/);
});
