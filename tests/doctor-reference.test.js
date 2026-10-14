const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  aggregateDoctorReferences,
  aggregateDoctorConsultationFees,
  calculateDoctorPayable,
  filterDoctorReferenceReport,
  getMonthDateRange,
  getDoctorReferencePeriodKey,
  normalizeDoctorReferencePercentageHistory,
  normalizeDoctorReferencePercentages,
  buildDoctorReferencePrintHtml,
  buildOverallDoctorReferencePrintHtml,
  renameDoctorReferenceData,
  aggregateMonthlyCollection,
  getCollectionMonthRange,
  getCollectionMonthOptions,
} = require("../doctor-reference.js");

test("getMonthDateRange returns the first and last day of the selected month", () => {
  assert.deepEqual(getMonthDateRange(new Date(2026, 7, 29)), {
    fromDate: "2026-08-01",
    toDate: "2026-08-31",
  });

  assert.deepEqual(getMonthDateRange(new Date(2026, 1, 15)), {
    fromDate: "2026-02-01",
    toDate: "2026-02-28",
  });
});

test("aggregateDoctorReferences filters dates inclusively and groups doctor names case-insensitively", () => {
  const report = aggregateDoctorReferences(
    [
      { date: "2026-08-01", refDoctor: "Dr. Mehta", totalFees: 1000 },
      { date: "2026-08-31", refDoctor: "dr. mehta", totalFees: 800 },
      { date: "2026-08-20", refDoctor: "DR.Mehta Sir", totalFees: 200 },
      { date: "2026-09-01", refDoctor: "Dr. Mehta", totalFees: 600 },
      { date: "2026-08-15", refDoctor: "Dr. Shah", totalFees: 500 },
      { date: "2026-08-15", refDoctor: "", totalFees: 999 },
    ],
    "2026-08-01",
    "2026-08-31",
    {}
  );

  assert.deepEqual(report, [
    {
      doctorName: "Dr. Mehta",
      referenceCount: 3,
      totalAmount: 2000,
      percentage: 0,
      payableAmount: 0,
    },
    {
      doctorName: "Dr. Shah",
      referenceCount: 1,
      totalAmount: 500,
      percentage: 0,
      payableAmount: 0,
    },
  ]);
});

test("aggregateDoctorReferences applies each doctor's saved percentage", () => {
  const report = aggregateDoctorReferences(
    [
      { date: "2026-08-10", refDoctor: "Dr. Mehta", totalFees: 1250.5 },
      { date: "2026-08-11", refDoctor: "Dr. Shah", totalFees: 900 },
    ],
    "2026-08-01",
    "2026-08-31",
    { "dr. mehta": 10, "Dr. Shah": 7.5 }
  );

  assert.equal(report[0].percentage, 10);
  assert.equal(report[0].payableAmount, 125.05);
  assert.equal(report[1].percentage, 7.5);
  assert.equal(report[1].payableAmount, 67.5);
});

test("aggregateDoctorReferences prefers the saved percentage for the selected month", () => {
  const report = aggregateDoctorReferences(
    [
      { date: "2026-08-10", refDoctor: "Dr. Mehta", totalFees: 1000 },
      { date: "2026-09-10", refDoctor: "Dr. Mehta", totalFees: 1000 },
    ],
    "2026-08-01",
    "2026-08-31",
    { "Dr. Mehta": 7 },
    { "2026-08": { drmehta: 10 } }
  );

  assert.equal(report[0].percentage, 10);
  assert.equal(report[0].payableAmount, 100);
});

