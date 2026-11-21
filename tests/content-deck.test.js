// Tests du bouton injecté sur la page d'un deck (content-deck.js) : npm test
//
// Les scripts de l'extension (deck-scraper.js, deck-checks.js,
// content-deck.js) sont exécutés dans une page de test jsdom, comme dans
// Chrome, avec un faux `chrome` qui répond à GET_STATE.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { FIXTURES_DIR, simulateLayout, fakeGetMessage } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = ["i18n.js", "deck-scraper.js", "deck-checks.js", "content-deck.js"].map((f) =>
  fs.readFileSync(path.join(ROOT, f), "utf8")
);
const STATE_KEY = "moxfieldStockManagerState";

function stockOf(entries) {
  const stock = {};
  for (const [name, qty] of Object.entries(entries)) stock[name.toLowerCase()] = { name, qty };
  return stock;
}

// Deck des pages de test : Birds of Paradise (possédée dans une autre
// version), Golgari Thug, Revitalizing Repast, Sidisi, Brood Tyrant et
// 3 Swamp. Tout est en stock : seule Birds of Paradise bloque.
const FULL_STOCK = stockOf({
  "Birds of Paradise": 1,
  "Golgari Thug": 1,
  "Revitalizing Repast // Old-Growth Grove": 1,
  "Sidisi, Brood Tyrant": 1,
  Swamp: 3,
});

// lang : langue du navigateur (français par défaut).
// handle : réponse imposée à un message dès le chargement de la page (cf.
// page.handle).
// beforeScripts(win) : préparation de la page avant les scripts de
// l'extension (ex. sessionStorage laissé par un rechargement).
// barIcons : icônes de la barre d'actions de Moxfield (cf. addActionBar),
// null pour une page sans barre.
function openDeckPage(state, lang = "fr", handle = null, format = "Commander", beforeScripts = null, barIcons = undefined) {
  const html = fs.readFileSync(path.join(FIXTURES_DIR, "text.html"), "utf8");
  // jsdom ne sait pas recharger une page : il le signale sur sa console, ce
  // qui permet de vérifier qu'un rechargement a été demandé.
  const reloads = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (/navigation/.test(err.message)) reloads.push(err.message);
    else console.error(err);
  });
  const dom = new JSDOM(html, { url: "https://www.moxfield.com/decks/abc123", runScripts: "outside-only", virtualConsole });
  const win = dom.window;
  simulateLayout(win);
  win.document.querySelector('select[name="viewMode"], select#viewMode').value = "table";
  // Format du deck (badge d'en-tête de Moxfield) : le bouton n'en dépend pas.
  const badge = win.document.createElement("span");
  badge.className = "badge-header";
  badge.textContent = format;
  win.document.body.prepend(badge);

  const storageListeners = [];
  // Messages du service worker vers la page (cf. page.emit).
  const messageListeners = [];
  const page = {
    state,
    win,
    // Le stock change ailleurs (popup, autre onglet, synchro Drive).
    setStock(stock) {
      page.state = { ...page.state, stock };
      for (const fn of storageListeners) fn({ [STATE_KEY]: { newValue: page.state } }, "local");
    },
    button: () => win.document.querySelector(".msm-bar-btn:not(.msm-editions-bar-btn):not(.msm-like-bar-btn)"),
    close: () => win.close(),
    sent: [],
    // Réponse imposée à un message (ex. erreur levée), sinon comportement normal.
    handle,
    reloads,
    // Message envoyé à la page par le service worker.
    emit: (msg) => messageListeners.forEach((fn) => fn(JSON.parse(JSON.stringify(msg)))),
  };
  // Comme le service worker (GET_DECK_CONTEXT) : seulement le stock des
  // cartes demandées (face avant d'une double face comprise) et de celles
  // du montage, pour que la page soit testée avec ce qu'elle reçoit vraiment.
  function deckContext({ deckId, names }) {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const deck = deckId && page.state.builtDecks[deckId];
    if (deck) deck.cards.forEach((c) => wanted.add(c.name.toLowerCase()));
    const stock = {};
    for (const [key, c] of Object.entries(page.state.stock)) {
      if (wanted.has(key) || wanted.has(key.split(" // ")[0])) stock[key] = c;
    }
    return { ok: true, stock, builtDecks: page.state.builtDecks, followed: Boolean(deckId && (page.state.followedDecks || {})[deckId]) };
  }
  win.chrome = {
    i18n: { getMessage: fakeGetMessage(lang) },
    runtime: {
      sendMessage: async (msg) => {
        page.sent.push(JSON.parse(JSON.stringify(msg)));
        if (page.handle) {
          const res = await page.handle(msg);
          if (res !== undefined) return res;
        }
        if (msg.type === "GET_DECK_CONTEXT") return JSON.parse(JSON.stringify(deckContext(msg.payload)));
        return { ok: true };
      },
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    storage: { onChanged: { addListener: (fn) => storageListeners.push(fn) } },
  };
  if (barIcons !== null) addActionBar(win, barIcons);
  if (beforeScripts) beforeScripts(win);
  for (const source of SCRIPTS) win.eval(source);
  return page;
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`délai dépassé (${timeoutMs} ms) : ${label}`);
}

// Libellé complet du bouton (état et faisabilité), comme le lit un lecteur d'écran.
const buttonText = (page) => (page.button() ? page.button().getAttribute("aria-label") || "" : "");
// Faisabilité seule (après « libellé — »).
const buttonTitle = (page) => (page.button() ? page.button().title.split(" — ").slice(1).join(" — ") : "");

test("deck non monté : faisabilité affichée, terrains de base exclus", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("dispo"), 2000, "faisabilité affichée");
  assert.match(buttonText(page), /^Marquer comme monté physiquement — .*\(3\/4 cartes disponibles en stock libre/);
  assert.match(buttonTitle(page), /^1 carte bloque le montage : 1 dans une autre version/);
  assert.match(buttonTitle(page), /version différente : Birds of Paradise/);
});

// Moxfield a retiré la barre d'actions de la page d'un deck (novembre
// 2026) : sans repli, plus aucun bouton n'apparaissait.
test("barre d'actions de Moxfield absente : boutons dans le bandeau flottant", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} }, "fr", null, "Commander", null, null);
  t.after(page.close);
  const doc = page.win.document;
  await waitFor(() => buttonText(page).includes("dispo"), 2000, "faisabilité affichée");
  const floating = doc.querySelector(".msm-floating-bar");
  assert.ok(floating, "bandeau flottant");
  assert.equal(page.button().parentElement, floating);
  assert.equal(page.button().previousElementSibling, editionsButton(page), "« Utiliser mes éditions » à gauche de « Monter »");
  assert.match(buttonText(page), /^Marquer comme monté physiquement — /);

  page.button().click();
  await waitFor(() => doc.querySelector(".msm-overlay"), 2000, "fenêtre de montage ouverte");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(doc.querySelectorAll(".msm-floating-bar").length, 1, "pas de bandeau en double");
});

test("barre d'actions affichée plus tard : boutons déplacés dans la barre, puis rendus au bandeau quand elle disparaît", async (t) => {
  const deck = { name: "Deck", url: "", cards: [{ name: "Birds of Paradise", qty: 1 }], builtAt: 1 };
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: { abc123: deck } }, "fr", null, "Commander", null, null);
  t.after(page.close);
  const doc = page.win.document;
  await waitFor(() => buttonText(page).includes("Monté physiquement"), 2000, "bouton de deck monté, dans le bandeau");
  assert.ok(page.button().closest(".msm-floating-bar"));

  addActionBar(page.win);
  await waitFor(() => page.button() && page.button().closest(".msm-test-bar"), 2000, "bouton dans la barre");
  assert.equal(doc.querySelector(".msm-floating-bar"), null, "bandeau retiré");
  assert.match(buttonText(page), /^Monté physiquement/);
  assert.equal(doc.querySelectorAll(".msm-bar-btn:not(.msm-editions-bar-btn):not(.msm-like-bar-btn)").length, 1);

  doc.querySelector(".msm-test-bar").remove();
  await waitFor(() => page.button() && page.button().closest(".msm-floating-bar"), 2000, "bouton rendu au bandeau");
  assert.match(buttonText(page), /^Monté physiquement/);
});

test("deck monté : pas de faisabilité", async (t) => {
  const deck = { name: "Deck", url: "", cards: [{ name: "Birds of Paradise", qty: 1 }], builtAt: 1 };
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: { abc123: deck } });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("Monté physiquement"), 2000, "bouton de deck monté");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(!buttonText(page).includes("dispo"), buttonText(page));
});

test("version changée sur la page : recalcul sans attendre le contrôle périodique", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("3/4 cartes disponibles"), 2000, "état initial");
  // Moxfield remplace le marqueur « Partially in collection » par « Found
  // in collection » quand on choisit une version possédée.
  const marker = page.win.document.querySelector('[id^="collection_pt_"]');
  marker.id = marker.id.replace("collection_pt_", "collection_full_");
  const elapsed = await waitFor(() => buttonText(page).includes("4/4 cartes disponibles"), 2500, "recalcul après changement de version");
  assert.ok(elapsed < 1500, `recalcul en ${elapsed} ms : trop lent pour venir du changement de la page`);
  assert.match(buttonTitle(page), /^montable/);
});

