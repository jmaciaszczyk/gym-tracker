// BUMP VERSION ON EVERY DEPLOY, or installed apps keep running the old files.
const VERSION = 'gym-tracker-v1';
const FILES = ['./', 'index.html', 'app.js', 'db.js', 'logic.js', 'exercises.js', 'htm-preact.js', 'barlow-latin.woff2', 'barlow-latin-ext.woff2', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.oninstall = e => {
  self.skipWaiting();
  // cache: 'reload' bypasses the HTTP cache (GitHub Pages sends max-age=600), so a new VERSION gets fresh files.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
};
self.onactivate = e => e.waitUntil(caches.keys()
  // *.github.io is shared by all of the owner's sites: delete only our own old caches.
  .then(ks => Promise.all(ks.filter(k => k.startsWith('gym-tracker-') && k !== VERSION).map(k => caches.delete(k))))
  .then(() => self.clients.claim()));
self.onfetch = e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.registration.scope)) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
};
