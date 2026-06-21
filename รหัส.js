// ============================================================
// HosXP Report Request System — Code.gs (Backend + LINE OA)
// Google Apps Script + Google Sheets + LINE Messaging API
// ============================================================

// ─── CONFIG ──────────────────────────────────────────────────
const SHEET_NAME_REQUESTS = "Requests";
const SHEET_NAME_USERS = "Users";
const SHEET_NAME_LOGS = "Logs";

const ADMIN_ROLE = "admin";
const DOCTOR_ROLE = "doctor";

// 🚨 LINE OA CONFIGURATION (ใส่ค่าของคุณที่นี่)
const LINE_ACCESS_TOKEN = "s0ueKkw86PCVQ/EdBVv2mM0SpJwaSCEIYi7u+jTA8A7xJtp0EPmmbBGprdVz8lv7sZnp7le48L+R6cjM2nJh7icNiOz/LIlaq7Z72ArjXxB/HZ8H2g4lt7qpmxtQq6rJH9jrfydfJPODklRMak1JxgdB04t89/1O/w1cDnyilFU=";
const LINE_ADMIN_GROUP_ID = "Ud1ee9e2dd0d262fa7f6e6780f40df0c8";
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbw218gf5IZqOzkoilIZBpISRFQ4o9aH6_B9pxPJuf70FORyuNFEV4y7csTCcC7rYYbE/exec"; // สำหรับปุ่มกดใน LINE

// 🚨 TELEGRAM CONFIGURATION (ใส่ค่าของคุณที่นี่)
const TELEGRAM_BOT_TOKEN = "7931324702:AAGVf1TZ808MWdiVq3uVoNU3DKJ0Z8ppt00";
const TELEGRAM_ADMIN_CHAT_ID = ""; // สามารถระบุ Chat ID ของกลุ่มแอดมินไอทีได้ (เช่น -100xxxxxxxxx หรือ ID ผู้ใช้)

// ─── API PROVIDERS CONFIGURATION ─────────────────────────────
const API_PROVIDERS = [
  { name: "GEMINI", provider: "google" },
  { name: "OPENAI", provider: "openai" },
  { name: "CLAUDE", provider: "anthropic" }
];

/**
 * ฟังก์ชันหลักสำหรับเรียก AI พร้อมระบบ Fallback สลับ API อัตโนมัติ
 */
function getAIResponseWithFallback(prompt, systemInstruction, history = []) {
  const props = PropertiesService.getScriptProperties().getProperties();
  
  for (const api of API_PROVIDERS) {
    try {
      const apiKey = props[api.name + "_API_KEY"];
      if (!apiKey) continue; // ข้ามถ้าไม่มี Key

      let response;
      if (api.provider === "google") {
        response = callGemini(prompt, systemInstruction, history, apiKey);
      } else if (api.provider === "openai") {
        response = callOpenAI(prompt, systemInstruction, history, apiKey);
      } else if (api.provider === "anthropic") {
        response = callAnthropic(prompt, systemInstruction, history, apiKey);
      }

      const status = response.getResponseCode();
      const content = response.getContentText();
      const json = JSON.parse(content);

      // ถ้าเจอ Error ที่ควรสลับ (429: Rate Limit, 401: Unauthorized, 403: Forbidden/Quota)
      if ([401, 403, 429].includes(status)) {
        writeLog("AI_FALLBACK", api.name, `Error ${status}: กำลังสลับไป API ถัดไป...`);
        continue; 
      }

      if (status !== 200) {
        writeLog("AI_ERROR", api.name, `HTTP ${status}: ${content}`);
        continue;
      }

      // แกะคำตอบตามโครงสร้างแต่ละค่าย
      let aiText = "";
      if (api.provider === "google") aiText = json.candidates[0].content.parts[0].text;
      else if (api.provider === "openai") aiText = json.choices[0].message.content;
      else if (api.provider === "anthropic") aiText = json.content[0].text;

      return { success: true, text: aiText, provider: api.name };

    } catch (e) {
      writeLog("AI_EXCEPTION", api.name, e.message);
      continue;
    }
  }
  return { success: false, message: "API ทุกค่ายไม่สามารถใช้งานได้ในขณะนี้" };
}

// ─── PROVIDER SPECIFIC CALLS ──────────────────────────────────

