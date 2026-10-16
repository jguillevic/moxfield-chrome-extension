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
const SYNC_KEY = "moxfieldStockManagerSync";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CHROME = { userAgent: UA, userAgentData: { brands: [{ brand: "Google Chrome", version: "141" }], platform: "Windows" } };
const BRAVE = { userAgent: UA, userAgentData: { brands: [{ brand: "Brave", version: "141" }], platform: "Linux" }, brave: {} };

// options.moxfieldCSV : collection renvoyée par le faux Moxfield (CSV), ou
// une Error à lever ; sans elle, tout appel réseau fait échouer le test.
// options.cookies : cookies de moxfield.com (session ouverte par défaut).
// options.drive : fausse API Google Drive, (url, options) => réponse.
// options.sentryDsn : DSN des rapports d'erreurs (aucun envoi sinon) ; les
// rapports reçus par le faux Sentry sont dans sentry (événements).
// options.authError : erreur levée par chrome.identity.getAuthToken
// (ex. Brave, qui ne l'implémente pas).
// options.navigator : navigateur (Google Chrome par défaut ; cf. BRAVE).
// options.webAuth : fausse fenêtre de connexion Google, (details) => URL de
// redirection ; par défaut un jeton pour le compte google.email.
// Sans options.drive, un Drive vide (aucun fichier) accepte tous les envois.
function loadBackground(initialState, options = {}) {
  const storage = {};
  if (initialState) storage[STORAGE_KEY] = initialState;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  let onMessage = null;
  const alarmListeners = [];
  const startupListeners = [];
  const alarms = new Map(); // nom → options
  const webRequestListeners = [];
  const cookieListeners = [];
  const counts = { stateWrites: 0, fetches: 0 };
  const sentry = [];
  const session = {};
  // Compte Google du profil Chrome et de la fenêtre de connexion ;
  // modifiable en cours de test (changement de compte).
  const google = { email: "moi@gmail.com", profileId: "118294207213255860701", launches: [], driveCalls: [] };
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
      session: {
        get: async (key) => (key in session ? { [key]: clone(session[key]) } : {}),
        set: async (items) => Object.assign(session, clone(items)),
        remove: async (key) => delete session[key],
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => (onMessage = fn) },
      onStartup: listener(startupListeners),
      onInstalled: listener(),
      getManifest: () => ({ version: "0.2.0" }),
      getPlatformInfo: async () => ({ os: "win" }),
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
      getAll: async () => options.cookies || [{ name: "refresh_token_ABC12", value: "rt" }],
      onChanged: listener(cookieListeners),
    },
    identity: {
      getAuthToken: async () => {
        if (options.authError) throw options.authError;
        return { token: "jeton-google" };
      },
      removeCachedAuthToken: async () => {},
      getProfileUserInfo: async () => ({ id: google.profileId, email: google.email }),
      getRedirectURL: () => "https://pkifconeiolgllnjbnbenadbohcihopf.chromiumapp.org/",
      launchWebAuthFlow: async (details) => {
        google.launches.push(clone(details));
        const webAuth = google.webAuth || options.webAuth;
        if (webAuth) return webAuth(details);
        return `https://pkifconeiolgllnjbnbenadbohcihopf.chromiumapp.org/#access_token=web-${google.launches.length}&expires_in=3599`;
      },
    },
  };
  // Drive vide qui accepte tout ; adresse du compte connecté.
  function defaultDrive(url, init = {}) {
    google.driveCalls.push({ url, method: init.method || "GET" });
    if (url.includes("/about")) return new Response(JSON.stringify({ user: { emailAddress: google.email } }));
    if (url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ files: [] }));
    return new Response(JSON.stringify({ id: "f1", version: "1" }));
  }
  // Faux Moxfield : jetons puis CSV (cf. tests/moxfield-collection.test.js
  // pour le détail des appels).
  async function fetch(url, init) {
    if (url.includes("googleapis.com")) return (options.drive || defaultDrive)(url, init);
    if (url.includes("sentry.io")) {
      sentry.push(JSON.parse(init.body.split("\n")[2]));
      return { ok: true };
    }
    counts.fetches++;
    if (options.moxfieldCSV === undefined) throw new Error(`appel réseau inattendu : ${url}`);
    if (options.moxfieldCSV instanceof Error) throw options.moxfieldCSV;
    const body = url.includes("/token/") ? JSON.stringify({ access_token: "jeton" }) : options.moxfieldCSV;
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  }
  const navigator = options.navigator || CHROME;
  const context = vm.createContext({
    chrome, fetch, setTimeout, clearTimeout, setInterval, clearInterval, console, navigator, URL, URLSearchParams,
    Blob, Response, FormData, TextDecoder, CompressionStream, DecompressionStream,
  });
  context.importScripts = (...files) => files.forEach((f) => vm.runInContext(read(f), context));
  const source = read("background.js");
  // DSN remplacée : aucun test n'envoie de rapport au vrai projet Sentry.
  const dsnLine = /const SENTRY_DSN = "[^"]*";/;
  if (!dsnLine.test(source)) throw new Error("SENTRY_DSN introuvable dans background.js");
  vm.runInContext(source.replace(dsnLine, `const SENTRY_DSN = "${options.sentryDsn || ""}";`), context);

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
    // Fonctions internes (synchro Drive, sans appel réseau).
    context,
    counts,
    sentry,
    google,
    session,
    syncMeta: () => clone(storage[SYNC_KEY]),
    setSyncMeta: (meta) => (storage[SYNC_KEY] = clone(meta)),
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
    // Cookie de moxfield.com posé ou retiré (connexion sur le site).
    async cookieChanged(change) {
      await Promise.all(cookieListeners.map((fn) => fn(clone(change))));
    },
    setCookies: (cookies) => (options.cookies = cookies),
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

