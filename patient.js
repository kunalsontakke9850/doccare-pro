// ============================================================================
// Patient Scan Entry System - Google Sheets Cloud Sync + Admin Configuration
// ============================================================================

const appDialog = window.AppDialog.createAppDialogController({
 document,
 dialog: document.getElementById("appPromptDialog"),
 title: document.getElementById("appPromptTitle"),
 message: document.getElementById("appPromptMessage"),
 input: document.getElementById("appPromptInput"),
 confirmButton: document.getElementById("appPromptConfirm"),
 cancelButton: document.getElementById("appPromptCancel")
});

const CLOUD_REMEMBER_KEY = "patient_cloud_remember_v1";
const CONFIG_VERSION_KEY = "patient_cloud_config_version_v1";
// Apps Script Web Apps can spend 15 - 20 seconds completing the redirect before
// returning a large Records payload. Keep the abort bounded, but above that
// observed production latency so a slow response is not misreported as offline.
const CLOUD_REQUEST_TIMEOUT_MS = 30000;

const RECORD_HEADERS = [
 "Date",
 "Age",
 "Patient Name",
 "Scan Type",
 "2D Scan",
 "Purpose of CBCT",
 "Scan Fees",
 "Radiologist Name",
 "Radiologist Fees",
 "Referring Doctor",
 "Consultation Fees",
 "Total Fees",
 "Phone",
 "Payment Method",
 "Cash Amount",
 "Online Amount",
 "Edit History"
];

const EXPENSE_HEADERS = [
 "Date",
 "Type",
 "Category",
 "Description",
 "Amount",
 "Payment Method",
 "ID",
 "Created At"
];

const RECORD_RANGE = "Records!A:Q"; // 17 columns including payment method and split amounts
const EXPENSES_RANGE = "Expenses!A:H";
const CONFIG_RANGE = "Config!A:B";

// ============================================================================
// FIXED ADMIN PASSWORD - SAME FOR ALL PCs (DO NOT CHANGE)
// ============================================================================

const DEFAULT_CONFIG = {
 scanTypes: ["CBCT", "2D"],
 twoDScanTypes: ["OPG"],
 purposes: ["Sample assessment"],
 radiologists: [{ name: "Demo Radiologist", fee: 0, pricing: {} }]
};
const DEFAULT_REFERRING_DOCTORS = window.APP_CONFIG?.CLINIC_REFERRING_DOCTORS || ["Demo Doctor One", "Demo Doctor Two"];
window.DEFAULT_REFERRING_DOCTORS = DEFAULT_REFERRING_DOCTORS;

let appConfig = normalizeConfig(window.APP_CONFIG?.CLINIC_CONFIG || DEFAULT_CONFIG);
window.appConfig = appConfig;
let cloudAdminPasswordHash = ""; // From Google Sheets (legacy field, kept for backward compatibility)
let cloudConfigVersion = "";
let isAdminMode = false;
let doctorReferenceAccessUnlocked = window.APP_CONFIG?.DEMO_MODE === true;
let adminLoginTarget = "global";
let adminReturnPageId = "scanPage";

let entriesCache = [];
window.entriesCache = entriesCache;

let isSubmitting = false; // prevents double-submits while a record is being saved
const recordSubmissionGate = window.RecordsPaging?.createSubmissionGate?.();
let recordsRefreshPromise = null;
let reportRecordsLoaded = false;
let configRefreshPromise = null;
let fullRefreshPromise = null;
let cloudOutboxSyncPromise = null;
let cloudCapabilitiesPromise = null;
let syncRecovery = null;

// Local-storage keys for the offline mirror - populated from the cloud and used
// as a safety net so the app still works if the network is down.
const LS_RECORDS_KEY = "doccare_records_mirror_v1";
const LS_RECORD_PAGES_KEY = "doccare_record_pages_v1";
const LS_EXPENSES_KEY = "doccare_expenses_mirror_v1";
const LS_CONFIG_KEY = "doccare_config_mirror_v1";
const LS_OUTBOX_KEY = "doccare_cloud_outbox_v1";
const LS_SYNC_HEALTH_KEY = "doccare_sync_health_v1";

// ============================================================================
// SHARED UTILITIES - used by scan, expenses, doctor and bill modules
// ============================================================================

// Normalize any date input to YYYY-MM-DD for comparison/storage
function normalizeDate(d) {
 if (!d) return "";
 if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
 const parsed = new Date(d);
 if (isNaN(parsed)) return d;
 const y = parsed.getFullYear();
 const m = String(parsed.getMonth() + 1).padStart(2, "0");
 const day = String(parsed.getDate()).padStart(2, "0");
 return `${y}-${m}-${day}`;
}

