import express from 'express';
import { supabase } from '../lib/supabase.js';
import { sendPush } from '../lib/push.js';

const router = express.Router();

/**
 * Live Video Call Signaling for AutoFilm.
 *
 * WebRTC peer-to-peer video calling between customers and reps.
 * The signaling uses simple HTTP polling (no WebSocket needed for MVP).
 *
 * Flow:
 *   1. Customer clicks "Live Call" on widget/player → POST /api/call/initiate
 *   2. Rep gets push notification → opens call page
 *   3. Both sides exchange SDP offers/answers via POST /api/call/:id/signal
 *   4. WebRTC peer connection established → direct video/audio
 *   5. Call ends → POST /api/call/:id/end
 *
 * In production, replace HTTP polling with WebSocket or SSE for
 * lower latency signaling. This MVP works for proof of concept.
 */

// In-memory call store (replace with Redis in production)
const activeCalls = new Map();

/**
 * POST /api/call/initiate
 * Customer initiates a live video call request.
 *
 * Body: { rep_id, rooftop_id, caller_name?, caller_phone?, source? }
 */
router.post('/initiate', async (req, res) => {
  try {
    const { rep_id, rooftop_id, caller_name, caller_phone, source } = req.body;

    if (!rep_id) return res.status(400).json({ error: 'rep_id required' });

    const callId = crypto.randomUUID();

    activeCalls.set(callId, {
      id: callId,
      rep_id,
      rooftop_id,
      caller_name: caller_name || 'Website Visitor',
      caller_phone: caller_phone || null,
      source: source || 'widget',
      status: 'ringing',      // ringing → connected → ended
      offer: null,             // caller's SDP offer
      answer: null,            // rep's SDP answer
      callerCandidates: [],    // caller's ICE candidates
      repCandidates: [],       // rep's ICE candidates
      created_at: Date.now(),
    });

    // Send push notification to rep
    const { data: rep } = await supabase
      .from('reps')
      .select('name, push_subscription, rooftops(name)')
      .eq('id', rep_id)
      .single();

    if (rep?.push_subscription) {
      await sendPush(rep.push_subscription, {
        title: 'Incoming Video Call',
        body: `${caller_name || 'A customer'} is calling from your website`,
        icon: '/icons/call-192.png',
        data: {
          type: 'incoming_call',
          call_id: callId,
          caller_name: caller_name || 'Website Visitor',
        },
        tag: `call-${callId}`,
        requireInteraction: true,
      });
    }

    console.log(`[call] Initiated ${callId} — ${caller_name} → rep ${rep_id}`);

    res.json({
      call_id: callId,
      status: 'ringing',
      rep_name: rep?.name || 'Your Rep',
      dealer_name: rep?.rooftops?.name || '',
    });

    // Auto-expire call after 60 seconds if not answered
    setTimeout(() => {
      const call = activeCalls.get(callId);
      if (call && call.status === 'ringing') {
        call.status = 'missed';
        console.log(`[call] ${callId} expired (unanswered)`);
        // Keep for 5 more minutes for the missed-call record
        setTimeout(() => activeCalls.delete(callId), 300000);
      }
    }, 60000);

  } catch (err) {
    console.error('[call] Initiate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/call/:id/status
 * Poll call status (both sides use this).
 */
router.get('/:id/status', (req, res) => {
  const call = activeCalls.get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found or expired' });

  res.json({
    call_id: call.id,
    status: call.status,
    caller_name: call.caller_name,
    has_offer: !!call.offer,
    has_answer: !!call.answer,
  });
});

/**
 * POST /api/call/:id/signal
 * Exchange WebRTC signaling data.
 *
 * Body: { role: 'caller' | 'rep', type: 'offer' | 'answer' | 'candidate', data: <SDP or ICE candidate> }
 */
router.post('/:id/signal', (req, res) => {
  const call = activeCalls.get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });

  const { role, type, data } = req.body;

  if (type === 'offer' && role === 'caller') {
    call.offer = data;
    call.status = 'ringing';
    console.log(`[call] ${call.id}: received offer from caller`);
  } else if (type === 'answer' && role === 'rep') {
    call.answer = data;
    call.status = 'connected';
    console.log(`[call] ${call.id}: connected`);
  } else if (type === 'candidate') {
    if (role === 'caller') call.callerCandidates.push(data);
    else call.repCandidates.push(data);
  }

  res.json({ ok: true });
});

/**
 * GET /api/call/:id/signal
 * Retrieve signaling data for the other party.
 *
 * Query: ?role=caller|rep&since=<index>
 */
router.get('/:id/signal', (req, res) => {
  const call = activeCalls.get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });

  const { role, since = 0 } = req.query;
  const sinceIdx = parseInt(since) || 0;

  if (role === 'caller') {
    // Caller wants rep's answer + candidates
    res.json({
      answer: call.answer,
      candidates: call.repCandidates.slice(sinceIdx),
      candidateIndex: call.repCandidates.length,
      status: call.status,
    });
  } else {
    // Rep wants caller's offer + candidates
    res.json({
      offer: call.offer,
      candidates: call.callerCandidates.slice(sinceIdx),
      candidateIndex: call.callerCandidates.length,
      status: call.status,
    });
  }
});

/**
 * POST /api/call/:id/accept
 * Rep accepts the incoming call.
 */
router.post('/:id/accept', (req, res) => {
  const call = activeCalls.get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });

  call.status = 'connecting';
  console.log(`[call] ${call.id}: accepted by rep`);
  res.json({ ok: true, call });
});

/**
 * POST /api/call/:id/end
 * Either party ends the call.
 */
router.post('/:id/end', (req, res) => {
  const call = activeCalls.get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });

  const duration = Math.floor((Date.now() - call.created_at) / 1000);
  call.status = 'ended';

  console.log(`[call] ${call.id}: ended — duration ${duration}s`);

  // Clean up after 60 seconds
  setTimeout(() => activeCalls.delete(call.id), 60000);

  res.json({ ok: true, duration });
});

/**
 * GET /api/call/active?rep_id=<uuid>
 * Check if there's an active/ringing call for a rep.
 */
router.get('/active', (req, res) => {
  const { rep_id } = req.query;
  if (!rep_id) return res.status(400).json({ error: 'rep_id required' });

  for (const [id, call] of activeCalls) {
    if (call.rep_id === rep_id && (call.status === 'ringing' || call.status === 'connecting')) {
      return res.json({ call });
    }
  }

  res.json({ call: null });
});

export default router;
