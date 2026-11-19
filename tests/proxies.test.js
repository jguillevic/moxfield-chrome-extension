// Tests de la page d'impression des proxies (proxies.html + proxies.js) :
// npm test
//
// Scryfall est simulé à partir de vraies réponses (novembre 2026), réduites
// aux champs utiles dans tests/fixtures/api/scryfall-cards.json : une carte
// simple, une transformable, une double face modale et une carte scindée.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { FIXTURES_DIR, fakeGetMessage } = require("./helpers");
const { createProxySheet, CARDS_PER_SHEET, SCRYFALL_BATCH_SIZE } = require("../proxies.js");

const ROOT = path.join(__dirname, "..");
const CARDS = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "api", "scryfall-cards.json"), "utf8"));
const png = (name) => {
  const card = CARDS.find((c) => c.name === name);
  return card.image_uris ? [card.image_uris.png] : card.card_faces.map((f) => f.image_uris.png);
};

// Faux Scryfall (POST /cards/collection) : comme le vrai, cartes trouvées
// dans l'ordre demandé, introuvables écartées (not_found), recherche par nom
// sur la seule face avant, sans tenir compte de la casse.
function fakeScryfall(options = {}) {
  const requests = [];
  const front = (name) => name.split(" // ")[0].trim().toLowerCase();
  async function fetch(url, init) {
    const { identifiers } = JSON.parse(init.body);
    requests.push({ url, method: init.method, identifiers });
    if (options.fail) return options.fail();
    const found = identifiers.map((id) =>
      CARDS.find((c) => (id.set ? c.set === id.set && c.collector_number === id.collector_number : front(c.name) === id.name.toLowerCase()))
    );
    const body = { object: "list", not_found: identifiers.filter((id, i) => !found[i]), data: found.filter(Boolean) };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  }
  return { fetch, requests };
}

function sheetWith(scryfall, waits = []) {
  return createProxySheet({ fetch: scryfall.fetch, wait: async (ms) => waits.push(ms) });
}

// --- Recherche des images (createProxySheet) ---

test("images : version du deck d'abord, sinon le nom ; une image par face", async () => {
  const scryfall = fakeScryfall();
  const slots = await sheetWith(scryfall).buildSlots([
    { name: "Golgari Thug", qty: 2, set: "rav", cn: "87" },
    { name: "Delver of Secrets // Insectile Aberration", qty: 1 },
    { name: "Fire // Ice", qty: 1 },
  ]);
  assert.deepEqual(scryfall.requests, [
    {
      url: "https://api.scryfall.com/cards/collection",
      method: "POST",
      identifiers: [{ set: "rav", collector_number: "87" }, { name: "Delver of Secrets" }, { name: "Fire" }],
    },
  ]);
  assert.deepEqual(slots, [
    { name: "Golgari Thug", image: png("Golgari Thug")[0] },
    { name: "Golgari Thug", image: png("Golgari Thug")[0] },
    // Carte transformable : recto et verso.
    { name: "Delver of Secrets // Insectile Aberration", image: png("Delver of Secrets // Insectile Aberration")[0] },
    { name: "Delver of Secrets // Insectile Aberration", image: png("Delver of Secrets // Insectile Aberration")[1] },
    // Carte scindée : une seule image.
    { name: "Fire // Ice", image: png("Fire // Ice")[0] },
  ]);
});

test("images : version introuvable, nouvel essai par le nom ; carte introuvable, nom seul", async () => {
  const scryfall = fakeScryfall();
  const waits = [];
  const slots = await sheetWith(scryfall, waits).buildSlots([
    // Numéro qui ne correspond pas chez Scryfall.
    { name: "Revitalizing Repast // Old-Growth Grove", qty: 1, set: "mh3", cn: "235" },
    { name: "Carte Inventée", qty: 1 },
  ]);
  assert.deepEqual(
    scryfall.requests.map((r) => r.identifiers),
    [[{ set: "mh3", collector_number: "235" }, { name: "Carte Inventée" }], [{ name: "Revitalizing Repast" }]]
  );
  assert.deepEqual(waits, [100], "délai demandé par Scryfall entre deux requêtes");
  assert.deepEqual(slots, [
    { name: "Revitalizing Repast // Old-Growth Grove", image: png("Revitalizing Repast // Old-Growth Grove")[0] },
    { name: "Revitalizing Repast // Old-Growth Grove", image: png("Revitalizing Repast // Old-Growth Grove")[1] },
    { name: "Carte Inventée", image: null },
  ]);
});

