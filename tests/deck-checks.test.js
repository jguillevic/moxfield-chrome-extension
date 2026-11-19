// Tests des contrôles d'une liste par rapport au stock (deck-checks.js) : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDeckScraper } = require("../deck-scraper.js");
const { createDeckChecks } = require("../deck-checks.js");
const { loadI18n } = require("./helpers");

// normalizeName ne dépend pas de la page : une fenêtre vide suffit.
const { normalizeName } = createDeckScraper({ document: {} });
const checks = createDeckChecks(normalizeName, loadI18n());
const {
  isBasicLand,
  buildWrongEditionSet,
  computeWrongEditionCards,
  computeShortages,
  computeShortagePrices,
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
    versionTakenCount: 0,
    shortages: [],
    wrongEdition: [],
    versionTaken: [],
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

// --- Version déjà utilisée par un autre deck monté ---

const { buildVersionUsage, computeVersionConflicts } = checks;

// Steam Vents possédée en deux éditions, un exemplaire de chaque : 2 au
// total. free : exemplaires encore libres.
function steamVentsStock(free, printings = [{ set: "grn", cn: "257", qty: 1 }, { set: "rna", cn: "257", qty: 1 }]) {
  return { "steam vents": { name: "Steam Vents", qty: free, printings } };
}

const builtWith = (versions, extra = {}) => ({
  a: { name: "Deck A", cards: [{ name: "Steam Vents", qty: versions.reduce((n, v) => n + v.qty, 0), versions, ...extra }] },
});

test("buildVersionUsage : versions des decks montés, sauf deck exclu et cartes hors stock", () => {
  const decks = {
    ...builtWith([{ code: "AAAAA", qty: 1 }]),
    b: { name: "Deck B", cards: [{ name: "steam vents", qty: 1, versions: [{ code: "BBBBB", qty: 1 }] }, { name: "Sol Ring", qty: 1 }] },
    c: { name: "Deck C", cards: [{ name: "Steam Vents", qty: 1, versions: [{ code: "CCCCC", qty: 1 }], excludedFromStock: true }] },
  };
  assert.deepEqual([...buildVersionUsage(decks)], [
    ["steam vents", [{ code: "AAAAA", qty: 1, deck: "Deck A" }, { code: "BBBBB", qty: 1, deck: "Deck B" }]],
  ]);
  assert.deepEqual([...buildVersionUsage(decks, "a").get("steam vents")], [{ code: "BBBBB", qty: 1, deck: "Deck B" }]);
});

test("version déjà utilisée : même version demandée par un second deck, possédée une seule fois", () => {
  // Cas constaté en vrai (novembre 2026) : un terrain possédé en x1 dans
  // deux éditions, utilisé deux fois dans la même.
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1 }]));
  const card = { name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] };
  assert.deepEqual(computeVersionConflicts([card], steamVentsStock(1), usage), [
    {
      name: "Steam Vents",
      qty: 1,
      decks: [{ name: "Deck A", qty: 1 }],
      owned: [{ set: "grn", cn: "257", qty: 1 }, { set: "rna", cn: "257", qty: 1 }],
    },
  ]);
});

test("version déjà utilisée : l'autre version reste montable", () => {
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1 }]));
  const card = { name: "Steam Vents", qty: 1, versions: [{ code: "BBBBB", qty: 1 }] };
  assert.deepEqual(computeVersionConflicts([card], steamVentsStock(1), usage), []);
});

test("version déjà utilisée : rien sans détail par édition, sans version lue ou sans autre deck", () => {
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1 }]));
  const card = { name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] };
  // Une seule édition possédée : le stock par nom suffit.
  assert.deepEqual(computeVersionConflicts([card], { "steam vents": { name: "Steam Vents", qty: 1 } }, usage), []);
  // Liste collée : version inconnue.
  assert.deepEqual(computeVersionConflicts([{ name: "Steam Vents", qty: 1 }], steamVentsStock(1), usage), []);
  assert.deepEqual(computeVersionConflicts([card], steamVentsStock(2), new Map()), []);
});

