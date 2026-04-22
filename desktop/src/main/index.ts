import { app, BrowserWindow, ipcMain } from "electron";
import { registerPtyHandlers, killAllPtys } from "./pty";
import { startOpenServer } from "./openServer";
import { createMainWindow, getMainWindow } from "./window";
import { registerActionHandlers } from "./actions";
import { IPC } from "../shared/ipc";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.vibehq.hq");
    registerPtyHandlers();
    registerActionHandlers();
    startOpenServer();
    ipcMain.on(IPC.diagLog, (_e, ...args) => {
      console.log("[diag]", ...args);
    });
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    killAllPtys();
  });
}
