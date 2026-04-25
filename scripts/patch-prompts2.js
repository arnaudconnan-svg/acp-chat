"use strict";
const fs = require("fs");
let c = fs.readFileSync("lib/prompts.js", "utf8");

// Patch forme2: ajouter contrainte phrases courtes après la ligne "toute phrase doit apporter"
// Cherche la ligne contenant "reformulation de l" + "idee deja exprimee" puis \r\n`,
const old2 = /( {2}- toute phrase doit apporter une information nouvelle, sans repetition ni reformulation de l.idee deja exprimee\r?\n)(`\,)/;
if (old2.test(c)) {
  c = c.replace(old2, (_, line, closing) => {
    const eol = line.endsWith("\r\n") ? "\r\n" : "\n";
    return line + "  - prefere les phrases courtes et directes ; evite les constructions avec plusieurs subordonnees ; si une phrase fait plus d'une ligne, cherche a la couper" + eol + closing;
  });
  console.log("OK forme2_court");
} else {
  console.error("MISS forme2_court");
}

fs.writeFileSync("lib/prompts.js", c);
