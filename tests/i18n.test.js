// Tests des traductions (i18n.js et _locales/) : npm test
//
// Les fichiers de langue sont vérifiés comme Chrome les lirait (une erreur
// dans messages.json empêche l'extension de se charger), et confrontés au
// code : toute clé utilisée existe dans chaque langue, toute clé existante
// sert.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createI18n } = require("../i18n.js");
const { LOCALES_DIR, loadMessages, loadI18n } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const LANGS = fs.readdirSync(LOCALES_DIR);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const SOURCES = fs
  .readdirSync(ROOT)
  .filter((f) => /\.(js|html)$/.test(f))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(ROOT, f), "utf8") }));
const placeholders = (message) => [...message.matchAll(/\$([1-9])/g)].map((m) => m[1]).sort().join(",");

test("langues : français et anglais, anglais par défaut", () => {
  assert.deepEqual(LANGS.sort(), ["en", "fr"]);
  assert.equal(MANIFEST.default_locale, "en");
  for (const lang of LANGS) assert.equal(loadMessages(lang).locale.message, lang);
});

test("mêmes clés dans toutes les langues, aucun texte vide", () => {
  const fr = loadMessages("fr");
  for (const lang of LANGS) {
    const messages = loadMessages(lang);
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(fr).sort(), `clés de ${lang}`);
    for (const [key, entry] of Object.entries(messages)) {
      assert.match(key, /^[A-Za-z0-9_]+$/, `${lang} : nom de clé ${key}`);
      assert.ok(entry.message.trim(), `${lang} : ${key} vide`);
    }
  }
});

test("mêmes valeurs insérées ($1…$9) d'une langue à l'autre", () => {
  const fr = loadMessages("fr");
  for (const lang of LANGS) {
    for (const [key, entry] of Object.entries(loadMessages(lang))) {
      assert.equal(placeholders(entry.message), placeholders(fr[key].message), `${lang} : ${key}`);
    }
  }
});

// Chrome lit "$…$" comme une variable nommée : non déclarée, l'extension
// refuse de se charger.
test("aucun « $ » que Chrome lirait comme une variable", () => {
  for (const lang of LANGS) {
    for (const [key, entry] of Object.entries(loadMessages(lang))) {
      assert.doesNotMatch(entry.message, /\$[A-Za-z0-9_@]+\$/, `${lang} : ${key}`);
      assert.doesNotMatch(entry.message, /\$(?![1-9$])/, `${lang} : ${key}`);
    }
  }
});

test("pluriels : chaque clé _one a sa clé _other", () => {
  for (const lang of LANGS) {
    const keys = new Set(Object.keys(loadMessages(lang)));
    for (const key of keys) {
      const m = key.match(/^(.+)_(one|other)$/);
      if (m) assert.ok(keys.has(`${m[1]}_${m[2] === "one" ? "other" : "one"}`), `${lang} : pendant de ${key}`);
    }
  }
});

test("manifest : nom et description traduits, dans les limites de Chrome", () => {
  const used = JSON.stringify(MANIFEST).match(/__MSG_\w+__/g);
  assert.deepEqual([...new Set(used)].sort(), ["__MSG_extDescription__", "__MSG_extName__"]);
  for (const lang of LANGS) {
    const messages = loadMessages(lang);
    assert.ok(messages.extName.message.length <= 75, `${lang} : nom trop long (75 caractères au plus)`);
    assert.ok(messages.extDescription.message.length <= 132, `${lang} : description trop longue`);
  }
});

test("i18n.js chargé avant les scripts qui s'en servent", () => {
  assert.equal(MANIFEST.content_scripts[0].js[0], "i18n.js");
  const html = SOURCES.find((s) => s.file === "popup.html").text;
  assert.ok(html.indexOf('src="i18n.js"') < html.indexOf('src="popup.js"'));
  const background = SOURCES.find((s) => s.file === "background.js").text;
  assert.match(background, /importScripts\("i18n.js"/);
});

// Premier argument de chaque appel t(…) / tn(…) : la clé en dur, ou les
// deux d'un choix « a ? "x" : "y" » (pas les valeurs comparées dans la
// condition).
function keysUsedInCalls(text) {
  const used = [];
  for (const m of text.matchAll(/(?<![\w.$])(?:i18n\.)?(t|tn)\(/g)) {
    let depth = 0;
    let end = m.index + m[0].length;
    for (; end < text.length; end++) {
      const c = text[end];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
    }
    const arg = text.slice(m.index + m[0].length, end);
    for (const [, key] of arg.trim().matchAll(/(?:^|[?:])\s*"([A-Za-z0-9_]+)"/g)) {
      if (m[1] === "tn") used.push(`${key}_one`, `${key}_other`);
      else used.push(key);
    }
  }
  return used;
}

test("toute clé utilisée par le code existe", () => {
  const messages = loadMessages("fr");
  const used = new Set();
  for (const { text } of SOURCES) {
    keysUsedInCalls(text).forEach((k) => used.add(k));
    for (const [, key] of text.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) used.add(key);
  }
  assert.ok(used.size > 150, `seulement ${used.size} clés trouvées : lecture du code à revoir`);
  for (const key of used) assert.ok(messages[key], `clé utilisée mais absente : ${key}`);
});

test("toute clé existante sert quelque part", () => {
  const all = SOURCES.map((s) => s.text).join("\n") + JSON.stringify(MANIFEST);
  for (const key of Object.keys(loadMessages("fr"))) {
    const base = key.replace(/_(one|other)$/, "");
    assert.ok(all.includes(`"${base}"`) || all.includes(`__MSG_${base}__`), `clé inutilisée : ${key}`);
  }
});

// --- createI18n ---

test("pluriels selon la langue : 0 au singulier en français, au pluriel en anglais", () => {
  const fr = loadI18n("fr");
  const en = loadI18n("en");
  assert.equal(fr.tn("cardCount", 0), "0 carte");
  assert.equal(fr.tn("cardCount", 1), "1 carte");
  assert.equal(fr.tn("cardCount", 2), "2 cartes");
  assert.equal(en.tn("cardCount", 0), "0 cards");
  assert.equal(en.tn("cardCount", 1), "1 card");
  assert.equal(en.tn("cardCount", 2), "2 cards");
  assert.equal(en.tn("historyDeckBuilt", 99, "Zethi"), "Deck “Zethi” built: 99 cards taken out of the free stock");
});

test("valeurs insérées, clé manquante affichée telle quelle", () => {
  const en = loadI18n("en");
  assert.equal(en.t("errorPrefix", "boom"), "Error: boom");
  assert.equal(en.t("shortageItem", "Sol Ring", 0, 1, 1), "Sol Ring — you have 0, need 1 (1 missing)");
  assert.equal(en.t("cleInexistante"), "cleInexistante");
});

test("dates au format de la langue", () => {
  const at = new Date(2026, 9, 7, 15, 42).getTime();
  assert.equal(loadI18n("fr").formatDateTime(at), "07/10/2026 15:42");
  assert.equal(loadI18n("en").formatDateTime(at), "10/7/26, 3:42 PM");
  assert.equal(loadI18n("fr").formatDay(at), "07/10/2026");
});

// Content script d'une extension rechargée : chrome.i18n lève.
test("lecture des messages impossible : ni plantage, ni texte vide", () => {
  const i18n = createI18n(() => {
    throw new Error("Extension context invalidated.");
  });
  assert.equal(i18n.locale, "en");
  assert.equal(i18n.t("cancel"), "cancel");
  assert.equal(i18n.tn("cardCount", 2), "cardCount_other");
});
