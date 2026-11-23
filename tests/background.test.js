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
const { fakeGetMessage } = require("./helpers");

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
// options.moxfieldDeck : réponse (texte JSON) de l'API d'un deck, ou
// fonction (url) => texte JSON ou { status } (erreur HTTP).
// options.cookies : cookies de moxfield.com (session ouverte par défaut).
// options.drive : fausse API Google Drive, (url, options) => réponse.
// options.sentryDsn : DSN des rapports d'erreurs (aucun envoi sinon) ; les
// rapports reçus par le faux Sentry sont dans sentry (événements).
// options.authError : erreur levée par chrome.identity.getAuthToken
// (ex. Brave, qui ne l'implémente pas).
// options.navigator : navigateur (Google Chrome par défaut ; cf. BRAVE).
// options.webAuth : fausse fenêtre de connexion Google, (details) => URL de
// redirection ; par défaut un jeton pour le compte google.email.
// options.lang : langue du navigateur (français par défaut).
// options.gitFiles : fichiers du dossier .git de l'extension ({ chemin:
// contenu }, aucun par défaut : pas un clone) ; options.github : fausse API
// GitHub, (url) => réponse (cf. update-check.js).
// Sans options.drive, un Drive vide (aucun fichier) accepte tous les envois.
function loadBackground(initialState, options = {}) {
  const storage = {};
  if (initialState) storage[STORAGE_KEY] = initialState;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  let onMessage = null;
  const alarmListeners = [];
  const startupListeners = [];
  const installedListeners = [];
  const alarms = new Map(); // nom → options
  const webRequestListeners = [];
  const cookieListeners = [];
  const counts = { stateWrites: 0, fetches: 0, onboardingWrites: 0 };
  const badge = { text: "", title: "" };
  const github = { calls: [] };
  const sentry = [];
  const tabsCreated = [];
  const tabMessages = [];
  const moxfieldCalls = [];
  const session = {};
  // Compte Google du profil Chrome et de la fenêtre de connexion ;
  // modifiable en cours de test (changement de compte).
  const google = { email: "moi@gmail.com", profileId: "118294207213255860701", launches: [], driveCalls: [] };
  const listener = (list = []) => ({ addListener: (fn) => list.push(fn) });
  const chrome = {
    i18n: { getMessage: fakeGetMessage(options.lang || "fr") },
    storage: {
      local: {
        async get(key) {
          return key in storage ? { [key]: clone(storage[key]) } : {};
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) {
            if (k === STORAGE_KEY) counts.stateWrites++;
            if (k === "moxfieldStockManagerOnboarding") counts.onboardingWrites++;
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
      onInstalled: listener(installedListeners),
      getManifest: () => ({ version: "0.2.0" }),
      getPlatformInfo: async () => ({ os: "win" }),
      getURL: (p) => `chrome-extension://test/${p}`,
    },
    // Onglets ouverts par l'extension (page d'impression des proxies).
    tabs: {
      create: async (info) => tabsCreated.push(clone(info)),
      // Messages envoyés à un onglet (avancement de « Utiliser mes éditions »).
      sendMessage: async (tabId, msg) => tabMessages.push({ tabId, ...clone(msg) }),
    },
    action: {
      setBadgeText: ({ text }) => (badge.text = text),
      setBadgeBackgroundColor: () => {},
      setTitle: ({ title }) => (badge.title = title),
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
    if (url.startsWith("chrome-extension://test/")) {
      const file = (options.gitFiles || {})[url.slice("chrome-extension://test/".length)];
      if (file === undefined) throw new TypeError("Failed to fetch"); // comme Chrome pour un fichier absent
      return new Response(file);
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      return new Response(JSON.stringify({ version: options.githubVersion || "9.9.9" }));
    }
    if (url.startsWith("https://api.github.com/")) {
      github.calls.push(url);
      if (!options.github) throw new Error(`appel GitHub inattendu : ${url}`);
      return options.github(url);
    }
    if (url.includes("googleapis.com")) return (options.drive || defaultDrive)(url, init);
    if (url.includes("sentry.io")) {
      sentry.push(JSON.parse(init.body.split("\n")[2]));
      return { ok: true };
    }
    counts.fetches++;
    if (options.moxfieldCSV === undefined) throw new Error(`appel réseau inattendu : ${url}`);
    // Éditions d'une carte et changement d'édition dans un deck (cf.
    // options.moxfieldEditions, options.moxfieldEdit).
    if (url.includes("/cards/editions/") || url.includes("/v2/decks/")) {
      moxfieldCalls.push({ url, method: (init && init.method) || "GET", headers: clone((init && init.headers) || {}), body: init && init.body ? JSON.parse(init.body) : null });
      const answer = await (url.includes("/v2/decks/") ? options.moxfieldEdit(url, init) : options.moxfieldEditions(url));
      if (answer instanceof Error) throw answer;
      return {
        ok: answer.status === undefined || answer.status < 400,
        status: answer.status || 200,
        json: async () => clone(answer.body),
        text: async () => JSON.stringify(answer.body),
      };
    }
    if (url.includes("/decks/all/")) moxfieldCalls.push({ url, method: "GET" });
    if (options.moxfieldCSV instanceof Error) throw options.moxfieldCSV;
    const deckAnswer = url.includes("/decks/all/") && typeof options.moxfieldDeck === "function" ? options.moxfieldDeck(url) : options.moxfieldDeck;
    if (url.includes("/decks/all/") && deckAnswer && typeof deckAnswer === "object") {
      return { ok: false, status: deckAnswer.status, json: async () => ({}), text: async () => "" };
    }
    const body = url.includes("/token/")
      ? JSON.stringify({ access_token: "jeton" })
      : url.includes("/decks/all/")
        ? deckAnswer
        : options.moxfieldCSV;
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
  // Délais avant de réessayer une requête Drive : sans attente dans les tests.
  const retryLine = /const DRIVE_RETRY_DELAYS_MS = \[[^\]]*\];/;
  if (!retryLine.test(source)) throw new Error("DRIVE_RETRY_DELAYS_MS introuvable dans background.js");
  vm.runInContext(
    source
      .replace(dsnLine, `const SENTRY_DSN = "${options.sentryDsn || ""}";`)
      .replace(retryLine, "const DRIVE_RETRY_DELAYS_MS = [0, 0];"),
    context
  );

  // Comme Chrome, message et réponse sont sérialisés (ce qui ramène aussi
  // les objets du contexte isolé dans celui des tests, pour deepEqual).
  // sender : expéditeur du message (ex. { tab: { id } } pour une page).
  function send(msg, sender = {}) {
    return new Promise((resolve) => onMessage(clone(msg), sender, (res) => resolve(clone(res))));
  }
  return {
    send,
    badge,
    github,
    async state() {
      return (await send({ type: "GET_STATE" })).state;
    },
    raw: () => storage[STORAGE_KEY],
    // Fonctions internes (synchro Drive, sans appel réseau).
    context,
    counts,
    sentry,
    tabsCreated,
    tabMessages,
    moxfieldCalls,
    google,
    session,
    syncMeta: () => clone(storage[SYNC_KEY]),
    setSyncMeta: (meta) => (storage[SYNC_KEY] = clone(meta)),
    alarms,
    setCollectionMeta: (meta) => (storage[COLLECTION_KEY] = clone(meta)),
    // Enregistrement laissé par une version précédente de l'extension.
    setOnboarding: (record) => (storage.moxfieldStockManagerOnboarding = clone(record)),
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
    // Extension rechargée (ex. après un git pull), ou installée (reason
    // "install").
    async installed(reason = "update") {
      await Promise.all(installedListeners.map((fn) => fn({ reason })));
      await new Promise((resolve) => setTimeout(resolve, 20));
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
  assert.deepEqual(res, { ok: true, stock: {}, builtDecks: {}, followed: false });
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

// Drive connecté, puis réponses imposées par failure(url, init) : une
// Response, ou undefined pour le comportement normal (Drive vide).
async function driveFailing(failure) {
  const calls = [];
  let failing = false;
  const bg = await connectedOnBrave({
    sentryDsn: SENTRY_DSN,
    drive: (url, init = {}) => {
      if (url.includes("/about")) return new Response(JSON.stringify({ user: { emailAddress: "moi@gmail.com" } }));
      if (failing) {
        calls.push({ url, method: init.method || "GET" });
        const res = failure(url, init, calls.length);
        if (res) return res;
      }
      if (url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ files: [] }));
      return new Response(JSON.stringify({ id: "f1", version: "1" }));
    },
  });
  failing = true;
  return { bg, calls };
}

const TRANSIENT_503 = () =>
  new Response(JSON.stringify({ error: { code: 503, message: "Transient failure." } }), { status: 503 });

test("Drive répond 503 une fois (cf. Sentry JAVASCRIPT-2) : réessayé, synchro réussie sans rapport", async () => {
  const { bg, calls } = await driveFailing((url, init, n) => (n === 1 ? TRANSIENT_503() : undefined));
  const res = await bg.send({ type: "SYNC_NOW" });
  assert.equal(res.meta.lastError, null);
  assert.ok(calls[0].url === calls[1].url, "même requête réessayée");
  await waitReports();
  assert.equal(bg.sentry.length, 0);
});

test("Drive indisponible plus longtemps : erreur expliquée, sans rapport", async () => {
  const { bg, calls } = await driveFailing((url) => (url.includes("/drive/v3/files?") ? TRANSIENT_503() : undefined));
  const res = await bg.send({ type: "SYNC_NOW" });
  assert.equal(res.meta.lastError, "Google Drive est momentanément indisponible (503) : réessaie dans quelques minutes.");
  assert.equal(calls.length, 3, "deux nouveaux essais, pas plus");
  await waitReports();
  assert.equal(bg.sentry.length, 0);
});

test("Drive : création de fichier jamais réessayée (elle a pu aboutir malgré le 503)", async () => {
  const { bg, calls } = await driveFailing((url, init) => (init.method === "POST" ? TRANSIENT_503() : undefined));
  const res = await bg.send({ type: "SYNC_NOW" });
  assert.match(res.meta.lastError, /momentanément indisponible/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("Drive injoignable (réseau coupé) : erreur expliquée, sans rapport", async () => {
  const { bg } = await driveFailing(() => {
    throw new TypeError("Failed to fetch");
  });
  const res = await bg.send({ type: "SYNC_NOW" });
  assert.equal(res.meta.lastError, "Google Drive injoignable : vérifie ta connexion.");
  await waitReports();
  assert.equal(bg.sentry.length, 0);
});

test("Drive refuse la requête (403) : erreur rapportée", async () => {
  const { bg } = await driveFailing(() => new Response("interdit", { status: 403 }));
  const res = await bg.send({ type: "SYNC_NOW" });
  assert.match(res.meta.lastError, /^Google Drive a répondu 403/);
  await waitReports();
  assert.equal(bg.sentry.length, 1);
  assert.equal(bg.sentry[0].tags.where, "drive-sync");
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

// --- Langue du navigateur ---

test("navigateur en anglais : erreurs et historique en anglais", async () => {
  const bg = loadBackground(SOL_RING_STOCK(), { lang: "en" });
  const empty = await bg.send({ type: "IMPORT_CSV_TEXT", csvText: CSV_HEADER });
  assert.equal(empty.error, "Empty or invalid CSV");
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  assert.deepEqual((await historyOf(bg)).map((e) => e.title), ["Deck “Deck a” built: 1 card taken out of the free stock"]);
});

// L'historique est synchronisé entre des PC qui n'ont pas forcément la même
// langue : les entrées gardent des données, le libellé est calculé à
// l'affichage.
test("historique noté en français, affiché en anglais", async () => {
  const fr = loadBackground(SOL_RING_STOCK());
  await build(fr, "a", [{ name: "Sol Ring", qty: 1 }]);
  assert.match((await historyOf(fr))[0].title, /^Deck « Deck a » monté/);
  const en = loadBackground(fr.raw(), { lang: "en" });
  assert.equal((await historyOf(en))[0].title, "Deck “Deck a” built: 1 card taken out of the free stock");
});

// --- Détail par édition et versions des decks montés ---

const TWO_EDITIONS_CSV = csv(
  "1,0,Steam Vents,grn,Near Mint,English,,,2024-01-01,257,False,False,",
  "1,0,Steam Vents,rna,Near Mint,French,foil,,2024-01-01,257,False,False,",
  "1,0,Sol Ring,c21,Near Mint,English,,,2024-01-01,263,False,False,",
  "2,0,Sol Ring,c21,Near Mint,French,foil,,2024-01-01,263,False,False,"
);
const STEAM_VENTS_PRINTINGS = [{ set: "grn", cn: "257", qty: 1 }, { set: "rna", cn: "257", qty: 1 }];

// La sauvegarde téléchargée montre l'édition de chaque carte, même
// possédée dans une seule.
test("import CSV : détail par édition gardé pour toutes les cartes", async () => {
  const bg = loadBackground();
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: TWO_EDITIONS_CSV });
  const { stock } = await bg.state();
  assert.deepEqual(stock["steam vents"], { name: "Steam Vents", qty: 2, printings: STEAM_VENTS_PRINTINGS });
  // Même édition en deux langues et deux finitions : une seule édition.
  assert.deepEqual(stock["sol ring"], { name: "Sol Ring", qty: 3, printings: [{ set: "c21", cn: "263", qty: 3 }] });
});

test("import CSV : carte sans édition dans la collection, pas de détail", async () => {
  const bg = loadBackground();
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: "Name,Count\nSol Ring,2" });
  assert.deepEqual((await bg.state()).stock["sol ring"], { name: "Sol Ring", qty: 2 });
});

test("détail par édition : possédé, donc inchangé par un montage, et transmis à la page du deck", async () => {
  const bg = loadBackground();
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: TWO_EDITIONS_CSV });
  await build(bg, "a", [{ name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] }]);
  const res = await bg.send({ type: "GET_DECK_CONTEXT", payload: { deckId: "b", names: ["Steam Vents"] } });
  assert.deepEqual(res.stock, { "steam vents": { name: "Steam Vents", qty: 1, printings: STEAM_VENTS_PRINTINGS } });
  assert.deepEqual(res.builtDecks.a.cards, [{ name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] }]);
});

test("récupération : détail par édition enregistré même si les quantités n'ont pas changé, une seule fois", async () => {
  // Stock d'avant le suivi des éditions : mêmes quantités, pas de détail.
  const before = { stock: { "steam vents": { name: "Steam Vents", qty: 2 }, "sol ring": { name: "Sol Ring", qty: 3 } }, builtDecks: {} };
  const bg = loadBackground(before, { moxfieldCSV: TWO_EDITIONS_CSV });
  const res = await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.deepEqual(res, { ok: true, changes: [] });
  assert.deepEqual((await bg.state()).stock["steam vents"].printings, STEAM_VENTS_PRINTINGS);
  assert.deepEqual((await bg.state()).stock["sol ring"].printings, [{ set: "c21", cn: "263", qty: 3 }], "aussi une carte en une seule édition");
  assert.deepEqual(await historyOf(bg), [], "aucune quantité n'a changé : rien dans l'historique");

  const writes = bg.counts.stateWrites;
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.equal(bg.counts.stateWrites, writes, "rien de nouveau : aucune écriture");

  // Une édition échangée contre une autre, quantités identiques.
  bg.setMoxfieldCSV(TWO_EDITIONS_CSV.replace("Steam Vents,rna", "Steam Vents,gpt"));
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.deepEqual((await bg.state()).stock["steam vents"].printings.map((p) => p.set), ["gpt", "grn"]);
});

test("versions d'un deck monté : complétées quand elles manquent, jamais remplacées", async () => {
  const bg = loadBackground();
  await build(bg, "a", [
    { name: "Steam Vents", qty: 1 },
    { name: "Sol Ring", qty: 1, versions: [{ code: "SSSSS", qty: 1 }] },
    { name: "Swamp", qty: 2 },
  ]);
  const versions = {
    "steam vents": [{ code: "AAAAA", qty: 1 }],
    "sol ring": [{ code: "TTTTT", qty: 1 }],
    swamp: [{ code: "SWAMP1", qty: 3 }], // plus d'exemplaires que dans le montage : écarté
  };
  const historyBefore = (await historyOf(bg)).length;
  assert.deepEqual(await bg.send({ type: "SET_DECK_VERSIONS", payload: { deckId: "a", versions } }), { ok: true });
  assert.deepEqual((await bg.state()).builtDecks.a.cards, [
    { name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] },
    { name: "Sol Ring", qty: 1, versions: [{ code: "SSSSS", qty: 1 }] },
    { name: "Swamp", qty: 2 },
  ]);
  assert.equal((await historyOf(bg)).length, historyBefore, "ni le stock ni la liste ne changent");

  const writes = bg.counts.stateWrites;
  assert.deepEqual(await bg.send({ type: "SET_DECK_VERSIONS", payload: { deckId: "a", versions } }), { ok: true, unchanged: true });
  assert.deepEqual(await bg.send({ type: "SET_DECK_VERSIONS", payload: { deckId: "zzz", versions } }), { ok: true, ignored: true });
  assert.equal(bg.counts.stateWrites, writes);
});

