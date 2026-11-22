// background.js — service worker (MV3)
// Source de vérité unique pour le state : chrome.storage.local
//   stock       : { [normalizedName]: { name: string, qty: number, printings?: [{set, cn, qty}] } }
//     qty : exemplaires libres ; printings : exemplaires POSSÉDÉS par édition
//     (cf. parseCollectionCSV), pour toute carte dont la collection donne
//     l'édition.
//   builtDecks  : { [deckId]: { name: string, url: string, cards: [{name, qty, versions?, proxyQty?, proxyPrinting?}], builtAt: number,
//     versions : [{code, qty, set?, cn?}], impressions Moxfield lues sur la
//     page au montage (cf. ownedVersionOf dans deck-scraper.js) ; set et cn :
//     édition et numéro donnés par l'API du deck quand elle a répondu (cf.
//     GET_DECK_PRINTINGS), comme dans printings.
//     proxyQty : exemplaires joués en proxy, jamais pris au stock ;
//     proxyPrinting : {set, cn} de la version à imprimer (cf. proxyCountOf
//     dans deck-checks.js).
//                   updatedAt?: number,
//                   pageChanges?: [{name, from, to}], pageCheckedAt?: number } }
//     pageChanges : différences constatées sur la page Moxfield du deck par
//     rapport au montage (absent = aucune, ou jamais constaté).
//   history     : [entrée] — historique des changements, le plus récent en
//                 premier (cf. history.js). Synchronisé avec le reste.
//   followedDecks : { [deckId]: { name, url, addedAt } } — decks de la vue
//                 « Mes decks » du popup (ouverts sur Moxfield ou ajoutés à
//                 la main), en plus des decks montés. Synchronisé ; une
//                 ancienne version de l'extension l'ignore et le perd en
//                 écrivant l'état (rien d'autre n'est touché).

// Modules partagés (chargés tels quels, cf. leur en-tête) :
// createDeckChecks, createMoxfieldCollection, computeCollectionDiff,
// createHistory, createErrorReports, createGoogleWebAuth, chooseAuthMethod,
// createChromeI18n, createUpdateCheck.
importScripts("i18n.js", "deck-checks.js", "moxfield-collection.js", "history.js", "error-reports.js", "google-auth.js", "update-check.js");

// Textes renvoyés au popup et à la page d'un deck (erreurs, historique),
// dans la langue du navigateur (cf. i18n.js).
const i18n = createChromeI18n();

const STORAGE_KEY = "moxfieldStockManagerState";

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Règles partagées avec la page d'un deck et le popup (cf. deck-checks.js).
const {
  isBasicLand,
  stockQtyOf,
  proxyCountOf,
  proxyTotal,
  replaceableProxies,
  chooseOwnedEdition,
  buildVersionUsage,
  computeDeckAvailability,
  availabilityLabel,
  cardsFromDeckApi,
} = createDeckChecks(
  normalizeName,
  i18n
);

// Seuls stock, builtDecks et history sont conservés : une ancienne version stockait
// aussi les réglages de synchro automatique (settings, lastAutoSync...),
// fonctionnalité retirée car jamais fonctionnelle — ces clés sont ignorées
// ici et disparaissent à la prochaine écriture de l'état.
async function getState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const state = data[STORAGE_KEY] || {};
  return {
    stock: state.stock || {},
    builtDecks: state.builtDecks || {},
    history: Array.isArray(state.history) ? state.history : [],
    followedDecks: isPlainObject(state.followedDecks) ? state.followedDecks : {},
  };
}

// Toute modification locale passe par ici et sera envoyée sur Drive si la
// synchro est active. writeState sert aux écritures venant de Drive, qui ne
// doivent pas être renvoyées.
async function setState(state) {
  await writeState(state);
  await markDirty();
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// --- Historique ---
// Chaque action qui change le stock ou les decks montés y est notée, avec
// le PC d'origine : Chrome ne donne pas le nom de l'ordinateur, chaque PC
// tire donc un identifiant au hasard, propre à ce PC (non synchronisé).
const DEVICE_KEY = "moxfieldStockManagerDevice";
const historyLog = createHistory(normalizeName, i18n);

async function getDeviceId() {
  const data = await chrome.storage.local.get(DEVICE_KEY);
  if (data[DEVICE_KEY]) return data[DEVICE_KEY];
  const id = historyLog.newId();
  await chrome.storage.local.set({ [DEVICE_KEY]: id });
  return id;
}

async function recordHistory(state, entry) {
  const full = { id: historyLog.newId(), at: Date.now(), device: await getDeviceId(), ...entry };
  state.history = historyLog.addEntry(state.history, full);
}

// --- Rapports d'erreurs (Sentry, cf. error-reports.js) ---
// DSN du projet Sentry qui reçoit les erreurs de toutes les installations
// (vide : aucun envoi). Pas un secret, elle ne permet que d'envoyer.
const SENTRY_DSN = "https://40773adedc23e5995ac79439fb0f356e@o4512265832103936.ingest.de.sentry.io/4512265848225872";
// { enabled: false } si l'utilisateur a coupé l'envoi (actif par défaut),
// log : limitation du nombre d'envois (cf. allow).
const ERROR_REPORTS_KEY = "moxfieldStockManagerErrorReports";
const errorReports = createErrorReports({ dsn: SENTRY_DSN, fetch: (...args) => fetch(...args) });

async function getErrorReportsMeta() {
  const data = await chrome.storage.local.get(ERROR_REPORTS_KEY);
  return { enabled: true, ...data[ERROR_REPORTS_KEY] };
}

async function updateErrorReportsMeta(patch) {
  const meta = { ...(await getErrorReportsMeta()), ...patch };
  await chrome.storage.local.set({ [ERROR_REPORTS_KEY]: meta });
  return meta;
}

// Erreur inattendue : envoyée si l'envoi est actif et pas trop fréquente.
// where : endroit (ex. "message:TOGGLE_DECK_BUILT", "drive-sync") ;
// error : Error, ou { message, stack, type } venant d'une page. Ne lève
// jamais. Les envois passent l'un après l'autre (journal de limitation).
let errorReportQueue = Promise.resolve();
function reportError(where, error, extra) {
  const run = errorReportQueue.then(async () => {
    if (!errorReports.configured || (error && error.expected)) return false;
    const meta = await getErrorReportsMeta();
    if (!meta.enabled) return false;
    const report = {
      where,
      message: (error && error.message) || String(error),
      stack: error && error.stack,
      type: (error && (error.type || error.name)) || "Error",
      extra,
    };
    const { allowed, log } = errorReports.allow(meta.log, report);
    await updateErrorReportsMeta({ log });
    if (!allowed) return false;
    const event = errorReports.buildEvent(report, {
      release: chrome.runtime.getManifest().version,
      installId: await getDeviceId(),
      nav: typeof navigator !== "undefined" ? navigator : null,
    });
    const sent = await errorReports.send(event);
    if (sent) await updateErrorReportsMeta({ lastSentAt: Date.now() });
    return sent;
  });
  errorReportQueue = run.catch(() => {});
  return run.catch(() => false);
}

// Erreurs qui échappent à tout try/catch du service worker.
if (typeof self !== "undefined" && self.addEventListener) {
  self.addEventListener("error", (event) => reportError("service-worker", event.error || event.message));
  self.addEventListener("unhandledrejection", (event) => reportError("service-worker", event.reason));
}

// Erreur d'origine (cause), utile au diagnostic mais pas affichée.
function causeOf(e) {
  return e && e.cause ? { cause: `${e.cause.name || "Error"}: ${e.cause.message || e.cause}` } : undefined;
}

async function handleSetErrorReports({ enabled }) {
  const meta = await updateErrorReportsMeta({ enabled: Boolean(enabled) });
  return { ok: true, enabled: meta.enabled, configured: errorReports.configured };
}

// --- Parsing CSV export Moxfield ---
// Header connu : Count,Tradelist Count,Name,Edition,Condition,Language,Foil,Tags,Last Modified,Collector Number,Alter,Proxy,Purchase Price
// On agrège par nom de carte (toutes éditions/finish confondues) : le stock physique est géré au nom de carte, pas à l'édition près.
// Le détail par édition (Edition + Collector Number, toutes finitions,
// langues et états confondus) n'est gardé que pour les cartes possédées en
// plusieurs éditions : il sert à refuser qu'une même version parte dans
// deux decks montés (cf. computeVersionConflicts dans deck-checks.js). Avec
// une seule édition, le stock par nom suffit — et sur une grosse collection
// (30 000 noms), garder le détail de tout doublerait la taille de l'état.
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
  const { aggregated, editions } = parseCollectionRows(csvText);
  // Toute carte, même possédée dans une seule édition : la sauvegarde
  // (téléchargeable depuis le popup) montre ainsi l'édition de chaque
  // carte. Les anciennes versions de l'extension ignorent ce champ ; elles
  // le perdent seulement en réimportant la collection, et la récupération
  // suivante d'une version à jour le remet (cf. printingsChanged).
  for (const [key, byEdition] of editions) {
    // Finitions laissées de côté : le stock ne les distingue pas.
    aggregated[key].printings = [...byEdition.values()]
      .map(({ set, cn, qty }) => ({ set, cn, qty }))
      .sort((a, b) => a.set.localeCompare(b.set) || a.cn.localeCompare(b.cn));
  }
  return aggregated;
}

// Éditions possédées de chaque carte, une seule édition comprise : Map nom
// normalisé → [{ set, cn, qty, finishes: { nonFoil?, foil?, etched? } }]
// (exemplaires par finition). Pour le changement d'édition d'un deck
// seulement, jamais enregistré dans l'état (cf. parseCollectionCSV).
function collectionEditions(csvText) {
  const result = new Map();
  for (const [key, byEdition] of parseCollectionRows(csvText).editions) result.set(key, [...byEdition.values()]);
  return result;
}