test("stock modifié ailleurs : recalcul immédiat", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("3/4 cartes disponibles"), 2000, "état initial");
  const { ["golgari thug"]: _removed, ...withoutThug } = FULL_STOCK;
  page.setStock(withoutThug);
  const elapsed = await waitFor(() => buttonText(page).includes("2/4 cartes disponibles"), 2500, "recalcul après changement du stock");
  assert.ok(elapsed < 1000, `recalcul en ${elapsed} ms`);
  assert.match(buttonTitle(page), /manque Golgari Thug \(1\)/);
});

test("liste brièvement incohérente : la faisabilité reste affichée", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("3/4 cartes disponibles"), 2000, "état initial");
  // Ligne en double le temps d'un rendu : le total ne correspond plus à
  // celui annoncé par Moxfield.
  const row = page.win.document.querySelector('a.table-deck-row-link[href^="/cards/"]').closest("li");
  const copy = row.cloneNode(true);
  copy.removeAttribute("data-hash");
  row.after(copy);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.match(buttonText(page), /3\/4 cartes disponibles/, "pastille retirée trop tôt");
  copy.remove();
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.match(buttonText(page), /3\/4 cartes disponibles/);
});

test("la page ne demande que le stock des cartes du deck, jamais l'état complet", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("3/4 cartes disponibles"), 2000, "état initial");
  assert.ok(!page.sent.some((m) => m.type === "GET_STATE"), "état complet demandé");
  const request = page.sent.filter((m) => m.type === "GET_DECK_CONTEXT").pop();
  assert.deepEqual(
    [...request.payload.names].sort(),
    ["Birds of Paradise", "Golgari Thug", "Revitalizing Repast", "Sidisi, Brood Tyrant", "Swamp"]
  );
  assert.equal(request.payload.deckId, "abc123");
});

// --- Fenêtre de montage ---

const builds = (page) => page.sent.filter((m) => m.type === "TOGGLE_DECK_BUILT");
const toasts = (page) => [...page.win.document.querySelectorAll(".msm-toast")].map((el) => el.textContent);

// Ouvre la fenêtre de montage, Birds of Paradise passée dans une version
// possédée pour que seul le stock puisse bloquer.
async function openBuildModal(page) {
  const doc = page.win.document;
  const marker = doc.querySelector('[id^="collection_pt_"]');
  marker.id = marker.id.replace("collection_pt_", "collection_full_");
  await waitFor(() => buttonText(page).includes("dispo"), 2000, "faisabilité affichée");
  page.button().click();
  await waitFor(() => doc.querySelector("#msm-card-count") && doc.querySelector("#msm-card-count").textContent, 2000, "fenêtre ouverte");
  return doc;
}

test("montage : carte possédée en un exemplaire déjà dans un autre deck monté, jamais reprise au stock", async (t) => {
  // Cas constaté en vrai (novembre 2026) : un terrain possédé en x1, déjà
  // pris par un deck monté, ne doit pas pouvoir partir dans un second deck ;
  // il ne peut y entrer qu'en proxy.
  const other = { name: "Autre deck", url: "", cards: [{ name: "Golgari Thug", qty: 1 }], builtAt: 1 };
  const page = openDeckPage({ stock: { ...FULL_STOCK, "golgari thug": { name: "Golgari Thug", qty: 0 } }, builtDecks: { other } });
  t.after(page.close);
  const doc = await openBuildModal(page);
  await waitFor(() => doc.querySelector("#msm-shortage-warning").textContent.includes("Golgari Thug"), 2000, "manque affiché");
  assert.match(doc.querySelector("#msm-shortage-warning").textContent, /Autre deck \(1\)/, "deck qui détient la carte");

  assert.equal(doc.querySelector("#msm-confirm").textContent, "Confirmer le montage avec 1 proxy");
  doc.querySelector("#msm-confirm").click();
  await waitFor(() => builds(page).length > 0, 2000, "montage envoyé");
  const golgari = builds(page)[0].payload.cards.find((c) => c.name === "Golgari Thug");
  assert.equal(golgari.proxyQty, 1, "en proxy, pas pris au stock");
});

test("montage : accepté quand tout est en stock libre", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  const doc = await openBuildModal(page);
  doc.querySelector("#msm-confirm").click();
  await waitFor(() => builds(page).length > 0, 2000, "montage envoyé");
  const [{ payload }] = builds(page);
  assert.equal(payload.built, true);
  assert.equal(payload.deckId, "abc123");
  assert.ok(payload.cards.some((c) => c.name === "Golgari Thug" && c.qty === 1));
});

// --- Rapports d'erreurs ---

const reportsOf = (page) => page.sent.filter((m) => m.type === "REPORT_ERROR").map((m) => m.payload);

test("erreur pendant le contrôle de la page : rapportée, sauf extension rechargée ou service worker injoignable", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("3/4 cartes disponibles"), 2000, "état initial");
  page.handle = (msg) => {
    if (msg.type === "GET_DECK_CONTEXT") throw new Error("Extension context invalidated.");
  };
  page.setStock(FULL_STOCK);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(reportsOf(page), [], "extension rechargée : rien à rapporter");

  // Service worker momentanément injoignable (cf. rapports Sentry
  // JAVASCRIPT-3 et JAVASCRIPT-4) : le contrôle suivant réessaie.
  for (const message of [
    "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
    "Could not establish connection. Receiving end does not exist.",
  ]) {
    page.handle = (msg) => {
      if (msg.type === "GET_DECK_CONTEXT") throw new Error(message);
    };
    page.setStock(FULL_STOCK);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.deepEqual(reportsOf(page), [], "service worker injoignable : rien à rapporter");

  page.handle = (msg) => {
    if (msg.type === "GET_DECK_CONTEXT") throw new TypeError("stock is undefined");
  };
  page.setStock(FULL_STOCK);
  await waitFor(() => reportsOf(page).length > 0, 2000, "erreur rapportée");
  const [report] = reportsOf(page);
  assert.equal(report.where, "deck-page:check");
  assert.equal(report.error.type, "TypeError");
  assert.equal(report.error.message, "stock is undefined");
});

test("erreur non interceptée : rapportée si elle vient de l'extension, pas du site", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  const { win } = page;
  const fire = (filename, message) =>
    win.dispatchEvent(new win.ErrorEvent("error", { error: new win.Error(message), message, filename }));
  fire("https://www.moxfield.com/static/main.js", "erreur du site");
  fire("chrome-extension://test/content-deck.js", "erreur de l'extension");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(reportsOf(page).map((r) => [r.where, r.error.message]), [["deck-page", "erreur de l'extension"]]);
});

test("navigateur en anglais : bouton et fenêtre de montage en anglais", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} }, "en");
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("available"), 2000, "faisabilité affichée");
  assert.match(buttonText(page), /^Mark as physically built — .*\(3\/4 cards available in the free stock/);
  assert.match(buttonTitle(page), /^1 card blocks the build: 1 in another printing/);
  assert.match(buttonTitle(page), /different printing: Birds of Paradise/);

  page.button().click();
  const doc = page.win.document;
  await waitFor(() => doc.querySelector("#msm-card-count") && doc.querySelector("#msm-card-count").textContent, 2000, "fenêtre ouverte");
  assert.equal(doc.querySelector("#msm-modal-title").textContent, "Mark this deck as physically built");
  assert.equal(doc.querySelector("#msm-confirm").textContent, "Confirm the build");
  assert.equal(doc.querySelector("#msm-card-count").textContent, "7 cards in total (5 distinct names)");
});

// --- Version déjà utilisée par un autre deck monté ---

// Golgari Thug possédée en deux éditions (un exemplaire de chaque), dont un
// exemplaire déjà dans un autre deck monté, dans la version otherCode. Sur
// la page de test, le deck la demande dans la version « ZOwRD ».
function thugInAnotherDeck(otherCode) {
  const printings = [{ set: "rav", cn: "87", qty: 1 }, { set: "dds", cn: "50", qty: 1 }];
  return {
    stock: { ...FULL_STOCK, "golgari thug": { name: "Golgari Thug", qty: 1, printings } },
    builtDecks: {
      other: { name: "Autre deck", url: "", cards: [{ name: "Golgari Thug", qty: 1, versions: [{ code: otherCode, qty: 1 }] }], builtAt: 1 },
    },
  };
}

test("montage : refusé si la même version est déjà dans un autre deck monté, alors qu'il reste un exemplaire d'une autre édition", async (t) => {
  // Cas constaté en vrai (novembre 2026) : un terrain possédé en x1 dans
  // deux éditions a pu être monté deux fois dans la même version.
  const page = openDeckPage(thugInAnotherDeck("ZOwRD"));
  t.after(page.close);
  const doc = await openBuildModal(page);
  assert.match(buttonTitle(page), /1 dont la version est déjà dans un autre deck/, "pastille du bouton");
  const warning = doc.querySelector("#msm-version-warning");
  await waitFor(() => warning.textContent.includes("Golgari Thug"), 2000, "version déjà utilisée affichée");
  assert.match(warning.textContent, /dans : Autre deck \(1\)/);
  assert.match(warning.textContent, /tu possèdes : RAV 87 ×1, DDS 50 ×1/);
  assert.equal(doc.querySelector("#msm-shortage-warning").textContent, "", "ce n'est pas un manque de stock");
  assert.match(doc.querySelector("#msm-blocking-summary").textContent, /1 carte bloque le montage/);

  doc.querySelector("#msm-confirm").click();
  await waitFor(() => toasts(page).length > 0, 2000, "refus expliqué");
  assert.deepEqual(toasts(page), ["Montage impossible — version déjà utilisée par un autre deck monté pour : Golgari Thug"]);
  assert.deepEqual(builds(page), []);
});

