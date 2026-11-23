// Tests du popup (popup.html + popup.js) : npm test
//
// Le popup est chargé dans une page jsdom avec un faux `chrome` qui répond
// aux messages comme le service worker.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { fakeGetMessage } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
// Scripts dans l'ordre de popup.html : le test charge ce que charge le popup.
const SCRIPTS = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(([, f]) => fs.readFileSync(path.join(ROOT, f), "utf8"));

const EMPTY_STATE = { stock: {}, builtDecks: {} };
const SYNC_OFF = { enabled: false };

// responses : réponse du faux service worker par type de message (objet ou
// fonction recevant le message) ; lang : langue du navigateur (français par
// défaut).
function openPopup(responses, lang = "fr") {
  const dom = new JSDOM(HTML.replace(/<script src="[^"]+"><\/script>/g, ""), { runScripts: "outside-only" });
  const win = dom.window;
  const sent = [];
  const storageListeners = [];
  const handlers = {
    GET_STATE: { ok: true, state: EMPTY_STATE },
    GET_SYNC_STATUS: { ok: true, meta: SYNC_OFF },
    ...responses,
  };
  win.chrome = {
    i18n: { getMessage: fakeGetMessage(lang) },
    runtime: {
      getManifest: () => ({ version: "0.3.0" }),
      sendMessage: async (msg) => {
        // Sérialisé comme par Chrome (et ramené dans le contexte des tests).
        sent.push(JSON.parse(JSON.stringify(msg)));
        const h = handlers[msg.type];
        const res = typeof h === "function" ? await h(msg) : h;
        return JSON.parse(JSON.stringify(res || { ok: true }));
      },
    },
    storage: { onChanged: { addListener: (fn) => storageListeners.push(fn) } },
  };
  win.confirm = () => true;
  for (const script of SCRIPTS) win.eval(script);
  const $ = (id) => win.document.getElementById(id);
  return {
    $,
    sent,
    handlers,
    win,
    close: () => win.close(),
    // Un autre composant (service worker) a écrit dans le stockage.
    storageChanged: (key) => storageListeners.forEach((fn) => fn({ [key]: {} }, "local")),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function collectionStatus(meta, uncovered = []) {
  return {
    ok: true,
    meta: { enabled: true, lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastChanges: null, lastChangesAt: null, ...meta },
    uncovered,
  };
}

test("collection jamais récupérée", async (t) => {
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  assert.equal(p.$("collection-state").textContent, "Pas encore récupérée.");
  assert.equal(p.$("collection-auto").checked, true);
  assert.equal(p.$("collection-changes").hidden, true);
  assert.equal(p.$("collection-uncovered").hidden, true);
});

test("dernière récupération et derniers changements", async (t) => {
  const at = new Date(2026, 9, 7, 14, 5).getTime();
  const p = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({
      lastSuccessAt: at,
      lastChanges: [
        { name: "Rhystic Study", from: 0, to: 1 },
        { name: "Sol Ring", from: 3, to: 1 },
      ],
      lastChangesAt: at,
    }),
  });
  t.after(p.close);
  await settle();
  assert.match(p.$("collection-state").textContent, /^Dernière récupération : 07\/10\/2026 14:05\.$/);
  assert.equal(p.$("collection-changes").hidden, false);
  assert.match(p.$("collection-changes").textContent, /: \+1 Rhystic Study, −2 Sol Ring\.$/);
});

test("erreur affichée avec la date de la dernière réussite", async (t) => {
  const p = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({
      lastSuccessAt: new Date(2026, 9, 7, 9, 0).getTime(),
      lastError: { code: "not-logged-in", message: "Session Moxfield expirée : reconnecte-toi sur moxfield.com dans ce navigateur." },
    }),
  });
  t.after(p.close);
  await settle();
  const state = p.$("collection-state");
  assert.equal(state.className, "sync-error");
  assert.match(state.textContent, /^Session Moxfield expirée.*Dernière récupération : 07\/10\/2026 09:00\.$/);
});

test("cartes de decks montés non couvertes, noms échappés", async (t) => {
  const p = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({}, [{ name: "Rhystic <Study>", missing: 2, decks: ["Deck a", "Deck b"] }]),
  });
  t.after(p.close);
  await settle();
  const el = p.$("collection-uncovered");
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /ne couvre plus 1 carte de decks montés/);
  assert.match(el.textContent, /Rhystic <Study> — manque 2 \(dans : Deck a, Deck b\)/);
  assert.equal(el.querySelector("li").children.length, 0, "pas de HTML injecté");
});

test("« Récupérer maintenant » : lance la récupération et résume le résultat", async (t) => {
  let fetched = false;
  const p = openPopup({
    GET_COLLECTION_STATUS: () => collectionStatus(fetched ? { lastSuccessAt: Date.now() } : {}),
    COLLECTION_FETCH_NOW: () => {
      fetched = true;
      return { ok: true, changes: [{ name: "Sol Ring", from: 1, to: 2 }, { name: "Island", from: 0, to: 5 }] };
    },
  });
  t.after(p.close);
  await settle();
  p.$("collection-fetch-btn").click();
  assert.equal(p.$("collection-fetch-btn").disabled, true, "bouton désactivé pendant la récupération");
  await settle();
  assert.ok(p.sent.some((m) => m.type === "COLLECTION_FETCH_NOW"));
  assert.equal(p.$("collection-status").textContent, "2 cartes modifiées, stock mis à jour.");
  assert.equal(p.$("collection-fetch-btn").disabled, false);
  assert.match(p.$("collection-state").textContent, /^Dernière récupération/);
});

test("« Récupérer maintenant » sans changement", async (t) => {
  const p = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({}),
    COLLECTION_FETCH_NOW: { ok: true, changes: [] },
  });
  t.after(p.close);
  await settle();
  p.$("collection-fetch-btn").click();
  await settle();
  assert.equal(p.$("collection-status").textContent, "Aucun changement.");
});

test("case « automatique » : envoie le réglage", async (t) => {
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  const box = p.$("collection-auto");
  box.checked = false;
  box.dispatchEvent(new box.ownerDocument.defaultView.Event("change"));
  await settle();
  const msg = p.sent.find((m) => m.type === "SET_COLLECTION_AUTO");
  assert.deepEqual(msg.payload, { enabled: false });
});

