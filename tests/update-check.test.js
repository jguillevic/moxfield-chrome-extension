// Tests de la détection d'une nouvelle version (update-check.js) : npm test
//
// Le dossier .git du clone et l'API GitHub sont simulés.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpdateCheck } = require("../update-check.js");

const LOCAL = "a".repeat(40);
const OTHER = "b".repeat(40);

// files : fichiers du dossier .git ; github : réponse de l'API (objet, ou
// Error levée), null s'il ne faut pas l'appeler ; manifest : manifest de
// main sur GitHub (absent : introuvable).
function checker(files, github = null, manifest = null) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      return { ok: Boolean(manifest), json: async () => manifest };
    }
    if (!github) throw new Error(`appel inattendu : ${url}`);
    if (github instanceof Error) throw github;
    return { ok: github.status === undefined || github.status === 200, json: async () => github.body };
  };
  return { calls, ...createUpdateCheck({ fetch, readFile: async (path) => (path in files ? files[path] : null) }) };
}

test("commit du clone : branche (fichier de la branche, ou packed-refs), commit détaché, pas de dossier .git", async () => {
  assert.equal(await checker({ ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/main": `${LOCAL}\n` }).localCommit(), LOCAL);
  const packed = `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/dev\n${LOCAL} refs/heads/main\n`;
  assert.equal(await checker({ ".git/HEAD": "ref: refs/heads/main\n", ".git/packed-refs": packed }).localCommit(), LOCAL);
  assert.equal(await checker({ ".git/HEAD": `${LOCAL}\n` }).localCommit(), LOCAL);
  assert.equal(await checker({}).localCommit(), null);
  assert.equal(await checker({ ".git/HEAD": "ref: refs/heads/main\n" }).localCommit(), null, "branche introuvable");
});

const CLONE = { ".git/HEAD": `${LOCAL}\n` };
const commit = (message) => ({ commit: { message } });

test("main a avancé : nouvelle version, modifications de la plus récente à la plus ancienne, version de main", async () => {
  const c = checker(CLONE, { body: { status: "ahead", ahead_by: 2, commits: [commit("Add A\n\ndétail"), commit("Fix B")] } }, { version: "0.4.0" });
  assert.deepEqual(await c.check(), {
    localSha: LOCAL,
    available: true,
    count: 2,
    commits: ["Fix B", "Add A"],
    compareUrl: `https://github.com/jguillevic/moxfield-chrome-extension/compare/${LOCAL.slice(0, 12)}...main`,
    latestVersion: "0.4.0",
  });
  assert.deepEqual(c.calls, [
    `https://api.github.com/repos/jguillevic/moxfield-chrome-extension/compare/${LOCAL}...main`,
    "https://raw.githubusercontent.com/jguillevic/moxfield-chrome-extension/main/manifest.json",
  ]);
});

test("version de main illisible : notification quand même, sans numéro", async () => {
  const c = checker(CLONE, { body: { status: "ahead", ahead_by: 1, commits: [commit("Fix B")] } });
  const res = await c.check();
  assert.equal(res.available, true);
  assert.equal(res.latestVersion, null);
});

test("clone à jour : la version de main n'est pas demandée", async () => {
  const c = checker(CLONE, { body: { status: "identical", ahead_by: 0, commits: [] } });
  await c.check();
  assert.equal(c.calls.length, 1);
});

test("clone à jour (ou en avance sur main) : pas de nouvelle version", async () => {
  for (const body of [{ status: "identical", ahead_by: 0, commits: [] }, { status: "behind", ahead_by: 0, behind_by: 1, commits: [] }]) {
    assert.equal((await checker(CLONE, { body }).check()).available, false);
  }
});

test("rien à conclure : pas de clone, commit pas encore poussé, réseau coupé, réponse anormale", async () => {
  assert.equal(await checker({}).check(), null, "pas de dossier .git : GitHub n'est pas appelé");
  assert.equal(await checker(CLONE, { status: 404, body: { message: "Not Found" } }).check(), null);
  assert.equal(await checker(CLONE, new TypeError("Failed to fetch")).check(), null);
  assert.equal(await checker(CLONE, { body: { message: "API rate limit exceeded" } }).check(), null);
});
