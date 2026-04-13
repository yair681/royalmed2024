'use strict';
const { DatabaseSync } = require('node:sqlite');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = process.env.ROYAL_MED_APP_DIR
  ? path.join(process.env.ROYAL_MED_APP_DIR, 'data')
  : path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'royal_med.db');

let _db;
function getDb() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    _db.exec('PRAGMA journal_mode=WAL');
  }
  return _db;
}

const DEFAULT_BOT_PROMPT = `אתה נציג שירות של מרפאת רויאל-מד לאסתטיקה. אתה מקבל פניות מלקוחות דרך וואטסאפ.

מטרתך:
1. לברך את הלקוח בחמימות ולהבין מה מעניין אותו
2. לאסוף בטבעיות (שאלה אחת בכל פעם): שם מלא, גיל, טיפול מבוקש
3. כאשר יש לך שם + טיפול — הפעל את הפונקציה register_lead
4. לאחר רישום — המשך לשיחת מכירה

כללים: עברית בלבד, תשובות קצרות, חם ומקצועי`;

function initDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employee',
      password_hash TEXT NOT NULL,
      email TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      birth_year INTEGER,
      skin_type TEXT,
      problems TEXT,
      health_insurance TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS consultations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER,
      patient_name TEXT,
      consultation_type TEXT NOT NULL,
      image_path TEXT,
      additional_info TEXT,
      ai_result TEXT,
      treatment_id TEXT,
      treatment_name TEXT,
      model_used TEXT,
      tokens_used INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS visualizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER,
      patient_name TEXT,
      before_image_path TEXT,
      after_image_path TEXT,
      after_image_url TEXT,
      treatment_id TEXT,
      treatment_name TEXT,
      prompt_used TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      patient_id INTEGER,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model_used TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS custom_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT DEFAULT '🤖',
      system_prompt TEXT NOT NULL,
      knowledge TEXT DEFAULT '',
      model TEXT DEFAULT 'gpt-4o',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      patient_id INTEGER,
      patient_name TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES custom_agents(id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      age INTEGER,
      gender TEXT,
      treatment_interest TEXT,
      description TEXT,
      status TEXT DEFAULT 'חדש',
      source TEXT DEFAULT 'ידני',
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bot_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled INTEGER DEFAULT 0,
      system_prompt TEXT DEFAULT '',
      model TEXT DEFAULT 'gpt-4o-mini',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whatsapp_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      display_name TEXT DEFAULT '',
      messages TEXT DEFAULT '[]',
      lead_created INTEGER DEFAULT 0,
      lead_id INTEGER,
      last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // bot_settings seed
  db.prepare(`INSERT OR IGNORE INTO bot_settings (id, enabled, system_prompt, model) VALUES (1, 0, ?, 'gpt-4o-mini')`).run(DEFAULT_BOT_PROMPT);

  // admin seed
  const admin = db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).get();
  if (!admin) {
    const pwd = process.env.SYSTEM_PASSWORD || 'royalmed2024';
    const hash = bcrypt.hashSync(pwd, 10);
    db.prepare(`INSERT INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?)`).run('admin', 'מנהל מערכת', 'admin', hash);
    console.log('[DB] admin created');
  }

  console.log('[DB] Database ready:', DB_PATH);
}

// ── Users ──
const getUser = (username) => getDb().prepare(`SELECT * FROM users WHERE username=? AND active=1`).get(username);
const getAllUsers = () => getDb().prepare(`SELECT id,username,full_name,role,active,created_at FROM users ORDER BY role DESC, created_at ASC`).all();
const createUser = (username, fullName, password, role = 'employee', email = '') => {
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = getDb().prepare(`INSERT INTO users (username,full_name,role,password_hash,email) VALUES (?,?,?,?,?)`).run(username.trim(), fullName.trim(), role, hash, email.trim());
    return [r.lastInsertRowid, null];
  } catch(e) { return [null, e.message]; }
};
const deleteUser = (id) => getDb().prepare(`DELETE FROM users WHERE id=? AND role!='admin'`).run(id);
const toggleUser = (id) => getDb().prepare(`UPDATE users SET active=1-active WHERE id=? AND role!='admin'`).run(id);

