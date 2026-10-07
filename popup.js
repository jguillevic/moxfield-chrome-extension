function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

async function loadState() {
  const res = await send("GET_STATE");
  return res.state;
}

// Détail du badge « Modifié » : "+1 Elvish Mystic, −1 Stitcher's Supplier —
// constaté le 30/09/2026 15:40". Le constat date de la dernière visite de la
// page du deck (cf. SET_DECK_PAGE_CHANGES dans background.js).
const MAX_CHANGES_IN_TOOLTIP = 10;

// "+1 Elvish Mystic, −1 Stitcher's Supplier, et 3 autre(s)".
function formatChanges(changes) {
  const items = changes.slice(0, MAX_CHANGES_IN_TOOLTIP).map((c) => {
    const delta = c.to - c.from;
    return `${delta > 0 ? "+" : "−"}${Math.abs(delta)} ${c.name}`;
  });
  const more = changes.length - items.length;
  if (more > 0) items.push(`et ${more} autre(s)`);
  return items.join(", ");
}

function describePageChanges(deck) {
  return (
    `La liste a changé sur Moxfield depuis le montage : ${formatChanges(deck.pageChanges)}` +
    ` — constaté le ${formatDate(deck.pageCheckedAt)}. Ouvre le deck pour mettre à jour le montage.`
  );
}

function renderBuiltDecks(state) {
  const list = document.getElementById("built-list");
  const decks = Object.entries(state.builtDecks);
  document.getElementById("built-count").textContent = decks.length;
  const changedCount = decks.filter(([, d]) => d.pageChanges && d.pageChanges.length > 0).length;
  const changedEl = document.getElementById("built-changed");
  changedEl.hidden = changedCount === 0;
  changedEl.textContent = `${changedCount} modifié${changedCount > 1 ? "s" : ""}`;
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
    const nameCell = document.createElement("div");
    nameCell.className = "deck-name";
    nameCell.appendChild(link);
    if (deck.pageChanges && deck.pageChanges.length > 0) {
      const badge = document.createElement("span");
      badge.className = "badge-changed";
      badge.textContent = "Modifié";
      badge.title = describePageChanges(deck);
      nameCell.appendChild(badge);
    }
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "Démonter";
    btn.addEventListener("click", async () => {
      await send("TOGGLE_DECK_BUILT", { deckId, deckName: deck.name, url: deck.url, cards: [], built: false });
      refresh();
    });
    row.appendChild(nameCell);
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

// Une collection complète compte des milliers de cartes : construire toutes
// les lignes rendait l'ouverture du popup lente (plusieurs secondes). Le
// tableau n'est donc construit que section dépliée, et limité aux premières
// lignes — le filtre cherche toujours dans tout le stock.
const MAX_STOCK_ROWS = 200;

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

  if (!document.getElementById("stock-details").open) {
    container.innerHTML = "";
    return;
  }

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
  table.innerHTML = "<tr><th>Carte</th><th>Libre</th><th>Decks</th></tr>";
  for (const card of entries.slice(0, MAX_STOCK_ROWS)) {
    const u = usage.get(card.key);
    const expanded = u && expandedCards.has(card.key);
    const tr = document.createElement("tr");
    if (u) tr.className = "has-decks";
    tr.innerHTML = `
      <td>${escapeHtml(card.name)}</td>
      <td class="${card.qty < 0 ? "negative" : ""}">${card.qty}</td>
      <td class="in-decks">${u ? `${u.total} ${expanded ? "▾" : "▸"}` : "—"}</td>
    `;
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
        `<td colspan="3">Total possédé : ${card.qty + u.total}<ul>` +
        u.decks
          .map((d) => `<li><a href="${escapeHtml(d.url)}" target="_blank">${escapeHtml(d.name)}</a> ×${d.qty}</li>`)
          .join("") +
        "</ul></td>";
      table.appendChild(detail);
    }
  }
  container.innerHTML = "";
  container.appendChild(table);
  if (entries.length > MAX_STOCK_ROWS) {
    const more = document.createElement("p");
    more.className = "hint";
    more.textContent = `… et ${entries.length - MAX_STOCK_ROWS} autre(s) carte(s) : affine avec le filtre.`;
    container.appendChild(more);
  }
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
document.getElementById("stock-details").addEventListener("toggle", refresh);
document.getElementById("stock-only-in-decks").addEventListener("change", refresh);

