import { resolve } from "node:path";
import { config as loadEnvironment } from "dotenv";

const root = resolve(import.meta.dirname, "..");

// A station restart must retain its gateway, lease-signing, and hardware
// configuration even when an operator starts one service directly. Explicit
// process variables always win; station settings take precedence over generic
// developer files.
for (const environmentFile of [".env.supervisor", ".env.local", ".env"]) {
  loadEnvironment({
    path: resolve(root, environmentFile),
    override: false,
    quiet: true,
  });
}
