# Migración a Webhook + Timezone Denver — Guía operativa

Este documento contiene **todos los cambios** que hay que aplicar al workflow n8n para que funcione el nuevo `index.html` (date-picker driven, Denver-aware).

El frontend ya está actualizado y commiteable. Falta sólo el lado n8n.

---

## Resumen de cambios

| # | Componente | Acción |
|---|---|---|
| 1 | Workflow settings | Setear `timezone = America/Denver` (red de seguridad) |
| 2 | `Schedule Trigger` | **Reemplazar por `Webhook` trigger** (POST, espera dateFrom/dateTo/tz) |
| 3 | `Calculate Week Dates` | **Borrar** |
| 4 | `Calculate Month Dates` | **Borrar** |
| 5 | `Airtable - Weekly Deals` / `Monthly Deals` | Cambiar `filterByFormula` (Denver-aware, sin DATEADD ±1) |
| 6 | `Code - Weekly Metrics` | Reemplazar JS por versión con Luxon |
| 7 | `Code - Monthly Metrics` | Reemplazar JS por versión con Luxon |
| 8 | Salidas Google Sheets | **Opcional**: dejar tal cual como backup, o reemplazar el final por un `Respond to Webhook` que devuelva el JSON al frontend |
| 9 | CORS | Habilitar headers `Access-Control-Allow-Origin` en el Webhook trigger |

---

## 1. Workflow settings — timezone

Workflow → menú `⋯` → **Settings** → **Timezone**: `America/Denver`.

Esto cubre cualquier resto de `new Date()` que se nos haya pasado por alto. Es red de seguridad, no la solución principal.

---

## 2. Reemplazar `Schedule Trigger` por `Webhook` trigger

Borrá `Schedule Trigger`. Insertá un nodo **Webhook** con esta config:

```yaml
HTTP Method:     POST
Path:            dashboard           # → URL final: https://api.pinprosplus.com/webhook/dashboard
Authentication:  Header Auth         # recomendado para no exponer el endpoint
Respond:         Using Respond to Webhook node   # devolvemos JSON al final
Options:
  Allowed Origins (CORS):   https://<tu-dominio-vercel>.vercel.app
                            (o "*" para tests, NO en prod)
  Response Headers (CORS):  Access-Control-Allow-Methods: POST, OPTIONS
                            Access-Control-Allow-Headers: Content-Type, X-API-Key
```

Conectalo a `Airtable - Active Reps` (ese nodo no cambia).

**Payload que va a recibir** (referencia para los nodos siguientes):

```json
{
  "dateFrom": "2026-05-01",
  "dateTo":   "2026-05-31",
  "tz":       "America/Denver"
}
```

Acceso desde otros nodos: `{{ $('Webhook').first().json.dateFrom }}`, etc.

---

## 3. Borrar `Calculate Week Dates` y `Calculate Month Dates`

Ya no se necesitan — las fechas las trae el payload del webhook.

Conectá directo:
- `Airtable - Active Reps` → `Airtable - Weekly Deals`
- `Airtable - Active Reps` → `Airtable - Monthly Deals`

> **Nota semántica:** el nombre "Weekly" / "Monthly" pierde sentido si el usuario filtra rangos arbitrarios. Podés renombrar a `Airtable - Deals (Range)` con un sólo nodo, pero para mantener compatibilidad con el código existente dejé los dos. Si querés unificar, decime y lo simplifico.

---

## 4. Nueva `filterByFormula` para los nodos Airtable

**Reemplazá el `filterByFormula` de `Airtable - Weekly Deals` por:**

```
=AND(
  IS_AFTER(
    DATETIME_FORMAT(SET_TIMEZONE({Date Created}, '{{ $('Webhook').first().json.tz }}'), 'YYYY-MM-DD'),
    DATEADD('{{ $('Webhook').first().json.dateFrom }}', -1, 'days')
  ),
  IS_BEFORE(
    DATETIME_FORMAT(SET_TIMEZONE({Date Created}, '{{ $('Webhook').first().json.tz }}'), 'YYYY-MM-DD'),
    DATEADD('{{ $('Webhook').first().json.dateTo }}', 1, 'days')
  )
)
```

**Lo mismo para `Airtable - Monthly Deals`.**

### Qué hace esta fórmula

