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

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// "Où est ma carte ?" : la quantité du stock est déjà la quantité LIBRE
// (les cartes des decks montés en ont été retirées au montage). On
// reconstitue l'autre moitié à partir des listes des decks montés. Les
// cartes marquées excludedFromStock (decks montés avec une ancienne
// version) n'ont jamais été retirées du stock : on ne les compte pas ici,
// sinon le total possédé serait faussé.
function buildDeckUsage(builtDecks) {
  const usage = new Map();
  for (const [deckId, deck] of Object.entries(builtDecks)) {
    for (const card of deck.cards || []) {
      if (card.excludedFromStock) continue;
      const key = normalizeName(card.name);
      if (!usage.has(key)) usage.set(key, { name: card.name, total: 0, decks: [] });
      const u = usage.get(key);
      u.total += card.qty;
      u.decks.push({ deckId, name: deck.name, url: deck.url, qty: card.qty });
    }
  }
  return usage;
}

// Lignes dépliées (détail des decks), conservées entre deux rafraîchissements.
const expandedCards = new Set();

function renderStock(state, filter, onlyInDecks) {
  const container = document.getElementById("stock-table");
  const usage = buildDeckUsage(state.builtDecks);

  // Union stock + cartes utilisées dans des decks : une carte montée est en
  // principe toujours présente dans le stock (entrée créée au décompte), mais
  // on ne veut pas la perdre de vue si ce n'est pas le cas.
  const rows = new Map();
  for (const [key, c] of Object.entries(state.stock)) rows.set(key, { key, name: c.name, qty: c.qty });
  for (const [key, u] of usage) {
    if (!rows.has(key)) rows.set(key, { key, name: u.name, qty: 0 });
  }

  const inDecksTotal = Array.from(usage.values()).reduce((sum, u) => sum + u.total, 0);
  document.getElementById("stock-count").textContent = Object.keys(state.stock).length;
  document.getElementById("stock-total").textContent = Object.values(state.stock).reduce((sum, c) => sum + c.qty, 0);
  document.getElementById("stock-in-decks").textContent = inDecksTotal;

  const entries = Array.from(rows.values())
    .filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))
    .filter((c) => !onlyInDecks || usage.has(c.key))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length === 0) {
    container.innerHTML = rows.size === 0
      ? '<p class="hint">Aucune carte en stock — importe ta collection ci-dessus.</p>'
      : '<p class="hint">Aucune carte ne correspond au filtre.</p>';
    return;
  }

  const table = document.createElement("table");
  table.innerHTML = "<tr><th>Carte</th><th>Libre</th><th>Decks</th><th></th></tr>";
  for (const card of entries) {
    const u = usage.get(card.key);
    const expanded = u && expandedCards.has(card.key);
    const tr = document.createElement("tr");
    if (u) tr.className = "has-decks";
    tr.innerHTML = `
      <td>${escapeHtml(card.name)}</td>
      <td class="${card.qty < 0 ? "negative" : ""}">${card.qty}</td>
      <td class="in-decks">${u ? `${u.total} ${expanded ? "▾" : "▸"}` : "—"}</td>
      <td class="qty-controls">
        <button data-delta="-1">-</button>
        <button data-delta="1">+</button>
      </td>
    `;
    tr.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation(); // ne pas déplier la ligne en ajustant la quantité
        const delta = parseInt(btn.dataset.delta, 10);
        await send("MANUAL_ADJUST_STOCK", { name: card.name, delta });
        refresh();
      });
    });
    if (u) {
      tr.addEventListener("click", () => {
        if (expandedCards.has(card.key)) expandedCards.delete(card.key);
        else expandedCards.add(card.key);
        refresh();
      });
    }
    table.appendChild(tr);

    if (expanded) {
      const detail = document.createElement("tr");
      detail.className = "deck-usage";
      detail.innerHTML =
        `<td colspan="4">Total possédé : ${card.qty + u.total}<ul>` +
        u.decks
          .map((d) => `<li><a href="${escapeHtml(d.url)}" target="_blank">${escapeHtml(d.name)}</a> ×${d.qty}</li>`)
          .join("") +
        "</ul></td>";
      table.appendChild(detail);
    }
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
  const onlyInDecks = document.getElementById("stock-only-in-decks").checked;
  renderBuiltDecks(state);
  renderStock(state, filter, onlyInDecks);
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
document.getElementById("stock-only-in-decks").addEventListener("change", refresh);

document.getElementById("reset-btn").addEventListener("click", async () => {
  if (confirm("Réinitialiser tout le stock et tous les decks montés ?")) {
    await send("RESET_STOCK");
    refresh();
  }
});

refresh();