test("récupération faite en fond pendant que le popup est ouvert : affichage mis à jour", async (t) => {
  let meta = {};
  const p = openPopup({ GET_COLLECTION_STATUS: () => collectionStatus(meta) });
  t.after(p.close);
  await settle();
  meta = { lastSuccessAt: Date.now(), lastChanges: [{ name: "Sol Ring", from: 1, to: 2 }], lastChangesAt: Date.now() };
  p.storageChanged("moxfieldStockManagerCollection");
  await settle();
  assert.match(p.$("collection-changes").textContent, /\+1 Sol Ring/);
});

// --- Section Stock : une collection complète compte des milliers de cartes ---

function bigState(count) {
  const stock = {};
  for (let i = 0; i < count; i++) {
    const name = `Card ${String(i).padStart(4, "0")}`;
    stock[name.toLowerCase()] = { name, qty: 1 };
  }
  return { stock, builtDecks: {} };
}

async function openStock(p) {
  const details = p.$("stock-details");
  details.open = true;
  details.dispatchEvent(new details.ownerDocument.defaultView.Event("toggle"));
  await settle();
}

test("stock replié : chiffres affichés, tableau non construit", async (t) => {
  const p = openPopup({ GET_STATE: { ok: true, state: bigState(500) }, GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  assert.equal(p.$("stock-count").textContent, "500");
  assert.equal(p.$("stock-table").querySelectorAll("tr").length, 0);
});

test("stock déplié : 200 lignes au plus, avec le nombre de cartes restantes", async (t) => {
  const p = openPopup({ GET_STATE: { ok: true, state: bigState(500) }, GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  await openStock(p);
  const rows = p.$("stock-table").querySelectorAll("tr");
  assert.equal(rows.length, 201, "en-tête + 200 cartes");
  assert.match(rows[1].textContent, /Card 0000/);
  assert.equal(p.$("stock-table").querySelectorAll("button").length, 0, "quantités non modifiables : Moxfield fait référence");
  assert.equal(p.$("stock-table").querySelector("p.hint").textContent, "… et 300 autres cartes : affine avec le filtre.");
});

test("filtre : cherche dans tout le stock, au-delà des 200 premières", async (t) => {
  const p = openPopup({ GET_STATE: { ok: true, state: bigState(500) }, GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  await openStock(p);
  const filter = p.$("stock-filter");
  filter.value = "Card 0450";
  filter.dispatchEvent(new filter.ownerDocument.defaultView.Event("input"));
  await settle();
  const rows = p.$("stock-table").querySelectorAll("tr");
  assert.equal(rows.length, 2);
  assert.match(rows[1].textContent, /Card 0450/);
  assert.equal(p.$("stock-table").querySelector("p.hint"), null);
});

// --- Chiffres clés ---

// Stock libre : 1 Sol Ring + 10 Forest. Deux decks montés contiennent un
// Sol Ring, dont un monté avec une ancienne version (excludedFromStock) :
// jamais retiré du stock, il ne doit pas gonfler le total possédé.
const MOUNTED_STATE = {
  stock: {
    "sol ring": { name: "Sol Ring", qty: 1 },
    forest: { name: "Forest", qty: 10 },
  },
  builtDecks: {
    a: { name: "Zethi", url: "https://moxfield.com/decks/a", cards: [{ name: "Sol Ring", qty: 1 }] },
    b: { name: "Sidisi", url: "https://moxfield.com/decks/b", cards: [{ name: "Sol Ring", qty: 1, excludedFromStock: true }] },
  },
};

test("chiffres clés : exemplaires possédés = libres + dans des decks montés", async (t) => {
  const p = openPopup({ GET_STATE: { ok: true, state: MOUNTED_STATE }, GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  assert.equal(p.$("stock-total").textContent, "11");
  assert.equal(p.$("stock-in-decks").textContent, "1");
  assert.equal(p.$("stock-owned").textContent, "12");
  assert.equal(p.$("stock-count").textContent, "2");
});

test("total possédé d'une carte : même calcul que le chiffre clé", async (t) => {
  const p = openPopup({ GET_STATE: { ok: true, state: MOUNTED_STATE }, GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  await openStock(p);
  const row = Array.from(p.$("stock-table").querySelectorAll("tr.has-decks")).find((tr) => /Sol Ring/.test(tr.textContent));
  row.dispatchEvent(new p.win.Event("click"));
  await settle();
  assert.match(p.$("stock-table").querySelector("tr.deck-usage").textContent, /Total possédé : 2/);
});

// --- Section Historique ---

const HISTORY = [
  {
    id: "h3",
    at: new Date(2026, 9, 7, 15, 42).getTime(),
    otherDevice: false,
    title: "Deck « Zethi » démonté : 99 cartes rendues au stock",
    changes: null,
  },
  {
    id: "h2",
    at: new Date(2026, 9, 7, 14, 0).getTime(),
    otherDevice: true,
    title: "Collection Moxfield récupérée : 2 cartes modifiées",
    changes: [
      { name: "Lotus Petal", from: 2, to: 3 },
      { name: "Sol Ring", from: 3, to: 1 },
    ],
  },
  {
    id: "h1",
    at: new Date(2026, 9, 6, 9, 0).getTime(),
    otherDevice: false,
    title: "Deck « Sidisi » monté : 100 cartes retirées du stock libre",
    changes: null,
  },
];

async function openHistory(p) {
  const details = p.$("history-details");
  details.open = true;
  details.dispatchEvent(new details.ownerDocument.defaultView.Event("toggle"));
  await settle();
}

test("historique replié : rien n'est demandé", async (t) => {
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}), GET_HISTORY: { ok: true, entries: HISTORY } });
  t.after(p.close);
  await settle();
  assert.ok(!p.sent.some((m) => m.type === "GET_HISTORY"));
});

test("historique : date, autre PC, libellé et détail, sans annulation", async (t) => {
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}), GET_HISTORY: { ok: true, entries: HISTORY } });
  t.after(p.close);
  await settle();
  await openHistory(p);
  const rows = p.$("history-list").querySelectorAll(".history-entry");
  assert.equal(rows.length, 3);

  assert.match(rows[0].textContent, /07\/10\/2026 15:42/);
  assert.match(rows[0].textContent, /Deck « Zethi » démonté/);

  assert.match(rows[1].textContent, /14:00 · sur un autre PC/);
  assert.deepEqual(
    [...rows[1].querySelectorAll("li")].map((li) => li.textContent),
    ["+1 Lotus Petal (2 → 3)", "−2 Sol Ring (3 → 1)"]
  );
  assert.equal(p.$("history-list").querySelectorAll("button").length, 0, "consultation seulement");
});

test("historique vide", async (t) => {
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}), GET_HISTORY: { ok: true, entries: [] } });
  t.after(p.close);
  await settle();
  await openHistory(p);
  assert.equal(p.$("history-list").textContent, "Aucune action pour le moment.");
});