- `SET_TIMEZONE({Date Created}, 'America/Denver')` → convierte el timestamp UTC a hora Denver dentro de Airtable.
- `DATETIME_FORMAT(..., 'YYYY-MM-DD')` → lo reduce a un string de día en Denver.
- `DATEADD(..., -1)` / `DATEADD(..., +1)` → comparamos contra los límites del rango ± 1 día (para no descartar registros que están justo en el borde por el formato YYYY-MM-DD vs hora exacta).

### Diferencia con la fórmula anterior

| | Anterior | Nueva |
|---|---|---|
| TZ asumida en `{Date Created}` | UTC (default Airtable) | **Forzada a Denver** |
| Padding | `DATEADD(_, ±1)` "por las dudas" | Igual, pero **el padding ahora compensa la conversión YMD, no errores de TZ** |
| Compara contra | timestamps UTC parseados | strings YYYY-MM-DD ya en Denver |

---

## 5. Nuevo `Code - Weekly Metrics`

Reemplazá TODO el contenido del nodo `Code - Weekly Metrics` por:

```javascript
// ============================================================
// WEEKLY METRICS - reescrito para webhook + Luxon
// ============================================================
const { DateTime } = require('luxon');

const weeklyItems    = $('Airtable - Weekly Deals').all();
const activeRepItems = $('Airtable - Active Reps').all();
const payload        = $('Webhook').first().json;

const TZ       = payload.tz       || 'America/Denver';
const dateFrom = payload.dateFrom;  // "YYYY-MM-DD"
const dateTo   = payload.dateTo;    // "YYYY-MM-DD"

const EXCLUDED_REPS = ['Bradley Fry'];

// ---- Lookup de reps ----
const repIdToName = {};
const allRepNames = new Set();
for (const item of activeRepItems) {
  const row = item.json.fields ?? item.json;
  const fullName = String(row['Full Name'] ?? '').trim();
  const recordId = item.json.id ?? '';
  if (fullName) {
    allRepNames.add(fullName);
    if (recordId) repIdToName[recordId] = fullName;
  }
}
const activeRepNames = new Set([...allRepNames].filter(n => !EXCLUDED_REPS.includes(n)));

const CONFIG = {
  createdField:  'Date Created',
  minutesField:  'Lead to Quote (Minutes) During Business Hours',
  repField:      'Sales',
  stageField:    'Stage',
  stageQuote:    'Quote',
};

function resolveRep(value) {
  if (Array.isArray(value)) return value.map(v => resolveRep(v)).flat().filter(Boolean);
  let str = String(value ?? '').trim();
  if (!str) return [];
  str = str.replace(/^\d+:/, '');
  if (str.startsWith('rec') && repIdToName[str]) return [repIdToName[str]];
  if (allRepNames.has(str)) return [str];
  if (!str.startsWith('rec')) return [str];
  return [];
}
function normalizeStage(v) {
  if (Array.isArray(v)) return String(v[0] ?? '').trim();
  return String(v ?? '').trim();
}
function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) { if (v.length === 0) return null; v = v[0]; }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function formatHours(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
  const total = Math.round(minutes);
  const days  = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins  = total % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

// ---- Conversión a Denver: el corazón del fix de TZ ----
function dayKeyInTz(isoOrEpoch) {
  return DateTime.fromISO(String(isoOrEpoch), { zone: 'utc' })
                 .setZone(TZ)
                 .toFormat('yyyy-LL-dd');
}
function isWithinRange(isoOrEpoch) {
  const d = DateTime.fromISO(String(isoOrEpoch), { zone: 'utc' }).setZone(TZ);
  const start = DateTime.fromISO(dateFrom, { zone: TZ }).startOf('day');
  const end   = DateTime.fromISO(dateTo,   { zone: TZ }).endOf('day');
  return d >= start && d <= end;
}

// ---- Filtrado + dedup por record ID (cinturón y tirantes) ----
const reps = Array.from(activeRepNames).sort((a, b) => a.localeCompare(b));
const weeklyRecords = [];
const seenIds = new Set();

for (const item of weeklyItems) {
  const id = item.json.id ?? '';
  if (id && seenIds.has(id)) continue;   // dedup por ID, por las dudas
  if (id) seenIds.add(id);

  const row = item.json.fields ?? item.json;
  const created = row[CONFIG.createdField];
  if (!created || !isWithinRange(created)) continue;

  const minutes        = toNumber(row[CONFIG.minutesField]);
  const resolvedReps   = resolveRep(row[CONFIG.repField]);
  const rep            = resolvedReps[0] ?? '';
  const stage          = normalizeStage(row[CONFIG.stageField]);
  const lmtQuoteStage  = row['LMT - Quote Stage (For Follow Up)'];

  weeklyRecords.push({
    created,
    createdDateKey: dayKeyInTz(created),
    minutes, rep, stage, lmtQuoteStage,
  });
}

// ---- Summary ----
const summary = {
  Week_Start: dateFrom,
  Week_End:   dateTo,
  'Total_Leads (with Bradley)':  0,
  'Total_Leads (Active Reps)':   0,
  'Total_Quotes (with Bradley)': 0,
  'Total_Quotes (Active Reps)':  0,
  Avg_Response_Min: 0,
  Avg_Response_Time: '0m',
  Active_Reps: reps.length,
  Last_Refresh: DateTime.now().setZone(TZ).toISO(),
};

let activeLeadsCount = 0;
let activeQuotesCount = 0;
const byRep = {};
const dailyQuotesMap = {};

for (const rep of reps) {
  byRep[rep] = { Rep: rep, Leads: 0, Quotes: 0, total_quote_minutes: 0, quote_time_count: 0, Avg_Response_Min: '0 min', Avg_Response_Time: '0m' };
}

for (const row of weeklyRecords) {
  if (!row.rep || !allRepNames.has(row.rep)) continue;

  summary['Total_Leads (with Bradley)'] += 1;
  if (row.lmtQuoteStage) summary['Total_Quotes (with Bradley)'] += 1;

  if (EXCLUDED_REPS.includes(row.rep)) continue;

  if (!dailyQuotesMap[row.rep]) dailyQuotesMap[row.rep] = {};
  if (!dailyQuotesMap[row.rep][row.createdDateKey]) dailyQuotesMap[row.rep][row.createdDateKey] = 0;

  byRep[row.rep].Leads += 1;
  activeLeadsCount += 1;

  if (row.lmtQuoteStage) {
    byRep[row.rep].Quotes += 1;
    activeQuotesCount += 1;
    dailyQuotesMap[row.rep][row.createdDateKey] += 1;
  }
  if (row.lmtQuoteStage && row.minutes !== null && row.minutes > 0) {
    byRep[row.rep].total_quote_minutes += row.minutes;
    byRep[row.rep].quote_time_count += 1;
    summary.Avg_Response_Min += row.minutes;
  }
}

let overallQuoteTimeCount = 0;
const byRepRows = Object.values(byRep).map((r) => {
  if (r.quote_time_count > 0) {
    const avgMin = Number((r.total_quote_minutes / r.quote_time_count).toFixed(2));
    r.Avg_Response_Time = formatHours(avgMin);
    r.Avg_Response_Min  = `${avgMin.toFixed(2)} min`;
    overallQuoteTimeCount += r.quote_time_count;
  }
  delete r.total_quote_minutes;
  delete r.quote_time_count;
  return r;
});

let summaryAvgMin = 0;
if (overallQuoteTimeCount > 0) summaryAvgMin = Number((summary.Avg_Response_Min / overallQuoteTimeCount).toFixed(2));
summary.Avg_Response_Time = formatHours(summaryAvgMin);
summary.Avg_Response_Min  = `${summaryAvgMin.toFixed(2)} min`;
summary['Total_Leads (Active Reps)']  = activeLeadsCount;
summary['Total_Quotes (Active Reps)'] = activeQuotesCount;
summary.Quote_Rate_Pct      = activeLeadsCount ? `${((activeQuotesCount / activeLeadsCount) * 100).toFixed(2)}%` : '0%';
summary.Avg_Quotes_Per_Rep  = reps.length ? Number((activeQuotesCount / reps.length).toFixed(2)) : 0;

const rankedByQuotes = [...byRepRows].sort((a, b) => (b.Quotes !== a.Quotes) ? b.Quotes - a.Quotes : a.Rep.localeCompare(b.Rep));
summary.Top_Rep_By_Quotes   = rankedByQuotes[0]?.Rep ?? '';
summary.Top_Rep_Quote_Count = rankedByQuotes[0]?.Quotes ?? 0;

const repsWithResponse = byRepRows
  .map(r => ({ ...r, _minNum: parseFloat(r.Avg_Response_Min) }))
  .filter(r => Number.isFinite(r._minNum) && r._minNum > 0)
  .sort((a, b) => (a._minNum !== b._minNum) ? a._minNum - b._minNum : a.Rep.localeCompare(b.Rep));
summary.Fastest_Rep          = repsWithResponse[0]?.Rep ?? '';
summary.Fastest_Rep_Avg_Min  = repsWithResponse[0]?.Avg_Response_Min ?? '0 min';
summary.Fastest_Rep_Avg_Time = repsWithResponse[0]?.Avg_Response_Time ?? '';

// ---- Daily Quotes — bucketeo en Denver ----
const dailyRows = [];
const dates = [];
let cursor = DateTime.fromISO(dateFrom, { zone: TZ }).startOf('day');
const stop = DateTime.fromISO(dateTo,   { zone: TZ }).startOf('day');
while (cursor <= stop) {
  dates.push(cursor.toFormat('yyyy-LL-dd'));
  cursor = cursor.plus({ days: 1 });
}
for (const rep of reps) {
  const row = { Rep: rep };
  let total = 0;
  for (const d of dates) {
    const v = Number(dailyQuotesMap[rep]?.[d] ?? 0);
    row[d] = v;
    total += v;
  }
  row.Total = total;
  dailyRows.push(row);
}

return [
  { json: { sheet: 'Dashboard_Summary', data: [summary] } },
  { json: { sheet: 'Weekly_By_Rep',     data: byRepRows  } },
  { json: { sheet: 'Daily_Quotes',      data: dailyRows  } },
];
```

