const fs = require("fs");
const path = require("path");
const filePath = path.join(__dirname, "..", "server.js");
let content = fs.readFileSync(filePath, "utf8");
// Em-dash mojibake: U+00E2 U+20AC U+201D → — (U+2014)
const emDashMojibake = "\u00e2\u20ac\u201d";
const count = content.split(emDashMojibake).length - 1;
content = content.split(emDashMojibake).join("\u2014");
fs.writeFileSync(filePath, content, "utf8");
console.log("em-dash fixed:", count);
