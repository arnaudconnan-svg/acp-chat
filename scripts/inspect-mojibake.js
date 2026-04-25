const fs = require("fs");
const filePath = require("path").join(__dirname, "..", "server.js");
const content = fs.readFileSync(filePath, "utf8");
const lines = content.split("\n");
// em-dash mojibake is U+00E2 U+20AC U+201D (right quote variant)
const emDashMojibake = "\u00e2\u20ac\u201d";
const count = content.split(emDashMojibake).length - 1;
console.log("em-dash occurrences:", count);
// Find guillemet replace lines
lines.forEach((l, i) => {
  if (l.includes("replace(/^") && l.includes("+|")) {
    const snippet2 = l.slice(l.indexOf("replace"), l.indexOf("replace") + 40);
    console.log("Guillemet line", i+1, JSON.stringify(snippet2));
    console.log("Codepoints:", [...snippet2].map(c => `U+${c.charCodeAt(0).toString(16).padStart(4,"0")}`).join(" "));
  }
});