test("montage : accepté si l'autre deck détient une autre version, les versions sont enregistrées", async (t) => {
  const page = openDeckPage(thugInAnotherDeck("AUTRE"));
  t.after(page.close);
  const doc = await openBuildModal(page);
  doc.querySelector("#msm-confirm").click();
  await waitFor(() => builds(page).length > 0, 2000, "montage envoyé");
  const cards = builds(page)[0].payload.cards;
  assert.deepEqual(cards.find((c) => c.name === "Golgari Thug"), { name: "Golgari Thug", qty: 1, versions: [{ code: "ZOwRD", qty: 1 }] });
  assert.deepEqual(cards.find((c) => c.name === "Swamp"), { name: "Swamp", qty: 3, versions: [{ code: "SWAMP1", qty: 3 }] });
});

test("montage : quantité modifiée à la main, la carte est enregistrée sans version", async (t) => {
  const page = openDeckPage({ stock: { ...FULL_STOCK, "golgari thug": { name: "Golgari Thug", qty: 2 } }, builtDecks: {} });
  t.after(page.close);
  const doc = await openBuildModal(page);
  const textarea = doc.querySelector("#msm-cards-textarea");
  textarea.value = textarea.value.replace("1 Golgari Thug", "2 Golgari Thug").replace("3 Swamp", "2 Swamp");
  doc.querySelector("#msm-confirm").click();
  await waitFor(() => builds(page).length > 0, 2000, "montage envoyé");
  const cards = builds(page)[0].payload.cards;
  // Un exemplaire de plus : sa version est inconnue, celle du premier reste.
  assert.deepEqual(cards.find((c) => c.name === "Golgari Thug"), { name: "Golgari Thug", qty: 2, versions: [{ code: "ZOwRD", qty: 1 }] });
  // Un exemplaire de moins : on ne sait plus lesquels restent.
  assert.deepEqual(cards.find((c) => c.name === "Swamp"), { name: "Swamp", qty: 2 });
});

// Deck de la page de test tel qu'il serait enregistré au montage.
const BUILT_CARDS = [
  { name: "Birds of Paradise", qty: 1 },
  { name: "Golgari Thug", qty: 1 },
  { name: "Revitalizing Repast // Old-Growth Grove", qty: 1 },
  { name: "Sidisi, Brood Tyrant", qty: 1 },
  { name: "Swamp", qty: 3 },
];
const builtDeck = (cards) => ({ abc123: { name: "Deck", url: "", cards, builtAt: 1 } });
const sentOf = (page, type) => page.sent.filter((m) => m.type === type).map((m) => m.payload);

test("deck monté sans versions enregistrées : celles de la page lui sont ajoutées, une seule fois", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: builtDeck(BUILT_CARDS) });
  t.after(page.close);
  await waitFor(() => sentOf(page, "SET_DECK_VERSIONS").length > 0, 2000, "versions envoyées");
  assert.deepEqual(sentOf(page, "SET_DECK_VERSIONS"), [
    {
      deckId: "abc123",
      versions: {
        "golgari thug": [{ code: "ZOwRD", qty: 1 }],
        "revitalizing repast // old-growth grove": [{ code: "xRXAR", qty: 1 }],
        "sidisi, brood tyrant": [{ code: "E0aWJ", qty: 1 }],
        swamp: [{ code: "SWAMP1", qty: 3 }],
      },
    },
  ]);
  // Contrôles suivants (le stock change ailleurs) : pas de nouvel envoi.
  page.setStock(FULL_STOCK);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sentOf(page, "SET_DECK_VERSIONS").length, 1);
  assert.ok(!buttonText(page).includes("la liste a changé"), "deck pas signalé comme modifié");
});

test("deck monté : version changée sur Moxfield, signalé comme modifié sans toucher aux versions enregistrées", async (t) => {
  const cards = BUILT_CARDS.map((c) => (c.name === "Golgari Thug" ? { ...c, versions: [{ code: "ANCIEN", qty: 1 }] } : c));
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: builtDeck(cards) });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("la liste a changé"), 2000, "deck signalé comme modifié");
  assert.deepEqual(sentOf(page, "SET_DECK_PAGE_CHANGES").pop(), {
    deckId: "abc123",
    changes: [{ name: "Golgari Thug", from: 1, to: 1, version: true }],
  });
  assert.deepEqual(sentOf(page, "SET_DECK_VERSIONS"), [], "liste différente du montage : rien n'est complété");

  page.button().click();
  const doc = page.win.document;
  await waitFor(() => doc.querySelector("#msm-update") && !doc.querySelector("#msm-update").hidden, 3000, "mise à jour proposée");
  assert.match(doc.querySelector("#msm-deck-changes").textContent, /↻ Golgari Thug \(version changée\)/);
  doc.querySelector("#msm-update").click();
  await waitFor(() => sentOf(page, "UPDATE_BUILT_DECK").length > 0, 2000, "mise à jour envoyée");
  const updated = sentOf(page, "UPDATE_BUILT_DECK")[0].cards;
  assert.deepEqual(updated.find((c) => c.name === "Golgari Thug"), { name: "Golgari Thug", qty: 1, versions: [{ code: "ZOwRD", qty: 1 }] });
  assert.deepEqual(updated.find((c) => c.name === "Birds of Paradise"), { name: "Birds of Paradise", qty: 1 });
});

// --- Éditions données par l'API du deck (GET_DECK_PRINTINGS) ---

// Ce que le service worker répond pour le deck de la page de test.
const PAGE_PRINTINGS = {
  ZOwRD: { set: "dds", cn: "50" },
  xRXAR: { set: "mh3", cn: "235" },
  E0aWJ: { set: "ktk", cn: "199" },
  SWAMP1: { set: "war", cn: "256" },
};
const printingsAnswer = (answer) => (msg) => (msg.type === "GET_DECK_PRINTINGS" ? answer : undefined);

// Golgari Thug possédée en x2 (RAV) et x1 (DDS), deux exemplaires libres ;
// l'autre deck monté détient la DDS, sous un autre code que celui de la
// page. Le recoupement n'y voit que deux versions différentes.
function thugUnequalEditions() {
  const printings = [{ set: "dds", cn: "50", qty: 1 }, { set: "rav", cn: "87", qty: 2 }];
  const taken = [{ code: "AUTRE", qty: 1, set: "dds", cn: "50" }];
  return {
    stock: { ...FULL_STOCK, "golgari thug": { name: "Golgari Thug", qty: 2, printings } },
    builtDecks: { other: { name: "Autre deck", url: "", cards: [{ name: "Golgari Thug", qty: 1, versions: taken }], builtAt: 1 } },
  };
}

test("montage : refusé quand l'API du deck montre que l'édition demandée, possédée en x1, est déjà montée", async (t) => {
  const page = openDeckPage(thugUnequalEditions(), "fr", printingsAnswer({ ok: true, printings: PAGE_PRINTINGS }));
  t.after(page.close);
  const doc = await openBuildModal(page);
  const warning = doc.querySelector("#msm-version-warning");
  await waitFor(() => warning.textContent.includes("Golgari Thug"), 2000, "version déjà utilisée affichée");
  assert.match(warning.textContent, /dans : Autre deck \(1\)/);
  assert.match(buttonTitle(page), /1 dont la version est déjà dans un autre deck/, "pastille du bouton");
  doc.querySelector("#msm-confirm").click();
  await waitFor(() => toasts(page).length > 0, 2000, "refus expliqué");
  assert.deepEqual(toasts(page), ["Montage impossible — version déjà utilisée par un autre deck monté pour : Golgari Thug"]);
  assert.deepEqual(builds(page), []);
});

test("montage : sans réponse de l'API du deck, repli sur le recoupement, sans erreur", async (t) => {
  const page = openDeckPage(thugUnequalEditions(), "fr", printingsAnswer({ ok: false, code: "not-logged-in", error: "Pas connecté" }));
  t.after(page.close);
  const doc = await openBuildModal(page);
  doc.querySelector("#msm-confirm").click();
  await waitFor(() => builds(page).length > 0, 2000, "montage envoyé");
  const cards = builds(page)[0].payload.cards;
  assert.deepEqual(cards.find((c) => c.name === "Golgari Thug"), { name: "Golgari Thug", qty: 1, versions: [{ code: "ZOwRD", qty: 1 }] });
  assert.deepEqual(toasts(page), ["Deck marqué comme monté, stock décrémenté."]);
  assert.deepEqual(reportsOf(page), []);
  // Contrôles suivants (le stock change ailleurs) : mêmes versions, pas de
  // nouvelle demande.
  const asked = sentOf(page, "GET_DECK_PRINTINGS");
  assert.deepEqual(asked[0], { deckId: "abc123" });
  page.setStock({ ...page.state.stock });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sentOf(page, "GET_DECK_PRINTINGS").length, asked.length, "échec : pas redemandé à chaque contrôle");
});