test("pas d'ajustement manuel du stock : Moxfield est la seule source de vérité", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 1 } }, builtDecks: {} });
  const res = await bg.send({ type: "MANUAL_ADJUST_STOCK", payload: { name: "Sol Ring", delta: 2 } });
  assert.equal(res.ok, false);
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 1 });
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
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
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

test("récupération : un stock qui diverge de Moxfield est remis en conformité", async () => {
  const diverging = { stock: { "sol ring": { name: "Sol Ring", qty: 4 }, "rhystic study": { name: "Rhystic Study", qty: 1 }, island: { name: "Island", qty: 10 } }, builtDecks: {} };
  const bg = loadBackground(diverging, { moxfieldCSV: COLLECTION_CSV });
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

// --- Historique ---

async function historyOf(bg) {
  return (await bg.send({ type: "GET_HISTORY" })).entries;
}

const SOL_RING_STOCK = () => ({ stock: { "sol ring": { name: "Sol Ring", qty: 2 } }, builtDecks: {} });

test("historique : l'état lu par les pages ne le contient pas", async () => {
  const bg = loadBackground();
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  assert.deepEqual(Object.keys(await bg.state()), ["stock", "builtDecks"]);
  assert.equal(bg.raw().history.length, 1);
});

test("historique : montage, mise à jour et démontage notés, le plus récent en premier", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  await bg.send({
    type: "UPDATE_BUILT_DECK",
    payload: { deckId: "a", deckName: "Deck a", url: "", cards: [{ name: "Sol Ring", qty: 1 }, { name: "Counterspell", qty: 1 }] },
  });
  await unbuild(bg, "a");
  const entries = await historyOf(bg);
  assert.deepEqual(entries.map((e) => e.title), [
    "Deck « Deck a » démonté : 2 cartes rendues au stock",
    "Montage de « Deck a » mis à jour : 1 carte modifiée",
    "Deck « Deck a » monté : 1 carte retirée du stock libre",
  ]);
  assert.deepEqual(entries[1].changes, [{ name: "Counterspell", from: 0, to: 1 }]);
  assert.ok(entries.every((e) => e.otherDevice === false && typeof e.at === "number"));
});

test("historique : récupération et import CSV notés seulement s'ils changent le stock", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  await bg.send({ type: "COLLECTION_FETCH_NOW" }); // rien de nouveau
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: COLLECTION_CSV }); // identique
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: csv("1,0,Sol Ring,,,,,,,,,,") });
  const entries = await historyOf(bg);
  assert.deepEqual(entries.map((e) => e.title), [
    "Import CSV : 3 cartes modifiées",
    "Collection Moxfield récupérée : 3 cartes modifiées",
  ]);
  assert.deepEqual(entries[0].changes, [
    { name: "Island", from: 10, to: 0 },
    { name: "Rhystic Study", from: 1, to: 0 },
    { name: "Sol Ring", from: 3, to: 1 },
  ]);
});

