const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  session,
  protocol,
  shell,
  ipcMain,
  desktopCapturer,
  nativeImage,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { setupAutoUpdater, installUpdateNow, checkForUpdatesManual } = require("./updater");

// Chamadas WebRTC/WebSocket: sem isso o Chromium engasga timers com a janela
// minimizada/na bandeja e o ping para → proxy derruba o socket → loop de reconexão.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// Captura de tela em jogos (Windows):
// - WGC lida melhor com "fullscreen optimizations" / borderless
// - Desliga 0Hz (só envia frame quando "muda") — causa freeze em exclusive fullscreen
//   com o cursor ainda se mexendo por cima do frame preso.
app.commandLine.appendSwitch(
  "enable-features",
  "AllowWgcScreenCapturer,AllowWgcWindowCapturer",
);
app.commandLine.appendSwitch(
  "disable-features",
  "AllowDxgiGdiZeroHz,AllowWgcScreenZeroHz,AllowWgcWindowZeroHz,AllowWgcZeroHz",
);

const API_URL = "https://api.ocfy.chat";
const APP_URL = "https://app.ocfy.chat";
const START_URL = process.env.ELECTRON_START_URL || "";
const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://oceanfy`;
const ICON_PATH = path.join(__dirname, "..", "build", "icon.png");

// Em produção o frontend/dist é empacotado via extraResources -> resources/dist
const DIST_ROOT = path.join(process.resourcesPath, "dist");

const CONFIG_JS = `window.__OCEANFY__={VITE_API_URL:"${API_URL}",VITE_APP_URL:"${APP_URL}",VITE_LIVEKIT_URL:"wss://livekit.ocfy.chat"};`;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

let mainWindow = null;
let tray = null;
let isQuitting = false;
let pickerOpen = false;

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // O esquema precisa ser registrado como privilegiado ANTES do app ready.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);

  app.setAppUserModelId("com.oceanfy.app");

  // Registro do protocolo oceanfy:// (apenas registro, sem deep-link handling)
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("oceanfy", process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("oceanfy");
  }

  app.whenReady().then(onReady);
}

// ---------------------------------------------------------------------------
// Protocolo app:// — serve frontend/dist empacotado, com fallback SPA
// ---------------------------------------------------------------------------
function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    // Config em runtime: aponta o app para a API de produção
    if (pathname === "/config.js") {
      return new Response(CONFIG_JS, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }

    if (pathname === "/") pathname = "/index.html";

    // Fallback SPA: rotas sem extensão viram index.html (BrowserRouter)
    if (!path.extname(pathname)) pathname = "/index.html";

    const filePath = path.normalize(path.join(DIST_ROOT, pathname));
    if (!filePath.startsWith(path.normalize(DIST_ROOT + path.sep))) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const data = await fs.promises.readFile(filePath);
      const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      return new Response(data, { headers: { "content-type": mime } });
    } catch {
      // Asset inexistente com extensão → 404; sem index.html não há o que servir
      return new Response("Not found", { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// Permissões de mídia
// ---------------------------------------------------------------------------
function setupPermissions(ses) {
  const ALLOWED = new Set([
    "media",
    "display-capture",
    "notifications",
    "fullscreen",
    "pointerLock",
  ]);

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED.has(permission));
  });

  ses.setPermissionCheckHandler((_webContents, permission) => ALLOWED.has(permission));
}

// ---------------------------------------------------------------------------
// Compartilhamento de tela: picker próprio
// ---------------------------------------------------------------------------
function serializeSources(sources) {
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    type: source.id.startsWith("screen:") ? "screen" : "window",
    thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null,
    appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
  }));
}

function openSourcePicker(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 720,
      height: 540,
      parent: mainWindow || undefined,
      modal: Boolean(mainWindow),
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      backgroundColor: "#0A111F",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "picker-preload.js"),
      },
    });

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("picker:select", onSelect);
      ipcMain.removeListener("picker:cancel", onCancel);
      if (!picker.isDestroyed()) picker.close();
      resolve(value);
    };

    const onSelect = (event, sourceId) => {
      if (event.sender !== picker.webContents) return;
      settle(sources.find((s) => s.id === sourceId) || null);
    };
    const onCancel = (event) => {
      if (event.sender !== picker.webContents) return;
      settle(null);
    };

    ipcMain.on("picker:select", onSelect);
    ipcMain.on("picker:cancel", onCancel);
    picker.on("closed", () => settle(null));

    picker.loadFile(path.join(__dirname, "picker.html"));
    picker.webContents.once("did-finish-load", () => {
      picker.webContents.send("picker:sources", serializeSources(sources));
      picker.show();
    });
  });
}

