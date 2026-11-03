// Shared between the content script and the popup.
// Settings live in chrome.storage.sync (small), the watched list in chrome.storage.local.

const AS_DEFAULTS = {
  syncYouTube: true,          // send the "played to the end" signals to YouTube (history + red bar)
  seekOnWatchPage: true,      // on the watch page, jump the player to the end when marking (start when unmarking)
  playerButton: true,         // button in the player controls
  actionButton: true,         // button in the action row under the video (next to Share)
  thumbButtons: true,         // button on every thumbnail (on hover)
  autoMark: true,             // mark automatically when playback passes autoMarkPercent
  autoMarkPercent: 90,
  useNativeProgress: true,    // treat videos YouTube already shows as watched (red bar) as watched
  nativeThreshold: 90,
  dimWatched: true,           // dim thumbnails of watched videos
  hideWatched: false,         // hide watched videos from feeds (never on the watch page itself)
  hideShorts: true,           // hide Shorts shelves, Shorts cards and the Shorts menu entry
  hideMembers: false,         // hide "Members only" videos
  hidePlayables: true         // hide YouTube Playables (built-in games) shelves and menu entry
};

const AS_WATCHED_KEY = 'watched'; // { [videoId]: markedAtMs }

function asLoadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ settings: {} }, (data) => {
      resolve({ ...AS_DEFAULTS, ...(data.settings || {}) });
    });
  });
}

function asSaveSettings(settings) {
  return chrome.storage.sync.set({ settings });
}

function asLoadWatched() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [AS_WATCHED_KEY]: {} }, (data) => resolve(data[AS_WATCHED_KEY] || {}));
  });
}

// Read-modify-write on the watched map; fn mutates the map in place.
async function asUpdateWatched(fn) {
  const watched = await asLoadWatched();
  fn(watched);
  await chrome.storage.local.set({ [AS_WATCHED_KEY]: watched });
  return watched;
}
