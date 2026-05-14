// ============================================================
// /api/dashboard-default — Node Serverless Function
// ============================================================
// Flujo:
//   1. (Opcional) Dispara el v3 webhook y espera a que termine
//      → asegura que el Google Sheet tenga datos fresquísimos.
//   2. Lee las 5 hojas del sheet via Google Sheets API v4 (auth
//      con Service Account JWT, sin dependencias npm).
//   3. Devuelve un JSON con la misma shape que /api/dashboard
//      (summary, byRep, daily, monthlySummary, monthlyByRep)
//      para que el frontend lo consuma sin cambios.
//
// Env vars requeridas (configurar en Vercel → Settings → Env Vars):
//   - SHEET_ID                 (ID del Google Sheet)
//   - GOOGLE_SA_EMAIL          (email del service account)
//   - GOOGLE_SA_PRIVATE_KEY    (private_key del JSON, con \n literales)
//   - N8N_V3_WEBHOOK_URL       (opcional — si está, dispara v3 y espera)
//
// No usa cache HTTP: cada request fuerza un refresh (el usuario eligió
// "esperar el refresh"). Si después querés cachearlo, cambiá el header
// Cache-Control de abajo.
// ============================================================

import crypto from 'node:crypto';

// Nombres exactos de las tabs del sheet (tal como el v3 las escribe)
const SHEET_TABS = [
  'Dashboard_Summary',
  'Weekly_By_Rep',
  'Daily_Quotes',
  'Monthly_Summary',
  'Monthly_By_Rep',
];

// ---------- Auth: Service Account → access_token ----------
async function getAccessToken() {
  const email = process.env.GOOGLE_SA_EMAIL;
  const key   = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('Missing GOOGLE_SA_EMAIL or GOOGLE_SA_PRIVATE_KEY env vars');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss:   email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${b64url(header)}.${b64url(claim)}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(key, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuth2 token exchange failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth2 response missing access_token');
  return data.access_token;
}

// ---------- Sheets API: batchGet de las 5 tabs en 1 sola llamada ----------
async function readSheetTabs(accessToken, sheetId) {
  const ranges = SHEET_TABS.map(t => `ranges=${encodeURIComponent(t)}`).join('&');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchGet?${ranges}&majorDimension=ROWS`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sheets API batchGet failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.valueRanges || [];
}

// ---------- Helpers ----------
// Convierte [["col1","col2"], ["val1","val2"], ...] → [{col1:val1, col2:val2}, ...]
function rowsToObjects(values) {
  if (!values || values.length === 0) return [];
  const [header, ...rows] = values;
  return rows.map(row => {
    const obj = {};
    header.forEach((h, i) => {
      const raw = row[i];
      obj[h] = raw === undefined ? '' : raw;
    });
    return obj;
  });
}

// Algunos campos numéricos pueden venir como string desde el sheet — los normalizamos
function coerceNumericFields(obj, keys) {
  const out = { ...obj };
  for (const k of keys) {
    if (out[k] != null && out[k] !== '' && typeof out[k] === 'string') {
      const n = Number(out[k]);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

// ---------- Trigger v3 webhook (espera completion) ----------
async function triggerV3Refresh() {
  const url = process.env.N8N_V3_WEBHOOK_URL;
  if (!url) return { skipped: true };
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      return { skipped: false, ok: false, status: res.status, elapsed_ms: elapsed };
    }
    return { skipped: false, ok: true, status: res.status, elapsed_ms: elapsed };
  } catch (err) {
    return { skipped: false, ok: false, error: err.message, elapsed_ms: Date.now() - t0 };
  }
}

// ============================================================
// Handler
// ============================================================
export default async function handler(req, res) {
  // CORS / preflight
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')      return res.status(405).json({ error: 'Use GET' });

  // No cache — el usuario eligió esperar el refresh cada vez
  res.setHeader('Cache-Control', 'no-store');

  const sheetId = process.env.SHEET_ID;
  if (!sheetId) {
    return res.status(500).json({ error: 'Missing SHEET_ID env var' });
  }

  // 1. Disparar v3 y esperar (si está configurado)
  const refreshResult = await triggerV3Refresh();

  // 2. Auth + leer sheets
  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    return res.status(502).json({ error: 'Auth failed', detail: err.message, refresh: refreshResult });
  }

  let valueRanges;
  try {
    valueRanges = await readSheetTabs(token, sheetId);
  } catch (err) {
    return res.status(502).json({ error: 'Sheet read failed', detail: err.message, refresh: refreshResult });
  }

  // 3. Parsear las 5 tabs
  const tabs = {};
  SHEET_TABS.forEach((name, i) => {
    tabs[name] = rowsToObjects(valueRanges[i]?.values);
  });

  // Coerción numérica para los campos que vienen como string del sheet
  const summaryNumKeys       = ['Total_Leads (with Bradley)', 'Total_Leads (Active Reps)', 'Total_Quotes (with Bradley)', 'Total_Quotes (Active Reps)', 'Active_Reps', 'Top_Rep_Quote_Count', 'Avg_Quotes_Per_Rep'];
  const monthlySummaryNumKeys = ['Total_Leads (with Bradley)', 'Total_Leads (Active Reps)', 'Artwork_Sent (with Bradley)', 'Artwork_Sent (Active Reps)', 'Total_Closed_Won (with Bradley)', 'Total_Closed_Won (Active Reps)', 'Active_Reps'];
  const byRepNumKeys         = ['Leads', 'Quotes'];
  const monthlyByRepNumKeys  = ['Total_Leads', 'Artwork_Sent', 'Closed_Won'];

  const summary        = tabs.Dashboard_Summary[0] ? coerceNumericFields(tabs.Dashboard_Summary[0], summaryNumKeys) : {};
  const monthlySummary = tabs.Monthly_Summary[0]   ? coerceNumericFields(tabs.Monthly_Summary[0],   monthlySummaryNumKeys) : {};
  const byRep          = (tabs.Weekly_By_Rep   || []).map(r => coerceNumericFields(r, byRepNumKeys));
  const monthlyByRep   = (tabs.Monthly_By_Rep  || []).map(r => coerceNumericFields(r, monthlyByRepNumKeys));

  // Daily quotes: columnas de fecha vienen como string, coercionar
  const daily = (tabs.Daily_Quotes || []).map(r => {
    const out = { Rep: r.Rep };
    for (const [k, v] of Object.entries(r)) {
      if (k === 'Rep') continue;
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) || k === 'Total') {
        const n = Number(v);
        out[k] = Number.isFinite(n) ? n : 0;
      } else {
        out[k] = v;
      }
    }
    return out;
  });

  return res.status(200).json({
    summary,
    byRep,
    daily,
    monthlySummary,
    monthlyByRep,
    _meta: {
      source: 'google_sheet',
      sheet_id: sheetId,
      refresh: refreshResult,
      generated_at: new Date().toISOString(),
    },
  });
}