test("historique : mise à jour d'un deck dont seule une version a changé", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  await build(bg, "a", [{ name: "Sol Ring", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] }]);
  await bg.send({
    type: "UPDATE_BUILT_DECK",
    payload: { deckId: "a", deckName: "Deck a", url: "", cards: [{ name: "Sol Ring", qty: 1, versions: [{ code: "BBBBB", qty: 1 }] }] },
  });
  const [entry] = await historyOf(bg);
  assert.equal(entry.title, "Montage de « Deck a » mis à jour : 1 carte modifiée");
  assert.deepEqual(entry.changes, [{ name: "Sol Ring", from: 1, to: 1, version: true }]);
  const state = await bg.state();
  assert.equal(state.stock["sol ring"].qty, 1, "le stock ne bouge pas");
  assert.deepEqual(state.builtDecks.a.cards[0].versions, [{ code: "BBBBB", qty: 1 }]);
});

// --- Éditions des cartes d'un deck (API du deck) ---

const API_DECK = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "api", "deck.json"), "utf8"));

test("éditions d'un deck : lues par l'API pour la page du deck, sans toucher à l'état", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV, moxfieldDeck: JSON.stringify(API_DECK) });
  const res = await bg.send({ type: "GET_DECK_PRINTINGS", payload: { deckId: "abc123" } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.printings.ZOwRD, { set: "rav", cn: "87", eur: 0.15 });
  assert.deepEqual(res.printings.SWAMP2, { set: "pwar", cn: "war-115", eur: 0.8 });
  assert.equal(bg.counts.stateWrites, 0);

  const fetches = bg.counts.fetches;
  assert.equal((await bg.send({ type: "GET_DECK_PRINTINGS", payload: { deckId: "../account" } })).ok, false);
  assert.equal((await bg.send({ type: "GET_DECK_PRINTINGS" })).ok, false);
  assert.equal(bg.counts.fetches, fetches, "identifiant invalide : aucun appel");
});