function callGemini(prompt, system, history, key) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key=${key}`;
  const contents = history.map(h => ({ role: h.role === "model" ? "model" : "user", parts: [{ text: h.text }] }));
  contents.push({ role: "user", parts: [{ text: prompt }] });

  return UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: contents,
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
    })
  });
}

function callOpenAI(prompt, system, history, key) {
  const url = "https://api.openai.com/v1/chat/completions";
  const messages = [{ role: "system", content: system }];
  history.forEach(h => messages.push({ role: h.role === "model" ? "assistant" : "user", content: h.text }));
  messages.push({ role: "user", content: prompt });

  return UrlFetchApp.fetch(url, {
    method: "post",
    headers: { "Authorization": `Bearer ${key}` },
    contentType: "application/json",
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: messages,
      temperature: 0.3
    })
  });
}

function callAnthropic(prompt, system, history, key) {
  const url = "https://api.anthropic.com/v1/messages";
  const messages = history.map(h => ({ role: h.role === "model" ? "assistant" : "user", content: h.text }));
  messages.push({ role: "user", content: prompt });

  return UrlFetchApp.fetch(url, {
    method: "post",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: "claude-3-haiku-20240307",
      system: system,
      messages: messages,
      max_tokens: 2048
    })
  });
}

/**
 * สุดยอดฟังก์ชันตรวจเช็ค AI (Super Debug)
 * ให้รันฟังก์ชันนี้เพื่อดูสาเหตุที่แท้จริงว่าทำไม AI ถึงไม่ทำงาน
 */
function superDebugAI() {
  const props = PropertiesService.getScriptProperties().getProperties();
  Logger.log("🚀 เริ่มการตรวจสอบระบบ AI...");

  API_PROVIDERS.forEach(api => {
    const keyName = api.name + "_API_KEY";
    const key = props[keyName];
    
    if (!key) {
      Logger.log(`❌ ${api.name}: ตรวจไม่พบ Key ชื่อ "${keyName}" ใน Script Properties (ระบบจึงข้ามไป)`);
      return;
    }

    Logger.log(`⏳ ${api.name}: ตรวจพบ Key... กำลังลองยิงทดสอบ...`);
    
    try {
      let res;
      if (api.provider === "google") res = callGemini("Hi", "Test", [], key);
      else if (api.provider === "openai") res = callOpenAI("Hi", "Test", [], key);
      else if (api.provider === "anthropic") res = callAnthropic("Hi", "Test", [], key);
      
      const code = res.getResponseCode();
      const body = res.getContentText();
      
      if (code === 200) {
        Logger.log(`✅ ${api.name}: ทำงานได้ปกติ! (HTTP 200)`);
      } else {
        Logger.log(`⚠️ ${api.name}: เชื่อมต่อได้แต่ Error (HTTP ${code})`);
        Logger.log(`   รายละเอียด: ${body}`);
      }
    } catch (e) {
      Logger.log(`❌ ${api.name}: ระบบขัดข้องขณะเชื่อมต่อ - ${e.message}`);
    }
  });
  
  Logger.log("🏁 จบการตรวจสอบ");
}

/**
 * ฟังก์ชันสำหรับตรวจสอบการตั้งค่า API Keys (ใช้ Debug เท่านั้น)
 * ให้คลิกเลือกฟังก์ชันนี้แล้วกด "เรียกทำงาน" ในหน้า GAS Editor
 */
function checkApiSettings() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const results = [];
  
  API_PROVIDERS.forEach(api => {
    const keyName = api.name + "_API_KEY";
    const keyExists = !!props[keyName];
    results.push(`${keyName}: ${keyExists ? "✅ พร้อมใช้งาน" : "❌ ไม่พบ Key"}`);
  });
  
  Logger.log("=== API Settings Diagnostic ===");
  results.forEach(res => Logger.log(res));
  Logger.log("===============================");
  
  return results.join("\n");
}

// ─── ENTRY POINT (WEB APP) ───────────────────────────────────
function doGet(e) {
  return HtmlService
    .createTemplateFromFile("Index")
    .evaluate()
    .setTitle("ระบบขอรายงาน HosXP")
    .addMetaTag("viewport", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ─── LINE WEBHOOK (ใช้สำหรับหา GROUP ID และ USER ID) ──────────
function doPost(e) {
  try {
    const json = JSON.parse(e.postData.contents);
    const event = json.events[0];
    if (!event) return;

    const replyToken = event.replyToken;
    const messageText = event.message ? event.message.text : "";

    // ดึงค่า Source (มาจากห้องแชทไหน)
    const source = event.source;
    let targetId = "";
    let contextType = "";

    if (source.type === "group") {
      targetId = source.groupId;
      contextType = "Group ID";
    } else if (source.type === "room") {
      targetId = source.roomId;
      contextType = "Room ID";
    } else if (source.type === "user") {
      targetId = source.userId;
      contextType = "User ID";
    }

    // บันทึกลง Log ของระบบเพื่อให้มาดูย้อนหลังได้
    writeLog("LINE_WEBHOOK", "GET_ID", `ประเภท: ${contextType} | ID: ${targetId} | ข้อความ: ${messageText}`);

    // ถ้าพิมพ์คำว่า @id ให้พิมพ์ตอบกลับในไลน์กลุ่มนั้นทันที
    if (messageText.includes("@id")) {
      const responseText = `📌 ข้อมูล ID สำหรับระบบรายงาน:\n🔹 ประเภทแชท: ${contextType}\n🆔 ID ของท่าน: ${targetId}`;

      UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
        "method": "post",
        "headers": {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + LINE_ACCESS_TOKEN
        },
        "payload": JSON.stringify({
          "replyToken": replyToken,
          "messages": [{ "type": "text", "text": responseText }]
        })
      });
    }
  } catch (err) {
    writeLog("SYSTEM_ERROR", "LINE_WEBHOOK_CATCH", err.message);
  }
}

// ─── USER MANAGEMENT API ──────────────────────────────────────

/**
 * ดึงรายชื่อผู้ใช้ทั้งหมด (เฉพาะ Admin)
 */
function getUsers() {
  const sheet = getSheet(SHEET_NAME_USERS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  return {
    success: true,
    data: data.slice(1).map(row => {
      let obj = {};
      headers.forEach((h, i) => {
        let val = row[i];
        if (h === 'username' && val !== null && val !== undefined) {
          val = val.toString().trim();
        }
        obj[h] = val;
      });
      return obj;
    })
  };
}

/**
 * เพิ่มหรือแก้ไขผู้ใช้
 */
function saveUser(payload) {
  const sheet = getSheet(SHEET_NAME_USERS);
  const data = sheet.getDataRange().getValues();

  // ใช้ oldUsername ในการระบุแถวที่ต้องการแก้ไข (ถ้ามี) เพื่อรองรับการเปลี่ยน Username
  const targetUsername = (payload.oldUsername || payload.username).toString().trim();
  const newUsername = payload.username.trim();

  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === targetUsername) {
      rowIndex = i + 1;
      break;
    }
  }

  const rowData = [
    newUsername,
    payload.password,
    payload.displayName,
    payload.email,
    payload.role,
    payload.department,
    payload.lineId ? payload.lineId.trim() : "",
    payload.telegramId ? payload.telegramId.trim() : ""
  ];

  if (rowIndex > 0) {
    sheet.getRange(rowIndex, 1, 1, 8).setValues([rowData]);
    writeLog("admin", "USER_UPDATE", `แก้ไขผู้ใช้: ${targetUsername} ${targetUsername !== newUsername ? '-> ' + newUsername : ''}`);
  } else {
    // กรณีเพิ่มใหม่ เช็คก่อนว่า Username ซ้ำไหม
    const exists = data.some(row => row[0] && row[0].toString().trim() === newUsername);
    if (exists) return { success: false, message: "ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว" };

    sheet.appendRow(rowData);
    writeLog("admin", "USER_CREATE", `เพิ่มผู้ใช้ใหม่: ${newUsername}`);
  }
  return { success: true };
}

/**
 * ลบผู้ใช้งานออกจากระบบ (เฉพาะ Admin)
 */
function deleteUser(usernameToDelete, currentUsername, currentRole) {
  try {
    if (currentRole !== ADMIN_ROLE) {
      return { success: false, message: "เฉพาะผู้ดูแลระบบเท่านั้นที่มีสิทธิ์ลบผู้ใช้" };
    }
    if (usernameToDelete.toString().trim() === currentUsername.toString().trim()) {
      return { success: false, message: "ระบบป้องกันความปลอดภัย: ไม่สามารถลบ Account ของตัวเองได้" };
    }

    const sheet = getSheet(SHEET_NAME_USERS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().trim() === usernameToDelete.toString().trim()) {
        sheet.deleteRow(i + 1);
        writeLog(currentUsername, "USER_DELETE", `ลบผู้ใช้งาน: ${usernameToDelete}`);
        return { success: true };
      }
    }
    return { success: false, message: "ไม่พบผู้ใช้งานที่ต้องการลบ" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── LINE TEST FUNCTION ───────────────────────────────────────

/**
 * ส่งข้อความทดสอบเข้า LINE Group/User ที่ตั้งค่าไว้
 */
function testLineNotification(targetId) {
  const toId = targetId || LINE_ADMIN_GROUP_ID;
  const testPayload = {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "⚡ LINE API TEST", weight: "bold", color: "#ffffff" }
      ],
      backgroundColor: "#333333"
    },
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "การเชื่อมต่อสมบูรณ์!", weight: "bold", size: "md" },
        { type: "text", text: "ระบบพร้อมแจ้งเตือนแล้ว", size: "sm", color: "#666666", margin: "sm" },
        { type: "text", text: "เวลาทดสอบ: " + new Date().toLocaleString("th-TH"), size: "xs", color: "#999999", margin: "md" }
      ]
    }
  };

  sendLineNotification(toId, testPayload);
  return { success: true, message: "ส่งข้อความทดสอบแล้ว กรุณาเช็คใน LINE" };
}

// ─── SHEET HELPERS ───────────────────────────────────────────
function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

// อัปเดตตารางสิทธิ์ผู้ใช้และหัวข้อตารางส่งคำขอ
function ensureHeaders() {
  const reqSheet = getSheet(SHEET_NAME_REQUESTS);
  const expectedReqHeaders = [
    "id", "requestNo", "requesterName", "requesterEmail", "department",
    "reportType", "dateFrom", "dateTo", "purpose", "urgency",
    "status", "adminNote", "createdAt", "updatedAt", "createdBy",
    "requesterPhone", "dataType", "requestedFields", "filterCondition",
    "fileFormat", "neededDate", "additionalNote"
  ];

  if (reqSheet.getLastRow() === 0) {
    reqSheet.appendRow(expectedReqHeaders);
    reqSheet.getRange(1, 1, 1, expectedReqHeaders.length).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");
  } else {
    // อัปเดตโครงสร้างคอลัมน์เดิมหากมีไม่ครบ 22 ฟิลด์
    const currentHeaders = reqSheet.getRange(1, 1, 1, reqSheet.getLastColumn()).getValues()[0];
    if (currentHeaders.length < expectedReqHeaders.length) {
      reqSheet.getRange(1, currentHeaders.length + 1, 1, expectedReqHeaders.length - currentHeaders.length)
        .setValues([expectedReqHeaders.slice(currentHeaders.length)])
        .setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");
    }
  }

  const usrSheet = getSheet(SHEET_NAME_USERS);
  const expectedUsrHeaders = ["username", "password", "displayName", "email", "role", "department", "lineId", "telegramId"];
  if (usrSheet.getLastRow() === 0) {
    usrSheet.appendRow(expectedUsrHeaders);
    usrSheet.getRange(1, 1, 1, expectedUsrHeaders.length).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");

    const seedData = [
      ["admin", "admin1234", "ผู้ดูแลระบบ", "admin@hospital.go.th", "admin", "IT", "", ""],
      ["doctor01", "doc1234", "นพ.สมชาย ใจดี", "doctor01@hospital.go.th", "doctor", "อายุรกรรม", "", ""],
      ["doctor02", "doc1234", "พญ.สมหญิง รักษาดี", "doctor02@hospital.go.th", "doctor", "ศัลยกรรม", "", ""],
      ["nurse01", "nur1234", "พยาบาล สมใจ", "nurse01@hospital.go.th", "doctor", "ห้องฉุกเฉิน", "", ""]
    ];
    usrSheet.getRange(2, 1, seedData.length, expectedUsrHeaders.length).setValues(seedData);
  } else {
    const currentHeaders = usrSheet.getRange(1, 1, 1, usrSheet.getLastColumn()).getValues()[0];
    if (currentHeaders.length < expectedUsrHeaders.length) {
      usrSheet.getRange(1, 1, 1, expectedUsrHeaders.length)
        .setValues([expectedUsrHeaders])
        .setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");
    }
  }

  const logSheet = getSheet(SHEET_NAME_LOGS);
  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow(["timestamp", "username", "action", "detail"]);
    logSheet.getRange(1, 1, 1, 4).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");
  }
}

// ─── AUTH ─────────────────────────────────────────────────────
function login(username, password) {
  try {
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_USERS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[0] && row[0].toString().trim() === username.toString().trim() && row[1].toString().trim() === password.toString().trim()) {
        writeLog(username, "LOGIN", "เข้าสู่ระบบสำเร็จ");
        return {
          success: true,
          user: {
            username: row[0].toString().trim(),
            displayName: row[2],
            email: row[3],
            role: row[4],
            department: row[5],
            lineId: row[6] || "",
            telegramId: row[7] || ""
          }
        };
      }
    }
    return { success: false, message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" };
  } catch (e) {
    return { success: false, message: "เกิดข้อผิดพลาดระบบ: " + e.message };
  }
}

// ─── REQUESTS CRUD ───────────────────────────────────────────

function getRequests(username, role, displayName) {
  try {
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();

    const parseData = (val) => (val instanceof Date) ? val.toISOString() : val;

    const rows = data.slice(1).map(row => ({
      id: parseData(row[0]),
      requestNo: parseData(row[1]),
      requesterName: parseData(row[2]),
      requesterEmail: parseData(row[3]),
      department: parseData(row[4]),
      reportType: parseData(row[5]),
      dateFrom: parseData(row[6]),
      dateTo: parseData(row[7]),
      purpose: parseData(row[8]),
      urgency: parseData(row[9]),
      status: parseData(row[10]),
      adminNote: parseData(row[11]),
      createdAt: parseData(row[12]),
      updatedAt: parseData(row[13]),
      createdBy: (row[14] || "").toString().trim(),
      requesterPhone: parseData(row[15] || ""),
      dataType: parseData(row[16] || ""),
      requestedFields: parseData(row[17] || ""),
      filterCondition: parseData(row[18] || ""),
      fileFormat: parseData(row[19] || ""),
      neededDate: parseData(row[20] || ""),
      additionalNote: parseData(row[21] || "")
    }));

    return { success: true, data: rows };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function createRequest(payload, username) {
  try {
    ensureHeaders();
    const userSheet = getSheet(SHEET_NAME_USERS);
    const userData = userSheet.getDataRange().getValues();

    let displayName = username;
    for (let i = 1; i < userData.length; i++) {
      if (userData[i][0].toString() === username.toString()) {
        displayName = userData[i][2];
        break;
      }
    }

    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const id = Utilities.getUuid();
    const now = new Date().toISOString();
    const reqNo = generateRequestNo();

    sheet.appendRow([
      id,
      reqNo,
      payload.requesterName,
      payload.requesterEmail,
      payload.department,
      payload.reportType,
      payload.dateFrom,
      payload.dateTo,
      payload.purpose,
      payload.urgency,
      "รอดำเนินการ",
      "",
      now,
      now,
      displayName,
      payload.requesterPhone || "",
      payload.dataType || "",
      payload.requestedFields || "",
      payload.filterCondition || "",
      payload.fileFormat || "",
      payload.neededDate || "",
      payload.additionalNote || ""
    ]);

    writeLog(username, "CREATE", "สร้างคำขอโดย " + displayName);

    // 🚀 ยิงแจ้งเตือนเข้า LINE OA ทันทีที่มีการสร้างคำขอใหม่
    payload.requestNo = reqNo;
    sendLineNotification(LINE_ADMIN_GROUP_ID, buildNewRequestFlex(payload));

    // 🚀 ยิงแจ้งเตือนเข้า Telegram แอดมิน (ถ้ากำหนดไว้)
    if (TELEGRAM_ADMIN_CHAT_ID) {
      const tgNewMsg = `📥 <b>มีคำขอรายงาน HosXP ใหม่</b>\n\n` +
        `<b>เลขที่คำขอ:</b> ${reqNo}\n` +
        `<b>รายงาน:</b> ${payload.reportType}\n` +
        `<b>ความเร่งด่วน:</b> ${payload.urgency}\n` +
        `<b>ผู้ขอ:</b> ${payload.requesterName} (${payload.department})\n` +
        `<b>ช่วงข้อมูล:</b> ${payload.dateFrom} ถึง ${payload.dateTo}\n` +
        `<b>รูปแบบไฟล์:</b> ${payload.fileFormat || "-"}\n` +
        `<b>วัตถุประสงค์:</b> ${payload.purpose}`;
      sendTelegramNotification(TELEGRAM_ADMIN_CHAT_ID, tgNewMsg);
    }

    return { success: true, id: id, requestNo: reqNo };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function updateRequest(id, payload, username, role) {
  try {
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        if (role !== ADMIN_ROLE) {
          if (data[i][14].toString().trim() !== username.toString().trim() && data[i][14].toString().trim() !== payload.requesterName.toString().trim()) {
            return { success: false, message: "ไม่มีสิทธิ์แก้ไขรายการนี้" };
          }
          if (data[i][10] !== "รอดำเนินการ") {
            return { success: false, message: "ไม่สามารถแก้ไขรายการที่ดำเนินการแล้ว" };
          }
        }

        const row = i + 1;
        const oldStatus = data[i][10];
        const createdBy = data[i][14];

        sheet.getRange(row, 3).setValue(payload.requesterName || data[i][2]);
        sheet.getRange(row, 4).setValue(payload.requesterEmail || data[i][3]);
        sheet.getRange(row, 5).setValue(payload.department || data[i][4]);
        sheet.getRange(row, 6).setValue(payload.reportType || data[i][5]);
        sheet.getRange(row, 7).setValue(payload.dateFrom || data[i][6]);
        sheet.getRange(row, 8).setValue(payload.dateTo || data[i][7]);
        sheet.getRange(row, 9).setValue(payload.purpose || data[i][8]);
        sheet.getRange(row, 10).setValue(payload.urgency || data[i][9]);

        if (role === ADMIN_ROLE) {
          sheet.getRange(row, 11).setValue(payload.status || data[i][10]);
          sheet.getRange(row, 12).setValue(payload.adminNote !== undefined ? payload.adminNote : data[i][11]);
        }

        sheet.getRange(row, 14).setValue(new Date().toISOString());

        // บันทึกฟิลด์ที่พัฒนาเพิ่มเติม
        sheet.getRange(row, 16).setValue(payload.requesterPhone !== undefined ? payload.requesterPhone : (data[i][15] || ""));
        sheet.getRange(row, 17).setValue(payload.dataType !== undefined ? payload.dataType : (data[i][16] || ""));
        sheet.getRange(row, 18).setValue(payload.requestedFields !== undefined ? payload.requestedFields : (data[i][17] || ""));
        sheet.getRange(row, 19).setValue(payload.filterCondition !== undefined ? payload.filterCondition : (data[i][18] || ""));
        sheet.getRange(row, 20).setValue(payload.fileFormat !== undefined ? payload.fileFormat : (data[i][19] || ""));
        sheet.getRange(row, 21).setValue(payload.neededDate !== undefined ? payload.neededDate : (data[i][20] || ""));
        sheet.getRange(row, 22).setValue(payload.additionalNote !== undefined ? payload.additionalNote : (data[i][21] || ""));

        writeLog(username, "UPDATE", "แก้ไขคำขอ " + data[i][1]);

        // 🚀 แจ้งเตือนกลุ่ม Admin กรณีผู้ใช้งานอัปเดตข้อมูลคำขอด้วยตนเอง
        if (role !== ADMIN_ROLE) {
          const editMsg = `✏️ <b>ผู้ใช้งานแก้ไขข้อมูลคำขอ</b>\n\n<b>เลขที่:</b> ${data[i][1]}\n<b>รายงาน:</b> ${payload.reportType || data[i][5]}`;
          sendLineNotification(LINE_ADMIN_GROUP_ID, {
            "type": "bubble",
            "body": {
              "type": "box", "layout": "vertical",
              "contents": [
                { "type": "text", "text": "✏️ ผู้ใช้แก้ไขข้อมูลคำขอ", "weight": "bold", "color": "#1A73E8" },
                { "type": "text", "text": `เลขที่: ${data[i][1]}`, "size": "sm" },
                { "type": "text", "text": `รายงาน: ${payload.reportType || data[i][5]}`, "size": "sm", "wrap": true }
              ]
            }
          });
          if (TELEGRAM_ADMIN_CHAT_ID) sendTelegramNotification(TELEGRAM_ADMIN_CHAT_ID, editMsg);
        }

        // 🚀 ระบบแจ้งเตือนอัจฉริยะเมื่อแอดมินอัปเดตสถานะงาน
        if (role === ADMIN_ROLE && payload.status && payload.status !== oldStatus) {
          const flexMessage = buildStatusUpdateFlex(
            data[i][1],
            payload.reportType || data[i][5],
            payload.status,
            payload.adminNote || "ไม่มี"
          );

          // 1. ส่งเข้ากลุ่มแอดมินกลาง
          sendLineNotification(LINE_ADMIN_GROUP_ID, flexMessage);

          // 2. ดึง LINE ID และ Telegram ID ของผู้แจ้ง เพื่อส่งข้อความทักไปบอกส่วนตัว
          const userSheet = getSheet(SHEET_NAME_USERS);
          const uData = userSheet.getDataRange().getValues();
          for (let u = 1; u < uData.length; u++) {
            if (uData[u][2] === createdBy) {
              const uLineId = uData[u][6];
              const uTelegramId = uData[u][7];

              if (uLineId) {
                sendLineNotification(uLineId, flexMessage); // ยิงหา LINE ID ของผู้ใช้คนนั้น
              }

              if (uTelegramId) {
                const tgMsg = `🔄 <b>อัปเดตสถานะคำขอรายงาน</b>\n\n` +
                  `<b>เลขที่คำขอ:</b> ${data[i][1]}\n` +
                  `<b>รายงาน:</b> ${payload.reportType || data[i][5]}\n` +
                  `<b>สถานะล่าสุด:</b> ${payload.status}\n` +
                  `<b>หมายเหตุไอที:</b> ${payload.adminNote || "ไม่มี"}`;
                sendTelegramNotification(uTelegramId, tgMsg); // ยิงแจ้งเตือนผ่าน Telegram
              }
              break;
            }
          }
        }
        return { success: true };
      }
    }
    return { success: false, message: "ไม่พบรายการ" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ปรับปรุงระบบลบคำขอ: อนุญาตให้เจ้าของงานลบได้ ถ้างานยังไม่ถูกดำเนินงาน
function deleteRequest(id, username, role) {
  try {
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();

    // ค้นหา displayName ของผู้ใช้งานปัจจุบันเพื่อเช็คความเป็นเจ้าของงาน
    const userSheet = getSheet(SHEET_NAME_USERS);
    const userData = userSheet.getDataRange().getValues();
    let userDisplayName = username;
    for (let u = 1; u < userData.length; u++) {
      if (userData[u][0].toString().trim() === username.toString().trim()) {
        userDisplayName = userData[u][2];
        break;
      }
    }

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        const reqNo = data[i][1];
        const status = data[i][10];
        const createdBy = data[i][14];

        // 🛡️ เช็คสิทธิ์ความปลอดภัย
        if (role !== ADMIN_ROLE) {
          if (String(createdBy).trim() !== String(userDisplayName).trim() && String(createdBy).trim() !== String(username).trim()) {
            return { success: false, message: "ไม่มีสิทธิ์ลบรายการของผู้อื่น" };
          }
          if (status !== "รอดำเนินการ") {
            return { success: false, message: "ไม่สามารถลบได้ เนื่องจากเจ้าหน้าที่รับเรื่องไปแล้ว" };
          }
        }

        sheet.deleteRow(i + 1);
        writeLog(username, "DELETE", "ลบคำขอ " + reqNo);
        return { success: true };
      }
    }
    return { success: false, message: "ไม่พบรายการ" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── EMAIL ────────────────────────────────────────────────────
function sendReportEmail(payload, username) {
  try {
    const subject = `[HosXP Report] ${payload.requestNo} — ${payload.reportType}`;
    const body = buildEmailBody(payload);

    const options = { name: "ระบบขอรายงาน HosXP" };
    if (payload.cc) options.cc = payload.cc;

    GmailApp.sendEmail(payload.to, subject, "", { ...options, htmlBody: body });
    writeLog(username, "EMAIL", "ส่งอีเมลคำขอ " + payload.requestNo + " ถึง " + payload.to);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function buildEmailBody(p) {
  return `
  <div style="font-family:Sarabun,sans-serif;max-width:600px;margin:auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
    <div style="background:#1a73e8;color:#fff;padding:20px 24px">
      <h2 style="margin:0;font-size:18px">🏥 ระบบขอรายงาน HosXP</h2>
      <p style="margin:4px 0 0;font-size:13px;opacity:.85">โรงพยาบาลคลองหาด — แผนก IT</p>
    </div>
    <div style="padding:24px">
      <p>เรียน ผู้รับผิดชอบ,</p>
      <p>มีคำขอรายงานใหม่เข้ามาในระบบ กรุณาตรวจสอบรายละเอียดด้านล่าง:</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold;width:40%">เลขที่คำขอ</td><td style="padding:8px 12px">${p.requestNo}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">ชื่อผู้ขอ</td><td style="padding:8px 12px">${p.requesterName}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">เบอร์โทรภายใน</td><td style="padding:8px 12px">${p.requesterPhone || "-"}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">แผนก</td><td style="padding:8px 12px">${p.department}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">ประเภทรายงาน / หัวข้อ</td><td style="padding:8px 12px">${p.reportType}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">ประเภทข้อมูลที่ต้องการ</td><td style="padding:8px 12px">${p.dataType || "-"}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">ช่วงวันที่ข้อมูล</td><td style="padding:8px 12px">${p.dateFrom} ถึง ${p.dateTo}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">คอลัมน์/Fields ที่ต้องการ</td><td style="padding:8px 12px">${p.requestedFields || "-"}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">เงื่อนไขการกรอง (Filter)</td><td style="padding:8px 12px">${p.filterCondition || "-"}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">รูปแบบไฟล์</td><td style="padding:8px 12px">${p.fileFormat || "-"}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">วันที่ต้องการรับรายงาน</td><td style="padding:8px 12px">${p.neededDate || "-"}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">วัตถุประสงค์</td><td style="padding:8px 12px">${p.purpose}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">ความเร่งด่วน</td><td style="padding:8px 12px">${p.urgency}</td></tr>
      </table>
      <div style="margin-top:20px;padding:12px 16px;background:#fff3cd;border-left:4px solid #ffc107;border-radius:4px">
        <strong>หมายเหตุ/ข้อมูลเพิ่มเติม:</strong> ${p.additionalNote || "ไม่มี"}
      </div>
      <div style="margin-top:24px;text-align:center">
        <a href="${WEB_APP_URL}" style="background:#1a73e8;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:bold">เข้าสู่ระบบเพื่อดำเนินการ</a>
      </div>
    </div>
    <div style="background:#f8f9fa;padding:12px 24px;text-align:center;font-size:12px;color:#666">
      อีเมลนี้ส่งจากระบบขอรายงาน HosXP อัตโนมัติ — กรุณาอย่าตอบกลับ
    </div>
  </div>`;
}

// ─── LINE NOTIFICATION ENGINE ────────────────────────────────
function sendLineNotification(targetId, flexContents) {
  if (!LINE_ACCESS_TOKEN || LINE_ACCESS_TOKEN.startsWith("ใส่")) return;

  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    "to": targetId,
    "messages": [{
      "type": "flex",
      "altText": "🚨 มีการอัปเดตระบบขอรายงาน HosXP",
      "contents": flexContents
    }]
  };

  const options = {
    "method": "post",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + LINE_ACCESS_TOKEN
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    writeLog("LINE_SYSTEM", "SEND_NOTIFICATION", response.getContentText());
  } catch (e) {
    writeLog("LINE_SYSTEM", "SEND_ERROR", e.message);
  }
}

// ─── TELEGRAM NOTIFICATION ENGINE ────────────────────────────
function sendTelegramNotification(chatId, message) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;

  const url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";
  const payload = {
    "chat_id": chatId,
    "text": message,
    "parse_mode": "HTML"
  };

  const options = {
    "method": "post",
    "headers": {
      "Content-Type": "application/json"
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    writeLog("TELEGRAM_SYSTEM", "SEND_NOTIFICATION", response.getContentText());
  } catch (e) {
    writeLog("TELEGRAM_SYSTEM", "SEND_ERROR", e.message);
  }
}

function testTelegramNotification(chatId) {
  try {
    if (!chatId) return { success: false, message: "กรุณาระบุ Telegram Chat ID" };
    sendTelegramNotification(chatId, "🔔 <b>ทดสอบระบบแจ้งเตือน Telegram</b>\n\nการเชื่อมต่อระหว่าง Telegram และระบบขอรายงาน HosXP สำเร็จแล้ว!");
    return { success: true, message: "ส่งข้อความทดสอบเข้า Telegram แล้ว" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── FLEX MESSAGE GENERATORS (UI DESIGN) ──────────────────────

// 1. Flex Message สำหรับคำขอใหม่
function buildNewRequestFlex(p) {
  let urgencyColor = "#2FB67E"; // ปกติ (สีเขียว)
  if (p.urgency === "สูง" || p.urgency === "เร่งด่วน") urgencyColor = "#F3B34C"; // ด่วน (สีส้ม)
  if (p.urgency === "ด่วนที่สุด" || p.urgency === "ด่วนมาก") urgencyColor = "#DE5D4E"; // ด่วนที่สุด (สีแดง)

  return {
    "type": "bubble",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        { "type": "text", "text": "📥 มีคำขอรายงาน HosXP ใหม่", "weight": "bold", "color": "#ffffff", "size": "md" },
        { "type": "text", "text": p.requestNo, "color": "#ffffffcc", "size": "xs", "margin": "xs" }
      ],
      "backgroundColor": "#1A73E8"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        { "type": "text", "text": p.reportType, "weight": "bold", "size": "lg", "wrap": true },
        {
          "type": "box", "layout": "horizontal", "margin": "md",
          "contents": [
            { "type": "text", "text": "ความเร่งด่วน", "size": "sm", "color": "#aaaaaa" },
            { "type": "text", "text": p.urgency, "size": "sm", "color": urgencyColor, "weight": "bold", "align": "end" }
          ]
        },
        { "type": "separator", "margin": "md" },
        {
          "type": "box", "layout": "vertical", "margin": "md", "spacing": "sm",
          "contents": [
            { "type": "text", "text": `👤 ผู้ขอ: ${p.requesterName} (${p.department})`, "size": "sm", "color": "#555555" },
            { "type": "text", "text": `📞 โทรภายใน: ${p.requesterPhone || "-"}`, "size": "sm", "color": "#555555" },
            { "type": "text", "text": `📅 ช่วงข้อมูล: ${p.dateFrom} ถึง ${p.dateTo}`, "size": "sm", "color": "#555555" },
            { "type": "text", "text": `📂 ประเภทข้อมูล: ${p.dataType || "-"}`, "size": "sm", "color": "#555555", "wrap": true },
            { "type": "text", "text": `💾 รูปแบบไฟล์: ${p.fileFormat || "-"}`, "size": "sm", "color": "#555555" },
            { "type": "text", "text": `🎯 วัตถุประสงค์: ${p.purpose}`, "size": "sm", "color": "#555555", "wrap": true }
          ]
        }
      ]
    },
    "footer": {
      "type": "box", "layout": "vertical",
      "contents": [
        {
          "type": "button",
          "action": { "type": "uri", "label": "เปิดดูระบบ & ดำเนินการ", "uri": WEB_APP_URL },
          "style": "primary", "color": "#1A73E8"
        }
      ]
    }
  };
}

// 2. Flex Message สำหรับอัปเดตสถานะงาน
function buildStatusUpdateFlex(requestNo, reportType, status, adminNote) {
  let statusColor = "#F3B34C"; // รอดำเนินการ (ส้ม)
  if (status === "กำลังดำเนินการ") statusColor = "#1A73E8"; // ฟ้า
  if (status === "เสร็จสิ้น") statusColor = "#2FB67E"; // เขียว
  if (status === "ปฏิเสธ") statusColor = "#DE5D4E"; // แดง

  return {
    "type": "bubble",
    "header": {
      "type": "box", "layout": "vertical",
      "contents": [
        { "type": "text", "text": "🔄 อัปเดตสถานะคำขอ", "weight": "bold", "color": "#ffffff", "size": "md" },
        { "type": "text", "text": requestNo, "color": "#ffffffcc", "size": "xs", "margin": "xs" }
      ],
      "backgroundColor": statusColor
    },
    "body": {
      "type": "box", "layout": "vertical",
      "contents": [
        { "type": "text", "text": reportType, "weight": "bold", "size": "md", "wrap": true },
        {
          "type": "box", "layout": "horizontal", "margin": "md",
          "contents": [
            { "type": "text", "text": "สถานะล่าสุด", "size": "sm", "color": "#aaaaaa" },
            { "type": "text", "text": status, "size": "sm", "color": statusColor, "weight": "bold", "align": "end" }
          ]
        },
        { "type": "separator", "margin": "md" },
        {
          "type": "box", "layout": "vertical", "margin": "md",
          "contents": [
            { "type": "text", "text": "📝 หมายเหตุจาก Admin / ไอที:", "size": "xs", "color": "#aaaaaa", "weight": "bold" },
            { "type": "text", "text": adminNote || "ไม่มีหมายเหตุเพิ่มเติม", "size": "sm", "color": "#333333", "margin": "xs", "wrap": true }
          ]
        }
      ]
    },
    "footer": {
      "type": "box", "layout": "vertical",
      "contents": [
        {
          "type": "button",
          "action": { "type": "uri", "label": "ตรวจสอบข้อมูลในระบบ", "uri": WEB_APP_URL },
          "style": "secondary"
        }
      ]
    }
  };
}

// ─── DASHBOARD STATS ─────────────────────────────────────────
function getDashboardStats(username, role, displayName) {
  try {
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();

    const parseData = (val) => (val instanceof Date) ? val.toISOString() : val;

    let rows = data.slice(1).map(row => ({
      id: parseData(row[0]),
      requestNo: parseData(row[1]),
      requesterName: parseData(row[2]),
      reportType: parseData(row[5]),
      status: (row[10] || "").toString().trim(),
      createdAt: parseData(row[12]),
      createdBy: (row[14] || "").toString().trim()
    }));

    if (role !== ADMIN_ROLE) {
      rows = rows.filter(r => r.createdBy === displayName || r.createdBy === username);
    }

    const stats = {
      total: rows.length,
      pending: rows.filter(r => r.status === "รอดำเนินการ").length,
      processing: rows.filter(r => r.status === "กำลังดำเนินการ").length,
      completed: rows.filter(r => r.status === "เสร็จสิ้น").length,
      rejected: rows.filter(r => r.status === "ปฏิเสธ").length,
      recent: rows.slice(-10).reverse() // ดึงมา 10 รายการเพื่อให้สามารถกรองในหน้าแดชบอร์ดได้ยืดหยุ่นขึ้น
    };
    return { success: true, data: stats };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── UTILITIES ───────────────────────────────────────────────
function generateRequestNo() {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const sheet = getSheet(SHEET_NAME_REQUESTS);
  const count = Math.max(sheet.getLastRow(), 1);
  const seq = String(count).padStart(4, "0");
  return `REQ${y}${m}${d}-${seq}`;
}

function writeLog(username, action, detail) {
  try {
    const sheet = getSheet(SHEET_NAME_LOGS);
    sheet.appendRow([new Date().toISOString(), username, action, detail]);
  } catch (_) { }
}

function getMonthlyReport(month, year) {
  try {
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();

    const headers = data[0].map(h => h.toString().trim());
    const parseData = (val) => (val instanceof Date) ? val.toISOString() : val;

    const result = data.slice(1).filter(row => {
      const d = new Date(row[12]);
      if (isNaN(d.getTime())) return false;

      return (d.getMonth() + 1).toString() === month.toString() && d.getFullYear().toString() === year.toString();
    }).map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = parseData(row[i]));
      return obj;
    });

    return { success: true, data: result };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── PROFILE MANAGEMENT API ───────────────────────────────────
function updateProfile(username, payload) {
  try {
    const sheet = getSheet(SHEET_NAME_USERS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().trim() === username.toString().trim()) {
        const row = i + 1;

        // อัปเดตข้อมูลทีละฟิลด์ตามที่มีส่งมา
        if (payload.password) sheet.getRange(row, 2).setValue(payload.password);
        if (payload.displayName) sheet.getRange(row, 3).setValue(payload.displayName);
        if (payload.email) sheet.getRange(row, 4).setValue(payload.email);
        if (payload.department) sheet.getRange(row, 6).setValue(payload.department);

        sheet.getRange(row, 7).setValue(payload.lineId ? payload.lineId.trim() : "");
        sheet.getRange(row, 8).setValue(payload.telegramId ? payload.telegramId.trim() : "");

        writeLog(username, "PROFILE_UPDATE", "อัปเดตข้อมูลส่วนตัวและช่องทางการแจ้งเตือน");
        return { success: true };
      }
    }
    return { success: false, message: "ไม่พบผู้ใช้ที่ต้องการแก้ไข" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── GEMINI AI REQUEST ANALYZER ──────────────────────────────
/**
 * วิเคราะห์ความต้องการคำขอรายงานข้อมูลและแนะนำตรรกะ SQL (HOSxP MySQL) ผ่าน AI พร้อมระบบ Fallback
 */
function askGeminiToAnalyzeRequest(requestId) {
  try {
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();
    let row = null;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === requestId) {
        row = data[i];
        break;
      }
    }

    if (!row) return { success: false, message: "ไม่พบข้อมูลคำขอรายงานในระบบ" };

    const userPrompt = `กรุณาวิเคราะห์คำขอรายงานข้อมูลโรงพยาบาล HOSxP ต่อไปนี้:\n` +
      `- **เลขที่คำขอ**: ${row[1]}\n` +
      `- **ชื่อรายงาน**: ${row[5]}\n` +
      `- **แผนกผู้ขอ**: ${row[4]}\n` +
      `- **ประเภทข้อมูล**: ${row[16] || ""}\n` +
      `- **วัตถุประสงค์**: ${row[8]}\n` +
      `- **คอลัมน์/ข้อมูลที่ต้องการ**: ${row[17] || ""}\n` +
      `- **เงื่อนไขตัวกรอง (Filter)**: ${row[18] || ""}\n` +
      `- **ช่วงเวลาข้อมูล**: ${row[6] ? new Date(row[6]).toLocaleDateString("th-TH") : "-"} ถึง ${row[7] ? new Date(row[7]).toLocaleDateString("th-TH") : "-"}\n` +
      `- **รูปแบบไฟล์**: ${row[19] || ""}\n` +
      `- **หมายเหตุเพิ่มเติม**: ${row[21] || ""}`;

    const systemInstruction = `คุณคือผู้เชี่ยวชาญด้านคลังข้อมูลสุขภาพและฐานข้อมูล HosXP (MySQL/MariaDB) และนักวิเคราะห์ข้อมูลโรงพยาบาลอาวุโส (Senior Medical Information Officer)
