import { useEffect, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useActiveSession } from "../../hooks/useActiveSession.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { ProviderStatus, ProviderType, ThinkingEffort } from "../../ipc/bridge-types.js";

const PROVIDER_TYPES: ProviderType[] = [
  "deepseek",
  "openai",
  "anthropic",
  "openai-compat",
];

const PROVIDER_DEFAULTS: Record<
  ProviderType,
  { baseUrl: string; actorModel: string; backendModel: string }
> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    actorModel: "deepseek-v4-pro",
    backendModel: "deepseek-v4-pro",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    actorModel: "o3",
    backendModel: "gpt-4o",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    actorModel: "claude-sonnet-5",
    backendModel: "claude-sonnet-5",
  },
  "openai-compat": {
    baseUrl: "",
    actorModel: "",
    backendModel: "",
  },
};

/**
 * Multi-provider settings panel. Replaces the old DeepSeek-only settings.
 * Lets the user:
 *   1. Select a provider type (DeepSeek / OpenAI / Anthropic / OpenAI-compatible)
 *   2. Enter API key
 *   3. Optionally configure base URL, model names, and thinking effort
 *   4. Set the active provider (which one the session uses)
 */
export function ProviderSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const { status: sessionStatus } = useActiveSession();
  const busy = sessionStatus !== "idle";

  // Active provider (which one the session uses)
  const [activeProvider, setActiveProvider] = useState<ProviderType>("deepseek");
  // Currently selected provider tab in the UI
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>("deepseek");
  // Provider statuses
  const [statuses, setStatuses] = useState<Record<ProviderType, ProviderStatus | null>>({
    deepseek: null,
    openai: null,
    anthropic: null,
    "openai-compat": null,
  });
  // Draft key input
  const [draftKey, setDraftKey] = useState("");
  // Draft base URL
  const [draftBaseUrl, setDraftBaseUrl] = useState("");
  // Draft actor model
  const [draftActorModel, setDraftActorModel] = useState("");
  // Draft backend model
  const [draftBackendModel, setDraftBackendModel] = useState("");
  // Draft thinking effort
  const [draftThinking, setDraftThinking] = useState<ThinkingEffort>("high");
  // Anthropic-specific: output effort (separate from thinking effort)
  const [draftAnthropicEffort, setDraftAnthropicEffort] = useState<ThinkingEffort>("medium");
  // Saving state
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);

  const locked = busy || saving;

  // Load statuses on mount
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const active = await bridge.getActiveProvider();
        if (alive) setActiveProvider(active);
      } catch {
        // ignore
      }
      const newStatuses: Record<ProviderType, ProviderStatus | null> = {
        deepseek: null,
        openai: null,
        anthropic: null,
        "openai-compat": null,
      };
      for (const type of PROVIDER_TYPES) {
        try {
          newStatuses[type] = await bridge.getProviderStatus(type);
        } catch {
          newStatuses[type] = null;
        }
      }
      if (alive) {
        setStatuses(newStatuses);
        setStatusFailed(false);
      }
    };
    load().catch(() => {
      if (alive) setStatusFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  // Reset drafts when switching selected provider
  useEffect(() => {
    const status = statuses[selectedProvider];
    if (status?.set) {
      setDraftKey("");
      setDraftBaseUrl("");
      setDraftActorModel("");
      setDraftBackendModel("");
      setDraftThinking("high");
      setDraftAnthropicEffort("medium");
    } else {
      const defaults = PROVIDER_DEFAULTS[selectedProvider];
      setDraftKey("");
      setDraftBaseUrl(defaults.baseUrl);
      setDraftActorModel(defaults.actorModel);
      setDraftBackendModel(defaults.backendModel);
      setDraftThinking("high");
      setDraftAnthropicEffort("medium");
    }
    setRejected(false);
    setUnverified(false);
    setFailed(false);
  }, [selectedProvider, statuses]);

  const onSave = async (): Promise<void> => {
    const key = draftKey.trim();
    if (key.length === 0 || locked) return;
    setSaving(true);
    setFailed(false);
    setRejected(false);
    setUnverified(false);
    try {
      await bridge.setProviderKey(selectedProvider, key, {
        baseUrl: draftBaseUrl.trim() || undefined,
        actorModel: draftActorModel.trim() || undefined,
        backendModel: draftBackendModel.trim() || undefined,
        thinking: draftThinking === "high" ? undefined : draftThinking,
        anthropicOutputEffort:
          selectedProvider === "anthropic" ? draftAnthropicEffort : undefined,
      });
      // Refresh status
      const newStatus = await bridge.getProviderStatus(selectedProvider);
      setStatuses((prev) => ({ ...prev, [selectedProvider]: newStatus }));
      setDraftKey("");
      setUnverified(false);
      // Auto-activate this provider
      await bridge.setActiveProvider(selectedProvider);
      setActiveProvider(selectedProvider);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (): Promise<void> => {
    if (locked) return;
    setSaving(true);
    setFailed(false);
    try {
      await bridge.clearProviderKey(selectedProvider);
      const newStatus = await bridge.getProviderStatus(selectedProvider);
      setStatuses((prev) => ({ ...prev, [selectedProvider]: newStatus }));
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const onActivate = async (type: ProviderType): Promise<void> => {
    try {
      await bridge.setActiveProvider(type);
      setActiveProvider(type);
    } catch {
      // ignore
    }
  };

  const status = statuses[selectedProvider];
  const isActive = activeProvider === selectedProvider;
  const defaults = PROVIDER_DEFAULTS[selectedProvider];
  const needsThinkingBudget = selectedProvider === "anthropic";

  return (
    <>
      <p className="settings-intro">{t("provider.intro")}</p>

      {/* Provider type selector tabs */}
      <div className="provider-tabs">
        {PROVIDER_TYPES.map((type) => {
          const s = statuses[type];
          const isConnected = s?.set;
          const isCurrent = activeProvider === type;
          return (
            <button
              key={type}
              type="button"
              className={`provider-tab${selectedProvider === type ? " is-active" : ""}${isCurrent ? " is-current" : ""}`}
              onClick={() => setSelectedProvider(type)}
              aria-current={selectedProvider === type}
            >
              <span className="provider-tab-label">
                {t(`provider.type.${type}`)}
              </span>
              {isConnected && (
                <span className="provider-tab-dot" aria-hidden="true" />
              )}
              {isCurrent && (
                <span className="provider-tab-badge">{t("provider.active")}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Key status */}
      <div className="settings-key-status">
        {status === null ? (
          <span className="settings-key-state is-muted">
            {statusFailed
              ? t("deepseek.statusFailed")
              : t("deepseek.checking")}
          </span>
        ) : status.set ? (
          <span className="settings-key-state is-connected">
            <span className="settings-key-dot" aria-hidden="true" />
            {t("provider.connected")} · …{status.hint}
          </span>
        ) : (
          <span className="settings-key-state is-muted">
            {t("provider.noKey")}
          </span>
        )}
      </div>

      {/* API Key input */}
      <div className="settings-key-form">
        <input
          type="password"
          className="settings-key-input"
          placeholder={
            status?.set
              ? t("provider.replaceKey")
              : `sk-${selectedProvider === "anthropic" ? "ant" : "…"}`
          }
          aria-label={t("provider.keyAria", { provider: t(`provider.type.${selectedProvider}`) })}
          autoComplete="off"
          spellCheck={false}
          value={draftKey}
          disabled={locked}
          onChange={(e) => {
            setDraftKey(e.target.value);
            setRejected(false);
            setUnverified(false);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void onSave();
            }
          }}
        />
        <button
          type="button"
          className="settings-key-save"
          disabled={draftKey.trim().length === 0 || locked}
          onClick={() => void onSave()}
        >
          {saving ? t("provider.verifying") : t("provider.save")}
        </button>
      </div>

      {/* Base URL (optional) */}
      <div className="settings-field">
        <label className="settings-field-label">{t("provider.baseUrl")}</label>
        <input
          type="text"
          className="settings-field-input"
          placeholder={defaults.baseUrl || "https://api.example.com/v1"}
          value={draftBaseUrl}
          disabled={locked}
          onChange={(e) => setDraftBaseUrl(e.target.value)}
        />
      </div>

      {/* Actor model (optional) */}
      <div className="settings-field">
        <label className="settings-field-label">{t("provider.actorModel")}</label>
        <input
          type="text"
          className="settings-field-input"
          placeholder={defaults.actorModel || "model-name"}
          value={draftActorModel}
          disabled={locked}
          onChange={(e) => setDraftActorModel(e.target.value)}
        />
      </div>

      {/* Backend model (optional) */}
      <div className="settings-field">
        <label className="settings-field-label">{t("provider.backendModel")}</label>
        <input
          type="text"
          className="settings-field-input"
          placeholder={defaults.backendModel || "model-name"}
          value={draftBackendModel}
          disabled={locked}
          onChange={(e) => setDraftBackendModel(e.target.value)}
        />
      </div>

      {/* Thinking effort */}
      <div className="settings-field">
        <label className="settings-field-label">{t("provider.thinking")}</label>
        <p className="settings-field-desc">{t("provider.thinkingDesc")}</p>
        <select
          className="settings-field-select"
          value={draftThinking}
          disabled={locked}
          onChange={(e) => setDraftThinking(e.target.value as ThinkingEffort)}
        >
          {(["none", "minimal", "low", "medium", "high", "xhigh", "max", "off"] as ThinkingEffort[]).map(
            (effort) => (
              <option key={effort} value={effort}>
                {t(`provider.thinking.${effort}`)}
              </option>
            ),
          )}
        </select>
      </div>

      {/* Anthropic-specific: output effort */}
      {needsThinkingBudget && (
        <div className="settings-field">
          <label className="settings-field-label">
            {t("provider.anthropicOutputEffort")}
          </label>
          <p className="settings-field-desc">
            {t("provider.anthropicOutputEffortDesc")}
          </p>
          <select
            className="settings-field-select"
            value={draftAnthropicEffort}
            disabled={locked}
            onChange={(e) =>
              setDraftAnthropicEffort(e.target.value as ThinkingEffort)
            }
          >
            {(["low", "medium", "high", "max"] as ThinkingEffort[]).map(
              (effort) => (
                <option key={effort} value={effort}>
                  {t(`provider.thinking.${effort}`)}
                </option>
              ),
            )}
          </select>
        </div>
      )}
      )}

      {/* Delete key button */}
      {status?.set && (
        <button
          type="button"
          className="settings-key-delete"
          disabled={locked}
          onClick={() => void onDelete()}
        >
          {saving ? t("provider.deleting") : t("provider.deleteKey")}
        </button>
      )}

      {/* Activate button (when this provider has a key but isn't active) */}
      {status?.set && !isActive && (
        <button
          type="button"
          className="settings-key-activate"
          disabled={locked}
          onClick={() => void onActivate(selectedProvider)}
        >
          {t("provider.active")} {t(`provider.type.${selectedProvider}`)}
        </button>
      )}

      {/* Status messages */}
      {rejected && (
        <p className="settings-note is-error">
          {t("provider.rejected", {
            provider: t(`provider.type.${selectedProvider}`),
          })}
        </p>
      )}
      {failed && <p className="settings-note">{t("common.couldntSave")}</p>}
      {busy && <p className="settings-note">{t("provider.busy")}</p>}
      {unverified && (
        <p className="settings-note">{t("provider.unverified")}</p>
      )}
      {status?.set && !status.encrypted && (
        <p className="settings-note">{t("provider.unencrypted")}</p>
      )}
    </>
  );
}