test("aggregateDoctorConsultationFees totals per-doctor fees for the selected period", () => {
  const total = aggregateDoctorConsultationFees(
    [
      { date: "2026-08-10", refDoctor: "Dr. Mehta", totalFees: 1000 },
      { date: "2026-08-15", refDoctor: "Dr. Mehta", totalFees: 500 },
      { date: "2026-08-20", refDoctor: "Dr. Shah", totalFees: 2000 },
      { date: "2026-09-01", refDoctor: "Dr. Mehta", totalFees: 900 },
      { date: "2026-08-21", refDoctor: "", totalFees: 9000 },
    ],
    "2026-08-01",
    "2026-08-31",
    { "Dr. Mehta": 10, "Dr. Shah": 5 },
    { "2026-08": { drmehta: 20 } }
  );

  assert.equal(total, 400);
});

test("new monthly reports fall back to the saved default percentage", () => {
  const report = aggregateDoctorReferences(
    [{ date: "2026-09-10", refDoctor: "Dr. Mehta", totalFees: 1000 }],
    "2026-09-01",
    "2026-09-30",
    { "Dr. Mehta": 7 },
    { "2026-08": { drmehta: 10 } }
  );

  assert.equal(report[0].percentage, 7);
  assert.equal(report[0].payableAmount, 70);
});

test("monthly report history normalizes only valid period and percentage values", () => {
  assert.deepEqual(
    normalizeDoctorReferencePercentageHistory({
      "2026-08": { drmehta: "10", invalid: 101 },
      "2026-09-01__2026-09-15": { "dr shah": 7.5 },
      invalid: { drmehta: 20 },
      "2026-10": "not-an-object",
    }),
    {
      "2026-08": { mehta: 10 },
      "2026-09-01__2026-09-15": { shah: 7.5 },
    }
  );
});

test("doctor reference period keys identify complete months and custom ranges", () => {
  assert.equal(getDoctorReferencePeriodKey("2026-08-01", "2026-08-31"), "2026-08");
  assert.equal(
    getDoctorReferencePeriodKey("2026-08-10", "2026-08-20"),
    "2026-08-10__2026-08-20"
  );
});

test("normalizeDoctorReferencePercentages keeps only valid percentages from zero to one hundred", () => {
  assert.deepEqual(
    normalizeDoctorReferencePercentages({
      "Dr. Mehta": "10",
      "Dr. Shah": 100,
      "Dr. Invalid": -2,
      "Dr. Too High": 101,
      "Dr. NaN": "not-a-number",
      "": 20,
    }),
    {
      "Dr. Mehta": 10,
      "Dr. Shah": 100,
    }
  );
});

test("renameDoctorReferenceData updates records, doctor list, defaults, and every saved period", () => {
  const result = renameDoctorReferenceData(
    [
      { refDoctor: "Dr. Mehta", patientName: "A" },
      { refDoctor: "dr mehta sir", patientName: "B" },
      { refDoctor: "Dr. Shah", patientName: "C" },
    ],
    {
      referringDoctors: ["Dr. Mehta", "Dr. Shah"],
      doctorReferencePercentages: { "Dr. Mehta": 12, "Dr. Shah": 7 },
      doctorReferencePercentageHistory: {
        "2026-08": { mehta: 10, shah: 5 },
        "2026-09-01__2026-09-15": { drmehta: 15 },
      },
    },
    "Dr. Mehta",
    "Dr. Amit Mehta"
  );

  assert.deepEqual(result.records.map((record) => record.refDoctor), [
    "Dr. Amit Mehta",
    "Dr. Amit Mehta",
    "Dr. Shah",
  ]);
  assert.deepEqual(result.config.referringDoctors, ["Dr. Amit Mehta", "Dr. Shah"]);
  assert.deepEqual(result.config.doctorReferencePercentages, {
    "Dr. Amit Mehta": 12,
    "Dr. Shah": 7,
  });
  assert.deepEqual(result.config.doctorReferencePercentageHistory, {
    "2026-08": { shah: 5, amitmehta: 10 },
    "2026-09-01__2026-09-15": { amitmehta: 15 },
  });
});

test("calculateDoctorPayable returns zero for invalid values", () => {
  assert.equal(calculateDoctorPayable(1000, 10), 100);
  assert.equal(calculateDoctorPayable(1000, 10.555), 105.55);
  assert.equal(calculateDoctorPayable(-1000, 10), 0);
  assert.equal(calculateDoctorPayable(1000, 101), 0);
});

