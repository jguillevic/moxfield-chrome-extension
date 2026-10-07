// Tests des contrôles d'une liste par rapport au stock (deck-checks.js) : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDeckScraper } = require("../deck-scraper.js");
const { createDeckChecks } = require("../deck-checks.js");

// normalizeName ne dépend pas de la page : une fenêtre vide suffit.
const { normalizeName } = createDeckScraper({ document: {} });
const checks = createDeckChecks(normalizeName);
const {
  isBasicLand,
  buildWrongEditionSet,
  computeWrongEditionCards,
  computeShortages,
  parseCardsText,
  evaluateDeckUpdate,
  computeDeckAvailability,
  blockingSummary,
  availabilityLabel,
} = checks;

// Stock au format de background.js : { [nom normalisé]: { name, qty } }.
function stockOf(entries) {
  const stock = {};
  for (const [name, qty] of Object.entries(entries)) stock[normalizeName(name)] = { name, qty };
  return stock;
}

test("isBasicLand : terrains de base, insensible à la casse et aux espaces", () => {
  for (const name of ["Plains", "island", " SWAMP ", "Mountain", "Forest"]) assert.ok(isBasicLand(name), name);
  for (const name of ["Snow-Covered Island", "Wastes", "Sol Ring"]) assert.ok(!isBasicLand(name), name);
});

test("buildWrongEditionSet : seulement les cartes en statut « partial »", () => {
  const set = buildWrongEditionSet([
    { name: "Sol Ring", qty: 1, printingStatus: "partial" },
    { name: "Arcane Signet", qty: 1, printingStatus: "full" },
    { name: "Counterspell", qty: 1 },
  ]);
  assert.deepEqual([...set], ["sol ring"]);
});

test("computeShortages : carte absente ou en quantité insuffisante", () => {
  const stock = stockOf({ "Sol Ring": 1, "Llanowar Elves": 2, "Island": 0 });
  const shortages = computeShortages(
    [
      { name: "Sol Ring", qty: 1 },
      { name: "Llanowar Elves", qty: 4 },
      { name: "Rhystic Study", qty: 1 },
      { name: "Island", qty: 3 },
    ],
    stock
  );
  assert.deepEqual(shortages, [
    { name: "Llanowar Elves", have: 2, need: 4, missing: 2 },
    { name: "Rhystic Study", have: 0, need: 1, missing: 1 },
    { name: "Island", have: 0, need: 3, missing: 3 },
  ]);
});

test("computeShortages : un stock négatif compte comme rien du tout et plus", () => {
  const shortages = computeShortages([{ name: "Sol Ring", qty: 1 }], stockOf({ "Sol Ring": -1 }));
  assert.equal(shortages[0].missing, 2);
});

test("computeShortages : nom comparé sans tenir compte de la casse", () => {
  assert.deepEqual(computeShortages([{ name: "SOL RING", qty: 1 }], stockOf({ "Sol Ring": 1 })), []);
});

test("computeWrongEditionCards : stock suffisant mais autre version", () => {
  const stock = stockOf({ "Sol Ring": 1, "Arcane Signet": 1 });
  const wrong = new Set(["sol ring", "arcane signet"]);
  assert.deepEqual(
    computeWrongEditionCards([{ name: "Sol Ring", qty: 1 }, { name: "Arcane Signet", qty: 2 }], stock, wrong),
    ["Sol Ring"],
    "Arcane Signet relève du stock insuffisant, pas de la version"
  );
});

test("computeWrongEditionCards : rien sans information de version", () => {
  assert.deepEqual(computeWrongEditionCards([{ name: "Sol Ring", qty: 1 }], stockOf({ "Sol Ring": 1 }), new Set()), []);
});

test("parseCardsText : formats acceptés", () => {
  const cards = parseCardsText(
    ["1 Sol Ring", "2x Island", "3 × Forest", "  4   Llanowar Elves  ", "1 Fire // Ice"].join("\n")
  );
  assert.deepEqual(cards, [
    { qty: 1, name: "Sol Ring" },
    { qty: 2, name: "Island" },
    { qty: 3, name: "Forest" },
    { qty: 4, name: "Llanowar Elves" },
    { qty: 1, name: "Fire // Ice" },
  ]);
});

test("parseCardsText : lignes vides, commentaires et lignes sans quantité ignorés", () => {
  const cards = parseCardsText("// Commander\n\nSol Ring\n1 Sol Ring\r\n1234 Island\n");
  assert.deepEqual(cards, [{ qty: 1, name: "Sol Ring" }]);
});

