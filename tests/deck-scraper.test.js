// Tests de la lecture des decks (deck-scraper.js) : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { FIXTURES_DIR, loadPage, summarize, totalOf } = require("./helpers");

// Même deck de 7 cartes dans toutes les pages de test (fixtures/*.html).
const FULL_DFC = "Revitalizing Repast // Old-Growth Grove";
const EXPECTED_VISUAL = [
  "1 Birds of Paradise",
  "1 Golgari Thug",
  `1 ${FULL_DFC}`,
  "1 Sidisi, Brood Tyrant",
  "3 Swamp",
];
// La vue Text ne donne que la face avant des cartes double face ; le nom
// complet est retrouvé ensuite par completeCardNames (testé plus bas).
const EXPECTED_TEXT = EXPECTED_VISUAL.map((l) => l.replace(FULL_DFC, "Revitalizing Repast"));

const VIEWS = [
  { name: "Text", fixture: "text.html", viewMode: "table", expected: EXPECTED_TEXT },
  { name: "Condensed Text", fixture: "condensed.html", viewMode: "condensedTable", expected: EXPECTED_TEXT },
  { name: "Visual Grid", fixture: "grid.html", viewMode: "visual", expected: EXPECTED_VISUAL },
  { name: "Visual Stacks", fixture: "stacks.html", viewMode: "stacks", expected: EXPECTED_VISUAL },
  { name: "Visual Stacks (Split)", fixture: "split.html", viewMode: "splitStacks", expected: EXPECTED_VISUAL },
  { name: "Visual Spoiler", fixture: "spoiler.html", viewMode: "spoiler", expected: EXPECTED_VISUAL },
];

for (const view of VIEWS) {
  test(`${view.name} : liste et quantités détectées`, () => {
    const scraper = loadPage(view.fixture, view.viewMode);
    assert.deepEqual(summarize(scraper.scrapeCardsGuess()), [...view.expected].sort());
  });

  test(`${view.name} : total détecté = total annoncé par Moxfield`, () => {
    const scraper = loadPage(view.fixture, view.viewMode);
    assert.equal(scraper.getSiteDeclaredTotal(), 7);
    assert.equal(totalOf(scraper.scrapeCardsGuess()), 7);
  });

  test(`${view.name} : les cartes de la zone Considering sont exclues`, () => {
    const cards = loadPage(view.fixture, view.viewMode).scrapeCardsGuess();
    assert.ok(!cards.some((c) => c.name === "Arboreal Grazer"), "carte de Considering comptée");
    assert.equal(cards.find((c) => c.name === "Birds of Paradise").qty, 1);
  });

  test(`${view.name} : carte possédée dans une autre version repérée`, () => {
    const scraper = loadPage(view.fixture, view.viewMode);
    const birds = scraper.scrapeCardsGuess().find((c) => c.name === "Birds of Paradise");
    assert.equal(birds.printingStatus, "partial");
  });
}

test("Visual Stacks : une tuile recréée après modification ne compte qu'une fois", () => {
  const scraper = loadPage("stacks.html", "stacks");
  const birds = scraper.scrapeCardsGuess().find((c) => c.name === "Birds of Paradise");
  assert.equal(birds.qty, 1);
});

test("Visual Stacks : une tuile périmée sans marqueur de collection est écartée au profit de la vraie", () => {
  const scraper = loadPage("stacks.html", "stacks");
  const thug = scraper.scrapeCardsGuess().find((c) => c.name === "Golgari Thug");
  assert.equal(thug.qty, 1);
});

test("Visual Stacks : les images de l'aperçu latéral (Transform, Back, Front) sont ignorées", () => {
  const scraper = loadPage("stacks.html", "stacks");
  const names = scraper.scrapeCardsGuess().map((c) => c.name);
  for (const n of ["Transform", "Back", "Front"]) assert.ok(!names.includes(n), `${n} détectée comme carte`);
});

test("Visual Grid : les restes cachés d'une autre vue sont ignorés", () => {
  const scraper = loadPage("grid.html", "visual");
  assert.ok(!scraper.scrapeCardsGuess().some((c) => c.name === "Sol Ring"));
});

test("Sélecteur de vue incohérent : la détection se rabat sur une autre méthode", () => {
  // Vue annoncée "Text" alors que la page affiche des tuiles : aucune ligne
  // de liste, on doit quand même trouver les cartes.
  const scraper = loadPage("grid.html", "table");
  assert.deepEqual(summarize(scraper.scrapeCardsGuess()), [...EXPECTED_VISUAL].sort());
});

