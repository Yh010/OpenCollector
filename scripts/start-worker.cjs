require("dotenv").config();

const { spawn } = require("node:child_process");

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(pnpmCommand, ["exec", "tsx", "src/worker.ts"], {
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
});

child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
});
