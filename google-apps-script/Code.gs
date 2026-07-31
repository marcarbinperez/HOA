var SPREADSHEET_ID = "1zEi0twiEq6s14YS-tMj3S2PXAfb6CI24lX4dP3AePNI";
var ADVANCE_DUE_ID = "__ADVANCE_PAYMENT__";

var SHEETS = ["settings", "users", "members", "dues", "payments", "donations", "rentals", "memberships", "certificates", "stickers", "expenses", "payroll", "activity"];

var HEADERS = {
  settings: ["key", "value"],
  users: ["id", "name", "username", "password", "role", "status", "createdAt", "createdBy", "updatedAt", "updatedBy"],
  members: ["id", "name", "block", "lot", "contact", "email", "notes", "status", "advancePayment", "createdAt", "createdBy", "updatedAt", "updatedBy"],
  dues: ["id", "memberId", "month", "amount", "createdAt", "createdBy"],
  payments: ["id", "dueId", "memberId", "date", "amount", "receipt", "paymentType", "advancePayment", "createdAt", "createdBy"],
  donations: ["id", "date", "source", "note", "amount", "createdAt", "createdBy"],
  rentals: ["id", "facility", "date", "time", "note", "amount", "createdAt", "createdBy"],
  memberships: ["id", "memberId", "date", "note", "amount", "createdAt", "createdBy"],
  certificates: ["id", "memberId", "date", "note", "amount", "createdAt", "createdBy"],
  stickers: ["id", "date", "year", "vehicleType", "plateNumber", "ownerName", "block", "lot", "amount", "createdAt", "createdBy"],
  expenses: ["id", "date", "category", "description", "amount", "createdAt", "createdBy"],
  payroll: ["id", "date", "name", "role", "amount", "createdAt", "createdBy"],
  activity: ["id", "date", "text", "userId", "userName", "createdAt"]
};

function doPost(e) {
  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (payload.action !== "sync") return json({ ok: false, error: "Unsupported action" });

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
      ensureSheets(spreadsheet);
      writeData(spreadsheet, payload.data || {});
      return json({ ok: true });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return json({ ok: false, error: getErrorMessage(error) });
  }
}

function doGet() {
  try {
    var spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    ensureSheets(spreadsheet);
    return json({ ok: true, data: readData(spreadsheet) });
  } catch (error) {
    return json({ ok: false, error: getErrorMessage(error) });
  }
}

function ensureSheets(spreadsheet) {
  for (var i = 0; i < SHEETS.length; i++) {
    var name = SHEETS[i];
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    ensureHeader(sheet, name);
  }
}

function ensureHeader(sheet, name) {
  var headers = HEADERS[name];
  var lastColumn = sheet.getLastColumn();
  var current = [];
  var hasHeader = false;

  if (lastColumn > 0) {
    current = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    for (var i = 0; i < current.length; i++) {
      if (current[i] !== "") hasHeader = true;
    }
  }

  if (!hasHeader) {
    resetRows(sheet, headers, []);
    return;
  }

  if (sameHeaders(current, headers)) return;

  var oldRecords = readRowsByHeaders(sheet, current);
  var rows = [];
  for (var r = 0; r < oldRecords.length; r++) {
    rows.push(recordToRow(normalizeRecord(name, oldRecords[r]), headers));
  }
  resetRows(sheet, headers, rows);
}

function writeData(spreadsheet, data) {
  writeSettings(spreadsheet.getSheetByName("settings"), data.settings || {});

  for (var i = 0; i < SHEETS.length; i++) {
    var name = SHEETS[i];
    if (name !== "settings") {
      var records = [];
      if (data && Object.prototype.toString.call(data[name]) === "[object Array]") {
        records = data[name];
      }
      writeRows(spreadsheet.getSheetByName(name), name, records);
    }
  }
}

function writeSettings(sheet, settings) {
  var rows = [];
  for (var key in settings) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) rows.push([key, settings[key]]);
  }
  resetRows(sheet, HEADERS.settings, rows);
}

function writeRows(sheet, name, records) {
  var headers = HEADERS[name];
  var rows = [];
  for (var i = 0; i < records.length; i++) {
    rows.push(recordToRow(normalizeRecord(name, records[i]), headers));
  }
  resetRows(sheet, headers, rows);
}

function normalizeRecord(name, record) {
  var copy = {};
  record = record || {};
  for (var key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) copy[key] = record[key];
  }

  if (name === "payments") {
    var type = String(copy.paymentType || "").toLowerCase();
    var isAdvance = copy.dueId === ADVANCE_DUE_ID || type.indexOf("advance") >= 0;
    if (!copy.paymentType) copy.paymentType = isAdvance ? "Advance Payment" : "Monthly Due";
    if (isAdvance && !copy.advancePayment) copy.advancePayment = copy.amount || "";
    if (!isAdvance) copy.advancePayment = "";
  }
  return copy;
}

function resetRows(sheet, headers, rows) {
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  if (rows.length > 0) {
    var range = sheet.getRange(2, 1, rows.length, headers.length);
    range.setNumberFormat("@");
    range.setValues(rows);
  }
}

function readData(spreadsheet) {
  var data = {};
  data.settings = readSettings(spreadsheet.getSheetByName("settings"));

  for (var i = 0; i < SHEETS.length; i++) {
    var name = SHEETS[i];
    if (name !== "settings") {
      data[name] = readRowsByHeaders(spreadsheet.getSheetByName(name), HEADERS[name]);
    }
  }
  return data;
}

function readSettings(sheet) {
  var values = sheet.getDataRange().getValues();
  var settings = {};
  for (var i = 1; i < values.length; i++) {
    if (values[i][0]) settings[values[i][0]] = values[i][1];
  }
  return settings;
}

function readRowsByHeaders(sheet, headers) {
  var values = sheet.getDataRange().getValues();
  var records = [];
  for (var r = 1; r < values.length; r++) {
    if (!rowHasValue(values[r])) continue;
    var record = {};
    for (var h = 0; h < headers.length; h++) {
      if (headers[h]) record[String(headers[h]).trim()] = values[r][h];
    }
    records.push(record);
  }
  return records;
}

function recordToRow(record, headers) {
  var row = [];
  for (var i = 0; i < headers.length; i++) {
    var value = record[headers[i]];
    row.push(value === undefined || value === null ? "" : value);
  }
  return row;
}

function sameHeaders(current, expected) {
  if (current.length !== expected.length) return false;
  for (var i = 0; i < expected.length; i++) {
    if (String(current[i] || "").trim() !== expected[i]) return false;
  }
  return true;
}

function rowHasValue(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== "" && row[i] !== null && row[i] !== undefined) return true;
  }
  return false;
}

function getErrorMessage(error) {
  return String(error && error.message ? error.message : error);
}

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
