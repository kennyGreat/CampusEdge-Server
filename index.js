
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const fs = require('fs');

const app = express();
app.use(bodyParser.json());

// Load env
const PORT = process.env.PORT || 8888;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TERMII_API_KEY = process.env.TERMII_API_KEY;
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID || 'EDGEINC';
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme';

// Supabase client (optional)
let supabase = null;
if(SUPABASE_URL && SUPABASE_KEY){
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

// Helpers for simple local fallback storage
const FALLBACK_FILE = 'payments_fallback.json';

function writeFallback(obj){
  fs.writeFileSync(FALLBACK_FILE, JSON.stringify(obj, null, 2));
}
function readFallback(){
  if(fs.existsSync(FALLBACK_FILE)) return JSON.parse(fs.readFileSync(FALLBACK_FILE));
  return [];
}

// Helper: write to Google Sheet via service account
async function appendToSheet(row) {
  if(!GOOGLE_SERVICE_ACCOUNT_JSON || !GOOGLE_SHEET_ID) return;
  let credentials;
  try {
    credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch(e) {
    if(fs.existsSync(GOOGLE_SERVICE_ACCOUNT_JSON)) {
      credentials = JSON.parse(fs.readFileSync(GOOGLE_SERVICE_ACCOUNT_JSON));
    } else {
      console.error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON');
      return;
    }
  }

  const client = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await client.authorize();
  const sheets = google.sheets({version: 'v4', auth: client});
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: 'Sheet1!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

// Helper: send Termii SMS (server side)
async function sendTermiiSMS(phone, message) {
  if(!TERMII_API_KEY) return {ok:false, message:'TERMII not configured'};
  const payload = {
    to: phone,
    from: TERMII_SENDER_ID,
    sms: message,
    type: 'plain'
  };
  const res = await fetch('https://termii.com/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': TERMII_API_KEY },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  return data;
}

// Middleware: simple admin auth for sensitive endpoints
function requireAdminSecret(req, res, next){
  const secret = req.headers['x-admin-secret'] || req.query.admin_secret;
  if(secret !== ADMIN_SECRET){
    return res.status(403).json({error:'forbidden'});
  }
  next();
}

// Endpoint: log a payment (agent or web app)
app.post('/payment', async (req, res) => {
  try {
    const { studentId, amount, agent, source, phone } = req.body;
    if(!studentId || !amount) return res.status(400).json({error:'studentId and amount required'});

    let paymentRecord = null;
    if(supabase){
      const { data, error } = await supabase.from('payments').insert([{
        student_id: studentId,
        amount,
        agent,
        status: source === 'agent' ? 'pending_agent' : 'pending_admin',
        source: source || 'web',
        created_at: new Date().toISOString()
      }]).select().single();
      if(error){ console.error('Supabase insert error', error); }
      paymentRecord = data;
    } else {
      const arr = readFallback();
      const rec = { id: 'fx_' + Date.now(), studentId, amount, agent, status: source === 'agent' ? 'pending_agent' : 'pending_admin', source: source || 'web', created_at: new Date().toISOString() };
      arr.push(rec);
      writeFallback(arr);
      paymentRecord = rec;
    }

    try{
      await appendToSheet([new Date().toISOString(), studentId, agent || '', amount, paymentRecord.status || 'pending', source || 'web']);
    }catch(e){ console.warn('sheet append failed', e.message); }

    return res.json({ok:true, payment: paymentRecord});
  } catch (err) {
    console.error(err);
    return res.status(500).json({error: 'server_error'});
  }
});

// Endpoint: agent approves payment (marks approved_by_agent)
app.post('/agent/approve', async (req, res) => {
  try{
    const { paymentId, agent } = req.body;
    if(!paymentId) return res.status(400).json({error:'paymentId required'});
    if(supabase){
      const { data, error } = await supabase.from('payments').update({ status: 'approved_by_agent', agent }).eq('id', paymentId).select().single();
      if(error) console.error(error);
      return res.json({ok:true, payment: data});
    } else {
      const arr = readFallback();
      const idx = arr.findIndex(x=>x.id===paymentId);
      if(idx>=0){ arr[idx].status = 'approved_by_agent'; arr[idx].agent = agent; writeFallback(arr); return res.json({ok:true, payment:arr[idx]}); }
      return res.status(404).json({error:'not_found'});
    }
  }catch(e){ console.error(e); return res.status(500).json({error:'server_error'}); }
});

// Endpoint: admin final approve - requires ADMIN_SECRET header or query param
app.post('/admin/approve', requireAdminSecret, async (req, res) => {
  try{
    const { paymentId, adminNote, notifyPhone } = req.body;
    if(!paymentId) return res.status(400).json({error:'paymentId required'});

    let updated = null;
    if(supabase){
      const { data, error } = await supabase.from('payments').update({ status: 'approved', admin_note: adminNote }).eq('id', paymentId).select().single();
      if(error) console.error(error);
      updated = data;
    } else {
      const arr = readFallback(); const idx = arr.findIndex(x=>x.id===paymentId);
      if(idx>=0){ arr[idx].status = 'approved'; arr[idx].admin_note = adminNote; writeFallback(arr); updated = arr[idx]; }
    }

    try{
      await appendToSheet([new Date().toISOString(), paymentId, 'APPROVED', updated.amount, updated.studentId]);
    }catch(e){ console.warn('sheet append failed', e.message); }

    if(notifyPhone && TERMII_API_KEY){
      try{
        await sendTermiiSMS(notifyPhone, `Your payment of ₦${updated.amount} has been received and approved. - CampusEdge`);
      }catch(e){ console.warn('termii send failed', e.message); }
    }

    return res.json({ok:true, payment: updated});
  }catch(e){ console.error(e); return res.status(500).json({error:'server_error'}); }
});

app.listen(PORT, () => console.log('CampusEdge server listening on', PORT));

app.get('/', (req, res) => {
  res.send('✅ CampusEdge Server is running successfully — Powered by Edge Incorporated Limited');
});
