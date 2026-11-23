// Tests de l'historique (history.js) : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHistory } = require("../history.js");
const { loadI18n } = require("./helpers");

const normalizeName = (name) => name.trim().toLowerCase().replace(/\s+/g, " ");
const h = createHistory(normalizeName, loadI18n());

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
    [{ type: "deck-built", deckName: "Zethi", cardCount: 99 }, "Deck « Zethi » monté : 99 exemplaires retirés du stock libre"],
    [{ type: "deck-unbuilt", deckName: "Zethi", cards }, "Deck « Zethi » démonté : 3 exemplaires rendus au stock"],
    [{ type: "deck-updated", deckName: "Zethi", changes: changes2 }, "Montage de « Zethi » mis à jour : 2 cartes modifiées"],
    [{ type: "reset", builtDecks: { a: {}, b: {} } }, "Tout remis à zéro (2 decks démontés)"],
    [{ type: "reset", builtDecks: {} }, "Tout remis à zéro (0 deck démonté)"],
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

test("cardsDiff : même quantité, autre version enregistrée", () => {
  const from = [
    { name: "Sol Ring", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] },
    { name: "Swamp", qty: 3, versions: [{ code: "S1", qty: 2 }, { code: "S2", qty: 1 }] },
    { name: "Counterspell", qty: 1 },
  ];
  const to = [
    { name: "Sol Ring", qty: 1, versions: [{ code: "BBBBB", qty: 1 }] },
    { name: "Swamp", qty: 3, versions: [{ code: "S2", qty: 1 }, { code: "S1", qty: 2 }] },
    // Aucune version n'était enregistrée : rien à comparer.
    { name: "Counterspell", qty: 1, versions: [{ code: "CCCCC", qty: 1 }] },
  ];
  assert.deepEqual(h.cardsDiff(from, to), [{ name: "Sol Ring", from: 1, to: 1, version: true }]);
});

test("describe : proxies (montage, démontage, mise à jour, remplacement)", () => {
  const built = { type: "deck-built", deckName: "Zethi", cardCount: 96, proxyCount: 3 };
  assert.equal(h.describe(built), "Deck « Zethi » monté : 96 exemplaires retirés du stock libre (+ 3 proxies)");
  const unbuilt = { type: "deck-unbuilt", deckName: "Zethi", cards: [{ name: "Sol Ring", qty: 2, proxyQty: 1 }], cardCount: 1, proxyCount: 1 };
  assert.equal(h.describe(unbuilt), "Deck « Zethi » démonté : 1 exemplaire rendu au stock (+ 1 proxy)");
  // Démontage d'avant les proxies : nombre calculé sur la liste.
  assert.equal(h.describe({ type: "deck-unbuilt", deckName: "Zethi", cards: [{ name: "Sol Ring", qty: 2 }] }), "Deck « Zethi » démonté : 2 exemplaires rendus au stock");
  const updated = { type: "deck-updated", deckName: "Zethi", changes: [{ name: "Sol Ring", from: 1, to: 2 }], proxiesAdded: 1 };
  assert.equal(h.describe(updated), "Montage de « Zethi » mis à jour : 1 carte modifiée (+ 1 nouveau proxy)");
  const replaced = { type: "proxies-replaced", deckName: "Zethi", cards: [{ name: "Sol Ring", qty: 2 }] };
  assert.equal(h.describe(replaced), "Deck « Zethi » : 2 proxies remplacés par la vraie carte, retirée du stock libre");
});
