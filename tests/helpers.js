// Chargement d'une page de test dans jsdom, avec le lecteur de deck branché
// dessus.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { createDeckScraper } = require("../deck-scraper.js");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

// jsdom ne calcule aucune mise en page : getBoundingClientRect y renvoie
// toujours une taille nulle, et isVisible écarterait tout. On reproduit le
// comportement d'un navigateur pour ce qui compte ici : taille nulle si
// l'élément ou un de ses ancêtres est en display:none (restes cachés d'une
// autre vue), non nulle sinon.
function simulateLayout(win) {
  win.Element.prototype.getBoundingClientRect = function () {
    for (let el = this; el; el = el.parentElement) {
      if (win.getComputedStyle(el).display === "none") {
        return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
      }
    }
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
  };
}

// viewMode : valeur du sélecteur « View » de Moxfield (table, visual,
// stacks, splitStacks...). Une copie HTML ne garde pas l'option choisie (elle
// est posée par le script de la page), il faut donc la redonner ici.
function loadPage(fixturePath, viewMode) {
  const html = fs.readFileSync(path.join(FIXTURES_DIR, fixturePath), "utf8");
  const win = new JSDOM(html).window;
  simulateLayout(win);
  const select = win.document.querySelector('select[name="viewMode"], select#viewMode');
  if (viewMode && select) select.value = viewMode;
  // document exposé pour que les tests puissent modifier la page.
  return { ...createDeckScraper(win), document: win.document };
}

// Forme comparable d'une liste de cartes : "QTE Nom", triée.
function summarize(cards) {
  return cards.map((c) => `${c.qty} ${c.name}`).sort();
}

function totalOf(cards) {
  return cards.reduce((sum, c) => sum + c.qty, 0);
}

module.exports = { FIXTURES_DIR, loadPage, simulateLayout, summarize, totalOf };