test("version déjà utilisée : éditions en quantités inégales, le doute profite au montage", () => {
  const stock = steamVentsStock(2, [{ set: "grn", cn: "257", qty: 2 }, { set: "rna", cn: "257", qty: 1 }]);
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1 }]));
  const card = { name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] };
  assert.deepEqual(computeVersionConflicts([card], stock, usage), [], "la version peut être celle possédée en x2");
  // Troisième exemplaire de la même version : plus aucune édition ne le couvre.
  const usage3 = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 2 }]));
  assert.equal(computeVersionConflicts([card], { "steam vents": { ...stock["steam vents"], qty: 1 } }, usage3).length, 1);
});

test("version déjà utilisée : plus de versions différentes que d'éditions possédées", () => {
  const decks = {
    ...builtWith([{ code: "AAAAA", qty: 1 }]),
    b: { name: "Deck B", cards: [{ name: "Steam Vents", qty: 1, versions: [{ code: "BBBBB", qty: 1 }] }] },
  };
  const stock = steamVentsStock(1, [{ set: "grn", cn: "257", qty: 2 }, { set: "rna", cn: "257", qty: 1 }]);
  const card = { name: "Steam Vents", qty: 1, versions: [{ code: "CCCCC", qty: 1 }] };
  const [conflict] = computeVersionConflicts([card], stock, buildVersionUsage(decks));
  assert.deepEqual(conflict.decks, [], "aucun deck ne détient cette version précise");
});

test("version déjà utilisée : priorité au stock insuffisant et à la version différente", () => {
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1 }]));
  const card = { name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] };
  assert.deepEqual(computeVersionConflicts([card], steamVentsStock(0), usage), [], "stock insuffisant d'abord");
  assert.deepEqual(computeVersionConflicts([card], steamVentsStock(1), usage, new Set(["steam vents"])), [], "version différente d'abord");
});

test("computeDeckAvailability : version déjà utilisée comptée dans les cartes bloquantes", () => {
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1 }]));
  const cards = [
    { name: "Steam Vents", qty: 1, printingStatus: "full", versions: [{ code: "AAAAA", qty: 1 }] },
    { name: "Sol Ring", qty: 1, printingStatus: "full", versions: [{ code: "SSSSS", qty: 1 }] },
  ];
  const stock = { ...steamVentsStock(1), ...stockOf({ "Sol Ring": 1 }) };
  const a = computeDeckAvailability(cards, stock, undefined, usage);
  assert.equal(a.blocking, 1);
  assert.equal(a.versionTakenCount, 1);
  assert.deepEqual(a.versionTaken, ["Steam Vents"]);
  assert.equal(blockingSummary(a), "1 carte bloque le montage : 1 dont la version est déjà dans un autre deck");
  assert.match(availabilityLabel(a), /version déjà utilisée par un autre deck monté : Steam Vents/);
  // Sans les versions des decks montés : rien ne bloque.
  assert.equal(computeDeckAvailability(cards, stock).blocking, 0);
});

test("evaluateDeckUpdate : changement de version vers une version déjà prise, bloqué", () => {
  // Le deck mis à jour détient la version B ; un autre deck détient la A.
  const deck = { cards: [{ name: "Steam Vents", qty: 1, versions: [{ code: "BBBBB", qty: 1 }] }] };
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1 }]));
  const changes = [{ name: "Steam Vents", from: 1, to: 1, version: true }];
  const toTaken = [{ name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] }];
  const check = evaluateDeckUpdate(changes, deck, steamVentsStock(0), new Set(), toTaken, usage);
  assert.equal(check.blocked, true);
  assert.deepEqual(check.versionTaken.map((c) => c.name), ["Steam Vents"]);
  assert.deepEqual(check.shortages, [], "l'exemplaire du deck lui est rendu d'abord");

  const toFree = [{ name: "Steam Vents", qty: 1, versions: [{ code: "CCCCC", qty: 1 }] }];
  assert.equal(evaluateDeckUpdate(changes, deck, steamVentsStock(0), new Set(), toFree, usage).blocked, false);
});

