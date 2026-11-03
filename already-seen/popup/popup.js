(async () => {
  const msg = document.getElementById('msg');
  let settings = await asLoadSettings();

  async function renderCount() {
    const n = Object.keys(await asLoadWatched()).length;
    document.getElementById('count').textContent = n === 0
      ? 'Aucune vidéo marquée'
      : `${n} vidéo${n > 1 ? 's' : ''} marquée${n > 1 ? 's' : ''} comme vue${n > 1 ? 's' : ''}`;
  }

  for (const input of document.querySelectorAll('[data-key]')) {
    const key = input.dataset.key;
    if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
    else input.value = settings[key];

    input.addEventListener('change', async () => {
      let value = input.type === 'checkbox' ? input.checked : Number(input.value);
      if (input.type === 'number') {
        value = Math.min(100, Math.max(10, Number.isFinite(value) ? value : AS_DEFAULTS[key]));
        input.value = value;
      }
      settings = { ...settings, [key]: value };
      await asSaveSettings(settings);
    });
  }

  document.getElementById('export').addEventListener('click', async () => {
    const data = { app: 'AlreadySeen', version: 1, exportedAt: new Date().toISOString(), settings, watched: await asLoadWatched() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `alreadyseen-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const fileInput = document.getElementById('file');
  document.getElementById('import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = data.watched && typeof data.watched === 'object' ? data.watched : {};
      let added = 0;
      await asUpdateWatched((map) => {
        for (const [id, ts] of Object.entries(incoming)) {
          if (!/^[\w-]{11}$/.test(id)) continue;
          if (!map[id]) added++;
          map[id] = Math.max(map[id] || 0, Number(ts) || Date.now());
        }
      });
      msg.textContent = `Import terminé : ${added} nouvelle${added > 1 ? 's' : ''} vidéo${added > 1 ? 's' : ''}.`;
      renderCount();
    } catch (e) {
      msg.textContent = `Fichier invalide : ${e.message}`;
    }
    fileInput.value = '';
  });

  document.getElementById('clear').addEventListener('click', async () => {
    if (!confirm('Effacer toutes les vidéos marquées localement ? (votre historique YouTube n\'est pas modifié)')) return;
    await chrome.storage.local.set({ [AS_WATCHED_KEY]: {} });
    msg.textContent = 'Liste locale effacée.';
    renderCount();
  });

  renderCount();
})();
