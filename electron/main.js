/**
 * Desktop shell.
 *
 * Runs the ordinary LichessPro server in-process on a random loopback port and
 * points a window at it, so `public/` is the same code the terminal version
 * serves. What this file adds is everything a double-clickable app needs and a
 * terminal does not: a tray so the arbiter survives the window closing, a guard
 * against quitting mid-game, and a rule that sends outside links to the real
 * browser.
 */
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const asset = (name) => path.join(dir, 'assets', name);

let instance = null;
let win = null;
let tray = null;
let quitting = false;

// A second copy would run a second arbiter over the same match file and pay
// every bonus twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  main();
}

async function main() {
  await app.whenReady();

  try {
    instance = await startServer({
      port: 0, // let the OS pick, so we never clash with anything on 8080
      host: '127.0.0.1', // loopback only: this process holds both players' tokens
      dataDir: app.getPath('userData'),
      desktop: true,
    });
  } catch (err) {
    dialog.showErrorBox('LichessPro could not start', String(err?.stack ?? err));
    app.exit(1);
    return;
  }

  createWindow();
  createTray();

  app.on('activate', showWindow); // macOS dock click
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 940,
    minWidth: 420,
    minHeight: 480,
    show: false,
    backgroundColor: '#14130f',
    title: 'LichessPro',
    icon: process.platform === 'linux' ? asset('icon.png') : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(instance.url);

  // Closing the window must not stop the arbiter — a classical game runs for
  // hours and the whole point of the tray is that it keeps going.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });

  applyNavigationRule(win);
}

/**
 * Anything that is not our own loopback origin opens in the user's browser:
 * the Lichess consent page, "Open on Lichess", any link at all.
 *
 * Sending OAuth to the system browser is what RFC 8252 asks of a native app,
 * and it is where the user's Lichess session already is. The sign-in still
 * works because the seat is claimed with the client id captured when
 * /auth/login was requested here — the browser's own cookie never matters.
 */
function applyNavigationRule(target) {
  const isLocal = (url) => {
    try {
      return new URL(url).origin === new URL(instance.url).origin;
    } catch {
      return false;
    }
  };
  const external = (url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
  };

  target.webContents.on('will-navigate', (event, url) => {
    if (isLocal(url)) return;
    event.preventDefault();
    external(url);
  });
  target.webContents.on('will-redirect', (event, url) => {
    if (isLocal(url)) return;
    event.preventDefault();
    external(url);
  });
  target.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const image = nativeImage.createFromPath(asset('trayTemplate.png'));
  image.setTemplateImage(true); // follows the macOS menu bar in light and dark
  tray = new Tray(image);
  tray.setToolTip('LichessPro — arbiter running');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open LichessPro', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (process.platform === 'darwin') app.dock?.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Matches whose game is running and still owe someone a bonus. */
function unfinishedBusiness() {
  const live = [];
  for (const match of instance?.store.all() ?? []) {
    if (match.status !== 'live') continue;
    const owed = Object.values(match.deliveries ?? {}).filter((d) => !d.done && !d.error).length;
    live.push({ label: match.specLabel, owed });
  }
  return live;
}

// Quitting stops the arbiter. If a game is in progress that means a bonus may
// never arrive, and the player finds out by flagging.
//
// The whole shutdown hangs off `before-quit` rather than `will-quit`: it is the
// event that reliably fires on every platform, and depending on the later one
// left the app unable to exit at all on Linux.
app.on('before-quit', (event) => {
  if (quitting) return; // second pass, let it through

  if (!confirmQuit()) {
    event.preventDefault();
    return;
  }

  quitting = true;
  event.preventDefault(); // hold the quit open while the server winds down
  void shutdown();
});

/** @returns {boolean} true if it is fine to quit now */
function confirmQuit() {
  const live = unfinishedBusiness();
  if (live.length === 0) return true;

  const pending = live.reduce((n, m) => n + m.owed, 0);
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Keep running', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'A game is still live',
    message: `LichessPro is still refereeing ${live.length} game${live.length === 1 ? '' : 's'}.`,
    detail:
      pending > 0
        ? `${pending} bonus deliver${pending === 1 ? 'y is' : 'ies are'} still owed. Quitting now means the time never arrives and your opponent could flag.`
        : 'Quitting now stops the arbiter, so any bonus still to come will not be delivered.',
  });
  return choice === 1;
}

async function shutdown() {
  const closing = instance;
  instance = null;
  try {
    await closing?.close();
  } catch {
    // nothing useful left to do; we are exiting either way
  }
  app.exit(0);
}

// The tray is the app; a closed window is not a reason to stop refereeing.
app.on('window-all-closed', () => {});
