// Tests de la gestion du stock du service worker (background.js) : npm test
//
// background.js est chargé tel quel dans un contexte isolé, avec un faux
// chrome.storage.local en mémoire ; on lui parle comme l'extension, par
// messages. La synchro Google Drive n'est pas activée : aucun appel réseau.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const STORAGE_KEY = "moxfieldStockManagerState";

function loadBackground(initialState) {
  const storage = {};
  if (initialState) storage[STORAGE_KEY] = initialState;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  let onMessage = null;
  const listener = () => ({ addListener() {} });
  const chrome = {
    storage: {
      local: {
        async get(key) {
          return key in storage ? { [key]: clone(storage[key]) } : {};
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) storage[k] = clone(v);
        },
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => (onMessage = fn) },
      onStartup: listener(),
      onInstalled: listener(),
    },
    alarms: { onAlarm: listener(), create() {}, clear: async () => {} },
  };
  vm.runInNewContext(SOURCE, { chrome, setTimeout, clearTimeout, console });

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
