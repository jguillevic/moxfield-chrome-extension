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
  // pour les images — cf. slotStableKey plus bas — Moxfield laisse parfois
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

  function slotWrapperId(imgEl) {
    const wrapperId = imgEl.parentElement && imgEl.parentElement.id;
    return wrapperId && SLOT_ID_PATTERN.test(wrapperId) ? wrapperId : null;
  }

  // Le <N> de "id<N>-legal-<code>" est un compteur de rendu, pas un
  // identifiant de l'entrée : après une modification du deck, Moxfield
  // recrée des tuiles avec de nouveaux numéros (ex. "id1585-legal-J7O5m"
  // au milieu de "id6", "id8"...) sans toujours retirer les anciennes —
  // dédoublonner sur l'id complet comptait alors ces cartes deux fois
  // (constaté : 163 cartes détectées pour 100). La partie stable est
  // "legal-<code>" (impression, suffixe "F0" si foil) ; on y ajoute la zone
  // du deck ("mainboard", "commanders"...), lue dans l'id du marqueur de
  // collection (ex. "collection_full_1586_mainboard_J7O5m"), car Moxfield
  // regroupe toujours une même impression d'une même zone en une entrée.
  function slotStableKey(wrapperId, slot) {
    const printing = wrapperId.replace(/^id\d+-/, "");
    const marker = slot && slot.querySelector('[id^="collection_"]');
    const boardMatch = marker && marker.id.match(/^collection_[a-z]+_\d+_([a-z]+)_/i);
    return `${boardMatch ? boardMatch[1] : "?"}:${printing}`;
  }

  // oneTilePerCopy : vue "Visual Stacks (Split)", où chaque exemplaire a sa
  // propre tuile (3 tuiles pour une carte en 3 exemplaires, sans badge de
  // quantité). Le dédoublonnage par impression (slotStableKey) y fusionnerait
  // les exemplaires : on garde l'id complet, un par tuile. Un éventuel
  // doublon périmé fausserait alors le total, ce que le contrôle par rapport
  // au total Moxfield signale.
  function scrapeCardsFromImages(oneTilePerCopy = false) {
    const imgs = Array.from(document.querySelectorAll("img.img-card[alt]")).filter(isVisible);
    const seen = new Map();
    const seenSlotKeys = new Set();
    imgs.forEach((img) => {
      const name = (img.getAttribute("alt") || "").trim();
      if (!name) return;
      if (FLIP_ICON_ALT_BLOCKLIST.has(name.toLowerCase())) return;
      const wrapperId = slotWrapperId(img);
      if (!wrapperId) return; // pas une vraie tuile de deck (ex. aperçu au survol) : ignorée
      const slot = findSlotContainer(img);
      const slotKey = oneTilePerCopy ? wrapperId : slotStableKey(wrapperId, slot);
      if (seenSlotKeys.has(slotKey)) return; // doublon DOM périmé de la même entrée : ignoré
      seenSlotKeys.add(slotKey);
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
      let name = nameEl ? (nameEl.textContent || "").trim() : "";
      if (!name) return;
      // Carte double face : le texte ne donne que la face avant ("Revitalizing
      // Repast"), l'image le nom complet ("Revitalizing Repast // Old-Growth
      // Grove"), qui est celui du stock.
      const imgAlt = ((card.querySelector("img.img-card[alt]") || {}).alt || "").trim();
      if (imgAlt.includes(" // ") && normalizeName(imgAlt).startsWith(normalizeName(name))) name = imgAlt;
      // La quantité est la valeur d'un <input> ("x" + <input value="3">) :
      // absente de textContent, qui ne contient que le "x". Le texte ("x3")
      // reste lu en repli si Moxfield revient à un affichage texte.
      const qtyEl = card.querySelector(".decklist-card-quantity");
      let qty = 1;
      if (qtyEl) {
        const input = qtyEl.querySelector("input");
        const m = ((input && input.value) || qtyEl.textContent || "").trim().match(/(\d{1,3})/);
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
    const oneTilePerCopy = mode === "splitStacks";

    if (mode && textModes.includes(mode)) {
      const fromList = scrapeCardsFromList();
      if (fromList.length > 0) return fromList;
    } else if (mode && visualModes.includes(mode)) {
      // "Visual Grid" (et peut-être d'autres) utilise une structure plus
      // fiable (div.decklist-card[data-hash]) que "Visual Stacks" — on la
      // tente en priorité, avant l'ancienne méthode par heuristique d'image.
      const fromDecklistCards = scrapeCardsFromDecklistCards();
      if (fromDecklistCards.length > 0) return fromDecklistCards;
      const fromImages = scrapeCardsFromImages(oneTilePerCopy);
      if (fromImages.length > 0) return fromImages;
    }

    // Mode inconnu, ou la méthode attendue n'a rien trouvé : on essaie tout.
    const fromDecklistCards = scrapeCardsFromDecklistCards();
    if (fromDecklistCards.length > 0) return fromDecklistCards;
    const fromImages = scrapeCardsFromImages(oneTilePerCopy);
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
  // Appelée régulièrement (détection d'un deck modifié) : on teste le texte
  // avant la visibilité, bien plus coûteuse (getComputedStyle).
  function getSiteDeclaredTotal() {
    let mainDeck = null;
    let sideboard = null;
    for (const el of document.querySelectorAll("div, span")) {
      if (el.children.length !== 0) continue;
      const t = (el.textContent || "").trim();
      const mainMatch = mainDeck === null && t.match(/^(\d+)\s+main deck$/i);
      const sideMatch = sideboard === null && t.match(/^(\d+)\s+sideboard$/i);
      if (!mainMatch && !sideMatch) continue;
      if (!isVisible(el)) continue;
      if (mainMatch) mainDeck = parseInt(mainMatch[1], 10);
      if (sideMatch) sideboard = parseInt(sideMatch[1], 10);
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

  // Pour chaque carte (nom normalisé), les decks montés qui la contiennent —
  // sert à indiquer, pour une carte manquante, quel deck démonter pour la
  // récupérer. Même règle que le popup : les cartes excludedFromStock
  // (decks montés avec une ancienne version) n'ont jamais été retirées du
  // stock, elles ne comptent donc pas comme "prises" par le deck.
  // excludeDeckId : deck à ignorer (celui qu'on met à jour, dont les cartes
  // lui reviennent).
  async function getStockAndDeckUsage(excludeDeckId = null) {
    const res = await safeSendMessage({ type: "GET_STATE" });
    if (!res.ok) return { stockMap: {}, deckUsage: new Map(), builtDecks: {} };
    const deckUsage = new Map();
    for (const [deckId, deck] of Object.entries(res.state.builtDecks || {})) {
      if (deckId === excludeDeckId) continue;
      for (const card of deck.cards || []) {
        if (card.excludedFromStock) continue;
        const key = normalizeName(card.name);
        if (!deckUsage.has(key)) deckUsage.set(key, []);
        deckUsage.get(key).push({ name: deck.name, qty: card.qty });
      }
    }
    return { stockMap: res.state.stock || {}, deckUsage, builtDecks: res.state.builtDecks || {} };
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
      return ` · <strong>dans : ${decks.map((d) => `${escapeHtml(d.name)} (${d.qty})`).join(", ")}</strong>`;
    };
    el.innerHTML =
      `<strong>⚠️ Stock insuffisant pour ${shortages.length} carte(s) :</strong>` +
      `<button type="button" class="msm-secondary msm-export-btn">🛒 Copier les cartes manquantes pour Cardmarket</button><ul>` +
      shortages
        .map(
          (s) =>
            `<li>${escapeHtml(s.name)} — as ${s.have}, besoin ${s.need} (manque ${s.missing})${whereText(s)}</li>`
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

  // --- Deck modifié depuis son montage ---
  // La liste enregistrée au montage est figée : si le deck est modifié
  // ensuite sur Moxfield, le stock ne correspond plus aux cartes réellement
  // utilisées. On compare la liste de la page à celle du montage (par nom,
  // quantités cumulées) pour le signaler et proposer de n'appliquer que la
  // différence.
  function cardsByKey(cards) {
    const map = new Map();
    for (const c of cards) {
      const key = normalizeName(c.name);
      if (map.has(key)) map.get(key).qty += c.qty;
      else map.set(key, { name: c.name, qty: c.qty });
    }
    return map;
  }

  // Cartes double face : les vues visuelles donnent le nom complet
  // ("Boggart Trawler // Boggart Bog", comme l'export CSV qui alimente le
  // stock), la vue Text seulement la face avant ("Boggart Trawler" — le
  // lien ne contient que ce texte). Sans correction, une même carte avait
  // deux noms selon la vue : fausses différences avec le montage, et carte
  // introuvable dans le stock. On retrouve le nom complet dans les listes de
  // référence fournies (stock, liste du montage).
  function frontFaceKey(name) {
    return normalizeName(name).split(" // ")[0];
  }

  function completeCardNames(cards, ...referenceLists) {
    const fullNames = new Map();
    for (const list of referenceLists) {
      for (const c of list) {
        if (!c.name.includes(" // ")) continue;
        const key = frontFaceKey(c.name);
        if (!fullNames.has(key)) fullNames.set(key, c.name);
      }
    }
    return cards.map((c) =>
      c.name.includes(" // ") ? c : { ...c, name: fullNames.get(frontFaceKey(c.name)) || c.name }
    );
  }

  function computeDeckDiff(oldCards, newCards) {
    const before = cardsByKey(oldCards);
    const after = cardsByKey(newCards);
    const changes = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const from = before.has(key) ? before.get(key).qty : 0;
      const to = after.has(key) ? after.get(key).qty : 0;
      if (from !== to) changes.push({ name: (after.get(key) || before.get(key)).name, from, to });
    }
    return changes.sort((a, b) => a.name.localeCompare(b.name));
  }

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
    if (cards.length === 0) return "aucune carte détectée sur la page.";
    const detected = `${total} carte${total === 1 ? "" : "s"} détectée${total === 1 ? "" : "s"} sur la page`;
    return siteTotal === null
      ? `${detected}, mais total annoncé par Moxfield (« N main deck ») introuvable.`
      : `${detected}, alors que Moxfield en annonce ${siteTotal}.`;
  }

  // Vérifications avant la mise à jour, sur les seules cartes ajoutées ou
  // en plus grand nombre (mêmes règles qu'au montage, cf. updateWarnings).
  // Le stock disponible pour elles inclut les exemplaires déjà pris par ce
  // deck, que la mise à jour lui rend d'abord.
  function evaluateDeckUpdate(changes, deck, stockMap) {
    const available = {};
    for (const [key, c] of Object.entries(stockMap)) available[key] = { ...c };
    for (const c of deck.cards) {
      if (c.excludedFromStock) continue;
      const key = normalizeName(c.name);
      if (!available[key]) available[key] = { name: c.name, qty: 0 };
      available[key].qty += c.qty;
    }
    const increased = changes.filter((c) => c.to > c.from).map((c) => ({ name: c.name, qty: c.to }));
    const basic = increased.filter((c) => isBasicLand(c.name));
    const nonBasic = increased.filter((c) => !isBasicLand(c.name));
    const check = {
      shortages: computeShortages(nonBasic, available),
      wrongEdition: computeWrongEditionCards(nonBasic, available),
      basicShortages: computeShortages(basic, available),
      basicWrongEdition: computeWrongEditionCards(basic, available),
    };
    check.blocked = check.shortages.length > 0 || check.wrongEdition.length > 0;
    return check;
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

  function formatDay(timestamp) {
    return new Date(timestamp).toLocaleDateString("fr-FR");
  }

  // Modale d'un deck monté : compare la liste de la page à celle du montage
  // et, si elle a changé, affiche la différence et active « Mettre à jour le
  // montage ». Renvoie la nouvelle liste à enregistrer, ou null.
  async function prepareDeckUpdate(overlay, deckId) {
    const changesEl = overlay.querySelector("#msm-deck-changes");
    changesEl.innerHTML = '<p class="msm-card-count">Vérification de la liste…</p>';
    const { stockMap, deckUsage, builtDecks } = await getStockAndDeckUsage(deckId);
    const deck = builtDecks[deckId];
    if (!deck) {
      changesEl.innerHTML = "";
      return null;
    }
    // Juste après un chargement ou une modification, Moxfield peut ne pas
    // avoir fini d'afficher la liste (images construites progressivement en
    // Visual Stacks) : on laisse quelques secondes avant de conclure.
    let detection = scrapeDeckListWithCheck();
    for (let waited = 0; !detection.reliable && waited < 3000; waited += 300) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      detection = scrapeDeckListWithCheck();
    }
    const pageCards = completeCardNames(detection.cards, Object.values(stockMap), deck.cards);
    if (!detection.reliable) {
      // Écarts entre la liste détectée (non fiable) et le montage : aide à
      // comprendre d'où vient l'erreur de détection (doublons, quantités mal
      // lues...).
      const suspect = pageCards.length > 0 ? computeDeckDiff(deck.cards, pageCards) : [];
      changesEl.innerHTML =
        '<p class="msm-card-count">Impossible de vérifier si la liste a changé depuis le montage : ' +
        `${escapeHtml(unreliableListMessage(detection))}</p>` +
        (suspect.length > 0
          ? `<details class="msm-card-count"><summary>Voir ce qui a été détecté (${suspect.length} écart(s) avec le montage)</summary>` +
            `${renderDeckDiff(suspect)}</details>`
          : "");
      return null;
    }
    const scraped = pageCards;
    const changes = computeDeckDiff(deck.cards, scraped);
    const since = formatDay(deck.updatedAt || deck.builtAt);
    if (changes.length === 0) {
      changesEl.innerHTML = `<p class="msm-card-count">✅ La liste n'a pas changé depuis le montage (${since}).</p>`;
      return null;
    }

    lastWrongEditionNames = buildWrongEditionSet(scraped);
    const check = evaluateDeckUpdate(changes, deck, stockMap);
    changesEl.innerHTML =
      '<div class="msm-changes">' +
      `<strong>La liste a changé sur Moxfield depuis le montage (${since}) :</strong>` +
      renderDeckDiff(changes) +
      "<p>« Mettre à jour le montage » ajuste le stock pour ces seules cartes.</p></div>";
    renderShortageWarning(overlay.querySelector("#msm-shortage-warning"), check.shortages, deckUsage);
    renderPrintingWarning(overlay.querySelector("#msm-printing-warning"), check.wrongEdition);
    renderBasicLandNotice(overlay.querySelector("#msm-basic-land-warning"), check.basicWrongEdition, check.basicShortages);

    const updateBtn = overlay.querySelector("#msm-update");
    updateBtn.hidden = false;
    updateBtn.disabled = check.blocked;
    if (check.blocked) updateBtn.title = "Stock insuffisant ou version différente : corrige d'abord (voir ci-dessus).";
    overlay.querySelector("#msm-confirm").classList.remove("msm-primary");
    return scraped.map(({ name, qty }) => ({ name, qty }));
  }

  function buildOverlay({ isBuilt }) {
    const overlay = document.createElement("div");
    overlay.className = "msm-overlay";
    overlay.innerHTML = `
      <div class="msm-modal">
        <h3>${isBuilt ? "Démonter ce deck" : "Marquer ce deck comme monté physiquement"}</h3>
        ${
          isBuilt
            ? `<p>Ce deck est actuellement marqué comme monté. Le démonter réincrémentera le stock des cartes qu'il utilise.</p>
               <div id="msm-deck-changes"></div>
               <div id="msm-printing-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-shortage-warning" class="msm-shortage-warning" style="display:none"></div>
               <div id="msm-basic-land-warning" class="msm-info-warning" style="display:none"></div>`
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
          ${isBuilt ? '<button id="msm-update" class="msm-primary" hidden>Mettre à jour le montage</button>' : ""}
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

  // Dernier état connu du deck (monté ou non), gardé pour pouvoir redessiner
  // le bouton sans relire le stockage quand il est recréé (passage barre ↔
  // flottant, ou barre re-rendue par React qui a effacé notre bouton).
  let btnBuilt = false;

  // Deck monté dont la liste a changé sur Moxfield depuis le montage (cf.
  // computeDeckDiff) : réévalué régulièrement tant qu'on reste sur la page,
  // car le deck peut être modifié sur place, sans navigation.
  let btnOutdated = false;
  let lastOutdatedCheck = 0;
  let outdatedCheckRunning = false;
  let unreliableChecks = 0;
  const OUTDATED_CHECK_INTERVAL_MS = 3000;

  async function checkDeckOutdated(deckId) {
    if (!btnBuilt || outdatedCheckRunning || document.querySelector(".msm-overlay")) return;
    if (Date.now() - lastOutdatedCheck < OUTDATED_CHECK_INTERVAL_MS) return;
    outdatedCheckRunning = true;
    lastOutdatedCheck = Date.now();
    try {
      const detection = scrapeDeckListWithCheck();
      if (!detection.reliable) {
        // Un bref passage non fiable (liste en cours d'affichage) garde
        // l'état précédent pour éviter un clignotement ; au-delà, on ne sait
        // plus si le deck a changé et on retire la pastille plutôt que de
        // signaler à tort une modification.
        unreliableChecks++;
        if (unreliableChecks >= 2 && btnOutdated && deckId === currentDeckId) {
          btnOutdated = false;
          renderButton();
        }
        return;
      }
      unreliableChecks = 0;
      // Pas safeSendMessage : après un rechargement de l'extension, ce
      // contrôle en fond afficherait son toast toutes les 3 secondes.
      const res = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      const deck = res && res.ok ? res.state.builtDecks[deckId] : null;
      const scraped = deck
        ? completeCardNames(detection.cards, Object.values(res.state.stock || {}), deck.cards)
        : [];
      const outdated = Boolean(deck) && computeDeckDiff(deck.cards, scraped).length > 0;
      if (deckId === currentDeckId && outdated !== btnOutdated) {
        btnOutdated = outdated;
        renderButton();
      }
    } catch (e) {
      // contexte d'extension invalidé : l'utilisateur sera prévenu à son prochain clic
    } finally {
      outdatedCheckRunning = false;
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
    const label = !btnBuilt
      ? "Marquer comme monté physiquement"
      : outdated
        ? "Monté physiquement — la liste a changé depuis le montage (cliquer pour mettre à jour)"
        : "Monté physiquement (cliquer pour démonter)";
    if (btn.dataset.mode === "bar") {
      btn.replaceChildren(createBarIcon(btnBuilt ? "built" : "build"));
      btn.title = label;
      btn.setAttribute("aria-label", label);
    } else {
      btn.textContent = (outdated ? "⚠️ " : btnBuilt ? "✅ " : "🧰 ") + label;
    }
    btn.classList.toggle("msm-btn-built", btnBuilt);
    btn.classList.toggle("msm-btn-outdated", outdated);
  }

  async function refreshButtonState(deckId) {
    if (!btn) return;
    btnBuilt = await getIsBuilt(deckId);
    if (!btnBuilt) btnOutdated = false;
    lastOutdatedCheck = 0; // réévaluer tout de suite au prochain tick
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
        // Une seule lecture de l'état, réutilisée pour toutes les zones.
        const { stockMap, deckUsage } = await getStockAndDeckUsage();
        renderShortageWarning(warningEl, computeShortages(nonBasicCards, stockMap), deckUsage);
        renderPrintingWarning(printingWarningEl, computeWrongEditionCards(nonBasicCards, stockMap));
        renderBasicLandNotice(
          basicLandWarningEl,
          computeWrongEditionCards(basicCards, stockMap),
          computeShortages(basicCards, stockMap)
        );
      };

      // Scraping DOM de la page (méthode adaptée à la vue active).
      const guessed = completeCardNames(scrapeCardsGuess(), Object.values(await getStockMap()));
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

    if (updatedCards) {
      overlay.querySelector("#msm-update").addEventListener("click", async () => {
        try {
          // Revérifié au clic : le stock a pu changer entre-temps (synchro
          // Drive, autre onglet).
          const { stockMap, builtDecks } = await getStockAndDeckUsage(deckId);
          const deck = builtDecks[deckId];
          if (!deck) throw new Error("Ce deck n'est plus marqué comme monté.");
          if (evaluateDeckUpdate(computeDeckDiff(deck.cards, updatedCards), deck, stockMap).blocked) {
            toast("Mise à jour impossible — stock insuffisant ou version différente.", true);
            return;
          }
          const payload = { deckId, deckName: getDeckName(), url: window.location.href, cards: updatedCards };
          const res = await safeSendMessage({ type: "UPDATE_BUILT_DECK", payload });
          if (res.error === "extension-context-invalidated") return; // toast déjà affiché par safeSendMessage
          if (!res.ok) throw new Error(res.error || "Erreur inconnue");
          overlay.remove();
          btnOutdated = false;
          await refreshButtonState(deckId);
          toast("Montage mis à jour, stock ajusté pour les cartes modifiées.");
        } catch (e) {
          toast("Erreur : " + e.message, true);
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
        unreliableChecks = 0;
        await refreshButtonState(deckId);
      }
      checkDeckOutdated(deckId);
    } else {
      currentDeckId = null;
      btnBuilt = false;
      btnOutdated = false;
      removeButton();
    }
  }

  // Polling léger (voir en-tête du fichier) : sert à la fois à détecter les
  // changements d'URL de la SPA et à réévaluer le badge "Commander" tant
  // qu'on reste sur la même page (cf. commentaire de syncButtonToLocation).
  setInterval(syncButtonToLocation, 500);

  syncButtonToLocation();
})();