test("historique : réinitialisation notée, l'historique est conservé", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  await bg.send({ type: "RESET_STOCK" });
  const entries = await historyOf(bg);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, "Stock réinitialisé (1 deck démonté)");
});

test("historique : action venant d'un autre PC signalée", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  bg.raw().history[0].device = "autre-pc";
  assert.equal((await historyOf(bg))[0].otherDevice, true);
});


// --- Historique et synchro Google Drive ---

function driveDoc(state, updatedAt = 1) {
  return { app: "moxfield-stock-manager", version: 1, updatedAt, state };
}

// Les objets créés dans le contexte isolé sont sérialisés pour deepEqual.
const plain = (v) => JSON.parse(JSON.stringify(v));

test("sauvegarde Drive sans historique (ancienne version) : acceptée", () => {
  const bg = loadBackground();
  const parsed = bg.context.parseDoc(driveDoc({ stock: {}, builtDecks: {} }));
  assert.equal(parsed.state.history.length, 0);
});

test("sauvegarde Drive : entrées d'historique invalides écartées", () => {
  const bg = loadBackground();
  const parsed = bg.context.parseDoc(driveDoc({ stock: {}, builtDecks: {}, history: [{ id: "a", at: 1 }, { at: 2 }, "x", null] }));
  assert.deepEqual(plain(parsed.state.history.map((e) => e.id)), ["a"]);
});

test("version Drive appliquée : l'historique de ce PC est conservé et reste à envoyer", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  const local = bg.raw().history[0];
  const remote = bg.context.parseDoc(driveDoc({ stock: {}, builtDecks: {}, history: [{ id: "r1", at: 5, type: "drive-restore" }] }));
  await bg.context.applyRemote(remote, { version: "7" });
  assert.deepEqual(bg.raw().history.map((e) => e.id), [local.id, "r1"]);
  const meta = (await bg.send({ type: "GET_SYNC_STATUS" })).meta;
  assert.equal(meta.dirty, true, "l'entrée locale doit partir sur Drive");
  assert.equal(meta.syncedVersion, "7");
});

test("version Drive appliquée sans rien de nouveau ici : rien à renvoyer", async () => {
  const bg = loadBackground();
  const remote = bg.context.parseDoc(driveDoc({ stock: {}, builtDecks: {}, history: [{ id: "r1", at: 5, type: "drive-restore" }] }));
  await bg.context.applyRemote(remote, { version: "8" });
  assert.equal((await bg.send({ type: "GET_SYNC_STATUS" })).meta.dirty, false);
  assert.deepEqual(bg.raw().history.map((e) => e.id), ["r1"]);
});

test("version de ce PC envoyée sur Drive : l'historique de Drive y est ajouté", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  const remoteDoc = bg.context.parseDoc(driveDoc({ stock: {}, builtDecks: {}, history: [{ id: "r1", at: 5, type: "drive-restore" }] }));
  await bg.context.mergeRemoteHistory(remoteDoc);
  assert.equal(bg.raw().history.length, 2);
  assert.ok(bg.raw().history.some((e) => e.id === "r1"));
  assert.ok(bg.raw().builtDecks.a, "le reste de l'état de ce PC est inchangé");
});

// --- Grosses collections ---

test("permission de stockage illimité (une grosse collection dépasse 10 Mo avec ses données)", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
});