function parseCollectionRows(csvText) {
  const lines = csvText.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error(i18n.t("csvEmpty"));

  const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const countIdx = header.indexOf("count");
  const nameIdx = header.indexOf("name");
  if (countIdx === -1 || nameIdx === -1) {
    throw new Error(i18n.t("csvColumnsMissing"));
  }

  const editionIdx = header.indexOf("edition");
  const numberIdx = header.indexOf("collector number");
  // Colonne « Foil » de l'export Moxfield : « foil », « etched » ou vide.
  const foilIdx = header.indexOf("foil");

  const aggregated = {};
  const editions = new Map(); // nom normalisé → Map("édition|numéro" → { set, cn, qty })
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    const rawName = (cells[nameIdx] || "").trim();
    const rawCount = parseInt((cells[countIdx] || "0").trim(), 10);
    if (!rawName || Number.isNaN(rawCount)) continue;
    const key = normalizeName(rawName);
    if (!aggregated[key]) aggregated[key] = { name: rawName, qty: 0 };
    aggregated[key].qty += rawCount;
    if (editionIdx === -1 || rawCount <= 0) continue;
    const set = (cells[editionIdx] || "").trim().toLowerCase();
    const cn = numberIdx === -1 ? "" : (cells[numberIdx] || "").trim().toLowerCase();
    if (!set) continue;
    if (!editions.has(key)) editions.set(key, new Map());
    const byEdition = editions.get(key);
    const editionKey = `${set}|${cn}`;
    if (!byEdition.has(editionKey)) byEdition.set(editionKey, { set, cn, qty: 0, finishes: {} });
    const edition = byEdition.get(editionKey);
    edition.qty += rawCount;
    const foil = foilIdx === -1 ? "" : (cells[foilIdx] || "").trim().toLowerCase();
    const finish = foil === "etched" ? "etched" : foil === "foil" ? "foil" : "nonFoil";
    edition.finishes[finish] = (edition.finishes[finish] || 0) + rawCount;
  }
  return { aggregated, editions };
}

// --- Handlers ---

// Stock correspondant à une collection : la collection, moins les cartes
// des decks montés (qui en ont été retirées au montage).
function stockFromCollection(collection, builtDecks) {
  const stock = {};
  for (const [key, c] of Object.entries(collection)) stock[key] = { ...c };
  moveCardsInStock(
    stock,
    Object.values(builtDecks).flatMap((deck) => deck.cards),
    -1
  );
  return stock;
}

// Inverse : quantités possédées (stock libre + cartes des decks montés).
function collectionFromState(state) {
  const collection = {};
  for (const [key, c] of Object.entries(state.stock)) collection[key] = { ...c };
  moveCardsInStock(
    collection,
    Object.values(state.builtDecks).flatMap((deck) => deck.cards),
    +1
  );
  return collection;
}

// Le détail par édition a-t-il changé entre le stock et une collection ?
// Les quantités par nom peuvent rester les mêmes (une édition échangée
// contre une autre, ou premier passage depuis que ce détail existe) : il
// faut quand même l'enregistrer.
function printingsChanged(stock, collection) {
  const same = (a, b) => JSON.stringify((a && a.printings) || null) === JSON.stringify((b && b.printings) || null);
  for (const key of Object.keys(collection)) if (!same(stock[key], collection[key])) return true;
  for (const key of Object.keys(stock)) if (stock[key].printings && !collection[key]) return true;
  return false;
}

async function handleImportCSV(csvText) {
  const parsed = parseCollectionCSV(csvText);
  const state = await getState();
  const changes = computeCollectionDiff(collectionFromState(state), parsed);
  state.stock = stockFromCollection(parsed, state.builtDecks);
  if (changes.length > 0) await recordHistory(state, { type: "collection", source: "csv", changes });
  await setState(state);
  const totalQty = Object.values(parsed).reduce((sum, c) => sum + c.qty, 0);
  return { ok: true, cardCount: Object.keys(parsed).length, totalQty };
}

// sign = -1 : les cartes partent dans un deck (montage) ; +1 : elles
// reviennent au stock (démontage).
// Cartes excludedFromStock (absentes de la collection Moxfield) et proxies :
// jamais décomptés (cf. stockQtyOf).
function moveCardsInStock(stock, cards, sign) {
  for (const card of cards) {
    const qty = stockQtyOf(card);
    if (qty === 0) continue;
    const key = normalizeName(card.name);
    if (!stock[key]) stock[key] = { name: card.name, qty: 0 };
    stock[key].qty += sign * qty;
  }
}

// Exemplaires pris au stock par une liste (historique).
function stockCount(cards) {
  return cards.reduce((n, c) => n + stockQtyOf(c), 0);
}

// Champs proxy reçus d'une page : proxyQty entier entre 1 et la quantité,
// proxyPrinting { set, cn } court ; tout le reste est retiré plutôt que
// d'enregistrer une valeur qui fausserait le stock.
function cleanProxyFields(cards) {
  const short = (value) => (typeof value === "string" ? value.slice(0, 20) : "");
  return (cards || []).map((card) => {
    if (!("proxyQty" in card) && !("proxyPrinting" in card)) return card;
    const { proxyQty, proxyPrinting, ...rest } = card;
    if (!Number.isInteger(proxyQty) || proxyQty < 1 || proxyQty > card.qty) return rest;
    const clean = { ...rest, proxyQty };
    if (proxyPrinting && short(proxyPrinting.set)) clean.proxyPrinting = { set: short(proxyPrinting.set), cn: short(proxyPrinting.cn) };
    return clean;
  });
}

// Montage / démontage, notés dans l'historique. cardCount : exemplaires pris
// au stock (ou rendus) ; proxyCount : proxies, s'il y en a.
function withProxyCount(entry, cards) {
  const proxies = proxyTotal(cards);
  return proxies > 0 ? { ...entry, proxyCount: proxies } : entry;
}

async function buildDeck(state, { deckId, deckName, url, cards }) {
  const builtAt = Date.now();
  moveCardsInStock(state.stock, cards, -1);
  state.builtDecks[deckId] = { name: deckName, url, cards, builtAt };
  await recordHistory(state, withProxyCount({ type: "deck-built", deckId, deckName, url, builtAt, cardCount: stockCount(cards) }, cards));
}

async function unbuildDeck(state, deckId) {
  const deck = state.builtDecks[deckId];
  moveCardsInStock(state.stock, deck.cards, +1);
  delete state.builtDecks[deckId];
  await recordHistory(
    state,
    withProxyCount({ type: "deck-unbuilt", deckId, deckName: deck.name, url: deck.url, cards: deck.cards, cardCount: stockCount(deck.cards) }, deck.cards)
  );
}

async function handleToggleDeck({ deckId, deckName, url, cards, built }) {
  const state = await getState();

  if (built) {
    if (state.builtDecks[deckId]) return { ok: true, alreadyBuilt: true };
    await buildDeck(state, { deckId, deckName, url, cards: cleanProxyFields(cards) });
  } else {
    if (!state.builtDecks[deckId]) return { ok: true, wasNotBuilt: true };
    await unbuildDeck(state, deckId);
  }

  await setState(state);
  return { ok: true };
}

// Deck monté dont la liste a changé sur Moxfield : équivaut à le démonter
// puis le remonter avec la nouvelle liste, en une seule écriture — seules
// les cartes modifiées voient donc leur stock bouger.
async function updateDeck(state, { deckId, deckName, url, cards }) {
  const deck = state.builtDecks[deckId];
  moveCardsInStock(state.stock, deck.cards, +1);
  moveCardsInStock(state.stock, cards, -1);
  const updated = { ...deck, name: deckName, url, cards, updatedAt: Date.now() };
  delete updated.pageChanges; // le montage correspond de nouveau à la page
  delete updated.pageCheckedAt;
  state.builtDecks[deckId] = updated;
  const entry = {
    type: "deck-updated",
    deckId,
    deckName,
    url,
    changes: historyLog.cardsDiff(deck.cards, cards),
    previousCards: deck.cards,
    updatedAt: updated.updatedAt,
  };
  // Proxies ajoutés pour des cartes en stock insuffisant.
  const proxiesAdded = proxyTotal(cards) - proxyTotal(deck.cards);
  if (proxiesAdded > 0) entry.proxiesAdded = proxiesAdded;
  await recordHistory(state, entry);
}

async function handleUpdateBuiltDeck({ deckId, deckName, url, cards }) {
  const state = await getState();
  if (!state.builtDecks[deckId]) throw new Error(i18n.t("deckNoLongerBuilt"));
  await updateDeck(state, { deckId, deckName, url, cards: cleanProxyFields(cards) });
  await setState(state);
  return { ok: true };
}

// Proxies d'un deck monté remplacés par la vraie carte, dès que le stock
// libre le permet (cf. replaceableProxies) : la carte est alors prise au
// stock comme les autres. Aucune vérification de version : le doute
// profite au montage, comme au montage par recoupement.
async function handleReplaceProxies({ deckId }) {
  const state = await getState();
  const deck = state.builtDecks[deckId];
  if (!deck) throw Object.assign(new Error(i18n.t("deckNoLongerBuilt")), { expected: true });
  const replaced = replaceableProxies(deck, state.stock);
  if (replaced.length === 0) throw Object.assign(new Error(i18n.t("proxiesNothingToReplace")), { expected: true });
  const left = new Map(replaced.map((r) => [normalizeName(r.name), r.qty]));
  deck.cards = deck.cards.map((card) => {
    const key = normalizeName(card.name);
    const qty = Math.min(left.get(key) || 0, proxyCountOf(card));
    if (qty === 0) return card;
    left.set(key, left.get(key) - qty);
    const { proxyQty, proxyPrinting, ...rest } = card;
    const remaining = proxyCountOf(card) - qty;
    return remaining > 0 ? { ...card, proxyQty: remaining } : rest;
  });
  moveCardsInStock(state.stock, replaced, -1);
  await recordHistory(state, {
    type: "proxies-replaced",
    deckId,
    deckName: deck.name,
    url: deck.url,
    cards: replaced,
  });
  await setState(state);
  return { ok: true, replaced };
}

// Proxies d'un deck monté, pour la page d'impression (proxies.html) :
// seulement ce deck, pas l'état complet.
async function handleGetDeckProxies({ deckId }) {
  const { builtDecks } = await getState();
  const deck = builtDecks[deckId];
  if (!deck) return { ok: true, deck: null };
  const cards = deck.cards
    .filter((c) => proxyCountOf(c) > 0)
    .map((c) => ({ name: c.name, qty: proxyCountOf(c), ...(c.proxyPrinting ? { set: c.proxyPrinting.set, cn: c.proxyPrinting.cn } : {}) }));
  return { ok: true, deck: { name: deck.name, url: deck.url, cards } };
}

// Page d'impression des proxies d'un deck, ouverte dans un nouvel onglet :
// une page de Moxfield ne peut pas ouvrir elle-même une page de
// l'extension.
async function handleOpenProxiesPage({ deckId }) {
  if (typeof deckId !== "string" || !deckId) return { ok: false, error: i18n.t("deckNoLongerBuilt") };
  await chrome.tabs.create({ url: chrome.runtime.getURL(`proxies.html?deck=${encodeURIComponent(deckId)}`) });
  return { ok: true };
}

