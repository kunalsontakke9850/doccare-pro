(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AppDialog = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function createAppDialogController({ document, dialog, title, message, input, confirmButton, cancelButton }) {
    function open(options, mode) {
      if (dialog.open) return Promise.resolve(mode === "prompt" ? null : false);
      const previousFocus = document.activeElement;
      const settings = options || {};
      title.textContent = settings.title || "Confirm action";
      message.textContent = settings.message || "";
      input.hidden = mode !== "prompt";
      input.value = mode === "prompt" ? String(settings.value ?? "") : "";
      input.setAttribute("aria-label", settings.inputLabel || "Value");
      cancelButton.hidden = mode === "notice";
      cancelButton.textContent = settings.cancelLabel || "Cancel";
      cancelButton.className = "app-dialog-cancel";
      confirmButton.textContent = settings.confirmLabel || (mode === "notice" ? "OK" : "Confirm");
      confirmButton.className = `app-dialog-confirm${settings.danger ? " is-danger" : ""}`;

      return new Promise(resolve => {
        dialog.addEventListener("close", function onClose() {
          dialog.removeEventListener("close", onClose);
          const accepted = dialog.returnValue === "confirm";
          const result = mode === "prompt" ? (accepted ? input.value : null) : accepted;
          input.hidden = true;
          if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
          resolve(result);
        });
        dialog.returnValue = "";
        dialog.showModal();
        if (mode === "prompt") input.focus();
        else if (mode === "notice") confirmButton.focus();
        else cancelButton.focus();
      });
    }

    return {
      confirm: options => open(options, "confirm"),
      notice: options => open(options, "notice"),
      prompt: options => open(options, "prompt")
    };
  }

  return { createAppDialogController };
});