test("montage : les versions sont enregistrées avec leur édition, pas redemandée ensuite", async (t) => {
  const page = openDeckPage(thugInAnotherDeck("AUTRE"), "fr", printingsAnswer({ ok: true, printings: PAGE_PRINTINGS }));
  t.after(page.close);
  const doc = await openBuildModal(page);
  doc.querySelector("#msm-confirm").click();
  await waitFor(() => builds(page).length > 0, 2000, "montage envoyé");
  const cards = builds(page)[0].payload.cards;
  assert.deepEqual(cards.find((c) => c.name === "Golgari Thug"), {
    name: "Golgari Thug",
    qty: 1,
    versions: [{ code: "ZOwRD", qty: 1, set: "dds", cn: "50" }],
  });
  assert.deepEqual(cards.find((c) => c.name === "Swamp"), { name: "Swamp", qty: 3, versions: [{ code: "SWAMP1", qty: 3, set: "war", cn: "256" }] });
  // Contrôles suivants (le stock change ailleurs) : mêmes versions, pas de
  // nouvelle demande.
  const asked = sentOf(page, "GET_DECK_PRINTINGS");
  assert.deepEqual(asked[0], { deckId: "abc123" });
  page.setStock({ ...page.state.stock });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sentOf(page, "GET_DECK_PRINTINGS").length, asked.length, "éditions connues : pas redemandées");
});

test("deck monté avant la lecture des éditions : elles sont ajoutées à ses versions", async (t) => {
  const cards = BUILT_CARDS.map((c) => (c.name === "Golgari Thug" ? { ...c, versions: [{ code: "ZOwRD", qty: 1 }] } : c));
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: builtDeck(cards) }, "fr", printingsAnswer({ ok: true, printings: PAGE_PRINTINGS }));
  t.after(page.close);
  const withEdition = () => sentOf(page, "SET_DECK_VERSIONS").find((p) => p.versions["golgari thug"] && p.versions["golgari thug"][0].set);
  await waitFor(withEdition, 2000, "éditions envoyées");
  assert.deepEqual(withEdition().versions["golgari thug"], [{ code: "ZOwRD", qty: 1, set: "dds", cn: "50" }]);
  // Toutes les éditions de la page sont connues : plus aucune demande.
  page.setStock({ ...FULL_STOCK });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sentOf(page, "GET_DECK_PRINTINGS").length, 1);
  assert.ok(!buttonText(page).includes("la liste a changé"), "deck pas signalé comme modifié");
});

test("deck d'un autre format que Commander : bouton et faisabilité affichés", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} }, "fr", null, "Modern");
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("dispo") || buttonTitle(page).includes("dispo"), 2000, "faisabilité affichée");
  assert.ok(page.button(), "bouton absent hors Commander");
});

// --- Prix des cartes manquantes (prix « eur » de l'API du deck) ---

// Golgari Thug et Sidisi ont un prix ; Revitalizing Repast n'en a pas.
const PAGE_PRICES = {
  ...PAGE_PRINTINGS,
  ZOwRD: { ...PAGE_PRINTINGS.ZOwRD, eur: 0.15 },
  E0aWJ: { ...PAGE_PRINTINGS.E0aWJ, eur: 0.9 },
};
// Espaces insécables des montants (« 0,15 € ») ramenées à des espaces.
const plainText = (el) => el.textContent.replace(/\s/g, " ");
const NO_STOCK = { ...FULL_STOCK, ...stockOf({ "Golgari Thug": 0, "Sidisi, Brood Tyrant": 0, "Revitalizing Repast // Old-Growth Grove": 0 }) };

test("montage : prix de chaque carte manquante et total, partiel si une carte n'a pas de prix", async (t) => {
  const page = openDeckPage({ stock: NO_STOCK, builtDecks: {} }, "fr", printingsAnswer({ ok: true, printings: PAGE_PRICES }));
  t.after(page.close);
  const doc = await openBuildModal(page);
  const warning = doc.querySelector("#msm-shortage-warning");
  await waitFor(() => warning.textContent.includes("Golgari Thug"), 2000, "manques affichés");
  assert.match(plainText(warning), /Golgari Thug — as 0, besoin 1 \(manque 1\) · 0,15 €/);
  assert.match(plainText(warning), /Sidisi, Brood Tyrant — as 0, besoin 1 \(manque 1\) · 0,90 €/);
  const repast = [...warning.querySelectorAll("li")].find((li) => li.textContent.startsWith("Revitalizing"));
  assert.equal(plainText(repast), "Revitalizing Repast // Old-Growth Grove — as 0, besoin 1 (manque 1)", "sans prix");
  const total = warning.querySelector(".msm-price-total");
  assert.equal(plainText(total), "💶 Coût des cartes manquantes : au moins 1,05 € (1 carte sans prix)");
  assert.match(total.title, /Cardmarket/);

  // Quantité changée à la main : la carte garde son prix.
  const textarea = doc.querySelector("#msm-cards-textarea");
  textarea.value = textarea.value.replace("1 Golgari Thug", "3 Golgari Thug").replace(/^1 Revitalizing.*$/m, "");
  textarea.dispatchEvent(new page.win.Event("input"));
  await waitFor(() => warning.textContent.includes("manque 3"), 2000, "liste recalculée");
  assert.match(plainText(warning), /Golgari Thug — as 0, besoin 3 \(manque 3\) · 0,45 € \(0,15 € l'unité\)/);
  assert.equal(plainText(warning.querySelector(".msm-price-total")), "💶 Coût des cartes manquantes : 1,35 €");
});

test("montage : sans réponse de l'API du deck, ni prix ni total", async (t) => {
  const page = openDeckPage({ stock: NO_STOCK, builtDecks: {} }, "fr", printingsAnswer({ ok: false, code: "network", error: "Réseau" }));
  t.after(page.close);
  const doc = await openBuildModal(page);
  const warning = doc.querySelector("#msm-shortage-warning");
  await waitFor(() => warning.textContent.includes("Golgari Thug"), 2000, "manques affichés");
  assert.ok(!warning.textContent.includes("€"), warning.textContent);
  assert.equal(warning.querySelector(".msm-price-total"), null);
});

test("montage : prix en anglais au format de la langue", async (t) => {
  const page = openDeckPage({ stock: NO_STOCK, builtDecks: {} }, "en", printingsAnswer({ ok: true, printings: PAGE_PRICES }));
  t.after(page.close);
  await waitFor(() => page.button(), 2000, "bouton affiché");
  page.button().click();
  const doc = page.win.document;
  await waitFor(() => doc.querySelector(".msm-price-total"), 3000, "total affiché");
  assert.equal(plainText(doc.querySelector(".msm-price-total")), "💶 Cost of the missing cards: at least €1.05 (1 card without a price)");
});

test("mise à jour d'un deck monté : prix des cartes ajoutées qui manquent", async (t) => {
  // Sidisi ajoutée au deck depuis son montage, plus en stock.
  const cards = BUILT_CARDS.filter((c) => c.name !== "Sidisi, Brood Tyrant");
  const stock = { ...FULL_STOCK, ...stockOf({ "Sidisi, Brood Tyrant": 0 }) };
  const page = openDeckPage({ stock, builtDecks: builtDeck(cards) }, "fr", printingsAnswer({ ok: true, printings: PAGE_PRICES }));
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("la liste a changé"), 2000, "deck signalé comme modifié");
  page.button().click();
  const doc = page.win.document;
  await waitFor(() => doc.querySelector(".msm-price-total"), 3000, "total affiché");
  const warning = doc.querySelector("#msm-shortage-warning");
  assert.match(plainText(warning), /Sidisi, Brood Tyrant — as 0, besoin 1 \(manque 1\) · 0,90 €/);
  assert.equal(plainText(warning.querySelector(".msm-price-total")), "💶 Coût des cartes manquantes : 0,90 €");
});

test("montage : quantité abaissée à la main sous celle de la page, la carte garde son prix", async (t) => {
  const page = openDeckPage({ stock: NO_STOCK, builtDecks: {} }, "fr", printingsAnswer({ ok: true, printings: PAGE_PRICES }));
  t.after(page.close);
  // 3 Golgari Thug sur la page : la version détectée porte sur 3 exemplaires.
  const input = page.win.document.querySelector('input[name="ZOwRDF0"]');
  input.value = "3";
  input.setAttribute("value", "3");
  // Total de la page désormais différent de celui annoncé : pas de pastille
  // de faisabilité à attendre, la fenêtre s'ouvre quand même.
  await waitFor(() => page.button(), 2000, "bouton affiché");
  page.button().click();
  const doc = page.win.document;
  await waitFor(() => doc.querySelector("#msm-shortage-warning"), 2000, "fenêtre ouverte");
  const warning = doc.querySelector("#msm-shortage-warning");
  await waitFor(() => warning.textContent.includes("manque 3"), 2000, "manques affichés");
  const textarea = doc.querySelector("#msm-cards-textarea");
  textarea.value = textarea.value.replace("3 Golgari Thug", "2 Golgari Thug");
  textarea.dispatchEvent(new page.win.Event("input"));
  await waitFor(() => warning.textContent.includes("manque 2"), 2000, "liste recalculée");
  assert.match(plainText(warning), /Golgari Thug — as 0, besoin 2 \(manque 2\) · 0,30 € \(0,15 € l'unité\)/);
});

// Cas constaté en vrai (novembre 2026) : pas de prix pour certaines cartes
// manquantes. Une carte manquante est souvent absente de la collection
// (marqueur « no ») ou possédée dans une autre édition (« pt ») : la page ne
// donne pas de version possédée, mais le code de l'impression du deck reste
// lisible dans le marqueur.
test("montage : prix des cartes manquantes absentes de la collection ou d'une autre édition", async (t) => {
  const page = openDeckPage({ stock: NO_STOCK, builtDecks: {} }, "fr", printingsAnswer({ ok: true, printings: PAGE_PRICES }));
  t.after(page.close);
  // Aucune carte du deck dans sa version : rien à enregistrer, mais les prix
  // doivent quand même être demandés.
  for (const marker of page.win.document.querySelectorAll('[id^="collection_full_"]')) {
    marker.id = marker.id.replace("collection_full_", marker.id.includes("E0aWJ") ? "collection_pt_" : "collection_no_");
  }
  await waitFor(() => page.button(), 2000, "bouton affiché");
  page.button().click();
  const doc = page.win.document;
  await waitFor(() => doc.querySelector(".msm-price-total"), 3000, "total affiché");
  const warning = doc.querySelector("#msm-shortage-warning");
  assert.match(plainText(warning), /Golgari Thug — as 0, besoin 1 \(manque 1\) · 0,15 €/, "absente de la collection");
  assert.match(plainText(warning), /Sidisi, Brood Tyrant — as 0, besoin 1 \(manque 1\) · 0,90 €/, "autre édition");
  assert.equal(plainText(warning.querySelector(".msm-price-total")), "💶 Coût des cartes manquantes : au moins 1,05 € (1 carte sans prix)");
});

test("code absent de la réponse de l'API : redemandé seulement après quelques minutes", async (t) => {
  // PAGE_PRINTINGS n'a pas l'impression de Birds of Paradise (EZA0w).
  const cards = BUILT_CARDS.map((c) => (c.name === "Golgari Thug" ? { ...c, versions: [{ code: "ZOwRD", qty: 1 }] } : c));
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: builtDeck(cards) }, "fr", printingsAnswer({ ok: true, printings: PAGE_PRINTINGS }));
  t.after(page.close);
  await waitFor(() => sentOf(page, "GET_DECK_PRINTINGS").length > 0, 2000, "première demande");
  page.setStock({ ...FULL_STOCK });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sentOf(page, "GET_DECK_PRINTINGS").length, 1, "pas redemandé aussitôt");
  // Six minutes plus tard (horloge de la page).
  const now = page.win.Date.now;
  page.win.Date.now = () => now() + 6 * 60 * 1000;
  page.setStock({ ...FULL_STOCK });
  await waitFor(() => sentOf(page, "GET_DECK_PRINTINGS").length === 2, 2000, "redemandé après le délai");
});

