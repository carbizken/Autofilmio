/**
 * CRM Integration Framework for AutoFilm.
 *
 * Supports: Elead, VinSolutions, DealerSocket (+ extensible to HubSpot, Salesforce).
 *
 * Each provider implements:
 *   - logActivity(connection, event)  — push video activity into CRM
 *   - syncContact(connection, contact) — create/update customer record
 *   - fetchLeads(connection, since)    — pull new leads for video follow-up
 *
 * The framework is event-driven: when a video is sent/watched/replied,
 * the CRM sync fires asynchronously (non-blocking to the user action).
 */

import { supabase } from './supabase.js';

// ── PROVIDER ADAPTERS ───────────────────────────────────────

const providers = {
  /**
   * Elead CRM (CDK Global) — uses REST API with dealer-specific endpoint.
   * Docs: Elead partner API portal
   */
  elead: {
    async logActivity(conn, event) {
      const url = `${conn.endpoint_url || 'https://api.eleadcrm.com'}/v1/activities`;
      const body = {
        dealerId: conn.dealer_id,
        type: mapEventType(event.action),
        contactPhone: event.customer_phone,
        contactEmail: event.customer_email,
        subject: buildSubject(event),
        notes: buildNotes(event),
        customFields: {
          autofilm_video_id: event.video_id,
          autofilm_short_code: event.short_code,
          autofilm_watch_pct: event.watch_pct,
          autofilm_video_url: event.video_url,
        },
      };

      return apiCall(url, conn, body);
    },

    async syncContact(conn, contact) {
      const url = `${conn.endpoint_url || 'https://api.eleadcrm.com'}/v1/contacts`;
      return apiCall(url, conn, {
        dealerId: conn.dealer_id,
        firstName: contact.first_name,
        lastName: contact.last_name,
        phone: contact.phone,
        email: contact.email,
        source: 'AutoFilm Video',
        notes: contact.notes,
      });
    },

    async fetchLeads(conn, since) {
      const url = `${conn.endpoint_url || 'https://api.eleadcrm.com'}/v1/leads?since=${since.toISOString()}&dealerId=${conn.dealer_id}`;
      return apiGet(url, conn);
    },
  },

  /**
   * VinSolutions (Cox Automotive) — uses VinConnect API.
   * Activity logging via lead activity endpoint.
   */
  vinsolutions: {
    async logActivity(conn, event) {
      const url = `${conn.endpoint_url || 'https://api.vinsolutions.com'}/v1/activities`;
      const body = {
        leadId: event.crm_lead_id,
        type: 'VideoMessage',
        direction: 'Outbound',
        subject: buildSubject(event),
        body: buildNotes(event),
        metadata: {
          provider: 'AutoFilm',
          videoId: event.video_id,
          watchPercentage: event.watch_pct,
          videoUrl: event.video_url,
        },
      };

      return apiCall(url, conn, body);
    },

    async syncContact(conn, contact) {
      const url = `${conn.endpoint_url || 'https://api.vinsolutions.com'}/v1/contacts`;
      return apiCall(url, conn, {
        firstName: contact.first_name,
        lastName: contact.last_name,
        primaryPhone: contact.phone,
        primaryEmail: contact.email,
        leadSource: 'AutoFilm',
      });
    },

    async fetchLeads(conn, since) {
      const url = `${conn.endpoint_url || 'https://api.vinsolutions.com'}/v1/leads?modifiedAfter=${since.toISOString()}`;
      return apiGet(url, conn);
    },
  },

  /**
   * DealerSocket (Solera) — uses DealerSocket Connect API.
   * Native Covideo integration exists; AutoFilm replaces it.
   */
  dealersocket: {
    async logActivity(conn, event) {
      const url = `${conn.endpoint_url || 'https://api.dealersocket.com'}/v2/activities`;
      const body = {
        dealershipId: conn.dealer_id,
        activityType: 'VideoEmail',
        description: buildSubject(event),
        notes: buildNotes(event),
        customerPhone: event.customer_phone,
        customerEmail: event.customer_email,
        customData: {
          source: 'AutoFilm',
          videoId: event.video_id,
          shortCode: event.short_code,
          watchPct: event.watch_pct,
        },
      };

      return apiCall(url, conn, body);
    },

    async syncContact(conn, contact) {
      const url = `${conn.endpoint_url || 'https://api.dealersocket.com'}/v2/customers`;
      return apiCall(url, conn, {
        dealershipId: conn.dealer_id,
        firstName: contact.first_name,
        lastName: contact.last_name,
        phoneNumber: contact.phone,
        email: contact.email,
        leadSource: 'AutoFilm Video',
      });
    },

    async fetchLeads(conn, since) {
      const url = `${conn.endpoint_url || 'https://api.dealersocket.com'}/v2/leads?since=${since.toISOString()}&dealershipId=${conn.dealer_id}`;
      return apiGet(url, conn);
    },
  },

  /**
   * HubSpot — universal CRM. Uses contacts + engagements API.
   */
  hubspot: {
    async logActivity(conn, event) {
      const url = 'https://api.hubapi.com/crm/v3/objects/notes';
      const body = {
        properties: {
          hs_note_body: buildNotes(event),
          hs_timestamp: new Date().toISOString(),
        },
      };

      return apiCall(url, conn, body, { useBearer: true });
    },

    async syncContact(conn, contact) {
      const url = 'https://api.hubapi.com/crm/v3/objects/contacts';
      return apiCall(url, conn, {
        properties: {
          firstname: contact.first_name,
          lastname: contact.last_name,
          phone: contact.phone,
          email: contact.email,
          leadsource: 'AutoFilm Video',
        },
      }, { useBearer: true });
    },

    async fetchLeads(conn, since) {
      const url = `https://api.hubapi.com/crm/v3/objects/contacts?limit=100&after=${since.getTime()}`;
      return apiGet(url, conn, { useBearer: true });
    },
  },

  /**
   * Salesforce — enterprise CRM. Uses REST API with OAuth token.
   */
  salesforce: {
    async logActivity(conn, event) {
      const url = `${conn.endpoint_url}/services/data/v59.0/sobjects/Task`;
      return apiCall(url, conn, {
        Subject: buildSubject(event),
        Description: buildNotes(event),
        Status: 'Completed',
        Type: 'Video Message',
        ActivityDate: new Date().toISOString().split('T')[0],
      }, { useBearer: true });
    },

    async syncContact(conn, contact) {
      const url = `${conn.endpoint_url}/services/data/v59.0/sobjects/Lead`;
      return apiCall(url, conn, {
        FirstName: contact.first_name,
        LastName: contact.last_name,
        Phone: contact.phone,
        Email: contact.email,
        LeadSource: 'AutoFilm Video',
      }, { useBearer: true });
    },

    async fetchLeads(conn, since) {
      const query = encodeURIComponent(`SELECT Id,FirstName,LastName,Phone,Email FROM Lead WHERE CreatedDate > ${since.toISOString()}`);
      const url = `${conn.endpoint_url}/services/data/v59.0/query?q=${query}`;
      return apiGet(url, conn, { useBearer: true });
    },
  },
};

