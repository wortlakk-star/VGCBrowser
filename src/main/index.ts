// ── VGC Browser — main process entry ─────────────────────────────────────────
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerIpc } from './ipc'
import { stopAllAndSync } from './profile-manager'
import { restartApiServer, stopApiServer } from './api-manager'
import { initUpdater, hasDownloadedUpdate, installOnQuit } from './updater'
import { startProxyKeepAlive, stopProxyKeepAlive } from './proxy-keepalive'
import { startScheduler, stopScheduler } from './warmup-scheduler'
import { fileURLToPath } from 'url'
import { trustedExternalUrl } from './validation'

const EXTERNAL_HOSTS = new Set([
  'vgcbrowser.com',
  'www.vgcbrowser.com',
  'dashboard.iproyal.com',
  'my.evomi.com',
  'dash.cliproxy.com',
  'dashboard.capsolver.com'
])

// Enforce Chromium's process sandbox for every renderer/utility process before
// Electron becomes ready. The preload only uses contextBridge + ipcRenderer.
app.enableSandbox()

function safeExternalUrl(raw: string): string | null {
  return trustedExternalUrl(raw, EXTERNAL_HOSTS)
}

function devRendererUrl(): URL | null {
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return null
  try {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      (url.protocol === 'http:' || url.protocol === 'https:')
      ? url
      : null
  } catch {
    return null
  }
}

function isRendererNavigation(raw: string): boolean {
  try {
    const target = new URL(raw)
    const devUrl = devRendererUrl()
    if (devUrl) return target.origin === devUrl.origin
    return target.protocol === 'file:' && fileURLToPath(target) === join(__dirname, '../renderer/index.html')
  } catch {
    return false
  }
}

// Network races — a browser tab or upstream proxy closing mid-write — surface as
// socket errors with these codes. The proxy relay attaches its own handlers, but
// this is a last-resort guard so a stray one never escalates to the fatal "A
// JavaScript error occurred in the main process" dialog. Non-network errors are
// re-thrown so real bugs still crash and aren't silently masked.
const BENIGN_NET = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ERR_STREAM_WRITE_AFTER_END'])
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err && BENIGN_NET.has(err.code ?? '')) {
    console.warn('[net] ignored benign socket error:', err.code, err.message)
    return
  }
  throw err
})

// A stray unhandled promise rejection (a missed .catch in a background sync/upload
// path) would, on modern Node/Electron, crash the whole main process with the fatal
// "A JavaScript error occurred" dialog and close the window. Log it instead so one
// missed catch can't kill the app — real bugs still surface in the log.
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? (reason as NodeJS.ErrnoException) : null
  if (err && BENIGN_NET.has(err.code ?? '')) {
    console.warn('[net] ignored benign rejected socket error:', err.code, err.message)
    return
  }
  console.error('[main] unhandledRejection:', reason)
})

function createWindow(): void {
  // Window/taskbar icon — transparent multi-size .ico generated from the logo (no white
  // background; PNG→ICO via electron-builder was flattening the alpha to white).
  // Packaged → resources/app.ico (extraResources); dev → the repo's resources/app.ico.
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'app.ico')
    : join(__dirname, '../../resources/app.ico')
  // Only pass the icon if it actually exists — a missing/invalid path can break
  // window creation on Windows (and would leave the app unable to open).
  const icon = existsSync(iconPath) ? iconPath : undefined

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'VGC Browser',
    icon,
    backgroundColor: '#0c1613',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Open external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const safe = safeExternalUrl(url)
    if (safe) void shell.openExternal(safe)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (isRendererNavigation(url)) return
    event.preventDefault()
    const safe = safeExternalUrl(url)
    if (safe) void shell.openExternal(safe)
  })

  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const ses = win.webContents.session
  ses.setPermissionCheckHandler(() => false)
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  const devUrl = devRendererUrl()
  if (devUrl) {
    win.loadURL(devUrl.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Quit state — declared here because the single-instance handler below reads it.
let quitHandled = false
let reopenRequested = false

// Single-instance lock: if VGC Browser is launched again (the user double-clicking the
// icon, or the auto-start task) while it is already running, DON'T spawn a second
// process — two instances fight over the same profiles dir + debug ports and one ends
// up a hung, windowless zombie ("I click the icon and nothing opens"). Instead the
// second launch hands off to the running instance, which surfaces + focuses its window.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    } else if (!quitHandled) {
      // No window yet and we're NOT shutting down → the app is still starting; build the UI.
      createWindow()
    } else {
      // A reopen click landed DURING graceful-quit's (up-to-15s) cloud-sync window. Building a
      // window now would just be destroyed by the pending app.exit(0), silently losing the click.
      // Remember it and relaunch a fresh instance after we exit instead.
      reopenRequested = true
    }
  })
}

app.whenReady().then(() => {
  // A duplicate launch already called app.quit() above — don't build a second UI.
  if (!gotSingleInstanceLock) return
  // Each piece is isolated so one failing service (IPC, API server, updater) can't
  // stop the WINDOW from opening — the app must always at least launch its UI.
  try {
    registerIpc()
  } catch (e) {
    console.error('[startup] registerIpc failed:', e)
  }
  try {
    createWindow()
  } catch (e) {
    // The window is the whole app — a windowless process is worse than an honest
    // crash (the user sees nothing and can't quit it). Log and exit.
    console.error('[startup] createWindow failed:', e)
    app.quit()
    return
  }
  void Promise.resolve()
    .then(() => restartApiServer())
    .catch((e) => console.error('[startup] api server failed:', e))
  try {
    initUpdater()
  } catch (e) {
    console.error('[startup] updater failed:', e)
  }
  try {
    // Keep residential (Evomi hardsession) IPs from rotating on inactivity.
    startProxyKeepAlive()
  } catch (e) {
    console.error('[startup] proxy keep-alive failed:', e)
  }
  try {
    // Scheduled auto warm-up (runs due profiles while the app is open).
    startScheduler()
  } catch (e) {
    console.error('[startup] warm-up scheduler failed:', e)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Graceful quit: stop every profile and UPLOAD each session to cloud BEFORE the
// app exits, so the latest cookies/logins are always saved (GoLogin-style). A 15s
// cap guarantees the app still exits even if an upload stalls on the network.
async function gracefulQuit(): Promise<void> {
  if (quitHandled) return
  quitHandled = true
  try {
    await Promise.race([
      stopAllAndSync(),
      new Promise((r) => setTimeout(r, 15000))
    ])
  } catch {
    // ignore — exit regardless
  }
  stopApiServer()
  stopProxyKeepAlive()
  stopScheduler()
  // If a newer version finished downloading, APPLY it now (the app is fully quitting).
  // electron-updater's own auto-install-on-quit hooks the 'quit' event, which app.exit(0)
  // below never emits — so on an always-on VPS the download sat pending forever and the
  // user "couldn't update". Spawn the installer explicitly; if it doesn't take over within
  // a few seconds, fall through to the hard exit (the installer, once spawned, still runs).
  if (hasDownloadedUpdate()) {
    installOnQuit()
    setTimeout(() => app.exit(0), 4000)
    return
  }
  // Honor a reopen click that arrived mid-shutdown: relaunch a fresh instance after we exit.
  if (reopenRequested) app.relaunch()
  app.exit(0)
}

app.on('window-all-closed', () => {
  void gracefulQuit()
})

app.on('before-quit', (e) => {
  if (!quitHandled) {
    e.preventDefault()
    void gracefulQuit()
  }
})
