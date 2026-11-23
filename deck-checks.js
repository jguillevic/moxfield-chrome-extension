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

  // Prix des cartes manquantes : prix unitaire de la version du deck (la
  // moins chère si le deck en utilise plusieurs) × quantité manquante.
  // codesByName : nom normalisé → codes des impressions du deck, possédées
  // ou non (cf. printingCodeOf dans deck-scraper.js) ; priceOfCode : code →
  // prix en euros, ou undefined (cf. extractDeckPrintings dans
  // moxfield-collection.js). Une carte sans code (liste collée) ou sans prix
  // n'est pas comptée : `unpriced` le dit, pour ne pas présenter un total
  // partiel comme complet. Calcul en centimes : pas d'erreur d'arrondi en
  // additionnant.
  // → { byName: Map nom normalisé → { unit, total }, total, unpriced }
  function computeShortagePrices(shortages, codesByName, priceOfCode) {
    const cents = (euros) => Math.round(euros * 100);
    const byName = new Map();
    let totalCents = 0;
    let unpriced = 0;
    for (const s of shortages) {
      const key = normalizeName(s.name);
      const prices = (codesByName.get(key) || []).map(priceOfCode).filter((p) => typeof p === "number");
      if (prices.length === 0) {
        unpriced++;
        continue;
      }
      const unitCents = cents(Math.min(...prices));
      byName.set(key, { unit: unitCents / 100, total: (unitCents * s.missing) / 100 });
      totalCents += unitCents * s.missing;
    }
    return { byName, total: totalCents / 100, unpriced };
  }

  // --- Proxies ---
  // Carte d'un deck monté : { name, qty, proxyQty?, proxyPrinting? } —
  // proxyQty exemplaires sont des proxies (cartes imprimées, cf.
  // proxies.html) : jamais pris au stock libre, ni rendus au démontage. La
  // collection Moxfield reste la seule source de vérité du stock : un proxy
  // n'en fait pas partie. proxyPrinting : { set, cn } de la version du deck,
  // pour imprimer la bonne image.

  // Exemplaires en proxy (proxyQty invalide : aucun).
  function proxyCountOf(card) {
    const n = card.proxyQty;
    return Number.isInteger(n) && n > 0 ? Math.min(n, card.qty) : 0;
  }

  // Exemplaires d'une carte d'un deck monté pris au stock libre. Un seul
  // calcul pour le montage, le démontage, la collection et le popup.
  function stockQtyOf(card) {
    return card.excludedFromStock ? 0 : card.qty - proxyCountOf(card);
  }

  // Proxies déclarés sur Moxfield (cf. declaredProxies dans
  // moxfield-collection.js : { nom: quantité }) appliqués à une liste du
  // deck : ces exemplaires sont des proxies d'office, en plus de ceux que la
  // carte a déjà. printingOf : comme pour addProxies.
  function applyDeclaredProxies(cards, declared, printingOf = () => null) {
    const byName = new Map(Object.entries(declared || {}).map(([name, qty]) => [normalizeName(name), qty]));
    if (byName.size === 0) return cards;
    return cards.map((c) => {
      const declaredQty = byName.get(normalizeName(c.name));
      if (!declaredQty || proxyCountOf(c) >= declaredQty) return c;
      const card = { ...c, proxyQty: Math.min(c.qty, declaredQty) };
      const printing = c.proxyPrinting || printingOf(c.name);
      if (printing) card.proxyPrinting = printing;
      return card;
    });
  }

  // Part d'une liste prise au stock (proxies retirés), sur laquelle portent
  // les contrôles : un proxy n'a besoin ni de stock, ni de la bonne édition
  // (cf. CLAUDE.md, Proxies). Versions gardées dans la limite de ce qui
  // reste ; carte entièrement en proxy écartée.
  function stockPartOf(cards) {
    const part = [];
    for (const c of cards) {
      const proxies = proxyCountOf(c);
      if (proxies === 0) {
        part.push(c);
        continue;
      }
      const qty = c.qty - proxies;
      if (qty <= 0) continue;
      const card = { ...c, qty };
      delete card.proxyQty;
      delete card.proxyPrinting;
      if (Array.isArray(c.versions)) {
        let left = qty;
        card.versions = c.versions
          .map((v) => {
            const take = Math.min(v.qty, left);
            left -= take;
            return { ...v, qty: take };
          })
          .filter((v) => v.qty > 0);
        if (card.versions.length === 0) delete card.versions;
      }
      part.push(card);
    }
    return part;
  }

  // Nombre total de proxies d'une liste de cartes.
  function proxyTotal(cards) {
    return cards.reduce((n, c) => n + proxyCountOf(c), 0);
  }

  // Liste dont les cartes en stock insuffisant reçoivent des proxies pour
  // les exemplaires manquants, en plus de ceux qu'elles ont déjà (mise à
  // jour d'un deck monté). printingOf : nom → { set, cn } de la version du
  // deck, ou null.
  function addProxies(cards, shortages, printingOf = () => null) {
    const missing = new Map(shortages.map((s) => [normalizeName(s.name), s.missing]));
    return cards.map((c) => {
      const extra = missing.get(normalizeName(c.name));
      if (!extra) return c;
      const card = { ...c, proxyQty: Math.min(c.qty, proxyCountOf(c) + extra) };
      const printing = c.proxyPrinting || printingOf(c.name);
      if (printing) card.proxyPrinting = printing;
      return card;
    });
  }

  // Mise à jour d'un deck monté : chaque carte garde ses proxies (dans la
  // limite de sa nouvelle quantité) — remplacer un proxy par la vraie carte
  // est une action à part (cf. replaceableProxies).
  function carryProxies(cards, previousCards) {
    const previous = new Map(previousCards.filter((c) => proxyCountOf(c) > 0).map((c) => [normalizeName(c.name), c]));
    return cards.map((c) => {
      const old = previous.get(normalizeName(c.name));
      if (!old) return c;
      const card = { ...c, proxyQty: Math.min(c.qty, proxyCountOf(old)) };
      if (old.proxyPrinting) card.proxyPrinting = old.proxyPrinting;
      return card;
    });
  }

  // Proxies d'un deck monté que le stock libre permet maintenant de
  // remplacer par la vraie carte (carte achetée, ajoutée à la collection
  // Moxfield) : [{ name, qty }]. Le même stock n'est pas compté deux fois
  // pour deux lignes du même nom.
  function replaceableProxies(deck, stock) {
    const free = new Map();
    const result = [];
    for (const card of deck.cards || []) {
      const proxies = card.excludedFromStock ? 0 : proxyCountOf(card);
      if (proxies === 0) continue;
      const key = normalizeName(card.name);
      if (!free.has(key)) free.set(key, stock[key] ? stock[key].qty : 0);
      const qty = Math.min(proxies, Math.max(0, free.get(key)));
      if (qty === 0) continue;
      free.set(key, free.get(key) - qty);
      result.push({ name: card.name, qty });
    }
    return result;
  }

  // --- Passer un deck sur les éditions de la collection ---
  // Carte possédée dans une autre édition que celle du deck : plutôt que de
  // monter le deck en laissant croire, sur Moxfield, que tu as cette
  // édition, le deck est passé sur une édition que tu possèdes. Choix : celle
  // dont il reste le plus d'exemplaires que les autres decks montés ne
  // tiennent pas, puis la plus fournie. owned : [{ set, cn, qty, finishes? }]
  // (cf. collectionEditions dans background.js) ; current : { set, cn,
  // finish? } de la carte dans le deck ; others : versions prises par les
  // autres decks (cf. buildVersionUsage), seules celles d'édition connue
  // comptent. Renvoie { set, cn, finish? } ; null si tu n'as ni autre
  // édition ni autre finition.
  //
  // Finition : Moxfield signale aussi une carte possédée dans l'édition du
  // deck mais pas dans sa finition (ex. possédée en foil, le deck demande la
  // non-foil — constaté en vrai, novembre 2026). Elle passe alors sur la
  // finition possédée, sans changer d'édition, en priorité : c'est
  // l'exemplaire exact que tu as.
  //
  // Foil d'abord (demande de l'utilisateur) : un exemplaire foil possédé est
  // choisi même si tu as aussi la finition du deck ; sinon la finition du
  // deck est gardée si tu l'as, sinon la plus fournie. Entre éditions
  // également libres, celle que tu as en foil passe devant.
  //
  // Quantité (current.quantity, 1 par défaut) : Moxfield ne tient une carte
  // pour possédée que si tu en as autant d'exemplaires que le deck dans
  // cette édition (et cette finition). Une édition qui n'en couvre qu'une
  // partie n'est jamais choisie : la carte resterait signalée, et chaque
  // clic la ferait passer d'une édition à l'autre (constaté en vrai sur les
  // terrains de base, novembre 2026 : 11 Plains réparties sur plusieurs
  // éditions).
  const ownsFoil = (p) => Boolean(p.finishes && p.finishes.foil > 0);

  function chooseOwnedEdition(owned, current, others = []) {
    const needed = Math.max(1, Number.isInteger(current.quantity) ? current.quantity : 1);
    // Finition à demander, undefined pour garder celle du deck. Seules
    // comptent les finitions possédées en assez d'exemplaires.
    const ownedFinish = (p) => {
      const finishes = Object.keys(p.finishes || {}).filter((f) => p.finishes[f] >= needed);
      if (finishes.includes("foil")) return current.finish === "foil" ? undefined : "foil";
      if (finishes.length === 0 || finishes.includes(current.finish)) return undefined;
      return finishes.sort((a, b) => p.finishes[b] - p.finishes[a] || a.localeCompare(b))[0];
    };
    // Exemplaires libres : possédés, moins ceux que les autres decks montés
    // tiennent dans cette édition. Une édition sans assez d'exemplaires
    // libres n'est jamais choisie : le deck pointerait vers des cartes déjà
    // ailleurs (constaté en vrai, novembre 2026 : une Chaos Warp déjà dans
    // un autre deck monté). Les versions d'édition inconnue ne comptent pas
    // (dans le doute, on laisse faire).
    const used = (p) => others.filter((o) => o.set === p.set && (o.cn || "") === p.cn).reduce((n, o) => n + o.qty, 0);
    const free = (p) => p.qty - used(p);
    const same = owned.find((p) => p.set === current.set && p.cn === current.cn);
    if (same && current.finish && free(same) >= needed) {
      const finish = ownedFinish(same);
      if (finish) return { set: same.set, cn: same.cn, finish };
    }
    const candidates = owned
      .filter((p) => !(p.set === current.set && p.cn === current.cn) && p.qty >= needed && free(p) >= needed)
      .map((p) => ({ ...p, free: free(p) }));
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => b.free - a.free || ownsFoil(b) - ownsFoil(a) || b.qty - a.qty || a.set.localeCompare(b.set) || a.cn.localeCompare(b.cn)
    );
    const best = candidates[0];
    const finish = current.finish ? ownedFinish(best) : undefined;
    return finish ? { set: best.set, cn: best.cn, finish } : { set: best.set, cn: best.cn };
  }

  // Pourquoi aucune édition ne convient (chooseOwnedEdition a rendu null),
  // de la raison la plus précise à la plus générale : une édition
  // conviendrait sans les autres decks montés ("taken"), ou en ne demandant
  // qu'un exemplaire ("not-enough"), ou aucune ("no-other-edition").
  function ownedEditionSkipReason(owned, current) {
    if (chooseOwnedEdition(owned, current)) return "taken";
    return chooseOwnedEdition(owned, { ...current, quantity: 1 }) ? "not-enough" : "no-other-edition";
  }

  // Prévision pour la page du deck, avant tout clic : raison pour laquelle
  // « Utiliser mes éditions » ne pourra pas changer la carte, ou null
  // (possible, ou impossible à dire). owned : éditions du stock
  // ({ set, cn, qty }, sans les finitions, que l'état ne garde pas). Dans
  // le doute, null, et le clic tranchera avec la collection fraîche :
  // - collection sans éditions (ancien import) ;
  // - édition du deck possédée : Moxfield signale alors une autre finition,
  //   qu'on ne peut pas juger ici.
  function predictEditionBlock(owned, current, others = []) {
    if (!Array.isArray(owned) || owned.length === 0) return null;
    if (owned.some((p) => p.set === current.set && p.cn === current.cn)) return null;
    if (chooseOwnedEdition(owned, current, others)) return null;
    return ownedEditionSkipReason(owned, current);
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
  // { printings: [{ set, cn, qty }] }).
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
  // excludedFromStock n'ont jamais été retirées du stock. Un proxy ne tient
  // aucun exemplaire : il est d'abord compté sur les exemplaires sans
  // version possédée (versions : seulement celles possédées, cf.
  // ownedVersionOf), puis retiré des versions.
  function buildVersionUsage(builtDecks, excludeDeckId = null) {
    const usage = new Map();
    for (const [deckId, deck] of Object.entries(builtDecks)) {
      if (deckId === excludeDeckId) continue;
      for (const card of deck.cards || []) {
        if (card.excludedFromStock) continue;
        const versions = card.versions || [];
        const unversioned = card.qty - versions.reduce((n, v) => n + v.qty, 0);
        let proxies = Math.max(0, proxyCountOf(card) - Math.max(0, unversioned));
        for (const v of versions) {
          const qty = v.qty - Math.min(proxies, v.qty);
          proxies -= v.qty - qty;
          if (qty <= 0) continue;
          const key = normalizeName(card.name);
          if (!usage.has(key)) usage.set(key, []);
          const use = { code: v.code, qty, deck: deck.name };
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
      // Une seule édition possédée : le stock par nom suffit. Le recoupement
      // y verrait même des conflits qui n'en sont pas (un exemplaire foil et
      // un non foil de la même édition ont deux codes Moxfield).
      if (!c.versions || c.versions.length === 0 || !entry || !entry.printings || entry.printings.length < 2) continue;
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
  // Les proxies d'une carte lui restent (cf. carryProxies) : seuls les
  // autres exemplaires sont à prendre au stock.
  function evaluateDeckUpdate(changes, deck, stockMap, wrongEditionNames, pageCards = [], versionUsage = new Map()) {
    const available = {};
    for (const [key, c] of Object.entries(stockMap)) available[key] = { ...c };
    const proxies = new Map();
    for (const c of deck.cards) {
      const key = normalizeName(c.name);
      proxies.set(key, (proxies.get(key) || 0) + proxyCountOf(c));
      if (stockQtyOf(c) === 0) continue;
      if (!available[key]) available[key] = { name: c.name, qty: 0 };
      available[key].qty += stockQtyOf(c);
    }
    const versionsOf = new Map(pageCards.map((c) => [normalizeName(c.name), c.versions]));
    const increased = changes
      .filter((c) => c.to > c.from || c.version)
      .map((c) => {
        const key = normalizeName(c.name);
        return { name: c.name, qty: c.to - Math.min(c.to, proxies.get(key) || 0), versions: versionsOf.get(key) };
      })
      // Entièrement en proxy : rien à prendre au stock, ni version à vérifier.
      .filter((c) => c.qty > 0);
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
  // Exemplaires déjà en proxy (déclarés sur Moxfield) : ni contrôlés, ni
  // comptés dans le total (cf. stockPartOf), seulement annoncés.
  function computeDeckAvailability(allCards, stockMap, wrongEditionNames = buildWrongEditionSet(allCards), versionUsage = new Map()) {
    const cards = stockPartOf(allCards);
    const proxyCount = proxyTotal(allCards.filter((c) => !isBasicLand(c.name)));
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
      proxyCount,
    };
  }

  // Cartes d'un deck lues par son API (cf. deckCardList dans
  // moxfield-collection.js), mises sous la forme de celles lues sur la page
  // pour computeDeckAvailability (vue « Mes decks » du popup, même calcul que
  // la pastille du bouton) :
  // - versions : impressions du deck dont l'édition et le numéro sont dans
  //   la collection, comme les versions possédées lues sur la page ;
  // - printingStatus "partial" : carte possédée, mais dans aucune des
  //   éditions du deck — ce que la page lit dans le marqueur « Partially in
  //   collection » de Moxfield. Sans détail par édition dans le stock
  //   (collection importée sans colonne d'édition), rien n'est supposé et
  //   le doute profite au montage.
  function cardsFromDeckApi(deckCards, stockMap) {
    return deckCards.map((c) => {
      const entry = stockMap[normalizeName(c.name)];
      const owned = entry && Array.isArray(entry.printings) ? entry.printings : [];
      const versions = c.printings
        .filter((p) => owned.some((o) => o.set === p.set && o.cn === p.cn))
        .map(({ code, qty, set, cn }) => ({ code, qty, set, cn }));
      const card = { name: c.name, qty: c.qty };
      if (c.proxyQty) card.proxyQty = c.proxyQty;
      if (versions.length > 0) card.versions = versions;
      else if (owned.length > 0 && c.printings.length > 0) card.printingStatus = "partial";
      return card;
    });
  }

  // Liste d'achats cumulée de plusieurs decks non montés (vue « Mes decks »
  // du popup) : besoins additionnés par nom (les decks seraient montés en
  // même temps, une carte ne sert qu'à un deck), comparés une seule fois au
  // stock libre, d'où une ligne par carte. Même part du deck que la
  // pastille (stockPartOf : proxies déclarés exclus) et mêmes exclusions
  // que le bouton Cardmarket de la page : terrains de base, et cartes
  // possédées dans une autre édition ou version déjà prise (rien à acheter,
  // c'est une question d'édition). Pour un seul deck, les manques sont donc
  // ceux de sa pastille.
  // decks : [{ name, cards }] → [{ name, have, need, missing, decks }] trié
  // par nom (decks : noms des decks qui l'utilisent).
  function computeShoppingList(decks, stockMap) {
    const needs = new Map();
    for (const deck of decks) {
      for (const c of stockPartOf(deck.cards)) {
        if (isBasicLand(c.name)) continue;
        const key = normalizeName(c.name);
        if (!needs.has(key)) needs.set(key, { name: c.name, qty: 0, decks: [] });
        const need = needs.get(key);
        need.qty += c.qty;
        if (!need.decks.includes(deck.name)) need.decks.push(deck.name);
      }
    }
    return computeShortages([...needs.values()], stockMap)
      .map((s) => ({ ...s, decks: needs.get(normalizeName(s.name)).decks }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Texte collé dans l'import d'une liste de wants Cardmarket : « N Nom »,
  // une carte par ligne, quantité manquante seulement. Même format depuis
  // la page d'un deck et depuis la liste d'achats.
  function cardmarketWantsText(shortages) {
    return shortages.map((s) => `${s.missing} ${s.name}`).join("\n");
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
    if (a.proxyCount > 0) parts.push(tn("availabilityDeclaredProxies", a.proxyCount));
    return parts.join(" — ");
  }

  return {
    isBasicLand,
    buildWrongEditionSet,
    computeWrongEditionCards,
    computeShortages,
    computeShortagePrices,
    computeShoppingList,
    cardmarketWantsText,
    proxyCountOf,
    stockQtyOf,
    proxyTotal,
    addProxies,
    applyDeclaredProxies,
    stockPartOf,
    carryProxies,
    replaceableProxies,
    chooseOwnedEdition,
    ownedEditionSkipReason,
    predictEditionBlock,
    buildVersionUsage,
    computeVersionConflicts,
    parseCardsText,
    evaluateDeckUpdate,
    computeDeckAvailability,
    cardsFromDeckApi,
    blockingSummary,
    availabilityLabel,
  };
}

if (typeof module !== "undefined") module.exports = { createDeckChecks };