---

## 6. Nuevo `Code - Monthly Metrics`

Reemplazá TODO el contenido del nodo `Code - Monthly Metrics` por:

```javascript
// ============================================================
// MONTHLY METRICS - reescrito para webhook + Luxon
// ============================================================
const { DateTime } = require('luxon');

const allItems       = $('Airtable - Monthly Deals').all();
const activeRepItems = $('Airtable - Active Reps').all();
const payload        = $('Webhook').first().json;

const TZ       = payload.tz       || 'America/Denver';
const dateFrom = payload.dateFrom;
const dateTo   = payload.dateTo;

const EXCLUDED_REPS = ['Bradley Fry'];

const repIdToName = {};
const allRepNames = new Set();
for (const item of activeRepItems) {
  const row = item.json.fields ?? item.json;
  const fullName = String(row['Full Name'] ?? '').trim();
  const recordId = item.json.id ?? '';
  if (fullName) {
    allRepNames.add(fullName);
    if (recordId) repIdToName[recordId] = fullName;
  }
}
const activeRepNames = new Set([...allRepNames].filter(n => !EXCLUDED_REPS.includes(n)));

const CONFIG = {
  createdField: 'Date Created',
  repField:     'Sales',
  stageField:   'Stage',
  artworkField: 'LMT Art Sent To Customer (from Artwork)',
};

function resolveRep(value) {
  if (Array.isArray(value)) return value.map(v => resolveRep(v)).flat().filter(Boolean);
  let str = String(value ?? '').trim();
  if (!str) return [];
  str = str.replace(/^\d+:/, '');
  if (str.startsWith('rec') && repIdToName[str]) return [repIdToName[str]];
  if (allRepNames.has(str)) return [str];
  if (!str.startsWith('rec')) return [str];
  return [];
}
function normalizeStage(v) {
  if (Array.isArray(v)) return String(v[0] ?? '').trim();
  return String(v ?? '').trim();
}
function formatPct(num, den) {
  if (!den) return '0.00%';
  return `${((num / den) * 100).toFixed(2)}%`;
}
function isWithinRange(isoOrEpoch) {
  const d = DateTime.fromISO(String(isoOrEpoch), { zone: 'utc' }).setZone(TZ);
  const start = DateTime.fromISO(dateFrom, { zone: TZ }).startOf('day');
  const end   = DateTime.fromISO(dateTo,   { zone: TZ }).endOf('day');
  return d >= start && d <= end;
}

const monthLabel = `${dateFrom} → ${dateTo}`;  // ya no es "el mes corriente", es el rango pedido
const reps = Array.from(activeRepNames).sort((a, b) => a.localeCompare(b));
const byRep = {};
const seenIds = new Set();

let displayTotalLeads      = 0;
let displayTotalArtwork    = 0;
let displayTotalClosedWon  = 0;

for (const item of allItems) {
  const id = item.json.id ?? '';
  if (id && seenIds.has(id)) continue;
  if (id) seenIds.add(id);

  const row = item.json.fields ?? item.json;
  const created = row[CONFIG.createdField];
  if (!created || !isWithinRange(created)) continue;

  const resolvedReps = resolveRep(row[CONFIG.repField]);
  const rep = resolvedReps[0] ?? '';
  if (!rep || !allRepNames.has(rep)) continue;

  const artworkValue = row[CONFIG.artworkField];
  const hasArtwork = Array.isArray(artworkValue)
    ? artworkValue.length > 0
    : (artworkValue !== null && artworkValue !== undefined && artworkValue !== '');
  const isClosedWon = normalizeStage(row[CONFIG.stageField]) === 'Closed Won';

  displayTotalLeads += 1;
  if (hasArtwork)  displayTotalArtwork += 1;
  if (isClosedWon) displayTotalClosedWon += 1;

  if (EXCLUDED_REPS.includes(rep)) continue;
  if (!byRep[rep]) byRep[rep] = { total_leads: 0, artwork_reached: 0, closed_won: 0 };
  byRep[rep].total_leads += 1;
  if (hasArtwork)  byRep[rep].artwork_reached += 1;
  if (isClosedWon) byRep[rep].closed_won += 1;
}

const nowIso = DateTime.now().setZone(TZ).toISO();
const monthlyByRepRows = reps.map((rep) => {
  const d = byRep[rep] ?? { total_leads: 0, artwork_reached: 0, closed_won: 0 };
  return {
    Rep: rep,
    Month: monthLabel,
    Total_Leads:     d.total_leads,
    Artwork_Sent:    d.artwork_reached,
    Lead_to_Art_Pct: formatPct(d.artwork_reached, d.total_leads),
    Closed_Won:      d.closed_won,
    Close_Rate_Pct:  formatPct(d.closed_won, d.total_leads),
    Last_Refresh:    nowIso,
  };
});

const activeTotalLeads     = monthlyByRepRows.reduce((s, r) => s + r.Total_Leads, 0);
const activeTotalArtwork   = monthlyByRepRows.reduce((s, r) => s + r.Artwork_Sent, 0);
const activeTotalClosedWon = monthlyByRepRows.reduce((s, r) => s + r.Closed_Won, 0);

const monthlySummary = {
  Month: monthLabel,
  'Total_Leads (with Bradley)':       displayTotalLeads,
  'Total_Leads (Active Reps)':        activeTotalLeads,
  'Artwork_Sent (with Bradley)':      displayTotalArtwork,
  'Artwork_Sent (Active Reps)':       activeTotalArtwork,
  Lead_to_Art_Pct:                    formatPct(activeTotalArtwork,   activeTotalLeads),
  'Total_Closed_Won (with Bradley)':  displayTotalClosedWon,
  'Total_Closed_Won (Active Reps)':   activeTotalClosedWon,
  Close_Rate_Pct:                     formatPct(activeTotalClosedWon, activeTotalLeads),
  Active_Reps:                        reps.length,
  Last_Refresh:                       nowIso,
};

return [
  { json: { sheet: 'Monthly_Summary', data: [monthlySummary] } },
  { json: { sheet: 'Monthly_By_Rep',  data: monthlyByRepRows } },
];
```

