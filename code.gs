// 711 飲料紀杯管理平台 - Google Apps Script 後端程式碼
// ==========================================================
// 此檔案為整個系統核心邏輯。配合 README.md 中所描述的結構，
// 建議直接複製到 Google Apps Script 編輯器後再進行調整與測試。

/*************** 基本設定 ***************/
const SPREADSHEET_ID = ""; // TODO: 更換成實際試算表 ID
const SHEET_ADMINS = "Admins";
const ADMIN_COL_USERNAME = 1;
const ADMIN_COL_PASSWORD = 2;
const ADMIN_COL_NAME = 3;
const SHEET_CONFIG   = "Config";
const SHEET_CUSTOMERS= "Customers";
const TEMP_LINK_EXPIRATION_MINUTES = 10; // 臨時連結有效分鐘數

/**
 * 初始化API，設定必要的CORS頭
 */
function doOptions(e) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  return ContentService.createTextOutput(JSON.stringify({status: 'success'}))
    .setMimeType(ContentService.MimeType.JSON)
    .setHeaders(headers);
}

/** 取得 Spreadsheet 物件 */
function getSS() {
  let ss;
  if (SPREADSHEET_ID && SPREADSHEET_ID !== "PUT_YOUR_SPREADSHEET_ID_HERE") {
    try {
      ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    } catch(e) {}
  }
  if (!ss) {
    throw new Error("找不到目標 Spreadsheet。請在 SPREADSHEET_ID 設定正確試算表 ID，或將此 Apps Script 綁定到試算表再執行。");
  }
  ensureSheets(ss);
  return ss;
}

/** 確保基礎工作表存在，若無則自動建立 */
function ensureSheets(ss){
  if(!ss.getSheetByName(SHEET_CONFIG)){
    const s=ss.insertSheet(SHEET_CONFIG);
    s.getRange("A1").setValue("VERIFY_CODE");
  }
  if(!ss.getSheetByName(SHEET_ADMINS)){
    const s=ss.insertSheet(SHEET_ADMINS);
    s.appendRow(["Username","Password","DisplayName"]);
  }
  if(!ss.getSheetByName(SHEET_CUSTOMERS)){
    const s=ss.insertSheet(SHEET_CUSTOMERS);
    s.appendRow(["CustomerID","CustomerName","SheetName"]);
  }
}

/*************** 入口函式 ***************/
/**
 * Web App GET 入口
 * 根據網址參數 page / token 決定要回傳哪個頁面
 */
