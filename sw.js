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
const CACHE_VERSION = "2026.09.22.16";
const SHELL_CACHE = APP_CACHE_PREFIX + "shell-" + CACHE_VERSION;

const INDEX_URL = new URL("index.html", BASE_URL).href;
const MANIFEST_URL = new URL("manifest.json", BASE_URL).href;
const ICON_192_URL = new URL("icons/icon-192.png", BASE_URL).href;
const ICON_512_URL = new URL("icons/icon-512.png", BASE_URL).href;
const APPLE_ICON_URL = new URL("icons/apple-touch-icon.png", BASE_URL).href;
const BRAND_LOGO_URL = new URL("icons/mercado-pago-logo.png", BASE_URL).href;

const LOCAL_SHELL = [
  APP_ROOT_URL,
  INDEX_URL,
  MANIFEST_URL,
  ICON_192_URL,
  ICON_512_URL,
  APPLE_ICON_URL,
  BRAND_LOGO_URL
];
const LOCAL_SHELL_SET = new Set(LOCAL_SHELL);
const INDEX_PATH = new URL(INDEX_URL).pathname;

self.addEventListener("install", function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(SHELL_CACHE);
    const requests = LOCAL_SHELL.map(function (url) {
      return new Request(url, { cache: "reload", credentials: "same-origin" });
    });

    /*
      La instalación es atómica: si falta un recurso crítico, la versión anterior
      permanece activa y conserva una experiencia offline válida.
    */
    await cache.addAll(requests);
  })());
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
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
    event.respondWith(staleWhileRevalidateNavigation(request, event));
    return;
  }

  /*
    Privacidad: solo el shell conocido puede entrar en Cache Storage. Cualquier
    JSON, CSV, endpoint de perfiles o recurso futuro usa la red y nunca se guarda.
  */
  if (url.origin === self.location.origin) {
    const canonicalUrl = canonicalLocalUrl(url);
    if (LOCAL_SHELL_SET.has(canonicalUrl)) {
      event.respondWith(staleWhileRevalidateShell(request, canonicalUrl, event));
    }
  }
});

async function staleWhileRevalidateNavigation(request, event) {
  const requestUrl = new URL(request.url);
  const canUpdateShell = requestUrl.pathname === APP_ROOT_PATH || requestUrl.pathname === INDEX_PATH;
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(INDEX_URL) || await cache.match(APP_ROOT_URL);
  const controller = new AbortController();
  const timeoutId = setTimeout(function () {
    controller.abort();
  }, 3500);

  const update = fetch(new Request(request, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal
    })).then(async function (response) {
      if (response && response.ok && canUpdateShell) {
        await Promise.all([
          cache.put(INDEX_URL, response.clone()),
          cache.put(APP_ROOT_URL, response.clone())
        ]);
      }

      if (response && (response.ok || response.status < 500)) return response;
      throw new Error("Navigation failed with status " + (response ? response.status : "unknown"));
    }).finally(function () {
      clearTimeout(timeoutId);
    });

  if (cached) {
    event.waitUntil(update.catch(function () {
      return undefined;
    }));
    return cached;
  }

  try {
    return await update;
  } catch (error) {
    return new Response(
      "<!doctype html><html lang=\"es-MX\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Sin conexión</title><body><h1>Sin conexión</h1><p>Abre la aplicación una vez con internet para habilitar el modo offline.</p></body></html>",
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
      }
    );
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