// --- Proxies ---

test("montage avec des proxies : les exemplaires manquants partent en proxy, avec leur version", async (t) => {
  const page = openDeckPage({ stock: NO_STOCK, builtDecks: {} }, "fr", printingsAnswer({ ok: true, printings: PAGE_PRICES }));
  t.after(page.close);
  const doc = await openBuildModal(page);
  const confirm = doc.querySelector("#msm-confirm");
  await waitFor(() => confirm.textContent === "Confirmer le montage avec 3 proxies", 2000, "bouton principal avec les proxies");
  assert.match(confirm.title, /joués en proxy/);
  assert.equal(doc.querySelector("#msm-shortage-warning button.msm-proxy-btn"), null, "plus de bouton à part dans l'encadré");
  confirm.click();
  await waitFor(() => builds(page).length > 0, 2000, "montage envoyé");
  const cards = builds(page)[0].payload.cards;
  const byName = (name) => cards.find((c) => c.name === name);
  assert.deepEqual(byName("Golgari Thug"), {
    name: "Golgari Thug",
    qty: 1,
    versions: [{ code: "ZOwRD", qty: 1, set: "dds", cn: "50" }],
    proxyQty: 1,
    proxyPrinting: { set: "dds", cn: "50" },
  });
  assert.deepEqual(byName("Sidisi, Brood Tyrant").proxyQty, 1);
  assert.deepEqual(byName("Sidisi, Brood Tyrant").proxyPrinting, { set: "ktk", cn: "199" });
  assert.equal(byName("Revitalizing Repast // Old-Growth Grove").proxyQty, 1);
  assert.equal(byName("Birds of Paradise").proxyQty, undefined, "en stock : pas de proxy");
  assert.equal(byName("Swamp").proxyQty, undefined, "terrain de base : jamais en proxy");
  await waitFor(() => toasts(page).length > 0, 2000, "montage confirmé");
  assert.deepEqual(toasts(page), ["Deck monté avec 3 proxies — imprime-les depuis le popup ou cette fenêtre."]);
});

test("montage avec des proxies : une version différente bloque toujours", async (t) => {
  // Birds of Paradise possédée dans une autre version : un proxy ne règle
  // pas une question d'édition.
  const page = openDeckPage({ stock: NO_STOCK, builtDecks: {} }, "fr", printingsAnswer({ ok: true, printings: PAGE_PRICES }));
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("dispo"), 2000, "faisabilité affichée");
  page.button().click();
  const doc = page.win.document;
  await waitFor(() => doc.querySelector("#msm-shortage-warning") && /Golgari/.test(doc.querySelector("#msm-shortage-warning").textContent), 2000, "manques affichés");
  const confirm = doc.querySelector("#msm-confirm");
  assert.equal(confirm.textContent, "Confirmer le montage", "pas de proxies tant qu'une version différente bloque");
  confirm.click();
  await waitFor(() => toasts(page).length > 0, 2000, "refus expliqué");
  assert.deepEqual(toasts(page), ["Montage impossible — version différente de ta collection pour : Birds of Paradise"]);
  assert.deepEqual(builds(page), []);
});

test("montage avec des proxies : libellé normal dès que les cartes arrivent en stock", async (t) => {
  const page = openDeckPage({ stock: NO_STOCK, builtDecks: {} }, "fr", printingsAnswer({ ok: true, printings: PAGE_PRICES }));
  t.after(page.close);
  const doc = await openBuildModal(page);
  const confirm = doc.querySelector("#msm-confirm");
  await waitFor(() => confirm.textContent === "Confirmer le montage avec 3 proxies", 2000, "avec les proxies");
  const textarea = doc.querySelector("#msm-cards-textarea");
  // Liste vidée : rien à monter, libellé normal.
  textarea.value = "";
  textarea.dispatchEvent(new page.win.Event("input"));
  await waitFor(() => confirm.textContent === "Confirmer le montage", 2000, "liste vide");
  textarea.value = "1 Golgari Thug";
  textarea.dispatchEvent(new page.win.Event("input"));
  await waitFor(() => confirm.textContent === "Confirmer le montage avec 1 proxy", 2000, "de nouveau avec un proxy");
  // Les cartes manquantes retirées de la liste : plus rien ne manque.
  textarea.value = "1 Birds of Paradise\n3 Swamp";
  textarea.dispatchEvent(new page.win.Event("input"));
  await waitFor(() => confirm.textContent === "Confirmer le montage", 2000, "libellé normal");
  assert.equal(confirm.title, "");
  confirm.click();
  await waitFor(() => builds(page).length > 0, 2000, "montage envoyé");
  assert.ok(builds(page)[0].payload.cards.every((c) => c.proxyQty === undefined), "aucun proxy");
});

test("deck monté avec des proxies : nombre affiché sur le bouton, mis à jour quand ils sont remplacés", async (t) => {
  const cards = BUILT_CARDS.map((c) => (c.name === "Golgari Thug" ? { ...c, proxyQty: 1, proxyPrinting: { set: "dds", cn: "50" } } : c));
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: builtDeck(cards) });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("avec 1 proxy"), 2000, "proxies sur le bouton");
  assert.equal(buttonText(page), "Monté physiquement avec 1 proxy (cliquer pour démonter)");
  assert.equal(page.button().querySelector(".msm-proxy-badge").textContent, "1");
  // Proxy remplacé depuis le popup : le bouton suit.
  page.state = { ...page.state, builtDecks: builtDeck(BUILT_CARDS) };
  page.setStock(FULL_STOCK);
  await waitFor(() => buttonText(page) === "Monté physiquement (cliquer pour démonter)", 3000, "plus de proxy");
  assert.equal(page.button().querySelector(".msm-proxy-badge"), null);
});