test("Total Moxfield absent : getSiteDeclaredTotal renvoie null", () => {
  const scraper = loadPage("text.html", "table");
  scraper.document.querySelector("footer").remove();
  assert.equal(scraper.getSiteDeclaredTotal(), null);
});

test("Total Moxfield masqué : pas pris en compte", () => {
  const scraper = loadPage("text.html", "table");
  scraper.document.querySelector("footer").style.display = "none";
  assert.equal(scraper.getSiteDeclaredTotal(), null);
});

test("completeCardNames : la face avant seule retrouve le nom complet", () => {
  const scraper = loadPage("text.html", "table");
  const stock = [{ name: FULL_DFC, qty: 1 }];
  const completed = scraper.completeCardNames(scraper.scrapeCardsGuess(), stock);
  assert.deepEqual(summarize(completed), [...EXPECTED_VISUAL].sort());
});

test("computeDeckDiff : même deck lu dans deux vues différentes → aucune différence", () => {
  const grid = loadPage("grid.html", "visual").scrapeCardsGuess();
  const textScraper = loadPage("text.html", "table");
  const text = textScraper.completeCardNames(textScraper.scrapeCardsGuess(), grid);
  for (const other of ["stacks.html:stacks", "split.html:splitStacks"]) {
    const [fixture, mode] = other.split(":");
    assert.deepEqual(textScraper.computeDeckDiff(loadPage(fixture, mode).scrapeCardsGuess(), grid), []);
  }
  assert.deepEqual(textScraper.computeDeckDiff(grid, text), []);
});

test("computeDeckDiff : ajouts, retraits et changements de quantité", () => {
  const { computeDeckDiff } = loadPage("text.html", "table");
  const before = [{ name: "Sol Ring", qty: 1 }, { name: "Swamp", qty: 3 }, { name: "Rhystic Study", qty: 1 }];
  const after = [{ name: "sol ring", qty: 1 }, { name: "Swamp", qty: 5 }, { name: "Counterspell", qty: 1 }];
  assert.deepEqual(computeDeckDiff(before, after), [
    { name: "Counterspell", from: 0, to: 1 },
    { name: "Rhystic Study", from: 1, to: 0 },
    { name: "Swamp", from: 3, to: 5 },
  ]);
});

// --- Pages réelles enregistrées (facultatif) ---
// tests/fixtures/pages/<nom>.html : copie d'une vraie page de deck Moxfield
// (DevTools → Elements → clic droit sur <html> → Copy → Copy outerHTML).
// tests/fixtures/pages/<nom>.json : { "viewMode": "stacks", "total": 100 }
// et, si possible, "cards": ["1 Sol Ring", ...] (liste « Copier » de
// Moxfield) pour vérifier aussi le détail.
const PAGES_DIR = path.join(FIXTURES_DIR, "pages");
const pageFiles = fs.existsSync(PAGES_DIR) ? fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith(".html")) : [];

for (const file of pageFiles) {
  const base = file.replace(/\.html$/, "");
  const expected = JSON.parse(fs.readFileSync(path.join(PAGES_DIR, `${base}.json`), "utf8"));

  test(`Page réelle ${base} : total`, () => {
    const scraper = loadPage(path.join("pages", file), expected.viewMode);
    const cards = scraper.scrapeCardsGuess();
    assert.equal(scraper.getSiteDeclaredTotal(), expected.total);
    assert.equal(totalOf(cards), expected.total);
  });

  if (expected.cards) {
    test(`Page réelle ${base} : liste`, () => {
      const scraper = loadPage(path.join("pages", file), expected.viewMode);
      const cards = scraper.completeCardNames(scraper.scrapeCardsGuess(), expected.cards.map(parseLine));
      assert.deepEqual(summarize(cards), expected.cards.map((l) => `${parseLine(l).qty} ${parseLine(l).name}`).sort());
    });
  }
}

function parseLine(line) {
  const m = line.trim().match(/^(\d+)\s+(.+)$/);
  return { qty: parseInt(m[1], 10), name: m[2].trim() };
}

// --- Version (impression) de chaque carte ---

for (const view of VIEWS) {
  test(`${view.name} : version lue pour les cartes possédées dans la version du deck`, () => {
    const cards = loadPage(view.fixture, view.viewMode).scrapeCardsGuess();
    const versionsOf = (name) => cards.find((c) => c.name.startsWith(name)).versions;
    assert.deepEqual(versionsOf("Sidisi"), [{ code: "E0aWJ", qty: 1 }]);
    // Carte foil : même code que la version normale (le marqueur de
    // collection ne porte pas le suffixe "F0").
    assert.deepEqual(versionsOf("Golgari Thug"), [{ code: "ZOwRD", qty: 1 }]);
    assert.deepEqual(versionsOf("Revitalizing Repast"), [{ code: "xRXAR", qty: 1 }]);
    assert.deepEqual(versionsOf("Swamp"), [{ code: "SWAMP1", qty: 3 }], "exemplaires cumulés");
    // Possédée dans une autre version : aucune version retenue.
    assert.deepEqual(versionsOf("Birds of Paradise"), []);
  });
}

