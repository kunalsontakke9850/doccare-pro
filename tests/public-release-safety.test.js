const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { scanPublicRelease, inspectContent, readPrivateValues } = require("../scripts/check-public-release.js");

test("public release scan accepts the safe source tree and generated demo", () => {
  const result = scanPublicRelease({ rootDir: path.join(__dirname, "..") });
  assert.equal(result.ok, true, "release tree must pass the local safety scan");
  assert.ok(result.scannedFiles > 20);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "demo-dist", "images", "Varhad.png")), false);
});

test("scanner reports a generic issue without echoing private values", () => {
  const filePath = path.join(os.tmpdir(), `doccare-release-${process.pid}.js`);
  const value = "LOCAL_PRIVATE_TEST_VALUE_93F1";
  try {
    fs.writeFileSync(filePath, `const hidden = "${value}";`);
    const result = inspectContent({ files: [filePath], forbiddenValues: [value] });
    assert.deepEqual(result.issues, [{ code: "private_value_leak", file: path.basename(filePath) }]);
    assert.equal(JSON.stringify(result).includes(value), false);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("private bill print details are included in release leak checks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `doccare-bill-private-${process.pid}-`));
  const privateValue = "PRIVATE_BILL_ADDRESS_TEST_74B2";
  try {
    fs.writeFileSync(path.join(root, "config.js"), `window.APP_CONFIG = { CLINIC_PRINTING: { address: "${privateValue}" } };`);
    fs.writeFileSync(path.join(root, "patient.js"), `const address = "${privateValue}";`);
    const values = readPrivateValues(root);
    assert.ok(values.includes(privateValue), "private bill details must be scanned");
    const result = inspectContent({ files: [path.join(root, "patient.js")], forbiddenValues: values });
    assert.deepEqual(result.issues, [{ code: "private_value_leak", file: "patient.js" }]);
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