test("éditions d'un deck : seules les erreurs anormales sont rapportées", async () => {
  const ask = (bg) => bg.send({ type: "GET_DECK_PRINTINGS", payload: { deckId: "abc123" } });
  const loggedOut = loadBackground(undefined, { sentryDsn: SENTRY_DSN, moxfieldCSV: "", cookies: [] });
  assert.equal((await ask(loggedOut)).code, "not-logged-in");
  const offline = loadBackground(undefined, { sentryDsn: SENTRY_DSN, moxfieldCSV: new TypeError("Failed to fetch") });
  assert.equal((await ask(offline)).code, "network");
  await waitReports();
  assert.equal(loggedOut.sentry.length + offline.sentry.length, 0, "situations normales");

  const changed = loadBackground(undefined, { sentryDsn: SENTRY_DSN, moxfieldCSV: "", moxfieldDeck: '{"cards":[]}' });
  const res = await ask(changed);
  assert.equal(res.ok, false);
  assert.equal(res.code, "api-changed");
  await waitReports();
  assert.equal(changed.sentry.length, 1);
  assert.equal(changed.sentry[0].tags.where, "moxfield-deck");
  assert.deepEqual(changed.sentry[0].extra, { code: "api-changed" });
});

test("versions d'un deck monté : édition ajoutée à une version déjà enregistrée, jamais retirée ni déplacée", async () => {
  const bg = loadBackground();
  await build(bg, "a", [
    { name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] },
    { name: "Sol Ring", qty: 1, versions: [{ code: "SSSSS", qty: 1 }] },
    { name: "Counterspell", qty: 1 },
    { name: "Island", qty: 2, versions: [{ code: "ISLE1", qty: 1 }, { code: "ISLE2", qty: 1 }] },
  ]);
  const versions = {
    island: [{ code: "ISLE1", qty: 2, set: "war", cn: "253" }], // même quantité, autre répartition

    "steam vents": [{ code: "AAAAA", qty: 1, set: "grn", cn: "257" }],
    "sol ring": [{ code: "TTTTT", qty: 1, set: "c21", cn: "263" }], // autre version : passe par la mise à jour du montage
    counterspell: [{ code: "CCCCC", qty: 1, set: "mh2", cn: 267 }],
  };
  assert.deepEqual(await bg.send({ type: "SET_DECK_VERSIONS", payload: { deckId: "a", versions } }), { ok: true });
  const expected = [
    { name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1, set: "grn", cn: "257" }] },
    { name: "Sol Ring", qty: 1, versions: [{ code: "SSSSS", qty: 1 }] },
    { name: "Counterspell", qty: 1, versions: [{ code: "CCCCC", qty: 1, set: "mh2", cn: "" }] },
    { name: "Island", qty: 2, versions: [{ code: "ISLE1", qty: 1 }, { code: "ISLE2", qty: 1 }] },
  ];
  assert.deepEqual((await bg.state()).builtDecks.a.cards, expected);

  // Page qui n'a pas (encore) lu les éditions, ou même constat renvoyé.
  const writes = bg.counts.stateWrites;
  const without = { "steam vents": [{ code: "AAAAA", qty: 1 }] };
  assert.deepEqual(await bg.send({ type: "SET_DECK_VERSIONS", payload: { deckId: "a", versions: without } }), { ok: true, unchanged: true });
  assert.deepEqual(await bg.send({ type: "SET_DECK_VERSIONS", payload: { deckId: "a", versions } }), { ok: true, unchanged: true });
  assert.equal(bg.counts.stateWrites, writes);
  assert.deepEqual((await bg.state()).builtDecks.a.cards, expected);
});

// --- Proxies ---

const update = (bg, deckId, cards) =>
  bg.send({ type: "UPDATE_BUILT_DECK", payload: { deckId, deckName: `Deck ${deckId}`, url: `https://moxfield.com/decks/${deckId}`, cards } });

test("proxies : jamais pris au stock au montage, ni rendus au démontage", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 1 } }, builtDecks: {} });
  // 3 Sol Ring demandés, 1 en stock : 2 proxies ; Counterspell entièrement en proxy.
  const cards = [
    { name: "Sol Ring", qty: 3, proxyQty: 2, proxyPrinting: { set: "c21", cn: "263" } },
    { name: "Counterspell", qty: 1, proxyQty: 1 },
  ];
  assert.deepEqual(await build(bg, "a", cards), { ok: true });
  let state = await bg.state();
  assert.deepEqual(quantities(state), { "sol ring": 0 }, "Counterspell n'entre pas dans le stock");
  assert.deepEqual(state.builtDecks.a.cards, cards);
  await unbuild(bg, "a");
  state = await bg.state();
  assert.deepEqual(quantities(state), { "sol ring": 1 });
  const [unbuilt, built] = await historyOf(bg);
  assert.equal(built.title, "Deck « Deck a » monté : 1 carte retirée du stock libre (+ 3 proxies)");
  assert.equal(unbuilt.title, "Deck « Deck a » démonté : 1 carte rendue au stock (+ 3 proxies)");
});

test("proxies : valeurs reçues invalides retirées plutôt qu'enregistrées", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 5 } }, builtDecks: {} });
  await build(bg, "a", [
    { name: "Sol Ring", qty: 1, proxyQty: 2 }, // plus que la quantité
    { name: "Counterspell", qty: 1, proxyQty: "1", proxyPrinting: { set: "c21", cn: "1" } },
    { name: "Arcane Signet", qty: 2, proxyQty: 1, proxyPrinting: { set: "x".repeat(50), cn: 7 } },
    { name: "Swords to Plowshares", qty: 1, proxyQty: 1, proxyPrinting: { set: "" } },
  ]);
  assert.deepEqual((await bg.state()).builtDecks.a.cards, [
    { name: "Sol Ring", qty: 1 },
    { name: "Counterspell", qty: 1 },
    { name: "Arcane Signet", qty: 2, proxyQty: 1, proxyPrinting: { set: "x".repeat(20), cn: "" } },
    { name: "Swords to Plowshares", qty: 1, proxyQty: 1 },
  ]);
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 4, counterspell: -1, "arcane signet": -1 });
});

test("proxies : mise à jour avec de nouveaux proxies, notée dans l'historique", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 1 } }, builtDecks: {} });
  await build(bg, "a", [{ name: "Sol Ring", qty: 2, proxyQty: 1 }]);
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 0 });
  // Un 3e Sol Ring, lui aussi en proxy : le stock ne bouge pas.
  await update(bg, "a", [{ name: "Sol Ring", qty: 3, proxyQty: 2 }]);
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 0 });
  const [entry] = await historyOf(bg);
  assert.equal(entry.title, "Montage de « Deck a » mis à jour : 1 carte modifiée (+ 1 nouveau proxy)");
});

test("proxies : collection récupérée, les proxies ne comptent ni dans le stock ni dans les cartes non couvertes", async () => {
  const bg = loadBackground({ stock: {}, builtDecks: {} }, { moxfieldCSV: COLLECTION_CSV });
  await build(bg, "a", [{ name: "Sol Ring", qty: 2, proxyQty: 2 }, { name: "Rhystic Study", qty: 2, proxyQty: 1 }]);
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  // 3 Sol Ring possédés, tous libres ; 1 Rhystic Study possédé, pris par le deck.
  assert.deepEqual(quantities(await bg.state()), { "sol ring": 3, "rhystic study": 0, island: 10 });
  assert.deepEqual((await collectionStatus(bg)).uncovered, []);
});