test("filterDoctorReferenceReport returns all doctors for an empty search and matches doctor names", () => {
  const report = [
    { doctorName: "Dr. Mehta", referenceCount: 3 },
    { doctorName: "Dr. Shah", referenceCount: 1 },
  ];

  assert.deepEqual(filterDoctorReferenceReport(report, ""), report);
  assert.deepEqual(filterDoctorReferenceReport(report, "meht"), [report[0]]);
  assert.deepEqual(filterDoctorReferenceReport(report, "unknown"), []);
});

test("aggregateMonthlyCollection calculates cash, online, split, daily, and cumulative totals", () => {
  const report = aggregateMonthlyCollection([
    { operationId: "cash-1", date: "2026-09-01", paymentMethod: "Cash", totalFees: 500 },
    { operationId: "online-1", date: "2026-09-01", paymentMethod: "Online", totalFees: 700 },
    { operationId: "split-1", date: "2026-09-02", paymentMethod: "Split Payment", cashAmount: 600, onlineAmount: 400, totalFees: 1000 },
    { operationId: "cash-2", date: "2026-09-02", paymentMethod: "Cash", totalFees: 300 },
  ], "2026-09", new Date(2026, 8, 30));

  assert.equal(report.cash, 1400);
  assert.equal(report.online, 1100);
  assert.equal(report.unclassified, 0);
  assert.equal(report.total, 2500);
  assert.equal(report.recordCount, 4);
  assert.equal(report.daily[0].date, "2026-09-01");
  assert.deepEqual(report.daily[0], {
    date: "2026-09-01", cash: 500, online: 700, unclassified: 0, total: 1200, cumulative: 1200
  });
  assert.deepEqual(report.daily[1], {
    date: "2026-09-02", cash: 900, online: 400, unclassified: 0, total: 1300, cumulative: 2500
  });
  assert.equal(report.daily.length, 30);
  assert.equal(report.daily[2].total, 0);
  assert.equal(report.daily.at(-1).cumulative, report.total);
});

test("current month ends today while completed months use their calendar end", () => {
  assert.deepEqual(
    getCollectionMonthRange("2026-09", new Date(2026, 8, 15)),
    { month: "2026-09", fromDate: "2026-09-01", toDate: "2026-09-15", isCurrentMonth: true }
  );
  assert.deepEqual(
    getCollectionMonthRange("2026-08", new Date(2026, 8, 15)),
    { month: "2026-08", fromDate: "2026-08-01", toDate: "2026-08-31", isCurrentMonth: false }
  );
});

test("legacy payment data is classified safely without guessing cash or online", () => {
  const report = aggregateMonthlyCollection([
    { date: "2026-08-01", paymentMethod: "Cash", totalFees: "₹1,200" },
    { date: "2026-08-02", paymentMethod: "Online", totalFees: "1,300" },
    { date: "2026-08-03", paymentMethod: "", totalFees: "900" },
    { date: "2026-08-04", paymentMethod: "", totalFees: "₹1,100" },
    { date: "2026-08-05", paymentMethod: "Cash", totalFees: "not-a-number" },
    { date: "2026-08-06", paymentMethod: "Cash", totalFees: null },
  ], "2026-08", new Date(2026, 8, 15));

  assert.equal(report.cash, 1200);
  assert.equal(report.online, 1300);
  assert.equal(report.unclassified, 2000);
  assert.equal(report.total, 4500);
  assert.ok(report.daily.every((row) => Number.isFinite(row.total) && !Number.isNaN(row.total)));
});