---

## 7. Devolver el JSON al frontend (`Respond to Webhook`)

El frontend espera UN sólo JSON con esta forma:

```json
{
  "summary":          { ... },         // Dashboard_Summary
  "byRep":            [ {...}, ... ],  // Weekly_By_Rep
  "daily":            [ {...}, ... ],  // Daily_Quotes
  "monthlySummary":   { ... },         // Monthly_Summary
  "monthlyByRep":     [ {...}, ... ]   // Monthly_By_Rep
}
```

Agregá un **`Code` node** después de los dos `Code - Metrics` (en una rama merge) que agrupe todo:

```javascript
// Code node: "Assemble Response"
const weekly  = $('Code - Weekly Metrics').all();
const monthly = $('Code - Monthly Metrics').all();

const pick = (items, name) => items.find(i => i.json.sheet === name)?.json.data ?? [];

return [{
  json: {
    summary:        pick(weekly, 'Dashboard_Summary')[0] ?? {},
    byRep:          pick(weekly, 'Weekly_By_Rep'),
    daily:          pick(weekly, 'Daily_Quotes'),
    monthlySummary: pick(monthly, 'Monthly_Summary')[0] ?? {},
    monthlyByRep:   pick(monthly, 'Monthly_By_Rep'),
  }
}];
```

