import path from "node:path";
import Database from "better-sqlite3";

if (!process.argv.includes("--confirm")) {
  console.error("Stop Plex Repairman first. Run again with --confirm to disable portal Basic authentication and clear its credentials. Existing media settings, credentials, and repairs are preserved.");
  process.exit(1);
}
const databasePath = path.join(path.resolve(process.env.CONFIG_DIR || "config"), "plex-repairman.db");
const db = new Database(databasePath, { fileMustExist: true });
try {
  db.transaction(() => {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run("portal.adminCredential");
    db.prepare("DELETE FROM app_settings WHERE key = ?").run("portal.basicAuth");
  })();
  console.log("Portal Basic authentication disabled and credentials cleared. Restart Plex Repairman, then configure Portal access in Bot settings if desired.");
} finally { db.close(); }
