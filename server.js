'use strict';
require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const flash        = require('connect-flash');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const { v4: uuid } = require('uuid');
const bcrypt       = require('bcryptjs');
const { OpenAI }   = require('openai');

const db = require('./db');

// ─── Setup ───────────────────────────────────────────
const APP_DIR  = process.env.ROYAL_MED_APP_DIR || __dirname;
const BASE_DIR = process.env.ROYAL_MED_BASE    || __dirname;

const UPLOAD_DIR = path.join(APP_DIR, 'static', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

db.initDatabase();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(BASE_DIR, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(BASE_DIR, 'static')));
app.use('/static/uploads', express.static(UPLOAD_DIR));

app.use(session({
  secret: process.env.SECRET_KEY || 'royal-med-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(flash());

// Pass flash + session to all views
app.use((req, res, next) => {
  res.locals.session  = req.session;
  res.locals.flashes  = req.flash();
  res.locals.endpoint = req.path;
  next();
});

// ─── Multer ──────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, uuid() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

// ─── Auth Middleware ──────────────────────────────────
function loginRequired(req, res, next) {
  if (req.session.logged_in) return next();
  res.redirect('/login');
}

// ─── OpenAI ──────────────────────────────────────────
function getOpenAI() {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) throw new Error('OpenAI API Key לא מוגדר — בדוק קובץ .env');
  return new OpenAI({ apiKey: key });
}

// ─── Treatments ──────────────────────────────────────
function getTreatmentsPath() {
  const p1 = path.join(APP_DIR,  'data', 'treatments.json');
  const p2 = path.join(BASE_DIR, 'data', 'treatments.json');
  return fs.existsSync(p1) ? p1 : p2;
}

function loadTreatmentsList() {
  const data = JSON.parse(fs.readFileSync(getTreatmentsPath(), 'utf8'));
  const lines = [];
  for (const cat of data.categories) {
    lines.push(`\n## ${cat.name}`);
    for (const t of cat.treatments) {
      if (t.active !== false) {
        lines.push(`  • ${t.name}: ${t.description}`);
        lines.push(`    התוויות: ${(t.indications || []).join(', ')}`);
      }
    }
  }
  return lines.join('\n');
}

// ─── AI: Diagnosis ────────────────────────────────────
async function runDiagnosisAgent(imagePath, additionalInfo = '') {
  const client = getOpenAI();
  const treatments = loadTreatmentsList();

  const systemPrompt = `אתה מומחה לרפואה אסתטית ודרמטולוגיה. תפקידך לנתח תמונות עור ולספק פענוח קליני מקצועי בעברית.`;
  const userPrompt = `נתח את תמונת העור הזו וספק:
1. **ממצאים קליניים** — תאר מה אתה רואה
2. **אבחנה מוצעת** — הערכה קלינית
3. **המלצות טיפול** — מתוך הרשימה הבאה בלבד:
${treatments}
4. **הערות** — מידע נוסף

${additionalInfo ? `מידע נוסף מהצוות: ${additionalInfo}` : ''}

ענה בעברית מקצועית.`;

  const imageB64 = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  const mime = mimeMap[ext] || 'image/jpeg';

  let response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'text', text: userPrompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${imageB64}`, detail: 'low' } },
      ]},
    ],
    max_tokens: 4000,
    temperature: 0.3,
  });

  let content = response.choices[0].message.content;
  if (!content || !content.trim()) {
    response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageB64}`, detail: 'low' } },
        ]},
      ],
      max_tokens: 2000,
      temperature: 0.3,
    });
    content = response.choices[0].message.content;
  }

  return { content, tokens: response.usage?.total_tokens || 0 };
}

async function runDiagnosisManual(findings) {
  const client = getOpenAI();
  const treatments = loadTreatmentsList();
  const prompt = `בהתבסס על הממצאים הקליניים הבאים, ספק פענוח והמלצת טיפול:

${findings}

טיפולים זמינים:
${treatments}

ענה בעברית מקצועית עם: ממצאים, אבחנה, המלצות טיפול.`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2000,
    temperature: 0.3,
  });
  return response.choices[0].message.content || '';
}