test("evaluateDeckUpdate : changement vers une version non possédée, bloqué comme version différente", () => {
  const deck = { cards: [{ name: "Steam Vents", qty: 1, versions: [{ code: "BBBBB", qty: 1 }] }] };
  const changes = [{ name: "Steam Vents", from: 1, to: 1, version: true }];
  const check = evaluateDeckUpdate(changes, deck, steamVentsStock(1), new Set(["steam vents"]), [{ name: "Steam Vents", qty: 1, versions: [] }]);
  assert.deepEqual(check.wrongEdition, ["Steam Vents"]);
  assert.equal(check.blocked, true);
});

// --- Contrôle exact : versions dont l'API du deck a donné l'édition ---

const GRN = { set: "grn", cn: "257" };
const RNA = { set: "rna", cn: "257" };
// GRN possédée en x2, RNA en x1 : le cas que le recoupement ne tranche pas.
const UNEQUAL = [{ ...GRN, qty: 2 }, { ...RNA, qty: 1 }];

test("buildVersionUsage : édition et numéro transmis quand ils sont connus", () => {
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1, ...RNA }]));
  assert.deepEqual(usage.get("steam vents"), [{ code: "AAAAA", qty: 1, deck: "Deck A", set: "rna", cn: "257" }]);
});

test("contrôle exact : éditions en quantités inégales, l'édition possédée en x1 n'est pas montée deux fois", () => {
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1, ...RNA }]));
  const stock = steamVentsStock(2, UNEQUAL);
  // Même édition sous un autre code (ex. autre langue) : le recoupement y
  // verrait deux versions différentes.
  const again = { name: "Steam Vents", qty: 1, versions: [{ code: "BBBBB", qty: 1, ...RNA }] };
  assert.deepEqual(computeVersionConflicts([again], stock, usage), [
    { name: "Steam Vents", qty: 1, decks: [{ name: "Deck A", qty: 1 }], owned: UNEQUAL },
  ]);
  const other = { name: "Steam Vents", qty: 2, versions: [{ code: "CCCCC", qty: 2, ...GRN }] };
  assert.deepEqual(computeVersionConflicts([other], stock, usage), [], "l'autre édition est libre, en x2");
});

test("contrôle exact : même code que l'autre deck, édition possédée en x2", () => {
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1, ...GRN }]));
  const card = { name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1, ...GRN }] };
  assert.deepEqual(computeVersionConflicts([card], steamVentsStock(2, UNEQUAL), usage), []);
  const two = { name: "Steam Vents", qty: 2, versions: [{ code: "AAAAA", qty: 2, ...GRN }] };
  assert.equal(computeVersionConflicts([two], steamVentsStock(2, UNEQUAL), usage).length, 1, "trois exemplaires demandés pour deux possédés");
});

test("contrôle exact : repli sur le recoupement dès qu'une édition manque", () => {
  const stock = steamVentsStock(2, UNEQUAL);
  const asked = { name: "Steam Vents", qty: 1, versions: [{ code: "BBBBB", qty: 1, ...RNA }] };
  // L'autre deck n'a pas son édition (monté avant, API pas lue) : il peut
  // détenir l'une ou l'autre, le doute profite au montage.
  assert.deepEqual(computeVersionConflicts([asked], stock, buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1 }]))), []);
  // Édition absente de la collection (collection pas à jour, code d'édition
  // différent entre l'API et le CSV) : on ne conclut rien de plus.
  const unknownSet = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1, set: "gpt", cn: "1" }]));
  assert.deepEqual(computeVersionConflicts([asked], stock, unknownSet), []);
  // Même code que l'autre deck, dont seule la page connaît l'édition : sans
  // repli, l'exemplaire de l'autre deck ne serait pas compté.
  const sameCode = { name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1, ...RNA }] };
  assert.equal(computeVersionConflicts([sameCode], steamVentsStock(1), buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1 }]))).length, 1);
  // Le recoupement continue de refuser ce qu'il refusait.
  const same = { name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] };
  assert.equal(computeVersionConflicts([same], steamVentsStock(1), buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1, ...GRN }]))).length, 1);
});