test("page de deck : seulement le stock de ses cartes et de son montage, decks montés compris", async () => {
  const bg = loadBackground({
    stock: {
      "sol ring": { name: "Sol Ring", qty: 1 },
      "revitalizing repast // old-growth grove": { name: "Revitalizing Repast // Old-Growth Grove", qty: 1 },
      counterspell: { name: "Counterspell", qty: 2 },
      "rhystic study": { name: "Rhystic Study", qty: 1 },
      island: { name: "Island", qty: 10 },
    },
    builtDecks: {},
  });
  await build(bg, "a", [{ name: "Counterspell", qty: 1 }]);
  const res = await bg.send({
    type: "GET_DECK_CONTEXT",
    // Face avant seule (vue Text), et casse différente.
    payload: { deckId: "a", names: ["SOL RING", "Revitalizing Repast", "Inconnue"] },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.stock).sort(), ["counterspell", "revitalizing repast // old-growth grove", "sol ring"]);
  assert.deepEqual(Object.keys(res.builtDecks), ["a"]);
});

test("page de deck : sans deck ni carte, aucun stock envoyé", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  const res = await bg.send({ type: "GET_DECK_CONTEXT", payload: { deckId: "inconnu", names: [] } });
  assert.deepEqual(res, { ok: true, stock: {}, builtDecks: {} });
});

test("collection de 50 000 cartes : import, historique et page de deck restent légers", async () => {
  const rows = [];
  for (let i = 0; i < 50000; i++) rows.push(`${1 + (i % 3)},0,"Card Name Number ${i % 30000} of the Multiverse",sld,,,,,,,,,`);
  const bg = loadBackground();
  const start = Date.now();
  const res = await bg.send({ type: "IMPORT_CSV_TEXT", csvText: csv(...rows) });
  assert.equal(res.cardCount, 30000);
  assert.ok(Date.now() - start < 5000, `import en ${Date.now() - start} ms`);

  const deckCards = Array.from({ length: 99 }, (_, i) => ({ name: `Card Name Number ${i} of the Multiverse`, qty: 1 }));
  await build(bg, "a", deckCards);

  // Historique : le premier import (30 000 cartes) ne garde que 200 lignes de détail.
  const stored = bg.raw();
  const importEntry = stored.history.find((e) => e.type === "collection");
  assert.equal(importEntry.changes.length, 200);
  assert.equal(importEntry.changeCount, 30000);
  const historySize = JSON.stringify(stored.history).length;
  assert.ok(historySize < 100 * 1024, `historique : ${historySize} octets`);
  const [listed] = (await historyOf(bg)).filter((e) => e.title.startsWith("Import CSV"));
  assert.equal(listed.title, "Import CSV : 30000 cartes modifiées");
  assert.equal(listed.changeCount, 30000);

  // Page de deck : le stock de ses 99 cartes, pas les 30 000.
  const context = await bg.send({ type: "GET_DECK_CONTEXT", payload: { deckId: "a", names: deckCards.map((c) => c.name) } });
  assert.equal(Object.keys(context.stock).length, 99);
  const contextSize = JSON.stringify(context).length;
  assert.ok(contextSize < 50 * 1024, `réponse à la page : ${contextSize} octets`);
});

// --- Fichiers Google Drive compressés ---

const zlib = require("zlib");
const DOC = { app: "moxfield-stock-manager", version: 1, updatedAt: 5, state: { stock: { "sol ring": { name: "Sol Ring", qty: 2 } }, builtDecks: {}, history: [] } };

// Fausse API Drive : enregistre les envois, répond avec le contenu donné.
function fakeDrive(fileContent) {
  const calls = [];
  const drive = async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(fileContent === undefined ? JSON.stringify({ id: "f1", version: "3" }) : fileContent, { status: 200 });
  };
  return { drive, calls };
}

async function bytesOf(blob) {
  return Buffer.from(await blob.arrayBuffer());
}

test("Drive : document compressé (gzip) puis relu à l'identique", async () => {
  const bg = loadBackground();
  const blob = await bg.context.encodeDoc(DOC);
  const bytes = await bytesOf(blob);
  assert.equal(blob.type, "application/gzip");
  assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b], "signature gzip");
  assert.deepEqual(JSON.parse(zlib.gunzipSync(bytes).toString()), DOC);
  assert.deepEqual(plain(await bg.context.decodeDoc(bytes)), DOC);
});