// Human-readable date - "22 May 2026"
function formatDateDisplay(d) {
 const iso = normalizeDate(d);
 if (!iso) return d || "";
 const obj = new Date(iso + "T00:00:00");
 if (isNaN(obj.getTime())) return d;
 return obj.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// Format a number as Indian Rupee. Integer amounts show no decimals; fractional amounts show 2 decimals.
function formatMoney(value, forceDecimals = false) {
 const n = Number(value || 0);
 if (!Number.isFinite(n)) return "0";
 const opts = (forceDecimals || n % 1 !== 0)
 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
 : { maximumFractionDigits: 0 };
 return "" + n.toLocaleString("en-IN", opts);
}

// Parse a number safely. Returns fallback if value is NaN/Infinity/negative-and-not-allowed.
function toNumber(value, { min = 0, fallback = 0 } = {}) {
 const n = Number(value);
 if (!Number.isFinite(n)) return fallback;
 if (n < min) return fallback;
 return n;
}

// Sanitize a phone number - keep digits only, validate length 10
function sanitizePhone(value) {
 const digits = String(value || "").replace(/\D/g, "");
 return digits;
}

// Expose for expenses.js and any other module loaded after patient.js
window.normalizeDate = normalizeDate;
window.formatDateDisplay = formatDateDisplay;
window.formatMoney = formatMoney;

const scanForm = document.getElementById("scanForm");
const dateInput = document.getElementById("entryDate");
const patientNameInput = document.getElementById("patientName");
const patientAgeInput = document.getElementById("patientAge");
const patientPhoneInput = document.getElementById("patientPhone");
const scanFeesInput = document.getElementById("scanFees");
const radiologistNameSelect = document.getElementById("radiologistName");
const radiologistFeesInput = document.getElementById("radiologistFees");
const paymentTypeInputs = document.querySelectorAll('input[name="paymentType"]');
const splitPaymentFields = document.getElementById("splitPaymentFields");
const cashAmountInput = document.getElementById("cashAmount");
const onlineAmountInput = document.getElementById("onlineAmount");

const totalFeesInput = document.getElementById("totalFees");
const refDoctorInput = document.getElementById("refDoctor");
const statusMsg = document.getElementById("statusMsg");
const recordsBody = document.getElementById("recordsBody");
const clearBtn = document.getElementById("clearBtn");
const refreshBtn = document.getElementById("refreshBtn");

const scanTypeOptionsContainer = document.getElementById("scanTypeOptions");
const twoDScanOptionsContainer = document.getElementById("twoDScanOptions");
const purposeOptionsContainer = document.getElementById("purposeOptions");
const adminAccessBtn = document.getElementById("adminAccessBtn");
const demoNotice = document.getElementById("demoNotice");
const clinicBanner = document.querySelector(".hero-image");
if (clinicBanner && window.APP_CONFIG?.CLINIC_BANNER_URL) {
 clinicBanner.style.backgroundImage = `url("${window.APP_CONFIG.CLINIC_BANNER_URL}")`;
 clinicBanner.classList.add("has-clinic-banner");
}
const adminQuickLogoutBtn = document.getElementById("adminQuickLogoutBtn");
const doctorReferenceAdminBtn = document.getElementById("doctorReferenceAdminBtn");
const doctorReferenceOverallPrintBtn = document.getElementById("doctorReferenceOverallPrintBtn");
const adminStatus = document.getElementById("adminStatus");
const formSection = document.getElementById("formSection");
const scanPage = document.getElementById("scanPage");
const adminPanel = document.getElementById("adminPanel");
const adminLogoutBtn = document.getElementById("adminLogoutBtn");
const radiologistRows = document.getElementById("radiologistRows");
const radiologistCount = document.getElementById("radiologistCount");
const addRadiologistBtn = document.getElementById("addRadiologistBtn");
const adminScanTypeRows = document.getElementById("adminScanTypeRows");
const adminTwoDScanTypeRows = document.getElementById("adminTwoDScanTypeRows");
const adminPurposeRows = document.getElementById("adminPurposeRows");
const adminScanTypeCount = document.getElementById("adminScanTypeCount");
const adminTwoDScanTypeCount = document.getElementById("adminTwoDScanTypeCount");
const adminPurposeCount = document.getElementById("adminPurposeCount");
const adminSaveStatus = document.getElementById("adminSaveStatus");
const saveAdminConfigBtn = document.getElementById("saveAdminConfigBtn");
const adminPasswordChangeForm = document.getElementById("adminPasswordChangeForm");
const adminCurrentPassword = document.getElementById("adminCurrentPassword");
const adminNewPassword = document.getElementById("adminNewPassword");
const adminConfirmPassword = document.getElementById("adminConfirmPassword");
const adminPasswordStatus = document.getElementById("adminPasswordStatus");
const changeAdminPasswordBtn = document.getElementById("changeAdminPasswordBtn");

const adminModal = document.getElementById("adminModal");
const adminModalHint = document.getElementById("adminModalHint");
const adminModalMsg = document.getElementById("adminModalMsg");
const adminLoginView = document.getElementById("adminLoginView");
const adminPasswordInput = document.getElementById("adminPasswordInput");
const adminLoginSubmitBtn = document.getElementById("adminLoginSubmitBtn");
const adminModalCloseBtn = document.getElementById("adminModalCloseBtn");

// Stub kept for legacy callers - there is no auth prompt in the new architecture.
async function handleAuthPromptClick() { /* no-op */ }

function normalizeScanTypeName(value) {
 const trimmed = String(value || "").trim();
 // Normalize legacy "LT"and "TMJ LT"to the new label
 if (trimmed === "LT" || trimmed === "TMJ LT") return "TMJ LT.";
 return trimmed;
}

function getPresetPricingByDoctorName(name) {
 const normalizedName = String(name || "").trim().toLowerCase();
 const presets = window.APP_CONFIG?.CLINIC_PRESET_PRICING || {};
 return presets[normalizedName] || null;
}

function normalizeRadiologistConfig(doctor, scanTypes) {
 const name = String(doctor?.name || "").trim();
 const fee = Number(doctor?.fee || 0);
 const sourcePricing = doctor?.pricing && typeof doctor.pricing === "object" ? doctor.pricing : {};
 const presetPricing = getPresetPricingByDoctorName(name) || {};
 const usePreset = Object.keys(sourcePricing).length === 0;
 const normalizedPricing = {};

 scanTypes.forEach((scanType) => {
 const normalizedType = normalizeScanTypeName(scanType);
 const direct = Number((usePreset ? presetPricing : sourcePricing)[normalizedType]);
 const legacyLt = Number((usePreset ? presetPricing : sourcePricing)["TMJ LT."] || (usePreset ? presetPricing : sourcePricing)["TMJ LT"] || (usePreset ? presetPricing : sourcePricing)["LT"]);

 if (Number.isFinite(direct) && direct >= 0) {
 normalizedPricing[normalizedType] = direct;
 return;
 }

 if (normalizedType === "LT" && Number.isFinite(legacyLt) && legacyLt >= 0) {
 normalizedPricing[normalizedType] = legacyLt;
 return;
 }

 normalizedPricing[normalizedType] = Number.isFinite(fee) && fee >= 0 ? fee : 0;
 });

 return {
 name,
 fee: Number.isFinite(fee) && fee >= 0 ? fee : 0,
 pricing: normalizedPricing
 };
}

function normalizeStringList(items, fallbackList, mapItem) {
 if (!Array.isArray(items) || items.length === 0) {
 return fallbackList;
 }

 const normalized = items
 .map((item) => {
 const value = typeof mapItem === "function" ? mapItem(item) : item;
 return String(value || "").trim();
 })
 .filter(Boolean);

 return normalized.length > 0 ? normalized : fallbackList;
}

function normalizeConfig(parsed) {
 const normalizedScanTypes = normalizeStringList(
 parsed?.scanTypes,
 DEFAULT_CONFIG.scanTypes,
 normalizeScanTypeName
 );

 const normalizedTwoDScanTypes = normalizeStringList(parsed?.twoDScanTypes, DEFAULT_CONFIG.twoDScanTypes);
 const normalizedPurposes = normalizeStringList(parsed?.purposes, DEFAULT_CONFIG.purposes);
 const normalizedReferringDoctors = normalizeStringList(parsed?.referringDoctors, DEFAULT_REFERRING_DOCTORS);
 const doctorReferencePercentages = window.DoctorReference
 ? window.DoctorReference.normalizeDoctorReferencePercentages(parsed?.doctorReferencePercentages)
 : {};
 const doctorReferencePercentageHistory = window.DoctorReference
 ? window.DoctorReference.normalizeDoctorReferencePercentageHistory(parsed?.doctorReferencePercentageHistory)
 : {};
 // The restored direct Apps Script workflow keeps the legacy PBKDF2 verifier
 // in Config so the existing client-side admin workflow remains compatible.
 const adminCredential = window.AdminAuth?.normalizePasswordCredential(parsed?.adminCredential) || null;

 // For radiologists, if they come from cloud/admin, normalize them
 // Otherwise use DEFAULT_CONFIG directly
 let radiologists = DEFAULT_CONFIG.radiologists;

 if (Array.isArray(parsed?.radiologists) && parsed.radiologists.length > 0) {
 radiologists = parsed.radiologists
 .map((doctor) => normalizeRadiologistConfig(doctor, normalizedScanTypes))
 .filter((doctor) => doctor && doctor.name);

 // If normalization resulted in empty array, use default
 if (radiologists.length === 0) {
 radiologists = DEFAULT_CONFIG.radiologists;
 }
 }

 return {
 scanTypes: normalizedScanTypes,
 twoDScanTypes: normalizedTwoDScanTypes,
 purposes: normalizedPurposes,
 referringDoctors: normalizedReferringDoctors,
 radiologists: radiologists,
 doctorReferencePercentages,
 doctorReferencePercentageHistory,
 adminCredential
 };
}

async function hashText(text) {
 const data = new TextEncoder().encode(text);
 const digest = await crypto.subtle.digest("SHA-256", data);
 const hashArray = Array.from(new Uint8Array(digest));
 return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getTodayDateValue() {
 // Use local timezone date for <input type="date"> values.
 const now = new Date();
 const timezoneOffsetMs = now.getTimezoneOffset() * 60 * 1000;
 return new Date(now.getTime() - timezoneOffsetMs).toISOString().split("T")[0];
}

function setDefaultDate(force = false) {
 if (!dateInput) {
 return;
 }

 if (force || !dateInput.value) {
 const todayValue = getTodayDateValue();
 // Direct assignment is the most reliable for type="date".
 dateInput.value = todayValue;
 // Keep reset behavior stable if browser uses default value on reset.
 dateInput.defaultValue = todayValue;
 }
}

function escapeHtml(value) {
 return String(value)
 .replace(/&/g, "&amp;")
 .replace(/</g, "&lt;")
 .replace(/>/g, "&gt;")
 .replace(/\"/g, "&quot;")
 .replace(/'/g, "&#039;");
}

function setStatus(message, isError) {
 statusMsg.textContent = message;
 statusMsg.style.color = isError ? "#b91c1c" : "#065f46";
}

function renderScanTypeOptions() {
 if (!scanTypeOptionsContainer) {
 console.error("scanTypeOptionsContainer is null or undefined!");
 return;
 }

 const scanTypes = (appConfig && appConfig.scanTypes && appConfig.scanTypes.length > 0)
 ? appConfig.scanTypes
 : DEFAULT_CONFIG.scanTypes;


 try {
 const html = scanTypes
 .map(
 (item) =>
 `<label class="scan-option"><input type="checkbox"name="scanTypeOption"value="${escapeHtml(item)}" /> ${escapeHtml(item)}</label>`
 )
 .join("");

 scanTypeOptionsContainer.innerHTML = html;

 const bothScanOption = document.querySelector('input[name="scanTypeOption"][value="Both"]');
 if (bothScanOption) {
 bothScanOption.addEventListener("change", syncBothWithMouthOptions);
 }

 document.querySelectorAll('input[name="scanTypeOption"]').forEach((checkbox) => {
 checkbox.addEventListener("change", () => {
 applyRadiologistFees();
 });
 });
 } catch (error) {
 console.error("Error rendering scan types:", error);
 }
}

function renderTwoDScanOptions() {
 if (!twoDScanOptionsContainer) {
 console.error("twoDScanOptionsContainer is null or undefined!");
 return;
 }

 const twoDScanTypes = (appConfig && appConfig.twoDScanTypes && appConfig.twoDScanTypes.length > 0)
 ? appConfig.twoDScanTypes
 : DEFAULT_CONFIG.twoDScanTypes;


 try {
 const html = twoDScanTypes
 .map(
 (item) =>
 `<label class="scan-option"><input type="checkbox"name="twoDScanOption"value="${escapeHtml(item)}" /> ${escapeHtml(item)}</label>`
 )
 .join("");

 twoDScanOptionsContainer.innerHTML = html;
 } catch (error) {
 console.error("Error rendering 2D scan types:", error);
 }
}

function renderPurposeOptions() {
 if (!purposeOptionsContainer) {
 console.error("purposeOptionsContainer is null or undefined!");
 return;
 }

 const purposes = (appConfig && appConfig.purposes && appConfig.purposes.length > 0)
 ? appConfig.purposes
 : DEFAULT_CONFIG.purposes;


 try {
 const html = purposes
 .map(
 (item) =>
 `<label class="scan-option"><input type="checkbox"name="purposeOption"value="${escapeHtml(item)}" /> ${escapeHtml(item)}</label>`
 )
 .join("");

 purposeOptionsContainer.innerHTML = html;
 } catch (error) {
 console.error("Error rendering purposes:", error);
 }
}

function renderRadiologistOptions() {
 if (!radiologistNameSelect) {
 return;
 }

 const selected = radiologistNameSelect.value;

 // Always use appConfig.radiologists, which is guaranteed to have at least the defaults
 const radiologists = (appConfig && appConfig.radiologists) ? appConfig.radiologists : DEFAULT_CONFIG.radiologists;

 // Build the dropdown options
 let optionsHtml = '<option value=""selected disabled>Select radiologist</option>' +
 '<option value="Not Applicable">Not Applicable</option>';

 if (radiologists && radiologists.length > 0) {
 optionsHtml += radiologists
 .map((doctor) => {
 if (doctor && doctor.name) {
 return `<option value="${escapeHtml(doctor.name)}">${escapeHtml(doctor.name)}</option>`;
 }
 return '';
 })
 .join("");
 }

 radiologistNameSelect.innerHTML = optionsHtml;

 if (selected && (selected === "Not Applicable" || (radiologists && radiologists.some((doc) => doc && doc.name === selected)))) {
 radiologistNameSelect.value = selected;
 }
}

function renderReferringDoctorOptions() {
 populateRefDoctorSelect();
}

// Build the complete, stable referring doctor list.
// Always starts from DEFAULT_REFERRING_DOCTORS (100+ hardcoded),
// then adds any extra names found in actual patient records.
// Never relies on appConfig.referringDoctors (which is cloud-dependent and unreliable).
// Normalize a doctor name to a comparison key:
// extracts alphanumeric characters and removes leading "dr"to handle variations like "Dr. Name", "Dr Name", "DR.NAME", "Name"
function normalizeDoctorKey(name) {
 let clean = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
 if (clean.startsWith("dr")) {
 clean = clean.substring(2);
 }
 // Strip trailing honorifics: "Ravikiran Phalke Sir"same key as "Dr. Ravikiran Phalke"
 clean = clean.replace(/(sir|mam|madam)$/, "");
 return clean;
}

// Reject values that are clearly not doctor names: blanks, sentinels,
// pure numbers (fee columns land here when a sheet row is shifted), and
// strings without at least two letters.
function isValidDoctorName(name) {
 const clean = String(name || "").trim();
 if (!clean || clean === "Not Applicable" || clean === "Not Applicable") return false;
 if (/^\d+$/.test(clean) || /^\d[\d\s.,-]*$/.test(clean)) return false;
 return clean.replace(/[^a-zA-Z]/g, "").length >= 2;
}

function buildFullDoctorList() {
 const seen = new Set(); // normalized keys
 const result = [];

 function addDoctor(d) {
 const clean = String(d || "").trim();
 if (!isValidDoctorName(clean)) return;
 const key = normalizeDoctorKey(clean);
 if (!key) return;
 if (!seen.has(key)) {
 seen.add(key);
 result.push(clean);
 }
 }

 // 1. Admin config (highest priority)
 if (window.appConfig && Array.isArray(window.appConfig.referringDoctors)) {
 window.appConfig.referringDoctors.forEach(addDoctor);
 }

 // 2. Hardcoded defaults
 DEFAULT_REFERRING_DOCTORS.forEach(addDoctor);

 // Snapshot canonical list length - fuzzy dedup only runs against canonical names,
 // not against other records added in this same loop.
 const canonicalCount = result.length;

 // 3. Names from patient records - suppress spelling-mistake variants
 const records = (window.entriesCache && Array.isArray(window.entriesCache)) ? window.entriesCache : [];
 const recordDoctorNames = [
 ...(window.recordsReferenceMetadata?.referringDoctors || []).map(refDoctor => ({ refDoctor })),
 ...records
 ];

 recordDoctorNames.forEach(r => {
 const name = (r.refDoctor || "").trim();
 if (!isValidDoctorName(name)) return;
 const key = normalizeDoctorKey(name);
 if (!key || seen.has(key)) return;

 // Check if this normalized key is an unambiguous prefix of exactly ONE canonical key.
 // e.g. "esha"only "eshakaware" starts with it silently merge.
 const canonicalKeys = result.slice(0, canonicalCount).map(n => normalizeDoctorKey(n));
 const prefixMatches = canonicalKeys.filter(ck => ck.startsWith(key) || key.startsWith(ck));
 if (prefixMatches.length === 1) {
 seen.add(key);
 return; // silently merge into the one canonical name
 }

 // Fuzzy similarity check against canonical names only
 const tooSimilar = result.slice(0, canonicalCount).some(
 existing => computeSimilarityForDedup(name, existing) >= 0.82
 );

 seen.add(key);
 if (!tooSimilar) {
 const formatted = name === name.toUpperCase()
 ? name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
 : name;
 result.push(formatted);
 }
 // if tooSimilar silently skip; canonical name is already in the list
 });

 result.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
 return result;
}

// Kept for backward-compat with existing callers - the smart autocomplete
// reads buildFullDoctorList() live on every keystroke.
function populateRefDoctorSelect() { /* no-op - custom autocomplete handles this */ }

function resetRefDoctorOtherMode() {
 const input = document.getElementById("refDoctor");
 if (input) input.value = "";
}

// ============================================================================
// SMART FUZZY AUTOCOMPLETE FOR REFERRING DOCTOR
// Prevents "Dr.Esha" / "Dr Esha Kaware" / "Ravikiran Phalke Sir" duplicates.
// by showing the correct canonical name as the top suggestion.
// ============================================================================

/** Compute Levenshtein edit distance (character-level) between two strings. */
function levenshteinDistance(a, b) {
 const m = a.length, n = b.length;
 if (m === 0) return n;
 if (n === 0) return m;
 const prev = Array.from({ length: n + 1 }, (_, j) => j);
 const curr = new Array(n + 1).fill(0);
 for (let i = 1; i <= m; i++) {
 curr[0] = i;
 for (let j = 1; j <= n; j++) {
 curr[j] = a[i - 1] === b[j - 1]
 ? prev[j - 1]
 : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
 }
 prev.splice(0, prev.length, ...curr);
 }
 return curr[n];
}

/** Strip Dr./Sir/Mam/spaces for fuzzy comparison purposes. */
function _normSuggest(s) {
 return String(s || "")
 .toLowerCase()
 .replace(/\bdr\.?\s*/gi, "")
 .replace(/\b(sir|mam|madam)\b/gi, "")
 .replace(/[^a-z0-9 ]/g, "")
 .replace(/\s+/g, " ")
 .trim();
}

/**
 * Similarity score (0 - 1) used for deduplication.
 * Score >= 0.82 "same doctor, different spelling"suppress the duplicate.
 */
function computeSimilarityForDedup(a, b) {
 const na = _normSuggest(a);
 const nb = _normSuggest(b);
 if (!na || !nb) return 0;
 if (na === nb) return 1;
 if (nb.includes(na) || na.includes(nb)) {
 const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
 return ratio >= 0.55 ? 0.88 : 0.55;
 }
 const dist = levenshteinDistance(na, nb);
 const maxLen = Math.max(na.length, nb.length);
 return maxLen > 0 ? 1 - dist / maxLen : 0;
}

/**
 * Fuzzy-match a query against all doctor names.
 * Returns [{name, score}] sorted by score descending.
 * score >= 0.85 "Exact / Close match" (shown without badge)
 * score 0.45 - 0.84 "Similar spelling" (shown with orange badge)
 */
function getSimilarDoctors(query, doctors, maxResults = 18) {
 if (!query || !query.trim()) return [];
 const q = _normSuggest(query);
 const qRaw = query.toLowerCase().trim();

 const scored = doctors.map(name => {
 const n = _normSuggest(name);
 const nRaw = name.toLowerCase();
 let score = 0;

 if (nRaw.includes(qRaw)) { score = 1.00; }
 else if (n.startsWith(q)) { score = 0.95; }
 else if (n.includes(q)) { score = 0.90; }
 else if (q.includes(n) && n.length >= 4) { score = 0.85; }
 else {
 // Token matching: every word in query appears (even approximately) in name
 const qWords = q.split(" ").filter(w => w.length >= 2);
 if (qWords.length > 0) {
 const matchCount = qWords.filter(w =>
 n.split(" ").some(nw => nw.startsWith(w) || levenshteinDistance(w, nw) <= 1)
 ).length;
 if (matchCount === qWords.length) score = 0.88;
 else if (matchCount > 0) score = 0.50 + 0.20 * (matchCount / qWords.length);
 }
 // Levenshtein fallback on short strings
 if (score < 0.50 && q.length >= 3 && n.length >= 3) {
 const dist = levenshteinDistance(q, n);
 const maxLen = Math.max(q.length, n.length);
 score = Math.max(score, maxLen > 0 ? 1 - dist / maxLen : 0);
 }
 }
 return { name, score };
 }).filter(x => x.score >= 0.45);

 scored.sort((a, b) => b.score - a.score);
 return scored.slice(0, maxResults);
}

/** Highlight matching search text inside doctor name string for search feedback. */
function highlightMatch(text, query) {
 if (!query || !query.trim()) return escapeHtml(text);
 const q = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const regex = new RegExp(`(${q})`, 'gi');
 const escaped = escapeHtml(text);
 return escaped.replace(regex, '<mark>$1</mark>');
}

/** Initials for the list avatar: "Dr. Esha Kaware" "EK". */
function doctorInitials(name) {
 const words = String(name || "")
 .replace(/\bdr\.?\s*/gi, "")
 .replace(/\b(sir|mam|madam)\b/gi, "")
 .trim()
 .split(/\s+/)
 .filter(w => /[a-zA-Z]/.test(w));
 if (!words.length) return "?";
 const first = words[0][0] || "";
 const last = words.length > 1 ? (words[words.length - 1][0] || "") : "";
 return (first + last).toUpperCase();
}

/** Wire up the custom fuzzy-autocomplete widget on the refDoctor input. */
function initRefDoctorAutocomplete() {
 const input = document.getElementById("refDoctor");
 const dropdown = document.getElementById("refDoctorDropdown");
 const arrowBtn = document.getElementById("refDoctorArrow");
 const clearBtn = document.getElementById("refDoctorClear");
 if (!input || !dropdown) return;

 if (input._refDocAcBound) return;
 input._refDocAcBound = true;

 let activeIdx = -1;
 let showingAll = false;

 function updateClearBtn() {
 if (clearBtn) {
 clearBtn.style.display = input.value.trim() ? "flex" : "none";
 }
 }

 function closeDropdown() {
 dropdown.style.display = "none";
 input.setAttribute("aria-expanded", "false");
 activeIdx = -1;
 showingAll = false;
 }

 function renderDropdown(forceAll) {
 const doctors = buildFullDoctorList();
 let items;
 const query = input.value.trim();
 if (forceAll || !query) {
 // Show all doctors alphabetically when arrow clicked or input is empty
 items = doctors.map(name => ({ name, score: 1 }));
 } else {
 items = getSimilarDoctors(query, doctors);
 }
 updateClearBtn();

 const optionsHtml = items.map((item, i) => {
 const isClose = item.score >= 0.85;
 const highlightedName = highlightMatch(item.name, forceAll ? "" : query);
 return `<div class="ref-ac-option${isClose ? "" : "ac-fuzzy"}"data-value="${escapeHtml(item.name)}"data-idx="${i}"role="option"aria-selected="false"id="refDocOpt-${i}">
 <span class="ref-ac-name">${highlightedName}</span>
 ${isClose ? "" : '<span class="ac-badge">Similar spelling</span>'}
 </div>`;
 }).join("");

 const headerLabel = forceAll || !query
 ? `All referring doctors`
 : `${items.length} match${items.length === 1 ? "" : "es"}`;
 const headerHtml = `<div class="ref-ac-header">
 <span class="ref-ac-header-label">${escapeHtml(headerLabel)}</span>
 <span class="ref-ac-count">${items.length}</span>
 </div>`;

 const emptyHtml = `<div class="ref-ac-empty">
 <span class="ref-ac-empty-title">No matching doctor</span>
 <span class="ref-ac-empty-hint">Press Enter to keep "${escapeHtml(query)}"as a new name.</span>
 </div>`;

 const scrollListHtml = `<div class="ref-ac-scroll-list"role="presentation">${optionsHtml || emptyHtml}</div>`;

 const footerHtml = `<div class="ref-ac-footer">
 <button type="button"class="ref-ac-manage-option"id="refDocManageOpt">
 <span>Edit</span>
 </button>
 </div>`;

 dropdown.innerHTML = headerHtml + scrollListHtml + footerHtml;

 dropdown.style.display = "block";
 input.setAttribute("aria-expanded", "true");
 activeIdx = -1;

 // Click to select
 dropdown.querySelectorAll(".ref-ac-option").forEach(opt => {
 opt.addEventListener("mousedown", e => {
 e.preventDefault();
 input.value = opt.dataset.value;
 updateClearBtn();
 closeDropdown();
 input.dispatchEvent(new Event("change", { bubbles: true }));
 });
 });

 const manageBtn = dropdown.querySelector("#refDocManageOpt");
 if (manageBtn) {
 manageBtn.addEventListener("mousedown", e => {
 e.preventDefault();
 closeDropdown();
 openDoctorManageModal();
 });
 }
 }

 function moveSelection(delta) {
 const opts = dropdown.querySelectorAll(".ref-ac-option");
 if (!opts.length) return;
 if (activeIdx >= 0 && opts[activeIdx]) {
 opts[activeIdx].classList.remove("ac-active");
 opts[activeIdx].setAttribute("aria-selected", "false");
 }
 activeIdx = Math.min(Math.max(activeIdx + delta, 0), opts.length - 1);
 const active = opts[activeIdx];
 if (active) {
 active.classList.add("ac-active");
 active.setAttribute("aria-selected", "true");
 active.scrollIntoView({ block: "nearest" });
 input.setAttribute("aria-activedescendant", active.id);
 }
 }

 input.addEventListener("input", () => {
 updateClearBtn();
 if (!input.value.trim()) { renderDropdown(true); return; }
 renderDropdown(false);
 });

 input.addEventListener("focus", () => {
 updateClearBtn();
 renderDropdown(false);
 });

 if (clearBtn) {
 clearBtn.addEventListener("mousedown", e => {
 e.preventDefault();
 input.value = "";
 updateClearBtn();
 renderDropdown(true);
 input.focus();
 input.dispatchEvent(new Event("change", { bubbles: true }));
 });
 }

 if (arrowBtn) {
 arrowBtn.addEventListener("click", (e) => {
 e.stopPropagation();
 if (dropdown.style.display === "block" && showingAll) {
 closeDropdown();
 } else {
 input.focus();
 showingAll = true;
 renderDropdown(true);
 }
 });
 }

 input.addEventListener("keydown", e => {
 if (dropdown.style.display === "none") {
 if (e.key === "ArrowDown") { renderDropdown(true); }
 return;
 }
 if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(+1); }
 else if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
 else if (e.key === "Home") { e.preventDefault(); moveSelection(-activeIdx); }
 else if (e.key === "End") { e.preventDefault(); moveSelection(1000); }
 else if (e.key === "Enter" && activeIdx >= 0) {
 e.preventDefault();
 const opt = dropdown.querySelectorAll(".ref-ac-option")[activeIdx];
 if (opt) {
 input.value = opt.dataset.value;
 updateClearBtn();
 closeDropdown();
 input.dispatchEvent(new Event("change", { bubbles: true }));
 }
 } else if (e.key === "Escape" || e.key === "Tab") { closeDropdown(); }
 });

 // Close when clicking outside
 document.addEventListener("click", e => {
 const wrap = document.getElementById("refDoctorAutocompleteWrap");
 if (wrap && !wrap.contains(e.target)) closeDropdown();
 });
}


function getSelectedScanTypes() {
 return Array.from(document.querySelectorAll('input[name="scanTypeOption"]'))
 .filter((option) => option.checked)
 .map((option) => option.value);
}

function getSelectedTwoDScanTypes() {
 return Array.from(document.querySelectorAll('input[name="twoDScanOption"]'))
 .filter((option) => option.checked)
 .map((option) => option.value);
}

function getSelectedPurposes() {
 return Array.from(document.querySelectorAll('input[name="purposeOption"]'))
 .filter((option) => option.checked)
 .map((option) => option.value);
}

function getSelectedPaymentType() {
 return document.querySelector('input[name="paymentType"]:checked')?.value || "Cash";
}

function syncPaymentMethodFields() {
 const isSplitPayment = getSelectedPaymentType() === "Split Payment";
 if (splitPaymentFields) splitPaymentFields.hidden = !isSplitPayment;
 if (cashAmountInput) cashAmountInput.required = isSplitPayment;
 if (onlineAmountInput) onlineAmountInput.required = isSplitPayment;
}

function normalizeStoredPayment(entry) {
 const result = window.PaymentMethods.normalizePaymentBreakdown({
 totalFees: entry.totalFees,
 paymentType: entry.paymentMethod || "Cash",
 cashAmount: entry.cashAmount,
 onlineAmount: entry.onlineAmount
 });

 return result.ok
 ? result
 : { paymentMethod: "Cash", cashAmount: Number(entry.totalFees || 0), onlineAmount: 0 };
}

function formatPaymentSummary(entry) {
 const payment = normalizeStoredPayment(entry);
 if (payment.paymentMethod !== "Split Payment") return payment.paymentMethod;
 return `Split (Cash ${payment.cashAmount.toFixed(2)} + Online ${payment.onlineAmount.toFixed(2)})`;
}

function syncBothWithMouthOptions() {
 const bothScanOption = document.querySelector('input[name="scanTypeOption"][value="Both"]');
 const openMouthOption = document.querySelector('input[name="scanTypeOption"][value="Open Mouth"]');
 const closedMouthOption = document.querySelector('input[name="scanTypeOption"][value="Closed Mouth"]');

 if (!bothScanOption || !openMouthOption || !closedMouthOption) {
 return;
 }

 openMouthOption.checked = bothScanOption.checked;
 closedMouthOption.checked = bothScanOption.checked;
 applyRadiologistFees();
}

function applyRadiologistFees() {
 const selectedDoctor = radiologistNameSelect.value;

 if (selectedDoctor === "Not Applicable") {
 radiologistFeesInput.value = "0";
 calculateTotalFees();
 return;
 }

 const found = appConfig.radiologists.find((doc) => doc.name === selectedDoctor);

 if (!found) {
 radiologistFeesInput.value = "";
 calculateTotalFees();
 return;
 }

 const selectedScanTypes = getSelectedScanTypes();
 const pricing = found.pricing && typeof found.pricing === "object" ? found.pricing : {};
 const fallbackFee = Number(found.fee || 0);

 const totalRadiologistFees = selectedScanTypes.reduce((sum, scanType) => {
 const normalizedType = normalizeScanTypeName(scanType);
 const configuredFee = Number(pricing[normalizedType]);
 if (Number.isFinite(configuredFee) && configuredFee >= 0) {
 return sum + configuredFee;
 }
 return sum + (Number.isFinite(fallbackFee) && fallbackFee >= 0 ? fallbackFee : 0);
 }, 0);

 radiologistFeesInput.value = totalRadiologistFees.toFixed(2);
 calculateTotalFees();
}

function calculateTotalFees() {
 const scanFees = Math.trunc(Number(scanFeesInput.value || 0));
 const consultationFeesInput = document.getElementById("consultationFees");
 const consultationFees = consultationFeesInput
 ? Math.trunc(Number(consultationFeesInput.value || 0))
 : 0;
 // Total Fees = what the patient pays = Scan Fees + Consultation Fees
 // Radiologist Fees is tracked separately (internal cost paid to the radiologist).
 const total = scanFees + consultationFees;
 totalFeesInput.value = total.toFixed(2);
}

function normalizeScanFees() {
 const numeric = Number(scanFeesInput.value || 0);
 if (!Number.isFinite(numeric) || numeric < 0) {
 scanFeesInput.value = "0";
 return;
 }

 scanFeesInput.value = String(Math.trunc(numeric));
}

function resetFormForNextEntry() {
 scanForm.reset();
 setDefaultDate();
 if (scanFeesInput) scanFeesInput.value = "";
 if (radiologistFeesInput) radiologistFeesInput.value = "";
 if (cashAmountInput) cashAmountInput.value = "";
 if (onlineAmountInput) onlineAmountInput.value = "";
 totalFeesInput.value = "0.00";
 syncPaymentMethodFields();
 resetRefDoctorOtherMode();
 // Close the smart-autocomplete dropdown on form reset
 const acDrop = document.getElementById("refDoctorDropdown");
 if (acDrop) acDrop.style.display = "none";
}

let editingRowIndex = null;

function startEditRecord(rowIdx) {
 const entry = entriesCache.find(e => e.sheetRowIndex === rowIdx)
 || _tableEntries.find(e => e.sheetRowIndex === rowIdx);
 if (!entry) return;

 editingRowIndex = rowIdx;

 // Populate basic text inputs
 dateInput.value = entry.date;
 patientNameInput.value = entry.patientName;
 patientAgeInput.value = entry.age;
 patientPhoneInput.value = entry.phone;
 scanFeesInput.value = entry.scanFees;
 radiologistNameSelect.value = entry.radiologistName;
 radiologistFeesInput.value = entry.radiologistFees;
 refDoctorInput.value = entry.refDoctor;
 const consultFeesInput = document.getElementById("consultationFees");
 if (consultFeesInput) consultFeesInput.value = entry.consultationFees;
 totalFeesInput.value = entry.totalFees;

 const storedPayment = normalizeStoredPayment(entry);
 paymentTypeInputs.forEach((input) => {
 input.checked = input.value === storedPayment.paymentMethod;
 });
 if (cashAmountInput) cashAmountInput.value = storedPayment.cashAmount.toFixed(2);
 if (onlineAmountInput) onlineAmountInput.value = storedPayment.onlineAmount.toFixed(2);
 syncPaymentMethodFields();

 // Clear autocomplete clear buttons state
 const clearBtn = document.getElementById("refDoctorClear");
 if (clearBtn) {
 clearBtn.style.display = entry.refDoctor ? "flex" : "none";
 }

 // Populate 3D Scan Checkboxes
 const chosenScans = (entry.scanType || "").split(",").map(s => s.trim());
 document.querySelectorAll('input[name="scanTypeOption"]').forEach(cb => {
 cb.checked = chosenScans.includes(cb.value);
 });

 // Populate 2D Scan Checkboxes
 const chosenTwoD = (entry.twoDScanType || "").split(",").map(s => s.trim());
 document.querySelectorAll('input[name="twoDScanOption"]').forEach(cb => {
 cb.checked = chosenTwoD.includes(cb.value);
 });

 // Populate Purpose Checkboxes
 const chosenPurposes = (entry.cbctPurpose || "").split(",").map(s => s.trim());
 document.querySelectorAll('input[name="purposeOption"]').forEach(cb => {
 cb.checked = chosenPurposes.includes(cb.value);
 });

 // Modify form actions for Edit Mode
 const submitBtn = document.getElementById("submitBtn");
 if (submitBtn) {
 submitBtn.textContent = "Update Entry";
 submitBtn.classList.remove("btn-primary");
 submitBtn.classList.add("btn-update");
 }

 // Add dynamic Cancel button if not already present
 let cancelBtn = document.getElementById("cancelEditBtn");
 if (!cancelBtn) {
 cancelBtn = document.createElement("button");
 cancelBtn.type = "button";
 cancelBtn.id = "cancelEditBtn";
 cancelBtn.className = "btn-secondary";
 cancelBtn.textContent = "Cancel Edit";
 cancelBtn.style.marginLeft = "8px";
 cancelBtn.addEventListener("click", cancelEditMode);
 submitBtn.parentNode.appendChild(cancelBtn);
 }

 // Scroll to form
 const formSection = document.getElementById("formSection");
 if (formSection) {
 formSection.scrollIntoView({ behavior: "smooth" });
 }
}

function cancelEditMode() {
 editingRowIndex = null;

 // Reset form
 resetFormForNextEntry();

 // Reset submit button
 const submitBtn = document.getElementById("submitBtn");
 if (submitBtn) {
 submitBtn.textContent = "Submit";
 submitBtn.classList.remove("btn-update");
 submitBtn.classList.add("btn-primary");
 }

 // Remove cancel button
 const cancelBtn = document.getElementById("cancelEditBtn");
 if (cancelBtn) {
 cancelBtn.remove();
 }
}

async function updateEntryInCloud(rowIdx, entry) {
 if (!isCloudConfigured()) {
 // Update local mirror for offline mode
 const mirror = readMirror(LS_RECORDS_KEY, []);
 const idx = mirror.findIndex(e => e.sheetRowIndex === rowIdx);
 if (idx !== -1) {
 mirror[idx] = { ...mirror[idx], ...entry };
 writeMirror(LS_RECORDS_KEY, mirror);
 }
 setStatus("Backend not configured - record updated locally only. Configure config.js to sync.", true);
 return false;
 }

 const row = {
 "Date": entry.date,
 "Age": entry.age,
 "Patient Name": entry.patientName,
 "Scan Type": entry.scanType,
 "2D Scan": entry.twoDScanType,
 "Purpose of CBCT": entry.cbctPurpose,
 "Scan Fees": entry.scanFees,
 "Radiologist Name": entry.radiologistName,
 "Radiologist Fees": entry.radiologistFees,
 "Referring Doctor": entry.refDoctor,
 "Consultation Fees": entry.consultationFees || 0,
 "Total Fees": entry.totalFees,
 "Phone": entry.phone || "",
 "Payment Method": entry.paymentMethod || "Cash",
 "Cash Amount": entry.cashAmount || 0,
 "Online Amount": entry.onlineAmount || 0,
 "Edit History": entry.editHistory || ""
 };

 try {
 const data = await cloudPost({ op: "updateRecord", rowIndex: rowIdx, row });
 if (data && data.editHistory) {
 entry.editHistory = data.editHistory;
 }

 // Update local mirror with server-confirmed editHistory
 const mirror = readMirror(LS_RECORDS_KEY, []);
 const idx = mirror.findIndex(e => e.sheetRowIndex === rowIdx);
 if (idx !== -1) {
 mirror[idx] = { ...mirror[idx], ...entry };
 writeMirror(LS_RECORDS_KEY, mirror);
 }
 return true;
 } catch (error) {
 console.error("updateEntryInCloud failed:", error);
 setStatus("Update failed: " + describeApiError(error), true);
 return false;
 }
}

async function deleteRecordInCloud(rowIdx) {
 try {
 setStatus("Deleting record...", false);
 await cloudPost({ op: "deleteRecord", rowIndex: rowIdx });

 setStatus("Record deleted. Syncing with cloud...", false);
 // Deletion shifts physical sheet rows, so invalidate every cached page and
 // reload only the current query's first page (never the legacy full dataset).
 const shiftRowsAfterDelete = entries => entries.map(entry => ({
  ...entry,
  sheetRowIndex: Number.isInteger(entry.sheetRowIndex) && entry.sheetRowIndex > rowIdx
   ? entry.sheetRowIndex - 1
   : entry.sheetRowIndex
 })).filter(entry => entry.sheetRowIndex !== rowIdx);
 entriesCache = shiftRowsAfterDelete(entriesCache);
 window.entriesCache = entriesCache;
 const legacyMirror = readMirror(LS_RECORDS_KEY, []);
 if (Array.isArray(legacyMirror)) writeMirror(LS_RECORDS_KEY, shiftRowsAfterDelete(legacyMirror));
 if (recordsPager) await recordsPager.invalidate();
 else renderTable();

 setStatus("Record deleted successfully.", false);
 setTimeout(() => setStatus(""), 3000);
 return true;
 } catch (error) {
 console.error("deleteRecordInCloud failed:", error);
 setStatus("Delete failed: " + describeApiError(error), true);
 return false;
 }
}

// Pagination state
let _tableEntries = [];
let _currentPage = 1;
const PAGE_SIZE = 10;
let recordsPager = null;
let recordsReferenceMetadata = { availableMonths: [], referringDoctors: [] };
let legacyPagingRecords = null;
let recordsListObserved = false;

function recordsPageCacheKey(month, cursor) {
 return JSON.stringify([month || "", cursor || ""]);
}

function readStoredRecordPage(month, cursor) {
 const pages = readMirror(LS_RECORD_PAGES_KEY, {});
 const stored = pages && typeof pages === "object" ? pages[recordsPageCacheKey(month, cursor)] : null;
 if (stored) return stored;
 return cursor ? null : readLegacyRecordPage(month, null, PAGE_SIZE);
}

function writeStoredRecordPage(month, cursor, page) {
 const pages = readMirror(LS_RECORD_PAGES_KEY, {});
 pages[recordsPageCacheKey(month, cursor)] = page;
 const keys = Object.keys(pages);
 while (keys.length > 30) delete pages[keys.shift()];
 writeMirror(LS_RECORD_PAGES_KEY, pages);
}

function clearStoredRecordPages() {
 try { localStorage.removeItem(LS_RECORD_PAGES_KEY); }
 catch (_) { writeMirror(LS_RECORD_PAGES_KEY, {}); }
}

function getLegacyPagingRecords() {
 if (legacyPagingRecords) return legacyPagingRecords;
 const cached = readMirror(LS_RECORDS_KEY, []);
 legacyPagingRecords = (Array.isArray(cached) ? cached : []).map((entry, index) => {
 if (entry && Object.prototype.hasOwnProperty.call(entry, "patientName")) {
 return { ...entry, sheetRowIndex: Number.isInteger(entry.sheetRowIndex) ? entry.sheetRowIndex : index };
 }
 return parseCloudRecord(entry || {}, index);
 }).sort((a, b) => normalizeDate(b.date).localeCompare(normalizeDate(a.date)) || Number(b.sheetRowIndex) - Number(a.sheetRowIndex));
 return legacyPagingRecords;
}

function readLegacyRecordPage(month, cursor, limit = PAGE_SIZE) {
 const allRows = getLegacyPagingRecords();
 const filtered = allRows.filter(entry => !month || normalizeDate(entry.date).slice(0, 7) === month);
 const offset = cursor && /^legacy:\d+$/.test(cursor) ? Number(cursor.slice(7)) : 0;
 const rows = filtered.slice(offset, offset + limit);
 const hasMore = filtered.length > offset + limit;
 const availableMonths = Array.from(new Set(allRows.map(entry => normalizeDate(entry.date).slice(0, 7)).filter(Boolean))).sort().reverse();
 const referringDoctors = Array.from(new Set(allRows.map(entry => String(entry.refDoctor || "").trim()).filter(Boolean)))
 .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
 return { rows, hasMore, nextCursor: hasMore ? `legacy:${offset + limit}` : null, ...(offset === 0 ? { availableMonths, referringDoctors } : {}) };
}

async function fetchRecordPage({ month, cursor, limit }) {
 if (cursor && String(cursor).startsWith("legacy:")) return readLegacyRecordPage(month, cursor, limit);
 const params = { limit };
 if (month) params.month = month;
 if (cursor) params.cursor = cursor;
 const data = await cloudGet("recordsPage", params);
 return {
 ...data,
 rows: data.rows.map((row, index) => parseCloudRecord(row, Number.isInteger(row._sheetRowIndex) ? row._sheetRowIndex : index))
 };
}

function ensureRecordsPager() {
 if (recordsPager) return recordsPager;
 if (!window.RecordsPaging?.createRecordPager) return null;
 recordsPager = window.RecordsPaging.createRecordPager({
 pageSize: PAGE_SIZE,
 fetchPage: fetchRecordPage,
  readCache: readStoredRecordPage,
  writeCache: writeStoredRecordPage,
  clearCache: clearStoredRecordPages,
  onStateChange: renderRecordPageState
 });
 return recordsPager;
}

function renderRecordPageState(state) {
 if (!recordsBody || !state) return;
 recordsReferenceMetadata = {
 availableMonths: Array.isArray(state.availableMonths) ? state.availableMonths : recordsReferenceMetadata.availableMonths,
 referringDoctors: Array.isArray(state.referringDoctors) ? state.referringDoctors : recordsReferenceMetadata.referringDoctors
 };
 window.recordsReferenceMetadata = recordsReferenceMetadata;
 populateRecordsMonthFilter(recordsReferenceMetadata.availableMonths);

 const pendingIds = new Set(readOutbox()
 .filter(operation => operation.kind === "record" && operation.status !== "synced")
 .map(operation => operation.operationId));
 const pendingRows = pendingIds.size
 ? readMirror(LS_RECORDS_KEY, []).filter(entry => pendingIds.has(entry.operationId))
 : [];
 const pageRows = Array.isArray(state.rows) ? state.rows : [];
 const pageIds = new Set(pageRows.map(entry => entry.operationId).filter(Boolean));
 const visibleRows = [
 ...pendingRows.filter(entry => (!state.month || normalizeDate(entry.date).slice(0, 7) === state.month) && !pageIds.has(entry.operationId)),
 ...pageRows
 ];
 _tableEntries = visibleRows;
 _currentPage = state.page || 1;

 if (!visibleRows.length) {
 const message = state.status === "loading" ? "Loading patient records..."
 : state.status === "error" ? "Could not load records. Check your connection and refresh."
 : state.status === "idle" ? "Records load when this section is opened."
 : "No records found for this selection.";
 recordsBody.innerHTML = `<tr class="empty-row"><td colspan="16">${escapeHtml(message)}</td></tr>`;
 } else {
 recordsBody.innerHTML = visibleRows.map(entry => `
 <tr>
 <td>${escapeHtml(formatDateDisplay(entry.date) || "")}</td>
 <td>${Number(entry.age || 0) > 0 ? Math.trunc(Number(entry.age || 0)) : ""}</td>
 <td>${escapeHtml(entry.patientName || "")}</td>
 <td>${escapeHtml(entry.phone || "")}</td>
 <td>${escapeHtml(entry.scanType || "")}</td>
 <td>${escapeHtml(entry.twoDScanType || "-")}</td>
 <td>${escapeHtml(entry.cbctPurpose || "-")}</td>
 <td>${Math.trunc(Number(entry.scanFees || 0))}</td>
 <td>${escapeHtml(entry.radiologistName || "")}</td>
 <td>${Number(entry.radiologistFees || 0).toFixed(2)}</td>
 <td>${escapeHtml(entry.refDoctor || "")}</td>
 <td>${Math.trunc(Number(entry.consultationFees || 0))}</td>
 <td>${Number(entry.totalFees || 0).toFixed(2)}</td>
 <td>${escapeHtml(formatPaymentSummary(entry))}</td>
 <td><span class="sync-status ${escapeHtml(entry.syncStatus || "synced")}">${escapeHtml(entry.syncStatus || "synced")}</span></td>
 <td class="no-print" style="text-align:center;">
 <button type="button" class="btn-table-edit" data-row-idx="${entry.sheetRowIndex}">Edit</button>
 <button type="button" class="btn-table-delete" data-row-idx="${entry.sheetRowIndex}">Delete</button>
 </td>
 </tr>`).join("");
 }

 recordsBody.querySelectorAll(".btn-table-edit").forEach(btn => {
 btn.addEventListener("click", () => startEditRecord(parseInt(btn.dataset.rowIdx, 10)));
 });
 recordsBody.querySelectorAll(".btn-table-delete").forEach(btn => {
 btn.addEventListener("click", async () => {
 if (await appDialog.confirm({
 title: "Delete patient record?",
 message: "Are you sure you want to delete this record? This action cannot be undone.",
 confirmLabel: "Delete",
 danger: true
 })) {
 await deleteRecordInCloud(parseInt(btn.dataset.rowIdx, 10));
 }
 });
 });

 const paginationRow = document.getElementById("paginationRow");
 const pageNumDisplay = document.getElementById("pageNumDisplay");
 const recordsPageInfo = document.getElementById("recordsPageInfo");
 if (paginationRow) paginationRow.style.display = (state.page > 1 || state.hasMore) ? "flex" : "none";
 if (pageNumDisplay) pageNumDisplay.textContent = visibleRows.length ? `Page ${state.page}` : "";
 if (recordsPageInfo) {
 const range = window.RecordsPaging?.formatRecordPageInfo(state.page, visibleRows.length, PAGE_SIZE) || "";
 const freshness = state.status === "stale" ? " · Cached data" : "";
 const loading = state.loading && visibleRows.length ? " · Refreshing" : "";
 recordsPageInfo.textContent = range ? `${range}${freshness}${loading}` : (state.status === "error" ? "Could not load records. Retry." : state.status === "loading" ? "Loading records..." : "");
 }
 const prevBtn = document.getElementById("prevPageBtn");
 const nextBtn = document.getElementById("nextPageBtn");
 if (prevBtn) prevBtn.disabled = state.page <= 1 || state.loading;
 if (nextBtn) nextBtn.disabled = !state.hasMore || state.loading;
}

async function ensureRecordsListLoaded({ refresh = false } = {}) {
 const pager = ensureRecordsPager();
 if (!pager || (recordsListObserved && !refresh)) return;
 recordsListObserved = true;
 await pager.loadFirst({ refresh: true });
}

function initializeRecordsListLazyLoading() {
 const section = document.getElementById("sheetSection");
 const scanTab = document.getElementById("tabScan");
 if (section && typeof IntersectionObserver === "function") {
 const observer = new IntersectionObserver(entries => {
 if (entries.some(entry => entry.isIntersecting)) {
 void ensureRecordsListLoaded();
 observer.disconnect();
 }
 });
 observer.observe(section);
 } else if (section) {
 void ensureRecordsListLoaded();
 }
 scanTab?.addEventListener("click", () => {
 if (!recordsListObserved) void ensureRecordsListLoaded();
 });
}

function renderTable(entries) {
 const pager = ensureRecordsPager();
 if (pager) renderRecordPageState(pager.getState());
}

// Wire pagination buttons (runs once after DOM ready)
document.addEventListener("DOMContentLoaded", () => {
 const prevBtn = document.getElementById("prevPageBtn");
 const nextBtn = document.getElementById("nextPageBtn");
 if (prevBtn) prevBtn.addEventListener("click", () => { void recordsPager?.previous(); });
 if (nextBtn) nextBtn.addEventListener("click", () => { void recordsPager?.next(); });
 initializeRecordsListLazyLoading();
});

// â”€â”€ Month filter for Patient Records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _recordsMonthFilter = "";

function populateRecordsMonthFilter(availableMonths) {
 const select = document.getElementById("recordsMonthFilter");
 if (!select) return;
 const sorted = Array.isArray(availableMonths) ? availableMonths.slice().sort().reverse() : [];
 const prev = _recordsMonthFilter || select.value;
 select.innerHTML = '<option value="">All Months</option>';
 sorted.forEach(function(m) {
 const label = new Date(m + "-01T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
 const opt = document.createElement("option");
 opt.value = m;
 opt.textContent = label;
 if (m === prev) opt.selected = true;
 select.appendChild(opt);
 });
 _recordsMonthFilter = select.value;
}

document.addEventListener("DOMContentLoaded", function() {
 const monthSel = document.getElementById("recordsMonthFilter");
 if (monthSel) {
 monthSel.addEventListener("change", function() {
 _recordsMonthFilter = monthSel.value;
 void recordsPager?.setMonth(_recordsMonthFilter);
 });
 }
});

function parseRowsToEntries(rows) {
 if (!rows || rows.length === 0) {
 return [];
 }

 let dataRows = rows;
 const first = rows[0] || [];
 const looksLikeHeader = first[0] === "Date" && (first[1] === "Age" || first[1] === "Patient Name" || first[2] === "Patient Name");
 if (looksLikeHeader) {
 dataRows = rows.slice(1);
 }

 return dataRows.map((row) => {
 // Current format: Date | Age | Patient Name | Scan Type | 2D Scan | Purpose | Scan Fees | Radiologist Name | Radiologist Fees | Referring Doctor | Consultation Fees | Total Fees | Phone | Payment Method | Cash Amount | Online Amount | Edit History
 if ((row || []).length >= 17) {
 return {
 date: row[0] || "",
 age: Number(row[1] || 0),
 patientName: row[2] || "",
 phone: row[12] || "",
 scanType: row[3] || "",
 twoDScanType: row[4] || "",
 cbctPurpose: row[5] || "",
 scanFees: Number(row[6] || 0),
 radiologistName: row[7] || "",
 radiologistFees: Number(row[8] || 0),
 refDoctor: row[9] || "",
 consultationFees: Number(row[10] || 0),
 totalFees: Number(row[11] || 0),
 paymentMethod: row[13] || "Cash",
 cashAmount: Number(row[14] || 0),
 onlineAmount: Number(row[15] || 0),
 editHistory: row[16] || ""
 };
 }

 // New format with phone: Date | Age | Patient Name | Phone | Scan Type | 2D Scan | Purpose | Scan Fees | Radiologist Name | Radiologist Fees | Referring Doctor | Total Fees
 if ((row || []).length >= 12) {
 return {
 date: row[0] || "",
 age: Number(row[1] || 0),
 patientName: row[2] || "",
 phone: row[3] || "",
 scanType: row[4] || "",
 twoDScanType: row[5] || "",
 cbctPurpose: row[6] || "",
 scanFees: Number(row[7] || 0),
 radiologistName: row[8] || "",
 radiologistFees: Number(row[9] || 0),
 refDoctor: row[10] || "",
 totalFees: Number(row[11] || 0),
 paymentMethod: "Cash",
 cashAmount: Number(row[11] || 0),
 onlineAmount: 0
 };
 }

 // Format without phone: Date | Age | Patient Name | Scan Type | 2D Scan | Purpose | Scan Fees | Radiologist Name | Radiologist Fees | Referring Doctor | Total Fees
 if ((row || []).length >= 11) {
 return {
 date: row[0] || "",
 age: Number(row[1] || 0),
 patientName: row[2] || "",
 phone: "",
 scanType: row[3] || "",
 twoDScanType: row[4] || "",
 cbctPurpose: row[5] || "",
 scanFees: Number(row[6] || 0),
 radiologistName: row[7] || "",
 radiologistFees: Number(row[8] || 0),
 refDoctor: row[9] || "",
 totalFees: Number(row[10] || 0),
 paymentMethod: "Cash",
 cashAmount: Number(row[10] || 0),
 onlineAmount: 0
 };
 }

 // Old format with no age
 if ((row || []).length >= 10) {
 return {
 date: row[0] || "",
 age: 0,
 patientName: row[1] || "",
 phone: "",
 scanType: row[2] || "",
 twoDScanType: row[3] || "",
 cbctPurpose: row[4] || "",
 scanFees: Number(row[5] || 0),
 radiologistName: row[6] || "",
 radiologistFees: Number(row[7] || 0),
 refDoctor: row[8] || "",
 totalFees: Number(row[9] || 0),
 paymentMethod: "Cash",
 cashAmount: Number(row[9] || 0),
 onlineAmount: 0
 };
 }

 // Legacy fallback
 return {
 date: row[0] || "",
 age: 0,
 patientName: row[1] || "",
 scanType: row[2] || "",
 twoDScanType: row[3] || "",
 cbctPurpose: row[4] || "",
 scanFees: Number(row[5] || 0),
 radiologistName: row[6] || "",
 radiologistFees: Number(row[7] || 0),
 refDoctor: row[8] || "",
 totalFees: Number(row[9] || 0),
 paymentMethod: "Cash",
 cashAmount: Number(row[9] || 0),
 onlineAmount: 0
 };
 });
}

// ============================================================================
// CLOUD LAYER - talks to the deployed Apps Script Web App via fetch().
// No client-side Google login. The Apps Script runs as its owner.
// ============================================================================

function getScriptUrl() {
 if (!window.CloudSync || typeof window.CloudSync.resolveEndpoint !== "function") return "";
 return window.CloudSync.resolveEndpoint({ appConfig: window.APP_CONFIG });
}

function isCloudConfigured() {
 try { return !!getScriptUrl(); } catch { return false; }
}

// localStorage mirror - survives reload, used when network is down
function readMirror(key, fallback) {
 try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; }
 catch { return fallback; }
}
function writeMirror(key, value) {
 try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn("LS write failed", e); }
}

// Shared bounded cloud request helper
const cloudClient = window.CloudSync.createCloudClient({
 getUrl: getScriptUrl,
 fetchImpl: window.APP_CONFIG?.DEMO_MODE ? window.DemoBackend.createFetch() : fetch,
 timeoutMs: CLOUD_REQUEST_TIMEOUT_MS
});
const gatewaySessionClient = window.CloudSync.createGatewaySessionClient({
 getUrl: getScriptUrl,
 fetchImpl: window.APP_CONFIG?.DEMO_MODE ? window.DemoBackend.createFetch() : fetch,
 timeoutMs: CLOUD_REQUEST_TIMEOUT_MS
});

if (window.APP_CONFIG?.DEMO_MODE) {
 if (!window.DemoBackend || !demoNotice || !adminAccessBtn) {
  throw new Error("The demo runtime is incomplete. Reload the page or use the local demo build.");
 }
 demoNotice.hidden = false;
 adminAccessBtn.disabled = true;
 adminAccessBtn.title = "Admin access is disabled in the public demo.";
}

// Kept as a named shim for existing callers and regression tests.
// Legacy call shape remains: fetchWithTimeout(url, init, timeoutMs).
async function fetchWithTimeout(input, init = {}, timeoutMs = CLOUD_REQUEST_TIMEOUT_MS) {
 if (typeof AbortController !== "function") return fetch(input, init);
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
 try {
 return await fetch(input, { ...init, signal: controller.signal });
 } finally {
 clearTimeout(timeoutId);
 }
}

async function cloudGet(op, queryParams) {
 return cloudClient.get(op, queryParams);
}

// Plain writes are intentionally one attempt. Only the outbox calls the
// idempotent retry path after Apps Script durable deduplication is deployed.
async function cloudPost(payload) {
 return cloudClient.post(payload);
}

async function cloudPostWithRetry(payload) {
 return cloudClient.postWithRetry(payload, { dedupeGuaranteed: true });
}

function generateOperationId(prefix = "op") {
 const random = (window.crypto && typeof window.crypto.randomUUID === "function")
 ? window.crypto.randomUUID()
 : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
 return `${prefix}-${random}`;
}

function readOutbox() {
 const outbox = readMirror(LS_OUTBOX_KEY, []);
 return Array.isArray(outbox) ? outbox : [];
}

function writeOutbox(outbox) {
 writeMirror(LS_OUTBOX_KEY, outbox);
}

function updateOutbox(operationId, changes) {
 const next = readOutbox().map(operation =>
 operation.operationId === operationId ? { ...operation, ...changes } : operation
 );
 writeOutbox(next);
 return next.find(operation => operation.operationId === operationId) || null;
}

function removeOutboxOperation(operationId) {
 writeOutbox(readOutbox().filter(operation => operation.operationId !== operationId));
}

function updateMirrorItem(mirrorKey, operationId, changes) {
 const mirror = readMirror(mirrorKey, []);
 if (!Array.isArray(mirror)) return;
 const next = mirror.map(item => item.operationId === operationId
 ? { ...item, ...changes }
 : item);
 writeMirror(mirrorKey, next);
 if (mirrorKey === LS_RECORDS_KEY && Array.isArray(entriesCache)) {
 entriesCache = entriesCache.map(item => item.operationId === operationId
 ? { ...item, ...changes }
 : item);
 window.entriesCache = entriesCache;
 renderTable(entriesCache);
 }
}

function updateMirrorSyncStatus(mirrorKey, operationId, syncStatus, syncError = "") {
 updateMirrorItem(mirrorKey, operationId, { syncStatus, syncError });
}

function setSyncStatus(state, detail = "") {
 const el = document.getElementById("syncStatus");
 if (!el) return;
 const detailEl = document.getElementById("syncStatusDetail");
 const pending = readOutbox().filter(operation => operation.status !== "synced").length;
 const labels = {
 syncing: "Syncing...",
 synced: "Synced",
  unavailable: "Cloud unavailable",
  pending: "Pending sync",
  failed: "Sync failed",
  retrying: "Cloud sync",
  offline: "Cloud sync",
  attention: "Cloud sync"
 };
 el.className = `sync-status ${state}`;
 const coordinated = ["syncing", "synced", "retrying", "offline", "attention"].includes(state);
 el.textContent = coordinated ? "" : (labels[state] || state);
 if (detailEl) {
  detailEl.className = `sync-status-detail ${state}`;
  detailEl.textContent = detail || (pending ? `${pending} pending` : "");
 }
}

function readSyncHealth() {
 const saved = readMirror(LS_SYNC_HEALTH_KEY, {});
 return {
 lastSuccessfulRecordsSyncAt: saved?.lastSuccessfulRecordsSyncAt || null,
 lastSuccessfulConfigSyncAt: saved?.lastSuccessfulConfigSyncAt || null,
 lastFailureAt: saved?.lastFailureAt || null,
 failureKind: saved?.failureKind || null,
 consecutiveFailures: Number(saved?.consecutiveFailures) || 0,
  nextRetryAt: saved?.nextRetryAt !== null && saved?.nextRetryAt !== undefined && Number.isFinite(Number(saved.nextRetryAt))
   ? Number(saved.nextRetryAt) : null
 };
}

function persistSyncHealth(health) {
 try {
  const serialize = window.SyncRecovery?.serializeSyncHealth;
  const safe = serialize
   ? JSON.parse(serialize(health))
   : {
    lastSuccessfulRecordsSyncAt: health.lastSuccessfulRecordsSyncAt || null,
    lastSuccessfulConfigSyncAt: health.lastSuccessfulConfigSyncAt || null,
   lastFailureAt: health.lastFailureAt || null,
   failureKind: health.failureKind || null,
   consecutiveFailures: Number(health.consecutiveFailures) || 0,
    nextRetryAt: health.nextRetryAt !== null && health.nextRetryAt !== undefined && Number.isFinite(Number(health.nextRetryAt))
     ? Number(health.nextRetryAt) : null
   };
  localStorage.setItem(LS_SYNC_HEALTH_KEY, JSON.stringify(safe));
 } catch (error) {
  console.warn("Could not persist cloud sync health:", error);
 }
}

function initializeSyncRecovery() {
 if (syncRecovery || !window.SyncRecovery?.createSyncRecovery) return syncRecovery;
 const health = readSyncHealth();
 syncRecovery = window.SyncRecovery.createSyncRecovery({
  refresh: refreshCloudState,
  classifyError: error => window.CloudSync?.classifyCloudError?.(error) || {
   kind: "unknown", retryable: false, message: "Cloud sync needs attention. Try Refresh or contact support."
  },
  isOnline: () => navigator.onLine !== false,
  isVisible: () => !document.hidden,
  refreshIntervalMs: Number(window.APP_CONFIG?.AUTO_REFRESH_MS || 600000),
  initialState: {
   lastSuccessfulAt: health.lastSuccessfulRecordsSyncAt,
   failureKind: health.failureKind,
   consecutiveFailures: health.consecutiveFailures,
   nextRetryAt: health.nextRetryAt
  },
  onStateChange(state) {
   const nowIso = new Date().toISOString();
   const latestHealth = readSyncHealth();
   const nextHealth = {
    ...latestHealth,
    lastFailureAt: state.failureKind ? nowIso : latestHealth.lastFailureAt,
    failureKind: state.failureKind,
    consecutiveFailures: state.consecutiveFailures,
    nextRetryAt: state.nextRetryAt
   };
   persistSyncHealth(nextHealth);
   const pendingCount = readOutbox().filter(operation => operation.status !== "synced").length;
   const detail = window.SyncRecovery.formatSyncStatus({
    ...state,
    pendingCount,
    now: Date.now()
   });
   setSyncStatus(state.status, detail);
   if (refreshBtn) refreshBtn.disabled = state.isRefreshing;
   if (state.status === "synced" && recordsListObserved && ["stale", "error"].includes(recordsPager?.getState().status)) {
    void recordsPager.refresh();
   }
  }
 });
 window.addEventListener("online", () => { void syncRecovery?.notifyOnline(); });
 window.addEventListener("focus", () => { void syncRecovery?.notifyFocus(); });
 document.addEventListener("visibilitychange", () => {
  void syncRecovery?.notifyVisibility(!document.hidden);
 });
 void syncRecovery.start();
 return syncRecovery;
}

function reconcileConfirmedOperations(operationIds) {
 const ids = new Set(operationIds.filter(Boolean));
 if (!ids.size) return;
 readOutbox().filter(operation => ids.has(operation.operationId)).forEach(operation => {
 removeOutboxOperation(operation.operationId);
 updateMirrorSyncStatus(operation.mirrorKey, operation.operationId, "synced", "");
 });
}

function mergePendingMirrorItems(remoteEntries, mirrorKey) {
 const remoteIds = new Set(remoteEntries.map(entry => entry.operationId).filter(Boolean));
 const pending = readMirror(mirrorKey, []).filter(entry =>
 entry.operationId && entry.syncStatus !== "synced" && !remoteIds.has(entry.operationId)
 );
 return [...pending, ...remoteEntries];
}

async function syncCloudOutbox() {
 if (cloudOutboxSyncPromise) return cloudOutboxSyncPromise;
 cloudOutboxSyncPromise = (async () => {
 const operations = readOutbox();
 if (!operations.length) return operations;
 let idempotentWritesAvailable = false;
 let capabilityError = null;
 try {
 if (!cloudCapabilitiesPromise) {
 cloudCapabilitiesPromise = cloudGet("capabilities")
 .then(data => data.capabilities || {})
 .finally(() => { cloudCapabilitiesPromise = null; });
 }
 const capabilities = await cloudCapabilitiesPromise;
 idempotentWritesAvailable = capabilities.idempotentWrites === true;
 } catch (error) {
 console.warn("Cloud write capability check failed:", error);
 capabilityError = error;
 }
 if (capabilityError) {
 const retryMessage = describeApiError(capabilityError);
 operations.forEach(operation => {
   updateOutbox(operation.operationId, {
     status: "pending",
     lastError: retryMessage,
     lastStatus: Number(capabilityError.status) || null
 });
 updateMirrorSyncStatus(
 operation.mirrorKey,
 operation.operationId,
 "pending",
 retryMessage
 );
 });
 setSyncStatus("pending", "Pending sync - waiting for cloud connection");
 return readOutbox();
 }
 if (!idempotentWritesAvailable) {
 operations.forEach(operation => {
 updateOutbox(operation.operationId, {
 status: "failed",
 lastError: "Durable write deduplication is unavailable on the deployed Apps Script."
 });
 updateMirrorSyncStatus(
 operation.mirrorKey,
 operation.operationId,
 "failed",
 "Durable write deduplication is unavailable on the deployed Apps Script."
 );
 });
 setSyncStatus("failed", "Update Apps Script before syncing writes");
 return readOutbox();
 }
 for (const operation of operations) {
 if (!isCloudConfigured()) break;
 updateOutbox(operation.operationId, { status: "syncing", lastAttemptAt: new Date().toISOString() });
 updateMirrorSyncStatus(operation.mirrorKey, operation.operationId, "syncing", "");
 setSyncStatus("syncing");
 try {
 const response = await cloudPostWithRetry(operation.payload);
 removeOutboxOperation(operation.operationId);
 const rowNumber = Number(response && response.rowNumber);
 updateMirrorItem(operation.mirrorKey, operation.operationId, {
 syncStatus: "synced",
 syncError: "",
 ...(rowNumber >= 2 ? { sheetRowIndex: rowNumber - 2 } : {})
 });
 } catch (error) {
 const retryable = typeof window.CloudSync?.isTransientError === "function"
 ? window.CloudSync.isTransientError(error)
 : false;
 const nextStatus = retryable ? "pending" : "failed";
  updateOutbox(operation.operationId, {
   status: nextStatus,
   retryCount: Number(operation.retryCount || 0) + 1,
   lastError: describeApiError(error),
   lastStatus: Number(error?.status) || null
 });
 updateMirrorSyncStatus(operation.mirrorKey, operation.operationId, nextStatus, describeApiError(error));
 }
 }
 const remaining = readOutbox();
 setSyncStatus(remaining.length ? (remaining.some(o => o.status === "failed") ? "failed" : "pending") : "synced");
 return remaining;
 })().finally(() => { cloudOutboxSyncPromise = null; });
 return cloudOutboxSyncPromise;
}

window.CloudOutbox = {
 read: readOutbox,
 enqueue(operation) {
 const existing = readOutbox().find(item => item.operationId === operation.operationId);
 if (existing) return existing;
 const next = {
 ...operation,
 status: "pending",
 retryCount: 0,
 createdAt: operation.createdAt || new Date().toISOString()
 };
 writeOutbox([...readOutbox(), next]);
 return next;
 },
 sync: syncCloudOutbox,
 reconcile: reconcileConfirmedOperations,
 mergePending: mergePendingMirrorItems
};
window.cloudGet = cloudGet;
window.cloudPost = cloudPost;
window.cloudPostWithRetry = cloudPostWithRetry;

// Friendly error message
function describeApiError(error) {
 const msg = (error && error.message) || String(error);
 if (/Failed to fetch|NetworkError/i.test(msg)) {
 if (window.location.protocol === "file:") {
 return "App opened as a file - use app.bat or open http://localhost:3000 in your browser.";
 }
 return "Cannot reach Google Sheets. Check your internet connection and try again.";
 }
 if (/gateway|endpoint/i.test(msg)) return msg;
 return "Server error: " + msg;
}

// Auth shims - kept so the rest of the file doesn't have to know we changed
// architectures. The Apps Script does the real auth on the server side.
function setAuthUiSignedIn(/* signedIn, showLoginFallback */) { /* no-op */ }
function setAuthPromptVisibility(/* show */) { /* no-op */ }
function onTokenReceived() { return true; }
async function requestToken(/* interactive */) { return true; }
async function ensureCloudAccess(/* interactiveIfNeeded */) { return isCloudConfigured(); }
function signOutCloud(message = "Cloud sync signed out.") { setStatus(message, false); }
async function initGoogleClients() {
 if (!isCloudConfigured()) {
 setStatus("Cloud endpoint is not configured for this environment. See the setup documentation.", true);
 return false;
 }
 return true;
}

// Config (scan types, purposes, radiologists, doctor list)
function generateConfigVersion() {
 return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function loadConfigFromCloud({ reportFailure = true } = {}) {
 // First show whatever we have cached locally so the UI is responsive
 const cached = readMirror(LS_CONFIG_KEY, null);
 if (cached && cached.config) {
 appConfig = normalizeConfig(cached.config);
 window.appConfig = appConfig;
 cloudConfigVersion = cached.version || "";
 renderScanTypeOptions();
 renderTwoDScanOptions();
 renderPurposeOptions();
 renderRadiologistOptions();
 renderReferringDoctorOptions();
 applyRadiologistFees();
 if (typeof renderDoctorReferenceReport === "function") renderDoctorReferenceReport();
 if (typeof renderMonthlyCollection === "function") renderMonthlyCollection();
 }
 if (!isCloudConfigured()) {
  return {
   area: "config", ok: false, source: "cache",
   error: new Error("Cloud endpoint is not configured for the active environment.")
  };
 }
 if (configRefreshPromise) return configRefreshPromise;

 configRefreshPromise = (async () => {
 try {
 const data = await cloudGet("config");
 const remote = data.config || {};
 appConfig = normalizeConfig(remote);
 window.appConfig = appConfig;
 cloudConfigVersion = remote.configVersion || generateConfigVersion();
 writeMirror(LS_CONFIG_KEY, { config: appConfig, version: cloudConfigVersion });

 renderScanTypeOptions();
 renderTwoDScanOptions();
 renderPurposeOptions();
 renderRadiologistOptions();
 renderReferringDoctorOptions();
 applyRadiologistFees();
 if (typeof renderDoctorReferenceReport === "function") renderDoctorReferenceReport();
  if (typeof renderMonthlyCollection === "function") renderMonthlyCollection();
  return { area: "config", ok: true, source: "cloud" };
 } catch (error) {
  console.error("loadConfigFromCloud failed:", error);
  if (reportFailure) setStatus("Could not load admin config from cloud: " + describeApiError(error), true);
  return { area: "config", ok: false, source: "cache", error };
 } finally {
 configRefreshPromise = null;
 }
 })();
 return configRefreshPromise;
}

async function saveConfigToCloud(config, /* passwordHash unused */ _ph, configVersion) {
 const safeConfig = { ...(config || {}) };
 // Always update local mirror first so admin edits are never lost
 writeMirror(LS_CONFIG_KEY, { config: safeConfig, version: configVersion });
 if (!isCloudConfigured()) {
 throw new Error("Backend not configured - config saved locally only.");
 }
 await cloudPost({ op: "saveConfig", config: safeConfig, version: configVersion });
}

// Records
function parseCloudRecord(rowObj, index) {
 const operationId = String(rowObj["Operation ID"] || "").trim();
 return {
 sheetRowIndex: Number.isInteger(rowObj._sheetRowIndex) ? rowObj._sheetRowIndex : index,
 operationId,
 syncStatus: "synced",
 date: normalizeDate(rowObj["Date"]),
 age: Number(rowObj["Age"] || 0),
 patientName: String(rowObj["Patient Name"] || ""),
 phone: String(rowObj["Phone"] || ""),
 scanType: String(rowObj["Scan Type"] || ""),
 twoDScanType: String(rowObj["2D Scan"] || ""),
 cbctPurpose: String(rowObj["Purpose of CBCT"] || ""),
 scanFees: Number(rowObj["Scan Fees"] || 0),
 radiologistName: String(rowObj["Radiologist Name"] || ""),
 radiologistFees: Number(rowObj["Radiologist Fees"] || 0),
 refDoctor: String(rowObj["Referring Doctor"] || ""),
 consultationFees: Number(rowObj["Consultation Fees"] || 0),
 totalFees: Number(rowObj["Total Fees"] || 0),
 paymentMethod: String(rowObj["Payment Method"] || "").trim(),
 cashAmount: Number(rowObj["Cash Amount"] || 0),
 onlineAmount: Number(rowObj["Online Amount"] || 0),
 editHistory: String(rowObj["Edit History"] || "")
 };
}

async function loadRecordsFromCloud({ reportFailure = true } = {}) {
 // Show cached entries immediately
 const cached = readMirror(LS_RECORDS_KEY, []);
 if (Array.isArray(cached) && cached.length) {
 entriesCache = cached.map((e, idx) => ({
 sheetRowIndex: e.hasOwnProperty("sheetRowIndex") ? e.sheetRowIndex : idx,
 ...e
 }));
 window.entriesCache = entriesCache;
  populateRefDoctorSelect();
 }

 if (!isCloudConfigured()) {
 return {
  area: "records", ok: false, source: "cache", entries: entriesCache,
  error: new Error("Cloud endpoint is not configured for the active environment.")
 };
 }
 if (recordsRefreshPromise) return recordsRefreshPromise;

 recordsRefreshPromise = (async () => {
 try {
 const data = await cloudGet("records");
 const rows = Array.isArray(data.rows) ? data.rows : [];
 const parsed = rows.map(parseCloudRecord);
 reconcileConfirmedOperations(parsed.map(entry => entry.operationId));
 entriesCache = window.PaymentMethods.restoreMissingPaymentDetails(parsed, cached);
 entriesCache = mergePendingMirrorItems(entriesCache, LS_RECORDS_KEY);
 window.entriesCache = entriesCache;
 writeMirror(LS_RECORDS_KEY, entriesCache);
  if (reportFailure) setStatus("Records refreshed.", false);
 populateRefDoctorSelect();

 // Refresh dependent views if visible
 const billPageVisible = document.getElementById("billPage")?.style.display === "block";
 if (billPageVisible && billDateInput && billDateInput.value) loadBillPatients(billDateInput.value);
 const doctorPageVisible = document.getElementById("doctorsPage")?.style.display === "block";
 if (doctorPageVisible && typeof renderDoctorRecords === "function") renderDoctorRecords();
 const radPageVisible = document.getElementById("radiologistsPage")?.style.display === "block";
 if (radPageVisible && typeof renderRadiologistRecords === "function") renderRadiologistRecords();
 const doctorReferencePageVisible = document.getElementById("doctorReferencePage")?.style.display === "block";
 if (doctorReferencePageVisible && typeof renderDoctorReferenceReport === "function") renderDoctorReferenceReport();
 if (doctorReferencePageVisible && typeof renderMonthlyCollection === "function") renderMonthlyCollection();

 return { area: "records", ok: true, source: "cloud", entries: entriesCache };
 } catch (error) {
  console.error("loadRecordsFromCloud failed:", error);
  if (reportFailure) setStatus("Could not refresh records; cached records remain available.", true);
  return { area: "records", ok: false, source: "cache", entries: entriesCache, error };
 } finally {
 recordsRefreshPromise = null;
 }
 })();
 return recordsRefreshPromise;
}

async function refreshCloudState({ reason = "manual" } = {}) {
 const [config] = await Promise.all([loadConfigFromCloud({ reportFailure: false })]);
 const outbox = await syncCloudOutbox();
 const health = readSyncHealth();
 if (config.ok) health.lastSuccessfulConfigSyncAt = new Date().toISOString();
 persistSyncHealth(health);
 const failed = !config.ok ? config : null;
 const queuedFailure = !failed && outbox.length
  ? (() => {
   const operation = outbox.find(item => item.status === "failed") || outbox[0];
   return { status: Number(operation.lastStatus) || 0, message: operation.lastError || "Cloud connection unavailable while syncing queued writes." };
  })()
  : null;
 const failure = failed
  ? (window.CloudSync?.classifyCloudError?.(failed.error) || {
   kind: "unknown", retryable: false, message: "Cloud sync needs attention. Try Refresh or contact support."
  })
  : queuedFailure
   ? (window.CloudSync?.classifyCloudError?.(queuedFailure) || {
    kind: "unknown", retryable: false, message: "Cloud sync needs attention. Try Refresh or contact support."
   })
   : null;
 return { ok: !failed && !outbox.length, reason, config, outbox, ...(failure ? { failure } : {}) };
}

async function ensureReportRecordsLoaded() {
 if (Array.isArray(entriesCache) && entriesCache.length && reportRecordsLoaded) return entriesCache;
 const result = await loadRecordsFromCloud({ reportFailure: false });
 if (!result.ok && !Array.isArray(entriesCache)) entriesCache = [];
 reportRecordsLoaded = Boolean(result.ok);
 if (!result.ok) setStatus(entriesCache.length
  ? "Cloud unavailable — using cached report data."
  : "Report data could not be loaded. Check the connection and refresh.", true);
 return entriesCache;
}

async function appendEntryToCloud(entry) {
 const operationId = entry.operationId || generateOperationId("record");
 entry.operationId = operationId;
 entry.syncStatus = "pending";
 entry.syncError = "";
 entry.sheetRowIndex = null;

 const row = {
 "Operation ID": operationId,
 "Date": entry.date,
 "Age": entry.age,
 "Patient Name": entry.patientName,
 "Scan Type": entry.scanType,
 "2D Scan": entry.twoDScanType,
 "Purpose of CBCT": entry.cbctPurpose,
 "Scan Fees": entry.scanFees,
 "Radiologist Name": entry.radiologistName,
 "Radiologist Fees": entry.radiologistFees,
 "Referring Doctor": entry.refDoctor,
 "Consultation Fees": entry.consultationFees || 0,
 "Total Fees": entry.totalFees,
 "Phone": entry.phone || "",
 "Payment Method": entry.paymentMethod || "Cash",
 "Cash Amount": entry.cashAmount || 0,
 "Online Amount": entry.onlineAmount || 0
 };

 const mirror = readMirror(LS_RECORDS_KEY, []);
 if (!mirror.some(item => item.operationId === operationId)) mirror.unshift(entry);
 writeMirror(LS_RECORDS_KEY, mirror);
 entriesCache = [entry, ...(entriesCache || []).filter(item => item.operationId !== operationId)];
 window.entriesCache = entriesCache;

 const shouldSync = isCloudConfigured();
 window.RecordsPaging.queueRecordSave({
  enqueue: () => window.CloudOutbox.enqueue({
   operationId,
   kind: "record",
   mirrorKey: LS_RECORDS_KEY,
   payload: { op: "addRecord", operationId, row }
  }),
  sync: () => shouldSync ? syncCloudOutbox() : Promise.resolve(),
  refresh: () => shouldSync && recordsPager ? recordsPager.invalidate() : undefined,
  onError: error => console.warn("Background record sync failed:", error)
 });
 renderTable(entriesCache);

 if (!isCloudConfigured()) {
 setSyncStatus("pending", "Pending sync - saved locally");
 setStatus("Backend not configured - record saved locally and queued for sync.", true);
 return true;
 }

 // The durable local outbox is the save boundary for the UI. Cloud sync and
 // refreshing the visible page continue without keeping the form blocked.
 return true;
}

const adminOptionEditors = {
 scanTypes: {
 container: adminScanTypeRows,
 count: adminScanTypeCount,
 label: "Scan type",
 idPrefix: "scan-types",
 newValue: "New Scan Type"
 },
 twoDScanTypes: {
 container: adminTwoDScanTypeRows,
 count: adminTwoDScanTypeCount,
 label: "2D scan type",
 idPrefix: "two-d-scan-types",
 newValue: "New 2D Scan Type"
 },
 purposes: {
 container: adminPurposeRows,
 count: adminPurposeCount,
 label: "Purpose",
 idPrefix: "purposes",
 newValue: "New Purpose"
 }
};

function getAdminOptionValues(groupKey) {
 const editor = adminOptionEditors[groupKey];
 if (!editor?.container) return [];
 return window.AdminConfigEditor.normalizeOptionValues(
 Array.from(editor.container.querySelectorAll(".admin-option-input"), (input) => input.value)
 );
}

function renderAdminOptionEditor(groupKey, values) {
 const editor = adminOptionEditors[groupKey];
 if (!editor?.container) return;

 const normalizedValues = window.AdminConfigEditor.normalizeOptionValues(values);
 editor.container.innerHTML = window.AdminConfigEditor.buildOptionRows(
 normalizedValues,
 editor.label,
 editor.idPrefix
 );
 if (editor.count) {
 editor.count.textContent = `${normalizedValues.length} ${normalizedValues.length === 1 ? "option" : "options"}`;
 }
}

function setAdminSaveStatus(message, state = "neutral") {
 if (!adminSaveStatus) return;
 adminSaveStatus.textContent = message;
 adminSaveStatus.dataset.state = state;
}

function setAdminPasswordStatus(message, state = "neutral") {
 if (!adminPasswordStatus) return;
 adminPasswordStatus.textContent = message;
 adminPasswordStatus.dataset.state = state;
}

function resetAdminPasswordForm() {
 adminPasswordChangeForm?.reset();
 adminPasswordChangeForm?.querySelectorAll(".admin-password-toggle").forEach((button) => {
 const input = document.getElementById(button.dataset.passwordTarget || "");
 if (input) input.type = "password";
 button.textContent = "Show";
 button.setAttribute("aria-pressed", "false");
 button.setAttribute("aria-label", `Show ${button.dataset.passwordLabel || "password"}`);
 });
}

function renderAdminPanel() {
 renderAdminOptionEditor("scanTypes", appConfig.scanTypes);
 renderAdminOptionEditor("twoDScanTypes", appConfig.twoDScanTypes);
 renderAdminOptionEditor("purposes", appConfig.purposes);

 const normalizedScanTypes = appConfig.scanTypes.map(normalizeScanTypeName);
 radiologistRows.innerHTML = appConfig.radiologists
 .map((doctor, index) => {
 const fallbackFee = Number(doctor.fee || 0);
 const safeFallbackFee = Number.isFinite(fallbackFee) && fallbackFee >= 0 ? fallbackFee : 0;
 const sourcePricing = doctor.pricing && typeof doctor.pricing === "object" ? doctor.pricing : {};
 const pricing = {};

 normalizedScanTypes.forEach((scanType) => {
 const value = Number(sourcePricing[scanType]);
 pricing[scanType] = Number.isFinite(value) && value >= 0 ? value : safeFallbackFee;
 });

 return window.AdminConfigEditor.buildRadiologistCard(
 { ...doctor, fee: safeFallbackFee, pricing },
 normalizedScanTypes,
 index
 );
 })
 .join("");

 if (radiologistCount) {
 radiologistCount.textContent = `${appConfig.radiologists.length} ${appConfig.radiologists.length === 1 ? "radiologist" : "radiologists"}`;
 }
 resetAdminPasswordForm();
 setAdminPasswordStatus("Your password is never stored as readable text.");
 setAdminSaveStatus("Review the fields, then save your changes.");
}

function collectAdminConfigFromPanel() {
 const scanTypes = getAdminOptionValues("scanTypes");
 const twoDScanTypes = getAdminOptionValues("twoDScanTypes");
 const purposes = getAdminOptionValues("purposes");

 const rows = Array.from(radiologistRows.querySelectorAll(".admin-row"));
 const radiologists = rows
 .map((row) => {
 const name = row.querySelector(".admin-doctor-name").value.trim();
 const fee = Number(row.querySelector(".admin-doctor-fee").value || 0);

 const pricing = {};
 row.querySelectorAll(".admin-doctor-scan-fee").forEach((input) => {
 const scanType = normalizeScanTypeName(input.dataset.scanType || "");
 const value = Number(input.value || 0);
 pricing[scanType] = Number.isFinite(value) && value >= 0 ? value : 0;
 });

 return {
 name,
 fee: Number.isFinite(fee) && fee >= 0 ? fee : 0,
 pricing
 };
 })
 .filter((item) => item.name);

 if (scanTypes.length === 0) {
 return { error: "Scan Type list cannot be empty." };
 }
 if (twoDScanTypes.length === 0) {
 return { error: "2D Scan Type list cannot be empty." };
 }
 if (purposes.length === 0) {
 return { error: "Purpose list cannot be empty." };
 }
 if (radiologists.length === 0) {
 return { error: "At least one radiologist is required." };
 }

 const editableConfig = window.AdminConfigEditor.withPreservedReferringDoctors({
 scanTypes,
 twoDScanTypes,
 purposes,
 radiologists,
 doctorReferencePercentages: appConfig.doctorReferencePercentages || {},
 doctorReferencePercentageHistory: appConfig.doctorReferencePercentageHistory || {}
 }, appConfig, DEFAULT_REFERRING_DOCTORS);

 return window.AdminAuth.withPreservedCredential(editableConfig, appConfig);
}

function setAdminMode(enabled) {
 const wasAdminMode = isAdminMode;

 if (!enabled && window.APP_CONFIG?.DEMO_MODE !== true) doctorReferenceAccessUnlocked = false;

 if (enabled && !wasAdminMode) {
 const visiblePage = Array.from(document.querySelectorAll(".page-content")).find(
 (page) => window.getComputedStyle(page).display !== "none"
 );
 adminReturnPageId = visiblePage?.id || "scanPage";
 document.querySelectorAll(".page-content").forEach((page) => {
 page.style.display = "none";
 });
 scanPage.style.display = "block";
 }

 isAdminMode = enabled;
 document.body.classList.toggle("admin-mode", enabled);
 formSection.style.display = enabled ? "none" : "block";
 adminPanel.style.display = enabled ? "block" : "none";
 adminStatus.textContent = enabled ? "Admin Mode Active" : "";
 if (adminQuickLogoutBtn) adminQuickLogoutBtn.style.display = enabled ? "inline-flex" : "none";
 if (doctorReferenceAdminBtn) doctorReferenceAdminBtn.style.display = enabled ? "none" : "inline-flex";
 if (typeof renderDoctorReferenceReport === "function") renderDoctorReferenceReport();

 if (!enabled && wasAdminMode) {
 document.querySelectorAll(".page-content").forEach((page) => {
 page.style.display = "none";
 });
 const returnPage = document.getElementById(adminReturnPageId) || scanPage;
 returnPage.style.display = "block";
 document.querySelectorAll(".page-tab").forEach((tab) => {
 tab.classList.toggle("active", TAB_TO_PAGE[tab.dataset.page] === returnPage.id);
 });
 const recordsSection = document.getElementById("scanPageRecords");
 if (recordsSection) {
 recordsSection.style.display = returnPage.id === "scanPage" ? "block" : "none";
 }
 }
}

function showAdminModal(accessTarget = "global") {

 // Always show login view - password is hardcoded, no setup needed
 if (!adminModal) {
 console.error("Ã°Å¸â€Â ERROR: adminModal element not found!");
 void appDialog.notice({ title: "Admin access unavailable", message: "The admin access window could not be opened. Please reload the app and try again." });
 return;
 }

 adminModal.style.display = "flex";
 adminModal.setAttribute("aria-hidden", "false");
 adminLoginTarget = accessTarget === "doctorReference" ? "doctorReference" : "global";

 adminModalMsg.textContent = "";

 // Always use login mode (hardcoded password, no user setup)
 adminModalHint.textContent = "Enter admin password";
 adminLoginView.style.display = "block";
 adminPasswordInput.value = "";
 adminPasswordInput.focus();

}

function hideAdminModal() {
 adminModal.style.display = "none";
}

scanForm.addEventListener("submit", async (event) => {
 event.preventDefault();

 // Guard against double-submit (button click + Enter key)
 if (isSubmitting) return;

 normalizeScanFees();
 calculateTotalFees();

 const submitBtn = document.getElementById("submitBtn");
 const selectedScanTypes = getSelectedScanTypes();
 const selectedTwoDScanTypes = getSelectedTwoDScanTypes();
 const selectedPurposes = getSelectedPurposes();

 // 1. Field-level validation
 const finalRefDoctorValue = (refDoctorInput ? refDoctorInput.value : "").trim();
 if (!finalRefDoctorValue) {
 setStatus("Please select or type a referring doctor.", true);
 refDoctorInput && refDoctorInput.focus();
 return;
 }

 const age = toNumber(patientAgeInput.value, { min: 1, fallback: 0 });
 if (age <= 0 || age > 150) {
 setStatus("Please enter a valid age (1 - 150).", true);
 patientAgeInput && patientAgeInput.focus();
 return;
 }

 const patientName = patientNameInput.value.trim();
 if (!patientName) {
 setStatus("Please enter the patient name.", true);
 patientNameInput && patientNameInput.focus();
 return;
 }

 if (!dateInput.value) {
 setStatus("Please select the scan date.", true);
 dateInput && dateInput.focus();
 return;
 }

 if (selectedScanTypes.length === 0 && selectedTwoDScanTypes.length === 0) {
 setStatus("Please select at least one scan type (3D CBCT or 2D).", true);
 return;
 }

 if (!radiologistNameSelect.value.trim()) {
 setStatus("Please select a radiologist (or 'Not Applicable').", true);
 radiologistNameSelect && radiologistNameSelect.focus();
 return;
 }

 // Purposes are required only when a CBCT (3D) scan type is selected.
 if (selectedScanTypes.length > 0 && selectedPurposes.length === 0) {
 setStatus("Please select at least one purpose of CBCT.", true);
 return;
 }

 const consultationFeesInput = document.getElementById("consultationFees");
 const phoneRaw = patientPhoneInput ? patientPhoneInput.value.trim() : "";
 const phone = phoneRaw.replace(/\D/g, "").slice(0, 10);
 const payment = window.PaymentMethods.normalizePaymentBreakdown({
 totalFees: totalFeesInput.value,
 paymentType: getSelectedPaymentType(),
 cashAmount: cashAmountInput?.value,
 onlineAmount: onlineAmountInput?.value
 });
 if (!payment.ok) {
 setStatus(payment.message, true);
 cashAmountInput?.focus();
 return;
 }

 const entry = {
 date: dateInput.value,
 age: Math.trunc(age),
 patientName,
 phone,
 scanType: selectedScanTypes.join(", "),
 twoDScanType: selectedTwoDScanTypes.join(", "),
 cbctPurpose: selectedPurposes.join(", "),
 scanFees: Math.trunc(toNumber(scanFeesInput.value)),
 radiologistName: radiologistNameSelect.value.trim(),
 radiologistFees: toNumber(radiologistFeesInput.value),
 refDoctor: finalRefDoctorValue,
 consultationFees: Math.trunc(toNumber(consultationFeesInput ? consultationFeesInput.value : 0)),
 totalFees: toNumber(totalFeesInput.value),
 paymentMethod: payment.paymentMethod,
 cashAmount: payment.cashAmount,
 onlineAmount: payment.onlineAmount
 };

 const releaseSubmission = recordSubmissionGate?.acquire();
 if (recordSubmissionGate && !releaseSubmission) return;
 isSubmitting = true;
 if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = editingRowIndex !== null ? "Updating..." : "Saving..."; }

 try {
 // 2. Duplicate detection uses a targeted cloud check rather than requiring
 // every record to be downloaded. Unknown/offline checks warn but don't block.
 if (editingRowIndex === null) {
 const check = await window.RecordsPaging.checkRecordDuplicate({
 entry,
 records: [...(entriesCache || []), ...(_tableEntries || [])],
 cloudGet,
 cloudConfigured: isCloudConfigured(),
 online: navigator.onLine !== false
 });
 if (!check.verified) {
 setStatus("Could not verify duplicates with cloud; saving is still available.", true);
 }
 if (check.duplicate) {
 const proceed = await appDialog.confirm({
 title: "Possible duplicate record",
 message: `A record for "${entry.patientName}" on ${formatDateDisplay(entry.date)} already exists.\n\nClick Save anyway to save it as a new record, or Cancel to review.`,
 confirmLabel: "Save anyway"
 });
 if (!proceed) {
 setStatus("Duplicate detected - submission cancelled.", true);
 return;
 }
 }
 }

 // 3. Save or Update
 if (editingRowIndex !== null) {
 const success = await updateEntryInCloud(editingRowIndex, entry);
 if (!success) return;

 if (recordsPager) await recordsPager.invalidate();

 const cachedIdx = entriesCache.findIndex(e => e.sheetRowIndex === editingRowIndex);
 if (cachedIdx !== -1) {
 entriesCache[cachedIdx] = { ...entriesCache[cachedIdx], ...entry };
 window.entriesCache = entriesCache;
 renderTable(entriesCache);
 }
 setStatus("Record updated successfully.", false);
 cancelEditMode();
 } else {
 const saved = await appendEntryToCloud(entry);
 if (!saved) return;

 populateRefDoctorSelect(); // pick up any newly-typed doctor name
 if (typeof renderDoctorReferenceReport === "function") renderDoctorReferenceReport();
 if (typeof renderMonthlyCollection === "function") renderMonthlyCollection();

 setStatus(entry.syncStatus === "synced"
 ? "Record saved successfully."
 : "Record saved locally and queued for cloud sync.", entry.syncStatus !== "synced");
 resetFormForNextEntry();
 }
 } finally {
 isSubmitting = false;
 releaseSubmission?.();
 if (submitBtn) {
 submitBtn.disabled = false;
 submitBtn.textContent = editingRowIndex !== null ? "Update Entry" : "Submit";
 }
 }
});

scanFeesInput.addEventListener("input", () => {
 normalizeScanFees();
 calculateTotalFees();
});
scanFeesInput.addEventListener("blur", normalizeScanFees);
radiologistNameSelect.addEventListener("change", applyRadiologistFees);
radiologistFeesInput.addEventListener("input", calculateTotalFees);
paymentTypeInputs.forEach((input) => input.addEventListener("change", syncPaymentMethodFields));
syncPaymentMethodFields();

// Re-calculate Total Fees whenever Consultation Fees changes
{
 const _consultFees = document.getElementById("consultationFees");
 if (_consultFees) _consultFees.addEventListener("input", calculateTotalFees);
}

if (clearBtn) {
 clearBtn.addEventListener("click", () => {
 resetFormForNextEntry();
 setStatus("Form cleared.", false);
 });
}

if (refreshBtn) {
 refreshBtn.addEventListener("click", async () => {
 const recovery = initializeSyncRecovery();
 if (!recovery) {
  setStatus("Cloud recovery could not start. Reload the app or contact support.", true);
  return;
 }
 fullRefreshPromise = recovery.requestRefresh("manual");
 try {
  const result = await fullRefreshPromise;
  const recordsSection = document.getElementById("scanPageRecords");
  if (recordsSection?.style.display !== "none" && recordsPager) await recordsPager.refresh();
  const activePage = document.querySelector(".page-content[style*='display: block']");
  if (activePage && activePage.id !== "scanPage" && activePage.id !== "expensePage") {
   reportRecordsLoaded = false;
   await ensureReportRecordsLoaded();
  } else if (activePage?.id === "expensePage") {
   await window.ensureExpensesLoaded?.({ refresh: true });
  }
  return result;
 }
 finally { fullRefreshPromise = null; }
 });
}


if (adminAccessBtn) {
 adminAccessBtn.addEventListener("click", showAdminModal);
} else {
 console.error("Ã°Å¸â€Â ERROR: adminAccessBtn is null!");
}

adminModalCloseBtn.addEventListener("click", hideAdminModal);

if (adminPasswordInput && adminLoginSubmitBtn) {
 adminPasswordInput.addEventListener("keydown", (event) => {
 if (event.key === "Enter") {
 event.preventDefault();
 adminLoginSubmitBtn.click();
 }
 });
}

adminLoginSubmitBtn.addEventListener("click", async () => {
 const input = adminPasswordInput.value || "";

 adminLoginSubmitBtn.disabled = true;
 adminLoginSubmitBtn.textContent = "Verifying...";
 adminModalMsg.textContent = "";

 try {
 // Keep the cached-first check for responsive offline UX and backward
 // compatibility. A successful online login still requires the gateway's
 // server-side challenge/proof session below.
 let isValid = await window.AdminAuth.verifyPassword(input, appConfig.adminCredential);
 if (!isValid && isCloudConfigured()) {
 await loadConfigFromCloud();
 isValid = await window.AdminAuth.verifyPassword(input, appConfig.adminCredential);
 }
 if (isCloudConfigured() && getScriptUrl().startsWith("/")) {
 const session = await gatewaySessionClient.login(input);
 cloudClient.setAdminSessionToken(session.sessionToken);
 isValid = true;
 } else {
 isValid = await window.AdminAuth.verifyPassword(input, appConfig.adminCredential);
 }

 if (!isValid) {
 adminModalMsg.textContent = "Invalid admin password.";
 adminPasswordInput.value = "";
 adminPasswordInput.focus();
 return;
 }

 if (adminLoginTarget === "doctorReference" && !isAdminMode) {
 doctorReferenceAccessUnlocked = true;
 hideAdminModal();
 await ensureReportRecordsLoaded();
 renderDoctorReferenceReport();
 return;
 }

 setAdminMode(true);
 renderAdminPanel();
 hideAdminModal();
 if (adminReturnPageId === "doctorReferencePage") {
 document.getElementById("tabDoctorReference")?.click();
 }
 setStatus("Admin mode enabled.", false);
 } catch (error) {
 console.error("Admin password verification failed:", error);
 adminModalMsg.textContent = "Could not verify the admin password. Please try again.";
 } finally {
 adminLoginSubmitBtn.disabled = false;
 adminLoginSubmitBtn.textContent = "Login";
 }
});

adminLogoutBtn.addEventListener("click", () => {
 setAdminMode(false);
 cloudClient.clearAdminSessionToken();
 setStatus("Admin mode disabled.", false);
});

if (adminQuickLogoutBtn) {
 adminQuickLogoutBtn.addEventListener("click", () => {
 setAdminMode(false);
 cloudClient.clearAdminSessionToken();
 setStatus("Admin mode disabled.", false);
 });
}

if (doctorReferenceAdminBtn) {
 doctorReferenceAdminBtn.addEventListener("click", () => {
 if (window.APP_CONFIG?.DEMO_MODE) {
 doctorReferenceAccessUnlocked = !doctorReferenceAccessUnlocked;
 renderDoctorReferenceReport();
 return;
 }
 if (doctorReferenceAccessUnlocked && !isAdminMode) {
 doctorReferenceAccessUnlocked = false;
 renderDoctorReferenceReport();
 return;
 }
 showAdminModal("doctorReference");
 });
}

addRadiologistBtn.addEventListener("click", () => {
 const index = radiologistRows.querySelectorAll(".admin-row").length;
 const scanTypes = getAdminOptionValues("scanTypes").map(normalizeScanTypeName);
 radiologistRows.insertAdjacentHTML(
 "beforeend",
 window.AdminConfigEditor.buildRadiologistCard(
 { name: "", fee: 0, pricing: {} },
 scanTypes,
 index
 )
 );
 if (radiologistCount) {
 const total = index + 1;
 radiologistCount.textContent = `${total} ${total === 1 ? "radiologist" : "radiologists"}`;
 }
 const newNameInput = radiologistRows.lastElementChild?.querySelector(".admin-doctor-name");
 newNameInput?.focus();
});

radiologistRows.addEventListener("click", (event) => {
 if (!event.target.classList.contains("admin-remove-radiologist")) {
 return;
 }
 event.target.closest(".admin-row").remove();
 const total = radiologistRows.querySelectorAll(".admin-row").length;
 if (radiologistCount) {
 radiologistCount.textContent = `${total} ${total === 1 ? "radiologist" : "radiologists"}`;
 }
 setAdminSaveStatus("Radiologist removed. Save to apply this change.", "pending");
});

adminPanel.addEventListener("click", (event) => {
 const passwordToggle = event.target.closest(".admin-password-toggle");
 if (passwordToggle) {
 const input = document.getElementById(passwordToggle.dataset.passwordTarget || "");
 if (!input) return;

 const willShow = input.type === "password";
 input.type = willShow ? "text" : "password";
 passwordToggle.textContent = willShow ? "Hide" : "Show";
 passwordToggle.setAttribute("aria-pressed", String(willShow));
 passwordToggle.setAttribute(
 "aria-label",
 `${willShow ? "Hide" : "Show"} ${passwordToggle.dataset.passwordLabel || "password"}`
 );
 return;
 }

 const addButton = event.target.closest("[data-admin-option-add]");
 if (addButton) {
 const groupKey = addButton.dataset.adminOptionAdd;
 const editor = adminOptionEditors[groupKey];
 if (!editor) return;

 const values = getAdminOptionValues(groupKey);
 values.push(editor.newValue);
 renderAdminOptionEditor(groupKey, values);
 const newInput = editor.container.lastElementChild?.querySelector(".admin-option-input");
 newInput?.focus();
 newInput?.select();
 setAdminSaveStatus("New option added. Edit it, then save your changes.", "pending");
 return;
 }

 const removeButton = event.target.closest(".admin-option-remove");
 if (!removeButton) return;

 const list = removeButton.closest(".admin-option-list");
 const groupKey = list?.dataset.optionGroup;
 const editor = adminOptionEditors[groupKey];
 if (!editor) return;

 removeButton.closest(".admin-option-row")?.remove();
 renderAdminOptionEditor(groupKey, getAdminOptionValues(groupKey));
 setAdminSaveStatus("Option removed. Save to apply this change.", "pending");
});

adminPasswordChangeForm.addEventListener("submit", async (event) => {
 event.preventDefault();

 if (!isAdminMode) {
 setAdminPasswordStatus("Admin login required.", "error");
 return;
 }

 const values = {
 currentPassword: adminCurrentPassword.value,
 newPassword: adminNewPassword.value,
 confirmPassword: adminConfirmPassword.value,
 };
 const validation = window.AdminAuth.validatePasswordChange(values);
 if (!validation.ok) {
 setAdminPasswordStatus(validation.message, "error");
 document.getElementById({
 currentPassword: "adminCurrentPassword",
 newPassword: "adminNewPassword",
 confirmPassword: "adminConfirmPassword",
 }[validation.field])?.focus();
 return;
 }

 changeAdminPasswordBtn.disabled = true;
 changeAdminPasswordBtn.setAttribute("aria-busy", "true");
 changeAdminPasswordBtn.textContent = "Updating...";
 setAdminPasswordStatus("Verifying the current password...", "pending");

 try {
 const ready = await ensureCloudAccess(true);
 if (!ready) {
 setAdminPasswordStatus("Connect to the configured Google Sheets backend, then try again.", "error");
 return;
 }

 const currentPasswordValid = await window.AdminAuth.verifyPassword(
 values.currentPassword,
 appConfig.adminCredential
 );
 if (!currentPasswordValid) {
 setAdminPasswordStatus("Current admin password is incorrect.", "error");
 return;
 }

 setAdminPasswordStatus("Securing and syncing the new password...", "pending");
 const adminCredential = await window.AdminAuth.createPasswordCredential(values.newPassword);
 const nextConfig = normalizeConfig({ ...appConfig, adminCredential });
 const nextVersion = generateConfigVersion();

 await cloudPost({ op: "saveConfig", config: nextConfig, version: nextVersion });

 appConfig = normalizeConfig(nextConfig);
 window.appConfig = appConfig;
 cloudConfigVersion = nextVersion;
 localStorage.setItem(CONFIG_VERSION_KEY, nextVersion);
 writeMirror(LS_CONFIG_KEY, { config: appConfig, version: nextVersion });

 resetAdminPasswordForm();
 setAdminPasswordStatus("Password updated and synced to every clinic computer.", "success");
 } catch (error) {
 console.error("Admin password update failed:", error);
 setAdminPasswordStatus("Password could not be updated. Check the connection and try again.", "error");
 } finally {
 changeAdminPasswordBtn.disabled = false;
 changeAdminPasswordBtn.removeAttribute("aria-busy");
 changeAdminPasswordBtn.textContent = "Update Password";
 }
});

saveAdminConfigBtn.addEventListener("click", async () => {
 if (!isAdminMode) {
 setStatus("Admin login required.", true);
 setAdminSaveStatus("Admin login required.", "error");
 return;
 }

 const collected = collectAdminConfigFromPanel();
 if (collected.error) {
 setStatus(collected.error, true);
 setAdminSaveStatus(collected.error, "error");
 return;
 }

 appConfig = normalizeConfig(collected);
 window.appConfig = appConfig;

 saveAdminConfigBtn.disabled = true;
 saveAdminConfigBtn.textContent = "Saving...";
 setAdminSaveStatus("Saving configuration...", "pending");

 const ready = await ensureCloudAccess(true);
 if (!ready) {
 setStatus("Sign in to Google first, then save admin changes.", true);
 setAdminSaveStatus("Sign in to Google first, then save admin changes.", "error");
 saveAdminConfigBtn.disabled = false;
 saveAdminConfigBtn.textContent = "Save Admin Changes";
 return;
 }

 try {
 const nextVersion = generateConfigVersion();
 // Use the hardcoded password hash (password is fixed, not user-changeable)
 await saveConfigToCloud(appConfig, "", nextVersion);
 cloudConfigVersion = nextVersion;
 localStorage.setItem(CONFIG_VERSION_KEY, nextVersion);

 renderScanTypeOptions();
 renderTwoDScanOptions();
 renderPurposeOptions();
 renderRadiologistOptions();
 renderReferringDoctorOptions();
 applyRadiologistFees();

 setStatus("Admin configuration saved successfully.", false);
 setAdminSaveStatus("Admin configuration saved successfully.", "success");
 } catch (error) {
 console.error("Error saving config:", error);
 setStatus("Failed to save admin configuration. Please try again.", true);
 setAdminSaveStatus("Failed to save admin configuration. Please try again.", "error");
 } finally {
 saveAdminConfigBtn.disabled = false;
 saveAdminConfigBtn.textContent = "Save Admin Changes";
 }
});

function initialize() {

 // Detect file:// - fetch() is blocked by the browser in this mode
 if (window.location.protocol === "file:") {
 setStatus(
 "Opened as a local file - Google Sheets sync is blocked. " +
 "Double-click app.bat (or run: npm start) to open at http://localhost:3000.",
 true
 );
 // Still render the UI with defaults so form is usable
 }

 // Ensure appConfig is properly initialized
 appConfig = normalizeConfig(window.APP_CONFIG?.CLINIC_CONFIG || DEFAULT_CONFIG);
 window.appConfig = appConfig;

 // Verify all properties exist and have content
 if (!appConfig.scanTypes || appConfig.scanTypes.length === 0) {
 appConfig.scanTypes = DEFAULT_CONFIG.scanTypes;
 }
 if (!appConfig.twoDScanTypes || appConfig.twoDScanTypes.length === 0) {
 appConfig.twoDScanTypes = DEFAULT_CONFIG.twoDScanTypes;
 }
 if (!appConfig.purposes || appConfig.purposes.length === 0) {
 appConfig.purposes = DEFAULT_CONFIG.purposes;
 }
 if (!appConfig.radiologists || appConfig.radiologists.length === 0) {
 appConfig.radiologists = DEFAULT_CONFIG.radiologists;
 }
 if (!appConfig.referringDoctors || appConfig.referringDoctors.length === 0) {
 appConfig.referringDoctors = DEFAULT_REFERRING_DOCTORS;
 }


 // Now render all options
 renderScanTypeOptions();
 renderTwoDScanOptions();
 renderPurposeOptions();
 renderRadiologistOptions();
 renderReferringDoctorOptions();

 setDefaultDate(true);
 totalFeesInput.value = "0.00";
 setAdminMode(false);
 renderTable();

 // Cached-first loaders and cloud recovery are coordinated through one scheduler.
 initializeSyncRecovery();
}

// ============================================================================
// BILL GENERATION FUNCTIONALITY
// ============================================================================

const billDateInput = document.getElementById("billDate");
const billStatusMsg = document.getElementById("billStatusMsg");
const billListSection = document.getElementById("billListSection");
const billListBody = document.getElementById("billListBody");
const billListDate = document.getElementById("billListDate");

function setBillStatus(message, isError) {
 billStatusMsg.textContent = message;
 billStatusMsg.style.color = isError ? "#b91c1c" : "#065f46";
}

// Load patients for the selected date and render the list
function loadBillPatients(date) {
 if (!date) return;

 const today = getTodayDateValue();
 const isFuture = date > today;
 const records = entriesCache || [];
 const filtered = records.filter(r => normalizeDate(r.date) === date);

 billListDate.textContent = new Date(date + "T00:00:00")
 .toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });

 // Decide the right empty-state message instead of a generic "no patients"
 if (filtered.length === 0) {
 let msg;
 if (isFuture) {
 msg = "Ã°Å¸â€œâ€¦ That date is in the future. Bills can only be generated for today or earlier dates.";
 } else if (!isCloudConfigured()) {
 msg = "Cloud endpoint is not configured for this environment. See the setup documentation.";
 } else if (records.length === 0) {
 msg = "Loading records from Google Sheets... please wait.";
 } else {
 msg = `No patients found on ${formatDateDisplay(date)}. Try another date.`;
 }
 billStatusMsg.textContent = msg;
 billStatusMsg.style.color = "#b91c1c";
 billListSection.style.display = "none";
 window._billDayRecords = [];
 return;
 }

 billStatusMsg.textContent = ` ${filtered.length} patient(s) found on ${formatDateDisplay(date)}.`;
 billStatusMsg.style.color = "#065f46";

 billListBody.innerHTML = filtered.map((record, i) => `
 <tr>
 <td>${i + 1}</td>
 <td class="col-name-val"title="${escapeHtml(record.patientName)}">${escapeHtml(record.patientName)}</td>
 <td>${escapeHtml(String(record.age || "-"))}</td>
 <td title="${escapeHtml(record.scanType || "-")}">${escapeHtml(record.scanType || "-")}</td>
 <td title="${escapeHtml(record.twoDScanType || "-")}">${escapeHtml(record.twoDScanType || "-")}</td>
 <td title="${escapeHtml(record.refDoctor || "-")}">${escapeHtml(record.refDoctor || "-")}</td>
 <td class="r">${formatMoney(record.scanFees)}</td>
 <td class="r total-val">${formatMoney(record.totalFees, true)}</td>
 <td class="c"><button class="btn-print-patient"onclick="printPatientBill(${i})">Print</button></td>
 </tr>
 `).join("");

 // Store filtered for print access
 window._billDayRecords = filtered;
 billListSection.style.display = "block";
}