// ─── AI: Custom Agent ─────────────────────────────────
async function runCustomAgent(agent, message, history) {
  const client = getOpenAI();
  const model  = agent.model || 'gpt-4o';

  let fullSystem = agent.system_prompt || '';
  if (agent.knowledge) fullSystem += `\n\n--- ידע ובסיס מידע ---\n${agent.knowledge}`;
  fullSystem += '\n\nתמיד השב בעברית בצורה מקצועית וברורה. היצמד להוראות שקיבלת בלבד.';

  const messages = [{ role: 'system', content: fullSystem }];
  for (const h of history.slice(-16)) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: message });

  let content = null;
  try {
    const resp = await client.chat.completions.create({ model, messages, max_tokens: 4000, temperature: 0.3 });
    content = resp.choices[0].message.content;
  } catch (e) {
    console.error('[AGENT] primary error:', e.message);
  }

  if (!content || !content.trim()) {
    const resp2 = await client.chat.completions.create({ model: 'gpt-4o-mini', messages, max_tokens: 1500, temperature: 0.3 });
    content = resp2.choices[0].message.content;
  }
  return content;
}

// ─── AI: Chat ─────────────────────────────────────────
async function runChat(message, history) {
  const client = getOpenAI();
  const system = `אתה עוזר AI מקצועי של מרפאת רויאל-מד לאסתטיקה רפואית.
ענה בעברית, בצורה מקצועית, קצרה וברורה. התמחה ברפואה אסתטית, דרמטולוגיה ואסתטיקה.`;

  const messages = [{ role: 'system', content: system }];
  for (const h of history.slice(-10)) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: message });

  const resp = await client.chat.completions.create({ model: 'gpt-4o', messages, max_tokens: 1000, temperature: 0.7 });
  return resp.choices[0].message.content || '';
}

// ─── Health ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.send('OK');
});