function doGet(e) {
  var headers = {
    'Access-Control-Allow-Origin': '*'
  };
  if (e.parameter['type'] === 'OPTIONS') {
    return jsonOutput({ success: true, msg: 'OPTIONS request' });
  }
  // 現有的 GET 邏輯
  const page = (e.parameter.page || "index").toString();
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
  var headers = {
    'Access-Control-Allow-Origin': '*'
  };
  if (e.parameter['type'] === 'OPTIONS') {
    return jsonOutput({ success: true, msg: 'OPTIONS request' });
  }

  const p = e.parameter;
  const action = p.action || '';
  const data = JSON.parse(p.data || '{}'); // 前端會傳 data=JSON.stringify({...})
  let res = { success: false, msg: '未知 action' };
  
  try {
    switch(action){
    case 'updateAdmin':
        res = handleUpdateAdmin(data);
        break;
      case 'login':
        res = handleLogin(data);
        break;
      case 'register':
        res = handleRegister(data);
        break;
      case 'createCustomer':
        res = handleCreateCustomer(data);
        break;
      case 'addDrink':
        res = handleDrinkChange(data, 1);
        break;
      case 'reduceDrink':
        res = handleDrinkChange(data, -1);
        break;
      case 'getCustomerData':
        res = handleGetCustomerData(data);
        break;
      case 'generateTempLink':
        res = handleGenerateTempLink(data);
        break;
      case 'getCustomerSummary':
        res = handleGetCustomerSummary(data);
        break;
      case 'getCustomerHistoryByMonth':
        res = handleGetCustomerHistoryByMonth(data);
        break;
      case 'validateToken':
        res = validateTempToken(data.token) 
              ? { success: true, payload: validateTempToken(data.token) }
              : { success: false, msg: 'token 失效' };
        break;
      default:
        res = { success: false, msg: '未定義的 action' };
        break;
    }
  } catch (err) {
    res = { success: false, msg: err.message };
  }

  return jsonOutput(res);  // 使用 jsonOutput 函式來加上 CORS 標頭
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

function handleLogin(p){
  const { username, password } = p;
  const ss = getSS();
  const sheet = ss.getSheetByName(SHEET_ADMINS);
  const data = sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    const row=data[i];
    if(String(row[ADMIN_COL_USERNAME-1])===String(username) && String(row[ADMIN_COL_PASSWORD-1])===String(password)){
      return {success:true, username: row[ADMIN_COL_USERNAME-1], displayName: row[ADMIN_COL_NAME-1] || username };
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
  sheet.appendRow([String(username), String(password), username]);
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
    if (String(data[i][0]) === String(customerId)) {
      return { success: false, msg: "顧客已存在" };
    }
  }
  // 建立顧客專屬 Sheet
  const newSheetName = "C-" + customerId;
  ss.insertSheet(newSheetName);
  // 初始化欄位
  ss.getSheetByName(newSheetName).appendRow(["飲料名稱", "剩餘杯數", "操作時間", "操作者", "動作", "異動數量"]);
// 顧客對照表新增
  sheetCustomers.appendRow([String(customerId), customerName, newSheetName]);
  return { success: true, msg: "顧客建立完成" };
}

function resolveCustomerId(idOrName){
  const ss=getSS();
  const sheet=ss.getSheetByName(SHEET_CUSTOMERS);
  const rows=sheet.getDataRange().getValues();
  for(let i=1;i<rows.length;i++){
    if(String(rows[i][0])===String(idOrName) || String(rows[i][1])===String(idOrName)){
      return rows[i][0];
    }
  }
  return null;
}

/*************** 管理員資料更新 ***************/
function handleUpdateAdmin(p){
  const {username, oldPassword, newPassword, newName}=p;
  if(!username||!oldPassword){return {success:false,msg:'缺少必要參數'};}
  const ss=getSS();
  const sheet=ss.getSheetByName(SHEET_ADMINS);
  const rows=sheet.getDataRange().getValues();
  for(let i=1;i<rows.length;i++){
    if(String(rows[i][ADMIN_COL_USERNAME-1])===String(username)){
      if(String(rows[i][ADMIN_COL_PASSWORD-1])!==String(oldPassword)){
        return {success:false,msg:'舊密碼錯誤'};
      }
      if(newPassword){ sheet.getRange(i+1,ADMIN_COL_PASSWORD).setValue(String(newPassword)); }
      if(newName){ sheet.getRange(i+1,ADMIN_COL_NAME).setValue(String(newName)); }
      return {success:true,msg:'更新成功'};
    }
  }
  return {success:false,msg:'找不到使用者'};
}

function handleDrinkChange(p, deltaSign) {
  let { customerId, drinkName, amount, operator } = p;
  customerId = resolveCustomerId(customerId);
  if(!customerId) return {success:false,msg:"找不到顧客"};

  const change = parseInt(amount, 10) * deltaSign;
  const ss = getSS();
  const sheetCustomers = ss.getSheetByName(SHEET_CUSTOMERS);
  const list = sheetCustomers.getDataRange().getValues();
  let sheetName = "";
  for (let i = 1; i < list.length; i++) {
    if (String(list[i][0]) === String(customerId)) {
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
    if (String(rows[i][0]) === String(drinkName)) {
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
    if (String(list[i][0]) === String(customerId)) {
      sheetName = list[i][2];
      break;
    }
  }
  if (!sheetName) return { success: false, msg: "找不到顧客" };
  const sheet = ss.getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  return { success: true, data: data };
}

/*************** 分頁與月份查詢 ***************/
/**
 * 取得顧客工作表完整資料
 * @param {string|number} customerId
 * @return {Array[]} 工作表所有列
 */
function getCustomerSheetData(customerId){
  const ss=getSS();
  const map=ss.getSheetByName(SHEET_CUSTOMERS).getDataRange().getValues();
  let sheetName='';
  for(let i=1;i<map.length;i++){
    if(String(map[i][0])===String(customerId)){
      sheetName=map[i][2];
      break;
    }
  }
  if(!sheetName) throw new Error('找不到顧客');
  const sheet=ss.getSheetByName(sheetName);
  if(!sheet) throw new Error('找不到工作表');
  return sheet.getDataRange().getValues();
}

/**
 * 取得顧客摘要（餘量 + 歷史分頁）
 * @param {{customerId:string|number,offset?:number,limit?:number}}
 */
function handleGetCustomerSummary(p){
  let { customerId, offset=0, limit=5 } = p;
  customerId = resolveCustomerId(customerId);
  if(!customerId) return {success:false,msg:"找不到顧客"};
  const off=parseInt(offset,10)||0;
  const lim=parseInt(limit,10)||5;
  const data=getCustomerSheetData(customerId);
  if(data.length<=1){
    return {success:true, remain:[], history:[], hasMore:false};
  }
  // 最新餘量 map
  const remainMap={};
  for(let i=1;i<data.length;i++){
    const [name,remain]=data[i];
    remainMap[name]=remain;
  }
  const remainArr=Object.entries(remainMap);
  // 歷史由新到舊
  const rows=data.slice(1).reverse();
  const historyPage=rows.slice(off, off+lim);
  const hasMore=off+lim<rows.length;
  return {success:true, remain:remainArr, history:historyPage, hasMore};
}

/**
 * 依月份取得顧客歷史
 * @param {{customerId:string|number, ym:string}} ym format YYYY-MM
 */
function handleGetCustomerHistoryByMonth(p){
  let { customerId, ym } = p;
  customerId = resolveCustomerId(customerId);
  if(!customerId) return {success:false,msg:"找不到顧客"};

  if(!ym) return {success:false, msg:'缺少月份'};
  const data=getCustomerSheetData(customerId);
  const list=[];
  for(let i=1;i<data.length;i++){
    const row=data[i];
    const d=new Date(row[2]);
    const y=d.getFullYear();
    const m=(d.getMonth()+1).toString().padStart(2,'0');
    if(`${y}-${m}`===ym){
      list.push(row);
    }
  }
  return {success:true, history:list};
}

/*************** 初始建置 ***************/
/**
 * 第一次安裝時手動執行此函式即可快速建立基礎工作表/欄位
 */
function initializeSetup(){
  const ss=getSS();
  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert("基礎工作表已檢查/建立完成！\n請到 Config!A1 填入註冊驗證碼，再到 Admins 新增一組管理員帳密。")
}

/*************** HTML Include 工具 ***************/
/*************** 共用輸出 ***************/
function jsonOutput(obj){
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
    // .setHeaders(headers);
}


/*************** Web API 入口 ***************/


/*************** HTML Include 工具 ***************/
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/*************** 觸發器與其他工具（選擇性） ***************/
// 這裡可以放入排程或保護邏輯，確保資料安全與備份