// Print individual patient bill in a new window
async function printPatientBill(index) {
 const record = window._billDayRecords[index];
 if (!record) return;

 const scanFees = Number(record.scanFees || 0);
 const consultFees = Number(record.consultationFees || 0);
 const radFees = Number(record.radiologistFees || 0);
 const total = Number(record.totalFees || 0);

 // Fix date - normalize first to YYYY-MM-DD then format
 const normalizedDate = normalizeDate(record.date);
 const dateObj = new Date(normalizedDate + "T00:00:00");
 const dateStr = isNaN(dateObj)
 ? record.date
 : dateObj.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });

 const scanType = escapeHtml(record.scanType || "");
 const twoDScan = escapeHtml(record.twoDScanType || "");
 const purpose = escapeHtml(record.cbctPurpose || "");
 const radiologist = escapeHtml(record.radiologistName || "Not Applicable");
 const refDoctor = escapeHtml(record.refDoctor || "-");

  const printing = window.APP_CONFIG?.CLINIC_PRINTING || {};
  const printClinicName = escapeHtml(printing.name || window.APP_CONFIG?.CLINIC_NAME || "DocCare Pro");
  const printSubtitle = escapeHtml(printing.subtitle || "Diagnostic Imaging");
  const printAddress = escapeHtml(printing.address || "");
  const printHours = escapeHtml(printing.hours || "");
  const printSignature = escapeHtml(printing.signature || (window.APP_CONFIG?.DEMO_MODE ? "Demo Staff" : ""));

  const html = `<!DOCTYPE html>
<html>
<head>
 <meta charset="UTF-8"/>
 <title>Bill - ${record.patientName}</title>
 <style>
 * { box-sizing: border-box; margin: 0; padding: 0; }
 body { font-family: "Times New Roman", Times, serif; background: #fff; color: #000; font-size: 13px; }
 .page { max-width: 700px; margin: 0 auto; padding: 30px 36px; }

 /* Header */
 .header { text-align: center; padding-bottom: 14px; margin-bottom: 18px; border-bottom: 3px solid #000; }
 .clinic-name { font-size: 24px; font-weight: 900; letter-spacing: 2px; text-transform: uppercase; font-family: "Segoe UI", Arial, sans-serif; }
 .clinic-sub { font-size: 12px; font-weight: 700; margin-top: 2px; letter-spacing: 1px; text-transform: uppercase; }
 .divider-thin { border: none; border-top: 1px solid #000; margin: 6px auto; width: 60%; }
 .clinic-addr { font-size: 11px; color: #333; margin-top: 4px; line-height: 1.7; }
 .bill-label {
 display: inline-block; margin-top: 10px;
 border: 2px solid #000;
 font-size: 11px; font-weight: 800; letter-spacing: 4px;
 padding: 4px 22px; text-transform: uppercase;
 font-family: "Segoe UI", Arial, sans-serif;
 }

 /* Info row (single line) */
 .info-row {
 display: flex; gap: 0;
 border: 1.5px solid #000;
 margin-bottom: 18px;
 }
 .info-cell {
 flex: 1;
 padding: 9px 14px;
 border-right: 1px solid #000;
 }
 .info-cell:last-child { border-right: none; }
 .info-cell.wide { flex: 2; }
 .info-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #555; font-family: "Segoe UI", Arial, sans-serif; }
 .info-value { font-size: 13px; font-weight: 700; color: #000; margin-top: 3px; }

 /* Table */
 table { width: 100%; border-collapse: collapse; margin-bottom: 0; font-size: 13px; }
 thead tr { background: #000; }
 th { padding: 10px 14px; text-align: left; color: #fff; font-weight: 700; font-size: 11px; letter-spacing: 0.8px; text-transform: uppercase; font-family: "Segoe UI", Arial, sans-serif; }
 th.r { text-align: right; }
 td { padding: 10px 14px; border-bottom: 1px solid #ccc; vertical-align: middle; }
 td.r { text-align: right; }
 tbody tr:last-child td { border-bottom: 2px solid #000; }
 tbody tr:nth-child(even) td { background: #f7f7f7; }

 /* Total row */
 .total-row td {
 background: #000 !important;
 color: #fff;
 font-weight: 800;
 font-size: 14px;
 padding: 12px 14px;
 border: none;
 font-family: "Segoe UI", Arial, sans-serif;
 }

 /* Bottom section */
 .bottom { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 32px; }
 .note { font-size: 10px; color: #555; font-style: italic; line-height: 1.8; }
 .sig-box { text-align: center; width: 170px; }
 .sig-space { height: 44px; }
 .sig-line { border-top: 1.5px solid #000; margin-bottom: 5px; }
 .sig-label { font-size: 10px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; font-family: "Segoe UI", Arial, sans-serif; }

 @media print {
 @page { margin: 12mm 14mm; }
 body { font-size: 12px; }
 .page { padding: 0; max-width: 100%; }
 }
 </style>
</head>
<body>
<div class="page">

 <!-- HEADER -->
 <div class="header">
 <div class="clinic-name">${printClinicName}</div>
 <div class="clinic-sub">${printSubtitle}</div>
 <hr class="divider-thin"/>
 <div class="clinic-addr">${printAddress}${printHours ? `&nbsp;&nbsp;|&nbsp;&nbsp; ${printHours}` : ""}</div>
 <div class="bill-label">Receipt / Bill</div>
 </div>

 <!-- PATIENT INFO -->
 <div class="info-row">
 <div class="info-cell wide">
 <div class="info-label">Patient Name</div>
 <div class="info-value">${escapeHtml(record.patientName)}</div>
 </div>
 <div class="info-cell">
 <div class="info-label">Age</div>
 <div class="info-value">${escapeHtml(String(record.age || " -"))} yrs</div>
 </div>
 ${record.phone ? `<div class="info-cell">
 <div class="info-label">Phone</div>
 <div class="info-value">${escapeHtml(record.phone)}</div>
 </div>` : ""}
 <div class="info-cell">
 <div class="info-label">Date</div>
 <div class="info-value">${dateStr}</div>
 </div>
 </div>
 <div class="info-row"style="margin-bottom:22px">
 <div class="info-cell wide">
 <div class="info-label">Referring Doctor</div>
 <div class="info-value">${refDoctor}</div>
 </div>
 ${purpose ? `<div class="info-cell wide"><div class="info-label">Purpose of CBCT</div><div class="info-value">${purpose}</div></div>` : `<div class="info-cell wide"><div class="info-label">Radiologist</div><div class="info-value">${radiologist}</div></div>`}
 </div>

 <!-- CHARGES TABLE -->
 <table>
 <thead>
 <tr>
 <th style="width:5%">#</th>
 <th style="width:45%">Description</th>
 <th style="width:30%">Details</th>
 <th class="r"style="width:20%">Amount ()</th>
 </tr>
 </thead>
 <tbody>
 ${scanType ? `<tr>
 <td>1</td>
 <td>3D Scan (CBCT)</td>
 <td>${scanType}</td>
 <td class="r"> ${Math.trunc(scanFees).toLocaleString("en-IN")}</td>
 </tr>` : ""}
 ${twoDScan ? `<tr>
 <td>${scanType ? "2" : "1"}</td>
 <td>2D Scan</td>
 <td>${twoDScan}</td>
 <td class="r"style="color:#555">Included</td>
 </tr>` : ""}
 ${consultFees > 0 ? `<tr>
 <td>${[scanType, twoDScan].filter(Boolean).length + 1}</td>
 <td>Consultation Charges</td>
 <td>-</td>
 <td class="r"> ${consultFees.toLocaleString("en-IN")}</td>
 </tr>` : ""}
 </tbody>
 <tfoot>
 <tr class="total-row">
 <td colspan="3">Total Amount Payable</td>
 <td class="r"> ${total.toLocaleString("en-IN", {minimumFractionDigits:2})}</td>
 </tr>
 </tfoot>
 </table>

 <!-- BOTTOM -->
 <div class="bottom">
 <div class="note">
 * This is a computer-generated receipt.<br>
 * Generated on: ${new Date().toLocaleString("en-IN")}<br>
 * Thank you for choosing ${window.APP_CONFIG?.CLINIC_NAME || "DocCare Pro"}.
 </div>
 <div class="sig-box">
 <div class="sig-space"></div>
 <div class="sig-line"></div>
 <div class="sig-label">${printSignature}</div>
 </div>
 </div>

</div>
<script>window.onload = function(){ window.print(); }; window.addEventListener('afterprint', function(){ setTimeout(function(){ window.close(); }, 200); });<\/script>
</body>
</html>`;

 const win = window.open("", "_blank");
 if (!win) {
 await appDialog.notice({ title: "Could not open bill", message: "The bill window could not be opened. Please allow pop-ups for this app and try again." });
 return;
 }
 win.document.write(html);
 win.document.close();
}

