#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep the package name at the launcher boundary so release automation updates
// only a scalar version in plugin JSON, never a compound package specifier.
// Git plugins launch the registry release. Windows source plugins additionally
// require a build and native addon for the owned process supervisor.
const [version, ...extra] = process.argv.slice(2);
if (
  extra.length !== 0 ||
  !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version ?? "")
) {
  process.stderr.write(
    "REA plugin requires one exact rea-agents@VERSION pin.\n",
  );
  process.exitCode = 1;
} else {
  await launch(`rea-agents@${version}`);
}

async function launch(packageSpecifier) {
  // npm installs already carry the release-pinned runtime. Run it in this
  // process so the plugin keeps the caller's working directory and the
  // runtime retains ownership of provider and worker cleanup.
  const { default: bundledPackage } = await import("../package.json", {
    with: { type: "json" },
  });
  const sourceCheckout = await isSourceCheckout();
  let bundledRuntimeMatchesPin =
    !sourceCheckout &&
    packageSpecifier === `${bundledPackage.name}@${bundledPackage.version}`;
  if (bundledRuntimeMatchesPin) {
    try {
      await access(new URL("../dist/mcp/main.js", import.meta.url));
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
      bundledRuntimeMatchesPin = false;
    }
  }
  if (bundledRuntimeMatchesPin) {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("./rea.mjs", import.meta.url)),
      "mcp",
    ];
    await import("./rea.mjs");
    return;
  }

  const runnerModule = await import(
    sourceCheckout
      ? "../src/application/PackageRunnerCommand.mjs"
      : "../dist/application/PackageRunnerCommand.mjs"
  );
  const { packageRunnerCommand } = runnerModule;
  const [command, ...args] = packageRunnerCommand(
    "npx",
    packageSpecifier,
    process.platform,
  );
  // npm can satisfy the exact pin from a same-version local checkout. An
  // empty owned cwd prevents a Git-installed plugin or caller project from
  // shadowing the registry package with unbuilt/different local files.
  let workingDirectory;
  try {
    workingDirectory = await mkdtemp(join(tmpdir(), "rea-plugin-launcher-"));
  } catch (cause) {
    process.stderr.write(
      `REA plugin could not create its working directory: ${cause.message}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (process.platform === "win32") {
    await launchWindowsFallback(command, args, workingDirectory);
    return;
  }
  const child = spawn(command, args, {
    cwd: workingDirectory,
    // A dedicated POSIX process group gives this launcher ownership of the
    // package runner and any server it starts.
    detached: true,
    stdio: "inherit",
    shell: false,
  });
  let spawnFailed = false;
  const signals = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const forward = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform !== "win32" && child.pid !== undefined)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (cause) {
        if (!isMissingProcess(cause))
          process.stderr.write(
            `REA plugin could not forward ${signal}: ${cause.message}\n`,
          );
      }
    };
    signals.set(signal, forward);
    process.on(signal, forward);
  }
  const stopForwarding = () => {
    for (const [signal, listener] of signals) process.off(signal, listener);
  };
  child.once("error", (cause) => {
    spawnFailed = true;
    stopForwarding();
    process.stderr.write(
      `REA plugin could not start ${command}: ${cause.message}\n`,
    );
    process.exitCode = 1;
  });
  child.once("close", async (code, signal) => {
    stopForwarding();
    let cleanupFailed = false;
    try {
      await rm(workingDirectory, { recursive: true });
    } catch (cause) {
      cleanupFailed = true;
      process.stderr.write(
        `REA plugin retained its working directory at ${workingDirectory}: ${cause.message}\n`,
      );
    }
    if (spawnFailed) return;
    if (signal !== null && process.platform !== "win32") {
      // Preserve signal termination after the owned child has closed its streams.
      process.kill(process.pid, signal);
    } else {
      process.exitCode =
        code === 0 && cleanupFailed
          ? 1
          : (code ?? 128 + (constants.signals[signal] ?? 1));
    }
  });
}

async function isSourceCheckout() {
  // Published artifacts exclude src/. Also reject Git worktrees (whose .git is
  // a file) and source exports where Git metadata has been stripped.
  for (const path of ["../.git", "../src"]) {
    try {
      await access(new URL(path, import.meta.url));
      return true;
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
    }
  }
  return false;
}

async function launchWindowsFallback(command, args, workingDirectory) {
  let spawnOwnedProviderProcess;
  try {
    ({ spawnOwnedProviderProcess } =
      await import("../dist/process/ProviderProcess.js"));
  } catch (cause) {
    await rm(workingDirectory, { recursive: true }).catch(() => {});
    process.stderr.write(
      `REA Windows source plugins require npm ci && npm run build:cached and the Windows x64 native addon before loading the plugin. The owned process supervisor is unavailable: ${cause.message}\n`,
    );
    process.exitCode = 1;
    return;
  }
  let owned;
  try {
    owned = await spawnOwnedProviderProcess({
      command,
      arguments: args,
      runId: randomUUID(),
      cwd: workingDirectory,
      stdin: "pipe",
      platform: "win32",
    });
  } catch (cause) {
    await rm(workingDirectory, { recursive: true }).catch(() => {});
    process.stderr.write(
      `REA plugin could not start the owned Windows process tree: ${cause.message}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const child = owned.process;
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  if (child.stdin === null || child.stdin === undefined) {
    const cleanup = await owned.cleanup?.();
    if (cleanup?.cleaned === true)
      await rm(workingDirectory, { recursive: true }).catch(() => {});
    else
      process.stderr.write(
        `REA plugin retained its Windows process ownership directory at ${workingDirectory} because cleanup was not verified.\n`,
      );
    process.stderr.write(
      "REA plugin Windows process supervisor did not provide protocol stdin.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdin.pipe(child.stdin);
  let cleanupFailed = false;
  let cleanupPromise;
  const signals = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const forward = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      cleanupPromise ??= owned
        .cleanup?.()
        .then((result) => {
          if (!result.cleaned) {
            cleanupFailed = true;
            process.stderr.write(
              `REA plugin could not verify Windows process-tree cleanup: ${result.reason}\n`,
            );
          }
        })
        .catch((cause) => {
          cleanupFailed = true;
          process.stderr.write(
            `REA plugin Windows process-tree cleanup failed: ${cause.message}\n`,
          );
        });
    };
    signals.set(signal, forward);
    process.on(signal, forward);
  }
  child.once("error", (cause) => {
    process.stderr.write(
      `REA plugin Windows process supervisor failed: ${cause.message}\n`,
    );
    process.exitCode = 1;
  });
  child.once("close", async (code) => {
    for (const [signal, listener] of signals) process.off(signal, listener);
    await cleanupPromise;
    if (!cleanupFailed) {
      try {
        await rm(workingDirectory, { recursive: true });
      } catch (cause) {
        cleanupFailed = true;
        process.stderr.write(
          `REA plugin retained its working directory at ${workingDirectory}: ${cause.message}\n`,
        );
      }
    }
    process.exitCode = code === 0 && cleanupFailed ? 1 : (code ?? 1);
  });
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

function isMissingProcess(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ESRCH"
  );
}