test("mise à jour avec des proxies : nouveaux proxies, et ceux du montage gardés", async (t) => {
  // Monté sans Sidisi, Golgari Thug en proxy ; Sidisi ajoutée depuis, plus en stock.
  const cards = BUILT_CARDS.filter((c) => c.name !== "Sidisi, Brood Tyrant").map((c) =>
    c.name === "Golgari Thug" ? { ...c, proxyQty: 1, proxyPrinting: { set: "dds", cn: "50" } } : c
  );
  const stock = { ...FULL_STOCK, ...stockOf({ "Sidisi, Brood Tyrant": 0 }) };
  const page = openDeckPage({ stock, builtDecks: builtDeck(cards) }, "fr", printingsAnswer({ ok: true, printings: PAGE_PRICES }));
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("la liste a changé"), 2000, "deck signalé comme modifié");
  page.button().click();
  const doc = page.win.document;
  const update = () => doc.querySelector("#msm-update");
  await waitFor(() => update() && update().textContent === "Mettre à jour avec 1 proxy", 3000, "bouton principal avec les proxies");
  assert.match(doc.querySelector("#msm-proxy-info").textContent, /Ce deck compte 1 proxy/);
  assert.ok(!update().disabled, "seul le stock manque : proposée avec des proxies");
  update().click();
  await waitFor(() => sentOf(page, "UPDATE_BUILT_DECK").length > 0, 2000, "mise à jour envoyée");
  const updated = sentOf(page, "UPDATE_BUILT_DECK")[0].cards;
  assert.deepEqual(updated.find((c) => c.name === "Sidisi, Brood Tyrant"), {
    name: "Sidisi, Brood Tyrant",
    qty: 1,
    versions: [{ code: "E0aWJ", qty: 1, set: "ktk", cn: "199" }],
    proxyQty: 1,
    proxyPrinting: { set: "ktk", cn: "199" },
  });
  assert.equal(updated.find((c) => c.name === "Golgari Thug").proxyQty, 1, "proxy du montage gardé");
  await waitFor(() => toasts(page).length > 0, 2000, "mise à jour confirmée");
  assert.deepEqual(toasts(page), ["Montage mis à jour avec 1 nouveau proxy."]);
});

test("mise à jour sans changement de stock : les proxies du montage sont reportés", async (t) => {
  // Golgari Thug en proxy ; une Swamp en plus sur la page (en stock).
  const cards = BUILT_CARDS.map((c) =>
    c.name === "Golgari Thug" ? { ...c, proxyQty: 1 } : c.name === "Swamp" ? { ...c, qty: 2 } : c
  );
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: builtDeck(cards) });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("la liste a changé"), 2000, "deck signalé comme modifié");
  page.button().click();
  const doc = page.win.document;
  await waitFor(() => doc.querySelector("#msm-update") && !doc.querySelector("#msm-update").hidden, 3000, "mise à jour proposée");
  doc.querySelector("#msm-update").click();
  await waitFor(() => sentOf(page, "UPDATE_BUILT_DECK").length > 0, 2000, "mise à jour envoyée");
  const updated = sentOf(page, "UPDATE_BUILT_DECK")[0].cards;
  assert.equal(updated.find((c) => c.name === "Golgari Thug").proxyQty, 1);
});

test("deck monté avec des proxies : nombre affiché et impression demandée", async (t) => {
  const cards = BUILT_CARDS.map((c) => (c.name === "Sidisi, Brood Tyrant" ? { ...c, proxyQty: 1 } : c));
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: builtDeck(cards) });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("Monté"), 2000, "bouton de deck monté");
  page.button().click();
  const doc = page.win.document;
  await waitFor(() => doc.querySelector("#msm-proxy-info") && !doc.querySelector("#msm-proxy-info").hidden, 3000, "proxies affichés");
  assert.match(doc.querySelector("#msm-proxy-info").textContent, /Ce deck compte 1 proxy\. 🖨️ Imprimer les proxies/);
  doc.querySelector("#msm-proxy-info button").click();
  await waitFor(() => sentOf(page, "OPEN_PROXIES_PAGE").length > 0, 2000, "impression demandée");
  assert.deepEqual(sentOf(page, "OPEN_PROXIES_PAGE"), [{ deckId: "abc123" }]);
});

// --- Passer le deck Moxfield sur les éditions de ta collection ---

const BIRDS_PLAN = {
  name: "Birds of Paradise",
  board: "commanders",
  uniqueCardId: "u0005",
  from: { set: "plst", cn: "52★" },
  to: { set: "m10", cn: "168", setName: "Magic 2010", cardId: "BrM10", finishes: ["nonFoil", "foil"] },
};

// Barre d'actions de Moxfield (repères confirmés via inspection réelle, cf.
// findActionBar) : absente des pages de test enregistrées. Sans cœur, notre
// bouton va en fin de barre (cf. findBarAnchor).
function addActionBar(win, icons = ["arrow-up-to-line", "comment", "heart"]) {
  const bar = win.document.createElement("div");
  bar.className = "msm-test-bar";
  bar.innerHTML = icons.map((icon) => `<a><svg data-icon="${icon}"></svg></a>`).join("");
  win.document.body.prepend(bar);
}

// Page avec la barre d'actions ; saved : bilan laissé avant un rechargement.
function openBarPage(handle = null, saved = null, state = { stock: FULL_STOCK, builtDecks: {} }, icons = undefined) {
  return openDeckPage(
    state,
    "fr",
    handle,
    "Commander",
    (win) => {
      if (saved) win.sessionStorage.setItem("msmOwnedEditionsDone", JSON.stringify(saved));
    },
    icons
  );
}

const editionsButton = (page) => page.win.document.querySelector(".msm-editions-bar-btn");
const editionsShown = (page) => Boolean(editionsButton(page)) && editionsButton(page).style.display !== "none";

// Bouton « Utiliser mes éditions » affiché (Birds of Paradise possédée dans
// une autre version).
async function waitEditionsButton(page) {
  await waitFor(() => editionsShown(page), 2000, "bouton des éditions");
  return editionsButton(page);
}

