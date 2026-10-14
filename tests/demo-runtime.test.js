const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveEndpoint } = require("../cloud-sync.js");
const { buildDemo } = require("../scripts/build-demo.js");
const { createDemoServer } = require("../scripts/start-demo.js");

test("demo runtime resolves only its same-origin API route", () => {
  assert.equal(resolveEndpoint({ appConfig: {
    ENVIRONMENT: "demo",
    DEMO_MODE: true,
    API_BASE_URL: "/demo-api"
  } }), "/demo-api");
  assert.throws(() => resolveEndpoint({ appConfig: {
    ENVIRONMENT: "demo",
    API_BASE_URL: "https://script.google.com/macros/s/production/exec"
  } }), /demo.*same-origin/i);
});

test("demo clients use the isolated adapter for cloud and session requests", () => {
  const patient = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

  assert.equal((patient.match(/window\.APP_CONFIG\?\.DEMO_MODE\s*\?\s*window\.DemoBackend\.createFetch\(\)/g) || []).length, 2);
  assert.match(html, /demo-backend\.js/);
  assert.match(patient, /demoNotice/);
  assert.match(patient, /adminAccessBtn[\s\S]*?disabled/);
  assert.match(patient, /let doctorReferenceAccessUnlocked = window\.APP_CONFIG\?\.DEMO_MODE === true/);
});

test("demo builder emits only its allowlisted app files and a safe runtime config", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "doccare-demo-"));
  try {
    const emitted = buildDemo({ outputDir });
    const relative = emitted.map(file => path.relative(outputDir, file).replace(/\\/g, "/")).sort();
    const config = fs.readFileSync(path.join(outputDir, "config.js"), "utf8");

    assert.ok(relative.includes("config.js"));
    assert.ok(relative.includes("demo-backend.js"));
    assert.ok(relative.includes("index.html"));
    assert.ok(relative.every(file => !/apps-script|admin\.html|admin\.js|DocCarePro-Desktop|node_modules|\.env/i.test(file)));
    assert.match(config, /ENVIRONMENT:\s*["']demo["']/);
    assert.match(config, /DEMO_MODE:\s*true/);
    assert.match(config, /API_BASE_URL:\s*["']\/demo-api["']/);
    assert.match(config, /subtitle:\s*["']Sample receipt["']/);
    assert.match(config, /address:\s*["']["']/);
    assert.match(config, /hours:\s*["']["']/);
    assert.doesNotMatch(config, /script\.google\.com|DOCCARE_GATEWAY_SECRET|SHEET_ID/i);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("demo build never copies a private runtime config or Apps Script deployment file", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "doccare-demo-private-"));
  try {
    buildDemo({ outputDir });
    assert.equal(fs.existsSync(path.join(outputDir, "apps-script.gs")), false);
    assert.equal(fs.existsSync(path.join(outputDir, "admin.html")), false);
    assert.equal(fs.existsSync(path.join(outputDir, "DocCarePro-Desktop")), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("local demo server serves only the built app and blocks traversal and API proxying", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "doccare-demo-server-"));
  const server = createDemoServer({ rootDir: outputDir });
  try {
    buildDemo({ outputDir });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const home = await fetch(baseUrl);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /DocCare Pro/);
    const api = await fetch(`${baseUrl}/demo-api?op=records`);
    assert.equal(api.status, 404);
    const traversal = await fetch(`${baseUrl}/..%2Fpackage.json`);
    assert.equal(traversal.status, 403);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
