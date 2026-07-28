import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  publicScriptPaths,
  publicStylePaths,
} from "./lib/public-script-paths.mjs";
import { assertReferencePage } from "./lib/reference-page.mjs";

const appRoot = resolve("apps/reference-site");
const nextRoot = resolve(appRoot, ".next");
const publicHtml = await readFile(
  resolve(nextRoot, "server/app/index.html"),
  "utf8",
);
const dashboardControlsSource = await readFile(
  resolve(appRoot, "components/dashboard-controls.tsx"),
  "utf8",
);
const privateMarkerMatch = dashboardControlsSource.match(
  /DASHBOARD_PRIVATE_BUNDLE_MARKER\s*=\s*"([^"]+)"/,
);

assertReferencePage(publicHtml);

if (privateMarkerMatch === null) {
  throw new Error("The protected dashboard bundle marker is not declared.");
}

const privateMarker = privateMarkerMatch[1];

const publicScriptsToCheck = publicScriptPaths(publicHtml);

if (publicScriptsToCheck.length === 0) {
  throw new Error("No public route scripts were found in the production build.");
}

const publicScripts = await Promise.all(
  publicScriptsToCheck.map((scriptPath) =>
    readFile(resolve(nextRoot, scriptPath.replace("/_next/", "")), "utf8"),
  ),
);

if (publicScripts.some((source) => source.includes(privateMarker))) {
  throw new Error("Protected dashboard code leaked into the public route bundle.");
}

const publicStylesToCheck = publicStylePaths(publicHtml);
const publicStyles = await Promise.all(
  publicStylesToCheck.map((stylePath) =>
    readFile(resolve(nextRoot, stylePath.replace("/_next/", "")), "utf8"),
  ),
);
if (publicStyles.some((source) => source.includes("--puck-color-"))) {
  throw new Error("Protected visual-editor styles leaked into the public route.");
}

const staticFiles = await readdir(resolve(nextRoot, "static/chunks"), {
  recursive: true,
});
const javascriptFiles = staticFiles.filter((file) => file.endsWith(".js"));
const allClientScripts = await Promise.all(
  javascriptFiles.map((file) =>
    readFile(resolve(nextRoot, "static/chunks", file), "utf8"),
  ),
);

if (!allClientScripts.some((source) => source.includes(privateMarker))) {
  throw new Error(
    "The protected dashboard marker was not emitted in its route-specific bundle.",
  );
}

console.log(
  `Verified ${publicScriptsToCheck.length} public scripts and ${publicStylesToCheck.length} public styles exclude protected dashboard code.`,
);
