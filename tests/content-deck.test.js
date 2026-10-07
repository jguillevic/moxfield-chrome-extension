// Tests du bouton injecté sur la page d'un deck (content-deck.js) : npm test
//
// Les scripts de l'extension (deck-scraper.js, deck-checks.js,
// content-deck.js) sont exécutés dans une page de test jsdom, comme dans
// Chrome, avec un faux `chrome` qui répond à GET_STATE.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { FIXTURES_DIR, simulateLayout } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = ["deck-scraper.js", "deck-checks.js", "content-deck.js"].map((f) =>
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

function openDeckPage(state) {
  const html = fs.readFileSync(path.join(FIXTURES_DIR, "text.html"), "utf8");
  const dom = new JSDOM(html, { url: "https://www.moxfield.com/decks/abc123", runScripts: "outside-only" });
  const win = dom.window;
  simulateLayout(win);
  win.document.querySelector('select[name="viewMode"], select#viewMode').value = "table";
  // Le bouton n'apparaît que sur un deck Commander.
  const badge = win.document.createElement("span");
  badge.className = "badge-header";
  badge.textContent = "Commander";
  win.document.body.prepend(badge);

  const storageListeners = [];
  const page = {
    state,
    win,
    // Le stock change ailleurs (popup, autre onglet, synchro Drive).
    setStock(stock) {
      page.state = { ...page.state, stock };
      for (const fn of storageListeners) fn({ [STATE_KEY]: { newValue: page.state } }, "local");
    },
    button: () => win.document.querySelector(".msm-floating-btn, .msm-bar-btn"),
    close: () => win.close(),
    sent: [],
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
    return { ok: true, stock, builtDecks: page.state.builtDecks };
  }
  win.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        page.sent.push(JSON.parse(JSON.stringify(msg)));
        if (msg.type === "GET_DECK_CONTEXT") return JSON.parse(JSON.stringify(deckContext(msg.payload)));
        return { ok: true };
      },
      getURL: (p) => `chrome-extension://test/${p}`,
    },
    storage: { onChanged: { addListener: (fn) => storageListeners.push(fn) } },
  };
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

// Sans barre d'actions Moxfield dans la page de test, le bouton est le
// bouton flottant : faisabilité dans son texte, détail dans son infobulle.
const buttonText = (page) => (page.button() ? page.button().textContent : "");
const buttonTitle = (page) => (page.button() ? page.button().title : "");

test("deck non monté : faisabilité affichée, terrains de base exclus", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("dispo"), 2000, "faisabilité affichée");
  assert.match(buttonText(page), /· 3\/4 dispo$/);
  assert.match(buttonTitle(page), /^1 carte bloque le montage : 1 dans une autre version/);
  assert.match(buttonTitle(page), /version différente : Birds of Paradise/);
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
  await waitFor(() => buttonText(page).includes("3/4 dispo"), 2000, "état initial");
  // Moxfield remplace le marqueur « Partially in collection » par « Found
  // in collection » quand on choisit une version possédée.
  const marker = page.win.document.querySelector('[id^="collection_pt_"]');
  marker.id = marker.id.replace("collection_pt_", "collection_full_");
  const elapsed = await waitFor(() => buttonText(page).includes("4/4 dispo"), 2500, "recalcul après changement de version");
  assert.ok(elapsed < 1500, `recalcul en ${elapsed} ms : trop lent pour venir du changement de la page`);
  assert.match(buttonTitle(page), /^montable/);
});

test("stock modifié ailleurs : recalcul immédiat", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("3/4 dispo"), 2000, "état initial");
  const { ["golgari thug"]: _removed, ...withoutThug } = FULL_STOCK;
  page.setStock(withoutThug);
  const elapsed = await waitFor(() => buttonText(page).includes("2/4 dispo"), 2500, "recalcul après changement du stock");
  assert.ok(elapsed < 1000, `recalcul en ${elapsed} ms`);
  assert.match(buttonTitle(page), /manque Golgari Thug \(1\)/);
});

test("liste brièvement incohérente : la faisabilité reste affichée", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("3/4 dispo"), 2000, "état initial");
  // Ligne en double le temps d'un rendu : le total ne correspond plus à
  // celui annoncé par Moxfield.
  const row = page.win.document.querySelector('a.table-deck-row-link[href^="/cards/"]').closest("li");
  const copy = row.cloneNode(true);
  copy.removeAttribute("data-hash");
  row.after(copy);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.match(buttonText(page), /3\/4 dispo/, "pastille retirée trop tôt");
  copy.remove();
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.match(buttonText(page), /3\/4 dispo/);
});

test("la page ne demande que le stock des cartes du deck, jamais l'état complet", async (t) => {
  const page = openDeckPage({ stock: FULL_STOCK, builtDecks: {} });
  t.after(page.close);
  await waitFor(() => buttonText(page).includes("3/4 dispo"), 2000, "état initial");
  assert.ok(!page.sent.some((m) => m.type === "GET_STATE"), "état complet demandé");
  const request = page.sent.filter((m) => m.type === "GET_DECK_CONTEXT").pop();
  assert.deepEqual(
    [...request.payload.names].sort(),
    ["Birds of Paradise", "Golgari Thug", "Revitalizing Repast", "Sidisi, Brood Tyrant", "Swamp"]
  );
  assert.equal(request.payload.deckId, "abc123");
});
