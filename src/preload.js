const { contextBridge, ipcRenderer } = require("electron");

function readVersionFromArgv() {
  const flag = "--oceanfy-version=";
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg ? arg.slice(flag.length) : "0.0.0";
}

contextBridge.exposeInMainWorld("oceanfyDesktop", {
  platform: "desktop",
  version: readVersionFromArgv(),
  listShareSources: () => ipcRenderer.invoke("desktop:list-sources"),
  setFullscreen: (value) => ipcRenderer.invoke("desktop:set-fullscreen", Boolean(value)),
  getFullscreen: () => ipcRenderer.invoke("desktop:get-fullscreen"),
  toggleFullscreen: () => ipcRenderer.invoke("desktop:toggle-fullscreen"),
  onFullscreenChange: (callback) => {
    const handler = (_event, value) => callback(Boolean(value));
    ipcRenderer.on("desktop:fullscreen-changed", handler);
    return () => ipcRenderer.removeListener("desktop:fullscreen-changed", handler);
  },
  checkForUpdates: () => ipcRenderer.invoke("desktop:check-updates"),
  installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
  onUpdateStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:update-status", handler);
    return () => ipcRenderer.removeListener("desktop:update-status", handler);
  },
});
