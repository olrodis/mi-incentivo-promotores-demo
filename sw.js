"use strict";

const BASE_URL = new URL("./", self.location.href);
const APP_ROOT_URL = new URL("./", BASE_URL).href;
const APP_ROOT_PATH = new URL(APP_ROOT_URL).pathname;
const SCOPE_KEY = APP_ROOT_PATH
  .replace(/[^a-z0-9]+/gi, "-")
  .replace(/^-+|-+$/g, "") || "root";
const APP_CACHE_PREFIX = "mp-incentivos-pwa-" + SCOPE_KEY + "-";
const PRIVATE_CACHE_PREFIX = "mp-incentivos-private-" + SCOPE_KEY + "-";
const LEGACY_CACHE_NAMES = new Set([
  "flow-control-pwa-shell-2026.09.14.2",
  "flow-control-pwa-runtime-2026.09.14.2",
  "flow-control-pwa-cdn-2026.09.14.2",
  "mp-incentivos-pwa-shell-2026.09.14.3"
]);
const CACHE_VERSION = "2026.09.28.4";
const SHELL_CACHE = APP_CACHE_PREFIX + "shell-" + CACHE_VERSION;
const ENCRYPTED_CACHE = PRIVATE_CACHE_PREFIX + "encrypted-" + CACHE_VERSION;
const LEGACY_DEMO_SHELL = APP_CACHE_PREFIX + "shell-2026.09.22.16";

const INDEX_URL = new URL("index.html", BASE_URL).href;
const MANIFEST_URL = new URL("manifest.json", BASE_URL).href;
const ICON_192_URL = new URL("icons/icon-192.png", BASE_URL).href;
const ICON_512_URL = new URL("icons/icon-512.png", BASE_URL).href;
const APPLE_ICON_URL = new URL("icons/apple-touch-icon.png", BASE_URL).href;
const BRAND_LOGO_URL = new URL("icons/mercado-pago-logo.png", BASE_URL).href;
const CHART_JS_URL = new URL("vendor/chart.umd.js", BASE_URL).href;
const LUCIDE_JS_URL = new URL("vendor/lucide.min.js", BASE_URL).href;
const ENCRYPTED_DATA_URL = new URL("data.enc.json", BASE_URL).href;
const CURRENT_APP_MARKER = 'name="mp-incentives-static-data" content="./data.enc.json"';

const LOCAL_SHELL = [
  APP_ROOT_URL,
  INDEX_URL,
  MANIFEST_URL,
  ICON_192_URL,
  ICON_512_URL,
  APPLE_ICON_URL,
  BRAND_LOGO_URL,
  CHART_JS_URL,
  LUCIDE_JS_URL
];
const LOCAL_SHELL_SET = new Set(LOCAL_SHELL);
const INDEX_PATH = new URL(INDEX_URL).pathname;

self.addEventListener("install", function (event) {
  // Un recurso auxiliar lento o bloqueado nunca debe retener la demo anterior.
  // El shell se guarda después de recibirlo correctamente durante la navegación.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    const replacingInstalledDemo = keys.includes(LEGACY_DEMO_SHELL);
    await Promise.all(keys.filter(function (key) {
      const staleCurrentAppCache = key.startsWith(APP_CACHE_PREFIX) && key !== SHELL_CACHE;
      const privateCache = key.startsWith(PRIVATE_CACHE_PREFIX);
      const legacyCache = LEGACY_CACHE_NAMES.has(key);
      return staleCurrentAppCache || privateCache || legacyCache;
    }).map(function (key) {
      return caches.delete(key);
    }));

    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.disable();
    }
    await self.clients.claim();
    if (replacingInstalledDemo) {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      await Promise.all(windows.map(async function (client) {
        const url = new URL(client.url);
        if (url.origin !== self.location.origin ||
            (url.pathname !== APP_ROOT_PATH && url.pathname !== INDEX_PATH)) return;
        try { await client.navigate(client.url); } catch (error) {
          // Algunos navegadores no permiten navegar desde el Service Worker.
        }
      }));
    }
  })());
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (event.data && event.data.type === "CLEAR_PRIVATE_DATA") {
    event.waitUntil(clearPrivateCaches());
  }
});

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;

  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (request.mode === "navigate") {
    if (url.origin === self.location.origin &&
        (url.pathname === APP_ROOT_PATH || url.pathname === INDEX_PATH)) {
      event.respondWith(networkFirstNavigation(request));
    }
    return;
  }

  /*
    Solo se guarda el shell y el paquete cifrado. Nunca se cachean perfiles
    descifrados, CSV ni respuestas de una API de promotores.
  */
  if (url.origin === self.location.origin) {
    const canonicalUrl = canonicalLocalUrl(url);
    if (canonicalUrl === ENCRYPTED_DATA_URL) {
      event.respondWith(networkFirstEncryptedData(request));
      return;
    }
    if (LOCAL_SHELL_SET.has(canonicalUrl)) {
      event.respondWith(staleWhileRevalidateShell(request, canonicalUrl, event));
    }
  }
});

async function networkFirstEncryptedData(request) {
  const cache = await caches.open(ENCRYPTED_CACHE);
  const controller = new AbortController();
  const timeoutId = setTimeout(function () {
    controller.abort();
  }, 4500);
  try {
    const response = await fetch(new Request(request, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal
    }));
    if (!response.ok) throw new Error("Encrypted data unavailable");
    try {
      await cache.put(ENCRYPTED_DATA_URL, response.clone());
    } catch (error) {
      // La falta de espacio de caché no debe impedir leer el corte de la red.
    }
    return response;
  } catch (error) {
    const cached = await cache.match(ENCRYPTED_DATA_URL);
    if (cached) return cached;
    return new Response("Encrypted data unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  const controller = new AbortController();
  const timeoutId = setTimeout(function () {
    controller.abort();
  }, 4500);

  try {
    const response = await fetch(new Request(request, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal
    }));
    if (!response.ok) throw new Error("Navigation unavailable");
    if (!(await response.clone().text()).includes(CURRENT_APP_MARKER)) {
      throw new Error("Unexpected app version");
    }
    try {
      await Promise.all([
        cache.put(INDEX_URL, response.clone()),
        cache.put(APP_ROOT_URL, response.clone())
      ]);
    } catch (error) {
      // Una caché llena no debe impedir abrir la versión recibida de la red.
    }
    return response;
  } catch (error) {
    const cached = await cache.match(INDEX_URL) || await cache.match(APP_ROOT_URL);
    if (cached) return cached;
    return new Response(
      "<!doctype html><html lang=\"es-MX\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>No se pudo actualizar</title><body><h1>No se pudo abrir Mi Incentivo</h1><p>No mostramos una versión anterior porque podría tener datos de demostración. Intenta abrirla de nuevo cuando tengas conexión.</p></body></html>",
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
      }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function staleWhileRevalidateShell(request, canonicalUrl, event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(canonicalUrl);
  const update = fetch(new Request(request, {
    cache: "no-cache",
    credentials: "same-origin"
  })).then(async function (response) {
    if (response.ok) await cache.put(canonicalUrl, response.clone());
    return response;
  });

  event.waitUntil(update.catch(function () {
    return undefined;
  }));

  if (cached) return cached;
  return update;
}

function canonicalLocalUrl(url) {
  const canonical = new URL(url.href);
  canonical.search = "";
  canonical.hash = "";
  return canonical.href;
}

async function clearPrivateCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter(function (key) {
    return key.startsWith(PRIVATE_CACHE_PREFIX);
  }).map(function (key) {
    return caches.delete(key);
  }));
}
