import { useEffect, useMemo, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { ProjectRuleFile } from "../../ipc/bridge-types.js";

function nextRuleName(files: readonly ProjectRuleFile[]): string {
  const names = new Set(files.map((file) => file.name));
  if (!names.has("rules.md")) return "rules.md";
  let suffix = 1;
  while (names.has(`rules${suffix}.md`)) suffix += 1;
  return `rules${suffix}.md`;
}

/**
 * Workspace-scoped `.herta/rules*.md` editor. The running agents re-read the
 * files before each request, so a successful save applies to the next turn
 * without restarting the session.
 */
export function ProjectRulesSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const supported =
    bridge.listProjectRules !== undefined &&
    bridge.saveProjectRule !== undefined &&
    bridge.deleteProjectRule !== undefined;
  const [files, setFiles] = useState<ProjectRuleFile[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [loading, setLoading] = useState(supported);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void bridge.listProjectRules?.().then(
      (loaded) => {
        if (!alive) return;
        setFiles([...loaded]);
        setSelectedName(loaded[0]?.name ?? null);
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

  const selected = useMemo(
    () => files.find((file) => file.name === selectedName) ?? null,
    [files, selectedName],
  );

  const createRule = (): void => {
    const name = nextRuleName(files);
    setFiles((current) => [...current, { name, content: "" }]);
    setSelectedName(name);
    setSaved(false);
    setError(null);
  };

  const updateContent = (content: string): void => {
    if (selected === null) return;
    setFiles((current) =>
      current.map((file) =>
        file.name === selected.name ? { ...file, content } : file,
      ),
    );
    setSaved(false);
    setError(null);
  };

  const save = (): void => {
    if (selected === null || bridge.saveProjectRule === undefined) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    void bridge.saveProjectRule(selected.name, selected.content).then(
      (result) => {
        setSaving(false);
        if (result.ok) setSaved(true);
        else setError(result.message ?? t("rules.saveFailed"));
      },
      () => {
        setSaving(false);
        setError(t("rules.saveFailed"));
      },
    );
  };

  const remove = (): void => {
    if (selected === null || bridge.deleteProjectRule === undefined) return;
    const name = selected.name;
    setSaving(true);
    setSaved(false);
    setError(null);
    void bridge.deleteProjectRule(name).then(
      (result) => {
        setSaving(false);
        if (!result.ok) {
          setError(result.message ?? t("rules.deleteFailed"));
          return;
        }
        setFiles((current) => {
          const next = current.filter((file) => file.name !== name);
          setSelectedName(next[0]?.name ?? null);
          return next;
        });
      },
      () => {
        setSaving(false);
        setError(t("rules.deleteFailed"));
      },
    );
  };

  if (!supported) {
    return (
      <>
        <p className="settings-intro">{t("rules.intro")}</p>
        <p className="settings-note">{t("rules.unavailable")}</p>
      </>
    );
  }

  return (
    <section className="mcp-settings" aria-busy={loading}>
      <p className="settings-intro">{t("rules.intro")}</p>
      <p className="mcp-settings-note">{t("rules.scopeNote")}</p>
      {loading && <p className="settings-note">{t("rules.loading")}</p>}
      {!loading && loadFailed && (
        <p className="settings-note is-error">{t("settings.loadFailed")}</p>
      )}
      {!loading && !loadFailed && (
        <>
          <div className="mcp-server-card">
            <div className="mcp-server-card-head">
              <span className="mcp-server-index">{t("rules.files")}</span>
              <button
                className="settings-key-save"
                type="button"
                onClick={createRule}
              >
                {t("rules.add")}
              </button>
            </div>
            {files.length === 0 ? (
              <p className="mcp-empty">{t("rules.empty")}</p>
            ) : (
              <ul className="rules-file-list">
                {files.map((file) => (
                  <li key={file.name}>
                    <button
                      className={`rules-file-item${file.name === selectedName ? " is-active" : ""}`}
                      type="button"
                      onClick={() => {
                        setSelectedName(file.name);
                        setSaved(false);
                        setError(null);
                      }}
                    >
                      {file.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {selected !== null && (
            <div className="mcp-server-card">
              <div className="mcp-server-card-head">
                <span className="mcp-server-index">{selected.name}</span>
                <button
                  className="settings-key-delete"
                  type="button"
                  onClick={remove}
                  disabled={saving}
                >
                  {t("rules.delete")}
                </button>
              </div>
              <div className="settings-field">
                <label
                  className="settings-field-label"
                  htmlFor="project-rule-content"
                >
                  {t("rules.content")}
                </label>
                <p className="settings-field-desc">{t("rules.contentDesc")}</p>
                <textarea
                  id="project-rule-content"
                  className="mcp-textarea"
                  value={selected.content}
                  onChange={(event) => updateContent(event.target.value)}
                  rows={12}
                  spellCheck={false}
                />
              </div>
              <div className="mcp-actions">
                <button
                  className="settings-key-save"
                  type="button"
                  onClick={save}
                  disabled={saving}
                >
                  {saving ? t("rules.saving") : t("rules.save")}
                </button>
                {saved && (
                  <span className="mcp-save-ok">{t("rules.saved")}</span>
                )}
              </div>
              {error !== null && (
                <p className="settings-note is-error">{error}</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
