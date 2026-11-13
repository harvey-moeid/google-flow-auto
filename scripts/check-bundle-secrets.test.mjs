import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scanBuildDir, scanRepoWiring, scanText } from "./check-bundle-secrets.mjs";

const SCRIPT = fileURLToPath(new URL("./check-bundle-secrets.mjs", import.meta.url));
const makeDir = () => mkdtempSync(join(tmpdir(), "bundle-scan-"));
const write = (root, rel, content) => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
};

test("clean text produces no findings", () => {
  assert.deepEqual(scanText('const a=fetch("/api/me",{credentials:"same-origin"});'), []);
});

test("each secret shape is detected", () => {
  const jwt = `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`;
  const samples = {
    "VITE_API_TOKEN": 'const t="VITE_API_TOKEN";',
    "API_SECRET": "process.env.API_SECRET",
    "bearer": 'headers:{a:"Bearer abcdef1234567890"}',
    "jwt": `var x="${jwt}"`,
    "private key": "-----BEGIN RSA PRIVATE KEY-----",
    "github token": `x="ghp_${"A".repeat(36)}"`,
    "aws": 'k="AKIAABCDEFGHIJKLMNOP"',
    "google key": `k="AIza${"x".repeat(35)}"`,
    "access cookie": "CF_Authorization=abcdefghij123456",
  };
  for (const [name, text] of Object.entries(samples)) {
    assert.ok(scanText(text).length > 0, `${name} should be detected`);
  }
});

test("scanBuildDir flags a leaked token in a built asset and reports no values", () => {
  const dist = makeDir();
  try {
    write(dist, "index.html", "<html></html>");
    write(dist, "assets/index-abc.js", 'fetch("/api",{headers:{authorization:"Bearer sk_live_supersecretvalue123"}})');
    const findings = scanBuildDir(dist);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, join("assets", "index-abc.js"));
    assert.ok(!JSON.stringify(findings).includes("supersecretvalue"), "finding must not contain the secret");
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("scanBuildDir passes a clean bundle", () => {
  const dist = makeDir();
  try {
    write(dist, "assets/index.js", 'export const a=()=>fetch("/api/me");');
    write(dist, "assets/index.css", "body{margin:0}");
    assert.deepEqual(scanBuildDir(dist), []);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("scanRepoWiring flags the old VITE_API_TOKEN pattern in source, env files and workflows", () => {
  const root = makeDir();
  try {
    write(root, "apps/pwa/src/App.tsx", 'const TOKEN=import.meta.env.VITE_API_TOKEN||"";');
    write(root, ".github/workflows/deploy.yml", "env:\n  VITE_API_TOKEN: ${{ secrets.API_TOKEN }}\n");
    write(root, ".env.example", "VITE_SERVICE_KEY=abc\n");
    const findings = scanRepoWiring(root);
    const files = new Set(findings.map((f) => f.file));
    assert.ok(files.has(join("apps", "pwa", "src", "App.tsx")));
    assert.ok(files.has(join(".github", "workflows", "deploy.yml")));
    assert.ok(files.has(".env.example"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanRepoWiring rejects non-allowlisted VITE_ variables and Authorization headers in the PWA", () => {
  const root = makeDir();
  try {
    write(root, "apps/pwa/src/a.ts", "const u=import.meta.env.VITE_FEATURE_FLAG;");
    write(root, "apps/pwa/src/b.ts", 'fetch(u,{headers:{"authorization":"x"}});');
    const rules = scanRepoWiring(root).map((f) => f.rule);
    assert.ok(rules.includes("VITE_* variable not on the public allowlist"));
    assert.ok(rules.includes("frontend sets an Authorization header"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanRepoWiring accepts the allowlisted public variable and ignores docs", () => {
  const root = makeDir();
  try {
    write(root, "apps/pwa/src/api.ts", "const b=import.meta.env.VITE_API_URL||'';");
    write(root, "docs/HANDOFF.md", "Remove VITE_API_TOKEN from the PWA.");
    assert.deepEqual(scanRepoWiring(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI exits 1 on a leak, 0 on a clean build, and 2 when the build output is missing", () => {
  const dist = makeDir();
  try {
    write(dist, "a.js", "var ok=1;");
    const clean = spawnSync(process.execPath, [SCRIPT, "--dist", dist], { encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stderr);
    write(dist, "b.js", 'var t="VITE_API_TOKEN";');
    const leak = spawnSync(process.execPath, [SCRIPT, "--dist", dist], { encoding: "utf8" });
    assert.equal(leak.status, 1);
    assert.match(leak.stderr, /FAIL/);
    const missing = spawnSync(process.execPath, [SCRIPT, "--dist", join(dist, "nope")], { encoding: "utf8" });
    assert.equal(missing.status, 2);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