test("proxies : remplacés par la vraie carte quand elle arrive en stock libre", async () => {
  const bg = loadBackground({ stock: {}, builtDecks: {} });
  await build(bg, "a", [
    { name: "Sol Ring", qty: 3, proxyQty: 3, proxyPrinting: { set: "c21", cn: "263" } },
    { name: "Counterspell", qty: 1, proxyQty: 1 },
  ]);
  const nothing = await bg.send({ type: "REPLACE_PROXIES", payload: { deckId: "a" } });
  assert.equal(nothing.ok, false);
  assert.match(nothing.error, /Aucun proxy à remplacer/);
  // 2 Sol Ring achetés et ajoutés à la collection.
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: csv("2,0,Sol Ring,,,,,,,,,,") });
  const res = await bg.send({ type: "REPLACE_PROXIES", payload: { deckId: "a" } });
  assert.deepEqual(res, { ok: true, replaced: [{ name: "Sol Ring", qty: 2 }] });
  const state = await bg.state();
  assert.deepEqual(state.builtDecks.a.cards, [
    { name: "Sol Ring", qty: 3, proxyQty: 1, proxyPrinting: { set: "c21", cn: "263" } },
    { name: "Counterspell", qty: 1, proxyQty: 1 },
  ]);
  assert.deepEqual(quantities(state), { "sol ring": 0 });
  const [entry] = await historyOf(bg);
  assert.equal(entry.title, "Deck « Deck a » : 2 proxies remplacés par la vraie carte, retirée du stock libre");
  // Le dernier proxy de la carte remplacé : plus aucune trace du proxy.
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: csv("3,0,Sol Ring,,,,,,,,,,") });
  await bg.send({ type: "REPLACE_PROXIES", payload: { deckId: "a" } });
  assert.deepEqual((await bg.state()).builtDecks.a.cards[0], { name: "Sol Ring", qty: 3 });
  // Refus expliqués : pas de rapport d'erreur.
  assert.equal((await bg.send({ type: "REPLACE_PROXIES", payload: { deckId: "inconnu" } })).ok, false);
  assert.deepEqual(bg.sentry, []);
});

test("proxies : page d'impression, avec seulement les proxies du deck demandé", async () => {
  const bg = loadBackground({ stock: { "sol ring": { name: "Sol Ring", qty: 1 } }, builtDecks: {} });
  await build(bg, "a", [
    { name: "Sol Ring", qty: 2, proxyQty: 1, proxyPrinting: { set: "c21", cn: "263" } },
    { name: "Counterspell", qty: 1, proxyQty: 1 },
    { name: "Island", qty: 5 },
  ]);
  assert.deepEqual(await bg.send({ type: "GET_DECK_PROXIES", payload: { deckId: "a" } }), {
    ok: true,
    deck: {
      name: "Deck a",
      url: "https://moxfield.com/decks/a",
      cards: [
        { name: "Sol Ring", qty: 1, set: "c21", cn: "263" },
        { name: "Counterspell", qty: 1 },
      ],
    },
  });
  assert.deepEqual(await bg.send({ type: "GET_DECK_PROXIES", payload: { deckId: "b" } }), { ok: true, deck: null });
  assert.deepEqual(await bg.send({ type: "OPEN_PROXIES_PAGE", payload: { deckId: "a/b" } }), { ok: true });
  assert.deepEqual(bg.tabsCreated, [{ url: "chrome-extension://test/proxies.html?deck=a%2Fb" }]);
  assert.equal((await bg.send({ type: "OPEN_PROXIES_PAGE", payload: {} })).ok, false);
});

test("proxies : un deck dont la carte est en proxy n'est pas cité parmi ceux qui la tiennent", async () => {
  // Rhystic Study absente de la collection : le deck a la tient (stock
  // négatif), le deck b ne l'a qu'en proxy.
  const bg = loadBackground({ stock: {}, builtDecks: {} }, { moxfieldCSV: csv("1,0,Sol Ring,,,,,,,,,,") });
  await build(bg, "a", [{ name: "Rhystic Study", qty: 1 }]);
  await build(bg, "b", [{ name: "Rhystic Study", qty: 1, proxyQty: 1 }]);
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.deepEqual((await collectionStatus(bg)).uncovered, [{ name: "Rhystic Study", missing: 1, decks: ["Deck a"] }]);
});

// --- Passer un deck Moxfield sur les éditions de la collection ---

const CARD_EDITIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "api", "card-editions.json"), "utf8"));

// Faux Moxfield qui tient un deck modifiable : chaque changement
// d'édition exige la dernière version du deck, et l'incrémente.
const BIRDS_EDITIONS = [
  { cardId: "bIrDs", uniqueCardId: "u0005", abbreviation: "plst", cn: "52★", name: "The List", hasNonFoil: true, hasFoil: false, hasEtched: true },
];

function editableDeck() {
  const deck = JSON.parse(JSON.stringify(API_DECK));
  const options = {
    sentryDsn: SENTRY_DSN,
    // Golgari Thug possédée en DDS (le deck demande RAV) ; Sidisi en KTK
    // (le deck demande la promo) ; Birds of Paradise dans l'édition du deck.
    moxfieldCSV: csv("1,0,Golgari Thug,dds,,,,,,50,,,", "1,0,Sidisi; Brood Tyrant,ktk,,,,,,199,,,", "1,0,Birds of Paradise,plst,,,,,,52★,,,").replace(
      "Sidisi; Brood Tyrant",
      '"Sidisi, Brood Tyrant"'
    ),
    moxfieldDeck: JSON.stringify(deck),
    // Éditions connues de Moxfield : celles de Golgari Thug et de Birds of
    // Paradise (en etched dans le deck, possédée en non-foil).
    moxfieldEditions: (url) => ({ body: url.endsWith("/u0001") ? CARD_EDITIONS : url.endsWith("/u0005") ? BIRDS_EDITIONS : [] }),
    // Comme Moxfield (confirmé en vrai, novembre 2026) : la fin de l'URL est
    // l'impression actuelle de la carte (card.id), pas son uniqueCardId ;
    // un autre identifiant y est lu comme l'impression d'une autre carte, et
    // la nouvelle impression est alors refusée (400).
    moxfieldEdit: (url, init) => {
      if (init.headers["x-deck-version"] !== String(deck.version)) return { status: 409, body: {} };
      const currentId = url.split("/").pop();
      const board = url.split("/").slice(-2)[0];
      const entry = Object.values(deck.boards[board].cards).find((e) => e.card.id === currentId);
      const id = JSON.parse(init.body).printingData[0].id;
      if (!entry) return { status: 400, body: { "printingData[0].Id": ['Specified printing ID is not a printing of "Mad Auntie".'] } };
      const edition = [...CARD_EDITIONS, ...BIRDS_EDITIONS].find((e) => e.cardId === id) || { abbreviation: "ktk", cn: "199" };
      entry.card = { ...entry.card, id, set: edition.abbreviation, cn: edition.cn };
      entry.finish = JSON.parse(init.body).finish;
      deck.version++;
      options.moxfieldDeck = JSON.stringify(deck);
      return { body: { card: entry.card } };
    },
  };
  return { deck, options };
}

const GOLGARI_TO_DDS = {
  name: "Golgari Thug",
  board: "mainboard",
  uniqueCardId: "u0001",
  from: { set: "rav", cn: "87" },
  to: { set: "dds", cn: "50", setName: "Duel Decks: Mind vs. Might", cardId: "GtDds", finishes: ["nonFoil"] },
};

// Même édition, seule la finition change (cas constaté en vrai : possédée
// dans une autre finition que celle du deck).
const BIRDS_TO_NONFOIL = {
  name: "Birds of Paradise",
  board: "commanders",
  uniqueCardId: "u0005",
  from: { set: "plst", cn: "52★" },
  to: { set: "plst", cn: "52★", setName: "The List", cardId: "bIrDs", finishes: ["nonFoil", "etched"], finish: "nonFoil" },
};

test("éditions de la collection : finition seule changée, édition gardée", async () => {
  const { deck, options } = editableDeck();
  const bg = loadBackground(undefined, options);
  const res = await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [BIRDS_TO_NONFOIL] } });
  assert.deepEqual(res, { ok: true, done: ["Birds of Paradise"], skipped: [] });
  const [write] = bg.moxfieldCalls.filter((c) => c.method === "PUT");
  assert.equal(write.url, "https://api2.moxfield.com/v2/decks/0000000/cards/commanders/bIrDs");
  assert.equal(write.body.finish, "nonFoil");
  assert.deepEqual(write.body.printingData.map((p) => [p.id, p.finish]), [["bIrDs", "nonFoil"]]);
  assert.equal(deck.version, 7);
});

test("éditions de la collection : édition déjà dans un autre deck monté, carte laissée avec la raison", async () => {
  const { options } = editableDeck();
  // La seule Golgari Thug DDS possédée est dans un deck monté.
  const state = {
    stock: { "golgari thug": { name: "Golgari Thug", qty: 0 } },
    builtDecks: {
      autre: { name: "Autre", url: "", builtAt: 1, cards: [{ name: "Golgari Thug", qty: 1, versions: [{ code: "GtDds", qty: 1, set: "dds", cn: "50" }] }] },
    },
  };
  const bg = loadBackground(state, options);
  const res = await bg.send({ type: "PLAN_OWNED_EDITIONS", payload: { deckId: "abc123", names: ["Golgari Thug"] } });
  assert.deepEqual(res, { ok: true, plan: [], skipped: [{ name: "Golgari Thug", reason: "taken" }] });
});

