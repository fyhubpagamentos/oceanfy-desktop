const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oceanfyPicker", {
  onSources(callback) {
    ipcRenderer.on("picker:sources", (_event, sources) => callback(sources));
  },
  select(sourceId) {
    ipcRenderer.send("picker:select", sourceId);
  },
  cancel() {
    ipcRenderer.send("picker:cancel");
  },
});
