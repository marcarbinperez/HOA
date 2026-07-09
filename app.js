const HOA_NAME = "Gentree Villas Homeowners Association Inc.";
const STORAGE_KEY = "gentreeVillasHoaDataV1";
const SYNC_META_KEY = "gentreeVillasHoaSyncMetaV1";
const DEFAULT_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz6mEGMr1OlJc-k8Vus30c2JayWxSdiGTdBTyXE4HxjT-m3hc3iN_5ijKoijp9ZkV8D/exec";
const CLOUD_COLLECTIONS = ["users", "members", "dues", "payments", "expenses", "payroll", "activity"];
const PAGE_SIZE = 15;
const MAX_PAGE_BUTTONS = 8;
const ADVANCE_DUE_ID = "__ADVANCE_PAYMENT__";

const state = {
  settings: {
    scriptUrl: DEFAULT_SCRIPT_URL,
    defaultDues: 500,
    startingFund: 0,
    preparedBy: ""
  },
  users: [],
  members: [],
  dues: [],
  payments: [],
  expenses: [],
  payroll: [],
  activity: []
};

let currentUserId = sessionStorage.getItem("gentreeVillasCurrentUserId") || "";
let syncRunning = false;
let syncQueued = false;
let localChangeVersion = 0;
let syncedChangeVersion = 0;
let loadInProgress = false;
let dashboardMonthTouched = false;
let duesSearchTimer = 0;
let lastSyncError = "";
const pageState = {
  balances: 1,
  activity: 1,
  members: 1,
  dues: 1,
  expenses: 1,
  payroll: 1,
  users: 1
};
const financialCache = {
  duePayments: new Map(),
  duePaid: new Map(),
  dueBalance: new Map(),
  memberAdvanceCredit: new Map()
};

const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().toISOString().slice(0, 7);
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const byDateDesc = (a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt));
const money = value => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value || "").replace(/[^0-9.-]/g, "");
  return cleaned ? Number(cleaned) || 0 : 0;
};

const el = id => document.getElementById(id);

function spreadsheetSerialDate(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 20000 || numericValue > 80000) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(numericValue) * 86400000);
}

function normalizeMonth(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 7);
  }

  const text = String(value).trim();
  const serialDate = spreadsheetSerialDate(text);
  if (serialDate) return serialDate.toISOString().slice(0, 7);

  const monthMatch = text.match(/^(\d{4})-(\d{2})/);
  if (monthMatch) return `${monthMatch[1]}-${monthMatch[2]}`;

  const monthYearMatch = text.match(/^(\d{1,2})[/-](\d{4})$/);
  if (monthYearMatch) return `${monthYearMatch[2]}-${monthYearMatch[1].padStart(2, "0")}`;

  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 7);
  }

  return text;
}

function normalizeDate(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  const serialDate = spreadsheetSerialDate(text);
  if (serialDate) return serialDate.toISOString().slice(0, 10);

  const dateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;

  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10);
  }

  return text;
}

function loadSyncMeta() {
  try {
    const meta = JSON.parse(localStorage.getItem(SYNC_META_KEY) || "{}");
    localChangeVersion = Number(meta.localChangeVersion || 0);
    syncedChangeVersion = Number(meta.syncedChangeVersion || 0);
    syncQueued = localChangeVersion > syncedChangeVersion;
  } catch {
    localChangeVersion = 0;
    syncedChangeVersion = 0;
    syncQueued = false;
  }
}

function saveSyncMeta() {
  localStorage.setItem(SYNC_META_KEY, JSON.stringify({
    localChangeVersion,
    syncedChangeVersion
  }));
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    ensureDefaultSettings();
    ensureDefaultAdmin();
    return;
  }

  try {
    const saved = JSON.parse(raw);
    Object.assign(state.settings, saved.settings || {});
    ensureDefaultSettings();
    for (const key of CLOUD_COLLECTIONS) {
      state[key] = Array.isArray(saved[key]) ? saved[key] : [];
    }
    ensureDefaultAdmin();
    normalizeRecords();
  } catch {
    setStatus("Local data error", "error");
    ensureDefaultSettings();
    ensureDefaultAdmin();
    normalizeRecords();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function commitChange(statusText = "Saved locally - click Save") {
  localChangeVersion += 1;
  saveSyncMeta();
  setStatus(statusText);
  render();
  syncQueued = true;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForSyncIdle() {
  while (syncRunning) {
    await wait(100);
  }
}

async function processSyncQueue() {
  if (syncRunning) {
    syncQueued = true;
    await waitForSyncIdle();
    return syncedChangeVersion >= localChangeVersion;
  }
  syncRunning = true;

  try {
    while (syncQueued || syncedChangeVersion < localChangeVersion) {
      syncQueued = false;
      const versionToSync = localChangeVersion;
      const synced = await syncNow({ renderAfter: false, version: versionToSync });

      if (!synced) {
        setStatus("Sync pending", "error");
        return false;
      }

      syncedChangeVersion = Math.max(syncedChangeVersion, versionToSync);
      saveSyncMeta();
    }

    setStatus("Ready", "ok");
    return true;
  } finally {
    syncRunning = false;
  }
}

async function saveToGoogleSheets(button) {
  if (!currentUser()) {
    alert("Please sign in before saving to Google Sheets.");
    return false;
  }

  if (button) button.disabled = true;
  setStatus("Saving to Google Sheets");
  localChangeVersion += 1;
  syncQueued = true;
  saveSyncMeta();

  const synced = await processSyncQueue();
  if (button) button.disabled = false;

  if (!synced || syncedChangeVersion < localChangeVersion) {
    setStatus("Save failed", "error");
    const details = lastSyncError ? `\n\nDetails: ${lastSyncError}` : "";
    alert(`Google Sheets save failed. Your data is still saved locally. Please check your internet connection, make sure the Google Apps Script is redeployed, then click Save again.${details}`);
    return false;
  }

  setStatus("Saved to Google Sheets", "ok");
  alert("All records were saved to Google Sheets.");
  return true;
}

function queueSearchLoad(afterLoad) {
  afterLoad();
  setLocalFirstStatus();
}

function queueActivitySearchLoad() {
  renderDashboard();
  setLocalFirstStatus();
}

function setLocalFirstStatus() {
  if (!currentUser()) {
    setStatus("Ready", "ok");
  } else if (syncRunning) {
    setStatus("Syncing");
  } else if (syncedChangeVersion < localChangeVersion || syncQueued) {
    setStatus("Saved locally - click Save");
  } else {
    setStatus("Ready", "ok");
  }
}

function paginateRecords(key, records, pagerId, renderFn) {
  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  pageState[key] = Math.min(Math.max(Number(pageState[key]) || 1, 1), totalPages);
  const start = (pageState[key] - 1) * PAGE_SIZE;
  const pageRecords = records.slice(start, start + PAGE_SIZE);
  renderPager(key, records.length, totalPages, pagerId, renderFn);
  return pageRecords;
}

function renderPager(key, totalRecords, totalPages, pagerId, renderFn) {
  const pager = el(pagerId);
  if (!pager) return;

  if (totalRecords <= PAGE_SIZE) {
    pager.innerHTML = totalRecords > 0 ? `<span class="page-summary">Showing ${totalRecords} record${totalRecords === 1 ? "" : "s"}</span>` : "";
    return;
  }

  const buttons = [];
  const halfWindow = Math.floor(MAX_PAGE_BUTTONS / 2);
  let firstPage = Math.max(1, pageState[key] - halfWindow + 1);
  let lastPage = Math.min(totalPages, firstPage + MAX_PAGE_BUTTONS - 1);
  firstPage = Math.max(1, lastPage - MAX_PAGE_BUTTONS + 1);

  buttons.push(`<button type="button" data-page-key="${key}" data-page="${pageState[key] - 1}" ${pageState[key] === 1 ? "disabled" : ""}>Prev</button>`);
  for (let page = firstPage; page <= lastPage; page += 1) {
    buttons.push(`<button type="button" data-page-key="${key}" data-page="${page}" class="${page === pageState[key] ? "active" : ""}">${page}</button>`);
  }
  buttons.push(`<button type="button" data-page-key="${key}" data-page="${pageState[key] + 1}" ${pageState[key] === totalPages ? "disabled" : ""}>Next</button>`);

  const start = (pageState[key] - 1) * PAGE_SIZE + 1;
  const end = Math.min(pageState[key] * PAGE_SIZE, totalRecords);
  pager.innerHTML = `${buttons.join("")}<span class="page-summary">${start}-${end} of ${totalRecords}</span>`;
  pager.querySelectorAll("button[data-page]").forEach(button => {
    button.addEventListener("click", () => {
      pageState[key] = Number(button.dataset.page);
      renderFn();
    });
  });
}

function resetPage(key) {
  pageState[key] = 1;
}

function ensureDefaultSettings() {
  if (!state.settings.scriptUrl) {
    state.settings.scriptUrl = DEFAULT_SCRIPT_URL;
  }
}

function ensureDefaultAdmin() {
  if (state.users.length > 0) return;

  state.users.push({
    id: "admin-default",
    name: "System Administrator",
    username: "admin",
    password: "admin123",
    role: "Admin",
    status: "Active",
    createdAt: new Date().toISOString(),
    createdBy: "System"
  });
  save();
}

function applyCloudData(data) {
  if (!data) return;

  if (data.settings) {
    Object.assign(state.settings, data.settings);
    ensureDefaultSettings();
  }

  for (const key of CLOUD_COLLECTIONS) {
    if (Array.isArray(data[key])) {
      state[key] = data[key];
    }
  }

  normalizeRecords();
}

function normalizeRecords() {
  state.users = state.users.map(user => ({
    ...user,
    id: normalizeId(user.id)
  }));

  state.members = state.members.map(member => ({
    ...member,
    id: normalizeId(member.id)
  }));

  state.dues = state.dues.map(due => ({
    ...due,
    id: normalizeId(due.id),
    memberId: normalizeId(due.memberId),
    month: normalizeMonth(firstValue(due, ["month", "period", "billingMonth", "dueMonth", "date"])),
    amount: money(firstValue(due, ["amount", "assessment", "monthlyDue", "monthlyDues", "billed", "duesAmount"]))
  }));

  state.payments = state.payments.map(payment => {
    const dueId = normalizeId(payment.dueId) || (String(payment.paymentType || "").toLowerCase().includes("advance") ? ADVANCE_DUE_ID : "");
    const amount = money(firstValue(payment, ["amount", "paid", "payment", "paymentAmount", "monthlyDuesPaid", "advancePayment"]));
    const paymentType = payment.paymentType || (sameId(dueId, ADVANCE_DUE_ID) ? "Advance Payment" : "Monthly Due");

    return {
      ...payment,
      id: normalizeId(payment.id),
      dueId,
      memberId: normalizeId(payment.memberId),
      date: normalizeDate(firstValue(payment, ["date", "paymentDate", "paidDate", "createdAt"])),
      amount,
      paymentType,
      advancePayment: String(paymentType).toLowerCase().includes("advance") ? money(payment.advancePayment || amount) : 0
    };
  });

  state.expenses = state.expenses.map(expense => ({
    ...expense,
    date: normalizeDate(expense.date),
    amount: money(expense.amount)
  }));

  state.payroll = state.payroll.map(payroll => ({
    ...payroll,
    date: normalizeDate(payroll.date),
    amount: money(payroll.amount)
  }));
}

function normalizeId(value) {
  return String(value || "").trim();
}

function firstValue(record, keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== "") {
      return record[key];
    }
  }
  return "";
}

