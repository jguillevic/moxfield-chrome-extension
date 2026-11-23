// Tests de l'aide sur les boutons de la page d'un deck (deck-help.js) : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { createDeckHelp } = require("../deck-help.js");
const { loadI18n } = require("./helpers");

const help = createDeckHelp(loadI18n());
const blocked = (blocking) => ({ blocking });

test("bulle : ce que dit le bouton pour chaque état du deck", () => {
  assert.match(help.bubbleText({ built: false, availability: null }), /^Ce deck n'est pas encore monté\. Clique sur la boîte/);
  assert.match(help.bubbleText({ built: false, availability: blocked(0) }), /^Ce deck est montable \(« OK »\) .* Mais il n'est pas encore monté/);
  assert.match(help.bubbleText({ built: false, availability: blocked(1) }), /, et 1 exemplaire bloque son montage/);
  assert.match(help.bubbleText({ built: false, availability: blocked(3) }), /, et 3 exemplaires bloquent son montage/);
  assert.match(help.bubbleText({ built: true, outdated: false, availability: null }), /^Ce deck est monté physiquement \(rond coché vert\)/);
  assert.match(help.bubbleText({ built: true, outdated: true, availability: null }), /sa liste a changé sur Moxfield depuis/);
});

test("bulle : en anglais", () => {
  const en = createDeckHelp(loadI18n("en"));
  assert.match(en.bubbleText({ built: false, availability: blocked(0) }), /^This deck is buildable/);
  assert.match(en.bubbleText({ built: false, availability: blocked(2) }), /2 copies block the build/);
});

test("légende : une ligne par état, icône et pastille identiques à celles de la page", () => {
  const { document } = new JSDOM("").window;
  const legend = help.buildLegend(document);
  const items = [...legend.querySelectorAll("li")];
  assert.equal(items.length, help.LEGEND.length);
  for (const [i, item] of help.LEGEND.entries()) {
    const path = items[i].querySelector("svg path").getAttribute("d");
    assert.equal(path, help.BAR_ICONS[item.icon].path, `${item.key} : icône du bouton`);
    const badge = items[i].querySelector(".msm-avail-badge");
    assert.equal(badge ? badge.textContent : null, item.badge ? item.badge[0] : null, `${item.key} : pastille`);
  }
  assert.equal(items[1].querySelector(".msm-avail-badge").className, "msm-avail-badge msm-avail-ok");
  assert.ok(items.every((li) => li.querySelector(".msm-legend-icon").getAttribute("aria-hidden") === "true"), "icônes décoratives : le texte suffit");
});

test("légende : textes échappés (construite sans innerHTML)", () => {
  const { document } = new JSDOM("").window;
  const evil = createDeckHelp({ t: () => "<img src=x onerror=alert(1)>", tn: () => "" });
  const legend = evil.buildLegend(document);
  assert.equal(legend.querySelector("img"), null);
  assert.match(legend.textContent, /<img src=x/);
});
