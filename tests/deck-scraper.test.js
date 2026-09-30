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
