/**
 * Email delivery for AutoFilm video shares.
 * Uses Twilio SendGrid for transactional email with animated thumbnail previews.
 *
 * Env: SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, SENDGRID_FROM_NAME
 */

const SENDGRID_API = 'https://api.sendgrid.com/v3/mail/send';

/**
 * Send a video share email with animated thumbnail.
 * @param {object} opts
 * @param {string} opts.to           - recipient email
 * @param {string} opts.customerName - recipient name
 * @param {string} opts.repName      - rep display name
 * @param {string} opts.dealerName   - dealership name
 * @param {string} opts.shortUrl     - short link to player
 * @param {string} opts.vehicle      - vehicle description (optional)
 * @param {string} opts.thumbnailUrl - animated GIF or static thumbnail URL
 * @param {string} opts.repPhoto     - rep's photo URL
 * @param {string} opts.brandColor   - rooftop brand color hex
 * @returns {{ success: boolean, messageId: string }}
 */
export async function sendVideoEmail(opts) {
  const {
    to,
    customerName,
    repName,
    dealerName,
    shortUrl,
    vehicle,
    thumbnailUrl,
    repPhoto,
    brandColor = '#D94F00',
  } = opts;

  const firstName = customerName.split(' ')[0];
  const subject = vehicle
    ? `${repName} recorded a personal video about the ${vehicle} for you`
    : `${repName} from ${dealerName} recorded a personal video for you`;

  const html = buildEmailHtml({
    firstName,
    repName,
    dealerName,
    shortUrl,
    vehicle,
    thumbnailUrl,
    repPhoto,
    brandColor,
  });

  const payload = {
    personalizations: [{ to: [{ email: to, name: customerName }] }],
    from: {
      email: process.env.SENDGRID_FROM_EMAIL || 'videos@autofilm.io',
      name: process.env.SENDGRID_FROM_NAME || `${repName} via AutoFilm`,
    },
    reply_to: {
      email: process.env.SENDGRID_FROM_EMAIL || 'videos@autofilm.io',
      name: repName,
    },
    subject,
    content: [
      { type: 'text/plain', value: `${repName} recorded a personal video for you. Watch it here: ${shortUrl}` },
      { type: 'text/html', value: html },
    ],
    tracking_settings: {
      click_tracking: { enable: true },
      open_tracking: { enable: true },
    },
  };

  const res = await fetch(SENDGRID_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SendGrid error ${res.status}: ${err}`);
  }

  const messageId = res.headers.get('x-message-id') || '';
  console.log(`[email] Sent to ${to} — msgId: ${messageId}`);

  return { success: true, messageId };
}

/**
 * Build premium HTML email with animated thumbnail.
 */
function buildEmailHtml({ firstName, repName, dealerName, shortUrl, vehicle, thumbnailUrl, repPhoto, brandColor }) {
  const thumbSrc = thumbnailUrl || `https://image.mux.com/placeholder/animated.gif?width=560&fps=15`;
  const vehicleLine = vehicle
    ? `<p style="margin:0 0 20px;font-size:14px;color:#666;line-height:1.5;">I put together a quick video about the <strong style="color:#333;">${escHtml(vehicle)}</strong> for you.</p>`
    : `<p style="margin:0 0 20px;font-size:14px;color:#666;line-height:1.5;">I put together a quick personal video just for you.</p>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

<!-- Header bar -->
<tr><td style="background:${escHtml(brandColor)};height:4px;"></td></tr>

<!-- Video thumbnail with play button -->
<tr><td style="padding:0;">
<a href="${escHtml(shortUrl)}" style="display:block;position:relative;text-decoration:none;">
  <img src="${escHtml(thumbSrc)}" alt="Watch Video" width="560" style="display:block;width:100%;height:auto;border:0;" />
  <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:72px;height:72px;background:rgba(0,0,0,0.6);border-radius:50%;display:flex;align-items:center;justify-content:center;">
    <div style="width:0;height:0;border-left:28px solid #fff;border-top:16px solid transparent;border-bottom:16px solid transparent;margin-left:6px;"></div>
  </div>
</a>
</td></tr>

<!-- Body content -->
<tr><td style="padding:28px 32px 32px;">

${repPhoto ? `<img src="${escHtml(repPhoto)}" alt="${escHtml(repName)}" width="48" height="48" style="border-radius:50%;margin-bottom:16px;display:block;" />` : ''}

<p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#1a1a1a;">Hey ${escHtml(firstName)},</p>
${vehicleLine}

<!-- CTA Button -->
<table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
<tr><td style="background:${escHtml(brandColor)};border-radius:10px;padding:14px 32px;">
  <a href="${escHtml(shortUrl)}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:inline-block;">
    Watch My Video &rarr;
  </a>
</td></tr>
</table>

<p style="margin:0;font-size:13px;color:#999;">
  ${escHtml(repName)} &middot; ${escHtml(dealerName)}
</p>

</td></tr>

<!-- Footer -->
<tr><td style="padding:16px 32px;border-top:1px solid #eee;background:#fafafa;">
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
  <td style="font-size:11px;color:#aaa;">Powered by <strong style="color:${escHtml(brandColor)};">AutoFilm</strong></td>
  <td align="right" style="font-size:11px;color:#ccc;">Personal video message</td>
</tr>
</table>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
