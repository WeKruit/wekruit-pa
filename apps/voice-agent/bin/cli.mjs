#!/usr/bin/env node
// voice-agent CLI shim. Delegates to dist/cli.js when built, or src/cli.ts via
// tsx when in dev. LiveKit Cloud invokes the built `dist/cli.js` directly
// per livekit.toml — this shim is for local development.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, "..", "dist", "cli.js");
const devEntry = path.resolve(here, "..", "src", "cli.ts");

if (existsSync(distEntry)) {
  await import(distEntry);
} else if (existsSync(devEntry)) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", devEntry, ...process.argv.slice(2)],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 1);
} else {
  console.error("[voice-agent] no entry found at dist/cli.js or src/cli.ts");
  process.exit(1);
}
