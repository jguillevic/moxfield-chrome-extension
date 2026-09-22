function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

async function loadState() {
  const res = await send("GET_STATE");
  return res.state;
}

function renderBuiltDecks(state) {
  const list = document.getElementById("built-list");
  const decks = Object.entries(state.builtDecks);
  document.getElementById("built-count").textContent = decks.length;
  if (decks.length === 0) {
    list.innerHTML = '<p class="hint">Aucun deck monté pour le moment.</p>';
    return;
  }
  list.innerHTML = "";
  for (const [deckId, deck] of decks) {
    const row = document.createElement("div");
    row.className = "deck-row";
    const link = document.createElement("a");
    link.href = deck.url;
    link.target = "_blank";
    link.textContent = deck.name;
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "Démonter";
    btn.addEventListener("click", async () => {
      await send("TOGGLE_DECK_BUILT", { deckId, deckName: deck.name, url: deck.url, cards: [], built: false });
      refresh();
    });
    row.appendChild(link);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function renderStock(state, filter) {
  const container = document.getElementById("stock-table");
  const entries = Object.values(state.stock)
    .filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  document.getElementById("stock-count").textContent = Object.keys(state.stock).length;
  document.getElementById("stock-total").textContent = Object.values(state.stock).reduce((sum, c) => sum + c.qty, 0);

  if (entries.length === 0) {
    container.innerHTML = '<p class="hint">Aucune carte en stock — importe ta collection ci-dessus.</p>';
    return;
  }

  const table = document.createElement("table");
  table.innerHTML = "<tr><th>Carte</th><th>Qté</th><th></th></tr>";
  for (const card of entries) {
    const tr = document.createElement("tr");
    const negative = card.qty < 0;
    tr.innerHTML = `
      <td>${card.name}</td>
      <td class="${negative ? "negative" : ""}">${card.qty}</td>
      <td class="qty-controls">
        <button data-delta="-1">-</button>
        <button data-delta="1">+</button>
      </td>
    `;
    tr.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const delta = parseInt(btn.dataset.delta, 10);
        await send("MANUAL_ADJUST_STOCK", { name: card.name, delta });
        refresh();
      });
    });
    table.appendChild(tr);
  }
  container.innerHTML = "";
  container.appendChild(table);
}

function formatTimestamp(ts) {
  if (!ts) return "jamais";
  return new Date(ts).toLocaleString("fr-FR");
}

function renderAutoSync(state) {
  const toggle = document.getElementById("auto-sync-toggle");
  const interval = document.getElementById("auto-sync-interval");
  const status = document.getElementById("auto-sync-status");

  toggle.checked = state.settings.autoSyncEnabled;
  interval.value = String(state.settings.intervalMinutes);

  let statusText = "Dernière synchro auto : " + formatTimestamp(state.lastAutoSync) + ".";
  if (state.lastAutoSyncError) {
    statusText += " Dernière erreur : " + state.lastAutoSyncError + " (le bouton manuel reste toujours disponible sur la page collection, ou l'import CSV collé ci-dessous).";
  }
  status.textContent = statusText;
}

async function refresh() {
  const state = await loadState();
  const filter = document.getElementById("stock-filter").value;
  renderBuiltDecks(state);
  renderStock(state, filter);
  renderAutoSync(state);
}

async function saveSettings() {
  const autoSyncEnabled = document.getElementById("auto-sync-toggle").checked;
  const intervalMinutes = parseInt(document.getElementById("auto-sync-interval").value, 10);
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", payload: { autoSyncEnabled, intervalMinutes } });
  refresh();
}

document.getElementById("auto-sync-toggle").addEventListener("change", saveSettings);
document.getElementById("auto-sync-interval").addEventListener("change", saveSettings);

async function importCSVText(csvText, status) {
  if (!csvText || !csvText.trim()) {
    status.textContent = "Aucun contenu à importer.";
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "IMPORT_CSV_TEXT", csvText });
  if (res.ok) {
    status.textContent = `${res.cardCount} cartes différentes, ${res.totalQty} exemplaires importés.`;
    refresh();
  } else {
    status.textContent = "Erreur : " + res.error;
  }
}

document.getElementById("import-btn").addEventListener("click", async () => {
  const fileInput = document.getElementById("csv-file-input");
  const status = document.getElementById("import-status");
  const file = fileInput.files[0];
  if (!file) {
    status.textContent = "Choisis d'abord un fichier CSV.";
    return;
  }
  try {
    const csvText = await file.text();
    await importCSVText(csvText, status);
    fileInput.value = "";
  } catch (e) {
    status.textContent = "Impossible de lire le fichier : " + e.message;
  }
});

document.getElementById("import-paste-btn").addEventListener("click", async () => {
  const csvText = document.getElementById("csv-input").value;
  const status = document.getElementById("import-status");
  await importCSVText(csvText, status);
  document.getElementById("csv-input").value = "";
});

document.getElementById("stock-filter").addEventListener("input", refresh);

document.getElementById("reset-btn").addEventListener("click", async () => {
  if (confirm("Réinitialiser tout le stock et tous les decks montés ?")) {
    await send("RESET_STOCK");
    refresh();
  }
});

refresh();
