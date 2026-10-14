const ENVIRONMENTS = Object.freeze(["development", "test", "production"]);
const ALLOWED_TRANSPORTS = Object.freeze(["local-gateway", "fixture", "apps-script-direct"]);

class EnvironmentConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "EnvironmentConfigError";
    this.code = code;
  }
}

function isRecognizedEnvironment(value) {
  return ENVIRONMENTS.includes(value);
}

function isProductionHost(endpoint) {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === "script.google.com" || hostname.endsWith(".script.google.com");
  } catch {
    return false;
  }
}

function validateEnvironmentConfig(input) {
  if (!input || typeof input !== "object") {
    throw new EnvironmentConfigError("Environment configuration is required.", "CONFIG_REQUIRED");
  }
  if (!isRecognizedEnvironment(input.environment)) {
    throw new EnvironmentConfigError("Environment must be development, test, or production.", "ENVIRONMENT_UNKNOWN");
  }
  if (typeof input.endpoint !== "string" || !input.endpoint.trim()) {
    throw new EnvironmentConfigError(`Endpoint is required for ${input.environment}.`, "ENDPOINT_REQUIRED");
  }

  let parsed;
  try {
    parsed = new URL(input.endpoint);
  } catch {
    throw new EnvironmentConfigError("Environment endpoint must be a valid URL.", "ENDPOINT_INVALID");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new EnvironmentConfigError("Environment endpoint must use HTTP or HTTPS.", "ENDPOINT_PROTOCOL");
  }
  if (input.environment === "test" && isProductionHost(parsed.href)) {
    throw new EnvironmentConfigError("Test environment cannot target the Apps Script production host.", "TEST_ENDPOINT_PRODUCTION_HOST");
  }
  if (!ALLOWED_TRANSPORTS.includes(input.transport)) {
    throw new EnvironmentConfigError("Environment transport is not recognized.", "TRANSPORT_UNKNOWN");
  }
  if (input.environment === "test" && input.transport === "apps-script-direct") {
    throw new EnvironmentConfigError("Test environment cannot use direct Apps Script transport.", "TEST_TRANSPORT_PRODUCTION");
  }
  if (input.environment === "production" && input.transport !== "apps-script-direct") {
    throw new EnvironmentConfigError("Production environment must use the approved Apps Script transport during Stage B.", "PRODUCTION_TRANSPORT_INVALID");
  }
  return Object.freeze({
    environment: input.environment,
    endpoint: parsed.href,
    transport: input.transport,
    productionIdentifier: input.productionIdentifier || null
  });
}

function resolveEnvironmentConfig({ environment, configs = {} } = {}) {
  if (typeof environment !== "string" || !environment.trim()) {
    throw new EnvironmentConfigError("An explicit environment is required; no production fallback is allowed.", "ENVIRONMENT_REQUIRED");
  }
  if (!isRecognizedEnvironment(environment)) {
    throw new EnvironmentConfigError("Environment must be development, test, or production.", "ENVIRONMENT_UNKNOWN");
  }
  if (!configs[environment]) {
    throw new EnvironmentConfigError(`Configuration for ${environment} is missing.`, "CONFIG_MISSING");
  }
  return validateEnvironmentConfig({ ...configs[environment], environment });
}

module.exports = {
  ENVIRONMENTS,
  ALLOWED_TRANSPORTS,
  EnvironmentConfigError,
  isProductionHost,
  validateEnvironmentConfig,
  resolveEnvironmentConfig
};