test("contrôle exact : édition demandée au-delà du possédé sans autre deck en cause, pas de refus", () => {
  // Page et collection en désaccord (collection pas encore récupérée) : ce
  // n'est pas une version « déjà utilisée ».
  const usage = buildVersionUsage(builtWith([{ code: "AAAAA", qty: 1, ...GRN }]));
  const card = { name: "Steam Vents", qty: 2, versions: [{ code: "BBBBB", qty: 2, ...RNA }] };
  assert.deepEqual(computeVersionConflicts([card], steamVentsStock(2, UNEQUAL), usage), []);
});

// --- Prix des cartes manquantes ---

test("computeShortagePrices : prix de la version du deck × quantité manquante, total", () => {
  const prices = { SOL: 1.5, ELF1: 0.3, ELF2: 0.25 };
  const codes = new Map([
    ["sol ring", ["SOL"]],
    // Deux versions dans le deck : la moins chère.
    ["llanowar elves", ["ELF1", "ELF2"]],
  ]);
  const shortages = computeShortages([{ name: "SOL RING", qty: 1 }, { name: "Llanowar Elves", qty: 3 }], stockOf({ "Llanowar Elves": 1 }));
  const result = computeShortagePrices(shortages, codes, (code) => prices[code]);
  assert.deepEqual([...result.byName], [
    ["sol ring", { unit: 1.5, total: 1.5 }],
    ["llanowar elves", { unit: 0.25, total: 0.5 }],
  ]);
  assert.equal(result.total, 2);
  assert.equal(result.unpriced, 0);
});

test("computeShortagePrices : cartes sans version ou sans prix comptées à part", () => {
  const codes = new Map([["sol ring", ["SOL"]], ["counterspell", ["CS"]]]);
  const shortages = computeShortages(
    [{ name: "Sol Ring", qty: 1 }, { name: "Counterspell", qty: 1 }, { name: "Arcane Signet", qty: 1 }],
    stockOf({})
  );
  const result = computeShortagePrices(shortages, codes, (code) => (code === "SOL" ? 2 : undefined));
  assert.deepEqual([...result.byName.keys()], ["sol ring"]);
  assert.equal(result.total, 2);
  assert.equal(result.unpriced, 2);
  assert.deepEqual(computeShortagePrices([], codes, () => 1), { byName: new Map(), total: 0, unpriced: 0 });
});

test("computeShortagePrices : total exact au centime", () => {
  // En virgule flottante, 0,1 + 0,2 + 0,1 × 3 vaut 0,6000000000000001.
  const codes = new Map(["a", "b", "c"].map((n) => [n, [n.toUpperCase()]]));
  const shortages = computeShortages([{ name: "A", qty: 1 }, { name: "B", qty: 1 }, { name: "C", qty: 3 }], stockOf({}));
  const result = computeShortagePrices(shortages, codes, (code) => ({ A: 0.1, B: 0.2, C: 0.1 })[code]);
  assert.equal(result.total, 0.6);
  assert.equal(result.byName.get("c").total, 0.3);
});

// --- Proxies ---

const { proxyCountOf, stockQtyOf, proxyTotal, addProxies, carryProxies, replaceableProxies } = checks;

test("proxies : exemplaires en proxy et exemplaires pris au stock", () => {
  assert.equal(proxyCountOf({ name: "Sol Ring", qty: 2, proxyQty: 1 }), 1);
  assert.equal(stockQtyOf({ name: "Sol Ring", qty: 2, proxyQty: 1 }), 1);
  assert.equal(stockQtyOf({ name: "Sol Ring", qty: 2 }), 2);
  assert.equal(stockQtyOf({ name: "Sol Ring", qty: 2, excludedFromStock: true }), 0);
  // Valeurs invalides : aucun proxy ; jamais plus que la quantité.
  for (const proxyQty of [0, -1, 1.5, "1", null]) assert.equal(proxyCountOf({ name: "Sol Ring", qty: 2, proxyQty }), 0, String(proxyQty));
  assert.equal(proxyCountOf({ name: "Sol Ring", qty: 2, proxyQty: 5 }), 2);
  assert.equal(proxyTotal([{ name: "A", qty: 2, proxyQty: 1 }, { name: "B", qty: 3, proxyQty: 3 }, { name: "C", qty: 1 }]), 4);
});

