// 711 飲料紀杯管理平台 - Google Apps Script 後端程式碼
// ==========================================================
// 此檔案為整個系統核心邏輯。配合 README.md 中所描述的結構，
// 建議直接複製到 Google Apps Script 編輯器後再進行調整與測試。

/*************** 基本設定 ***************/
const SPREADSHEET_ID = "PUT_YOUR_SPREADSHEET_ID_HERE"; // TODO: 更換成實際試算表 ID
const SHEET_ADMINS   = "Admins";
const SHEET_CONFIG   = "Config";
const SHEET_CUSTOMERS= "Customers";
const TEMP_LINK_EXPIRATION_MINUTES = 10; // 臨時連結有效分鐘數

/** 取得 Spreadsheet 物件 */
function getSS() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/*************** 入口函式 ***************/
/**
 * Web App GET 入口
 * 根據網址參數 page / token 決定要回傳哪個頁面
 */
function doGet(e) {
  const page  = (e.parameter.page || "index").toString();
  if (page === "user") {
    const token = e.parameter.token || "";
    const payload = validateTempToken(token);
    if (!payload) {
      return HtmlService.createHtmlOutput("連結已失效或無效。");
    }
    const tpl = HtmlService.createTemplateFromFile("userView");
    tpl.customerId = payload.customerId;
    return tpl.evaluate().setTitle("顧客查詢");
  }
  // 預設回傳管理員介面
  return HtmlService.createTemplateFromFile("index").evaluate().setTitle("711 飲料紀杯平台");
}

/**
 * Web App POST 入口 (AJAX)
 * 依據 action 參數執行對應功能
 */
function doPost(e) {
  const action = (e.parameter.action || "").toString();
  let result = { success: false, msg: "未知動作" };
  try {
    switch (action) {
      case "login":
        result = handleLogin(e.parameter);
        break;
      case "register":
        result = handleRegister(e.parameter);
        break;
      case "addDrink":
        result = handleDrinkChange(e.parameter, 1);
        break;
      case "reduceDrink":
        result = handleDrinkChange(e.parameter, -1);
        break;
      case "createCustomer":
        result = handleCreateCustomer(e.parameter);
        break;
      case "generateLink":
        result = handleGenerateTempLink(e.parameter);
        break;
      case "getCustomerData":
        result = handleGetCustomerData(e.parameter);
        break;
    }
  } catch (err) {
    result = { success: false, msg: err.message };
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/*************** 帳號與授權 ***************/

/** 供前端直接呼叫 - 增加飲料 */
function addDrinkAPI(p){
  return handleDrinkChange(p,1);
}
/** 供前端直接呼叫 - 減少飲料 */
function reduceDrinkAPI(p){
  return handleDrinkChange(p,-1);
}

function handleLogin(p) {
  const { username, password } = p;
  const sheet = getSS().getSheetByName(SHEET_ADMINS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === username && data[i][1] === password) {
      return { success: true, msg: "登入成功" };
    }
  }
  return { success: false, msg: "帳號或密碼錯誤" };
}

function handleRegister(p) {
  const { username, password, verifyCode } = p;
  const ss = getSS();
  const cfg = ss.getSheetByName(SHEET_CONFIG).getRange("A1").getValue();
  if (verifyCode !== cfg) {
    return { success: false, msg: "驗證碼錯誤" };
  }
  const sheet = ss.getSheetByName(SHEET_ADMINS);
  sheet.appendRow([username, password]);
  return { success: true, msg: "註冊成功，可重新登入" };
}

/*************** 顧客與飲料管理 ***************/
function handleCreateCustomer(p) {
  const { customerId, customerName } = p;
  const ss = getSS();
  const sheetCustomers = ss.getSheetByName(SHEET_CUSTOMERS);
  // 檢查是否已存在
  const data = sheetCustomers.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === customerId) {
      return { success: false, msg: "顧客已存在" };
    }
  }
  // 建立顧客專屬 Sheet
  const newSheetName = "C-" + customerId;
  ss.insertSheet(newSheetName);
  // 初始化欄位
  ss.getSheetByName(newSheetName).appendRow(["飲料名稱", "剩餘杯數", "操作時間", "操作者", "動作", "異動數量"]);
  // 顧客對照表新增
  sheetCustomers.appendRow([customerId, customerName, newSheetName]);
  return { success: true, msg: "顧客建立完成" };
}

function handleDrinkChange(p, deltaSign) {
  const { customerId, drinkName, amount, operator } = p;
  const change = parseInt(amount, 10) * deltaSign;
  const ss = getSS();
  const sheetCustomers = ss.getSheetByName(SHEET_CUSTOMERS);
  const list = sheetCustomers.getDataRange().getValues();
  let sheetName = "";
  for (let i = 1; i < list.length; i++) {
    if (list[i][0] === customerId) {
      sheetName = list[i][2];
      break;
    }
  }
  if (!sheetName) return { success: false, msg: "找不到顧客" };
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { success: false, msg: "顧客工作表不存在" };
  // 讀取現有飲料資料
  const rows = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === drinkName) {
      rowIndex = i + 1; // 轉成 GAS 的 1-base row index
      break;
    }
  }
  if (rowIndex === -1) {
    // 新飲料
    sheet.appendRow([drinkName, change, new Date(), operator, (deltaSign>0?"增加":"減少"), Math.abs(change)]);
  } else {
    // 更新剩餘杯數
    const remaining = sheet.getRange(rowIndex, 2).getValue() + change;
    sheet.getRange(rowIndex, 2).setValue(remaining);
    // 新增異動紀錄（另外一行）
    sheet.appendRow([drinkName, remaining, new Date(), operator, (deltaSign>0?"增加":"減少"), Math.abs(change)]);
  }
  return { success: true, msg: "異動完成" };
}

/*************** 臨時連結 ***************/
function handleGenerateTempLink(p) {
  const { customerId } = p;
  const payload = {
    customerId: customerId,
    exp: Date.now() + TEMP_LINK_EXPIRATION_MINUTES * 60 * 1000
  };
  const token = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const url = ScriptApp.getService().getUrl() + "?page=user&token=" + token;
  return { success: true, url: url };
}

/**
 * 驗證臨時 token
 * 回傳 payload 或 null
 */
function validateTempToken(token) {
  if (!token) return null;
  try {
    const str = Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString();
    const payload = JSON.parse(str);
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/*************** 顧客查詢 ***************/
function handleGetCustomerData(p) {
  const { customerId } = p;
  const ss = getSS();
  const sheetCustomers = ss.getSheetByName(SHEET_CUSTOMERS);
  const list = sheetCustomers.getDataRange().getValues();
  let sheetName = "";
  for (let i = 1; i < list.length; i++) {
    if (list[i][0] === customerId) {
      sheetName = list[i][2];
      break;
    }
  }
  if (!sheetName) return { success: false, msg: "找不到顧客" };
  const sheet = ss.getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  return { success: true, data: data };
}

/*************** HTML Include 工具 ***************/
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/*************** 觸發器與其他工具（選擇性） ***************/
// 這裡可以放入排程或保護邏輯，確保資料安全與備份