// ── Patients ──
const getAllPatients = () => getDb().prepare(`SELECT * FROM patients ORDER BY created_at DESC`).all();
const getPatient = (id) => getDb().prepare(`SELECT * FROM patients WHERE id=?`).get(id);
const searchPatients = (q) => getDb().prepare(`SELECT * FROM patients WHERE name LIKE ? OR phone LIKE ? ORDER BY name`).all(`%${q}%`, `%${q}%`);
const createPatient = (data) => {
  const r = getDb().prepare(`INSERT INTO patients (name,phone,birth_year,skin_type,problems,health_insurance,notes) VALUES (?,?,?,?,?,?,?)`).run(data.name, data.phone||'', data.birth_year||null, data.skin_type||'', data.problems||'', data.health_insurance||'', data.notes||'');
  return r.lastInsertRowid;
};
const updatePatient = (id, data) => getDb().prepare(`UPDATE patients SET name=?,phone=?,birth_year=?,skin_type=?,problems=?,health_insurance=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(data.name, data.phone||'', data.birth_year||null, data.skin_type||'', data.problems||'', data.health_insurance||'', data.notes||'', id);
const deletePatient = (id) => {
  const db = getDb();
  db.prepare(`DELETE FROM consultations WHERE patient_id=?`).run(id);
  db.prepare(`DELETE FROM visualizations WHERE patient_id=?`).run(id);
  db.prepare(`DELETE FROM patients WHERE id=?`).run(id);
};

// ── Consultations ──
const saveConsultation = (data) => {
  const r = getDb().prepare(`INSERT INTO consultations (patient_id,patient_name,consultation_type,image_path,additional_info,ai_result,treatment_id,treatment_name,model_used,tokens_used) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(data.patient_id||null, data.patient_name||'', data.consultation_type||'diagnosis', data.image_path||'', data.additional_info||'', data.ai_result||'', data.treatment_id||'', data.treatment_name||'', data.model_used||'', data.tokens_used||0);
  return r.lastInsertRowid;
};
const getConsultation = (id) => getDb().prepare(`SELECT * FROM consultations WHERE id=?`).get(id);
const getPatientConsultations = (patientId) => getDb().prepare(`SELECT * FROM consultations WHERE patient_id=? ORDER BY created_at DESC`).all(patientId);
const getRecentConsultations = (limit = 20) => getDb().prepare(`SELECT * FROM consultations ORDER BY created_at DESC LIMIT ?`).all(limit);

// ── Visualizations ──
const saveVisualization = (data) => {
  const r = getDb().prepare(`INSERT INTO visualizations (patient_id,patient_name,before_image_path,after_image_path,after_image_url,treatment_id,treatment_name,prompt_used) VALUES (?,?,?,?,?,?,?,?)`).run(data.patient_id||null, data.patient_name||'', data.before_image_path||'', data.after_image_path||'', data.after_image_url||'', data.treatment_id||'', data.treatment_name||'', data.prompt_used||'');
  return r.lastInsertRowid;
};
const getPatientVisualizations = (patientId) => getDb().prepare(`SELECT * FROM visualizations WHERE patient_id=? ORDER BY created_at DESC`).all(patientId);

// ── Chat ──
const saveChatMessage = (sessionId, role, content, patientId = null, modelUsed = '') => getDb().prepare(`INSERT INTO chat_history (session_id,patient_id,role,content,model_used) VALUES (?,?,?,?,?)`).run(sessionId, patientId, role, content, modelUsed);
const getChatHistory = (sessionId, limit = 50) => getDb().prepare(`SELECT * FROM chat_history WHERE session_id=? ORDER BY created_at ASC LIMIT ?`).all(sessionId, limit);