test("collection excludes other months, deduplicates operation IDs, and lists available months", () => {
  const records = [
    { operationId: "same", date: "2026-08-10", paymentMethod: "Cash", totalFees: 100 },
    { operationId: "same", date: "2026-08-10", paymentMethod: "Cash", totalFees: 100 },
    { operationId: "other-month", date: "2026-07-10", paymentMethod: "Cash", totalFees: 200 },
    { operationId: "future", date: "2026-10-01", paymentMethod: "Cash", totalFees: 300 },
  ];

  const report = aggregateMonthlyCollection(records, "2026-08", new Date(2026, 8, 15));
  assert.equal(report.total, 100);
  assert.equal(report.recordCount, 1);
  assert.deepEqual(getCollectionMonthOptions(records, new Date(2026, 8, 15)), ["2026-09", "2026-08", "2026-07"]);
});

test("zero-record collection month still provides a complete zeroed daily table", () => {
  const report = aggregateMonthlyCollection([], "2026-02", new Date(2026, 8, 15));
  assert.equal(report.total, 0);
  assert.equal(report.cash, 0);
  assert.equal(report.online, 0);
  assert.equal(report.unclassified, 0);
  assert.equal(report.daily.length, 28);
  assert.ok(report.daily.every((row) => row.total === 0 && row.cumulative === 0));
});

test("Monthly Review keeps the public navigation label private", () => {
  const indexMarkup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const doctorReferenceScript = fs.readFileSync(path.join(__dirname, "..", "doctor-reference.js"), "utf8");
  const tabMarkup = indexMarkup.match(/<button[^>]*id="tabDoctorReference"[^>]*>([^<]+)<\/button>/);

  assert.ok(tabMarkup, "the private report tab must exist");
  assert.equal(tabMarkup[1].trim(), "Monthly Review");
  assert.doesNotMatch(tabMarkup[1], /doctor|referral|reference|fee|commission/i);
  assert.match(indexMarkup, /id="doctorReferenceSearchInput"/);
  assert.doesNotMatch(indexMarkup, /doctorReferenceSearchDropdown/);
  assert.doesNotMatch(patientScript, /doctorReferenceSearchDropdown/);
  assert.match(indexMarkup, />Doctor Referral Summary</);
  assert.match(indexMarkup, /<th>Consultation Fee<\/th>/);
  assert.doesNotMatch(indexMarkup, /Payable Amount/);
  assert.match(doctorReferenceScript, /<th>Consultation Fee<\/th>/);
  assert.doesNotMatch(patientScript, /<th>Payable Amount<\/th>/);
});

test("Monthly Collection is wired into the protected Monthly Review page", () => {
  const indexMarkup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const doctorReferenceScript = fs.readFileSync(path.join(__dirname, "..", "doctor-reference.js"), "utf8");

  assert.match(indexMarkup, /id="monthlyCollectionSection"/);
  assert.match(indexMarkup, /id="monthlyCollectionMonth"/);
  assert.match(indexMarkup, /id="monthlyCollectionBody"/);
  assert.match(indexMarkup, /id="monthlyCollectionConsultationFees"/);
  assert.match(patientScript, /function renderMonthlyCollection/);
  assert.match(patientScript, /aggregateDoctorConsultationFees/);
  assert.match(patientScript, /getCollectionMonthOptions/);
  assert.match(doctorReferenceScript, /function aggregateMonthlyCollection/);
});

