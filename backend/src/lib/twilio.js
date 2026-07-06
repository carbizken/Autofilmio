import twilio from 'twilio';

if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}

export const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER;

/**
 * Express middleware: verify a request genuinely came from Twilio via the
 * X-Twilio-Signature header. Without this, anyone who learns the webhook URL
 * can forge inbound messages — e.g. a fake "STOP" from a victim's number, or
 * bogus replies injected into a rep's inbox.
 *
 * Enabled by default in production. Set TWILIO_WEBHOOK_VALIDATE=false to
 * disable (local dev), or PUBLIC_API_URL to pin the exact base URL Twilio
 * signed against (recommended behind a proxy like Render).
 */
export function verifyTwilioSignature() {
  return (req, res, next) => {
    if (process.env.TWILIO_WEBHOOK_VALIDATE === 'false') return next();

    const signature = req.headers['x-twilio-signature'];
    const base = process.env.PUBLIC_API_URL
      || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    const url = `${base.replace(/\/$/, '')}${req.originalUrl}`;

    const valid = signature && twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      signature,
      url,
      req.body || {}
    );

    if (!valid) {
      console.warn(`[twilio] Rejected unsigned/invalid webhook to ${req.originalUrl}`);
      return res.status(403).type('text/xml').send('<Response></Response>');
    }
    next();
  };
}
