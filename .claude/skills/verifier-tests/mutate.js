// Casse une règle à la fois (remplacement de texte), lance npm test, puis
// restaure le fichier : chaque mutation doit faire échouer au moins un test.
// Usage, depuis la racine du dépôt :
//   node .claude/skills/verifier-tests/mutate.js mutations.json
// mutations.json : [{ "name", "file", "from", "to" }], "from" unique dans
// le fichier. Code de sortie 1 si une mutation n'est pas détectée ou pas
// appliquée.
const fs = require("fs");
const { execSync } = require("child_process");

const listFile = process.argv[2];
if (!listFile) {
  console.error("Usage : node mutate.js <mutations.json>");
  process.exit(2);
}
const mutations = JSON.parse(fs.readFileSync(listFile, "utf8"));

function runTests() {
  let out = "";
  try {
    out = execSync("npm test 2>&1", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = e.stdout || "";
  }
  const fail = /ℹ fail (\d+)/.exec(out);
  return fail ? Number(fail[1]) : null;
}

let ok = true;
for (const { name, file, from, to } of mutations) {
  const original = fs.readFileSync(file, "utf8");
  const count = original.split(from).length - 1;
  if (count !== 1) {
    console.log(`?? ${count === 0 ? "introuvable" : `${count} occurrences`} : ${name}`);
    ok = false;
    continue;
  }
  fs.writeFileSync(file, original.replace(from, to));
  let fail;
  try {
    fail = runTests();
  } finally {
    fs.writeFileSync(file, original); // toujours restauré
  }
  if (fail > 0) console.log(`détectée (${fail} échecs) : ${name}`);
  else {
    console.log(`NON DÉTECTÉE (${fail === null ? "sortie illisible" : "0 échec"}) : ${name}`);
    ok = false;
  }
}
process.exit(ok ? 0 : 1);