function mergeActivityRecords(localRecords, cloudRecords) {
  const records = [...(Array.isArray(cloudRecords) ? cloudRecords : []), ...(Array.isArray(localRecords) ? localRecords : [])];
  const byId = new Map();

  records.forEach(record => {
    if (!record) return;
    const id = record.id || `${record.createdAt || ""}-${record.text || ""}-${record.userName || ""}`;
    if (!byId.has(id)) {
      byId.set(id, { ...record, id });
    }
  });

  return [...byId.values()]
    .sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")))
    .slice(0, 1000);
}

function currentUser() {
  return state.users.find(user => user.id === currentUserId && user.status === "Active");
}

function currentUserName() {
  return currentUser()?.name || "Unknown user";
}

function isAdmin() {
  return currentUser()?.role === "Admin";
}

function requireAdmin() {
  if (isAdmin()) return true;
  alert("Only admin users can manage this section.");
  return false;
}

function logActivity(text) {
  state.activity.unshift({
    id: uid(),
    date: today(),
    text,
    userId: currentUserId || "system",
    userName: currentUserName(),
    createdAt: new Date().toISOString()
  });
  state.activity = state.activity.slice(0, 1000);
}

function setStatus(text, tone = "") {
  const status = el("syncStatus");
  status.textContent = text;
  status.className = `status ${tone}`.trim();
}

function memberName(memberId) {
  return state.members.find(member => member.id === memberId)?.name || "Unknown member";
}

function memberById(memberId) {
  return state.members.find(member => member.id === memberId);
}

function duePayments(dueOrId) {
  const dueId = normalizeId(typeof dueOrId === "object" ? dueOrId.id : dueOrId);
  return financialCache.duePayments.get(dueId) || [];
}

function duePaid(dueOrId) {
  const dueId = normalizeId(typeof dueOrId === "object" ? dueOrId.id : dueOrId);
  return financialCache.duePaid.get(dueId) || 0;
}

function dueBalance(due) {
  return financialCache.dueBalance.get(normalizeId(due?.id)) || 0;
}

function isAdvancePayment(payment) {
  return sameId(payment.dueId, ADVANCE_DUE_ID) || String(payment.paymentType || "").toLowerCase().includes("advance");
}

function memberAdvanceCredit(memberId) {
  return financialCache.memberAdvanceCredit.get(normalizeId(memberId)) || 0;
}

function memberDuesInOrder(memberId) {
  return state.dues
    .filter(due => sameId(due.memberId, memberId))
    .sort((a, b) => normalizeMonth(a.month).localeCompare(normalizeMonth(b.month)) || normalizeId(a.id).localeCompare(normalizeId(b.id)));
}

