import { useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type {
  McpConfig,
  McpServerConfig,
  McpTransport,
} from "../../ipc/bridge-types.js";

interface McpServerDraft {
  readonly id: number;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
}

function pairsToText(
  value: Readonly<Record<string, string>> | undefined,
): string {
  return value === undefined
    ? ""
    : Object.entries(value)
        .map(([key, item]) => `${key}=${item}`)
        .join("\n");
}

function draftFromConfig(
  id: number,
  name: string,
  config: McpServerConfig,
): McpServerDraft {
  if (config.transport === "sse" || config.transport === "streamable-http") {
    return {
      id,
      name,
      transport: config.transport,
      command: "",
      argsText: "",
      envText: "",
      url: config.url,
      headersText: pairsToText(config.headers),
    };
  }
  return {
    id,
    name,
    transport: "stdio",
    command: config.command,
    argsText: (config.args ?? []).join("\n"),
    envText: pairsToText(config.env),
    url: "",
    headersText: "",
  };
}

function emptyDraft(id: number): McpServerDraft {
  return {
    id,
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    envText: "",
    url: "",
    headersText: "",
  };
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Parse KEY=VALUE textareas. Values may themselves contain `=`. */
function parsePairs(value: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of lines(value)) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (separator <= 0 || key.length === 0) return null;
    out[key] = line.slice(separator + 1).trim();
  }
  return out;
}

function nonEmpty<T extends Record<string, string>>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

/** Turn UI drafts into the canonical, workspace-scoped persisted config. */
function toMcpConfig(drafts: readonly McpServerDraft[]): McpConfig | null {
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (name.length === 0 || Object.hasOwn(mcpServers, name)) return null;

    if (draft.transport === "stdio") {
      const command = draft.command.trim();
      const env = parsePairs(draft.envText);
      if (command.length === 0 || env === null) return null;
      const args = lines(draft.argsText);
      mcpServers[name] = {
        transport: "stdio",
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(nonEmpty(env) !== undefined ? { env } : {}),
      };
      continue;
    }

    const headers = parsePairs(draft.headersText);
    if (headers === null) return null;
    try {
      const url = new URL(draft.url.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    } catch {
      return null;
    }
    mcpServers[name] = {
      transport: draft.transport,
      url: draft.url.trim(),
      ...(nonEmpty(headers) !== undefined ? { headers } : {}),
    };
  }
  return { mcpServers };
}

/**
 * Workspace-scoped MCP service editor. Values are persisted only when Save is
 * pressed, so an incomplete new server never corrupts the active configuration.
 */
