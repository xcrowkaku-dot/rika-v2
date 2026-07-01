const models = require("./models");
const utils = require("../utils");

let uniqueIndexEnsured = false;
let autoBackupInterval = null;

function getBackupModel() {
  if (!models || !models.sequelize || !models.Sequelize) return null;
  const sequelize = models.sequelize;
  const { DataTypes } = models.Sequelize;

  if (sequelize.models && sequelize.models.AppStateBackup) {
    return sequelize.models.AppStateBackup;
  }

  const dialect =
    typeof sequelize.getDialect === "function"
      ? sequelize.getDialect()
      : "sqlite";
  const LongText =
    dialect === "mysql" || dialect === "mariadb"
      ? DataTypes.TEXT("long")
      : DataTypes.TEXT;

  const AppStateBackup = sequelize.define(
    "AppStateBackup",
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      userID: { type: DataTypes.STRING, allowNull: false },
      type: { type: DataTypes.STRING, allowNull: false },
      data: { type: LongText },
      // Add expiry tracking for better session management
      expiresAt: { type: DataTypes.DATE, allowNull: true },
      lastActivityAt: { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW }
    },
    {
      tableName: "app_state_backups",
      timestamps: true,
      indexes: [
        { unique: true, fields: ["userID", "type"] },
        { fields: ["expiresAt"] },
        { fields: ["lastActivityAt"] }
      ]
    }
  );
  return AppStateBackup;
}

async function ensureUniqueIndex(sequelize) {
  if (uniqueIndexEnsured) return;
  try {
    await sequelize
      .getQueryInterface()
      .addIndex("app_state_backups", ["userID", "type"], {
        unique: true,
        name: "app_state_user_type_unique"
      });
  } catch {}
  uniqueIndexEnsured = true;
}

async function upsertBackup(Model, userID, type, data, expiresAt = null) {
  const where = { userID: String(userID || ""), type };
  const updateData = { 
    data, 
    lastActivityAt: new Date(),
    ...(expiresAt && { expiresAt })
  };
  
  const row = await Model.findOne({ where });
  if (row) {
    await row.update(updateData);
    utils.log(`Overwrote existing ${type} backup for user ${where.userID}`);
    return;
  }
  await Model.create({ ...where, ...updateData });
  utils.log(`Created new ${type} backup for user ${where.userID}`);
}

async function backupAppStateSQL(jar, userID) {
  try {
    const Model = getBackupModel();
    if (!Model) return;
    await Model.sync();
    await ensureUniqueIndex(models.sequelize);

    const appState = utils.getAppState(jar);
    const cookieStr = cookieHeaderFromJar(jar);
    
    // Calculate cookie expiry (default to 90 days if not determinable)
    let expiresAt = null;
    try {
      const cookies = jar.getCookiesSync("https://www.facebook.com");
      const cUserCookie = cookies.find(c => c.key === "c_user");
      if (cUserCookie && cUserCookie.expires) {
        expiresAt = new Date(cUserCookie.expires);
      } else {
        // Default 90 days from now
        expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      }
    } catch (e) {
      expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    }

    await upsertBackup(Model, userID, "appstate", JSON.stringify(appState), expiresAt);
    await upsertBackup(Model, userID, "cookie", cookieStr, expiresAt);

    utils.log("AppState backup stored successfully");
  } catch (e) {
    utils.warn(
      `Failed to save AppState backup: ${
        e && e.message ? e.message : String(e)
      }`
    );
  }
}

async function getLatestBackup(userID, type) {
  try {
    const Model = getBackupModel();
    if (!Model) return null;
    const row = await Model.findOne({
      where: { userID: String(userID || ""), type }
    });
    return row ? row.data : null;
  } catch {
    return null;
  }
}

async function getLatestBackupAny(type) {
  try {
    const Model = getBackupModel();
    if (!Model) return null;
    const row = await Model.findOne({
      where: { type },
      order: [["updatedAt", "DESC"]]
    });
    return row ? row.data : null;
  } catch {
    return null;
  }
}

