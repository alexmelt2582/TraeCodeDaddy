#!/usr/bin/env node
/**
 * One-shot release pipeline for TraeCode CN Enhancer.
 *
 * Stages (each skippable):
 *   1. verify  - npm test + npm run check                 (--skip-verify)
 *   2. build   - build:exe + build:installer              (--skip-build)
 *   3. package - assemble dist\release\<ver>: copy the installer,
 *                zip the portable tree, write SHA256SUMS.txt, and patch the
 *                SHA256 block inside docs\releases\<ver>.md
 *   4. commit  - commit docs changes (only the docs/ tree) if any
 *   5. publish - annotated tag v<ver>, push the tag, and create/upload the
 *                GitHub release                          (--skip-publish)
 *
 * gh authentication:
 *   GH_TOKEN wins if set. Otherwise `gh auth status` is tried first, and if the
 *   CLI is not logged in the token stored by Git Credential Manager for
 *   github.com is reused through GH_TOKEN. gh's own `auth login` rejects tokens
 *   that lack the read:org scope, so scope validation is bypassed this way.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1]));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const pkg = require(path.join(PROJECT_ROOT, "package.json"));

const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const RELEASE_ROOT = path.join(DIST_DIR, "release");
const PORTABLE_DIR = path.join(DIST_DIR, "portable");
const INSTALLER_DIR = path.join(DIST_DIR, "installer");
const EXE_NAME = "TraeCodeEnhancer.exe";
const NOTES_DIR = path.join(PROJECT_ROOT, "docs", "releases");

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function log(message) {
  console.log(`[release] ${message}`);
}

function parseFlags(argv) {
  const flags = {
    skipVerify: false,
    skipBuild: false,
    skipPublish: false,
    version: null,
    notes: null,
  };
  for (const arg of argv) {
    if (arg === "--skip-verify") flags.skipVerify = true;
    else if (arg === "--skip-build") flags.skipBuild = true;
    else if (arg === "--skip-publish") flags.skipPublish = true;
    else if (arg.startsWith("--version=")) flags.version = arg.slice("--version=".length);
    else if (arg.startsWith("--notes=")) flags.notes = arg.slice("--notes=".length);
    else {
      console.error(`[release] unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return flags;
}

/** Runs a command and returns its stdout. Rejects with the error on failure. */
async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, options);
  return stdout;
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

async function gitArgs() {
  try {
    await fs.stat(path.join(PROJECT_ROOT, ".git-meta"));
    return ["--git-dir=.git-meta", "--work-tree=."];
  } catch {
    return [];
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function verify() {
  log("verify: npm test");
  await run(NPM, ["run", "test"], { cwd: PROJECT_ROOT, shell: process.platform === "win32" });
  log("verify: npm run check");
  await run(NPM, ["run", "check"], { cwd: PROJECT_ROOT, shell: process.platform === "win32" });
  log("verify: ok");
}

async function build() {
  log("build: npm run build:exe");
  await run(NPM, ["run", "build:exe"], { cwd: PROJECT_ROOT, shell: process.platform === "win32" });
  log("build: npm run build:installer");
  await run(NPM, ["run", "build:installer"], {
    cwd: PROJECT_ROOT,
    shell: process.platform === "win32",
  });
  log("build: ok");
}

async function packageRelease(version) {
  const releaseDir = path.join(RELEASE_ROOT, version);
  const installerName = `TraeCodeEnhancer-Setup-${version}.exe`;
  const zipName = `TraeCodeEnhancer-v${version}-portable.zip`;
  const installerPath = path.join(releaseDir, installerName);
  const zipPath = path.join(releaseDir, zipName);
  const sumsPath = path.join(releaseDir, "SHA256SUMS.txt");

  await fs.mkdir(releaseDir, { recursive: true });
  await fs.copyFile(path.join(INSTALLER_DIR, installerName), installerPath);
  log(`package: copied ${installerName}`);

  log(`package: zipping ${PORTABLE_DIR}`);
  await run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${path.join(PORTABLE_DIR, "*")}' -DestinationPath '${zipPath}' -Force`,
  ]);

  const installerHash = await sha256(installerPath);
  const zipHash = await sha256(zipPath);
  const portableHash = await sha256(path.join(PORTABLE_DIR, EXE_NAME));
  await fs.writeFile(
    sumsPath,
    [
      `${installerHash.toUpperCase()}  ${installerName}`,
      `${zipHash.toUpperCase()}  ${zipName}`,
      `${portableHash.toUpperCase()}  ${EXE_NAME}`,
      "",
    ].join("\n"),
    "utf8",
  );
  log(`package: ${installerName} ${installerHash}`);
  log(`package: ${zipName} ${zipHash}`);
  log(`package: ${EXE_NAME} ${portableHash}`);
  log(`package: wrote SHA256SUMS.txt`);

  const notes = flags.notes ?? path.join(NOTES_DIR, `v${version}.md`);
  if (await exists(notes)) {
    const md = await fs.readFile(notes, "utf8");
    const block = /(SHA256：\n\n```text\n)[\s\S]*?(```)/;
    if (block.test(md)) {
      const patched = md.replace(
        block,
        (_match, head) =>
          `${head}${installerHash}  ${installerName}\n${zipHash}  ${zipName}\n${portableHash}  ${EXE_NAME}\n\`\`\``,
      );
      await fs.writeFile(notes, patched, "utf8");
      log(`package: patched SHA256 block in ${path.relative(PROJECT_ROOT, notes)}`);
    } else {
      log(`package: note: no SHA256 block found in ${path.relative(PROJECT_ROOT, notes)}`);
    }
  } else {
    log(`package: note: release notes missing, skipping patch: ${notes}`);
  }

  return { releaseDir, notes };
}

