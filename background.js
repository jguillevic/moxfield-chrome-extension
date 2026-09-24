// background.js — service worker (MV3)
// Source de vérité unique pour le state : chrome.storage.local
//   stock       : { [normalizedName]: { name: string, qty: number } }
//   builtDecks  : { [deckId]: { name: string, url: string, cards: [{name, qty}], builtAt: number } }

const STORAGE_KEY = "moxfieldStockManagerState";

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Seuls stock et builtDecks sont conservés : une ancienne version stockait
// aussi les réglages de synchro automatique (settings, lastAutoSync...),
// fonctionnalité retirée car jamais fonctionnelle — ces clés sont ignorées
// ici et disparaissent à la prochaine écriture de l'état.
async function getState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const state = data[STORAGE_KEY] || {};
  return {
    stock: state.stock || {},
    builtDecks: state.builtDecks || {},
  };
}

async function setState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// --- Parsing CSV export Moxfield ---
// Header connu : Count,Tradelist Count,Name,Edition,Condition,Language,Foil,Tags,Last Modified,Collector Number,Alter,Proxy,Purchase Price
// On agrège par nom de carte (toutes éditions/finish confondues) : le stock physique est géré au nom de carte, pas à l'édition près.
function parseCSVLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function parseCollectionCSV(csvText) {
  const lines = csvText.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV vide ou invalide");

  const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const countIdx = header.indexOf("count");
  const nameIdx = header.indexOf("name");
  if (countIdx === -1 || nameIdx === -1) {
    throw new Error("Colonnes 'Count' / 'Name' introuvables dans le CSV — format inattendu.");
  }

  const aggregated = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    const rawName = (cells[nameIdx] || "").trim();
    const rawCount = parseInt((cells[countIdx] || "0").trim(), 10);
    if (!rawName || Number.isNaN(rawCount)) continue;
    const key = normalizeName(rawName);
    if (!aggregated[key]) aggregated[key] = { name: rawName, qty: 0 };
    aggregated[key].qty += rawCount;
  }
  return aggregated;
}

// --- Handlers ---
async function handleImportCSV(csvText) {
  const parsed = parseCollectionCSV(csvText);
  const state = await getState();
  const freshStock = parsed;
  for (const deckId of Object.keys(state.builtDecks)) {
    const deck = state.builtDecks[deckId];
    for (const card of deck.cards) {
      if (card.excludedFromStock) continue; // jamais décomptée au montage : ne pas la décompter ici non plus
      const key = normalizeName(card.name);
      if (freshStock[key]) {
        freshStock[key].qty -= card.qty;
      } else {
        freshStock[key] = { name: card.name, qty: -card.qty };
      }
    }
  }
  state.stock = freshStock;
  await setState(state);
  const totalQty = Object.values(parsed).reduce((sum, c) => sum + c.qty, 0);
  return { ok: true, cardCount: Object.keys(parsed).length, totalQty };
}

async function handleToggleDeck({ deckId, deckName, url, cards, built }) {
  const state = await getState();

  if (built) {
    if (state.builtDecks[deckId]) return { ok: true, alreadyBuilt: true };
    for (const card of cards) {
      if (card.excludedFromStock) continue; // absente de la collection Moxfield : pas décomptée
      const key = normalizeName(card.name);
      if (!state.stock[key]) state.stock[key] = { name: card.name, qty: 0 };
      state.stock[key].qty -= card.qty;
    }
    state.builtDecks[deckId] = { name: deckName, url, cards, builtAt: Date.now() };
  } else {
    const deck = state.builtDecks[deckId];
    if (!deck) return { ok: true, wasNotBuilt: true };
    for (const card of deck.cards) {
      if (card.excludedFromStock) continue;
      const key = normalizeName(card.name);
      if (!state.stock[key]) state.stock[key] = { name: card.name, qty: 0 };
      state.stock[key].qty += card.qty;
    }
    delete state.builtDecks[deckId];
  }

  await setState(state);
  return { ok: true };
}

async function handleManualAdjust({ name, delta }) {
  const state = await getState();
  const key = normalizeName(name);
  if (!state.stock[key]) state.stock[key] = { name, qty: 0 };
  state.stock[key].qty += delta;
  await setState(state);
  return { ok: true };
}

async function handleResetStock() {
  await setState({ stock: {}, builtDecks: {} });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_STATE":
          sendResponse({ ok: true, state: await getState() });
          break;
        case "IMPORT_CSV_TEXT":
          sendResponse(await handleImportCSV(msg.csvText));
          break;
        case "TOGGLE_DECK_BUILT":
          sendResponse(await handleToggleDeck(msg.payload));
          break;
        case "MANUAL_ADJUST_STOCK":
          sendResponse(await handleManualAdjust(msg.payload));
          break;
        case "RESET_STOCK":
          sendResponse(await handleResetStock());
          break;
        default:
          sendResponse({ ok: false, error: "Type de message inconnu: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // réponse asynchrone
});
