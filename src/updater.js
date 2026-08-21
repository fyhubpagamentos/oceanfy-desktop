/**
 * Auto-update (estilo Discord):
 * - Só roda no app instalado (packaged)
 * - Baixa em background e avisa o renderer
 * - Instala no próximo restart (ou quando o user clicar)
 */

let started = false;
let autoUpdater = null;

function getAutoUpdater() {
  if (!autoUpdater) {
    // Lazy: electron-updater precisa do app do Electron já carregado
    ({ autoUpdater } = require("electron-updater"));
  }
  return autoUpdater;
}

function send(win, channel, payload) {
  try {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  } catch {
    /* ignore */
  }
}

function setupAutoUpdater(getMainWindow) {
  if (started) return;
  started = true;

  const { app } = require("electron");
  if (!app.isPackaged) return;

  const updater = getAutoUpdater();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = null;

  updater.on("checking-for-update", () => {
    send(getMainWindow(), "desktop:update-status", { status: "checking" });
  });

  updater.on("update-available", (info) => {
    send(getMainWindow(), "desktop:update-status", {
      status: "available",
      version: info.version,
    });
  });

  updater.on("update-not-available", (info) => {
    send(getMainWindow(), "desktop:update-status", {
      status: "none",
      version: info.version,
    });
  });

  updater.on("download-progress", (progress) => {
    send(getMainWindow(), "desktop:update-status", {
      status: "downloading",
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  updater.on("update-downloaded", (info) => {
    send(getMainWindow(), "desktop:update-status", {
      status: "ready",
      version: info.version,
    });
  });

  updater.on("error", (err) => {
    send(getMainWindow(), "desktop:update-status", {
      status: "error",
      message: err?.message || String(err),
    });
  });

  setTimeout(() => {
    void updater.checkForUpdates().catch(() => undefined);
  }, 8_000);

  setInterval(
    () => {
      void updater.checkForUpdates().catch(() => undefined);
    },
    4 * 60 * 60 * 1000,
  );
}

function installUpdateNow() {
  getAutoUpdater().quitAndInstall(false, true);
}

function checkForUpdatesManual() {
  const { app } = require("electron");
  if (!app.isPackaged) {
    return Promise.resolve({ status: "dev" });
  }
  return getAutoUpdater()
    .checkForUpdates()
    .then((result) => ({
      status: "checking",
      version: result?.updateInfo?.version ?? null,
    }));
}

module.exports = {
  setupAutoUpdater,
  installUpdateNow,
  checkForUpdatesManual,
};
