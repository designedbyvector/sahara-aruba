// ══════════════════════════════════════════════════════════
//  SERVICE WORKER — Polvo del Sahara · Aruba
//  Maneja notificaciones en segundo plano
// ══════════════════════════════════════════════════════════

const CACHE_NAME = "sahara-aruba-v1";
const LAT = 12.5211, LON = -69.9683;

const LV = {
  low:      { label: "Normal",   emoji: "✅" },
  moderate: { label: "Moderado", emoji: "🟡" },
  high:     { label: "Alto",     emoji: "🟠" },
  veryHigh: { label: "Muy Alto", emoji: "🔴" }
};

// ─── Install & Activate ───────────────────────────────────
self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(["./", "./index.html", "./manifest.json"])
    )
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(clients.claim());
  // Start periodic check on activate
  scheduleCheck();
});

// ─── Fetch (cache-first for app shell) ───────────────────
self.addEventListener("fetch", e => {
  // Only cache same-origin requests (not the API)
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ─── Periodic dust check ──────────────────────────────────
function scheduleCheck() {
  // Check every 6 hours using setTimeout chain
  checkDust();
  setTimeout(() => scheduleCheck(), 6 * 60 * 60 * 1000);
}

async function checkDust() {
  try {
    const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
    url.searchParams.set("latitude",     LAT);
    url.searchParams.set("longitude",    LON);
    url.searchParams.set("hourly",       "dust,pm10,pm2_5");
    url.searchParams.set("forecast_days","5");
    url.searchParams.set("timezone",     "America/Aruba");

    const res = await fetch(url.toString());
    if (!res.ok) return;
    const data = await res.json();
    const forecast = processForecast(data);
    sendAlertsIfNeeded(forecast);
  } catch (e) {
    console.warn("[SW] Dust check failed:", e);
  }
}

// ─── Process API data ─────────────────────────────────────
function processForecast(data) {
  const { time, dust, pm10, pm2_5: pm25 } = data.hourly;
  const map = {};
  time.forEach((t, i) => {
    const day = t.split("T")[0];
    if (!map[day]) map[day] = { dust: [], pm10: [], pm25: [] };
    if (dust[i]  !== null) map[day].dust.push(dust[i]);
    if (pm10[i]  !== null) map[day].pm10.push(pm10[i]);
    if (pm25[i]  !== null) map[day].pm25.push(pm25[i]);
  });
  const mx = a => a.length ? Math.max(...a) : 0;
  return Object.entries(map).map(([date, v]) => ({
    date,
    dustMax: mx(v.dust),
    pm10Max: mx(v.pm10),
    level: classify(mx(v.dust))
  }));
}

function classify(v) {
  if (v < 50)  return "low";
  if (v < 200) return "moderate";
  if (v < 800) return "high";
  return "veryHigh";
}

function todayStr() { return new Date().toISOString().split("T")[0]; }

// ─── Fire notifications ───────────────────────────────────
async function sendAlertsIfNeeded(forecast) {
  // Load previously sent alerts from IDB
  const sent = await loadSentAlerts();
  const today = todayStr();

  // Clean old entries
  Object.keys(sent).forEach(k => { if (k < today) delete sent[k]; });

  let updated = false;

  for (const day of forecast) {
    const dayDate = new Date(day.date + "T12:00:00");
    const now = new Date(); now.setHours(12, 0, 0, 0);
    const diff = Math.round((dayDate - now) / 864e5);

    // Alert 1 or 2 days ahead, moderate or worse
    if ((diff === 1 || diff === 2) && day.level !== "low") {
      const key = `${day.date}_${diff}`;
      if (!sent[key]) {
        const lv = LV[day.level];
        const when = diff === 1 ? "mañana" : "pasado mañana";
        await showNotification(
          `${lv.emoji} Polvo del Sahara — ${lv.label}`,
          `Se pronostica polvo ${lv.label.toLowerCase()} para ${when} en Aruba.\n` +
          `Máx: ${Math.round(day.dustMax)} μg/m³ · PM10: ${Math.round(day.pm10Max)} μg/m³`,
          `dust-${key}`,
          day.level
        );
        sent[key] = true;
        updated = true;
      }
    }

    // Alert if very high today
    if (diff === 0 && (day.level === "high" || day.level === "veryHigh")) {
      const key = `today_${today}`;
      if (!sent[key]) {
        const lv = LV[day.level];
        await showNotification(
          `${lv.emoji} Polvo Activo AHORA — Aruba`,
          `Nivel ${lv.label} en este momento.\nConcentración: ${Math.round(day.dustMax)} μg/m³ — Toma precauciones.`,
          `dust-now-${today}`,
          day.level
        );
        sent[key] = true;
        updated = true;
      }
    }
  }

  if (updated) await saveSentAlerts(sent);
}

async function showNotification(title, body, tag, level) {
  const urgency = level === "veryHigh" || level === "high";
  return self.registration.showNotification(title, {
    body,
    tag,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-96.png",
    requireInteraction: urgency,
    vibrate: urgency ? [200, 100, 200, 100, 400] : [200, 100, 200],
    data: { url: self.registration.scope, level }
  });
}

// ─── Notification click → open app ───────────────────────
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil(
    clients.matchAll({ type: "window" }).then(list => {
      const existing = list.find(c => c.url === url);
      return existing ? existing.focus() : clients.openWindow(url);
    })
  );
});

// ─── Messages from main page ──────────────────────────────
self.addEventListener("message", e => {
  if (e.data?.type === "FORECAST") {
    // Page sent fresh forecast — check for alerts
    sendAlertsIfNeeded(e.data.forecast);
  }
  if (e.data?.type === "CHECK_NOW") {
    checkDust();
  }
});

// ─── IndexedDB helpers for persisting sent alerts ─────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("SaharaAlerts", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("alerts");
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function loadSentAlerts() {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction("alerts", "readonly");
      const req = tx.objectStore("alerts").get("sent");
      req.onsuccess = () => res(req.result || {});
      req.onerror   = () => rej(req.error);
    });
  } catch { return {}; }
}

async function saveSentAlerts(data) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction("alerts", "readwrite");
      const req = tx.objectStore("alerts").put(data, "sent");
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  } catch { /* silent */ }
}
