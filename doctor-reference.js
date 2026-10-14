(function attachDoctorReference(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.DoctorReference = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDoctorReference() {
  function normalizeDate(value) {
    if (!value) return "";
    const text = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";

    return [
      parsed.getFullYear(),
      String(parsed.getMonth() + 1).padStart(2, "0"),
      String(parsed.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function normalizeDoctorKey(value) {
    let clean = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (clean.startsWith("dr")) clean = clean.substring(2);
    return clean.replace(/(sir|mam|madam)$/, "");
  }

  function getMonthDateRange(value = new Date()) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) return { fromDate: "", toDate: "" };

    const year = date.getFullYear();
    const month = date.getMonth();
    const monthText = String(month + 1).padStart(2, "0");
    const lastDay = new Date(year, month + 1, 0).getDate();

    return {
      fromDate: `${year}-${monthText}-01`,
      toDate: `${year}-${monthText}-${String(lastDay).padStart(2, "0")}`,
    };
  }

  function normalizeCollectionMonth(value) {
    const text = String(value ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(text)) return "";
    const month = Number(text.slice(5, 7));
    return month >= 1 && month <= 12 ? text : "";
  }

  function getCollectionMonthRange(monthValue, referenceDate = new Date()) {
    const reference = normalizeDate(referenceDate);
    const currentMonth = reference ? reference.slice(0, 7) : "";
    const month = normalizeCollectionMonth(monthValue) || currentMonth;
    if (!month) return { month: "", fromDate: "", toDate: "", isCurrentMonth: false };

    const year = Number(month.slice(0, 4));
    const monthNumber = Number(month.slice(5, 7));
    const lastDay = new Date(year, monthNumber, 0).getDate();
    const fromDate = `${month}-01`;
    const fullMonthEnd = `${month}-${String(lastDay).padStart(2, "0")}`;
    const isCurrentMonth = month === currentMonth;

    return {
      month,
      fromDate,
      toDate: isCurrentMonth ? reference : fullMonthEnd,
      isCurrentMonth,
    };
  }

  function getCollectionMonthOptions(records, referenceDate = new Date()) {
    const currentMonth = normalizeDate(referenceDate).slice(0, 7);
    const months = new Set(currentMonth ? [currentMonth] : []);

    (Array.isArray(records) ? records : []).forEach((record) => {
      const date = normalizeDate(record?.date);
      const month = date.slice(0, 7);
      if (month && (!currentMonth || month <= currentMonth)) months.add(month);
    });

    return Array.from(months).sort().reverse();
  }

  function roundMoney(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function parseCollectionAmount(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string") {
      const cleaned = value.replace(/[₹,\s]/g, "").trim();
      if (!cleaned) return null;
      value = cleaned;
    }
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }

  function getRecordCollectionAmounts(record) {
    const cash = parseCollectionAmount(record?.cashAmount);
    const online = parseCollectionAmount(record?.onlineAmount);
    const totalFees = parseCollectionAmount(record?.totalFees);

    if (cash !== null || online !== null) {
      return {
        cash: cash ?? 0,
        online: online ?? 0,
        unclassified: 0,
        total: roundMoney((cash ?? 0) + (online ?? 0)),
      };
    }

    const method = String(record?.paymentMethod ?? "").trim().toLowerCase();
    if (totalFees !== null && method === "cash") {
      return { cash: totalFees, online: 0, unclassified: 0, total: totalFees };
    }
    if (totalFees !== null && method === "online") {
      return { cash: 0, online: totalFees, unclassified: 0, total: totalFees };
    }

    return {
      cash: 0,
      online: 0,
      unclassified: totalFees ?? 0,
      total: totalFees ?? 0,
    };
  }

  function aggregateMonthlyCollection(records, selectedMonth, referenceDate = new Date()) {
    const range = getCollectionMonthRange(selectedMonth, referenceDate);
    if (!range.month) {
      return { ...range, cash: 0, online: 0, unclassified: 0, total: 0, recordCount: 0, daily: [] };
    }

    const daily = [];
    const dailyByDate = new Map();
    const cursor = new Date(`${range.fromDate}T00:00:00`);
    const end = new Date(`${range.toDate}T00:00:00`);
    while (cursor <= end) {
      const date = normalizeDate(cursor);
      const row = { date, cash: 0, online: 0, unclassified: 0, total: 0, cumulative: 0 };
      daily.push(row);
      dailyByDate.set(date, row);
      cursor.setDate(cursor.getDate() + 1);
    }

    const seenOperationIds = new Set();
    let recordCount = 0;
    (Array.isArray(records) ? records : []).forEach((record) => {
      const date = normalizeDate(record?.date);
      if (!date || date < range.fromDate || date > range.toDate) return;

      const operationId = String(record?.operationId || record?.["Operation ID"] || "").trim();
      if (operationId) {
        if (seenOperationIds.has(operationId)) return;
        seenOperationIds.add(operationId);
      }

      const row = dailyByDate.get(date);
      if (!row) return;
      const amounts = getRecordCollectionAmounts(record);
      row.cash += amounts.cash;
      row.online += amounts.online;
      row.unclassified += amounts.unclassified;
      row.total += amounts.total;
      recordCount += 1;
    });

    let cumulative = 0;
    daily.forEach((row) => {
      row.cash = roundMoney(row.cash);
      row.online = roundMoney(row.online);
      row.unclassified = roundMoney(row.unclassified);
      row.total = roundMoney(row.cash + row.online + row.unclassified);
      cumulative = roundMoney(cumulative + row.total);
      row.cumulative = cumulative;
    });

    return {
      ...range,
      cash: roundMoney(daily.reduce((sum, row) => sum + row.cash, 0)),
      online: roundMoney(daily.reduce((sum, row) => sum + row.online, 0)),
      unclassified: roundMoney(daily.reduce((sum, row) => sum + row.unclassified, 0)),
      total: cumulative,
      recordCount,
      daily,
    };
  }

  function normalizeDoctorReferencePercentages(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};

    return Object.entries(value).reduce((result, [doctorName, rawPercentage]) => {
      const name = String(doctorName ?? "").trim();
      const percentage = Number(rawPercentage);
      if (name && Number.isFinite(percentage) && percentage >= 0 && percentage <= 100) {
        result[name] = percentage;
      }
      return result;
    }, {});
  }

  function isValidPeriodKey(value) {
    const key = String(value ?? "").trim();
    if (/^\d{4}-\d{2}$/.test(key)) return true;
    if (!/^\d{4}-\d{2}-\d{2}__\d{4}-\d{2}-\d{2}$/.test(key)) return false;

    const [fromDate, toDate] = key.split("__");
    return normalizeDate(fromDate) === fromDate && normalizeDate(toDate) === toDate && fromDate <= toDate;
  }

  function normalizeDoctorReferencePercentageHistory(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};

    return Object.entries(value).reduce((result, [periodKey, doctorPercentages]) => {
      const normalizedPeriodKey = String(periodKey ?? "").trim();
      if (!isValidPeriodKey(normalizedPeriodKey) || !doctorPercentages || typeof doctorPercentages !== "object" || Array.isArray(doctorPercentages)) {
        return result;
      }

      const normalizedDoctors = Object.entries(doctorPercentages).reduce((doctors, [doctorName, rawPercentage]) => {
        const doctorKey = normalizeDoctorKey(doctorName);
        const percentage = Number(rawPercentage);
        if (doctorKey && Number.isFinite(percentage) && percentage >= 0 && percentage <= 100) {
          doctors[doctorKey] = percentage;
        }
        return doctors;
      }, {});

      if (Object.keys(normalizedDoctors).length > 0) {
        result[normalizedPeriodKey] = normalizedDoctors;
      }
      return result;
    }, {});
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildDoctorReferencePrintHtml({
    doctorName,
    referenceCount,
    totalAmountText,
    percentage,
    consultationFeeText,
    fromDate,
    toDate,
    generatedAt,
    patients,
  } = {}) {
    const safeDoctorName = escapeHtml(doctorName);
    const safeReferenceCount = escapeHtml(referenceCount);
    const safeTotalAmount = escapeHtml(totalAmountText);
    const safePercentage = escapeHtml(percentage);
    const safeConsultationFee = escapeHtml(consultationFeeText);
    const safeFromDate = escapeHtml(fromDate);
    const safeToDate = escapeHtml(toDate);
    const safeGeneratedAt = escapeHtml(generatedAt);
    const patientRecords = Array.isArray(patients) ? patients : [];
    const patientCount = patientRecords.length;
    const patientsPerColumn = 25;
    const buildPatientTable = (columnPatients, startIndex) => {
      const patientRows = columnPatients.map((patient, index) => `
      <tr>
        <td>${startIndex + index + 1}</td>
        <td><strong>${escapeHtml(patient?.patientName || "Unnamed patient")}</strong></td>
        <td>${escapeHtml(patient?.amountPaidText || "")}</td>
      </tr>`).join("");
      return `<div class="patient-table-card">
        <table class="patient-table">
          <thead><tr><th>Sr. No.</th><th>Patient Name</th><th>Amount Paid</th></tr></thead>
          <tbody>${patientRows}</tbody>
        </table>
      </div>`;
    };
    const patientPageMarkup = [];
    for (let pageStart = 0; pageStart < patientCount; pageStart += patientsPerColumn * 2) {
      const leftPatients = patientRecords.slice(pageStart, pageStart + patientsPerColumn);
      const rightPatients = patientRecords.slice(pageStart + patientsPerColumn, pageStart + patientsPerColumn * 2);
      const pageColumns = [
        { patients: leftPatients, startIndex: pageStart },
        { patients: rightPatients, startIndex: pageStart + patientsPerColumn },
      ].filter((column) => column.patients.length > 0);
      patientPageMarkup.push(`<div class="patient-page${pageStart ? " patient-page-break" : ""}">
        <div class="patient-table-columns">
          ${pageColumns.map((column) => buildPatientTable(column.patients, column.startIndex)).join("")}
        </div>
      </div>`);
    }
    const patientSection = patientCount
      ? `<section class="patient-section" aria-label="Patient details">
          <div class="section-heading"><h2>Patient Details</h2><span>${patientCount} patients</span></div>
          ${patientPageMarkup.join("")}
        </section>`
      : `<section class="patient-section" aria-label="Patient details">
          <div class="section-heading"><h2>Patient Details</h2><span>0 patients</span></div>
          <div class="patient-empty">No patient records found for this period.</div>
        </section>`;
    const densityClass = patientCount > 25 ? " report-sheet-dense" : "";

    return `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Monthly Report - ${safeDoctorName}</title>
          <style>
            @page { size: A4 portrait; margin: 14mm; }
            :root { color-scheme: light; font-family: "Segoe UI", Arial, sans-serif; }
            * { box-sizing: border-box; }
            body { margin: 0; color: #172033; background: #ffffff; font-size: 12px; line-height: 1.45; }
            .report-sheet { width: 100%; max-width: 820px; margin: 0 auto; }
            .report-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 28px; padding-bottom: 18px; border-bottom: 2px solid #1d4ed8; }
            .brand { color: #1d4ed8; font-size: 11px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
            h1 { margin: 7px 0 4px; color: #102a56; font-size: 28px; line-height: 1.1; letter-spacing: -.02em; }
            .report-subtitle { margin: 0; color: #475569; font-size: 14px; font-weight: 600; }
            .report-period { min-width: 150px; color: #475569; font-size: 11px; text-align: right; }
            .period-label { display: block; margin-bottom: 3px; color: #94a3b8; font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
            .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 22px 0; }
            .summary-item { padding: 12px 14px; border: 1px solid #dbe3ee; border-radius: 8px; background: #f8fafc; }
            .summary-label { display: block; margin-bottom: 4px; color: #64748b; font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
            .summary-value { color: #172033; font-size: 15px; font-weight: 800; }
            .table-card { overflow: hidden; border: 1px solid #dbe3ee; border-radius: 9px; }
            table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            th, td { padding: 13px 14px; border-bottom: 1px solid #e2e8f0; vertical-align: middle; }
            th { color: #475569; background: #f8fafc; font-size: 10px; font-weight: 800; letter-spacing: .06em; line-height: 1.25; text-align: right; text-transform: uppercase; }
            th:first-child, td:first-child { width: 27%; text-align: left; }
            td { color: #1f2937; font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
            td:first-child { color: #102a56; font-weight: 800; overflow-wrap: anywhere; }
            tr:last-child td { border-bottom: 0; }
            .patient-section { margin-top: 19px; page-break-inside: auto; }
            .section-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 7px; }
            .section-heading h2 { margin: 0; color: #102a56; font-size: 14px; letter-spacing: -.01em; }
            .section-heading span { color: #64748b; font-size: 10px; font-weight: 700; }
            .patient-page { break-inside: avoid; page-break-inside: avoid; }
            .patient-page-break { break-before: page; page-break-before: always; }
            .patient-table-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: start; }
            .patient-table-card { overflow: hidden; border: 1px solid #dbe3ee; border-radius: 9px; page-break-inside: auto; }
            .patient-table { width: 100%; table-layout: fixed; }
            .patient-table thead { display: table-header-group; }
            .patient-table tbody tr { break-inside: avoid; page-break-inside: avoid; }
            .patient-table th, .patient-table td { padding: 7px 9px; }
            .patient-table th { text-align: left; }
            .patient-table th:nth-child(1), .patient-table td:nth-child(1) { width: 15%; text-align: center; }
            .patient-table th:nth-child(2), .patient-table td:nth-child(2) { width: 55%; text-align: left; }
            .patient-table th:nth-child(3), .patient-table td:nth-child(3) { width: 30%; text-align: right; }
            .patient-table td { font-size: 11px; }
            .patient-table td:first-child { color: #1d4ed8; font-weight: 800; }
            .patient-table td:nth-child(2) strong { display: block; overflow-wrap: anywhere; color: #172033; line-height: 1.25; }
            .patient-table td:nth-child(2) small { display: block; margin-top: 1px; color: #64748b; font-size: 9px; }
            .patient-table tr:last-child td { border-bottom: 0; }
            .patient-empty { padding: 12px; border: 1px solid #dbe3ee; border-radius: 9px; color: #64748b; font-size: 11px; }
            .report-footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 18px; padding-top: 12px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 10px; }
            .report-sheet-dense .report-header { padding-bottom: 7px; }
            .report-sheet-dense h1 { font-size: 20px; }
            .report-sheet-dense .summary-grid { gap: 5px; margin: 8px 0; }
            .report-sheet-dense .summary-item { padding: 5px 7px; }
            .report-sheet-dense .patient-section { margin-top: 8px; }
            .report-sheet-dense .patient-table th, .report-sheet-dense .patient-table td { padding: 3px 5px; font-size: 8px; line-height: 1.2; }
            @media screen {
              body { min-height: 100vh; padding: 28px; background: #eef2f7; }
              .report-sheet { padding: 34px; background: #ffffff; box-shadow: 0 16px 38px rgba(15, 23, 42, .12); }
            }
            @media print {
              .report-sheet { max-width: none; }
            }
            @media (max-width: 600px) {
              body { padding: 12px; }
              .report-sheet { padding: 20px; }
              .report-header { display: block; }
              .report-period { margin-top: 12px; text-align: left; }
              .summary-grid { grid-template-columns: 1fr; }
              th, td { padding: 10px 7px; font-size: 10px; }
              .patient-table-columns { grid-template-columns: 1fr; }
            }
            @media print {
              body { font-size: 10px; }
              .report-header { padding-bottom: 7px; gap: 18px; }
              .brand { font-size: 9px; }
              h1 { margin: 4px 0 2px; font-size: 20px; }
              .report-subtitle { font-size: 11px; }
              .report-period { min-width: 120px; font-size: 9px; }
              .period-label { margin-bottom: 2px; font-size: 8px; }
              .summary-grid { gap: 5px; margin: 8px 0; }
              .summary-item { padding: 5px 7px; }
              .summary-label { margin-bottom: 2px; font-size: 8px; }
              .summary-value { font-size: 11px; }
              th, td { padding: 3px 5px; font-size: 8px; line-height: 1.2; }
              .patient-section { margin-top: 8px; }
              .section-heading { margin-bottom: 3px; }
              .section-heading h2 { font-size: 11px; }
              .section-heading span { font-size: 8px; }
              .patient-table th, .patient-table td { padding: 3px 5px; font-size: 8px; line-height: 1.2; }
              .report-footer { margin-top: 8px; padding-top: 6px; font-size: 8px; }
            }
          </style>
        </head>
        <body>
          <main class="report-sheet${densityClass}">
            <header class="report-header">
              <div>
                <div class="brand">DocCare Pro</div>
                <h1>Monthly Report</h1>
                <p class="report-subtitle">${safeDoctorName}</p>
              </div>
              <div class="report-period">
                <span class="period-label">Report period</span>
                ${safeFromDate}${safeToDate ? ` &ndash; ${safeToDate}` : ""}
              </div>
            </header>
            <section class="summary-grid" aria-label="Report summary">
              <div class="summary-item"><span class="summary-label">Total references</span><span class="summary-value">${safeReferenceCount}</span></div>
              <div class="summary-item"><span class="summary-label">Amount generated</span><span class="summary-value">${safeTotalAmount}</span></div>
              <div class="summary-item"><span class="summary-label">Consultation fee</span><span class="summary-value">${safeConsultationFee}</span></div>
            </section>
            <section class="table-card">
              <table>
                <thead><tr><th>Doctor</th><th>Total References</th><th>Total Amount Generated</th><th>Percentage</th><th>Consultation Fee</th></tr></thead>
                <tbody><tr>
                  <td>${safeDoctorName}</td>
                  <td>${safeReferenceCount}</td>
                  <td>${safeTotalAmount}</td>
                  <td>${safePercentage}%</td>
                  <td>${safeConsultationFee}</td>
                </tr></tbody>
              </table>
            </section>
            ${patientSection}
            <footer class="report-footer"><span>Generated on ${safeGeneratedAt}</span><span>Confidential clinic report</span></footer>
          </main>
          <script>
            window.addEventListener("load", () => {
              requestAnimationFrame(() => requestAnimationFrame(() => { window.focus(); window.print(); }));
            });
            window.addEventListener("afterprint", () => setTimeout(() => window.close(), 200));
          <\/script>
        </body>
      </html>`;
  }

  function buildOverallDoctorReferencePrintHtml({ fromDate, toDate, generatedAt, doctors } = {}) {
    const formatPrintMoney = (value) => {
      const amount = Number(value);
      return Number.isFinite(amount)
        ? `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '₹0.00';
    };
    const doctorRecords = Array.isArray(doctors) ? doctors : [];
    const totalReferences = doctorRecords.reduce((sum, doctor) => sum + (Number(doctor?.referenceCount) || 0), 0);
    const totalAmount = doctorRecords.reduce((sum, doctor) => sum + (Number(doctor?.totalAmount) || 0), 0);
    const totalConsultationFee = doctorRecords.reduce((sum, doctor) => sum + (Number(doctor?.payableAmount) || 0), 0);
    const doctorRows = doctorRecords.map((doctor) => {
      const doctorName = String(doctor?.doctorName || 'Unnamed doctor').trim();
      const totalDoctorAmount = Number(doctor?.totalAmount) || 0;
      const percentage = Number(doctor?.percentage);
      const safePercentage = Number.isFinite(percentage) ? percentage : 0;
      const payableAmount = Number.isFinite(Number(doctor?.payableAmount))
        ? Number(doctor.payableAmount)
        : calculateDoctorPayable(totalDoctorAmount, safePercentage);
      return `<tr>
        <td>${escapeHtml(doctorName)}</td>
        <td>${Number(doctor?.referenceCount) || 0}</td>
        <td>${escapeHtml(formatPrintMoney(totalDoctorAmount))}</td>
        <td>${escapeHtml(safePercentage)}%</td>
        <td>${escapeHtml(formatPrintMoney(payableAmount))}</td>
      </tr>`;
    }).join('');
    const safeFromDate = escapeHtml(fromDate);
    const safeToDate = escapeHtml(toDate);
    const safeGeneratedAt = escapeHtml(generatedAt);

    return `<!doctype html>
      <html lang='en'>
        <head>
          <meta charset='UTF-8' />
          <meta name='viewport' content='width=device-width, initial-scale=1' />
          <title>Overall Monthly Report</title>
          <style>
            @page { size: A4 portrait; margin: 14mm; }
            :root { color-scheme: light; font-family: 'Segoe UI', Arial, sans-serif; }
            * { box-sizing: border-box; }
            body { margin: 0; color: #172033; background: #fff; font-size: 12px; line-height: 1.45; }
            .report-sheet { width: 100%; max-width: 820px; margin: 0 auto; }
            .report-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 28px; padding-bottom: 18px; border-bottom: 2px solid #1d4ed8; }
            .brand { color: #1d4ed8; font-size: 11px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
            h1 { margin: 7px 0 4px; color: #102a56; font-size: 28px; line-height: 1.1; }
            .report-subtitle { margin: 0; color: #475569; font-size: 14px; font-weight: 600; }
            .report-period { min-width: 150px; color: #475569; font-size: 11px; text-align: right; }
            .period-label { display: block; margin-bottom: 3px; color: #94a3b8; font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
            .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 22px 0; }
            .summary-item { padding: 12px 14px; border: 1px solid #dbe3ee; border-radius: 8px; background: #f8fafc; }
            .summary-label { display: block; margin-bottom: 4px; color: #64748b; font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
            .summary-value { color: #172033; font-size: 15px; font-weight: 800; }
            .table-card { overflow: hidden; border: 1px solid #dbe3ee; border-radius: 9px; }
            .overall-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            .overall-table thead { display: table-header-group; }
            .overall-table tbody tr { break-inside: avoid; page-break-inside: avoid; }
            th, td { padding: 9px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: middle; }
            th { color: #475569; background: #f8fafc; font-size: 10px; font-weight: 800; letter-spacing: .06em; line-height: 1.25; text-align: right; text-transform: uppercase; }
            .overall-table th:first-child, .overall-table td:first-child { width: 31%; text-align: left; }
            .overall-table th:nth-child(2), .overall-table td:nth-child(2) { width: 16%; }
            .overall-table th:nth-child(3), .overall-table td:nth-child(3) { width: 21%; }
            .overall-table th:nth-child(4), .overall-table td:nth-child(4) { width: 14%; }
            .overall-table th:nth-child(5), .overall-table td:nth-child(5) { width: 18%; }
            td { color: #1f2937; font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
            .overall-table td:first-child { color: #102a56; font-weight: 800; overflow-wrap: anywhere; }
            tr:last-child td { border-bottom: 0; }
            .report-footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 18px; padding-top: 12px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 10px; }
            @media screen { body { min-height: 100vh; padding: 28px; background: #eef2f7; } .report-sheet { padding: 34px; background: #fff; box-shadow: 0 16px 38px rgba(15, 23, 42, .12); } }
            @media (max-width: 600px) { body { padding: 12px; } .report-sheet { padding: 20px; } .report-header { display: block; } .report-period { margin-top: 12px; text-align: left; } .summary-grid { grid-template-columns: repeat(2, 1fr); } th, td { padding: 8px 6px; font-size: 9px; } }
            @media print { body { font-size: 10px; } .report-header { padding-bottom: 7px; gap: 18px; } .brand { font-size: 9px; } h1 { margin: 4px 0 2px; font-size: 20px; } .report-subtitle { font-size: 11px; } .report-period { min-width: 120px; font-size: 9px; } .period-label { margin-bottom: 2px; font-size: 8px; } .summary-grid { gap: 5px; margin: 8px 0; } .summary-item { padding: 5px 7px; } .summary-label { margin-bottom: 2px; font-size: 8px; } .summary-value { font-size: 11px; } th, td { padding: 3px 5px; font-size: 8px; line-height: 1.2; } .report-footer { margin-top: 8px; padding-top: 6px; font-size: 8px; } }
          </style>
        </head>
        <body>
          <main class='report-sheet'>
            <header class='report-header'><div><div class='brand'>DocCare Pro</div><h1>Overall Monthly Report</h1><p class='report-subtitle'>All referring doctors</p></div><div class='report-period'><span class='period-label'>Report period</span>${safeFromDate}${safeToDate ? ` &ndash; ${safeToDate}` : ''}</div></header>
            <section class='summary-grid' aria-label='Overall report summary'>
              <div class='summary-item'><span class='summary-label'>Doctors</span><span class='summary-value'>${doctorRecords.length}</span></div>
              <div class='summary-item'><span class='summary-label'>Total references</span><span class='summary-value'>${totalReferences}</span></div>
              <div class='summary-item'><span class='summary-label'>Amount generated</span><span class='summary-value'>${escapeHtml(formatPrintMoney(totalAmount))}</span></div>
              <div class='summary-item'><span class='summary-label'>Consultation fees</span><span class='summary-value'>${escapeHtml(formatPrintMoney(totalConsultationFee))}</span></div>
            </section>
            <section class='table-card' aria-label='Overall doctor summary'><table class='overall-table'><thead><tr><th>Doctor Name</th><th>Total References</th><th>Total Amount Generated</th><th>Percentage</th><th>Consultation Fee</th></tr></thead><tbody>${doctorRows || '<tr><td colspan="5">No doctor references found.</td></tr>'}</tbody></table></section>
            <footer class='report-footer'><span>Generated on ${safeGeneratedAt}</span><span>Confidential clinic report</span></footer>
          </main>
          <script>window.addEventListener('load', () => { requestAnimationFrame(() => requestAnimationFrame(() => { window.focus(); window.print(); })); }); window.addEventListener('afterprint', () => setTimeout(() => window.close(), 200));<\/script>
        </body>
      </html>`;
  }

  function getDoctorReferencePeriodKey(fromDate, toDate) {
    const start = normalizeDate(fromDate);
    const end = normalizeDate(toDate);
    if (!start || !end || start > end) return "";

    const monthRange = getMonthDateRange(new Date(`${start}T00:00:00`));
    if (monthRange.fromDate === start && monthRange.toDate === end) {
      return start.slice(0, 7);
    }
    return `${start}__${end}`;
  }

  function renameDoctorReferenceData(records, config, oldName, newName) {
    const sourceName = String(oldName ?? "").trim();
    const targetName = String(newName ?? "").trim();
    const sourceKey = normalizeDoctorKey(sourceName);
    const targetKey = normalizeDoctorKey(targetName);

    if (!sourceKey || !targetKey || !targetName) {
      throw new Error("Both the existing and new doctor names are required.");
    }

    const renamedRecords = (Array.isArray(records) ? records : []).map((record) => {
      if (!record || typeof record !== "object") return record;
      return normalizeDoctorKey(record.refDoctor) === sourceKey
        ? { ...record, refDoctor: targetName }
        : { ...record };
    });

    const currentConfig = config && typeof config === "object" ? config : {};
    const seenDoctors = new Set();
    const referringDoctors = [];
    (Array.isArray(currentConfig.referringDoctors) ? currentConfig.referringDoctors : [])
      .map((name) => String(name ?? "").trim())
      .filter(Boolean)
      .forEach((name) => {
        const finalName = normalizeDoctorKey(name) === sourceKey ? targetName : name;
        const key = normalizeDoctorKey(finalName);
        if (key && !seenDoctors.has(key)) {
          seenDoctors.add(key);
          referringDoctors.push(finalName);
        }
      });

    if (!seenDoctors.has(targetKey)) {
      seenDoctors.add(targetKey);
      referringDoctors.push(targetName);
    }

    function renamePercentageMap(value, useNormalizedKeys) {
      const sourceMap = useNormalizedKeys ? (value || {}) : normalizeDoctorReferencePercentages(value);
      const renamed = {};
      let targetPercentage;

      Object.entries(sourceMap).forEach(([name, percentage]) => {
        const key = useNormalizedKeys ? normalizeDoctorKey(name) : normalizeDoctorKey(name);
        if (key === sourceKey || key === targetKey) {
          if (targetPercentage === undefined || key === sourceKey) targetPercentage = percentage;
          return;
        }
        renamed[useNormalizedKeys ? key : name] = percentage;
      });

      if (targetPercentage !== undefined) {
        renamed[useNormalizedKeys ? targetKey : targetName] = targetPercentage;
      }
      return renamed;
    }

    const history = normalizeDoctorReferencePercentageHistory(currentConfig.doctorReferencePercentageHistory);
    const doctorReferencePercentageHistory = Object.entries(history).reduce((result, [periodKey, percentages]) => {
      const renamed = renamePercentageMap(percentages, true);
      if (Object.keys(renamed).length > 0) result[periodKey] = renamed;
      return result;
    }, {});

    return {
      records: renamedRecords,
      config: {
        ...currentConfig,
        referringDoctors,
        doctorReferencePercentages: renamePercentageMap(currentConfig.doctorReferencePercentages, false),
        doctorReferencePercentageHistory,
      },
    };
  }

  function getDoctorPercentage(percentages, doctorName, periodPercentages = {}) {
    const key = normalizeDoctorKey(doctorName);
    if (Object.prototype.hasOwnProperty.call(periodPercentages, key)) {
      return periodPercentages[key];
    }
    const match = Object.entries(percentages).find(([name]) => normalizeDoctorKey(name) === key);
    return match ? match[1] : 0;
  }

  function calculateDoctorPayable(totalAmount, percentage) {
    const total = Number(totalAmount);
    const rate = Number(percentage);
    if (!Number.isFinite(total) || total < 0 || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return 0;
    }
    return roundMoney(total * rate / 100);
  }

  function filterDoctorReferenceReport(report, searchTerm) {
    const rows = Array.isArray(report) ? report : [];
    const query = String(searchTerm ?? "").trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((item) => String(item?.doctorName ?? "").toLowerCase().includes(query));
  }

  function aggregateDoctorReferences(records, fromDate, toDate, percentages, percentageHistory) {
    const start = normalizeDate(fromDate);
    const end = normalizeDate(toDate);
    const normalizedPercentages = normalizeDoctorReferencePercentages(percentages);
    const normalizedHistory = normalizeDoctorReferencePercentageHistory(percentageHistory);
    const periodKey = getDoctorReferencePeriodKey(start, end);
    const periodPercentages = normalizedHistory[periodKey] || {};
    const grouped = new Map();

    (Array.isArray(records) ? records : []).forEach((record) => {
      const doctorName = String(record?.refDoctor ?? "").trim();
      if (!doctorName) return;

      const date = normalizeDate(record?.date);
      if (start && (!date || date < start)) return;
      if (end && (!date || date > end)) return;

      const key = normalizeDoctorKey(doctorName);
      const current = grouped.get(key) || {
        doctorName,
        referenceCount: 0,
        totalAmount: 0,
      };
      const amount = Number(record?.totalFees);

      current.referenceCount += 1;
      current.totalAmount += Number.isFinite(amount) && amount >= 0 ? amount : 0;
      grouped.set(key, current);
    });

    return Array.from(grouped.values())
      .sort((left, right) => left.doctorName.localeCompare(right.doctorName))
      .map((item) => {
        const totalAmount = roundMoney(item.totalAmount);
        const percentage = getDoctorPercentage(normalizedPercentages, item.doctorName, periodPercentages);
        return {
          doctorName: item.doctorName,
          referenceCount: item.referenceCount,
          totalAmount,
          percentage,
          payableAmount: calculateDoctorPayable(totalAmount, percentage),
        };
      });
  }

  function aggregateDoctorConsultationFees(records, fromDate, toDate, percentages, percentageHistory) {
    return roundMoney(aggregateDoctorReferences(
      records,
      fromDate,
      toDate,
      percentages,
      percentageHistory
    ).reduce((total, item) => total + item.payableAmount, 0));
  }

  return {
    aggregateDoctorReferences,
    aggregateDoctorConsultationFees,
    calculateDoctorPayable,
    buildDoctorReferencePrintHtml,
    buildOverallDoctorReferencePrintHtml,
    filterDoctorReferenceReport,
    getDoctorReferencePeriodKey,
    getMonthDateRange,
    aggregateMonthlyCollection,
    getCollectionMonthRange,
    getCollectionMonthOptions,
    normalizeDoctorReferencePercentageHistory,
    normalizeDoctorReferencePercentages,
    renameDoctorReferenceData,
  };
});