test("images : 75 cartes par requête au plus, une même carte demandée une seule fois", async () => {
  const scryfall = fakeScryfall();
  const waits = [];
  const cards = Array.from({ length: 80 }, (_, i) => ({ name: `Carte ${i}`, qty: 1 }));
  cards.push({ name: "Carte 0", qty: 2 });
  const slots = await sheetWith(scryfall, waits).buildSlots(cards);
  assert.deepEqual(scryfall.requests.map((r) => r.identifiers.length), [SCRYFALL_BATCH_SIZE, 5]);
  assert.equal(SCRYFALL_BATCH_SIZE, 75);
  assert.deepEqual(waits, [100]);
  assert.equal(slots.length, 82);
});

test("images : erreurs de Scryfall, normales ou non", async () => {
  const failing = (fail) => sheetWith(fakeScryfall({ fail })).buildSlots([{ name: "Golgari Thug", qty: 1 }]);
  const offline = () => Promise.reject(new TypeError("Failed to fetch"));
  await assert.rejects(failing(offline), (e) => e.expected === true);
  await assert.rejects(failing(async () => ({ ok: false, status: 429 })), (e) => e.expected === true);
  await assert.rejects(failing(async () => ({ ok: false, status: 503 })), (e) => e.expected === true);
  await assert.rejects(failing(async () => ({ ok: false, status: 400 })), (e) => e.expected === false);
  await assert.rejects(failing(async () => ({ ok: true, status: 200, json: async () => ({ object: "error" }) })), (e) => e.expected === false);
});

test("planches : 9 cartes par page A4", () => {
  const { toSheets } = sheetWith(fakeScryfall());
  const slots = Array.from({ length: 10 }, (_, i) => ({ name: `Carte ${i}`, image: null }));
  assert.equal(CARDS_PER_SHEET, 9);
  assert.deepEqual(toSheets(slots).map((s) => s.length), [9, 1]);
  assert.deepEqual(toSheets([]), []);
});

// --- Page (proxies.html) ---

const HTML = fs.readFileSync(path.join(ROOT, "proxies.html"), "utf8");
const SCRIPTS = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(([, f]) => fs.readFileSync(path.join(ROOT, f), "utf8"));

const DECK = {
  name: "Zethi",
  url: "https://moxfield.com/decks/a",
  cards: [
    { name: "Golgari Thug", qty: 2, set: "rav", cn: "87" },
    { name: "Delver of Secrets // Insectile Aberration", qty: 1 },
  ],
};

// deck : réponse de GET_DECK_PROXIES ; scryfall : faux Scryfall.
function openPage({ deck = DECK, scryfall = fakeScryfall(), lang = "fr", search = "?deck=a" } = {}) {
  const dom = new JSDOM(HTML.replace(/<script src="[^"]+"><\/script>/g, ""), {
    url: `https://extension.test/proxies.html${search}`,
    runScripts: "outside-only",
  });
  const win = dom.window;
  const sent = [];
  win.chrome = {
    i18n: { getMessage: fakeGetMessage(lang) },
    runtime: {
      sendMessage: async (msg) => {
        sent.push(JSON.parse(JSON.stringify(msg)));
        if (msg.type === "GET_DECK_PROXIES") return { ok: true, deck: JSON.parse(JSON.stringify(deck)) };
        return { ok: true };
      },
    },
  };
  win.fetch = scryfall.fetch;
  let printed = 0;
  win.print = () => printed++;
  for (const script of SCRIPTS) win.eval(script);
  const $ = (id) => win.document.getElementById(id);
  return { win, $, sent, printed: () => printed, close: () => win.close() };
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`délai dépassé : ${label}`);
}

const slotsOf = (p) => [...p.win.document.querySelectorAll(".sheet .slot")];

test("page : planche des proxies du deck, impression possible une fois les images chargées", async (t) => {
  const p = openPage();
  t.after(p.close);
  await waitFor(() => slotsOf(p).length > 0, "planche affichée");
  assert.equal(p.$("deck-name").textContent, "Zethi");
  assert.equal(p.win.document.title, "Proxies — Zethi");
  assert.equal(p.$("status").textContent, "3 proxies à imprimer sur 1 page.");
  assert.deepEqual(p.sent.find((m) => m.type === "GET_DECK_PROXIES").payload, { deckId: "a" });
  // 2 Golgari Thug + recto et verso de Delver of Secrets.
  const images = slotsOf(p).map((s) => s.querySelector("img").src);
  assert.deepEqual(images, [...png("Golgari Thug"), ...png("Golgari Thug"), ...png("Delver of Secrets // Insectile Aberration")]);
  assert.ok(slotsOf(p).every((s) => s.querySelector(".proxy-mark").textContent === "PROXY"));
  assert.equal(p.$("print").disabled, true, "images pas encore chargées");
  for (const img of p.win.document.querySelectorAll(".slot img")) img.dispatchEvent(new p.win.Event("load"));
  assert.equal(p.$("print").disabled, false);
  p.$("print").click();
  assert.equal(p.printed(), 1);
});

