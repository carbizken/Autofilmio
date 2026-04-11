/**
 * AutoFilm Link Resolver — Cloudflare Worker
 * Deploy to: workers.cloudflare.com
 * Routes:
 *   /v/:code  → AutoFilm video player  (e.g. autofilm.io/v/abc9)
 *   /t/:code  → Trade-in landing page  (e.g. autofilm.io/t/k9x2)
 *
 * KV Namespace required: AUTOFILM_LINKS
 *   Key format:  "v:abc9"  or  "t:k9x2"
 *   Value format (JSON string):
 *     Video: { "type":"video", "dest":"https://autofilm.io/watch/abc9", "rep":"Ken C.", "created":1711234567 }
 *     Trade: { "type":"trade", "dest":"https://hartecash.com/trade?source=autofilm&rep=Ken+C.&customer=John+Smith&phone=2035551234&vehicle=2025+Honda+Accord", "rep":"Ken C.", "created":1711234567 }
 *
 * Analytics namespace (optional): AUTOFILM_ANALYTICS
 *   Written on every click for rep dashboards.
 *
 * ─────────────────────────────────────────────────────────
 * DEPLOY STEPS:
 *   1. wrangler kv:namespace create AUTOFILM_LINKS
 *   2. wrangler kv:namespace create AUTOFILM_ANALYTICS
 *   3. Copy namespace IDs into wrangler.toml (see bottom of file)
 *   4. wrangler publish
 *
 * SHORT LINK CREATION (from your Node/Render API):
 *   POST /api/links  →  { video_link, trade_link? }
 *   Your API generates codes, writes to KV, returns short URLs.
 *   See createShortLink() helper below for reference.
 * ─────────────────────────────────────────────────────────
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname; // e.g. "/v/abc9" or "/t/k9x2"

    // ── Health check ─────────────────────────────────────
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Parse /v/:code  or  /t/:code ────────────────────
    const match = path.match(/^\/(v|t)\/([a-zA-Z0-9]{4,12})$/);
    if (!match) {
      return new Response('Not found', { status: 404 });
    }

    const [, type, code] = match; // type = "v" or "t"
    const kvKey = `${type}:${code}`;

    // ── KV lookup ────────────────────────────────────────
    const raw = await env.AUTOFILM_LINKS.get(kvKey);
    if (!raw) {
      // Code doesn't exist or expired
      return Response.redirect(
        type === 'v'
          ? 'https://autofilm.io'          // fallback: homepage
          : 'https://hartecash.com/trade', // fallback: trade tool homepage
        302
      );
    }

    const record = JSON.parse(raw);

    // ── Fire analytics event (non-blocking) ──────────────
    ctx.waitUntil(trackClick(env, type, code, record, request));

    // ── Redirect to destination ──────────────────────────
    return Response.redirect(record.dest, 302);
  },
};

// ─────────────────────────────────────────────────────────
// ANALYTICS TRACKER
// Writes to KV: "click:v:abc9:1711234567" = { event data }
// Your backend reads these for rep dashboards.
// ─────────────────────────────────────────────────────────
async function trackClick(env, type, code, record, request) {
  try {
    const event = {
      type,
      code,
      rep:       record.rep    || null,
      dest_host: new URL(record.dest).hostname,
      ts:        Date.now(),
      ip:        request.headers.get('CF-Connecting-IP') || null,
      country:   request.cf?.country || null,
      device:    detectDevice(request.headers.get('User-Agent') || ''),
      // Trade-specific: extract customer identity from dest URL params
      customer:  type === 't' ? extractParam(record.dest, 'customer') : null,
      phone:     type === 't' ? extractParam(record.dest, 'phone')    : null,
    };

    // Write to KV with 30-day TTL (your backend batch-reads these)
    const analyticsKey = `click:${type}:${code}:${event.ts}`;
    await env.AUTOFILM_ANALYTICS.put(
      analyticsKey,
      JSON.stringify(event),
      { expirationTtl: 60 * 60 * 24 * 30 } // 30 days
    );

    // Also increment a counter for the rep's daily stats
    // Key: "count:rep:Ken+C.:2026-03-22:trade_taps"
    if (record.rep) {
      const today    = new Date().toISOString().slice(0, 10);
      const metric   = type === 't' ? 'trade_taps' : 'video_opens';
      const countKey = `count:rep:${encodeURIComponent(record.rep)}:${today}:${metric}`;
      const existing = await env.AUTOFILM_ANALYTICS.get(countKey);
      const count    = existing ? parseInt(existing) + 1 : 1;
      await env.AUTOFILM_ANALYTICS.put(countKey, String(count), {
        expirationTtl: 60 * 60 * 24 * 60, // 60 days
      });
    }
  } catch (e) {
    // Never block the redirect on analytics failure
    console.error('Analytics error:', e);
  }
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function extractParam(urlStr, param) {
  try {
    return new URL(urlStr).searchParams.get(param);
  } catch {
    return null;
  }
}

function detectDevice(ua) {
  if (/iPhone|Android.*Mobile|iPad/i.test(ua)) return 'mobile';
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  return 'desktop';
}


// ─────────────────────────────────────────────────────────
// SHORT LINK CREATOR — reference implementation
// Call this from your Node.js/Render API when rep hits Send.
// ─────────────────────────────────────────────────────────
/**
 * createShortLink(env, type, dest, meta)
 *
 * type: "v" | "t"
 * dest: full destination URL (video player URL or trade URL with params)
 * meta: { rep, dealer, customer?, phone?, vehicle? }
 *
 * Returns: short code (e.g. "abc9")
 *
 * Example usage in your Express API:
 *
 *   POST /api/links
 *   body: { video_dest, trade_dest?, rep, dealer, customer, phone, vehicle }
 *
 *   const videoCode = await createShortLink(env, 'v', video_dest, { rep, dealer });
 *   const tradeCode = trade_dest
 *     ? await createShortLink(env, 't', trade_dest, { rep, dealer, customer, phone })
 *     : null;
 *
 *   return {
 *     video_short: `https://autofilm.io/v/${videoCode}`,
 *     trade_short: tradeCode ? `https://autofilm.io/t/${tradeCode}` : null,
 *   };
 */