test("éditions de la collection : pas assez d'exemplaires dans une même édition, carte laissée", async () => {
  const { deck, options } = editableDeck();
  // 2 Golgari Thug dans le deck, une seule DDS possédée.
  Object.values(deck.boards.mainboard.cards).find((e) => e.card.uniqueCardId === "u0001").quantity = 2;
  options.moxfieldDeck = JSON.stringify(deck);
  const bg = loadBackground(undefined, options);
  const res = await bg.send({ type: "PLAN_OWNED_EDITIONS", payload: { deckId: "abc123", names: ["Golgari Thug"] } });
  assert.deepEqual(res, { ok: true, plan: [], skipped: [{ name: "Golgari Thug", reason: "not-enough" }] });
});

test("éditions de la collection : finition possédée inconnue de Moxfield pour cette édition, carte laissée", async () => {
  const { options } = editableDeck();
  // Birds possédée en foil : The List n'existe pas en foil chez Moxfield.
  options.moxfieldCSV = csv("1,0,Birds of Paradise,plst,,,foil,,,52★,,,");
  const bg = loadBackground(undefined, options);
  const res = await bg.send({ type: "PLAN_OWNED_EDITIONS", payload: { deckId: "abc123", names: ["Birds of Paradise"] } });
  assert.deepEqual(res, { ok: true, plan: [], skipped: [{ name: "Birds of Paradise", reason: "edition-unknown" }] });
});

test("éditions de la collection : finitions de la collection jamais enregistrées dans le stock", async () => {
  const bg = loadBackground();
  await bg.send({ type: "IMPORT_CSV_TEXT", csvText: csv("1,0,Sol Ring,c21,,,foil,,,263,,,", "1,0,Sol Ring,cmr,,,,,,472,,,") });
  const { stock } = await bg.state();
  assert.deepEqual(stock["sol ring"].printings, [
    { set: "c21", cn: "263", qty: 1 },
    { set: "cmr", cn: "472", qty: 1 },
  ]);
});

test("éditions de la collection : proposition, sans rien écrire", async () => {
  const { options } = editableDeck();
  const bg = loadBackground(undefined, options);
  const names = ["Golgari Thug", "Sidisi, Brood Tyrant", "Birds of Paradise", "Swamp", "Carte Inconnue", "Revitalizing Repast"];
  const res = await bg.send({ type: "PLAN_OWNED_EDITIONS", payload: { deckId: "abc123", names } });
  assert.deepEqual(res, {
    ok: true,
    plan: [GOLGARI_TO_DDS, BIRDS_TO_NONFOIL],
    skipped: [
      { name: "Sidisi, Brood Tyrant", reason: "edition-unknown" },
      { name: "Swamp", reason: "several" },
      { name: "Carte Inconnue", reason: "not-in-deck" },
      { name: "Revitalizing Repast // Old-Growth Grove", reason: "no-other-edition" },
    ],
  });
  assert.deepEqual(bg.moxfieldCalls.filter((c) => c.method !== "GET"), [], "aucune écriture");
  assert.equal(bg.counts.stateWrites, 0);
});

test("éditions de la collection : application carte par carte, deck lu une seule fois", async () => {
  const { deck, options } = editableDeck();
  const bg = loadBackground(undefined, options);
  const sidisi = {
    name: "Sidisi, Brood Tyrant",
    board: "mainboard",
    uniqueCardId: "u0002",
    from: { set: "pktk", cn: "199p" },
    to: { set: "ktk", cn: "199", setName: "Khans of Tarkir", cardId: "SdKtk", finishes: ["nonFoil", "foil"] },
  };
  // Carte modifiée entre-temps sur Moxfield : plus dans l'édition proposée.
  const stale = { ...GOLGARI_TO_DDS, name: "Revitalizing Repast // Old-Growth Grove", uniqueCardId: "u0003", from: { set: "mh3", cn: "1" } };
  const res = await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [GOLGARI_TO_DDS, sidisi, stale] } });
  assert.deepEqual(res, { ok: true, done: ["Golgari Thug", "Sidisi, Brood Tyrant"], skipped: [{ name: stale.name, reason: "changed" }] });
  const writes = bg.moxfieldCalls.filter((c) => c.method === "PUT");
  assert.deepEqual(writes.map((c) => c.url), [
    // Impression actuelle de Golgari Thug (RAV), puis de Sidisi (promo).
    "https://api2.moxfield.com/v2/decks/0000000/cards/mainboard/ZOwRD",
    "https://api2.moxfield.com/v2/decks/0000000/cards/mainboard/E0aWJ",
  ]);
  assert.deepEqual(writes.map((c) => c.headers["x-deck-version"]), ["6", "7"], "version suivie d'un changement à l'autre");
  assert.equal(bg.moxfieldCalls.filter((c) => c.url.includes("/decks/all/")).length, 1, "deck lu une seule fois");
  // Sidisi est en foil dans le deck, et l'édition KTK existe en foil.
  assert.equal(writes[1].body.finish, "foil");
  assert.equal(deck.version, 8);
  assert.equal(bg.counts.stateWrites, 0, "ni stock ni decks montés modifiés");
});

test("éditions de la collection : arrêt à la première erreur, cartes déjà passées indiquées", async () => {
  const { options } = editableDeck();
  let calls = 0;
  const edit = options.moxfieldEdit;
  options.moxfieldEdit = (url, init) => (++calls === 2 ? new TypeError("Failed to fetch") : edit(url, init));
  const bg = loadBackground(undefined, options);
  const second = { ...GOLGARI_TO_DDS, name: "Sidisi, Brood Tyrant", uniqueCardId: "u0002", from: { set: "pktk", cn: "199p" } };
  const res = await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [GOLGARI_TO_DDS, second] } });
  assert.equal(res.ok, false);
  assert.equal(res.code, "network");
  assert.deepEqual(res.done, ["Golgari Thug"]);
  assert.equal(calls, 2, "réseau coupé : pas de nouvelle tentative");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(bg.sentry, [], "réseau coupé : pas de rapport");
});

const SIDISI_TO_KTK = {
  name: "Sidisi, Brood Tyrant",
  board: "mainboard",
  uniqueCardId: "u0002",
  from: { set: "pktk", cn: "199p" },
  to: { set: "ktk", cn: "199", setName: "Khans of Tarkir", cardId: "SdKtk", finishes: ["nonFoil", "foil"] },
};

test("éditions de la collection : deck modifié ailleurs en cours de route, relu puis carte retentée", async () => {
  const { deck, options } = editableDeck();
  const edit = options.moxfieldEdit;
  let calls = 0;
  options.moxfieldEdit = (url, init) => {
    // Avant le 2e changement, le deck est modifié dans un autre onglet.
    if (++calls === 2) {
      deck.version++;
      options.moxfieldDeck = JSON.stringify(deck);
    }
    return edit(url, init);
  };
  const bg = loadBackground(undefined, options);
  const res = await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [GOLGARI_TO_DDS, SIDISI_TO_KTK] } });
  assert.deepEqual(res, { ok: true, done: ["Golgari Thug", "Sidisi, Brood Tyrant"], skipped: [] });
  const writes = bg.moxfieldCalls.filter((c) => c.method === "PUT");
  assert.deepEqual(writes.map((c) => c.headers["x-deck-version"]), ["6", "7", "8"], "refusée en 7, retentée en 8");
  assert.equal(bg.moxfieldCalls.filter((c) => c.url.includes("/decks/all/")).length, 2, "deck relu après le refus");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(bg.sentry, [], "refus rattrapé : pas de rapport");
});

test("éditions de la collection : carte changée entre-temps, vue à la relecture, pas touchée", async () => {
  const { deck, options } = editableDeck();
  const edit = options.moxfieldEdit;
  let calls = 0;
  options.moxfieldEdit = (url, init) => {
    // Sidisi passée à la main sur une autre édition, juste avant notre 2e changement.
    if (++calls === 2) {
      const sidisi = Object.values(deck.boards.mainboard.cards).find((e) => e.card.uniqueCardId === "u0002");
      sidisi.card = { ...sidisi.card, set: "dtk", cn: "1" };
      deck.version++;
      options.moxfieldDeck = JSON.stringify(deck);
    }
    return edit(url, init);
  };
  const bg = loadBackground(undefined, options);
  const res = await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [GOLGARI_TO_DDS, SIDISI_TO_KTK] } });
  assert.deepEqual(res, { ok: true, done: ["Golgari Thug"], skipped: [{ name: "Sidisi, Brood Tyrant", reason: "changed" }] });
  assert.equal(bg.moxfieldCalls.filter((c) => c.method === "PUT").length, 2, "pas de nouvelle tentative");
});

