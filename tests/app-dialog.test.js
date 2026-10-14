const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createAppDialogController } = require("../app-dialog.js");

class TestElement extends EventTarget {
  constructor(document) {
    super();
    this.ownerDocument = document;
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.className = "";
    this.isConnected = true;
  }
  focus() { this.ownerDocument.activeElement = this; }
  setAttribute() {}
}

function createDialogHarness() {
  const document = { activeElement: null };
  const dialog = new TestElement(document);
  dialog.open = false;
  dialog.returnValue = "";
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = value => {
    dialog.returnValue = value || "";
    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));
  };
  const elements = Object.fromEntries(["title", "message", "input", "confirmButton", "cancelButton"].map(key => [key, new TestElement(document)]));
  return {
    document,
    dialog,
    elements,
    controller: createAppDialogController({ document, dialog, ...elements })
  };
}

test("app confirmation resolves true only for the explicit confirm action and restores focus", async () => {
  const harness = createDialogHarness();
  const trigger = new TestElement(harness.document);
  harness.document.activeElement = trigger;
  const result = harness.controller.confirm({
    title: "Delete record?",
    message: "This action cannot be undone.",
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    danger: true
  });

  assert.equal(harness.elements.title.textContent, "Delete record?");
  assert.equal(harness.elements.message.textContent, "This action cannot be undone.");
  assert.equal(harness.elements.confirmButton.textContent, "Delete");
  assert.equal(harness.elements.cancelButton.hidden, false);
  assert.equal(harness.elements.cancelButton.className, "app-dialog-cancel");
  assert.equal(harness.elements.confirmButton.className, "app-dialog-confirm is-danger");
  assert.equal(harness.document.activeElement, harness.elements.cancelButton);
  harness.dialog.close("cancel");
  assert.equal(await result, false);
  assert.equal(harness.document.activeElement, trigger);
});

test("app notice hides Cancel and resolves after its single action", async () => {
  const harness = createDialogHarness();
  const result = harness.controller.notice({ title: "Attention", message: "Please retry.", confirmLabel: "OK" });
  assert.equal(harness.elements.cancelButton.hidden, true);
  assert.equal(harness.document.activeElement, harness.elements.confirmButton);
  harness.dialog.close("confirm");
  assert.equal(await result, true);
});

test("app text prompt returns edited text on confirm and null on cancel", async () => {
  const harness = createDialogHarness();
  const trigger = new TestElement(harness.document);
  harness.document.activeElement = trigger;
  const confirmed = harness.controller.prompt({ title: "Edit name", message: "Doctor name", value: "Dr. Rao" });
  assert.equal(harness.elements.input.hidden, false);
  assert.equal(harness.elements.input.value, "Dr. Rao");
  assert.equal(harness.document.activeElement, harness.elements.input);
  harness.elements.input.value = "Dr. Rao Updated";
  harness.dialog.close("confirm");
  assert.equal(await confirmed, "Dr. Rao Updated");
  assert.equal(harness.document.activeElement, trigger);

  harness.dialog.returnValue = "confirm";
  const cancelled = harness.controller.prompt({ title: "Edit name", message: "Doctor name", value: "Dr. Rao" });
  assert.equal(harness.dialog.returnValue, "", "each new dialog must clear stale confirmation state for Escape");
  harness.dialog.close("cancel");
  assert.equal(await cancelled, null);
});

test("patient-facing notices, confirmations, and prompts no longer use native system dialogs", () => {
  const patientSource = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  assert.doesNotMatch(patientSource, /(?<![.\w])(?:alert|confirm|prompt)\s*\(/);
  assert.match(patientSource, /appDialog\.confirm\(/);
  assert.match(patientSource, /appDialog\.notice\(/);
  assert.match(patientSource, /appDialog\.prompt\(/);
});

test("the reusable prompt input stays hidden for confirmations and notices", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "patient.css"), "utf8");
  assert.match(styles, /\.app-dialog-input\[hidden\]\s*\{\s*display:\s*none\s*;/);
});

test("patient record row actions have matching button sizing and no conflicting inline styles", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "patient.css"), "utf8");
  const patientSource = fs.readFileSync(path.join(__dirname, "..", "patient.js"), "utf8");
  assert.match(styles, /\.btn-table-edit\s*,\s*\.btn-table-delete\s*\{[^}]*width:\s*64px/);
  assert.match(styles, /\.btn-table-delete\s*\{[^}]*margin-top:\s*4px/);
  assert.doesNotMatch(patientSource, /class="btn-table-delete"[^>]*style=/);
});