function rebuildFinancialCache() {
  financialCache.duePayments = new Map();
  financialCache.duePaid = new Map();
  financialCache.dueBalance = new Map();
  financialCache.memberAdvanceCredit = new Map();

  const dueById = new Map();
  const memberDues = new Map();
  state.dues.forEach(due => {
    const dueId = normalizeId(due.id);
    const memberId = normalizeId(due.memberId);
    dueById.set(dueId, due);
    financialCache.duePayments.set(dueId, []);
    financialCache.duePaid.set(dueId, 0);
    if (!memberDues.has(memberId)) memberDues.set(memberId, []);
    memberDues.get(memberId).push(due);
  });

  memberDues.forEach(dues => {
    dues.sort((a, b) => normalizeMonth(a.month).localeCompare(normalizeMonth(b.month)) || normalizeId(a.id).localeCompare(normalizeId(b.id)));
  });

  const advanceByMember = new Map();
  const unlinkedPayments = [];

  state.payments.forEach(payment => {
    const amount = money(payment.amount);
    const memberId = normalizeId(payment.memberId);
    const dueId = normalizeId(payment.dueId);

    if (isAdvancePayment(payment)) {
      advanceByMember.set(memberId, (advanceByMember.get(memberId) || 0) + amount);
      return;
    }

    if (dueById.has(dueId)) {
      addPaymentToDue(dueId, payment, amount);
      return;
    }

    unlinkedPayments.push(payment);
  });

  unlinkedPayments.forEach(payment => {
    let remaining = money(payment.amount);
    const paymentMonth = normalizeMonth(payment.date);
    const dues = (memberDues.get(normalizeId(payment.memberId)) || []).filter(due => normalizeMonth(due.month) === paymentMonth);

    for (const due of dues) {
      if (remaining <= 0) break;
      const dueId = normalizeId(due.id);
      const needed = Math.max(0, money(due.amount) - (financialCache.duePaid.get(dueId) || 0));
      const applied = Math.min(remaining, needed || remaining);
      addPaymentToDue(dueId, payment, applied);
      remaining -= applied;
    }
  });

  memberDues.forEach((dues, memberId) => {
    let advance = advanceByMember.get(memberId) || 0;
    for (const due of dues) {
      if (advance <= 0) break;
      const dueId = normalizeId(due.id);
      const needed = Math.max(0, money(due.amount) - (financialCache.duePaid.get(dueId) || 0));
      const applied = Math.min(advance, needed);
      financialCache.duePaid.set(dueId, (financialCache.duePaid.get(dueId) || 0) + applied);
      advance -= applied;
    }
    financialCache.memberAdvanceCredit.set(memberId, Math.max(0, advance));
  });

  state.dues.forEach(due => {
    const dueId = normalizeId(due.id);
    financialCache.dueBalance.set(dueId, Math.max(0, money(due.amount) - (financialCache.duePaid.get(dueId) || 0)));
  });
}

function addPaymentToDue(dueId, payment, amount) {
  const normalizedDueId = normalizeId(dueId);
  financialCache.duePaid.set(normalizedDueId, (financialCache.duePaid.get(normalizedDueId) || 0) + amount);
  const payments = financialCache.duePayments.get(normalizedDueId) || [];
  payments.push(payment);
  financialCache.duePayments.set(normalizedDueId, payments);
}

function sameId(left, right) {
  return normalizeId(left) === normalizeId(right);
}

function periodItems(items, dateKey, month) {
  const normalizedMonth = normalizeMonth(month);
  return items.filter(item => normalizeMonth(item[dateKey]) === normalizedMonth);
}

function monthInRange(value, from, to) {
  const month = normalizeMonth(value);
  return Boolean(month && month >= from && month <= to);
}

function periodItemsRange(items, dateKey, from, to) {
  return items.filter(item => monthInRange(item[dateKey], from, to));
}

function dashboardRecordMonths() {
  return [...new Set([
    ...state.dues.map(due => normalizeMonth(due.month)),
    ...state.payments.map(payment => normalizeMonth(payment.date)),
    ...state.payments.map(payment => {
      const due = state.dues.find(item => sameId(item.id, payment.dueId));
      return due ? normalizeMonth(due.month) : "";
    }),
    ...state.expenses.map(expense => normalizeMonth(expense.date)),
    ...state.payroll.map(payroll => normalizeMonth(payroll.date))
  ].filter(Boolean))].sort();
}

function dashboardRange() {
  const fromInput = el("dashboardFrom");
  const toInput = el("dashboardTo");
  const months = dashboardRecordMonths();
  const fallbackMonth = months.length ? months[months.length - 1] : currentMonth();
  let from = normalizeMonth(fromInput.value) || currentMonth();
  let to = normalizeMonth(toInput.value) || from;

  if (!dashboardMonthTouched && months.length > 0 && !months.some(month => month >= from && month <= to)) {
    from = fallbackMonth;
    to = fallbackMonth;
  }

  if (from > to) {
    const oldFrom = from;
    from = to;
    to = oldFrom;
  }

  if (/^\d{4}-\d{2}$/.test(from)) fromInput.value = from;
  if (/^\d{4}-\d{2}$/.test(to)) toInput.value = to;

  return { from, to };
}

function totals(from = currentMonth(), to = from) {
  const normalizedFrom = normalizeMonth(from) || currentMonth();
  const normalizedTo = normalizeMonth(to) || normalizedFrom;
  const rangeFrom = normalizedFrom <= normalizedTo ? normalizedFrom : normalizedTo;
  const rangeTo = normalizedFrom <= normalizedTo ? normalizedTo : normalizedFrom;
  const duesForRange = state.dues.filter(due => monthInRange(due.month, rangeFrom, rangeTo));
  const billed = duesForRange.reduce((sum, due) => sum + money(due.amount), 0);
  const paid = dashboardPaymentsForRange(rangeFrom, rangeTo, duesForRange).reduce((sum, payment) => sum + money(payment.amount), 0);
  const outstanding = duesForRange.reduce((sum, due) => sum + dueBalance(due), 0);
  const expenseTotal = periodItemsRange(state.expenses, "date", rangeFrom, rangeTo).reduce((sum, item) => sum + money(item.amount), 0);
  const payrollTotal = periodItemsRange(state.payroll, "date", rangeFrom, rangeTo).reduce((sum, item) => sum + money(item.amount), 0);
  return {
    billed,
    paid,
    balance: outstanding,
    expenses: expenseTotal,
    payroll: payrollTotal,
    fund: money(state.settings.startingFund) + paid - expenseTotal - payrollTotal
  };
}

function dashboardPaymentsForRange(from, to, duesForRange) {
  const dueIds = new Set(duesForRange.map(due => normalizeId(due.id)).filter(Boolean));
  const months = dashboardRecordMonths();
  const useUndatedPayments = months.length > 0 && months.every(month => month >= from && month <= to);
  const seen = new Set();
  const payments = [];

  state.payments.forEach((payment, index) => {
    const paymentMonth = normalizeMonth(payment.date);
    const linkedToRangeDue = dueIds.has(normalizeId(payment.dueId));
    if (!monthInRange(paymentMonth, from, to) && !linkedToRangeDue && !(useUndatedPayments && !paymentMonth)) return;

    const key = paymentKey(payment, index);
    if (seen.has(key)) return;

    seen.add(key);
    payments.push(payment);
  });

  return payments;
}

function paymentKey(payment, index) {
  return normalizeId(payment.id) || [
    normalizeId(payment.dueId),
    normalizeId(payment.memberId),
    normalizeDate(payment.date),
    money(payment.amount),
    normalizeId(payment.receipt),
    index
  ].join("|");
}

function render() {
  rebuildFinancialCache();
  renderAuth();
  renderSettings();
  renderDashboard();
  renderMembers();
  renderDues();
  renderExpenses();
  renderPayroll();
  renderUsers();
  renderSoaOptions();
  renderSoa();
  save();
}

function renderAuth() {
  const user = currentUser();
  document.body.classList.toggle("logged-out", !user);
  el("currentUserLabel").textContent = user ? `${user.name} (${user.role})` : "";
  document.querySelectorAll(".admin-only").forEach(item => {
    item.hidden = !isAdmin();
  });

  if (!isAdmin() && (el("users").classList.contains("active") || el("settings").classList.contains("active"))) {
    document.querySelector('[data-view="dashboard"]').click();
  }
}

function renderSettings() {
  el("scriptUrl").value = state.settings.scriptUrl || "";
  el("defaultDues").value = state.settings.defaultDues || 0;
  el("startingFund").value = state.settings.startingFund || 0;
  el("preparedBy").value = state.settings.preparedBy || "";
  el("duesAmount").value = state.settings.defaultDues || 0;
}