test("Drive : fichier enregistré avant la compression (JSON) toujours lisible", async () => {
  const bg = loadBackground();
  const bytes = Buffer.from(JSON.stringify(DOC));
  assert.deepEqual(plain(await bg.context.decodeDoc(bytes)), DOC);
});

test("Drive : une grosse collection est au moins 3 fois plus légère", async () => {
  const bg = loadBackground();
  const stock = {};
  for (let i = 0; i < 30000; i++) stock[`card ${i}`] = { name: `Card ${i} of the Multiverse`, qty: 1 + (i % 4) };
  const doc = { ...DOC, state: { stock, builtDecks: {}, history: [] } };
  const raw = Buffer.byteLength(JSON.stringify(doc));
  const compressed = (await bytesOf(await bg.context.encodeDoc(doc))).length;
  assert.ok(compressed * 3 < raw, `${raw} → ${compressed} octets`);
});

test("Drive : mise à jour du fichier d'état envoyée compressée", async () => {
  const { drive, calls } = fakeDrive();
  const bg = loadBackground(undefined, { drive });
  await bg.context.uploadStateDoc("f1", DOC);
  const [call] = calls;
  assert.equal(call.init.method, "PATCH");
  assert.equal(call.init.headers["Content-Type"], "application/gzip");
  assert.deepEqual(JSON.parse(zlib.gunzipSync(await bytesOf(call.init.body)).toString()), DOC);
});

test("Drive : nouveau fichier (état ou version de l'historique) envoyé compressé", async () => {
  const { drive, calls } = fakeDrive();
  const bg = loadBackground(undefined, { drive });
  await bg.context.uploadStateDoc(null, DOC);
  const form = calls[0].init.body;
  const metadata = JSON.parse(await form.get("metadata").text());
  assert.equal(metadata.name, "moxfield-stock-state.json");
  assert.equal(metadata.mimeType, "application/gzip");
  assert.deepEqual(JSON.parse(zlib.gunzipSync(await bytesOf(form.get("file"))).toString()), DOC);
});

test("Drive : lecture d'un fichier compressé comme d'un ancien fichier JSON", async () => {
  for (const content of [zlib.gzipSync(JSON.stringify(DOC)), JSON.stringify(DOC)]) {
    const { drive } = fakeDrive(content);
    const bg = loadBackground(undefined, { drive });
    const parsed = await bg.context.downloadDoc("f1");
    assert.deepEqual(plain(parsed.state.stock), DOC.state.stock);
    assert.equal(parsed.updatedAt, 5);
  }
});

// --- Rapports d'erreurs (Sentry) ---

const SENTRY_DSN = "https://abc123@o42.ingest.de.sentry.io/777";
const waitReports = () => new Promise((resolve) => setTimeout(resolve, 30));

test("erreur inattendue d'une action : rapportée, avec l'action en cause", async () => {
  const bg = loadBackground(undefined, { sentryDsn: SENTRY_DSN });
  const res = await bg.send({ type: "TOGGLE_DECK_BUILT" }); // sans payload : bug simulé
  assert.equal(res.ok, false);
  await waitReports();
  assert.equal(bg.sentry.length, 1);
  const [event] = bg.sentry;
  assert.equal(event.tags.where, "message:TOGGLE_DECK_BUILT");
  assert.equal(event.exception.values[0].type, "TypeError");
  assert.equal(event.release, "moxfield-stock-manager@0.2.0");
  assert.match(event.user.id, /\w/);
  // Rien d'autre que l'erreur et son contexte (jamais l'état).
  assert.deepEqual(Object.keys(event).sort(), ["event_id", "exception", "extra", "level", "platform", "release", "tags", "timestamp", "user"]);
});

test("même erreur répétée : un seul rapport", async () => {
  const bg = loadBackground(undefined, { sentryDsn: SENTRY_DSN });
  for (let i = 0; i < 3; i++) await bg.send({ type: "TOGGLE_DECK_BUILT" });
  await waitReports();
  assert.equal(bg.sentry.length, 1);
});

