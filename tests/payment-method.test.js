const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  normalizePaymentBreakdown,
  restoreMissingPaymentDetails,
} = require("../payment-method.js");

const indexMarkup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
const appsScript = fs.readFileSync(path.join(__dirname, "..", "apps-script.gs"), "utf8");

test("cash and online payments normalize to the full total", () => {
  assert.deepEqual(
    normalizePaymentBreakdown({ totalFees: 300, paymentType: "Cash" }),
    { ok: true, paymentMethod: "Cash", cashAmount: 300, onlineAmount: 0 }
  );
  assert.deepEqual(
    normalizePaymentBreakdown({ totalFees: 300, paymentType: "Online" }),
    { ok: true, paymentMethod: "Online", cashAmount: 0, onlineAmount: 300 }
  );
});

test("split payments preserve both amounts when they match the total", () => {
  assert.deepEqual(
    normalizePaymentBreakdown({
      totalFees: 300,
      paymentType: "Split Payment",
      cashAmount: 100,
      onlineAmount: 200,
    }),
    { ok: true, paymentMethod: "Split Payment", cashAmount: 100, onlineAmount: 200 }
  );
});

test("split payments are rejected when their amounts do not match the total", () => {
  const result = normalizePaymentBreakdown({
    totalFees: 300,
    paymentType: "Split Payment",
    cashAmount: 100,
    onlineAmount: 100,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /must equal the total fees/i);
});

test("a cloud refresh preserves a selected payment method when the older backend omits it", () => {
  const refreshedRecords = restoreMissingPaymentDetails(
    [{
      date: "2026-09-03",
      patientName: "Asha Patil",
      refDoctor: "Dr. Mehta",
      totalFees: 300,
      paymentMethod: "",
      cashAmount: 0,
      onlineAmount: 0,
    }],
    [{
      date: "2026-09-03",
      patientName: "Asha Patil",
      refDoctor: "Dr. Mehta",
      totalFees: 300,
      paymentMethod: "Split Payment",
      cashAmount: 100,
      onlineAmount: 200,
    }]
  );

  assert.deepEqual(refreshedRecords[0], {
    date: "2026-09-03",
    patientName: "Asha Patil",
    refDoctor: "Dr. Mehta",
    totalFees: 300,
    paymentMethod: "Split Payment",
    cashAmount: 100,
    onlineAmount: 200,
  });
});

test("scan form exposes a default cash option and split amount fields", () => {
  assert.match(indexMarkup, /name="paymentType"[^>]*value="Cash"[^>]*checked/);
  assert.match(indexMarkup, /name="paymentType"[^>]*value="Online"/);
  assert.match(indexMarkup, /value="Split Payment"/);
  assert.match(indexMarkup, /id="cashAmount"/);
  assert.match(indexMarkup, /id="onlineAmount"/);
  assert.match(patientScript, /normalizePaymentBreakdown/);
});

test("payment breakdown is persisted in local and cloud records", () => {
  assert.match(patientScript, /"Payment Method"/);
  assert.match(patientScript, /"Cash Amount"/);
  assert.match(patientScript, /"Online Amount"/);
  assert.match(appsScript, /"Payment Method"/);
  assert.match(appsScript, /"Cash Amount"/);
  assert.match(appsScript, /"Online Amount"/);
});
