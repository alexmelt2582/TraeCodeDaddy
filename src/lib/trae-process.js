import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runPowerShell(script, { timeout = 15000 } = {}) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      timeout,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  return stdout.trim();
}

export async function traeExecutableExists(exePath) {
  try {
    const stat = await fs.stat(exePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function isCdpAvailable(port, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function isTraeCdpAvailable(port, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const targets = await response.json();
    return targets.some((target) => {
      if (target.type !== "page") return false;
      const url = String(target.url || "").toLowerCase();
      const title = String(target.title || "").toLowerCase();
      return (
        url.includes("workbench") ||
        url.includes("vscode-file") ||
        title.includes("trae") ||
        title.includes("solo")
      );
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decides whether the Trae CN instance currently bound to `cdpPort` is one this
 * launcher manages (i.e. carries our `--user-data-dir`).
 *
 * Returns one of:
 *   - "owned":   a matching process carries our exact `--user-data-dir`.
 *   - "foreign": a matching process pins a different `--user-data-dir`, so the
 *                 window is owned by another enhancer (or a different profile)
 *                 and must be restarted before we inject into it.
 *   - "default": a matching process exposes CDP without pinning any
 *                 `--user-data-dir`, which is Trae CN's default profile and
 *                 therefore ours (storage.json sits where we expect it).
 *   - "none":    no `Trae CN.exe` process claims the port; nothing to fight over.
 */
export async function isTraeCdpManagedBy(cdpPort, userDataDir) {
  const script = `
    $portArg = '--remote-debugging-port=${cdpPort}'
    try {
      $items = @(Get-CimInstance Win32_Process -Filter "Name='Trae CN.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($portArg)
      } | Select-Object -ExpandProperty CommandLine)
    } catch { $items = @() }
    if (-not $items -or -not $items.Count) { Write-Output 'none'; exit }
    $userArg = '--user-data-dir=${userDataDir}'
    $explicit = @($items | Where-Object { $_ -match '--user-data-dir=' })
    if ($explicit.Count) {
      if (($explicit | Where-Object { $_.Contains($userArg) }).Count) { Write-Output 'owned'; exit }
      Write-Output 'foreign'; exit
    }
    Write-Output 'default'
  `;
  const output = await runPowerShell(script);
  const result = String(output).split(/\r?\n/).find((line) => /^(owned|foreign|default|none)$/.test(line.trim()));
  return (result || "none").trim();
}

export async function findTraeWindowProcessIds(exePath) {
  const script = `
    $target = ${psQuote(exePath)}
    $items = @(Get-Process -Name 'Trae CN' -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and $_.Path.Equals($target, [System.StringComparison]::OrdinalIgnoreCase) -and $_.MainWindowHandle -ne 0
    } | Select-Object -ExpandProperty Id)
    $items | ConvertTo-Json -Compress
  `;
  const output = await runPowerShell(script);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isInteger);
}

export async function findTraeProcessIds(exePath) {
  const script = `
    $target = ${psQuote(exePath)}
    @(Get-Process -Name 'Trae CN' -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and $_.Path.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress
  `;
  const output = await runPowerShell(script);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isInteger);
}

/**
 * Image (executable) names that identify Cockpit Tools, without the `.exe`
 * suffix and lower-cased for comparison.
 */
export const COCKPIT_IMAGE_NAMES = [
  "cockpit tools",
  "cockpit-tools",
  "antigravity_cockpit_tools",
  "antigravity-cockpit-tools",
];

/** The executable base name, lower-cased and without the `.exe` suffix. */
export function normalizeImageBaseName(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const base = text.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.exe$/i, "").trim().toLowerCase();
}

export function isCockpitImageName(value) {
  const base = normalizeImageBaseName(value);
  return base !== "" && COCKPIT_IMAGE_NAMES.includes(base);
}

/**
 * `tasklist /FO CSV` wraps every field in double quotes. Only the first column
 * (the image name) matters here.
 */
export function parseTasklistImageNames(stdout) {
  const names = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let name;
    if (text.startsWith('"')) {
      const end = text.indexOf('"', 1);
      name = end > 0 ? text.slice(1, end) : "";
    } else {
      name = text.split(",")[0] ?? "";
    }
    name = name.trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * Layer 1 of the Cockpit probe.
 *
 * `tasklist.exe` is a native system binary, so it keeps working on a locked-down
 * machine where PowerShell execution is blocked by policy. That distinction is
 * the whole reason this layer exists first: on the intranet machine the
 * PowerShell-only probe threw, and the throw aborted an entire check-in sweep.
 */
async function probeCockpitByTasklist() {
  const { stdout } = await execFileAsync("tasklist.exe", ["/FO", "CSV", "/NH"], {
    timeout: 15000,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const found = parseTasklistImageNames(stdout).filter(isCockpitImageName);
  return { running: found.length > 0, detail: found.join(", ") };
}

/** Layer 2: the PowerShell implementation carried over from v1.0.0. */
async function probeCockpitByPowerShell() {
  const script = `
    $names = @('Cockpit Tools', 'cockpit-tools', 'antigravity_cockpit_tools', 'antigravity-cockpit-tools')
    $items = @(Get-Process -Name $names -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if (-not $items.Count) {
      $items = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and [System.IO.Path]::GetFileNameWithoutExtension($_.Path) -match '^(?i:Cockpit Tools|cockpit-tools)$'
      } | Select-Object -ExpandProperty Id)
    }
    $items | ConvertTo-Json -Compress
  `;
  const output = await runPowerShell(script);
  if (!output) return { running: false, detail: "" };
  const parsed = JSON.parse(output);
  const ids = (Array.isArray(parsed) ? parsed : [parsed]).filter(Number.isInteger);
  return { running: ids.length > 0, detail: ids.map(String).join(", ") };
}

const COCKPIT_PROBES = [
  { source: "tasklist", run: probeCockpitByTasklist },
  { source: "powershell", run: probeCockpitByPowerShell },
];

/**
 * Reports whether Cockpit Tools is running.
 *
 * `running` is a three-state value on purpose:
 *   - `true`  — definitively running
 *   - `false` — definitively not running
 *   - `null`  — every probe failed, so the answer is unknown
 *
 * `null` must never be collapsed into `false`. Both tools rotate the same
 * refresh tokens, so an unknown answer has to be handled with its own policy
 * instead of being treated as a green light.
 */
export async function probeCockpitTools() {
  const failures = [];
  for (const probe of COCKPIT_PROBES) {
    try {
      const result = await probe.run();
      return {
        running: result.running,
        source: probe.source,
        detail: result.detail,
        error: null,
        failures,
      };
    } catch (error) {
      failures.push({ source: probe.source, error: error?.message || String(error) });
    }
  }
  return {
    running: null,
    source: null,
    detail: "",
    error: failures.map((entry) => `${entry.source}: ${entry.error}`).join(" | "),
    failures,
  };
}

async function waitForExit(processIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const remaining = new Set(processIds);
  while (remaining.size && Date.now() < deadline) {
    for (const pid of [...remaining]) {
      try {
        process.kill(pid, 0);
      } catch {
        remaining.delete(pid);
      }
    }
    if (remaining.size) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return [...remaining];
}

export async function stopTraeForRestart(exePath, { timeoutMs = 15000 } = {}) {
  const processIds = await findTraeProcessIds(exePath);
  if (!processIds.length) return [];

  const script = `
    $ids = @(${processIds.join(",")})
    Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object {
      try { [void]$_.CloseMainWindow() } catch {}
    }
  `;
  await runPowerShell(script);
  let remaining = await waitForExit(processIds, timeoutMs);
  if (!remaining.length) return [];

  await new Promise((resolve) => setTimeout(resolve, 300));

  const forceScript = `
    $ids = @(${remaining.join(",")})
    Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue
  `;
  await runPowerShell(forceScript);
  remaining = await waitForExit(remaining, 5000);
  if (remaining.length) {
    throw new Error(`Unable to stop Trae CN process(es): ${remaining.join(", ")}`);
  }
  return [];
}

export async function startTraeWithCdp(exePath, port, userDataDir) {
  const args = ["--new-window", `--remote-debugging-port=${port}`];
  // Pin the profile explicitly so ownership is provable afterwards: an instance
  // started with our --user-data-dir is ours, and one without it (or with a
  // different one) is a foreign window we must take back before injecting.
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
  const child = spawn(exePath, args, {
    cwd: path.dirname(exePath),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return child.pid || null;
}

export async function waitForCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTraeCdpAvailable(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
