import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

/**
 * POST /api/onboard
 * Standalone dealership onboarding with website scraper.
 *
 * Body: {
 *   website_url: string,
 *   admin_email: string,
 *   admin_name: string,
 *   dealer_name?: string  (scraped if not provided)
 * }
 *
 * Steps:
 *   1. Scrape the dealer website for: name, logo, brand colors, phone, address
 *   2. Create rooftop record with scraped data
 *   3. Create admin rep record
 *   4. Return rooftop + rep IDs + scraped data for confirmation
 */
router.post('/', async (req, res) => {
  try {
    const { website_url, admin_email, admin_name, dealer_name } = req.body;

    if (!website_url) return res.status(400).json({ error: 'website_url required' });
    if (!admin_email) return res.status(400).json({ error: 'admin_email required' });
    if (!admin_name) return res.status(400).json({ error: 'admin_name required' });

    // Check if email already exists
    const { data: existingRep } = await supabase
      .from('reps')
      .select('id, rooftop_id')
      .eq('email', admin_email)
      .single();

    if (existingRep) {
      return res.status(409).json({
        error: 'Email already registered',
        rooftop_id: existingRep.rooftop_id,
      });
    }

    // 1. Scrape dealer website
    console.log(`[onboard] Scraping ${website_url}...`);
    const scraped = await scrapeDealer(website_url);

    const finalName = dealer_name || scraped.name || 'My Dealership';

    // 2. Create rooftop
    const { data: rooftop, error: rtErr } = await supabase
      .from('rooftops')
      .insert({
        name: finalName,
        website_url: normalizeUrl(website_url),
        logo_url: scraped.logo,
        brand_color: scraped.brandColor || '#D94F00',
        phone: scraped.phone,
        address: scraped.address,
        city: scraped.city,
        state: scraped.state,
        zip: scraped.zip,
        tenant_source: 'autofilm',
        scraped_at: new Date().toISOString(),
        onboarded: false,
      })
      .select()
      .single();

    if (rtErr) throw rtErr;

    // 3. Create admin rep
    const { data: rep, error: repErr } = await supabase
      .from('reps')
      .insert({
        rooftop_id: rooftop.id,
        name: admin_name,
        email: admin_email,
        role: 'admin',
        department: 'sales',
        onboarded: false,
      })
      .select()
      .single();

    if (repErr) throw repErr;

    console.log(`[onboard] Created rooftop ${rooftop.id} (${finalName}) + admin ${rep.id}`);

    res.json({
      success: true,
      rooftop_id: rooftop.id,
      rep_id: rep.id,
      scraped: {
        name: finalName,
        logo: scraped.logo,
        brand_color: scraped.brandColor,
        phone: scraped.phone,
        address: scraped.address,
        city: scraped.city,
        state: scraped.state,
        zip: scraped.zip,
        inventory_detected: scraped.inventoryDetected,
      },
    });

  } catch (err) {
    console.error('[onboard] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/onboard/:rooftop_id/confirm
 * Confirm onboarding after admin reviews scraped data.
 * Body: { corrections... } — any overrides to scraped values.
 */
router.post('/:rooftop_id/confirm', async (req, res) => {
  try {
    const { rooftop_id } = req.params;
    const updates = {};

    // Allow overriding any scraped field
    const allowed = ['name', 'logo_url', 'brand_color', 'phone', 'address', 'city', 'state', 'zip'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.onboarded = true;

    const { data, error } = await supabase
      .from('rooftops')
      .update(updates)
      .eq('id', rooftop_id)
      .select()
      .single();

    if (error) throw error;

    // Mark admin rep as onboarded
    await supabase
      .from('reps')
      .update({ onboarded: true })
      .eq('rooftop_id', rooftop_id)
      .eq('role', 'admin');

    console.log(`[onboard] Confirmed rooftop ${rooftop_id}`);
    res.json({ success: true, rooftop: data });

  } catch (err) {
    console.error('[onboard] Confirm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/onboard/:rooftop_id/invite
 * Invite a rep to the rooftop.
 * Body: { name, email, role?, department? }
 */
router.post('/:rooftop_id/invite', async (req, res) => {
  try {
    const { rooftop_id } = req.params;
    const { name, email, role = 'sales', department = 'sales' } = req.body;

    if (!name || !email) return res.status(400).json({ error: 'name and email required' });

    const { data: rep, error } = await supabase
      .from('reps')
      .insert({
        rooftop_id,
        name,
        email,
        role,
        department,
        onboarded: false,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`[onboard] Invited ${name} (${email}) to rooftop ${rooftop_id}`);
    res.json({ success: true, rep });

  } catch (err) {
    console.error('[onboard] Invite error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SCRAPER ─────────────────────────────────────────────────

/**
 * Scrape a dealer website for branding info.
 * Uses basic fetch + regex — lightweight, no headless browser needed.
 */
async function scrapeDealer(url) {
  const result = {
    name: null,
    logo: null,
    brandColor: null,
    phone: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    inventoryDetected: false,
  };

  try {
    const normalUrl = normalizeUrl(url);
    const response = await fetch(normalUrl, {
      headers: {
        'User-Agent': 'AutoFilm-Onboard/1.0 (dealer scraper)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.warn(`[onboard] Scrape failed: HTTP ${response.status}`);
      return result;
    }

    const html = await response.text();

    // Extract title / dealer name
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      let title = titleMatch[1].trim();
      // Clean common suffixes
      title = title.replace(/\s*[|\-–—].*$/, '').trim();
      title = title.replace(/\s*(New|Used|Cars|Dealer|Dealership|Auto).*$/i, '').trim();
      if (title.length > 3 && title.length < 80) result.name = title;
    }

    // Extract logo
    const logoPatterns = [
      /class="[^"]*logo[^"]*"[^>]*src="([^"]+)"/i,
      /id="[^"]*logo[^"]*"[^>]*src="([^"]+)"/i,
      /<img[^>]*alt="[^"]*logo[^"]*"[^>]*src="([^"]+)"/i,
      /<link[^>]*rel="icon"[^>]*href="([^"]+)"/i,
    ];
    for (const pattern of logoPatterns) {
      const match = html.match(pattern);
      if (match) {
        result.logo = resolveUrl(normalUrl, match[1]);
        break;
      }
    }

    // Extract phone number
    const phoneMatch = html.match(/(?:tel:|href="tel:)?\+?1?\s*[\(\-]?\s*(\d{3})\s*[\)\-.\s]+(\d{3})\s*[\-.\s]+(\d{4})/);
    if (phoneMatch) {
      result.phone = `(${phoneMatch[1]}) ${phoneMatch[2]}-${phoneMatch[3]}`;
    }

    // Extract brand color from CSS / meta theme-color
    const themeMatch = html.match(/<meta[^>]*name="theme-color"[^>]*content="([^"]+)"/i);
    if (themeMatch) {
      result.brandColor = themeMatch[1];
    } else {
      // Look for dominant hex color in inline styles
      const hexColors = html.match(/#[0-9a-fA-F]{6}/g);
      if (hexColors) {
        // Count frequency, pick most common non-black/white
        const counts = {};
        hexColors.forEach(c => {
          const lower = c.toLowerCase();
          if (lower !== '#000000' && lower !== '#ffffff' && lower !== '#333333') {
            counts[lower] = (counts[lower] || 0) + 1;
          }
        });
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) result.brandColor = sorted[0][0];
      }
    }

    // Extract address from structured data (JSON-LD)
    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatch) {
      for (const block of jsonLdMatch) {
        try {
          const content = block.replace(/<\/?script[^>]*>/gi, '');
          const ld = JSON.parse(content);
          const addr = ld.address || ld?.location?.address;
          if (addr) {
            result.address = addr.streetAddress;
            result.city = addr.addressLocality;
            result.state = addr.addressRegion;
            result.zip = addr.postalCode;
            break;
          }
        } catch { /* skip malformed JSON-LD */ }
      }
    }

    // Detect inventory pages
    const inventoryPatterns = ['/inventory', '/new-vehicles', '/used-vehicles', '/searchnew', '/searchused', '/vehicles'];
    result.inventoryDetected = inventoryPatterns.some(p => html.includes(p));

  } catch (err) {
    console.warn(`[onboard] Scrape error: ${err.message}`);
  }

  return result;
}

function normalizeUrl(url) {
  if (!url.startsWith('http')) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

export default router;
