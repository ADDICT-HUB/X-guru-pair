# pairing-X-GURU

Companion repository for pairing sessions with the ADDICT-HUB/X-GURU WhatsApp bot.

This pairing server provides:
- QR-based WhatsApp pairing (whatsapp-web.js).
- Phone number OTP verification (Twilio) to link a phone number to a session and receive the sessionId.

Quick start
1. Create the repo on GitHub: ADDICT-HUB/pairing-X-GURU (public).
2. Clone locally and save these files.
3. Make the script executable:
   chmod +x scripts/clone-x-guru.sh
4. Install deps:
   npm ci
5. Set environment variables (see .env.example).
6. Start:
   npm start
7. Create a pairing request:
   curl -X POST -H "Content-Type: application/json" -d '{"phone":"+15551234567"}' http://localhost:3001/pair
   Response includes requestId and QR data URL. OTP is sent to the provided phone.
8. Verify OTP:
   curl -X POST -H "Content-Type: application/json" -d '{"otp":"123456"}' http://localhost:3001/pair/<requestId>/verify-otp
9. Poll for status:
   curl http://localhost:3001/pair/<requestId>

Notes
- The pairing server uses whatsapp-web.js and Puppeteer. For containerized / Linux deployments you may need system dependencies for Puppeteer.
- Twilio integration: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER. If not set the server will log the OTP to console (useful for dev).
- Sessions are stored under ./sessions/<requestId> (LocalAuth data and a meta.json). Treat these as secrets.# X-guru-pair
