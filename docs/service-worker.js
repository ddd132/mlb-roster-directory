const SCOPE = new URL(self.registration.scope);
const PREFIX = `mlb-directory:${SCOPE.pathname}:`;
const CORE = PREFIX + "core-v1";
const STATS = PREFIX + "stats-v1";
const STATS_LIMIT = 48;
const MLB_API = "https://statsapi.mlb.com";
const SAVED_MESSAGE = "mlb-pwa-saved-data";

const PAGES = [
  "", "index.html", "search.html", "history.html", "player.html",
  "leaders.html", "league-trends.html", "standings.html", "minors.html", "offline.html",
];
const ESSENTIALS = [
  ...PAGES,
  "app.webmanifest", "pwa.js", "pwa.css", "pwa-icon-180.png", "pwa-icon-192.png", "pwa-icon-512.png",
  "styles.css", "player.css", "team-details.css", "comparison.css", "career-trend.css", "ability.css",
  "minors.css", "search.css", "leader-scatter.css", "league-trends.css",
  "mlb.js", "app.js", "player.js", "finder.js", "search.js", "player-search.js", "finder-links.js",
  "history-data.js", "history.js", "leaders.js", "scatter-data.js", "leader-scatter.js",
  "league-trends.js", "league-metrics.js", "standings.js", "minors.js",
  "team-details.js", "depth-view.js", "contracts-view.js", "transactions.js",
  "advanced.js", "ability.js", "percentiles.js", "career-trend.js", "career-metrics.js", "compare.js", "compare-data.js",
  "assets/baseball.png", "assets/player-silhouette.webp",
  "data/rosters.json", "data/league-trends.json", "finder-labels.json",
];
const OPTIONAL = [
  "assets/inter.woff2", "assets/barlow-normal-800.woff2", "assets/barlow-italic-800.woff2", "assets/dodger-stadium.webp",
  "data/player-search.json.gz", "history-archive.json.gz", "standings-archive.json.gz",
  "team-details.json.gz", "data/minor-league-rosters.json", "data/pipeline-rankings.json",
  ...[108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 133,
    134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 158]
    .map(id => `assets/teams/${id}.png`),
];

const inScope = url => url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname);
const absolute = path => new URL(path, SCOPE).href;
const installRequest = path => new Request(absolute(path), { cache: "reload" });

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE);
    await cache.addAll(ESSENTIALS.map(installRequest));
    await Promise.allSettled(OPTIONAL.map(path => cache.add(installRequest(path))));
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CORE && key !== STATS)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isPublicStatRequest(url) {
  // Live roster and transaction requests use the page's own freshness handling.
  return url.origin === MLB_API
    && /^\/api\/v1\/(?:people\/\d+(?:\/stats)?|stats|seasons\/all|schedule|standings|teams)$/.test(url.pathname);
}

function canSave(response, isStats) {
  const type = response.headers.get("Content-Type") ?? "";
  const length = Number(response.headers.get("Content-Length") || 0);
  return response.status === 200 && !response.redirected && response.type !== "opaque"
    && !/\bno-store\b/i.test(response.headers.get("Cache-Control") ?? "")
    && (!isStats || (/json/i.test(type) && length <= 4 * 1024 * 1024));
}

async function remember(cacheName, key, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(key, response);
    if (cacheName === STATS) {
      const keys = await cache.keys();
      await Promise.all(keys.slice(0, Math.max(0, keys.length - STATS_LIMIT)).map(entry => cache.delete(entry)));
    }
  } catch {
    // A blocked or full cache must not interrupt a successful network response.
  }
}

async function savedResponse(cacheName, key) {
  try {
    const cache = await caches.open(cacheName);
    return await cache.match(key);
  } catch {
    return undefined;
  }
}

async function notifyPage(event) {
  const client = await self.clients.get(event.clientId || event.resultingClientId);
  client?.postMessage({ type: SAVED_MESSAGE });
}

async function networkFirst(event, key, cacheName, navigation, data) {
  let response;
  try {
    response = await fetch(event.request);
  } catch {
    // A failed connection can still use the last successful response.
  }
  if (response?.ok) {
    if (canSave(response, cacheName === STATS)) event.waitUntil(remember(cacheName, key, response.clone()));
    return response;
  }
  if (response && response.status < 500) return response;
  const saved = await savedResponse(cacheName, key);
  if (saved) {
    if (navigation || data) event.waitUntil(notifyPage(event).catch(() => {}));
    return saved;
  }
  if (navigation && await savedResponse(CORE, absolute("offline.html"))) {
    return Response.redirect(absolute("offline.html"));
  }
  return response ?? Response.error();
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET" || request.cache === "no-store" || request.headers.has("Authorization")
    || request.headers.has("Range")) return;
  const url = new URL(request.url);
  if (request.mode === "navigate" && inScope(url)) {
    event.respondWith(networkFirst(event, url.origin + url.pathname, CORE, true, false));
  } else if (isPublicStatRequest(url)) {
    event.respondWith(networkFirst(event, request, STATS, false, true));
  } else if (inScope(url) && /\.(?:js|css|json|gz|csv|webmanifest|png|webp|woff2)$/i.test(url.pathname)) {
    const data = /\.(?:json|gz|csv)$/i.test(url.pathname);
    event.respondWith(networkFirst(event, url.origin + url.pathname, CORE, false, data));
  }
});