export function McpSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const supported =
    bridge.getMcpConfig !== undefined && bridge.setMcpConfig !== undefined;
  const nextId = useRef(1);
  const [servers, setServers] = useState<McpServerDraft[]>([]);
  const [loading, setLoading] = useState(supported);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void bridge.getMcpConfig?.().then(
      (config) => {
        if (!alive) return;
        setServers(
          Object.entries(config.mcpServers).map(([name, entry]) =>
            draftFromConfig(nextId.current++, name, entry),
          ),
        );
        setLoading(false);
      },
      () => {
        if (!alive) return;
        setLoadFailed(true);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge, supported]);

  const updateServer = (
    id: number,
    patch: Partial<Omit<McpServerDraft, "id">>,
  ): void => {
    setSaved(false);
    setInvalid(false);
    setSaveFailed(false);
    setServers((current) =>
      current.map((server) =>
        server.id === id ? { ...server, ...patch } : server,
      ),
    );
  };

  const addServer = (): void => {
    setSaved(false);
    setInvalid(false);
    setServers((current) => [...current, emptyDraft(nextId.current++)]);
  };

  const removeServer = (id: number): void => {
    setSaved(false);
    setInvalid(false);
    setServers((current) => current.filter((server) => server.id !== id));
  };

  const save = (): void => {
    const config = toMcpConfig(servers);
    if (config === null || bridge.setMcpConfig === undefined) {
      setInvalid(true);
      setSaved(false);
      return;
    }
    setSaving(true);
    setInvalid(false);
    setSaveFailed(false);
    setSaved(false);
    void bridge.setMcpConfig(config).then(
      () => {
        setSaving(false);
        setSaved(true);
      },
      () => {
        setSaving(false);
        setSaveFailed(true);
      },
    );
  };

  if (!supported) {
    return (
      <>
        <p className="settings-intro">{t("mcp.intro")}</p>
        <p className="settings-note">{t("mcp.unavailable")}</p>
      </>
    );
  }

  return (
    <section className="mcp-settings" aria-busy={loading}>
      <p className="settings-intro">{t("mcp.intro")}</p>
      <p className="mcp-settings-note">{t("mcp.scopeNote")}</p>

      {loading && <p className="settings-note">{t("mcp.loading")}</p>}
      {!loading && loadFailed && (
        <p className="settings-note is-error">{t("settings.loadFailed")}</p>
      )}

      {!loading && !loadFailed && servers.length === 0 && (
        <p className="mcp-empty">{t("mcp.empty")}</p>
      )}

      {!loading &&
        !loadFailed &&
        servers.map((server, index) => {
          const prefix = `mcp-server-${server.id}`;
          const remote = server.transport !== "stdio";
          return (
            <div className="mcp-server-card" key={server.id}>
              <div className="mcp-server-card-head">
                <span className="mcp-server-index">
                  {t("mcp.server").replace("{n}", String(index + 1))}
                </span>
                <button
                  className="settings-key-delete"
                  type="button"
                  onClick={() => removeServer(server.id)}
                  aria-label={t("mcp.removeAria").replace(
                    "{name}",
                    server.name || String(index + 1),
                  )}
                >
                  {t("mcp.remove")}
                </button>
              </div>

              <div className="mcp-field-grid">
                <div className="settings-field">
                  <label
                    className="settings-field-label"
                    htmlFor={`${prefix}-name`}
                  >
                    {t("mcp.name")}
                  </label>
                  <input
                    id={`${prefix}-name`}
                    className="settings-field-input"
                    type="text"
                    value={server.name}
                    onChange={(event) =>
                      updateServer(server.id, { name: event.target.value })
                    }
                    placeholder={t("mcp.namePlaceholder")}
                    autoComplete="off"
                  />
                </div>
                <div className="settings-field">
                  <label
                    className="settings-field-label"
                    htmlFor={`${prefix}-transport`}
                  >
                    {t("mcp.transport")}
                  </label>
                  <select
                    id={`${prefix}-transport`}
                    className="settings-field-select"
                    value={server.transport}
                    onChange={(event) =>
                      updateServer(server.id, {
                        transport: event.target.value as McpTransport,
                      })
                    }
                  >
                    <option value="stdio">{t("mcp.transport.stdio")}</option>
                    <option value="streamable-http">
                      {t("mcp.transport.http")}
                    </option>
                    <option value="sse">{t("mcp.transport.sse")}</option>
                  </select>
                </div>
              </div>

              {!remote ? (
                <>
                  <div className="settings-field">
                    <label
                      className="settings-field-label"
                      htmlFor={`${prefix}-command`}
                    >
                      {t("mcp.command")}
                    </label>
                    <input
                      id={`${prefix}-command`}
                      className="settings-field-input"
                      type="text"
                      value={server.command}
                      onChange={(event) =>
                        updateServer(server.id, { command: event.target.value })
                      }
                      placeholder={t("mcp.commandPlaceholder")}
                      autoComplete="off"
                    />
                  </div>
                  <div className="settings-field">
                    <label
                      className="settings-field-label"
                      htmlFor={`${prefix}-args`}
                    >
                      {t("mcp.args")}
                    </label>
                    <p className="settings-field-desc">{t("mcp.argsDesc")}</p>
                    <textarea
                      id={`${prefix}-args`}
                      className="mcp-textarea"
                      value={server.argsText}
                      onChange={(event) =>
                        updateServer(server.id, {
                          argsText: event.target.value,
                        })
                      }
                      placeholder={t("mcp.argsPlaceholder")}
                      rows={3}
                    />
                  </div>
                  <div className="settings-field">
                    <label
                      className="settings-field-label"
                      htmlFor={`${prefix}-env`}
                    >
                      {t("mcp.env")}
                    </label>
                    <p className="settings-field-desc">{t("mcp.envDesc")}</p>
                    <textarea
                      id={`${prefix}-env`}
                      className="mcp-textarea"
                      value={server.envText}
                      onChange={(event) =>
                        updateServer(server.id, { envText: event.target.value })
                      }
                      placeholder={t("mcp.envPlaceholder")}
                      rows={3}
                      spellCheck={false}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="settings-field">
                    <label
                      className="settings-field-label"
                      htmlFor={`${prefix}-url`}
                    >
                      {t("mcp.url")}
                    </label>
                    <input
                      id={`${prefix}-url`}
                      className="settings-field-input"
                      type="url"
                      value={server.url}
                      onChange={(event) =>
                        updateServer(server.id, { url: event.target.value })
                      }
                      placeholder={t("mcp.urlPlaceholder")}
                      autoComplete="url"
                    />
                  </div>
                  <div className="settings-field">
                    <label
                      className="settings-field-label"
                      htmlFor={`${prefix}-headers`}
                    >
                      {t("mcp.headers")}
                    </label>
                    <p className="settings-field-desc">
                      {t("mcp.headersDesc")}
                    </p>
                    <textarea
                      id={`${prefix}-headers`}
                      className="mcp-textarea"
                      value={server.headersText}
                      onChange={(event) =>
                        updateServer(server.id, {
                          headersText: event.target.value,
                        })
                      }
                      placeholder={t("mcp.headersPlaceholder")}
                      rows={3}
                      spellCheck={false}
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}

      {!loading && !loadFailed && (
        <div className="mcp-actions">
          <button className="settings-btn" type="button" onClick={addServer}>
            {t("mcp.add")}
          </button>
          <button
            className="settings-btn settings-btn--primary"
            type="button"
            onClick={save}
            disabled={saving}
          >
            {saving ? t("mcp.saving") : t("mcp.save")}
          </button>
        </div>
      )}

      {invalid && <p className="settings-note is-error">{t("mcp.invalid")}</p>}
      {saveFailed && (
        <p className="settings-note is-error">{t("common.couldntSave")}</p>
      )}
      {saved && <p className="mcp-saved">{t("mcp.saved")}</p>}
    </section>
  );
}
