const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createDeviceIdentity({ filePath } = {}) {
  if (!filePath) throw new Error("Device identity requires a gateway-owned file path.");
  const resolved = path.resolve(filePath);
  let value = "";
  try { value = fs.readFileSync(resolved, "utf8").trim(); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!/^dev_[0-9a-f-]{36}$/i.test(value)) {
    value = `dev_${crypto.randomUUID()}`;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const handle = fs.openSync(resolved, "w", 0o600);
    try { fs.writeFileSync(handle, value, { encoding: "utf8" }); } finally { fs.closeSync(handle); }
  }
  return { get: () => value, filePath: resolved };
}

module.exports = { createDeviceIdentity };