// Init bill tab - always default to today, cap to today, and load patients
function initBillPageTab() {
 if (!billDateInput) return;
 const today = getTodayDateValue();
 billDateInput.value = today;
 billDateInput.max = today; // no future-date selections
 loadBillPatients(today);
}

// When date changes, validate range and auto-reload patients
if (billDateInput) {
 const today = getTodayDateValue();
 billDateInput.value = today;
 billDateInput.max = today;
 billDateInput.addEventListener("change", () => {
 if (!billDateInput.value) return;
 // Clamp to today if user manually types a future date
 if (billDateInput.value > today) {
 billDateInput.value = today;
 }
 loadBillPatients(billDateInput.value);
 });
}

// ============================================================================
// DOCTOR DETAILS FUNCTIONALITY
// ============================================================================

const doctorSelectInput = document.getElementById("doctorSelectInput"); // hidden value holder
const doctorFromDate = document.getElementById("doctorFromDate");
const doctorToDate = document.getElementById("doctorToDate");
const doctorStatusMsg = document.getElementById("doctorStatusMsg");
const doctorSummaryRow = document.getElementById("doctorSummaryRow");
const doctorPatientsSection = document.getElementById("doctorPatientsSection");
const doctorPatientsBody = document.getElementById("doctorPatientsBody");
const doctorPatientsTitle = document.getElementById("doctorPatientsTitle");

