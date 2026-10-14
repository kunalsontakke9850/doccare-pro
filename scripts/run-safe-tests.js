const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveEnvironmentConfig } = require("../config/environment.js");
const { assertSafeTestMutation } = require("./test-safety.js");

const mode = process.argv[2] || "all";
const root = path.join(__dirname, "..");
const testConfig = JSON.parse(fs.readFileSync(path.join(root, "config", "environments", "test.json"), "utf8"));
const config = resolveEnvironmentConfig({ environment: "test", configs: { test: testConfig } });
assertSafeTestMutation(config, "test suite");

const deploymentSourceTests = new Set([
  "apps-script-records-page.test.js",
  "cloud-reliability.test.js",
  "doctor-reference.test.js",
  "payment-method.test.js"
]);
const files = mode === "stage-b"
  ? [path.join(root, "tests", "stage-b-environment.test.js")]
  : mode === "stage-c"
    ? [path.join(root, "tests", "stage-c-security.test.js")]
  : fs.readdirSync(path.join(root, "tests"))
    .filter(name => name.endsWith(".test.js"))
    .filter(name => fs.existsSync(path.join(root, "apps-script.gs")) || !deploymentSourceTests.has(name))
    .sort()
    .map(name => path.join(root, "tests", name));

if (!files.length) throw new Error("No test files were found.");
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  env: { ...process.env, DOCCARE_ENV: "test" },
  stdio: "inherit"
});
process.exit(result.status ?? 1);
