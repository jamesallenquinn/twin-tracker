// Twin Tracker service worker
// Strategy: network-first for the app shell so new deploys always win;
// cache only as an offline fallback. Cross-origin requests (Firebase, gstatic)
// are NOT intercepted, so live sync behaves exactly as before.

const CACHE = "twin-tracker-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL).catch(function () {});
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) {
          if (k !== CACHE) return caches.delete(k);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  // Only handle same-origin navigations / shell GETs. Let everything else
  // (Firebase, gstatic SDK, etc.) go straight to the network untouched.
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" || url.pathname.endsWith("/index.html") || url.pathname === "/" || url.pathname.endsWith("/")) {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put(req, copy).catch(function () {});
          });
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || caches.match("./index.html");
          });
        })
    );
  }
});

// ---- Push (used in Phase 2) ----
self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Twin Tracker", body: event.data ? event.data.text() : "" };
  }
  var title = data.title || "Twin Tracker";
  var options = {
    body: data.body || "",
    icon: "https://i.ibb.co/Zzcnht8k/E47-ECDA6-E87-B-42-D2-92-E0-A4-C072-D94864.png",
    badge: "https://i.ibb.co/Zzcnht8k/E47-ECDA6-E87-B-42-D2-92-E0-A4-C072-D94864.png",
    tag: data.tag || undefined,
    data: { url: data.url || "./index.html" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ("focus" in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
