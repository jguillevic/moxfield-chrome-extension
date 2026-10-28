// Chargement d'une page de test dans jsdom, avec le lecteur de deck branché
// dessus.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { createDeckScraper } = require("../deck-scraper.js");
const { createI18n } = require("../i18n.js");

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const LOCALES_DIR = path.join(__dirname, "..", "_locales");

// Messages d'une langue (_locales/<lang>/messages.json).
function loadMessages(lang) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang, "messages.json"), "utf8"));
}

// Équivalent de chrome.i18n.getMessage pour une langue : "" si la clé
// n'existe pas, $1…$9 remplacés par les valeurs, "$" par "$".
function fakeGetMessage(lang = "fr") {
  const messages = loadMessages(lang);
  return (key, subs) => {
    const entry = messages[key];
    if (!entry) return "";
    const values = subs === undefined ? [] : [].concat(subs);
    return entry.message.replace(/\$(\$|[1-9])/g, (m, d) => (d === "$" ? "$" : String(values[d - 1] ?? "")));
  };
}

// Textes traduits (cf. i18n.js), comme dans l'extension. Français par
// défaut : c'est la langue des libellés attendus dans les tests.
function loadI18n(lang = "fr") {
  return createI18n(fakeGetMessage(lang));
}

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

module.exports = { FIXTURES_DIR, LOCALES_DIR, loadPage, simulateLayout, summarize, totalOf, loadMessages, fakeGetMessage, loadI18n };