function renderDashboard() {
  const { from, to } = dashboardRange();
  const balanceQuery = el("balanceSearch").value.trim().toLowerCase();
  const activityQuery = el("activitySearch").value.trim().toLowerCase();
  const total = totals(from, to);
  el("metricFund").textContent = peso.format(total.fund);
  el("metricBilled").textContent = peso.format(total.billed);
  el("metricPaid").textContent = peso.format(total.paid);
  el("metricBalance").textContent = peso.format(total.balance);
  el("metricExpenses").textContent = peso.format(total.expenses);
  el("metricPayroll").textContent = peso.format(total.payroll);

  const balances = state.dues
    .map(due => {
      const member = memberById(due.memberId);
      return { due, member, month: normalizeMonth(due.month), balance: dueBalance(due) };
    })
    .filter(row => monthInRange(row.month, from, to))
    .filter(row => row.balance > 0)
    .filter(row => {
      if (!balanceQuery) return true;
      return [
        row.member?.name,
        row.member?.block,
        row.member?.lot,
        row.month
      ].join(" ").toLowerCase().includes(balanceQuery);
    })
    .sort((a, b) => b.balance - a.balance);
  const balancePage = paginateRecords("balances", balances, "balancePager", renderDashboard);

  el("balanceList").innerHTML = balancePage.length
    ? balancePage.map(({ due, member, month, balance }) => {
      const property = member ? `Block ${member.block}, Lot ${member.lot}` : "Deleted member";
      return `<div class="list-item"><span>${escapeHtml(memberName(due.memberId))} (${month})<small>${escapeHtml(property)}</small></span><strong>${peso.format(balance)}</strong></div>`;
    }).join("")
    : `<div class="list-item"><span>No outstanding balances</span></div>`;

  const activities = state.activity.filter(item => {
    if (!activityQuery) return true;
    return [
      item.text,
      item.userName,
      item.date,
      item.createdAt
    ].join(" ").toLowerCase().includes(activityQuery);
  });
  const activityPage = paginateRecords("activity", activities, "activityPager", renderDashboard);

  el("activityList").innerHTML = activityPage.map(item =>
    `<div class="list-item"><span>${escapeHtml(item.text)}<small>By ${escapeHtml(item.userName || "Unknown user")}</small></span><small>${escapeHtml(item.date)}</small></div>`
  ).join("") || `<div class="list-item"><span>No recent activity</span></div>`;
}

function renderMembers() {
  const query = el("memberSearch").value.trim().toLowerCase();
  const members = state.members
    .filter(member => [member.name, member.block, member.lot, member.contact, member.email, member.notes, member.status].join(" ").toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));
  const pageMembers = paginateRecords("members", members, "membersPager", renderMembers);
  const rows = pageMembers
    .map(member => `
      <tr>
        <td>${escapeHtml(member.name)}</td>
        <td>${escapeHtml(member.block)}</td>
        <td>${escapeHtml(member.lot)}</td>
        <td>${escapeHtml(member.contact || "")}</td>
        <td class="notes-cell">${escapeHtml(member.notes || "")}</td>
        <td>${peso.format(memberAdvanceCredit(member.id))}</td>
        <td>${statusBadge(member.status || "Active")}</td>
        <td class="actions">
          <button class="table-action" data-edit-member="${member.id}">Edit</button>
          <button class="table-action danger" data-delete-member="${member.id}">Delete</button>
        </td>
      </tr>
    `).join("");

  el("membersTable").innerHTML = rows || `<tr><td colspan="8">No members yet.</td></tr>`;
}

function renderDues() {
  const query = el("duesSearch").value.trim().toLowerCase();
  const membersById = new Map(state.members.map(member => [normalizeId(member.id), member]));
  const dues = state.dues
    .map(due => {
      const member = membersById.get(normalizeId(due.memberId));
      const dueMonth = normalizeMonth(due.month);
      const memberNameText = member?.name || "Deleted member";
      const blockLotText = member ? `${member.block}/${member.lot}` : "";
      const searchable = [
        dueMonth,
        member?.name,
        member?.block,
        member?.lot,
        blockLotText,
        member ? `Block ${member.block} Lot ${member.lot}` : ""
      ].join(" ").toLowerCase();

      return { due, member, dueMonth, memberNameText, blockLotText, searchable };
    })
    .filter(row => !query || row.searchable.includes(query))
    .sort((a, b) => b.dueMonth.localeCompare(a.dueMonth) || a.memberNameText.localeCompare(b.memberNameText));
  const pageDues = paginateRecords("dues", dues, "duesPager", renderDues);
  const rows = pageDues
    .map(({ due, dueMonth, memberNameText, blockLotText }) => {
      const paid = duePaid(due);

      return `
        <tr>
          <td>${escapeHtml(dueMonth)}</td>
          <td>${escapeHtml(memberNameText)}</td>
          <td>${escapeHtml(blockLotText)}</td>
          <td>${peso.format(money(due.amount))}</td>
          <td>${peso.format(paid)}</td>
          <td>${peso.format(dueBalance(due))}</td>
          <td class="actions">
            <button class="table-action" data-pay-due="${due.id}">Payment</button>
            <button class="table-action danger" data-delete-due="${due.id}">Delete</button>
          </td>
        </tr>
      `;
    }).join("");

  el("duesTable").innerHTML = rows || `<tr><td colspan="7">No dues recorded yet.</td></tr>`;
}

function renderExpenses() {
  const expenses = [...state.expenses].sort(byDateDesc);
  const pageExpenses = paginateRecords("expenses", expenses, "expensesPager", renderExpenses);
  el("expensesTable").innerHTML = pageExpenses.map(expense => `
    <tr>
      <td>${escapeHtml(expense.date)}</td>
      <td>${escapeHtml(expense.category)}</td>
      <td>${escapeHtml(expense.description)}</td>
      <td>${peso.format(money(expense.amount))}</td>
      <td class="actions"><button class="table-action danger" data-delete-expense="${expense.id}">Delete</button></td>
    </tr>
  `).join("") || `<tr><td colspan="5">No expenses recorded yet.</td></tr>`;
}

function renderPayroll() {
  const payroll = [...state.payroll].sort(byDateDesc);
  const pagePayroll = paginateRecords("payroll", payroll, "payrollPager", renderPayroll);
  el("payrollTable").innerHTML = pagePayroll.map(payroll => `
    <tr>
      <td>${escapeHtml(payroll.date)}</td>
      <td>${escapeHtml(payroll.name)}</td>
      <td>${escapeHtml(payroll.role)}</td>
      <td>${peso.format(money(payroll.amount))}</td>
      <td class="actions"><button class="table-action danger" data-delete-payroll="${payroll.id}">Delete</button></td>
    </tr>
  `).join("") || `<tr><td colspan="5">No payroll recorded yet.</td></tr>`;
}

function renderUsers() {
  const users = state.users
    .sort((a, b) => a.name.localeCompare(b.name));
  const pageUsers = paginateRecords("users", users, "usersPager", renderUsers);
  const rows = pageUsers
    .map(user => `
      <tr>
        <td>${escapeHtml(user.name)}</td>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.role)}</td>
        <td>${escapeHtml(user.status || "Active")}</td>
        <td>${escapeHtml(user.updatedBy || user.createdBy || "")}</td>
        <td class="actions">
          <button class="table-action" data-edit-user="${user.id}">Edit</button>
          <button class="table-action danger" data-delete-user="${user.id}" ${user.id === currentUserId ? "disabled" : ""}>Delete</button>
        </td>
      </tr>
    `).join("");

  el("usersTable").innerHTML = rows || `<tr><td colspan="6">No users yet.</td></tr>`;
}

