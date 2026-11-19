// content-deck.js — injecté sur tout moxfield.com (voir manifest.json).
//
// Moxfield est une SPA : naviguer d'une page à l'autre (ex. cliquer sur un
// deck depuis une liste) change l'URL via l'API History du navigateur, SANS
// rechargement complet de page. Un content script ne se relance PAS sur ce
// type de navigation "douce" — il ne s'exécute qu'au chargement initial du
// document. On surveille donc nous-mêmes les changements d'URL (polling
// léger toutes les 500ms) pour faire apparaître/disparaître le bouton en
// fonction de la page réellement affichée à l'instant T.

(function () {
  let currentDeckId = null;
  let btn = null;

  // Pages de listing sous /decks/{...} qui ont la même forme d'URL qu'un
  // deck (un seul segment) mais n'en sont pas — à compléter si d'autres
  // sont trouvées.
  const NON_DECK_SLUGS = new Set(["public"]);

  // Uniquement la page d'un deck précis, ex. /decks/Z9iP5lF4OEusUjMQXrpbgg —
  // ancré en fin de chaîne (contrairement à avant) pour exclure les
  // sous-pages du deck (/decks/{id}/primer, /decks/{id}/changelog, etc.), et
  // exclusion explicite des pages de listing (cf. NON_DECK_SLUGS).
  function isDeckPage() {
    const m = window.location.pathname.match(/^\/decks\/([^/]+)\/?$/);
    return Boolean(m) && !NON_DECK_SLUGS.has(m[1].toLowerCase());
  }

  // Tous les formats : le bouton a d'abord été réservé aux decks Commander
  // (badge d'en-tête "Commander", classe "badge-header"), mais rien dans les
  // contrôles n'en dépend — un deck de 60 cartes se monte avec sa réserve
  // (sideboard), comptée dans le total annoncé par Moxfield.

  function getDeckId() {
    const m = window.location.pathname.match(/\/decks\/([^/]+)/);
    return m ? m[1] : null;
  }

  function getDeckName() {
    const h1 = document.querySelector("h1");
    return (h1 && h1.textContent.trim()) || document.title.replace(/\s*\|\s*Moxfield.*$/i, "").trim();
  }

  // Textes traduits : voir i18n.js.
  const i18n = createChromeI18n();
  const { t, tn } = i18n;
  // Lu dès le chargement : une fois l'extension rechargée, chrome.i18n peut
  // ne plus répondre, et c'est justement là qu'il faut ce message.
  const CONTEXT_INVALIDATED_MESSAGE = t("extensionReloaded");

  // Lecture de la liste du deck sur la page : voir deck-scraper.js.
  const { normalizeName, scrapeCardsGuess, getSiteDeclaredTotal, completeCardNames, computeDeckDiff, versionsToRecord } =
    createDeckScraper(window);

  // Contrôles de la liste par rapport au stock : voir deck-checks.js.
  const {
    isBasicLand,
    buildWrongEditionSet,
    computeWrongEditionCards,
    computeShortages,
    computeShortagePrices,
    proxyTotal,
    addProxies,
    carryProxies,
    buildVersionUsage,
    computeVersionConflicts,
    parseCardsText,
    evaluateDeckUpdate,
    computeDeckAvailability,
    blockingSummary,
    availabilityLabel,
  } = createDeckChecks(normalizeName, i18n);

  // Cartes possédées dans une autre version que celle du deck (cf.
  // buildWrongEditionSet), pour la liste affichée dans la fenêtre. Bloque le
  // montage tant que la liste n'est pas corrigée/retirée — même traitement
  // que le stock insuffisant plutôt qu'un décompte silencieux. Vide si la
  // liste vient du presse-papiers.
  let lastWrongEditionNames = new Set();

  function renderPrintingWarning(el, names) {
    if (names.length === 0) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    el.style.display = "block";
    el.innerHTML =
      `<strong>🚫 ${escapeHtml(tn("printingWarningTitle", names.length))}</strong> — ${escapeHtml(t("printingWarningHint"))}` +
      "<ul>" +
      names.map((n) => `<li>${escapeHtml(n)}</li>`).join("") +
      "</ul>";
  }

  // --- Passer le deck Moxfield sur les éditions de ta collection ---
  // Bouton du ruban, juste à gauche de « Monter », affiché quand Moxfield
  // indique des cartes possédées dans une autre édition (cf.
  // ownedEditionNames). Un seul clic (demande de l'utilisateur : pas de
  // proposition à confirmer, et le deck n'est pas monté) : le service worker
  // choisit une édition possédée par carte (PLAN_OWNED_EDITIONS), l'écrit sur
  // Moxfield (APPLY_OWNED_EDITIONS), puis la page est rechargée — Moxfield
  // n'affiche pas une modification faite ailleurs que dans son interface.
  const EDITION_SKIP_REASONS = {
    "not-in-deck": "ownedEditionsSkipNotInDeck",
    several: "ownedEditionsSkipSeveral",
    "no-other-edition": "ownedEditionsSkipNoOther",
    "edition-unknown": "ownedEditionsSkipUnknown",
    changed: "ownedEditionsSkipChanged",
    "not-enough": "ownedEditionsSkipNotEnough",
    taken: "ownedEditionsSkipTaken",
  };
  // sessionStorage : survit au rechargement de l'onglet, pas au-delà.
  const OWNED_EDITIONS_KEY = "msmOwnedEditionsDone";
  // Cartes qu'un clic n'a pas pu changer (pas assez d'exemplaires dans une
  // même édition, aucune autre édition…), par deck : plus comptées sur le
  // bouton, sinon il resterait bloqué sur un nombre qu'aucun clic ne fait
  // baisser (constaté en vrai avec les terrains de base, novembre 2026).
  // Oubliées à la fermeture de l'onglet : la collection a pu changer.
  // « changed » (modifiée ailleurs entre-temps) n'en fait pas partie : un
  // nouveau clic peut la changer.
  const OWNED_EDITIONS_UNFIXABLE_KEY = "msmOwnedEditionsUnfixable";
  // Decks retenus au plus (sessionStorage est limité).
  const MAX_UNFIXABLE_DECKS = 20;
  const frontFace = (name) => normalizeName(name).split(" // ")[0];

  function readUnfixable() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(OWNED_EDITIONS_UNFIXABLE_KEY) || "{}");
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  }

  function rememberUnfixable(deckId, skipped) {
    const names = skipped.filter((s) => s.reason !== "changed").map((s) => frontFace(s.name));
    if (names.length === 0) return;
    const saved = readUnfixable();
    const merged = [...new Set([...(saved[deckId] || []), ...names])];
    delete saved[deckId];
    const kept = Object.entries(saved).slice(-(MAX_UNFIXABLE_DECKS - 1));
    try {
      sessionStorage.setItem(OWNED_EDITIONS_UNFIXABLE_KEY, JSON.stringify(Object.fromEntries([...kept, [deckId, merged]])));
    } catch {
      // Stockage bloqué : le bouton continue de les compter.
    }
  }

  function isUnfixable(deckId, name) {
    return (readUnfixable()[deckId] || []).includes(frontFace(name));
  }
  // Au-delà, le rechargement n'est plus le nôtre (onglet rouvert plus tard).
  const OWNED_EDITIONS_RESUME_MS = 30000;

  // Cartes de la page que Moxfield indique possédées, mais pas dans
  // l'édition du deck (« Partially in collection », cf.
  // buildWrongEditionSet), terrains de base compris : changer leur édition
  // ne dépend pas du stock libre ni du montage. Sans celles qu'un clic n'a
  // pas pu changer sur ce deck (cf. rememberUnfixable).
  function ownedEditionNames(cards, deckId) {
    const wrong = buildWrongEditionSet(cards);
    const names = [];
    for (const c of cards) {
      if (wrong.has(normalizeName(c.name)) && !names.includes(c.name) && !isUnfixable(deckId, c.name)) names.push(c.name);
    }
    return names;
  }

  function skippedText(skipped) {
    return skipped.map((s) => `${s.name} — ${t(EDITION_SKIP_REASONS[s.reason] || "unknownError")}`).join(" ; ");
  }

  // Un clic à la fois : l'écriture sur Moxfield prend jusqu'à une minute.
  let ownedEditionsRunning = false;

  // Fenêtre qui bloque la page pendant le traitement, avec une jauge mise à
  // jour par le service worker (OWNED_EDITIONS_PROGRESS) : sans elle, une
  // minute sans rien voir bouger donne l'impression que rien ne marche
  // (retour utilisateur), et la page ne doit pas être modifiée pendant ce
  // temps. total absent : jauge sans fin (étape de durée inconnue).
  let progressEl = null;

  function showEditionsProgress(text, done, total) {
    if (!progressEl) {
      progressEl = document.createElement("div");
      progressEl.className = "msm-progress-overlay";
      progressEl.setAttribute("role", "dialog");
      progressEl.setAttribute("aria-modal", "true");
      progressEl.setAttribute("aria-busy", "true");
      progressEl.innerHTML =
        `<div class="msm-modal msm-progress-modal"><h2>🔄 ${escapeHtml(t("ownedEditionsButton"))}</h2>` +
        `<p class="msm-progress-text" aria-live="polite"></p>` +
        `<div class="msm-progress-bar"><div class="msm-progress-fill"></div></div>` +
        `<p class="msm-progress-hint">${escapeHtml(t("ownedEditionsProgressHint"))}</p></div>`;
      document.body.appendChild(progressEl);
    }
    progressEl.querySelector(".msm-progress-text").textContent = text;
    const bar = progressEl.querySelector(".msm-progress-bar");
    const known = Number.isInteger(total) && total > 0;
    bar.classList.toggle("msm-progress-indeterminate", !known);
    progressEl.querySelector(".msm-progress-fill").style.width = known ? `${Math.round((100 * Math.min(done, total)) / total)}%` : "";
  }

  function hideEditionsProgress() {
    if (progressEl) progressEl.remove();
    progressEl = null;
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "OWNED_EDITIONS_PROGRESS" || !ownedEditionsRunning || !progressEl) return;
      const key = msg.step === "apply" ? "ownedEditionsApplyProgress" : "ownedEditionsPlanProgress";
      showEditionsProgress(t(key, msg.done, msg.total), msg.done, msg.total);
    });
  } catch (e) {
    // contexte d'extension invalidé : pas de jauge, le traitement reste possible
  }

  async function useOwnedEditions(deckId, names) {
    if (ownedEditionsRunning || names.length === 0) return;
    ownedEditionsRunning = true;
    renderEditionsButton();
    let reloading = false;
    try {
      showEditionsProgress(t("ownedEditionsLoading"));
      const planned = await safeSendMessage({ type: "PLAN_OWNED_EDITIONS", payload: { deckId, names } });
      if (planned.error === "extension-context-invalidated") return; // toast déjà affiché par safeSendMessage
      if (!planned.ok) {
        toast(t("errorPrefix", planned.error || t("unknownError")), true);
        return;
      }
      let res = { ok: true, done: [], skipped: [] };
      if (planned.plan.length > 0) {
        showEditionsProgress(t("ownedEditionsApplyProgress", 0, planned.plan.length), 0, planned.plan.length);
        res = await safeSendMessage({ type: "APPLY_OWNED_EDITIONS", payload: { deckId, plan: planned.plan } });
        if (res.error === "extension-context-invalidated") return;
      }
      const done = res.done || [];
      const skipped = [...planned.skipped, ...(res.skipped || [])];
      rememberUnfixable(deckId, skipped);
      if (done.length > 0) {
        try {
          sessionStorage.setItem(
            OWNED_EDITIONS_KEY,
            JSON.stringify({ deckId, done: done.length, error: res.ok ? null : res.error || t("unknownError"), at: Date.now() })
          );
        } catch {
          // Stockage bloqué : la page est rechargée quand même, sans le bilan.
        }
        // Fenêtre gardée jusqu'au rechargement.
        reloading = true;
        showEditionsProgress(t("ownedEditionsReloading"), 1, 1);
        window.location.reload();
        return;
      }
      // Rien n'a changé : pas de rechargement, la raison est affichée.
      setEditionNames(btnEditionNames.filter((n) => !isUnfixable(deckId, n)));
      const summary = res.ok ? t("ownedEditionsZero") : tn("ownedEditionsFailed", 0, res.error || t("unknownError"));
      toast(skipped.length > 0 ? `${summary} ${skippedText(skipped)}` : summary, true);
    } finally {
      if (!reloading) hideEditionsProgress();
      ownedEditionsRunning = false;
      renderEditionsButton();
    }
  }

  // Après le rechargement déclenché par useOwnedEditions : bilan, une fois.
  let ownedEditionsResume = null;
  try {
    const raw = sessionStorage.getItem(OWNED_EDITIONS_KEY);
    sessionStorage.removeItem(OWNED_EDITIONS_KEY);
    // Âge et deck vérifiés par announceOwnedEditions.
    if (raw) ownedEditionsResume = JSON.parse(raw);
  } catch {
    // Stockage bloqué ou illisible : pas de bilan.
  }

  function announceOwnedEditions(deckId) {
    if (!ownedEditionsResume) return;
    const { done, error, at } = ownedEditionsResume;
    const ours = ownedEditionsResume.deckId === deckId && Date.now() - at <= OWNED_EDITIONS_RESUME_MS;
    ownedEditionsResume = null;
    if (ours) toast(error ? tn("ownedEditionsFailed", done, error) : tn("ownedEditionsDone", done), Boolean(error));
  }

  // Versions (impressions Moxfield) des cartes de la liste détectée, par nom
  // normalisé (cf. ownedVersionOf dans deck-scraper.js) : la zone de texte
  // de la fenêtre ne porte que « QTE Nom ». Vide si la liste vient du
  // presse-papiers.
  let lastVersions = new Map();
  // Codes des impressions du deck, possédées ou non, par nom normalisé :
  // pour le prix des cartes manquantes (cf. printingCodeOf dans
  // deck-scraper.js). Gardés même si la quantité est modifiée à la main.
  let lastPrintingCodes = new Map();

  function rememberVersions(cards) {
    lastVersions = new Map(cards.filter((c) => c.versions && c.versions.length > 0).map((c) => [normalizeName(c.name), c.versions]));
    lastPrintingCodes = printingCodesByName(cards);
  }

  function printingCodesByName(cards) {
    return new Map(cards.filter((c) => c.printingCodes && c.printingCodes.length > 0).map((c) => [normalizeName(c.name), c.printingCodes]));
  }

  // Version du deck d'une carte ({ set, cn }, donnée par l'API du deck), pour
  // imprimer son proxy ; null si inconnue (l'impression se fera par nom).
  function proxyPrintingFinder(codesByName) {
    return (name) => {
      for (const code of codesByName.get(normalizeName(name)) || []) {
        if (printingsByCode.has(code)) return { ...printingsByCode.get(code) };
      }
      return null;
    };
  }

  // Liste de la zone de texte, complétée des versions détectées. Quantité
  // modifiée à la main : on ne sait plus quelle version est concernée, la
  // carte est enregistrée sans version.
  function withVersions(cards) {
    return cards.map(({ name, qty }) => {
      const versions = lastVersions.get(normalizeName(name));
      const known = versions && versions.reduce((n, v) => n + v.qty, 0) <= qty;
      return known ? { name, qty, versions } : { name, qty };
    });
  }

  // Édition et numéro des impressions (code Moxfield → { set, cn }), donnés
  // par l'API du deck via le service worker (GET_DECK_PRINTINGS) : la page
  // ne porte que le code, la collection que l'édition. Un code désigne
  // toujours la même impression : ce qui est appris est gardé tant que
  // l'onglet vit. Sans réponse (pas connecté, réseau), les versions restent
  // sans édition et le contrôle se replie sur le recoupement (cf.
  // computeVersionConflicts dans deck-checks.js).
  const printingsByCode = new Map();
  // Prix en euros de ces mêmes impressions (code → prix), donnés par la même
  // réponse : sert au coût des cartes manquantes (cf. computeShortagePrices
  // dans deck-checks.js). Gardé à part : il ne doit pas être enregistré avec
  // les versions d'un deck monté.
  const pricesByCode = new Map();
  // Dernière demande : les mêmes codes inconnus ne sont pas redemandés avant
  // ce délai (chaque demande renouvelle la session Moxfield côté service
  // worker, et la page est contrôlée toutes les 3 secondes).
  const PRINTINGS_RETRY_MS = 5 * 60 * 1000;
  let printingsAsked = { key: null, at: 0 };
  let printingsRequest = null;
  // Codes absents d'une réponse réussie (code → moment de la réponse) :
  // redemander tout de suite ne les ferait pas apparaître, mais une carte
  // tout juste ajoutée au deck peut ne pas encore être enregistrée chez
  // Moxfield, d'où le même délai qu'après un échec.
  const printingsMissing = new Map();

  // Demande les éditions (et prix) des impressions pas encore connues ;
  // résout à true si de nouvelles éditions ont été apprises. Ne lève jamais :
  // sans elles, les contrôles se font par recoupement. Impressions non
  // possédées comprises : un deck dont tu n'as aucune carte a aussi besoin
  // de ses prix.
  function loadPrintings(deckId, cards) {
    const unknown = new Set();
    const ask = (code) => {
      if (printingsByCode.has(code)) return;
      if (printingsMissing.has(code) && Date.now() - printingsMissing.get(code) < PRINTINGS_RETRY_MS) return;
      unknown.add(code);
    };
    for (const c of cards) {
      for (const v of c.versions || []) ask(v.code);
      for (const code of c.printingCodes || []) ask(code);
    }
    if (unknown.size === 0) return Promise.resolve(false);
    if (printingsRequest) return printingsRequest;
    const key = deckId + ":" + [...unknown].sort().join(",");
    if (key === printingsAsked.key && Date.now() - printingsAsked.at < PRINTINGS_RETRY_MS) return Promise.resolve(false);
    printingsAsked = { key, at: Date.now() };
    printingsRequest = (async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: "GET_DECK_PRINTINGS", payload: { deckId } });
        if (!res || !res.ok || !res.printings) return false;
        let added = false;
        for (const [code, printing] of Object.entries(res.printings)) {
          if (printing && typeof printing.eur === "number" && printing.eur > 0) pricesByCode.set(code, printing.eur);
          if (printingsByCode.has(code) || !printing || typeof printing.set !== "string" || !printing.set) continue;
          printingsByCode.set(code, { set: printing.set, cn: typeof printing.cn === "string" ? printing.cn : "" });
          added = true;
        }
        for (const code of unknown) if (!printingsByCode.has(code)) printingsMissing.set(code, Date.now());
        return added;
      } catch (e) {
        return false; // extension rechargée ou service worker injoignable
      } finally {
        printingsRequest = null;
      }
    })();
    return printingsRequest;
  }

  // Liste dont les versions portent leur édition, quand elle est connue.
  function withPrintings(cards) {
    return cards.map((c) => {
      if (!c.versions || !c.versions.some((v) => printingsByCode.has(v.code))) return c;
      return { ...c, versions: c.versions.map((v) => (printingsByCode.has(v.code) ? { ...v, ...printingsByCode.get(v.code) } : v)) };
    });
  }

  // Version déjà prise par un autre deck monté (cf. computeVersionConflicts
  // dans deck-checks.js) : bloque le montage, comme la version différente.
  function renderVersionWarning(el, conflicts) {
    if (conflicts.length === 0) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    const item = (c) => {
      const details = [];
      if (c.decks.length > 0) details.push(t("shortageIn", c.decks.map((d) => `${d.name} (${d.qty})`).join(", ")));
      details.push(t("versionOwned", c.owned.map((p) => `${p.set.toUpperCase()} ${p.cn} ×${p.qty}`).join(", ")));
      return `<li>${escapeHtml(c.name)} · <strong>${escapeHtml(details.join(" · "))}</strong></li>`;
    };
    el.style.display = "block";
    el.innerHTML =
      `<strong>🚫 ${escapeHtml(tn("versionWarningTitle", conflicts.length))}</strong> — ${escapeHtml(t("versionWarningHint"))}<ul>` +
      conflicts.map(item).join("") +
      "</ul>";
  }

  function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delayMs);
    };
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Stock des seules cartes utiles (cartes demandées, et celles du montage du
  // deck deckId s'il est monté) et decks montés, null en cas d'échec. Pas
  // l'état complet : une grosse collection pèse plusieurs Mo, et cette
  // lecture a lieu toutes les quelques secondes (cf. GET_DECK_CONTEXT dans
  // background.js). send : safeSendMessage, ou chrome.runtime.sendMessage
  // pour les contrôles en fond (pas de toast si l'extension a été rechargée).
  async function getDeckContext(cards, deckId = null, send = safeSendMessage) {
    const names = cards.map((c) => c.name);
    const res = await send({ type: "GET_DECK_CONTEXT", payload: { deckId, names } });
    return res && res.ok ? { stock: res.stock || {}, builtDecks: res.builtDecks || {} } : null;
  }

  async function getStockMap(cards) {
    const context = await getDeckContext(cards);
    return context ? context.stock : {};
  }

  // Pour chaque carte (nom normalisé), les decks montés qui la contiennent —
  // sert à indiquer, pour une carte manquante, quel deck démonter pour la
  // récupérer. Même règle que le popup : les cartes excludedFromStock
  // (decks montés avec une ancienne version) n'ont jamais été retirées du
  // stock, elles ne comptent donc pas comme "prises" par le deck.
  // excludeDeckId : deck à ignorer (celui qu'on met à jour, dont les cartes
  // lui reviennent).
  async function getStockAndDeckUsage(cards, excludeDeckId = null) {
    const context = await getDeckContext(cards, excludeDeckId);
    if (!context) return { stockMap: {}, deckUsage: new Map(), versionUsage: new Map(), builtDecks: {} };
    const deckUsage = new Map();
    for (const [deckId, deck] of Object.entries(context.builtDecks)) {
      if (deckId === excludeDeckId) continue;
      for (const card of deck.cards || []) {
        if (card.excludedFromStock) continue;
        const key = normalizeName(card.name);
        if (!deckUsage.has(key)) deckUsage.set(key, []);
        deckUsage.get(key).push({ name: deck.name, qty: card.qty });
      }
    }
    return {
      stockMap: context.stock,
      deckUsage,
      versionUsage: buildVersionUsage(context.builtDecks, excludeDeckId),
      builtDecks: context.builtDecks,
    };
  }

  // codesByName : nom normalisé → codes des impressions du deck, pour le
  // prix des cartes manquantes (cf. computeShortagePrices) ; vide (liste
  // collée) : pas de prix. Le montage avec des proxies passe par le bouton
  // principal de la fenêtre (cf. setProxyAction), pas par cet encadré.
  function renderShortageWarning(el, shortages, deckUsage = new Map(), codesByName = new Map()) {
    if (shortages.length === 0) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    el.style.display = "block";
    const whereText = (s) => {
      const decks = deckUsage.get(normalizeName(s.name));
      if (!decks || decks.length === 0) return "";
      return ` · <strong>${escapeHtml(t("shortageIn", decks.map((d) => `${d.name} (${d.qty})`).join(", ")))}</strong>`;
    };
    const prices = computeShortagePrices(shortages, codesByName, (code) => pricesByCode.get(code));
    const { formatPrice } = i18n;
    const priceText = (s) => {
      const price = prices.byName.get(normalizeName(s.name));
      if (!price) return "";
      const text = s.missing > 1 ? t("shortagePriceEach", formatPrice(price.total), formatPrice(price.unit)) : formatPrice(price.total);
      return ` · <span class="msm-price">${escapeHtml(text)}</span>`;
    };
    // Aucun prix (pas de réponse de l'API du deck, liste collée) : pas de
    // total du tout plutôt qu'un « au moins 0 € ».
    let totalLine = "";
    if (prices.byName.size > 0) {
      const total = formatPrice(prices.total);
      const text = prices.unpriced > 0 ? tn("shortagePricePartial", prices.unpriced, total) : t("shortagePriceTotal", total);
      totalLine = `<p class="msm-price-total" title="${escapeHtml(t("shortagePriceSource"))}">💶 ${escapeHtml(text)}</p>`;
    }
    el.innerHTML =
      `<strong>⚠️ ${escapeHtml(tn("shortageTitle", shortages.length))}</strong>` +
      `<button type="button" class="msm-secondary msm-export-btn">🛒 ${escapeHtml(t("cardmarketCopyButton"))}</button>` +
      // Avant la liste : le cadre défile, le total resterait sinon caché.
      totalLine +
      "<ul>" +
      shortages
        .map(
          (s) =>
            `<li>${escapeHtml(t("shortageItem", s.name, s.have, s.need, s.missing))}${priceText(s)}${whereText(s)}</li>`
        )
        .join("") +
      "</ul>";
    el.querySelector(".msm-export-btn").addEventListener("click", () => exportShortagesToCardmarket(shortages));
  }

  // Bouton principal de la fenêtre (montage ou mise à jour) : quand seul le
  // stock manque (proxies > 0), il devient « … avec N proxies » plutôt que
  // de proposer les proxies dans un bouton à part, au milieu de l'encadré
  // des manques (retour utilisateur, novembre 2026). Son libellé dit qu'il
  // monte avec des proxies : un clic vaut accord.
  function setProxyAction(button, proxies, plainKey, proxiesKey) {
    button.dataset.proxies = proxies > 0 ? "1" : "";
    button.textContent = proxies > 0 ? tn(proxiesKey, proxies) : t(plainKey);
    button.title = proxies > 0 ? t("proxiesHint") : "";
  }

  // Exemplaires manquants qu'un montage avec des proxies compléterait, ou 0
  // si autre chose bloque (version différente ou déjà utilisée : un proxy
  // ne règle pas une question d'édition, cf. CLAUDE.md).
  function proxiesNeeded(shortages, otherBlocking) {
    return otherBlocking ? 0 : shortages.reduce((n, s) => n + s.missing, 0);
  }

  // Export vers Cardmarket : pas d'API utilisable sans identifiants
  // d'application, ni de remplissage automatique de leur page (autre site,
  // autre scraping fragile). On copie donc la liste au format texte
  // "N Nom" (une carte par ligne, quantité MANQUANTE uniquement) et on ouvre
  // la page des Wants : il reste à la coller dans l'import texte d'une liste
  // de wants, puis à lancer le Shopping Wizard. Les terrains de base et les
  // cartes en "version différente" n'y figurent pas : elles sont déjà
  // exclues de `shortages` (cf. updateWarnings / computeWrongEditionCards).
  // Page dans la langue de l'extension (cf. cardmarketWantsUrl dans _locales).
  const CARDMARKET_WANTS_URL = t("cardmarketWantsUrl");

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Repli si l'API presse-papiers est refusée : sélection d'un textarea temporaire.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  async function exportShortagesToCardmarket(shortages) {
    const text = shortages.map((s) => `${s.missing} ${s.name}`).join("\n");
    const ok = await copyText(text);
    if (!ok) {
      toast(t("clipboardCopyFailed"), true);
      return;
    }
    window.open(CARDMARKET_WANTS_URL, "_blank", "noopener");
    toast(tn("cardmarketCopied", shortages.length));
  }

  // Avertissement non bloquant regroupant les deux mêmes problèmes que les
  // zones ci-dessus (version différente / stock insuffisant), mais pour les
  // terrains de base uniquement — n'empêche jamais de valider le montage.
  function renderBasicLandNotice(el, wrongEditionNames, shortages) {
    if (wrongEditionNames.length === 0 && shortages.length === 0) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    const items = [
      ...wrongEditionNames.map((n) => escapeHtml(t("basicLandWrongEdition", n))),
      ...shortages.map((s) => escapeHtml(t("shortageItem", s.name, s.have, s.need, s.missing))),
    ];
    el.style.display = "block";
    el.innerHTML =
      `<strong>ℹ️ ${escapeHtml(t("basicLandTitle", items.length))}</strong> — ${escapeHtml(t("basicLandHint"))}<ul>` +
      items.map((i) => `<li>${i}</li>`).join("") +
      "</ul>";
  }

  // Affiche le nombre total de cartes (somme des quantités) de la liste
  // actuellement dans la zone de texte, recalculé à chaque modification —
  // sert de repère rapide (ex. "99 cartes" pour un deck Commander) pour
  // vérifier que le scraping n'a rien manqué ni dupliqué.
  function renderCardCount(el, cards, siteTotal) {
    if (!el) return;
    if (cards.length === 0) {
      el.textContent = "";
      el.classList.remove("msm-card-count-mismatch");
      return;
    }
    const total = cards.reduce((sum, c) => sum + c.qty, 0);
    const base = t("cardCountBase", tn("cardCount", total), tn("distinctNames", cards.length));
    // Comparaison au total officiel affiché par Moxfield (main deck +
    // sideboard) : une divergence signale une erreur de scraping en amont
    // (carte manquée ou dupliquée) à corriger manuellement dans la liste.
    if (typeof siteTotal === "number" && siteTotal !== total) {
      el.textContent = t("cardCountMismatch", base, tn("cardCount", siteTotal));
      el.classList.add("msm-card-count-mismatch");
    } else {
      el.textContent = base;
      el.classList.remove("msm-card-count-mismatch");
    }
  }

  function cardsToText(cards) {
    return cards.map((c) => `${c.qty} ${c.name}`).join("\n");
  }

  // --- Deck modifié depuis son montage ---
  // La liste enregistrée au montage est figée : si le deck est modifié
  // ensuite sur Moxfield, le stock ne correspond plus aux cartes réellement
  // utilisées. On compare la liste de la page à celle du montage (par nom,
  // quantités cumulées, cf. computeDeckDiff dans deck-scraper.js) pour le
  // signaler et proposer de n'appliquer que la différence.

  // Liste de la page, avec reliable = false si on ne peut pas s'y fier : rien
  // de détecté (liste pas encore affichée), total officiel introuvable ou
  // différent du total détecté (détection incomplète). On ne conclut alors
  // rien, pour ne pas signaler à tort un deck modifié.
  function scrapeDeckListWithCheck() {
    const cards = scrapeCardsGuess();
    const total = cards.reduce((sum, c) => sum + c.qty, 0);
    const siteTotal = getSiteDeclaredTotal();
    return { cards, total, siteTotal, reliable: cards.length > 0 && siteTotal === total };
  }

  function unreliableListMessage({ cards, total, siteTotal }) {
    if (cards.length === 0) return t("pageNoCards");
    const detected = tn("pageCardsDetected", total);
    return siteTotal === null ? t("pageTotalNotFound", detected) : t("pageTotalMismatch", detected, siteTotal);
  }

  function renderDeckDiff(changes) {
    const items = changes.map((c) => {
      // Même quantité, autre version (impression) que celle du montage.
      if (c.version) {
        return (
          `<li><span class="msm-diff-delta">↻</span> ${escapeHtml(c.name)} ` +
          `<span class="msm-diff-detail">(${escapeHtml(t("diffVersionChanged"))})</span></li>`
        );
      }
      const added = c.to > c.from;
      const delta = added ? `+${c.to - c.from}` : `−${c.from - c.to}`;
      return (
        `<li class="${added ? "msm-diff-add" : "msm-diff-remove"}">` +
        `<span class="msm-diff-delta">${delta}</span> ${escapeHtml(c.name)} ` +
        `<span class="msm-diff-detail">(${c.from} → ${c.to})</span></li>`
      );
    });
    return `<ul class="msm-diff">${items.join("")}</ul>`;
  }

  // Proxies d'un deck monté : leur nombre, et de quoi les imprimer (page de
  // l'extension, ouverte par le service worker).
  function renderProxyInfo(el, deckId, deck) {
    const count = proxyTotal(deck.cards);
    if (count === 0) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML =
      `🃏 ${escapeHtml(tn("deckProxyInfo", count))} ` +
      `<button type="button" class="msm-secondary msm-export-btn">🖨️ ${escapeHtml(t("printProxies"))}</button>`;
    el.querySelector("button").addEventListener("click", async () => {
      const res = await safeSendMessage({ type: "OPEN_PROXIES_PAGE", payload: { deckId } });
      if (res.error === "extension-context-invalidated") return; // toast déjà affiché par safeSendMessage
      if (!res.ok) toast(t("errorPrefix", res.error || t("unknownError")), true);
    });
  }

  // Modale d'un deck monté : compare la liste de la page à celle du montage
  // et, si elle a changé, affiche la différence et active « Mettre à jour le
  // montage ». Renvoie la nouvelle liste à enregistrer (proxies du montage
  // reportés), ou null. Stock insuffisant seulement : « Mettre à jour avec
  // N proxies » (cf. setProxyAction).
  async function prepareDeckUpdate(overlay, deckId) {
    const changesEl = overlay.querySelector("#msm-deck-changes");
    changesEl.innerHTML = `<p class="msm-card-count">${escapeHtml(t("deckChecking"))}</p>`;
    // Juste après un chargement ou une modification, Moxfield peut ne pas
    // avoir fini d'afficher la liste (images construites progressivement en
    // Visual Stacks) : on laisse quelques secondes avant de conclure.
    let detection = scrapeDeckListWithCheck();
    for (let waited = 0; !detection.reliable && waited < 3000; waited += 300) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      detection = scrapeDeckListWithCheck();
    }
    const [{ stockMap, deckUsage, versionUsage, builtDecks }] = await Promise.all([
      getStockAndDeckUsage(detection.cards, deckId),
      loadPrintings(deckId, detection.cards),
    ]);
    const deck = builtDecks[deckId];
    if (!deck) {
      changesEl.innerHTML = "";
      return null;
    }
    renderProxyInfo(overlay.querySelector("#msm-proxy-info"), deckId, deck);
    const pageCards = withPrintings(completeCardNames(detection.cards, Object.values(stockMap), deck.cards));
    if (!detection.reliable) {
      // Écarts entre la liste détectée (non fiable) et le montage : aide à
      // comprendre d'où vient l'erreur de détection (doublons, quantités mal
      // lues...).
      const suspect = pageCards.length > 0 ? computeDeckDiff(deck.cards, pageCards) : [];
      changesEl.innerHTML =
        `<p class="msm-card-count">${escapeHtml(t("deckCannotCheck", unreliableListMessage(detection)))}</p>` +
        (suspect.length > 0
          ? `<details class="msm-card-count"><summary>${escapeHtml(tn("deckSuspectSummary", suspect.length))}</summary>` +
            `${renderDeckDiff(suspect)}</details>`
          : "");
      return null;
    }
    const scraped = pageCards;
    const changes = computeDeckDiff(deck.cards, scraped);
    reportPageChanges(deckId, changes);
    const since = i18n.formatDay(deck.updatedAt || deck.builtAt);
    if (changes.length === 0) {
      changesEl.innerHTML = `<p class="msm-card-count">✅ ${escapeHtml(t("deckUnchanged", since))}</p>`;
      return null;
    }

    lastWrongEditionNames = buildWrongEditionSet(scraped);
    const check = evaluateDeckUpdate(changes, deck, stockMap, lastWrongEditionNames, scraped, versionUsage);
    changesEl.innerHTML =
      '<div class="msm-changes">' +
      `<strong>${escapeHtml(t("deckChangedTitle", since))}</strong>` +
      renderDeckDiff(changes) +
      `<p>${escapeHtml(t("deckUpdateHint", t("updateBuild")))}</p></div>`;
    lastPrintingCodes = printingCodesByName(scraped);
    renderShortageWarning(overlay.querySelector("#msm-shortage-warning"), check.shortages, deckUsage, lastPrintingCodes);
    renderPrintingWarning(overlay.querySelector("#msm-printing-warning"), check.wrongEdition);
    renderVersionWarning(overlay.querySelector("#msm-version-warning"), check.versionTaken);
    renderBasicLandNotice(overlay.querySelector("#msm-basic-land-warning"), check.basicWrongEdition, check.basicShortages);

    const updateBtn = overlay.querySelector("#msm-update");
    updateBtn.hidden = false;
    const proxies = proxiesNeeded(check.shortages, check.wrongEdition.length > 0 || check.versionTaken.length > 0);
    setProxyAction(updateBtn, proxies, "updateBuild", "updateBuildWithProxies");
    updateBtn.disabled = check.blocked && proxies === 0;
    if (updateBtn.disabled) updateBtn.title = t("deckUpdateBlocked");
    overlay.querySelector("#msm-confirm").classList.remove("msm-primary");
    const cards = scraped.map(({ name, qty, versions }) => (versions && versions.length > 0 ? { name, qty, versions } : { name, qty }));
    return carryProxies(cards, deck.cards);
  }

  // Icône de l'extension (déclarée dans web_accessible_resources). getURL
  // lève une exception si l'extension a été rechargée sans rafraîchir
  // l'onglet : on se passe alors de l'icône.
  function extensionIconUrl() {
    try {
      return chrome.runtime.getURL("icons/icon32.png");
    } catch (e) {
      return null;
    }
  }

  function buildOverlay({ isBuilt }) {
    const overlay = document.createElement("div");
    overlay.className = "msm-overlay";
    const iconUrl = extensionIconUrl();
    overlay.innerHTML = `
      <div class="msm-modal" role="dialog" aria-modal="true" aria-labelledby="msm-modal-title">
        <div class="msm-modal-header">
          ${iconUrl ? `<img src="${iconUrl}" alt="" width="24" height="24" />` : ""}
          <div>
            <div class="msm-modal-brand">Moxfield Stock Manager</div>
            <h3 id="msm-modal-title">${escapeHtml(t(isBuilt ? "overlayTitleUnbuild" : "overlayTitleBuild"))}</h3>
          </div>
        </div>
        ${
          isBuilt
            ? `<p>${escapeHtml(t("overlayBuiltIntro"))}</p>
               <div id="msm-proxy-info" class="msm-card-count" hidden></div>
               <div id="msm-deck-changes"></div>
               <div id="msm-printing-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-version-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-shortage-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-basic-land-warning" class="msm-info-warning" style="display:none"></div>`
            : `<p>${escapeHtml(t("overlayIntro", t("pasteFromClipboard")))}</p>
               <button id="msm-paste-clipboard" class="msm-secondary">📋 ${escapeHtml(t("pasteFromClipboard"))}</button>
               <div id="msm-card-count" class="msm-card-count"></div>
               <div id="msm-blocking-summary" class="msm-card-count msm-card-count-mismatch" hidden></div>
               <textarea id="msm-cards-textarea" rows="12" placeholder="1 Sol Ring&#10;1 Sidisi, Brood Tyrant&#10;..."></textarea>
               <div id="msm-printing-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-version-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-shortage-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-basic-land-warning" class="msm-info-warning" style="display:none"></div>`
        }
        <div class="msm-modal-actions">
          <button id="msm-cancel">${escapeHtml(t("cancel"))}</button>
          <button id="msm-confirm" class="msm-primary">${escapeHtml(t(isBuilt ? "unbuild" : "confirmBuild"))}</button>
          ${isBuilt ? `<button id="msm-update" class="msm-primary" hidden>${escapeHtml(t("updateBuild"))}</button>` : ""}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function toast(message, isError) {
    const el = document.createElement("div");
    el.className = "msm-toast" + (isError ? " msm-toast-error" : "");
    el.textContent = message;
    // Placer le toast au-dessus de la barre d'actions de Moxfield plutôt que
    // de la masquer (sa hauteur varie selon la largeur de l'écran).
    const barTop = getActionBarTop();
    if (barTop !== null) el.style.bottom = `${window.innerHeight - barTop + 12}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), isError ? 8000 : 5000);
  }

  // Recharger l'extension (chrome://extensions) sans rafraîchir cet onglet
  // laisse l'ancien content script actif mais coupé de l'extension : tout
  // appel à chrome.runtime.* plante alors avec "Extension context
  // invalidated." (typiquement en promesse non interceptée, invisible sauf
  // dans la console). On l'intercepte pour afficher un message clair plutôt
  // que de laisser planter silencieusement.
  function isContextInvalidatedError(err) {
    return Boolean(err && /Extension context invalidated/i.test(err.message || ""));
  }

  // Service worker momentanément injoignable (arrêté par Chrome pendant la
  // requête, en train de redémarrer) : « message channel closed before a
  // response was received » ou « Receiving end does not exist », constatés
  // dans les rapports d'erreurs. Le contrôle en fond suivant (3 secondes plus
  // tard) le réveille : rien à rapporter.
  function isServiceWorkerUnreachableError(err) {
    return Boolean(err && /message channel closed|Receiving end does not exist/i.test(err.message || ""));
  }

  // Erreur inattendue (bug de l'extension, page Moxfield qui a changé) :
  // rapport anonyme envoyé par le service worker (cf. reportError dans
  // background.js). Silencieux si l'extension a été rechargée entre-temps.
  function reportError(where, e) {
    if (isContextInvalidatedError(e)) return;
    try {
      const error = { message: (e && e.message) || String(e), stack: e && e.stack, type: (e && e.name) || "Error" };
      chrome.runtime.sendMessage({ type: "REPORT_ERROR", payload: { where, error } }).catch(() => {});
    } catch (err) {
      // contexte d'extension invalidé
    }
  }

  // Refus du service worker (stock insuffisant…) : message pour
  // l'utilisateur, pas un bug — déjà rapporté par le service worker s'il
  // s'agissait d'une erreur inattendue.
  function refusal(res) {
    return Object.assign(new Error(res.error || t("unknownError")), { expected: true });
  }

  // Erreurs de nos scripts qui échappent à tout try/catch. Les erreurs du
  // site lui-même arrivent aussi ici : on ne garde que celles dont la pile
  // passe par l'extension.
  function isOwnError(e, filename) {
    let base = "chrome-extension://";
    try {
      base = chrome.runtime.getURL("");
    } catch (err) {
      // contexte d'extension invalidé : on garde le préfixe générique
    }
    return String(filename || "").startsWith(base) || String((e && e.stack) || "").includes(base);
  }
  window.addEventListener("error", (event) => {
    if (isOwnError(event.error, event.filename)) reportError("deck-page", event.error || event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (isOwnError(event.reason)) reportError("deck-page", event.reason);
  });

  async function safeSendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        toast(CONTEXT_INVALIDATED_MESSAGE, true);
        return { ok: false, error: "extension-context-invalidated" };
      }
      throw err;
    }
  }

  // Deck monté (cartes comprises), ou null.
  async function getBuiltDeck(deckId) {
    const context = await getDeckContext([], deckId);
    return (context && context.builtDecks[deckId]) || null;
  }

  async function getIsBuilt(deckId) {
    return Boolean(await getBuiltDeck(deckId));
  }

  // Dernier état connu du deck (monté ou non), gardé pour pouvoir redessiner
  // le bouton sans relire le stockage quand il est recréé (passage barre ↔
  // flottant, ou barre re-rendue par React qui a effacé notre bouton).
  let btnBuilt = false;

  // Deck monté dont la liste a changé sur Moxfield depuis le montage (cf.
  // computeDeckDiff) : réévalué régulièrement tant qu'on reste sur la page,
  // car le deck peut être modifié sur place, sans navigation.
  let btnOutdated = false;

  // Deck pas encore monté : faisabilité avec le stock libre (cf.
  // computeDeckAvailability), null tant que la liste de la page n'est pas
  // fiable. Réévaluée elle aussi régulièrement : le stock peut changer
  // ailleurs (autre onglet, synchro Drive, popup).
  let btnAvailability = null;

  // Proxies du deck monté (cf. proxyTotal), affichés sur le bouton.
  // Réévalués avec le reste : ils changent quand un proxy est remplacé
  // depuis le popup.
  let btnProxies = 0;

  let lastStatusCheck = 0;
  let statusCheckRunning = false;
  // Contrôle demandé pendant qu'un autre tournait : relancé à la fin de
  // celui-ci, pour ne pas manquer un changement survenu entre-temps.
  let statusCheckPending = false;
  // Début de la période où la liste de la page n'est pas fiable (0 si elle
  // l'est), cf. UNRELIABLE_GRACE_MS.
  let unreliableSince = 0;
  // Filet de sécurité : la page et le stock déclenchent eux-mêmes un
  // contrôle quand ils changent (cf. watchDeckChanges).
  const STATUS_CHECK_INTERVAL_MS = 3000;
  // Après une modification, Moxfield peut afficher un moment une liste
  // incohérente (ancienne tuile pas encore retirée) : la pastille garde son
  // dernier état tant que ça ne dure pas plus longtemps que ça.
  const UNRELIABLE_GRACE_MS = 3000;

  // Transmet le constat au service worker, pour le badge « Modifié » du
  // popup. Seulement quand il diffère du dernier envoyé : la vérification
  // tourne toutes les 3 secondes. Remis à zéro par refreshButtonState (après
  // un montage, une mise à jour ou un démontage).
  let lastReportedChanges = null;

  function reportPageChanges(deckId, changes) {
    const key = deckId + ":" + JSON.stringify(changes);
    if (key === lastReportedChanges) return;
    lastReportedChanges = key;
    const retryLater = () => {
      lastReportedChanges = null; // extension rechargée entre-temps : on retentera
    };
    try {
      chrome.runtime.sendMessage({ type: "SET_DECK_PAGE_CHANGES", payload: { deckId, changes } }).catch(retryLater);
    } catch (e) {
      retryLater(); // contexte invalidé : l'appel lève avant même de renvoyer une promesse
    }
  }

  // Deck monté sans versions enregistrées (monté avant leur suivi, ou depuis
  // une liste collée) : celles de la page lui sont ajoutées, sans quoi ses
  // cartes ne seraient jamais vues comme « déjà utilisées » ailleurs. Une
  // seule fois par constat, comme reportPageChanges.
  let lastRecordedVersions = null;

  function recordDeckVersions(deckId, versions) {
    const key = deckId + ":" + JSON.stringify(versions);
    if (key === lastRecordedVersions) return;
    lastRecordedVersions = key;
    const retryLater = () => {
      lastRecordedVersions = null;
    };
    try {
      chrome.runtime.sendMessage({ type: "SET_DECK_VERSIONS", payload: { deckId, versions } }).catch(retryLater);
    } catch (e) {
      retryLater();
    }
  }

  // Contrôle en fond de la liste de la page : deck monté modifié depuis le
  // montage, ou faisabilité d'un deck pas encore monté. immediate : contrôle
  // déclenché par un changement de la page ou du stock, sans attendre
  // l'intervalle.
  async function checkDeckStatus(deckId, immediate = false) {
    if (document.querySelector(".msm-overlay")) return;
    if (statusCheckRunning) {
      if (immediate) statusCheckPending = true;
      return;
    }
    if (!immediate && Date.now() - lastStatusCheck < STATUS_CHECK_INTERVAL_MS) return;
    statusCheckRunning = true;
    lastStatusCheck = Date.now();
    try {
      const detection = scrapeDeckListWithCheck();
      if (!detection.reliable) {
        // Un bref passage non fiable (liste en cours d'affichage) garde
        // l'état précédent pour éviter un clignotement ; au-delà, on ne sait
        // plus ce que contient le deck et on retire la pastille plutôt que
        // d'afficher un constat faux.
        if (!unreliableSince) unreliableSince = Date.now();
        const tooLong = Date.now() - unreliableSince >= UNRELIABLE_GRACE_MS;
        if (tooLong && (btnOutdated || btnAvailability) && deckId === currentDeckId) {
          btnOutdated = false;
          btnAvailability = null;
          renderButton();
        }
        if (tooLong && deckId === currentDeckId) setEditionNames([]);
        return;
      }
      unreliableSince = 0;
      // Éditions des versions, sans attendre la réponse (jusqu'à plusieurs
      // secondes) : le constat est refait dès qu'elles arrivent.
      loadPrintings(deckId, detection.cards).then((added) => {
        if (added && deckId === currentDeckId) checkDeckStatus(deckId, true);
      });
      // Pas safeSendMessage : après un rechargement de l'extension, ce
      // contrôle en fond afficherait son toast toutes les 3 secondes.
      const context = await getDeckContext(detection.cards, deckId, (m) => chrome.runtime.sendMessage(m));
      if (!context || deckId !== currentDeckId) return;
      const stockMap = context.stock;
      const deck = context.builtDecks[deckId];
      if (deck) {
        const scraped = withPrintings(completeCardNames(detection.cards, Object.values(stockMap), deck.cards));
        setEditionNames(ownedEditionNames(scraped, deckId));
        const changes = computeDeckDiff(deck.cards, scraped);
        reportPageChanges(deckId, changes);
        const outdated = changes.length > 0;
        // Liste identique au montage : seul cas où les versions de la page
        // sont à coup sûr celles du montage.
        const missingVersions = outdated ? null : versionsToRecord(deck.cards, scraped);
        if (missingVersions) recordDeckVersions(deckId, missingVersions);
        const proxies = proxyTotal(deck.cards);
        if (outdated !== btnOutdated || btnAvailability || proxies !== btnProxies) {
          btnOutdated = outdated;
          btnAvailability = null;
          btnProxies = proxies;
          renderButton();
        }
      } else {
        const cards = withPrintings(completeCardNames(detection.cards, Object.values(stockMap)));
        setEditionNames(ownedEditionNames(cards, deckId));
        const availability = computeDeckAvailability(
          cards,
          stockMap,
          undefined,
          buildVersionUsage(context.builtDecks)
        );
        // Redessiner seulement si le constat change : sinon l'infobulle
        // ouverte au survol disparaîtrait toutes les 3 secondes.
        if (JSON.stringify(availability) !== JSON.stringify(btnAvailability)) {
          btnAvailability = availability;
          renderButton();
        }
      }
    } catch (e) {
      // Contexte d'extension invalidé : l'utilisateur sera prévenu à son
      // prochain clic. Service worker injoignable : le prochain contrôle
      // réessaie. Autre erreur : lecture de la page qui échoue (Moxfield a pu
      // changer), rapportée.
      if (!isServiceWorkerUnreachableError(e)) reportError("deck-page:check", e);
    } finally {
      statusCheckRunning = false;
      if (statusCheckPending) {
        statusCheckPending = false;
        if (currentDeckId) checkDeckStatus(currentDeckId, true);
      }
    }
  }

  // Recalcul dès que la liste du deck change sur la page (carte ajoutée,
  // version changée...) ou que le stock change (autre onglet, popup, synchro
  // Drive), sans attendre le prochain contrôle périodique. Les changements
  // de la page arrivent en rafale pendant un rendu React : on attend qu'elle
  // se stabilise un court instant.
  const PAGE_SETTLE_MS = 400;
  // Clé du stock et des decks montés dans chrome.storage.local (STORAGE_KEY
  // de background.js) ; les réglages de synchro, à côté, n'importent pas ici.
  const STATE_STORAGE_KEY = "moxfieldStockManagerState";

  function isOwnNode(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(el && el.closest(".msm-bar-btn, .msm-overlay, .msm-progress-overlay, .msm-toast"));
  }

  function isOwnMutation(m) {
    if (isOwnNode(m.target)) return true;
    // Ajout/retrait d'un de nos éléments directement dans la page (toast,
    // fenêtre, bouton flottant).
    const nodes = [...m.addedNodes, ...m.removedNodes];
    return m.type === "childList" && nodes.length > 0 && nodes.every(isOwnNode);
  }

  function watchDeckChanges() {
    const recheck = debounce(() => {
      if (currentDeckId) checkDeckStatus(currentDeckId, true);
    }, PAGE_SETTLE_MS);
    new MutationObserver((mutations) => {
      // Nos propres changements (pastille redessinée, toast...) ne
      // concernent pas la liste : les ignorer évite de relancer un contrôle
      // à chaque affichage de son résultat.
      if (currentDeckId && mutations.some((m) => !isOwnMutation(m))) recheck();
      // id : marqueurs de collection (collection_full_/pt_/no_), qui changent
      // avec la version ; src/alt : image d'une carte remplacée sur place.
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["id", "src", "alt"] });
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[STATE_STORAGE_KEY] && currentDeckId) checkDeckStatus(currentDeckId, true);
      });
    } catch (e) {
      // contexte d'extension invalidé : le contrôle périodique prend le relais
    }
  }

  // Icônes Font Awesome Free 6.7.2 (CC BY 4.0) — https://fontawesome.com/license/free
  // Classe svg-inline--fa : même taille/alignement que les icônes natives de la barre.
  const BAR_ICONS = {
    build: {
      viewBox: "0 0 640 512",
      path: "M58.9 42.1c3-6.1 9.6-9.6 16.3-8.7L320 64 564.8 33.4c6.7-.8 13.3 2.7 16.3 8.7l41.7 83.4c9 17.9-.6 39.6-19.8 45.1L439.6 217.3c-13.9 4-28.8-1.9-36.2-14.3L320 64 236.6 203c-7.4 12.4-22.3 18.3-36.2 14.3L37.1 170.6c-19.3-5.5-28.8-27.2-19.8-45.1L58.9 42.1zM321.1 128l54.9 91.4c14.9 24.8 44.6 36.6 72.5 28.6L576 211.6l0 167c0 22-15 41.2-36.4 46.6l-204.1 51c-10.2 2.6-20.9 2.6-31 0l-204.1-51C79 419.7 64 400.5 64 378.5l0-167L191.6 248c27.8 8 57.6-3.8 72.5-28.6L318.9 128l2.2 0z",
    },
    // arrows-rotate
    editions: {
      viewBox: "0 0 512 512",
      path: "M105.1 202.6c7.7-21.8 20.2-42.3 37.8-59.8c62.5-62.5 163.8-62.5 226.3 0L386.3 160 352 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l111.5 0c0 0 0 0 0 0l.4 0c17.7 0 32-14.3 32-32l0-112c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 35.2L414.4 97.6c-87.5-87.5-229.3-87.5-316.8 0C73.2 122 55.6 150.7 44.8 181.4c-5.9 16.7 2.9 34.9 19.5 40.8s34.9-2.9 40.8-19.5zM39 289.3c-5 1.5-9.8 4.2-13.7 8.2c-4 4-6.7 8.8-8.1 14c-.3 1.2-.6 2.5-.8 3.8c-.3 1.7-.4 3.4-.4 5.1L16 432c0 17.7 14.3 32 32 32s32-14.3 32-32l0-35.1 17.6 17.5c0 0 0 0 0 0c87.5 87.4 229.3 87.4 316.7 0c24.4-24.4 42.1-53.1 52.9-83.8c5.9-16.7-2.9-34.9-19.5-40.8s-34.9 2.9-40.8 19.5c-7.7 21.8-20.2 42.3-37.8 59.8c-62.5 62.5-163.8 62.5-226.3 0l-.1-.1L125.6 352l34.4 0c17.7 0 32-14.3 32-32s-14.3-32-32-32L48.4 288c-1.6 0-3.2 .1-4.8 .3s-3.1 .5-4.6 1z",
    },
    built: {
      viewBox: "0 0 512 512",
      path: "M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM369 209L241 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L335 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z",
    },
  };

  // Bouton « Utiliser mes éditions » (ruban seulement, cf. ensureButton) et
  // cartes qu'il changerait (cf. ownedEditionNames).
  let editionsBtn = null;
  let btnEditionNames = [];

  function setEditionNames(names) {
    if (JSON.stringify(names) === JSON.stringify(btnEditionNames)) return;
    btnEditionNames = names;
    renderEditionsButton();
  }

  function renderEditionsButton() {
    if (!editionsBtn) return;
    const count = btnEditionNames.length;
    editionsBtn.style.display = count === 0 ? "none" : "";
    editionsBtn.replaceChildren(createBarIcon("editions"));
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "msm-avail-badge msm-editions-badge";
      badge.textContent = String(count);
      badge.setAttribute("aria-hidden", "true");
      editionsBtn.appendChild(badge);
    }
    const label = ownedEditionsRunning
      ? t("ownedEditionsLoading")
      : `${t("ownedEditionsButton")} — ${tn("ownedEditionsCount", count)}`;
    editionsBtn.title = `${label}\n${t("ownedEditionsHint")}`;
    editionsBtn.setAttribute("aria-label", label);
    editionsBtn.classList.toggle("msm-busy", ownedEditionsRunning);
  }

  function createBarIcon(kind) {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const { viewBox, path } = BAR_ICONS[kind];
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "svg-inline--fa no-pointer-events");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("d", path);
    svg.appendChild(p);
    return svg;
  }

  function renderButton() {
    if (!btn) return;
    const outdated = btnBuilt && btnOutdated;
    const availability = btnBuilt ? null : btnAvailability;
    const proxies = btnBuilt ? btnProxies : 0;
    const label =
      !btnBuilt ? t("buttonBuild") : outdated ? t("buttonBuiltOutdated") : proxies > 0 ? tn("buttonBuiltWithProxies", proxies) : t("buttonBuilt");
    btn.replaceChildren(createBarIcon(btnBuilt ? "built" : "build"));
    if (proxies > 0) {
      // Deck monté avec des proxies : leur nombre, à côté de l'icône.
      const badge = document.createElement("span");
      badge.className = "msm-avail-badge msm-proxy-badge";
      badge.textContent = String(proxies);
      badge.setAttribute("aria-hidden", "true");
      btn.appendChild(badge);
    }
    if (availability) {
      // Pastille : ✓ si montable, sinon nombre d'exemplaires bloquants.
      const badge = document.createElement("span");
      badge.className = "msm-avail-badge" + (availability.blocking === 0 ? " msm-avail-ok" : "");
      badge.textContent = availability.blocking === 0 ? "✓" : String(availability.blocking);
      badge.setAttribute("aria-hidden", "true");
      btn.appendChild(badge);
    }
    const fullLabel = availability ? `${label} — ${availabilityLabel(availability)}` : label;
    btn.title = fullLabel;
    btn.setAttribute("aria-label", fullLabel);
    btn.classList.toggle("msm-btn-built", btnBuilt);
    btn.classList.toggle("msm-btn-outdated", outdated);
  }

  // Aussi sans bouton (barre d'actions pas encore affichée) : l'état est
  // prêt quand elle apparaît.
  async function refreshButtonState(deckId) {
    const deck = await getBuiltDeck(deckId);
    btnBuilt = Boolean(deck);
    btnProxies = deck ? proxyTotal(deck.cards) : 0;
    if (!btnBuilt) btnOutdated = false;
    btnAvailability = null;
    lastStatusCheck = 0; // réévaluer tout de suite au prochain tick
    lastReportedChanges = null;
    renderButton();
    return btnBuilt;
  }

  async function tryFillFromClipboard(textarea) {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip && parseCardsText(clip).length > 0) {
        textarea.value = clip.trim();
        return true;
      }
    } catch (e) {
      // lecture refusée (permission/focus) — l'utilisateur collera à la main (Ctrl+V)
    }
    return false;
  }

  // Le bouton flottant reste cliquable par-dessus la modale (z-index plus
  // élevé, pour que les toasts restent visibles au-dessus de l'overlay) : on
  // refuse donc d'ouvrir une deuxième modale si une est déjà affichée — ou
  // en cours d'ouverture, car la lecture de l'état du deck (getIsBuilt) est
  // asynchrone et un double-clic rapide passerait sinon le test du DOM.
  let overlayOpening = false;

  async function openOverlay() {
    if (overlayOpening || document.querySelector(".msm-overlay")) return;
    const deckId = getDeckId();
    if (!deckId) return;
    overlayOpening = true;
    let isBuilt;
    let overlay;
    try {
      isBuilt = await getIsBuilt(deckId);
      overlay = buildOverlay({ isBuilt });
    } finally {
      overlayOpening = false;
    }

    let updatedCards = null;
    if (isBuilt) {
      updatedCards = await prepareDeckUpdate(overlay, deckId);
    } else {
      const textarea = overlay.querySelector("#msm-cards-textarea");
      const warningEl = overlay.querySelector("#msm-shortage-warning");
      const printingWarningEl = overlay.querySelector("#msm-printing-warning");
      const versionWarningEl = overlay.querySelector("#msm-version-warning");
      const basicLandWarningEl = overlay.querySelector("#msm-basic-land-warning");
      const cardCountEl = overlay.querySelector("#msm-card-count");
      const blockingSummaryEl = overlay.querySelector("#msm-blocking-summary");
      const siteDeclaredTotal = getSiteDeclaredTotal();
      const confirmBtn = overlay.querySelector("#msm-confirm");

      const updateWarnings = async () => {
        const cards = withVersions(parseCardsText(textarea.value));
        renderCardCount(cardCountEl, cards, siteDeclaredTotal);
        if (cards.length === 0) {
          blockingSummaryEl.hidden = true;
          setProxyAction(confirmBtn, 0, "confirmBuild", "confirmBuildWithProxies");
          renderShortageWarning(warningEl, []);
          renderPrintingWarning(printingWarningEl, []);
          renderVersionWarning(versionWarningEl, []);
          renderBasicLandNotice(basicLandWarningEl, [], []);
          return;
        }
        // Terrains de base traités à part (jamais bloquants) — cf. isBasicLand.
        const basicCards = cards.filter((c) => isBasicLand(c.name));
        const nonBasicCards = cards.filter((c) => !isBasicLand(c.name));
        // Une seule lecture de l'état, réutilisée pour toutes les zones.
        const { stockMap, deckUsage, versionUsage } = await getStockAndDeckUsage(cards);
        // Même total que la pastille du bouton (cf. computeDeckAvailability).
        const summary = blockingSummary(computeDeckAvailability(cards, stockMap, lastWrongEditionNames, versionUsage));
        blockingSummaryEl.hidden = !summary;
        blockingSummaryEl.textContent = summary ? `🚫 ${summary}.` : "";
        // Impressions détectées sur la page, pas les versions de la liste :
        // une quantité modifiée à la main garde le prix de la carte.
        const shortages = computeShortages(nonBasicCards, stockMap);
        const wrongEdition = computeWrongEditionCards(nonBasicCards, stockMap, lastWrongEditionNames);
        const versionTaken = computeVersionConflicts(nonBasicCards, stockMap, versionUsage, lastWrongEditionNames);
        setProxyAction(confirmBtn, proxiesNeeded(shortages, wrongEdition.length > 0 || versionTaken.length > 0), "confirmBuild", "confirmBuildWithProxies");
        renderShortageWarning(warningEl, shortages, deckUsage, lastPrintingCodes);
        renderPrintingWarning(printingWarningEl, wrongEdition);
        renderVersionWarning(versionWarningEl, versionTaken);
        renderBasicLandNotice(
          basicLandWarningEl,
          computeWrongEditionCards(basicCards, stockMap, lastWrongEditionNames),
          computeShortages(basicCards, stockMap)
        );
      };

      // Scraping DOM de la page (méthode adaptée à la vue active).
      const scrapedCards = scrapeCardsGuess();
      const [scrapedStock] = await Promise.all([getStockMap(scrapedCards), loadPrintings(deckId, scrapedCards)]);
      const guessed = withPrintings(completeCardNames(scrapedCards, Object.values(scrapedStock)));
      if (guessed.length > 0) {
        textarea.value = cardsToText(guessed);
        lastWrongEditionNames = buildWrongEditionSet(guessed);
        rememberVersions(guessed);
      } else {
        // Repli : presse-papiers (pas d'info de version disponible dans du texte brut).
        lastWrongEditionNames = new Set();
        rememberVersions([]);
        await tryFillFromClipboard(textarea);
      }
      await updateWarnings();

      textarea.addEventListener("input", debounce(updateWarnings, 400));

      overlay.querySelector("#msm-paste-clipboard").addEventListener("click", async () => {
        const ok = await tryFillFromClipboard(textarea);
        if (!ok) toast(t("clipboardEmpty"), true);
        // Un collage manuel remplace la liste détectée : on perd l'info de version.
        lastWrongEditionNames = new Set();
        rememberVersions([]);
        await updateWarnings();
      });
    }

    overlay.querySelector("#msm-cancel").addEventListener("click", () => overlay.remove());

    // Mise à jour du montage. withProxies : les cartes en stock insuffisant
    // sont complétées par des proxies au lieu de bloquer ; version
    // différente ou déjà utilisée bloquent toujours (un proxy ne règle pas
    // une question d'édition).
    async function submitUpdate(withProxies) {
      try {
        // Revérifié au clic : le stock a pu changer entre-temps (synchro
        // Drive, autre onglet).
        const { stockMap, versionUsage, builtDecks } = await getStockAndDeckUsage(updatedCards, deckId);
        const deck = builtDecks[deckId];
        if (!deck) throw new Error(t("deckNoLongerBuilt"));
        const changes = computeDeckDiff(deck.cards, updatedCards);
        const check = evaluateDeckUpdate(changes, deck, stockMap, lastWrongEditionNames, updatedCards, versionUsage);
        const blocked = withProxies ? check.wrongEdition.length > 0 || check.versionTaken.length > 0 : check.blocked;
        if (blocked) {
          toast(t("updateBlocked"), true);
          return;
        }
        const cards = withProxies ? addProxies(updatedCards, check.shortages, proxyPrintingFinder(lastPrintingCodes)) : updatedCards;
        const payload = { deckId, deckName: getDeckName(), url: window.location.href, cards };
        const res = await safeSendMessage({ type: "UPDATE_BUILT_DECK", payload });
        if (res.error === "extension-context-invalidated") return; // toast déjà affiché par safeSendMessage
        if (!res.ok) throw refusal(res);
        overlay.remove();
        btnOutdated = false;
        await refreshButtonState(deckId);
        const added = proxyTotal(cards) - proxyTotal(updatedCards);
        toast(added > 0 ? tn("updateDoneWithProxies", added) : t("updateDone"));
      } catch (e) {
        if (!e.expected) reportError("deck-page:update", e);
        toast(t("errorPrefix", e.message), true);
      }
    }

    // Montage. withProxies : comme pour la mise à jour.
    async function submitBuild(withProxies) {
      try {
        const textarea = overlay.querySelector("#msm-cards-textarea");
        const cards = withVersions(parseCardsText(textarea.value));
        if (cards.length === 0) {
          toast(t("noCardsRecognized"), true);
          return;
        }
        // Trois vérifications bloquantes avant de pouvoir valider : version
        // différente de ta collection Moxfield (zone 1), stock insuffisant
        // (zone 2, sauf montage avec des proxies), puis version déjà prise
        // par un autre deck monté — sauf pour les terrains de base, jamais
        // bloquants (cf. isBasicLand). Recalculées ici au cas où le texte a
        // été modifié depuis le dernier passage de updateWarnings.
        const { stockMap, versionUsage } = await getStockAndDeckUsage(cards);
        const nonBasicCards = cards.filter((c) => !isBasicLand(c.name));
        const wrongEdition = computeWrongEditionCards(nonBasicCards, stockMap, lastWrongEditionNames);
        if (wrongEdition.length > 0) {
          toast(t("buildBlockedWrongEdition", wrongEdition.join(", ")), true);
          return;
        }
        const shortages = computeShortages(nonBasicCards, stockMap);
        if (shortages.length > 0 && !withProxies) {
          const details = shortages.map((s) => t("shortageShort", s.name, s.missing)).join(", ");
          toast(t("buildBlockedShortage", details), true);
          return;
        }
        const versionTaken = computeVersionConflicts(nonBasicCards, stockMap, versionUsage, lastWrongEditionNames);
        if (versionTaken.length > 0) {
          toast(t("buildBlockedVersionTaken", versionTaken.map((c) => c.name).join(", ")), true);
          return;
        }
        const built = withProxies ? addProxies(cards, shortages, proxyPrintingFinder(lastPrintingCodes)) : cards;
        await sendToggle({ deckId, deckName: getDeckName(), url: window.location.href, cards: built, built: true });
      } catch (e) {
        if (!e.expected) reportError("deck-page:toggle", e);
        toast(t("errorPrefix", e.message), true);
      }
    }

    async function sendToggle(payload) {
      const res = await safeSendMessage({ type: "TOGGLE_DECK_BUILT", payload });
      if (res.error === "extension-context-invalidated") return; // toast déjà affiché par safeSendMessage
      if (!res.ok) throw refusal(res);
      overlay.remove();
      await refreshButtonState(deckId);
      const proxies = proxyTotal(payload.cards);
      toast(!payload.built ? t("unbuildDone") : proxies > 0 ? tn("buildDoneWithProxies", proxies) : t("buildDone"));
    }

    // Avec ou sans proxies selon le libellé affiché (cf. setProxyAction).
    const withProxies = (button) => button.dataset.proxies === "1";
    if (updatedCards) {
      const updateBtn = overlay.querySelector("#msm-update");
      updateBtn.addEventListener("click", () => submitUpdate(withProxies(updateBtn)));
    }

    overlay.querySelector("#msm-confirm").addEventListener("click", async (e) => {
      if (!isBuilt) return submitBuild(withProxies(e.currentTarget));
      try {
        await sendToggle({ deckId, deckName: getDeckName(), url: window.location.href, cards: [], built: false });
      } catch (e) {
        if (!e.expected) reportError("deck-page:toggle", e);
        toast(t("errorPrefix", e.message), true);
      }
    });
  }

  // Barre d'actions flottante de Moxfield sur la page d'un deck (remonter en
  // haut, commentaires, like, et sur les decks des autres : avatar, menu
  // "..."). Son conteneur n'a qu'une classe générée (type
  // "rueHSSzYMIFGgjgPnfBE", instable) : on la repère plutôt par ses icônes
  // FontAwesome, dont l'attribut data-icon est stable — c'est le parent
  // commun du bouton "arrow-up-to-line" et du bouton "comment". Confirmé via
  // inspection HTML réelle, sur ses propres decks comme sur ceux des autres.
  function findActionBar() {
    for (const icon of document.querySelectorAll('svg[data-icon="arrow-up-to-line"]')) {
      const link = icon.closest("a");
      const bar = link && link.parentElement;
      if (bar && bar.querySelector(':scope > a svg[data-icon="comment"]')) return bar;
    }
    return null;
  }

  // Le bouton vit dans la barre d'actions de Moxfield, et nulle part
  // ailleurs : sans elle (menu du deck masqué), pas de bouton — l'ancien
  // bouton flottant de repli gênait (retour utilisateur, novembre 2026).
  // Rappelée à chaque tick du polling : si React a re-rendu la barre et
  // effacé notre bouton, ou si la barre est apparue/disparue, on le recrée
  // au bon endroit ou on le retire.
  // Position dans la barre : juste après le bouton "like" (cœur). Sur ses
  // propres decks c'est le dernier bouton ; sur ceux des autres, ça place le
  // nôtre avant l'avatar et le menu "..." (4e position). Sans cœur trouvé,
  // on ajoute simplement à la fin.
  // Haut (en px depuis le haut de la fenêtre) du bandeau fixe qui contient la
  // barre d'actions : on remonte jusqu'à l'ancêtre en position fixed/sticky,
  // qui porte le fond coloré. null si la barre est absente.
  function getActionBarTop() {
    const bar = findActionBar();
    if (!bar) return null;
    let container = bar;
    for (let el = bar; el && el !== document.body; el = el.parentElement) {
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") { container = el; break; }
    }
    const top = container.getBoundingClientRect().top;
    return top > 0 && top < window.innerHeight ? top : null;
  }

  function findBarAnchor(bar) {
    const heart = bar.querySelector(':scope > a svg[data-icon="heart"]');
    return heart ? heart.closest("a") : null;
  }

  // « Utiliser mes éditions » juste à gauche de notre bouton.
  function isButtonWellPlaced(bar) {
    if (btn.parentElement !== bar || !editionsBtn || btn.previousElementSibling !== editionsBtn) return false;
    const anchor = findBarAnchor(bar);
    return anchor ? editionsBtn.previousElementSibling === anchor : true;
  }

  function ensureButton() {
    const bar = findActionBar();
    if (!bar) {
      removeButton();
      return null;
    }
    if (btn && btn.isConnected && isButtonWellPlaced(bar)) return btn;

    removeButton();
    // Mêmes classes utilitaires que les boutons natifs de la barre, pour en
    // reprendre l'apparence.
    btn = document.createElement("a");
    btn.className = "py-1 text-white no-underline cursor-pointer no-outline msm-bar-btn";
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openOverlay();
      }
    });
    const anchor = findBarAnchor(bar);
    if (anchor) anchor.after(btn);
    else bar.appendChild(btn);
    editionsBtn = document.createElement("a");
    editionsBtn.className = "py-1 text-white no-underline cursor-pointer no-outline msm-bar-btn msm-editions-bar-btn";
    editionsBtn.setAttribute("role", "button");
    editionsBtn.setAttribute("tabindex", "0");
    const useEditions = () => useOwnedEditions(currentDeckId, btnEditionNames);
    editionsBtn.addEventListener("click", useEditions);
    editionsBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        useEditions();
      }
    });
    btn.before(editionsBtn);
    renderEditionsButton();
    btn.addEventListener("click", () => openOverlay());
    renderButton();
    return btn;
  }

  function removeButton() {
    if (btn) {
      btn.remove();
      btn = null;
    }
    if (editionsBtn) {
      editionsBtn.remove();
      editionsBtn = null;
    }
  }

  async function syncButtonToLocation() {
    // Rappelée à chaque tick du polling (voir plus bas) : la liste du deck
    // est affichée par React après le changement d'URL, et contrôlée tant
    // qu'on reste sur la page (cf. checkDeckStatus).
    if (isDeckPage()) {
      const deckId = getDeckId();
      ensureButton();
      if (deckId !== currentDeckId) {
        currentDeckId = deckId;
        btnEditionNames = [];
        renderEditionsButton();
        btnOutdated = false;
        unreliableSince = 0;
        await refreshButtonState(deckId);
      }
      announceOwnedEditions(deckId);
      checkDeckStatus(deckId);
    } else {
      currentDeckId = null;
      btnBuilt = false;
      btnOutdated = false;
      btnAvailability = null;
      removeButton();
    }
  }

  // Polling léger (voir en-tête du fichier) : sert à la fois à détecter les
  // changements d'URL de la SPA et à recontrôler la page tant qu'on y
  // reste (cf. commentaire de syncButtonToLocation).
  setInterval(syncButtonToLocation, 500);

  syncButtonToLocation();
  watchDeckChanges();
})();
