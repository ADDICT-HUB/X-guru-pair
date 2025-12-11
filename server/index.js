// server/index.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

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

// Baileys imports
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason
} = require('@adiwajshing/baileys');

const app = express();
app.use(express.json());

// Serve the static client UI (public/client.html)
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'client.html'));
});

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const clients = {}; // requestId -> { socket, state, saveCreds, status, ... }
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
    // dev fallback
    console.log(`SIMULATED SMS to ${phone}: ${message}`);
    return true;
  }
}

// Helper: produce Mercedes~<base64> export of the auth creds (all files under sessionPath)
function exportCredsAsMercedesBase64(sessionPath) {
  try {
    const files = fs.readdirSync(sessionPath);
    const state = {};
    for (const file of files) {
      const full = path.join(sessionPath, file);
      if (fs.lstatSync(full).isFile()) {
        state[file] = fs.readFileSync(full, 'utf8');
      }
    }
    const payload = JSON.stringify(state);
    const b64 = Buffer.from(payload, 'utf8').toString('base64');
    return `Mercedes~${b64}`;
  } catch (e) {
    console.error('exportCreds error', e);
    return null;
  }
}

/**
 * POST /pair { phone: "+1555..." }
 * - create requestId
 * - generate OTP and send via SMS (or log)
 * - create Baileys state under ./sessions/<requestId> using useMultiFileAuthState
 * - start a socket and call requestPairingCode(phone) if available
 * - listen for connection.update to get qr and ready state
 */
app.post('/pair', async (req, res) => {
  const phone = (req.body && req.body.phone) ? String(req.body.phone) : null;
  if (!phone) return res.status(400).json({ error: 'phone is required (E.164 format)' });

  const requestId = uuidv4();
  const otp = generateOtp();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 mins
  otps[requestId] = { code: otp, phone, expiresAt, verified: false, created_at: new Date().toISOString() };

  // send OTP (async)
  sendSms(phone, `Your X-GURU pairing code is: ${otp}`).then(ok => {
    if (!ok) console.warn('OTP delivery may have failed for', phone);
  });

  const sessionPath = path.join(SESSIONS_DIR, requestId);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  // create an auth state that writes files under sessions/<requestId>
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // fetch baileys version
  const { version } = await fetchLatestBaileysVersion();

  // create socket
  const socket = makeWASocket({
    logger: { level: 'silent' },
    browser: Browsers.macOS('Firefox'),
    auth: state,
    version,
    printQRInTerminal: false,
  });

  clients[requestId] = { socket, state, saveCreds, status: 'initializing', phone, created_at: new Date().toISOString() };

  // persist creds when updated
  socket.ev.on('creds.update', saveCreds);

  let responded = false;

  socket.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const dataUrl = await qrcode.toDataURL(qr);
          clients[requestId].status = 'qr';
          clients[requestId].qr = dataUrl;
          if (!responded) {
            responded = true;
            return res.json({ requestId, status: 'qr', qr: dataUrl, message: 'OTP sent to phone.' });
          }
        } catch (e) {
          console.error('QR->DataURL error', e);
        }
      }

      if (connection === 'open') {
        const sessionId = uuidv4();
        clients[requestId].status = 'ready';
        clients[requestId].sessionId = sessionId;
        clients[requestId].ready_at = new Date().toISOString();

        const meta = { sessionId, requestId, phone, created_at: clients[requestId].created_at, ready_at: clients[requestId].ready_at };
        try {
          fs.writeFileSync(path.join(sessionPath, 'meta.json'), JSON.stringify(meta, null, 2));
        } catch (e) {
          console.error('Failed to write meta.json', e);
        }

        const otpRec = otps[requestId];
        if (otpRec && otpRec.verified) {
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

        const exportBase64 = exportCredsAsMercedesBase64(sessionPath);
        clients[requestId].export = exportBase64;

        console.log('Baileys client ready for', requestId);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode || null;
        if (code === DisconnectReason.loggedOut) {
          console.log('Logged out for', requestId);
          clients[requestId].status = 'logged_out';
        } else {
          console.log('Connection closed for', requestId, 'reason', code);
          clients[requestId].status = 'disconnected';
        }
      }
    } catch (e) {
      console.error('connection.update handler error', e);
    }
  });

  // try requestPairingCode if available
  try {
    if (typeof socket.requestPairingCode === 'function') {
      const normalized = phone.replace(/[^0-9]/g, '');
      const raw = await socket.requestPairingCode(normalized);
      const code = String(raw).match(/.{1,4}/g)?.join('-') || String(raw);
      clients[requestId].pairing_code = code;
      if (!responded) {
        responded = true;
        return res.json({ requestId, status: 'pairing_code', pairing_code: code, message: 'OTP sent to phone.' });
      }
    }
  } catch (e) {
    console.warn('requestPairingCode not available or failed:', e && e.message);
  }

  // fallback response
  setTimeout(() => {
    if (!responded) {
      responded = true;
      res.json({ requestId, status: 'pending', message: 'OTP sent. Waiting for QR/pairing code (poll /pair/:requestId).' });
    }
  }, 15000);
});

/**
 * POST /pair/:requestId/verify-otp { otp: "123456" }
 * Verifies OTP. If socket is already ready, returns sessionId immediately.
 */
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
    const c = clients[requestId];
    if (c && c.sessionId) {
      c.linked = true;
      c.linked_at = new Date().toISOString();
      return res.json({ requestId, verified: true, sessionId: c.sessionId, export: c.export || null });
    }
    return res.json({ requestId, verified: true, message: 'OTP verified. Waiting for WhatsApp connection to complete.' });
  } else {
    return res.status(403).json({ error: 'invalid otp' });
  }
});

/**
 * GET /pair/:requestId
 * Returns status, qr (if any), pairing_code (if any), otp_verified, sessionId and Mercedes export
 */
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
    pairing_code: c && c.pairing_code ? c.pairing_code : null,
    otp_verified: otpRec ? !!otpRec.verified : false,
    sessionId: c && c.sessionId ? c.sessionId : null,
    export: c && c.export ? c.export : null,
    linked: c && c.linked ? true : false,
    error: c && c.error ? c.error : null,
    created_at: c ? c.created_at : (otpRec ? otpRec.created_at : null)
  });
});

/**
 * GET /sessions
 * Lists saved session meta files found under ./sessions
 */
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
app.listen(PORT, () => console.log(`Pairing server (Baileys) listening on ${PORT}`));
