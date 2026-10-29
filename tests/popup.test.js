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
const SCRIPTS = ["i18n.js", "popup.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"));

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

test("rapports d'erreurs : accord demandé en haut du popup tant que pas de réponse", async (t) => {
  let enabled = null;
  const popup = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({ enabled: false }),
    GET_ERROR_REPORTS: () => ({ ok: true, enabled, configured: true }),
    SET_ERROR_REPORTS: (msg) => ((enabled = msg.payload.enabled), { ok: true, enabled, configured: true }),
  });
  t.after(popup.close);
  await settle();
  assert.equal(popup.$("error-reports-consent").hidden, false);
  popup.$("error-reports-decline").click();
  await settle();
  assert.deepEqual(popup.sent.find((m) => m.type === "SET_ERROR_REPORTS").payload, { enabled: false });
  assert.equal(popup.$("error-reports-consent").hidden, true, "réponse donnée : question retirée");
});

test("rapports d'erreurs : choix déjà fait, pas de question ; case décochable", async (t) => {
  let enabled = true;
  const popup = openPopup({
    GET_COLLECTION_STATUS: collectionStatus({ enabled: false }),
    GET_ERROR_REPORTS: () => ({ ok: true, enabled, configured: true }),
    SET_ERROR_REPORTS: (msg) => ((enabled = msg.payload.enabled), { ok: true, enabled, configured: true }),
  });
  t.after(popup.close);
  await settle();
  assert.equal(popup.$("error-reports-consent").hidden, true);
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
