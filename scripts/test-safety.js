const { isProductionHost } = require("../config/environment.js");

class ProductionSafetyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ProductionSafetyError";
    this.code = code;
  }
}

function assertSafeTestMutation(config, action = "mutation") {
  if (!config || config.environment !== "test") {
    throw new ProductionSafetyError(
      `Refusing ${action}: test mutations require the explicit test environment.`,
      "TEST_ENVIRONMENT_REQUIRED"
    );
  }
  if (isProductionHost(config.endpoint)) {
    throw new ProductionSafetyError(
      `Refusing ${action}: the test environment points at the Apps Script production host.`,
      "PRODUCTION_ENDPOINT"
    );
  }
  if (config.productionIdentifier && String(config.endpoint).includes(config.productionIdentifier)) {
    throw new ProductionSafetyError(
      `Refusing ${action}: the test endpoint matches the configured production identifier.`,
      "PRODUCTION_IDENTIFIER"
    );
  }
}

function assertSafeTestRequest(config, input, init = {}) {
  assertSafeTestMutation(config, String(init.method || "GET").toUpperCase() === "GET" ? "request" : "mutation");
  let url;
  try {
    url = new URL(input, config.endpoint);
  } catch {
    throw new ProductionSafetyError("Refusing request: target URL is invalid.", "TARGET_INVALID");
  }
  if (isProductionHost(url.href)) {
    throw new ProductionSafetyError("Refusing request to a production Apps Script host.", "PRODUCTION_HOST");
  }
}

function createGuardedFetch({ config, fetchImpl = globalThis.fetch } = {}) {
  if (!config) throw new ProductionSafetyError("A test environment config is required.", "CONFIG_REQUIRED");
  if (typeof fetchImpl !== "function") throw new TypeError("createGuardedFetch requires fetchImpl().");
  return async function guardedFetch(input, init = {}) {
    assertSafeTestRequest(config, input, init);
    return fetchImpl(input, init);
  };
}

module.exports = {
  ProductionSafetyError,
  assertSafeTestMutation,
  assertSafeTestRequest,
  createGuardedFetch
};
