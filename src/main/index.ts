// ── VGC Browser — main process entry ─────────────────────────────────────────
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
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

function createWindow(): void {
  // Window/taskbar icon — transparent multi-size .ico generated from the logo (no white
  // background; PNG→ICO via electron-builder was flattening the alpha to white).
  // Packaged → resources/app.ico (extraResources); dev → the repo's resources/app.ico.
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'app.ico')
    : join(__dirname, '../../resources/app.ico')

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'VGC Browser',
    icon: iconPath,
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

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  void restartApiServer()
  initUpdater()

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