หน้าที่ของคุณคือรับข้อมูลคำขอรายงานจากผู้ใช้ แล้วทำการวิเคราะห์โครงสร้างข้อมูลและสร้างคำสั่ง SQL สำหรับฐานข้อมูล HosXP

กรุณาวิเคราะห์และจัดทำข้อเสนอรายงานเป็นภาษาไทย โดยแบ่งออกเป็นหัวข้อดังนี้:
1. ชื่อรายงานและวัตถุประสงค์ (Report Name & Objective): สรุปประเภทรายงานและวัตถุประสงค์สั้นๆ
2. ข้อมูลที่ต้องแสดงในรายงาน (Output Columns): ตารางแสดงลำดับ, ชื่อคอลัมน์ภาษาไทย, ฟิล์ดและตารางอ้างอิง, และหมายเหตุ
3. เงื่อนไขและตัวกรอง (Filters & Criteria): เงื่อนไขในการดึงข้อมูลตามคำขอ
4. ตารางหลักของ HosXP ที่เกี่ยวข้อง (Related HosXP Tables): รายชื่อตารางที่ต้องใช้
5. ร่างคำสั่ง SQL (Draft SQL Query): เขียนคำสั่ง MySQL ที่ถูกต้อง มีประสิทธิภาพ และพร้อมใช้งาน (ครอบโค้ดด้วย \`\`\`sql ... \`\`\`)
6. ข้อแนะนำและข้อจำกัดทางเทคนิค (Suggestions & Technical Notes)

### โครงสร้างตาราง HosXP สำหรับอ้างอิง (Database Schema Context):
- patient: ข้อมูลทั่วไปผู้ป่วย (hn, fname, lname, sex, birthday, cid)
- ovst: การมารับบริการ OPD (vn, hn, vstdate, vsttime, spclty, pttype, main_dep)
- vn_stat: สถิติบริการ OPD หลัก (vn, hn, vstdate, pdx, dx0, dx1, dx2, dx3, sex, age_y, pttype, income, uc_money)
- ovstdiag: การวินิจฉัยโรค OPD (ovst_diag_id, vn, hn, icd10, diagtype) -> diagtype: 1=Primary, 2=Secondary, 3=Co-morbid, 4=Complication
- ipt: การนอนโรงพยาบาล IPD (an, hn, regdate, regtime, dchdate, dchtime, ward, spclty, pttype)
- an_stat: สถิติบริการ IPD หลัก (an, hn, regdate, dchdate, pdx, sex, age_y, pttype)
- iptdiag: การวินิจฉัยโรค IPD (ipt_diag_id, an, hn, icd10, diagtype)
- opitemrece: รายการค่ารักษา/ยา/เวชภัณฑ์ (vn, an, hn, rxdate, icode, qty, sum_price)
- drugitems: รายการยา (icode, name, strength, units)
- nondrugitems: รายการเวชภัณฑ์/ค่าบริการที่ไม่ใช่ยา (icode, name)
- pttype: สิทธิ์การรักษา (pttype, name)
- doctor: รายชื่อแพทย์ (code, name)
- ward: หอผู้ป่วย (ward, name)
- spclty: แผนก/สาขาเฉพาะทาง (spclty, name)
- icd101: รหัสและชื่อโรค ICD-10 (code, name)

### กฎเกณฑ์การเขียน SQL สำหรับ HosXP:
1. การ Join ข้อมูลการเงิน/ยา (opitemrece):
   - ผู้ป่วยนอก (OPD): เชื่อม opitemrece กับตารางบริการด้วย vn เสมอ (เช่น ON o.vn = r.vn)
   - ผู้ป่วยใน (IPD): เชื่อม opitemrece กับตารางบริการด้วย an เสมอ (เช่น ON i.an = r.an)
2. การวินิจฉัยโรค (Diagnosis):
   - หากผู้ใช้ระบุว่าต้องการคนไข้ที่ได้รับการวินิจฉัยโรคหลัก (Primary Diagnosis) ให้ใช้ฟิลด์ pdx ใน vn_stat หรือ an_stat
   - หากต้องการคนไข้ที่ได้รับการวินิจฉัยโรคนั้นๆ ไม่ว่าจะเป็นโรคหลักหรือโรครอง ให้ทำการ JOIN ตาราง ovstdiag (OPD) หรือ iptdiag (IPD) แล้วคัดกรองที่ icd10
3. การคัดกรองวันที่:
   - ให้ใช้รูปแบบมาตรฐานของระบบรายงานทั่วไป โดยใช้ Placeholder คือ :start_date และ :end_date ในฟังก์ชันเปรียบเทียบ เช่น vstdate BETWEEN :start_date AND :end_date หรือ regdate BETWEEN :start_date AND :end_date
4. ความคุ้มค่าของการดึงข้อมูล (Performance):
   - หลีกเลี่ยง SELECT * ให้ระบุคอลัมน์ให้ชัดเจน
   - เมื่อต้องการดึงชื่อสิทธิ์ หรือชื่อแพทย์ ให้ทำ LEFT JOIN กับตาราง pttype หรือ doctor
5. ความปลอดภัย: หากข้อมูลในคำขอไม่ชัดเจน ให้เขียน SQL ที่ปลอดภัยและสมเหตุสมผลที่สุด พร้อมคอมเมนต์บอกข้อจำกัดไว้ในโค้ด`;

    const aiResult = getAIResponseWithFallback(userPrompt, systemInstruction);
    if (!aiResult.success) return aiResult;

    return { success: true, analysis: aiResult.text };
  } catch (e) {
    return { success: false, message: "เกิดข้อผิดพลาดของระบบ: " + e.message };
  }
}