test("historique : mis à jour quand le stock change pendant que le popup est ouvert", async (t) => {
  let entries = [];
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}), GET_HISTORY: () => ({ ok: true, entries }) });
  t.after(p.close);
  await settle();
  await openHistory(p);
  entries = [HISTORY[1]];
  p.storageChanged("moxfieldStockManagerState");
  await settle();
  assert.match(p.$("history-list").textContent, /Collection Moxfield récupérée/);
});

test("historique : détail tronqué signalé", async (t) => {
  const entry = { ...HISTORY[1], changes: HISTORY[1].changes, changeCount: 30000 };
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}), GET_HISTORY: { ok: true, entries: [entry] } });
  t.after(p.close);
  await settle();
  await openHistory(p);
  const items = [...p.$("history-list").querySelectorAll("li")].map((li) => li.textContent);
  assert.deepEqual(items, ["+1 Lotus Petal (2 → 3)", "−2 Sol Ring (3 → 1)", "… et 29998 autres"]);
});

// --- Rapports d'erreurs ---

test("rapports d'erreurs : case cochée par défaut, décochable", async (t) => {
  let enabled = true;
  const popup = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({ enabled: false }),
    GET_ERROR_REPORTS: () => ({ ok: true, enabled, configured: true }),
    SET_ERROR_REPORTS: (msg) => ((enabled = msg.payload.enabled), { ok: true, enabled, configured: true }),
  });
  t.after(popup.close);
  await settle();
  assert.ok(!popup.sent.some((m) => m.type === "GET_ERROR_REPORTS"), "section repliée : rien demandé");
  popup.$("error-reports-details").open = true;
  popup.$("error-reports-details").dispatchEvent(new popup.win.Event("toggle"));
  await settle();
  const checkbox = popup.$("error-reports-enabled");
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.disabled, false);
  checkbox.checked = false;
  checkbox.dispatchEvent(new popup.win.Event("change"));
  await settle();
  assert.deepEqual(popup.sent.find((m) => m.type === "SET_ERROR_REPORTS").payload, { enabled: false });
  assert.equal(checkbox.checked, false);
});

test("rapports d'erreurs : version sans service configuré, case grisée", async (t) => {
  const popup = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({ enabled: false }), GET_ERROR_REPORTS: { ok: true, enabled: true, configured: false } });
  t.after(popup.close);
  popup.$("error-reports-details").open = true;
  popup.$("error-reports-details").dispatchEvent(new popup.win.Event("toggle"));
  await settle();
  assert.equal(popup.$("error-reports-enabled").disabled, true);
  assert.match(popup.$("error-reports-state").textContent, /rien n'est envoyé/);
});

test("erreur non interceptée du popup : rapportée", async (t) => {
  const popup = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({ enabled: false }),});
  t.after(popup.close);
  const { win } = popup;
  win.dispatchEvent(new win.ErrorEvent("error", { error: new win.TypeError("boum"), message: "boum" }));
  await settle();
  const report = popup.sent.find((m) => m.type === "REPORT_ERROR").payload;
  assert.equal(report.where, "popup");
  assert.deepEqual([report.error.type, report.error.message], ["TypeError", "boum"]);
});

// --- Compte Google de la synchro ---

test("synchro : compte du profil sous Chrome, compte choisi à la connexion ailleurs", async (t) => {
  for (const [authMethod, hint, help] of [
    [null, "Compte du profil Chrome", /profil Chrome/],
    ["chrome", "Compte du profil Chrome", /profil Chrome/],
    ["web", "Compte choisi à la connexion", /Déconnecter, puis Connecter/],
  ]) {
    const popup = openPopup({
      GET_COLLECTION_STATUS: collectionStatus({ enabled: false }),
      GET_SYNC_STATUS: { ok: true, meta: { enabled: true, authMethod, accountEmail: "moi@gmail.com", lastSyncAt: 1 } },
      SYNC_NOW: { ok: true, meta: { enabled: true } },
    });
    t.after(popup.close);
    await settle();
    assert.equal(popup.$("sync-account").textContent, "moi@gmail.com");
    assert.equal(popup.$("sync-account-hint").textContent, hint);
    assert.match(popup.$("sync-account-box").title, help);
  }
});

// --- Connexion à Moxfield ---

test("pas de session Moxfield : lien vers la connexion, absent pour les autres erreurs", async (t) => {
  for (const [lastError, shown] of [
    [{ code: "not-logged-in", message: "Pas de session Moxfield : connecte-toi sur moxfield.com dans ce navigateur." }, true],
    [{ code: "blocked", message: "Moxfield a refusé la récupération (code 429)." }, false],
    [null, false],
  ]) {
    const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({ lastError }) });
    t.after(p.close);
    await settle();
    const link = p.$("collection-login-link");
    assert.equal(link.hidden, !shown, lastError ? lastError.code : "sans erreur");
    assert.equal(link.href, "https://moxfield.com/account/signin");
    assert.equal(link.target, "_blank");
  }
});

// --- Langue du navigateur ---

test("tous les textes fixes du popup sont traduits, dans chaque langue", async (t) => {
  for (const lang of ["fr", "en"]) {
    const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}) }, lang);
    t.after(p.close);
    const doc = p.win.document;
    assert.equal(doc.documentElement.lang, lang);
    for (const el of doc.querySelectorAll("[data-i18n]")) {
      assert.ok(el.textContent && el.textContent !== el.dataset.i18n, `${lang} : ${el.dataset.i18n} non traduit`);
    }
    assert.notEqual(p.$("stock-filter").placeholder, "stockFilterPlaceholder");
  }
});

