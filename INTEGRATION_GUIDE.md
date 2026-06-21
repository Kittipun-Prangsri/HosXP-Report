# คู่มือการติดตั้งและใช้งาน HosXP Report Telegram Bot

บอทนี้จะช่วยรับคำขอรายงาน HosXP (ผ่านข้อความหรือรูปภาพตาราง/Mockup) แล้วส่งประมวลผลผ่าน Gemini API พร้อมสร้างร่างตารางและคำสั่ง SQL (MySQL)

---

## 1. วิธีแก้ไขเมื่อเจอข้อผิดพลาด `.venv/bin/python: No such file or directory`

เนื่องจากโฟลเดอร์นี้ถูกซิงค์ผ่าน Google Drive ค่าลิงก์เชื่อมโยง (Symlinks) ของ Python ในโฟลเดอร์ `.venv` เก่าอาจจะเสียหรือชี้ไปยังตําแหน่งเครื่องอื่น

ให้คุณแก้ปัญหาโดยการลบโฟลเดอร์ `.venv` เดิมทิ้งแล้วสร้างใหม่ตามวิธีด้านล่างนี้:

### ขั้นตอนใน Terminal (ในโฟลเดอร์ ระบบขอรายงาน HosXP V.2):
```bash
# 1. ลบโฟลเดอร์สภาพแวดล้อมเสมือนอันเดิมที่พังออก
rm -rf .venv

# 2. สร้างสภาพแวดล้อมเสมือนอันใหม่สำหรับเครื่องนี้
python3 -m venv .venv

# 3. ติดตั้งไลบรารีที่ระบุไว้ใน requirements.txt
.venv/bin/pip install -r requirements.txt
```

---

## 2. วิธีสั่งรันบอท (Running the Bot)

หลังจากเตรียมสภาพแวดล้อมเสร็จเรียบร้อยแล้ว ให้กรอก Token และสั่งรันดังนี้:

```bash
# 1. ตั้งค่า API Keys
export TELEGRAM_BOT_TOKEN="รหัส_TOKEN_จาก_BotFather"
export GEMINI_API_KEY="รหัส_API_KEY_จาก_Google_AI_Studio"

# 2. สั่งรันสคริปต์บอท
.venv/bin/python telegram_hosxp_bot.py
```