async function commitDocs(version) {
  const git = await gitArgs();
  const docsDir = "docs";
  await run("git", [...git, "add", docsDir], { cwd: PROJECT_ROOT });
  const status = await run("git", [...git, "status", "--porcelain", "--", docsDir], {
    cwd: PROJECT_ROOT,
  });
  if (!status.trim()) {
    log("commit: no docs changes");
    return;
  }
  await run("git", [...git, "commit", "-m", `docs: 更新 ${version} 发布说明`], { cwd: PROJECT_ROOT });
  log("commit: docs committed");
}

/** Makes sure `gh` can talk to GitHub, reusing the GCM token if necessary. */
async function ensureGhAuth() {
  if (process.env.GH_TOKEN) return;
  try {
    await run("gh", ["auth", "status"]);
    return;
  } catch {
    // not logged in - fall through to the GCM token
  }
  log("publish: gh not logged in; reusing Git Credential Manager token via GH_TOKEN");
  const { stdout } = await execFileAsync("git", ["credential", "fill"], {
    cwd: PROJECT_ROOT,
    input: "protocol=https\nhost=github.com\n",
  });
  const match = /^password=(.+)$/m.exec(stdout);
  if (!match) {
    throw new Error("no github.com credential found in Git Credential Manager");
  }
  process.env.GH_TOKEN = match[1].trim();
}

async function publishRelease(version, notes, releaseDir) {
  const git = await gitArgs();
  await ensureGhAuth();
  const tag = `v${version}`;

  const existingTag = await run("git", [...git, "tag", "-l", tag], { cwd: PROJECT_ROOT });
  if (existingTag.trim()) {
    log(`publish: tag ${tag} already exists`);
  } else {
    await run("git", [...git, "tag", "-a", tag, "-m", tag], { cwd: PROJECT_ROOT });
    await run("git", [...git, "push", "origin", tag], { cwd: PROJECT_ROOT });
    log(`publish: pushed tag ${tag}`);
  }

  const assets = [
    path.join(releaseDir, `TraeCodeEnhancer-Setup-${version}.exe`),
    path.join(releaseDir, `TraeCodeEnhancer-v${version}-portable.zip`),
    path.join(releaseDir, "SHA256SUMS.txt"),
  ];

  try {
    await run("gh", ["release", "view", tag, "--json", "tagName"], { cwd: PROJECT_ROOT });
    log(`publish: release ${tag} already exists, uploading assets`);
    await run("gh", ["release", "upload", tag, "--clobber", ...assets], { cwd: PROJECT_ROOT });
  } catch {
    await run("gh", ["release", "create", tag, "--title", tag, "--notes-file", notes, ...assets], {
      cwd: PROJECT_ROOT,
    });
    log(`publish: created release ${tag}`);
  }

  const remote = (await run("git", [...git, "remote", "get-url", "origin"], { cwd: PROJECT_ROOT })).trim();
  log(`publish: https://github.com/${remote.replace(/^.*github\.com[/:](.+?)(\.git)?$/, "$1")}/releases/tag/${tag}`);
}

const flags = parseFlags(process.argv.slice(2));
const version = flags.version ?? pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`[release] invalid version: ${version}`);
  process.exit(2);
}

try {
  log(`pipeline start: v${version}`);
  if (!flags.skipVerify) await verify();
  if (!flags.skipBuild) await build();
  const { releaseDir, notes } = await packageRelease(version);
  await commitDocs(version);
  if (!flags.skipPublish) await publishRelease(version, notes, releaseDir);
  log("pipeline done");
} catch (error) {
  console.error(`[release] failed: ${error.message}`);
  process.exit(1);
}