test("rapports coupés par l'utilisateur, ou pas de DSN : rien ne part", async () => {
  const off = loadBackground(undefined, { sentryDsn: SENTRY_DSN });
  const res = await off.send({ type: "SET_ERROR_REPORTS", payload: { enabled: false } });
  assert.deepEqual(res, { ok: true, enabled: false, configured: true });
  await off.send({ type: "TOGGLE_DECK_BUILT" });
  await waitReports();
  assert.equal(off.sentry.length, 0);
  assert.deepEqual(await off.send({ type: "GET_ERROR_REPORTS" }), { ok: true, enabled: false, configured: true });

  const noDsn = loadBackground();
  assert.deepEqual(await noDsn.send({ type: "GET_ERROR_REPORTS" }), { ok: true, enabled: true, configured: false });
  await noDsn.send({ type: "TOGGLE_DECK_BUILT" });
  await waitReports();
  assert.equal(noDsn.sentry.length, 0);
});

test("erreur d'une page (deck, popup) : rapportée par le service worker", async () => {
  const bg = loadBackground(undefined, { sentryDsn: SENTRY_DSN });
  const error = { message: "x is null", stack: "TypeError: x is null\n    at f (chrome-extension://id/content-deck.js:10:5)", type: "TypeError" };
  const res = await bg.send({ type: "REPORT_ERROR", payload: { where: "deck-page:check", error } });
  assert.deepEqual(res, { ok: true, sent: true });
  const [event] = bg.sentry;
  assert.equal(event.tags.where, "deck-page:check");
  assert.equal(event.exception.values[0].value, "x is null");
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "content-deck.js");
});

test("connexion Google impossible (ex. Brave) : rapportée avec l'erreur d'origine", async () => {
  const bg = loadBackground(undefined, {
    sentryDsn: SENTRY_DSN,
    authError: new Error("This API is not supported on this browser"),
  });
  const res = await bg.send({ type: "DRIVE_CONNECT" });
  assert.equal(res.error, "Connexion à Google refusée ou annulée.");
  await waitReports();
  const [event] = bg.sentry;
  assert.equal(event.tags.where, "message:DRIVE_CONNECT");
  assert.equal(event.extra.cause, "Error: This API is not supported on this browser");
});

test("récupération de la collection : seules les erreurs anormales sont rapportées", async () => {
  const loggedOut = loadBackground(undefined, { sentryDsn: SENTRY_DSN, moxfieldCSV: "", cookies: [] });
  assert.equal((await loggedOut.send({ type: "COLLECTION_FETCH_NOW" })).code, "not-logged-in");
  await waitReports();
  assert.equal(loggedOut.sentry.length, 0, "pas connecté à Moxfield : situation normale");

  const changed = loadBackground(undefined, { sentryDsn: SENTRY_DSN, moxfieldCSV: "<html>maintenance</html>" });
  assert.equal((await changed.send({ type: "COLLECTION_FETCH_NOW" })).code, "api-changed");
  await waitReports();
  assert.equal(changed.sentry.length, 1);
  assert.equal(changed.sentry[0].tags.where, "moxfield-collection");
  assert.deepEqual(changed.sentry[0].extra, { code: "api-changed" });
});

// --- Synchro Drive hors Google Chrome (fenêtre de connexion) ---

const TOKEN_KEY = "moxfieldStockManagerGoogleToken";
const authParams = (launch) => Object.fromEntries(new URL(launch.url).searchParams);

async function connectedOnBrave(options = {}) {
  const bg = loadBackground(undefined, { navigator: BRAVE, ...options });
  const res = await bg.send({ type: "DRIVE_CONNECT" });
  assert.equal(res.ok, true, res.error);
  return bg;
}

test("Brave : connexion par la fenêtre Google, compte lu sur Drive", async () => {
  const bg = await connectedOnBrave();
  const meta = bg.syncMeta();
  assert.equal(meta.authMethod, "web");
  assert.equal(meta.enabled, true);
  assert.equal(meta.accountEmail, "moi@gmail.com");
  assert.equal(meta.accountId, null, "pas d'identifiant de profil Chrome");
  assert.equal(meta.lastError, null);
  assert.equal(bg.google.launches.length, 1, "une seule fenêtre pour toute la connexion");
  assert.equal(bg.google.launches[0].interactive, true);
  assert.equal(authParams(bg.google.launches[0]).client_id, "494997360432-b2572mk99tjvd882i4695b83d71d1oka.apps.googleusercontent.com");
  assert.equal(authParams(bg.google.launches[0]).prompt, "select_account");
});

