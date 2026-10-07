// Tests de la gestion du stock du service worker (background.js) : npm test
//
// background.js est chargé tel quel dans un contexte isolé, avec un faux
// chrome.storage.local en mémoire ; on lui parle comme l'extension, par
// messages. La synchro Google Drive n'est pas activée, et Moxfield est
// simulé (fausse fonction fetch) : aucun appel réseau.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const STORAGE_KEY = "moxfieldStockManagerState";
const COLLECTION_KEY = "moxfieldStockManagerCollection";

// options.moxfieldCSV : collection renvoyée par le faux Moxfield (CSV), ou
// une Error à lever ; sans elle, tout appel réseau fait échouer le test.
// options.cookies : cookies de moxfield.com (session ouverte par défaut).
function loadBackground(initialState, options = {}) {
  const storage = {};
  if (initialState) storage[STORAGE_KEY] = initialState;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  let onMessage = null;
  const alarmListeners = [];
  const startupListeners = [];
  const alarms = new Map(); // nom → options
  const webRequestListeners = [];
  const counts = { stateWrites: 0, fetches: 0 };
  const listener = (list = []) => ({ addListener: (fn) => list.push(fn) });
  const chrome = {
    storage: {
      local: {
        async get(key) {
          return key in storage ? { [key]: clone(storage[key]) } : {};
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) {
            if (k === STORAGE_KEY) counts.stateWrites++;
            storage[k] = clone(v);
          }
        },
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => (onMessage = fn) },
      onStartup: listener(startupListeners),
      onInstalled: listener(),
    },
    alarms: {
      onAlarm: listener(alarmListeners),
      create: (name, info) => alarms.set(name, clone(info)),
      clear: async (name) => alarms.delete(name),
    },
    webRequest: {
      onCompleted: { addListener: (fn, filter) => webRequestListeners.push({ fn, filter: clone(filter) }) },
    },
    cookies: {
      getAll: async () => options.cookies || [{ name: "refresh_token_XN1JV", value: "rt" }],
    },
  };
  // Faux Moxfield : jetons puis CSV (cf. tests/moxfield-collection.test.js
  // pour le détail des appels).
  async function fetch(url) {
    counts.fetches++;
    if (options.moxfieldCSV === undefined) throw new Error(`appel réseau inattendu : ${url}`);
    if (options.moxfieldCSV instanceof Error) throw options.moxfieldCSV;
    const body = url.includes("/token/") ? JSON.stringify({ access_token: "jeton" }) : options.moxfieldCSV;
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  }
  const context = vm.createContext({ chrome, fetch, setTimeout, clearTimeout, console });
  context.importScripts = (...files) => files.forEach((f) => vm.runInContext(read(f), context));
  vm.runInContext(read("background.js"), context);

  // Comme Chrome, message et réponse sont sérialisés (ce qui ramène aussi
  // les objets du contexte isolé dans celui des tests, pour deepEqual).
  function send(msg) {
    return new Promise((resolve) => onMessage(clone(msg), {}, (res) => resolve(clone(res))));
  }
  return {
    send,
    async state() {
      return (await send({ type: "GET_STATE" })).state;
    },
    raw: () => storage[STORAGE_KEY],
    counts,
    alarms,
    setCollectionMeta: (meta) => (storage[COLLECTION_KEY] = clone(meta)),
    setMoxfieldCSV: (csv) => (options.moxfieldCSV = csv),
    // Déclenche une alarme / le démarrage du navigateur et attend la fin des
    // traitements lancés.
    async fireAlarm(name) {
      for (const fn of alarmListeners) fn({ name });
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    webRequestFilters: () => webRequestListeners.map((l) => l.filter),
    // Requête terminée, vue par chrome.webRequest (cf. handleCollectionWrite).
    async requestCompleted(details) {
      await Promise.all(webRequestListeners.map((l) => l.fn({ tabId: 7, statusCode: 200, ...details })));
    },
    async startup() {
      await Promise.all(startupListeners.map((fn) => fn()));
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

// Quantités du stock, par nom normalisé : { "sol ring": 2, ... }.
function quantities(state) {
  return Object.fromEntries(Object.entries(state.stock).map(([k, c]) => [k, c.qty]));
}

const CSV_HEADER =
  "Count,Tradelist Count,Name,Edition,Condition,Language,Foil,Tags,Last Modified,Collector Number,Alter,Proxy,Purchase Price";

function csv(...rows) {
  return [CSV_HEADER, ...rows].join("\n");
}

function build(bg, deckId, cards) {
  return bg.send({
    type: "TOGGLE_DECK_BUILT",
    payload: { deckId, deckName: `Deck ${deckId}`, url: `https://moxfield.com/decks/${deckId}`, cards, built: true },
  });
}

function unbuild(bg, deckId) {
  return bg.send({ type: "TOGGLE_DECK_BUILT", payload: { deckId, deckName: "", url: "", cards: [], built: false } });
}

test("état vide au départ", async () => {
  const bg = loadBackground();
  assert.deepEqual(await bg.state(), { stock: {}, builtDecks: {} });
});

test("état : les anciennes clés (settings...) sont ignorées", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 1 } }, builtDecks: {}, settings: { x: 1 } });
  assert.deepEqual(Object.keys(await bg.state()), ["stock", "builtDecks"]);
});

