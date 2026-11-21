// update-check.js — nouvelle version de l'extension disponible sur GitHub ?
//
// Chargé par le service worker (importScripts dans background.js) et par les
// tests Node (tests/), d'où la fabrique paramétrée par fetch et la lecture
// des fichiers de l'extension.
//
// L'extension est installée depuis un clone du dépôt (mode développeur) :
// rien ne la met à jour, il faut un git pull. Elle compare le commit du
// clone, lu dans son propre dossier .git (lisible par l'extension, vérifié
// sous Chromium), à la branche main du dépôt sur GitHub. Sans dossier .git
// (paquet du Chrome Web Store, simple copie), pas de vérification : le Store
// fait lui-même les mises à jour.
//
// API GitHub publique, sans compte ni permission d'hôte (elle autorise toute
// origine, CORS « * ») : 60 appels par heure et par adresse IP sans compte,
// largement assez pour une vérification toutes les quelques heures.

const UPDATE_REPO = "jguillevic/moxfield-chrome-extension";
const UPDATE_BRANCH = "main";

// readFile(chemin) : contenu texte d'un fichier de l'extension, null s'il
// n'existe pas.
function createUpdateCheck({ fetch, readFile, repo = UPDATE_REPO, branch = UPDATE_BRANCH }) {
  const SHA = /^[0-9a-f]{40}$/;

  // Commit du clone : .git/HEAD donne la branche (« ref: refs/heads/main »)
  // ou directement un commit. La branche est dans .git/refs/heads/, ou dans
  // .git/packed-refs après un « git gc ». null sans dossier .git.
  async function localCommit() {
    const head = ((await readFile(".git/HEAD")) || "").trim();
    if (SHA.test(head)) return head;
    const ref = /^ref: (\S+)$/.exec(head);
    if (!ref) return null;
    const loose = ((await readFile(`.git/${ref[1]}`)) || "").trim();
    if (SHA.test(loose)) return loose;
    for (const line of ((await readFile(".git/packed-refs")) || "").split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref[1] && SHA.test(sha)) return sha;
    }
    return null;
  }

  // Version de main (champ version de son manifest), null si illisible :
  // un plus, la notification s'en passe.
  async function latestVersion() {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/manifest.json`);
      if (!res.ok) return null;
      const manifest = await res.json();
      return typeof manifest.version === "string" ? manifest.version : null;
    } catch (e) {
      return null;
    }
  }

  // → { localSha, available, count, commits: [titre], compareUrl,
  // latestVersion } ;
  // available : main a des commits que le clone n'a pas. null si on ne peut
  // pas conclure (pas de dossier .git, commit local inconnu de GitHub — pas
  // encore poussé —, réseau coupé, réponse anormale) : situation normale,
  // l'appelant garde son dernier constat.
  async function check() {
    const localSha = await localCommit();
    if (!localSha) return null;
    let res;
    try {
      res = await fetch(`https://api.github.com/repos/${repo}/compare/${localSha}...${branch}`, {
        headers: { Accept: "application/vnd.github+json" },
      });
    } catch (e) {
      return null;
    }
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body || typeof body.ahead_by !== "number") return null;
    const commits = (Array.isArray(body.commits) ? body.commits : [])
      .map((c) => String((c && c.commit && c.commit.message) || "").split("\n")[0])
      .filter(Boolean)
      .reverse(); // le plus récent en premier
    const available = body.ahead_by > 0;
    return {
      localSha,
      available,
      count: body.ahead_by,
      commits: commits.slice(0, 10),
      compareUrl: `https://github.com/${repo}/compare/${localSha.slice(0, 12)}...${branch}`,
      latestVersion: available ? await latestVersion() : null,
    };
  }

  // Page GitHub d'un commit (version affichée dans le popup).
  function commitUrl(sha) {
    return `https://github.com/${repo}/commit/${sha}`;
  }

  return { localCommit, check, commitUrl };
}

if (typeof module !== "undefined") module.exports = { createUpdateCheck };
