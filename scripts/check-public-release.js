const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync, spawnSync } = require("node:child_process");
const { ALLOWLIST } = require("./build-demo.js");

const PRIVATE_PATHS = [
  /(^|\/)config\.js$/i,
  /(^|\/)apps-script\.gs$/i,
  /(^|\/)appscript_setup\.md$/i,
  /(^|\/)doccarepro-desktop(\/|$)/i,
  /(^|\/)admin\.(html|js|css)$/i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.claude(\/|$)/i,
  /(^|\/)\.superpowers(\/|$)/i,
  /(^|\/)docs(\/|$)/i,
  /(^|\/)agents\.md$/i,
  /\.(csv|xlsx?|sqlite|db|msi|exe)$/i
];
const REQUIRED_IGNORES = ["config.js", "apps-script.gs", "APPSCRIPT_SETUP.md", "DocCarePro-Desktop/package.json", "AGENTS.md", "docs/superpowers/plan.md", "images/Varhad.png"];

function inspectContent({ files, forbiddenValues = [] }) {
  const issues = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath); }
    catch { issues.push({ code: "unreadable_file", file: path.basename(filePath) }); continue; }
    if (content.includes(0)) continue;
    const source = content.toString("utf8");
    if (forbiddenValues.some(value => typeof value === "string" && value.length > 0 && source.includes(value))) {
      issues.push({ code: "private_value_leak", file: path.basename(filePath) });
    }
    if (/AKfycb[A-Za-z0-9_-]{20,}/.test(source)) issues.push({ code: "deployment_token_pattern", file: path.basename(filePath) });
  }
  return { issues };
}

function getCandidateFiles(rootDir) {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: rootDir });
  return output.toString("utf8").split("\0").filter(Boolean).map(file => path.resolve(rootDir, file));
}

function readPrivateValues(rootDir) {
  const values = [];
  const privateConfigPath = path.join(rootDir, "config.js");
  if (fs.existsSync(privateConfigPath)) {
    try {
      const context = { window: { APP_CONFIG: {} } };
      vm.runInNewContext(fs.readFileSync(privateConfigPath, "utf8"), context, { timeout: 1000 });
      const config = context.window.APP_CONFIG || {};
      values.push(config.SCRIPT_URL, config.INITIAL_ADMIN_PASSWORD);
      values.push(config.CLINIC_NAME);
      values.push(...Object.values(config.CLINIC_PRINTING || {}));
      values.push(...Object.keys(config.CLINIC_PRESET_PRICING || {}));
      values.push(...(config.CLINIC_REFERRING_DOCTORS || []).filter(name => {
        const normalized = String(name).trim().toLowerCase();
        return normalized.split(/\s+/).length > 1 && !["not applicable", "not available"].includes(normalized);
      }));
      values.push(...(config.CLINIC_CONFIG?.radiologists || [])
        .map(row => row.name)
        .filter(name => !["not applicable", "not available"].includes(String(name).trim().toLowerCase())));
    } catch {
      values.push("__invalid-private-config-sentinel__");
    }
  }
  const appsScriptPath = path.join(rootDir, "apps-script.gs");
  if (fs.existsSync(appsScriptPath)) {
    const source = fs.readFileSync(appsScriptPath, "utf8");
    const sheetId = /(?:openById|SPREADSHEET_ID\s*=)\s*\(?\s*["']([A-Za-z0-9_-]{20,})["']/.exec(source)?.[1];
    if (sheetId) values.push(sheetId);
  }
  return [...new Set(values.filter(value => typeof value === "string" && value.length >= 4))];
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

function checkIgnored(rootDir, relativePath) {
  const result = spawnSync("git", ["check-ignore", "--no-index", "-q", relativePath], { cwd: rootDir });
  return result.status === 0;
}

function scanPublicRelease({ rootDir = path.resolve(__dirname, "..") } = {}) {
  const issues = [];
  const relativeFiles = getCandidateFiles(rootDir).map(file => path.relative(rootDir, file).replace(/\\/g, "/"));
  for (const relative of relativeFiles) {
    if (PRIVATE_PATHS.some(pattern => pattern.test(relative))) issues.push({ code: "private_path_in_release", file: relative });
  }
  for (const relative of REQUIRED_IGNORES) {
    if (!checkIgnored(rootDir, relative)) issues.push({ code: "missing_ignore_rule", file: relative });
  }

  const sourceFiles = relativeFiles.map(file => path.join(rootDir, file)).filter(file => fs.existsSync(file) && fs.statSync(file).isFile());
  issues.push(...inspectContent({ files: sourceFiles, forbiddenValues: readPrivateValues(rootDir) }).issues);

  const demoDirectory = path.join(rootDir, "demo-dist");
  const demoFiles = walkFiles(demoDirectory);
  if (demoFiles.length) {
    const expected = new Set([...ALLOWLIST, "config.js"]);
    const actual = new Set(demoFiles.map(file => path.relative(demoDirectory, file).replace(/\\/g, "/")));
    for (const relative of expected) if (!actual.has(relative)) issues.push({ code: "demo_asset_missing", file: relative });
    for (const relative of actual) if (!expected.has(relative)) issues.push({ code: "demo_asset_not_allowlisted", file: relative });
    issues.push(...inspectContent({ files: demoFiles, forbiddenValues: readPrivateValues(rootDir) }).issues);
  }
  return { ok: issues.length === 0, scannedFiles: sourceFiles.length + demoFiles.length, issues };
}

if (require.main === module) {
  const result = scanPublicRelease();
  if (!result.ok) {
    process.stderr.write(`Public release scan found ${result.issues.length} issue(s):\n`);
    for (const issue of result.issues) process.stderr.write(`- ${issue.code}: ${issue.file}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Public release scan passed (${result.scannedFiles} files checked).\n`);
  }
}

module.exports = { inspectContent, readPrivateValues, scanPublicRelease };
