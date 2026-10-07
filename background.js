// background.js — service worker (MV3)
// Source de vérité unique pour le state : chrome.storage.local
//   stock       : { [normalizedName]: { name: string, qty: number } }
//   builtDecks  : { [deckId]: { name: string, url: string, cards: [{name, qty}], builtAt: number,
//                   updatedAt?: number,
//                   pageChanges?: [{name, from, to}], pageCheckedAt?: number } }
//     pageChanges : différences constatées sur la page Moxfield du deck par
//     rapport au montage (absent = aucune, ou jamais constaté).

// Modules partagés (chargés tels quels, cf. leur en-tête) :
// createDeckChecks, createMoxfieldCollection, computeCollectionDiff.
importScripts("deck-checks.js", "moxfield-collection.js");

const STORAGE_KEY = "moxfieldStockManagerState";

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Seuls stock et builtDecks sont conservés : une ancienne version stockait
// aussi les réglages de synchro automatique (settings, lastAutoSync...),
// fonctionnalité retirée car jamais fonctionnelle — ces clés sont ignorées
// ici et disparaissent à la prochaine écriture de l'état.
async function getState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const state = data[STORAGE_KEY] || {};
  return {
    stock: state.stock || {},
    builtDecks: state.builtDecks || {},
  };
}

// Toute modification locale passe par ici et sera envoyée sur Drive si la
// synchro est active. writeState sert aux écritures venant de Drive, qui ne
// doivent pas être renvoyées.
async function setState(state) {
  await writeState(state);
  await markDirty();
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// --- Parsing CSV export Moxfield ---
// Header connu : Count,Tradelist Count,Name,Edition,Condition,Language,Foil,Tags,Last Modified,Collector Number,Alter,Proxy,Purchase Price
// On agrège par nom de carte (toutes éditions/finish confondues) : le stock physique est géré au nom de carte, pas à l'édition près.
function parseCSVLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function parseCollectionCSV(csvText) {
  const lines = csvText.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV vide ou invalide");

  const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const countIdx = header.indexOf("count");
  const nameIdx = header.indexOf("name");
  if (countIdx === -1 || nameIdx === -1) {
    throw new Error("Colonnes 'Count' / 'Name' introuvables dans le CSV — format inattendu.");
  }

  const aggregated = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    const rawName = (cells[nameIdx] || "").trim();
    const rawCount = parseInt((cells[countIdx] || "0").trim(), 10);
    if (!rawName || Number.isNaN(rawCount)) continue;
    const key = normalizeName(rawName);
    if (!aggregated[key]) aggregated[key] = { name: rawName, qty: 0 };
    aggregated[key].qty += rawCount;
  }
  return aggregated;
}

// --- Handlers ---

// Stock correspondant à une collection : la collection, moins les cartes
// des decks montés (qui en ont été retirées au montage).
function stockFromCollection(collection, builtDecks) {
  const stock = {};
  for (const [key, c] of Object.entries(collection)) stock[key] = { ...c };
  moveCardsInStock(
    stock,
    Object.values(builtDecks).flatMap((deck) => deck.cards),
    -1
  );
  return stock;
}

// Inverse : quantités possédées (stock libre + cartes des decks montés).
function collectionFromState(state) {
  const collection = {};
  for (const [key, c] of Object.entries(state.stock)) collection[key] = { ...c };
  moveCardsInStock(
    collection,
    Object.values(state.builtDecks).flatMap((deck) => deck.cards),
    +1
  );
  return collection;
}

async function handleImportCSV(csvText) {
  const parsed = parseCollectionCSV(csvText);
  const state = await getState();
  state.stock = stockFromCollection(parsed, state.builtDecks);
  await setState(state);
  const totalQty = Object.values(parsed).reduce((sum, c) => sum + c.qty, 0);
  return { ok: true, cardCount: Object.keys(parsed).length, totalQty };
}

// sign = -1 : les cartes partent dans un deck (montage) ; +1 : elles
// reviennent au stock (démontage).
function moveCardsInStock(stock, cards, sign) {
  for (const card of cards) {
    if (card.excludedFromStock) continue; // absente de la collection Moxfield : jamais décomptée
    const key = normalizeName(card.name);
    if (!stock[key]) stock[key] = { name: card.name, qty: 0 };
    stock[key].qty += sign * card.qty;
  }
}