test("Google Chrome : connexion par le compte du profil, sans fenêtre", async () => {
  const bg = loadBackground();
  assert.equal((await bg.send({ type: "DRIVE_CONNECT" })).ok, true);
  const meta = bg.syncMeta();
  assert.equal(meta.authMethod, "chrome");
  assert.equal(meta.accountId, "118294207213255860701");
  assert.equal(bg.google.launches.length, 0);
});

test("Chrome connecté avant la fenêtre de connexion (sans méthode notée) : rien ne change", async () => {
  const bg = loadBackground(undefined, { navigator: BRAVE });
  bg.setSyncMeta({ enabled: true, accountId: "118294207213255860701", accountEmail: "moi@gmail.com", syncedVersion: "1" });
  const res = await bg.send({ type: "SYNC_NOW" });
  assert.equal(res.meta.lastError, null);
  assert.equal(bg.google.launches.length, 0);
});

test("synchro en fond, navigateur redémarré : jeton renouvelé sans fenêtre, pour le même compte", async () => {
  const bg = await connectedOnBrave();
  delete bg.session[TOKEN_KEY]; // mémoire de session vidée au redémarrage
  const res = await bg.send({ type: "SYNC_NOW" });
  assert.equal(res.meta.lastError, null);
  const silent = bg.google.launches[1];
  assert.equal(silent.interactive, false);
  assert.equal(authParams(silent).prompt, "none");
  assert.equal(authParams(silent).login_hint, "moi@gmail.com");
});

test("renouvellement impossible : « Reconnecter » proposé, sans rapport d'erreur", async () => {
  const bg = await connectedOnBrave({ sentryDsn: SENTRY_DSN });
  delete bg.session[TOKEN_KEY];
  // Session Google fermée dans le navigateur : Google répond sans jeton.
  bg.google.webAuth = () => "https://pkifconeiolgllnjbnbenadbohcihopf.chromiumapp.org/#error=interaction_required";
  const res = await bg.send({ type: "SYNC_NOW" });
  assert.match(res.meta.lastError, /Reconnecter/);
  assert.ok(bg.google.launches.every((l) => l === bg.google.launches[0] || !l.interactive), "aucune fenêtre ouverte en fond");
  await waitReports();
  assert.equal(bg.sentry.length, 0);
});

test("reconnexion avec un autre compte Google : synchro en pause, choix demandé", async () => {
  const bg = await connectedOnBrave();
  delete bg.session[TOKEN_KEY];
  bg.google.email = "autre@gmail.com";
  await bg.send({ type: "DRIVE_CONNECT" });
  const meta = bg.syncMeta();
  assert.deepEqual(meta.accountMismatch, { email: "autre@gmail.com" });
  assert.equal(meta.accountEmail, "moi@gmail.com");
});

test("même compte, adresse écrite autrement : pas de changement de compte", async () => {
  const bg = await connectedOnBrave();
  delete bg.session[TOKEN_KEY];
  bg.google.email = "Moi@Gmail.com";
  await bg.send({ type: "DRIVE_CONNECT" });
  assert.equal(bg.syncMeta().accountMismatch, null);
});

test("jeton refusé par Drive (401) : redemandé en silence, synchro réussie", async () => {
  let refused = false;
  const bg = await connectedOnBrave({
    drive: (url, init = {}) => {
      if (url.includes("/about")) return new Response(JSON.stringify({ user: { emailAddress: "moi@gmail.com" } }));
      if (url.includes("/drive/v3/files?") && !refused && init.headers.Authorization === "Bearer web-1") {
        refused = true;
        return new Response("révoqué", { status: 401 });
      }
      if (url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ files: [] }));
      return new Response(JSON.stringify({ id: "f1", version: "1" }));
    },
  });
  const res = await bg.send({ type: "SYNC_NOW" });
  assert.equal(refused, true);
  assert.equal(res.meta.lastError, null);
  assert.equal(bg.google.launches.at(-1).interactive, false, "nouveau jeton sans fenêtre");
});

