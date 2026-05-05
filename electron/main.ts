import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, shell, nativeImage, protocol, net, safeStorage, clipboard, globalShortcut, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import { AcpSession, acpSessions } from './acpSession.js';
import { reviewRegistry } from './acpReview.js';

const require = createRequire(import.meta.url);

// Single-instance lock — without this, two Milu processes (e.g. a
// login-item launch + manual double-click, or a stale dev build still
// running) fight for the global launcher hotkey. The OS only honours
// one registration; whichever process registered first wins, and the
// second one's `globalShortcut.register` returns false silently.
// Bailing here lets the existing instance handle the new launch.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  // Important: stop module-level side-effects from running below.
  // app.quit() schedules an async exit so we still execute past this
  // point unless we throw; an explicit early-exit keeps things tidy.
  // eslint-disable-next-line no-undef
  process.exit(0);
}
app.on('second-instance', () => {
  // Another launch attempt — bring the existing main window forward
  // (or pop the launcher) so the user sees something happen.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Pin the user-visible name early — affects app menu, dock label, and
// `app.name` everywhere. Without this we'd fall through to the bundled
// Electron's "Electron" name in dev.
app.setName('Milu');

// Force the regular macOS activation policy at boot. Milu keeps this
// for the lifetime of the process — dock icon never disappears.
applyRegularActivationPolicy();

// Custom scheme used by the media viewer / image viewer to stream files from
// disk directly into <video>/<audio>/<img>. Bypasses the renderer's IPC and
// avoids huge base64 round-trips for large media. Privileged so the renderer
// can fetch from it without CORS / mixed-content rejection.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'milu-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
  // Production-mode renderer origin. The renderer is served from
  // `milu-app://app/...` so its origin is a real one — YouTube and
  // similar embed-restricted sites refuse to load inside iframes
  // hosted on `file://` (Error 153 / "Watch on YouTube"). In dev the
  // Vite server already gives us http://localhost:N, which works.
  {
    scheme: 'milu-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !!process.env.VITE_DEV_SERVER_URL;

/** Cached snapshot of ~/.milu/settings.json read once at app boot.
 *  Shipped to every BrowserWindow via webPreferences.additionalArguments
 *  so the preload can hand it to the renderer synchronously without
 *  having to do its own fs read (Node imports inside the preload
 *  throw under the launcher's sandboxed context). */
let initialSettingsBlob = '';
function loadInitialSettingsSync(): void {
  try {
    const file = path.join(os.homedir(), '.milu', 'settings.json');
    if (existsSync(file)) initialSettingsBlob = readFileSync(file, 'utf8');
  } catch {
    initialSettingsBlob = '';
  }
}
function settingsArg(): string {
  return `--milu-initial-settings=${initialSettingsBlob}`;
}

/** Production renderer URL — populated by `startRendererServer()`
 *  during app boot. We serve `dist/` over a random localhost port
 *  so the renderer's origin is `http://127.0.0.1:<port>` rather
 *  than `file://` or `milu-app://`. YouTube's embed policy only
 *  honours http(s) origins, so without this every embedded YouTube
 *  iframe in a packaged build refuses with Error 153. */
let prodRendererUrl: string | null = null;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
};

async function startRendererServer(): Promise<string> {
  const distDir = path.join(__dirname, '..', 'dist');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        let pathname = decodeURIComponent(url.pathname);
        if (pathname === '/' || pathname === '') pathname = '/index.html';
        const filePath = path.join(distDir, pathname);
        // Path-traversal guard — refuse any request that escapes
        // dist/. The local server is bound to 127.0.0.1 only, but
        // belt-and-braces.
        if (!filePath.startsWith(distDir)) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        const stream = createReadStream(filePath);
        stream.on('error', () => {
          res.statusCode = 404;
          res.end('not found');
        });
        stream.pipe(res);
      } catch {
        res.statusCode = 500;
        res.end('error');
      }
    });
    server.on('error', reject);
    // Port 0 = let the OS pick a free port.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(`http://127.0.0.1:${addr.port}`);
      } else {
        reject(new Error('renderer server: no address'));
      }
    });
  });
}

let mainWindow: BrowserWindow | null = null;
let launcherWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Cached dock-icon image, set once at boot and re-applied every time
 *  we flip the activation policy back to 'regular' from 'accessory'.
 *  macOS resets the dock icon to the bundle's default whenever it
 *  re-creates the dock entry (the accessory→regular transition does
 *  this), so without re-applying, dev builds revert to Electron's
 *  generic icon mid-session. */
let cachedDockIcon: Electron.NativeImage | null = null;
/** Pre-rendered tray icons for the two main-window states. */
let trayIconActive: Electron.NativeImage | null = null;
let trayIconDormant: Electron.NativeImage | null = null;
/** Renderer-pushed snapshot of tray-relevant state. The tray menu
 *  reads this directly instead of trying to access localStorage from
 *  the main process. Renderer pushes via 'tray:push-state' IPC on
 *  every settings update. */
let trayState: {
  recentFiles: string[];
  bookmarks: { name: string; path: string }[];
} = { recentFiles: [], bookmarks: [] };
ipcMain.on('tray:push-state', (_e, state: typeof trayState) => {
  trayState = state ?? { recentFiles: [], bookmarks: [] };
});
/** Set when the user actually wants to quit Milu (Cmd+Q, app menu →
 *  Quit). Lets the main-window close handler distinguish "user X'd the
 *  window" (which we intercept to hide instead) from "user is quitting"
 *  (which we let through). */
let appIsQuitting = false;
app.on('before-quit', () => { appIsQuitting = true; });

/** Last-resort safety net: an unhandled exception or rejection in
 *  the main process is otherwise fatal — Electron exits the whole
 *  app immediately, which has been observed to take Milu down
 *  mid-operation (e.g., when an ACP subprocess dies and a stray
 *  EPIPE leaks past a stream listener). Logging instead of crashing
 *  is the right tradeoff for an editor: lose one feature, not the
 *  whole session. */
process.on('uncaughtException', (err) => {
  console.error('[milu] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[milu] unhandledRejection:', reason);
});

/** Timestamp (Date.now) of the most recent `did-resign-active`.
 *  app.hide() / ⌘H / clicking another app all fire this. We use it to
 *  distinguish "main window hidden because the whole app was hidden"
 *  (don't switch to accessory — keep dock + ⌘Tab presence) from "main
 *  window hidden because user clicked X" (switch to accessory). */
let lastResignAt = 0;
app.on('did-resign-active', () => {
  lastResignAt = Date.now();
});

/** Milu's dock icon stays visible at all times — we never flip the
 *  activation policy after boot. Closing the main window hides it but
 *  doesn't put us in accessory mode.
 *  Note: do NOT call app.dock.show() here. On macOS that internally
 *  invokes NSApplication.unhide:, which can re-activate Milu and
 *  steal focus from other apps the user is trying to use. */
function applyRegularActivationPolicy() {
  if (process.platform === 'darwin' && app.setActivationPolicy) {
    app.setActivationPolicy('regular');
  }
}

/** Bring the main window forward — used as the universal "before X"
 *  step for tray menu items that need a visible main window. */
function bringMainForward() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Send a path to the renderer for the standard "open file/folder"
 *  flow, after bringing main forward. */
function trayOpenPath(p: string) {
  if (!p) return;
  bringMainForward();
  mainWindow?.webContents.send('tray:open-path', p);
}

/** Build the tray icon's right-click menu. Rebuilt every time the
 *  state changes so labels stay accurate ("Show Milu" vs "Hide Milu")
 *  and the recent-files / bookmarks submenus reflect the latest state. */