test("Monthly Report provides an overall print action for every doctor", () => {
  const indexMarkup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");

  assert.equal(typeof buildOverallDoctorReferencePrintHtml, "function");
  assert.match(indexMarkup, /id="doctorReferenceOverallPrintBtn"/);
  assert.match(indexMarkup, />Print Overall Report</);
  assert.match(patientScript, /function printOverallDoctorReferenceSummary/);
  assert.match(patientScript, /buildOverallDoctorReferencePrintHtml/);

  const html = buildOverallDoctorReferencePrintHtml({
    fromDate: "2026-08-01",
    toDate: "2026-08-31",
    generatedAt: "31 Aug 2026, 12:30 am",
    doctors: [
      { doctorName: "Dr. Alpha", referenceCount: 3, totalAmount: 2000, percentage: 10, payableAmount: 200 },
      { doctorName: "Dr. Beta", referenceCount: 2, totalAmount: 1500, percentage: 20, payableAmount: 300 },
    ],
  });
  assert.match(html, /Overall Monthly Report/);
  assert.match(html, /<th>Doctor Name<\/th>/);
  assert.match(html, /<th>Total References<\/th>/);
  assert.match(html, /<th>Total Amount Generated<\/th>/);
  assert.match(html, /<th>Percentage<\/th>/);
  assert.match(html, /<th>Consultation Fee<\/th>/);
  assert.match(html, /Dr\. Alpha/);
  assert.match(html, /Dr\. Beta/);
  assert.match(html, /10%/);
  assert.match(html, /₹500\.00/);
  assert.match(html, /table-header-group/);
});

test("Monthly Report shows only a centered authentication gate while locked", () => {
  const indexMarkup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "patient.css"), "utf8");

  assert.match(indexMarkup, /id="doctorReferenceAuthGate"/);
  assert.match(indexMarkup, /Authentication Required/);
  assert.match(indexMarkup, /id="doctorReferenceAuthGateBtn"/);
  assert.match(indexMarkup, /id="doctorReferenceSelectionSection"/);
  assert.match(indexMarkup, /id="doctorReferenceTableSection"/);
  assert.match(patientScript, /doctorReferenceAuthGate\.hidden = canView/);
  assert.match(patientScript, /doctorReferenceSelectionSection\.hidden = !canView/);
  assert.match(patientScript, /doctorReferenceTableSection\.hidden = !canView/);
  assert.match(styles, /\.doctor-reference-auth-gate\s*\{/);
});

test("Doctor Reference table layout fits its container without horizontal scrolling", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "patient.css"), "utf8");
  const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");

  assert.match(styles, /\.doctor-reference-table-wrap\s*\{[^}]*overflow-x:\s*hidden/);
  assert.match(styles, /\.doctor-reference-table\s*\{[^}]*min-width:\s*0/);
  assert.match(styles, /\.doctor-reference-table\s*\{[^}]*table-layout:\s*fixed/);
  assert.doesNotMatch(styles, /\.doctor-reference-table\s*\{[^}]*min-width:\s*760px/);
  assert.match(patientScript, /data-label="Doctor Name"/);
});