test("message inconnu : erreur", async () => {
  const res = await loadBackground().send({ type: "NOPE" });
  assert.equal(res.ok, false);
  assert.match(res.error, /inconnu/);
});

test("import CSV : quantités agrégées par nom, toutes éditions confondues", async () => {
  const bg = loadBackground();
  const res = await bg.send({
    type: "IMPORT_CSV_TEXT",
    csvText: csv(
      '1,0,"Sol Ring",c21,Near Mint,English,,,2024-01-01,263,False,False,',
      '2,0,"Sol Ring",cmr,Near Mint,English,foil,,2024-01-01,472,False,False,',
      '1,0,"Sidisi, Brood Tyrant",ktk,Near Mint,English,,,2024-01-01,199,False,False,',
      '3,0,"Island",unf,Near Mint,English,,,2024-01-01,236,False,False,'
    ),
  });
  assert.deepEqual(res, { ok: true, cardCount: 3, totalQty: 7 });
  const state = await bg.state();
  assert.deepEqual(quantities(state), { "sol ring": 3, "sidisi, brood tyrant": 1, island: 3 });
  assert.equal(state.stock["sidisi, brood tyrant"].name, "Sidisi, Brood Tyrant");
});

test("import CSV : guillemets échappés, fins de ligne Windows, lignes invalides ignorées", async () => {
  const bg = loadBackground();
  await bg.send({
    type: "IMPORT_CSV_TEXT",
    csvText: csv(
      '1,0,"Kongming, ""Sleeping Dragon""",ptk,Near Mint,English,,,,,False,False,',
      'abc,0,"Sol Ring",c21,,,,,,,,,',
      '1,0,"",c21,,,,,,,,,',
      ""
    ).replace(/\n/g, "\r\n"),
  });
  assert.deepEqual(quantities(await bg.state()), { 'kongming, "sleeping dragon"': 1 });
});

test("import CSV : colonnes dans un autre ordre", async () => {
  const bg = loadBackground();
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: "Name,Count\nSol Ring,2" });
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 2 });
});

test("import CSV : fichier vide ou sans colonnes Count/Name refusé", async () => {
  const bg = loadBackground();
  const empty = await bg.send({ type: "IMPORT_CSV_TEXT", csvText: CSV_HEADER });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /vide/);
  const wrong = await bg.send({ type: "IMPORT_CSV_TEXT", csvText: "Quantity,Card\n1,Sol Ring" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /Count/);
  assert.deepEqual(await bg.state(), { stock: {}, builtDecks: {} }, "état inchangé après une erreur");
});

