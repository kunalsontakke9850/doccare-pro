(function attachAdminAuth(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.AdminAuth = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createAdminAuth(root) {
  const CREDENTIAL_VERSION = 1;
  const CREDENTIAL_ALGORITHM = "PBKDF2-SHA-256";
  const DEFAULT_ITERATIONS = 210000;
  const MIN_ITERATIONS = 100000;

  function getCrypto() {
    if (!root.crypto?.subtle || typeof root.crypto.getRandomValues !== "function") {
      throw new Error("Secure password storage is not supported in this environment.");
    }
    return root.crypto;
  }

  function bytesToBase64(bytes) {
    if (typeof root.btoa === "function") {
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      return root.btoa(binary);
    }
    return Buffer.from(bytes).toString("base64");
  }

  function base64ToBytes(value) {
    if (typeof root.atob === "function") {
      const binary = root.atob(value);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }
    return Uint8Array.from(Buffer.from(value, "base64"));
  }

  function isBase64(value, minimumLength) {
    return (
      typeof value === "string" &&
      value.length >= minimumLength &&
      value.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    );
  }

  function normalizePasswordCredential(credential) {
    if (!credential || typeof credential !== "object") return null;

    const iterations = Number(credential.iterations);
    if (
      credential.version !== CREDENTIAL_VERSION ||
      credential.algorithm !== CREDENTIAL_ALGORITHM ||
      !Number.isInteger(iterations) ||
      iterations < MIN_ITERATIONS ||
      iterations > 1000000 ||
      !isBase64(credential.salt, 20) ||
      !isBase64(credential.hash, 40)
    ) {
      return null;
    }

    return {
      version: CREDENTIAL_VERSION,
      algorithm: CREDENTIAL_ALGORITHM,
      iterations,
      salt: credential.salt,
      hash: credential.hash,
    };
  }

  async function derivePasswordHash(password, salt, iterations) {
    const cryptoApi = getCrypto();
    const encoder = new TextEncoder();
    const keyMaterial = await cryptoApi.subtle.importKey(
      "raw",
      encoder.encode(String(password)),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await cryptoApi.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations,
      },
      keyMaterial,
      256
    );
    return new Uint8Array(bits);
  }

  function equalBytes(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
      difference |= left[index] ^ right[index];
    }
    return difference === 0;
  }

  async function createPasswordCredential(password) {
    const cryptoApi = getCrypto();
    const salt = cryptoApi.getRandomValues(new Uint8Array(16));
    const hash = await derivePasswordHash(password, salt, DEFAULT_ITERATIONS);

    return {
      version: CREDENTIAL_VERSION,
      algorithm: CREDENTIAL_ALGORITHM,
      iterations: DEFAULT_ITERATIONS,
      salt: bytesToBase64(salt),
      hash: bytesToBase64(hash),
    };
  }

  async function verifyPassword(password, credential, fallbackPassword = root.APP_CONFIG?.INITIAL_ADMIN_PASSWORD || "") {
    if (credential !== null && credential !== undefined) {
      const normalized = normalizePasswordCredential(credential);
      if (!normalized) return false;

      try {
        const actual = await derivePasswordHash(
          password,
          base64ToBytes(normalized.salt),
          normalized.iterations
        );
        return equalBytes(actual, base64ToBytes(normalized.hash));
      } catch (_error) {
        return false;
      }
    }

    const encoder = new TextEncoder();
    if (!fallbackPassword) return false;
    return equalBytes(
      encoder.encode(String(password ?? "")),
      encoder.encode(String(fallbackPassword ?? ""))
    );
  }

  function validatePasswordChange(values) {
    const currentPassword = String(values?.currentPassword ?? "");
    const newPassword = String(values?.newPassword ?? "");
    const confirmPassword = String(values?.confirmPassword ?? "");

    if (!currentPassword) {
      return {
        ok: false,
        field: "currentPassword",
        code: "CURRENT_REQUIRED",
        message: "Enter your current admin password.",
      };
    }
    if (newPassword.length < 8 || newPassword.trim().length < 8) {
      return {
        ok: false,
        field: "newPassword",
        code: "NEW_TOO_SHORT",
        message: "Use at least 8 characters for the new password.",
      };
    }
    if (newPassword !== confirmPassword) {
      return {
        ok: false,
        field: "confirmPassword",
        code: "CONFIRM_MISMATCH",
        message: "The new passwords do not match.",
      };
    }
    if (newPassword === currentPassword) {
      return {
        ok: false,
        field: "newPassword",
        code: "PASSWORD_UNCHANGED",
        message: "Choose a password different from the current password.",
      };
    }
    return { ok: true };
  }

  function withPreservedCredential(editableConfig, currentConfig) {
    const credential = normalizePasswordCredential(currentConfig?.adminCredential);
    return {
      ...(editableConfig && typeof editableConfig === "object" ? editableConfig : {}),
      adminCredential: credential ? { ...credential } : null,
    };
  }

  return {
    createPasswordCredential,
    normalizePasswordCredential,
    validatePasswordChange,
    verifyPassword,
    withPreservedCredential,
  };
});
