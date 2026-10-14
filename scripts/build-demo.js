const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ALLOWLIST = [
  "index.html", "patient.css", "patient.js", "demo-backend.js", "cloud-sync.js",
  "admin-auth.js", "admin-config-editor.js", "doctor-reference.js", "payment-method.js",
  "sync-recovery.js", "records-paging.js", "app-dialog.js", "expenses.js"
];
const DEMO_CONFIG = `window.APP_CONFIG = {
  ENVIRONMENT: "demo",
  DEMO_MODE: true,
  API_BASE_URL: "/demo-api",
  AUTO_REFRESH_MS: 0,
  CLINIC_NAME: "DocCare Pro Demo",
  CLINIC_PRINTING: {
    name: "DocCare Pro Demo",
    subtitle: "Sample receipt",
    address: "",
    hours: ""
  },
  CLINIC_CONFIG: {
    scanTypes: ["CBCT", "2D"],
    twoDScanTypes: ["OPG", "Lateral Ceph"],
    purposes: ["Implant planning", "Orthodontic assessment"],
    radiologists: [{ name: "Demo Radiologist", fee: 500, pricing: { CBCT: 2400, "2D": 900 } }]
  },
  CLINIC_REFERRING_DOCTORS: ["Demo Doctor One", "Demo Doctor Two"]
};
`;

function buildDemo({ outputDir = path.join(ROOT, "demo-dist") } = {}) {
  const destination = path.resolve(outputDir);
  const defaultOutput = path.join(ROOT, "demo-dist");
  const tempRoot = path.resolve(os.tmpdir());
  if (destination !== defaultOutput && !destination.startsWith(tempRoot + path.sep)) {
    throw new Error("Demo output must be demo-dist or a dedicated temporary test directory.");
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const emitted = [];
  for (const relative of ALLOWLIST) {
    const source = path.join(ROOT, relative);
    const target = path.join(destination, relative);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`Required demo asset is missing: ${relative}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    emitted.push(target);
  }
  const configPath = path.join(destination, "config.js");
  fs.writeFileSync(configPath, DEMO_CONFIG, "utf8");
  emitted.push(configPath);
  return emitted;
}

if (require.main === module) {
  const files = buildDemo();
  process.stdout.write(`Built browser demo with ${files.length} allowlisted files.\n`);
}

module.exports = { ALLOWLIST: [...ALLOWLIST], DEMO_CONFIG, buildDemo };
