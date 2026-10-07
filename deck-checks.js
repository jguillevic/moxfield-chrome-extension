// deck-checks.js — contrôles d'une liste de cartes par rapport au stock
// (stock insuffisant, version différente, terrains de base, faisabilité).
//
// Chargé avant content-deck.js (cf. manifest.json), et par les tests Node
// (tests/). Aucun accès à la page ni à l'extension : uniquement des calculs
// sur des listes de cartes et le stock.

function createDeckChecks(normalizeName) {
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
  // deck, que la mise à jour lui rend d'abord.
  function evaluateDeckUpdate(changes, deck, stockMap, wrongEditionNames) {
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
      wrongEdition: computeWrongEditionCards(nonBasic, available, wrongEditionNames),
      basicShortages: computeShortages(basic, available),
      basicWrongEdition: computeWrongEditionCards(basic, available, wrongEditionNames),
    };
    check.blocked = check.shortages.length > 0 || check.wrongEdition.length > 0;
    return check;
  }

  // Faisabilité d'un deck pas encore monté : mêmes contrôles qu'au montage,
  // faits en fond sur la liste de la page pour afficher sur le bouton, sans
  // ouvrir la fenêtre, si le deck est montable avec le stock libre.
  // "blocking" : exemplaires qui bloqueraient le montage (stock insuffisant
  // ou version différente) ; "total" et "available" : exemplaires du deck et
  // ceux utilisables tels quels. Le tout hors terrains de base, qui ne font
  // jamais qu'un avertissement (basicShortages).
  // wrongEditionNames : à donner quand la liste ne porte pas elle-même
  // l'information de version (liste modifiée à la main dans la fenêtre).
  function computeDeckAvailability(cards, stockMap, wrongEditionNames = buildWrongEditionSet(cards)) {
    const basic = cards.filter((c) => isBasicLand(c.name));
    const nonBasic = cards.filter((c) => !isBasicLand(c.name));
    const shortages = computeShortages(nonBasic, stockMap);
    const wrongEdition = nonBasic.filter((c) =>
      computeWrongEditionCards([c], stockMap, wrongEditionNames).length > 0
    );
    const basicShortages = computeShortages(basic, stockMap);
    const sum = (list, field) => list.reduce((n, c) => n + c[field], 0);
    const total = sum(nonBasic, "qty");
    const missingCount = sum(shortages, "missing");
    const wrongEditionCount = sum(wrongEdition, "qty");
    const blocking = missingCount + wrongEditionCount;
    return {
      total,
      available: total - blocking,
      blocking,
      missingCount,
      wrongEditionCount,
      shortages: shortages.map(({ name, missing }) => ({ name, missing })),
      wrongEdition: wrongEdition.map((c) => c.name),
      basicShortages: basicShortages.map(({ name, missing }) => ({ name, missing })),
    };
  }

  // Nombre affiché sur la pastille du bouton, avec sa décomposition — repris
  // tel quel dans la fenêtre de montage pour que les deux concordent.
  // null si rien ne bloque.
  function blockingSummary(a) {
    if (a.blocking === 0) return null;
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const reasons = [];
    if (a.missingCount > 0) reasons.push(`${plural(a.missingCount, "manquante")} en stock`);
    if (a.wrongEditionCount > 0) reasons.push(`${a.wrongEditionCount} dans une autre version`);
    const verb = a.blocking === 1 ? "bloque" : "bloquent";
    return `${plural(a.blocking, "carte")} ${verb} le montage : ${reasons.join(", ")}`;
  }

  // Détail de la faisabilité, affiché au survol du bouton.
  function availabilityLabel(a) {
    const MAX_NAMES = 8;
    const list = (items) =>
      items.slice(0, MAX_NAMES).join(", ") + (items.length > MAX_NAMES ? `, … (+${items.length - MAX_NAMES})` : "");
    const disponibles = `${a.available}/${a.total} cartes disponibles en stock libre, hors terrains de base`;
    const parts = [a.blocking === 0 ? `montable : ${disponibles}` : `${blockingSummary(a)} (${disponibles})`];
    if (a.shortages.length > 0) parts.push("manque " + list(a.shortages.map((s) => `${s.name} (${s.missing})`)));
    if (a.wrongEdition.length > 0) parts.push("version différente : " + list(a.wrongEdition));
    if (a.basicShortages.length > 0) {
      parts.push("terrains de base manquants (non bloquant) : " + list(a.basicShortages.map((s) => `${s.name} (${s.missing})`)));
    }
    return parts.join(" — ");
  }

  return {
    isBasicLand,
    buildWrongEditionSet,
    computeWrongEditionCards,
    computeShortages,
    parseCardsText,
    evaluateDeckUpdate,
    computeDeckAvailability,
    blockingSummary,
    availabilityLabel,
  };
}

if (typeof module !== "undefined") module.exports = { createDeckChecks };