test("navigateur en anglais : popup en anglais, dates comprises", async (t) => {
  const meta = { lastSuccessAt: new Date(2026, 9, 7, 9, 0).getTime() };
  const p = openPopup({ GET_STATE: { ok: true, state: MOUNTED_STATE }, GET_COLLECTION_STATUS: collectionStatus(meta) }, "en");
  t.after(p.close);
  await settle();
  assert.equal(p.$("stock-owned").nextElementSibling.textContent, "copies owned");
  assert.equal(p.$("sync-pill").textContent, "Not synced");
  assert.equal(p.$("collection-state").textContent, "Last fetched: 10/7/26, 9:00 AM.");
  assert.deepEqual([...p.$("built-list").querySelectorAll("button")].map((b) => b.textContent), ["Unbuild", "Unbuild"]);
  await openStock(p);
  assert.deepEqual([...p.$("stock-table").querySelectorAll("th")].map((th) => th.textContent), ["Card", "Free", "Decks"]);
});

// --- Changement de version (impression) d'une carte ---

test("changement de version seul : affiché sans quantité, dans le badge « Modifié » et l'historique", async (t) => {
  const versionChange = { name: "Steam Vents", from: 1, to: 1, version: true };
  const deck = {
    name: "Niv-Mizzet",
    url: "https://moxfield.com/decks/a",
    cards: [{ name: "Steam Vents", qty: 1, versions: [{ code: "AAAAA", qty: 1 }] }],
    pageChanges: [versionChange, { name: "Sol Ring", from: 0, to: 1 }],
    pageCheckedAt: new Date(2026, 10, 18, 10, 0).getTime(),
  };
  const history = [{ id: "h1", at: deck.pageCheckedAt, otherDevice: false, title: "Montage mis à jour", changes: [versionChange] }];
  const p = openPopup({
    GET_STATE: { ok: true, state: { stock: {}, builtDecks: { a: deck } } },
    GET_COLLECTION_STATUS: collectionStatus({}),
    GET_HISTORY: { ok: true, entries: history },
  });
  t.after(p.close);
  await settle();
  const badge = p.$("built-list").querySelector(".badge-changed");
  assert.match(badge.title, /↻ Steam Vents, \+1 Sol Ring/);

  await openHistory(p);
  assert.deepEqual(
    [...p.$("history-list").querySelectorAll("li")].map((li) => li.textContent),
    ["↻ Steam Vents (version changée)"]
  );
});

// --- Proxies des decks montés ---

// Zethi : 2 Sol Ring dont 1 proxy, Counterspell en proxy ; 1 Sol Ring et
// 1 Counterspell libres (achetés depuis le montage).
const PROXY_STATE = {
  stock: {
    "sol ring": { name: "Sol Ring", qty: 1 },
    counterspell: { name: "Counterspell", qty: 1 },
  },
  builtDecks: {
    a: {
      name: "Zethi",
      url: "https://moxfield.com/decks/a",
      cards: [
        { name: "Sol Ring", qty: 2, proxyQty: 1 },
        { name: "Counterspell", qty: 2, proxyQty: 2 },
      ],
    },
    b: { name: "Sidisi", url: "https://moxfield.com/decks/b", cards: [{ name: "Sol Ring", qty: 1 }] },
  },
};

const deckRow = (p, name) => [...p.$("built-list").querySelectorAll(".deck-row")].find((r) => r.textContent.includes(name));
const buttonsOf = (row) => [...row.querySelectorAll("button")];