test("addProxies : exemplaires manquants en proxy, avec la version du deck", () => {
  const cards = [{ name: "Sol Ring", qty: 2, versions: [{ code: "SOL", qty: 2 }] }, { name: "Counterspell", qty: 1 }, { name: "Island", qty: 5 }];
  const shortages = [{ name: "SOL RING", have: 1, need: 2, missing: 1 }, { name: "Counterspell", have: 0, need: 1, missing: 1 }];
  const printingOf = (name) => (name === "Sol Ring" ? { set: "c21", cn: "263" } : null);
  assert.deepEqual(addProxies(cards, shortages, printingOf), [
    { name: "Sol Ring", qty: 2, versions: [{ code: "SOL", qty: 2 }], proxyQty: 1, proxyPrinting: { set: "c21", cn: "263" } },
    { name: "Counterspell", qty: 1, proxyQty: 1 },
    { name: "Island", qty: 5 },
  ]);
  // Proxies déjà présents (mise à jour) : les nouveaux s'y ajoutent.
  assert.deepEqual(addProxies([{ name: "Sol Ring", qty: 3, proxyQty: 1 }], [{ name: "Sol Ring", missing: 1 }]), [{ name: "Sol Ring", qty: 3, proxyQty: 2 }]);
});

test("carryProxies : chaque carte garde ses proxies, dans la limite de sa nouvelle quantité", () => {
  const before = [
    { name: "Sol Ring", qty: 2, proxyQty: 2, proxyPrinting: { set: "c21", cn: "263" } },
    { name: "Counterspell", qty: 1, proxyQty: 1 },
    { name: "Arcane Signet", qty: 1 },
  ];
  const after = [{ name: "Sol Ring", qty: 1 }, { name: "Arcane Signet", qty: 2 }, { name: "Llanowar Elves", qty: 1 }];
  assert.deepEqual(carryProxies(after, before), [
    { name: "Sol Ring", qty: 1, proxyQty: 1, proxyPrinting: { set: "c21", cn: "263" } },
    { name: "Arcane Signet", qty: 2 },
    { name: "Llanowar Elves", qty: 1 },
  ]);
});

test("replaceableProxies : proxies que le stock libre permet de remplacer", () => {
  const deck = {
    cards: [
      { name: "Sol Ring", qty: 2, proxyQty: 2 },
      { name: "Counterspell", qty: 1, proxyQty: 1 },
      { name: "Arcane Signet", qty: 1 },
      { name: "Swords to Plowshares", qty: 1, proxyQty: 1, excludedFromStock: true },
    ],
  };
  const stock = stockOf({ "Sol Ring": 1, Counterspell: 0, "Arcane Signet": 4, "Swords to Plowshares": 3 });
  assert.deepEqual(replaceableProxies(deck, stock), [{ name: "Sol Ring", qty: 1 }]);
  assert.deepEqual(replaceableProxies(deck, stockOf({ "Sol Ring": -1 })), [], "stock négatif");
  // Deux lignes du même nom : le même stock n'est pas compté deux fois.
  const twice = { cards: [{ name: "Sol Ring", qty: 1, proxyQty: 1 }, { name: "sol ring", qty: 1, proxyQty: 1 }] };
  assert.deepEqual(replaceableProxies(twice, stockOf({ "Sol Ring": 1 })), [{ name: "Sol Ring", qty: 1 }]);
});

test("buildVersionUsage : un proxy ne tient aucune version", () => {
  const decks = {
    // 2 exemplaires dont 1 sans version possédée : le proxy est celui-là.
    a: { name: "A", cards: [{ name: "Sol Ring", qty: 2, proxyQty: 1, versions: [{ code: "S1", qty: 1 }] }] },
    // Toutes les versions possédées : le proxy en retire une.
    b: { name: "B", cards: [{ name: "Counterspell", qty: 2, proxyQty: 1, versions: [{ code: "C1", qty: 2 }] }] },
    // Entièrement en proxy.
    c: { name: "C", cards: [{ name: "Arcane Signet", qty: 1, proxyQty: 1, versions: [{ code: "A1", qty: 1 }] }] },
  };
  const usage = buildVersionUsage(decks);
  assert.deepEqual(usage.get("sol ring"), [{ code: "S1", qty: 1, deck: "A" }]);
  assert.deepEqual(usage.get("counterspell"), [{ code: "C1", qty: 1, deck: "B" }]);
  assert.equal(usage.get("arcane signet"), undefined);
});