function renderSoaOptions() {
  const selected = el("soaMember").value;
  const query = el("soaSearch").value.trim().toLowerCase();
  const members = state.members
    .filter(member => member.status !== "Inactive")
    .filter(member => {
      if (!query) return true;
      return [
        member.name,
        member.block,
        member.lot,
        `Block ${member.block} Lot ${member.lot}`
      ].join(" ").toLowerCase().includes(query);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  el("soaMember").innerHTML = members
    .map(member => `<option value="${member.id}">${escapeHtml(member.name)} - Block ${escapeHtml(member.block)}, Lot ${escapeHtml(member.lot)}</option>`)
    .join("");

  if (members.some(member => member.id === selected)) {
    el("soaMember").value = selected;
  } else if (members.length > 0) {
    el("soaMember").value = members[0].id;
  }

}

function renderSoa() {
  const member = memberById(el("soaMember").value);
  if (!member) {
    el("soaPreview").innerHTML = "<p>Select a member to preview a Statement of Account.</p>";
    return;
  }

  const from = normalizeMonth(el("soaFrom").value) || "0000-00";
  const to = normalizeMonth(el("soaTo").value) || "9999-99";
  el("soaPreview").innerHTML = `<article class="soa-print-page">${buildSoaHtml(member, from, to)}</article>`;
}

function buildSoaHtml(member, from, to) {
  const { dues, balance } = soaData(member, from, to);

  return `
    <div class="soa-header">
      <div>
        <h3>${HOA_NAME}</h3>
        <strong>Statement of Account</strong>
      </div>
      <div>
        <div>Date: ${today()}</div>
        <div>Prepared by: ${escapeHtml(state.settings.preparedBy || "HOA Admin")}</div>
      </div>
    </div>
    <p><strong>Member:</strong> ${escapeHtml(member.name)}</p>
    <p><strong>Property:</strong> Block ${escapeHtml(member.block)}, Lot ${escapeHtml(member.lot)}</p>
    <table>
      <thead><tr><th>Month</th><th>Assessment</th><th>Payments</th><th>Balance</th></tr></thead>
      <tbody>
        ${dues.map(due => `
          <tr>
            <td>${escapeHtml(normalizeMonth(due.month))}</td>
            <td>${peso.format(money(due.amount))}</td>
            <td>${peso.format(duePaid(due))}</td>
            <td>${peso.format(dueBalance(due))}</td>
          </tr>
        `).join("") || `<tr><td colspan="4">No dues in selected period.</td></tr>`}
      </tbody>
    </table>
    <div class="soa-total"><strong>Total Balance: ${peso.format(balance)}</strong></div>
  `;
}

function soaData(member, from, to) {
  const fromMonth = normalizeMonth(from) || "0000-00";
  const toMonth = normalizeMonth(to) || "9999-99";
  const dues = state.dues
    .filter(due => {
      const dueMonth = normalizeMonth(due.month);
      return due.memberId === member.id && dueMonth >= fromMonth && dueMonth <= toMonth;
    })
    .sort((a, b) => normalizeMonth(a.month).localeCompare(normalizeMonth(b.month)));
  const balance = dues.reduce((sum, due) => sum + dueBalance(due), 0);

  return { fromMonth, toMonth, dues, balance };
}

function printAllSoa() {
  const from = normalizeMonth(el("soaFrom").value) || "0000-00";
  const to = normalizeMonth(el("soaTo").value) || "9999-99";
  const members = state.members
    .filter(member => member.status !== "Inactive")
    .sort((a, b) => a.name.localeCompare(b.name));

  if (members.length === 0) {
    alert("No active members to print.");
    return;
  }

  el("soaPreview").innerHTML = members.map(member =>
    `<article class="soa-print-page">${buildSoaHtml(member, from, to)}</article>`
  ).join("");

  window.print();
  renderSoa();
}

function downloadSelectedSoaPdf() {
  const member = memberById(el("soaMember").value);
  if (!member) {
    alert("Select a member to download a Statement of Account.");
    return;
  }

  renderSoa();
  const originalTitle = document.title;
  const fileName = sanitizeFileName(`${today()} ${member.name} Block ${member.block} Lot ${member.lot} SOA`);

  document.title = fileName;
  const restoreTitle = () => {
    document.title = originalTitle;
    window.removeEventListener("afterprint", restoreTitle);
  };

  window.addEventListener("afterprint", restoreTitle);
  window.print();
  setTimeout(restoreTitle, 1500);
}

function sendSelectedSoaEmail() {
  const member = memberById(el("soaMember").value);
  if (!member) {
    alert("Select a member before sending the SOA email.");
    return;
  }

  const toEmail = String(member.email || "").trim();
  if (!toEmail) {
    alert("This member has no email address saved. Please add an email in the member record first.");
    return;
  }

  const from = normalizeMonth(el("soaFrom").value) || "0000-00";
  const to = normalizeMonth(el("soaTo").value) || "9999-99";
  const subject = `${HOA_NAME} SOA - ${member.name} Block ${member.block} Lot ${member.lot}`;
  const body = buildSoaEmailText(member, from, to);
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(toEmail)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(gmailUrl, "_blank", "noopener");
  logActivity(`Opened Gmail SOA email for ${member.name} at ${toEmail}`);
    commitChange("SOA Gmail draft opened - click Save");
}

function buildSoaEmailText(member, from, to) {
  const { fromMonth, toMonth, dues, balance } = soaData(member, from, to);
  const lines = [
    HOA_NAME,
    "Statement of Account",
    "",
    `Date: ${today()}`,
    `Prepared by: ${state.settings.preparedBy || "HOA Admin"}`,
    "",
    `Member: ${member.name}`,
    `Property: Block ${member.block}, Lot ${member.lot}`,
    `Period: ${fromMonth} to ${toMonth}`,
    "",
    "Month | Assessment | Payments | Balance",
    "----------------------------------------"
  ];

  if (dues.length === 0) {
    lines.push("No dues in selected period.");
  } else {
    dues.forEach(due => {
      lines.push(`${normalizeMonth(due.month)} | ${peso.format(money(due.amount))} | ${peso.format(duePaid(due))} | ${peso.format(dueBalance(due))}`);
    });
  }

  lines.push("");
  lines.push(`Total Balance: ${peso.format(balance)}`);
  lines.push("");
  lines.push("Please see the SOA details above.");
  return lines.join("\n");
}

function sanitizeFileName(value) {
  return String(value || "SOA.pdf")
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function printMemberList() {
  const members = [...state.members]
    .sort((a, b) => String(a.block).localeCompare(String(b.block), undefined, { numeric: true }) || String(a.lot).localeCompare(String(b.lot), undefined, { numeric: true }) || a.name.localeCompare(b.name));

  if (members.length === 0) {
    alert("No members to print.");
    return;
  }

  el("memberPrintArea").innerHTML = `
    <div class="print-header">
      <h1>${HOA_NAME}</h1>
      <p>Member List</p>
      <p>Date: ${today()}</p>
    </div>
    <table class="print-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Block</th>
          <th>Lot</th>
        </tr>
      </thead>
      <tbody>
        ${members.map(member => `
          <tr>
            <td>${escapeHtml(member.name)}</td>
            <td>${escapeHtml(member.block)}</td>
            <td>${escapeHtml(member.lot)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  document.body.classList.add("printing-members");
  window.print();
  document.body.classList.remove("printing-members");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(value.trim());
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value.trim());
      if (row.some(cell => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value.trim());
  if (row.some(cell => cell !== "")) rows.push(row);
  return rows;
}

function normalizeHeader(header) {
  return String(header || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function valueByHeader(record, names) {
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  return "";
}

async function importMembersCsv(file) {
  if (!file) return;

  setStatus("Loading");
  try {
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      alert("CSV file must include a header row and at least one member row.");
      return;
    }

    const headers = rows[0].map(normalizeHeader);
    const imported = [];

    rows.slice(1).forEach(row => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = row[index] || "";
      });

      const name = valueByHeader(record, ["name", "fullname", "membername", "ownername"]);
      const block = valueByHeader(record, ["block", "blk"]);
      const lot = valueByHeader(record, ["lot"]);

      if (!name || !block || !lot) return;

      const status = valueByHeader(record, ["status"]) || "Active";
      imported.push({
        id: uid(),
        name,
        block,
        lot,
        contact: valueByHeader(record, ["contact", "contactnumber", "phone", "mobile"]),
        email: valueByHeader(record, ["email", "emailaddress"]),
        notes: valueByHeader(record, ["notes", "note", "remarks"]),
        status: ["Active", "Inactive", "Delinquent"].includes(status) ? status : "Active",
        createdAt: new Date().toISOString(),
        createdBy: currentUserName(),
        updatedAt: new Date().toISOString(),
        updatedBy: currentUserName()
      });
    });

    if (imported.length === 0) {
      alert("No valid members found. Required CSV headers: name, block, lot.");
      return;
    }

    state.members.push(...imported);
    logActivity(`Imported ${imported.length} members from CSV`);
    el("memberCsvInput").value = "";
    commitChange();
    alert(`Imported ${imported.length} members. Each member was assigned a system ID.`);
  } catch (error) {
    console.error(error);
    setStatus("Import failed", "error");
    alert("Unable to import CSV. Please check the file format.");
  }
}

function statusBadge(status) {
  const normalized = String(status || "Active").toLowerCase();
  const className = normalized === "delinquent" ? "delinquent" : normalized === "inactive" ? "inactive" : "active";
  return `<span class="member-status ${className}">${escapeHtml(status || "Active")}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function openMemberDialog(member = null) {
  el("memberDialogTitle").textContent = member ? "Update Member" : "Add Member";
  el("memberId").value = member?.id || "";
  el("memberName").value = member?.name || "";
  el("memberBlock").value = member?.block || "";
  el("memberLot").value = member?.lot || "";
  el("memberContact").value = member?.contact || "";
  el("memberEmail").value = member?.email || "";
  el("memberNotes").value = member?.notes || "";
  el("memberStatus").value = member?.status || "Active";
  el("memberDialog").showModal();
}

function openAdvancePaymentDialog() {
  const members = state.members
    .filter(member => member.status !== "Inactive")
    .sort((a, b) => a.name.localeCompare(b.name));

  if (members.length === 0) {
    alert("No active or delinquent members available for advance payment.");
    return;
  }

  el("advanceMemberSearch").value = "";
  renderAdvanceMemberOptions();
  el("advanceDate").value = today();
  el("advanceAmount").value = "";
  el("advanceReceipt").value = "";
  el("advancePaymentDialog").showModal();
}

function renderAdvanceMemberOptions() {
  const query = el("advanceMemberSearch").value.trim().toLowerCase();
  const members = state.members
    .filter(member => member.status !== "Inactive")
    .filter(member => {
      if (!query) return true;
      return [
        member.name,
        member.block,
        member.lot,
        `Block ${member.block} Lot ${member.lot}`
      ].join(" ").toLowerCase().includes(query);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  el("advanceMember").innerHTML = members.length
    ? members.map(member => `<option value="${member.id}">${escapeHtml(member.name)} - Block ${escapeHtml(member.block)}, Lot ${escapeHtml(member.lot)}</option>`).join("")
    : `<option value="" disabled>No matching members</option>`;
}

function openUserDialog(user = null) {
  if (!requireAdmin()) return;
  el("userDialogTitle").textContent = user ? "Update User" : "Add User";
  el("userId").value = user?.id || "";
  el("userName").value = user?.name || "";
  el("userUsername").value = user?.username || "";
  el("userPassword").value = "";
  el("userPassword").placeholder = user ? "Leave blank to keep current password" : "";
  el("userPassword").required = !user;
  el("userRole").value = user?.role || "Staff";
  el("userStatus").value = user?.status || "Active";
  el("userDialog").showModal();
}

function openPasswordDialog() {
  if (!currentUser()) {
    alert("Please sign in before changing password.");
    return;
  }

  el("currentPassword").value = "";
  el("newPassword").value = "";
  el("confirmPassword").value = "";
  el("passwordError").textContent = "";
  el("passwordDialog").showModal();
}

async function changePassword(submitButton) {
  const user = currentUser();
  const currentPassword = el("currentPassword").value;
  const newPassword = el("newPassword").value;
  const confirmPassword = el("confirmPassword").value;

  el("passwordError").textContent = "";

  if (!user) {
    el("passwordError").textContent = "No signed-in user found.";
    return;
  }

  if (currentPassword !== user.password) {
    el("passwordError").textContent = "Current password is incorrect.";
    return;
  }

  if (!newPassword) {
    el("passwordError").textContent = "New password is required.";
    return;
  }

  if (newPassword !== confirmPassword) {
    el("passwordError").textContent = "New passwords do not match.";
    return;
  }

  if (newPassword === currentPassword) {
    el("passwordError").textContent = "New password must be different from current password.";
    return;
  }

  if (submitButton) submitButton.disabled = true;
  user.password = newPassword;
  user.updatedAt = new Date().toISOString();
  user.updatedBy = currentUserName();
  logActivity(`Changed password for ${user.name}`);
  commitChange("Password saved locally - click Save");
  if (submitButton) submitButton.disabled = false;

  el("passwordDialog").close();
  alert("Password changed locally. Click Save or Logout to sync it.");
}

function deleteById(collection, id) {
  const index = collection.findIndex(item => item.id === id);
  if (index >= 0) collection.splice(index, 1);
}

async function syncNow(options = {}) {
  const { silent = false, renderAfter = true, version = localChangeVersion } = options;
  ensureDefaultSettings();
  if (!state.settings.scriptUrl) {
    if (!silent) setStatus("Set URL first", "error");
    return false;
  }

  if (!silent) setStatus("Syncing");
  try {
    lastSyncError = "";
    const payloadToSync = buildSyncPayload();
    const response = await fetch(state.settings.scriptUrl, {
      method: "POST",
      mode: "cors",
      redirect: "follow",
      body: JSON.stringify({ action: "sync", data: payloadToSync }),
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(`Google Apps Script did not return JSON: ${responseText.slice(0, 300)}`);
    }
    if (!payload.ok) throw new Error(payload.error || "Sync failed");

    if (payload.data && localChangeVersion === version) {
      applyCloudData(payload.data);
    } else if (Array.isArray(payload.data?.activity)) {
      state.activity = mergeActivityRecords(state.activity, payload.data.activity);
    }
    ensureDefaultAdmin();
    save();
    setStatus("Ready", "ok");
    if (renderAfter) render();
    return true;
  } catch (error) {
    lastSyncError = String(error && error.message ? error.message : error);
    setStatus(silent ? "Auto sync failed" : "Sync failed", "error");
    console.error(error);
    return false;
  }
}

function buildSyncPayload() {
  normalizeRecords();
  rebuildFinancialCache();
  return {
    settings: { ...state.settings },
    users: state.users.map(user => ({ ...user })),
    members: state.members.map(member => ({
      ...member,
      advancePayment: memberAdvanceCredit(member.id)
    })),
    dues: state.dues.map(due => ({ ...due })),
    payments: state.payments.map(payment => ({ ...payment })),
    expenses: state.expenses.map(expense => ({ ...expense })),
    payroll: state.payroll.map(payroll => ({ ...payroll })),
    activity: state.activity.map(item => ({ ...item }))
  };
}

async function loadFromCloud(options = {}) {
  const { confirmBefore = true, renderAfter = true, silent = false } = options;
  ensureDefaultSettings();
  if (!state.settings.scriptUrl) {
    if (!silent) setStatus("Set URL first", "error");
    return false;
  }

  if (confirmBefore && !confirm("Load data from Google Sheets? This will replace the local browser copy.")) return false;

  if (loadInProgress) return false;
  loadInProgress = true;
  if (!silent) setStatus("Loading");
  try {
    const response = await fetch(`${state.settings.scriptUrl}?_=${Date.now()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "Load failed");

    applyCloudData(payload.data);
    ensureDefaultAdmin();
    save();
    if (!silent) setStatus("Loaded", "ok");
    if (renderAfter) render();
    return true;
  } catch (error) {
    if (!silent) setStatus("Load failed", "error");
    console.error(error);
    return false;
  } finally {
    loadInProgress = false;
  }
}

async function loadActivityFromCloud() {
  ensureDefaultSettings();
  if (!state.settings.scriptUrl) return false;
  if (loadInProgress) return false;

  loadInProgress = true;
  try {
    const response = await fetch(`${state.settings.scriptUrl}?_=${Date.now()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "Activity load failed");

    if (Array.isArray(payload.data?.activity)) {
      state.activity = payload.data.activity;
      save();
      return true;
    }

    return false;
  } catch (error) {
    console.error(error);
    return false;
  } finally {
    loadInProgress = false;
  }
}

function bindEvents() {
  document.querySelectorAll(".nav-button").forEach(button => {
    button.addEventListener("click", () => {
      if ((button.dataset.view === "users" || button.dataset.view === "settings") && !requireAdmin()) return;
      setStatus("Loading");
      document.querySelectorAll(".nav-button, .view").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      el(button.dataset.view).classList.add("active");
      render();
      setStatus("Ready", "ok");
    });
  });

  el("newMemberBtn").addEventListener("click", () => openMemberDialog());
  el("importMembersBtn").addEventListener("click", () => el("memberCsvInput").click());
  el("memberCsvInput").addEventListener("change", event => importMembersCsv(event.target.files[0]));
  el("printMembersBtn").addEventListener("click", printMemberList);
  el("newUserBtn").addEventListener("click", () => openUserDialog());
  el("changePasswordBtn").addEventListener("click", openPasswordDialog);
  el("cancelMemberBtn").addEventListener("click", () => el("memberDialog").close());
  el("cancelUserBtn").addEventListener("click", () => el("userDialog").close());
  el("cancelPasswordBtn").addEventListener("click", () => el("passwordDialog").close());
  el("cancelPaymentBtn").addEventListener("click", () => el("paymentDialog").close());
  el("cancelAdvancePaymentBtn").addEventListener("click", () => el("advancePaymentDialog").close());
  el("advanceMemberSearch").addEventListener("input", renderAdvanceMemberOptions);
  el("saveCloudBtn").addEventListener("click", event => saveToGoogleSheets(event.currentTarget));
  el("logoutBtn").addEventListener("click", event => logout(event.currentTarget));
  el("memberSearch").addEventListener("input", () => {
    resetPage("members");
    queueSearchLoad(renderMembers);
  });
  el("duesSearch").addEventListener("input", () => {
    resetPage("dues");
    clearTimeout(duesSearchTimer);
    duesSearchTimer = setTimeout(() => queueSearchLoad(renderDues), 90);
  });
  el("balanceSearch").addEventListener("input", () => {
    resetPage("balances");
    queueSearchLoad(renderDashboard);
  });
  el("activitySearch").addEventListener("input", () => {
    resetPage("activity");
    queueActivitySearchLoad();
  });
  ["dashboardFrom", "dashboardTo"].forEach(id => {
    el(id).addEventListener("change", () => {
      dashboardMonthTouched = true;
      resetPage("balances");
      renderDashboard();
    });
  });
  el("soaSearch").addEventListener("input", () => {
    resetPage("members");
    queueSearchLoad(() => {
      renderSoaOptions();
      renderSoa();
    });
  });
  el("soaMember").addEventListener("change", renderSoa);
  el("soaFrom").addEventListener("change", renderSoa);
  el("soaTo").addEventListener("change", renderSoa);
  el("printSoaBtn").addEventListener("click", () => window.print());
  el("downloadSoaPdfBtn").addEventListener("click", downloadSelectedSoaPdf);
  el("emailSoaBtn").addEventListener("click", sendSelectedSoaEmail);
  el("printAllSoaBtn").addEventListener("click", printAllSoa);

  el("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const submitButton = event.submitter;
    if (submitButton) submitButton.disabled = true;
    el("loginError").textContent = "Loading latest Google Sheet data...";
    const ok = await login(el("loginUsername").value.trim(), el("loginPassword").value);
    el("loginError").textContent = ok ? "" : "Invalid username or password.";
    if (ok) {
      el("loginPassword").value = "";
    }
    if (submitButton) submitButton.disabled = false;
  });

  el("memberForm").addEventListener("submit", event => {
    event.preventDefault();
    const id = el("memberId").value || uid();
    const existing = memberById(id);
    const member = {
      id,
      name: el("memberName").value.trim(),
      block: el("memberBlock").value.trim(),
      lot: el("memberLot").value.trim(),
      contact: el("memberContact").value.trim(),
      email: el("memberEmail").value.trim(),
      notes: el("memberNotes").value.trim(),
      status: el("memberStatus").value,
      updatedAt: new Date().toISOString(),
      updatedBy: currentUserName()
    };

    if (existing) {
      Object.assign(existing, member);
      logActivity(`Updated member ${member.name}`);
    } else {
      state.members.push({ ...member, createdAt: new Date().toISOString(), createdBy: currentUserName() });
      logActivity(`Added member ${member.name}`);
    }
    el("memberDialog").close();
    commitChange();
  });

  el("userForm").addEventListener("submit", event => {
    event.preventDefault();
    if (!requireAdmin()) return;

    const id = el("userId").value || uid();
    const username = el("userUsername").value.trim();
    const duplicate = state.users.find(user => user.username.toLowerCase() === username.toLowerCase() && user.id !== id);
    if (duplicate) {
      alert("Username already exists.");
      return;
    }

    const existing = state.users.find(user => user.id === id);
    const userData = {
      id,
      name: el("userName").value.trim(),
      username,
      role: el("userRole").value,
      status: el("userStatus").value,
      updatedAt: new Date().toISOString(),
      updatedBy: currentUserName()
    };

    const password = el("userPassword").value;
    if (password) userData.password = password;

    if (existing) {
      Object.assign(existing, userData);
      logActivity(`Updated system user ${userData.name}`);
    } else {
      state.users.push({ ...userData, password, createdAt: new Date().toISOString(), createdBy: currentUserName() });
      logActivity(`Added system user ${userData.name}`);
    }

    el("userDialog").close();
    commitChange();
  });

  el("passwordForm").addEventListener("submit", async event => {
    event.preventDefault();
    await changePassword(event.submitter);
  });

  el("duesForm").addEventListener("submit", event => {
    event.preventDefault();
    generateDues(el("duesMonth").value, money(el("duesAmount").value));
  });

  el("generateDuesBtn").addEventListener("click", () => generateDues(el("duesMonth").value || currentMonth(), money(el("duesAmount").value || state.settings.defaultDues)));
  el("advancePaymentBtn").addEventListener("click", openAdvancePaymentDialog);

  el("paymentForm").addEventListener("submit", event => {
    event.preventDefault();
    const due = state.dues.find(item => item.id === el("paymentDueId").value);
    if (!due) return;
    const receipt = el("paymentReceipt").value.trim();
    if (!receipt) {
      alert("Receipt number is required before recording payment.");
      return;
    }
    state.payments.push({
      id: uid(),
      dueId: due.id,
      memberId: due.memberId,
      date: el("paymentDate").value,
      amount: money(el("paymentAmount").value),
      receipt,
      paymentType: "Monthly Due",
      advancePayment: 0,
      createdAt: new Date().toISOString(),
      createdBy: currentUserName()
    });
    logActivity(`Recorded payment from ${memberName(due.memberId)} - Receipt #${receipt}`);
    el("paymentDialog").close();
    commitChange();
  });

  el("advancePaymentForm").addEventListener("submit", event => {
    event.preventDefault();
    const member = memberById(el("advanceMember").value);
    if (!member) return;
    const receipt = el("advanceReceipt").value.trim();
    const amount = money(el("advanceAmount").value);
    if (!receipt) {
      alert("Receipt number is required before recording advance payment.");
      return;
    }
    if (amount <= 0) {
      alert("Advance payment amount must be greater than zero.");
      return;
    }
    state.payments.push({
      id: uid(),
      dueId: ADVANCE_DUE_ID,
      memberId: member.id,
      date: el("advanceDate").value,
      amount,
      receipt,
      paymentType: "Advance Payment",
      advancePayment: amount,
      createdAt: new Date().toISOString(),
      createdBy: currentUserName()
    });
    logActivity(`Recorded advance payment from ${member.name} - Receipt #${receipt}`);
    el("advancePaymentDialog").close();
    commitChange("Advance payment saved locally - click Save");
  });

  el("expenseForm").addEventListener("submit", event => {
    event.preventDefault();
    state.expenses.push({
      id: uid(),
      date: el("expenseDate").value,
      category: el("expenseCategory").value.trim(),
      description: el("expenseDescription").value.trim(),
      amount: money(el("expenseAmount").value),
      createdAt: new Date().toISOString(),
      createdBy: currentUserName()
    });
    logActivity(`Added expense ${el("expenseCategory").value.trim()}`);
    event.target.reset();
    el("expenseDate").value = today();
    commitChange("Expense saved locally - click Save");
  });

  el("payrollForm").addEventListener("submit", event => {
    event.preventDefault();
    state.payroll.push({
      id: uid(),
      date: el("payrollDate").value,
      name: el("payrollName").value.trim(),
      role: el("payrollRole").value.trim(),
      amount: money(el("payrollAmount").value),
      createdAt: new Date().toISOString(),
      createdBy: currentUserName()
    });
    logActivity(`Added payroll for ${el("payrollName").value.trim()}`);
    event.target.reset();
    el("payrollDate").value = today();
    commitChange("Payroll saved locally - click Save");
  });

  el("settingsForm").addEventListener("submit", event => {
    event.preventDefault();
    state.settings.scriptUrl = el("scriptUrl").value.trim();
    state.settings.defaultDues = money(el("defaultDues").value);
    state.settings.startingFund = money(el("startingFund").value);
    state.settings.preparedBy = el("preparedBy").value.trim();
    logActivity("Updated settings");
    commitChange();
    setStatus(state.settings.scriptUrl ? "Ready" : "Local", state.settings.scriptUrl ? "ok" : "");
  });

  document.addEventListener("click", event => {
    const target = event.target;
    const editMember = target.dataset?.editMember;
    const deleteMember = target.dataset?.deleteMember;
    const payDue = target.dataset?.payDue;
    const deleteDue = target.dataset?.deleteDue;
    const deleteExpense = target.dataset?.deleteExpense;
    const deletePayroll = target.dataset?.deletePayroll;
    const editUser = target.dataset?.editUser;
    const deleteUser = target.dataset?.deleteUser;

    if (editMember) openMemberDialog(memberById(editMember));
    if (deleteMember && confirm("Delete this member? Existing dues and payments will remain for records.")) {
      const name = memberName(deleteMember);
      deleteById(state.members, deleteMember);
      logActivity(`Deleted member ${name}`);
      commitChange();
    }
    if (payDue) {
      const due = state.dues.find(item => item.id === payDue);
      el("paymentDueId").value = payDue;
      el("paymentDate").value = today();
      el("paymentAmount").value = due ? dueBalance(due) : 0;
      el("paymentReceipt").value = "";
      el("paymentDialog").showModal();
    }
    if (deleteDue && confirm("Delete this due record and its payments?")) {
      deleteById(state.dues, deleteDue);
      state.payments = state.payments.filter(payment => payment.dueId !== deleteDue);
      logActivity("Deleted a due record");
      commitChange();
    }
    if (deleteExpense && confirm("Delete this expense?")) {
      deleteById(state.expenses, deleteExpense);
      logActivity("Deleted an expense");
      commitChange();
    }
    if (deletePayroll && confirm("Delete this payroll record?")) {
      deleteById(state.payroll, deletePayroll);
      logActivity("Deleted a payroll record");
      commitChange();
    }
    if (editUser) openUserDialog(state.users.find(user => user.id === editUser));
    if (deleteUser && requireAdmin() && confirm("Delete this system user?")) {
      const user = state.users.find(item => item.id === deleteUser);
      if (user?.id === currentUserId) {
        alert("You cannot delete your own signed-in account.");
        return;
      }
      deleteById(state.users, deleteUser);
      logActivity(`Deleted system user ${user?.name || "Unknown user"}`);
      commitChange();
    }
  });
}

function generateDues(month, amount) {
  const billMonth = normalizeMonth(month);
  if (!billMonth || amount <= 0) return;
  const activeMembers = state.members.filter(member => member.status !== "Inactive");
  let created = 0;
  for (const member of activeMembers) {
    const exists = state.dues.some(due => due.memberId === member.id && normalizeMonth(due.month) === billMonth);
    if (!exists) {
      state.dues.push({ id: uid(), memberId: member.id, month: billMonth, amount, createdAt: new Date().toISOString(), createdBy: currentUserName() });
      created += 1;
    }
  }
  if (created === 0) {
    alert(`No new dues created for ${billMonth}. Bills may already exist for all active/delinquent members.`);
    return;
  }
  logActivity(`Generated ${created} dues for ${billMonth}`);
  commitChange();
}

async function login(username, password) {
  const loaded = await loadFromCloud({ confirmBefore: false, renderAfter: false, silent: true });
  if (loaded) {
    setStatus("Loaded", "ok");
  }

  const user = state.users.find(item =>
    item.username.toLowerCase() === username.toLowerCase() &&
    item.password === password &&
    item.status === "Active"
  );

  if (!user) return false;

  currentUserId = user.id;
  sessionStorage.setItem("gentreeVillasCurrentUserId", user.id);
  dashboardMonthTouched = false;
  if (!loaded) {
    setStatus("Using local data", "error");
  }
  logActivity(`Signed in as ${user.name}`);
  commitChange();
  return true;
}

async function logout(button) {
  if (!currentUser()) return;
  if (button) button.disabled = true;
  setStatus("Syncing");
  logActivity(`Signed out ${currentUserName()}`);
  localChangeVersion += 1;
  saveSyncMeta();
  save();
  syncQueued = true;
  const synced = await processSyncQueue();
  const hasPendingSync = !synced || syncedChangeVersion < localChangeVersion;

  currentUserId = "";
  sessionStorage.removeItem("gentreeVillasCurrentUserId");
  render();
  if (hasPendingSync) {
    syncQueued = true;
    saveSyncMeta();
    setStatus("Saved locally - click Save", "error");
    const details = lastSyncError ? `\n\nDetails: ${lastSyncError}` : "";
    alert(`You have been logged out. Some records were saved locally but did not sync to Google Sheets yet. Please login again later and click Save.${details}`);
  } else {
    setStatus("Ready", "ok");
  }
  if (button) button.disabled = false;
}

function seedDates() {
  el("dashboardFrom").value = currentMonth();
  el("dashboardTo").value = currentMonth();
  el("duesMonth").value = currentMonth();
  el("soaFrom").value = currentMonth();
  el("soaTo").value = currentMonth();
  el("expenseDate").value = today();
  el("payrollDate").value = today();
}

load();
loadSyncMeta();
seedDates();
bindEvents();
setStatus(state.settings.scriptUrl ? "Ready" : "Local", state.settings.scriptUrl ? "ok" : "");
render();
if (currentUser() && syncedChangeVersion < localChangeVersion) {
  setStatus("Saved locally - click Save");
}