function initDoctorPageTab() {
 // Reset the searchable autocomplete input and hidden value when tab is opened
 const searchInput = document.getElementById("doctorSearchInput");
 if (searchInput) searchInput.value = "";
 if (doctorSelectInput) doctorSelectInput.value = "";

 // Default date range: from 3 months ago today
 const today = getTodayDateValue();
 const now = new Date();
 const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
 const fromY = threeMonthsAgo.getFullYear();
 const fromM = String(threeMonthsAgo.getMonth() + 1).padStart(2, "0");
 doctorFromDate.value = `${fromY}-${fromM}-01`;
 doctorToDate.value = today;

 // Wire up the autocomplete widget (safe to call multiple times)
 initDoctorPageAutocomplete();
}

/** Searchable fuzzy-autocomplete for the Doctor Details page doctor picker. */
function initDoctorPageAutocomplete() {
 const input = document.getElementById("doctorSearchInput");
 const dropdown = document.getElementById("doctorSearchDropdown");
 const hidden = document.getElementById("doctorSelectInput");
 const arrowBtn = document.getElementById("doctorSearchArrow");
 const clearBtn = document.getElementById("doctorSearchClear");
 if (!input || !dropdown || !hidden) return;

 // Prevent double-binding
 if (input._docPageAcBound) return;
 input._docPageAcBound = true;

 let activeIdx = -1;
 let showingAll = false;

 function updateClearBtn() {
 if (clearBtn) {
 clearBtn.style.display = input.value.trim() ? "flex" : "none";
 }
 }

 function closeDropdown() {
 dropdown.style.display = "none";
 input.setAttribute("aria-expanded", "false");
 activeIdx = -1;
 showingAll = false;
 }

 function renderDropdown(forceAll) {
 const doctors = buildFullDoctorList();
 let items;
 const query = input.value.trim();
 if (forceAll || !query) {
 // Show all doctors alphabetically when arrow clicked or empty
 items = doctors.map(name => ({ name, score: 1 }));
 } else {
 items = getSimilarDoctors(query, doctors);
 }
 updateClearBtn();

 const optionsHtml = items.map((item, i) => {
 const isClose = item.score >= 0.85;
 const highlightedName = highlightMatch(item.name, forceAll ? "" : query);
 return `<div class="ref-ac-option${isClose ? "" : "ac-fuzzy"}"data-value="${escapeHtml(item.name)}"data-idx="${i}"role="option"aria-selected="false"id="docPageOpt-${i}">
 <span class="ref-ac-name">${highlightedName}</span>
 ${isClose ? "" : '<span class="ac-badge">Similar spelling</span>'}
 </div>`;
 }).join("");

 const headerLabel = forceAll || !query
 ? `All referring doctors`
 : `${items.length} match${items.length === 1 ? "" : "es"}`;
 const headerHtml = `<div class="ref-ac-header">
 <span class="ref-ac-header-label">${escapeHtml(headerLabel)}</span>
 <span class="ref-ac-count">${items.length}</span>
 </div>`;

 const emptyHtml = `<div class="ref-ac-empty">
 <span class="ref-ac-empty-title">No matching doctor</span>
 <span class="ref-ac-empty-hint">Type or select another name.</span>
 </div>`;

 const scrollListHtml = `<div class="ref-ac-scroll-list"role="presentation">${optionsHtml || emptyHtml}</div>`;

 const footerHtml = `<div class="ref-ac-footer">
 <button type="button"class="ref-ac-manage-option"id="docPageManageOpt">
 <span>Edit</span>
 </button>
 </div>`;

 dropdown.innerHTML = headerHtml + scrollListHtml + footerHtml;

 dropdown.style.display = "block";
 input.setAttribute("aria-expanded", "true");
 activeIdx = -1;

 dropdown.querySelectorAll(".ref-ac-option").forEach(opt => {
 opt.addEventListener("mousedown", e => {
 e.preventDefault();
 selectDoctor(opt.dataset.value);
 });
 });

 const manageBtn = dropdown.querySelector("#docPageManageOpt");
 if (manageBtn) {
 manageBtn.addEventListener("mousedown", e => {
 e.preventDefault();
 closeDropdown();
 openDoctorManageModal();
 });
 }
 }

 function selectDoctor(name) {
 input.value = name;
 hidden.value = name;
 updateClearBtn();
 closeDropdown();
 // Trigger records render
 renderDoctorRecords();
 }

 function moveSelection(delta) {
 const opts = dropdown.querySelectorAll(".ref-ac-option");
 if (!opts.length) return;
 if (activeIdx >= 0 && opts[activeIdx]) {
 opts[activeIdx].classList.remove("ac-active");
 opts[activeIdx].setAttribute("aria-selected", "false");
 }
 activeIdx = Math.min(Math.max(activeIdx + delta, 0), opts.length - 1);
 const active = opts[activeIdx];
 if (active) {
 active.classList.add("ac-active");
 active.setAttribute("aria-selected", "true");
 active.scrollIntoView({ block: "nearest" });
 input.setAttribute("aria-activedescendant", active.id);
 }
 }

 input.addEventListener("input", () => {
 hidden.value = ""; // Clear selection when user types
 updateClearBtn();
 if (!input.value.trim()) { renderDropdown(true); return; }
 renderDropdown(false);
 });

 input.addEventListener("focus", () => {
 updateClearBtn();
 if (input.value.trim()) renderDropdown(false);
 else renderDropdown(true);
 });

 if (clearBtn) {
 clearBtn.addEventListener("mousedown", e => {
 e.preventDefault();
 input.value = "";
 hidden.value = "";
 updateClearBtn();
 renderDropdown(true);
 input.focus();
 renderDoctorRecords();
 });
 }

 input.addEventListener("keydown", e => {
 if (dropdown.style.display === "none") {
 if (e.key === "ArrowDown") { renderDropdown(true); }
 return;
 }
 if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(+1); }
 else if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
 else if (e.key === "Home") { e.preventDefault(); moveSelection(-activeIdx); }
 else if (e.key === "End") { e.preventDefault(); moveSelection(1000); }
 else if (e.key === "Enter" && activeIdx >= 0) {
 e.preventDefault();
 const opt = dropdown.querySelectorAll(".ref-ac-option")[activeIdx];
 if (opt) selectDoctor(opt.dataset.value);
 } else if (e.key === "Escape" || e.key === "Tab") { closeDropdown(); }
 });

 // Arrow button: toggle show-all dropdown
 if (arrowBtn) {
 arrowBtn.addEventListener("mousedown", e => {
 e.preventDefault();
 if (dropdown.style.display === "block") {
 closeDropdown();
 } else {
 input.focus();
 renderDropdown(true);
 }
 });
 }

 document.addEventListener("click", e => {
 const wrap = document.getElementById("doctorSearchWrap");
 if (wrap && !wrap.contains(e.target)) closeDropdown();
 });
}