test("éditions de la collection : refus répété, une seule nouvelle tentative puis arrêt", async () => {
  const { options } = editableDeck();
  options.moxfieldEdit = () => ({ status: 409, body: {} });
  const bg = loadBackground(undefined, options);
  const res = await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [GOLGARI_TO_DDS, SIDISI_TO_KTK] } });
  assert.equal(res.ok, false);
  assert.equal(res.code, "api-changed");
  assert.deepEqual(res.done, []);
  assert.equal(bg.moxfieldCalls.filter((c) => c.method === "PUT").length, 2);
});

test("éditions de la collection : avancement envoyé à l'onglet qui a lancé l'action", async () => {
  const { options } = editableDeck();
  const bg = loadBackground(undefined, options);
  const tab = { tab: { id: 7 } };
  await bg.send({ type: "PLAN_OWNED_EDITIONS", payload: { deckId: "abc123", names: ["Golgari Thug", "Birds of Paradise"] } }, tab);
  await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [GOLGARI_TO_DDS, SIDISI_TO_KTK] } }, tab);
  const steps = bg.tabMessages.map(({ tabId, type, step, done, total }) => `${tabId} ${type} ${step} ${done}/${total}`);
  assert.deepEqual(steps.slice(0, 1), ["7 OWNED_EDITIONS_PROGRESS plan 0/2"]);
  // Lectures en parallèle : l'ordre d'arrivée importe peu, le compte si.
  assert.deepEqual(steps.slice(1, 3).sort(), ["7 OWNED_EDITIONS_PROGRESS plan 1/2", "7 OWNED_EDITIONS_PROGRESS plan 2/2"]);
  assert.deepEqual(steps.slice(3), [
    "7 OWNED_EDITIONS_PROGRESS apply 0/2",
    "7 OWNED_EDITIONS_PROGRESS apply 1/2",
    "7 OWNED_EDITIONS_PROGRESS apply 2/2",
  ]);
  // Sans onglet (message venu d'ailleurs) : rien n'est envoyé.
  const before = bg.tabMessages.length;
  await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [GOLGARI_TO_DDS] } });
  assert.equal(bg.tabMessages.length, before);
});

test("éditions de la collection : carte laissée comptée dans l'avancement", async () => {
  const { options } = editableDeck();
  const bg = loadBackground(undefined, options);
  const stale = { ...GOLGARI_TO_DDS, name: "Revitalizing Repast // Old-Growth Grove", uniqueCardId: "u0003", from: { set: "mh3", cn: "1" } };
  await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [stale, GOLGARI_TO_DDS] } }, { tab: { id: 3 } });
  assert.deepEqual(bg.tabMessages.map((m) => m.done), [0, 1, 2]);
});

test("éditions de la collection : éditions lues en parallèle, par 3 au plus, ordre gardé", async () => {
  const { options } = editableDeck();
  // Toutes les cartes du deck possédées dans une autre édition.
  options.moxfieldCSV = csv(
    "1,0,Golgari Thug,dds,,,,,,50,,,",
    '1,0,"Sidisi, Brood Tyrant",ktk,,,,,,199,,,',
    "1,0,Revitalizing Repast // Old-Growth Grove,mh3,,,,,,1,,,",
    "1,0,Birds of Paradise,plst,,,,,,52★,,,",
    "1,0,Swamp,war,,,,,,1,,,"
  );
  const known = options.moxfieldEditions;
  let inFlight = 0;
  let maxInFlight = 0;
  options.moxfieldEditions = async (url) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return known(url);
  };
  const bg = loadBackground(undefined, options);
  const names = ["Golgari Thug", "Sidisi, Brood Tyrant", "Revitalizing Repast", "Birds of Paradise"];
  const res = await bg.send({ type: "PLAN_OWNED_EDITIONS", payload: { deckId: "abc123", names } });
  assert.equal(maxInFlight, 3);
  assert.deepEqual(res.plan.map((p) => p.name), ["Golgari Thug", "Birds of Paradise"]);
  assert.deepEqual(res.skipped.map((p) => p.name), ["Sidisi, Brood Tyrant", "Revitalizing Repast // Old-Growth Grove"]);
});

test("éditions de la collection : deck d'un autre compte refusé sans rapport, réponse anormale rapportée", async () => {
  const refused = editableDeck();
  refused.options.moxfieldEdit = () => ({ status: 403, body: {} });
  const bg = loadBackground(undefined, refused.options);
  const res = await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [GOLGARI_TO_DDS] } });
  assert.equal(res.code, "blocked");
  const odd = editableDeck();
  odd.options.moxfieldEdit = () => ({ body: { card: { id: "AUTRE" } } });
  const bg2 = loadBackground(undefined, odd.options);
  assert.equal((await bg2.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [GOLGARI_TO_DDS] } })).code, "api-changed");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bg.sentry.length, 0);
  assert.equal(bg2.sentry.length, 1);
  // Rien du deck ni des cartes dans le rapport.
  assert.ok(!JSON.stringify(bg2.sentry).includes("Golgari"));
});

test("éditions de la collection : refus 400, motif de Moxfield joint au rapport, sans adresse mail", async () => {
  const { options } = editableDeck();
  const reason = { title: "One or more validation errors occurred.", errors: { "printingData[0].lang": ["Invalid"] }, contact: "joueur@exemple.fr" };
  options.moxfieldEdit = () => ({ status: 400, body: { ...reason, padding: "x".repeat(2000) } });
  const bg = loadBackground(undefined, options);
  const res = await bg.send({ type: "APPLY_OWNED_EDITIONS", payload: { deckId: "abc123", plan: [GOLGARI_TO_DDS] } });
  assert.equal(res.code, "api-changed");
  assert.ok(!res.error.includes("Invalid"), "motif brut jamais affiché");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bg.sentry.length, 1);
  const report = JSON.stringify(bg.sentry[0]);
  assert.ok(report.includes("printingData[0].lang"), "motif du refus");
  assert.ok(!report.includes("joueur@exemple.fr"), "adresse mail");
  assert.ok(!report.includes("x".repeat(600)), "réponse bornée");
});

test("éditions de la collection : demandes invalides refusées sans appel", async () => {
  const { options } = editableDeck();
  const bg = loadBackground(undefined, options);
  for (const payload of [
    { deckId: "../x", plan: [GOLGARI_TO_DDS] },
    { deckId: "abc123", plan: [{ ...GOLGARI_TO_DDS, to: { ...GOLGARI_TO_DDS.to, cardId: "a/b" } }] },
    { deckId: "abc123", plan: [{ ...GOLGARI_TO_DDS, board: "main board" }] },
    { deckId: "abc123" },
  ]) {
    assert.equal((await bg.send({ type: "APPLY_OWNED_EDITIONS", payload })).ok, false);
  }
  assert.equal((await bg.send({ type: "PLAN_OWNED_EDITIONS", payload: { deckId: "abc123" } })).ok, false);
  assert.deepEqual(bg.moxfieldCalls, []);
});

// --- Sauvegarde Drive à télécharger ---
// Le dossier de l'extension (appDataFolder) est invisible dans Google
// Drive : le popup permet d'en télécharger le contenu.

function driveWithStateFile(files) {
  const calls = [];
  const drive = async (url, init = {}) => {
    calls.push(url);
    if (url.includes("alt=media")) return new Response(zlib.gzipSync(JSON.stringify(DOC)), { status: 200 });
    if (url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ files }), { status: 200 });
    return new Response(JSON.stringify({ id: "f1", version: "1" }), { status: 200 });
  };
  return { drive, calls };
}

test("sauvegarde Drive : fichier d'état téléchargé et décompressé", async () => {
  const { drive, calls } = driveWithStateFile([{ id: "etat1", version: "4" }]);
  const bg = loadBackground(undefined, { drive });
  const res = await bg.send({ type: "DRIVE_DOWNLOAD" });
  assert.equal(res.ok, true);
  // Liste « Mes decks » ajoutée, vide pour une sauvegarde d'avant.
  assert.deepEqual(res.doc, { ...DOC, state: { ...DOC.state, followedDecks: {} } });
  assert.ok(calls.some((u) => u.includes("/files/etat1?alt=media")), "fichier d'état lu");
});

test("sauvegarde Drive : version de l'historique téléchargée", async () => {
  const { drive, calls } = driveWithStateFile([]);
  const bg = loadBackground(undefined, { drive });
  const res = await bg.send({ type: "DRIVE_DOWNLOAD", payload: { fileId: "snap7" } });
  assert.deepEqual(res.doc, { ...DOC, state: { ...DOC.state, followedDecks: {} } });
  assert.ok(calls.some((u) => u.includes("/files/snap7?alt=media")));
});

test("sauvegarde Drive : rien sur Drive, refus expliqué", async () => {
  const { drive } = driveWithStateFile([]);
  const bg = loadBackground(undefined, { drive });
  assert.deepEqual(await bg.send({ type: "DRIVE_DOWNLOAD" }), { ok: false, error: "Aucune sauvegarde sur Drive pour le moment." });
});

// --- Nouvelle version de l'extension (cf. update-check.js) ---