test("proxies : nombre par deck, impression, remplacement proposé quand la vraie carte est libre", async (t) => {
  const p = openPopup({ GET_STATE: { ok: true, state: PROXY_STATE }, GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  const zethi = deckRow(p, "Zethi");
  const badge = zethi.querySelector(".badge-proxies");
  assert.equal(badge.textContent, "🃏 3");
  assert.equal(badge.title, "Proxies : Sol Ring ×1, Counterspell ×2");
  assert.deepEqual(buttonsOf(zethi).map((b) => b.textContent), ["🖨️ Imprimer", "Remplacer 2 proxies", "Démonter"]);
  assert.match(buttonsOf(zethi)[1].title, /Sol Ring ×1, Counterspell ×1/);
  // Deck sans proxy : seulement « Démonter ».
  const sidisi = deckRow(p, "Sidisi");
  assert.equal(sidisi.querySelector(".badge-proxies"), null);
  assert.deepEqual(buttonsOf(sidisi).map((b) => b.textContent), ["Démonter"]);

  buttonsOf(zethi)[0].click();
  await settle();
  assert.deepEqual(p.sent.filter((m) => m.type === "OPEN_PROXIES_PAGE").map((m) => m.payload), [{ deckId: "a" }]);

  p.handlers.REPLACE_PROXIES = { ok: true, replaced: [{ name: "Sol Ring", qty: 1 }, { name: "Counterspell", qty: 1 }] };
  buttonsOf(zethi)[1].click();
  await settle();
  assert.deepEqual(p.sent.filter((m) => m.type === "REPLACE_PROXIES").map((m) => m.payload), [{ deckId: "a" }]);
  assert.equal(p.$("built-status").textContent, "2 proxies remplacés par la vraie carte.");
});

test("proxies : remplacement refusé, raison affichée", async (t) => {
  const p = openPopup({
    GET_STATE: { ok: true, state: PROXY_STATE },
    GET_COLLECTION_STATUS: collectionStatus({}),
    REPLACE_PROXIES: { ok: false, error: "Aucun proxy à remplacer : la vraie carte n'est pas (ou plus) en stock libre." },
  });
  t.after(p.close);
  await settle();
  buttonsOf(deckRow(p, "Zethi"))[1].click();
  await settle();
  assert.equal(p.$("built-status").textContent, "Erreur : Aucun proxy à remplacer : la vraie carte n'est pas (ou plus) en stock libre.");
});

test("proxies : pas de remplacement proposé sans la vraie carte en stock libre", async (t) => {
  const state = { ...PROXY_STATE, stock: { "sol ring": { name: "Sol Ring", qty: 0 } } };
  const p = openPopup({ GET_STATE: { ok: true, state }, GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  assert.deepEqual(buttonsOf(deckRow(p, "Zethi")).map((b) => b.textContent), ["🖨️ Imprimer", "Démonter"]);
});

test("proxies : jamais comptés dans les exemplaires des decks montés", async (t) => {
  const p = openPopup({ GET_STATE: { ok: true, state: PROXY_STATE }, GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  // 1 Sol Ring réel dans Zethi + 1 dans Sidisi ; Counterspell entièrement en proxy.
  assert.equal(p.$("stock-in-decks").textContent, "2");
  assert.equal(p.$("stock-owned").textContent, "4");
});

// --- Sauvegarde Drive ---
// Le dossier de l'extension sur Drive est invisible : lien vers les
// paramètres de Drive et téléchargement de la sauvegarde.

const SYNC_ON = { enabled: true, authMethod: "chrome", accountEmail: "moi@gmail.com", lastSyncAt: 1 };
const BACKUP = { app: "moxfield-stock-manager", version: 1, updatedAt: new Date(2026, 10, 21, 15, 0).getTime(), state: { stock: {}, builtDecks: {}, history: [] } };

// Fichiers enregistrés par le popup : { name, text }.
function captureDownloads(win) {
  const saved = [];
  const blobs = new Map();
  win.URL.createObjectURL = (blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () {
    saved.push(blobs.get(this.href).text().then((text) => ({ name: this.download, text })));
  };
  return () => Promise.all(saved);
}

test("sauvegarde Drive : lien vers les paramètres de Drive, sauvegarde téléchargée en JSON", async (t) => {
  const p = openPopup({
    GET_SYNC_STATUS: { ok: true, meta: SYNC_ON },
    GET_COLLECTION_STATUS: collectionStatus({}),
    DRIVE_DOWNLOAD: { ok: true, doc: BACKUP },
  });
  t.after(p.close);
  const downloads = captureDownloads(p.win);
  await settle();
  const link = p.$("sync-on").querySelector('a[href^="https://drive.google.com/drive/settings"]');
  assert.ok(link, "lien vers les paramètres de Drive");
  assert.equal(link.target, "_blank");
  p.$("sync-download-btn").click();
  await settle();
  assert.deepEqual(p.sent.find((m) => m.type === "DRIVE_DOWNLOAD").payload, undefined, "fichier d'état");
  const [file] = await downloads();
  assert.equal(file.name, `moxfield-stock-manager-${new Date(BACKUP.updatedAt).toISOString().slice(0, 10)}.json`);
  assert.deepEqual(JSON.parse(file.text), BACKUP);
});

test("sauvegarde Drive : une version de l'historique se télécharge aussi", async (t) => {
  const created = "2026-11-20T08:00:00.000Z";
  const p = openPopup({
    GET_SYNC_STATUS: { ok: true, meta: SYNC_ON },
    GET_COLLECTION_STATUS: collectionStatus({}),
    DRIVE_LIST_SNAPSHOTS: { ok: true, snapshots: [{ id: "snap7", createdTime: created, size: 10, reason: "daily" }] },
    DRIVE_DOWNLOAD: { ok: true, doc: BACKUP },
  });
  t.after(p.close);
  const downloads = captureDownloads(p.win);
  await settle();
  const details = p.$("sync-history");
  details.open = true;
  details.dispatchEvent(new p.win.Event("toggle"));
  await settle();
  const button = [...p.$("sync-snapshots").querySelectorAll("button")].find((b) => b.textContent === "Télécharger");
  button.click();
  await settle();
  assert.deepEqual(p.sent.find((m) => m.type === "DRIVE_DOWNLOAD").payload, { fileId: "snap7" });
  const [file] = await downloads();
  assert.equal(file.name, "moxfield-stock-manager-2026-11-20.json");
});

test("sauvegarde Drive : rien sur Drive, message affiché", async (t) => {
  const p = openPopup({
    GET_SYNC_STATUS: { ok: true, meta: SYNC_ON },
    GET_COLLECTION_STATUS: collectionStatus({}),
    DRIVE_DOWNLOAD: { ok: false, error: "Aucune sauvegarde sur Drive pour le moment." },
  });
  t.after(p.close);
  await settle();
  p.$("sync-download-btn").click();
  await settle();
  assert.equal(p.$("sync-status").textContent, "Erreur : Aucune sauvegarde sur Drive pour le moment.");
});

// --- Nouvelle version de l'extension ---

test("nouvelle version : carte en haut du popup avec les modifications et le lien GitHub", async (t) => {
  const update = {
    count: 7,
    commits: ["Add G", "Fix F", "Add E", "Add D", "Add C", "Add B", "Add A"],
    compareUrl: "https://github.com/jguillevic/moxfield-chrome-extension/compare/cccccccccccc...main",
  };
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}), GET_UPDATE_STATUS: { ok: true, update } });
  t.after(p.close);
  await settle();
  assert.equal(p.$("update-available").hidden, false);
  assert.equal(p.$("update-summary").textContent, "7 modifications sur GitHub depuis ta version :");
  assert.deepEqual([...p.$("update-commits").children].map((li) => li.textContent), ["Add G", "Fix F", "Add E", "Add D", "Add C"]);
  assert.equal(p.$("update-link").href, update.compareUrl);
  assert.match(p.$("update-available").textContent, /git pull/);
});

test("nouvelle version : pas de carte quand l'extension est à jour", async (t) => {
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}), GET_UPDATE_STATUS: { ok: true, update: null } });
  t.after(p.close);
  await settle();
  assert.equal(p.$("update-available").hidden, true);
});

test("version de l'extension en bas du popup : numéro et commit, lien vers le commit", async (t) => {
  const sha = "c".repeat(40);
  const p = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({}),
    GET_VERSION_INFO: { ok: true, version: "0.3.0", commit: sha, commitUrl: `https://github.com/jguillevic/moxfield-chrome-extension/commit/${sha}` },
  });
  t.after(p.close);
  await settle();
  assert.equal(p.$("version-link").textContent, "Version 0.3.0 · ccccccc");
  assert.equal(p.$("version-link").href, `https://github.com/jguillevic/moxfield-chrome-extension/commit/${sha}`);
});

test("version de l'extension : sans clone git, le numéro seul", async (t) => {
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}), GET_VERSION_INFO: { ok: true, version: "0.3.0", commit: null, commitUrl: null } });
  t.after(p.close);
  await settle();
  assert.equal(p.$("version-link").textContent, "Version 0.3.0");
});

test("nouvelle version : numéro de la nouvelle version et de la version installée", async (t) => {
  const update = { count: 2, commits: ["Add B", "Add A"], compareUrl: "https://github.com/x", latestVersion: "0.4.0" };
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}), GET_UPDATE_STATUS: { ok: true, update } });
  t.after(p.close);
  await settle();
  assert.equal(p.$("update-summary").textContent, "Version 0.4.0 disponible (tu as la 0.3.0). 2 modifications sur GitHub depuis ta version :");
});

