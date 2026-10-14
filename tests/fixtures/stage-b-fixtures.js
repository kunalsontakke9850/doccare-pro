const baseRecord = {
  Date: "2026-01-15",
  Age: 32,
  "Patient Name": "Test Patient Alpha",
  "Scan Type": "CBCT",
  "2D Scan": "",
  "Purpose of CBCT": "Implant planning",
  "Scan Fees": 2500,
  "Radiologist Name": "Test Radiologist",
  "Radiologist Fees": 500,
  "Referring Doctor": "Test Doctor",
  "Consultation Fees": 1000,
  "Total Fees": 4000,
  Phone: "9000000001",
  "Payment Method": "Cash",
  "Cash Amount": 4000,
  "Online Amount": 0,
  "Edit History": "",
  recordId: "rec_test_alpha",
  version: 2,
  updatedAt: "2026-01-15T10:00:00.000Z"
};

const completeRecord = { ...baseRecord };

const legacyRecord = {
  Date: "2025-12-01",
  Age: "",
  "Patient Name": "Test Patient Beta",
  "Scan Type": "2D",
  "2D Scan": "OPG",
  "Purpose of CBCT": "",
  "Scan Fees": 800,
  "Radiologist Name": "",
  "Radiologist Fees": "",
  "Referring Doctor": "Test Doctor",
  "Consultation Fees": "",
  "Total Fees": "",
  Phone: "",
  "Payment Method": "",
  "Cash Amount": "",
  "Online Amount": "",
  "Edit History": ""
};

const cashRecord = { ...completeRecord, recordId: "rec_test_cash", "Payment Method": "Cash", "Cash Amount": 4000, "Online Amount": 0 };
const onlineRecord = { ...completeRecord, recordId: "rec_test_online", "Payment Method": "Online", "Cash Amount": 0, "Online Amount": 4000 };
const splitRecord = { ...completeRecord, recordId: "rec_test_split", "Payment Method": "Split", "Cash Amount": 1500, "Online Amount": 2500 };

const expense = {
  Date: "2026-01-16",
  Type: "Operating",
  Category: "Supplies",
  Description: "Synthetic test expense",
  Amount: 1250,
  "Payment Method": "Cash",
  id: "exp_test_1",
  operationId: "op_test_expense_fixture",
  createdAt: "2026-01-16T10:00:00.000Z"
};

const validConfig = {
  scanTypes: ["CBCT", "2D"],
  twoDScanTypes: ["OPG"],
  purposes: ["Implant planning"],
  referringDoctors: ["Test Doctor"],
  radiologists: [{ name: "Test Radiologist", defaultFee: 500, scanFees: {} }],
  configVersion: "test-config-v1"
};

const staleVersionRecord = { ...completeRecord, recordId: "rec_test_stale", version: 1 };
const malformedRecord = { ...completeRecord, "Patient Name": "", "Scan Fees": "not-a-number" };

module.exports = {
  completeRecord,
  legacyRecord,
  cashRecord,
  onlineRecord,
  splitRecord,
  expense,
  validConfig,
  staleVersionRecord,
  malformedRecord
};