async function handleToggleDeck({ deckId, deckName, url, cards, built }) {
  const state = await getState();

  if (built) {
    if (state.builtDecks[deckId]) return { ok: true, alreadyBuilt: true };
    moveCardsInStock(state.stock, cards, -1);
    state.builtDecks[deckId] = { name: deckName, url, cards, builtAt: Date.now() };
  } else {
    const deck = state.builtDecks[deckId];
    if (!deck) return { ok: true, wasNotBuilt: true };
    moveCardsInStock(state.stock, deck.cards, +1);
    delete state.builtDecks[deckId];
  }

  await setState(state);
  return { ok: true };
}

// Deck monté dont la liste a changé sur Moxfield : équivaut à le démonter
// puis le remonter avec la nouvelle liste, en une seule écriture — seules
// les cartes modifiées voient donc leur stock bouger.
async function handleUpdateBuiltDeck({ deckId, deckName, url, cards }) {
  const state = await getState();
  const deck = state.builtDecks[deckId];
  if (!deck) throw new Error("Ce deck n'est plus marqué comme monté.");
  moveCardsInStock(state.stock, deck.cards, +1);
  moveCardsInStock(state.stock, cards, -1);
  const updated = { ...deck, name: deckName, url, cards, updatedAt: Date.now() };
  delete updated.pageChanges; // le montage correspond de nouveau à la page
  delete updated.pageCheckedAt;
  state.builtDecks[deckId] = updated;
  await setState(state);
  return { ok: true };
}

// Constat fait sur la page du deck (content-deck.js) : différences entre la
// liste Moxfield et le montage, vide si identiques. Sert au badge
// « Modifié » du popup. N'écrit que si le constat change : la page est
// vérifiée toutes les 3 secondes, et chaque écriture part sur Drive.
async function handleSetDeckPageChanges({ deckId, changes }) {
  const state = await getState();
  const deck = state.builtDecks[deckId];
  if (!deck) return { ok: true, ignored: true };
  if (JSON.stringify(deck.pageChanges || []) === JSON.stringify(changes)) return { ok: true, unchanged: true };
  if (changes.length > 0) {
    deck.pageChanges = changes;
    deck.pageCheckedAt = Date.now();
  } else {
    delete deck.pageChanges;
    delete deck.pageCheckedAt;
  }
  await setState(state);
  return { ok: true };
}

async function handleManualAdjust({ name, delta }) {
  const state = await getState();
  const key = normalizeName(name);
  if (!state.stock[key]) state.stock[key] = { name, qty: 0 };
  state.stock[key].qty += delta;
  await setState(state);
  return { ok: true };
}

// --- Synchronisation Google Drive ---
// L'état complet est stocké dans un fichier unique de l'appDataFolder de
// Drive : dossier caché, propre à l'extension (scope drive.appdata), sans
// accès aux autres fichiers de l'utilisateur. Chaque modification locale
// marque l'état « dirty » et déclenche un envoi différé ; une alarme
// périodique, le démarrage du navigateur et l'ouverture du popup récupèrent
// les changements faits sur un autre PC.
//
// Détection des changements distants : Drive incrémente le champ `version`
// du fichier à chaque écriture. Une version distante différente de la
// dernière version synchronisée signifie qu'un autre PC a écrit entre-temps.
// Conflit (changements des deux côtés) : le plus récent gagne, l'autre
// version est conservée dans l'historique pour ne rien perdre.
//
// Historique : un instantané daté par jour et par PC au plus, plus les
// versions écartées lors d'un conflit ; seuls les DRIVE_MAX_SNAPSHOTS plus
// récents sont gardés.
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_STATE_FILE = "moxfield-stock-state.json";
const DRIVE_SNAPSHOT_PREFIX = "moxfield-stock-";
const DRIVE_MAX_SNAPSHOTS = 10;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SYNC_META_KEY = "moxfieldStockManagerSync";
const SYNC_ALARM = "drive-sync";
const SYNC_PERIOD_MINUTES = 5;
const PUSH_DELAY_MS = 3000;
const DOC_APP = "moxfield-stock-manager";
const DOC_VERSION = 1;