// --- Aide : premiers pas et légende des boutons ---

// Popup d'une nouvelle installation ; onboarding : réponse du service worker.
function openGuide(onboarding = { ok: true, done: false, deckHelpSeen: false }, extra = {}, lang = "fr") {
  let saved = onboarding;
  return openPopup(
    {
      GET_COLLECTION_STATUS: collectionStatus({}),
      GET_ONBOARDING: () => saved,
      SET_ONBOARDING: (msg) => (saved = { ...saved, ...msg.payload }),
      ...extra,
    },
    lang
  );
}
const savedGuide = (p) => p.sent.filter((m) => m.type === "SET_ONBOARDING").map((m) => m.payload);
const tasks = (p) => [...p.$("onboarding-tasks").children];
const taskTitles = (p) => tasks(p).map((li) => li.querySelector(".onboarding-task-title").textContent);
const currentTask = (p) => p.$("onboarding-tasks").querySelector('[aria-current="step"]');

test("aide : nouvelle installation, trois premiers pas visibles d'un coup, le premier à faire déplié", async (t) => {
  const p = openGuide();
  t.after(p.close);
  await settle();
  assert.equal(p.$("onboarding").hidden, false);
  assert.equal(p.$("onboarding-title").textContent, "Bien démarrer");
  assert.equal(p.$("onboarding-progress").textContent, "0/3 faits");
  assert.deepEqual(taskTitles(p), ["1Récupère ta collection Moxfield", "2Ouvre un de tes decks sur Moxfield", "3Monte ton premier deck"]);
  assert.equal(currentTask(p), tasks(p)[0]);
  assert.match(currentTask(p).textContent, /la récupération|récupérée toute seule/, "la récupération se fait toute seule après la connexion");
  assert.ok(currentTask(p).querySelector('a[href="https://moxfield.com/account/signin"]'), "lien de connexion à Moxfield");
  assert.ok(p.$("onboarding-fetch"), "bouton de récupération (secours)");
  assert.equal(tasks(p)[1].querySelector("a"), null, "tâches suivantes : titre seul");
  assert.equal(p.$("onboarding-close").textContent, "Masquer l'aide");
  assert.equal(p.$("help-btn").getAttribute("aria-expanded"), "true");
});

test("aide : chaque tâche cochée d'après l'état réel, la suivante dépliée avec le lien vers ses decks", async (t) => {
  const p = openGuide(undefined, { GET_STATE: { ok: true, state: { stock: MOUNTED_STATE.stock, builtDecks: {} } } });
  t.after(p.close);
  await settle();
  assert.equal(p.$("onboarding-progress").textContent, "1/3 faits");
  assert.ok(tasks(p)[0].classList.contains("done"));
  assert.equal(tasks(p)[0].querySelector(".onboarding-status.done").textContent, "Collection récupérée : 2 cartes différentes.");
  assert.equal(p.$("onboarding-fetch"), null, "collection déjà là : pas de bouton de récupération");
  assert.equal(currentTask(p), tasks(p)[1]);
  assert.equal(p.$("onboarding-decks-link").href, "https://moxfield.com/decks/personal");
  assert.equal(p.$("onboarding-all-done").hidden, true);
});

test("aide : tout fait (bulle vue sur la page d'un deck, deck monté) : « Terminer »", async (t) => {
  const p = openGuide({ ok: true, done: false, deckHelpSeen: true }, { GET_STATE: { ok: true, state: MOUNTED_STATE } });
  t.after(p.close);
  await settle();
  assert.equal(p.$("onboarding-progress").textContent, "3/3 faits");
  assert.equal(currentTask(p), null);
  assert.equal(tasks(p)[1].querySelector(".onboarding-status.done").textContent, "Fait : tu as vu l'aide de la page d'un deck.");
  assert.equal(tasks(p)[2].querySelector(".onboarding-status.done").textContent, "Tu as 2 decks montés.");
  assert.equal(p.$("onboarding-all-done").hidden, false);
  assert.equal(p.$("onboarding-close").textContent, "Terminer");
  assert.equal(p.$("onboarding-close").className, "primary");
  p.$("onboarding-close").click();
  await settle();
  assert.equal(p.$("onboarding").hidden, true);
  assert.deepEqual(savedGuide(p), [{ done: true }]);
  assert.equal(p.win.document.activeElement, p.$("help-btn"), "focus rendu au bouton « Aide »");
});

test("aide : bulle vue sur la page d'un deck pendant que le popup est ouvert : tâche cochée", async (t) => {
  let onboarding = { ok: true, done: false, deckHelpSeen: false };
  const p = openGuide(undefined, { GET_STATE: { ok: true, state: { stock: MOUNTED_STATE.stock, builtDecks: {} } }, GET_ONBOARDING: () => onboarding });
  t.after(p.close);
  await settle();
  assert.equal(currentTask(p), tasks(p)[1]);
  onboarding = { ok: true, done: false, deckHelpSeen: true };
  p.storageChanged("moxfieldStockManagerOnboarding");
  await settle();
  assert.ok(tasks(p)[1].classList.contains("done"));
  assert.equal(currentTask(p), tasks(p)[2]);
});

test("aide : liste pas reconstruite quand rien ne change (focus et message gardés)", async (t) => {
  const p = openGuide();
  t.after(p.close);
  await settle();
  const fetchBtn = p.$("onboarding-fetch");
  fetchBtn.focus();
  p.storageChanged("moxfieldStockManagerState");
  await settle();
  assert.equal(p.$("onboarding-fetch"), fetchBtn);
  assert.equal(p.win.document.activeElement, fetchBtn);
});

test("aide : masquée, rouverte par « Aide » dans l'en-tête, focus sur son titre ; légende ouverte quand tout est fait", async (t) => {
  const p = openGuide({ ok: true, done: true, deckHelpSeen: true }, { GET_STATE: { ok: true, state: MOUNTED_STATE } });
  t.after(p.close);
  await settle();
  assert.equal(p.$("onboarding").hidden, true);
  assert.equal(p.$("help-btn").getAttribute("aria-expanded"), "false");
  assert.equal(p.$("help-btn").textContent.trim(), "? Aide");
  assert.equal(p.$("onboarding-replay"), null, "plus de lien caché en bas du popup");
  p.$("help-btn").click();
  await settle();
  assert.equal(p.$("onboarding").hidden, false);
  assert.equal(p.win.document.activeElement, p.$("onboarding-title"));
  assert.equal(p.$("onboarding-legend").open, true, "premiers pas faits : c'est la légende qu'on vient chercher");
  assert.deepEqual(savedGuide(p), [{ done: false }]);
  p.$("help-btn").click();
  await settle();
  assert.equal(p.$("onboarding").hidden, true);
  assert.deepEqual(savedGuide(p).at(-1), { done: true });
});

