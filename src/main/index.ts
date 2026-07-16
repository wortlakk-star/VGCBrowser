// ── VGC Browser — main process entry ─────────────────────────────────────────
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerIpc } from './ipc'
import { stopAllAndSync } from './profile-manager'
import { restartApiServer, stopApiServer } from './api-manager'
import { initUpdater } from './updater'

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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Open external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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
    } else {
      createWindow()
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Graceful quit: stop every profile and UPLOAD each session to cloud BEFORE the
// app exits, so the latest cookies/logins are always saved (GoLogin-style). A 15s
// cap guarantees the app still exits even if an upload stalls on the network.
let quitHandled = false
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
