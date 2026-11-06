import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { nodeLauncher, sshLaunchFrame } from "./ssh-launch.js";

it("Node-only SSH hosts preserve private env and command stdin", async () => {
  const input = "first\n雪\u0000last";
  const child = spawn(process.execPath, ["-e", nodeLauncher], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", error = "";
  child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { error += c; });
  const marker = "Bearer NODE_FALLBACK_SECRET";
  expect(child.spawnargs.join(" ")).not.toContain(marker);
  child.stdin.write(sshLaunchFrame({ command: process.execPath, args: ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify([process.env.PRIVATE,s])))"], env: { PRIVATE: marker }, stdin: input }));
  const [code] = await once(child, "close");
  expect(error).toBe(""); expect(code).toBe(0); expect(JSON.parse(output)).toEqual([marker, input]);
});

it.each(["disconnect", "timeout"])("Node-only SSH hosts kill TERM-resistant groups on %s", async mode => {
  const child = spawn(process.execPath, ["-e", nodeLauncher], { stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; let ready!: () => void;
  const started = new Promise<void>(r => { ready = r; });
  child.stdout.on("data", c => { output += c; if (output.includes("ready")) ready(); });
  child.stdin.write(sshLaunchFrame({ command: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{}); console.log(process.pid+' ready');setInterval(()=>{},1000)"], env: {}, timeoutSec: mode === "timeout" ? 0.5 : 0, graceSec: 0.05 }));
  await started;
  if (mode === "disconnect") child.stdin.end();
  const [code] = await once(child, "close");
  expect(code).not.toBe(0);
  const pid = Number(output.split(" ")[0]);
  expect(() => process.kill(pid, 0)).toThrow();
});