test("page : image qui ne se charge pas, le nom de la carte à la place", async (t) => {
  const p = openPage();
  t.after(p.close);
  await waitFor(() => slotsOf(p).length > 0, "planche affichée");
  const imgs = [...p.win.document.querySelectorAll(".slot img")];
  imgs[0].dispatchEvent(new p.win.Event("error"));
  for (const img of imgs.slice(1)) img.dispatchEvent(new p.win.Event("load"));
  assert.ok(slotsOf(p)[0].classList.contains("slot-missing"));
  assert.match(slotsOf(p)[0].textContent, /^Golgari Thug/);
  assert.equal(p.$("print").disabled, false, "impression possible quand même");
});

test("page : mention « PROXY » activée par défaut, désactivable, choix retenu", async (t) => {
  const p = openPage();
  t.after(p.close);
  await waitFor(() => slotsOf(p).length > 0, "planche affichée");
  const body = p.win.document.body;
  assert.equal(p.$("proxy-mark").checked, true);
  assert.equal(body.classList.contains("no-mark"), false);
  p.$("proxy-mark").checked = false;
  p.$("proxy-mark").dispatchEvent(new p.win.Event("change"));
  assert.equal(body.classList.contains("no-mark"), true);
  assert.equal(p.win.localStorage.getItem("msmProxyMark"), "off");
});

test("page : carte introuvable chez Scryfall, signalée, son nom imprimé", async (t) => {
  const deck = { ...DECK, cards: [{ name: "Carte Inventée", qty: 1 }, DECK.cards[0]] };
  const p = openPage({ deck });
  t.after(p.close);
  await waitFor(() => slotsOf(p).length > 0, "planche affichée");
  assert.equal(p.$("status").textContent, "3 proxies à imprimer sur 1 page. Image introuvable pour 1 emplacement(s) : le nom de la carte est imprimé à la place.");
  assert.equal(slotsOf(p)[0].querySelector("img"), null);
  assert.match(slotsOf(p)[0].textContent, /^Carte Inventée/);
});

test("page : Scryfall injoignable, noms seuls, sans rapport d'erreur", async (t) => {
  const p = openPage({ scryfall: fakeScryfall({ fail: () => Promise.reject(new TypeError("Failed to fetch")) }) });
  t.after(p.close);
  await waitFor(() => slotsOf(p).length > 0, "planche affichée");
  assert.match(p.$("status").textContent, /Scryfall injoignable/);
  assert.deepEqual(slotsOf(p).map((s) => s.firstChild.textContent), ["Golgari Thug", "Golgari Thug", "Delver of Secrets // Insectile Aberration"]);
  assert.equal(p.$("print").disabled, false);
  assert.deepEqual(p.sent.filter((m) => m.type === "REPORT_ERROR"), []);
});

test("page : réponse anormale de Scryfall, rapportée", async (t) => {
  const p = openPage({ scryfall: fakeScryfall({ fail: async () => ({ ok: false, status: 400 }) }) });
  t.after(p.close);
  await waitFor(() => slotsOf(p).length > 0, "planche affichée");
  const reports = p.sent.filter((m) => m.type === "REPORT_ERROR");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].payload.where, "proxies-page");
  assert.match(reports[0].payload.error.message, /status 400/);
  // Rien sur le deck ni les cartes dans le rapport.
  assert.ok(!JSON.stringify(reports[0]).includes("Zethi") && !JSON.stringify(reports[0]).includes("Golgari"));
});

test("page : deck plus monté ou sans proxy", async (t) => {
  const p = openPage({ deck: null });
  t.after(p.close);
  await waitFor(() => p.$("status").textContent, "message affiché");
  assert.equal(p.$("status").textContent, "Ce deck n'est plus monté, ou n'a aucun proxy.");
  assert.equal(p.$("print").disabled, true);
  assert.equal(slotsOf(p).length, 0);
});

test("page : en anglais", async (t) => {
  const p = openPage({ lang: "en" });
  t.after(p.close);
  await waitFor(() => slotsOf(p).length > 0, "planche affichée");
  assert.equal(p.$("status").textContent, "3 proxies to print on 1 page.");
  assert.match(p.win.document.querySelector("[data-i18n='proxiesMarkLabel']").textContent, /PROXY/);
});

test("images : deux cartes de la même édition, chacune par son numéro", async () => {
  const scryfall = fakeScryfall();
  const slots = await sheetWith(scryfall).buildSlots([
    { name: "Carte Inventée", qty: 1, set: "rav", cn: "999" },
    { name: "Golgari Thug", qty: 1, set: "rav", cn: "87" },
  ]);
  assert.deepEqual(slots, [
    { name: "Carte Inventée", image: null },
    { name: "Golgari Thug", image: png("Golgari Thug")[0] },
  ]);
});