test("aide : légende avec les vraies icônes de la page d'un deck, tous les états, « montable ≠ monté » en tête", async (t) => {
  const p = openGuide();
  t.after(p.close);
  await settle();
  const legend = p.$("onboarding-legend-body");
  assert.match(legend.querySelector(".msm-legend-callout").textContent, /^Montable ≠ monté/);
  const items = [...legend.querySelectorAll("li")];
  assert.deepEqual(
    items.map((li) => li.dataset.legend),
    ["legendNotBuilt", "legendBuildable", "legendBlocked", "legendBuilt", "legendOutdated", "legendProxies", "legendEditions", "legendLike"]
  );
  assert.equal(legend.querySelectorAll(".msm-legend-icon svg path").length, 8, "une icône dessinée par état");
  assert.deepEqual([...legend.querySelectorAll(".msm-avail-badge")].map((b) => b.textContent), ["OK", "3", "2", "4"]);
  assert.ok(items[3].querySelector(".msm-legend-icon").classList.contains("msm-legend-built"), "deck monté : rond coché vert");
  assert.ok(items[4].querySelector(".msm-legend-icon").classList.contains("msm-legend-outdated"), "liste modifiée : point orange");
  assert.match(items[0].textContent, /monté physiquement/, "même mot que l'infobulle du bouton");
  assert.match(items[2].textContent, /exemplaires/, "la pastille compte des exemplaires");
});

test("aide : récupération de la collection depuis la première tâche, erreur affichée", async (t) => {
  let state = EMPTY_STATE;
  let result = { ok: false, error: "Pas de session Moxfield : connecte-toi sur moxfield.com dans ce navigateur.", code: "not-logged-in" };
  const p = openGuide(undefined, { GET_STATE: () => ({ ok: true, state }), COLLECTION_FETCH_NOW: () => result });
  t.after(p.close);
  await settle();
  p.$("onboarding-fetch").click();
  await settle();
  assert.match(currentTask(p).querySelector(".onboarding-status").textContent, /^Pas de session Moxfield/);

  state = MOUNTED_STATE;
  result = { ok: true, changes: [] };
  p.$("onboarding-fetch").click();
  await settle();
  assert.match(tasks(p)[0].querySelector(".onboarding-status.done").textContent, /Collection récupérée/);
});

test("aide : en anglais", async (t) => {
  const p = openGuide(undefined, {}, "en");
  t.after(p.close);
  await settle();
  assert.equal(p.$("onboarding-title").textContent, "Getting started");
  assert.equal(p.$("onboarding-progress").textContent, "0/3 done");
  assert.equal(taskTitles(p)[0], "1Fetch your Moxfield collection");
  assert.match(p.$("onboarding-legend-body").textContent, /Buildable ≠ built/);
});

test("chiffres clés : un message plutôt que quatre zéros tant que rien n'est récupéré", async (t) => {
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(p.close);
  await settle();
  assert.equal(p.$("stats").hidden, true);
  assert.equal(p.$("stats-empty").hidden, false);
  assert.match(p.$("stats-empty").textContent, /une fois ta collection récupérée/);

  const q = openPopup({ GET_STATE: { ok: true, state: MOUNTED_STATE }, GET_COLLECTION_STATUS: collectionStatus({}) });
  t.after(q.close);
  await settle();
  assert.equal(q.$("stats").hidden, false);
  assert.equal(q.$("stats-empty").hidden, true);
});

// --- Mes decks ---

const DECKS = [
  { deckId: "b1", name: "Zethi", url: "https://moxfield.com/decks/b1", followed: false, fetchedAt: null, status: "built" },
  { deckId: "k1", name: "Teval", url: "https://moxfield.com/decks/k1", followed: true, fetchedAt: 1, status: "blocked", blocking: 3, label: "3 cartes bloquent le montage : …" },
  { deckId: "o1", name: "Saheeli", url: "https://moxfield.com/decks/o1", followed: true, fetchedAt: 1, status: "buildable", blocking: 0, label: "montable : …" },
  { deckId: "u1", name: "Inconnu", url: "https://moxfield.com/decks/u1", followed: true, fetchedAt: null, status: "unknown" },
];

async function openDecksSection(p) {
  const details = p.$("decks-details");
  details.open = true;
  details.dispatchEvent(new p.win.Event("toggle"));
  await settle();
}
const deckRows = (p) => [...p.$("decks-list").querySelectorAll(".deck-row")].map((r) => [r.querySelector("a").textContent, r.querySelector(".deck-status").textContent]);

test("Mes decks : rien demandé section repliée ; montables d'abord, puis bloqués, à vérifier, montés", async (t) => {
  const p = openPopup({ GET_COLLECTION_STATUS: collectionStatus({}), GET_DECKS: { ok: true, decks: DECKS, staleIds: [] } });
  t.after(p.close);
  await settle();
  assert.ok(!p.sent.some((m) => m.type === "GET_DECKS"), "section repliée : rien demandé");
  await openDecksSection(p);
  assert.deepEqual(deckRows(p), [
    ["Saheeli", "Montable"],
    ["Teval", "3 cartes bloquent"],
    ["Inconnu", "À vérifier"],
    ["Zethi", "Monté"],
  ]);
  assert.equal(p.$("decks-list").querySelector(".deck-status.blocked").title, "3 cartes bloquent le montage : …");
  assert.equal(p.$("decks-list").querySelectorAll(".deck-remove").length, 3, "pas de « retirer » pour un deck monté");
  assert.ok(!p.sent.some((m) => m.type === "REFRESH_DECKS"), "rien à relire");
});

