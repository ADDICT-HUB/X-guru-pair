const express = require('express');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (e) {
    console.warn('Twilio client setup failed:', e.message);
    twilioClient = null;
  }
}

// Default WA lib. If X-GURU uses another lib, adapt accordingly.
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(express.json());

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const clients = {}; // requestId -> { client, status, ... }
const otps = {}; // requestId -> { code, phone, expiresAt, verified }

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendSms(phone, message) {
  if (twilioClient) {
    try {
      await twilioClient.messages.create({
        body: message,
        from: TWILIO_FROM,
        to: phone
      });
      return true;
    } catch (e) {
      console.error('Twilio send error:', e.message || e);
      return false;
    }
  } else {
    // fallback for development: log OTP to console
    console.log(`SIMULATED SMS to ${phone}: ${message}`);
    return true;
  }
}

// POST /pair { phone: "+1555..." }
app.post('/pair', async (req, res) => {
  const phone = (req.body && req.body.phone) ? String(req.body.phone) : null;
  if (!phone) return res.status(400).json({ error: 'phone is required (E.164 format)' });

  const requestId = uuidv4();
  const otp = generateOtp();
  const expiresAt = Date.now() + (5 * 60 * 1000); // 5 minutes

  otps[requestId] = { code: otp, phone, expiresAt, verified: false, created_at: new Date().toISOString() };

  // Send OTP asynchronously (do not block client too long)
  sendSms(phone, `Your X-GURU pairing code is: ${otp}`).then(ok => {
    if (!ok) console.warn('OTP delivery may have failed for', phone);
  });

  // prepare WA client; store the session at ./sessions/<requestId>
  const sessionPath = path.join(SESSIONS_DIR, requestId);
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: requestId, dataPath: sessionPath }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  clients[requestId] = { client, status: 'initializing', phone, created_at: new Date().toISOString() };

  let responded = false;

  client.on('qr', async (qr) => {
    try {
      const dataUrl = await qrcode.toDataURL(qr);
      clients[requestId].status = 'qr';
      clients[requestId].qr = dataUrl;
      // return QR immediately if still waiting
      if (!responded) {
        responded = true;
        return res.json({ requestId, status: 'qr', qr: dataUrl, message: 'OTP sent to phone.' });
      }
    } catch (err) {
      console.error('QR->DataURL error', err);
    }
  });

  client.on('ready', async () => {
    const sessionId = uuidv4();
    clients[requestId].status = 'ready';
    clients[requestId].sessionId = sessionId;
    clients[requestId].ready_at = new Date().toISOString();

    const meta = { sessionId, requestId, phone, created_at: clients[requestId].created_at, ready_at: clients[requestId].ready_at };
    try {
      if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
      fs.writeFileSync(path.join(sessionPath, 'meta.json'), JSON.stringify(meta, null, 2));
    } catch (e) {
      console.error('Failed to write meta.json', e);
    }

    // if OTP already verified, finalize and (optionally) notify the phone via SMS
    const otpRec = otps[requestId];
    if (otpRec && otpRec.verified) {
      // notify user with sessionId via SMS (best effort)
      if (twilioClient) {
        try {
          await twilioClient.messages.create({
            body: `Pairing complete. sessionId: ${sessionId}`,
            from: TWILIO_FROM,
            to: phone
          });
        } catch (e) {
          console.warn('Failed to SMS sessionId:', e.message || e);
        }
      } else {
        console.log(`Pairing complete for ${phone}. sessionId: ${sessionId}`);
      }
      clients[requestId].linked = true;
      clients[requestId].linked_at = new Date().toISOString();
    }

    console.log('Client ready for requestId', requestId);
  });

  client.on('auth_failure', (msg) => {
    console.error('auth_failure', msg);
    clients[requestId].status = 'failed';
    clients[requestId].error = String(msg);
    if (!responded) {
      responded = true;
      res.status(500).json({ requestId, status: 'failed', error: String(msg) });
    }
    client.destroy().catch(() => {});
  });

  client.on('disconnected', (reason) => {
    console.log('Client disconnected', requestId, reason);
    clients[requestId].status = 'disconnected';
    clients[requestId].last_disconnect_reason = reason;
  });

  // initialize client
  try {
    client.initialize();
  } catch (e) {
    console.error('client.initialize error', e);
    clients[requestId].status = 'failed';
    if (!responded) {
      responded = true;
      return res.status(500).json({ requestId, status: 'failed', error: String(e) });
    }
  }

  // safety: if no QR in 15s, return pending with requestId (client will continue running)
  setTimeout(() => {
    if (!responded) {
      responded = true;
      res.json({ requestId, status: 'pending', message: 'OTP sent. Waiting for QR (poll /pair/:requestId).' });
    }
  }, 15000);
});

// POST /pair/:requestId/verify-otp { otp: "123456" }
app.post('/pair/:requestId/verify-otp', (req, res) => {
  const requestId = req.params.requestId;
  const bodyOtp = (req.body && req.body.otp) ? String(req.body.otp).trim() : null;
  const rec = otps[requestId];
  if (!rec) return res.status(404).json({ error: 'requestId not found or expired' });
  if (Date.now() > rec.expiresAt) {
    delete otps[requestId];
    return res.status(410).json({ error: 'OTP expired' });
  }
  if (!bodyOtp) return res.status(400).json({ error: 'otp required' });

  if (bodyOtp === rec.code) {
    rec.verified = true;
    rec.verified_at = new Date().toISOString();
    // if client already ready, return sessionId immediately
    const c = clients[requestId];
    if (c && c.sessionId) {
      // mark linked and return sessionId
      c.linked = true;
      c.linked_at = new Date().toISOString();
      return res.json({ requestId, verified: true, sessionId: c.sessionId });
    }
    return res.json({ requestId, verified: true, message: 'OTP verified. Waiting for WhatsApp connection to complete.' });
  } else {
    return res.status(403).json({ error: 'invalid otp' });
  }
});

// GET /pair/:requestId
app.get('/pair/:requestId', (req, res) => {
  const requestId = req.params.requestId;
  const c = clients[requestId] || null;
  const otpRec = otps[requestId] || null;

  if (!c && !otpRec) return res.status(404).json({ error: 'not found' });

  res.json({
    requestId,
    status: c ? c.status : 'unknown',
    phone: c ? c.phone : (otpRec ? otpRec.phone : null),
    qr: c && c.qr ? c.qr : null,
    otp_verified: otpRec ? !!otpRec.verified : false,
    sessionId: c && c.sessionId ? c.sessionId : null,
    linked: c && c.linked ? true : false,
    error: c && c.error ? c.error : null,
    created_at: c ? c.created_at : (otpRec ? otpRec.created_at : null)
  });
});

// GET /sessions
app.get('/sessions', (req, res) => {
  try {
    const items = fs.readdirSync(SESSIONS_DIR).map(name => {
      const metaPath = path.join(SESSIONS_DIR, name, 'meta.json');
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { meta = { requestId: name }; }
      return meta;
    });
    res.json({ sessions: items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// cleanup expired OTPs occasionally
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(otps)) {
    if (otps[id].expiresAt && otps[id].expiresAt < now) {
      console.log('Cleaning expired OTP for', id);
      delete otps[id];
    }
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Pairing server listening on ${PORT}`));