test("import CSV : écrase le stock et réapplique les decks montés", async () => {
  const bg = loadBackground();
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: csv("4,0,Sol Ring,,,,,,,,,,", "9,0,Forest,,,,,,,,,,") });
  await build(bg, "a", [
    { name: "Sol Ring", qty: 1 },
    { name: "Rhystic Study", qty: 1 },
    { name: "Arcane Signet", qty: 1, excludedFromStock: true },
  ]);
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: csv("2,0,Sol Ring,,,,,,,,,,") });
  // Forest disparaît (plus dans la collection) ; Sol Ring : 2 − 1 monté ;
  // Rhystic Study absente du CSV mais montée : −1 ; Arcane Signet jamais
  // décomptée.
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 1, "rhystic study": -1 });
});

test("montage puis démontage : stock décrémenté puis rendu", async () => {
  const bg = loadBackground();
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: csv("2,0,Sol Ring,,,,,,,,,,", "10,0,Island,,,,,,,,,,") });
  const cards = [
    { name: "Sol Ring", qty: 1 },
    { name: "Island", qty: 4 },
  ];
  assert.deepEqual(await build(bg, "a", cards), { ok: true });
  let state = await bg.state();
  assert.deepEqual(quantities(state), { "sol ring": 1, island: 6 });
  assert.deepEqual(state.builtDecks.a.cards, cards);
  assert.equal(state.builtDecks.a.name, "Deck a");
  assert.equal(typeof state.builtDecks.a.builtAt, "number");

  assert.deepEqual(await unbuild(bg, "a"), { ok: true });
  state = await bg.state();
  assert.deepEqual(quantities(state), { "sol ring": 2, island: 10 });
  assert.deepEqual(state.builtDecks, {});
});

test("montage : carte absente du stock → stock négatif", async () => {
  const bg = loadBackground();
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  assert.deepEqual(quantities(await bg.state()), { "sol ring": -1 });
});

test("montage : cartes excludedFromStock jamais décomptées, ni rendues", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 1 } }, builtDecks: {} });
  await build(bg, "a", [{ name: "Sol Ring", qty: 1, excludedFromStock: true }]);
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 1 });
  await unbuild(bg, "a");
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 1 });
});

test("montage en double ou démontage d'un deck non monté : sans effet", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 2 } }, builtDecks: {} });
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  assert.deepEqual(await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]), { ok: true, alreadyBuilt: true });
  assert.deepEqual(await unbuild(bg, "b"), { ok: true, wasNotBuilt: true });
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 1 });
});

test("mise à jour d'un deck monté : seules les cartes modifiées bougent", async () => {
  const bg = loadBackground({
    stock: {
      "sol ring": { name: "Sol Ring", qty: 1 },
      "rhystic study": { name: "Rhystic Study", qty: 0 },
      counterspell: { name: "Counterspell", qty: 2 },
    },
    builtDecks: {},
  });
  await build(bg, "a", [
    { name: "Sol Ring", qty: 1 },
    { name: "Rhystic Study", qty: 1 },
  ]);
  await bg.send({ type: "SET_DECK_PAGE_CHANGES", payload: { deckId: "a", changes: [{ name: "Counterspell", from: 0, to: 1 }] } });
  const cards = [
    { name: "Sol Ring", qty: 1 },
    { name: "Counterspell", qty: 1 },
  ];
  const res = await bg.send({
    type: "UPDATE_BUILT_DECK",
    payload: { deckId: "a", deckName: "Nouveau nom", url: "https://moxfield.com/decks/a", cards },
  });
  assert.deepEqual(res, { ok: true });
  const state = await bg.state();
  assert.deepEqual(quantities(state), { "sol ring": 0, "rhystic study": 0, counterspell: 1 });
  const deck = state.builtDecks.a;
  assert.deepEqual(deck.cards, cards);
  assert.equal(deck.name, "Nouveau nom");
  assert.equal(typeof deck.updatedAt, "number");
  assert.equal(typeof deck.builtAt, "number", "date de montage conservée");
  assert.equal(deck.pageChanges, undefined, "badge « Modifié » retiré");
  assert.equal(deck.pageCheckedAt, undefined);
});

