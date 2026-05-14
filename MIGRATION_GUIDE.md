# Migración a Webhook + Timezone Denver — Guía operativa

> **⚠️ Nota importante (v4.1):** En n8n >= 2.20 los Code nodes corren en un
> task runner externo que **bloquea `require('luxon')`** por whitelist de
> módulos. Por eso este workflow usa **`Intl.DateTimeFormat` puro de JS**
> (vanilla, sin imports). El comportamiento es el mismo, y los tests
> confirman bucketing correcto en Denver incluso cruzando DST.


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
| 6 | `Code - Weekly Metrics` | Reemplazar JS por versión con Intl (vanilla JS) |
| 7 | `Code - Monthly Metrics` | Reemplazar JS por versión con Intl (vanilla JS) |
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
// Código completo (sin Luxon, usa Intl puro) — está en el archivo
// n8n-workflow-webhook.json del repo. Si reimportás ese workflow, ya viene
// con este código adentro. Si querés ver el código standalone, abrí el JSON
// y buscá el campo 'jsCode' del nodo 'Code - Weekly Metrics'.
```

---

## 6. Nuevo `Code - Monthly Metrics`

Reemplazá TODO el contenido del nodo `Code - Monthly Metrics` por:

```javascript
// Código completo (sin Luxon, usa Intl puro) — está en el archivo
// n8n-workflow-webhook.json del repo. Si reimportás ese workflow, ya viene
// con este código adentro. Si querés ver el código standalone, abrí el JSON
// y buscá el campo 'jsCode' del nodo 'Code - Monthly Metrics'.
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
// Code node: "Assemble Response" — v4.1, asume que Weekly/Monthly Metrics
// devuelven UN solo item con dashboard_summary / weekly_by_rep / etc.
const weeklyOut  = $('Code - Weekly Metrics').first()?.json  ?? {};
const monthlyOut = $('Code - Monthly Metrics').first()?.json ?? {};

return [{
  json: {
    summary:        weeklyOut.dashboard_summary ?? {},
    byRep:          weeklyOut.weekly_by_rep     ?? [],
    daily:          weeklyOut.daily_quotes      ?? [],
    monthlySummary: monthlyOut.monthly_summary  ?? {},
    monthlyByRep:   monthlyOut.monthly_by_rep   ?? [],
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

*Generado para PinPros