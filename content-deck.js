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

  // Le bouton ne doit s'afficher que sur un deck de format "Commander" — ce
  // badge (texte "Commander") est un des badges d'en-tête du deck, classe
  // "badge-header" (nom semble sémantique et volontaire, contrairement aux
  // classes générées type "H3UM7DGQXHnJUSoQ5Jgv" — confirmé via inspection
  // HTML réelle). D'autres badges partagent cette classe (Bracket, hubs de
  // tags comme "Burn"/"Combo"/"Tokens") : on ne retient que celui dont le
  // texte correspond exactement à "Commander".
  function hasCommanderBadge() {
    const badges = document.querySelectorAll(".badge-header");
    for (const el of badges) {
      if ((el.textContent || "").trim().toLowerCase() === "commander") return true;
    }
    return false;
  }

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
  const { normalizeName, scrapeCardsGuess, getSiteDeclaredTotal, completeCardNames, computeDeckDiff } =
    createDeckScraper(window);

  // Contrôles de la liste par rapport au stock : voir deck-checks.js.
  const {
    isBasicLand,
    buildWrongEditionSet,
    computeWrongEditionCards,
    computeShortages,
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
      `<strong>🚫 ${escapeHtml(tn("printingWarningTitle", names.length))}</strong> — ${escapeHtml(t("printingWarningHint"))}<ul>` +
      names.map((n) => `<li>${escapeHtml(n)}</li>`).join("") +
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
    if (!context) return { stockMap: {}, deckUsage: new Map(), builtDecks: {} };
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
    return { stockMap: context.stock, deckUsage, builtDecks: context.builtDecks };
  }

  function renderShortageWarning(el, shortages, deckUsage = new Map()) {
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
    el.innerHTML =
      `<strong>⚠️ ${escapeHtml(tn("shortageTitle", shortages.length))}</strong>` +
      `<button type="button" class="msm-secondary msm-export-btn">🛒 ${escapeHtml(t("cardmarketCopyButton"))}</button><ul>` +
      shortages
        .map(
          (s) =>
            `<li>${escapeHtml(t("shortageItem", s.name, s.have, s.need, s.missing))}${whereText(s)}</li>`
        )
        .join("") +
      "</ul>";
    el.querySelector(".msm-export-btn").addEventListener("click", () => exportShortagesToCardmarket(shortages));
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

  // Modale d'un deck monté : compare la liste de la page à celle du montage
  // et, si elle a changé, affiche la différence et active « Mettre à jour le
  // montage ». Renvoie la nouvelle liste à enregistrer, ou null.
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
    const { stockMap, deckUsage, builtDecks } = await getStockAndDeckUsage(detection.cards, deckId);
    const deck = builtDecks[deckId];
    if (!deck) {
      changesEl.innerHTML = "";
      return null;
    }
    const pageCards = completeCardNames(detection.cards, Object.values(stockMap), deck.cards);
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
    const check = evaluateDeckUpdate(changes, deck, stockMap, lastWrongEditionNames);
    changesEl.innerHTML =
      '<div class="msm-changes">' +
      `<strong>${escapeHtml(t("deckChangedTitle", since))}</strong>` +
      renderDeckDiff(changes) +
      `<p>${escapeHtml(t("deckUpdateHint", t("updateBuild")))}</p></div>`;
    renderShortageWarning(overlay.querySelector("#msm-shortage-warning"), check.shortages, deckUsage);
    renderPrintingWarning(overlay.querySelector("#msm-printing-warning"), check.wrongEdition);
    renderBasicLandNotice(overlay.querySelector("#msm-basic-land-warning"), check.basicWrongEdition, check.basicShortages);

    const updateBtn = overlay.querySelector("#msm-update");
    updateBtn.hidden = false;
    updateBtn.disabled = check.blocked;
    if (check.blocked) updateBtn.title = t("deckUpdateBlocked");
    overlay.querySelector("#msm-confirm").classList.remove("msm-primary");
    return scraped.map(({ name, qty }) => ({ name, qty }));
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
               <div id="msm-deck-changes"></div>
               <div id="msm-printing-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-shortage-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-basic-land-warning" class="msm-info-warning" style="display:none"></div>`
            : `<p>${escapeHtml(t("overlayIntro", t("pasteFromClipboard")))}</p>
               <button id="msm-paste-clipboard" class="msm-secondary">📋 ${escapeHtml(t("pasteFromClipboard"))}</button>
               <div id="msm-card-count" class="msm-card-count"></div>
               <div id="msm-blocking-summary" class="msm-card-count msm-card-count-mismatch" hidden></div>
               <textarea id="msm-cards-textarea" rows="12" placeholder="1 Sol Ring&#10;1 Sidisi, Brood Tyrant&#10;..."></textarea>
               <div id="msm-printing-warning" class="msm-shortage-warning" style="display:none"></div>
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

  async function getIsBuilt(deckId) {
    const context = await getDeckContext([], deckId);
    return Boolean(context && context.builtDecks[deckId]);
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
        return;
      }
      unreliableSince = 0;
      // Pas safeSendMessage : après un rechargement de l'extension, ce
      // contrôle en fond afficherait son toast toutes les 3 secondes.
      const context = await getDeckContext(detection.cards, deckId, (m) => chrome.runtime.sendMessage(m));
      if (!context || deckId !== currentDeckId) return;
      const stockMap = context.stock;
      const deck = context.builtDecks[deckId];
      if (deck) {
        const scraped = completeCardNames(detection.cards, Object.values(stockMap), deck.cards);
        const changes = computeDeckDiff(deck.cards, scraped);
        reportPageChanges(deckId, changes);
        const outdated = changes.length > 0;
        if (outdated !== btnOutdated || btnAvailability) {
          btnOutdated = outdated;
          btnAvailability = null;
          renderButton();
        }
      } else {
        const availability = computeDeckAvailability(
          completeCardNames(detection.cards, Object.values(stockMap)),
          stockMap
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
      // prochain clic. Autre erreur : lecture de la page qui échoue (Moxfield
      // a pu changer), rapportée.
      reportError("deck-page:check", e);
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
    return Boolean(el && el.closest(".msm-bar-btn, .msm-floating-btn, .msm-overlay, .msm-toast"));
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
    built: {
      viewBox: "0 0 512 512",
      path: "M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM369 209L241 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L335 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z",
    },
  };

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
    const label = t(!btnBuilt ? "buttonBuild" : outdated ? "buttonBuiltOutdated" : "buttonBuilt");
    if (btn.dataset.mode === "bar") {
      btn.replaceChildren(createBarIcon(btnBuilt ? "built" : "build"));
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
    } else {
      const counts = availability ? ` · ${t("buttonAvailableShort", availability.available, availability.total)}` : "";
      btn.textContent = (outdated ? "⚠️ " : btnBuilt ? "✅ " : "🧰 ") + label + counts;
      btn.title = availability ? availabilityLabel(availability) : "";
    }
    btn.classList.toggle("msm-btn-built", btnBuilt);
    btn.classList.toggle("msm-btn-outdated", outdated);  }

  async function refreshButtonState(deckId) {
    if (!btn) return;
    btnBuilt = await getIsBuilt(deckId);
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
      const basicLandWarningEl = overlay.querySelector("#msm-basic-land-warning");
      const cardCountEl = overlay.querySelector("#msm-card-count");
      const blockingSummaryEl = overlay.querySelector("#msm-blocking-summary");
      const siteDeclaredTotal = getSiteDeclaredTotal();

      const updateWarnings = async () => {
        const cards = parseCardsText(textarea.value);
        renderCardCount(cardCountEl, cards, siteDeclaredTotal);
        if (cards.length === 0) {
          blockingSummaryEl.hidden = true;
          renderShortageWarning(warningEl, []);
          renderPrintingWarning(printingWarningEl, []);
          renderBasicLandNotice(basicLandWarningEl, [], []);
          return;
        }
        // Terrains de base traités à part (jamais bloquants) — cf. isBasicLand.
        const basicCards = cards.filter((c) => isBasicLand(c.name));
        const nonBasicCards = cards.filter((c) => !isBasicLand(c.name));
        // Une seule lecture de l'état, réutilisée pour toutes les zones.
        const { stockMap, deckUsage } = await getStockAndDeckUsage(cards);
        // Même total que la pastille du bouton (cf. computeDeckAvailability).
        const summary = blockingSummary(computeDeckAvailability(cards, stockMap, lastWrongEditionNames));
        blockingSummaryEl.hidden = !summary;
        blockingSummaryEl.textContent = summary ? `🚫 ${summary}.` : "";
        renderShortageWarning(warningEl, computeShortages(nonBasicCards, stockMap), deckUsage);
        renderPrintingWarning(printingWarningEl, computeWrongEditionCards(nonBasicCards, stockMap, lastWrongEditionNames));
        renderBasicLandNotice(
          basicLandWarningEl,
          computeWrongEditionCards(basicCards, stockMap, lastWrongEditionNames),
          computeShortages(basicCards, stockMap)
        );
      };

      // Scraping DOM de la page (méthode adaptée à la vue active).
      const scrapedCards = scrapeCardsGuess();
      const guessed = completeCardNames(scrapedCards, Object.values(await getStockMap(scrapedCards)));
      if (guessed.length > 0) {
        textarea.value = cardsToText(guessed);
        lastWrongEditionNames = buildWrongEditionSet(guessed);
      } else {
        // Repli : presse-papiers (pas d'info de version disponible dans du texte brut).
        lastWrongEditionNames = new Set();
        await tryFillFromClipboard(textarea);
      }
      await updateWarnings();

      textarea.addEventListener("input", debounce(updateWarnings, 400));

      overlay.querySelector("#msm-paste-clipboard").addEventListener("click", async () => {
        const ok = await tryFillFromClipboard(textarea);
        if (!ok) toast(t("clipboardEmpty"), true);
        // Un collage manuel remplace la liste détectée : on perd l'info de version.
        lastWrongEditionNames = new Set();
        await updateWarnings();
      });
    }

    overlay.querySelector("#msm-cancel").addEventListener("click", () => overlay.remove());

    if (updatedCards) {
      overlay.querySelector("#msm-update").addEventListener("click", async () => {
        try {
          // Revérifié au clic : le stock a pu changer entre-temps (synchro
          // Drive, autre onglet).
          const { stockMap, builtDecks } = await getStockAndDeckUsage(updatedCards, deckId);
          const deck = builtDecks[deckId];
          if (!deck) throw new Error(t("deckNoLongerBuilt"));
          if (evaluateDeckUpdate(computeDeckDiff(deck.cards, updatedCards), deck, stockMap, lastWrongEditionNames).blocked) {
            toast(t("updateBlocked"), true);
            return;
          }
          const payload = { deckId, deckName: getDeckName(), url: window.location.href, cards: updatedCards };
          const res = await safeSendMessage({ type: "UPDATE_BUILT_DECK", payload });
          if (res.error === "extension-context-invalidated") return; // toast déjà affiché par safeSendMessage
          if (!res.ok) throw refusal(res);
          overlay.remove();
          btnOutdated = false;
          await refreshButtonState(deckId);
          toast(t("updateDone"));
        } catch (e) {
          if (!e.expected) reportError("deck-page:update", e);
          toast(t("errorPrefix", e.message), true);
        }
      });
    }

    overlay.querySelector("#msm-confirm").addEventListener("click", async () => {
      try {
        let payload;
        if (isBuilt) {
          payload = { deckId, deckName: getDeckName(), url: window.location.href, cards: [], built: false };
        } else {
          const textarea = overlay.querySelector("#msm-cards-textarea");
          let cards = parseCardsText(textarea.value);
          if (cards.length === 0) {
            toast(t("noCardsRecognized"), true);
            return;
          }
          // Deux vérifications bloquantes avant de pouvoir valider : version
          // différente de ta collection Moxfield (zone 1), puis stock
          // insuffisant (zone 2) — sauf pour les terrains de base, jamais
          // bloquants (cf. isBasicLand). Recalculées ici au cas où le texte
          // a été modifié depuis le dernier passage de updateWarnings.
          const stockMap = await getStockMap(cards);
          const nonBasicCards = cards.filter((c) => !isBasicLand(c.name));
          const wrongEdition = computeWrongEditionCards(nonBasicCards, stockMap, lastWrongEditionNames);
          if (wrongEdition.length > 0) {
            toast(t("buildBlockedWrongEdition", wrongEdition.join(", ")), true);
            return;
          }
          const shortages = computeShortages(nonBasicCards, stockMap);
          if (shortages.length > 0) {
            const details = shortages.map((s) => t("shortageShort", s.name, s.missing)).join(", ");
            toast(t("buildBlockedShortage", details), true);
            return;
          }
          payload = { deckId, deckName: getDeckName(), url: window.location.href, cards, built: true };
        }
        const res = await safeSendMessage({ type: "TOGGLE_DECK_BUILT", payload });
        if (res.error === "extension-context-invalidated") return; // toast déjà affiché par safeSendMessage
        if (!res.ok) throw refusal(res);
        overlay.remove();
        await refreshButtonState(deckId);
        toast(t(isBuilt ? "unbuildDone" : "buildDone"));
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

  // Le bouton vit dans la barre Moxfield quand elle existe, sinon en bouton
  // flottant (repli). Rappelée à chaque tick du polling : si React a re-rendu
  // la barre et effacé notre bouton, ou si la barre est apparue/disparue, on
  // le recrée au bon endroit.
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

  function isButtonWellPlaced(bar) {
    if (btn.parentElement !== bar) return false;
    const anchor = findBarAnchor(bar);
    return anchor ? btn.previousElementSibling === anchor : true;
  }

  function ensureButton() {
    const bar = findActionBar();
    const mode = bar ? "bar" : "floating";
    const upToDate =
      btn && btn.isConnected && btn.dataset.mode === mode && (mode === "floating" || isButtonWellPlaced(bar));
    if (upToDate) return btn;

    removeButton();
    if (bar) {
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
    } else {
      btn = document.createElement("button");
      btn.className = "msm-floating-btn";
      document.body.appendChild(btn);
    }
    btn.dataset.mode = mode;
    btn.addEventListener("click", () => openOverlay());
    renderButton();
    return btn;
  }

  function removeButton() {
    if (btn) {
      btn.remove();
      btn = null;
    }
  }

  async function syncButtonToLocation() {
    // Le badge "Commander" est injecté par React après le chargement
    // initial de la page : au moment précis où l'URL change, il peut ne pas
    // encore être présent. On ne se fie donc pas qu'au changement d'URL —
    // cette fonction est rappelée à chaque tick du polling (voir plus bas)
    // pour réévaluer sa présence tant qu'on reste sur la même page.
    if (isDeckPage() && hasCommanderBadge()) {
      const deckId = getDeckId();
      ensureButton();
      if (deckId !== currentDeckId) {
        currentDeckId = deckId;
        btnOutdated = false;
        unreliableSince = 0;
        await refreshButtonState(deckId);
      }
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
  // changements d'URL de la SPA et à réévaluer le badge "Commander" tant
  // qu'on reste sur la même page (cf. commentaire de syncButtonToLocation).
  setInterval(syncButtonToLocation, 500);

  syncButtonToLocation();
  watchDeckChanges();
})();