test("evaluateDeckUpdate : les exemplaires déjà dans le deck comptent comme disponibles", () => {
  // Le deck a déjà 1 Llanowar Elves (retiré du stock) ; il en reste 1 libre.
  const deck = { cards: [{ name: "Llanowar Elves", qty: 1 }] };
  const stock = stockOf({ "Llanowar Elves": 1 });
  const ok = evaluateDeckUpdate([{ name: "Llanowar Elves", from: 1, to: 2 }], deck, stock, new Set());
  assert.equal(ok.blocked, false);
  const ko = evaluateDeckUpdate([{ name: "Llanowar Elves", from: 1, to: 3 }], deck, stock, new Set());
  assert.equal(ko.blocked, true);
  assert.deepEqual(ko.shortages, [{ name: "Llanowar Elves", have: 2, need: 3, missing: 1 }]);
});

test("evaluateDeckUpdate : ne modifie pas le stock passé en paramètre", () => {
  const stock = stockOf({ "Llanowar Elves": 1 });
  evaluateDeckUpdate([{ name: "Llanowar Elves", from: 1, to: 2 }], { cards: [{ name: "Llanowar Elves", qty: 1 }] }, stock, new Set());
  assert.equal(stock["llanowar elves"].qty, 1);
});

test("evaluateDeckUpdate : cartes excludedFromStock jamais rendues au stock", () => {
  const deck = { cards: [{ name: "Sol Ring", qty: 1, excludedFromStock: true }] };
  const check = evaluateDeckUpdate([{ name: "Sol Ring", from: 1, to: 2 }], deck, {}, new Set());
  assert.deepEqual(check.shortages, [{ name: "Sol Ring", have: 0, need: 2, missing: 2 }]);
});

test("evaluateDeckUpdate : cartes retirées et terrains de base jamais bloquants", () => {
  const deck = { cards: [{ name: "Rhystic Study", qty: 1 }] };
  const check = evaluateDeckUpdate(
    [
      { name: "Rhystic Study", from: 1, to: 0 },
      { name: "Island", from: 0, to: 5 },
    ],
    deck,
    {},
    new Set(["island"])
  );
  assert.equal(check.blocked, false);
  assert.deepEqual(check.basicShortages, [{ name: "Island", have: 0, need: 5, missing: 5 }]);
});

test("evaluateDeckUpdate : version différente bloquante", () => {
  const check = evaluateDeckUpdate([{ name: "Sol Ring", from: 0, to: 1 }], { cards: [] }, stockOf({ "Sol Ring": 1 }), new Set(["sol ring"]));
  assert.equal(check.blocked, true);
  assert.deepEqual(check.wrongEdition, ["Sol Ring"]);
});

test("computeDeckAvailability : deck montable", () => {
  const a = computeDeckAvailability(
    [
      { name: "Sol Ring", qty: 1 },
      { name: "Island", qty: 2 },
    ],
    stockOf({ "Sol Ring": 3, "Island": 10 })
  );
  assert.deepEqual(a, {
    total: 1,
    available: 1,
    blocking: 0,
    missingCount: 0,
    wrongEditionCount: 0,
    shortages: [],
    wrongEdition: [],
    basicShortages: [],
  });
});

test("computeDeckAvailability : stock insuffisant, version différente et terrains de base", () => {
  const a = computeDeckAvailability(
    [
      { name: "Sol Ring", qty: 1, printingStatus: "partial" },
      { name: "Llanowar Elves", qty: 3 },
      { name: "Rhystic Study", qty: 1 },
      { name: "Arcane Signet", qty: 1 },
      { name: "Island", qty: 4 },
    ],
    stockOf({ "Sol Ring": 1, "Llanowar Elves": 1, "Arcane Signet": 1, "Island": 1 })
  );
  assert.equal(a.total, 6, "terrains de base exclus du total");
  // Bloquants : 2 Llanowar Elves + 1 Rhystic Study + 1 Sol Ring (version).
  assert.equal(a.blocking, 4);
  assert.equal(a.missingCount, 3);
  assert.equal(a.wrongEditionCount, 1);
  // Utilisables : 6 − 4 bloquants ; les Island manquantes ne comptent pas.
  assert.equal(a.available, 2);
  assert.deepEqual(a.shortages, [
    { name: "Llanowar Elves", missing: 2 },
    { name: "Rhystic Study", missing: 1 },
  ]);
  assert.deepEqual(a.wrongEdition, ["Sol Ring"]);
  assert.deepEqual(a.basicShortages, [{ name: "Island", missing: 3 }]);
});

