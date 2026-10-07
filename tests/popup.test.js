// Tests du popup (popup.html + popup.js) : npm test
//
// Le popup est chargé dans une page jsdom avec un faux `chrome` qui répond
// aux messages comme le service worker. Seule la section « Collection
// Moxfield » est couverte pour l'instant.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
const SCRIPT = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");

const EMPTY_STATE = { stock: {}, builtDecks: {} };
const SYNC_OFF = { enabled: false };

// responses : réponse du faux service worker par type de message (objet ou
// fonction recevant le message).
function openPopup(responses) {
  const dom = new JSDOM(HTML.replace(/<script src="popup.js"><\/script>/, ""), { runScripts: "outside-only" });
  const win = dom.window;
  const sent = [];
  const storageListeners = [];
  const handlers = {
    GET_STATE: { ok: true, state: EMPTY_STATE },
    GET_SYNC_STATUS: { ok: true, meta: SYNC_OFF },
    ...responses,
  };
  win.chrome = {
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
  win.eval(SCRIPT);
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
      lastError: { code: "not-logged-in", message: "Session Moxfield expirée : reconnecte-toi sur moxfield.com dans Chrome." },
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
  assert.match(el.textContent, /ne couvre plus 1 carte\(s\)/);
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
  assert.equal(p.$("collection-status").textContent, "2 carte(s) modifiée(s), stock mis à jour.");
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
  assert.equal(p.$("stock-table").querySelector("p.hint").textContent, "… et 300 autre(s) carte(s) : affine avec le filtre.");
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
