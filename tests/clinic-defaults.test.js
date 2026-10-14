const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("publishable app defaults do not contain clinic-specific people or pricing", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");

  assert.equal(/window\.APP_CONFIG\?\.CLINIC_CONFIG\s*\|\|\s*DEFAULT_CONFIG/.test(source), true, "app defaults should come from the private runtime config");
  assert.equal(/window\.APP_CONFIG\?\.CLINIC_REFERRING_DOCTORS/.test(source), true, "referral lists should come from the private runtime config");
  assert.equal(/window\.APP_CONFIG\?\.CLINIC_PRESET_PRICING/.test(source), true, "preset pricing should come from the private runtime config");
  assert.equal(/appConfig\s*=\s*normalizeConfig\(window\.APP_CONFIG\?\.CLINIC_CONFIG\s*\|\|\s*DEFAULT_CONFIG\)/.test(source), true, "startup should retain local clinic defaults when configured");
  const configPath = path.join(__dirname, "..", "config.js");
  const configSource = fs.readFileSync(fs.existsSync(configPath) ? configPath : path.join(__dirname, "..", "config.js.example"), "utf8");
  const context = { window: { APP_CONFIG: {} } };
  vm.runInNewContext(configSource, context);
  const clinicNames = Object.keys(context.window.APP_CONFIG.CLINIC_PRESET_PRICING || {});
  clinicNames.push(...(context.window.APP_CONFIG.CLINIC_REFERRING_DOCTORS || []));
  clinicNames.push(...(context.window.APP_CONFIG.CLINIC_CONFIG?.radiologists || []).map(row => row.name));
  for (const name of clinicNames) {
    assert.equal(source.toLowerCase().includes(name), false, "clinic names must stay out of publishable app source");
  }
  assert.equal(/DOCTOR_ANURAGH_PRICING|DOCTOR_PALAK_DHANASHREE_PRICING/.test(source), false, "clinic pricing symbols must stay out of publishable app source");
});