test("computeDeckDiff : même quantité, autre version que celle du montage", () => {
  const { computeDeckDiff } = loadPage("text.html", "table");
  const built = [
    { name: "Sol Ring", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] },
    { name: "Swamp", qty: 3, versions: [{ code: "SWAMP1", qty: 2 }, { code: "SWAMP2", qty: 1 }] },
    { name: "Counterspell", qty: 1 },
  ];
  const page = [
    { name: "Sol Ring", qty: 1, printingStatus: "full", versions: [{ code: "BBBBB", qty: 1 }] },
    { name: "Swamp", qty: 3, printingStatus: "full", versions: [{ code: "SWAMP2", qty: 1 }, { code: "SWAMP1", qty: 2 }] },
    { name: "Counterspell", qty: 1, printingStatus: "full", versions: [{ code: "CCCCC", qty: 1 }] },
  ];
  assert.deepEqual(computeDeckDiff(built, page), [{ name: "Sol Ring", from: 1, to: 1, version: true }]);
  // Passage à une version non possédée : plus aucune version lue.
  const notOwned = [{ ...page[0], printingStatus: "partial", versions: [] }, page[1], page[2]];
  assert.deepEqual(computeDeckDiff(built, notOwned), [{ name: "Sol Ring", from: 1, to: 1, version: true }]);
});

test("computeDeckDiff : version illisible sur la page (rendu en cours), rien de conclu", () => {
  const { computeDeckDiff } = loadPage("text.html", "table");
  const built = [{ name: "Sol Ring", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] }];
  assert.deepEqual(computeDeckDiff(built, [{ name: "Sol Ring", qty: 1, printingStatus: "unknown", versions: [] }]), []);
});

test("versionsToRecord : versions de la page pour les cartes du montage qui n'en ont pas", () => {
  const { versionsToRecord } = loadPage("text.html", "table");
  const built = [
    { name: "Sol Ring", qty: 1 },
    { name: "Counterspell", qty: 1, versions: [{ code: "CCCCC", qty: 1 }] },
    { name: "Swamp", qty: 3 },
    { name: "Birds of Paradise", qty: 1 },
  ];
  const page = [
    { name: "sol ring", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] },
    { name: "Counterspell", qty: 1, versions: [{ code: "DDDDD", qty: 1 }] },
    { name: "Swamp", qty: 4, versions: [{ code: "SWAMP1", qty: 4 }] },
    { name: "Birds of Paradise", qty: 1, versions: [] },
  ];
  // Version déjà enregistrée, quantité différente ou version non lue : rien.
  assert.deepEqual(versionsToRecord(built, page), { "sol ring": [{ code: "AAAAA", qty: 1 }] });
  assert.equal(versionsToRecord([built[1]], page), null);
});

test("versionsToRecord : édition apprise depuis (API du deck) pour une version déjà enregistrée", () => {
  const { versionsToRecord } = loadPage("text.html", "table");
  const built = [
    { name: "Sol Ring", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] },
    { name: "Counterspell", qty: 1, versions: [{ code: "CCCCC", qty: 1, set: "mh2", cn: "267" }] },
    { name: "Swamp", qty: 1, versions: [{ code: "SWAMP1", qty: 1 }] },
    { name: "Island", qty: 2, versions: [{ code: "ISLE1", qty: 1 }, { code: "ISLE2", qty: 1 }] },
  ];
  const page = [
    // Même quantité, mais plus répartie de la même façon entre les versions.
    { name: "Island", qty: 2, versions: [{ code: "ISLE1", qty: 2, set: "war", cn: "253" }] },
    { name: "Sol Ring", qty: 1, versions: [{ code: "AAAAA", qty: 1, set: "c21", cn: "263" }] },
    { name: "Counterspell", qty: 1, versions: [{ code: "CCCCC", qty: 1, set: "mh2", cn: "267" }] },
    { name: "Swamp", qty: 1, versions: [{ code: "SWAMP2", qty: 1, set: "war", cn: "256" }] },
  ];
  // Édition déjà enregistrée, ou autre version que celle du montage : rien.
  assert.deepEqual(versionsToRecord(built, page), { "sol ring": [{ code: "AAAAA", qty: 1, set: "c21", cn: "263" }] });
  assert.equal(versionsToRecord(built.slice(1), page), null);
});