// Versions lues sur la page d'un deck monté qui n'en avait pas (monté avant
// leur suivi, ou depuis une liste collée) :
// { [nom normalisé]: [{code, qty, set?, cn?}] }.
// Ne complète que les cartes sans version, ou les mêmes versions (codes et
// quantités) auxquelles il manque l'édition — jamais une autre version que
// celle enregistrée (un changement de version passe par la mise à jour du
// montage, avec ses contrôles). Ni le stock ni la liste du deck ne
// changent : pas d'entrée dans l'historique. N'écrit que si quelque chose
// change — chaque écriture part sur Drive.
async function handleSetDeckVersions({ deckId, versions }) {
  const state = await getState();
  const deck = state.builtDecks[deckId];
  if (!deck || !versions) return { ok: true, ignored: true };
  const edition = (value) => (typeof value === "string" ? value.slice(0, 20) : "");
  const sameVersions = (a, b) => JSON.stringify(a.map((v) => [v.code, v.qty]).sort()) === JSON.stringify(b.map((v) => [v.code, v.qty]).sort());
  let changed = false;
  for (const card of deck.cards) {
    const found = versions[normalizeName(card.name)];
    if (!Array.isArray(found) || found.length === 0) continue;
    const clean = found
      .filter((v) => v && typeof v.code === "string" && Number.isInteger(v.qty) && v.qty > 0)
      .map((v) => (edition(v.set) ? { code: v.code, qty: v.qty, set: edition(v.set), cn: edition(v.cn) } : { code: v.code, qty: v.qty }));
    if (clean.length === 0 || clean.reduce((n, v) => n + v.qty, 0) > card.qty) continue;
    const known = card.versions || [];
    if (known.length > 0) {
      const gain = clean.some((v) => v.set && known.some((k) => k.code === v.code && !k.set));
      if (!gain || !sameVersions(known, clean)) continue;
      // Une édition déjà enregistrée n'est pas retirée par une page qui ne
      // l'a pas (encore) lue.
      card.versions = clean.map((v) => (v.set ? v : known.find((k) => k.code === v.code)));
    } else {
      card.versions = clean;
    }
    changed = true;
  }
  if (!changed) return { ok: true, unchanged: true };
  await setState(state);
  return { ok: true };
}

// Constat fait sur la page du deck (content-deck.js) : différences entre la
// liste Moxfield et le montage, vide si identiques. Sert au badge
// « Modifié » du popup. N'écrit que si le constat change : la page est
// vérifiée toutes les 3 secondes, et chaque écriture part sur Drive.
async function handleSetDeckPageChanges({ deckId, changes }) {
  const state = await getState();
  const deck = state.builtDecks[deckId];
  if (!deck) return { ok: true, ignored: true };
  if (JSON.stringify(deck.pageChanges || []) === JSON.stringify(changes)) return { ok: true, unchanged: true };
  if (changes.length > 0) {
    deck.pageChanges = changes;
    deck.pageCheckedAt = Date.now();
  } else {
    delete deck.pageChanges;
    delete deck.pageCheckedAt;
  }
  await setState(state);
  return { ok: true };
}

// --- Synchronisation Google Drive ---
// L'état complet est stocké dans un fichier unique de l'appDataFolder de
// Drive : dossier caché, propre à l'extension (scope drive.appdata), sans
// accès aux autres fichiers de l'utilisateur. Chaque modification locale
// marque l'état « dirty » et déclenche un envoi différé ; une alarme
// périodique, le démarrage du navigateur et l'ouverture du popup récupèrent
// les changements faits sur un autre PC.
//
// Détection des changements distants : Drive incrémente le champ `version`
// du fichier à chaque écriture. Une version distante différente de la
// dernière version synchronisée signifie qu'un autre PC a écrit entre-temps.
// Conflit (changements des deux côtés) : le plus récent gagne, l'autre
// version est conservée dans l'historique pour ne rien perdre.
//
// Historique : un instantané daté par jour et par PC au plus, plus les
// versions écartées lors d'un conflit ; seuls les DRIVE_MAX_SNAPSHOTS plus
// récents sont gardés.
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_STATE_FILE = "moxfield-stock-state.json";
const DRIVE_SNAPSHOT_PREFIX = "moxfield-stock-";
const DRIVE_MAX_SNAPSHOTS = 10;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SYNC_META_KEY = "moxfieldStockManagerSync";
const SYNC_ALARM = "drive-sync";
const SYNC_PERIOD_MINUTES = 5;
const PUSH_DELAY_MS = 3000;
const DOC_APP = "moxfield-stock-manager";
const DOC_VERSION = 1;

async function getSyncMeta() {
  const data = await chrome.storage.local.get(SYNC_META_KEY);
  return {
    enabled: false,
    dirty: false,
    localUpdatedAt: 0,
    syncedVersion: null,
    lastSyncAt: null,
    lastSnapshotAt: 0,
    lastError: null,
    pendingChoice: null,
    accountId: null,
    accountEmail: null,
    accountMismatch: null,
    // "chrome" (compte du profil, getAuthToken) ou "web" (fenêtre de
    // connexion, cf. google-auth.js) ; absent avant octobre 2026 : chrome.
    authMethod: null,
    ...data[SYNC_META_KEY],
  };
}

async function updateSyncMeta(patch) {
  const meta = { ...(await getSyncMeta()), ...patch };
  await chrome.storage.local.set({ [SYNC_META_KEY]: meta });
  return meta;
}

let pushTimer = null;

async function markDirty() {
  const meta = await updateSyncMeta({ dirty: true, localUpdatedAt: Date.now() });
  if (!meta.enabled) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), PUSH_DELAY_MS);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function makeDoc(state, updatedAt) {
  return { app: DOC_APP, version: DOC_VERSION, updatedAt, state };
}

// Accepte aussi les sauvegardes manuelles d'une version précédente, qui
// n'avaient qu'un champ exportedAt.
function parseDoc(doc) {
  if (!isPlainObject(doc) || doc.app !== DOC_APP) {
    throw new Error(i18n.t("backupNotOurs"));
  }
  if (doc.version !== DOC_VERSION) {
    throw new Error(i18n.t("backupVersionUnsupported", doc.version));
  }
  const { stock, builtDecks } = doc.state || {};
  if (!isPlainObject(stock) || !isPlainObject(builtDecks)) {
    throw new Error(i18n.t("backupMissingParts"));
  }
  for (const c of Object.values(stock)) {
    if (typeof c?.name !== "string" || !Number.isFinite(c?.qty)) {
      throw new Error(i18n.t("backupBadStockEntry"));
    }
  }
  for (const d of Object.values(builtDecks)) {
    if (typeof d?.name !== "string" || !Array.isArray(d?.cards)) {
      throw new Error(i18n.t("backupBadDeck"));
    }
  }
  // Historique absent des sauvegardes d'avant sa création ; entrées
  // invalides écartées plutôt que de refuser toute la sauvegarde.
  const rawHistory = Array.isArray(doc.state.history) ? doc.state.history : [];
  const history = rawHistory.filter((e) => isPlainObject(e) && typeof e.id === "string" && Number.isFinite(e.at));
  // Decks suivis : absents des sauvegardes d'avant « Mes decks » ; entrées
  // invalides écartées.
  const followedDecks = {};
  for (const [id, d] of Object.entries(isPlainObject(doc.state.followedDecks) ? doc.state.followedDecks : {})) {
    if (isDeckId(id) && isPlainObject(d) && typeof d.name === "string") followedDecks[id] = d;
  }
  return { state: { stock, builtDecks, history, followedDecks }, updatedAt: doc.updatedAt || Date.parse(doc.exportedAt) || 0 };
}

// Identifiant OAuth « Application Web » de la fenêtre de connexion (cf.
// google-auth.js) ; celui de getAuthToken est dans le manifest (oauth2).
const GOOGLE_WEB_CLIENT_ID = "494997360432-b2572mk99tjvd882i4695b83d71d1oka.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const browserNavigator = typeof navigator !== "undefined" ? navigator : null;
const googleWebAuth = createGoogleWebAuth({
  identity: chrome.identity,
  session: chrome.storage.session,
  runtime: chrome.runtime,
  fetch: (...args) => fetch(...args),
  clientId: GOOGLE_WEB_CLIENT_ID,
  scope: DRIVE_SCOPE,
  i18n,
  isBrave: Boolean(browserNavigator && browserNavigator.brave),
});

function authMethodOf(meta) {
  return meta.authMethod || "chrome";
}

// interactive : seulement sur un clic de l'utilisateur (fenêtre Google
// possible), jamais depuis une synchro en fond.
async function getAuthToken(interactive) {
  const meta = await getSyncMeta();
  if (authMethodOf(meta) === "web") {
    return (await googleWebAuth.getToken({ interactive, loginHint: meta.accountEmail })).token;
  }
  let token;
  try {
    ({ token } = await chrome.identity.getAuthToken({ interactive }));
  } catch (e) {
    // Jeton à renouveler : situation normale, pas une erreur à rapporter.
    throw Object.assign(new Error(i18n.t(interactive ? "googleCancelled" : "googleRenew"), { cause: e }), { expected: !interactive });
  }
  if (!token) throw new Error(i18n.t("googleCancelled"));
  return token;
}

async function invalidateAuthToken(token) {
  if (authMethodOf(await getSyncMeta()) === "web") await googleWebAuth.invalidate();
  else await chrome.identity.removeCachedAuthToken({ token });
}

// Google Drive répond parfois 503 « Transient failure » (constaté dans les
// rapports d'erreurs), ou 429 quand on va trop vite : la requête est
// réessayée après ces délais. Jamais une création (POST) : après un 503, le
// fichier a pu être créé quand même, la réessayer risquerait de le doubler.
const DRIVE_RETRY_DELAYS_MS = [1000, 4000];

// Un token en cache peut avoir expiré ou été révoqué : sur un 401, on
// l'invalide et on réessaie une fois avec un token neuf, demandé en
// silence (pas de seconde fenêtre Google pendant une connexion).
// Drive indisponible ou réseau coupé : situation normale, pas de rapport
// d'erreur (expected) ; la synchro suivante réessaie.
async function driveFetch(url, options = {}, interactive = false) {
  const delays = options.method === "POST" ? [] : DRIVE_RETRY_DELAYS_MS;
  let tokenRenewed = false;
  let retries = 0;
  for (;;) {
    const token = await getAuthToken(interactive && !tokenRenewed && retries === 0);
    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      throw Object.assign(new Error(i18n.t("driveUnreachable"), { cause: e }), { expected: true });
    }
    if (res.status === 401 && !tokenRenewed) {
      tokenRenewed = true;
      await invalidateAuthToken(token);
      continue;
    }
    const unavailable = res.status === 429 || res.status >= 500;
    if (unavailable && retries < delays.length) {
      await new Promise((resolve) => setTimeout(resolve, delays[retries++]));
      continue;
    }
    if (unavailable) {
      throw Object.assign(new Error(i18n.t("driveUnavailable", res.status)), { expected: true });
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(i18n.t("driveHttpError", res.status, body.slice(0, 200)));
    }
    return res;
  }
}

