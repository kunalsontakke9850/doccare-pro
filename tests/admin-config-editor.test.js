const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOptionRows,
  buildRadiologistCard,
  normalizeOptionValues,
  withPreservedReferringDoctors,
} = require("../admin-config-editor.js");

test("buildOptionRows renders every option as a separate, labelled input", () => {
  const html = buildOptionRows(
    ["Single Tooth", "Quadrant"],
    "Scan type",
    "scan-types"
  );

  assert.equal((html.match(/class="admin-option-input"/g) || []).length, 2);
  assert.match(html, /id="scan-types-option-1"/);
  assert.match(html, /for="scan-types-option-1"/);
  assert.match(html, /value="Single Tooth"/);
  assert.match(html, /id="scan-types-option-2"/);
  assert.match(html, /value="Quadrant"/);
  assert.equal((html.match(/class="admin-option-remove"/g) || []).length, 2);
});

test("buildOptionRows escapes user-controlled option values", () => {
  const html = buildOptionRows(
    ['\"><img src=x onerror="alert(1)">'],
    "Purpose",
    "purposes"
  );

  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /onerror="alert/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&quot;/);
});

test("normalizeOptionValues trims entries and removes empty rows", () => {
  assert.deepEqual(normalizeOptionValues(["  Single Tooth  ", "", "  ", "TMJ Rt."]), [
    "Single Tooth",
    "TMJ Rt.",
  ]);
});

test("buildRadiologistCard gives the name, default fee, and each scan fee a proper field", () => {
  const html = buildRadiologistCard(
    {
      name: "Dr. Sample Referrer",
      fee: 500,
      pricing: { "Single Tooth": 100, Quadrant: 150 },
    },
    ["Single Tooth", "Quadrant"],
    0
  );

  assert.match(html, /Radiologist name/);
  assert.match(html, /Default fee/);
  assert.match(html, /value="Dr. Sample Referrer"/);
  assert.equal((html.match(/class="admin-doctor-scan-fee"/g) || []).length, 2);
  assert.match(html, /Single Tooth/);
  assert.match(html, /value="100"/);
  assert.match(html, /Quadrant/);
  assert.match(html, /value="150"/);
});

test("withPreservedReferringDoctors retains the entry-form doctor list", () => {
  const result = withPreservedReferringDoctors(
    { scanTypes: ["Single Tooth"] },
    { referringDoctors: ["Dr. Existing"] },
    ["Dr. Fallback"]
  );

  assert.deepEqual(result.referringDoctors, ["Dr. Existing"]);
  assert.notStrictEqual(result.referringDoctors, result.scanTypes);
});

test("withPreservedReferringDoctors uses defaults when the current list is unavailable", () => {
  const result = withPreservedReferringDoctors(
    { scanTypes: ["Single Tooth"] },
    { referringDoctors: [] },
    ["Dr. Fallback"]
  );

  assert.deepEqual(result.referringDoctors, ["Dr. Fallback"]);
});