test("evaluateDeckUpdate : les proxies du deck restent, seuls les autres exemplaires sont à prendre", () => {
  // 1 vraie + 1 proxy ; la page en demande 3 : il manque 1 exemplaire.
  const deck = { cards: [{ name: "Sol Ring", qty: 2, proxyQty: 1 }] };
  const check = evaluateDeckUpdate([{ name: "Sol Ring", from: 2, to: 3 }], deck, stockOf({ "Sol Ring": 0 }), new Set());
  assert.deepEqual(check.shortages, [{ name: "Sol Ring", have: 1, need: 2, missing: 1 }]);
  // Le proxy n'est pas rendu au stock : 1 seul exemplaire disponible.
  const enough = evaluateDeckUpdate([{ name: "Sol Ring", from: 2, to: 3 }], deck, stockOf({ "Sol Ring": 1 }), new Set());
  assert.equal(enough.blocked, false);
  // Carte entièrement en proxy, dont seule la version change : rien à vérifier.
  const proxied = { cards: [{ name: "Counterspell", qty: 1, proxyQty: 1 }] };
  const version = evaluateDeckUpdate([{ name: "Counterspell", from: 1, to: 1, version: true }], proxied, stockOf({}), new Set(["counterspell"]));
  assert.equal(version.blocked, false);
});

// --- Passer un deck sur les éditions de la collection ---

const { chooseOwnedEdition } = checks;

test("chooseOwnedEdition : l'édition possédée la plus libre, jamais celle du deck", () => {
  const owned = [
    { set: "rav", cn: "87", qty: 1 },
    { set: "dds", cn: "50", qty: 2 },
    { set: "c21", cn: "1", qty: 1 },
  ];
  const current = { set: "rav", cn: "87" };
  assert.deepEqual(chooseOwnedEdition(owned, current), { set: "dds", cn: "50" }, "la plus fournie");
  // Les 2 DDS sont dans d'autres decks montés : la C21, libre.
  const others = [{ code: "X", qty: 2, deck: "A", set: "dds", cn: "50" }, { code: "Y", qty: 1, deck: "B" }];
  assert.deepEqual(chooseOwnedEdition(owned, current, others), { set: "c21", cn: "1" });
  assert.equal(chooseOwnedEdition([{ set: "rav", cn: "87", qty: 3 }], current), null, "aucune autre édition");
  assert.equal(chooseOwnedEdition([], current), null);
});

test("chooseOwnedEdition : même édition possédée dans une autre finition (constaté en vrai)", () => {
  // Possédée seulement en foil, le deck demande la non-foil : seule la
  // finition change, même si une autre édition est possédée.
  const owned = [
    { set: "rav", cn: "87", qty: 1, finishes: { foil: 1 } },
    { set: "dds", cn: "50", qty: 3, finishes: { nonFoil: 3 } },
  ];
  assert.deepEqual(chooseOwnedEdition(owned, { set: "rav", cn: "87", finish: "nonFoil" }), { set: "rav", cn: "87", finish: "foil" });
  // Foil possédée aussi dans la finition du deck : foil d'abord.
  const both = [{ set: "rav", cn: "87", qty: 2, finishes: { foil: 1, nonFoil: 1 } }, owned[1]];
  assert.deepEqual(chooseOwnedEdition(both, { set: "rav", cn: "87", finish: "nonFoil" }), { set: "rav", cn: "87", finish: "foil" });
  // Déjà en foil dans le deck : rien à changer sur cette édition.
  assert.deepEqual(chooseOwnedEdition(both, { set: "rav", cn: "87", finish: "foil" }), { set: "dds", cn: "50", finish: "nonFoil" });
  // Seulement la finition du deck dans son édition : on passe à une autre édition.
  const exact = [{ set: "rav", cn: "87", qty: 2, finishes: { nonFoil: 2 } }, owned[1]];
  assert.deepEqual(chooseOwnedEdition(exact, { set: "rav", cn: "87", finish: "nonFoil" }), { set: "dds", cn: "50" });
  // Plusieurs finitions possédées, aucune celle du deck : la plus fournie.
  const many = [{ set: "rav", cn: "87", qty: 3, finishes: { etched: 1, foil: 2 } }];
  assert.deepEqual(chooseOwnedEdition(many, { set: "rav", cn: "87", finish: "nonFoil" }), { set: "rav", cn: "87", finish: "foil" });
  // Finition du deck inconnue : pas de changement de finition.
  assert.equal(chooseOwnedEdition([owned[0]], { set: "rav", cn: "87" }), null);
});

