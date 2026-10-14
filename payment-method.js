(function attachPaymentMethods(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.PaymentMethods = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPaymentMethods() {
  const PAYMENT_TYPES = new Set(["Cash", "Online", "Split Payment"]);

  function toCents(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : 0;
  }

  function fromCents(value) {
    return value / 100;
  }

  function normalizePaymentBreakdown({ totalFees = 0, paymentType = "Cash", cashAmount = 0, onlineAmount = 0 } = {}) {
    const totalCents = toCents(totalFees);
    const type = PAYMENT_TYPES.has(paymentType) ? paymentType : "Cash";

    if (type === "Cash") {
      return { ok: true, paymentMethod: "Cash", cashAmount: fromCents(totalCents), onlineAmount: 0 };
    }

    if (type === "Online") {
      return { ok: true, paymentMethod: "Online", cashAmount: 0, onlineAmount: fromCents(totalCents) };
    }

    const cashCents = toCents(cashAmount);
    const onlineCents = toCents(onlineAmount);
    if (cashCents + onlineCents !== totalCents) {
      return {
        ok: false,
        message: "Cash Amount plus Online Amount must equal the Total Fees."
      };
    }

    return {
      ok: true,
      paymentMethod: "Split Payment",
      cashAmount: fromCents(cashCents),
      onlineAmount: fromCents(onlineCents)
    };
  }

  function isStoredPaymentMethod(value) {
    return PAYMENT_TYPES.has(value);
  }

  function recordIdentity(entry) {
    return [
      String(entry.date || "").trim(),
      String(entry.patientName || "").trim().toLowerCase(),
      String(entry.refDoctor || "").trim().toLowerCase(),
      toCents(entry.totalFees)
    ].join("\u0001");
  }

  function restoreMissingPaymentDetails(records, cachedRecords) {
    const availableByIdentity = new Map();

    (Array.isArray(cachedRecords) ? cachedRecords : []).forEach((entry) => {
      if (!isStoredPaymentMethod(entry.paymentMethod)) return;
      const key = recordIdentity(entry);
      const matches = availableByIdentity.get(key) || [];
      matches.push(entry);
      availableByIdentity.set(key, matches);
    });

    return (Array.isArray(records) ? records : []).map((entry) => {
      if (isStoredPaymentMethod(entry.paymentMethod)) return entry;
      const matches = availableByIdentity.get(recordIdentity(entry));
      const cachedEntry = matches && matches.shift();
      if (!cachedEntry) return entry;

      return {
        ...entry,
        paymentMethod: cachedEntry.paymentMethod,
        cashAmount: cachedEntry.cashAmount,
        onlineAmount: cachedEntry.onlineAmount
      };
    });
  }

  return { normalizePaymentBreakdown, restoreMissingPaymentDetails };
});