test("Brave : déconnexion, jeton révoqué et méthode oubliée", async () => {
  const bg = await connectedOnBrave();
  await bg.send({ type: "DRIVE_DISCONNECT" });
  assert.ok(bg.google.driveCalls.some((c) => c.url.startsWith("https://oauth2.googleapis.com/revoke")));
  assert.equal(bg.session[TOKEN_KEY], undefined);
  const meta = bg.syncMeta();
  assert.equal(meta.enabled, false);
  assert.equal(meta.authMethod, null);
});

test("fenêtre fermée par l'utilisateur : refus affiché, sans rapport d'erreur", async () => {
  const bg = loadBackground(undefined, {
    navigator: BRAVE,
    sentryDsn: SENTRY_DSN,
    webAuth: () => { throw new Error("The user did not approve access."); },
  });
  const res = await bg.send({ type: "DRIVE_CONNECT" });
  assert.equal(res.error, "Connexion à Google refusée ou annulée.");
  await waitReports();
  assert.equal(bg.sentry.length, 0);
});

test("Brave, fenêtre bloquée : réglage à activer indiqué, erreur rapportée", async () => {
  const bg = loadBackground(undefined, {
    navigator: BRAVE,
    sentryDsn: SENTRY_DSN,
    webAuth: () => { throw new Error("Authorization page could not be loaded."); },
  });
  const res = await bg.send({ type: "DRIVE_CONNECT" });
  assert.match(res.error, /brave:\/\/settings\/extensions/);
  await waitReports();
  assert.equal(bg.sentry.length, 1);
  assert.equal(bg.sentry[0].tags.browser, "Brave 141");
  assert.equal(bg.sentry[0].extra.cause, "Error: Authorization page could not be loaded.");
});

// --- Connexion à Moxfield après une récupération sans session ---

const SESSION_COOKIE = { name: "refresh_token_ABC12", value: "rt", domain: "api2.moxfield.com" };

test("connexion sur Moxfield après « pas de session » : collection récupérée aussitôt", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV, cookies: [] });
  assert.equal((await bg.send({ type: "COLLECTION_FETCH_NOW" })).code, "not-logged-in");
  bg.setCookies([SESSION_COOKIE]);
  await bg.cookieChanged({ cookie: SESSION_COOKIE, removed: false, cause: "explicit" });
  const status = await bg.send({ type: "GET_COLLECTION_STATUS" });
  assert.equal(status.meta.lastError, null);
  assert.ok(status.meta.lastSuccessAt);
  assert.equal(quantities(await bg.state())["sol ring"], 3);
});

test("cookies posés ensemble à la connexion : une seule récupération", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV, cookies: [] });
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  bg.setCookies([SESSION_COOKIE]);
  const other = { ...SESSION_COOKIE, domain: ".moxfield.com" };
  await Promise.all([
    bg.cookieChanged({ cookie: SESSION_COOKIE, removed: false }),
    bg.cookieChanged({ cookie: other, removed: false }),
    bg.cookieChanged({ cookie: SESSION_COOKIE, removed: false }),
  ]);
  assert.equal(bg.counts.fetches, 3, "jeton, jeton d'export, CSV : une seule fois");
});

test("cookies sans rapport avec une connexion : rien n'est relancé", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV, cookies: [] });
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  bg.setCookies([SESSION_COOKIE]);
  await bg.cookieChanged({ cookie: SESSION_COOKIE, removed: true }); // déconnexion
  await bg.cookieChanged({ cookie: { name: "_ga", value: "x", domain: ".moxfield.com" }, removed: false });
  await bg.cookieChanged({ cookie: { ...SESSION_COOKIE, domain: "moxfield.com.example.org" }, removed: false });
  await bg.cookieChanged({ cookie: { ...SESSION_COOKIE, domain: "fakemoxfieldxcom" }, removed: false });
  assert.equal(bg.counts.fetches, 0);
});

test("cookie de session renouvelé sans erreur précédente : pas de récupération en plus", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  await bg.cookieChanged({ cookie: SESSION_COOKIE, removed: false });
  assert.equal(bg.counts.fetches, 0);
});