function buildTrayMenu(): Menu {
  const mainVisible = !!mainWindow?.isVisible();
  // Recent files: shorten long paths for menu display ("…/parent/leaf").
  const fmtPath = (p: string) => {
    const parts = p.split('/').filter(Boolean);
    if (parts.length <= 2) return p;
    return '…/' + parts.slice(-2).join('/');
  };
  const recentItems: Electron.MenuItemConstructorOptions[] =
    trayState.recentFiles.slice(0, 10).map((p) => ({
      label: fmtPath(p),
      toolTip: p,
      click: () => trayOpenPath(p),
    }));
  const bookmarkItems: Electron.MenuItemConstructorOptions[] =
    trayState.bookmarks.slice(0, 12).map((b) => ({
      label: b.name,
      toolTip: b.path,
      click: () => trayOpenPath(b.path),
    }));

  // Surfaced at the top of the tray menu so the user can see at a
  // glance whether the global hotkey actually bound — common failure
  // mode is another app already owning the shortcut, which makes
  // globalShortcut.register return false silently. The retry item
  // lets them re-attempt without restarting Milu.
  const hotkeyOk = !!currentLauncherHotkey;
  const desiredHotkey = lastRequestedLauncherHotkey ?? DEFAULT_LAUNCHER_HOTKEY;
  return Menu.buildFromTemplate([
    {
      label: 'Open Launcher',
      accelerator: currentLauncherHotkey ?? undefined,
      click: () => toggleLauncher(),
    },
    {
      label: hotkeyOk
        ? `Hotkey: ${currentLauncherHotkey} ✓`
        : `Hotkey ${desiredHotkey} not bound — click to retry`,
      enabled: !hotkeyOk,
      click: () => {
        const ok = registerLauncherHotkey(desiredHotkey);
        if (!ok && tray) {
          tray.displayBalloon?.({
            title: 'Milu',
            content: `Could not bind ${desiredHotkey}. Another app may own it.`,
          });
        }
        // Rebuild the menu so the status line updates.
        tray?.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    {
      label: mainVisible ? 'Hide Main Window' : 'Show Milu',
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else bringMainForward();
      },
    },
    { type: 'separator' },
    {
      label: 'Recent Files',
      enabled: recentItems.length > 0,
      submenu: recentItems.length > 0
        ? recentItems
        : [{ label: '(none yet)', enabled: false }],
    },
    {
      label: 'Workspace Bookmarks',
      enabled: bookmarkItems.length > 0,
      submenu: bookmarkItems.length > 0
        ? bookmarkItems
        : [{ label: '(none yet — bookmark a folder in Settings)', enabled: false }],
    },
    { type: 'separator' },
    {
      label: 'Preferences…',
      click: () => {
        bringMainForward();
        mainWindow?.webContents.send('menu:preferences');
      },
    },
    {
      label: 'Activity (Process Viewer)',
      click: () => {
        bringMainForward();
        mainWindow?.webContents.send('menu:process-viewer');
      },
    },
    {
      label: 'Keyboard Shortcuts',
      click: () => {
        bringMainForward();
        mainWindow?.webContents.send('menu:show-shortcuts');
      },
    },
    {
      label: 'Show Onboarding Tour',
      click: () => {
        bringMainForward();
        mainWindow?.webContents.send('menu:show-onboarding');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Milu',
      accelerator: 'Cmd+Q',
      click: () => app.quit(),
    },
  ]);
}

/** Reflect main-window visibility in the tray icon. Called from the
 *  show/hide event handlers and once at boot. */
function updateTrayState() {
  if (!tray) return;
  const visible = !!mainWindow?.isVisible();
  tray.setImage((visible ? trayIconActive : trayIconDormant) ?? nativeImage.createEmpty());
  tray.setToolTip(visible ? 'Milu' : 'Milu (hidden — click to open launcher)');
}

async function createTray() {
  if (tray) return;
  const icons = await generateTrayIcons();
  trayIconActive = icons.active;     // filled M — confident
  trayIconDormant = icons.dormant;   // outlined M — quieter
  tray = new Tray(trayIconActive);
  tray.setToolTip('Milu');
  // Single click → open the launcher. Right-click shows the context
  // menu. We don't attach the menu via setContextMenu directly,
  // because that overrides the click handler too — instead we open it
  // explicitly on right-click.
  tray.on('click', () => {
    toggleLauncher();
  });
  tray.on('right-click', () => {
    tray?.popUpContextMenu(buildTrayMenu());
  });
}

/** Render the tray icons by drawing a folder silhouette with an "M"
 *  composited onto an offscreen canvas. Two states:
 *    - active:  filled folder with the M cut out (destination-out)
 *    - dormant: outlined folder with a solid M inside
 *  Marked as template images so macOS tints them for the menu bar's
 *  light/dark mode automatically. */
async function generateTrayIcons(): Promise<{ active: Electron.NativeImage; dormant: Electron.NativeImage }> {
  // Hidden helper window — runs the canvas rendering in a real
  // Chromium context so we get system font access and proper text
  // hinting, then closes immediately.
  const helper = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // Target 20pt menu-bar height. At retina 2× that's 40 actual pixels.
  const PT = 20;
  const PX = PT * 2;
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">
<canvas id="a" width="${PX}" height="${PX}"></canvas>
<canvas id="d" width="${PX}" height="${PX}"></canvas>
<script>
  // Folder geometry — tab at top-left, body below. Both rounded; the
  // tab's bottom corners are square because the body overlaps and
  // hides them. Sized for the 40px canvas.
  const TAB_X = 4, TAB_Y = 6, TAB_W = 14, TAB_H = 6;
  const BODY_X = 4, BODY_Y = 11, BODY_W = 32, BODY_H = 23;
  const R = 3;

  function drawFolder(ctx, mode) {
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.roundRect(TAB_X, TAB_Y, TAB_W, TAB_H, [R, R, 0, 0]);
    if (mode === 'fill') ctx.fill(); else ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(BODY_X, BODY_Y, BODY_W, BODY_H, R);
    if (mode === 'fill') ctx.fill(); else ctx.stroke();
  }

  function drawM(ctx, op) {
    ctx.globalCompositeOperation = op;
    ctx.fillStyle = '#000';
    ctx.font = '900 ' + Math.round(${PX} * 0.42) + 'px "Futura", "Avenir Next", "SF Pro Rounded", system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', ${PX / 2}, BODY_Y + BODY_H / 2 + 1);
    ctx.globalCompositeOperation = 'source-over';
  }

  function draw(id, mode) {
    const c = document.getElementById(id);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, ${PX}, ${PX});
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    if (mode === 'active') {
      // Solid folder, then carve M out of it.
      drawFolder(ctx, 'fill');
      drawM(ctx, 'destination-out');
    } else {
      // Outlined folder with a solid M inside.
      drawFolder(ctx, 'stroke');
      drawM(ctx, 'source-over');
    }
    return c.toDataURL('image/png');
  }
  window.__icons = {
    active:  draw('a', 'active'),
    dormant: draw('d', 'dormant'),
  };
</script></body>`;
  await helper.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const result = (await helper.webContents.executeJavaScript('window.__icons')) as {
    active: string;
    dormant: string;
  };
  helper.destroy();
  // dataURL → buffer → nativeImage with scaleFactor=2 so macOS treats
  // the 40px image as 20pt logical, not 40pt.
  const decode = (dataURL: string) => {
    const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
    return Buffer.from(base64, 'base64');
  };
  const active = nativeImage.createFromBuffer(decode(result.active), { scaleFactor: 2.0 });
  const dormant = nativeImage.createFromBuffer(decode(result.dormant), { scaleFactor: 2.0 });
  // Template images: macOS tints them based on menu-bar appearance
  // (white on dark, black on light, with proper hover/click highlights).
  active.setTemplateImage(true);
  dormant.setTemplateImage(true);
  return { active, dormant };
}

const LAUNCHER_W = 600;
const LAUNCHER_H = 420;
/** Default launcher hotkey before the renderer pushes the user's
 *  configured value. The renderer's settings module pings us on boot
 *  and on every change, so this matters for ~the first second of the
 *  process lifetime. */
const DEFAULT_LAUNCHER_HOTKEY = 'Cmd+Alt+Space';
let currentLauncherHotkey: string | null = null;
/** Tracks what the user *wanted* even if registration failed. Read
 *  by the tray menu so the "Hotkey not bound — retry" item knows
 *  which accelerator to attempt. */
let lastRequestedLauncherHotkey: string | null = null;

function registerLauncherHotkey(accel: string): boolean {
  if (currentLauncherHotkey) {
    globalShortcut.unregister(currentLauncherHotkey);
  }
  if (!accel) {
    currentLauncherHotkey = null;
    lastRequestedLauncherHotkey = null;
    return false;
  }
  lastRequestedLauncherHotkey = accel;
  try {
    const ok = globalShortcut.register(accel, toggleLauncher);
    if (ok) {
      currentLauncherHotkey = accel;
      return true;
    }
    console.warn('[milu] failed to register launcher hotkey', accel);
    currentLauncherHotkey = null;
    return false;
  } catch (err) {
    console.warn('[milu] launcher hotkey error', (err as Error).message);
    currentLauncherHotkey = null;
    return false;
  }
}

function createLauncherWindow() {
  if (launcherWindow) return;
  launcherWindow = new BrowserWindow({
    width: LAUNCHER_W,
    height: LAUNCHER_H,
    // Normal NSWindow type. Tried 'panel' to avoid activation-policy
    // demotion on launcher show, but with the offscreen anchor window
    // already keeping Milu classified as regular, the panel type was
    // unnecessary and might have been triggering its own demotion path
    // (when an NSPanel is the only "real" frontmost window, macOS can
    // still classify the app as utility).
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [settingsArg()],
    },
  });

  // Hide on blur so the launcher feels ephemeral. Skipping in dev because
  // opening DevTools blurs the window and nukes the launcher mid-debug.
  // Skipping while dispatching so the user-action flow (which hides the
  // launcher then shows the main window) isn't intercepted.
  launcherWindow.on('blur', () => {
    if (suppressLauncherBlur) return;
    if (isDev && launcherWindow?.webContents.isDevToolsOpened()) return;
    hideLauncher();
  });
  launcherWindow.on('closed', () => {
    launcherWindow = null;
  });

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL!;
    launcherWindow.loadURL(new URL('launcher.html', devUrl).toString());
  } else if (prodRendererUrl) {
    launcherWindow.loadURL(`${prodRendererUrl}/launcher.html`);
  } else {
    launcherWindow.loadFile(path.join(__dirname, '../dist/launcher.html'));
  }
}

function showLauncher() {
  if (!launcherWindow) createLauncherWindow();
  if (!launcherWindow) return;
  // Apply the floating-overlay properties only on first show, not at
  // construction (see createLauncherWindow comment).
  launcherWindow.setAlwaysOnTop(true, 'floating');
  launcherWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Recenter relative to whichever display has the cursor — multi-monitor
  // friendly so the launcher always shows up where the user is looking.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  const wx = Math.round(x + (width - LAUNCHER_W) / 2);
  // Position slightly above center for a Spotlight-like feel.
  const wy = Math.round(y + (height - LAUNCHER_H) / 3);
  launcherWindow.setBounds({ x: wx, y: wy, width: LAUNCHER_W, height: LAUNCHER_H });
  launcherWindow.show();
  launcherWindow.focus();
  launcherWindow.webContents.send('launcher:show');
  // No setActivationPolicy() here. The anchor window keeps Milu
  // classified as regular continuously, and re-asserting at runtime
  // calls activate() under the hood — which forces the main window
  // forward (whether it was hidden or in the background). The whole
  // point of this design is "launcher is independent of main window".
}

function toggleLauncher() {
  if (!launcherWindow) createLauncherWindow();
  if (!launcherWindow) return;
  if (launcherWindow.isVisible() && launcherWindow.isFocused()) {
    hideLauncher();
  } else {
    showLauncher();
  }
}

/** Set during launcher:dispatch so the launcher's own blur listener
 *  (fired when we hide it) doesn't run hideLauncher() → app.hide() and
 *  block the subsequent mainWindow.show() from coming forward. */
let suppressLauncherBlur = false;


/** Dismiss the launcher. On macOS, app.hide() runs FIRST so Milu
 *  deactivates and all windows vanish in a single frame — preventing
 *  the visible "main flashes between launcher hide and app deactivate"
 *  race. The launcher.hide() that follows marks the launcher as
 *  explicitly orderOut'd so re-activating Milu (dock click, Cmd+Tab)
 *  brings only the main window back, not the launcher. */
function hideLauncher() {
  if (!launcherWindow) return;
  launcherWindow.hide();
  // No re-assertion — the anchor window is the source of truth for
  // activation policy. setActivationPolicy('regular') here would
  // re-activate the app and bring main forward, defeating the
  // launcher-independent-of-main design.
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#ffffff',
    show: false,
    // OS-level fullscreen of the main window is disabled. Milu's
    // activation policy flips between regular and accessory based on
    // window visibility, and macOS treats apps that ever go accessory
    // as "utility" for Space allocation purposes — fullscreen calls
    // appear to succeed but the window vanishes (no Space, no return
    // path). Disabling fullscreen entirely keeps the window present
    // and predictable. Video fullscreen is handled in-window by the
    // WebView component (the slot becomes position: fixed; inset: 0
    // to cover the viewport).
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      // Enable Chromium's built-in PDF viewer so the PdfViewer component can
      // render PDFs in an <embed type="application/pdf">.
      plugins: true,
      // Don't let Electron auto-fullscreen the BrowserWindow when a
      // video inside any guest webview enters HTML fullscreen — that
      // path uses native setFullScreen, which is the disappearance
      // trigger (see fullscreenable: false comment above).
      disableHtmlFullscreenWindowResize: true,
      additionalArguments: [settingsArg()],
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Raycast-style lifecycle: the main window's red X / Cmd+Shift+W hides
  // it instead of closing. Milu stays running in the background.
  // Cmd+Q sets appIsQuitting and bypasses this so quit still works.
  mainWindow.on('close', (e) => {
    if (appIsQuitting) return;
    e.preventDefault();
    mainWindow?.hide();
  });

  // Tie activation policy to main-window visibility:
  //   visible main window → 'regular' → dock icon, in ⌘Tab
  //   hidden main window → 'accessory' → no dock, no ⌘Tab, but Milu
  //                                       still runs and the launcher
  //                                       hotkey still works.
  // The launcher's "Show Milu" command (or any other path that calls
  // mainWindow.show()) flips us back to regular automatically. This
  // matches every other macOS app's mental model — dock icon presence
  // tracks "the app has a window open" — so we stop fighting the OS.
  if (process.platform === 'darwin') {
    mainWindow.on('show', () => {
      app.setActivationPolicy('regular');
      // accessory→regular re-creates the dock entry from the bundle's
      // default icon (Electron's diamond in dev). Re-apply our cached
      // PNG so the dock always shows Milu's brand mark.
      if (cachedDockIcon && app.dock) {
        app.dock.setIcon(cachedDockIcon);
      }
      updateTrayState();
    });
    mainWindow.on('hide', () => {
      // If the app just became inactive (within 200ms), this hide is
      // a side-effect of app.hide() — i.e., ⌘H or another app stole
      // focus. Keep regular policy so the user can ⌘Tab back. Only
      // window-only hides (X-button click, programmatic .hide()) flip
      // us to accessory mode.
      if (Date.now() - lastResignAt < 200) {
        updateTrayState();
        return;
      }
      app.setActivationPolicy('accessory');
      updateTrayState();
    });
  }


  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else if (prodRendererUrl) {
    // Real http://127.0.0.1 origin so YouTube embeds work — see
    // startRendererServer() above for why this matters.
    mainWindow.loadURL(`${prodRendererUrl}/index.html`);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Intercept popups opened from <webview> tags inside Milu (e.g., OAuth
 *  sign-in flows for Google, Twitter, GitHub). The default behavior opens
 *  them at full size without a sensible parent — we want a small floating
 *  window above the main one, sharing the default session so cookies set
 *  during the popup auth flow are visible to the originating webview. */
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url, features }) => {
    // OAuth and share-sheet flows call window.open(url, '_blank',
    // 'width=520,height=640,...') — any explicit width/height in
    // `features` means the source wanted a sized popup, not a tab.
    // Keep those as separate floating windows so sign-in flows still
    // work end-to-end.
    const isSizedPopup = /\b(width|height|top|left)\s*=/.test(features || '');
    if (isSizedPopup) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 640,
          parent: mainWindow ?? undefined,
          modal: false,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }
    // Anything else — middle-click, ⌘-click, target="_blank", plain
    // window.open — forward to the main renderer to open as a Milu
    // web tab. We don't filter on `disposition` because Chromium
    // sometimes reports edge cases as 'other' or 'default' for
    // perfectly normal links.
    if (url) {
      console.log('[milu] webview:open-url forwarding:', url);
      mainWindow?.webContents.send('webview:open-url', url);
    }
    return { action: 'deny' };
  });

  // Tab-navigation shortcuts: a focused <webview> normally swallows
  // these keys before they reach Milu's app menu, so once a user
  // clicks into a web tab they can't ⌘⇧[ / ⌘⇧] back out. Intercept
  // them at the guest's before-input-event and forward to the main
  // renderer so the menu IPC handler runs as if the keystroke had
  // hit the host window.
  // Suppress the guest's default context menu — the WebView
  // component renders its own Milu-aware menu (Open Link in New
  // Tab, Save Link to Later, Search Selection, etc.) via the
  // webview tag's `context-menu` event in the renderer.
  contents.on('context-menu', (event) => {
    event.preventDefault();
  });

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const cmd = input.meta || input.control;
    if (!cmd || input.alt) return;
    const send = (channel: string) => {
      event.preventDefault();
      mainWindow?.webContents.send(channel);
    };
    if (input.shift) {
      if (input.key === ']' || input.key === '}') return send('menu:next-tab');
      if (input.key === '[' || input.key === '{') return send('menu:prev-tab');
      // ⌘⇧9 / ⌘⇧0 → prev/next session. Shifted forms ('(' / ')') are
      // what input.key reports on US layouts; the bare digits cover
      // layouts/keyboards that don't shift to the parens.
      if (input.key === '9' || input.key === '(') return send('menu:prev-session');
      if (input.key === '0' || input.key === ')') return send('menu:next-session');
      // ⌘⇧T — reopen the most recently closed Milu tab. Mirrors
      // browser convention; webview otherwise has no semantics for it.
      if (input.key === 't' || input.key === 'T') return send('menu:reopen-closed-tab');
    } else {
      // ⌘1-8 and ⌘9 — tab jump shortcuts also get eaten by the guest.
      if (/^[1-8]$/.test(input.key)) return send(`menu:goto-tab-${input.key}`);
      if (input.key === '9') return send('menu:goto-tab-last');
      // ⌘W — close current Milu tab. The webview otherwise has no
      // close-tab semantics, so it's safe to forward.
      if (input.key === 'w' || input.key === 'W') return send('menu:close-tab');
      // ⌘F — find on page. The webview swallows this otherwise so the
      // user can never open Milu's find bar once they've clicked
      // into a page.
      if (input.key === 'f' || input.key === 'F') return send('menu:find-on-page');
      // ⌘H — hide the app. macOS's standard hide shortcut also gets
      // eaten by the guest, so we need to call app.hide() directly
      // here rather than rely on the menu role accelerator.
      if (input.key === 'h' || input.key === 'H') {
        event.preventDefault();
        app.hide();
        return;
      }
    }
  });
});

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const sendToRenderer = (channel: string, ...args: unknown[]) => {
    BrowserWindow.getFocusedWindow()?.webContents.send(channel, ...args);
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendToRenderer('menu:preferences'),
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              // Explicit click handler instead of `role: 'hide'`. The
              // role's auto-bound accelerator wasn't always firing
              // (suspect: focus state or menu rebuild timing). Calling
              // app.hide() directly via the click handler is the
              // canonical macOS hide behavior.
              {
                label: `Hide ${app.name}`,
                accelerator: 'Command+H',
                click: () => {
                  console.log('[milu] menu Hide clicked');
                  app.hide();
                },
              },
              {
                label: 'Hide Others',
                accelerator: 'Command+Alt+H',
                click: () => {
                  Menu.sendActionToFirstResponder?.('hideOtherApplications:');
                },
              },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] satisfies Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendToRenderer('menu:new'),
        },
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToRenderer('menu:open-file'),
        },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendToRenderer('menu:open-folder'),
        },
        {
          label: 'Quick Open…',
          accelerator: 'CmdOrCtrl+P',
          click: () => sendToRenderer('menu:quick-open'),
        },
        {
          label: 'Quick Open (Replace)…',
          accelerator: 'CmdOrCtrl+Alt+P',
          click: () => sendToRenderer('menu:quick-open-replace'),
        },
        {
          label: 'Find on Page…',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendToRenderer('menu:find-on-page'),
        },
        {
          label: 'Find in Files…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => sendToRenderer('menu:find-in-files'),
        },
        {
          label: 'Go to Path…',
          accelerator: 'CmdOrCtrl+T',
          click: () => sendToRenderer('menu:goto-path'),
        },
        {
          label: 'Go to Path (Replace)…',
          accelerator: 'CmdOrCtrl+Alt+T',
          click: () => sendToRenderer('menu:goto-path-replace'),
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => sendToRenderer('menu:reopen-closed-tab'),
        },
        {
          label: 'New Terminal',
          click: () => sendToRenderer('menu:new-terminal'),
        },
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => sendToRenderer('menu:focus-address'),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToRenderer('menu:save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToRenderer('menu:save-as'),
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendToRenderer('menu:close-tab'),
        },
        { type: 'separator' },
        {
          label: 'Reset Workspace…',
          click: () => sendToRenderer('menu:reset-workspace'),
        },
        ...(isMac ? [] : ([{ role: 'quit' }] satisfies Electron.MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Clipboard History…',
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () => sendToRenderer('menu:open-clipboard'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendToRenderer('menu:toggle-sidebar'),
        },
        {
          label: 'Toggle Outline',
          accelerator: 'CmdOrCtrl+Shift+\\',
          click: () => sendToRenderer('menu:toggle-outline'),
        },
        {
          label: 'Toggle Markdown View Mode',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => sendToRenderer('menu:toggle-markdown-mode'),
        },
        { type: 'separator' },
        {
          label: 'Split Right',
          accelerator: 'CmdOrCtrl+\\',
          click: () => sendToRenderer('menu:split-right'),
        },
        {
          label: 'Split Down',
          accelerator: 'CmdOrCtrl+=',
          click: () => sendToRenderer('menu:split-down'),
        },
        {
          label: 'Close Pane',
          accelerator: 'CmdOrCtrl+Alt+W',
          click: () => sendToRenderer('menu:close-pane'),
        },
        {
          label: 'Cycle Pane Layout',
          accelerator: 'CmdOrCtrl+Shift+Space',
          click: () => sendToRenderer('menu:cycle-layout'),
        },
        {
          label: 'Zoom Pane',
          accelerator: 'CmdOrCtrl+Shift+Return',
          click: () => sendToRenderer('menu:toggle-pane-zoom'),
        },
        {
          label: 'Next Pane',
          accelerator: 'CmdOrCtrl+`',
          click: () => sendToRenderer('menu:focus-pane-next'),
        },
        {
          label: 'Previous Pane',
          accelerator: 'CmdOrCtrl+Shift+`',
          click: () => sendToRenderer('menu:focus-pane-prev'),
        },
        {
          label: 'Process Viewer',
          accelerator: 'CmdOrCtrl+Y',
          click: () => sendToRenderer('menu:process-viewer'),
        },
        {
          label: 'Keyboard Shortcuts',
          // Use the canonical Shift+/ form rather than '?' — Electron
          // doesn't reliably resolve the shifted-key shorthand on macOS.
          accelerator: 'CmdOrCtrl+Shift+/',
          click: () => sendToRenderer('menu:show-shortcuts'),
        },
        { type: 'separator' },
        // ⌘R must NOT reload the whole BrowserWindow — that wipes every
        // open tab, every workspace, every unsaved scratch buffer. Route
        // the keystroke to the focused tab instead: web tabs use it to
        // refresh their page; everything else ignores it.
        {
          label: 'Reload Page',
          accelerator: 'CmdOrCtrl+R',
          click: () => sendToRenderer('menu:reload-page'),
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        // Move zoom-in off ⌘= so ⌘= can be Split Down. ⌘⇧= is the
        // explicit "+" key, which is what macOS already labels for zoom-in.
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+Shift+=' },
        { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'New Workspace',
          accelerator: 'CmdOrCtrl+Alt+N',
          click: () => sendToRenderer('menu:new-session'),
        },
        {
          label: 'Close Workspace',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => sendToRenderer('menu:close-session'),
        },
        {
          label: 'Previous Workspace',
          accelerator: 'CmdOrCtrl+Shift+9',
          click: () => sendToRenderer('menu:prev-session'),
        },
        {
          label: 'Next Workspace',
          accelerator: 'CmdOrCtrl+Shift+0',
          click: () => sendToRenderer('menu:next-session'),
        },
        { type: 'separator' },
        {
          label: 'Previous Tab',
          accelerator: 'CmdOrCtrl+Shift+[',
          click: () => sendToRenderer('menu:prev-tab'),
        },
        {
          label: 'Next Tab',
          accelerator: 'CmdOrCtrl+Shift+]',
          click: () => sendToRenderer('menu:next-tab'),
        },
        // Chrome-style numeric tab jumps. ⌘1–8 selects the Nth tab in the
        // focused leaf; ⌘9 jumps to the last tab regardless of count.
        ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map((n) => ({
          label: `Go to Tab ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          click: () => sendToRenderer(`menu:goto-tab-${n}`),
        } satisfies Electron.MenuItemConstructorOptions)),
        {
          label: 'Go to Last Tab',
          accelerator: 'CmdOrCtrl+9',
          click: () => sendToRenderer('menu:goto-tab-last'),
        },
        { type: 'separator' },
        { role: 'minimize' },
        { label: 'Close Window', role: 'close' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Read settings.json once and stash it for preload/window creation.
  // Both the main and launcher windows inherit it via additionalArguments.
  loadInitialSettingsSync();

  // First-launch: enrol Milu in macOS Login Items so the global
  // Cmd+Space launcher is available whenever the user logs in. We
  // mark a flag the first time we do this so subsequent launches
  // don't override the user's choice if they later remove Milu
  // from System Settings → General → Login Items themselves.
  if (process.platform === 'darwin') {
    void (async () => {
      try {
        const dir = path.join(os.homedir(), '.milu');
        await fs.mkdir(dir, { recursive: true });
        const flagPath = path.join(dir, '.login-item-set');
        try {
          await fs.access(flagPath);
          // Flag exists — user already had Milu enrolled (or
          // explicitly opted out by removing it). Don't touch it.
          return;
        } catch {
          /* fall through — first run */
        }
        app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false });
        await fs.writeFile(flagPath, new Date().toISOString(), 'utf8');
        console.log('[milu] enrolled in macOS login items (first launch)');
      } catch (err) {
        console.warn('[milu] login item enrol failed:', err);
      }
    })();
  }

  // Stream local files into the renderer through net.fetch — supports HTTP
  // range requests so <video> seeking works without buffering the whole clip.
  protocol.handle('milu-file', (req) => {
    const u = new URL(req.url);
    const filePath = decodeURIComponent(u.pathname);
    return net.fetch(`file://${filePath}`);
  });

  // Boot the localhost renderer server in production. We need a real
  // http origin (not file://, not a custom scheme) because YouTube's
  // embed policy refuses to render inside any iframe whose parent's
  // protocol isn't http(s).
  if (!isDev) {
    try {
      prodRendererUrl = await startRendererServer();
      console.log('[milu] renderer server:', prodRendererUrl);
    } catch (err) {
      console.error('[milu] renderer server failed:', err);
      // Fall back to file:// — app still works, just no YouTube
      // embeds. Better than refusing to launch.
    }
  }

  // Set the dock icon in dev (production builds get the icon from .icns).
  // Try a few candidate paths since __dirname differs between dev and prod.
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(process.cwd(), 'build', 'icon.png'),
    path.resolve(__dirname, '..', '..', 'build', 'icon.png'),
  ];
  let setIconResult: 'ok' | string = 'no candidate matched';
  for (const candidate of candidates) {
    try {
      const icon = nativeImage.createFromPath(candidate);
      if (icon.isEmpty()) {
        setIconResult = `empty image at ${candidate}`;
        continue;
      }
      if (process.platform === 'darwin' && app.dock) {
        app.dock.setIcon(icon);
        cachedDockIcon = icon;
      }
      setIconResult = `ok (${candidate})`;
      break;
    } catch (err) {
      setIconResult = (err as Error).message;
    }
  }
  console.log('[milu] dock icon:', setIconResult);

  buildMenu();
  // Tray creation is async (renders the procedural M icons via a
  // hidden BrowserWindow). Don't await — the main window can come up
  // first; the tray icon will appear once the canvases finish.
  void createTray();
  createWindow();
  // Note: launcher window is created lazily on first hotkey press (see
  // showLauncher) to avoid interfering with the main window at app boot.

  // Boot clipboard history watcher after window creation so the renderer is
  // available to receive 'clipboard:changed' broadcasts.
  void loadClipboardLog().then(() => startClipboardWatcher());

  // Boot the launcher hotkey directly from the persisted settings
  // file (~/.milu/settings.json) instead of waiting for the renderer
  // to push it via IPC. The renderer push still runs once
  // settings.ts loads, but it might not — slow load, hot-reload, blank
  // renderer, etc. Doing it here means Cmd+Space (or whatever the
  // user picked) is bound immediately on app start, regardless.
  let bootHotkey = DEFAULT_LAUNCHER_HOTKEY;
  try {
    const raw = await fs.readFile(await settingsFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { launcherHotkey?: unknown };
    if (typeof parsed.launcherHotkey === 'string' && parsed.launcherHotkey) {
      bootHotkey = parsed.launcherHotkey;
    }
  } catch {
    /* file missing / unreadable — stick with the default */
  }
  registerLauncherHotkey(bootHotkey);
  // Refresh the tray menu so the "Hotkey: Cmd+Space ✓" / retry line
  // reflects whether the registration actually took. The tray boots
  // async (canvas-rendered icons) so this may run before the tray
  // exists; updateTrayState() and createTray() both rebuild the menu
  // when they finish.
  if (tray) tray.setContextMenu(buildTrayMenu());

  app.on('activate', () => {
    // Re-assert the regular activation policy on every reactivation. We
    // don't auto-show the main window here — macOS fires 'activate' for
    // many reasons (launcher hide, focus shuffle, dock click) and we'd
    // flash main on every launcher dismissal.
    applyRegularActivationPolicy();
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  // Always release the global shortcut before quitting; otherwise the next
  // launch can fail to bind it.
  globalShortcut.unregisterAll();
  for (const db of sqliteConnections.values()) {
    try { db.close(); } catch { /* ignore */ }
  }
  sqliteConnections.clear();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('file:read', async (_e, filePath: string) => {
  const text = await fs.readFile(filePath, 'utf-8');
  return text;
});

ipcMain.handle('file:write', async (_e, filePath: string, content: string) => {
  await fs.writeFile(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('dialog:open-file', async () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx'] },
      {
        name: 'Code & Text',
        extensions: [
          'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv', 'log', 'env',
          'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
          'py', 'rb', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'kt', 'scala',
          'php', 'lua', 'swift', 'dart', 'zig',
          'html', 'htm', 'css', 'scss', 'sass', 'less',
          'sh', 'bash', 'zsh', 'fish', 'ps1',
          'sql', 'graphql', 'gql', 'proto',
          'vue', 'svelte', 'astro',
          'gitignore', 'gitattributes', 'editorconfig', 'dockerfile',
        ],
      },
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff'],
      },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];

  // Detect image / binary up front to avoid reading binary as utf-8 garbage.
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff'];
  if (IMAGE_EXTS.includes(ext)) {
    return { filePath, content: '' };
  }
  const content = await fs.readFile(filePath, 'utf-8');
  return { filePath, content };
});

ipcMain.handle('dialog:open-folder', async () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:save-as', async (_e, suggestedName?: string) => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;
  const defaultPath = suggestedName ?? 'untitled.md';
  // Derive the extension from the suggested name so the Format dropdown
  // defaults to the correct type instead of always saying "Markdown".
  const dot = defaultPath.lastIndexOf('.');
  const slash = Math.max(defaultPath.lastIndexOf('/'), defaultPath.lastIndexOf('\\'));
  const ext = dot > slash ? defaultPath.slice(dot + 1).toLowerCase() : '';
  const filters: Electron.FileFilter[] = [];
  if (ext) filters.push({ name: ext.toUpperCase(), extensions: [ext] });
  filters.push({ name: 'All Files', extensions: ['*'] });
  const result = await dialog.showSaveDialog(win, { defaultPath, filters });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

ipcMain.handle('dir:list', async (_e, dirPath: string): Promise<DirEntry[]> => {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  // Return all entries (including dotfiles); the renderer filters per-setting.
  const entries = await Promise.all(
    dirents.map(async (d): Promise<DirEntry> => {
      const full = path.join(dirPath, d.name);
      let size = 0;
      let mtimeMs = 0;
      let ctimeMs = 0;
      try {
        const st = await fs.stat(full);
        size = st.size;
        mtimeMs = st.mtimeMs;
        ctimeMs = st.ctimeMs;
      } catch {
        // ignore (broken symlinks, perm issues)
      }
      return { name: d.name, path: full, isDirectory: d.isDirectory(), size, mtimeMs, ctimeMs };
    }),
  );
  // Default response order: dirs first, then alphabetical. Renderer can re-sort.
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
});

ipcMain.handle('path:basename', async (_e, p: string) => path.basename(p));

/** Toggle the main window's fullscreen for HTML5 video. Called from
 *  the WebView component when a video inside any web tab enters /
 *  leaves HTML fullscreen. We use `setSimpleFullScreen` instead of
 *  native `setFullScreen` because native fullscreen allocates a new
 *  macOS Space, which fails (the window vanishes) when the app's
 *  activation policy is `accessory` — the state Milu flips to when
 *  its main window is hidden. Simple fullscreen just stretches the
 *  window to cover the screen without Space allocation, so it works
 *  under any activation policy. */
ipcMain.handle('window:set-fullscreen', async (_e, fullscreen: boolean) => {
  if (!mainWindow) return { ok: false };
  try {
    if (fullscreen) applyRegularActivationPolicy();
    mainWindow.setSimpleFullScreen(!!fullscreen);
    if (fullscreen) mainWindow.focus();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

/** Fetch the YouTube watch page for a video and pull out title,
 *  channel, description, and live-status flag. The renderer can't do
 *  this directly because the watch page doesn't ship CORS headers;
 *  the main process has no such restriction. Used by the music tab's
 *  Add Link flow to pre-fill metadata + suggest a genre. */
ipcMain.handle(
  'youtube:metadata',
  async (
    _e,
    videoId: string,
  ): Promise<
    | { ok: true; title: string; channel: string; description: string; isLive: boolean }
    | { ok: false; error: string }
  > => {
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
        headers: {
          // Default headers from Electron's main fetch are spartan and
          // some YouTube responses redirect to a consent gate. A full
          // browser UA short-circuits that path.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const html = await res.text();
      const decode = (raw: string): string => {
        try {
          return JSON.parse(`"${raw}"`);
        } catch {
          return raw;
        }
      };
      const titleMatch = html.match(/"title":"((?:\\.|[^"\\])*)"/);
      const channelMatch = html.match(/"author":"((?:\\.|[^"\\])*)"/);
      const descMatch = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
      return {
        ok: true,
        title: titleMatch ? decode(titleMatch[1]) : '',
        channel: channelMatch ? decode(channelMatch[1]) : '',
        description: descMatch ? decode(descMatch[1]) : '',
        isLive: /"isLiveContent":true/.test(html) || /"isLive":true/.test(html),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
);

ipcMain.handle('path:home', async () => os.homedir());

/** ~/.milu is Milu's per-user config/data directory. We use it for the
 *  global notes file and any future user-specific persisted state. */
async function ensureMiluDir(): Promise<string> {
  const dir = path.join(os.homedir(), '.milu');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

ipcMain.handle('milu:config-dir', async () => ensureMiluDir());

ipcMain.handle('milu:notes-path', async (): Promise<string> => {
  const dir = await ensureMiluDir();
  const file = path.join(dir, 'notes.txt');
  try {
    // Create the file with an empty body if it doesn't exist; preserve content otherwise.
    await fs.writeFile(file, '', { flag: 'wx' });
  } catch {
    // File already exists — leave it alone.
  }
  return file;
});

/** Persisted workspace snapshot at ~/.milu/state.json. Renderer owns the
 *  schema; main just reads/writes/clears the blob. */
async function statePath(): Promise<string> {
  const dir = await ensureMiluDir();
  return path.join(dir, 'state.json');
}

ipcMain.handle('state:read', async (): Promise<string | null> => {
  try {
    return await fs.readFile(await statePath(), 'utf8');
  } catch {
    return null;
  }
});

ipcMain.handle('state:write', async (_e, json: string): Promise<{ ok: boolean }> => {
  try {
    const file = await statePath();
    // Atomic-ish write: write tmp then rename, so a crash mid-write doesn't
    // leave a half-written file that breaks the next launch.
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, json, 'utf8');
    await fs.rename(tmp, file);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

/** App settings at ~/.milu/settings.json. Lives in the shared
 *  dotfile dir so dev and packaged builds see the same prefs.
 *  Initial read happens synchronously in preload (settings.ts loads
 *  synchronously); writes go through the async IPC below. */
async function settingsFilePath(): Promise<string> {
  const dir = await ensureMiluDir();
  return path.join(dir, 'settings.json');
}
ipcMain.handle('settings:write', async (_e, json: string): Promise<{ ok: boolean }> => {
  try {
    const file = await settingsFilePath();
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, json, 'utf8');
    await fs.rename(tmp, file);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

/** "Save for later" reading list at ~/.milu/later.json — pages,
 *  videos, anything saved from a web tab via the bookmark button.
 *  Same shared-dotfile pattern as music-library. */
async function laterListPath(): Promise<string> {
  const dir = await ensureMiluDir();
  return path.join(dir, 'later.json');
}
ipcMain.handle('later:read', async (): Promise<string | null> => {
  try {
    return await fs.readFile(await laterListPath(), 'utf8');
  } catch {
    return null;
  }
});
ipcMain.handle(
  'later:write',
  async (_e, json: string): Promise<{ ok: boolean }> => {
    try {
      const file = await laterListPath();
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, json, 'utf8');
      await fs.rename(tmp, file);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
);

/** Music tab library (user-added tracks + hidden curated picks) at
 *  ~/.milu/music-library.json. Lives in the shared dotfile dir so
 *  dev and packaged builds see the same library — localStorage is
 *  scoped per app/userData and wouldn't share across them. */
async function musicLibraryPath(): Promise<string> {
  const dir = await ensureMiluDir();
  return path.join(dir, 'music-library.json');
}
ipcMain.handle('music-library:read', async (): Promise<string | null> => {
  try {
    return await fs.readFile(await musicLibraryPath(), 'utf8');
  } catch {
    return null;
  }
});
ipcMain.handle(
  'music-library:write',
  async (_e, json: string): Promise<{ ok: boolean }> => {
    try {
      const file = await musicLibraryPath();
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, json, 'utf8');
      await fs.rename(tmp, file);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
);

ipcMain.handle('state:reset', async (): Promise<{ ok: boolean }> => {
  try {
    await fs.rm(await statePath(), { force: true });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ---------- Git ----------
// Lightweight wrappers over simple-git. Each handler operates on a workspace
// directory passed in by the renderer. We bail with `ok: false, error` rather
// than throwing so the UI can render an error inline.

interface GitFileEntry {
  path: string;
  index: string;
  workingDir: string;
  staged: boolean;
}

export interface GitStatusInfo {
  isRepo: boolean;
  branch: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  files: GitFileEntry[];
  error?: string;
}

function git(repoDir: string): SimpleGit {
  return simpleGit({ baseDir: repoDir, binary: 'git' });
}

async function isInsideRepo(repoDir: string): Promise<boolean> {
  try {
    const out = await git(repoDir).revparse(['--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

ipcMain.handle('git:init', async (_e, repoDir: string): Promise<{ ok: boolean; error?: string }> => {
  if (!repoDir) return { ok: false, error: 'No directory selected' };
  try {
    if (await isInsideRepo(repoDir)) {
      return { ok: false, error: 'Directory is already a Git repository' };
    }
    await git(repoDir).init();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('git:status', async (_e, repoDir: string): Promise<GitStatusInfo> => {
  if (!repoDir) return { isRepo: false, branch: null, tracking: null, ahead: 0, behind: 0, files: [] };
  if (!(await isInsideRepo(repoDir))) {
    return { isRepo: false, branch: null, tracking: null, ahead: 0, behind: 0, files: [] };
  }
  try {
    const s: StatusResult = await git(repoDir).status();
    const files: GitFileEntry[] = s.files.map((f) => ({
      path: f.path,
      index: f.index ?? ' ',
      workingDir: f.working_dir ?? ' ',
      // simple-git uses `index` for the staged column (' ' = unstaged).
      staged: !!f.index && f.index !== ' ' && f.index !== '?',
    }));
    return {
      isRepo: true,
      branch: s.current ?? null,
      tracking: s.tracking ?? null,
      ahead: s.ahead,
      behind: s.behind,
      files,
    };
  } catch (err) {
    return {
      isRepo: true,
      branch: null,
      tracking: null,
      ahead: 0,
      behind: 0,
      files: [],
      error: (err as Error).message,
    };
  }
});

ipcMain.handle(
  'git:diff',
  async (
    _e,
    repoDir: string,
    relPath: string,
    staged: boolean,
  ): Promise<{ ok: boolean; diff?: string; error?: string }> => {
    try {
      const args = staged ? ['--staged', '--', relPath] : ['--', relPath];
      const out = await git(repoDir).diff(args);
      return { ok: true, diff: out };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:stage',
  async (_e, repoDir: string, paths: string[]): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).add(paths);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:unstage',
  async (_e, repoDir: string, paths: string[]): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).reset(['HEAD', '--', ...paths]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:discard',
  async (_e, repoDir: string, paths: string[]): Promise<{ ok: boolean; error?: string }> => {
    // Restore working-tree files to HEAD. Untracked files aren't affected by
    // checkout; the renderer should call `git:trash-untracked` for those (or
    // route them through fs.trash). We only handle tracked here.
    try {
      await git(repoDir).checkout(['--', ...paths]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:commit',
  async (_e, repoDir: string, message: string): Promise<{ ok: boolean; error?: string }> => {
    if (!message.trim()) return { ok: false, error: 'Empty commit message' };
    try {
      await git(repoDir).commit(message);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

// ---------- Native rich confirm dialog ----------
// `window.confirm()` wraps long content awkwardly (single-column, narrow,
// breaks mid-word). Electron's native message box handles a separate `detail`
// field cleanly, and we can mark the action as destructive on macOS.

ipcMain.handle(
  'app:confirm',
  async (
    _e,
    opts: {
      message: string;
      detail?: string;
      confirmLabel?: string;
      cancelLabel?: string;
      dangerous?: boolean;
    },
  ): Promise<boolean> => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!win) return false;
    const result = await dialog.showMessageBox(win, {
      type: opts.dangerous ? 'warning' : 'question',
      message: opts.message,
      detail: opts.detail,
      buttons: [opts.confirmLabel ?? 'OK', opts.cancelLabel ?? 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0;
  },
);

// ---------- Branches ----------

export interface GitBranchInfo {
  current: string;
  local: string[];
  remote: string[];
}

ipcMain.handle(
  'git:branches',
  async (_e, repoDir: string): Promise<{ ok: boolean; data?: GitBranchInfo; error?: string }> => {
    try {
      const localBr = await git(repoDir).branchLocal();
      const allBr = await git(repoDir).branch(['-a']);
      const remote = allBr.all
        .filter((n) => n.startsWith('remotes/') && !n.includes('/HEAD'))
        .map((n) => n.replace(/^remotes\//, ''));
      return { ok: true, data: { current: localBr.current, local: localBr.all, remote } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:checkout',
  async (_e, repoDir: string, branch: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).checkout(branch);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:deleteBranch',
  async (_e, repoDir: string, name: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      // -D forces deletion even if not merged. Caller is expected to confirm.
      await git(repoDir).raw(['branch', '-D', name]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:rebase',
  async (_e, repoDir: string, target: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).rebase([target]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:merge',
  async (_e, repoDir: string, target: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).merge([target]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

// ---------- Remote ops ----------

ipcMain.handle(
  'git:fetch',
  async (_e, repoDir: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).fetch();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:pull',
  async (_e, repoDir: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).pull();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:push',
  async (_e, repoDir: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).push();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

// ---------- Stash ----------

export interface GitStashEntry {
  ref: string; // e.g. stash@{0}
  message: string;
  date: string;
}

ipcMain.handle(
  'git:stashList',
  async (
    _e,
    repoDir: string,
  ): Promise<{ ok: boolean; items?: GitStashEntry[]; error?: string }> => {
    try {
      const s = await git(repoDir).stashList();
      const items: GitStashEntry[] = s.all.map((it) => ({
        ref: `stash@{${s.all.indexOf(it)}}`,
        message: it.message,
        date: it.date,
      }));
      return { ok: true, items };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:stashSave',
  async (_e, repoDir: string, message: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const args = ['push'];
      if (message) args.push('-m', message);
      await git(repoDir).stash(args);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:stashApply',
  async (_e, repoDir: string, ref: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).stash(['apply', ref]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:stashPop',
  async (_e, repoDir: string, ref: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).stash(['pop', ref]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:stashDrop',
  async (_e, repoDir: string, ref: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).stash(['drop', ref]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:stashClear',
  async (_e, repoDir: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).stash(['clear']);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

// ---------- Log / commit history ----------

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string; // ISO
  subject: string;
  parents: string[];
}

ipcMain.handle(
  'git:log',
  async (
    _e,
    repoDir: string,
    opts: { limit?: number; ref?: string } = {},
  ): Promise<{ ok: boolean; commits?: GitLogEntry[]; error?: string }> => {
    const limit = opts.limit ?? 100;
    return new Promise((resolve) => {
      // Use a delimited custom format we can split safely (record sep \x1e,
      // field sep \x1f). simple-git's parser is finicky for unusual chars in
      // commit messages; raw spawn with format gives us full control.
      const sep = '\x1e';
      const fld = '\x1f';
      const fmt = `%H${fld}%h${fld}%an${fld}%ae${fld}%aI${fld}%P${fld}%s${sep}`;
      const args = ['log', `--max-count=${limit}`, `--format=${fmt}`];
      if (opts.ref) args.push(opts.ref);
      const proc = spawn('git', args, { cwd: repoDir });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', (e) => resolve({ ok: false, error: e.message }));
      proc.on('close', (code) => {
        if (code !== 0) {
          return resolve({ ok: false, error: stderr.trim() || `git log exit ${code}` });
        }
        const commits: GitLogEntry[] = stdout
          .split(sep)
          .map((rec) => rec.trim())
          .filter(Boolean)
          .map((rec) => {
            const f = rec.split(fld);
            return {
              hash: f[0] ?? '',
              shortHash: f[1] ?? '',
              author: f[2] ?? '',
              email: f[3] ?? '',
              date: f[4] ?? '',
              parents: (f[5] ?? '').split(' ').filter(Boolean),
              subject: f[6] ?? '',
            };
          });
        resolve({ ok: true, commits });
      });
    });
  },
);

ipcMain.handle(
  'git:show',
  async (
    _e,
    repoDir: string,
    hash: string,
  ): Promise<{ ok: boolean; diff?: string; error?: string }> => {
    try {
      const out = await git(repoDir).show([hash]);
      return { ok: true, diff: out };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:cherryPick',
  async (_e, repoDir: string, hash: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).raw(['cherry-pick', hash]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

// ---------- Tags ----------

ipcMain.handle(
  'git:tags',
  async (
    _e,
    repoDir: string,
  ): Promise<{ ok: boolean; tags?: string[]; error?: string }> => {
    try {
      const t = await git(repoDir).tags();
      return { ok: true, tags: t.all };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:createTag',
  async (
    _e,
    repoDir: string,
    name: string,
    message: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      if (message) await git(repoDir).addAnnotatedTag(name, message);
      else await git(repoDir).addTag(name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle(
  'git:deleteTag',
  async (_e, repoDir: string, name: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await git(repoDir).raw(['tag', '-d', name]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

// ---------- Apply patch (for hunk-level stage/unstage/discard) ----------
// We pipe the patch via stdin to `git apply`. simple-git's API only takes
// patch file paths, so we use spawn directly.

ipcMain.handle(
  'git:applyPatch',
  async (
    _e,
    repoDir: string,
    patch: string,
    opts: { cached?: boolean; reverse?: boolean },
  ): Promise<{ ok: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const args = ['apply'];
      if (opts.cached) args.push('--cached');
      if (opts.reverse) args.push('--reverse');
      // --whitespace=nowarn keeps stage/discard idempotent against typical
      // editor-induced trailing-whitespace differences.
      args.push('--whitespace=nowarn', '-');
      const proc = spawn('git', args, { cwd: repoDir });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('error', (e) => resolve({ ok: false, error: e.message }));
      proc.on('close', (code) => {
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: stderr.trim() || `git apply exit ${code}` });
      });
      proc.stdin.write(patch);
      proc.stdin.end();
    });
  },
);

// ---------- Git: read a range of lines from the post-image ----------
// Powers GitHub-style "expand context" buttons in the diff viewer.
// `source` selects which version of the file to read:
//   'work'  — current working tree (used when viewing the unstaged diff)
//   'index' — the staged blob (used when viewing the staged diff)
//   'HEAD'  — the last committed version (fallback for deleted files)
// Returns 1-indexed inclusive `[startLine, endLine]` clipped to the
// file's actual length, plus `total` so the renderer can disable
// further-expand buttons when there's nothing more to show.
ipcMain.handle(
  'git:fileLines',
  async (
    _e,
    repoDir: string,
    source: 'work' | 'index' | 'HEAD',
    relPath: string,
    startLine: number,
    endLine: number,
  ): Promise<{ ok: boolean; lines?: string[]; total?: number; error?: string }> => {
    if (!repoDir || !relPath) return { ok: false, error: 'no repoDir/path' };
    let content: string;
    try {
      if (source === 'work') {
        content = await fs.readFile(path.join(repoDir, relPath), 'utf8');
      } else {
        // `git show :path` → index blob. `git show HEAD:path` → HEAD blob.
        const ref = source === 'index' ? `:${relPath}` : `HEAD:${relPath}`;
        content = await git(repoDir).raw(['show', ref]);
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const lines = content.split('\n');
    // Trailing newline produces an empty last element; drop so line
    // count is accurate.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const lo = Math.max(1, startLine);
    const hi = Math.min(total, endLine);
    return {
      ok: true,
      lines: lo > hi ? [] : lines.slice(lo - 1, hi),
      total,
    };
  },
);

// ---------- Shell: open external URL ----------
// Renderer-callable wrapper around shell.openExternal. Restricted to
// http/https so a stray call can't be turned into a file:// or
// javascript: hop. Used by the git tab's "Open on GitHub" buttons.
ipcMain.handle(
  'shell:openExternal',
  async (_e, url: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false, error: 'Only http/https URLs are allowed.' };
      }
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

// ---------- GitHub remote info ----------
// Parses `git config --get remote.origin.url` and normalizes ssh URLs
// (`git@github.com:owner/repo.git`) into https form so the renderer
// can build deep links. Non-GitHub remotes return ok=false.
ipcMain.handle(
  'git:githubRemote',
  async (
    _e,
    repoDir: string,
  ): Promise<{ ok: boolean; owner?: string; repo?: string; web?: string; error?: string }> => {
    if (!repoDir) return { ok: false, error: 'no rootDir' };
    try {
      const raw = (await git(repoDir).raw(['config', '--get', 'remote.origin.url'])).trim();
      if (!raw) return { ok: false, error: 'no origin remote' };
      // Match the three common GitHub URL shapes:
      //   https://github.com/owner/repo(.git)?
      //   git@github.com:owner/repo(.git)?
      //   ssh://git@github.com/owner/repo(.git)?
      const m =
        /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
          raw,
        );
      if (!m) return { ok: false, error: 'not a GitHub remote' };
      const [, owner, repo] = m;
      return { ok: true, owner, repo, web: `https://github.com/${owner}/${repo}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

// ---------- gh CLI bridge ----------
// All gh wrappers run the binary in repoDir so it picks up the right
// upstream automatically. They share one runner that resolves to a
// uniform `{ ok, json?, error?, code? }` shape so renderer code can
// treat "not installed", "not authed", and "API failure" the same way
// (degrade gracefully — never crash the git tab).
function runGh(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; json?: unknown; error?: string; code?: number }> {
  return new Promise((resolve) => {
    const proc = spawn('gh', args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => {
      // ENOENT here means `gh` isn't installed or isn't on PATH.
      const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT';
      resolve({
        ok: false,
        error: enoent ? 'gh CLI not installed' : e.message,
      });
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({
          ok: false,
          code: code ?? -1,
          error: stderr.trim() || `gh exit ${code}`,
        });
      }
      try {
        resolve({ ok: true, json: stdout.trim() ? JSON.parse(stdout) : null });
      } catch (parseErr) {
        resolve({ ok: false, error: (parseErr as Error).message });
      }
    });
  });
}

/** One-shot capability probe: is `gh` installed and is the user
 *  authed against github.com? Used to gate UI without forcing the
 *  expensive PR/issue/CI calls just to discover gh isn't around. */
ipcMain.handle(
  'gh:check',
  async (): Promise<{ available: boolean; authed: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const proc = spawn('gh', ['auth', 'status', '--hostname', 'github.com']);
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', (e) => {
        const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT';
        resolve({
          available: !enoent,
          authed: false,
          error: enoent ? 'gh CLI not installed' : e.message,
        });
      });
      proc.on('close', (code) => {
        // gh auth status writes to stderr (status info), exit 0 = authed,
        // non-zero = not authed. The binary exists either way.
        resolve({ available: true, authed: code === 0, error: code === 0 ? undefined : stderr.trim() });
      });
    });
  },
);

interface GhPr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  url: string;
  author?: { login: string };
}
ipcMain.handle(
  'gh:prList',
  async (
    _e,
    repoDir: string,
  ): Promise<{ ok: boolean; prs?: GhPr[]; error?: string }> => {
    if (!repoDir) return { ok: false, error: 'no rootDir' };
    const r = await runGh(
      ['pr', 'list', '--json', 'number,title,state,isDraft,headRefName,url,author', '--limit', '30'],
      repoDir,
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, prs: (r.json ?? []) as GhPr[] };
  },
);

interface GhIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  author?: { login: string };
}
ipcMain.handle(
  'gh:issueList',
  async (
    _e,
    repoDir: string,
  ): Promise<{ ok: boolean; issues?: GhIssue[]; error?: string }> => {
    if (!repoDir) return { ok: false, error: 'no rootDir' };
    const r = await runGh(
      ['issue', 'list', '--json', 'number,title,state,url,author', '--limit', '30'],
      repoDir,
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, issues: (r.json ?? []) as GhIssue[] };
  },
);

interface GhRun {
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | null while running
  headSha: string;
  workflowName: string;
  url: string;
  createdAt: string;
}
/** Latest workflow run on a given branch — drives the inline CI badge.
 *  Returns the single most-recent run; the renderer maps status into
 *  ✓ / ✗ / ⊙ glyphs. */
ipcMain.handle(
  'gh:runLatest',
  async (
    _e,
    repoDir: string,
    branch: string,
  ): Promise<{ ok: boolean; run?: GhRun | null; error?: string }> => {
    if (!repoDir || !branch) return { ok: false, error: 'no rootDir/branch' };
    const r = await runGh(
      [
        'run',
        'list',
        '--branch',
        branch,
        '--limit',
        '1',
        '--json',
        'status,conclusion,headSha,workflowName,url,createdAt',
      ],
      repoDir,
    );
    if (!r.ok) return { ok: false, error: r.error };
    const arr = (r.json ?? []) as GhRun[];
    return { ok: true, run: arr[0] ?? null };
  },
);

// ---------- CHANGELOG preview ----------
// Reads CHANGELOG.md (or CHANGELOG / HISTORY.md / etc.) at repoDir
// root or one level deep (docs/, .github/) and returns the topmost
// markdown section — everything from the first `## ` heading up to
// (but not including) the next one. Used by the git tab's release-
// notes card.
const CHANGELOG_NAME_RE =
  /^(CHANGELOG|CHANGES|HISTORY|RELEASES?|RELEASE[_-]?NOTES?|NEWS)(\.(md|markdown|mdown|mkd|txt))?$/i;
const CHANGELOG_SUBDIRS = ['', 'docs', '.github'];

ipcMain.handle(
  'git:changelogTop',
  async (
    _e,
    repoDir: string,
  ): Promise<{ ok: boolean; heading?: string; body?: string; filename?: string; error?: string }> => {
    if (!repoDir) return { ok: false, error: 'no rootDir' };
    for (const sub of CHANGELOG_SUBDIRS) {
      const dir = sub ? path.join(repoDir, sub) : repoDir;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      // Case-insensitive match against the broad name set above.
      const hit = entries.find((e) => e.isFile() && CHANGELOG_NAME_RE.test(e.name));
      if (!hit) continue;
      const filename = sub ? `${sub}/${hit.name}` : hit.name;
      try {
        const content = await fs.readFile(path.join(dir, hit.name), 'utf8');
        const lines = content.split('\n');
        const startIdx = lines.findIndex((l) => /^##\s/.test(l));
        if (startIdx === -1) {
          // No `##` headings — return the whole file's first 50 lines.
          return { ok: true, heading: filename, body: lines.slice(0, 50).join('\n'), filename };
        }
        const heading = lines[startIdx].replace(/^##\s+/, '').trim();
        let endIdx = lines.findIndex((l, i) => i > startIdx && /^##\s/.test(l));
        if (endIdx === -1) endIdx = lines.length;
        const body = lines.slice(startIdx + 1, endIdx).join('\n').trim();
        return { ok: true, heading, body, filename };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    return { ok: false, error: 'no CHANGELOG' };
  },
);

ipcMain.handle('file:create', async (_e, filePath: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    await fs.writeFile(filePath, '', { flag: 'wx' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('dir:create', async (_e, dirPath: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    await fs.mkdir(dirPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    await fs.rename(oldPath, newPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('fs:copy', async (_e, src: string, dest: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('fs:exists', async (_e, p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('fs:trash', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    await shell.trashItem(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('fs:reveal', async (_e, p: string) => {
  shell.showItemInFolder(p);
});

ipcMain.handle('fs:open-default', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
  const err = await shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
});

// ---------- Terminal (PTY) ----------

const ptys = new Map<string, IPty>();

// node-pty's prebuilt spawn-helper sometimes loses its executable bit when
// extracted by npm. Without +x, posix_spawnp fails. Self-heal at startup.
async function ensurePtyHelperExecutable() {
  if (process.platform === 'win32') return;
  try {
    const ptyPkgDir = path.dirname(require.resolve('node-pty/package.json'));
    const candidates = [
      path.join(ptyPkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(ptyPkgDir, 'build', 'Release', 'spawn-helper'),
    ];
    for (const c of candidates) {
      try {
        await fs.chmod(c, 0o755);
      } catch {
        // file may not exist for this arch — that's fine
      }
    }
  } catch {
    // node-pty not resolvable somehow — let pty:spawn surface the error
  }
}
void ensurePtyHelperExecutable();

ipcMain.handle('pty:spawn', (e, id: string, opts: { cwd?: string; cols?: number; rows?: number }): { ok: boolean; error?: string } => {
  try {
    if (ptys.has(id)) return { ok: true };
    const shell = process.env.SHELL ?? '/bin/zsh';
    const child = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd ?? os.homedir(),
      env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color', LANG: process.env.LANG ?? 'en_US.UTF-8' },
    });
    ptys.set(id, child);
    const win = BrowserWindow.fromWebContents(e.sender);
    child.onData((data) => {
      win?.webContents.send('pty:data', id, data);
    });
    child.onExit(({ exitCode }) => {
      win?.webContents.send('pty:exit', id, exitCode);
      ptys.delete(id);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('pty:write', (_e, id: string, data: string): boolean => {
  const p = ptys.get(id);
  if (!p) return false;
  p.write(data);
  return true;
});

ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number): boolean => {
  const p = ptys.get(id);
  if (!p) return false;
  try {
    p.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('pty:kill', (_e, id: string): boolean => {
  const p = ptys.get(id);
  if (!p) return false;
  try {
    p.kill();
  } catch {
    // ignore
  }
  ptys.delete(id);
  return true;
});

ipcMain.handle('fs:stat', async (_e, p: string): Promise<{ exists: boolean; isFile: boolean; isDirectory: boolean; error?: string }> => {
  try {
    const st = await fs.stat(p);
    return { exists: true, isFile: st.isFile(), isDirectory: st.isDirectory() };
  } catch (err) {
    return { exists: false, isFile: false, isDirectory: false, error: (err as Error).message };
  }
});

ipcMain.handle('fs:quicklook', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
  if (process.platform !== 'darwin') return { ok: false, error: 'Quick Look is macOS-only' };
  try {
    const child = spawn('qlmanage', ['-p', p], { stdio: 'ignore', detached: true });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

const WALK_IGNORE = new Set([
  'node_modules', '.git', '.svn', '.hg', '.next', '.nuxt', '.cache',
  'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__',
  '.idea', '.vscode', '.DS_Store', '.turbo', '.parcel-cache',
]);
const WALK_FILE_LIMIT = 20000;

ipcMain.handle('dir:walk', async (_e, rootDir: string): Promise<string[]> => {
  const results: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0 && results.length < WALK_FILE_LIMIT) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (WALK_IGNORE.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip dot-directories (.git, .next, .cache that didn't make
        // the explicit ignore list) — they're typically tooling output.
        if (entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        // Hidden files (.env, .gitignore, .eslintrc, etc.) ARE indexed.
        // Users routinely ⌘P-search for them.
        results.push(full);
        if (results.length >= WALK_FILE_LIMIT) break;
      }
    }
  }
  return results;
});

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tiff: 'image/tiff',
};

interface ProcInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  vsz: number;
  rss: number;
  state: string;
  time: string;
  command: string;
  args: string;
}

interface SystemStats {
  cpus: number[]; // 0..1 per core
  memUsed: number; // bytes
  memTotal: number;
  loadavg: [number, number, number];
  uptime: number; // seconds
}

function runPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ps', [
      '-A',
      '-o',
      'pid=,user=,pcpu=,pmem=,vsz=,rss=,state=,time=,args=',
    ]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err || `ps exited ${code}`));
    });
    child.on('error', reject);
  });
}

function basenameOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

ipcMain.handle('ps:list', async (): Promise<ProcInfo[]> => {
  const text = await runPs();
  const procs: ProcInfo[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const args = m[9];
    const firstSpace = args.indexOf(' ');
    const argv0 = firstSpace < 0 ? args : args.slice(0, firstSpace);
    procs.push({
      pid: parseInt(m[1], 10),
      user: m[2],
      cpu: parseFloat(m[3]) || 0,
      mem: parseFloat(m[4]) || 0,
      vsz: parseInt(m[5], 10) || 0,
      rss: parseInt(m[6], 10) || 0,
      state: m[7],
      time: m[8],
      command: basenameOf(argv0),
      args,
    });
  }
  return procs;
});

let lastCpu: { idle: number; total: number }[] = [];

function cpuTimes(): { idle: number; total: number }[] {
  return os.cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

ipcMain.handle('system:stats', async (): Promise<SystemStats> => {
  const now = cpuTimes();
  const cpus = now.map((curr, i) => {
    const prev = lastCpu[i];
    if (!prev) return 0;
    const dIdle = curr.idle - prev.idle;
    const dTotal = curr.total - prev.total;
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - dIdle / dTotal));
  });
  lastCpu = now;
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  return {
    cpus,
    memUsed: memTotal - memFree,
    memTotal,
    loadavg: os.loadavg() as [number, number, number],
    uptime: os.uptime(),
  };
});

ipcMain.handle('ps:kill', async (_e, pid: number, signal: string = 'SIGTERM'): Promise<{ ok: boolean; error?: string }> => {
  try {
    process.kill(pid, signal as NodeJS.Signals);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('image:load', async (_e, filePath: string) => {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = IMAGE_MIME[ext] ?? 'application/octet-stream';
  const buf = await fs.readFile(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
});


// =====================================================================
// AI chat: provider config, encrypted API keys, streaming completions.
// Streaming happens here in main so (a) API keys never reach the renderer,
// (b) CORS can't bite us, (c) we can abort cleanly via AbortController.
// =====================================================================

interface AiProvider {
  id: string;
  name: string;
  baseURL: string;
  defaultModel: string;
  needsKey: boolean;
  isLocal: boolean;
  /** Provider-specific extra headers (e.g. OpenRouter recommends
   *  HTTP-Referer + X-Title for routing/leaderboards). */
  extraHeaders?: Record<string, string>;
}

const DEFAULT_PROVIDERS: AiProvider[] = [
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    baseURL: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    needsKey: false,
    isLocal: true,
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    needsKey: false,
    isLocal: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
    isLocal: false,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    needsKey: true,
    isLocal: false,
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/jinghanx/milu',
      'X-Title': 'Milu',
    },
  },
];

async function aiProvidersPath(): Promise<string> {
  const dir = await ensureMiluDir();
  return path.join(dir, 'ai-providers.json');
}
async function aiKeysPath(): Promise<string> {
  const dir = await ensureMiluDir();
  return path.join(dir, 'ai-keys.json');
}

async function readProviders(): Promise<AiProvider[]> {
  try {
    const raw = await fs.readFile(await aiProvidersPath(), 'utf8');
    const parsed = JSON.parse(raw) as AiProvider[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Backfill any default providers that aren't yet in the user's list
      // (so newly-shipped defaults like OpenRouter show up automatically).
      const known = new Set(parsed.map((p) => p.id));
      const merged = [...parsed];
      let added = false;
      for (const def of DEFAULT_PROVIDERS) {
        if (!known.has(def.id)) {
          merged.push(def);
          added = true;
        }
      }
      if (added) {
        // Persist so we don't have to merge on every read.
        await writeProviders(merged).catch(() => {});
      }
      return merged;
    }
  } catch {
    // file missing or corrupt — fall through to defaults
  }
  return DEFAULT_PROVIDERS;
}

async function writeProviders(list: AiProvider[]): Promise<void> {
  const file = await aiProvidersPath();
  await fs.writeFile(file, JSON.stringify(list, null, 2), 'utf8');
}

async function readKeys(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(await aiKeysPath(), 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}
async function writeKeys(map: Record<string, string>): Promise<void> {
  const file = await aiKeysPath();
  await fs.writeFile(file, JSON.stringify(map), 'utf8');
}

async function readDecryptedKey(providerId: string): Promise<string | null> {
  const map = await readKeys();
  const enc = map[providerId];
  if (!enc) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}

ipcMain.handle('ai:providers', readProviders);

ipcMain.handle(
  'ai:provider-save',
  async (_e, p: AiProvider): Promise<{ ok: boolean; error?: string }> => {
    try {
      const list = await readProviders();
      const idx = list.findIndex((x) => x.id === p.id);
      if (idx >= 0) list[idx] = p;
      else list.push(p);
      await writeProviders(list);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
);

ipcMain.handle(
  'ai:provider-delete',
  async (_e, id: string): Promise<{ ok: boolean }> => {
    try {
      const list = await readProviders();
      await writeProviders(list.filter((p) => p.id !== id));
      const map = await readKeys();
      delete map[id];
      await writeKeys(map);
    } catch {
      // ignore
    }
    return { ok: true };
  },
);

ipcMain.handle(
  'ai:set-key',
  async (_e, id: string, key: string): Promise<{ ok: boolean; error?: string }> => {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS keychain not available' };
    }
    try {
      const map = await readKeys();
      map[id] = safeStorage.encryptString(key).toString('base64');
      await writeKeys(map);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
);

ipcMain.handle(
  'ai:has-key',
  async (_e, id: string): Promise<boolean> => {
    const map = await readKeys();
    return !!map[id];
  },
);

ipcMain.handle(
  'ai:delete-key',
  async (_e, id: string): Promise<{ ok: boolean }> => {
    const map = await readKeys();
    delete map[id];
    await writeKeys(map);
    return { ok: true };
  },
);

// ---------- ACP agents (Agent Client Protocol) ----------
// Configured agents are kept in `~/.milu/acp-agents.json` mirroring
// the AI-providers pattern: a flat list of records the renderer reads
// to populate the agent picker, edits via the settings UI, and the
// AcpSession layer reads to spawn the right binary. No secrets here —
// auth is delegated to each agent's own login flow (e.g. claude-login).
interface AcpAgent {
  id: string;
  name: string;
  /** Argv[0] passed to spawn — typically a binary on PATH or an
   *  absolute path. We deliberately don't shell-expand to avoid
   *  injection footguns; users wanting `npx foo` write it as
   *  `command: 'npx', args: ['foo']`. */
  command: string;
  args: string[];
  /** Extra env vars merged into process.env for this agent. */
  env?: Record<string, string>;
}

const DEFAULT_ACP_AGENTS: AcpAgent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    // The Zed adapter is currently the canonical entrypoint for
    // Claude over ACP. It's a peer dep of Milu (in node_modules), so
    // calling its bin name resolves via the local .bin shim during
    // dev and via the bundled node_modules in production.
    command: 'claude-code-acp',
    args: [],
  },
];

async function acpAgentsPath(): Promise<string> {
  const dir = await ensureMiluDir();
  return path.join(dir, 'acp-agents.json');
}

async function readAcpAgents(): Promise<AcpAgent[]> {
  try {
    const raw = await fs.readFile(await acpAgentsPath(), 'utf8');
    const parsed = JSON.parse(raw) as AcpAgent[];
    if (Array.isArray(parsed)) {
      // Backfill any default agents that aren't yet in the user's list
      // (newly-shipped defaults appear automatically).
      const known = new Set(parsed.map((a) => a.id));
      const merged = [...parsed];
      let added = false;
      for (const def of DEFAULT_ACP_AGENTS) {
        if (!known.has(def.id)) {
          merged.push(def);
          added = true;
        }
      }
      if (added) await writeAcpAgents(merged).catch(() => {});
      return merged;
    }
  } catch {
    // missing or corrupt → defaults
  }
  return DEFAULT_ACP_AGENTS;
}

async function writeAcpAgents(list: AcpAgent[]): Promise<void> {
  const file = await acpAgentsPath();
  await fs.writeFile(file, JSON.stringify(list, null, 2), 'utf8');
}

ipcMain.handle('acp:agents', readAcpAgents);

ipcMain.handle(
  'acp:agent-save',
  async (_e, a: AcpAgent): Promise<{ ok: boolean; error?: string }> => {
    try {
      const list = await readAcpAgents();
      const idx = list.findIndex((x) => x.id === a.id);
      if (idx >= 0) list[idx] = a;
      else list.push(a);
      await writeAcpAgents(list);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
);

ipcMain.handle(
  'acp:agent-delete',
  async (_e, id: string): Promise<{ ok: boolean }> => {
    try {
      const list = await readAcpAgents();
      await writeAcpAgents(list.filter((a) => a.id !== id));
    } catch {
      // ignore
    }
    return { ok: true };
  },
);

// ---------- ACP session lifecycle IPC ----------
// Each tab in the renderer owns a stable reqId; the AcpSession holds
// the live subprocess + JSON-RPC connection. Events stream back on
// `acp:event:${reqId}`. The handlers below are the renderer's only
// way to drive a session.
ipcMain.handle(
  'acp:start',
  async (
    e,
    reqId: string,
    agentId: string,
    cwd: string,
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }> => {
    if (acpSessions.has(reqId)) {
      return { ok: false, error: 'reqId already in use' };
    }
    const list = await readAcpAgents();
    const agent = list.find((a) => a.id === agentId);
    if (!agent) return { ok: false, error: `unknown agent: ${agentId}` };
    const session = new AcpSession(reqId, e.sender, cwd);
    acpSessions.set(reqId, session);
    const r = await session.start(agent);
    if (!r.ok) {
      acpSessions.delete(reqId);
      session.dispose();
    }
    return r;
  },
);

ipcMain.handle(
  'acp:prompt',
  async (
    _e,
    reqId: string,
    text: string,
  ): Promise<{ ok: boolean; stopReason?: string; error?: string }> => {
    const session = acpSessions.get(reqId);
    if (!session) return { ok: false, error: 'no such session' };
    return session.prompt(text);
  },
);

ipcMain.handle(
  'acp:cancel',
  async (_e, reqId: string): Promise<{ ok: boolean }> => {
    const session = acpSessions.get(reqId);
    if (!session) return { ok: false };
    await session.cancel();
    return { ok: true };
  },
);

ipcMain.handle(
  'acp:dispose',
  async (_e, reqId: string): Promise<{ ok: boolean }> => {
    const session = acpSessions.get(reqId);
    if (!session) return { ok: true };
    session.dispose();
    acpSessions.delete(reqId);
    return { ok: true };
  },
);

ipcMain.handle(
  'acp:permission-resolve',
  async (
    _e,
    reqId: string,
    permId: string,
    response: import('@agentclientprotocol/sdk').RequestPermissionResponse,
  ): Promise<{ ok: boolean }> => {
    const session = acpSessions.get(reqId);
    if (!session) return { ok: false };
    session.resolvePermission(permId, response);
    return { ok: true };
  },
);

// ---------- ACP write-review IPC ----------
// Renderer reads pending reviews + commits user decisions through
// these handlers. The registry holds the structured-patch hunks; the
// renderer's review UI sends decisions back hunk-by-hunk and then a
// final resolve() that writes the merged content to disk and
// unblocks the agent.
ipcMain.handle('acp-review:list', async (_e, reqId: string) => {
  return reviewRegistry.list(reqId).map((c) => ({
    id: c.id,
    path: c.path,
    unifiedDiff: c.unifiedDiff,
    hunks: c.hunks.map((h) => ({
      index: h.index,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      decision: h.decision,
    })),
    createdAt: c.createdAt,
  }));
});

ipcMain.handle('acp-review:get', async (_e, id: string) => {
  const c = reviewRegistry.get(id);
  if (!c) return null;
  return {
    id: c.id,
    path: c.path,
    baseContent: c.baseContent,
    proposedContent: c.proposedContent,
    unifiedDiff: c.unifiedDiff,
    hunks: c.hunks,
  };
});

ipcMain.handle(
  'acp-review:set-hunk',
  async (
    _e,
    id: string,
    hunkIdx: number,
    decision: 'pending' | 'accepted' | 'rejected',
  ): Promise<{ ok: boolean }> => {
    reviewRegistry.setHunkDecision(id, hunkIdx, decision);
    return { ok: true };
  },
);

ipcMain.handle(
  'acp-review:resolve',
  async (
    _e,
    id: string,
    mode: 'accept-all' | 'reject-all' | 'partial',
  ): Promise<{ ok: boolean; error?: string }> => {
    return reviewRegistry.resolve(id, mode);
  },
);

ipcMain.handle(
  'acp-review:abandon',
  async (_e, id: string): Promise<{ ok: boolean }> => {
    reviewRegistry.abandon(id);
    return { ok: true };
  },
);

// In-flight chat requests, keyed by reqId so the renderer can cancel.
const inflightChats = new Map<string, AbortController>();

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatStartArgs {
  providerId: string;
  model: string;
  messages: ChatMessage[];
  systemPrompt?: string;
}

ipcMain.handle(
  'ai:chat-start',
  async (
    e,
    reqId: string,
    args: ChatStartArgs,
  ): Promise<{ ok: boolean; error?: string }> => {
    const list = await readProviders();
    const provider = list.find((p) => p.id === args.providerId);
    if (!provider) return { ok: false, error: `Unknown provider: ${args.providerId}` };

    const apiKey = provider.needsKey ? await readDecryptedKey(provider.id) : null;
    if (provider.needsKey && !apiKey) {
      return { ok: false, error: `No API key set for ${provider.name}` };
    }

    const controller = new AbortController();
    inflightChats.set(reqId, controller);

    const messages: ChatMessage[] = args.systemPrompt
      ? [{ role: 'system', content: args.systemPrompt }, ...args.messages]
      : args.messages;

    const url = `${provider.baseURL.replace(/\/$/, '')}/chat/completions`;
    const sender = e.sender;

    // Run in background so we can return immediately to the renderer.
    void (async () => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...(provider.extraHeaders ?? {}),
          },
          body: JSON.stringify({
            model: args.model || provider.defaultModel,
            messages,
            stream: true,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text();
          sender.send(`ai:chat:done:${reqId}`, {
            ok: false,
            error: `HTTP ${res.status}: ${body.slice(0, 500)}`,
          });
          return;
        }
        if (!res.body) {
          sender.send(`ai:chat:done:${reqId}`, { ok: false, error: 'Empty body' });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const ev of events) {
            const trimmed = ev.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) sender.send(`ai:chat:chunk:${reqId}`, delta);
            } catch {
              // skip malformed events
            }
          }
        }
        sender.send(`ai:chat:done:${reqId}`, { ok: true });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          sender.send(`ai:chat:done:${reqId}`, { ok: false, error: 'Cancelled' });
        } else {
          sender.send(`ai:chat:done:${reqId}`, {
            ok: false,
            error: (err as Error).message,
          });
        }
      } finally {
        inflightChats.delete(reqId);
      }
    })();

    return { ok: true };
  },
);

ipcMain.handle('ai:chat-cancel', (_e, reqId: string) => {
  inflightChats.get(reqId)?.abort();
  inflightChats.delete(reqId);
  return { ok: true };
});

// =====================================================================
// Find-in-files (ripgrep). We stream rg's --json output; the renderer
// parses match events and renders grouped results.
// =====================================================================

const inflightSearches = new Map<string, ReturnType<typeof spawn>>();

interface SearchArgs {
  rootDir: string;
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  /** rg-style glob filter, e.g. "*.{ts,tsx}". */
  glob?: string;
}

ipcMain.handle(
  'search:start',
  async (e, reqId: string, args: SearchArgs): Promise<{ ok: boolean; error?: string }> => {
    if (!args.rootDir || !args.query) {
      return { ok: false, error: 'Missing rootDir or query' };
    }
    const rgArgs: string[] = ['--json'];
    if (!args.caseSensitive) rgArgs.push('-i');
    if (args.wholeWord) rgArgs.push('-w');
    if (!args.regex) rgArgs.push('-F');
    if (args.glob && args.glob.trim()) {
      rgArgs.push('-g', args.glob.trim());
    }
    // Cap matches so a very common query doesn't tail forever.
    rgArgs.push('-M', '500'); // truncate long lines
    rgArgs.push('--', args.query, args.rootDir);

    let proc;
    try {
      proc = spawn('rg', rgArgs);
    } catch (err) {
      return { ok: false, error: `Failed to spawn rg: ${(err as Error).message}` };
    }
    inflightSearches.set(reqId, proc);

    let buffer = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'match') {
            const m = msg.data;
            const path = m.path?.text ?? '';
            const lineNumber = m.line_number ?? 0;
            const text = m.lines?.text ?? '';
            const submatches: Array<{ start: number; end: number }> = (m.submatches ?? []).map(
              (s: { start: number; end: number }) => ({ start: s.start, end: s.end }),
            );
            e.sender.send(`search:match:${reqId}`, { path, lineNumber, text, submatches });
          }
        } catch {
          // skip malformed line
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      const msg = err.message.includes('ENOENT')
        ? 'ripgrep (rg) not found. Install with `brew install ripgrep`.'
        : err.message;
      e.sender.send(`search:done:${reqId}`, { ok: false, error: msg });
      inflightSearches.delete(reqId);
    });
    proc.on('close', (code) => {
      // rg exits 1 when there are no matches — that's not an error.
      const ok = code === 0 || code === 1;
      e.sender.send(`search:done:${reqId}`, {
        ok,
        error: ok ? undefined : stderr.trim() || `rg exit ${code}`,
        exitCode: code,
      });
      inflightSearches.delete(reqId);
    });

    return { ok: true };
  },
);

ipcMain.handle('search:cancel', (_e, reqId: string) => {
  const proc = inflightSearches.get(reqId);
  if (proc) {
    try {
      proc.kill();
    } catch {
      // already exited
    }
    inflightSearches.delete(reqId);
  }
  return { ok: true };
});

// =====================================================================
// HTTP client tab — main proxies the request so we bypass CORS, support
// any host, and keep response body parsing in Node.
// =====================================================================

interface HttpHeader {
  key: string;
  value: string;
  enabled: boolean;
}

interface HttpRequestArgs {
  method: string;
  url: string;
  headers: HttpHeader[];
  body?: string;
}

interface HttpResponseInfo {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  timeMs: number;
  size?: number;
  error?: string;
}

ipcMain.handle(
  'http:request',
  async (_e, req: HttpRequestArgs): Promise<HttpResponseInfo> => {
    const start = Date.now();
    try {
      const headerObj: Record<string, string> = {};
      for (const h of req.headers ?? []) {
        if (h.enabled !== false && h.key.trim()) {
          headerObj[h.key.trim()] = h.value;
        }
      }
      const init: RequestInit = {
        method: req.method,
        headers: headerObj,
      };
      const upper = req.method.toUpperCase();
      if (req.body && upper !== 'GET' && upper !== 'HEAD') {
        init.body = req.body;
      }
      const res = await fetch(req.url, init);
      const body = await res.text();
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      return {
        ok: true,
        status: res.status,
        statusText: res.statusText,
        headers: respHeaders,
        body,
        size: new TextEncoder().encode(body).length,
        timeMs: Date.now() - start,
      };
    } catch (e) {
      return {
        ok: false,
        error: (e as Error).message,
        timeMs: Date.now() - start,
      };
    }
  },
);

// =====================================================================
// Chat history archive — every chat conversation persists as its own JSON
// file under ~/.milu/chats/. Tabs save on each turn; closing a tab doesn't
// delete the archive, so the user can browse / reopen later.
// =====================================================================

async function chatsDir(): Promise<string> {
  const dir = path.join(await ensureMiluDir(), 'chats');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

interface ChatHistoryEntry {
  id: string;
  title: string;
  providerId: string;
  model: string;
  messageCount: number;
  updatedAt: number; // epoch ms
  preview: string; // first ~120 chars of last user message
}

ipcMain.handle('chat-history:list', async (): Promise<ChatHistoryEntry[]> => {
  try {
    const dir = await chatsDir();
    const files = await fs.readdir(dir);
    const entries: ChatHistoryEntry[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf8');
        const obj = JSON.parse(raw);
        entries.push({
          id: obj.id ?? f.replace(/\.json$/, ''),
          title: obj.title ?? 'Untitled',
          providerId: obj.providerId ?? '',
          model: obj.model ?? '',
          messageCount: Array.isArray(obj.messages) ? obj.messages.length : 0,
          updatedAt: obj.updatedAt ?? 0,
          preview: obj.preview ?? '',
        });
      } catch {
        // skip malformed
      }
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries;
  } catch {
    return [];
  }
});

ipcMain.handle(
  'chat-history:save',
  async (_e, id: string, data: unknown): Promise<{ ok: boolean }> => {
    try {
      const dir = await chatsDir();
      const file = path.join(dir, `${id}.json`);
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, file);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
);

ipcMain.handle('chat-history:load', async (_e, id: string): Promise<string | null> => {
  try {
    const dir = await chatsDir();
    return await fs.readFile(path.join(dir, `${id}.json`), 'utf8');
  } catch {
    return null;
  }
});

ipcMain.handle(
  'chat-history:delete',
  async (_e, id: string): Promise<{ ok: boolean }> => {
    try {
      const dir = await chatsDir();
      await fs.rm(path.join(dir, `${id}.json`), { force: true });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
);

// =====================================================================
// Clipboard history — polls the system clipboard every CLIPBOARD_POLL_MS
// and records changes to ~/.milu/clipboard.json. Image entries spill to
// PNG files in ~/.milu/clipboard-images/ so the renderer can stream them
// through the milu-file:// protocol instead of base64. Renderers never
// poll; they subscribe to the 'clipboard:changed' broadcast.
// =====================================================================

const CLIPBOARD_POLL_MS = 700;
const CLIPBOARD_CAP = 200;
// Apps like 1Password / Bitwarden / Alfred set these pasteboard types to
// signal "transient secret — clipboard managers should ignore me." We
// honor the convention.
const CLIPBOARD_CONCEALED_TYPES = new Set([
  'org.nspasteboard.ConcealedType',
  'org.nspasteboard.TransientType',
  'org.nspasteboard.AutoGeneratedType',
]);

interface ClipboardEntry {
  id: string;
  ts: number;
  kind: 'text' | 'image';
  preview: string;
  text?: string;
  imagePath?: string;
  width?: number;
  height?: number;
  pinned?: boolean;
  byteSize?: number;
}

let clipboardEntries: ClipboardEntry[] = [];
let clipboardCaptureEnabled = true;
let clipboardLastFingerprint = '';
let clipboardWatchTimer: NodeJS.Timeout | null = null;

async function clipboardImagesDir(): Promise<string> {
  const dir = path.join(await ensureMiluDir(), 'clipboard-images');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function clipboardLogPath(): Promise<string> {
  return path.join(await ensureMiluDir(), 'clipboard.json');
}

async function loadClipboardLog() {
  try {
    const raw = await fs.readFile(await clipboardLogPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      clipboardEntries = parsed.filter(
        (e): e is ClipboardEntry =>
          e &&
          typeof e === 'object' &&
          (e.kind === 'text' || e.kind === 'image') &&
          typeof e.id === 'string',
      );
    }
  } catch {
    clipboardEntries = [];
  }
}

async function persistClipboardLog() {
  try {
    const file = await clipboardLogPath();
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(clipboardEntries, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch {
    // ignore persistence errors
  }
}

function broadcastClipboardChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('clipboard:changed');
  }
}

function newClipboardId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimClipboardCap() {
  // Pinned items are preserved indefinitely and don't count against the cap.
  const pinned: ClipboardEntry[] = [];
  const unpinned: ClipboardEntry[] = [];
  for (const e of clipboardEntries) (e.pinned ? pinned : unpinned).push(e);
  if (unpinned.length <= CLIPBOARD_CAP) return;
  const dropped = unpinned.slice(CLIPBOARD_CAP);
  // Best-effort cleanup of evicted image PNGs.
  for (const e of dropped) {
    if (e.kind === 'image' && e.imagePath) {
      void fs.rm(e.imagePath, { force: true }).catch(() => {});
    }
  }
  clipboardEntries = [...pinned, ...unpinned.slice(0, CLIPBOARD_CAP)].sort((a, b) => b.ts - a.ts);
}

async function captureClipboardIfChanged() {
  if (!clipboardCaptureEnabled) return;
  try {
    const formats = clipboard.availableFormats();
    if (formats.some((f) => CLIPBOARD_CONCEALED_TYPES.has(f))) return;

    const hasImage = formats.some((f) => f.startsWith('image/'));
    let entry: ClipboardEntry | null = null;
    let fingerprint = '';

    if (hasImage) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const png = img.toPNG();
        fingerprint = 'img:' + png.length + ':' + png.subarray(0, 16).toString('hex');
        if (fingerprint !== clipboardLastFingerprint) {
          const id = newClipboardId();
          const dir = await clipboardImagesDir();
          const file = path.join(dir, `${id}.png`);
          await fs.writeFile(file, png);
          const size = img.getSize();
          entry = {
            id,
            ts: Date.now(),
            kind: 'image',
            preview: `${size.width}×${size.height} PNG`,
            imagePath: file,
            width: size.width,
            height: size.height,
            byteSize: png.length,
          };
        }
      }
    } else {
      const text = clipboard.readText();
      if (text && text.length > 0) {
        // Length + first slice keeps the fingerprint cheap; collisions just
        // skip a duplicate, which is fine.
        fingerprint = 'txt:' + text.length + ':' + text.slice(0, 64);
        if (fingerprint !== clipboardLastFingerprint) {
          entry = {
            id: newClipboardId(),
            ts: Date.now(),
            kind: 'text',
            preview: text.replace(/\s+/g, ' ').trim().slice(0, 200),
            text,
            byteSize: Buffer.byteLength(text, 'utf8'),
          };
        }
      }
    }

    if (!entry) {
      if (fingerprint) clipboardLastFingerprint = fingerprint;
      return;
    }
    clipboardLastFingerprint = fingerprint;

    // Drop existing exact-text dupe so the entry surfaces fresh at the top.
    if (entry.kind === 'text') {
      clipboardEntries = clipboardEntries.filter(
        (e) => !(e.kind === 'text' && e.text === entry!.text && !e.pinned),
      );
    }
    clipboardEntries.unshift(entry);
    trimClipboardCap();
    await persistClipboardLog();
    broadcastClipboardChanged();
  } catch {
    // clipboard read can race during fast paste cycles — swallow
  }
}

function startClipboardWatcher() {
  if (clipboardWatchTimer) return;
  // Seed the fingerprint with whatever is already on the clipboard at launch
  // so we don't immediately log it.
  try {
    const formats = clipboard.availableFormats();
    if (formats.some((f) => f.startsWith('image/'))) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const png = img.toPNG();
        clipboardLastFingerprint =
          'img:' + png.length + ':' + png.subarray(0, 16).toString('hex');
      }
    } else {
      const t = clipboard.readText();
      if (t) clipboardLastFingerprint = 'txt:' + t.length + ':' + t.slice(0, 64);
    }
  } catch {
    // ignore
  }
  clipboardWatchTimer = setInterval(captureClipboardIfChanged, CLIPBOARD_POLL_MS);
  // Don't keep the event loop alive solely for the timer.
  if (typeof clipboardWatchTimer.unref === 'function') clipboardWatchTimer.unref();
}

ipcMain.handle('clipboard:list', async (): Promise<ClipboardEntry[]> => clipboardEntries);

ipcMain.handle('clipboard:write', async (_e, id: string): Promise<{ ok: boolean }> => {
  const entry = clipboardEntries.find((x) => x.id === id);
  if (!entry) return { ok: false };
  try {
    if (entry.kind === 'text' && entry.text != null) {
      clipboard.writeText(entry.text);
      clipboardLastFingerprint =
        'txt:' + entry.text.length + ':' + entry.text.slice(0, 64);
    } else if (entry.kind === 'image' && entry.imagePath) {
      const buf = await fs.readFile(entry.imagePath);
      const img = nativeImage.createFromBuffer(buf);
      clipboard.writeImage(img);
      clipboardLastFingerprint =
        'img:' + buf.length + ':' + buf.subarray(0, 16).toString('hex');
    }
    // Bump to top of history so it's where the user expects.
    entry.ts = Date.now();
    clipboardEntries = [entry, ...clipboardEntries.filter((x) => x.id !== id)];
    await persistClipboardLog();
    broadcastClipboardChanged();
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('clipboard:delete', async (_e, id: string): Promise<{ ok: boolean }> => {
  const entry = clipboardEntries.find((x) => x.id === id);
  if (!entry) return { ok: false };
  if (entry.kind === 'image' && entry.imagePath) {
    try { await fs.rm(entry.imagePath, { force: true }); } catch { /* ignore */ }
  }
  clipboardEntries = clipboardEntries.filter((x) => x.id !== id);
  await persistClipboardLog();
  broadcastClipboardChanged();
  return { ok: true };
});

ipcMain.handle('clipboard:clear', async (): Promise<{ ok: boolean }> => {
  const removed = clipboardEntries.filter((e) => !e.pinned);
  for (const e of removed) {
    if (e.kind === 'image' && e.imagePath) {
      try { await fs.rm(e.imagePath, { force: true }); } catch { /* ignore */ }
    }
  }
  clipboardEntries = clipboardEntries.filter((e) => e.pinned);
  await persistClipboardLog();
  broadcastClipboardChanged();
  return { ok: true };
});

ipcMain.handle(
  'clipboard:pin',
  async (_e, id: string, pinned: boolean): Promise<{ ok: boolean }> => {
    const entry = clipboardEntries.find((x) => x.id === id);
    if (!entry) return { ok: false };
    entry.pinned = pinned;
    await persistClipboardLog();
    broadcastClipboardChanged();
    return { ok: true };
  },
);

ipcMain.handle(
  'clipboard:set-paused',
  async (_e, paused: boolean): Promise<{ ok: boolean }> => {
    clipboardCaptureEnabled = !paused;
    return { ok: true };
  },
);

ipcMain.handle('clipboard:get-paused', async (): Promise<boolean> => !clipboardCaptureEnabled);

// =====================================================================
// SQLite client — one cached connection per file path. The renderer
// drives a query editor + schema browser; main owns the actual db handle
// so we never block the renderer on disk IO. better-sqlite3 is synchronous
// but we wrap each call in a try/catch and return error objects rather
// than throwing across the IPC boundary.
// =====================================================================

// Lazy require: the native binding shouldn't load until the user actually
// opens a sqlite tab, so a missing build doesn't crash the app on launch.
type BetterSqlite3Database = {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
    columns: () => Array<{ name: string }>;
    reader: boolean;
  };
  exec: (sql: string) => void;
  pragma: (s: string) => unknown;
  close: () => void;
  readonly: boolean;
};
type BetterSqlite3Constructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => BetterSqlite3Database;

let SqliteCtor: BetterSqlite3Constructor | null = null;
function loadSqliteModule(): BetterSqlite3Constructor | null {
  if (SqliteCtor) return SqliteCtor;
  try {
    const mod = require('better-sqlite3');
    SqliteCtor = (mod.default ?? mod) as BetterSqlite3Constructor;
    return SqliteCtor;
  } catch (err) {
    console.error('[milu] failed to load better-sqlite3:', (err as Error).message);
    return null;
  }
}

const sqliteConnections = new Map<string, BetterSqlite3Database>();

function getSqliteConnection(filePath: string): BetterSqlite3Database | { error: string } {
  const cached = sqliteConnections.get(filePath);
  if (cached) return cached;
  const Ctor = loadSqliteModule();
  if (!Ctor) return { error: 'better-sqlite3 module unavailable' };
  try {
    const db = new Ctor(filePath, { fileMustExist: true });
    sqliteConnections.set(filePath, db);
    return db;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

interface SqliteSchemaTable {
  name: string;
  type: 'table' | 'view';
  rowCount: number | null; // null if count failed (large or external)
  columns: { name: string; type: string; notNull: boolean; pk: number; defaultValue: string | null }[];
}

interface SqliteSchema {
  tables: SqliteSchemaTable[];
  pragma: { foreignKeys: boolean; journalMode: string };
}

ipcMain.handle('sqlite:open', async (_e, filePath: string): Promise<{ ok: boolean; error?: string }> => {
  const conn = getSqliteConnection(filePath);
  if ('error' in conn) return { ok: false, error: conn.error };
  return { ok: true };
});

ipcMain.handle('sqlite:close', async (_e, filePath: string): Promise<{ ok: boolean }> => {
  const conn = sqliteConnections.get(filePath);
  if (conn) {
    try { conn.close(); } catch { /* ignore */ }
    sqliteConnections.delete(filePath);
  }
  return { ok: true };
});

ipcMain.handle(
  'sqlite:schema',
  async (_e, filePath: string): Promise<{ ok: boolean; data?: SqliteSchema; error?: string }> => {
    const conn = getSqliteConnection(filePath);
    if ('error' in conn) return { ok: false, error: conn.error };
    try {
      const objects = conn
        .prepare(
          `SELECT name, type FROM sqlite_master
           WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
           ORDER BY type, name`,
        )
        .all() as { name: string; type: 'table' | 'view' }[];
      const tables: SqliteSchemaTable[] = [];
      for (const obj of objects) {
        const cols = conn
          .prepare(`PRAGMA table_info(${quoteIdent(obj.name)})`)
          .all() as { name: string; type: string; notnull: number; pk: number; dflt_value: string | null }[];
        let rowCount: number | null = null;
        try {
          const row = conn
            .prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(obj.name)}`)
            .all() as { c: number }[];
          rowCount = row[0]?.c ?? null;
        } catch {
          rowCount = null;
        }
        tables.push({
          name: obj.name,
          type: obj.type,
          rowCount,
          columns: cols.map((c) => ({
            name: c.name,
            type: c.type,
            notNull: c.notnull === 1,
            pk: c.pk,
            defaultValue: c.dflt_value,
          })),
        });
      }
      const fk = conn.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
      const journal = conn.pragma('journal_mode') as Array<{ journal_mode: string }>;
      return {
        ok: true,
        data: {
          tables,
          pragma: {
            foreignKeys: Array.isArray(fk) && fk[0]?.foreign_keys === 1,
            journalMode: Array.isArray(journal) ? journal[0]?.journal_mode ?? 'unknown' : 'unknown',
          },
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

interface SqliteQueryResult {
  ok: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  changes?: number;
  isReadOnly?: boolean;
  truncated?: boolean;
  timeMs?: number;
  error?: string;
}

const SQLITE_ROW_CAP = 5000;

ipcMain.handle(
  'sqlite:query',
  async (_e, filePath: string, sql: string): Promise<SqliteQueryResult> => {
    const conn = getSqliteConnection(filePath);
    if ('error' in conn) return { ok: false, error: conn.error };
    const start = Date.now();
    try {
      const stmt = conn.prepare(sql);
      const isReadOnly = stmt.reader;
      if (isReadOnly) {
        const all = stmt.all() as unknown[];
        const truncated = all.length > SQLITE_ROW_CAP;
        const rows = (truncated ? all.slice(0, SQLITE_ROW_CAP) : all) as Record<string, unknown>[];
        // Column metadata isn't available until after a step on PRAGMAs and
        // such, so fall back to the keys of the first row when needed.
        let columns: string[] = stmt.columns().map((c) => c.name);
        if (columns.length === 0 && rows.length > 0) {
          columns = Object.keys(rows[0] as object);
        }
        const tabular: unknown[][] = rows.map((r) =>
          columns.map((c) => (r as Record<string, unknown>)[c]),
        );
        return {
          ok: true,
          columns,
          rows: tabular,
          rowCount: tabular.length,
          isReadOnly: true,
          truncated,
          timeMs: Date.now() - start,
        };
      }
      const result = stmt.run();
      return {
        ok: true,
        isReadOnly: false,
        changes: result.changes,
        timeMs: Date.now() - start,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message, timeMs: Date.now() - start };
    }
  },
);

function quoteIdent(name: string): string {
  // SQLite identifier quoting — wrap in double quotes, double up any inner ones.
  return `"${name.replace(/"/g, '""')}"`;
}

// =====================================================================
// macOS application discovery — scan the standard `.app` folders so the
// launcher can autocomplete + launch installed applications. Cached for
// 30 s; refreshed on demand.
// =====================================================================

interface AppEntry {
  name: string;
  path: string;
}

const APP_SCAN_DIRS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  path.join(os.homedir(), 'Applications'),
];
const APP_CACHE_TTL_MS = 30_000;
let appCache: { ts: number; apps: AppEntry[] } | null = null;

async function scanApps(): Promise<AppEntry[]> {
  if (appCache && Date.now() - appCache.ts < APP_CACHE_TTL_MS) return appCache.apps;
  const seen = new Set<string>();
  const apps: AppEntry[] = [];
  for (const dir of APP_SCAN_DIRS) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue;
      const name = entry.slice(0, -4);
      const full = path.join(dir, entry);
      // Dedup across dirs (e.g., a user copy at ~/Applications shadowing
      // /Applications); first occurrence wins.
      if (seen.has(name)) continue;
      seen.add(name);
      apps.push({ name, path: full });
    }
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  appCache = { ts: Date.now(), apps };
  return apps;
}

ipcMain.handle('apps:list', async (): Promise<AppEntry[]> => scanApps());

/** Per-app icon cache, keyed by absolute path. PNG data URLs at ~64px.
 *  Null entries are also cached so a bundle that fails once doesn't keep
 *  retrying every keystroke. */
const appIconCache = new Map<string, string | null>();

ipcMain.handle('apps:icon', async (_e, appPath: string): Promise<string | null> => {
  if (!appPath) return null;
  if (appIconCache.has(appPath)) return appIconCache.get(appPath) ?? null;
  // Each step is wrapped in its own try so a failure in resize/toDataURL
  // (which has been observed to crash on certain .icns variants) gets
  // caught instead of taking down the main process.
  try {
    const icon = await app.getFileIcon(appPath, { size: 'large' });
    if (icon.isEmpty()) {
      appIconCache.set(appPath, null);
      return null;
    }
    let dataUrl: string;
    try {
      const sized = icon.resize({ width: 64, height: 64, quality: 'best' });
      dataUrl = sized.toDataURL();
    } catch {
      // Fall back to the original size if resize fails.
      try {
        dataUrl = icon.toDataURL();
      } catch {
        appIconCache.set(appPath, null);
        return null;
      }
    }
    appIconCache.set(appPath, dataUrl);
    return dataUrl;
  } catch (err) {
    console.warn('[milu] apps:icon failed for', appPath, (err as Error).message);
    appIconCache.set(appPath, null);
    return null;
  }
});

// =====================================================================
// Launcher window — small frameless palette woken by the global hotkey.
// Dispatches the chosen action over to the main window and hides itself.
// =====================================================================

ipcMain.handle('launcher:set-hotkey', async (_e, accelerator: string): Promise<{ ok: boolean }> => {
  if (typeof accelerator !== 'string' || !accelerator) return { ok: false };
  if (accelerator === currentLauncherHotkey) return { ok: true };
  return { ok: registerLauncherHotkey(accelerator) };
});

ipcMain.handle('launcher:hide', async () => {
  hideLauncher();
  return { ok: true };
});

ipcMain.handle('launcher:dispatch', async (_e, action: unknown): Promise<{ ok: boolean }> => {
  const a = action as { type?: string; appPath?: string } | null;

  // External-app launches: hide the launcher (it's a macOS panel, so
  // hiding returns focus naturally — no app.hide() needed) and let
  // shell.openPath bring the target app forward. Removed the prior
  // app.hide() here because it was occasionally demoting Milu's
  // activation policy and stealing focus on re-show.
  if (a?.type === 'open-app' && typeof a.appPath === 'string') {
    suppressLauncherBlur = true;
    launcherWindow?.hide();
    try {
      await shell.openPath(a.appPath);
    } catch (err) {
      console.warn('[milu] open-app failed:', (err as Error).message);
    }
    setTimeout(() => { suppressLauncherBlur = false; }, 50);
    return { ok: true };
  }

  // Milu-internal actions need the main window. Hide the launcher
  // (suppressing the blur-hide path so this isn't treated as a user
  // dismiss) and bring main forward.
  suppressLauncherBlur = true;
  launcherWindow?.hide();
  try {
    if (!mainWindow) return { ok: false };
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('launcher:run', action);
    return { ok: true };
  } finally {
    setTimeout(() => { suppressLauncherBlur = false; }, 50);
  }
});