Conectalo a un nodo **`Respond to Webhook`**:

```yaml
Respond With:    JSON
Response Body:   {{ $json }}
Response Code:   200
Response Headers:
  Access-Control-Allow-Origin: https://<tu-dominio-vercel>.vercel.app
  Content-Type:                application/json
```

**Importante:** si querés mantener las hojas de Google Sheets también, agregá esa rama paralela. No es excluyente.

---

## 8. Snippet diagnóstico para los duplicados de Airtable

Como no estabas seguro de dónde vienen los "duplicados/triplicados", agregá temporalmente un **Code node** entre `Airtable - Weekly Deals` y `Code - Weekly Metrics` con este código y mirá el resultado:

```javascript
// DIAGNOSTIC ONLY — borrar después
const items = $input.all();
const total = items.length;

// Contar IDs únicos
const idCounts = {};
for (const it of items) {
  const id = it.json.id || '<no-id>';
  idCounts[id] = (idCounts[id] || 0) + 1;
}
const uniqueIds   = Object.keys(idCounts).length;
const duplicated  = Object.entries(idCounts).filter(([_, n]) => n > 1);

// Cómo se ve el campo Sales
const salesShapes = items.slice(0, 5).map(it => {
  const v = (it.json.fields ?? it.json).Sales;
  return {
    type: Array.isArray(v) ? `array(len=${v.length})` : typeof v,
    sample: v
  };
});

return [{ json: {
  total_items_returned: total,
  unique_record_ids:    uniqueIds,
  duplicated_ids:       duplicated.slice(0, 10), // primeros 10 si hay
  first_5_sales_fields: salesShapes,
}}];
```