test("mise à jour d'un deck qui n'est plus monté : erreur", async () => {
  const res = await loadBackground().send({
    type: "UPDATE_BUILT_DECK",
    payload: { deckId: "a", deckName: "", url: "", cards: [] },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /plus marqué comme monté/);
});

test("constat de modification : enregistré, puis effacé quand la page redevient identique", async () => {
  const bg = loadBackground();
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  const changes = [{ name: "Counterspell", from: 0, to: 1 }];
  assert.deepEqual(await bg.send({ type: "SET_DECK_PAGE_CHANGES", payload: { deckId: "a", changes } }), { ok: true });
  let deck = (await bg.state()).builtDecks.a;
  assert.deepEqual(deck.pageChanges, changes);
  assert.equal(typeof deck.pageCheckedAt, "number");

  await bg.send({ type: "SET_DECK_PAGE_CHANGES", payload: { deckId: "a", changes: [] } });
  deck = (await bg.state()).builtDecks.a;
  assert.equal(deck.pageChanges, undefined);
  assert.equal(deck.pageCheckedAt, undefined);
});

test("constat de modification : pas de nouvelle écriture si rien ne change", async () => {
  const bg = loadBackground();
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  const changes = [{ name: "Counterspell", from: 0, to: 1 }];
  await bg.send({ type: "SET_DECK_PAGE_CHANGES", payload: { deckId: "a", changes } });
  const again = await bg.send({ type: "SET_DECK_PAGE_CHANGES", payload: { deckId: "a", changes } });
  assert.deepEqual(again, { ok: true, unchanged: true });
  const empty = await bg.send({ type: "SET_DECK_PAGE_CHANGES", payload: { deckId: "a", changes: [] } });
  assert.deepEqual(empty, { ok: true });
  const emptyAgain = await bg.send({ type: "SET_DECK_PAGE_CHANGES", payload: { deckId: "a", changes: [] } });
  assert.deepEqual(emptyAgain, { ok: true, unchanged: true });
});

test("constat de modification d'un deck non monté : ignoré", async () => {
  const bg = loadBackground();
  const res = await bg.send({ type: "SET_DECK_PAGE_CHANGES", payload: { deckId: "x", changes: [{ name: "A", from: 0, to: 1 }] } });
  assert.deepEqual(res, { ok: true, ignored: true });
  assert.deepEqual((await bg.state()).builtDecks, {});
});

test("ajustement manuel : +/− sur une carte existante ou nouvelle", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 1 } }, builtDecks: {} });
  await bg.send({ type: "MANUAL_ADJUST_STOCK", payload: { name: "sol  RING", delta: 2 } });
  await bg.send({ type: "MANUAL_ADJUST_STOCK", payload: { name: "Counterspell", delta: -1 } });
  const state = await bg.state();
  assert.deepEqual(quantities(state), { "sol ring": 3, counterspell: -1 });
  assert.equal(state.stock["sol ring"].name, "Sol Ring", "nom d'origine conservé");
});

test("réinitialisation : stock et decks montés vidés", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 1 } }, builtDecks: {} });
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  assert.deepEqual(await bg.send({ type: "RESET_STOCK" }), { ok: true });
  assert.deepEqual(await bg.state(), { stock: {}, builtDecks: {} });
});

test("chaque modification marque l'état à synchroniser", async () => {
  const bg = loadBackground();
  const before = (await bg.send({ type: "GET_SYNC_STATUS" })).meta;
  assert.equal(before.dirty, false);
  assert.equal(before.enabled, false);
  await bg.send({ type: "MANUAL_ADJUST_STOCK", payload: { name: "Sol Ring", delta: 1 } });
  const after = (await bg.send({ type: "GET_SYNC_STATUS" })).meta;
  assert.equal(after.dirty, true);
  assert.ok(after.localUpdatedAt > 0);
});

test("import CSV : résumé calculé sur la collection, pas sur le stock libre", async () => {
  const bg = loadBackground({ stock: {}, builtDecks: {} });
  await build(bg, "a", [{ name: "Rhystic Study", qty: 1 }]);
  const res = await bg.send({ type: "IMPORT_CSV_TEXT", csvText: csv("2,0,Sol Ring,,,,,,,,,,") });
  assert.deepEqual(res, { ok: true, cardCount: 1, totalQty: 2 });
});

