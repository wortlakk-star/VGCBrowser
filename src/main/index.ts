// ── VGC Browser — main process entry ─────────────────────────────────────────
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { stopAllAndSync } from './profile-manager'
import { restartApiServer, stopApiServer } from './api-manager'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'VGC Browser',
    backgroundColor: '#0f1115',
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