const LOCAL_SHA = "c".repeat(40);
const CLONE_FILES = { ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/main": `${LOCAL_SHA}\n` };
const AHEAD = () => new Response(JSON.stringify({ status: "ahead", ahead_by: 1, commits: [{ commit: { message: "Add something" } }] }));

test("nouvelle version sur GitHub : pastille sur l'icône et détail pour le popup", async () => {
  const bg = loadBackground(undefined, { gitFiles: CLONE_FILES, github: AHEAD });
  await bg.startup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bg.badge.text, "↑");
  assert.match(bg.badge.title, /nouvelle version disponible/);
  assert.ok(bg.alarms.has("update-check"), "vérification périodique");
  const res = await bg.send({ type: "GET_UPDATE_STATUS" });
  assert.deepEqual(res.update, {
    count: 1,
    commits: ["Add something"],
    compareUrl: `https://github.com/jguillevic/moxfield-chrome-extension/compare/${LOCAL_SHA.slice(0, 12)}...main`,
    latestVersion: "9.9.9",
  });
  assert.equal(bg.github.calls.length, 1, "constat récent : le popup ne redemande pas à GitHub");
});

test("nouvelle version : rien si le clone est à jour, ni sans dossier .git (GitHub pas appelé)", async () => {
  const upToDate = loadBackground(undefined, { gitFiles: CLONE_FILES, github: () => new Response(JSON.stringify({ status: "identical", ahead_by: 0, commits: [] })) });
  await upToDate.startup();
  assert.deepEqual(await upToDate.send({ type: "GET_UPDATE_STATUS" }), { ok: true, update: null });
  assert.equal(upToDate.badge.text, "");

  const noClone = loadBackground();
  await noClone.startup();
  assert.deepEqual(await noClone.send({ type: "GET_UPDATE_STATUS" }), { ok: true, update: null });
  assert.equal(noClone.github.calls.length, 0);
});

// Après un git pull et le rechargement de l'extension, l'ancien constat ne
// vaut plus, même si GitHub ne répond pas.
test("nouvelle version : pastille retirée après le git pull et le rechargement, même sans réponse de GitHub", async () => {
  const options = { gitFiles: { ...CLONE_FILES }, github: AHEAD };
  const bg = loadBackground(undefined, options);
  await bg.startup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bg.badge.text, "↑");
  options.gitFiles[".git/refs/heads/main"] = `${"d".repeat(40)}\n`; // git pull
  options.github = () => {
    throw new TypeError("Failed to fetch");
  };
  await bg.installed();
  assert.equal(bg.badge.text, "");
  assert.deepEqual(await bg.send({ type: "GET_UPDATE_STATUS" }), { ok: true, update: null });
});

test("version affichée : numéro du manifest et commit du clone (lien vers GitHub)", async () => {
  const clone = loadBackground(undefined, { gitFiles: CLONE_FILES });
  assert.deepEqual(await clone.send({ type: "GET_VERSION_INFO" }), {
    ok: true,
    version: "0.2.0",
    commit: LOCAL_SHA,
    commitUrl: `https://github.com/jguillevic/moxfield-chrome-extension/commit/${LOCAL_SHA}`,
  });
  const copy = loadBackground();
  assert.deepEqual(await copy.send({ type: "GET_VERSION_INFO" }), { ok: true, version: "0.2.0", commit: null, commitUrl: null });
});

// --- Aide au démarrage ---

test("aide : premiers pas proposés à une nouvelle installation, et encore après la récupération de la collection", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  assert.deepEqual(await bg.send({ type: "GET_ONBOARDING" }), { ok: true, done: false, deckHelpSeen: false });
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.equal((await bg.send({ type: "GET_ONBOARDING" })).done, false, "le stock n'est plus vide, mais les premiers pas ne sont pas finis");
});

// Cas réel : connexion à Moxfield juste après l'installation, collection
// récupérée avant la première ouverture du popup.
test("aide : nouvelle installation dont la collection arrive avant la première ouverture du popup", async () => {
  const bg = loadBackground(undefined, { moxfieldCSV: COLLECTION_CSV });
  await bg.installed("install");
  await bg.send({ type: "COLLECTION_FETCH_NOW" });
  assert.deepEqual(await bg.send({ type: "GET_ONBOARDING" }), { ok: true, done: false, deckHelpSeen: false });
});

test("aide : installation existante (déjà un stock) : pas de premiers pas, mais la bulle de la page d'un deck une fois", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  await bg.installed("update");
  assert.deepEqual(await bg.send({ type: "GET_ONBOARDING" }), { ok: true, done: true, deckHelpSeen: false });
  await bg.send({ type: "SET_DECK_HELP_SEEN" });
  assert.deepEqual(await bg.send({ type: "GET_ONBOARDING" }), { ok: true, done: true, deckHelpSeen: true });
});

test("aide : ancien enregistrement du guide pas à pas (étape) repris sans son étape", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  bg.setOnboarding({ done: false, step: 2 });
  assert.deepEqual(await bg.send({ type: "GET_ONBOARDING" }), { ok: true, done: false, deckHelpSeen: false });
});

test("aide : masquée, rouverte, bulle vue ; écrite seulement quand elle change, jamais dans l'état synchronisé", async () => {
  const bg = loadBackground();
  await bg.send({ type: "GET_ONBOARDING" });
  const writes = bg.counts.onboardingWrites;
  assert.deepEqual(await bg.send({ type: "SET_ONBOARDING", payload: { done: true } }), { ok: true, done: true, deckHelpSeen: false });
  await bg.send({ type: "SET_DECK_HELP_SEEN" });
  assert.deepEqual(await bg.send({ type: "GET_ONBOARDING" }), { ok: true, done: true, deckHelpSeen: true });
  await bg.send({ type: "SET_ONBOARDING", payload: { done: false } }); // rouverte par « Aide »
  assert.deepEqual(await bg.send({ type: "GET_ONBOARDING" }), { ok: true, done: false, deckHelpSeen: true }, "la bulle reste vue");
  assert.equal(bg.counts.onboardingWrites, writes + 3);
  await bg.send({ type: "SET_DECK_HELP_SEEN" });
  await bg.send({ type: "SET_ONBOARDING", payload: { done: false } });
  assert.equal(bg.counts.onboardingWrites, writes + 3, "rien de changé : rien d'écrit");
  assert.equal(bg.counts.stateWrites, 0, "propre à ce PC : rien n'est envoyé sur Drive");
});

// --- Mes decks (vue d'ensemble dans le popup) ---

const SOL_DECK = (name, cards) => JSON.stringify({
  id: "x", name, publicId: "p", boards: { mainboard: { cards: Object.fromEntries(cards.map(([n, id], i) => [`u${i}`, { quantity: 1, card: { id, name: n, set: "c21", cn: String(i) } }])) } },
});
const decksOf = async (bg) => (await bg.send({ type: "GET_DECKS" })).decks;

test("Mes decks : deck ouvert suivi une fois, jamais renommé par la page, gardé après une réinitialisation", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  assert.deepEqual(await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "deck1", name: "Nom lu sur la page" } }), { ok: true, changed: true });
  const writes = bg.counts.stateWrites;
  assert.equal((await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "deck1", name: "Autre nom" } })).changed, false);
  assert.equal(bg.counts.stateWrites, writes, "déjà suivi : rien n'est écrit (ni envoyé sur Drive)");
  assert.equal(bg.raw().followedDecks.deck1.name, "Nom lu sur la page");
  await bg.send({ type: "RESET_STOCK" });
  assert.ok(bg.raw().followedDecks.deck1, "réinitialisation : les decks suivis restent");
  assert.equal((await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "../x" } })).ok, false, "identifiant invalide");
});

test("Mes decks : deck suivi jamais lu à relire, deck monté affiché sans appel à Moxfield", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "deck1", name: "Deck 1" } });
  const res = await bg.send({ type: "GET_DECKS" });
  assert.deepEqual(res.decks.map((d) => [d.deckId, d.status]), [["deck1", "unknown"], ["a", "built"]]);
  assert.deepEqual(res.staleIds, ["deck1"]);
});

