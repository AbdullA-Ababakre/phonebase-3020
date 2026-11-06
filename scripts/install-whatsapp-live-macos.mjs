#!/usr/bin/env node
/** Persistent visual listener, with process recovery. No scheduled message checks. */
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const label = "com.phoneuse.ali-whatsapp-live";
const runtime = resolve(option("--runtime") || process.cwd());
const ledger = option("--ledger");
const target = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const logs = resolve(runtime, ".runtime/whatsapp-live-verified");
const xml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const run = (...argv) => execFileSync("/bin/launchctl", argv, { encoding: "utf8", stdio: "pipe" });

if (args.includes("--status")) {
  console.log(run("print", `${domain}/${label}`));
} else if (args.includes("--uninstall")) {
  run("bootout", domain, target);
  // Preserve configuration, conversation state and logs for recovery/review.
  console.log("Listener stopped. Saved configuration and message state were preserved.");
} else {
  if (!ledger) throw Error("Pass the existing dedicated WhatsApp ledger with --ledger");
  await fs.access(resolve(runtime, "scripts/whatsapp-live.ts"));
  await fs.access(resolve(runtime, "node_modules/tsx/package.json"));
  await fs.access(resolve(ledger));
  const node = process.execPath.startsWith("/opt/homebrew/") ? "/opt/homebrew/bin/node" : process.execPath;
  const argv = ["/usr/bin/caffeinate", "-i", node, "--import", "tsx", "scripts/whatsapp-live.ts", "--reply",
    "--state-dir", ".runtime/whatsapp-live-verified", "--ledger", resolve(ledger)];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${argv.map(v => `<string>${xml(v)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(runtime)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || "/opt/homebrew/bin:/usr/bin:/bin")}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>120</integer>
<key>StandardOutPath</key><string>${xml(resolve(logs, "service.out.log"))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(logs, "service.err.log"))}</string>
</dict></plist>
`;
  if (args.includes("--print")) console.log(plist);
  else if (args.includes("--install")) {
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.mkdir(logs, { recursive: true, mode: 0o700 });
    let loaded = false;
    try { run("print", `${domain}/${label}`); loaded = true; } catch {}
    if (loaded) throw Error("Listener service already installed; use launchctl to stop it before replacing configuration");
    await fs.writeFile(target, plist, { mode: 0o600, flag: "wx" });
    execFileSync("/usr/bin/plutil", ["-lint", target], { stdio: "inherit" });
    run("bootstrap", domain, target);
    console.log(JSON.stringify({ label, target, runtime, mode: "continuous_live_frames", restartOnExit: true }));
  } else throw Error("Use --print, --install, --status or --uninstall");
}