test("chooseOwnedEdition : autre édition, finition possédée plutôt que celle du deck", () => {
  const current = { set: "rav", cn: "87", finish: "nonFoil" };
  assert.deepEqual(
    chooseOwnedEdition([{ set: "dds", cn: "50", qty: 1, finishes: { foil: 1 } }], current),
    { set: "dds", cn: "50", finish: "foil" },
    "possédée seulement en foil"
  );
  assert.deepEqual(
    chooseOwnedEdition([{ set: "dds", cn: "50", qty: 2, finishes: { foil: 1, nonFoil: 1 } }], current),
    { set: "dds", cn: "50", finish: "foil" },
    "foil d'abord, même si la finition du deck est possédée"
  );
  assert.deepEqual(
    chooseOwnedEdition([{ set: "dds", cn: "50", qty: 3, finishes: { etched: 1, nonFoil: 2 } }], current),
    { set: "dds", cn: "50" },
    "sans foil : finition du deck gardée"
  );
});

test("chooseOwnedEdition : seulement une édition qui couvre toute la quantité du deck (terrains de base, constaté en vrai)", () => {
  // 11 Plains dans le deck, réparties sur plusieurs éditions dans la collection.
  const current = { set: "rav", cn: "87", finish: "nonFoil", quantity: 11 };
  const spread = [
    { set: "war", cn: "1", qty: 4, finishes: { nonFoil: 4 } },
    { set: "m21", cn: "2", qty: 5, finishes: { nonFoil: 5 } },
  ];
  assert.equal(chooseOwnedEdition(spread, current), null, "aucune n'en a 11");
  const enough = [...spread, { set: "dmu", cn: "3", qty: 11, finishes: { nonFoil: 11 } }];
  assert.deepEqual(chooseOwnedEdition(enough, current), { set: "dmu", cn: "3" });
  // Foil seulement pour une partie : la finition du deck est gardée.
  const mixed = [{ set: "dmu", cn: "3", qty: 11, finishes: { foil: 1, nonFoil: 10 } }];
  assert.deepEqual(chooseOwnedEdition(mixed, { ...current, quantity: 10 }), { set: "dmu", cn: "3" });
  // Même édition, pas assez d'exemplaires dans l'autre finition : rien.
  const sameFoil = [{ set: "rav", cn: "87", qty: 1, finishes: { foil: 1 } }];
  assert.equal(chooseOwnedEdition(sameFoil, { ...current, quantity: 2 }), null);
  assert.deepEqual(chooseOwnedEdition(sameFoil, { ...current, quantity: 1 }), { set: "rav", cn: "87", finish: "foil" });
});

test("chooseOwnedEdition : entre éditions également libres, celle possédée en foil d'abord", () => {
  const current = { set: "rav", cn: "87", finish: "nonFoil" };
  const owned = [
    { set: "znr", cn: "1", qty: 1, finishes: { foil: 1 } },
    { set: "dds", cn: "50", qty: 1, finishes: { nonFoil: 1 } },
  ];
  assert.deepEqual(chooseOwnedEdition(owned, current), { set: "znr", cn: "1", finish: "foil" });
  // Plus d'exemplaires libres l'emporte sur le foil.
  const more = [owned[0], { set: "dds", cn: "50", qty: 3, finishes: { nonFoil: 3 } }];
  assert.deepEqual(chooseOwnedEdition(more, current), { set: "dds", cn: "50" });
});