test("éditions de la collection : bouton du ruban juste à gauche de « Monter », avec le nombre de cartes", async (t) => {
  const page = openBarPage();
  t.after(page.close);
  const button = await waitEditionsButton(page);
  const buildButton = page.win.document.querySelector(".msm-bar-btn:not(.msm-editions-bar-btn):not(.msm-like-bar-btn)");
  assert.equal(button.nextElementSibling, buildButton, "à gauche du bouton de montage");
  // Ordre : « j'aime » de Moxfield, notre cœur, nos éditions, « Monter ».
  assert.ok(button.previousElementSibling.classList.contains("msm-like-bar-btn"), "notre cœur à gauche");
  assert.equal(button.previousElementSibling.previousElementSibling.querySelector("svg").getAttribute("data-icon"), "heart");
  assert.equal(button.querySelector(".msm-editions-badge").textContent, "1");
  assert.match(button.title, /^Utiliser mes éditions — 1 carte possédée dans une autre édition\n.*Le deck n'est pas monté/);
});

test("éditions de la collection : bouton masqué sans carte d'une autre édition, remis en place après un re-rendu", async (t) => {
  const page = openBarPage();
  t.after(page.close);
  await waitEditionsButton(page);
  // React re-rend la barre : notre bouton de montage disparaît.
  page.win.document.querySelector(".msm-bar-btn:not(.msm-editions-bar-btn):not(.msm-like-bar-btn)").remove();
  await waitFor(() => page.win.document.querySelector(".msm-bar-btn:not(.msm-editions-bar-btn):not(.msm-like-bar-btn)"), 2000, "bouton recréé");
  assert.equal(page.win.document.querySelectorAll(".msm-editions-bar-btn").length, 1, "un seul bouton des éditions");
  assert.equal(editionsButton(page).nextElementSibling, page.win.document.querySelector(".msm-bar-btn:not(.msm-editions-bar-btn):not(.msm-like-bar-btn)"));
  // Plus aucune carte d'une autre édition sur la page.
  const marker = page.win.document.querySelector('[id^="collection_pt_"]');
  marker.id = marker.id.replace("collection_pt_", "collection_full_");
  await waitFor(() => !editionsShown(page), 2000, "bouton masqué");
});

test("éditions de la collection : bouton retiré par un re-rendu de la barre, remis à gauche de « Monter »", async (t) => {
  for (const icons of [undefined, ["arrow-up-to-line", "comment"]]) {
    const page = openBarPage(null, null, undefined, icons);
    t.after(page.close);
    (await waitEditionsButton(page)).remove();
    await waitFor(() => editionsShown(page), 2000, "bouton des éditions recréé");
    const buildButton = page.win.document.querySelector(".msm-bar-btn:not(.msm-editions-bar-btn):not(.msm-like-bar-btn)");
    assert.equal(editionsButton(page).nextElementSibling, buildButton);
  }
});

test("éditions de la collection : un clic change les éditions, recharge la page, ne monte pas le deck", async (t) => {
  const answers = {
    PLAN_OWNED_EDITIONS: { ok: true, plan: [BIRDS_PLAN], skipped: [{ name: "Swamp", reason: "several" }] },
    APPLY_OWNED_EDITIONS: { ok: true, done: ["Birds of Paradise"], skipped: [] },
  };
  const page = openBarPage((msg) => answers[msg.type]);
  t.after(page.close);
  (await waitEditionsButton(page)).click();
  await waitFor(() => page.reloads.length > 0, 2000, "page rechargée");
  assert.deepEqual(sentOf(page, "PLAN_OWNED_EDITIONS"), [{ deckId: "abc123", names: ["Birds of Paradise"] }]);
  assert.deepEqual(sentOf(page, "APPLY_OWNED_EDITIONS"), [{ deckId: "abc123", plan: [BIRDS_PLAN] }], "sans confirmation");
  assert.deepEqual(builds(page), [], "deck pas monté");
  assert.equal(page.win.document.querySelector(".msm-overlay"), null, "pas de fenêtre de montage");
  const saved = JSON.parse(page.win.sessionStorage.getItem("msmOwnedEditionsDone"));
  assert.deepEqual({ ...saved, at: typeof saved.at }, { deckId: "abc123", done: 1, error: null, at: "number" });
});

test("éditions de la collection : deck déjà monté, le bouton est là aussi", async (t) => {
  const builtDecks = {
    abc123: {
      name: "Deck",
      cards: [
        { name: "Birds of Paradise", qty: 1 },
        { name: "Golgari Thug", qty: 1 },
        { name: "Revitalizing Repast // Old-Growth Grove", qty: 1 },
        { name: "Sidisi, Brood Tyrant", qty: 1 },
        { name: "Swamp", qty: 3 },
      ],
    },
  };
  const page = openBarPage(null, null, { stock: FULL_STOCK, builtDecks });
  t.after(page.close);
  await waitEditionsButton(page);
});

const progressOverlay = (page) => page.win.document.querySelector(".msm-progress-overlay");
const progressText = (page) => progressOverlay(page).querySelector(".msm-progress-text").textContent;
const progressWidth = (page) => progressOverlay(page).querySelector(".msm-progress-fill").style.width;

test("éditions de la collection : fenêtre bloquante avec jauge pendant le traitement, gardée jusqu'au rechargement", async (t) => {
  const gates = {};
  const wait = (type) => new Promise((resolve) => (gates[type] = resolve));
  const answers = {
    PLAN_OWNED_EDITIONS: { ok: true, plan: [BIRDS_PLAN, BIRDS_PLAN], skipped: [] },
    APPLY_OWNED_EDITIONS: { ok: true, done: ["Birds of Paradise"], skipped: [] },
  };
  const page = openBarPage((msg) => (answers[msg.type] ? wait(msg.type).then(() => answers[msg.type]) : undefined));
  t.after(page.close);
  (await waitEditionsButton(page)).click();
  await waitFor(() => progressOverlay(page), 2000, "fenêtre affichée");
  assert.match(progressText(page), /Recherche de tes éditions/);
  assert.ok(progressOverlay(page).querySelector(".msm-progress-bar").classList.contains("msm-progress-indeterminate"), "durée inconnue");
  page.emit({ type: "OWNED_EDITIONS_PROGRESS", step: "plan", done: 1, total: 4 });
  assert.equal(progressText(page), "Recherche des éditions chez Moxfield : 1 / 4");
  assert.equal(progressWidth(page), "25%");
  assert.ok(!progressOverlay(page).querySelector(".msm-progress-bar").classList.contains("msm-progress-indeterminate"));
  gates.PLAN_OWNED_EDITIONS();
  await waitFor(() => /Changement des cartes/.test(progressText(page)), 2000, "écriture commencée");
  assert.equal(progressText(page), "Changement des cartes sur Moxfield : 0 / 2");
  page.emit({ type: "OWNED_EDITIONS_PROGRESS", step: "apply", done: 1, total: 2 });
  assert.equal(progressText(page), "Changement des cartes sur Moxfield : 1 / 2");
  assert.equal(progressWidth(page), "50%");
  // Autres messages ignorés.
  page.emit({ type: "AUTRE", step: "apply", done: 2, total: 2 });
  assert.equal(progressWidth(page), "50%");
  gates.APPLY_OWNED_EDITIONS();
  await waitFor(() => page.reloads.length > 0, 2000, "page rechargée");
  assert.ok(progressOverlay(page), "fenêtre gardée jusqu'au rechargement");
  assert.equal(progressText(page), "C'est fait, rechargement de la page…");
  assert.equal(progressWidth(page), "100%");
});

test("éditions de la collection : fenêtre retirée quand rien n'a changé ou en cas d'erreur", async (t) => {
  for (const answers of [
    { PLAN_OWNED_EDITIONS: { ok: false, code: "not-logged-in", error: "Pas connecté à Moxfield" } },
    { PLAN_OWNED_EDITIONS: { ok: true, plan: [], skipped: [{ name: "Birds of Paradise", reason: "no-other-edition" }] } },
    {
      PLAN_OWNED_EDITIONS: { ok: true, plan: [BIRDS_PLAN], skipped: [] },
      APPLY_OWNED_EDITIONS: { ok: false, code: "network", error: "Moxfield injoignable", done: [], skipped: [] },
    },
  ]) {
    const page = openBarPage((msg) => answers[msg.type]);
    t.after(page.close);
    (await waitEditionsButton(page)).click();
    await waitFor(() => toasts(page).length > 0, 2000, "résultat affiché");
    assert.equal(progressOverlay(page), null);
    // Avancement arrivé après coup : pas de fenêtre fantôme.
    page.emit({ type: "OWNED_EDITIONS_PROGRESS", step: "apply", done: 1, total: 1 });
    assert.equal(progressOverlay(page), null);
  }
});

test("éditions de la collection : arrêt en cours de route, la page est quand même rechargée", async (t) => {
  const answers = {
    PLAN_OWNED_EDITIONS: { ok: true, plan: [BIRDS_PLAN, BIRDS_PLAN], skipped: [] },
    APPLY_OWNED_EDITIONS: { ok: false, code: "network", error: "Moxfield injoignable", done: ["Birds of Paradise"], skipped: [] },
  };
  const page = openBarPage((msg) => answers[msg.type]);
  t.after(page.close);
  (await waitEditionsButton(page)).click();
  await waitFor(() => page.reloads.length > 0, 2000, "page rechargée");
  assert.equal(JSON.parse(page.win.sessionStorage.getItem("msmOwnedEditionsDone")).error, "Moxfield injoignable");
});

test("éditions de la collection : rien de changé, raison affichée sans rechargement", async (t) => {
  const answers = {
    PLAN_OWNED_EDITIONS: { ok: true, plan: [BIRDS_PLAN], skipped: [{ name: "Swamp", reason: "several" }] },
    APPLY_OWNED_EDITIONS: { ok: false, code: "network", error: "Moxfield injoignable", done: [], skipped: [] },
  };
  const page = openBarPage((msg) => answers[msg.type]);
  t.after(page.close);
  (await waitEditionsButton(page)).click();
  await waitFor(() => toasts(page).some((m) => /arrêt/.test(m)), 2000, "erreur affichée");
  assert.ok(
    toasts(page).includes("0 carte passée, puis arrêt : Moxfield injoignable Swamp — plusieurs éditions dans la même ligne du deck, à changer à la main")
  );
  assert.deepEqual(page.reloads, []);
  assert.equal(page.win.sessionStorage.getItem("msmOwnedEditionsDone"), null);
});

test("éditions de la collection : aucune carte à changer, rien n'est écrit", async (t) => {
  const answers = { PLAN_OWNED_EDITIONS: { ok: true, plan: [], skipped: [{ name: "Birds of Paradise", reason: "no-other-edition" }] } };
  const page = openBarPage((msg) => answers[msg.type]);
  t.after(page.close);
  (await waitEditionsButton(page)).click();
  await waitFor(() => toasts(page).some((m) => /Aucune carte/.test(m)), 2000, "raison affichée");
  assert.ok(toasts(page).some((m) => /Birds of Paradise — aucune autre édition dans ta collection/.test(m)));
  assert.deepEqual(sentOf(page, "APPLY_OWNED_EDITIONS"), []);
  assert.deepEqual(page.reloads, []);
});

test("éditions de la collection : proposition impossible, raison affichée", async (t) => {
  const answers = { PLAN_OWNED_EDITIONS: { ok: false, code: "not-logged-in", error: "Pas connecté à Moxfield" } };
  const page = openBarPage((msg) => answers[msg.type]);
  t.after(page.close);
  (await waitEditionsButton(page)).click();
  await waitFor(() => toasts(page).some((m) => m.startsWith("Erreur")), 2000, "erreur affichée");
  assert.ok(toasts(page).includes("Erreur : Pas connecté à Moxfield"));
  assert.deepEqual(page.reloads, []);
});

test("éditions de la collection : un seul traitement à la fois", async (t) => {
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const answers = {
    PLAN_OWNED_EDITIONS: { ok: true, plan: [BIRDS_PLAN], skipped: [] },
    APPLY_OWNED_EDITIONS: { ok: true, done: ["Birds of Paradise"], skipped: [] },
  };
  const page = openBarPage((msg) => (msg.type === "PLAN_OWNED_EDITIONS" ? pending.then(() => answers[msg.type]) : answers[msg.type]));
  t.after(page.close);
  const button = await waitEditionsButton(page);
  button.click();
  button.click();
  assert.ok(button.classList.contains("msm-busy"));
  release();
  await waitFor(() => page.reloads.length > 0, 2000, "page rechargée");
  assert.equal(sentOf(page, "PLAN_OWNED_EDITIONS").length, 1);
});

test("éditions de la collection : après le rechargement, bilan affiché, fenêtre de montage non ouverte", async (t) => {
  const page = openBarPage(null, { deckId: "abc123", done: 2, error: null, at: Date.now() });
  t.after(page.close);
  await waitFor(() => toasts(page).length > 0, 2000, "bilan affiché");
  assert.deepEqual(toasts(page), ["2 cartes passées sur l'édition de ta collection."]);
  assert.equal(page.win.sessionStorage.getItem("msmOwnedEditionsDone"), null, "une seule fois");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(page.win.document.querySelector(".msm-overlay"), null);
  assert.equal(toasts(page).length, 1);
});

test("éditions de la collection : bilan d'un arrêt en cours de route après le rechargement", async (t) => {
  const page = openBarPage(null, { deckId: "abc123", done: 1, error: "Moxfield injoignable", at: Date.now() });
  t.after(page.close);
  await waitFor(() => toasts(page).length > 0, 2000, "bilan affiché");
  assert.deepEqual(toasts(page), ["1 carte passée, puis arrêt : Moxfield injoignable"]);
});

test("éditions de la collection : cartes impossibles à changer plus comptées sur le bouton (terrains de base)", async (t) => {
  const answers = {
    PLAN_OWNED_EDITIONS: {
      ok: true,
      plan: [],
      skipped: [
        { name: "Birds of Paradise", reason: "not-enough" },
        { name: "Golgari Thug", reason: "taken" },
      ],
    },
  };
  const page = openBarPage((msg) => answers[msg.type]);
  t.after(page.close);
  (await waitEditionsButton(page)).click();
  await waitFor(() => toasts(page).length > 0, 2000, "raison affichée");
  assert.ok(toasts(page).some((m) => m.includes("Birds of Paradise — pas assez d'exemplaires dans une même édition")));
  assert.ok(toasts(page).some((m) => m.includes("Golgari Thug — tes exemplaires des éditions possédées sont déjà dans d'autres decks montés")));
  await waitFor(() => !editionsShown(page), 2000, "bouton masqué");
  // Toujours masqué au contrôle suivant de la page.
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(!editionsShown(page));
});

test("éditions de la collection : cartes impossibles à changer, retenues par deck jusqu'à la fermeture de l'onglet", async (t) => {
  const remembered = (unfixable) =>
    openDeckPage({ stock: FULL_STOCK, builtDecks: {} }, "fr", null, "Commander", (win) => {
      win.sessionStorage.setItem("msmOwnedEditionsUnfixable", JSON.stringify(unfixable));
    });
  const same = remembered({ abc123: ["birds of paradise"] });
  t.after(same.close);
  await waitFor(() => buttonTitle(same).includes("dispo"), 2000, "faisabilité affichée");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!editionsShown(same), "même deck : plus comptée");
  const other = remembered({ autre: ["birds of paradise"] });
  t.after(other.close);
  await waitEditionsButton(other);
});

