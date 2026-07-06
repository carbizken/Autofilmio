/**
 * Write a key-value pair to Cloudflare KV.
 * Used to store short_code → player_url mappings.
 */
export async function kvPut(key, value, expirationTtl = null) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values`;
  const url = `${base}/${encodeURIComponent(key)}`;

  const params = expirationTtl ? `?expiration_ttl=${expirationTtl}` : '';

  const res = await fetch(url + params, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body: value,
    // Bound the call so a hung CF API can't tie up the request awaiting it.
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CF KV write failed (${res.status}): ${err}`);
  }

  return true;
}
