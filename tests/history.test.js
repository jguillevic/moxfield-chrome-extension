// Tests de l'historique (history.js) : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHistory } = require("../history.js");

const normalizeName = (name) => name.trim().toLowerCase().replace(/\s+/g, " ");
const h = createHistory(normalizeName);

const entry = (id, at, extra = {}) => ({ id, at, device: "pc1", type: "drive-restore", ...extra });

test("addEntry : la plus récente en premier, 200 entrées au plus", () => {
  let history = [];
  for (let i = 0; i < 205; i++) history = h.addEntry(history, entry(`e${i}`, i));
  assert.equal(history.length, h.MAX_ENTRIES);
  assert.equal(h.MAX_ENTRIES, 200);
  assert.equal(history[0].id, "e204");
  assert.equal(history[199].id, "e5", "les plus anciennes sont oubliées");
});

test("addEntry : historique absent (ancien état)", () => {
  assert.deepEqual(h.addEntry(undefined, entry("a", 1)), [entry("a", 1)]);
});

test("newId : identifiants différents", () => {
  const ids = new Set(Array.from({ length: 100 }, () => h.newId()));
  assert.equal(ids.size, 100);
});

test("mergeHistories : union sans doublon, triée de la plus récente à la plus ancienne", () => {
  const a = [entry("c", 30), entry("a", 10)];
  const b = [entry("d", 40), entry("c", 30), entry("b", 20)];
  assert.deepEqual(h.mergeHistories(a, b).map((e) => e.id), ["d", "c", "b", "a"]);
});


test("mergeHistories : 200 entrées au plus, historiques absents", () => {
  const many = Array.from({ length: 150 }, (_, i) => entry(`x${i}`, i));
  const more = Array.from({ length: 150 }, (_, i) => entry(`y${i}`, 1000 + i));
  const merged = h.mergeHistories(many, more);
  assert.equal(merged.length, 200);
  assert.equal(merged[0].id, "y149");
  assert.deepEqual(h.mergeHistories(undefined, undefined), []);
});

test("cardsDiff : ajouts, retraits, quantités, noms comparés sans casse", () => {
  const from = [
    { name: "Sol Ring", qty: 1 },
    { name: "Rhystic Study", qty: 1 },
    { name: "Island", qty: 2 },
    { name: "island", qty: 1 },
  ];
  const to = [
    { name: "SOL RING", qty: 1 },
    { name: "Counterspell", qty: 1 },
    { name: "Island", qty: 5 },
  ];
  assert.deepEqual(h.cardsDiff(from, to), [
    { name: "Counterspell", from: 0, to: 1 },
    { name: "Island", from: 3, to: 5 },
    { name: "Rhystic Study", from: 1, to: 0 },
  ]);
});

test("describe : libellé de chaque type d'action", () => {
  const cards = [{ name: "Sol Ring", qty: 1 }, { name: "Island", qty: 2 }];
  const changes1 = [{ name: "Sol Ring", from: 0, to: 1 }];
  const changes2 = [...changes1, { name: "Island", from: 2, to: 0 }];
  const cases = [
    [{ type: "collection", source: "fetch", changes: changes2 }, "Collection Moxfield récupérée : 2 cartes modifiées"],
    [{ type: "collection", source: "csv", changes: changes1 }, "Import CSV : 1 carte modifiée"],
    [{ type: "deck-built", deckName: "Zethi", cardCount: 99 }, "Deck « Zethi » monté : 99 cartes retirées du stock libre"],
    [{ type: "deck-unbuilt", deckName: "Zethi", cards }, "Deck « Zethi » démonté : 3 cartes rendues au stock"],
    [{ type: "deck-updated", deckName: "Zethi", changes: changes2 }, "Montage de « Zethi » mis à jour : 2 cartes modifiées"],
    [{ type: "reset", builtDecks: { a: {}, b: {} } }, "Stock réinitialisé (2 decks démontés)"],
    [{ type: "reset", builtDecks: {} }, "Stock réinitialisé (0 deck démonté)"],
    [{ type: "drive-restore" }, "Version de l'historique Google Drive restaurée"],
  ];
  for (const [e, expected] of cases) assert.equal(h.describe(e), expected);
});


