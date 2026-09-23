import { spawn } from "node:child_process";
import path from "node:path";
const children = [
  spawn(
    process.execPath,
    [
      path.resolve("target-app/node_modules/vite/bin/vite.js"),
      "--host",
      "localhost",
    ],
    { cwd: "target-app", stdio: "inherit", windowsHide: true },
  ),
  spawn(process.execPath, ["--import", "tsx", "automation/server.ts"], {
    stdio: "inherit",
    windowsHide: true,
  }),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}
for (const child of children) {
  child.on("error", stop);
  child.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 1;
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