test("éditions de la collection : carte modifiée ailleurs entre-temps, toujours comptée", async (t) => {
  const answers = {
    PLAN_OWNED_EDITIONS: { ok: true, plan: [BIRDS_PLAN], skipped: [] },
    APPLY_OWNED_EDITIONS: { ok: true, done: [], skipped: [{ name: "Birds of Paradise", reason: "changed" }] },
  };
  const page = openBarPage((msg) => answers[msg.type]);
  t.after(page.close);
  (await waitEditionsButton(page)).click();
  await waitFor(() => toasts(page).length > 0, 2000, "résultat affiché");
  assert.ok(editionsShown(page));
  assert.equal(page.win.sessionStorage.getItem("msmOwnedEditionsUnfixable"), null);
});

test("éditions de la collection : rechargement trop ancien ou d'un autre deck, pas de bilan", async (t) => {
  for (const saved of [
    { deckId: "abc123", done: 2, error: null, at: Date.now() - 60000 },
    { deckId: "autre", done: 2, error: null, at: Date.now() },
  ]) {
    const page = openBarPage(null, saved);
    t.after(page.close);
    await waitEditionsButton(page);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(toasts(page), []);
  }
});

test("fenêtre de montage : cartes d'une autre édition listées, sans bouton des éditions", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("dispo"), 2000, "faisabilité affichée");
  page.button().click();
  const box = () => page.win.document.querySelector("#msm-printing-warning");
  await waitFor(() => box() && /Birds of Paradise/.test(box().textContent), 2000, "liste affichée");
  assert.equal(box().querySelector("button"), null);
});

// Cas réel (novembre 2026) : un deck pas monté affichait l'icône « monté ».
// En passant d'un deck monté à un autre dans Moxfield (sans rechargement),
// la réponse « monté ? » de l'ancien deck arrivait après celle du nouveau
// (service worker en réveil) et écrasait son état, sans correction ensuite.
test("navigation d'un deck monté vers un autre : réponse tardive de l'ancien deck ignorée", async (t) => {
  const deck = { name: "Deck A", url: "", cards: [{ name: "Birds of Paradise", qty: 1 }], builtAt: 1 };
  let delayed = 0;
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: { abc123: deck } }, "fr", async (msg) => {
    // Premières lectures du deck monté (abc123) : lentes.
    if (msg.type === "GET_DECK_CONTEXT" && msg.payload.deckId === "abc123" && delayed++ < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return undefined;
  });
  t.after(page.close);
  await new Promise((resolve) => setTimeout(resolve, 100));
  page.win.history.pushState({}, "", "/decks/zzz999"); // autre deck, pas monté
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.match(buttonText(page), /^Marquer comme monté physiquement/, "deck zzz999 pas monté");
});

test("deck démonté ailleurs (popup, autre PC) pendant que sa page est ouverte : bouton mis à jour", async (t) => {
  const deck = { name: "Deck", url: "", cards: [{ name: "Birds of Paradise", qty: 1 }], builtAt: 1 };
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: { abc123: deck } });
  t.after(page.close);
  await waitFor(() => buttonText(page).startsWith("Monté physiquement"), 2000, "deck monté");
  page.state = { ...page.state, builtDecks: {} };
  page.setStock(FULL_STOCK); // signale le changement de l'état, comme chrome.storage
  await waitFor(() => buttonText(page).startsWith("Marquer comme monté physiquement"), 2000, "deck affiché comme pas monté");
});

// Retour utilisateur (novembre 2026) : la coche verte de « montable » sur
// la boîte ouverte se lisait « déjà monté ».
test("pastille « montable » sans coche ; deck monté signalé à part, sans pastille", async (t) => {
  const buildable = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(buildable.close);
  // Birds of Paradise dans la bonne version : plus rien ne bloque.
  const marker = buildable.win.document.querySelector('[id^="collection_pt_"]');
  marker.id = marker.id.replace("collection_pt_", "collection_full_");
  await waitFor(() => buildable.button().querySelector(".msm-avail-ok"), 2000, "deck montable");
  assert.equal(buildable.button().querySelector(".msm-avail-ok").textContent, "OK");
  assert.ok(!buildable.button().classList.contains("msm-btn-built"));

  const deck = { name: "Deck", url: "", cards: [{ name: "Birds of Paradise", qty: 1 }], builtAt: 1 };
  const built = openDeckPage({ stock: FULL_STOCK, builtDecks: { abc123: deck } });
  t.after(built.close);
  await waitFor(() => built.button() && built.button().classList.contains("msm-btn-built"), 2000, "deck monté");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(built.button().querySelector(".msm-avail-badge:not(.msm-proxy-badge)"), null, "aucune pastille de faisabilité");
});

// Vue « Mes decks » du popup : un deck y entre par le cœur du bandeau,
// plus à l'ouverture (qui ajoutait aussi les decks des autres consultés).
const likeButton = (page) => page.win.document.querySelector(".msm-like-bar-btn");

test("deck ouvert : pas ajouté à « Mes decks » sans clic sur le cœur", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => likeButton(page), 2000, "cœur affiché");
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(page.sent.filter((m) => m.type === "FOLLOW_DECK").length, 0);
  assert.equal(likeButton(page).getAttribute("aria-pressed"), "false");
  assert.match(likeButton(page).title, /^Garder ce deck dans « Mes decks »/);
});

test("cœur : ajoute le deck à « Mes decks », puis l'en retire", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {}, followedDecks: {} });
  t.after(page.close);
  page.handle = (msg) => {
    if (msg.type === "FOLLOW_DECK") page.state.followedDecks[msg.payload.deckId] = { name: msg.payload.name };
    if (msg.type === "UNFOLLOW_DECK") delete page.state.followedDecks[msg.payload.deckId];
    return undefined;
  };
  await waitFor(() => likeButton(page), 2000, "cœur affiché");
  likeButton(page).click();
  await waitFor(() => likeButton(page).classList.contains("msm-liked"), 2000, "cœur plein");
  assert.equal(page.sent.find((m) => m.type === "FOLLOW_DECK").payload.deckId, "abc123");
  assert.match(page.win.document.querySelector(".msm-toast").textContent, /ajouté à « Mes decks »/);
  assert.match(likeButton(page).title, /^Retirer ce deck/);

  likeButton(page).click();
  await waitFor(() => !likeButton(page).classList.contains("msm-liked"), 2000, "cœur vide");
  assert.equal(page.sent.find((m) => m.type === "UNFOLLOW_DECK").payload.deckId, "abc123");
});

test("cœur : plein à l'ouverture d'un deck déjà gardé, et suit un retrait fait dans le popup", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {}, followedDecks: { abc123: { name: "Deck" } } });
  t.after(page.close);
  await waitFor(() => likeButton(page) && likeButton(page).classList.contains("msm-liked"), 2000, "cœur plein");
  page.state.followedDecks = {};
  page.setStock(FULL_STOCK); // changement de l'état signalé, comme chrome.storage
  await waitFor(() => !likeButton(page).classList.contains("msm-liked"), 2000, "cœur vidé");
});
