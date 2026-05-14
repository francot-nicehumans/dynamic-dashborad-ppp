# Setup — Google Sheets como fuente del modo default

Guía para conectar `/api/dashboard-default` al Google Sheet privado.

Resumen del flujo: el frontend pide `/api/dashboard-default` → la edge function (1) dispara el webhook v3 patcheado y espera el refresh, (2) lee las 5 tabs del sheet con una Service Account, (3) devuelve un JSON listo para el dashboard.

Necesitás hacer **3 cosas** en orden:

1. Importar el v3 patched en n8n y obtener la URL del webhook nuevo
2. Crear una Service Account de Google y compartir el sheet con ella
3. Cargar las 4 env vars en Vercel y redesplegar

---

## 1. Reimportar el v3 patched en n8n

El archivo `n8n-workflow-v3-patched.json` es el v3 original **+** un nuevo nodo `Webhook - Refresh` (path `dashboard-refresh`). Mantiene también el Schedule Trigger horario, así que sigue corriendo solo.

Pasos:

1. En n8n: borrá (o desactivá) el v3 viejo para no tener dos cron pisándose.
2. **+** → **Import from File** → seleccioná `n8n-workflow-v3-patched.json`.
3. Reconectá credenciales:
   - 3 nodos Airtable → credential `Airtable Personal Access Token OFFICIAL | For Old Bases`
   - 5 nodos Google Sheets → tu credencial de GS de siempre
4. **Activá** el workflow (toggle arriba a la derecha).
5. Probalo manualmente con curl o Postman para confirmar que responde 200:
   ```bash
   curl -X POST "https://api.pinprosplus.com/webhook/dashboard-refresh" \
     -H "Content-Type: application/json" \
     -d '{}' -i
   ```
   Tiene que devolver 200 después de 5-15 segundos (el workflow corre completo antes de responder).

**Guardá esta URL** — la vas a usar como env var en Vercel: `https://api.pinprosplus.com/webhook/dashboard-refresh`

---

## 2. Crear Service Account y compartir el sheet

### 2.1 Crear el SA en Google Cloud

1. Andá a https://console.cloud.google.com/
2. Si no tenés proyecto: **Create Project** → nombre `pinprosplus-dashboard` (o cualquiera).
3. Buscá **"Sheets API"** en el menú lateral → **Enable**.
4. Menú lateral → **IAM & Admin → Service Accounts** → **Create Service Account**:
   - Name: `dashboard-reader`
   - ID: queda autogenerado (`dashboard-reader@<project>.iam.gserviceaccount.com`)
   - Skip los roles opcionales (no necesita ninguno).
5. Click en la SA recién creada → tab **Keys** → **Add Key → Create new key → JSON** → descargás un archivo `dashboard-reader-XXX.json`.

### 2.2 Compartir el sheet con la SA

1. Abrí el JSON descargado y copiá el campo `client_email` (algo como `dashboard-reader@pinprosplus-dashboard.iam.gserviceaccount.com`).
2. Abrí el sheet: https://docs.google.com/spreadsheets/d/1n3BPm6ZdjIYGlGqZcpTPlX8jbRVc6_O01dTFo12ZbCg
3. Botón **Share** → pegá el email de la SA → permiso **Viewer** → uncheck "Notify people" → **Share**.

El sheet sigue privado para todos los demás. Solo la SA puede leerlo.

---

## 3. Configurar env vars en Vercel

Andá a tu proyecto Vercel → **Settings → Environment Variables** → agregá las 4:

| Variable | Valor | Notas |
|---|---|---|
| `SHEET_ID` | `1n3BPm6ZdjIYGlGqZcpTPlX8jbRVc6_O01dTFo12ZbCg` | Sale del URL del sheet (entre `/d/` y `/edit`) |
| `GOOGLE_SA_EMAIL` | `dashboard-reader@...iam.gserviceaccount.com` | Campo `client_email` del JSON |
| `GOOGLE_SA_PRIVATE_KEY` | `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n` | Campo `private_key` del JSON — **mantené los `\n` literales** (Vercel los acepta tal cual) |
| `N8N_V3_WEBHOOK_URL` | `https://api.pinprosplus.com/webhook/dashboard-refresh` | URL del webhook nuevo del v3 patched |

> **Importante con `GOOGLE_SA_PRIVATE_KEY`:** copiala del JSON como una sola línea con `\n` (dos caracteres: backslash + n) — Vercel preserva esos como literales y la edge function los convierte a saltos de línea reales al cargarla. **No hagas split en líneas reales en el campo de Vercel**, te lo rompe.

Aplicá las 4 env vars a los 3 environments (Production, Preview, Development).

**Después de agregarlas: hay que redeployar para que tomen efecto.** Vercel no las inyecta retroactivamente. Para forzar: andá a Deployments → último deploy → **⋯** → **Redeploy**. O hacé cualquier commit a main.

---

## 4. Verificar que funciona

Una vez redeployado:

```bash
# 1. Test directo de la edge function (debe devolver el JSON completo en ~5-15s)
curl -i "https://project-95dp8.vercel.app/api/dashboard-default"

# 2. Inspeccionar el _meta del response
curl -s "https://project-95dp8.vercel.app/api/dashboard-default" | python -m json.tool | head -50
```

En el campo `_meta.refresh` vas a ver:
- `{ "skipped": true }` → no había `N8N_V3_WEBHOOK_URL` configurada (revisá env vars)
- `{ "ok": true, "elapsed_ms": 8432 }` → v3 corrió OK
- `{ "ok": false, "status": 500 }` → v3 falló, mirá los logs de n8n

Y abrí el dashboard en el browser: tiene que aparecer "Source: Google Sheet" en el header arriba.

---

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `500 — Missing SHEET_ID` | Env var no cargada | Verificá Vercel → Env Vars + redeploy |
| `502 — Auth failed` | SA mal configurada | Confirmá que el SA email tenga acceso de Viewer al sheet |
| `502 — Auth failed: PEM routines` | `GOOGLE_SA_PRIVATE_KEY` mal copiada | Re-copiá del JSON original, manteniendo `\n` como dos caracteres |
| `502 — Sheets API: 403` | SA no tiene acceso al sheet | Compartí el sheet con el SA email (Viewer) |
| `502 — Sheets API: 404` | `SHEET_ID` incorrecto o sheet borrado | Verificá el ID en el URL del sheet |
| Datos viejos en el dashboard | `N8N_V3_WEBHOOK_URL` mal o v3 fallando | Mirá `_meta.refresh` en el response |
| Página tarda >20s en cargar | v3 está lento o congelado | Mirá logs de n8n; opcional: cambiar a "background" en vez de esperar |

---

## Apéndice: si después querés cambiar a "background" (no esperar el refresh)

En `api/dashboard-default.js`, reemplazá:
```js
const refreshResult = await triggerV3Refresh();
```
por:
```js
// fire-and-forget — no bloqueamos al usuario actual
const refreshPromise = triggerV3Refresh();
const refreshResult = { skipped: false, ok: 'pending', fire_and_forget: true };
```

Y al final, antes del `return`, podés esperar opcionalmente con un timeout corto:
```js
await Promise.race([refreshPromise, new Promise(r => setTimeout(r, 500))]);
```

Con eso: la página carga en <1s (cae sobre el sheet stale), y v3 sigue refrescando en background para el próximo visitante.
