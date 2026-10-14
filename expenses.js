// ============================================================================
// Clinic Expenses Module — Google Sheets ONLY (no localStorage)
// ============================================================================

const EXPENSES_SHEET_NAME  = "Expenses";
const EXPENSES_SHEET_RANGE = "Expenses!A:H";
const EXPENSE_HEADERS_ROW  = ["Date", "Type", "Category", "Description", "Amount", "Payment Method", "ID", "Created At"];
let expenseRefreshPromise = null;
let expensesLoaded = false;

// ── Self-contained helpers (fall back to patient.js globals if loaded first) ──
const expEscapeHtml = (typeof escapeHtml === "function")
  ? escapeHtml
  : (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

const expNormalizeDate = (typeof window !== "undefined" && typeof window.normalizeDate === "function")
  ? window.normalizeDate
  : (d) => {
      if (!d) return "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
      const p = new Date(d);
      if (isNaN(p)) return d;
      return `${p.getFullYear()}-${String(p.getMonth()+1).padStart(2,"0")}-${String(p.getDate()).padStart(2,"0")}`;
    };

const expFormatMoney = (typeof window !== "undefined" && typeof window.formatMoney === "function")
  ? window.formatMoney
  : (v) => "₹" + Number(v || 0).toFixed(2);

// ── Local-storage mirror — safety net if network is down ─────────────────────
const EXP_LS_KEY = "doccare_expenses_mirror_v1";

function expReadMirror() {
  try { return JSON.parse(localStorage.getItem(EXP_LS_KEY) || "[]"); }
  catch { return []; }
}
function expWriteMirror(arr) {
  try { localStorage.setItem(EXP_LS_KEY, JSON.stringify(arr)); } catch {}
}

// ── Apps Script Web App URL ──────────────────────────────────────────────────
function expGetScriptUrl() {
  if (!window.CloudSync || typeof window.CloudSync.resolveEndpoint !== "function") return "";
  try { return window.CloudSync.resolveEndpoint({ appConfig: window.APP_CONFIG }); }
  catch { return ""; }
}

// ── Save one expense row via the Apps Script Web App ─────────────────────────

async function saveExpenseToSheets(expense) {
  const operationId = expense.operationId || `expense-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  expense.operationId = operationId;
  expense.syncStatus = "pending";
  expense.syncError = "";

  // Mirror locally first so the record is never lost on network failure.
  const mirror = expReadMirror();
  if (!mirror.some(item => item.operationId === operationId)) mirror.unshift(expense);
  expWriteMirror(mirror);

  const row = {
    "Operation ID":   operationId,
    "Date":           expense.date,
    "Type":           expense.type,
    "Category":       expense.category,
    "Description":    expense.description,
    "Amount":         expense.amount,
    "Payment Method": expense.paymentMethod,
    "ID":             expense.id,
    "Created At":     expense.createdAt
  };

  if (window.CloudOutbox) {
    window.CloudOutbox.enqueue({
      operationId,
      kind: "expense",
      mirrorKey: EXP_LS_KEY,
      payload: { op: "addExpense", operationId, row }
    });
    if (!expGetScriptUrl()) return { synced: false, pending: true };
    await window.CloudOutbox.sync();
    const pending = window.CloudOutbox.read().some(item => item.operationId === operationId);
    return { synced: !pending, pending };
  }

  throw new Error("Shared cloud outbox is unavailable.");
}

// ── Load all expenses ────────────────────────────────────────────────────────

async function loadExpensesFromSheets() {
  const url = expGetScriptUrl();
  if (!url) {
    // No backend configured — return whatever we have cached locally
    return expReadMirror();
  }

  if (expenseRefreshPromise) return expenseRefreshPromise;
  expenseRefreshPromise = (async () => {
    if (typeof window.cloudGet !== "function") throw new Error("Shared cloud client is unavailable.");
    const data = await window.cloudGet("expenses");

    const remoteExpenses = (data.rows || []).map(r => ({
      operationId:   String(r["Operation ID"] || "").trim(),
      syncStatus:    "synced",
      syncError:     "",
    date:          r["Date"] ? expNormalizeDate(r["Date"]) : "",
    type:          String(r["Type"] || ""),
    category:      String(r["Category"] || ""),
    description:   String(r["Description"] || ""),
    amount:        Number(r["Amount"] || 0),
    paymentMethod: String(r["Payment Method"] || ""),
    id:            String(r["ID"] || ""),
    createdAt:     String(r["Created At"] || "")
    }));

    if (window.CloudOutbox) {
      window.CloudOutbox.reconcile(remoteExpenses.map(expense => expense.operationId));
      const expenses = window.CloudOutbox.mergePending(remoteExpenses, EXP_LS_KEY);
      expWriteMirror(expenses);
      return expenses;
    }
    expWriteMirror(remoteExpenses);
    return remoteExpenses;
  })().finally(() => { expenseRefreshPromise = null; });
  return expenseRefreshPromise;
}

async function ensureExpensesLoaded({ refresh = false } = {}) {
  if (!refresh && expensesLoaded) return expReadMirror();
  renderExpensesTable(expReadMirror());
  try {
    const expenses = await loadExpensesFromSheets();
    expensesLoaded = true;
    renderExpensesTable(expenses);
    return expenses;
  } catch (error) {
    console.warn("Expenses load failed (using local cache):", error);
    const message = (typeof describeApiError === "function")
      ? describeApiError(error)
      : (error?.message || "Could not load expenses. Check the connection and refresh.");
    showExpenseStatus("❌ " + message, "error");
    throw error;
  }
}
if (typeof window !== "undefined") window.ensureExpensesLoaded = ensureExpensesLoaded;

// ── Render table ──────────────────────────────────────────────────────────────

function renderExpensesTable(expenses) {
  const tableBody = document.getElementById('expenseTableBody');
  const totalCell = document.getElementById('totalExpenses');
  if (!tableBody) return;

  if (!expenses || expenses.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#6b7280;padding:24px">No expenses found. Add one above.</td></tr>';
    if (totalCell) totalCell.textContent = '₹0.00';
    return;
  }

  // Sort newest first
  const sorted = [...expenses].sort((a, b) =>
    expNormalizeDate(b.date).localeCompare(expNormalizeDate(a.date))
  );

  let total = 0;
  tableBody.innerHTML = sorted.map(exp => {
    const amt = Number(exp.amount || 0);
    total += amt;
    return `<tr>
      <td>${expEscapeHtml(exp.date)}</td>
      <td>${expEscapeHtml(exp.type)}</td>
      <td>${expEscapeHtml(exp.category)}</td>
      <td>${expEscapeHtml(exp.description)}</td>
      <td style="text-align:right;font-weight:600">${expFormatMoney(amt, true)}</td>
      <td>${expEscapeHtml(exp.paymentMethod)}</td>
      <td><span class="sync-status ${expEscapeHtml(exp.syncStatus || "synced")}">${expEscapeHtml(exp.syncStatus || "synced")}</span></td>
    </tr>`;
  }).join('');

  if (totalCell) totalCell.textContent = expFormatMoney(total, true);
}

// ── Status helpers ────────────────────────────────────────────────────────────

function showExpenseStatus(msg, type = 'success') {
  const el = document.getElementById('expenseStatusMsg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'success' ? '#065f46' : '#991b1b';
  setTimeout(() => { el.textContent = ''; }, 5000);
}

function setExpenseBtn(btn, text, disabled) {
  if (!btn) return;
  btn.textContent = text;
  btn.disabled = disabled;
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initExpensesForm() {
  const expenseForm       = document.getElementById('expenseForm');
  const dateInput         = document.getElementById('expenseDate');
  const expenseClearBtn   = document.getElementById('expenseClearBtn');
  const expenseRefreshBtn = document.getElementById('expenseRefreshBtn');
  const submitBtn         = document.getElementById('expenseSubmitBtn');

  // Default date to today
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }

  // ── Form submit ──────────────────────────────────────────────────────────────
  let isExpenseSubmitting = false;
  if (expenseForm) {
    expenseForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isExpenseSubmitting) return;

      const date          = document.getElementById('expenseDate').value;
      const type          = document.getElementById('expenseType').value;
      const category      = document.getElementById('expenseCategory').value.trim();
      const description   = document.getElementById('expenseDescription').value.trim();
      const amountRaw     = document.getElementById('expenseAmount').value;
      const paymentMethod = document.getElementById('expensePaymentMethod').value;

      if (!date || !type || !category || !description || !amountRaw || !paymentMethod) {
        showExpenseStatus('⚠️ Please fill all fields', 'error');
        return;
      }

      const amount = Number(amountRaw);
      if (!Number.isFinite(amount) || amount <= 0) {
        showExpenseStatus('⚠️ Amount must be a positive number', 'error');
        return;
      }

      isExpenseSubmitting = true;
      setExpenseBtn(submitBtn, '⏳ Saving to Sheets...', true);

      const expense = {
        id:            "EXP-" + Date.now(),
        date,
        type,
        category,
        description,
        amount,
        paymentMethod,
        createdAt:     new Date().toISOString()
      };

      try {
        const saveResult = await saveExpenseToSheets(expense);

        // Reload table from Sheets so UI is in sync
        const all = await loadExpensesFromSheets();
        renderExpensesTable(all);

        expenseForm.reset();
        dateInput.value = new Date().toISOString().split('T')[0];
        showExpenseStatus(saveResult.pending
          ? '✅ Expense saved locally and queued for cloud sync.'
          : '✅ Expense saved to Google Sheets!', 'success');
      } catch (err) {
        console.error('Expense save failed:', err);
        const msg = (typeof describeApiError === 'function')
          ? describeApiError(err)
          : (err?.message || 'Failed to save. Please sign in first.');
        showExpenseStatus('❌ ' + msg, 'error');
      } finally {
        isExpenseSubmitting = false;
        setExpenseBtn(submitBtn, 'Add Expense', false);
      }
    });
  }

  // ── Clear ────────────────────────────────────────────────────────────────────
  if (expenseClearBtn) {
    expenseClearBtn.addEventListener('click', () => {
      expenseForm && expenseForm.reset();
      if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
    });
  }

  // ── Refresh — always loads from Sheets ──────────────────────────────────────
  if (expenseRefreshBtn) {
    expenseRefreshBtn.addEventListener('click', async () => {
      setExpenseBtn(expenseRefreshBtn, '⏳ Loading...', true);
      try {
        const expenses = await ensureExpensesLoaded({ refresh: true });
        showExpenseStatus(` Loaded ${expenses.length} expense(s) `, 'success');
      } catch (err) {
        console.error('Expense refresh failed:', err);
        const msg = (typeof describeApiError === 'function')
          ? describeApiError(err)
          : (err?.message || 'Could not load. Please sign in.');
        showExpenseStatus('❌ ' + msg, 'error');
      } finally {
        setExpenseBtn(expenseRefreshBtn, '🔄 Refresh', false);
      }
    });
  }


  // Neither the full local mirror nor cloud expenses are loaded at startup.
}

document.addEventListener('DOMContentLoaded', () => {
  initExpensesForm();
});