// ─── Auth ─────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.logged_in) return res.redirect('/dashboard');
  res.render('login', { error: req.flash('error')[0] || null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.getUser(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.flash('error', 'שם משתמש או סיסמה שגויים');
    return res.redirect('/login');
  }
  req.session.logged_in  = true;
  req.session.user_id    = user.id;
  req.session.username   = user.username;
  req.session.full_name  = user.full_name;
  req.session.role       = user.role;
  db.logActivity(user.username, 'login', '', req.ip, user.id);
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/', (req, res) => res.redirect('/dashboard'));

// ─── Dashboard ────────────────────────────────────────
app.get('/dashboard', loginRequired, (req, res) => {
  const stats  = db.getStats();
  const recent = db.getRecentConsultations(10);
  res.render('dashboard', { stats, recent });
});

// ─── Patients ─────────────────────────────────────────
app.get('/patients', loginRequired, (req, res) => {
  const q = req.query.q || '';
  const patients = q ? db.searchPatients(q) : db.getAllPatients();
  res.render('patients', { patients, query: q });
});

app.post('/patients/new', loginRequired, (req, res) => {
  const problems = Array.isArray(req.body.problems) ? req.body.problems.join(',') : (req.body.problems || '');
  db.createPatient({ ...req.body, problems });
  req.flash('success', 'מטופל נוסף בהצלחה');
  res.redirect('/patients');
});

app.post('/patients/:id/delete', loginRequired, (req, res) => {
  db.deletePatient(parseInt(req.params.id));
  req.flash('success', 'מטופל נמחק');
  res.redirect('/patients');
});

app.get('/patients/:id', loginRequired, (req, res) => {
  const patient = db.getPatient(parseInt(req.params.id));
  if (!patient) return res.redirect('/patients');
  const consultations  = db.getPatientConsultations(patient.id);
  const visualizations = db.getPatientVisualizations(patient.id);
  res.render('patient_history', { patient, consultations, visualizations });
});

app.get('/patients/:id/edit', loginRequired, (req, res) => {
  const patient = db.getPatient(parseInt(req.params.id));
  if (!patient) return res.redirect('/patients');
  res.render('patient_edit', { patient });
});

app.post('/patients/:id/edit', loginRequired, (req, res) => {
  const problems = Array.isArray(req.body.problems) ? req.body.problems.join(',') : (req.body.problems || '');
  db.updatePatient(parseInt(req.params.id), { ...req.body, problems });
  res.redirect('/patients');
});

// ─── Diagnosis ────────────────────────────────────────
app.get('/diagnosis', loginRequired, (req, res) => {
  const patients = db.getAllPatients();
  res.render('diagnosis', { patients });
});

app.post('/api/diagnose', loginRequired, upload.single('image'), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: 'לא הועלתה תמונה' });
  try {
    const { content, tokens } = await runDiagnosisAgent(req.file.path, req.body.additional_info || '');
    const cid = db.saveConsultation({
      patient_id: req.body.patient_id || null,
      patient_name: req.body.patient_name || '',
      consultation_type: 'diagnosis',
      image_path: `/static/uploads/${req.file.filename}`,
      additional_info: req.body.additional_info || '',
      ai_result: content,
      model_used: 'GPT-4o',
      tokens_used: tokens,
    });
    db.logActivity(req.session.username, 'diagnosis', `מטופל: ${req.body.patient_name || 'אנונימי'}`, req.ip, req.session.user_id);
    res.json({ success: true, result: content, model: 'GPT-4o', consultation_id: cid });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/diagnose-manual', loginRequired, async (req, res) => {
  const { findings, patient_name, patient_id } = req.body;
  if (!findings) return res.json({ success: false, error: 'יש להזין ממצאים' });
  try {
    const content = await runDiagnosisManual(findings);
    db.saveConsultation({ patient_id: patient_id || null, patient_name: patient_name || '', consultation_type: 'diagnosis', additional_info: findings, ai_result: content, model_used: 'GPT-4o' });
    res.json({ success: true, result: content });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Visualization ────────────────────────────────────
app.get('/visualization', loginRequired, (req, res) => {
  const patients   = db.getAllPatients();
  const treatments = JSON.parse(fs.readFileSync(getTreatmentsPath(), 'utf8'));
  res.render('visualization', { patients, treatments });
});

app.post('/api/visualize', loginRequired, upload.single('before_image'), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: 'לא הועלתה תמונה' });
  try {
    const client = getOpenAI();
    const { treatment_name, patient_name, patient_id } = req.body;

    const prompt = `Medical aesthetic visualization: Show the realistic result of ${treatment_name} treatment on this face. Maintain the same person's identity, lighting, and angle. Professional medical photography style.`;

    const imageB64 = fs.readFileSync(req.file.path).toString('base64');
    const resp = await client.images.edit({
      model: 'dall-e-2',
      image: fs.createReadStream(req.file.path),
      prompt,
      n: 1,
      size: '512x512',
      response_format: 'url',
    });

    const afterUrl = resp.data[0].url;
    db.saveVisualization({ patient_id: patient_id || null, patient_name: patient_name || '', before_image_path: `/static/uploads/${req.file.filename}`, after_image_url: afterUrl, treatment_name: treatment_name || '' });
    db.logActivity(req.session.username, 'visualization', `טיפול: ${treatment_name || ''}`, req.ip, req.session.user_id);
    res.json({ success: true, before_url: `/static/uploads/${req.file.filename}`, after_url: afterUrl });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Chat ─────────────────────────────────────────────
app.get('/chat', loginRequired, (req, res) => {
  if (!req.session.chat_session_id) req.session.chat_session_id = uuid();
  const history = db.getChatHistory(req.session.chat_session_id, 20);
  res.render('chat', { history });
});

app.post('/api/chat', loginRequired, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.json({ success: false, error: 'הודעה ריקה' });
  if (!req.session.chat_session_id) req.session.chat_session_id = uuid();
  const history = db.getChatHistory(req.session.chat_session_id, 20);
  try {
    db.saveChatMessage(req.session.chat_session_id, 'user', message, null, '');
    const reply = await runChat(message, history);
    db.saveChatMessage(req.session.chat_session_id, 'assistant', reply, null, 'gpt-4o');
    res.json({ success: true, response: reply });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Agents ───────────────────────────────────────────
app.get('/agents', loginRequired, (req, res) => {
  const agents = db.getAllAgents();
  res.render('agents', { agents });
});

app.get('/agents/new', loginRequired, (req, res) => {
  res.render('agent_builder', { agent: null, prefill: req.query });
});

app.get('/agents/:id/edit', loginRequired, (req, res) => {
  const agent = db.getAgent(parseInt(req.params.id));
  if (!agent) return res.redirect('/agents');
  res.render('agent_builder', { agent, prefill: {} });
});

app.post('/api/agents/save', loginRequired, (req, res) => {
  const { id, name, description, icon, system_prompt, knowledge, model, active } = req.body;
  if (!name || !system_prompt) return res.json({ success: false, error: 'שם ו-System Prompt הם שדות חובה' });
  if (id) {
    db.updateAgent(parseInt(id), { name, description, icon: icon||'🤖', system_prompt, knowledge, model: model||'gpt-4o', active: active !== '0' ? 1 : 0 });
    res.json({ success: true, redirect: '/agents' });
  } else {
    const newId = db.createAgent({ name, description, icon: icon||'🤖', system_prompt, knowledge, model: model||'gpt-4o' });
    res.json({ success: true, redirect: '/agents' });
  }
});

app.post('/api/agents/:id/delete', loginRequired, (req, res) => {
  db.deleteAgent(parseInt(req.params.id));
  res.json({ success: true });
});

app.post('/api/agents/upload-icon', loginRequired, upload.single('icon'), (req, res) => {
  if (!req.file) return res.json({ success: false, error: 'לא הועלה קובץ' });
  res.json({ success: true, url: `/static/uploads/${req.file.filename}` });
});

app.get('/agents/:id/chat', loginRequired, (req, res) => {
  const agent = db.getAgent(parseInt(req.params.id));
  if (!agent) return res.redirect('/agents');
  const patients = db.getAllPatients();
  res.render('agent_chat', { agent, patients });
});

app.post('/api/agents/:id/chat', loginRequired, async (req, res) => {
  const agent = db.getAgent(parseInt(req.params.id));
  if (!agent) return res.json({ success: false, error: 'Agent לא נמצא' });
  const { message, session_id, patient_name } = req.body;
  if (!message) return res.json({ success: false, error: 'הודעה ריקה' });
  const sessionId = session_id || uuid();
  const history   = db.getAgentConversation(agent.id, sessionId, 20);
  db.saveAgentMessage(agent.id, sessionId, 'user', message, null, patient_name || '');
  try {
    const reply = await runCustomAgent(agent, message, history);
    if (!reply || !reply.trim()) return res.json({ success: false, error: 'הסוכן לא הצליח לענות — בדוק חיבור אינטרנט ומפתח API' });
    db.saveAgentMessage(agent.id, sessionId, 'assistant', reply);
    res.json({ success: true, response: reply });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Settings ─────────────────────────────────────────
app.get('/settings', loginRequired, (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY || '';
  const geminiKey = process.env.GEMINI_API_KEY || '';
  res.render('settings', {
    openai_set: openaiKey.length > 10,
    gemini_set: geminiKey.length > 10,
  });
});

app.post('/api/save-api-keys', loginRequired, async (req, res) => {
  const envPath = path.join(APP_DIR, '.env');
  let lines = [];
  if (fs.existsSync(envPath)) lines = fs.readFileSync(envPath, 'utf8').split('\n');

  const setKey = (arr, key, val) => {
    const idx = arr.findIndex(l => l.startsWith(key + '='));
    if (val) {
      if (idx >= 0) arr[idx] = `${key}=${val}`;
      else arr.push(`${key}=${val}`);
    }
    return arr;
  };

  if (req.body.openai_key) { setKey(lines, 'OPENAI_API_KEY', req.body.openai_key); process.env.OPENAI_API_KEY = req.body.openai_key; }
  if (req.body.gemini_key) { setKey(lines, 'GEMINI_API_KEY', req.body.gemini_key); process.env.GEMINI_API_KEY = req.body.gemini_key; }
  if (req.body.new_password) {
    const hash = bcrypt.hashSync(req.body.new_password, 10);
    db.getDb && require('./db').getDb?.(); // noop
    require('better-sqlite3')(path.join(db.DATA_DIR, 'royal_med.db')).prepare(`UPDATE users SET password_hash=? WHERE username=?`).run(hash, req.session.username);
  }

  fs.writeFileSync(envPath, lines.filter(Boolean).join('\n'), 'utf8');
  res.json({ success: true });
});

app.get('/api/treatments', loginRequired, (req, res) => {
  const data = JSON.parse(fs.readFileSync(getTreatmentsPath(), 'utf8'));
  res.json(data);
});

app.post('/api/treatments/save', loginRequired, (req, res) => {
  fs.writeFileSync(getTreatmentsPath(), JSON.stringify(req.body, null, 2), 'utf8');
  res.json({ success: true });
});

// ─── Users ────────────────────────────────────────────
app.get('/users', loginRequired, (req, res) => {
  if (req.session.role !== 'admin') return res.redirect('/dashboard');
  res.render('users', { users: db.getAllUsers() });
});

app.post('/api/users/create', loginRequired, (req, res) => {
  if (req.session.role !== 'admin') return res.json({ success: false, error: 'אין הרשאה' });
  const [id, err] = db.createUser(req.body.username, req.body.full_name, req.body.password, req.body.role || 'employee', req.body.email || '');
  if (err) return res.json({ success: false, error: err });
  res.json({ success: true });
});

app.post('/api/users/:id/delete', loginRequired, (req, res) => {
  if (req.session.role !== 'admin') return res.json({ success: false, error: 'אין הרשאה' });
  db.deleteUser(parseInt(req.params.id));
  res.json({ success: true });
});

app.post('/api/users/:id/toggle', loginRequired, (req, res) => {
  if (req.session.role !== 'admin') return res.json({ success: false, error: 'אין הרשאה' });
  db.toggleUser(parseInt(req.params.id));
  res.json({ success: true });
});

// ─── Activity Log ─────────────────────────────────────
app.get('/activity-log', loginRequired, (req, res) => {
  if (req.session.role !== 'admin') return res.redirect('/dashboard');
  res.render('activity_log', { logs: db.getActivityLog(200) });
});

// ─── Leads ────────────────────────────────────────────
app.get('/leads', loginRequired, (req, res) => {
  const status = req.query.status || '';
  const leads  = db.getAllLeads(status || undefined);
  const stats  = {
    total:    leads.length,
    new:      leads.filter(l => l.status === 'חדש').length,
    followup: leads.filter(l => l.status === 'מעקב').length,
    closed:   leads.filter(l => l.status === 'סגור').length,
  };
  res.render('leads', { leads, stats, status_filter: status });
});

app.get('/leads/new', loginRequired, (req, res) => res.render('lead_form', { lead: null }));

app.post('/leads/new', loginRequired, (req, res) => {
  db.createLead(req.body);
  res.redirect('/leads');
});

app.get('/leads/:id', loginRequired, (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.redirect('/leads');
  res.render('lead_detail', { lead });
});

app.get('/leads/:id/edit', loginRequired, (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.redirect('/leads');
  res.render('lead_form', { lead });
});

app.post('/leads/:id/edit', loginRequired, (req, res) => {
  db.updateLead(parseInt(req.params.id), req.body);
  res.redirect('/leads/' + req.params.id);
});

app.post('/api/leads/:id/status', loginRequired, (req, res) => {
  db.updateLead(parseInt(req.params.id), { status: req.body.status });
  res.json({ success: true });
});

app.post('/api/leads/:id/notes', loginRequired, (req, res) => {
  db.updateLead(parseInt(req.params.id), { notes: req.body.notes });
  res.json({ success: true });
});

app.post('/api/leads/:id/delete', loginRequired, (req, res) => {
  db.deleteLead(parseInt(req.params.id));
  res.json({ success: true });
});

// ─── WhatsApp ─────────────────────────────────────────
app.get('/whatsapp-bot', loginRequired, (req, res) => {
  const settings = db.getBotSettings();
  res.render('whatsapp_bot', { settings });
});

app.get('/api/whatsapp/status', loginRequired, async (req, res) => {
  try {
    const r = await fetch('http://localhost:3001/status');
    const d = await r.json();
    res.json(d);
  } catch { res.json({ connected: false, status: 'disconnected' }); }
});

app.get('/api/whatsapp/qr', loginRequired, async (req, res) => {
  try {
    const r = await fetch('http://localhost:3001/qr');
    const d = await r.json();
    res.json(d);
  } catch { res.json({ qr: null }); }
});

app.post('/api/whatsapp/connect', loginRequired, async (req, res) => {
  try {
    const r = await fetch('http://localhost:3001/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    res.json(d);
  } catch { res.json({ success: false, error: 'שירות WhatsApp לא פעיל' }); }
});

app.post('/api/whatsapp/disconnect', loginRequired, async (req, res) => {
  try {
    const r = await fetch('http://localhost:3001/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    res.json(await r.json());
  } catch { res.json({ success: false }); }
});

app.get('/api/whatsapp/bot-settings', loginRequired, (req, res) => res.json(db.getBotSettings()));
app.post('/api/whatsapp/bot-settings', loginRequired, (req, res) => {
  db.saveBotSettings(req.body.enabled ? 1 : 0, req.body.system_prompt || '', req.body.model || 'gpt-4o-mini');
  res.json({ success: true });
});

app.get('/api/whatsapp/conversations', loginRequired, (req, res) => res.json(db.getAllWaConversations()));
app.get('/api/whatsapp/conversations/:phone', loginRequired, (req, res) => {
  const c = db.getWaConversation(req.params.phone);
  res.json(c || {});
});

app.post('/api/whatsapp/incoming', async (req, res) => {
  // WhatsApp bot handler
  const { phone, message, display_name } = req.body;
  if (!phone || !message) return res.json({ reply: null });
  try {
    const settings = db.getBotSettings();
    if (!settings.enabled) return res.json({ reply: null });

    const conv = db.getOrCreateWaConversation(phone, display_name || '');
    const messages = JSON.parse(conv.messages || '[]');
    messages.push({ role: 'user', content: message, ts: Date.now() });

    const client = getOpenAI();
    const history = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
    const chatMsgs = [{ role: 'system', content: settings.system_prompt }, ...history];

    const resp = await client.chat.completions.create({ model: settings.model || 'gpt-4o-mini', messages: chatMsgs, max_tokens: 500, temperature: 0.7 });
    const reply = resp.choices[0].message.content || '';

    messages.push({ role: 'assistant', content: reply, ts: Date.now() });
    db.updateWaConversation(phone, messages);
    res.json({ reply });
  } catch (e) {
    res.json({ reply: null, error: e.message });
  }
});

// ─── Report ───────────────────────────────────────────
app.get('/report/:id', loginRequired, (req, res) => {
  const c = db.getConsultation(parseInt(req.params.id));
  if (!c) return res.redirect('/dashboard');
  res.render('report', { consultation: c });
});

// ─── Start ────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '4000');
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[RoyalMed] Server running on http://localhost:${PORT}`);
});
