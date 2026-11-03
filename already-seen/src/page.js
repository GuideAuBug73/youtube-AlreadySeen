// Runs in the page's own JavaScript world (MAIN), so it can use ytcfg, the player API
// and the account cookies. It talks to content.js through CustomEvents on document.
//
// Marking works like yt-dlp's --mark-watched: fetch the video's player response, take the
// playbackTracking URLs (videostatsPlaybackUrl / videostatsWatchtimeUrl) and ping them as if
// playback had reached the end. YouTube then adds the video to the account's history and
// stores the resume position near the end, which is what draws the full red bar.
//
// Unmarking removes the video from the account's watch history, like the "Remove from watch
// history" menu of youtube.com/feed/history: that also removes the red bar. A "position 0"
// watchtime ping does not work, YouTube ignores it once a video is complete.
(() => {
  'use strict';

  const REQUEST_EVENT = 'alreadyseen:request';
  const RESPONSE_EVENT = 'alreadyseen:response';
  const CPN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  const cfg = (key) => {
    try { return window.ytcfg?.get?.(key); } catch (e) { return undefined; }
  };

  const player = () => document.getElementById('movie_player');

  function makeCpn() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let cpn = '';
    for (const b of bytes) cpn += CPN_ALPHABET[b & 63];
    return cpn;
  }

  function isLoggedIn() {
    return cfg('LOGGED_IN') === true;
  }

  function authHeaders() {
    const headers = {
      'X-YouTube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
      'X-YouTube-Client-Version': cfg('INNERTUBE_CLIENT_VERSION') || cfg('INNERTUBE_CONTEXT')?.client?.clientVersion || '2.20260101.00.00'
    };
    // Without the identity token, signed-in pbj requests only get {"reload":"now"}.
    const optional = {
      'X-YouTube-Identity-Token': cfg('ID_TOKEN'),
      'X-Goog-Visitor-Id': cfg('VISITOR_DATA'),
      'X-YouTube-Page-CL': cfg('PAGE_CL'),
      'X-YouTube-Page-Label': cfg('PAGE_BUILD_LABEL')
    };
    for (const [name, value] of Object.entries(optional)) {
      if (value !== undefined && value !== null && value !== '') headers[name] = String(value);
    }
    const sessionIndex = cfg('SESSION_INDEX');
    if (sessionIndex !== undefined && sessionIndex !== null) headers['X-Goog-AuthUser'] = String(sessionIndex);
    const pageId = cfg('DELEGATED_SESSION_ID'); // brand accounts
    if (pageId) headers['X-Goog-PageId'] = pageId;
    return headers;
  }

  function extractPlayerResponse(json) {
    const parts = Array.isArray(json) ? json : [json];
    for (const part of parts) {
      if (part?.playerResponse) return part.playerResponse;
    }
    return null;
  }

  async function fetchPlayerResponse(videoId) {
    // The video currently loaded in the player: reuse its response, no request needed.
    try {
      const current = player()?.getPlayerResponse?.();
      if (current?.videoDetails?.videoId === videoId && current.playbackTracking) return current;
    } catch (e) { /* player not ready */ }

    // Light JSON version of the watch page (~500 KB), same data yt-dlp scrapes from the HTML.
    try {
      const r = await fetch(`/watch?v=${encodeURIComponent(videoId)}&pbj=1`, {
        credentials: 'include',
        headers: authHeaders()
      });
      if (r.ok) {
        // Signed-in responses start with the XSSI guard )]}'
        const text = (await r.text()).replace(/^\)\]\}'\s*/, '');
        const pr = extractPlayerResponse(JSON.parse(text));
        if (pr?.playbackTracking) return pr;
      }
    } catch (e) { /* fall through to HTML */ }

    const r = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: 'include' });
    const html = await r.text();
    const m = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var |<\/script>)/s);
    if (!m) throw new Error('player response introuvable');
    return JSON.parse(m[1]);
  }

  function buildUrl(baseUrl, params) {
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return url.toString();
  }

  async function ping(url) {
    // s.youtube.com is same-site, so the account cookies go along; the response is opaque.
    await fetch(url, { mode: 'no-cors', credentials: 'include', cache: 'no-store', keepalive: true });
  }

  // pickPosition(length) returns the position (seconds) to report.
  async function sendPositionSignals(videoId, pickPosition) {
    const pr = await fetchPlayerResponse(videoId);
    const tracking = pr?.playbackTracking;
    const playbackUrl = tracking?.videostatsPlaybackUrl?.baseUrl;
    const watchtimeUrl = tracking?.videostatsWatchtimeUrl?.baseUrl;
    if (!playbackUrl || !watchtimeUrl) {
      const reason = pr?.playabilityStatus?.reason || pr?.playabilityStatus?.status || 'pas de suivi de lecture';
      throw new Error(reason);
    }

    const lenFromUrl = parseFloat(new URL(playbackUrl).searchParams.get('len'));
    const length = lenFromUrl > 0 ? lenFromUrl : parseFloat(pr.videoDetails?.lengthSeconds) || 0;
    if (!(length > 0)) throw new Error('durée inconnue (direct ?)');

    const position = Math.min(Math.max(pickPosition(length), 0), length).toFixed(3);
    const cpn = makeCpn();
    const common = { ver: 2, cpn, cmt: position, el: 'detailpage' };

    await ping(buildUrl(playbackUrl, common));
    // st/et describe the watched segment; this one is what ends up in the history.
    await ping(buildUrl(watchtimeUrl, { ...common, st: 0, et: position }));
    return { length, position: Number(position), title: pr.videoDetails?.title || '' };
  }

  // Just before the end, like yt-dlp (more reliable than the exact end).
  const sendWatchedSignals = (videoId) => sendPositionSignals(videoId, (length) => length - 1);

  // Saving a position on the watch page: move the player there and pause, so that its own
  // later pings report the same position instead of where playback really was.
  function seekCurrentPlayerTo(videoId, seconds) {
    const p = player();
    try {
      if (p?.getVideoData?.().video_id !== videoId) return;
      p.pauseVideo();
      p.seekTo(seconds, true);
    } catch (e) { /* ignore */ }
  }

  // On the watch page, also move the real player to the end, so that its own later
  // watchtime pings (sent on pause / navigation) don't overwrite our position.
  function seekCurrentPlayerToEnd(videoId) {
    const p = player();
    try {
      if (p?.getVideoData?.().video_id !== videoId) return false;
      const duration = p.getDuration?.();
      if (!(duration > 2)) return false;
      // Pause first: reaching the real end would start the autoplay countdown.
      p.pauseVideo();
      p.seekTo(duration - 1, true);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function sha1Hex(text) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function readCookie(name) {
    const entry = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    return entry ? entry.slice(name.length + 1) : null;
  }

  // POST to the InnerTube API as the signed-in user (same Authorization header as youtube.com).
  async function innertube(endpoint, body) {
    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
    if (!sapisid) throw new Error('cookie de session introuvable');
    const ts = Math.floor(Date.now() / 1000);
    const headers = {
      ...authHeaders(),
      'Content-Type': 'application/json',
      'X-Origin': location.origin,
      Authorization: `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${location.origin}`)}`
    };
    const r = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context: cfg('INNERTUBE_CONTEXT'), ...body })
    });
    if (!r.ok) throw new Error(`${endpoint} : HTTP ${r.status}`);
    return r.json();
  }

  // Finds the "remove from history" token of videoId in a FEhistory browse response.
  // Only tokens nested inside that video's own entry are taken, and never one behind a
  // confirmation dialog (that is the "clear all watch history" button).
  function findRemovalToken(json, videoId) {
    let token = null;
    const walk = (node, currentId, inDialog) => {
      if (token || !node || typeof node !== 'object') return;
      const id = node.videoId || node.contentId || currentId;
      const dialog = inDialog || Boolean(node.confirmDialogEndpoint || node.confirmDialogRenderer);
      const fb = node.feedbackEndpoint;
      if (fb?.feedbackToken && id === videoId && !dialog &&
          (fb.uiActions?.hideEnclosingContainer || fb.actions?.some((a) => a.replaceEnclosingAction))) {
        token = fb.feedbackToken;
        return;
      }
      for (const key of Object.keys(node)) walk(node[key], id, dialog);
    };
    walk(json, null, false);
    return token;
  }

  async function removeFromHistory(videoId, title) {
    // History search works on titles, not ids; the unfiltered page covers recent views.
    const attempts = title ? [{ query: title }, {}] : [{}];
    for (const extra of attempts) {
      const page = await innertube('browse', { browseId: 'FEhistory', ...extra });
      const token = findRemovalToken(page, videoId);
      if (token) {
        await innertube('feedback', { feedbackTokens: [token], isFeedbackTokenUnencrypted: false, shouldMerge: false });
        return true;
      }
    }
    return false;
  }

  async function videoTitle(videoId) {
    try {
      const current = player()?.getVideoData?.();
      if (current?.video_id === videoId && current.title) return current.title;
    } catch (e) { /* ignore */ }
    try {
      return (await fetchPlayerResponse(videoId))?.videoDetails?.title || '';
    } catch (e) {
      return '';
    }
  }

  // Unmarking the video being watched: rewind and pause first, otherwise the player's next
  // watchtime ping would put it straight back in the history at the end position.
  function rewindCurrentPlayer(videoId) {
    const p = player();
    try {
      if (p?.getVideoData?.().video_id !== videoId) return;
      p.pauseVideo();
      p.seekTo(0, true);
    } catch (e) { /* ignore */ }
  }

  async function handle(req) {
    switch (req.action) {
      case 'mark': {
        const seeked = req.seek ? seekCurrentPlayerToEnd(req.videoId) : false;
        if (!isLoggedIn() && !req.force) return { synced: false, reason: 'not-logged-in', seeked };
        const info = await sendWatchedSignals(req.videoId);
        return { synced: true, seeked, ...info };
      }
      case 'progress': {
        // seconds (from the player bar) or fraction (from a thumbnail menu).
        if (!isLoggedIn() && !req.force) return { synced: false, reason: 'not-logged-in' };
        const info = await sendPositionSignals(req.videoId,
          (length) => (req.seconds !== undefined ? req.seconds : length * req.fraction));
        if (req.seek) seekCurrentPlayerTo(req.videoId, info.position);
        return { synced: true, ...info };
      }
      case 'unmark': {
        if (!isLoggedIn() && !req.force) return { synced: false, reason: 'not-logged-in' };
        if (req.seek) rewindCurrentPlayer(req.videoId);
        const title = req.title || await videoTitle(req.videoId);
        const removed = await removeFromHistory(req.videoId, title);
        return { synced: removed, reason: removed ? null : 'not-in-history' };
      }
      default:
        throw new Error('action inconnue ' + req.action);
    }
  }

  document.addEventListener(REQUEST_EVENT, async (event) => {
    let req;
    try { req = JSON.parse(event.detail); } catch (e) { return; }
    let response;
    try {
      response = { id: req.id, ok: true, result: await handle(req) };
    } catch (e) {
      response = { id: req.id, ok: false, error: String(e?.message || e) };
    }
    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: JSON.stringify(response) }));
  });
})();
