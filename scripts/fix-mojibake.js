const fs = require("fs");
const path = require("path");

const targets = [
	path.join(__dirname, "..", "server.js"),
	path.join(__dirname, "..", "lib", "prompts.js")
];

// Common UTF-8 mojibake patterns observed in this repo.
const replacements = [
	["\u00c3\u2030", "\u00c9"], // Ã‰ -> É
	["\u00c3\u00a9", "\u00e9"], // Ã© -> é
	["\u00c3\u00a8", "\u00e8"], // Ã¨ -> è
	["\u00c3\u00a0", "\u00e0"], // Ã  -> à
	["\u00c3\u00aa", "\u00ea"], // Ãª -> ê
	["\u00c3\u00b9", "\u00f9"], // Ã¹ -> ù
	["\u00c3\u00b4", "\u00f4"], // Ã´ -> ô
	["\u00c3\u00a7", "\u00e7"], // Ã§ -> ç
	["\u00c3\u00ab", "\u00eb"], // Ã« -> ë
	["\u00e2\u20ac\u2122", "\u2019"], // â€™ -> ’
	["\u00e2\u20ac\u201d", "\u2014"], // â€" -> —
	["\u00e2\u20ac\u0153", "\u201c"] // â€œ -> “
];

let totalReplacements = 0;

for (const filePath of targets) {
	let content = fs.readFileSync(filePath, "utf8");
	let fileReplacements = 0;

	for (const [bad, good] of replacements) {
		const count = content.split(bad).length - 1;
		if (count > 0) {
			content = content.split(bad).join(good);
			fileReplacements += count;
		}
	}

	fs.writeFileSync(filePath, content, "utf8");
	totalReplacements += fileReplacements;
	console.log(path.relative(process.cwd(), filePath) + ": replacements=" + fileReplacements);
}

console.log("total replacements:", totalReplacements);