// --- Récupération automatique de la collection Moxfield ---

const COLLECTION_CSV = csv("3,0,Sol Ring,,,,,,,,,,", "1,0,Rhystic Study,,,,,,,,,,", "10,0,Island,,,,,,,,,,");

async function collectionStatus(bg) {
  return bg.send({ type: "GET_COLLECTION_STATUS" });
}

test("récupération : collection importée, decks montés réappliqués, changements retenus", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 2 } }, builtDecks: {} }, { moxfieldCSV: COLLECTION_CSV });
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  const res = await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.changes, [
    { name: "Island", from: 0, to: 10 },
    { name: "Rhystic Study", from: 0, to: 1 },
    { name: "Sol Ring", from: 2, to: 3 },
  ]);
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 2, "rhystic study": 1, island: 10 });

  const { meta } = await collectionStatus(bg);
  assert.equal(meta.enabled, true, "activée par défaut");
  assert.equal(meta.lastError, null);
  assert.equal(typeof meta.lastSuccessAt, "number");
  assert.deepEqual(meta.lastChanges, res.changes);
  assert.equal(typeof meta.lastChangesAt, "number");
});

test("récupération sans changement : aucune écriture du stock (rien n'est envoyé sur Drive)", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  const first = await bg.send({ type: "COLLECTION_FETCH_NOW" });
  const writes = bg.counts.stateWrites;
  const second = await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.deepEqual(second, { ok: true, changes: [] });
  assert.equal(bg.counts.stateWrites, writes);
  const { meta } = await collectionStatus(bg);
  assert.deepEqual(meta.lastChanges, first.changes, "derniers changements conservés");
});

test("récupération : un ajustement manuel est écrasé par la collection", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  await bg.send({ type: "MANUAL_ADJUST_STOCK", payload: { name: "Sol Ring", delta: 1 } });
  const res = await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.deepEqual(res.changes, [{ name: "Sol Ring", from: 4, to: 3 }]);
  assert.equal((await bg.state()).stock["sol ring"].qty, 3);
});

test("récupération en échec : erreur retenue, stock inchangé", async () => {
  const before = { stock: { "sol ring": { name: "Sol Ring", qty: 2 } }, builtDecks: {} };
  const bg = loadBackground(before, { moxfieldCSV: new TypeError("Failed to fetch") });
  const res = await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "network");
  assert.deepEqual(await bg.state(), before);
  const { meta } = await collectionStatus(bg);
  assert.equal(meta.lastError.code, "network");
  assert.match(meta.lastError.message, /injoignable/);
  assert.equal(meta.lastSuccessAt, null);
});

test("récupération sans session Moxfield : pas connecté, aucun appel", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV, cookies: [] });
  const res = await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.equal(res.code, "not-logged-in");
  assert.equal(bg.counts.fetches, 0);
});

test("une récupération réussie efface l'erreur précédente", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: new TypeError("Failed to fetch") });
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  bg.setMoxfieldCSV(COLLECTION_CSV);
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.equal((await collectionStatus(bg)).meta.lastError, null);
});

test("cartes de decks montés que la collection ne couvre plus (terrains de base exclus)", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: csv("1,0,Sol Ring,,,,,,,,,,") });
  await build(bg, "a", [
    { name: "Sol Ring", qty: 1 },
    { name: "Rhystic Study", qty: 1 },
    { name: "Island", qty: 5 },
    { name: "Arcane Signet", qty: 1, excludedFromStock: true },
  ]);
  await build(bg, "b", [{ name: "Rhystic Study", qty: 1 }]);
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  const { uncovered } = await collectionStatus(bg);
  assert.deepEqual(uncovered, [{ name: "Rhystic Study", missing: 2, decks: ["Deck a", "Deck b"] }]);
});

test("alarme horaire : récupère si la dernière tentative date d'au moins 55 min", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  bg.setCollectionMeta({ lastAttemptAt: Date.now() - 56 * 60 * 1000 });
  await bg.fireAlarm("moxfield-collection");
  assert.equal(bg.counts.fetches, 3, "renouvellement, jeton d'export, CSV");
  assert.equal((await bg.state()).stock["sol ring"].qty, 3);
});