Ejecutalo una vez y mandame el output. Con eso te confirmo si:
- **`total === uniqueIds`** → no hay dedup que hacer; el "duplicado" era confusión con el campo Sales multi-valor.
- **`total > uniqueIds`** → Airtable realmente repite records (raro). El `seenIds` que metí en el código nuevo ya lo cubre.
- **`first_5_sales_fields` muestra array de 2-3 reps** → cada deal tiene multi-rep, y la atribución a `resolvedReps[0]` está descartando reps. Decidir si querés mantener eso o atribuir por porción.

---

## 9. Checklist final antes de prod

- [ ] Borré `Schedule Trigger` y agregué `Webhook` con path `dashboard`
- [ ] Borré `Calculate Week Dates` y `Calculate Month Dates`
- [ ] Reemplacé `filterByFormula` en ambos nodos Airtable
- [ ] Reemplacé código de `Code - Weekly Metrics` y `Code - Monthly Metrics`
- [ ] Agregué `Assemble Response` + `Respond to Webhook`
- [ ] Setteé Workflow timezone a `America/Denver`
- [ ] Habilité CORS con el dominio Vercel (no `*` en prod)
- [ ] Frontend desplegado con `BUSINESS_TZ` apuntando a Denver
- [ ] Corrí el snippet diagnóstico una vez y borré el code temporal
- [ ] Active workflow en prod

---

## Apéndice: por qué este diseño es mejor

| Problema viejo | Por qué pasaba | Cómo lo resuelve esta migración |
|---|---|---|
| Semana corrida 3h | `new Date()` en BA generaba lunes 00:00 BA = domingo 21h Denver | Las fechas las da el usuario, no el reloj del servidor |
| Daily_Quotes en día equivocado | `getDate()` usaba TZ local del servidor | `dayKeyInTz()` con Luxon fuerza Denver |
| Filtro Airtable inexacto | DATETIME_PARSE asumía UTC sobre un campo que se mostraba en TZ del workspace | `SET_TIMEZONE` lo deja explícito |
| Hardcoded "esta semana / este mes" | Era batch horario, no on-demand | Webhook acepta cualquier rango |
| Doble-conteo si Airtable repitiera | Asume único pero no chequea | `seenIds` por record.id cubre el caso |

---

*Generado para PinProsPlus Dynamic Dashboard — migración v3 → webhook.*