function renderDoctorRecords() {
 const selectedDoctor = (doctorSelectInput && doctorSelectInput.value) ? doctorSelectInput.value
 : (document.getElementById("doctorSearchInput") ? document.getElementById("doctorSearchInput").value.trim() : "");
 const fromDate = doctorFromDate.value;
 const toDate = doctorToDate.value;

 if (!selectedDoctor) {
 doctorStatusMsg.textContent = "Please select a doctor.";
 doctorStatusMsg.style.color = "#b91c1c";
 doctorSummaryRow.style.display = "none";
 doctorPatientsSection.style.display = "none";
 return;
 }

 if (!fromDate || !toDate) {
 doctorStatusMsg.textContent = "Please select both dates.";
 doctorStatusMsg.style.color = "#b91c1c";
 return;
 }

 if (fromDate > toDate) {
 doctorStatusMsg.textContent = "From Date must be before To Date.";
 doctorStatusMsg.style.color = "#b91c1c";
 return;
 }

 const records = entriesCache || [];
 const selectedDocKey = normalizeDoctorKey(selectedDoctor);
 const filtered = records.filter(r => {
 const nd = normalizeDate(r.date);
 const docMatch = normalizeDoctorKey(r.refDoctor) === selectedDocKey;
 return docMatch && nd >= fromDate && nd <= toDate;
 });

 // Summary stats
 let totalScanFees = 0, totalRadFees = 0, totalFees = 0;
 filtered.forEach(r => {
 totalScanFees += Number(r.scanFees || 0);
 totalRadFees += Number(r.radiologistFees || 0);
 totalFees += Number(r.totalFees || 0);
 });

 document.getElementById("statPatients").textContent = filtered.length;
 document.getElementById("statScanFees").textContent = "" + totalScanFees.toLocaleString("en-IN");
 document.getElementById("statRadFees").textContent = "" + totalRadFees.toLocaleString("en-IN", {minimumFractionDigits:2});
 document.getElementById("statTotal").textContent = "" + totalFees.toLocaleString("en-IN", {minimumFractionDigits:2});

 doctorSummaryRow.style.display = "block";

 if (filtered.length === 0) {
 doctorStatusMsg.textContent = `No records found for ${selectedDoctor} in this date range.`;
 doctorStatusMsg.style.color = "#b91c1c";
 doctorPatientsSection.style.display = "none";
 return;
 }

 doctorStatusMsg.textContent = ` Found ${filtered.length} patient(s) referred by ${selectedDoctor}`;
 doctorStatusMsg.style.color = "#065f46";

 const fromFmt = new Date(fromDate + "T00:00:00").toLocaleDateString("en-IN", {day:"numeric", month:"short", year:"numeric"});
 const toFmt = new Date(toDate + "T00:00:00").toLocaleDateString("en-IN", {day:"numeric", month:"short", year:"numeric"});
 doctorPatientsTitle.textContent = `Patient Records - ${selectedDoctor} (${fromFmt} to ${toFmt})`;

 doctorPatientsBody.innerHTML = filtered.map((r, i) => `
 <tr>
 <td>${i + 1}</td>
 <td>${formatDateDisplay(r.date)}</td>
 <td>${escapeHtml(r.patientName)}</td>
 <td>${Number(r.age) > 0 ? Math.trunc(Number(r.age)) : "-"}</td>
 <td>${escapeHtml(r.scanType || "-")}</td>
 <td>${escapeHtml(r.twoDScanType || "-")}</td>
 <td>${formatMoney(r.scanFees)}</td>
 <td>${formatMoney(r.radiologistFees, true)}</td>
 <td>${formatMoney(r.totalFees, true)}</td>
 </tr>
 `).join("");

 doctorPatientsSection.style.display = "block";
}