// ── Agents ──
const getAllAgents = () => getDb().prepare(`SELECT * FROM custom_agents ORDER BY created_at DESC`).all();
const getAgent = (id) => getDb().prepare(`SELECT * FROM custom_agents WHERE id=?`).get(id);
const createAgent = (data) => {
  const r = getDb().prepare(`INSERT INTO custom_agents (name,description,icon,system_prompt,knowledge,model) VALUES (?,?,?,?,?,?)`).run(data.name, data.description||'', data.icon||'🤖', data.system_prompt, data.knowledge||'', data.model||'gpt-4o');
  return r.lastInsertRowid;
};
const updateAgent = (id, data) => getDb().prepare(`UPDATE custom_agents SET name=?,description=?,icon=?,system_prompt=?,knowledge=?,model=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(data.name, data.description||'', data.icon||'🤖', data.system_prompt, data.knowledge||'', data.model||'gpt-4o', data.active !== undefined ? data.active : 1, id);
const deleteAgent = (id) => {
  getDb().prepare(`DELETE FROM agent_conversations WHERE agent_id=?`).run(id);
  getDb().prepare(`DELETE FROM custom_agents WHERE id=?`).run(id);
};
const saveAgentMessage = (agentId, sessionId, role, content, patientId = null, patientName = '') => getDb().prepare(`INSERT INTO agent_conversations (agent_id,session_id,patient_id,patient_name,role,content) VALUES (?,?,?,?,?,?)`).run(agentId, sessionId, patientId, patientName, role, content);
const getAgentConversation = (agentId, sessionId, limit = 30) => getDb().prepare(`SELECT * FROM agent_conversations WHERE agent_id=? AND session_id=? ORDER BY created_at ASC LIMIT ?`).all(agentId, sessionId, limit);

// ── Leads ──
const getAllLeads = (status) => status ? getDb().prepare(`SELECT * FROM leads WHERE status=? ORDER BY created_at DESC`).all(status) : getDb().prepare(`SELECT * FROM leads ORDER BY created_at DESC`).all();
const getLead = (id) => getDb().prepare(`SELECT * FROM leads WHERE id=?`).get(id);
const createLead = (data) => {
  const r = getDb().prepare(`INSERT INTO leads (full_name,phone,email,age,gender,treatment_interest,description,status,source,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(data.full_name, data.phone||'', data.email||'', data.age||null, data.gender||'', data.treatment_interest||'', data.description||'', data.status||'חדש', data.source||'ידני', data.notes||'');
  return r.lastInsertRowid;
};
const updateLead = (id, fields) => {
  fields.updated_at = new Date().toISOString().slice(0,19).replace('T',' ');
  const keys = Object.keys(fields);
  const sql = `UPDATE leads SET ${keys.map(k => k+'=?').join(',')} WHERE id=?`;
  getDb().prepare(sql).run(...Object.values(fields), id);
};
const deleteLead = (id) => getDb().prepare(`DELETE FROM leads WHERE id=?`).run(id);

// ── Bot / WhatsApp ──
const getBotSettings = () => getDb().prepare(`SELECT * FROM bot_settings WHERE id=1`).get() || { enabled: 0, system_prompt: DEFAULT_BOT_PROMPT, model: 'gpt-4o-mini' };
const saveBotSettings = (enabled, systemPrompt, model) => getDb().prepare(`UPDATE bot_settings SET enabled=?,system_prompt=?,model=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(enabled, systemPrompt, model);
const getAllWaConversations = () => getDb().prepare(`SELECT * FROM whatsapp_conversations ORDER BY last_message_at DESC`).all();
const getWaConversation = (phone) => getDb().prepare(`SELECT * FROM whatsapp_conversations WHERE phone=?`).get(phone);
const getOrCreateWaConversation = (phone, displayName = '') => {
  const db = getDb();
  let row = db.prepare(`SELECT * FROM whatsapp_conversations WHERE phone=?`).get(phone);
  if (!row) {
    db.prepare(`INSERT INTO whatsapp_conversations (phone,display_name) VALUES (?,?)`).run(phone, displayName);
    row = db.prepare(`SELECT * FROM whatsapp_conversations WHERE phone=?`).get(phone);
  }
  return row;
};
const updateWaConversation = (phone, messages, leadCreated, leadId) => {
  const msgsJson = JSON.stringify(messages);
  if (leadCreated !== undefined) {
    getDb().prepare(`UPDATE whatsapp_conversations SET messages=?,lead_created=?,lead_id=?,last_message_at=CURRENT_TIMESTAMP WHERE phone=?`).run(msgsJson, leadCreated, leadId, phone);
  } else {
    getDb().prepare(`UPDATE whatsapp_conversations SET messages=?,last_message_at=CURRENT_TIMESTAMP WHERE phone=?`).run(msgsJson, phone);
  }
};

// ── Activity ──
const logActivity = (username, action, details = '', ipAddress = '', userId = null) => getDb().prepare(`INSERT INTO activity_log (user_id,username,action,details,ip_address) VALUES (?,?,?,?,?)`).run(userId, username, action, details, ipAddress);
const getActivityLog = (limit = 100) => getDb().prepare(`SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?`).all(limit);

// ── Stats ──
const getStats = () => {
  const db = getDb();
  return {
    total_patients: db.prepare(`SELECT COUNT(*) as n FROM patients`).get().n,
    total_diagnoses: db.prepare(`SELECT COUNT(*) as n FROM consultations WHERE consultation_type='diagnosis'`).get().n,
    total_visualizations: db.prepare(`SELECT COUNT(*) as n FROM visualizations`).get().n,
    today_consultations: db.prepare(`SELECT COUNT(*) as n FROM consultations WHERE DATE(created_at)=DATE('now')`).get().n,
  };
};

module.exports = {
  initDatabase, getUser, getAllUsers, createUser, deleteUser, toggleUser,
  getAllPatients, getPatient, searchPatients, createPatient, updatePatient, deletePatient,
  saveConsultation, getConsultation, getPatientConsultations, getRecentConsultations,
  saveVisualization, getPatientVisualizations,
  saveChatMessage, getChatHistory,
  getAllAgents, getAgent, createAgent, updateAgent, deleteAgent, saveAgentMessage, getAgentConversation,
  getAllLeads, getLead, createLead, updateLead, deleteLead,
  getBotSettings, saveBotSettings, getAllWaConversations, getWaConversation, getOrCreateWaConversation, updateWaConversation,
  logActivity, getActivityLog, getStats, DATA_DIR,
};