function setupDisplayMediaHandler(ses) {
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (pickerOpen) {
        callback(null);
        return;
      }
      pickerOpen = true;
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true,
        });
        const chosen = await openSourcePicker(sources);
        if (!chosen) {
          callback(null); // rejeita → o site recebe NotAllowedError
          return;
        }
        if (request.audioRequested) {
          try {
            // loopback = áudio do sistema; restrictOwnAudio no getDisplayMedia
            // (renderer) faz o Chromium/Electron excluir o áudio do próprio Oceanfy
            // da captura — igual Discord (quem assiste não se ouve na stream).
            callback({ video: chosen, audio: "loopback" });
            return;
          } catch {
            // loopback indisponível → segue sem áudio
          }
        }
        callback({ video: chosen });
      } catch {
        try {
          callback(null);
        } catch {
          /* callback já consumido */
        }
      } finally {
        pickerOpen = false;
      }
    },
    { useSystemPicker: false },
  );
}

// ---------------------------------------------------------------------------
// Janela principal
// ---------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0A111F",
    autoHideMenuBar: true,
    fullscreenable: true,
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [`--oceanfy-version=${app.getVersion()}`],
      v8CacheOptions: "code",
    },
  });

  // Links externos abrem no navegador; navegação fica dentro do app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const insideApp =
      url.startsWith(APP_ORIGIN) || (START_URL && url.startsWith(START_URL));
    if (!insideApp) {
      event.preventDefault();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        shell.openExternal(url);
      }
    }
  });

  // Fechar minimiza para a bandeja; sair de verdade só pelo menu do tray
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (START_URL) {
    mainWindow.loadURL(START_URL);
  } else {
    mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }

  mainWindow.on("enter-full-screen", () => {
    mainWindow.webContents.send("desktop:fullscreen-changed", true);
  });
  mainWindow.on("leave-full-screen", () => {
    mainWindow.webContents.send("desktop:fullscreen-changed", false);
  });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  let trayImage = nativeImage.createFromPath(ICON_PATH);
  if (!trayImage.isEmpty()) {
    trayImage = trayImage.resize({ width: 16, height: 16 });
  }
  tray = new Tray(trayImage);
  tray.setToolTip("Oceanfy");

  const menu = Menu.buildFromTemplate([
    {
      label: "Abrir Oceanfy",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: "Iniciar com o Windows",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    {
      label: "Verificar atualizações",
      click: () => {
        void checkForUpdatesManual().then((result) => {
          if (result?.status === "dev") {
            dialog.showMessageBox({
              type: "info",
              title: "Oceanfy",
              message: "Auto-update só funciona no app instalado (não no modo dev).",
            });
          }
        });
      },
    },
    { type: "separator" },
    {
      label: "Sair",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function onReady() {
  if (!START_URL) {
    registerAppProtocol();
  }
  setupPermissions(session.defaultSession);
  setupDisplayMediaHandler(session.defaultSession);
  ipcMain.handle("desktop:list-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: String(source.id).startsWith("screen:") ? "screen" : "window",
      thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : null,
      appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
    }));
  });
  ipcMain.handle("desktop:set-fullscreen", (_event, value) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const next = Boolean(value);
    try {
      if (mainWindow.isFullScreen() !== next) {
        mainWindow.setFullScreen(next);
      }
    } catch {
      /* ignore */
    }
    // No Windows isFullScreen() pode atrasar — devolve o pedido e notifica o renderer
    try {
      mainWindow.webContents.send("desktop:fullscreen-changed", next);
    } catch {
      /* ignore */
    }
    return next;
  });
  ipcMain.handle("desktop:get-fullscreen", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return mainWindow.isFullScreen();
  });
  ipcMain.handle("desktop:toggle-fullscreen", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const next = !mainWindow.isFullScreen();
    try {
      mainWindow.setFullScreen(next);
    } catch {
      /* ignore */
    }
    try {
      mainWindow.webContents.send("desktop:fullscreen-changed", next);
    } catch {
      /* ignore */
    }
    return next;
  });
  ipcMain.handle("desktop:check-updates", () => checkForUpdatesManual());
  ipcMain.handle("desktop:install-update", () => {
    installUpdateNow();
    return true;
  });
  createMainWindow();
  createTray();
  setupAutoUpdater(() => mainWindow);
}

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  // Mantém o app vivo na bandeja; a saída real acontece pelo menu "Sair"
  if (isQuitting) app.quit();
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
  }
});
