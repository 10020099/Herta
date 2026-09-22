import type { MenuItemConstructorOptions } from "electron";

/** Roles a packaged app must never carry: each one is a keyboard shortcut
 *  that reloads the window or opens the developer tools. */
export const DEV_ONLY_ROLES: ReadonlySet<string> = new Set([
  "reload",
  "forceReload",
  "toggleDevTools",
]);

/**
 * The application menu, or null to keep Electron's default.
 *
 * The window is frameless (`titleBarStyle: "hidden"`), so no menu is ever
 * SEEN on Windows or Linux — but Electron's default menu stays installed and
 * its accelerators stay live. In a packaged build Ctrl+R reloaded the window
 * mid-turn and Ctrl+Shift+I opened the developer tools on a window that
 * holds the app's whole IPC bridge (UX review 2026-09-22, item 7).
 *
 * Packaged: the default menu's shape minus those three roles. Editing,
 * zoom, full screen and the window roles stay: on macOS the Edit menu is
 * what makes Cmd+C / Cmd+V work in a text field at all, and a user's zoom
 * or Ctrl+W close is not the bug. A development build keeps the default
 * (reload and the tools are how the app is worked on).
 */
export function appMenuTemplate(opts: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
}): MenuItemConstructorOptions[] | null {
  if (!opts.isPackaged) return null;
  const mac = opts.platform === "darwin";
  return [
    mac ? { role: "appMenu" } : { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}
