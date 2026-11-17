import path from "node:path";
import Database from "better-sqlite3";

if (!process.argv.includes("--confirm")) {
  console.error("Stop Plex Repairman first. Run again with --confirm to reset only the portal administrator password. Existing media settings, credentials, and repairs are preserved.");
  process.exit(1);
}
const databasePath = path.join(path.resolve(process.env.CONFIG_DIR || "config"), "plex-repairman.db");
const db = new Database(databasePath, { fileMustExist: true });
try {
  db.prepare("DELETE FROM app_settings WHERE key = ?").run("portal.adminCredential");
  console.log("Administrator password reset. Start Plex Repairman, then use /config/portal-setup-token to create a new password.");
} finally { db.close(); }
