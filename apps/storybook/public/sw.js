/**
 * Minimal service worker.
 *
 * Chrome's URL-bar install icon and `beforeinstallprompt` event still
 * require a service worker with a `fetch` handler (as of Chrome 112/108
 * on desktop/mobile the SW requirement was lifted for the menu-install
 * path, but NOT for the ambient install prompt — see
 * https://developer.chrome.com/blog/update-install-criteria).
 *
 * This SW exists only to satisfy that criterion — it's a pass-through
 * fetch handler so the PWA becomes installable. Real caching, offline
 * support, and push all land in slice 2 of the PWA plan (post-MVP).
 */

self.addEventListener("fetch", (event) => {
  // Pass-through: do nothing. The handler's mere presence is what Chrome
  // looks for; we don't want to interfere with the app's network behaviour
  // until slice 2 lands.
});