// background.js — service worker (MV3)
// Source de vérité unique pour le state : chrome.storage.local
//   stock       : { [normalizedName]: { name: string, qty: number } }
//   builtDecks  : { [deckId]: { name: string, url: string, cards: [{name, qty}], builtAt: number } }

const STORAGE_KEY = "moxfieldStockManagerState";
const ALARM_NAME = "msm-auto-sync";
const COLLECTION_URL_PATTERNS = ["https://www.moxfield.com/collection*", "https://moxfield.com/collection*"];

const DEFAULT_SETTINGS = {
  autoSyncEnabled: false,
  intervalMinutes: 30,
};

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function getState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const state = data[STORAGE_KEY] || {};
  return {
    stock: state.stock || {},
    builtDecks: state.builtDecks || {},
    settings: { ...DEFAULT_SETTINGS, ...(state.settings || {}) },
    lastAutoSync: state.lastAutoSync || null,
    lastAutoSyncError: state.lastAutoSyncError || null,
  };
}

async function setState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function applyAlarmSchedule(settings) {
  await chrome.alarms.clear(ALARM_NAME);
  if (settings.autoSyncEnabled) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: settings.intervalMinutes });
  }
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
  const state = await getState();
  await setState({ stock: {}, builtDecks: {}, settings: state.settings, lastAutoSync: null, lastAutoSyncError: null });
  return { ok: true };
}

async function handleSetSettings(newSettings) {
  const state = await getState();
  state.settings = { ...state.settings, ...newSettings };
  await setState(state);
  await applyAlarmSchedule(state.settings);
  return { ok: true, settings: state.settings };
}

// --- Auto-sync : exécuté DANS un onglet Moxfield/collection déjà ouvert ---
// (nécessaire car Moxfield n'a pas d'API publique documentée ; on ne peut
// lire l'export CSV qu'en passant par une page réellement rendue).
// Cette fonction est injectée telle quelle via chrome.scripting.executeScript,
// elle doit donc être autonome (pas de référence à des variables externes).
async function pageFindAndFetchCSV() {
  function findExportLink() {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    return (
      anchors.find(
        (a) =>
          /export|csv/i.test(a.getAttribute("href") || "") ||
          /export/i.test(a.getAttribute("download") || "") ||
          /export|t[ée]l[ée]charger|download/i.test(a.textContent || "") ||
          /export|download/i.test(a.getAttribute("aria-label") || "")
      ) || null
    );
  }
  const link = findExportLink();
  if (!link) return { ok: false, error: "Lien d'export introuvable sur la page." };
  try {
    const res = await fetch(link.href, { credentials: "same-origin" });
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    const csvText = await res.text();
    return { ok: true, csvText };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function trySyncTab(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageFindAndFetchCSV,
    });
    const result = injection && injection.result;
    if (!result || !result.ok) {
      const state = await getState();
      state.lastAutoSyncError = (result && result.error) || "Résultat vide";
      await setState(state);
      return;
    }
    const importResult = await handleImportCSV(result.csvText);
    const state = await getState();
    state.lastAutoSync = Date.now();
    state.lastAutoSyncError = importResult.ok ? null : importResult.error;
    await setState(state);
  } catch (e) {
    const state = await getState();
    state.lastAutoSyncError = e.message || String(e);
    await setState(state);
  }
}

async function autoSyncAllCollectionTabs() {
  const state = await getState();
  if (!state.settings.autoSyncEnabled) return;
  const tabs = await chrome.tabs.query({ url: COLLECTION_URL_PATTERNS });
  for (const tab of tabs) {
    if (tab.id != null) await trySyncTab(tab.id);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) autoSyncAllCollectionTabs();
});

// Sync aussi dès qu'un onglet collection finit de charger (pratique quand tu
// viens d'ajouter des cartes et que tu retournes/rafraîchis la page).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  const isCollectionPage = /^https:\/\/(www\.)?moxfield\.com\/collection/.test(tab.url);
  if (!isCollectionPage) return;
  const state = await getState();
  if (state.settings.autoSyncEnabled) await trySyncTab(tabId);
});

async function initAlarms() {
  const state = await getState();
  await applyAlarmSchedule(state.settings);
}
chrome.runtime.onInstalled.addListener(initAlarms);
chrome.runtime.onStartup.addListener(initAlarms);

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
        case "SET_SETTINGS":
          sendResponse(await handleSetSettings(msg.payload));
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
