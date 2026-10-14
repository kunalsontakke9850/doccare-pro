(function attachAdminConfigEditor(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.AdminConfigEditor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createAdminConfigEditor() {
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeOptionValues(values) {
    return (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
  }

  function safeIdPart(value, fallback) {
    const cleaned = String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return cleaned || fallback;
  }

  function buildOptionRows(values, groupLabel, groupKey) {
    const label = String(groupLabel || "Option");
    const idPrefix = safeIdPart(groupKey, "admin-options");

    return normalizeOptionValues(values)
      .map((value, index) => {
        const position = index + 1;
        const inputId = `${idPrefix}-option-${position}`;
        const escapedValue = escapeHtml(value);
        const escapedLabel = escapeHtml(label);

        return `
          <div class="admin-option-row">
            <span class="admin-option-index" aria-hidden="true">${position}</span>
            <label class="sr-only" for="${inputId}">${escapedLabel} ${position}</label>
            <input
              id="${inputId}"
              class="admin-option-input"
              type="text"
              value="${escapedValue}"
              autocomplete="off"
              aria-label="${escapedLabel} ${position}"
            />
            <button
              class="admin-option-remove"
              type="button"
              aria-label="Remove ${escapedLabel.toLowerCase()} ${position}"
              title="Remove option"
            >Remove</button>
          </div>`;
      })
      .join("");
  }

  function numericValue(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function buildRadiologistCard(doctor, scanTypes, index) {
    const safeDoctor = doctor && typeof doctor === "object" ? doctor : {};
    const doctorIndex = Number.isInteger(index) && index >= 0 ? index : 0;
    const position = doctorIndex + 1;
    const name = String(safeDoctor.name || "").trim();
    const pricing = safeDoctor.pricing && typeof safeDoctor.pricing === "object"
      ? safeDoctor.pricing
      : {};
    const normalizedScanTypes = normalizeOptionValues(scanTypes);
    const nameId = `admin-radiologist-name-${position}`;
    const feeId = `admin-radiologist-fee-${position}`;
    const escapedName = escapeHtml(name);

    const pricingFields = normalizedScanTypes
      .map((scanType, scanIndex) => {
        const fieldId = `admin-radiologist-${position}-scan-fee-${scanIndex + 1}`;
        const escapedScanType = escapeHtml(scanType);
        return `
          <label class="admin-pricing-item" for="${fieldId}">
            <span>${escapedScanType}</span>
            <span class="admin-money-field">
              <span aria-hidden="true">&#8377;</span>
              <input
                id="${fieldId}"
                class="admin-doctor-scan-fee"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                data-scan-type="${escapedScanType}"
                value="${numericValue(pricing[scanType])}"
                aria-label="${escapedScanType} fee"
              />
            </span>
          </label>`;
      })
      .join("");

    return `
      <article class="admin-row admin-radiologist-card" data-index="${doctorIndex}">
        <header class="admin-radiologist-card-head">
          <div>
            <p class="admin-card-kicker">Radiologist ${position}</p>
            <h4>${escapedName || "New radiologist"}</h4>
          </div>
          <button
            type="button"
            class="danger-btn admin-remove-radiologist"
            aria-label="Remove ${escapedName || `radiologist ${position}`}"
          >Remove</button>
        </header>

        <div class="admin-radiologist-primary">
          <label class="admin-field-label" for="${nameId}">
            <span>Radiologist name</span>
            <input
              id="${nameId}"
              class="admin-doctor-name"
              type="text"
              value="${escapedName}"
              autocomplete="off"
              placeholder="Enter radiologist name"
            />
          </label>

          <label class="admin-field-label" for="${feeId}">
            <span>Default fee</span>
            <span class="admin-money-field">
              <span aria-hidden="true">&#8377;</span>
              <input
                id="${feeId}"
                class="admin-doctor-fee"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                value="${numericValue(safeDoctor.fee)}"
              />
            </span>
          </label>
        </div>

        <div class="admin-pricing-section">
          <div class="admin-pricing-heading">
            <h5>Fees by scan type</h5>
            <p>Set the amount used for each scan option.</p>
          </div>
          <div class="admin-pricing-grid">${pricingFields}</div>
        </div>
      </article>`;
  }

  function withPreservedReferringDoctors(editableConfig, currentConfig, fallbackDoctors) {
    const currentDoctors = normalizeOptionValues(currentConfig?.referringDoctors);
    const defaults = normalizeOptionValues(fallbackDoctors);

    return {
      ...(editableConfig && typeof editableConfig === "object" ? editableConfig : {}),
      referringDoctors: (currentDoctors.length ? currentDoctors : defaults).slice(),
    };
  }

  return {
    buildOptionRows,
    buildRadiologistCard,
    normalizeOptionValues,
    withPreservedReferringDoctors,
  };
});
