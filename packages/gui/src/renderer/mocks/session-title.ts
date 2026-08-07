import type { SessionMetadata } from "@herta/app-server";
import { deriveTitle } from "./derive-title.js";
import { mockRecord } from "./record.js";

/**
 * Display title for a sidebar session row. Prefers the real generated title
 * (SessionMetadata.title, from the title sidecar). Falls back to the legacy
 * derived placeholder ("Untitled" / mock "today-1") when a session has no
 * generated title yet.
 */
export function sessionDisplayTitle(session: SessionMetadata): string {
  if (session.title !== undefined && session.title !== "") return session.title;
  return deriveTitle(session.sessionId === "today-1" ? mockRecord : []);
}
