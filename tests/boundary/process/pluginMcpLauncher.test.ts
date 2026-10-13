import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const launcher = fileURLToPath(
  new URL("../../../scripts/plugin-mcp-launcher.mjs", import.meta.url),
);

const start = (path: string, version = "6.4.0-rc.1", entry = launcher) => {
  const child = spawn(process.execPath, [entry, version], {
    env: {
      ...process.env,
      PATH: `${path}${delimiter}${process.env.PATH ?? ""}`,
    },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on(
    "data",
    (bytes: Buffer) => (stdout += bytes.toString("utf8")),
  );
  child.stderr.on(
    "data",
    (bytes: Buffer) => (stderr += bytes.toString("utf8")),
  );
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  });
  return { child, closed };
};

const fakeRunner = async (body: string) => {
  const root = await createTestTempDirectory("rea-plugin-launcher-");
  const bin = join(root, "plugin with spaces", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npx"), `#!${process.execPath}\n${body}\n`, {
    mode: 0o755,
  });
  return bin;
};

it.skipIf(process.platform === "win32")(
  "passes the exact pin and protocol streams through the source-only plugin launcher",
  async () => {
    const bin = await fakeRunner(`
      process.stderr.write(JSON.stringify(process.argv.slice(2)));
      process.stdin.pipe(process.stdout);
      process.stdin.on("end", () => { process.exitCode = 7; });
    `);
    const { child, closed } = start(bin, "6.4.0-rc.1");
    child.stdin.end('{"jsonrpc":"2.0","id":1}\n');
    expect(await closed).toEqual({
      code: 7,
      signal: null,
      stdout: '{"jsonrpc":"2.0","id":1}\n',
      stderr: '["-y","rea-agents@6.4.0-rc.1","mcp"]',
    });
  },
);

it.skipIf(process.platform === "win32")(
  "forwards termination to the live package-runner child before exiting",
  async () => {
    const bin = await fakeRunner(`
      process.on("SIGTERM", () => { process.stderr.write("stopped"); process.exit(0); });
      process.stdout.write("ready");
      process.stdin.resume();
    `);
    const { child, closed } = start(bin);
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    expect(await closed).toMatchObject({ code: 0, stderr: "stopped" });
  },
);

it.skipIf(process.platform === "win32")(
  "stops a package runner and its long-lived server with stdin still open",
  async () => {
    const root = await createTestTempDirectory("rea-plugin-process-tree-");
    const runnerMarker = join(root, "runner-stopped");
    const serverMarker = join(root, "server-stopped");
    const bin = await fakeRunner(`
      const { appendFileSync } = require("node:fs");
      const { spawn } = require("node:child_process");
      const server = spawn(process.execPath, ["-e", ${JSON.stringify(`
        const { appendFileSync } = require("node:fs");
        process.on("SIGTERM", () => {
          appendFileSync(${JSON.stringify(serverMarker)}, "stopped\\n");
          process.exit(0);
        });
        process.stdin.resume();
        process.stdout.write("server-ready\\n");
      `)}], { stdio: "inherit" });
      let stopping = false;
      process.on("SIGTERM", () => {
        stopping = true;
        appendFileSync(${JSON.stringify(runnerMarker)}, "stopped\\n");
      });
      process.stdin.resume();
      server.once("close", () => { if (stopping) process.exit(0); });
    `);
    const { child, closed } = start(bin);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("package server did not become ready")),
        5_000,
      );
      child.stdout.on("data", (bytes: Buffer) => {
        if (bytes.toString("utf8").includes("server-ready\n")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", reject);
    });

    // Keep the protocol pipe open: shutdown must reach the package runner and
    // its server process independently of EOF on stdin.
    child.kill("SIGTERM");
    expect(await closed).toMatchObject({ code: 0, signal: null });
    await expect(readFile(runnerMarker, "utf8")).resolves.toBe("stopped\n");
    await expect(readFile(serverMarker, "utf8")).resolves.toBe("stopped\n");
  },
);

it.skipIf(process.platform === "win32")(
  "isolates local package resolution and removes the owned runner directory",
  async () => {
    const bin = await fakeRunner("process.stdout.write(process.cwd());");
    const { child, closed } = start(bin);
    child.stdin.end();
    const result = await closed;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("rea-plugin-launcher-");
    expect(result.stdout).not.toBe(process.cwd());
    await expect(lstat(result.stdout)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("rejects a shell expression instead of treating it as the pinned package", async () => {
  const root = await createTestTempDirectory("rea-plugin-invalid-pin-");
  const { child, closed } = start(root, "6.4.0&echo wrong");
  child.stdin.end();
  expect(await closed).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "REA plugin requires one exact rea-agents@VERSION pin.\n",
  });
});

const pluginFixture = async () => {
  const root = await createTestTempDirectory("rea-plugin-release-origin-");
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "dist/mcp"), { recursive: true });
  const entry = join(root, "scripts/plugin-mcp-launcher.mjs");
  await copyFile(launcher, entry);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "rea-agents",
      version: "6.4.0",
      type: "module",
    }),
  );
  await writeFile(join(root, "dist/mcp/main.js"), "");
  await writeFile(
    join(root, "scripts/rea.mjs"),
    'process.stdout.write("bundled-runtime");',
  );
  return { root, entry };
};

it
  .skipIf(process.platform === "win32")
  .each(["directory", "worktree file", "exported source"])(
  "uses the registry pin even when a %s checkout has same-version dist",
  async (kind) => {
    const { root, entry } = await pluginFixture();
    await mkdir(join(root, "src/application"), { recursive: true });
    await copyFile(
      fileURLToPath(
        new URL(
          "../../../src/application/PackageRunnerCommand.mjs",
          import.meta.url,
        ),
      ),
      join(root, "src/application/PackageRunnerCommand.mjs"),
    );
    if (kind === "directory") await mkdir(join(root, ".git"));
    else if (kind === "worktree file")
      await writeFile(join(root, ".git"), "gitdir: /fixture/worktree");
    const bin = await fakeRunner(
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    );
    const { child, closed } = start(bin, "6.4.0", entry);
    child.stdin.end();
    expect(await closed).toMatchObject({
      code: 0,
      stdout: '["-y","rea-agents@6.4.0","mcp"]',
      stderr: "",
    });
  },
);

it("uses the matching installed runtime without another package-runner install", async () => {
  const { root, entry } = await pluginFixture();
  const { child, closed } = start(root, "6.4.0", entry);
  child.stdin.end();
  expect(await closed).toMatchObject({
    code: 0,
    stdout: "bundled-runtime",
    stderr: "",
  });
});