// --- Historique ---
// Libellés calculés par le service worker (cf. handleGetHistory). Construit
// seulement section dépliée, comme le stock.
function formatChangeLine(c) {
  const delta = c.to - c.from;
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta)} ${c.name} (${c.from} → ${c.to})`;
}

async function renderHistory() {
  if (!document.getElementById("history-details").open) return;
  const list = document.getElementById("history-list");
  const { entries } = await send("GET_HISTORY");
  list.innerHTML = "";
  if (entries.length === 0) {
    list.innerHTML = '<p class="hint">Aucune action pour le moment.</p>';
    return;
  }
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "deck-row history-entry";
    const text = document.createElement("div");
    text.className = "history-text";
    const meta = document.createElement("span");
    meta.className = "hint";
    meta.textContent = formatDate(e.at) + (e.otherDevice ? " · sur un autre PC" : "");
    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = e.title;
    text.append(meta, title);
    if (e.changes && e.changes.length > 0) {
      const details = document.createElement("details");
      details.className = "sub-details";
      const summary = document.createElement("summary");
      summary.textContent = "Détail";
      const ul = document.createElement("ul");
      for (const c of e.changes) {
        const li = document.createElement("li");
        li.textContent = formatChangeLine(c);
        ul.appendChild(li);
      }
      details.append(summary, ul);
      text.appendChild(details);
    }
    row.appendChild(text);
    list.appendChild(row);
  }
}

document.getElementById("history-details").addEventListener("toggle", renderHistory);

// --- Récupération de la collection Moxfield ---
// Faite par le service worker (toutes les heures, cf. background.js) ; le
// popup affiche son état et permet de la lancer à la main.
async function renderCollection() {
  const { meta, uncovered } = await send("GET_COLLECTION_STATUS");
  document.getElementById("collection-auto").checked = meta.enabled;

  const state = document.getElementById("collection-state");
  const lastSuccess = meta.lastSuccessAt ? `Dernière récupération : ${formatDate(meta.lastSuccessAt)}.` : "";
  if (meta.lastError) {
    state.className = "sync-error";
    state.textContent = `${meta.lastError.message}${lastSuccess ? ` ${lastSuccess}` : ""}`;
  } else {
    state.className = "hint";
    state.textContent = lastSuccess || "Pas encore récupérée.";
  }

  const changesEl = document.getElementById("collection-changes");
  changesEl.hidden = !meta.lastChanges;
  if (meta.lastChanges) {
    changesEl.textContent = `Derniers changements (${formatDate(meta.lastChangesAt)}) : ${formatChanges(meta.lastChanges)}.`;
  }

  // Cartes de decks montés que la collection ne couvre plus.
  const uncoveredEl = document.getElementById("collection-uncovered");
  uncoveredEl.hidden = uncovered.length === 0;
  uncoveredEl.innerHTML =
    `<strong>Ta collection ne couvre plus ${uncovered.length} carte(s) de decks montés :</strong><ul>` +
    uncovered
      .map((u) => `<li>${escapeHtml(u.name)} — manque ${u.missing} (dans : ${u.decks.map(escapeHtml).join(", ")})</li>`)
      .join("") +
    "</ul>";
}

document.getElementById("collection-auto").addEventListener("change", async (e) => {
  await send("SET_COLLECTION_AUTO", { enabled: e.target.checked });
  renderCollection();
});

document.getElementById("collection-fetch-btn").addEventListener("click", async () => {
  const btn = document.getElementById("collection-fetch-btn");
  const status = document.getElementById("collection-status");
  btn.disabled = true;
  status.textContent = "Récupération…";
  try {
    const res = await send("COLLECTION_FETCH_NOW");
    if (!res.ok) status.textContent = "";
    else if (res.changes.length === 0) status.textContent = "Aucun changement.";
    else status.textContent = `${res.changes.length} carte(s) modifiée(s), stock mis à jour.`;
  } finally {
    btn.disabled = false;
    renderCollection();
  }
});

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
  if (changes.moxfieldStockManagerState) {
    refresh();
    renderCollection(); // cartes non couvertes
    renderHistory();
  }
  if (changes.moxfieldStockManagerSync) renderSync();
  if (changes.moxfieldStockManagerCollection) renderCollection();
});

refresh();
renderCollection();
renderSync().then(() => {
  if (syncMeta.enabled) send("SYNC_NOW"); // récupère tout de suite les changements d'un autre PC
});