test("Mes decks : decks relus sur Moxfield, faisabilité avec le stock du moment, nom de Moxfield retenu", async () => {
  const bg = loadBackground(SOL_RING_STOCK(), {
    moxfieldCSV: "",
    moxfieldDeck: (url) => (url.includes("/ok1") ? SOL_DECK("Deck montable", [["Sol Ring", "S1"]]) : SOL_DECK("Deck incomplet", [["Sol Ring", "S1"], ["Rhystic Study", "R1"]])),
  });
  await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "ok1", name: "Titre de page" } });
  await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "ko2", name: "ko2" } });
  assert.deepEqual(await bg.send({ type: "REFRESH_DECKS", payload: { deckIds: ["ok1", "ko2"] } }), { ok: true, refreshed: 2 });
  const decks = await decksOf(bg);
  const ok = decks.find((d) => d.deckId === "ok1");
  const ko = decks.find((d) => d.deckId === "ko2");
  assert.deepEqual([ok.name, ok.status, ok.blocking], ["Deck montable", "buildable", 0]);
  assert.deepEqual([ko.status, ko.blocking], ["blocked", 1]);
  assert.match(ko.label, /manque Rhystic Study \(1\)/);
  assert.equal(bg.raw().followedDecks.ok1.name, "Deck montable", "nom lu par l'API");
  assert.deepEqual((await bg.send({ type: "GET_DECKS" })).staleIds, [], "lus à l'instant");

  // Le stock change : faisabilité recalculée sans relire Moxfield.
  const calls = bg.moxfieldCalls.length;
  await build(bg, "b", [{ name: "Sol Ring", qty: 2 }]);
  assert.equal((await decksOf(bg)).find((d) => d.deckId === "ok1").status, "blocked");
  assert.equal(bg.moxfieldCalls.length, calls);
});

test("Mes decks : deck introuvable ou privé noté sans rapport d'erreur ; pas connecté, lecture arrêtée", async () => {
  const bg = loadBackground(undefined, { sentryDsn: SENTRY_DSN, moxfieldCSV: "", moxfieldDeck: () => ({ status: 404 }) });
  await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "gone", name: "Supprimé" } });
  assert.deepEqual(await bg.send({ type: "REFRESH_DECKS", payload: { deckIds: ["gone"] } }), { ok: true, refreshed: 1 });
  assert.equal((await decksOf(bg))[0].status, "unavailable");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(bg.sentry.length, 0);

  const loggedOut = loadBackground(undefined, { moxfieldCSV: "", cookies: [], moxfieldDeck: "{}" });
  await loggedOut.send({ type: "FOLLOW_DECK", payload: { deckId: "d1", name: "D1" } });
  const res = await loggedOut.send({ type: "REFRESH_DECKS", payload: { deckIds: ["d1", "d2"] } });
  assert.deepEqual([res.ok, res.code, res.refreshed], [false, "not-logged-in", 0]);
  assert.equal((await decksOf(loggedOut))[0].status, "unknown");
});

test("Mes decks : adresse collée ajoutée et lue tout de suite ; adresse non reconnue refusée", async () => {
  const bg = loadBackground(SOL_RING_STOCK(), { moxfieldCSV: "", moxfieldDeck: SOL_DECK("Collé", [["Sol Ring", "S1"]]) });
  const res = await bg.send({ type: "ADD_DECK", payload: { input: " https://www.moxfield.com/decks/Z9iP5lF4OEusUjMQXrpbgg/primer " } });
  assert.deepEqual(res, { ok: true, refreshed: 1 });
  assert.deepEqual((await decksOf(bg)).map((d) => [d.deckId, d.name, d.status]), [["Z9iP5lF4OEusUjMQXrpbgg", "Collé", "buildable"]]);
  for (const input of ["https://example.com/decks/abc", "https://moxfield.com/decks/public", "pas une adresse !"]) {
    const refused = await bg.send({ type: "ADD_DECK", payload: { input } });
    assert.equal(refused.code, "invalid-deck", input);
    assert.match(refused.error, /non reconnue/);
  }
});

test("Mes decks : retirer un deck suivi ; liste synchronisée via Drive et gardée à la restauration", async () => {
  const bg = loadBackground();
  await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "d1", name: "D1" } });
  await bg.send({ type: "UNFOLLOW_DECK", payload: { deckId: "d1" } });
  assert.deepEqual(await decksOf(bg), []);

  // Sauvegarde Drive : la liste fait partie de l'état envoyé.
  await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "d2", name: "D2" } });
  const doc = bg.context.makeDoc(await bg.context.getState(), 1);
  assert.deepEqual(Object.keys(plain(doc.state.followedDecks)), ["d2"]);
  // Relue, avec une entrée invalide écartée.
  doc.state.followedDecks["../x"] = { name: "invalide" };
  assert.deepEqual(Object.keys(plain(bg.context.parseDoc(doc).state.followedDecks)), ["d2"]);
});

test("Mes decks : cœur sur un deck monté, il reste dans la liste une fois démonté ; état transmis à la page", async () => {
  const bg = loadBackground(SOL_RING_STOCK());
  await build(bg, "a", [{ name: "Sol Ring", qty: 1 }]);
  assert.equal((await bg.send({ type: "GET_DECK_CONTEXT", payload: { deckId: "a", names: [] } })).followed, false);
  assert.equal((await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "a", name: "Deck a" } })).changed, true);
  assert.equal((await bg.send({ type: "GET_DECK_CONTEXT", payload: { deckId: "a", names: [] } })).followed, true);
  await unbuild(bg, "a");
  assert.deepEqual((await decksOf(bg)).map((d) => [d.deckId, d.status]), [["a", "unknown"]]);
});

test("proxies déclarés sur Moxfield : transmis à la page, et pris en compte dans « Mes decks »", async () => {
  const deck = JSON.parse(SOL_DECK("Avec proxy", [["Sol Ring", "S1"], ["Rhystic Study", "R1"]]));
  deck.boards.mainboard.cards.u1.isProxy = true;
  const bg = loadBackground(SOL_RING_STOCK(), { moxfieldCSV: "", moxfieldDeck: JSON.stringify(deck) });
  const res = await bg.send({ type: "GET_DECK_PRINTINGS", payload: { deckId: "d1" } });
  assert.deepEqual(res.declaredProxies, { "Rhystic Study": 1 });
  await bg.send({ type: "FOLLOW_DECK", payload: { deckId: "d1", name: "d1" } });
  await bg.send({ type: "REFRESH_DECKS", payload: { deckIds: ["d1"] } });
  const [listed] = await decksOf(bg);
  assert.deepEqual([listed.status, listed.blocking], ["buildable", 0], "Rhystic Study manque, mais déclaré proxy");
  assert.match(listed.label, /1 proxy déclaré/);
});

// Liste d'achats cumulée des decks cochés dans « Mes decks ».
test("liste d'achats : manques de plusieurs decks additionnés sur le stock libre, prix de la version la moins chère", async () => {
  const card = (name, id, eur, extra = {}) => ({ quantity: 1, card: { id, name, set: "c21", cn: id, prices: eur === undefined ? {} : { eur } }, ...extra });
  const deckJson = (name, cards) => JSON.stringify({ id: "x", name, publicId: "p", boards: { mainboard: { cards: Object.fromEntries(cards.map((c, i) => [`u${i}`, c])) } } });
  const decks = {
    a: deckJson("Deck A", [card("Sol Ring", "S1", 1.5), card("Rhystic Study", "R1", 30), card("Swamp", "W1", 0.1)]),
    b: deckJson("Deck B", [card("Sol Ring", "S2", 1.2), card("Rhystic Study", "R2"), card("Mana Crypt", "M1", 150, { isProxy: true }), card("Arcane Signet", "A1")]),
    c: deckJson("Deck C", [card("Sol Ring", "S3", 1)]),
  };
  const bg = loadBackground(SOL_RING_STOCK(), { moxfieldCSV: "", moxfieldDeck: (url) => decks[url.split("/").pop()] });
  for (const id of ["a", "b", "c", "never"]) await bg.send({ type: "FOLLOW_DECK", payload: { deckId: id, name: id } });
  await bg.send({ type: "REFRESH_DECKS", payload: { deckIds: ["a", "b", "c"] } });

  // Sol Ring : 3 au total dans A, B et C pour 2 libres ; C est monté
  // (ses cartes sortent du stock libre) et n'entre plus dans la liste.
  await build(bg, "c", [{ name: "Sol Ring", qty: 1 }]);
  const res = await bg.send({ type: "GET_SHOPPING_LIST", payload: { deckIds: ["a", "b", "c", "never"] } });
  assert.equal(res.deckCount, 2);
  assert.deepEqual(res.skipped, ["never"], "deck jamais lu : écarté et nommé");
  assert.deepEqual(
    res.items.map((i) => [i.name, i.have, i.need, i.missing, i.decks, i.unit, i.total]),
    [
      ["Arcane Signet", 0, 1, 1, ["Deck B"], undefined, undefined],
      ["Rhystic Study", 0, 2, 2, ["Deck A", "Deck B"], 30, 60],
      ["Sol Ring", 1, 2, 1, ["Deck A", "Deck B"], 1.2, 1.2],
    ],
    "une ligne par carte ; terrains de base et proxy déclaré (Mana Crypt) exclus"
  );
  assert.deepEqual([res.total, res.unpriced], [61.2, 1]);

  // Un seul deck : mêmes manques que sa pastille dans « Mes decks ».
  const single = await bg.send({ type: "GET_SHOPPING_LIST", payload: { deckIds: ["a"] } });
  const listed = (await decksOf(bg)).find((d) => d.deckId === "a");
  assert.equal(single.items.reduce((n, i) => n + i.missing, 0), listed.blocking);
  assert.deepEqual((await bg.send({ type: "GET_SHOPPING_LIST", payload: { deckIds: [] } })).items, []);
});
