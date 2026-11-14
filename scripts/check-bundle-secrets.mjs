#!/usr/bin/env node
/**
 * Fails when something secret-looking would ship to (or be wired into) the public PWA.
 *
 *   node scripts/check-bundle-secrets.mjs            # scan built assets + repo wiring
 *   node scripts/check-bundle-secrets.mjs --dist DIR # scan another build directory
 *
 * Findings print the file, line and rule only. The matched text is never printed, so a
 * leaked secret does not get copied into CI logs.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".json", ".map", ".webmanifest", ".txt", ".svg", ".ts", ".tsx", ".yml", ".yaml", ".toml", ".example", ".md", ""]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist"]);

/** Rules for text that must never appear in a shipped bundle. */
export const BUNDLE_RULES = [
  { name: "API token/key/secret variable name", re: /\b(VITE_)?(WORKER_|CLOUDFLARE_|CF_)?API_(TOKEN|KEY|SECRET)\b/ },
  { name: "Authorization bearer value", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/ },
  { name: "JWT-looking value", re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Cloudflare Access cookie value", re: /CF_Authorization=[A-Za-z0-9._-]{10,}/ },
];

/** VITE_* names are public by design; secret-looking ones are always forbidden. */
const SECRET_VITE_RE = /\bVITE_[A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)[A-Z0-9_]*\b/;
const ALLOWED_VITE_VARS = new Set(["VITE_API_URL"]);

export function scanText(text, rules = BUNDLE_RULES) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of rules) {
      if (rule.re.test(line)) findings.push({ line: index + 1, rule: rule.name });
    }
  });
  return findings;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

/** Scans a build output directory (dist is scanned explicitly, so it is not skipped here). */
export function scanBuildDir(dir) {
  const findings = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) && statSync(full).size < 20 * 1024 * 1024) {
        for (const finding of scanText(readFileSync(full, "utf8"))) findings.push({ file: relative(dir, full), ...finding });
      }
    }
  };
  visit(dir);
  for (const finding of findings) finding.where = "build output";
  return findings;
}

/** Scans source/config for secret wiring into the frontend. */
export function scanRepoWiring(root) {
  const findings = [];
  const candidates = [];
  // Prose docs are excluded on purpose: they may mention removed variables as history.
  for (const base of ["apps/pwa", ".github"]) {
    const dir = join(root, base);
    if (existsSync(dir)) candidates.push(...walk(dir));
  }
  for (const name of [".env.example", "engine/.env.example", "scripts/bootstrap-cloudflare.sh"]) {
    if (existsSync(join(root, name))) candidates.push(join(root, name));
  }
  for (const file of candidates) {
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase()) && !file.endsWith("_headers")) continue;
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (SECRET_VITE_RE.test(line)) {
        findings.push({ file: rel, line: index + 1, rule: "secret-looking VITE_* variable", where: "repo wiring" });
      }
      if (rel.startsWith("apps/pwa/src/")) {
        for (const match of line.matchAll(/\bVITE_[A-Z0-9_]+\b/g)) {
          if (!ALLOWED_VITE_VARS.has(match[0])) {
            findings.push({ file: rel, line: index + 1, rule: "VITE_* variable not on the public allowlist", where: "repo wiring" });
          }
        }
      }
    });
    // The PWA must never build an Authorization header.
    if (rel.startsWith("apps/pwa/src/") && /["'`]authorization["'`]\s*:/i.test(readFileSync(file, "utf8"))) {
      findings.push({ file: rel, line: 0, rule: "frontend sets an Authorization header", where: "repo wiring" });
    }
  }
  return findings;
}

function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const args = process.argv.slice(2);
  const distIndex = args.indexOf("--dist");
  const dist = resolve(distIndex >= 0 ? args[distIndex + 1] : join(root, "apps/pwa/dist"));

  if (!existsSync(dist)) {
    console.error(`FAIL: build output not found at ${dist}. Run the PWA build first.`);
    process.exit(2);
  }
  const findings = [...scanBuildDir(dist), ...scanRepoWiring(root)];
  if (findings.length > 0) {
    console.error("FAIL: secret-looking content found (values are intentionally not printed):");
    for (const f of findings) console.error(`  [${f.where}] ${f.file}:${f.line} ${f.rule}`);
    process.exit(1);
  }
  console.log(`OK: no secret-looking content in ${relative(root, dist) || dist} or the frontend wiring.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