// ── PUBLIC API ──────────────────────────────────────────────

/**
 * Push a video event to all active CRM connections for a rooftop.
 * Runs asynchronously — does not block the caller.
 *
 * @param {string} rooftopId
 * @param {object} event - { action, video_id, short_code, customer_phone, customer_email, watch_pct, video_url }
 */
export async function syncVideoEvent(rooftopId, event) {
  try {
    const { data: connections } = await supabase
      .from('crm_connections')
      .select('*')
      .eq('rooftop_id', rooftopId)
      .eq('active', true);

    if (!connections?.length) return;

    for (const conn of connections) {
      const provider = providers[conn.provider];
      if (!provider) {
        console.warn(`[crm] Unknown provider: ${conn.provider}`);
        continue;
      }

      try {
        const result = await provider.logActivity(conn, event);

        await supabase.from('crm_sync_log').insert({
          rooftop_id: rooftopId,
          crm_provider: conn.provider,
          action: event.action,
          video_id: event.video_id,
          crm_record_id: result?.id || null,
          payload: event,
          status: 'synced',
        });

        console.log(`[crm] ${conn.provider}: synced ${event.action} for video ${event.video_id}`);
      } catch (err) {
        await supabase.from('crm_sync_log').insert({
          rooftop_id: rooftopId,
          crm_provider: conn.provider,
          action: event.action,
          video_id: event.video_id,
          payload: event,
          status: 'failed',
          error_message: err.message,
        });

        console.error(`[crm] ${conn.provider}: sync failed — ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[crm] syncVideoEvent error:', err.message);
  }
}

/**
 * Get available CRM providers.
 */
export function getProviders() {
  return Object.keys(providers);
}

/**
 * Test a CRM connection by attempting a simple API call.
 */
export async function testConnection(connection) {
  const provider = providers[connection.provider];
  if (!provider) throw new Error(`Unknown provider: ${connection.provider}`);

  try {
    await provider.fetchLeads(connection, new Date(Date.now() - 86400000));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── HELPERS ─────────────────────────────────────────────────

function mapEventType(action) {
  const map = {
    video_sent: 'VideoOutbound',
    video_watched: 'VideoViewed',
    reply_received: 'VideoInbound',
    mpi_approved: 'ServiceApproval',
  };
  return map[action] || 'Other';
}

function buildSubject(event) {
  const subjects = {
    video_sent: 'AutoFilm: Personal video sent to customer',
    video_watched: `AutoFilm: Customer watched ${event.watch_pct || 0}% of video`,
    reply_received: 'AutoFilm: Customer sent a video reply',
    mpi_approved: 'AutoFilm: Customer approved MPI service recommendation',
  };
  return subjects[event.action] || 'AutoFilm: Video activity';
}

function buildNotes(event) {
  const lines = [`Source: AutoFilm Video Platform`];
  if (event.short_code) lines.push(`Video Link: https://links.autofilm.io/v/${event.short_code}`);
  if (event.watch_pct !== undefined) lines.push(`Watch Percentage: ${event.watch_pct}%`);
  if (event.video_url) lines.push(`Player URL: ${event.video_url}`);
  lines.push(`Timestamp: ${new Date().toISOString()}`);
  return lines.join('\n');
}

async function apiCall(url, conn, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };

  if (opts.useBearer) {
    headers['Authorization'] = `Bearer ${conn.api_key}`;
  } else {
    headers['X-Api-Key'] = conn.api_key;
    if (conn.api_secret) headers['X-Api-Secret'] = conn.api_secret;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${conn.provider} API error ${res.status}: ${err}`);
  }

  return res.json().catch(() => ({}));
}

async function apiGet(url, conn, opts = {}) {
  const headers = {};

  if (opts.useBearer) {
    headers['Authorization'] = `Bearer ${conn.api_key}`;
  } else {
    headers['X-Api-Key'] = conn.api_key;
    if (conn.api_secret) headers['X-Api-Secret'] = conn.api_secret;
  }

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${conn.provider} API error ${res.status}: ${err}`);
  }

  return res.json();
}