export async function createShortLink(env, type, dest, meta = {}) {
  const code    = generateCode(); // 6-char alphanumeric
  const kvKey   = `${type}:${code}`;
  const record  = {
    type,
    dest,
    rep:     meta.rep     || null,
    dealer:  meta.dealer  || null,
    created: Date.now(),
  };
  // Video links: 90-day TTL. Trade links: 7-day TTL (matches price lock).
  const ttl = type === 'v' ? 60 * 60 * 24 * 90 : 60 * 60 * 24 * 7;
  await env.AUTOFILM_LINKS.put(kvKey, JSON.stringify(record), {
    expirationTtl: ttl,
  });
  return code;
}

function generateCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no l, o, i, 0, 1 (confusing chars)
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}


/*
═══════════════════════════════════════════════════════
wrangler.toml — paste this into your project root
═══════════════════════════════════════════════════════

name = "autofilm-links"
main = "autofilm-worker.js"
compatibility_date = "2025-01-01"
workers_dev = false

routes = [
  { pattern = "autofilm.io/v/*", zone_name = "autofilm.io" },
  { pattern = "autofilm.io/t/*", zone_name = "autofilm.io" },
]

# For dealer-branded short domains (one entry per dealer):
# { pattern = "harte.video/v/*", zone_name = "harte.video" }
# { pattern = "harte.video/t/*", zone_name = "harte.video" }

[[kv_namespaces]]
binding = "AUTOFILM_LINKS"
id      = "YOUR_KV_NAMESPACE_ID_HERE"

[[kv_namespaces]]
binding = "AUTOFILM_ANALYTICS"
id      = "YOUR_ANALYTICS_KV_ID_HERE"

═══════════════════════════════════════════════════════
WHAT THIS COSTS:
  Cloudflare Workers free tier: 100,000 requests/day
  At 1,000 videos/rooftop/month → ~33,000 link clicks/day for 1 rooftop
  Paid tier ($5/month): 10 million requests/month
  At 150 rooftops: ~150,000 video opens + ~50,000 trade taps/month
  = ~200,000 requests/month → well within $5/month tier

WHAT THIS RESOLVES IN:
  <10ms globally (Cloudflare edge, 300+ cities)
  Customer taps link → page loads before they blink
═══════════════════════════════════════════════════════
*/
