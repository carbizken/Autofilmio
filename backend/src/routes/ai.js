import express from 'express';

const router = express.Router();

/**
 * POST /api/ai-script
 * Proxy for Anthropic API — keeps the key server-side.
 * Body: { purpose, rep_name, dealer, vehicle?, customer_name? }
 * Returns: { script: string }
 */
router.post('/', async (req, res) => {
  try {
    const { purpose, rep_name, dealer, vehicle, customer_name } = req.body;

    if (!purpose) return res.status(400).json({ error: 'purpose required' });

    const prompts = {
      'internet-lead': `Write a short, natural video script (45-60 seconds when spoken) for ${rep_name} at ${dealer} reaching out to ${customer_name || 'a new internet lead'}${vehicle ? ` about the ${vehicle}` : ''}. Warm, personal, not salesy. End with a clear next step.`,
      'follow-up': `Write a brief follow-up video script for ${rep_name} at ${dealer} checking in with ${customer_name || 'a prospect'}${vehicle ? ` who was looking at the ${vehicle}` : ''}. Acknowledge time has passed. Keep it short and genuine.`,
      'appointment-reminder': `Write a friendly appointment reminder script for ${rep_name} at ${dealer}. Customer ${customer_name || ''} has an appointment coming up${vehicle ? ` to look at the ${vehicle}` : ''}. Excited tone, confirm details, make them feel welcome.`,
      'mpi-video': `Write a service video script for ${rep_name} at ${dealer} explaining recommended repairs to ${customer_name || 'the customer'}. Professional, transparent, no pressure. Explain why each item matters for safety or reliability.`,
      'trade-in': `Write a trade-in outreach script for ${rep_name} at ${dealer} reaching out to ${customer_name || 'a past customer'} about their current vehicle. Mention market conditions, keep it brief, offer a free appraisal.`,
      'unsold-follow-up': `Write a 48-hour unsold follow-up script for ${rep_name} at ${dealer} reaching back to ${customer_name || 'someone who visited'}${vehicle ? ` who looked at the ${vehicle}` : ''}. No pressure, open the conversation, offer to help.`,
      'csi-thank-you': `Write a thank-you and CSI script for ${rep_name} at ${dealer} following up after ${customer_name || 'a customer'}'s purchase${vehicle ? ` of the ${vehicle}` : ''}. Genuine gratitude, ask for a Google review, offer continued support.`,
      'service-reminder': `Write a service reminder script for ${rep_name} at ${dealer} reaching out to ${customer_name || 'a customer'} due for their next service. Friendly, make it easy to schedule.`,
      'birthday': `Write a birthday video script for ${rep_name} at ${dealer} wishing ${customer_name || 'a customer'} a happy birthday. Short, genuine, not a sales pitch.`,
      'walk-around': `Write a vehicle walk-around video script for ${rep_name} at ${dealer} showcasing the ${vehicle || 'vehicle'} for ${customer_name || 'a prospect'}. Hit the top 3 features they care about. Enthusiastic but natural.`,
    };

    const systemPrompt = prompts[purpose] || prompts['internet-lead'];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: systemPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error: ${err}`);
    }

    const data = await response.json();
    const script = data.content?.[0]?.text || '';

    console.log(`[ai] Generated ${purpose} script for ${rep_name} (${script.length} chars)`);
    res.json({ script });

  } catch (err) {
    console.error('[ai] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
