import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { appMenuTemplate, DEV_ONLY_ROLES } from "./app-menu.js";

/** Every role anywhere in a template, submenus included. */
function roles(items: readonly MenuItemConstructorOptions[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.role !== undefined) out.push(item.role);
    if (Array.isArray(item.submenu)) out.push(...roles(item.submenu));
  }
  return out;
}

describe("appMenuTemplate (UX review 2026-09-22, item 7)", () => {
  it("a packaged build carries no reload and no developer tools, on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const template = appMenuTemplate({ platform, isPackaged: true });
      expect(template).not.toBeNull();
      const all = roles(template ?? []);
      for (const role of DEV_ONLY_ROLES) expect(all).not.toContain(role);
    }
  });

  it("keeps editing, zoom, full screen and the window roles — macOS needs the Edit menu for Cmd+C", () => {
    const mac = roles(
      appMenuTemplate({ platform: "darwin", isPackaged: true }) ?? [],
    );
    expect(mac).toEqual(
      expect.arrayContaining([
        "appMenu",
        "editMenu",
        "zoomIn",
        "zoomOut",
        "resetZoom",
        "togglefullscreen",
        "windowMenu",
      ]),
    );
    const win = roles(
      appMenuTemplate({ platform: "win32", isPackaged: true }) ?? [],
    );
    expect(win).toEqual(
      expect.arrayContaining(["fileMenu", "editMenu", "windowMenu"]),
    );
    expect(win).not.toContain("appMenu");
  });

  it("a development build keeps Electron's default menu (null)", () => {
    expect(appMenuTemplate({ platform: "win32", isPackaged: false })).toBe(
      null,
    );
  });
});