test("Doctor Reference data is locked until scoped admin access is granted", () => {
  const indexMarkup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "patient.css"), "utf8");

  assert.match(indexMarkup, /id="doctorReferenceLockedState"/);
  assert.match(indexMarkup, /Admin Access to View &amp; Edit/);
  assert.match(patientScript, /let doctorReferenceAccessUnlocked = window\.APP_CONFIG\?\.DEMO_MODE === true/);
  assert.match(patientScript, /if \(!enabled && window\.APP_CONFIG\?\.DEMO_MODE !== true\) doctorReferenceAccessUnlocked = false/);
  assert.match(patientScript, /isAdminMode \|\| doctorReferenceAccessUnlocked/);
  assert.match(patientScript, /doctorReferenceLockedState\.hidden/);
  assert.match(patientScript, /isAdminMode \|\| doctorReferenceAccessUnlocked \? "" : "disabled"/);
  assert.match(patientScript, /showAdminModal\("doctorReference"\)/);
  assert.match(styles, /\.doctor-reference-locked-state\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(styles, /#doctorReferencePage \.doctor-reference-table-wrap\s*\{[^}]*border:/s);
  assert.match(styles, /font-variant-numeric:\s*tabular-nums/);
  assert.match(styles, /\.doctor-reference-admin-btn\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(styles, /\.doctor-reference-admin-btn\s*\{[^}]*justify-content:\s*center/s);
  assert.match(indexMarkup, /<th>Actions<\/th>/);
  assert.match(patientScript, /doctor-reference-print-btn/);
  assert.match(patientScript, /function printDoctorReferenceSummary/);
  assert.match(styles, /\.doctor-reference-print-btn\s*\{/);
});

test("Admin password modal submits when Enter is pressed in the password field", () => {
  const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");

  assert.match(patientScript, /adminPasswordInput\.addEventListener\("keydown"/);
  assert.match(patientScript, /event\.key === "Enter"/);
  assert.match(patientScript, /adminLoginSubmitBtn\.click\(\)/);
});

test("Doctor Reference print reads the current table percentage", () => {
  const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");

  assert.match(
    patientScript,
    /const percentageInput = button\.closest\("tr"\)\?\.querySelector\("\.doctor-reference-percent-input"\)/
  );
  assert.match(patientScript, /Number\(percentageInput\?\.value \?\? button\.dataset\.percentage \?\? 0\)/);
  assert.match(patientScript, /calculateDoctorPayable\(totalAmount, percentage\)/);
});

test("Monthly Report doctor names are editable and saved through the app-wide rename flow", () => {
  const indexMarkup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const appsScript = fs.readFileSync(path.join(__dirname, "..", "apps-script.gs"), "utf8");

  assert.match(patientScript, /doctor-reference-name-input/);
  assert.match(patientScript, /function saveDoctorReferenceName/);
  assert.match(patientScript, /op: "renameReferringDoctor"/);
  assert.match(patientScript, /renameDoctorReferenceData/);
  assert.match(appsScript, /op === 'renameReferringDoctor'/);
  assert.match(appsScript, /Referring Doctor/);
  assert.match(indexMarkup, /<th>Doctor Name<\/th>/);
});

test("Monthly Report printing uses a committed printable document instead of about:blank document.write", () => {
  const patientScript = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const html = buildDoctorReferencePrintHtml({
    doctorName: "Dr. <Mehta>",
    referenceCount: 3,
    totalAmountText: "₹2,000.00",
    percentage: 10,
    consultationFeeText: "₹200.00",
    fromDate: "2026-08-01",
    toDate: "2026-08-31",
    generatedAt: "30 Aug 2026, 10:30 pm",
    patients: [
      { visitDate: "2026-08-03", patientName: "Asha Patil", amountPaidText: "₹800.00" },
      { visitDate: "2026-08-12", patientName: "Rahul Deshmukh", amountPaidText: "₹1,200.00" },
    ],
  });

  assert.match(patientScript, /URL\.createObjectURL/);
  assert.doesNotMatch(patientScript, /printWindow\.document\.write/);
  assert.match(patientScript, /window\.open\(printUrl/);
  assert.match(html, /<title>Monthly Report - Dr\. &lt;Mehta&gt;<\/title>/);
  assert.match(html, /@page\s*\{[^}]*size:\s*A4/s);
  assert.match(html, /Consultation Fee/);
  assert.match(html, /Generated on/);
  assert.match(html, /Patient Details/);
  assert.match(html, /<th>Sr\. No\.<\/th>/);
  assert.match(html, /<th>Patient Name<\/th>/);
  assert.match(html, /<th>Amount Paid<\/th>/);
  assert.match(html, /Asha Patil/);
  assert.match(html, /Rahul Deshmukh/);
  assert.match(html, /₹800\.00/);
  assert.match(html, /₹1,200\.00/);
  assert.doesNotMatch(html, /2026-08-03|2026-08-12/);
  assert.match(html, /thead\s*\{\s*display:\s*table-header-group/);
  assert.match(html, /page-break-inside:\s*auto/);
  assert.match(html, /body\s*\{\s*font-size:\s*10px;\s*\}/);
  assert.match(html, /\.report-header\s*\{\s*padding-bottom:\s*7px;/);
  assert.match(html, /\.patient-table th, \.patient-table td\s*\{\s*padding:\s*3px 5px;/);
  assert.match(html, /\.report-footer\s*\{\s*margin-top:\s*8px;/);
  assert.doesNotMatch(html, /patient-grid/);
  assert.doesNotMatch(html, /<Mehta>/);
  assert.match(patientScript, /amountPaidText:\s*formatMoney\(record\.totalFees, true\)/);
  assert.doesNotMatch(patientScript, /visitDate:\s*formatDateDisplay\(record\.date\)/);
});

test("Monthly Report dense print mode keeps compact spacing for large patient lists", () => {
  const html = buildDoctorReferencePrintHtml({
    doctorName: "Dr. Dense",
    referenceCount: 26,
    totalAmountText: "₹26,000.00",
    percentage: 10,
    consultationFeeText: "₹2,600.00",
    patients: Array.from({ length: 26 }, (_, index) => ({
      patientName: `Patient ${index + 1}`,
      amountPaidText: "₹1,000.00",
    })),
  });

  assert.match(html, /<main class="report-sheet report-sheet-dense">/);
  assert.match(html, /\.report-sheet-dense \.report-header\s*\{\s*padding-bottom:\s*7px;/);
  assert.match(html, /\.report-sheet-dense \.patient-table th, \.report-sheet-dense \.patient-table td\s*\{\s*padding:\s*3px 5px;\s*font-size:\s*8px;/);
});

test("Monthly Report splits patients into left and right tables in order", () => {
  const html = buildDoctorReferencePrintHtml({
    doctorName: "Dr. Columns",
    referenceCount: 27,
    totalAmountText: "₹27,000.00",
    percentage: 10,
    consultationFeeText: "₹2,700.00",
    patients: Array.from({ length: 27 }, (_, index) => ({
      patientName: `Patient ${index + 1}`,
      amountPaidText: "₹1,000.00",
    })),
  });

  assert.equal((html.match(/class="patient-table-card"/g) || []).length, 2);
  const leftTable = html.match(/<table class="patient-table">[\s\S]*?<\/table>/g)?.[0] || "";
  const rightTable = html.match(/<table class="patient-table">[\s\S]*?<\/table>/g)?.[1] || "";
  assert.match(leftTable, /Patient 1/);
  assert.match(leftTable, /Patient 25/);
  assert.doesNotMatch(leftTable, /Patient 26/);
  assert.match(rightTable, /Patient 26/);
  assert.match(rightTable, /Patient 27/);
  assert.doesNotMatch(rightTable, /Patient 1/);
});

test("Monthly Report omits an unused right table", () => {
  const html = buildDoctorReferencePrintHtml({
    doctorName: "Dr. Short",
    referenceCount: 2,
    totalAmountText: "₹2,000.00",
    percentage: 10,
    consultationFeeText: "₹200.00",
    patients: [
      { patientName: "Patient 1", amountPaidText: "₹1,000.00" },
      { patientName: "Patient 2", amountPaidText: "₹1,000.00" },
    ],
  });

  assert.equal((html.match(/class="patient-table-card"/g) || []).length, 1);
  assert.match(html, /Patient 1/);
  assert.match(html, /Patient 2/);
});

test("Monthly Report starts a new left-first page after both columns are full", () => {
  const html = buildDoctorReferencePrintHtml({
    doctorName: "Dr. Pages",
    referenceCount: 51,
    totalAmountText: "₹51,000.00",
    percentage: 10,
    consultationFeeText: "₹5,100.00",
    patients: Array.from({ length: 51 }, (_, index) => ({
      patientName: `Patient ${index + 1}`,
      amountPaidText: "₹1,000.00",
    })),
  });
  const tables = html.match(/<table class="patient-table">[\s\S]*?<\/table>/g) || [];

  assert.equal(tables.length, 3);
  assert.match(tables[0], /Patient 1/);
  assert.match(tables[0], /Patient 25/);
  assert.match(tables[1], /Patient 26/);
  assert.match(tables[1], /Patient 50/);
  assert.match(tables[2], /Patient 51/);
  assert.doesNotMatch(tables[2], /Patient 1/);
  assert.match(html, /patient-page-break/);
});