async function findStateFile(interactive = false) {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name = '${DRIVE_STATE_FILE}'`,
    fields: "files(id,version)",
  });
  const res = await driveFetch(`${DRIVE_API}/files?${params}`, {}, interactive);
  return (await res.json()).files[0] || null;
}

// Fichiers Drive compressés (gzip, intégré au navigateur) : chaque
// modification renvoie tout l'état, plusieurs Mo pour une grosse collection
// (÷4 à ÷5 une fois compressé), et l'historique des versions en garde 10.
// Les fichiers sont reconnus à leur contenu, pas à leur nom (inchangé) : les
// sauvegardes d'avant la compression, en JSON, restent lisibles.
const GZIP_TYPE = "application/gzip";

async function encodeDoc(doc) {
  const stream = new Blob([JSON.stringify(doc)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(stream).arrayBuffer()], { type: GZIP_TYPE });
}

async function decodeDoc(buffer) {
  const bytes = new Uint8Array(buffer);
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b; // signature gzip
  if (!gzipped) return JSON.parse(new TextDecoder().decode(bytes));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

async function downloadDoc(fileId) {
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
  return parseDoc(await decodeDoc(await res.arrayBuffer()));
}

async function createDriveFile(metadata, doc) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ ...metadata, parents: ["appDataFolder"], mimeType: GZIP_TYPE })], { type: "application/json" }));
  form.append("file", await encodeDoc(doc));
  const res = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,version`, { method: "POST", body: form });
  return res.json();
}

async function uploadStateDoc(fileId, doc) {
  if (!fileId) return createDriveFile({ name: DRIVE_STATE_FILE }, doc);
  const res = await driveFetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,version`, {
    method: "PATCH",
    headers: { "Content-Type": GZIP_TYPE },
    body: await encodeDoc(doc),
  });
  return res.json();
}

async function listSnapshots() {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name contains '${DRIVE_SNAPSHOT_PREFIX}' and name != '${DRIVE_STATE_FILE}'`,
    orderBy: "createdTime desc",
    fields: "files(id,createdTime,size,appProperties)",
    pageSize: "100",
  });
  const res = await driveFetch(`${DRIVE_API}/files?${params}`);
  return (await res.json()).files;
}

// reason : "daily" (instantané quotidien) ou "conflict" (version écartée).
async function createSnapshot(doc, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await createDriveFile({ name: `${DRIVE_SNAPSHOT_PREFIX}${stamp}.json`, appProperties: { reason } }, doc);
  const files = await listSnapshots();
  for (const old of files.slice(DRIVE_MAX_SNAPSHOTS)) {
    await driveFetch(`${DRIVE_API}/files/${old.id}`, { method: "DELETE" });
  }
}

// L'historique local est fusionné à celui de Drive : une action faite sur ce
// PC reste dans l'historique même quand la version de Drive l'emporte. S'il
// apporte des entrées que Drive n'a pas, l'état reste à envoyer.
async function applyRemote(parsed, remoteFile) {
  const local = await getState();
  const history = historyLog.mergeHistories(parsed.state.history, local.history);
  const remoteIds = new Set(parsed.state.history.map((e) => e.id));
  const extra = history.some((e) => !remoteIds.has(e.id));
  await writeState({ ...parsed.state, history });
  await updateSyncMeta({
    syncedVersion: remoteFile.version,
    dirty: extra,
    localUpdatedAt: extra ? Date.now() : parsed.updatedAt,
  });
}

// Inverse, quand la version de ce PC l'emporte sur celle de Drive.
async function mergeRemoteHistory(remoteDoc) {
  const state = await getState();
  state.history = historyLog.mergeHistories(state.history, remoteDoc.state.history);
  await writeState(state);
}

// Une modification locale peut arriver pendant l'envoi : on ne repasse
// dirty à false que si rien n'a changé depuis la lecture de l'état envoyé.
async function pushLocal(fileId) {
  const { localUpdatedAt } = await getSyncMeta();
  const updatedAt = localUpdatedAt || Date.now();
  const file = await uploadStateDoc(fileId, makeDoc(await getState(), updatedAt));
  const current = await getSyncMeta();
  await updateSyncMeta({ syncedVersion: file.version, dirty: current.localUpdatedAt !== localUpdatedAt });
}