/**
 * คุยกับ Chatbot แบบโต้ตอบผ่าน AI พร้อมระบบ Fallback
 */
function askGeminiChat(history, role) {
  try {
    let systemInstruction = "";
    if (role === ADMIN_ROLE) {
      systemInstruction = `คุณคือ AI ผู้ช่วยอัจฉริยะสำหรับ IT ในการวิเคราะห์ตารางและเขียน SQL HOSxP (MySQL/MariaDB)
ทุกครั้งที่ให้ SQL ต้องครอบด้วย markdown code block (\`\`\`sql ... \`\`\`) และอธิบายเหตุผลสั้นๆ

### ตาราง HosXP สำหรับเชื่อมโยง (Database Schema Context):
- patient: hn, fname, lname, sex, birthday, cid
- ovst: vn, hn, vstdate, vsttime, spclty, pttype, main_dep
- vn_stat: vn, hn, pdx, dx0, dx1, dx2, dx3, age_y, pttype, uc_money
- ovstdiag: vn, hn, icd10, diagtype (1=Primary, 2=Secondary)
- ipt: an, hn, regdate, dchdate, ward, spclty, pttype
- an_stat: an, hn, pdx, age_y, pttype
- iptdiag: an, hn, icd10, diagtype
- opitemrece: vn, an, hn, rxdate, icode, qty, sum_price
- drugitems: icode, name, strength, units
- nondrugitems: icode, name
- pttype: pttype, name
- doctor: code, name
- ward: ward, name
- spclty: spclty, name
- icd101: code, name

### กฎสำคัญ:
1. ดึงสิทธิ์คนไข้ หรือตึก ให้ LEFT JOIN ตาราง pttype หรือ ward เสมอ
2. เชื่อมโยงธุรกรรมการเงิน/ยา (opitemrece) ของผู้ป่วยนอก (OPD) ใช้ vn ส่วนผู้ป่วยใน (IPD) ใช้ an เสมอ เพื่อป้องกันข้อมูลซ้ำซ้อน
3. การกรองวันที่ ให้ระบุ Placeholder เป็น :start_date และ :end_date เพื่อความยืดหยุ่นในการดึงรายงาน`;
    } else {
      systemInstruction = "คุณคือ AI ผู้ช่วยอัจฉริยะสำหรับบุคลากรทางการแพทย์ในระบบขอรายงาน HosXP\n" +
        "ห้ามแสดง SQL หรือชื่อตารางเชิงเทคนิคให้ผู้ใช้เห็นเด็ดขาด ให้แนะนำวิธีอธิบายรายงานที่ดีและแนะนำการกรอกแบบฟอร์มขอรายงานแทน";
    }

    const lastMessage = history.pop().text;
    const aiResult = getAIResponseWithFallback(lastMessage, systemInstruction, history);
    
    if (!aiResult.success) return aiResult;
    return { success: true, response: aiResult.text };
  } catch (e) {
    return { success: false, message: "เกิดข้อผิดพลาดในการประมวลผลแชท: " + e.message };
  }
}