// Wire up doctor filter events
// doctorSearchInput fires renderDoctorRecords via selectDoctor() inside initDoctorPageAutocomplete()
// Date inputs still trigger re-render directly
// if (doctorSelectInput) doctorSelectInput.addEventListener("change", renderDoctorRecords); // replaced by autocomplete
if (doctorFromDate) doctorFromDate.addEventListener("change", renderDoctorRecords);
if (doctorToDate) doctorToDate.addEventListener("change", renderDoctorRecords);


// ============================================================================
// DOCTOR REFERENCE FUNCTIONALITY
// Shows each referring doctor's reference count, generated amount, and
// admin-entered payable percentage for the selected date range.
// ============================================================================

const doctorReferenceFromDate = document.getElementById("doctorReferenceFromDate");
const doctorReferenceToDate = document.getElementById("doctorReferenceToDate");
const doctorReferenceSelectionSection = document.getElementById("doctorReferenceSelectionSection");
const doctorReferenceAuthGate = document.getElementById("doctorReferenceAuthGate");
const doctorReferenceAuthGateBtn = document.getElementById("doctorReferenceAuthGateBtn");
const doctorReferenceSearchRow = document.getElementById("doctorReferenceSearchRow");
const doctorReferenceSearchInput = document.getElementById("doctorReferenceSearchInput");
const doctorReferenceSearchClear = document.getElementById("doctorReferenceSearchClear");
const doctorReferenceStatusMsg = document.getElementById("doctorReferenceStatusMsg");
const doctorReferenceBody = document.getElementById("doctorReferenceBody");
const doctorReferenceLockedState = document.getElementById("doctorReferenceLockedState");
const doctorReferenceTableWrap = document.getElementById("doctorReferenceTableWrap");
const monthlyCollectionSection = document.getElementById("monthlyCollectionSection");
const monthlyCollectionMonth = document.getElementById("monthlyCollectionMonth");
const monthlyCollectionPeriodLabel = document.getElementById("monthlyCollectionPeriodLabel");
const monthlyCollectionPeriod = document.getElementById("monthlyCollectionPeriod");
const monthlyCollectionRange = document.getElementById("monthlyCollectionRange");
const monthlyCollectionTotalLabel = document.getElementById("monthlyCollectionTotalLabel");
const monthlyCollectionTotal = document.getElementById("monthlyCollectionTotal");
const monthlyCollectionCash = document.getElementById("monthlyCollectionCash");
const monthlyCollectionOnline = document.getElementById("monthlyCollectionOnline");
const monthlyCollectionUnclassified = document.getElementById("monthlyCollectionUnclassified");
const monthlyCollectionConsultationFees = document.getElementById("monthlyCollectionConsultationFees");
const monthlyCollectionRecordCount = document.getElementById("monthlyCollectionRecordCount");
const monthlyCollectionBody = document.getElementById("monthlyCollectionBody");
let doctorReferenceSaving = false;
let doctorReferenceRenaming = false;