function cookieHeaderFromJar(jar) {
  const urls = ["https://www.facebook.com", "https://www.messenger.com"];
  const seen = new Set();
  const parts = [];
  for (const url of urls) {
    let cookieString = "";
    try {
      if (typeof jar.getCookieStringSync === "function") {
        cookieString = jar.getCookieStringSync(url);
      }
    } catch {}
    if (!cookieString) continue;
    for (const kv of cookieString.split(";")) {
      const trimmed = kv.trim();
      const name = trimmed.split("=")[0];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      parts.push(trimmed);
    }
  }
  return parts.join("; ");
}

async function hydrateJarFromDB(jar, userID) {
  try {
    const { normalizeCookieHeaderString, setJarFromPairs } = require("../utils/formatters/value/formatCookie");
    
    let cookieHeader = null;
    let appStateJson = null;

    if (userID) {
      cookieHeader = await getLatestBackup(userID, "cookie");
      appStateJson = await getLatestBackup(userID, "appstate");
    } else {
      cookieHeader = await getLatestBackupAny("cookie");
      appStateJson = await getLatestBackupAny("appstate");
    }

    if (cookieHeader) {
      const pairs = normalizeCookieHeaderString(cookieHeader);
      if (pairs.length) {
        setJarFromPairs(jar, pairs);
        return true;
      }
    }

    if (appStateJson) {
      let parsed = null;
      try {
        parsed = JSON.parse(appStateJson);
      } catch {}
      if (Array.isArray(parsed)) {
        const pairs = parsed.map(c => [c.name || c.key, c.value].join("="));
        setJarFromPairs(jar, pairs);
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Start automatic periodic backup of appState
 * @param {Object} jar - Cookie jar
 * @param {string} userID - User ID
 * @param {number} intervalMs - Backup interval in milliseconds (default: 5 minutes)
 */
function startAutoBackup(jar, userID, intervalMs = 5 * 60 * 1000) {
  // Clear existing interval if any
  if (autoBackupInterval) {
    clearInterval(autoBackupInterval);
    autoBackupInterval = null;
  }
  
  autoBackupInterval = setInterval(async () => {
    try {
      await backupAppStateSQL(jar, userID);
      utils.log("AppStateBackup", `Auto-backup completed for user ${userID}`);
    } catch (err) {
      utils.warn("AppStateBackup", "Auto-backup failed:", err.message);
    }
  }, intervalMs);
  
  utils.log("AppStateBackup", `Auto-backup started (interval: ${intervalMs}ms)`);
}

/**
 * Stop automatic backup
 */
function stopAutoBackup() {
  if (autoBackupInterval) {
    clearInterval(autoBackupInterval);
    autoBackupInterval = null;
    utils.log("AppStateBackup", "Auto-backup stopped");
  }
}

/**
 * Update session activity timestamp
 * @param {string} userID - User ID
 */
async function updateSessionActivity(userID) {
  try {
    const Model = getBackupModel();
    if (!Model) return;
    
    await Model.update(
      { lastActivityAt: new Date() },
      { where: { userID: String(userID || "") } }
    );
  } catch (e) {
    // Silent fail - not critical
  }
}

/**
 * Check if session is still valid based on expiry
 * @param {string} userID - User ID
 * @returns {Promise<boolean>}
 */
async function isSessionValid(userID) {
  try {
    const Model = getBackupModel();
    if (!Model) return true;
    
    const row = await Model.findOne({
      where: { userID: String(userID || ""), type: "appstate" }
    });
    
    if (!row || !row.expiresAt) return true;
    
    return new Date(row.expiresAt) > new Date();
  } catch {
    return true;
  }
}

module.exports = {
  getBackupModel,
  ensureUniqueIndex,
  upsertBackup,
  backupAppStateSQL,
  getLatestBackup,
  getLatestBackupAny,
  hydrateJarFromDB,
  cookieHeaderFromJar,
  startAutoBackup,
  stopAutoBackup,
  updateSessionActivity,
  isSessionValid
};
