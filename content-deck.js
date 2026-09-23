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

  // Filtre de visibilité : Moxfield semble garder en mémoire le DOM d'une
  // vue précédente (Text/Visual/...) en le cachant plutôt que de le détruire
  // quand on change de mode d'affichage. `offsetParent` seul ne suffit pas
  // (un élément en `visibility: hidden` le garde) — on vérifie aussi la
  // taille réelle et les propriétés CSS de visibilité.
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  // --- Statut de collection ---
  // Moxfield calcule déjà, pour chaque carte du deck, sa présence dans ta
  // collection Moxfield. Confirmé via inspection DOM réelle (aria-label) :
  // - "collection_full_" (aria-label "Found in collection") : tu as la carte
  //   dans la même version que celle du deck.
  // - "collection_pt_" (aria-label "Partially in collection") : tu as la
  //   carte, mais pas dans cette version précise (ex. Sol Ring possédé sous
  //   une autre édition) — c'est la vraie carte "version différente".
  // - "collection_no_" (aria-label "Card missing from Collection") : absente
  //   de ta collection, TOUTES éditions confondues.
  function findCollectionStatusNear(anchorEl, searchScopeEl) {
    const marker = searchScopeEl.querySelector('[id^="collection_full_"], [id^="collection_pt_"], [id^="collection_no_"]');
    if (!marker) return "unknown";
    if (marker.id.startsWith("collection_no_")) return "missing";
    if (marker.id.startsWith("collection_pt_")) return "partial";
    return "full";
  }

  // --- Scraping DOM, vue "Text" / "Condensed Text" ---
  // Chaque carte est un <li data-hash="..."> avec un <a href="/cards/...">
  // dont le texte est le nom complet de la carte. La quantité était portée
  // par un <input type="text" value="N">, mais Moxfield l'a remplacé par un
  // simple <div> ne contenant qu'un nombre (même principe que le badge de
  // quantité de la vue Visual/Stacks — confirmé via inspection HTML réelle)
  // — l'ancien <input> ne s'y trouve donc plus, d'où des quantités toujours
  // ramenées à 1. On garde la lecture de l'<input> en repli si jamais il
  // réapparaît. Chaque <li> porte aussi un data-hash unique et stable : on
  // s'en sert pour ignorer un éventuel doublon de rendu (même cause que
  // pour les images — cf. slotUniqueKey plus bas — Moxfield laisse parfois
  // un ancien nœud en double sans le détruire).
  function findListQty(li) {
    const input = li.querySelector('input[type="text"]');
    if (input) {
      const v = parseInt(input.value, 10);
      if (!Number.isNaN(v) && v > 0) return v;
    }
    const leaves = Array.from(li.querySelectorAll("div")).filter((el) => el.children.length === 0);
    for (const leaf of leaves) {
      const t = (leaf.textContent || "").trim();
      if (/^\d{1,3}$/.test(t)) return parseInt(t, 10);
    }
    return 1;
  }

  function scrapeCardsFromList() {
    const links = Array.from(document.querySelectorAll('a.table-deck-row-link[href^="/cards/"]')).filter(isVisible);
    const seen = new Map();
    const seenRowKeys = new Set();
    links.forEach((link) => {
      const li = link.closest("li");
      if (!li) return;
      const rowKey = li.getAttribute("data-hash");
      if (rowKey) {
        if (seenRowKeys.has(rowKey)) return; // doublon de rendu de la même ligne : ignoré
        seenRowKeys.add(rowKey);
      }
      const qty = findListQty(li);
      const name = (link.textContent || "").replace(/\s+/g, " ").trim();
      if (!name) return;
      const printingStatus = findCollectionStatusNear(link, li);
      const key = name.toLowerCase();
      if (seen.has(key)) seen.get(key).qty += qty;
      else seen.set(key, { name, qty, printingStatus });
    });
    return Array.from(seen.values());
  }

  // --- Scraping DOM, vues visuelles (Visual Stacks / Grid / Spoiler) ---
  // Méthode principale : la classe "img-card" est fiable et on a confirmé
  // que ces éléments sont bien présents dans le DOM au moment du clic.
  // On s'appuie sur des repères structurels plutôt que sur les noms de
  // classes CSS générées automatiquement par Moxfield (ex. "H3UM7DGQXHnJU...",
  // probablement issues de CSS Modules et donc sujettes à changer à chaque
  // build) : la classe "img-card" semble être un nom sémantique stable posé
  // volontairement par Moxfield sur toutes ses images de carte, et chaque
  // image de carte a une quantité affichée juste à côté dans le DOM, sous
  // forme d'un <div> ne contenant qu'un nombre (masqué visuellement par CSS
  // tant qu'on ne survole pas, mais bien présent dans le HTML).
  // On borne d'abord la recherche au "slot" (conteneur) de CETTE carte —
  // délimité par la présence du marqueur de collection natif "collection_*"
  // (voir findSlotContainer) — avant de chercher un nombre isolé dedans.
  // Sans cette limite, la recherche grimpait librement d'ancêtre en ancêtre
  // en excluant systématiquement la branche qui contient l'image
  // (`child.contains(imgEl)`) : si le badge de quantité de la carte vit
  // justement dans cette branche (cas normal), il n'était jamais trouvé là,
  // et la recherche continuait de grimper jusqu'à tomber sur le premier
  // nombre isolé rencontré — potentiellement celui d'une carte VOISINE. Le
  // rendu React n'imbrique pas le DOM exactement pareil à chaque chargement,
  // ce qui expliquait des quantités fausses différentes à chaque F5.
  function findQtyNear(imgEl, scopeEl) {
    // ATTENTION : le vrai badge de quantité est délibérément masqué par CSS
    // tant qu'on ne survole pas la carte (cf. commentaire plus haut) — un
    // filtre isVisible() ici exclurait justement le bon élément. On se
    // borne donc au "slot" de la carte (délimité par le marqueur de
    // collection) pour éviter la contamination inter-cartes, sans exiger de
    // visibilité sur le candidat lui-même.
    if (scopeEl) {
      const leaves = Array.from(scopeEl.querySelectorAll("*")).filter(
        (el) => el !== imgEl && !el.contains(imgEl) && el.children.length === 0
      );
      for (const leaf of leaves) {
        const t = (leaf.textContent || "").trim();
        if (/^\d{1,3}$/.test(t)) return parseInt(t, 10);
      }
    }
    // Repli : ancienne méthode par élargissement d'ancêtres, seulement si
    // aucun slot borné n'a pu être déterminé (pas de marqueur de collection
    // trouvé, ex. deck d'un autre utilisateur sans données de collection).
    let el = imgEl.parentElement;
    for (let level = 0; level < 4 && el; level++) {
      el = el.parentElement;
      if (!el) break;
      for (const child of el.children) {
        if (child.contains(imgEl)) continue;
        const t = (child.textContent || "").trim();
        if (/^\d{1,3}$/.test(t)) return parseInt(t, 10);
      }
    }
    return 1; // pas trouvé : on suppose 1 exemplaire par défaut
  }

  function findSlotContainer(imgEl) {
    let el = imgEl.parentElement;
    for (let level = 0; level < 4 && el; level++) {
      el = el.parentElement;
      if (!el) break;
      if (el.querySelector('[id^="collection_"]')) return el;
    }
    return imgEl.parentElement ? imgEl.parentElement.parentElement : null;
  }

  // Sur les cartes double-face (ex. "Elusive Otter // Grove's Bounty"),
  // Moxfield ajoute une petite icône de retournement recto/verso qui porte
  // la MÊME classe "img-card" que la vraie image de carte, avec un
  // alt="Front" / alt="Back". Elle se retrouve alors traitée comme une
  // "carte" à part entière (avec la quantité et le statut de collection de
  // la vraie carte adjacente récupérés par erreur). Aucune carte Magic ne
  // s'appelle "Front" ou "Back" : on exclut ces deux libellés sans risque.
  const FLIP_ICON_ALT_BLOCKLIST = new Set(["front", "back"]);

  // Chaque VRAIE tuile de deck a un identifiant stable et unique porté par
  // le conteneur direct de l'image, au format exact "id<N>-legal-<code>"
  // (ex. "id130-legal-0vZWm", le suffixe "0vZWm" se retrouvant aussi dans
  // l'URL de l'image : .../card-0vZWm-...). Confirmé via inspection DOM
  // réelle (Copy outerHTML) sur plusieurs cartes. Moxfield garde par
  // ailleurs, ailleurs dans la page, un élément de prévisualisation/zoom au
  // survol qui réutilise la MÊME classe "img-card" et peut garder en
  // mémoire le alt/src d'une carte déjà survolée — repéré en pratique par
  // un conteneur SANS id (vérifié via la console DevTools). On exige donc
  // ce format précis plutôt qu'un repli approximatif (ex. tiré de l'URL),
  // et on ignore purement toute image qui ne le porte pas.
  const SLOT_ID_PATTERN = /^id\d+-legal-.+$/;

  function slotUniqueKey(imgEl) {
    const wrapperId = imgEl.parentElement && imgEl.parentElement.id;
    return wrapperId && SLOT_ID_PATTERN.test(wrapperId) ? wrapperId : null;
  }

  function scrapeCardsFromImages() {
    const imgs = Array.from(document.querySelectorAll("img.img-card[alt]")).filter(isVisible);
    const seen = new Map();
    const seenSlotKeys = new Set();
    imgs.forEach((img) => {
      const name = (img.getAttribute("alt") || "").trim();
      if (!name) return;
      if (FLIP_ICON_ALT_BLOCKLIST.has(name.toLowerCase())) return;
      const slotKey = slotUniqueKey(img);
      if (!slotKey) return; // pas une vraie tuile de deck (ex. aperçu au survol) : ignorée
      if (seenSlotKeys.has(slotKey)) return; // doublon DOM périmé de la même entrée : ignoré
      seenSlotKeys.add(slotKey);
      const slot = findSlotContainer(img);
      const qty = findQtyNear(img, slot);
      const printingStatus = slot ? findCollectionStatusNear(img, slot) : "unknown";
      const key = name.toLowerCase();
      if (seen.has(key)) {
        seen.get(key).qty += qty;
      } else {
        seen.set(key, { name, qty, printingStatus });
      }
    });
    return Array.from(seen.values());
  }

  // --- Scraping DOM, vue "Visual Grid" ---
  // Structure différente de "Visual Stacks" (voir scrapeCardsFromImages) :
  // chaque carte est un <div class="decklist-card" data-hash="..."> qui
  // regroupe tout au même endroit — pas besoin de deviner une zone
  // ("slot") par élargissement d'ancêtres comme pour les Stacks :
  // - nom en texte brut dans .decklist-card-phantomsearch
  // - quantité en texte brut ("x1", "x2"...) dans .decklist-card-quantity
  // - statut de collection dans .decklist-card-collection (même marqueur
  //   natif "collection_full_/pt_/no_" qu'ailleurs)
  // - "data-hash" unique par entrée, pour ignorer un éventuel doublon de
  //   rendu (même principe que pour les autres méthodes de scraping).
  // Confirmé via inspection HTML réelle de la page en vue "Visual Grid".
  function scrapeCardsFromDecklistCards() {
    const cardEls = Array.from(document.querySelectorAll("div.decklist-card[data-hash]")).filter(isVisible);
    const seen = new Map();
    const seenHashes = new Set();
    cardEls.forEach((card) => {
      const hash = card.getAttribute("data-hash");
      if (hash) {
        if (seenHashes.has(hash)) return; // doublon de rendu de la même entrée : ignoré
        seenHashes.add(hash);
      }
      const nameEl = card.querySelector(".decklist-card-phantomsearch");
      const name = nameEl ? (nameEl.textContent || "").trim() : "";
      if (!name) return;
      const qtyEl = card.querySelector(".decklist-card-quantity");
      let qty = 1;
      if (qtyEl) {
        const m = (qtyEl.textContent || "").trim().match(/(\d{1,3})/);
        if (m) qty = parseInt(m[1], 10);
      }
      const printingStatus = findCollectionStatusNear(card, card);
      const key = name.toLowerCase();
      if (seen.has(key)) seen.get(key).qty += qty;
      else seen.set(key, { name, qty, printingStatus });
    });
    return Array.from(seen.values());
  }

  // --- Scraping texte (méthode de repli) ---
  // Utile pour les vues "Text" / "Condensed Text" de Moxfield, qui affichent
  // directement des lignes "QTE Nom" en texte plutôt que des images.
  function scrapeCardsFromText() {
    const container = document.querySelector("main") || document.body;
    const text = container.innerText || "";
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const blocklist = /^(commander|deck|maindeck|mainboard|sideboard|companion|format|legal|price|export|copy|edit|settings|tags|description|comments?|visibility|created|updated|views?)\b/i;
    const seen = new Map();
    for (const line of lines) {
      const match = line.match(/^(\d{1,3})\s*[x×]?\s+([A-Za-zÀ-ÿ0-9][^$€\n]{1,60}?)$/);
      if (!match) continue;
      const qty = parseInt(match[1], 10);
      const name = match[2].trim();
      if (!qty || qty > 99) continue;
      if (blocklist.test(name)) continue;
      if (/^\d+$/.test(name)) continue;
      const key = name.toLowerCase();
      seen.set(key, { name, qty, printingStatus: "unknown" });
    }
    return Array.from(seen.values());
  }

  function scrapeCardsGuess() {
    // Moxfield expose la vue active via un <select id="viewMode"> — on lit
    // directement cette valeur plutôt que de deviner via la visibilité des
    // éléments, ce qui évite tout risque de retomber sur des restes DOM
    // d'une autre vue.
    const viewSelect = document.querySelector('select[name="viewMode"], select#viewMode');
    const mode = viewSelect ? viewSelect.value : null;
    const textModes = ["table", "condensedTable"];
    const visualModes = ["visual", "stacks", "splitStacks", "spoiler"];

    if (mode && textModes.includes(mode)) {
      const fromList = scrapeCardsFromList();
      if (fromList.length > 0) return fromList;
    } else if (mode && visualModes.includes(mode)) {
      // "Visual Grid" (et peut-être d'autres) utilise une structure plus
      // fiable (div.decklist-card[data-hash]) que "Visual Stacks" — on la
      // tente en priorité, avant l'ancienne méthode par heuristique d'image.
      const fromDecklistCards = scrapeCardsFromDecklistCards();
      if (fromDecklistCards.length > 0) return fromDecklistCards;
      const fromImages = scrapeCardsFromImages();
      if (fromImages.length > 0) return fromImages;
    }

    // Mode inconnu, ou la méthode attendue n'a rien trouvé : on essaie tout.
    const fromDecklistCards = scrapeCardsFromDecklistCards();
    if (fromDecklistCards.length > 0) return fromDecklistCards;
    const fromImages = scrapeCardsFromImages();
    if (fromImages.length > 0) return fromImages;
    const fromList = scrapeCardsFromList();
    if (fromList.length > 0) return fromList;
    return scrapeCardsFromText();
  }

  // Moxfield affiche dans le pied de page le total officiel du deck sous la
  // forme de deux blocs de texte "<N> main deck" et "<N> sideboard". On lit
  // ce texte plutôt que les classes CSS générées automatiquement qui
  // l'entourent (cf. CONTEXT.md — elles changent à chaque build). Ce total
  // sert à vérifier que le scraping n'a rien manqué ni dupliqué : une
  // divergence signale une erreur de détection à corriger manuellement
  // avant de valider le montage.
  function getSiteDeclaredTotal() {
    const nodes = Array.from(document.querySelectorAll("div, span")).filter(
      (el) => el.children.length === 0 && isVisible(el)
    );
    let mainDeck = null;
    let sideboard = null;
    for (const el of nodes) {
      const t = (el.textContent || "").trim();
      if (mainDeck === null) {
        const m = t.match(/^(\d+)\s+main deck$/i);
        if (m) mainDeck = parseInt(m[1], 10);
      }
      if (sideboard === null) {
        const m = t.match(/^(\d+)\s+sideboard$/i);
        if (m) sideboard = parseInt(m[1], 10);
      }
      if (mainDeck !== null && sideboard !== null) break;
    }
    if (mainDeck === null) return null;
    return mainDeck + (sideboard || 0);
  }

  // Cartes que Moxfield indique comme présentes dans ta collection, mais
  // pas dans la version utilisée par ce deck ("collection_pt_...", aria-label
  // "Partially in collection" — confirmé via inspection DOM réelle, ex. Sol
  // Ring possédé sous une autre édition). Bloque le montage tant que la
  // liste n'est pas corrigée/retirée — même traitement que le stock
  // insuffisant (zone 2) plutôt qu'un décompte silencieux. Calculé au moment
  // du scraping DOM ; vide si la liste vient du presse-papiers (pas d'info
  // disponible dans du texte brut collé).
  let lastWrongEditionNames = new Set();

  function buildWrongEditionSet(scrapedCards) {
    const set = new Set();
    for (const c of scrapedCards) {
      if (c.printingStatus === "partial") set.add(normalizeName(c.name));
    }
    return set;
  }

  // Zone 1 : cartes dont le stock est SUFFISANT (peu importe l'édition,
  // puisque le stock est suivi par nom) et que Moxfield signale en plus
  // comme possédées sous une version différente de celle utilisée par ce
  // deck précis. Priorité au stock : une carte dont le stock ne suffit pas
  // (have < besoin), même partiellement, ne doit PAS apparaître ici — c'est
  // un problème de stock insuffisant (zone 2) d'abord ; on ne regarde la
  // version que si le stock est déjà suffisant.
  function computeWrongEditionCards(cards, stockMap) {
    const names = [];
    for (const c of cards) {
      const key = normalizeName(c.name);
      const have = stockMap[key] ? stockMap[key].qty : 0;
      if (have >= c.qty && lastWrongEditionNames.has(key)) names.push(c.name);
    }
    return names;
  }

  function renderPrintingWarning(el, names) {
    if (names.length === 0) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    el.style.display = "block";
    el.innerHTML =
      `<strong>🚫 Présentes dans ta collection mais pas dans la bonne version pour ce deck (${names.length} carte(s))</strong> — montage bloqué, corrige ou retire ces lignes avant de valider :<ul>` +
      names.map((n) => `<li>${escapeHtml(n)}</li>`).join("") +
      "</ul>";
  }

  function normalizeName(name) {
    return name.trim().toLowerCase().replace(/\s+/g, " ");
  }

  // Terrains de base : en pratique tu en as (presque) toujours assez, et
  // l'édition n'a jamais d'importance pour eux. On ne bloque donc jamais le
  // montage à cause d'un terrain de base (ni "version différente", ni
  // "stock insuffisant") — juste un avertissement non bloquant séparé.
  const BASIC_LAND_NAMES = new Set(["plains", "island", "swamp", "mountain", "forest"]);

  function isBasicLand(name) {
    return BASIC_LAND_NAMES.has(normalizeName(name));
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

  async function getStockMap() {
    const res = await safeSendMessage({ type: "GET_STATE" });
    return res.ok ? res.state.stock || {} : {};
  }

  // Zone 2 : cartes dont le stock disponible ne suffirait pas si ce deck
  // était monté — y compris les cartes totalement absentes du stock
  // (have === 0), quel que soit leur statut de version Moxfield.
  function computeShortages(cards, stockMap) {
    const shortages = [];
    for (const c of cards) {
      const key = normalizeName(c.name);
      const have = stockMap[key] ? stockMap[key].qty : 0;
      const missing = c.qty - have;
      if (missing > 0) shortages.push({ name: c.name, have, need: c.qty, missing });
    }
    return shortages;
  }

  function renderShortageWarning(el, shortages) {
    if (shortages.length === 0) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    el.style.display = "block";
    el.innerHTML =
      `<strong>⚠️ Stock insuffisant pour ${shortages.length} carte(s) :</strong>` +
      `<button type="button" class="msm-secondary msm-export-btn">🛒 Copier les cartes manquantes pour Cardmarket</button><ul>` +
      shortages
        .map(
          (s) =>
            `<li>${escapeHtml(s.name)} — as ${s.have}, besoin ${s.need} (manque ${s.missing})</li>`
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
  const CARDMARKET_WANTS_URL = "https://www.cardmarket.com/fr/Magic/Wants";

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
      toast("Impossible de copier la liste dans le presse-papiers.", true);
      return;
    }
    window.open(CARDMARKET_WANTS_URL, "_blank", "noopener");
    toast(`${shortages.length} carte(s) copiée(s) — sur Cardmarket, ouvre une liste de wants puis « Ajouter une Deck List » et colle.`);
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
      ...wrongEditionNames.map((n) => `${escapeHtml(n)} — version différente de ta collection`),
      ...shortages.map(
        (s) => `${escapeHtml(s.name)} — as ${s.have}, besoin ${s.need} (manque ${s.missing})`
      ),
    ];
    el.style.display = "block";
    el.innerHTML =
      `<strong>ℹ️ Terrains de base à vérifier (${items.length})</strong> — n'empêche pas de valider :<ul>` +
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
    const base = `${total} carte${total === 1 ? "" : "s"} au total (${cards.length} intitulé${cards.length === 1 ? "" : "s"} différent${cards.length === 1 ? "" : "s"})`;
    // Comparaison au total officiel affiché par Moxfield (main deck +
    // sideboard) : une divergence signale une erreur de scraping en amont
    // (carte manquée ou dupliquée) à corriger manuellement dans la liste.
    if (typeof siteTotal === "number" && siteTotal !== total) {
      el.textContent = `${base} — ⚠️ le site indique ${siteTotal} carte${siteTotal === 1 ? "" : "s"} : vérifie la liste avant de valider`;
      el.classList.add("msm-card-count-mismatch");
    } else {
      el.textContent = base;
      el.classList.remove("msm-card-count-mismatch");
    }
  }

  function cardsToText(cards) {
    return cards.map((c) => `${c.qty} ${c.name}`).join("\n");
  }

  function parseCardsText(text) {
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"))
      .map((line) => {
        const m = line.match(/^(\d{1,3})\s*[x×]?\s+(.+)$/);
        if (!m) return null;
        return { qty: parseInt(m[1], 10), name: m[2].trim() };
      })
      .filter(Boolean);
  }

  function buildOverlay({ isBuilt }) {
    const overlay = document.createElement("div");
    overlay.className = "msm-overlay";
    overlay.innerHTML = `
      <div class="msm-modal">
        <h3>${isBuilt ? "Démonter ce deck" : "Marquer ce deck comme monté physiquement"}</h3>
        ${
          isBuilt
            ? `<p>Ce deck est actuellement marqué comme monté. Le démonter réincrémentera le stock des cartes qu'il utilise.</p>`
            : `<p>
                 Liste détectée automatiquement à partir de la page — vérifie/corrige avant de valider
                 (une carte par ligne, "QTE Nom"). Si elle est vide ou incomplète, clique sur le bouton
                 <strong>« Copier »</strong> de Moxfield puis « Coller depuis le presse-papiers ».
               </p>
               <button id="msm-paste-clipboard" class="msm-secondary">📋 Coller depuis le presse-papiers</button>
               <div id="msm-card-count" class="msm-card-count"></div>
               <textarea id="msm-cards-textarea" rows="12" placeholder="1 Sol Ring&#10;1 Sidisi, Brood Tyrant&#10;..."></textarea>
               <div id="msm-printing-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-shortage-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-basic-land-warning" class="msm-info-warning" style="display:none"></div>`
        }
        <div class="msm-modal-actions">
          <button id="msm-cancel">Annuler</button>
          <button id="msm-confirm" class="msm-primary">${isBuilt ? "Démonter" : "Confirmer le montage"}</button>
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

  async function safeSendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        toast("Extension rechargée entre-temps — rafraîchis cette page (F5) puis réessaie.", true);
        return { ok: false, error: "extension-context-invalidated" };
      }
      throw err;
    }
  }

  async function getIsBuilt(deckId) {
    const res = await safeSendMessage({ type: "GET_STATE" });
    if (!res.ok) return false;
    return Boolean(res.state.builtDecks[deckId]);
  }

  async function refreshButtonState(deckId) {
    if (!btn) return;
    const built = await getIsBuilt(deckId);
    btn.textContent = built ? "✅ Monté physiquement (cliquer pour démonter)" : "🧰 Marquer comme monté physiquement";
    btn.classList.toggle("msm-btn-built", built);
    return built;
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

  async function openOverlay() {
    const deckId = getDeckId();
    if (!deckId) return;
    const isBuilt = await getIsBuilt(deckId);
    const overlay = buildOverlay({ isBuilt });

    if (!isBuilt) {
      const textarea = overlay.querySelector("#msm-cards-textarea");
      const warningEl = overlay.querySelector("#msm-shortage-warning");
      const printingWarningEl = overlay.querySelector("#msm-printing-warning");
      const basicLandWarningEl = overlay.querySelector("#msm-basic-land-warning");
      const cardCountEl = overlay.querySelector("#msm-card-count");
      const siteDeclaredTotal = getSiteDeclaredTotal();

      const updateWarnings = async () => {
        const cards = parseCardsText(textarea.value);
        renderCardCount(cardCountEl, cards, siteDeclaredTotal);
        if (cards.length === 0) {
          renderShortageWarning(warningEl, []);
          renderPrintingWarning(printingWarningEl, []);
          renderBasicLandNotice(basicLandWarningEl, [], []);
          return;
        }
        // Terrains de base traités à part (jamais bloquants) — cf. isBasicLand.
        const basicCards = cards.filter((c) => isBasicLand(c.name));
        const nonBasicCards = cards.filter((c) => !isBasicLand(c.name));
        // Une seule lecture du stock, réutilisée pour toutes les zones.
        const stockMap = await getStockMap();
        renderShortageWarning(warningEl, computeShortages(nonBasicCards, stockMap));
        renderPrintingWarning(printingWarningEl, computeWrongEditionCards(nonBasicCards, stockMap));
        renderBasicLandNotice(
          basicLandWarningEl,
          computeWrongEditionCards(basicCards, stockMap),
          computeShortages(basicCards, stockMap)
        );
      };

      // Scraping DOM de la page (méthode adaptée à la vue active).
      const guessed = scrapeCardsGuess();
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
        if (!ok) toast("Presse-papiers vide ou format non reconnu — colle manuellement avec Ctrl+V.", true);
        // Un collage manuel remplace la liste détectée : on perd l'info de version.
        lastWrongEditionNames = new Set();
        await updateWarnings();
      });
    }

    overlay.querySelector("#msm-cancel").addEventListener("click", () => overlay.remove());

    overlay.querySelector("#msm-confirm").addEventListener("click", async () => {
      try {
        let payload;
        if (isBuilt) {
          payload = { deckId, deckName: getDeckName(), url: window.location.href, cards: [], built: false };
        } else {
          const textarea = overlay.querySelector("#msm-cards-textarea");
          let cards = parseCardsText(textarea.value);
          if (cards.length === 0) {
            toast("Aucune carte reconnue dans la liste — vérifie le format (QTE Nom).", true);
            return;
          }
          // Deux vérifications bloquantes avant de pouvoir valider : version
          // différente de ta collection Moxfield (zone 1), puis stock
          // insuffisant (zone 2) — sauf pour les terrains de base, jamais
          // bloquants (cf. isBasicLand). Recalculées ici au cas où le texte
          // a été modifié depuis le dernier passage de updateWarnings.
          const stockMap = await getStockMap();
          const nonBasicCards = cards.filter((c) => !isBasicLand(c.name));
          const wrongEdition = computeWrongEditionCards(nonBasicCards, stockMap);
          if (wrongEdition.length > 0) {
            toast(`Montage impossible — version différente de ta collection pour : ${wrongEdition.join(", ")}`, true);
            return;
          }
          const shortages = computeShortages(nonBasicCards, stockMap);
          if (shortages.length > 0) {
            const details = shortages.map((s) => `${s.name} (manque ${s.missing})`).join(", ");
            toast(`Montage impossible — stock insuffisant : ${details}`, true);
            return;
          }
          payload = { deckId, deckName: getDeckName(), url: window.location.href, cards, built: true };
        }
        const res = await safeSendMessage({ type: "TOGGLE_DECK_BUILT", payload });
        if (res.error === "extension-context-invalidated") return; // toast déjà affiché par safeSendMessage
        if (!res.ok) throw new Error(res.error || "Erreur inconnue");
        overlay.remove();
        await refreshButtonState(deckId);
        toast(isBuilt ? "Deck démonté, stock réincrémenté." : "Deck marqué comme monté, stock décrémenté.");
      } catch (e) {
        toast("Erreur : " + e.message, true);
      }
    });
  }

  function ensureButton() {
    if (btn) return btn;
    btn = document.createElement("button");
    btn.className = "msm-floating-btn";
    document.body.appendChild(btn);
    btn.addEventListener("click", () => openOverlay());
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
        await refreshButtonState(deckId);
      }
    } else {
      currentDeckId = null;
      removeButton();
    }
  }

  // Polling léger (voir en-tête du fichier) : sert à la fois à détecter les
  // changements d'URL de la SPA et à réévaluer le badge "Commander" tant
  // qu'on reste sur la même page (cf. commentaire de syncButtonToLocation).
  setInterval(syncButtonToLocation, 500);

  syncButtonToLocation();
})();