function formatCollectionMonth(month) {
 const date = new Date(`${month}-01T00:00:00`);
 return Number.isNaN(date.getTime())
 ? month
 : date.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

function renderMonthlyCollection() {
 if (!monthlyCollectionSection || !window.DoctorReference) return;
 if (!(isAdminMode || doctorReferenceAccessUnlocked)) return;

 const options = window.DoctorReference.getCollectionMonthOptions(entriesCache, new Date());
 const currentMonth = window.DoctorReference.getCollectionMonthRange(undefined, new Date()).month;
 const previousSelection = monthlyCollectionMonth?.value || "";
 const selectedMonth = options.includes(previousSelection)
 ? previousSelection
 : (options.includes(currentMonth) ? currentMonth : options[0] || currentMonth);

 if (monthlyCollectionMonth) {
 monthlyCollectionMonth.innerHTML = options.map((month) =>
 `<option value="${month}">${escapeHtml(formatCollectionMonth(month))}</option>`
 ).join("");
 monthlyCollectionMonth.value = selectedMonth;
 }

 const report = window.DoctorReference.aggregateMonthlyCollection(entriesCache, selectedMonth, new Date());
 const consultationFees = window.DoctorReference.aggregateDoctorConsultationFees(
 entriesCache,
 report.fromDate,
 report.toDate,
 appConfig.doctorReferencePercentages,
 appConfig.doctorReferencePercentageHistory
 );
 const periodLabel = report.isCurrentMonth ? "Collection Till Date" : "Total Monthly Collection";
 if (monthlyCollectionPeriodLabel) monthlyCollectionPeriodLabel.textContent = "Selected Month";
 if (monthlyCollectionPeriod) monthlyCollectionPeriod.textContent = formatCollectionMonth(report.month);
 if (monthlyCollectionRange) monthlyCollectionRange.textContent = report.fromDate && report.toDate
 ? `${formatDateDisplay(report.fromDate)} - ${formatDateDisplay(report.toDate)}`
 : "No date range";
 if (monthlyCollectionTotalLabel) monthlyCollectionTotalLabel.textContent = periodLabel;
 if (monthlyCollectionTotal) monthlyCollectionTotal.textContent = formatMoney(report.total);
 if (monthlyCollectionCash) monthlyCollectionCash.textContent = formatMoney(report.cash);
 if (monthlyCollectionOnline) monthlyCollectionOnline.textContent = formatMoney(report.online);
 if (monthlyCollectionUnclassified) monthlyCollectionUnclassified.textContent = formatMoney(report.unclassified);
 if (monthlyCollectionConsultationFees) {
 monthlyCollectionConsultationFees.textContent = formatMoney(consultationFees);
 }
 if (monthlyCollectionRecordCount) {
 monthlyCollectionRecordCount.textContent = `${report.recordCount} record${report.recordCount === 1 ? "" : "s"}`;
 }
 if (monthlyCollectionBody) {
 monthlyCollectionBody.innerHTML = report.daily.map((row) => `
 <tr>
 <td data-label="Date">${formatDateDisplay(row.date)}</td>
 <td data-label="Cash Collection">${formatMoney(row.cash)}</td>
 <td data-label="Online Collection">${formatMoney(row.online)}</td>
 <td data-label="Unclassified">${formatMoney(row.unclassified)}</td>
 <td data-label="Total Collection">${formatMoney(row.total)}</td>
 <td data-label="Cumulative Collection">${formatMoney(row.cumulative)}</td>
 </tr>
 `).join("");
 }
}

function setDoctorReferenceStatus(message, isError = false) {
 if (!doctorReferenceStatusMsg) return;
 doctorReferenceStatusMsg.textContent = message;
 doctorReferenceStatusMsg.style.color = isError ? "#b91c1c" : "#065f46";
}

function updateDoctorReferenceAccessView() {
 const canView = isAdminMode || doctorReferenceAccessUnlocked;

 if (doctorReferenceAuthGate) doctorReferenceAuthGate.hidden = canView;
 if (doctorReferenceAuthGateBtn && window.APP_CONFIG?.DEMO_MODE) doctorReferenceAuthGateBtn.textContent = "View Sample Report";
 if (doctorReferenceSelectionSection) doctorReferenceSelectionSection.hidden = !canView;
 const doctorReferenceTableSection = document.getElementById("doctorReferenceTableSection");
 if (doctorReferenceTableSection) doctorReferenceTableSection.hidden = !canView;
 if (monthlyCollectionSection) monthlyCollectionSection.hidden = !canView;
 if (doctorReferenceLockedState) doctorReferenceLockedState.hidden = canView;
 if (doctorReferenceTableWrap) doctorReferenceTableWrap.hidden = !canView;
 if (doctorReferenceSearchRow) doctorReferenceSearchRow.hidden = !canView;
 if (doctorReferenceAdminBtn) {
 const isScopedAccess = doctorReferenceAccessUnlocked && !isAdminMode;
 doctorReferenceAdminBtn.textContent = isScopedAccess
 ? "Lock Report"
 : "Admin Access to View & Edit";
 doctorReferenceAdminBtn.setAttribute(
 "aria-label",
 isScopedAccess ? "Lock Monthly Review" : "Admin Access to View and Edit Monthly Review"
 );
 }

 if (!canView) {
 if (doctorReferenceSearchInput) doctorReferenceSearchInput.value = "";
 if (doctorReferenceSearchClear) doctorReferenceSearchClear.hidden = true;
 if (doctorReferenceBody) doctorReferenceBody.innerHTML = "";
 setDoctorReferenceStatus(window.APP_CONFIG?.DEMO_MODE
  ? "This sample report is locked. Reopen it to continue."
  : "Admin access is required to open Monthly Review.");
 }

 if (canView && typeof renderMonthlyCollection === "function") renderMonthlyCollection();

 return canView;
}

function setDefaultDoctorReferenceDates() {
 if (!doctorReferenceFromDate || !doctorReferenceToDate) return;

 const { fromDate, toDate } = window.DoctorReference.getMonthDateRange(new Date());
 doctorReferenceFromDate.value = fromDate;
 doctorReferenceToDate.value = toDate;
}

function initDoctorReferencePageTab() {
 setDefaultDoctorReferenceDates();
 updateDoctorReferenceAccessView();
 renderMonthlyCollection();
 renderDoctorReferenceReport();
}

function updateDoctorReferencePayable(input) {
 const totalAmount = Number(input.dataset.totalAmount || 0);
 const payableAmount = window.DoctorReference.calculateDoctorPayable(totalAmount, input.value);
 const payableCell = input.closest("tr")?.querySelector(".doctor-reference-payable");
 if (payableCell) payableCell.textContent = formatMoney(payableAmount, true);
}

function updateDoctorReferenceNameEditState(input) {
 const saveButton = input.closest("td")?.querySelector(".doctor-reference-name-save");
 if (saveButton) {
 saveButton.disabled = input.value.trim() === String(input.dataset.doctorName || "").trim();
 }
}

function cancelDoctorReferenceNameEdit(input) {
 if (!input) return;
 input.value = String(input.dataset.doctorName || "");
 updateDoctorReferenceNameEditState(input);
 input.focus();
}

function updateDefaultDoctorName(oldName, newName) {
 const oldKey = normalizeDoctorKey(oldName);
 if (!oldKey) return;
 DEFAULT_REFERRING_DOCTORS.forEach((name, index) => {
 if (normalizeDoctorKey(name) === oldKey) DEFAULT_REFERRING_DOCTORS[index] = newName;
 });
}

async function saveDoctorReferenceName(input) {
 if (!(isAdminMode || doctorReferenceAccessUnlocked) || doctorReferenceRenaming) return;

 const oldName = String(input.dataset.doctorName || "").trim();
 const newName = String(input.value || "").trim();
 if (!oldName || !isValidDoctorName(newName)) {
 setDoctorReferenceStatus("Please enter a valid doctor name.", true);
 input.value = oldName;
 updateDoctorReferenceNameEditState(input);
 return;
 }
 if (oldName === newName) return;

 const saveButton = input.closest("td")?.querySelector(".doctor-reference-name-save");
 const cancelButton = input.closest("td")?.querySelector(".doctor-reference-name-cancel");
 const matchingRecordCount = entriesCache.filter((record) => normalizeDoctorKey(record.refDoctor) === normalizeDoctorKey(oldName)).length;
 let successMessage = "";
 let errorMessage = "";
 doctorReferenceRenaming = true;
 input.disabled = true;
 if (saveButton) saveButton.disabled = true;
 if (cancelButton) cancelButton.disabled = true;
 setDoctorReferenceStatus("Saving doctor name across the app...");

 try {
 const nextVersion = generateConfigVersion();
 let serverResponse = null;
 if (isCloudConfigured()) {
 serverResponse = await cloudPost({
 op: "renameReferringDoctor",
 oldName,
 newName,
 version: nextVersion
 });
 }

 const renamed = window.DoctorReference.renameDoctorReferenceData(
 entriesCache,
 appConfig,
 oldName,
 newName
 );
 updateDefaultDoctorName(oldName, newName);
 entriesCache = renamed.records;
 window.entriesCache = entriesCache;
 appConfig = normalizeConfig(serverResponse?.config || renamed.config);
 window.appConfig = appConfig;
 cloudConfigVersion = serverResponse?.config?.configVersion || nextVersion;
 writeMirror(LS_RECORDS_KEY, entriesCache);
 writeMirror(LS_CONFIG_KEY, { config: appConfig, version: cloudConfigVersion });

 renderTable(entriesCache);
 renderReferringDoctorOptions();
 const doctorPageVisible = document.getElementById("doctorsPage")?.style.display === "block";
 if (doctorPageVisible && typeof renderDoctorRecords === "function") renderDoctorRecords();
 const billPageVisible = document.getElementById("billPage")?.style.display === "block";
 if (billPageVisible && billDateInput?.value) loadBillPatients(billDateInput.value);
 renderDoctorReferenceReport();

 const serverCount = Number(serverResponse?.updatedRecords);
 const changedCount = Number.isFinite(serverCount) ? serverCount : matchingRecordCount;
 successMessage = ` Renamed "${oldName}"to "${newName}"across the app (${changedCount} record${changedCount === 1 ? "" : "s"} updated).`;
 } catch (error) {
 console.error("Doctor reference rename failed:", error);
 errorMessage = "Doctor name could not be saved. Check the connection and try again.";
 } finally {
 doctorReferenceRenaming = false;
 renderDoctorReferenceReport();
 if (successMessage) setDoctorReferenceStatus(successMessage);
 if (errorMessage) setDoctorReferenceStatus(errorMessage, true);
 }
}

function printDoctorReferenceSummary(button) {
 if (!button || !(isAdminMode || doctorReferenceAccessUnlocked)) return;

 const doctorName = String(button.dataset.doctorName || "").trim();
 const referenceCount = Number(button.dataset.referenceCount || 0);
 const totalAmount = Number(button.dataset.totalAmount || 0);
 const percentageInput = button.closest("tr")?.querySelector(".doctor-reference-percent-input");
 const percentage = Number(percentageInput?.value ?? button.dataset.percentage ?? 0);
 const payableAmount = window.DoctorReference.calculateDoctorPayable(totalAmount, percentage);
 const fromDate = doctorReferenceFromDate?.value || "";
 const toDate = doctorReferenceToDate?.value || "";
 const doctorKey = normalizeDoctorKey(doctorName);
 const patients = entriesCache
 .filter((record) => {
 const visitDate = normalizeDate(record.date);
 return normalizeDoctorKey(record.refDoctor) === doctorKey
 && (!fromDate || (visitDate && visitDate >= fromDate))
 && (!toDate || (visitDate && visitDate <= toDate));
 })
 .sort((left, right) => normalizeDate(left.date).localeCompare(normalizeDate(right.date)))
 .map((record) => ({
 patientName: String(record.patientName || "Unnamed patient").trim(),
 amountPaidText: formatMoney(record.totalFees, true),
 }));
 const printHtml = window.DoctorReference.buildDoctorReferencePrintHtml({
 doctorName,
 referenceCount,
 totalAmountText: formatMoney(totalAmount, true),
 percentage,
 consultationFeeText: formatMoney(payableAmount, true),
 fromDate,
 toDate,
 patients,
 generatedAt: new Date().toLocaleString("en-IN", {
 day: "2-digit",
 month: "short",
 year: "numeric",
 hour: "2-digit",
 minute: "2-digit",
 }),
 });
 const printUrl = URL.createObjectURL(new Blob([printHtml], { type: "text/html" }));
 const printWindow = window.open(printUrl, "_blank", "width=900,height=760");

 if (!printWindow) {
 URL.revokeObjectURL(printUrl);
 setDoctorReferenceStatus("Allow pop-ups to print the doctor report.", true);
 return;
 }

 // Keep the object URL alive while the print preview is open. Revoking it too
 // early can turn the Electron print surface into a blank page.
 setTimeout(() => URL.revokeObjectURL(printUrl), 120000);
}

function printOverallDoctorReferenceSummary() {
 if (!(isAdminMode || doctorReferenceAccessUnlocked) || !window.DoctorReference) return;

 const fromDate = doctorReferenceFromDate?.value || "";
 const toDate = doctorReferenceToDate?.value || "";
 if (!fromDate || !toDate || fromDate > toDate) {
 setDoctorReferenceStatus("Select a valid date range before printing the overall report.", true);
 return;
 }

 const fullReport = window.DoctorReference.aggregateDoctorReferences(
 entriesCache,
 fromDate,
 toDate,
 appConfig.doctorReferencePercentages,
 appConfig.doctorReferencePercentageHistory
 );
 if (!fullReport.length) {
 setDoctorReferenceStatus("No referring doctor records found for the selected dates.", true);
 return;
 }

 const doctors = fullReport.map((item) => {
 const row = [...(doctorReferenceBody?.querySelectorAll("tr") || [])].find((candidate) => {
 const nameInput = candidate.querySelector(".doctor-reference-name-input");
 return normalizeDoctorKey(nameInput?.value || nameInput?.dataset.doctorName) === normalizeDoctorKey(item.doctorName);
 });
 const nameInput = row?.querySelector(".doctor-reference-name-input");
 const percentageInput = row?.querySelector(".doctor-reference-percent-input");
 const totalAmount = Number(percentageInput?.dataset.totalAmount ?? item.totalAmount);
 const percentage = Number(percentageInput?.value ?? item.percentage);
 return {
 doctorName: String(nameInput?.value || item.doctorName).trim(),
 referenceCount: item.referenceCount,
 totalAmount,
 percentage,
 payableAmount: window.DoctorReference.calculateDoctorPayable(totalAmount, percentage),
 };
 });

 const printHtml = window.DoctorReference.buildOverallDoctorReferencePrintHtml({
 fromDate,
 toDate,
 doctors,
 generatedAt: new Date().toLocaleString("en-IN", {
 day: "2-digit",
 month: "short",
 year: "numeric",
 hour: "2-digit",
 minute: "2-digit",
 }),
 });
 const printUrl = URL.createObjectURL(new Blob([printHtml], { type: "text/html" }));
 const printWindow = window.open(printUrl, "_blank", "width=900,height=760");

 if (!printWindow) {
 URL.revokeObjectURL(printUrl);
 setDoctorReferenceStatus("Allow pop-ups to print the overall report.", true);
 return;
 }

 setTimeout(() => URL.revokeObjectURL(printUrl), 120000);
}

async function saveDoctorReferencePercentage(input) {
 if (!(isAdminMode || doctorReferenceAccessUnlocked) || doctorReferenceSaving) return;

 const doctorName = String(input.dataset.doctorName || "").trim();
 const percentage = Number(input.value);
 if (!doctorName || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
 setDoctorReferenceStatus("Percentage must be a number between 0 and 100.", true);
 renderDoctorReferenceReport();
 return;
 }

 const nextPercentages = { ...(appConfig.doctorReferencePercentages || {}) };
 Object.keys(nextPercentages).forEach((name) => {
 if (name.trim().toLowerCase() === doctorName.toLowerCase()) delete nextPercentages[name];
 });
 nextPercentages[doctorName] = percentage;

 const periodKey = window.DoctorReference.getDoctorReferencePeriodKey(
 doctorReferenceFromDate?.value || "",
 doctorReferenceToDate?.value || ""
 );
 const nextHistory = JSON.parse(JSON.stringify(appConfig.doctorReferencePercentageHistory || {}));
 if (periodKey) {
 nextHistory[periodKey] = {
 ...(nextHistory[periodKey] || {}),
 [normalizeDoctorKey(doctorName)]: percentage
 };
 }

 appConfig = normalizeConfig({
 ...appConfig,
 doctorReferencePercentages: nextPercentages,
 doctorReferencePercentageHistory: nextHistory
 });
 window.appConfig = appConfig;
 const nextVersion = generateConfigVersion();
 doctorReferenceSaving = true;
 input.disabled = true;
 setDoctorReferenceStatus("Saving percentage...");

 try {
 await saveConfigToCloud(appConfig, "", nextVersion);
 cloudConfigVersion = nextVersion;
 localStorage.setItem(CONFIG_VERSION_KEY, nextVersion);
 setDoctorReferenceStatus("Percentage saved successfully.");
 } catch (error) {
 console.error("Doctor reference percentage save failed:", error);
 setDoctorReferenceStatus("Percentage could not be saved. Check the connection and try again.", true);
 } finally {
 doctorReferenceSaving = false;
 renderDoctorReferenceReport();
 }
}

function renderDoctorReferenceReport() {
 if (!doctorReferenceBody || !window.DoctorReference) return;
 if (!updateDoctorReferenceAccessView()) return;

 const fromDate = doctorReferenceFromDate?.value || "";
 const toDate = doctorReferenceToDate?.value || "";
 if (!fromDate || !toDate) {
 doctorReferenceBody.innerHTML = '<tr><td colspan="6"class="doctor-reference-empty">Select both dates to view the report.</td></tr>';
 return;
 }
 if (fromDate > toDate) {
 setDoctorReferenceStatus("From Date must be before To Date.", true);
 doctorReferenceBody.innerHTML = '<tr><td colspan="6"class="doctor-reference-empty">Invalid date range.</td></tr>';
 return;
 }

 const fullReport = window.DoctorReference.aggregateDoctorReferences(
 entriesCache,
 fromDate,
 toDate,
 appConfig.doctorReferencePercentages,
 appConfig.doctorReferencePercentageHistory
 );
 const report = window.DoctorReference.filterDoctorReferenceReport(
 fullReport,
 doctorReferenceSearchInput?.value || ""
 );

 if (!report.length) {
 const hasSearch = Boolean(doctorReferenceSearchInput?.value.trim());
 setDoctorReferenceStatus(
 hasSearch ? "No matching doctor found for the selected dates." : "No referring doctor records found for the selected dates.",
 true
 );
 doctorReferenceBody.innerHTML = '<tr><td colspan="6"class="doctor-reference-empty">No doctor references found.</td></tr>';
 return;
 }

 const searchText = doctorReferenceSearchInput?.value.trim() || "";
 setDoctorReferenceStatus(
 searchText
 ? ` ${report.length} of ${fullReport.length} referring doctor(s) shown.`
 : ` ${report.length} referring doctor(s) found.`
 );
 doctorReferenceBody.innerHTML = report.map((item) => `
 <tr>
 <td class="doctor-reference-name"data-label="Doctor Name">
 <input
 class="doctor-reference-name-input"type="text"value="${escapeHtml(item.doctorName)}"data-doctor-name="${escapeHtml(item.doctorName)}"autocomplete="off"aria-label="Doctor name for ${escapeHtml(item.doctorName)}"
 ${isAdminMode || doctorReferenceAccessUnlocked ? "" : "disabled"}
 />
 <span class="doctor-reference-name-actions">
 <button type="button"class="doctor-reference-name-save"disabled aria-label="Save doctor name">Save</button>
 <button type="button"class="doctor-reference-name-cancel"aria-label="Cancel doctor name edit">Cancel</button>
 </span>
 </td>
 <td data-label="Total References">${item.referenceCount}</td>
 <td data-label="Total Amount Generated">${formatMoney(item.totalAmount, true)}</td>
 <td data-label="Percentage">
 <span class="doctor-reference-percent-wrap">
 <span aria-hidden="true">%</span>
 <input
 class="doctor-reference-percent-input"type="number"min="0"max="100"step="0.01"value="${item.percentage}"data-doctor-name="${escapeHtml(item.doctorName)}"data-total-amount="${item.totalAmount}"
 ${isAdminMode || doctorReferenceAccessUnlocked ? "" : "disabled"}
 aria-label="Percentage for ${escapeHtml(item.doctorName)}"
 />
 </span>
 </td>
 <td class="doctor-reference-payable"data-label="Consultation Fee">${formatMoney(item.payableAmount, true)}</td>
 <td data-label="Actions">
 <button
 type="button"class="doctor-reference-print-btn"data-doctor-name="${escapeHtml(item.doctorName)}"data-reference-count="${item.referenceCount}"data-total-amount="${item.totalAmount}"data-percentage="${item.percentage}"aria-label="Print report for ${escapeHtml(item.doctorName)}"
 >Print</button>
 </td>
 </tr>
 `).join("");

 if (!doctorReferenceBody._bound) {
 doctorReferenceBody._bound = true;
 doctorReferenceBody.addEventListener("input", (event) => {
 const input = event.target.closest(".doctor-reference-percent-input");
 if (input) updateDoctorReferencePayable(input);
 const nameInput = event.target.closest(".doctor-reference-name-input");
 if (nameInput) updateDoctorReferenceNameEditState(nameInput);
 });
 doctorReferenceBody.addEventListener("keydown", (event) => {
 const input = event.target.closest(".doctor-reference-name-input");
 if (!input) return;
 if (event.key === "Enter") {
 event.preventDefault();
 saveDoctorReferenceName(input);
 } else if (event.key === "Escape") {
 event.preventDefault();
 cancelDoctorReferenceNameEdit(input);
 }
 });
 doctorReferenceBody.addEventListener("click", (event) => {
 const button = event.target.closest(".doctor-reference-print-btn");
 if (button) printDoctorReferenceSummary(button);
 const saveButton = event.target.closest(".doctor-reference-name-save");
 if (saveButton) saveDoctorReferenceName(saveButton.closest("td")?.querySelector(".doctor-reference-name-input"));
 const cancelButton = event.target.closest(".doctor-reference-name-cancel");
 if (cancelButton) cancelDoctorReferenceNameEdit(cancelButton.closest("td")?.querySelector(".doctor-reference-name-input"));
 });
 doctorReferenceBody.addEventListener("change", (event) => {
 const input = event.target.closest(".doctor-reference-percent-input");
 if (input) saveDoctorReferencePercentage(input);
 });
 }
}

if (doctorReferenceFromDate) doctorReferenceFromDate.addEventListener("change", renderDoctorReferenceReport);
if (doctorReferenceToDate) doctorReferenceToDate.addEventListener("change", renderDoctorReferenceReport);
if (monthlyCollectionMonth) monthlyCollectionMonth.addEventListener("change", renderMonthlyCollection);
if (doctorReferenceAuthGateBtn) {
 doctorReferenceAuthGateBtn.addEventListener("click", () => {
 if (window.APP_CONFIG?.DEMO_MODE) {
 doctorReferenceAccessUnlocked = true;
 renderDoctorReferenceReport();
 return;
 }
 showAdminModal("doctorReference");
 });
}
if (doctorReferenceOverallPrintBtn) {
 doctorReferenceOverallPrintBtn.addEventListener("click", printOverallDoctorReferenceSummary);
}

if (doctorReferenceSearchInput) {
 doctorReferenceSearchInput.addEventListener("input", () => {
 if (doctorReferenceSearchClear) doctorReferenceSearchClear.hidden = !doctorReferenceSearchInput.value;
 renderDoctorReferenceReport();
 });
}

if (doctorReferenceSearchClear) {
 doctorReferenceSearchClear.addEventListener("click", () => {
 if (!doctorReferenceSearchInput) return;
 doctorReferenceSearchInput.value = "";
 doctorReferenceSearchClear.hidden = true;
 renderDoctorReferenceReport();
 doctorReferenceSearchInput.focus();
 });
}


// ============================================================================
// RADIOLOGIST DETAILS FUNCTIONALITY
// Same pattern as Doctor Details but adds a second filter (referring doctor)
// so you can see exactly how much business each referrer brought to each radiologist.
// ============================================================================

const radSelectInput = document.getElementById("radSelectInput");
const radDoctorSelectInput = document.getElementById("radDoctorSelectInput");
const radFromDate = document.getElementById("radFromDate");
const radToDate = document.getElementById("radToDate");
const radStatusMsg = document.getElementById("radStatusMsg");
const radSummaryRow = document.getElementById("radSummaryRow");
const radPatientsSection = document.getElementById("radPatientsSection");
const radPatientsBody = document.getElementById("radPatientsBody");
const radPatientsTitle = document.getElementById("radPatientsTitle");

function initRadiologistPageTab() {
 if (!radSelectInput) return;

 // 1. Populate radiologist dropdown from appConfig (admin-editable list)
 const radiologists = (appConfig && appConfig.radiologists) ? appConfig.radiologists : [];
 let radOpts = '<option value=""disabled selected>Select a radiologist</option>';
 radiologists.forEach(r => {
 if (r && r.name) {
 radOpts += `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`;
 }
 });
 // Allow Not Applicable too - some records may have it
 radOpts += '<option value="Not Applicable">Not Applicable</option>';
 radSelectInput.innerHTML = radOpts;

 // 2. Populate referring doctor dropdown - same merged list used elsewhere
 const doctors = buildFullDoctorList();
 let docOpts = '<option value="__ALL__"selected>All Doctors</option>';
 doctors.forEach(d => {
 docOpts += `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`;
 });
 radDoctorSelectInput.innerHTML = docOpts;

 // 3. Default date range - last 3 calendar months today (reset every tab open)
 const today = getTodayDateValue();
 const now = new Date();
 const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
 const fromY = threeMonthsAgo.getFullYear();
 const fromM = String(threeMonthsAgo.getMonth() + 1).padStart(2, "0");
 radFromDate.value = `${fromY}-${fromM}-01`;
 radToDate.value = today;
 radToDate.max = today; // no future To-date
 radFromDate.max = today;

 // 4. Reset display
 radStatusMsg.textContent = "Select a radiologist to see records.";
 radStatusMsg.style.color = "#6b7280";
 radSummaryRow.style.display = "none";
 radPatientsSection.style.display = "none";
}

function renderRadiologistRecords() {
 if (!radSelectInput) return;

 const selectedRad = radSelectInput.value;
 const selectedDoctor = radDoctorSelectInput.value; // "__ALL__"or a doctor name
 const fromDate = radFromDate.value;
 const toDate = radToDate.value;

 // Validate inputs
 if (!selectedRad) {
 radStatusMsg.textContent = "Please select a radiologist.";
 radStatusMsg.style.color = "#b91c1c";
 radSummaryRow.style.display = "none";
 radPatientsSection.style.display = "none";
 return;
 }
 if (!fromDate || !toDate) {
 radStatusMsg.textContent = "Please select both dates.";
 radStatusMsg.style.color = "#b91c1c";
 return;
 }
 if (fromDate > toDate) {
 radStatusMsg.textContent = "From Date must be before To Date.";
 radStatusMsg.style.color = "#b91c1c";
 return;
 }

 const records = entriesCache || [];
 const radKey = selectedRad.trim().toLowerCase();
 const docKey = selectedDoctor === "__ALL__" ? null : normalizeDoctorKey(selectedDoctor);

 const filtered = records.filter(r => {
 const nd = normalizeDate(r.date);
 if (nd < fromDate || nd > toDate) return false;
 if ((r.radiologistName || "").trim().toLowerCase() !== radKey) return false;
 if (docKey && normalizeDoctorKey(r.refDoctor) !== docKey) return false;
 return true;
 });

 // Summary stats
 let totalScanFees = 0, totalRadFees = 0, totalFees = 0;
 filtered.forEach(r => {
 totalScanFees += Number(r.scanFees || 0);
 totalRadFees += Number(r.radiologistFees || 0);
 totalFees += Number(r.totalFees || 0);
 });

 document.getElementById("radStatPatients").textContent = filtered.length;
 document.getElementById("radStatScanFees").textContent = formatMoney(totalScanFees);
 document.getElementById("radStatRadFees").textContent = formatMoney(totalRadFees, true);
 document.getElementById("radStatTotal").textContent = formatMoney(totalFees, true);
 radSummaryRow.style.display = "block";

 // Headline status
 const fromFmt = formatDateDisplay(fromDate);
 const toFmt = formatDateDisplay(toDate);
 const docLabel = (selectedDoctor === "__ALL__") ? "all referring doctors" : selectedDoctor;

 if (filtered.length === 0) {
 radStatusMsg.textContent = `No records for ${selectedRad} from ${docLabel} between ${fromFmt} and ${toFmt}.`;
 radStatusMsg.style.color = "#b91c1c";
 radPatientsSection.style.display = "none";
 return;
 }

 radStatusMsg.textContent = ` ${filtered.length} record(s) - ${selectedRad} Ãƒâ€” ${docLabel} (${fromFmt} ${toFmt})`;
 radStatusMsg.style.color = "#065f46";

 radPatientsTitle.textContent =
 (selectedDoctor === "__ALL__")
 ? `Records for ${selectedRad} (${fromFmt} ${toFmt})`
 : `Records - ${selectedRad} Ãƒâ€” ${selectedDoctor} (${fromFmt} ${toFmt})`;

 radPatientsBody.innerHTML = filtered.map((r, i) => `
 <tr>
 <td>${i + 1}</td>
 <td>${formatDateDisplay(r.date)}</td>
 <td>${escapeHtml(r.patientName)}</td>
 <td>${Number(r.age) > 0 ? Math.trunc(Number(r.age)) : "-"}</td>
 <td>${escapeHtml(r.scanType || "-")}</td>
 <td>${escapeHtml(r.twoDScanType || "-")}</td>
 <td>${escapeHtml(r.refDoctor || "-")}</td>
 <td>${formatMoney(r.scanFees)}</td>
 <td>${formatMoney(r.radiologistFees, true)}</td>
 <td>${formatMoney(r.totalFees, true)}</td>
 </tr>
 `).join("");
 radPatientsSection.style.display = "block";
}

// Wire up filter events - any change re-runs the query
if (radSelectInput) radSelectInput.addEventListener("change", renderRadiologistRecords);
if (radDoctorSelectInput) radDoctorSelectInput.addEventListener("change", renderRadiologistRecords);
if (radFromDate) radFromDate.addEventListener("change", renderRadiologistRecords);
if (radToDate) radToDate.addEventListener("change", renderRadiologistRecords);

// ============================================================================
// TAB NAVIGATION
// ============================================================================
const TAB_TO_PAGE = {
 scan: "scanPage",
 expenses: "expensePage",
 doctors: "doctorsPage",
 doctorReference: "doctorReferencePage",
 radiologists: "radiologistsPage",
 bill: "billPage"
};

document.querySelectorAll(".page-tab").forEach(tab => {
 tab.addEventListener("click", async () => {
 const pageName = tab.dataset.page;
 const pageId = TAB_TO_PAGE[pageName];
 if (!pageId) return;

 if (pageName !== "doctorReference" && doctorReferenceAccessUnlocked && window.APP_CONFIG?.DEMO_MODE !== true) {
 doctorReferenceAccessUnlocked = false;
 renderDoctorReferenceReport();
 }

 document.querySelectorAll(".page-content").forEach(p => p.style.display = "none");
 document.querySelectorAll(".page-tab").forEach(t => t.classList.remove("active"));

 document.getElementById(pageId).style.display = "block";
 tab.classList.add("active");

 const recordsSection = document.getElementById("scanPageRecords");
 if (recordsSection) recordsSection.style.display = (pageName === "scan") ? "block" : "none";

 if (pageName === "expenses") {
  void window.ensureExpensesLoaded?.();
 } else if (pageName !== "scan" && (pageName !== "doctorReference" || isAdminMode || doctorReferenceAccessUnlocked)) {
  await ensureReportRecordsLoaded();
 }

 if (pageName === "bill") initBillPageTab();
 if (pageName === "doctors") initDoctorPageTab();
 if (pageName === "doctorReference") initDoctorReferencePageTab();
 if (pageName === "radiologists") initRadiologistPageTab();
 });
});

document.addEventListener("DOMContentLoaded", () => {
 try {
 initialize();
 // Wire up the smart referring-doctor autocomplete AFTER the DOM is ready
 initRefDoctorAutocomplete();
 } catch (err) {
 console.error("Error during initialization:", err);
 }
});

// ============================================================================
// DOCTOR LIST MANAGEMENT MODAL (+ ADD / DELETE DOCTOR)
// ============================================================================
let _docManageBound = false;

function openDoctorManageModal() {
 const modal = document.getElementById("doctorManageModal");
 if (!modal) return;
 modal.style.display = "flex";
 modal.setAttribute("aria-hidden", "false");
 renderDoctorManageList();

 if (!_docManageBound) {
 _docManageBound = true;
 const closeBtn = document.getElementById("docManageCloseBtn");
 const doneBtn = document.getElementById("docManageDoneBtn");
 const addBtn = document.getElementById("addNewDoctorBtn");
 const newInput = document.getElementById("newDoctorNameInput");
 const filterIn = document.getElementById("filterDocManageInput");

 if (closeBtn) closeBtn.addEventListener("click", closeDoctorManageModal);
 if (doneBtn) doneBtn.addEventListener("click", closeDoctorManageModal);

 if (addBtn && newInput) {
 addBtn.addEventListener("click", () => handleAddDoctorModal());
 newInput.addEventListener("keydown", e => {
 if (e.key === "Enter") {
 e.preventDefault();
 handleAddDoctorModal();
 }
 });
 }

 if (filterIn) {
 filterIn.addEventListener("input", () => renderDoctorManageList());
 }

 modal.addEventListener("click", e => {
 if (e.target === modal) closeDoctorManageModal();
 });
 }
}

function closeDoctorManageModal() {
 const modal = document.getElementById("doctorManageModal");
 if (modal) {
 modal.style.display = "none";
 modal.setAttribute("aria-hidden", "true");
 }
}

function renderDoctorManageList() {
 const listBody = document.getElementById("docManageListBody");
 const filterIn = document.getElementById("filterDocManageInput");
 if (!listBody) return;

 const doctors = buildFullDoctorList();
 const query = filterIn ? filterIn.value.trim().toLowerCase() : "";

 const filtered = doctors.filter(d => !query || d.toLowerCase().includes(query));

 if (!filtered.length) {
 listBody.innerHTML = `<div style="padding:16px;text-align:center;color:#64748b;font-size:0.9rem;">No doctor names found.</div>`;
 return;
 }

 listBody.innerHTML = filtered.map(name => `
 <div class="doc-manage-item">
 <span>${escapeHtml(name)}</span>
 <div class="doc-manage-actions">
 <button type="button"class="btn-doc-edit"data-doc="${escapeHtml(name)}">Edit</button>
 <button type="button"class="btn-doc-delete"data-doc="${escapeHtml(name)}">Delete</button>
 </div>
 </div>
 `).join("");

 listBody.querySelectorAll(".btn-doc-edit").forEach(btn => {
 btn.addEventListener("click", async () => {
 const docName = btn.dataset.doc;
 const updated = await appDialog.prompt({
 title: "Edit referring doctor",
 message: `Edit doctor name for "${docName}":`,
 value: docName,
 inputLabel: "Doctor name",
 confirmLabel: "Save"
 });
 if (updated && updated.trim() && updated.trim() !== docName) {
 editDoctorInList(docName, updated.trim());
 }
 });
 });

 listBody.querySelectorAll(".btn-doc-delete").forEach(btn => {
 btn.addEventListener("click", async () => {
 const docName = btn.dataset.doc;
 if (await appDialog.confirm({
 title: "Remove referring doctor?",
 message: `Remove "${docName}" from referring doctors list?`,
 confirmLabel: "Remove",
 danger: true
 })) {
 deleteDoctorFromList(docName);
 }
 });
 });
}

function editDoctorInList(oldName, newName) {
 const msgEl = document.getElementById("docManageMsg");
 const oldNorm = oldName.toLowerCase();

 if (/^\d+$/.test(newName) || newName.replace(/[^a-zA-Z]/g, "").length < 2) {
 if (msgEl) {
 msgEl.textContent = "Please enter a valid doctor name.";
 msgEl.style.color = "#b91c1c";
 }
 return;
 }

 if (window.appConfig && Array.isArray(window.appConfig.referringDoctors)) {
 const idx = window.appConfig.referringDoctors.findIndex(d => d.toLowerCase() === oldNorm);
 if (idx !== -1) {
 window.appConfig.referringDoctors[idx] = newName;
 } else {
 window.appConfig.referringDoctors.push(newName);
 }
 }

 const defaultIdx = DEFAULT_REFERRING_DOCTORS.findIndex(d => d.toLowerCase() === oldNorm);
 if (defaultIdx !== -1) {
 DEFAULT_REFERRING_DOCTORS[defaultIdx] = newName;
 } else {
 DEFAULT_REFERRING_DOCTORS.push(newName);
 }

 saveConfigToCloud(window.appConfig || {}, "", cloudConfigVersion || "");

 if (msgEl) {
 msgEl.textContent = ` Updated "${oldName}"to "${newName}".`;
 msgEl.style.color = "#065f46";
 }

 renderDoctorManageList();
}

function handleAddDoctorModal() {
 const newInput = document.getElementById("newDoctorNameInput");
 const msgEl = document.getElementById("docManageMsg");
 if (!newInput) return;

 const name = newInput.value.trim();
 if (!name) {
 if (msgEl) {
 msgEl.textContent = "Please enter a doctor name.";
 msgEl.style.color = "#b91c1c";
 }
 return;
 }

 if (/^\d+$/.test(name) || name.replace(/[^a-zA-Z]/g, "").length < 2) {
 if (msgEl) {
 msgEl.textContent = "Please enter a valid doctor name (e.g. Dr. John Doe).";
 msgEl.style.color = "#b91c1c";
 }
 return;
 }

 if (!window.appConfig) window.appConfig = {};
 if (!Array.isArray(window.appConfig.referringDoctors)) {
 window.appConfig.referringDoctors = [...DEFAULT_REFERRING_DOCTORS];
 }

 const normalized = name.toLowerCase();
 const exists = window.appConfig.referringDoctors.some(d => d.toLowerCase() === normalized);
 if (!exists) {
 window.appConfig.referringDoctors.push(name);
 }

 if (!DEFAULT_REFERRING_DOCTORS.some(d => d.toLowerCase() === normalized)) {
 DEFAULT_REFERRING_DOCTORS.push(name);
 }

 saveConfigToCloud(window.appConfig, "", cloudConfigVersion || "");

 newInput.value = "";
 if (msgEl) {
 msgEl.textContent = ` Added "${name}"to doctor list.`;
 msgEl.style.color = "#065f46";
 }

 renderDoctorManageList();
}

function deleteDoctorFromList(docName) {
 const msgEl = document.getElementById("docManageMsg");
 const norm = docName.toLowerCase();

 if (window.appConfig && Array.isArray(window.appConfig.referringDoctors)) {
 window.appConfig.referringDoctors = window.appConfig.referringDoctors.filter(d => d.toLowerCase() !== norm);
 }

 for (let i = DEFAULT_REFERRING_DOCTORS.length - 1; i >= 0; i--) {
 if (DEFAULT_REFERRING_DOCTORS[i].toLowerCase() === norm) {
 DEFAULT_REFERRING_DOCTORS.splice(i, 1);
 }
 }

 saveConfigToCloud(window.appConfig || {}, "", cloudConfigVersion || "");

 if (msgEl) {
 msgEl.textContent = `Ã°Å¸â€”â€˜Ã¯Â¸Â Removed "${docName}"from list.`;
 msgEl.style.color = "#b91c1c";
 }

 renderDoctorManageList();
}
// // // // // // // // // //
