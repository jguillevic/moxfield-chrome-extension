// deck-scraper.js — lecture de la liste d'un deck sur la page Moxfield.
//
// Chargé avant content-deck.js (cf. manifest.json), et par les tests Node
// (tests/), d'où la fabrique paramétrée par la fenêtre : `window` dans
// l'extension, une fenêtre jsdom dans les tests.

function createDeckScraper(win) {
  const document = win.document;

  function normalizeName(name) {
    return name.trim().toLowerCase().replace(/\s+/g, " ");
  }

  // Filtre de visibilité : Moxfield semble garder en mémoire le DOM d'une
  // vue précédente (Text/Visual/...) en le cachant plutôt que de le détruire
  // quand on change de mode d'affichage. `offsetParent` seul ne suffit pas
  // (un élément en `visibility: hidden` le garde) — on vérifie aussi la
  // taille réelle et les propriétés CSS de visibilité.
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const cs = win.getComputedStyle(el);
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
  // "legal-<code>" (impression, suffixe "F0" si foil) : Moxfield regroupe
  // toujours une même impression en une seule entrée, et un deck Commander
  // n'a jamais la même impression dans deux zones. La zone du deck (lue
  // dans le marqueur de collection) n'y figure plus : les tuiles périmées
  // n'ont pas toujours ce marqueur, et la clé différait alors de celle de
  // la vraie tuile (163 cartes à nouveau, réglé par un F5).
  function slotStableKey(wrapperId) {
    return wrapperId.replace(/^id\d+-/, "");
  }

  // oneTilePerCopy : vue "Visual Stacks (Split)", où chaque exemplaire a sa
  // propre tuile (3 tuiles pour une carte en 3 exemplaires, sans badge de
  // quantité). Le dédoublonnage par impression (slotStableKey) y fusionnerait
  // les exemplaires : on garde l'id complet, un par tuile. Un éventuel
  // doublon périmé fausserait alors le total, ce que le contrôle par rapport
  // au total Moxfield signale.
  function scrapeCardsFromImages(oneTilePerCopy = false) {
    const imgs = Array.from(document.querySelectorAll("img.img-card[alt]")).filter(isVisible);
    // Une entrée par tuile retenue. Entre deux tuiles d'une même entrée, on
    // garde celle qui porte le marqueur de collection : c'est la tuile à
    // jour, la périmée pouvant en être dépourvue (et avoir une quantité
    // obsolète).
    const tiles = new Map();
    imgs.forEach((img) => {
      const name = (img.getAttribute("alt") || "").trim();
      if (!name) return;
      if (FLIP_ICON_ALT_BLOCKLIST.has(name.toLowerCase())) return;
      const wrapperId = slotWrapperId(img);
      if (!wrapperId) return; // pas une vraie tuile de deck (ex. aperçu au survol) : ignorée
      const slot = findSlotContainer(img);
      const slotKey = oneTilePerCopy ? wrapperId : slotStableKey(wrapperId);
      // Marqueur cherché sur la tuile elle-même (parent du conteneur d'image),
      // pas dans `slot` : faute de marqueur propre, findSlotContainer remonte
      // jusqu'à un ancêtre qui contient celui d'une AUTRE carte.
      const tile = img.parentElement.parentElement;
      const hasMarker = Boolean(tile && tile.querySelector('[id^="collection_"]'));
      const previous = tiles.get(slotKey);
      if (previous && (previous.hasMarker || !hasMarker)) return; // doublon DOM périmé : ignoré
      tiles.set(slotKey, {
        name,
        qty: findQtyNear(img, slot),
        printingStatus: slot ? findCollectionStatusNear(img, slot) : "unknown",
        hasMarker,
      });
    });
    const seen = new Map();
    for (const { name, qty, printingStatus } of tiles.values()) {
      const key = name.toLowerCase();
      if (seen.has(key)) seen.get(key).qty += qty;
      else seen.set(key, { name, qty, printingStatus });
    }
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

  // --- Comparaison de listes (deck monté / page) ---
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

  return {
    normalizeName,
    scrapeCardsFromList,
    scrapeCardsFromImages,
    scrapeCardsFromDecklistCards,
    scrapeCardsGuess,
    getSiteDeclaredTotal,
    frontFaceKey,
    completeCardNames,
    computeDeckDiff,
  };
}

if (typeof module !== "undefined") module.exports = { createDeckScraper };
