// ============================================================
// Vercel Edge Function: /api/dashboard
// ============================================================
// Proxy + cache layer in front of the n8n webhook.
//
// - Runs as Edge Function: low cold-start, runs at CDN POP.
// - Converts the frontend GET (with query params) to a POST against n8n.
// - Sets Cache-Control so Vercel's edge cache stores the response by URL.
//   Two users requesting the same date range within s-maxage get the
//   cached body (typically <100ms). Cache key = full URL incl. query.
//
// Why GET on this side, POST on the upstream side?
// Edge cache keys responses by URL. POST bodies are not part of the key,
// so caching POST is unreliable. GET with deterministic query params is.
// n8n's webhook node only accepts POST in our config, so we translate.
// ============================================================

export const config = { runtime: 'edge' };

const N8N_WEBHOOK_URL = 'https://api.pinprosplus.com/webhook/dashboard';

// Cache tunables — change here if behavior needs adjusting.
const CACHE_TTL_SECONDS          = 600;   // 10 min fresh
const STALE_WHILE_REVALIDATE_SEC = 60;    // serve stale for up to 60s while refetching in background

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(body, { status = 200, cache = false } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(),
  };
  if (cache) {
    headers['Cache-Control'] = `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SEC}`;
    headers['CDN-Cache-Control'] = `public, s-maxage=${CACHE_TTL_SECONDS}`;
    // Vercel-specific: also honor s-maxage at the edge
    headers['Vercel-CDN-Cache-Control'] = `public, s-maxage=${CACHE_TTL_SECONDS}`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed. Use GET with query params.' }, { status: 405 });
  }

  const url      = new URL(req.url);
  const dateFrom = url.searchParams.get('dateFrom');
  const dateTo   = url.searchParams.get('dateTo');
  const tz       = url.searchParams.get('tz') || 'America/Denver';

  // ---- Validation ----
  if (!dateFrom || !dateTo) {
    return jsonResponse({ error: 'Missing required query params: dateFrom, dateTo' }, { status: 400 });
  }
  if (!YMD_RE.test(dateFrom) || !YMD_RE.test(dateTo)) {
    return jsonResponse({ error: 'dateFrom and dateTo must be YYYY-MM-DD' }, { status: 400 });
  }
  if (dateFrom > dateTo) {
    return jsonResponse({ error: 'dateFrom must be <= dateTo' }, { status: 400 });
  }
  // Sanity bound to avoid abusive ranges (>2 years) bypassing caching value
  const fromY = Number(dateFrom.slice(0, 4));
  const toY   = Number(dateTo.slice(0, 4));
  if (toY - fromY > 2) {
    return jsonResponse({ error: 'Range too large (>2 years).' }, { status: 400 });
  }

  // ---- Upstream call ----
  let upstream;
  try {
    upstream = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateFrom, dateTo, tz }),
      // Don't pass through cookies/credentials — server-to-server only
      cache: 'no-store',
    });
  } catch (err) {
    return jsonResponse(
      { error: 'Upstream fetch failed', detail: String(err && err.message || err) },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    let bodyText = '';
    try { bodyText = await upstream.text(); } catch (_) {}
    return jsonResponse(
      { error: `Upstream returned ${upstream.status}`, body: bodyText.slice(0, 500) },
      { status: 502 }
    );
  }

  // Pass through JSON body, with cache headers attached.
  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    return jsonResponse({ error: 'Upstream returned non-JSON' }, { status: 502 });
  }

  return jsonResponse(data, { status: 200, cache: true });
}