async function getSyncMeta() {
  const data = await chrome.storage.local.get(SYNC_META_KEY);
  return {
    enabled: false,
    dirty: false,
    localUpdatedAt: 0,
    syncedVersion: null,
    lastSyncAt: null,
    lastSnapshotAt: 0,
    lastError: null,
    pendingChoice: null,
    accountId: null,
    accountEmail: null,
    accountMismatch: null,
    ...data[SYNC_META_KEY],
  };
}

async function updateSyncMeta(patch) {
  const meta = { ...(await getSyncMeta()), ...patch };
  await chrome.storage.local.set({ [SYNC_META_KEY]: meta });
  return meta;
}

let pushTimer = null;

async function markDirty() {
  const meta = await updateSyncMeta({ dirty: true, localUpdatedAt: Date.now() });
  if (!meta.enabled) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), PUSH_DELAY_MS);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function makeDoc(state, updatedAt) {
  return { app: DOC_APP, version: DOC_VERSION, updatedAt, state };
}

// Accepte aussi les sauvegardes manuelles d'une version précédente, qui
// n'avaient qu'un champ exportedAt.
function parseDoc(doc) {
  if (!isPlainObject(doc) || doc.app !== DOC_APP) {
    throw new Error("Ce fichier n'est pas une sauvegarde Moxfield Stock Manager.");
  }
  if (doc.version !== DOC_VERSION) {
    throw new Error(`Version de sauvegarde non prise en charge : ${doc.version}.`);
  }
  const { stock, builtDecks } = doc.state || {};
  if (!isPlainObject(stock) || !isPlainObject(builtDecks)) {
    throw new Error("Sauvegarde corrompue : stock ou decks montés manquants.");
  }
  for (const c of Object.values(stock)) {
    if (typeof c?.name !== "string" || !Number.isFinite(c?.qty)) {
      throw new Error("Sauvegarde corrompue : entrée de stock invalide.");
    }
  }
  for (const d of Object.values(builtDecks)) {
    if (typeof d?.name !== "string" || !Array.isArray(d?.cards)) {
      throw new Error("Sauvegarde corrompue : deck monté invalide.");
    }
  }
  return { state: { stock, builtDecks }, updatedAt: doc.updatedAt || Date.parse(doc.exportedAt) || 0 };
}

async function getAuthToken(interactive) {
  let token;
  try {
    ({ token } = await chrome.identity.getAuthToken({ interactive }));
  } catch (e) {
    throw new Error(interactive
      ? "Connexion à Google refusée ou annulée."
      : "Connexion Google à renouveler : clique sur « Reconnecter ».");
  }
  if (!token) throw new Error("Connexion à Google refusée ou annulée.");
  return token;
}

// Un token en cache peut avoir expiré ou été révoqué : sur un 401, on
// l'invalide et on réessaie une fois avec un token neuf.
async function driveFetch(url, options = {}, interactive = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAuthToken(interactive);
    const res = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && attempt === 0) {
      await chrome.identity.removeCachedAuthToken({ token });
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google Drive a répondu ${res.status} : ${body.slice(0, 200)}`);
    }
    return res;
  }
}

async function findStateFile(interactive = false) {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name = '${DRIVE_STATE_FILE}'`,
    fields: "files(id,version)",
  });
  const res = await driveFetch(`${DRIVE_API}/files?${params}`, {}, interactive);
  return (await res.json()).files[0] || null;
}

async function downloadDoc(fileId) {
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
  return parseDoc(await res.json());
}

async function createDriveFile(metadata, doc) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ ...metadata, parents: ["appDataFolder"], mimeType: "application/json" })], { type: "application/json" }));
  form.append("file", new Blob([JSON.stringify(doc)], { type: "application/json" }));
  const res = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,version`, { method: "POST", body: form });
  return res.json();
}

async function uploadStateDoc(fileId, doc) {
  if (!fileId) return createDriveFile({ name: DRIVE_STATE_FILE }, doc);
  const res = await driveFetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,version`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  return res.json();
}