test("Mes decks : decks à relire relus à l'ouverture, puis liste redessinée ; erreur affichée", async (t) => {
  let decks = [{ ...DECKS[3] }];
  const p = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({}),
    GET_DECKS: () => ({ ok: true, decks, staleIds: decks[0].status === "unknown" ? ["u1"] : [] }),
    REFRESH_DECKS: () => {
      decks = [{ ...DECKS[2], deckId: "u1", name: "Inconnu" }];
      return { ok: true, refreshed: 1 };
    },
  });
  t.after(p.close);
  await openDecksSection(p);
  await settle();
  assert.deepEqual(p.sent.find((m) => m.type === "REFRESH_DECKS").payload, { deckIds: ["u1"] });
  assert.deepEqual(deckRows(p), [["Inconnu", "Montable"]]);

  const failing = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({}),
    GET_DECKS: { ok: true, decks: [DECKS[3]], staleIds: ["u1"] },
    REFRESH_DECKS: { ok: false, code: "not-logged-in", error: "Pas de session Moxfield : connecte-toi sur moxfield.com dans ce navigateur." },
  });
  t.after(failing.close);
  await openDecksSection(failing);
  await settle();
  assert.match(failing.$("decks-status").textContent, /^Erreur : Pas de session Moxfield/);
});

test("Mes decks : ajouter une adresse, retirer un deck", async (t) => {
  let decks = [];
  const p = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({}),
    GET_DECKS: () => ({ ok: true, decks, staleIds: [] }),
    ADD_DECK: (msg) => {
      if (!msg.payload.input.includes("moxfield.com/decks/")) return { ok: false, code: "invalid-deck", error: "Adresse de deck Moxfield non reconnue (ex. https://moxfield.com/decks/…)." };
      decks = [DECKS[2]];
      return { ok: true, refreshed: 1 };
    },
    UNFOLLOW_DECK: () => ((decks = []), { ok: true }),
  });
  t.after(p.close);
  await openDecksSection(p);
  assert.match(p.$("decks-list").textContent, /Aucun deck pour le moment/);

  p.$("deck-add-input").value = "n'importe quoi";
  p.$("deck-add-btn").click();
  await settle();
  assert.match(p.$("decks-status").textContent, /non reconnue/);

  p.$("deck-add-input").value = "https://moxfield.com/decks/o1";
  p.$("deck-add-btn").click();
  await settle();
  assert.deepEqual(deckRows(p), [["Saheeli", "Montable"]]);
  assert.equal(p.$("deck-add-input").value, "");

  p.$("decks-list").querySelector(".deck-remove").click();
  await settle();
  assert.deepEqual(p.sent.find((m) => m.type === "UNFOLLOW_DECK").payload, { deckId: "o1" });
  assert.match(p.$("decks-list").textContent, /Aucun deck pour le moment/);
});

test("liste d'achats : decks lus et non montés cochables, liste cumulée, copie pour Cardmarket", async (t) => {
  const p = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({}),
    GET_DECKS: { ok: true, decks: DECKS, staleIds: [] },
    GET_SHOPPING_LIST: (msg) =>
      msg.payload.deckIds.length === 1
        ? { ok: true, deckCount: 1, skipped: [], items: [], total: 0, unpriced: 0 }
        : {
            ok: true,
            deckCount: 2,
            skipped: [],
            items: [
              { name: "Rhystic Study", have: 0, need: 2, missing: 2, decks: ["Teval", "Saheeli"], unit: 30, total: 60 },
              { name: "Arcane Signet", have: 0, need: 1, missing: 1, decks: ["Teval"] },
            ],
            total: 60,
            unpriced: 1,
          },
  });
  t.after(p.close);
  const copied = [];
  Object.defineProperty(p.win.navigator, "clipboard", { value: { writeText: async (text) => copied.push(text) } });
  const opened = [];
  p.win.chrome.tabs = { create: (o) => opened.push(o.url) };
  await openDecksSection(p);
  const boxes = () => [...p.$("decks-list").querySelectorAll(".deck-shop")];
  assert.deepEqual(boxes().map((b) => b.closest(".deck-row").querySelector("a").textContent), ["Saheeli", "Teval"], "ni monté, ni jamais lu");
  assert.match(p.$("shopping-list").textContent, /Coche des decks/);

  boxes()[0].click();
  await settle();
  assert.deepEqual(p.sent.filter((m) => m.type === "GET_SHOPPING_LIST").pop().payload, { deckIds: ["o1"] });
  assert.match(p.$("shopping-list").textContent, /Rien à acheter : ton stock libre suffit pour le deck coché/);

  boxes()[1].click();
  await settle();
  const text = p.$("shopping-list").textContent;
  assert.match(text, /3 cartes à acheter \(decks cochés : 2\)/);
  assert.match(text, /au moins 60,00\s€ \(1 carte sans prix\)/);
  assert.match(text, /2 × Rhystic Study · 60,00\s€ \(30,00\s€ l'unité\)/);
  assert.match(text, /as 0 de libre, besoin 2 — Teval, Saheeli/);

  p.$("shopping-copy-btn").click();
  await settle();
  assert.deepEqual(copied, ["2 Rhystic Study\n1 Arcane Signet"]);
  assert.deepEqual(opened, ["https://www.cardmarket.com/fr/Magic/Wants"]);
  assert.match(p.$("shopping-status").textContent, /2 cartes copiées/);

  // Tout décocher : retour à l'invitation (la réponse au premier décochage,
  // arrivée après, est ignorée).
  boxes().forEach((b) => b.checked && b.click());
  await settle();
  assert.match(p.$("shopping-list").textContent, /Coche des decks/);
});

test("liste d'achats : deck coché puis monté, décoché à l'affichage suivant", async (t) => {
  let decks = [DECKS[1], DECKS[2]];
  const p = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({}),
    GET_DECKS: () => ({ ok: true, decks, staleIds: [] }),
    GET_SHOPPING_LIST: { ok: true, deckCount: 1, skipped: [], items: [], total: 0, unpriced: 0 },
  });
  t.after(p.close);
  await openDecksSection(p);
  p.$("decks-list").querySelector(".deck-shop").click();
  await settle();
  decks = [DECKS[1], { ...DECKS[2], status: "built" }];
  p.$("decks-refresh-btn").click();
  await settle();
  await settle();
  assert.match(p.$("shopping-list").textContent, /Coche des decks/, "Saheeli monté : plus coché");
  p.$("decks-list").querySelector(".deck-shop").click();
  await settle();
  assert.deepEqual(p.sent.filter((m) => m.type === "GET_SHOPPING_LIST").pop().payload, { deckIds: ["k1"] });
});