async function maybeDailySnapshot() {
  const meta = await getSyncMeta();
  if (Date.now() - meta.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
  await createSnapshot(makeDoc(await getState(), meta.localUpdatedAt), "daily");
  await updateSyncMeta({ lastSnapshotAt: Date.now() });
}

// Le compte Google utilisé est celui du profil Chrome (getAuthToken sans
// compte explicite), ou celui choisi dans la fenêtre de connexion. S'il
// change, le fichier Drive n'est plus le même : on met la synchro en pause
// (accountMismatch) au lieu d'écraser le stock local avec celui d'un autre
// compte, et le popup demande quoi faire.
async function getCurrentAccount(meta) {
  if (authMethodOf(meta) === "web") {
    const email = await googleWebAuth.currentEmail();
    return email ? { id: null, email } : null;
  }
  const { id, email } = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
  return id ? { id, email } : null;
}

// Même compte : même identifiant de profil Chrome, ou même adresse. Pas de
// comparaison d'identifiants d'une méthode à l'autre : pour un même compte,
// celui du profil Chrome et celui de Drive diffèrent (constaté en vrai).
function isSameAccount(account, meta) {
  if (!meta.accountId && !meta.accountEmail) return true;
  if (account.id && meta.accountId && account.id === meta.accountId) return true;
  return Boolean(account.email && meta.accountEmail && account.email.toLowerCase() === meta.accountEmail.toLowerCase());
}

async function currentAccountPatch() {
  const account = await getCurrentAccount(await getSyncMeta());
  return account ? { accountId: account.id, accountEmail: account.email, accountMismatch: null } : {};
}

async function runSync() {
  let meta = await getSyncMeta();
  if (!meta.enabled || meta.pendingChoice) return meta;
  try {
    // Fenêtre de connexion : compte du dernier jeton obtenu (inconnu après un
    // redémarrage du navigateur, le temps du premier renouvellement, qui
    // reprend de toute façon le même compte).
    const account = await getCurrentAccount(meta);
    if (account && !isSameAccount(account, meta)) {
      if (meta.accountMismatch?.email === account.email) return meta;
      return updateSyncMeta({ accountMismatch: { email: account.email } });
    }
    if (account && (meta.accountMismatch || meta.accountId !== account.id || meta.accountEmail !== account.email)) {
      meta = await updateSyncMeta({ accountId: account.id, accountEmail: account.email, accountMismatch: null });
    }
    const remote = await findStateFile();
    if (!remote) {
      await pushLocal(null);
    } else if (remote.version === meta.syncedVersion) {
      if (meta.dirty) await pushLocal(remote.id);
    } else {
      const remoteDoc = await downloadDoc(remote.id);
      meta = await getSyncMeta(); // relu : une modification locale a pu arriver pendant le téléchargement
      if (!meta.dirty) {
        await applyRemote(remoteDoc, remote);
      } else if (remoteDoc.updatedAt > meta.localUpdatedAt) {
        await createSnapshot(makeDoc(await getState(), meta.localUpdatedAt), "conflict");
        await applyRemote(remoteDoc, remote);
      } else {
        await createSnapshot(makeDoc(remoteDoc.state, remoteDoc.updatedAt), "conflict");
        await mergeRemoteHistory(remoteDoc);
        await pushLocal(remote.id);
      }
    }
    await maybeDailySnapshot();
    return await updateSyncMeta({ lastSyncAt: Date.now(), lastError: null });
  } catch (e) {
    reportError("drive-sync", e, causeOf(e));
    return await updateSyncMeta({ lastError: e.message || String(e) });
  }
}

// Les synchros sont exécutées l'une après l'autre, jamais en parallèle.
let syncQueue = Promise.resolve();
function syncNow() {
  const run = syncQueue.then(runSync);
  syncQueue = run.catch(() => {});
  return run;
}

function startSyncAlarm() {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
}

function isLocalEmpty(state) {
  return Object.keys(state.stock).length === 0 && Object.keys(state.builtDecks).length === 0;
}

// Première connexion sur ce PC. Si Drive a déjà des données et que ce PC a
// aussi un stock, on ne choisit pas à la place de l'utilisateur : le popup
// lui demande lequel garder (pendingChoice). Déjà connecté : simple
// reconnexion après expiration du token.
async function handleDriveConnect() {
  // Méthode choisie une fois pour toutes à la connexion : sous Chrome, un
  // refus de l'utilisateur ne doit pas ouvrir ensuite la fenêtre Google.
  if (!(await getSyncMeta()).enabled) await updateSyncMeta({ authMethod: chooseAuthMethod(browserNavigator) });
  await getAuthToken(true);
  const meta = await getSyncMeta();
  if (meta.enabled && !meta.pendingChoice) {
    startSyncAlarm();
    return { ok: true, meta: await syncNow() };
  }
  const account = await currentAccountPatch();
  const remote = await findStateFile(true);
  if (!remote) {
    await updateSyncMeta({ ...account, enabled: true, pendingChoice: null, syncedVersion: null, dirty: true });
  } else if (isLocalEmpty(await getState())) {
    await updateSyncMeta({ ...account, enabled: true, pendingChoice: null });
    await applyRemote(await downloadDoc(remote.id), remote);
  } else {
    const remoteDoc = await downloadDoc(remote.id);
    const pendingChoice = { remoteUpdatedAt: remoteDoc.updatedAt };
    return { ok: true, meta: await updateSyncMeta({ ...account, enabled: true, pendingChoice }) };
  }
  startSyncAlarm();
  return { ok: true, meta: await syncNow() };
}

// Sert aussi après un changement de compte Chrome : le fichier Drive est
// alors celui du nouveau compte (éventuellement absent).
async function handleDriveResolveChoice({ keep }) {
  await updateSyncMeta(await currentAccountPatch());
  const remote = await findStateFile();
  if (remote) {
    const remoteDoc = await downloadDoc(remote.id);
    if (keep === "remote") {
      const { localUpdatedAt } = await getSyncMeta();
      await createSnapshot(makeDoc(await getState(), localUpdatedAt), "conflict");
      await applyRemote(remoteDoc, remote);
    } else {
      await createSnapshot(makeDoc(remoteDoc.state, remoteDoc.updatedAt), "conflict");
      await updateSyncMeta({ syncedVersion: remote.version, dirty: true, localUpdatedAt: Date.now() });
    }
  } else {
    await updateSyncMeta({ syncedVersion: null, dirty: true });
  }
  await updateSyncMeta({ pendingChoice: null });
  startSyncAlarm();
  return { ok: true, meta: await syncNow() };
}

// Les données restent sur ce PC et sur Drive ; seule la synchro s'arrête.
async function handleDriveDisconnect() {
  await chrome.alarms.clear(SYNC_ALARM);
  if (authMethodOf(await getSyncMeta()) === "web") {
    await googleWebAuth.signOut();
  } else {
    try {
      const { token } = await chrome.identity.getAuthToken({ interactive: false });
      if (token) await chrome.identity.removeCachedAuthToken({ token });
    } catch (e) {
      // déjà déconnecté de Google : rien à nettoyer
    }
  }
  const meta = await updateSyncMeta({
    authMethod: null,
    enabled: false,
    pendingChoice: null,
    syncedVersion: null,
    lastSyncAt: null,
    lastError: null,
    accountId: null,
    accountEmail: null,
    accountMismatch: null,
  });
  return { ok: true, meta };
}

async function handleDriveListSnapshots() {
  const files = await listSnapshots();
  return {
    ok: true,
    snapshots: files.map((f) => ({
      id: f.id,
      createdTime: f.createdTime,
      size: Number(f.size),
      reason: f.appProperties?.reason || "manual",
    })),
  };
}

// Sauvegarde à télécharger (popup) : le fichier d'état, ou une version de
// l'historique (fileId). Le dossier de l'extension (appDataFolder) est
// invisible dans Google Drive : c'est le seul moyen d'en voir le contenu.
async function handleDriveDownload({ fileId } = {}) {
  const id = fileId || ((await findStateFile()) || {}).id;
  if (!id) return { ok: false, error: i18n.t("driveNoBackup") };
  // Relu et vérifié, puis remis au format complet (app, version) : le
  // fichier téléchargé reste reconnaissable comme une sauvegarde.
  const { state, updatedAt } = await downloadDoc(id);
  return { ok: true, doc: makeDoc(state, updatedAt) };
}

// Passe par setState : la version restaurée est ensuite envoyée sur Drive
// et donc propagée aux autres PC.
async function handleDriveRestoreSnapshot({ fileId }) {
  const { state } = await downloadDoc(fileId);
  // L'historique récent est gardé : la version restaurée ne le remplace pas.
  const current = await getState();
  state.history = historyLog.mergeHistories(state.history, current.history);
  // Decks suivis d'ici gardés : la liste ne fait que s'allonger.
  state.followedDecks = { ...current.followedDecks, ...state.followedDecks };
  await recordHistory(state, { type: "drive-restore" });
  await setState(state);
  return { ok: true, cardCount: Object.keys(state.stock).length, deckCount: Object.keys(state.builtDecks).length };
}

async function handleResetStock() {
  const { builtDecks, history, followedDecks } = await getState();
  // Les decks suivis restent dans « Mes decks » (rien de physique).
  const state = { stock: {}, builtDecks: {}, history, followedDecks };
  await recordHistory(state, { type: "reset", builtDecks });
  await setState(state);
  return { ok: true };
}

// Stock des seules cartes utiles à une page de deck (cartes de la page et,
// pour un deck monté, celles du montage), avec les decks montés. Une grosse
// collection pèse plusieurs Mo (30 000 noms ≈ 3 Mo) : la page la consulte
// toutes les quelques secondes, elle ne doit pas la recevoir en entier. Une
// carte double face n'est parfois connue de la page que par sa face avant
// (vue Text) : les entrées dont la face avant correspond sont jointes (cf.
// completeCardNames dans deck-scraper.js).
async function handleGetDeckContext({ deckId, names }) {
  const state = await getState();
  const wanted = new Set((names || []).map(normalizeName));
  const deck = deckId ? state.builtDecks[deckId] : null;
  if (deck) for (const c of deck.cards) wanted.add(normalizeName(c.name));
  const stock = {};
  for (const [key, c] of Object.entries(state.stock)) {
    if (wanted.has(key) || (key.includes(" // ") && wanted.has(key.split(" // ")[0]))) stock[key] = c;
  }
  // followed : deck dans « Mes decks » (cœur du bandeau de la page).
  return { ok: true, stock, builtDecks: state.builtDecks, followed: Boolean(deckId && state.followedDecks[deckId]) };
}

// Historique pour le popup, avec les libellés calculés ici.
async function handleGetHistory() {
  const state = await getState();
  const device = await getDeviceId();
  const entries = state.history.map((e) => ({
    id: e.id,
    at: e.at,
    otherDevice: e.device !== device,
    title: historyLog.describe(e),
    changes: e.changes || null,
    changeCount: e.changes ? historyLog.changeCount(e) : null,
  }));
  return { ok: true, entries };
}

// --- Récupération automatique de la collection Moxfield ---
// Toutes les heures (et au démarrage du navigateur si la dernière date de
// plus d'une heure), la collection est téléchargée depuis le compte Moxfield
// connecté dans le navigateur (cf. moxfield-collection.js) puis importée comme un
// CSV : elle devient la référence du stock. Rien n'est écrit si elle n'a
// pas changé — chaque écriture part sur Drive.
// Le suivi (dernière récupération, derniers changements, erreur) est propre
// à ce PC : il n'est pas synchronisé.
const COLLECTION_META_KEY = "moxfieldStockManagerCollection";
const COLLECTION_ALARM = "moxfield-collection";
const COLLECTION_PERIOD_MINUTES = 60;
// Marge : une récupération lancée entre deux alarmes (bouton, démarrage) ne
// doit pas faire sauter la suivante pour quelques minutes.
const COLLECTION_DUE_MS = (COLLECTION_PERIOD_MINUTES - 5) * 60 * 1000;

const moxfieldCollection = createMoxfieldCollection({
  fetch: (...args) => fetch(...args),
  getCookies: () => chrome.cookies.getAll({ domain: "moxfield.com" }),
  i18n,
});

async function getCollectionMeta() {
  const data = await chrome.storage.local.get(COLLECTION_META_KEY);
  return {
    enabled: true,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null, // { code, message }
    lastChanges: null, // [{ name, from, to }] : derniers changements importés
    lastChangesAt: null,
    ...data[COLLECTION_META_KEY],
  };
}

async function updateCollectionMeta(patch) {
  const meta = { ...(await getCollectionMeta()), ...patch };
  await chrome.storage.local.set({ [COLLECTION_META_KEY]: meta });
  return meta;
}

// Cartes de decks montés que la collection ne couvre plus (stock libre
// négatif), terrains de base exclus : ils ne font jamais qu'un
// avertissement, et leur stock peut être négatif par choix.
function findUncoveredCards(state) {
  const decksByCard = new Map();
  for (const deck of Object.values(state.builtDecks)) {
    for (const card of deck.cards) {
      // Proxies et cartes excludedFromStock : ne tiennent aucun exemplaire.
      if (stockQtyOf(card) === 0 || isBasicLand(card.name)) continue;
      const key = normalizeName(card.name);
      if (!decksByCard.has(key)) decksByCard.set(key, []);
      decksByCard.get(key).push(deck.name);
    }
  }
  const uncovered = [];
  for (const [key, decks] of decksByCard) {
    const c = state.stock[key];
    if (c && c.qty < 0) uncovered.push({ name: c.name, missing: -c.qty, decks });
  }
  return uncovered.sort((a, b) => a.name.localeCompare(b.name));
}

const EXPECTED_COLLECTION_ERRORS = ["not-logged-in", "network"];

async function fetchCollection() {
  await updateCollectionMeta({ lastAttemptAt: Date.now() });
  try {
    const collection = parseCollectionCSV(await moxfieldCollection.downloadCollectionCSV());
    const state = await getState();
    const changes = computeCollectionDiff(collectionFromState(state), collection);
    const patch = { lastSuccessAt: Date.now(), lastError: null };
    if (changes.length > 0 || printingsChanged(state.stock, collection)) {
      state.stock = stockFromCollection(collection, state.builtDecks);
      if (changes.length > 0) {
        await recordHistory(state, { type: "collection", source: "fetch", changes });
        Object.assign(patch, { lastChanges: changes, lastChangesAt: Date.now() });
      }
      await setState(state);
    }
    await updateCollectionMeta(patch);
    return { ok: true, changes };
  } catch (e) {
    const lastError = { code: e.code || "unknown", message: e.message || String(e) };
    // Pas connecté à Moxfield, réseau coupé : situations normales, pas des
    // erreurs de l'extension.
    if (!EXPECTED_COLLECTION_ERRORS.includes(lastError.code)) reportError("moxfield-collection", e, { code: lastError.code });
    await updateCollectionMeta({ lastError });
    return { ok: false, error: lastError.message, code: lastError.code };
  }
}

// Les récupérations sont exécutées l'une après l'autre, jamais en parallèle
// (le jeton de renouvellement change à chaque fois).
let collectionQueue = Promise.resolve();
function fetchCollectionNow() {
  const run = collectionQueue.then(fetchCollection);
  collectionQueue = run.catch(() => {});
  return run;
}

// Édition et numéro des impressions d'un deck ({ [code Moxfield]: { set, cn } }),
// demandés par la page du deck pour le contrôle « version déjà utilisée »
// (cf. computeVersionConflicts dans deck-checks.js). Sans réponse, la page
// se replie sur le recoupement : pas connecté, réseau coupé, deck privé
// d'un autre compte sont des situations normales, non rapportées.
const EXPECTED_DECK_PRINTINGS_ERRORS = ["not-logged-in", "network", "deck-unavailable"];

async function handleGetDeckPrintings({ deckId }) {
  if (typeof deckId !== "string" || !/^[\w-]{1,64}$/.test(deckId)) return { ok: false, code: "deck-unavailable" };
  const run = collectionQueue.then(() => moxfieldCollection.fetchDeck(deckId));
  collectionQueue = run.catch(() => {});
  try {
    const deck = await run;
    // declaredProxies : cartes marquées « proxy » dans le deck sur Moxfield.
    return { ok: true, printings: extractDeckPrintings(deck), declaredProxies: declaredProxies(deck) };
  } catch (e) {
    const code = e.code || "unknown";
    if (!EXPECTED_DECK_PRINTINGS_ERRORS.includes(code)) reportError("moxfield-deck", e, { code });
    return { ok: false, error: e.message || String(e), code };
  }
}

// --- Passer un deck Moxfield sur les éditions de la collection ---
// Cartes possédées dans une autre édition que celle du deck (cf.
// chooseOwnedEdition dans deck-checks.js). Deux temps : proposition (aucune
// écriture : collection, deck et éditions lus), puis application, carte par
// carte, après confirmation sur la page du deck. C'est la seule écriture de
// l'extension sur Moxfield. Ni le stock ni les decks montés ne changent :
// pas d'entrée dans l'historique (le deck Moxfield garde la sienne).
// Pause entre deux appels à Moxfield : jusqu'à une centaine de cartes.
const MOXFIELD_CALL_DELAY_MS = 150;
const MAX_EDITION_CHANGES = 250;
const validDeckId = (deckId) => typeof deckId === "string" && /^[\w-]{1,64}$/.test(deckId);
const pause = () => new Promise((resolve) => setTimeout(resolve, MOXFIELD_CALL_DELAY_MS));
// Lectures des éditions menées en parallèle, par petits groupes : 66 cartes
// lues une à une prenaient près d'une minute (constaté en vrai, novembre
// 2026), sans aller jusqu'à inonder Moxfield (refus 429).
const EDITIONS_CONCURRENCY = 3;

// fn appliquée à chaque élément, au plus limit à la fois ; résultats dans
// l'ordre des éléments. Première erreur propagée.
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Refus de Moxfield (deck d'un autre compte, protection anti-robot) :
// expliqué à l'utilisateur, pas rapporté.
const EXPECTED_EDITION_ERRORS = [...EXPECTED_DECK_PRINTINGS_ERRORS, "blocked"];

// Même file que la collection : jamais deux suites d'appels à Moxfield à la
// fois.
async function inMoxfieldQueue(where, task) {
  const run = collectionQueue.then(task);
  collectionQueue = run.catch(() => {});
  try {
    return { ok: true, ...(await run) };
  } catch (e) {
    const code = e.code || "unknown";
    // Réponse de Moxfield (motif d'un refus) jointe au rapport ; adresses
    // mail et jetons masqués par scrub (error-reports.js).
    const extra = typeof e.response === "string" ? { code, response: e.response } : { code };
    if (!EXPECTED_EDITION_ERRORS.includes(code)) reportError(where, e, extra);
    return { ok: false, error: e.message || String(e), code, ...(e.partial || {}) };
  }
}

// Proposition : { plan: [{ name, board, uniqueCardId, from: {set, cn},
// to: {set, cn, setName, cardId, finishes} }], skipped: [{ name, reason }] }.
// reason : "not-in-deck", "several" (plusieurs impressions dans la même
// entrée), "no-other-edition", "edition-unknown" (édition de la collection
// introuvable chez Moxfield pour cette carte).
// Avancement ({ step: "plan" | "apply", done, total }) envoyé à l'onglet
// qui a lancé l'action, pour sa jauge : sans elle, une minute sans rien
// voir bouger donne l'impression que rien ne marche (retour utilisateur).
// Onglet fermé ou rechargé entre-temps : ignoré.
function progressTo(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  return (progress) => {
    if (tabId === undefined) return;
    try {
      Promise.resolve(chrome.tabs.sendMessage(tabId, { type: "OWNED_EDITIONS_PROGRESS", ...progress })).catch(() => {});
    } catch (e) {
      // onglet introuvable : rien à afficher
    }
  };
}

async function handlePlanOwnedEditions({ deckId, names }, progress = () => {}) {
  if (!validDeckId(deckId) || !Array.isArray(names)) return { ok: false, code: "deck-unavailable", error: i18n.t("moxfieldDeckUnavailable") };
  return inMoxfieldQueue("moxfield-editions", async () => {
    const owned = collectionEditions(await moxfieldCollection.downloadCollectionCSV());
    const entries = deckEntries(await moxfieldCollection.fetchDeck(deckId));
    const usage = buildVersionUsage((await getState()).builtDecks, deckId);
    // Choix faits d'abord (sans appel), éditions lues ensuite en parallèle ;
    // cartes laissées gardées dans l'ordre demandé.
    const steps = [];
    for (const name of names.filter((n) => typeof n === "string").slice(0, MAX_EDITION_CHANGES)) {
      const key = normalizeName(name);
      // La page ne donne parfois que la face avant (cf. completeCardNames).
      const entry =
        entries.find((e) => normalizeName(e.name) === key) || entries.find((e) => normalizeName(e.name).split(" // ")[0] === key.split(" // ")[0]);
      if (!entry) {
        steps.push({ skip: { name, reason: "not-in-deck" } });
        continue;
      }
      if (entry.several) {
        steps.push({ skip: { name: entry.name, reason: "several" } });
        continue;
      }
      const cardKey = normalizeName(entry.name);
      const ownedEditions = owned.get(cardKey) || [];
      const choice = chooseOwnedEdition(ownedEditions, entry, usage.get(cardKey) || []);
      if (choice) {
        steps.push({ entry, choice });
        continue;
      }
      // Raison du refus, de la plus précise à la plus générale : une édition
      // conviendrait sans les autres decks montés ("taken"), ou en ne
      // demandant qu'un exemplaire ("not-enough"), ou aucune.
      const reason = chooseOwnedEdition(ownedEditions, entry)
        ? "taken"
        : chooseOwnedEdition(ownedEditions, { ...entry, quantity: 1 })
          ? "not-enough"
          : "no-other-edition";
      steps.push({ skip: { name: entry.name, reason } });
    }
    const chosen = steps.filter((step) => step.entry);
    let read = 0;
    progress({ step: "plan", done: 0, total: chosen.length });
    const editions = await mapLimited(chosen, EDITIONS_CONCURRENCY, async ({ entry }) => {
      const known = await moxfieldCollection.fetchCardEditions(entry.uniqueCardId);
      progress({ step: "plan", done: ++read, total: chosen.length });
      return known;
    });
    chosen.forEach((step, i) => (step.editions = editions[i]));
    const plan = [];
    const skipped = [];
    for (const { skip, entry, choice, editions: known } of steps) {
      if (skip) {
        skipped.push(skip);
        continue;
      }
      const edition = known.find((e) => e.set === choice.set && e.cn === choice.cn);
      // Même édition, finition que Moxfield ne connaît pas pour elle : rien
      // à changer.
      const sameEdition = edition && edition.set === entry.set && edition.cn === entry.cn;
      if (!edition || (sameEdition && !edition.finishes.includes(choice.finish))) {
        skipped.push({ name: entry.name, reason: "edition-unknown" });
        continue;
      }
      plan.push({
        name: entry.name,
        board: entry.board,
        uniqueCardId: entry.uniqueCardId,
        from: { set: entry.set, cn: entry.cn },
        to: { set: edition.set, cn: edition.cn, setName: edition.setName, cardId: edition.cardId, finishes: edition.finishes, finish: choice.finish },
      });
    }
    return { plan, skipped };
  });
}

// Application d'une proposition, une carte à la fois : Moxfield exige la
// version du deck, qui change à chaque modification. Le deck n'est lu qu'au
// début (le relire avant chaque carte faisait près de 2 minutes pour 66
// cartes, constaté en vrai, novembre 2026) : la version est ensuite
// augmentée de 1 après chaque changement accepté. Si Moxfield refuse
// (deck modifié ailleurs, version qui ne suit pas), le deck est relu et la
// carte retentée une fois. Une carte modifiée entre-temps n'est pas touchée
// ("changed"). Arrêt à la première erreur, avec les cartes déjà passées
// (done).
const FINISHES = ["nonFoil", "foil", "etched"];

async function handleApplyOwnedEditions({ deckId, plan }, progress = () => {}) {
  const short = (v) => typeof v === "string" && v.length > 0 && v.length <= 64;
  const valid = (item) =>
    item && short(item.name) && /^\w{1,32}$/.test(item.board) && /^[\w-]{1,32}$/.test(item.uniqueCardId) &&
    item.from && typeof item.from.set === "string" && typeof item.from.cn === "string" &&
    item.to && /^[\w-]{1,32}$/.test(item.to.cardId) && Array.isArray(item.to.finishes) &&
    (item.to.finish === undefined || FINISHES.includes(item.to.finish));
  if (!validDeckId(deckId) || !Array.isArray(plan) || !plan.every(valid)) return { ok: false, code: "invalid", error: i18n.t("unknownError") };
  return inMoxfieldQueue("moxfield-edition-change", async () => {
    const done = [];
    const skipped = [];
    let deck = null;
    const read = async () => {
      deck = await moxfieldCollection.fetchDeck(deckId);
    };
    const entryOf = (item) => {
      const entry = deckEntries(deck).find((e) => e.board === item.board && e.uniqueCardId === item.uniqueCardId);
      return entry && !entry.several && entry.set === item.from.set && entry.cn === item.from.cn ? entry : null;
    };
    const items = plan.slice(0, MAX_EDITION_CHANGES);
    progress({ step: "apply", done: 0, total: items.length });
    for (const [i, item] of items.entries()) {
      if (i > 0) await pause();
      // Carte traitée (changée ou laissée), même en cas d'erreur juste après.
      const advance = () => progress({ step: "apply", done: i + 1, total: items.length });
      try {
        if (!deck) await read();
        const finishes = item.to.finishes.filter((f) => FINISHES.includes(f));
        const edition = { cardId: item.to.cardId, finishes, finish: item.to.finish };
        let entry = entryOf(item);
        if (!entry) {
          skipped.push({ name: item.name, reason: "changed" });
          advance();
          continue;
        }
        try {
          await moxfieldCollection.setDeckCardEdition(deck, entry, edition);
        } catch (e) {
          // Refus attendu d'une version périmée : relire, puis une seule
          // nouvelle tentative. Réseau coupé ou blocage : arrêt direct.
          if (e.code !== "api-changed") throw e;
          await read();
          entry = entryOf(item);
          if (!entry) {
            skipped.push({ name: item.name, reason: "changed" });
            advance();
            continue;
          }
          await moxfieldCollection.setDeckCardEdition(deck, entry, edition);
        }
        deck = { ...deck, version: deck.version + 1 };
        done.push(item.name);
        advance();
      } catch (e) {
        e.partial = { done, skipped };
        throw e;
      }
    }
    return { done, skipped };
  });
}

async function fetchCollectionIfDue() {
  const meta = await getCollectionMeta();
  if (!meta.enabled) return;
  const last = meta.lastAttemptAt || 0;
  if (Date.now() - last >= COLLECTION_DUE_MS) await fetchCollectionNow();
}

function startCollectionAlarm() {
  chrome.alarms.create(COLLECTION_ALARM, { periodInMinutes: COLLECTION_PERIOD_MINUTES });
}

// Collection modifiée sur Moxfield (ajout, changement de quantité,
// suppression — sur la page collection ou ailleurs sur le site) : on
// récupère la collection peu après, sans attendre l'heure. Observé
// (octobre 2026) : POST /v1/collections (ajout), PUT /v1/collections/<id>
// (modification) ; on retient tout appel qui n'est pas une lecture.
// L'alarme est repoussée à chaque modification : la récupération a lieu
// après une pause dans la saisie. Une alarme plutôt qu'un setTimeout : le
// service worker peut être arrêté entre-temps. 30 s est aussi le délai
// minimal d'une alarme.
const COLLECTION_CHANGED_ALARM = "moxfield-collection-changed";
const COLLECTION_SETTLE_MINUTES = 0.5;
const COLLECTION_WRITE_URLS = ["https://api2.moxfield.com/*/collections*"];

async function handleCollectionWrite(details) {
  // tabId -1 : requête qui ne vient pas d'un onglet (ex. l'extension).
  if (details.method === "GET" || details.tabId < 0 || details.statusCode >= 400) return;
  if (!(await getCollectionMeta()).enabled) return;
  chrome.alarms.create(COLLECTION_CHANGED_ALARM, { delayInMinutes: COLLECTION_SETTLE_MINUTES });
}

chrome.webRequest.onCompleted.addListener(handleCollectionWrite, { urls: COLLECTION_WRITE_URLS });

// Récupération en échec faute de session Moxfield : relancée dès que
// l'utilisateur se connecte (le site pose alors le cookie
// refresh_token_<userId>, cf. moxfield-collection.js), sans attendre
// l'heure ni un clic sur « Récupérer maintenant ». Le site pose ses cookies
// en plusieurs fois : une seule relance à la fois.
let loginRetryRunning = false;
async function handleMoxfieldCookie({ cookie, removed }) {
  if (removed || !/^refresh_token_.+$/.test(cookie.name) || !/(^|\.)moxfield\.com$/.test(cookie.domain)) return;
  if (loginRetryRunning) return;
  loginRetryRunning = true; // avant toute attente : les cookies arrivent ensemble
  try {
    const meta = await getCollectionMeta();
    if (meta.lastError && meta.lastError.code === "not-logged-in") await fetchCollectionNow();
  } finally {
    loginRetryRunning = false;
  }
}

chrome.cookies.onChanged.addListener(handleMoxfieldCookie);

async function handleGetCollectionStatus() {
  return { ok: true, meta: await getCollectionMeta(), uncovered: findUncoveredCards(await getState()) };
}

async function handleSetCollectionAuto({ enabled }) {
  const meta = await updateCollectionMeta({ enabled });
  if (enabled) {
    startCollectionAlarm();
    fetchCollectionIfDue();
  } else {
    await chrome.alarms.clear(COLLECTION_ALARM);
    await chrome.alarms.clear(COLLECTION_CHANGED_ALARM);
  }
  return { ok: true, meta };
}

// --- Nouvelle version de l'extension (cf. update-check.js) ---
// Vérifiée au démarrage, au (re)chargement de l'extension et toutes les 6
// heures ; signalée par une pastille sur l'icône et une carte en haut du
// popup. Constat propre à ce PC (son clone), pas synchronisé.
const UPDATE_META_KEY = "moxfieldStockManagerUpdate";
const UPDATE_ALARM = "update-check";
const UPDATE_PERIOD_MINUTES = 6 * 60;
// Constat récent : l'ouverture du popup ne redemande pas à GitHub.
const UPDATE_FRESH_MS = 60 * 60 * 1000;
const updateCheck = createUpdateCheck({
  fetch: (...args) => fetch(...args),
  readFile: async (path) => {
    try {
      const res = await fetch(chrome.runtime.getURL(path));
      return res.ok ? await res.text() : null;
    } catch (e) {
      return null; // fichier absent
    }
  },
});

async function getUpdateMeta() {
  const data = await chrome.storage.local.get(UPDATE_META_KEY);
  return data[UPDATE_META_KEY] || {};
}

function showUpdateBadge(available) {
  chrome.action.setBadgeText({ text: available ? "↑" : "" });
  if (available) chrome.action.setBadgeBackgroundColor({ color: "#2f6fd6" });
  chrome.action.setTitle({ title: available ? i18n.t("updateBadgeTitle") : i18n.t("extName") });
}

// Constat valable seulement pour le commit sur lequel il a été fait : après
// un git pull et un rechargement, l'ancien « nouvelle version disponible »
// ne vaut plus, même si GitHub ne répond pas.
async function checkForUpdate() {
  const result = await updateCheck.check();
  let meta;
  if (result) {
    meta = { ...result, checkedAt: Date.now() };
    await chrome.storage.local.set({ [UPDATE_META_KEY]: meta });
  } else {
    meta = await getUpdateMeta();
    if (meta.localSha && meta.localSha !== (await updateCheck.localCommit())) {
      meta = {};
      await chrome.storage.local.set({ [UPDATE_META_KEY]: meta });
    }
  }
  showUpdateBadge(Boolean(meta.available));
  return meta;
}

async function handleGetUpdateStatus() {
  let meta = await getUpdateMeta();
  const localSha = await updateCheck.localCommit();
  if (!meta.checkedAt || Date.now() - meta.checkedAt > UPDATE_FRESH_MS || meta.localSha !== localSha) {
    meta = await checkForUpdate();
  }
  const update = meta.available && meta.localSha === localSha
    ? { count: meta.count, commits: meta.commits, compareUrl: meta.compareUrl, latestVersion: meta.latestVersion || null }
    : null;
  return { ok: true, update };
}

// --- Mes decks (popup) ---
// Faisabilité de plusieurs decks sans les ouvrir : decks suivis (ouverts
// sur Moxfield, ou adresse collée dans le popup) et decks montés. Moxfield
// n'a pas d'appel connu qui liste les decks d'un compte : la liste se
// remplit au fil des visites. Chaque deck est lu par l'API déjà utilisée
// pour les éditions (cf. fetchDeck), et calculé avec computeDeckAvailability,
// comme la pastille du bouton de la page.
//
// Cartes lues gardées sur ce PC (pas synchronisées, recalculables) :
// { [deckId]: { name, fetchedAt, cards } } ou { fetchedAt, error }. La
// faisabilité, elle, est recalculée à chaque ouverture avec le stock du
// moment : seules les listes des decks vieillissent.
const DECK_CACHE_KEY = "moxfieldStockManagerDeckCache";
// Liste d'un deck relue au-delà : un deck se modifie rarement, et chaque
// lecture est un appel à Moxfield.
const DECK_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Borne de la liste : au-delà, les plus anciens decks suivis cèdent la place.
const MAX_FOLLOWED_DECKS = 200;
// Pause entre deux lectures de deck, pour ne pas enchaîner les appels.
const DECK_READ_PAUSE_MS = 300;

function isDeckId(id) {
  return typeof id === "string" && /^[\w-]{1,64}$/.test(id);
}

function deckUrlOf(deckId) {
  return `https://moxfield.com/decks/${deckId}`;
}

// Adresse d'un deck Moxfield (ou son seul identifiant) → identifiant, null
// si ce n'en est pas une.
// « public » : la liste des decks publics, même forme d'adresse (cf.
// NON_DECK_SLUGS dans content-deck.js).
function deckIdFromInput(input) {
  const text = String(input || "").trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?moxfield\.com\/decks\/([\w-]{1,64})(?:[/?#].*)?$/i.exec(text);
  const id = m ? m[1] : text;
  return isDeckId(id) && id.toLowerCase() !== "public" ? id : null;
}

async function getDeckCache() {
  const data = await chrome.storage.local.get(DECK_CACHE_KEY);
  return data[DECK_CACHE_KEY] || {};
}

// Ajoute un deck à « Mes decks » ; n'écrit (et n'envoie sur Drive) que si
// quelque chose change : la page d'un deck l'appelle à chaque visite.
async function followDeck(deckId, name) {
  const state = await getState();
  const current = state.followedDecks[deckId];
  if (current && (!name || current.name === name)) return false;
  const followedDecks = { ...state.followedDecks, [deckId]: { name: name || deckId, url: deckUrlOf(deckId), addedAt: current ? current.addedAt : Date.now() } };
  const ids = Object.keys(followedDecks);
  if (ids.length > MAX_FOLLOWED_DECKS) {
    ids.sort((a, b) => (followedDecks[a].addedAt || 0) - (followedDecks[b].addedAt || 0));
    for (const id of ids.slice(0, ids.length - MAX_FOLLOWED_DECKS)) delete followedDecks[id];
  }
  await setState({ ...state, followedDecks });
  return true;
}

// Cœur de la page d'un deck (cf. toggleLike dans content-deck.js) : deck
// ajouté à « Mes decks », même monté (il y reste une fois démonté). Déjà
// suivi : jamais renommé — le nom lu sur la page (cf. getDeckName) n'est
// pas toujours celui du deck, et le corriger écrirait l'état (donc Drive)
// en concurrence avec le nom lu par l'API.
async function handleFollowDeck({ deckId, name }) {
  if (!isDeckId(deckId)) return { ok: false, code: "invalid-deck" };
  const state = await getState();
  if (state.followedDecks[deckId]) return { ok: true, changed: false };
  return { ok: true, changed: await followDeck(deckId, typeof name === "string" ? name.trim().slice(0, 200) : "") };
}

async function handleUnfollowDeck({ deckId }) {
  const state = await getState();
  if (!state.followedDecks[deckId]) return { ok: true };
  const followedDecks = { ...state.followedDecks };
  delete followedDecks[deckId];
  await setState({ ...state, followedDecks });
  return { ok: true };
}

// Adresse collée dans le popup : deck suivi, puis lu tout de suite.
async function handleAddDeck({ input }) {
  const deckId = deckIdFromInput(input);
  if (!deckId) return { ok: false, code: "invalid-deck", error: i18n.t("decksInvalidUrl") };
  const state = await getState();
  if (!state.followedDecks[deckId] && !state.builtDecks[deckId]) await followDeck(deckId, "");
  return handleRefreshDecks({ deckIds: [deckId] });
}

// Lit les decks demandés, l'un après l'autre, dans la file des appels à
// Moxfield. S'arrête au premier problème général (pas connecté, réseau,
// refus) ; un deck introuvable ou privé est noté et la suite continue.
async function handleRefreshDecks({ deckIds } = {}) {
  const ids = (Array.isArray(deckIds) ? deckIds : []).filter(isDeckId);
  let refreshed = 0;
  for (const deckId of ids) {
    if (refreshed > 0) await new Promise((resolve) => setTimeout(resolve, DECK_READ_PAUSE_MS));
    const run = collectionQueue.then(() => moxfieldCollection.fetchDeck(deckId));
    collectionQueue = run.catch(() => {});
    let entry;
    try {
      const deck = await run;
      entry = { name: typeof deck.name === "string" ? deck.name : "", fetchedAt: Date.now(), cards: deckCardList(deck) };
    } catch (e) {
      const code = e.code || "unknown";
      if (code !== "deck-unavailable") {
        if (!EXPECTED_EDITION_ERRORS.includes(code)) reportError("moxfield-deck-overview", e, { code });
        return { ok: false, code, error: e.message || String(e), refreshed };
      }
      entry = { fetchedAt: Date.now(), error: code };
    }
    const cache = await getDeckCache();
    await chrome.storage.local.set({ [DECK_CACHE_KEY]: { ...cache, [deckId]: entry } });
    // Nom lu sur Moxfield : plus sûr que celui de la page (cf. getDeckName).
    if (entry.name && (await getState()).followedDecks[deckId]) await followDeck(deckId, entry.name);
    refreshed++;
  }
  return { ok: true, refreshed };
}

// Vue « Mes decks » : faisabilité recalculée avec le stock du moment.
// status : "built" (monté), "buildable", "blocked", "unknown" (jamais lu),
// "unavailable" (introuvable ou privé). staleIds : decks à relire.
async function handleGetDecks() {
  const state = await getState();
  const cache = await getDeckCache();
  const versionUsage = buildVersionUsage(state.builtDecks);
  const now = Date.now();
  const ids = [...new Set([...Object.keys(state.followedDecks), ...Object.keys(state.builtDecks)])];
  const decks = ids.map((deckId) => {
    const built = state.builtDecks[deckId];
    const followed = state.followedDecks[deckId];
    const cached = cache[deckId];
    const deck = {
      deckId,
      name: (built && built.name) || (cached && cached.name) || (followed && followed.name) || deckId,
      url: (built && built.url) || (followed && followed.url) || deckUrlOf(deckId),
      followed: Boolean(followed),
      fetchedAt: (cached && cached.fetchedAt) || null,
    };
    if (built) return { ...deck, status: "built" };
    if (!cached) return { ...deck, status: "unknown" };
    if (cached.error) return { ...deck, status: "unavailable" };
    const availability = computeDeckAvailability(cardsFromDeckApi(cached.cards, state.stock), state.stock, undefined, versionUsage);
    return {
      ...deck,
      status: availability.blocking === 0 ? "buildable" : "blocked",
      blocking: availability.blocking,
      available: availability.available,
      total: availability.total,
      label: availabilityLabel(availability),
    };
  });
  const staleIds = decks
    .filter((d) => d.status !== "built" && (!d.fetchedAt || now - d.fetchedAt > DECK_CACHE_MAX_AGE_MS))
    .map((d) => d.deckId);
  return { ok: true, decks, staleIds };
}

// --- Guide de démarrage (popup) ---
// { done, step } : guide terminé ou passé, et étape où l'utilisateur s'est
// arrêté (le popup se ferme dès qu'on va sur Moxfield : le guide reprend là
// à sa réouverture). Propre à ce PC, pas synchronisé.
const ONBOARDING_KEY = "moxfieldStockManagerOnboarding";

// Premier appel : une installation qui a déjà un stock ou des decks montés
// (extension mise à jour, ou état venu de Drive) n'a pas besoin du guide ;
// le constat est enregistré, pour qu'une nouvelle installation garde son
// guide une fois la collection récupérée.
async function handleGetOnboarding() {
  const data = await chrome.storage.local.get(ONBOARDING_KEY);
  let record = data[ONBOARDING_KEY];
  if (!record) {
    const { stock, builtDecks } = await getState();
    record = { done: Object.keys(stock).length > 0 || Object.keys(builtDecks).length > 0, step: 0 };
    await chrome.storage.local.set({ [ONBOARDING_KEY]: record });
  }
  return { ok: true, done: Boolean(record.done), step: Number(record.step) || 0 };
}

async function handleSetOnboarding({ done, step }) {
  const record = { done: Boolean(done), step: Math.max(0, Number(step) || 0) };
  await chrome.storage.local.set({ [ONBOARDING_KEY]: record });
  return { ok: true, ...record };
}

// Version affichée en bas du popup : numéro du manifest, et commit du clone
// quand il y en a un (deux PC au même numéro peuvent différer entre deux
// livraisons).
async function handleGetVersionInfo() {
  const commit = await updateCheck.localCommit();
  return { ok: true, version: chrome.runtime.getManifest().version, commit, commitUrl: commit ? updateCheck.commitUrl(commit) : null };
}

function startUpdateChecks() {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_PERIOD_MINUTES });
  checkForUpdate();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate();
  if (alarm.name === SYNC_ALARM) syncNow();
  if (alarm.name === COLLECTION_ALARM) fetchCollectionIfDue();
  if (alarm.name === COLLECTION_CHANGED_ALARM) fetchCollectionNow();
});

// Les alarmes ne survivent pas toujours à un redémarrage du navigateur.
chrome.runtime.onStartup.addListener(async () => {
  startUpdateChecks();
  if ((await getSyncMeta()).enabled) {
    startSyncAlarm();
    syncNow();
  }
  if ((await getCollectionMeta()).enabled) {
    startCollectionAlarm();
    fetchCollectionIfDue();
  }
});

// Aussi au rechargement de l'extension (après un git pull) : la pastille
// « nouvelle version » disparaît.
chrome.runtime.onInstalled.addListener(async () => {
  startUpdateChecks();
  if ((await getSyncMeta()).enabled) startSyncAlarm();
  if ((await getCollectionMeta()).enabled) {
    startCollectionAlarm();
    fetchCollectionIfDue();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_STATE": {
          // Sans l'historique : la page d'un deck lit l'état toutes les
          // quelques secondes, l'historique est demandé à part.
          const { stock, builtDecks } = await getState();
          sendResponse({ ok: true, state: { stock, builtDecks } });
          break;
        }
        case "GET_DECKS":
          sendResponse(await handleGetDecks());
          break;
        case "REFRESH_DECKS":
          sendResponse(await handleRefreshDecks(msg.payload || {}));
          break;
        case "ADD_DECK":
          sendResponse(await handleAddDeck(msg.payload || {}));
          break;
        case "FOLLOW_DECK":
          sendResponse(await handleFollowDeck(msg.payload || {}));
          break;
        case "UNFOLLOW_DECK":
          sendResponse(await handleUnfollowDeck(msg.payload || {}));
          break;
        case "GET_ONBOARDING":
          sendResponse(await handleGetOnboarding());
          break;
        case "SET_ONBOARDING":
          sendResponse(await handleSetOnboarding(msg.payload || {}));
          break;
        case "GET_VERSION_INFO":
          sendResponse(await handleGetVersionInfo());
          break;
        case "GET_UPDATE_STATUS":
          sendResponse(await handleGetUpdateStatus());
          break;
        case "GET_DECK_CONTEXT":
          sendResponse(await handleGetDeckContext(msg.payload || {}));
          break;
        case "GET_HISTORY":
          sendResponse(await handleGetHistory());
          break;
        case "IMPORT_CSV_TEXT":
          sendResponse(await handleImportCSV(msg.csvText));
          break;
        case "GET_COLLECTION_STATUS":
          sendResponse(await handleGetCollectionStatus());
          break;
        case "COLLECTION_FETCH_NOW":
          sendResponse(await fetchCollectionNow());
          break;
        case "SET_COLLECTION_AUTO":
          sendResponse(await handleSetCollectionAuto(msg.payload));
          break;
        case "TOGGLE_DECK_BUILT":
          sendResponse(await handleToggleDeck(msg.payload));
          break;
        case "SET_DECK_PAGE_CHANGES":
          sendResponse(await handleSetDeckPageChanges(msg.payload));
          break;
        case "GET_DECK_PRINTINGS":
          sendResponse(await handleGetDeckPrintings(msg.payload || {}));
          break;
        case "SET_DECK_VERSIONS":
          sendResponse(await handleSetDeckVersions(msg.payload));
          break;
        case "UPDATE_BUILT_DECK":
          sendResponse(await handleUpdateBuiltDeck(msg.payload));
          break;
        case "PLAN_OWNED_EDITIONS":
          sendResponse(await handlePlanOwnedEditions(msg.payload || {}, progressTo(sender)));
          break;
        case "APPLY_OWNED_EDITIONS":
          sendResponse(await handleApplyOwnedEditions(msg.payload || {}, progressTo(sender)));
          break;
        case "REPLACE_PROXIES":
          sendResponse(await handleReplaceProxies(msg.payload || {}));
          break;
        case "GET_DECK_PROXIES":
          sendResponse(await handleGetDeckProxies(msg.payload || {}));
          break;
        case "OPEN_PROXIES_PAGE":
          sendResponse(await handleOpenProxiesPage(msg.payload || {}));
          break;
        case "GET_SYNC_STATUS":
          sendResponse({ ok: true, meta: await getSyncMeta() });
          break;
        case "SYNC_NOW":
          sendResponse({ ok: true, meta: await syncNow() });
          break;
        case "DRIVE_CONNECT":
          sendResponse(await handleDriveConnect());
          break;
        case "DRIVE_RESOLVE_CHOICE":
          sendResponse(await handleDriveResolveChoice(msg.payload));
          break;
        case "DRIVE_DISCONNECT":
          sendResponse(await handleDriveDisconnect());
          break;
        case "DRIVE_LIST_SNAPSHOTS":
          sendResponse(await handleDriveListSnapshots());
          break;
        case "DRIVE_DOWNLOAD":
          sendResponse(await handleDriveDownload(msg.payload || {}));
          break;
        case "DRIVE_RESTORE_SNAPSHOT":
          sendResponse(await handleDriveRestoreSnapshot(msg.payload));
          break;
        case "RESET_STOCK":
          sendResponse(await handleResetStock());
          break;
        case "REPORT_ERROR": {
          const { where, error } = msg.payload || {};
          sendResponse({ ok: true, sent: await reportError(where || "page", error || {}) });
          break;
        }
        case "GET_ERROR_REPORTS":
          sendResponse({ ok: true, enabled: (await getErrorReportsMeta()).enabled, configured: errorReports.configured });
          break;
        case "SET_ERROR_REPORTS":
          sendResponse(await handleSetErrorReports(msg.payload || {}));
          break;
        default:
          sendResponse({ ok: false, error: i18n.t("unknownMessageType", msg.type) });
      }
    } catch (e) {
      reportError(`message:${msg.type}`, e, causeOf(e));
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // réponse asynchrone
});
