import type { SessionMetadata } from "@herta/app-server";
import { Menu, nativeImage, Tray } from "electron";
import type { Locale } from "./app-global-settings.js";
import {
  buildTrayMenuTemplate,
  renderTrayIconBitmap,
  trayLabels,
} from "./tray-menu.js";

export interface AppTrayDeps {
  /** Newest-first metadata for the Recent section (empty until bootstrap). */
  listSessions(): readonly SessionMetadata[];
  /** Activate an existing session (same last-click-wins path as the sidebar). */
  openSession(sessionId: string): Promise<void>;
  /** Create + activate a fresh session (tray "New Chat"). */
  newChat(): Promise<void>;
  /** Restore + focus the (possibly hidden-to-tray) main window. */
  showWindow(): void;
  /** Real exit — the close-to-tray override must NOT apply here. */
  requestExit(): void;
  /** Persisted UI locale; the menu is rebuilt per open so a language switch
   *  in Settings applies to the very next right-click. */
  getLocale(): Promise<Locale>;
}

export interface AppTray {
  /** Re-resolve the persisted locale and update the hover tooltip. Called
   *  at creation and by the Settings → Language apply path — the tooltip is
   *  rendered by the OS on hover (no menu open involved), so it must be
   *  pushed on change; per-open re-resolution only covers the MENU labels. */
  refreshTooltip(): void;
  destroy(): void;
}

/**
 * The tray image, per platform.
 *
 * Windows: the colored badge at 32px, as before.
 *
 * macOS: the menu bar wants a TEMPLATE image — black-and-alpha only, which
 * the OS then tints for the light/dark menu bar and for the highlighted
 * state. Shipping the colored badge there would render a dark blob that
 * ignores the menu bar's appearance. Two differences beyond the color:
 *   - the glyph is KNOCKED OUT (alpha 0) rather than painted white, since a
 *     template's opaque pixels all become one color — the "H." reads as a
 *     cutout in the badge silhouette;
 *   - the 32px bitmap is added as an @2x representation of a 16pt image, so
 *     it stays crisp on Retina AND fits the ~22pt menu bar (a plain 32px
 *     nativeImage would be interpreted as 32pt and get scaled down).
 * NOT verifiable on this machine — the macOS CI screenshot captures the full
 * screen including the menu bar, which is where this gets checked.
 */
function buildTrayIcon(size: number): Electron.NativeImage {
  if (process.platform !== "darwin") {
    return nativeImage.createFromBitmap(renderTrayIconBitmap(size), {
      width: size,
      height: size,
    });
  }
  const img = nativeImage.createEmpty();
  img.addRepresentation({
    scaleFactor: 2,
    width: size,
    height: size,
    buffer: renderTrayIconBitmap(size, { template: true }),
  });
  img.setTemplateImage(true);
  return img;
}

/**
 * System-tray affordance (user 2026-07-04): the window close button hides to
 * the tray instead of quitting (index.ts owns that), and this tray is then
 * the app's persistent presence — left-click reopens the window; right-click
 * shows Recent sessions / New Chat / Open / Exit, Codex-style.
 *
 * The context menu is built FRESH on every right-click (popUpContextMenu,
 * not a static setContextMenu) so the Recent list always reflects the
 * current sessions without any invalidation bookkeeping.
 */
export function createAppTray(deps: AppTrayDeps): AppTray {
  const size = 32;
  const icon = buildTrayIcon(size);
  const tray = new Tray(icon);
  const refreshTooltip = (): void => {
    void deps
      .getLocale()
      .then((l) => tray.setToolTip(trayLabels(l).tooltip))
      .catch(() => tray.setToolTip(trayLabels("en").tooltip));
  };
  refreshTooltip();

  const show = (): void => deps.showWindow();
  tray.on("click", show);
  tray.on("double-click", show);

  tray.on("right-click", () => {
    void (async (): Promise<void> => {
      let locale: Locale = "en";
      try {
        locale = await deps.getLocale();
      } catch {
        // settings unreadable → English labels; the menu still works.
      }
      const labels = trayLabels(locale);
      const template = buildTrayMenuTemplate(deps.listSessions(), labels, {
        // Opening a session / starting a chat from the tray also SHOWS the
        // window — the tray is a launcher, not a headless console; the
        // renderer adopts the activation via the session:reset it receives.
        onOpenSession: (id) => {
          deps.showWindow();
          void deps.openSession(id);
        },
        onNewChat: () => {
          deps.showWindow();
          void deps.newChat();
        },
        onShow: show,
        onExit: () => deps.requestExit(),
      });
      tray.popUpContextMenu(Menu.buildFromTemplate(template));
    })();
  });

  return {
    refreshTooltip,
    destroy: () => tray.destroy(),
  };
}
