// Isolated-world content script: all the UI (player button, action-row button, thumbnail
// buttons, red bar / dimming / hiding) and the local watched list. Account sync is delegated
// to page.js through CustomEvents.
(async () => {
  'use strict';

  let settings = await asLoadSettings();
  let watched = await asLoadWatched();
  const unmarkedThisPage = new Set(); // unmarked here although YouTube's own bar says watched
  const progressThisPage = new Map(); // videoId -> percent saved here (drawn until the next load)

  const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
  const ICON_CHECK_CIRCLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.6 14.2-4.1-4.1 1.4-1.4 2.7 2.7 6-6 1.4 1.4-7.4 7.4Z"/></svg>';

  const THUMB_SELECTOR = 'ytd-thumbnail, yt-thumbnail-view-model, ytm-shorts-lockup-view-model';
  // Thumbnails that don't stand for one video (playlists, mixes) or that live inside the player.
  const THUMB_EXCLUDE = 'yt-collection-thumbnail-view-model, ytd-playlist-thumbnail, ytd-macro-markers-list-item-renderer, #movie_player';
  const CARD_SELECTOR = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ' +
    'ytd-reel-item-renderer, ytm-shorts-lockup-view-model, yt-lockup-view-model, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer';
  // Never hide entries of a playlist: that would break the list you are going through.
  const NEVER_HIDE_SELECTOR = 'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer';
  const NATIVE_PROGRESS_SELECTOR = 'ytd-thumbnail-overlay-resume-playback-renderer #progress, ' +
    'ytw-thumbnail-overlay-resume-playback-renderer > div, .ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment';

  // ── Bridge to page.js (MAIN world) ─────────────────────────────────────────

  let requestSeq = 0;
  const pending = new Map();

  document.addEventListener('alreadyseen:response', (event) => {
    let res;
    try { res = JSON.parse(event.detail); } catch (e) { return; }
    const entry = pending.get(res.id);
    if (!entry) return;
    pending.delete(res.id);
    clearTimeout(entry.timer);
    res.ok ? entry.resolve(res.result) : entry.reject(new Error(res.error));
  });

  function callPage(action, payload = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${++requestSeq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('délai dépassé'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      document.dispatchEvent(new CustomEvent('alreadyseen:request', {
        detail: JSON.stringify({ id, action, ...payload })
      }));
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function videoIdFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const m = url.pathname.match(/^\/shorts\/([\w-]{11})/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  function currentVideoId() {
    if (location.pathname === '/watch' || location.pathname.startsWith('/shorts/')) {
      return videoIdFromHref(location.href);
    }
    return null;
  }

  function nativeProgressPercent(root) {
    const bar = root.querySelector(NATIVE_PROGRESS_SELECTOR);
    if (!bar) return 0;
    const width = parseFloat(bar.style.width);
    return Number.isFinite(width) ? width : 0;
  }

  // Local mark first; otherwise, optionally, YouTube's own red bar.
  function isWatched(videoId, root) {
    if (watched[videoId]) return true;
    if (unmarkedThisPage.has(videoId)) return false;
    return Boolean(settings.useNativeProgress && root && nativeProgressPercent(root) >= settings.nativeThreshold);
  }

  // In fullscreen only the fullscreen element is drawn: put our overlays inside it.
  const overlayRoot = () => document.fullscreenElement || document.documentElement;

  let toastTimer = null;
  function toast(message, kind = 'ok') {
    let el = document.getElementById('as-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'as-toast';
    }
    if (el.parentElement !== overlayRoot()) overlayRoot().appendChild(el);
    el.textContent = message;
    el.dataset.kind = kind;
    el.classList.add('as-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('as-visible'), 3500);
  }

  // ── Marking ────────────────────────────────────────────────────────────────

  async function setWatched(videoId, value, { auto = false } = {}) {
    if (!videoId) return;
    if (value) {
      watched[videoId] = Date.now();
      unmarkedThisPage.delete(videoId);
    } else {
      delete watched[videoId];
      unmarkedThisPage.add(videoId);
    }
    refreshAll();
    await asUpdateWatched((map) => {
      if (value) map[videoId] = watched[videoId];
      else delete map[videoId];
    });

    if (!settings.syncYouTube) {
      if (!auto) toast(value ? 'Marquée comme vue (localement)' : 'Marque retirée (localement)');
      return;
    }

    try {
      const seek = !auto && videoId === currentVideoId() && settings.seekOnWatchPage;
      const result = await callPage(value ? 'mark' : 'unmark', { videoId, seek });
      if (auto) return;
      if (value) {
        if (result.synced) toast('Marquée comme vue, historique YouTube mis à jour');
        else toast('Marquée comme vue localement. Connectez-vous à YouTube pour mettre à jour votre historique.', 'warn');
      } else if (result.synced) {
        toast('Marque retirée, vidéo supprimée de votre historique YouTube');
      } else if (result.reason === 'not-in-history') {
        toast('Marque retirée. Vidéo introuvable dans votre historique YouTube.', 'warn');
      } else {
        toast('Marque retirée localement. Connectez-vous à YouTube pour mettre à jour votre historique.', 'warn');
      }
    } catch (e) {
      if (!auto) toast(`${value ? 'Marquée' : 'Marque retirée'} localement, échec de la synchro YouTube : ${e.message}`, 'error');
    }
  }

  // ── Manual progress ────────────────────────────────────────────────────────

  function formatTime(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  // target: { seconds } or { fraction }. A saved progress replaces the "watched" mark.
  async function saveProgress(videoId, target) {
    if (!settings.syncYouTube) {
      toast('Activez la synchronisation YouTube pour enregistrer un avancement.', 'warn');
      return;
    }
    delete watched[videoId];
    unmarkedThisPage.add(videoId);
    if (target.fraction !== undefined) progressThisPage.set(videoId, Math.round(target.fraction * 100));
    refreshAll();
    await asUpdateWatched((map) => { delete map[videoId]; });

    try {
      const seek = videoId === currentVideoId();
      const result = await callPage('progress', { videoId, seek, ...target });
      if (!result.synced) {
        toast('Connectez-vous à YouTube pour enregistrer un avancement.', 'warn');
        return;
      }
      progressThisPage.set(videoId, Math.round(result.position / result.length * 100));
      refreshAll();
      toast(`Avancement enregistré à ${formatTime(result.position)} (${progressThisPage.get(videoId)} %)`);
    } catch (e) {
      toast(`Échec de l'enregistrement de l'avancement : ${e.message}`, 'error');
    }
  }

  let menuEl = null;
  function closeMenu() {
    menuEl?.remove();
    menuEl = null;
  }

  // items: [{ label, run }]
  function openMenu(x, y, title, items) {
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.id = 'as-menu';
    menuEl.setAttribute('role', 'menu');
    const head = document.createElement('div');
    head.className = 'as-menu-title';
    head.textContent = title;
    menuEl.appendChild(head);
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = item.label;
      b.addEventListener('click', (e) => {
        swallow(e);
        closeMenu();
        item.run();
      }, true);
      menuEl.appendChild(b);
    }
    for (const type of ['pointerdown', 'mousedown', 'mouseup']) {
      menuEl.addEventListener(type, (e) => e.stopPropagation(), true);
    }
    overlayRoot().appendChild(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
    menuEl.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
    menuEl.querySelector('button')?.focus();
  }

  document.addEventListener('pointerdown', (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, true);
  window.addEventListener('blur', closeMenu);

  function openThumbProgressMenu(videoId, x, y) {
    const items = [25, 50, 75].map((pct) => ({
      label: `${pct} %`,
      run: () => saveProgress(videoId, { fraction: pct / 100 })
    }));
    items.push({
      label: 'Autre valeur…',
      run: () => {
        const answer = prompt('Avancement à enregistrer : un pourcentage (ex. 40) ou un temps (ex. 12:30)');
        const target = parseProgressInput(answer);
        if (target) saveProgress(videoId, target);
        else if (answer !== null) toast('Valeur non reconnue. Exemples : 40 ou 12:30', 'warn');
      }
    });
    openMenu(x, y, "Enregistrer l'avancement", items);
  }

  function parseProgressInput(text) {
    const value = (text || '').trim().replace(',', '.').replace(/\s*%$/, '');
    if (/^\d+(\.\d+)?$/.test(value)) {
      const pct = Number(value);
      return pct > 0 && pct <= 100 ? { fraction: pct / 100 } : null;
    }
    if (/^\d+(:\d{1,2}){1,2}$/.test(value)) {
      return { seconds: value.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) };
    }
    return null;
  }

  // Right click on the player's progress bar: save the progress at the clicked time.
  document.addEventListener('contextmenu', (e) => {
    const bar = e.target.closest?.('#movie_player .ytp-progress-bar-container');
    const id = currentVideoId();
    if (!bar || !id) return;
    const playerEl = document.getElementById('movie_player');
    const video = playerEl?.querySelector('video');
    if (!video || playerEl.classList.contains('ad-showing') || !Number.isFinite(video.duration)) return;
    const track = bar.querySelector('.ytp-progress-bar') || bar;
    const rect = track.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const clicked = fraction * video.duration;
    const current = video.currentTime;
    swallow(e);
    openMenu(e.clientX, e.clientY - 90, "Avancement YouTube", [
      { label: `Sauvegarder l'avancement à ${formatTime(clicked)}`, run: () => saveProgress(id, { seconds: clicked }) },
      { label: `Sauvegarder la position actuelle (${formatTime(current)})`, run: () => saveProgress(id, { seconds: current }) }
    ]);
  }, true);

  function toggleWatched(videoId, root) {
    return setWatched(videoId, !isWatched(videoId, root));
  }

  // Stop the click from reaching YouTube's link / hover-preview handlers.
  function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  // ── Thumbnails ─────────────────────────────────────────────────────────────

  function thumbAnchor(thumb) {
    if (thumb.tagName === 'YTD-THUMBNAIL') return thumb.querySelector('a#thumbnail[href]');
    if (thumb.tagName === 'YTM-SHORTS-LOCKUP-VIEW-MODEL') return thumb.querySelector('a[href*="/shorts/"]');
    return thumb.closest('a[href]') || thumb.parentElement?.querySelector('a[href]');
  }

  // Element the button and the bar are drawn into (must be the image box).
  function thumbHost(thumb) {
    if (thumb.tagName === 'YTM-SHORTS-LOCKUP-VIEW-MODEL') {
      const anchor = thumbAnchor(thumb);
      return anchor?.querySelector('img')?.parentElement || anchor;
    }
    return thumb;
  }

  function ensureThumbButton(host) {
    let btn = host.querySelector(':scope > .as-thumb-btn');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.className = 'as-thumb-btn';
    btn.type = 'button';
    btn.innerHTML = ICON_CHECK;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'dblclick']) {
      btn.addEventListener(type, (e) => e.stopPropagation(), true);
    }
    btn.addEventListener('click', (e) => {
      swallow(e);
      const id = host.dataset.asId;
      if (id) toggleWatched(id, host);
    }, true);
    btn.addEventListener('contextmenu', (e) => {
      swallow(e);
      if (host.dataset.asId) openThumbProgressMenu(host.dataset.asId, e.clientX, e.clientY);
    }, true);
    host.appendChild(btn);
    return btn;
  }

  function ensureBar(host) {
    let bar = host.querySelector(':scope > .as-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'as-bar';
      host.appendChild(bar);
    }
    return bar;
  }

  function updateThumb(thumb) {
    if (thumb.closest(THUMB_EXCLUDE)) return;
    // Nested matches (a shorts lockup holds its own thumbnail): handle only the outermost.
    if (thumb.parentElement?.closest('ytm-shorts-lockup-view-model') && thumb.tagName !== 'YTM-SHORTS-LOCKUP-VIEW-MODEL') return;

    const host = thumbHost(thumb);
    if (!host) return;
    const id = videoIdFromHref(thumbAnchor(thumb)?.getAttribute('href'));
    if (!id) {
      host.querySelector(':scope > .as-thumb-btn')?.remove();
      return;
    }
    if (host.dataset.asId !== id) host.dataset.asId = id;
    host.classList.add('as-host');

    const isLocal = Boolean(watched[id]);
    const seen = isWatched(id, host);

    if (settings.thumbButtons) {
      const btn = ensureThumbButton(host);
      btn.classList.toggle('as-on', seen);
      const label = seen ? 'Vu (cliquer pour retirer)' : 'Marquer comme vu';
      if (btn.title !== label) {
        btn.title = label;
        btn.setAttribute('aria-label', label);
      }
    } else {
      host.querySelector(':scope > .as-thumb-btn')?.remove();
    }

    // Our own full red bar, until YouTube's feed catches up with the account history.
    const saved = progressThisPage.get(id);
    if (isLocal || saved !== undefined) ensureBar(host).style.width = isLocal ? '' : `${saved}%`;
    else host.querySelector(':scope > .as-bar')?.remove();

    host.classList.toggle('as-dim', seen && settings.dimWatched);
    // Unmarked here: hide YouTube's own bar too, it only updates on the next page load.
    host.classList.toggle('as-cleared', unmarkedThisPage.has(id));

    const card = thumb.closest('ytd-rich-item-renderer') || thumb.closest(CARD_SELECTOR);
    if (card) {
      const hide = seen && settings.hideWatched && !card.matches(NEVER_HIDE_SELECTOR) && id !== currentVideoId();
      card.classList.toggle('as-hidden', hide);
    }
  }

  // ── Watch page: player button + action-row button ──────────────────────────

  function updatePlayerButton(id) {
    const existing = document.getElementById('as-player-btn');
    if (!settings.playerButton || !id) {
      existing?.remove();
      return;
    }
    const controls = document.querySelector('#movie_player .ytp-right-controls-left') ||
      document.querySelector('#movie_player .ytp-right-controls');
    if (!controls) return;

    let btn = existing;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'as-player-btn';
      btn.className = 'ytp-button as-player-btn';
      btn.innerHTML = ICON_CHECK_CIRCLE;
      btn.addEventListener('click', (e) => {
        swallow(e);
        const vid = currentVideoId();
        if (vid) toggleWatched(vid);
      });
    }
    if (btn.parentElement !== controls) controls.insertBefore(btn, controls.firstChild);
    const seen = Boolean(watched[id]);
    btn.classList.toggle('as-on', seen);
    const label = seen ? 'Vue (cliquer pour retirer la marque)' : 'Marquer comme vue';
    if (btn.getAttribute('aria-label') !== label) {
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  }

  function updateActionButton(id) {
    const existing = document.getElementById('as-action-btn');
    if (!settings.actionButton || !id || location.pathname !== '/watch') {
      existing?.remove();
      return;
    }
    const row = document.querySelector('ytd-watch-metadata #actions #top-level-buttons-computed');
    if (!row) return;

    let btn = existing;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'as-action-btn';
      btn.type = 'button';
      btn.className = 'as-action-btn';
      btn.innerHTML = `${ICON_CHECK}<span></span>`;
      btn.addEventListener('click', (e) => {
        swallow(e);
        const vid = currentVideoId();
        if (vid) toggleWatched(vid);
      });
    }
    if (btn.parentElement !== row) row.appendChild(btn);
    const seen = Boolean(watched[id]);
    btn.classList.toggle('as-on', seen);
    const text = seen ? 'Vue' : 'Marquer vue';
    const span = btn.querySelector('span');
    if (span.textContent !== text) span.textContent = text;
    btn.title = seen ? 'Cliquer pour retirer la marque' : 'Marquer comme vue (historique YouTube + barre rouge)';
  }

  // ── Auto-mark while watching ───────────────────────────────────────────────

  let autoMarkedId = null;
  function onTimeUpdate(event) {
    if (!settings.autoMark) return;
    const video = event.target;
    const id = currentVideoId();
    if (!id || id === autoMarkedId || watched[id] || unmarkedThisPage.has(id)) return;
    if (document.getElementById('movie_player')?.classList.contains('ad-showing')) return;
    const { currentTime, duration } = video;
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (currentTime / duration * 100 >= settings.autoMarkPercent) {
      autoMarkedId = id;
      setWatched(id, true, { auto: true });
    }
  }

  // Media events don't bubble, but they can be caught on the way down: no need to find and
  // re-hook the <video> element every time YouTube swaps it (ads, navigation).
  document.addEventListener('timeupdate', (event) => {
    if (event.target.closest?.('#movie_player')) onTimeUpdate(event);
  }, true);

  // ── Shorts / members-only filters ──────────────────────────────────────────

  // Shorts are hidden in CSS (see html.as-hide-shorts); only the page type is decided here,
  // so that the Shorts player and a channel's Shorts tab stay usable.
  function updateShortsFilter() {
    const onShortsPage = /^\/shorts\/|\/shorts\/?$/.test(location.pathname);
    document.documentElement.classList.toggle('as-hide-shorts', settings.hideShorts && !onShortsPage);
    // Same for the built-in games (Playables), except on their own pages.
    const onPlayablesPage = location.pathname.startsWith('/playables');
    document.documentElement.classList.toggle('as-hide-playables', settings.hidePlayables && !onPlayablesPage);
  }

  // The "Members only" badge: recognised by its star icon, whatever the interface language,
  // with the text as a fallback for older layouts.
  const MEMBERS_TEXT = /members only|réservé aux membres|nur für (kanal)?mitglieder|solo para miembros|apenas para membros|solo per i membri|alleen voor leden|tylko dla członków|только для спонсоров|メンバー限定|회원 전용|會員專屬|会员专享/i;
  const MEMBERS_ICON_PATH = 'M6 .5a5.5 5.5 0 100 11';
  const MEMBERS_CARD_SELECTOR = 'ytd-rich-item-renderer, yt-lockup-view-model, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer';

  function isMembersBadge(badge) {
    if (badge.classList.contains('badge-style-type-members-only')) return true;
    const path = badge.querySelector('svg path')?.getAttribute('d') || '';
    return path.startsWith(MEMBERS_ICON_PATH) || MEMBERS_TEXT.test(badge.textContent);
  }

  function updateMembersFilter() {
    document.documentElement.classList.toggle('as-hide-members', settings.hideMembers);
    if (!settings.hideMembers) return;
    const cards = new Set();
    document.querySelectorAll('badge-shape, .badge-style-type-members-only').forEach((badge) => {
      if (!isMembersBadge(badge)) return;
      const card = badge.closest('ytd-rich-item-renderer') || badge.closest(MEMBERS_CARD_SELECTOR);
      if (card) cards.add(card);
    });
    // YouTube recycles cards for other videos: untag the ones that lost their badge.
    document.querySelectorAll('.as-members').forEach((card) => {
      if (!cards.has(card)) card.classList.remove('as-members');
    });
    cards.forEach((card) => card.classList.add('as-members'));
  }

  // ── Refresh loop ───────────────────────────────────────────────────────────

  function refreshAll() {
    updateShortsFilter();
    updateMembersFilter();
    document.querySelectorAll(THUMB_SELECTOR).forEach(updateThumb);
    const id = currentVideoId();
    updatePlayerButton(id);
    updateActionButton(id);
  }

  let scheduled = false;
  function scheduleRefresh() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      refreshAll();
    }, 200);
  }

  new MutationObserver((mutations) => {
    // Ignore mutations we caused ourselves.
    for (const m of mutations) {
      const t = m.target;
      if (t.nodeType === 1 && (t.id === 'as-toast' || t.classList.contains('as-thumb-btn') || t.closest?.('.as-action-btn, .as-player-btn'))) continue;
      scheduleRefresh();
      return;
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });

  // YouTube's hover preview (inline player) is drawn above the thumbnail, outside of it, so our
  // button ends up hidden underneath. Find the thumbnail under the pointer by geometry and, when
  // something covers it, show a floating copy of the button at the same place.
  const OVERLAY_SELECTOR = 'ytd-video-preview, #video-preview, #inline-preview-player';
  let floatBtn = null;
  let floatHost = null;
  let pointerQueued = false;
  let lastPointer = null;

  function getFloatButton() {
    if (floatBtn) return floatBtn;
    floatBtn = document.createElement('button');
    floatBtn.type = 'button';
    floatBtn.className = 'as-thumb-btn as-float';
    floatBtn.innerHTML = ICON_CHECK;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'dblclick']) {
      floatBtn.addEventListener(type, (e) => e.stopPropagation(), true);
    }
    floatBtn.addEventListener('click', async (e) => {
      swallow(e);
      const host = floatHost;
      if (!host?.dataset.asId) return;
      await toggleWatched(host.dataset.asId, host);
      syncFloatButton();
    }, true);
    document.documentElement.appendChild(floatBtn);
    return floatBtn;
  }

  function syncFloatButton() {
    const btn = getFloatButton();
    const inner = floatHost?.querySelector(':scope > .as-thumb-btn');
    if (!inner) {
      btn.style.display = 'none';
      return;
    }
    const r = inner.getBoundingClientRect();
    btn.style.display = 'block';
    btn.style.top = `${r.top}px`;
    btn.style.left = `${r.left}px`;
    btn.classList.toggle('as-on', inner.classList.contains('as-on'));
    btn.title = inner.title;
    btn.setAttribute('aria-label', inner.title);
  }

  function updateHover() {
    pointerQueued = false;
    if (!lastPointer || !settings.thumbButtons) return;
    const stack = document.elementsFromPoint(lastPointer.x, lastPointer.y);
    if (stack[0] === floatBtn) return;
    const covered = stack[0]?.closest?.(OVERLAY_SELECTOR);
    const host = covered ? stack.find((el) => el.classList?.contains('as-host')) : null;
    floatHost = host || null;
    syncFloatButton();
  }

  document.addEventListener('pointermove', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!pointerQueued) {
      pointerQueued = true;
      requestAnimationFrame(updateHover);
    }
  }, { passive: true });
  document.addEventListener('scroll', () => { floatHost = null; floatBtn && (floatBtn.style.display = 'none'); }, { passive: true, capture: true });

  document.addEventListener('yt-navigate-finish', () => {
    unmarkedThisPage.clear();
    progressThisPage.clear();
    closeMenu();
    scheduleRefresh();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[AS_WATCHED_KEY]) watched = changes[AS_WATCHED_KEY].newValue || {};
    if (area === 'sync' && changes.settings) settings = { ...AS_DEFAULTS, ...(changes.settings.newValue || {}) };
    scheduleRefresh();
  });

  refreshAll();
})();
