const fs = require("node:fs");
const path = require("node:path");
const { resolveEnvironmentConfig } = require("../config/environment.js");
const { createGatewayServer } = require("../gateway/server.js");

const ROOT = path.join(__dirname, "..");
const ENVIRONMENT_FILES = {
  development: "development.json",
  test: "test.json"
};

function resolveStartConfiguration(environment) {
  if (environment === "production") {
    return {
      environment: "production",
      endpoint: "https://script.google.com/macros/s/EXPLICIT_PRODUCTION_CONFIG/exec",
      transport: "apps-script-direct"
    };
  }
  const fileName = ENVIRONMENT_FILES[environment];
  if (!fileName) throw new Error(`Unknown start environment: ${environment}`);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "environments", fileName), "utf8"));
  return resolveEnvironmentConfig({ environment, configs: { [environment]: config } });
}

function buildRuntimeConfigSource(config, { productionSource = "" } = {}) {
  if (config.environment === "production") {
    if (!productionSource) throw new Error("Explicit production startup requires a renderer-safe production config source.");
    if (/DOCCARE_APPS_SCRIPT_URL|DOCCARE_GATEWAY_SECRET|hmac/i.test(productionSource)) {
      throw new Error("Production renderer config contains forbidden gateway signing material.");
    }
    return productionSource;
  }
  return `window.APP_CONFIG = ${JSON.stringify({
    ENVIRONMENT: config.environment,
    API_BASE_URL: config.endpoint,
    AUTO_REFRESH_MS: 0
  }, null, 2)};\n`;
}

function resolveStaticPath(rootDir, requestUrl) {
  const pathname = decodeURIComponent(String(requestUrl || "/").split("?")[0]);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^[/\\]+/, "");
  const resolved = path.resolve(rootDir, relative);
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const error = new Error("Path escapes static root.");
    error.code = "PATH_TRAVERSAL";
    throw error;
  }
  return resolved;
}

function createStaticServer({ rootDir = ROOT, config, productionSource = "", upstreamEndpoint, secretProvider, deviceIdProvider, deviceIdFilePath, fetchImpl, cloudClient } = {}) {
  if (!config) throw new Error("Static server requires an explicit environment config.");
  const runtimeConfigSource = buildRuntimeConfigSource(config, { productionSource });
  const unavailableClient = {
    request: async () => {
      const error = new Error("Gateway upstream is not configured for this environment.");
      error.code = "GATEWAY_NOT_CONFIGURED";
      error.status = 503;
      throw error;
    }
  };
  return createGatewayServer({
    staticRoot: rootDir,
    runtimeConfigSource,
    cloudClient: cloudClient || (upstreamEndpoint && secretProvider ? undefined : unavailableClient),
    upstreamEndpoint,
    secretProvider,
    deviceIdProvider,
    deviceIdFilePath,
    fetchImpl
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml"
  })[ext] || "application/octet-stream";
}

function startFromCommandLine() {
  const environment = process.argv[2] || "development";
  const config = resolveStartConfiguration(environment);
  const productionSource = environment === "production" ? fs.readFileSync(path.join(ROOT, "config.js"), "utf8") : "";
  const upstreamEndpoint = process.env.DOCCARE_APPS_SCRIPT_URL || "";
  const secret = process.env.DOCCARE_GATEWAY_SECRET || "";
  const server = createStaticServer({
    config,
    productionSource,
    upstreamEndpoint,
    secretProvider: secret ? () => secret : undefined,
    deviceIdFilePath: process.env.DOCCARE_DEVICE_ID_FILE || path.join(process.env.LOCALAPPDATA || ROOT, "DocCare Pro", "device-id")
  });
  const preferredPort = Number(process.env.DOCCARE_PORT || 3050);
  const ports = [preferredPort, preferredPort + 1, preferredPort + 2, preferredPort + 3, preferredPort + 4];
  const listen = index => {
    if (index >= ports.length) throw new Error("No safe loopback port is available.");
    server.once("error", error => {
      if (error.code === "EADDRINUSE") listen(index + 1);
      else throw error;
    });
    server.listen(ports[index], "127.0.0.1", () => {
      console.log(`DocCare Pro ${environment} server: http://127.0.0.1:${ports[index]}`);
    });
  };
  listen(0);
}

if (require.main === module) startFromCommandLine();

module.exports = {
  buildRuntimeConfigSource,
  resolveStartConfiguration,
  resolveStaticPath,
  createStaticServer
};
