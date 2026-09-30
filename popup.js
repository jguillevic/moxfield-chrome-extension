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

async function refresh() {
  const state = await loadState();
  const filter = document.getElementById("stock-filter").value;
  const onlyInDecks = document.getElementById("stock-only-in-decks").checked;
  renderBuiltDecks(state);
  renderStock(state, filter, onlyInDecks);
}

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

// Le vrai champ fichier est masqué derrière un bouton stylé : on affiche
// nous-mêmes le nom du fichier choisi.
function showChosenFile() {
  const file = document.getElementById("csv-file-input").files[0];
  document.getElementById("csv-file-name").textContent = file ? file.name : "Aucun fichier choisi";
}

document.getElementById("csv-file-input").addEventListener("change", showChosenFile);

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
    showChosenFile();
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

// --- Synchronisation Google Drive ---
// Le travail se fait dans le service worker ; le popup ne fait qu'afficher
// l'état de la synchro, qu'il relit à chaque changement du stockage local.
function formatDate(value) {
  return new Date(value).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

let syncMeta = null;

async function renderSync() {
  const res = await send("GET_SYNC_STATUS");
  syncMeta = res.meta;
  const m = syncMeta;
  const blocked = m.pendingChoice || m.accountMismatch;
  document.getElementById("sync-off").hidden = m.enabled;
  document.getElementById("sync-choice").hidden = !(m.enabled && m.pendingChoice);
  document.getElementById("sync-account-changed").hidden = !(m.enabled && !m.pendingChoice && m.accountMismatch);
  document.getElementById("sync-on").hidden = !(m.enabled && !blocked);
  document.getElementById("sync-reconnect-btn").hidden = !m.lastError;
  document.getElementById("sync-account").textContent = m.accountEmail || "inconnu";
  if (m.accountMismatch) {
    document.getElementById("sync-old-account").textContent = m.accountEmail || "inconnu";
    document.getElementById("sync-new-account").textContent = m.accountMismatch.email || "inconnu";
  }
  if (m.pendingChoice) {
    document.getElementById("sync-choice-date").textContent = `modifiées le ${formatDate(m.pendingChoice.remoteUpdatedAt)}`;
  }
  document.getElementById("sync-avatar").textContent = (m.accountEmail || "?").charAt(0);

  const state = document.getElementById("sync-state");
  let pill;
  if (!m.enabled) {
    pill = ["off", "Non synchronisé"];
    state.textContent = "";
  } else if (blocked) {
    pill = ["pending", "En pause"];
  } else if (m.lastError) {
    pill = ["error", "Erreur de synchro"];
    state.className = "sync-error";
    state.textContent = m.lastError;
  } else if (m.dirty || !m.lastSyncAt) {
    pill = ["pending", "Envoi en cours"];
    state.className = "";
    state.textContent = m.lastSyncAt ? "Modifications en attente d'envoi…" : "Première synchronisation…";
  } else {
    pill = ["ok", "Synchronisé"];
    state.className = "";
    state.textContent = `Dernière synchro : ${formatDate(m.lastSyncAt)}`;
  }
  const pillEl = document.getElementById("sync-pill");
  pillEl.className = `pill ${pill[0]}`;
  pillEl.textContent = pill[1];
}

async function runSyncAction(type, payload, pendingText) {
  const status = document.getElementById("sync-status");
  status.textContent = pendingText;
  const res = await send(type, payload);
  status.textContent = res.ok ? "" : "Erreur : " + res.error;
  renderSync();
  return res;
}

const SNAPSHOT_REASONS = { daily: "", conflict: " — version écartée lors d'un conflit", manual: " — sauvegarde manuelle" };

async function renderSnapshots() {
  const container = document.getElementById("sync-snapshots");
  container.innerHTML = '<p class="hint">Chargement…</p>';
  const res = await send("DRIVE_LIST_SNAPSHOTS");
  if (!res.ok) {
    container.innerHTML = "";
    document.getElementById("sync-status").textContent = "Erreur : " + res.error;
    return;
  }
  if (res.snapshots.length === 0) {
    container.innerHTML = '<p class="hint">Aucune version dans l\'historique pour le moment.</p>';
    return;
  }
  container.innerHTML = "";
  for (const s of res.snapshots) {
    const row = document.createElement("div");
    row.className = "deck-row";
    const label = document.createElement("span");
    label.className = "hint";
    label.textContent = `${formatDate(s.createdTime)}${SNAPSHOT_REASONS[s.reason] ?? ""}`;
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "Restaurer";
    btn.addEventListener("click", async () => {
      if (!confirm(`Remplacer le stock et les decks montés par la version du ${formatDate(s.createdTime)} ? Elle sera aussi appliquée à tes autres PC.`)) return;
      const r = await runSyncAction("DRIVE_RESTORE_SNAPSHOT", { fileId: s.id }, "Restauration…");
      if (r.ok) {
        document.getElementById("sync-status").textContent = `Restauré : ${r.cardCount} cartes différentes, ${r.deckCount} decks montés.`;
      }
    });
    row.appendChild(label);
    row.appendChild(btn);
    container.appendChild(row);
  }
}

document.getElementById("sync-connect-btn").addEventListener("click", () => runSyncAction("DRIVE_CONNECT", undefined, "Connexion…"));
document.getElementById("sync-reconnect-btn").addEventListener("click", () => runSyncAction("DRIVE_CONNECT", undefined, "Connexion…"));
document.getElementById("sync-keep-remote-btn").addEventListener("click", () => runSyncAction("DRIVE_RESOLVE_CHOICE", { keep: "remote" }, "Récupération depuis Drive…"));
document.getElementById("sync-keep-local-btn").addEventListener("click", () => runSyncAction("DRIVE_RESOLVE_CHOICE", { keep: "local" }, "Envoi vers Drive…"));
document.getElementById("sync-account-keep-local-btn").addEventListener("click", () => runSyncAction("DRIVE_RESOLVE_CHOICE", { keep: "local" }, "Envoi vers le nouveau compte…"));
document.getElementById("sync-account-keep-remote-btn").addEventListener("click", () => {
  if (confirm("Remplacer le stock de ce PC par celui du nouveau compte ? (s'il n'en a pas, le stock de ce PC y sera envoyé)")) {
    runSyncAction("DRIVE_RESOLVE_CHOICE", { keep: "remote" }, "Récupération depuis le nouveau compte…");
  }
});
document.getElementById("sync-now-btn").addEventListener("click", () => runSyncAction("SYNC_NOW", undefined, "Synchronisation…"));
document.getElementById("sync-disconnect-btn").addEventListener("click", () => {
  if (confirm("Arrêter la synchronisation sur ce PC ? Les données restent sur ce PC et sur Drive.")) {
    runSyncAction("DRIVE_DISCONNECT", undefined, "");
  }
});
document.getElementById("sync-history").addEventListener("toggle", (e) => {
  if (e.target.open) renderSnapshots();
});

document.getElementById("reset-btn").addEventListener("click", async () => {
  const warning = syncMeta?.enabled ? "\n\nLa synchronisation est active : tes autres PC seront aussi vidés." : "";
  if (confirm("Réinitialiser tout le stock et tous les decks montés ?" + warning)) {
    await send("RESET_STOCK");
    refresh();
  }
});

// Un changement venant de Drive (ou d'un onglet Moxfield) met le popup à jour.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.moxfieldStockManagerState) refresh();
  if (changes.moxfieldStockManagerSync) renderSync();
});

refresh();
renderSync().then(() => {
  if (syncMeta.enabled) send("SYNC_NOW"); // récupère tout de suite les changements d'un autre PC
});
