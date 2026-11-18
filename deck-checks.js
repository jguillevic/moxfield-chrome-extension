// deck-checks.js — contrôles d'une liste de cartes par rapport au stock
// (stock insuffisant, version différente, version déjà utilisée par un autre
// deck monté, terrains de base, faisabilité).
//
// Chargé avant content-deck.js (cf. manifest.json), et par les tests Node
// (tests/). Aucun accès à la page ni à l'extension : uniquement des calculs
// sur des listes de cartes et le stock.

// i18n : textes traduits (cf. i18n.js).
function createDeckChecks(normalizeName, { t, tn }) {
  // Terrains de base : en pratique tu en as (presque) toujours assez, et
  // l'édition n'a jamais d'importance pour eux. On ne bloque donc jamais le
  // montage à cause d'un terrain de base (ni "version différente", ni
  // "stock insuffisant") — juste un avertissement non bloquant séparé.
  const BASIC_LAND_NAMES = new Set(["plains", "island", "swamp", "mountain", "forest"]);

  function isBasicLand(name) {
    return BASIC_LAND_NAMES.has(normalizeName(name));
  }

  // Cartes que Moxfield indique comme présentes dans ta collection, mais
  // pas dans la version utilisée par ce deck ("collection_pt_...", aria-label
  // "Partially in collection" — confirmé via inspection DOM réelle, ex. Sol
  // Ring possédé sous une autre édition). Calculé à partir du scraping DOM ;
  // vide si la liste vient du presse-papiers (pas d'info disponible dans du
  // texte brut collé).
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
  function computeWrongEditionCards(cards, stockMap, wrongEditionNames) {
    const names = [];
    for (const c of cards) {
      const key = normalizeName(c.name);
      const have = stockMap[key] ? stockMap[key].qty : 0;
      if (have >= c.qty && wrongEditionNames.has(key)) names.push(c.name);
    }
    return names;
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

  // --- Version déjà utilisée par un autre deck monté ---
  // Le stock est suivi par nom, mais une carte possédée en plusieurs
  // éditions peut être demandée deux fois dans la MÊME version : Moxfield
  // l'indique alors comme possédée sur les deux decks, et le stock par nom
  // dit qu'il reste un exemplaire (cas constaté : un terrain possédé en x1
  // dans deux éditions, monté deux fois dans la même).
  //
  // Les deux côtés ne parlent pas la même langue : la page d'un deck donne
  // le code Moxfield de l'impression (cf. ownedVersionOf dans
  // deck-scraper.js), la collection une édition et un numéro (cf.
  // parseCollectionCSV dans background.js : entrée de stock
  // { printings: [{ set, cn, qty }] } quand la carte est possédée en
  // plusieurs éditions).
  //
  // Contrôle exact : l'API du deck relie les deux (cf. extractDeckPrintings
  // dans moxfield-collection.js), et une version porte alors son édition et
  // son numéro ({ code, qty, set, cn }). Chaque édition est comptée à part :
  // refus si les autres decks montés et celui-ci en demandent plus
  // d'exemplaires que possédés.
  //
  // Repli par recoupement, dès qu'une des versions concernées n'a pas son
  // édition (API pas lue : pas connecté, deck monté avant, réponse
  // changée) ou ne se retrouve pas dans la collection : on sait seulement
  // que chaque version possédée d'un deck est UNE des éditions de la
  // collection. Les versions utilisées par les decks montés doivent donc
  // pouvoir se répartir sur des éditions distinctes, sans dépasser la
  // quantité de chacune. Limite du repli : avec des éditions en quantités
  // inégales (x2 et x1), on ne sait pas laquelle est demandée — le doute
  // profite au montage.

  // Versions prises par les decks montés, par carte (nom normalisé) :
  // Map → [{ code, qty, deck, set?, cn? }]. excludeDeckId : deck à ignorer
  // (celui qu'on met à jour, dont les cartes lui reviennent). Les cartes
  // excludedFromStock n'ont jamais été retirées du stock.
  function buildVersionUsage(builtDecks, excludeDeckId = null) {
    const usage = new Map();
    for (const [deckId, deck] of Object.entries(builtDecks)) {
      if (deckId === excludeDeckId) continue;
      for (const card of deck.cards || []) {
        if (card.excludedFromStock) continue;
        for (const v of card.versions || []) {
          const key = normalizeName(card.name);
          if (!usage.has(key)) usage.set(key, []);
          const use = { code: v.code, qty: v.qty, deck: deck.name };
          usage.get(key).push(v.set ? { ...use, set: v.set, cn: v.cn || "" } : use);
        }
      }
    }
    return usage;
  }

  // Exemplaires qui ne tiennent pas dans les éditions possédées : la version
  // la plus utilisée est rapprochée de l'édition la plus fournie, et ainsi de
  // suite (répartition la plus favorable).
  function versionOverflow(usedByCode, printings) {
    const used = [...usedByCode.values()].sort((a, b) => b - a);
    const owned = printings.map((p) => p.qty).sort((a, b) => b - a);
    return used.reduce((n, qty, i) => n + Math.max(0, qty - (owned[i] || 0)), 0);
  }

  // Édition de la collection d'une version dont l'API a donné l'édition,
  // undefined sinon.
  function printingOf(version, printings) {
    return printings.find((p) => p.set === version.set && p.cn === (version.cn || ""));
  }

  // Contrôle exact : autres decks (others) qui tiennent une édition demandée
  // en trop ([] si tout tient), ou null si une version n'a pas d'édition
  // connue — à l'appelant de se replier sur le recoupement.
  function exactVersionConflict(versions, others, printings) {
    const used = new Map();
    for (const o of others) {
      const printing = printingOf(o, printings);
      if (!printing) return null;
      used.set(printing, (used.get(printing) || 0) + o.qty);
    }
    const asked = new Map();
    for (const v of versions) {
      const printing = printingOf(v, printings);
      if (!printing) return null;
      asked.set(printing, (asked.get(printing) || 0) + v.qty);
    }
    const taken = [...asked].filter(([printing, qty]) => (used.get(printing) || 0) + qty > printing.qty).map(([printing]) => printing);
    if (taken.length === 0) return [];
    // Une édition demandée au-delà de ce qui est possédé sans qu'aucun autre
    // deck la tienne : incohérence entre la page et la collection (pas
    // encore récupérée ?), pas une version « déjà utilisée ».
    return others.filter((o) => taken.includes(printingOf(o, printings)));
  }

  // Cartes (avec leurs versions lues sur la page) dont la version est déjà
  // prise par d'autres decks montés : [{ name, qty, decks: [{ name, qty }],
  // owned: [{ set, cn, qty }] }]. Priorité au stock et à la version
  // différente : on ne regarde que les cartes que rien d'autre ne bloque.
  function computeVersionConflicts(cards, stockMap, versionUsage, wrongEditionNames = new Set()) {
    const conflicts = [];
    for (const c of cards) {
      const key = normalizeName(c.name);
      const entry = stockMap[key];
      if (!c.versions || c.versions.length === 0 || !entry || !entry.printings) continue;
      if (entry.qty < c.qty || wrongEditionNames.has(key)) continue;
      const others = versionUsage.get(key) || [];
      const exact = exactVersionConflict(c.versions, others, entry.printings);
      if (exact) {
        if (exact.length > 0) {
          conflicts.push({ name: c.name, qty: c.qty, decks: exact.map((o) => ({ name: o.deck, qty: o.qty })), owned: entry.printings });
        }
        continue;
      }
      const used = new Map();
      for (const o of others) used.set(o.code, (used.get(o.code) || 0) + o.qty);
      const before = versionOverflow(used, entry.printings);
      for (const v of c.versions) used.set(v.code, (used.get(v.code) || 0) + v.qty);
      if (versionOverflow(used, entry.printings) <= before) continue;
      conflicts.push({
        name: c.name,
        qty: c.qty,
        decks: others.filter((o) => c.versions.some((v) => v.code === o.code)).map((o) => ({ name: o.deck, qty: o.qty })),
        owned: entry.printings,
      });
    }
    return conflicts;
  }

  // Liste saisie ou collée dans la fenêtre de montage : une carte par ligne,
  // "QTE Nom" (ou "QTEx Nom"), lignes vides et commentaires "//" ignorés.
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

  // Vérifications avant la mise à jour d'un deck monté, sur les seules
  // cartes ajoutées ou en plus grand nombre (mêmes règles qu'au montage).
  // Le stock disponible pour elles inclut les exemplaires déjà pris par ce
  // deck, que la mise à jour lui rend d'abord. Une carte dont seule la
  // version a changé est vérifiée aussi.
  // pageCards : nouvelle liste (pour ses versions) ; versionUsage : versions
  // prises par les AUTRES decks montés (cf. buildVersionUsage).
  function evaluateDeckUpdate(changes, deck, stockMap, wrongEditionNames, pageCards = [], versionUsage = new Map()) {
    const available = {};
    for (const [key, c] of Object.entries(stockMap)) available[key] = { ...c };
    for (const c of deck.cards) {
      if (c.excludedFromStock) continue;
      const key = normalizeName(c.name);
      if (!available[key]) available[key] = { name: c.name, qty: 0 };
      available[key].qty += c.qty;
    }
    const versionsOf = new Map(pageCards.map((c) => [normalizeName(c.name), c.versions]));
    const increased = changes
      .filter((c) => c.to > c.from || c.version)
      .map((c) => ({ name: c.name, qty: c.to, versions: versionsOf.get(normalizeName(c.name)) }));
    const basic = increased.filter((c) => isBasicLand(c.name));
    const nonBasic = increased.filter((c) => !isBasicLand(c.name));
    const check = {
      shortages: computeShortages(nonBasic, available),
      wrongEdition: computeWrongEditionCards(nonBasic, available, wrongEditionNames),
      basicShortages: computeShortages(basic, available),
      basicWrongEdition: computeWrongEditionCards(basic, available, wrongEditionNames),
      versionTaken: computeVersionConflicts(nonBasic, available, versionUsage, wrongEditionNames),
    };
    check.blocked = check.shortages.length > 0 || check.wrongEdition.length > 0 || check.versionTaken.length > 0;
    return check;
  }

  // Faisabilité d'un deck pas encore monté : mêmes contrôles qu'au montage,
  // faits en fond sur la liste de la page pour afficher sur le bouton, sans
  // ouvrir la fenêtre, si le deck est montable avec le stock libre.
  // "blocking" : exemplaires qui bloqueraient le montage (stock insuffisant,
  // version différente ou déjà utilisée par un autre deck monté) ; "total" et "available" : exemplaires du deck et
  // ceux utilisables tels quels. Le tout hors terrains de base, qui ne font
  // jamais qu'un avertissement (basicShortages).
  // wrongEditionNames : à donner quand la liste ne porte pas elle-même
  // l'information de version (liste modifiée à la main dans la fenêtre).
  // versionUsage : versions prises par les decks montés (cf. buildVersionUsage).
  function computeDeckAvailability(cards, stockMap, wrongEditionNames = buildWrongEditionSet(cards), versionUsage = new Map()) {
    const basic = cards.filter((c) => isBasicLand(c.name));
    const nonBasic = cards.filter((c) => !isBasicLand(c.name));
    const shortages = computeShortages(nonBasic, stockMap);
    const wrongEdition = nonBasic.filter((c) =>
      computeWrongEditionCards([c], stockMap, wrongEditionNames).length > 0
    );
    const versionTaken = computeVersionConflicts(nonBasic, stockMap, versionUsage, wrongEditionNames);
    const basicShortages = computeShortages(basic, stockMap);
    const sum = (list, field) => list.reduce((n, c) => n + c[field], 0);
    const total = sum(nonBasic, "qty");
    const missingCount = sum(shortages, "missing");
    const wrongEditionCount = sum(wrongEdition, "qty");
    const versionTakenCount = sum(versionTaken, "qty");
    const blocking = missingCount + wrongEditionCount + versionTakenCount;
    return {
      total,
      available: total - blocking,
      blocking,
      missingCount,
      wrongEditionCount,
      versionTakenCount,
      shortages: shortages.map(({ name, missing }) => ({ name, missing })),
      wrongEdition: wrongEdition.map((c) => c.name),
      versionTaken: versionTaken.map((c) => c.name),
      basicShortages: basicShortages.map(({ name, missing }) => ({ name, missing })),
    };
  }

  // Nombre affiché sur la pastille du bouton, avec sa décomposition — repris
  // tel quel dans la fenêtre de montage pour que les deux concordent.
  // null si rien ne bloque.
  function blockingSummary(a) {
    if (a.blocking === 0) return null;
    const reasons = [];
    if (a.missingCount > 0) reasons.push(tn("blockingMissing", a.missingCount));
    if (a.wrongEditionCount > 0) reasons.push(tn("blockingWrongEdition", a.wrongEditionCount));
    if (a.versionTakenCount > 0) reasons.push(tn("blockingVersionTaken", a.versionTakenCount));
    return tn("blockingSummary", a.blocking, reasons.join(", "));
  }

  // Détail de la faisabilité, affiché au survol du bouton.
  function availabilityLabel(a) {
    const MAX_NAMES = 8;
    const list = (items) =>
      items.slice(0, MAX_NAMES).join(", ") + (items.length > MAX_NAMES ? `, … (+${items.length - MAX_NAMES})` : "");
    const available = t("availabilityCount", a.available, a.total);
    const parts = [a.blocking === 0 ? t("availabilityOk", available) : `${blockingSummary(a)} (${available})`];
    if (a.shortages.length > 0) parts.push(t("availabilityMissing", list(a.shortages.map((s) => `${s.name} (${s.missing})`))));
    if (a.wrongEdition.length > 0) parts.push(t("availabilityWrongEdition", list(a.wrongEdition)));
    if (a.versionTaken.length > 0) parts.push(t("availabilityVersionTaken", list(a.versionTaken)));
    if (a.basicShortages.length > 0) {
      parts.push(t("availabilityBasicMissing", list(a.basicShortages.map((s) => `${s.name} (${s.missing})`))));
    }
    return parts.join(" — ");
  }

  return {
    isBasicLand,
    buildWrongEditionSet,
    computeWrongEditionCards,
    computeShortages,
    buildVersionUsage,
    computeVersionConflicts,
    parseCardsText,
    evaluateDeckUpdate,
    computeDeckAvailability,
    blockingSummary,
    availabilityLabel,
  };
}

if (typeof module !== "undefined") module.exports = { createDeckChecks };
