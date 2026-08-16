require("dotenv").config();

const { spawn } = require("node:child_process");

if (process.env.HTTPS_PROXY) {
    process.env.NODE_USE_ENV_PROXY = "1";
}

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(pnpmCommand, ["exec", "tsx", "src/worker.ts"], {
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
});

child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
});