test("alarme horaire : rien si une récupération vient d'avoir lieu", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  bg.setCollectionMeta({ lastAttemptAt: Date.now() - 10 * 60 * 1000 });
  await bg.fireAlarm("moxfield-collection");
  assert.equal(bg.counts.fetches, 0);
});

test("récupération automatique désactivée : l'alarme ne fait rien, le bouton marche", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  bg.alarms.set("moxfield-collection", {});
  bg.alarms.set("moxfield-collection-changed", {});
  const res = await bg.send({ type: "SET_COLLECTION_AUTO", payload: { enabled: false } });
  assert.equal(res.meta.enabled, false);
  assert.ok(!bg.alarms.has("moxfield-collection"), "alarme supprimée");
  assert.ok(!bg.alarms.has("moxfield-collection-changed"), "récupération programmée annulée");
  await bg.fireAlarm("moxfield-collection");
  assert.equal(bg.counts.fetches, 0);
  assert.equal((await bg.send({ type: "COLLECTION_FETCH_NOW" })).ok, true);
});

test("réactivation : alarme recréée et récupération immédiate si due", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  bg.setCollectionMeta({ enabled: false });
  await bg.send({ type: "SET_COLLECTION_AUTO", payload: { enabled: true } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(bg.alarms.has("moxfield-collection"));
  assert.equal(bg.counts.fetches, 3);
});

test("démarrage du navigateur : alarme recréée et récupération si due", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  await bg.startup();
  assert.ok(bg.alarms.has("moxfield-collection"));
  assert.equal(bg.counts.fetches, 3);
});

// --- Récupération après une modification de la collection sur Moxfield ---

const ADD_CARD = { method: "POST", url: "https://api2.moxfield.com/v1/collections?setPrefPrinting=false" };
const EDIT_CARD = { method: "PUT", url: "https://api2.moxfield.com/v1/collections/3GnQVA6?setPrefPrinting=false" };

test("modification de la collection : observée sur les appels de collection de l'API", () => {
  const bg = loadBackground();
  assert.deepEqual(bg.webRequestFilters(), [{ urls: ["https://api2.moxfield.com/*/collections*"] }]);
});

test("ajout ou modification d'une carte : récupération programmée 30 s plus tard", async () => {
  for (const request of [ADD_CARD, EDIT_CARD, { method: "DELETE", url: "https://api2.moxfield.com/v1/collections/3GnQVA6" }]) {
    const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
    await bg.requestCompleted(request);
    assert.deepEqual(bg.alarms.get("moxfield-collection-changed"), { delayInMinutes: 0.5 }, request.method);
    assert.equal(bg.counts.fetches, 0, "pas de récupération immédiate");
  }
});

test("à l'échéance : la collection est récupérée", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  await bg.requestCompleted(EDIT_CARD);
  await bg.fireAlarm("moxfield-collection-changed");
  assert.equal(bg.counts.fetches, 3);
  assert.equal((await bg.state()).stock["sol ring"].qty, 3);
});

test("à l'échéance : récupérée même si une récupération horaire vient d'avoir lieu", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  bg.setCollectionMeta({ lastAttemptAt: Date.now() - 60 * 1000 });
  await bg.fireAlarm("moxfield-collection-changed");
  assert.equal(bg.counts.fetches, 3);
});

test("lectures, requêtes hors onglet et échecs : ignorés", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  await bg.requestCompleted({ method: "GET", url: "https://api2.moxfield.com/v1/collections/search" });
  await bg.requestCompleted({ ...EDIT_CARD, tabId: -1 });
  await bg.requestCompleted({ ...EDIT_CARD, statusCode: 400 });
  assert.ok(!bg.alarms.has("moxfield-collection-changed"));
});

test("récupération automatique désactivée : modification ignorée", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  bg.setCollectionMeta({ enabled: false });
  await bg.requestCompleted(ADD_CARD);
  assert.ok(!bg.alarms.has("moxfield-collection-changed"));
});