async function listSnapshots() {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name contains '${DRIVE_SNAPSHOT_PREFIX}' and name != '${DRIVE_STATE_FILE}'`,
    orderBy: "createdTime desc",
    fields: "files(id,createdTime,size,appProperties)",
    pageSize: "100",
  });
  const res = await driveFetch(`${DRIVE_API}/files?${params}`);
  return (await res.json()).files;
}

// reason : "daily" (instantané quotidien) ou "conflict" (version écartée).
async function createSnapshot(doc, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await createDriveFile({ name: `${DRIVE_SNAPSHOT_PREFIX}${stamp}.json`, appProperties: { reason } }, doc);
  const files = await listSnapshots();
  for (const old of files.slice(DRIVE_MAX_SNAPSHOTS)) {
    await driveFetch(`${DRIVE_API}/files/${old.id}`, { method: "DELETE" });
  }
}

async function applyRemote(parsed, remoteFile) {
  await writeState(parsed.state);
  await updateSyncMeta({ syncedVersion: remoteFile.version, dirty: false, localUpdatedAt: parsed.updatedAt });
}

// Une modification locale peut arriver pendant l'envoi : on ne repasse
// dirty à false que si rien n'a changé depuis la lecture de l'état envoyé.
async function pushLocal(fileId) {
  const { localUpdatedAt } = await getSyncMeta();
  const updatedAt = localUpdatedAt || Date.now();
  const file = await uploadStateDoc(fileId, makeDoc(await getState(), updatedAt));
  const current = await getSyncMeta();
  await updateSyncMeta({ syncedVersion: file.version, dirty: current.localUpdatedAt !== localUpdatedAt });
}

async function maybeDailySnapshot() {
  const meta = await getSyncMeta();
  if (Date.now() - meta.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
  await createSnapshot(makeDoc(await getState(), meta.localUpdatedAt), "daily");
  await updateSyncMeta({ lastSnapshotAt: Date.now() });
}

// Le compte Google utilisé est celui du profil Chrome (getAuthToken sans
// compte explicite). S'il change, le fichier Drive n'est plus le même : on
// met la synchro en pause (accountMismatch) au lieu d'écraser le stock local
// avec celui d'un autre compte, et le popup demande quoi faire.
async function getProfileAccount() {
  const { id, email } = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
  return id ? { id, email } : null;
}

async function currentAccountPatch() {
  const account = await getProfileAccount();
  return account ? { accountId: account.id, accountEmail: account.email, accountMismatch: null } : {};
}

async function runSync() {
  let meta = await getSyncMeta();
  if (!meta.enabled || meta.pendingChoice) return meta;
  const account = await getProfileAccount();
  if (account && meta.accountId && account.id !== meta.accountId) {
    if (meta.accountMismatch?.email === account.email) return meta;
    return updateSyncMeta({ accountMismatch: { email: account.email } });
  }
  if (account && (meta.accountMismatch || meta.accountId !== account.id || meta.accountEmail !== account.email)) {
    meta = await updateSyncMeta({ accountId: account.id, accountEmail: account.email, accountMismatch: null });
  }
  try {
    const remote = await findStateFile();
    if (!remote) {
      await pushLocal(null);
    } else if (remote.version === meta.syncedVersion) {
      if (meta.dirty) await pushLocal(remote.id);
    } else {
      const remoteDoc = await downloadDoc(remote.id);
      meta = await getSyncMeta(); // relu : une modification locale a pu arriver pendant le téléchargement
      if (!meta.dirty) {
        await applyRemote(remoteDoc, remote);
      } else if (remoteDoc.updatedAt > meta.localUpdatedAt) {
        await createSnapshot(makeDoc(await getState(), meta.localUpdatedAt), "conflict");
        await applyRemote(remoteDoc, remote);
      } else {
        await createSnapshot(makeDoc(remoteDoc.state, remoteDoc.updatedAt), "conflict");
        await pushLocal(remote.id);
      }
    }
    await maybeDailySnapshot();
    return await updateSyncMeta({ lastSyncAt: Date.now(), lastError: null });
  } catch (e) {
    return await updateSyncMeta({ lastError: e.message || String(e) });
  }
}

// Les synchros sont exécutées l'une après l'autre, jamais en parallèle.
let syncQueue = Promise.resolve();
function syncNow() {
  const run = syncQueue.then(runSync);
  syncQueue = run.catch(() => {});
  return run;
}

function startSyncAlarm() {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
}

function isLocalEmpty(state) {
  return Object.keys(state.stock).length === 0 && Object.keys(state.builtDecks).length === 0;
}

// Première connexion sur ce PC. Si Drive a déjà des données et que ce PC a
// aussi un stock, on ne choisit pas à la place de l'utilisateur : le popup
// lui demande lequel garder (pendingChoice). Déjà connecté : simple
// reconnexion après expiration du token.
async function handleDriveConnect() {
  await getAuthToken(true);
  const meta = await getSyncMeta();
  if (meta.enabled && !meta.pendingChoice) {
    startSyncAlarm();
    return { ok: true, meta: await syncNow() };
  }
  const account = await currentAccountPatch();
  const remote = await findStateFile(true);
  if (!remote) {
    await updateSyncMeta({ ...account, enabled: true, pendingChoice: null, syncedVersion: null, dirty: true });
  } else if (isLocalEmpty(await getState())) {
    await updateSyncMeta({ ...account, enabled: true, pendingChoice: null });
    await applyRemote(await downloadDoc(remote.id), remote);
  } else {
    const remoteDoc = await downloadDoc(remote.id);
    const pendingChoice = { remoteUpdatedAt: remoteDoc.updatedAt };
    return { ok: true, meta: await updateSyncMeta({ ...account, enabled: true, pendingChoice }) };
  }
  startSyncAlarm();
  return { ok: true, meta: await syncNow() };
}

// Sert aussi après un changement de compte Chrome : le fichier Drive est
// alors celui du nouveau compte (éventuellement absent).
async function handleDriveResolveChoice({ keep }) {
  await updateSyncMeta(await currentAccountPatch());
  const remote = await findStateFile();
  if (remote) {
    const remoteDoc = await downloadDoc(remote.id);
    if (keep === "remote") {
      const { localUpdatedAt } = await getSyncMeta();
      await createSnapshot(makeDoc(await getState(), localUpdatedAt), "conflict");
      await applyRemote(remoteDoc, remote);
    } else {
      await createSnapshot(makeDoc(remoteDoc.state, remoteDoc.updatedAt), "conflict");
      await updateSyncMeta({ syncedVersion: remote.version, dirty: true, localUpdatedAt: Date.now() });
    }
  } else {
    await updateSyncMeta({ syncedVersion: null, dirty: true });
  }
  await updateSyncMeta({ pendingChoice: null });
  startSyncAlarm();
  return { ok: true, meta: await syncNow() };
}

// Les données restent sur ce PC et sur Drive ; seule la synchro s'arrête.
async function handleDriveDisconnect() {
  await chrome.alarms.clear(SYNC_ALARM);
  try {
    const { token } = await chrome.identity.getAuthToken({ interactive: false });
    if (token) await chrome.identity.removeCachedAuthToken({ token });
  } catch (e) {
    // déjà déconnecté de Google : rien à nettoyer
  }
  const meta = await updateSyncMeta({
    enabled: false,
    pendingChoice: null,
    syncedVersion: null,
    lastSyncAt: null,
    lastError: null,
    accountId: null,
    accountEmail: null,
    accountMismatch: null,
  });
  return { ok: true, meta };
}

async function handleDriveListSnapshots() {
  const files = await listSnapshots();
  return {
    ok: true,
    snapshots: files.map((f) => ({
      id: f.id,
      createdTime: f.createdTime,
      size: Number(f.size),
      reason: f.appProperties?.reason || "manual",
    })),
  };
}

// Passe par setState : la version restaurée est ensuite envoyée sur Drive
// et donc propagée aux autres PC.
async function handleDriveRestoreSnapshot({ fileId }) {
  const { state } = await downloadDoc(fileId);
  await setState(state);
  return { ok: true, cardCount: Object.keys(state.stock).length, deckCount: Object.keys(state.builtDecks).length };
}

async function handleResetStock() {
  await setState({ stock: {}, builtDecks: {} });
  return { ok: true };
}

// --- Récupération automatique de la collection Moxfield ---
// Toutes les heures (et au démarrage du navigateur si la dernière date de
// plus d'une heure), la collection est téléchargée depuis le compte Moxfield
// connecté dans Chrome (cf. moxfield-collection.js) puis importée comme un
// CSV : elle devient la référence du stock. Rien n'est écrit si elle n'a
// pas changé — chaque écriture part sur Drive.
// Le suivi (dernière récupération, derniers changements, erreur) est propre
// à ce PC : il n'est pas synchronisé.
const COLLECTION_META_KEY = "moxfieldStockManagerCollection";
const COLLECTION_ALARM = "moxfield-collection";
const COLLECTION_PERIOD_MINUTES = 60;
// Marge : une récupération lancée entre deux alarmes (bouton, démarrage) ne
// doit pas faire sauter la suivante pour quelques minutes.
const COLLECTION_DUE_MS = (COLLECTION_PERIOD_MINUTES - 5) * 60 * 1000;

const moxfieldCollection = createMoxfieldCollection({
  fetch: (...args) => fetch(...args),
  getCookies: () => chrome.cookies.getAll({ domain: "moxfield.com" }),
});
const { isBasicLand } = createDeckChecks(normalizeName);

async function getCollectionMeta() {
  const data = await chrome.storage.local.get(COLLECTION_META_KEY);
  return {
    enabled: true,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null, // { code, message }
    lastChanges: null, // [{ name, from, to }] : derniers changements importés
    lastChangesAt: null,
    ...data[COLLECTION_META_KEY],
  };
}

async function updateCollectionMeta(patch) {
  const meta = { ...(await getCollectionMeta()), ...patch };
  await chrome.storage.local.set({ [COLLECTION_META_KEY]: meta });
  return meta;
}

// Cartes de decks montés que la collection ne couvre plus (stock libre
// négatif), terrains de base exclus : ils ne font jamais qu'un
// avertissement, et leur stock peut être négatif par choix.
function findUncoveredCards(state) {
  const decksByCard = new Map();
  for (const deck of Object.values(state.builtDecks)) {
    for (const card of deck.cards) {
      if (card.excludedFromStock || isBasicLand(card.name)) continue;
      const key = normalizeName(card.name);
      if (!decksByCard.has(key)) decksByCard.set(key, []);
      decksByCard.get(key).push(deck.name);
    }
  }
  const uncovered = [];
  for (const [key, decks] of decksByCard) {
    const c = state.stock[key];
    if (c && c.qty < 0) uncovered.push({ name: c.name, missing: -c.qty, decks });
  }
  return uncovered.sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchCollection() {
  await updateCollectionMeta({ lastAttemptAt: Date.now() });
  try {
    const collection = parseCollectionCSV(await moxfieldCollection.downloadCollectionCSV());
    const state = await getState();
    const changes = computeCollectionDiff(collectionFromState(state), collection);
    const patch = { lastSuccessAt: Date.now(), lastError: null };
    if (changes.length > 0) {
      state.stock = stockFromCollection(collection, state.builtDecks);
      await setState(state);
      Object.assign(patch, { lastChanges: changes, lastChangesAt: Date.now() });
    }
    await updateCollectionMeta(patch);
    return { ok: true, changes };
  } catch (e) {
    const lastError = { code: e.code || "unknown", message: e.message || String(e) };
    await updateCollectionMeta({ lastError });
    return { ok: false, error: lastError.message, code: lastError.code };
  }
}

// Les récupérations sont exécutées l'une après l'autre, jamais en parallèle
// (le jeton de renouvellement change à chaque fois).
let collectionQueue = Promise.resolve();
function fetchCollectionNow() {
  const run = collectionQueue.then(fetchCollection);
  collectionQueue = run.catch(() => {});
  return run;
}

async function fetchCollectionIfDue() {
  const meta = await getCollectionMeta();
  if (!meta.enabled) return;
  const last = meta.lastAttemptAt || 0;
  if (Date.now() - last >= COLLECTION_DUE_MS) await fetchCollectionNow();
}

function startCollectionAlarm() {
  chrome.alarms.create(COLLECTION_ALARM, { periodInMinutes: COLLECTION_PERIOD_MINUTES });
}

// Collection modifiée sur Moxfield (ajout, changement de quantité,
// suppression — sur la page collection ou ailleurs sur le site) : on
// récupère la collection peu après, sans attendre l'heure. Observé
// (octobre 2026) : POST /v1/collections (ajout), PUT /v1/collections/<id>
// (modification) ; on retient tout appel qui n'est pas une lecture.
// L'alarme est repoussée à chaque modification : la récupération a lieu
// après une pause dans la saisie. Une alarme plutôt qu'un setTimeout : le
// service worker peut être arrêté entre-temps. 30 s est aussi le délai
// minimal d'une alarme.
const COLLECTION_CHANGED_ALARM = "moxfield-collection-changed";
const COLLECTION_SETTLE_MINUTES = 0.5;
const COLLECTION_WRITE_URLS = ["https://api2.moxfield.com/*/collections*"];

async function handleCollectionWrite(details) {
  // tabId -1 : requête qui ne vient pas d'un onglet (ex. l'extension).
  if (details.method === "GET" || details.tabId < 0 || details.statusCode >= 400) return;
  if (!(await getCollectionMeta()).enabled) return;
  chrome.alarms.create(COLLECTION_CHANGED_ALARM, { delayInMinutes: COLLECTION_SETTLE_MINUTES });
}

chrome.webRequest.onCompleted.addListener(handleCollectionWrite, { urls: COLLECTION_WRITE_URLS });

async function handleGetCollectionStatus() {
  return { ok: true, meta: await getCollectionMeta(), uncovered: findUncoveredCards(await getState()) };
}

async function handleSetCollectionAuto({ enabled }) {
  const meta = await updateCollectionMeta({ enabled });
  if (enabled) {
    startCollectionAlarm();
    fetchCollectionIfDue();
  } else {
    await chrome.alarms.clear(COLLECTION_ALARM);
    await chrome.alarms.clear(COLLECTION_CHANGED_ALARM);
  }
  return { ok: true, meta };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncNow();
  if (alarm.name === COLLECTION_ALARM) fetchCollectionIfDue();
  if (alarm.name === COLLECTION_CHANGED_ALARM) fetchCollectionNow();
});

// Les alarmes ne survivent pas toujours à un redémarrage du navigateur.
chrome.runtime.onStartup.addListener(async () => {
  if ((await getSyncMeta()).enabled) {
    startSyncAlarm();
    syncNow();
  }
  if ((await getCollectionMeta()).enabled) {
    startCollectionAlarm();
    fetchCollectionIfDue();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  if ((await getSyncMeta()).enabled) startSyncAlarm();
  if ((await getCollectionMeta()).enabled) {
    startCollectionAlarm();
    fetchCollectionIfDue();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_STATE":
          sendResponse({ ok: true, state: await getState() });
          break;
        case "IMPORT_CSV_TEXT":
          sendResponse(await handleImportCSV(msg.csvText));
          break;
        case "GET_COLLECTION_STATUS":
          sendResponse(await handleGetCollectionStatus());
          break;
        case "COLLECTION_FETCH_NOW":
          sendResponse(await fetchCollectionNow());
          break;
        case "SET_COLLECTION_AUTO":
          sendResponse(await handleSetCollectionAuto(msg.payload));
          break;
        case "TOGGLE_DECK_BUILT":
          sendResponse(await handleToggleDeck(msg.payload));
          break;
        case "SET_DECK_PAGE_CHANGES":
          sendResponse(await handleSetDeckPageChanges(msg.payload));
          break;
        case "UPDATE_BUILT_DECK":
          sendResponse(await handleUpdateBuiltDeck(msg.payload));
          break;
        case "MANUAL_ADJUST_STOCK":
          sendResponse(await handleManualAdjust(msg.payload));
          break;
        case "GET_SYNC_STATUS":
          sendResponse({ ok: true, meta: await getSyncMeta() });
          break;
        case "SYNC_NOW":
          sendResponse({ ok: true, meta: await syncNow() });
          break;
        case "DRIVE_CONNECT":
          sendResponse(await handleDriveConnect());
          break;
        case "DRIVE_RESOLVE_CHOICE":
          sendResponse(await handleDriveResolveChoice(msg.payload));
          break;
        case "DRIVE_DISCONNECT":
          sendResponse(await handleDriveDisconnect());
          break;
        case "DRIVE_LIST_SNAPSHOTS":
          sendResponse(await handleDriveListSnapshots());
          break;
        case "DRIVE_RESTORE_SNAPSHOT":
          sendResponse(await handleDriveRestoreSnapshot(msg.payload));
          break;
        case "RESET_STOCK":
          sendResponse(await handleResetStock());
          break;
        default:
          sendResponse({ ok: false, error: "Type de message inconnu: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // réponse asynchrone
});