test("computeDeckAvailability : terrains de base manquants ou d'une autre version, deck montable", () => {
  const a = computeDeckAvailability([{ name: "Forest", qty: 2, printingStatus: "partial" }], {});
  assert.equal(a.blocking, 0);
  assert.equal(a.total, 0);
  assert.equal(a.available, 0);
  assert.deepEqual(a.wrongEdition, []);
});

test("computeDeckAvailability : carte en stock insuffisant jamais comptée deux fois", () => {
  // Statut « partial » mais stock insuffisant : seulement un manque.
  const a = computeDeckAvailability([{ name: "Sol Ring", qty: 2, printingStatus: "partial" }], stockOf({ "Sol Ring": 1 }));
  assert.equal(a.blocking, 1);
  assert.deepEqual(a.wrongEdition, []);
});

test("computeDeckAvailability : information de version donnée à part (liste saisie)", () => {
  const a = computeDeckAvailability([{ name: "Sol Ring", qty: 1 }], stockOf({ "Sol Ring": 1 }), new Set(["sol ring"]));
  assert.equal(a.blocking, 1);
  assert.deepEqual(a.wrongEdition, ["Sol Ring"]);
});

// Cas réel : la pastille affichait 80, la fenêtre « 27 » (version) et
// « 53 » (stock) dans deux encadrés séparés, sans total.
test("blockingSummary : total de la pastille décomposé comme dans la fenêtre", () => {
  const cards = [
    ...Array.from({ length: 53 }, (_, i) => ({ name: `Manquante ${i}`, qty: 1 })),
    ...Array.from({ length: 27 }, (_, i) => ({ name: `Version ${i}`, qty: 1, printingStatus: "partial" })),
    { name: "Possédée", qty: 1 },
  ];
  const stock = stockOf(Object.fromEntries(cards.slice(53).map((c) => [c.name, 1])));
  const a = computeDeckAvailability(cards, stock);
  assert.equal(a.blocking, 80);
  assert.equal(blockingSummary(a), "80 cartes bloquent le montage : 53 manquantes en stock, 27 dans une autre version");
});

test("blockingSummary : singulier, motif unique, rien de bloquant", () => {
  assert.equal(
    blockingSummary(computeDeckAvailability([{ name: "Sol Ring", qty: 1 }], {})),
    "1 carte bloque le montage : 1 manquante en stock"
  );
  assert.equal(
    blockingSummary(computeDeckAvailability([{ name: "Sol Ring", qty: 1, printingStatus: "partial" }], stockOf({ "Sol Ring": 1 }))),
    "1 carte bloque le montage : 1 dans une autre version"
  );
  assert.equal(blockingSummary(computeDeckAvailability([{ name: "Island", qty: 3 }], {})), null);
});

test("availabilityLabel : deck montable", () => {
  const label = availabilityLabel(computeDeckAvailability([{ name: "Sol Ring", qty: 1 }], stockOf({ "Sol Ring": 1 })));
  assert.equal(label, "montable : 1/1 cartes disponibles en stock libre, hors terrains de base");
});

test("availabilityLabel : détail des problèmes", () => {
  const label = availabilityLabel(
    computeDeckAvailability(
      [
        { name: "Sol Ring", qty: 1, printingStatus: "partial" },
        { name: "Rhystic Study", qty: 1 },
        { name: "Island", qty: 2 },
      ],
      stockOf({ "Sol Ring": 1 })
    )
  );
  assert.equal(
    label,
    "2 cartes bloquent le montage : 1 manquante en stock, 1 dans une autre version " +
      "(0/2 cartes disponibles en stock libre, hors terrains de base) — manque Rhystic Study (1) — " +
      "version différente : Sol Ring — terrains de base manquants (non bloquant) : Island (2)"
  );
});

test("availabilityLabel : longues listes tronquées", () => {
  const cards = Array.from({ length: 10 }, (_, i) => ({ name: `Carte ${i + 1}`, qty: 1 }));
  const label = availabilityLabel(computeDeckAvailability(cards, {}));
  assert.ok(label.includes("Carte 8 (1), … (+2)"), label);
  assert.ok(!label.includes("Carte 9"), label);
});
