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



// --- Grosses collections : détail limité par entrée ---

const manyChanges = (n) => Array.from({ length: n }, (_, i) => ({ name: `Card ${String(i).padStart(5, "0")}`, from: 0, to: 1 }));

test("compactEntry : au-delà de 200 cartes, détail tronqué et nombre total conservé", () => {
  const big = { id: "a", at: 1, type: "collection", source: "fetch", changes: manyChanges(30000) };
  const compact = h.compactEntry(big);
  assert.equal(h.MAX_CHANGES_PER_ENTRY, 200);
  assert.equal(compact.changes.length, 200);
  assert.equal(compact.changes[0].name, "Card 00000");
  assert.equal(compact.changeCount, 30000);
  assert.equal(h.changeCount(compact), 30000);
  assert.equal(big.changes.length, 30000, "entrée d'origine non modifiée");
});

test("compactEntry : petite entrée, et entrée déjà compactée, inchangées", () => {
  const small = { id: "a", at: 1, type: "collection", source: "fetch", changes: manyChanges(3) };
  assert.equal(h.compactEntry(small), small);
  const once = h.compactEntry({ ...small, changes: manyChanges(500) });
  assert.deepEqual(h.compactEntry(once), once);
  assert.equal(h.changeCount(once), 500);
});

test("describe : nombre total de cartes, pas seulement le détail gardé", () => {
  const compact = h.compactEntry({ type: "collection", source: "fetch", changes: manyChanges(30000) });
  assert.equal(h.describe(compact), "Collection Moxfield récupérée : 30000 cartes modifiées");
});

test("addEntry et mergeHistories : les anciennes grosses entrées sont compactées", () => {
  const old = { id: "old", at: 1, type: "collection", source: "fetch", changes: manyChanges(5000) };
  const [, compacted] = h.addEntry([old], entry("new", 2));
  assert.equal(compacted.changes.length, 200);
  assert.equal(compacted.changeCount, 5000);
  const [merged] = h.mergeHistories([old], []);
  assert.equal(merged.changes.length, 200);
});
