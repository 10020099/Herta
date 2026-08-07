import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { HertaBridge } from "../renderer/ipc/bridge-types.js";
import { CMD, EVT } from "./channels.js";

function subscribe<T>(channel: string, cb: (e: T) => void): () => void {
  const handler = (_evt: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const bridge: HertaBridge = {
  platform: process.platform,
  submitText: (text) => ipcRenderer.invoke(CMD.submitText, text),
  interrupt: (turnId) => ipcRenderer.invoke(CMD.interrupt, turnId),
  rewindLastTurn: (sessionId) =>
    ipcRenderer.invoke(CMD.rewindLastTurn, sessionId),
  maybePlayEasterEgg: () => ipcRenderer.invoke(CMD.maybePlayEasterEgg),
  listSessions: () => ipcRenderer.invoke(CMD.list),
  searchSessions: (query) => ipcRenderer.invoke(CMD.search, query),
  recordSlice: (sessionId, before, count) =>
    ipcRenderer.invoke(CMD.recordSlice, sessionId, before, count),
  openSession: (id) => ipcRenderer.invoke(CMD.open, id),
  createSession: (opts) => ipcRenderer.invoke(CMD.create, opts),
  deleteSession: (id) => ipcRenderer.invoke(CMD.deleteSession, id),
  resolveApproval: (opts) => ipcRenderer.invoke(CMD.resolveApproval, opts),
  listCommandRules: () => ipcRenderer.invoke(CMD.listCommandRules),
  removeCommandRule: (display) =>
    ipcRenderer.invoke(CMD.removeCommandRule, display),
  resyncRecord: () => ipcRenderer.invoke(CMD.resyncRecord),
  checkForUpdate: () => ipcRenderer.invoke(CMD.updateCheck),
  restartAndInstall: () => ipcRenderer.invoke(CMD.updateRestart),
  getUpdateState: () => ipcRenderer.invoke(CMD.updateStatus),
  getAppVersion: () => ipcRenderer.invoke(CMD.appVersion),
  onUpdate: (cb) => subscribe(EVT.update, cb),
  pickWorkspace: () => ipcRenderer.invoke(CMD.pickWorkspace),
  setWorkspace: (sessionId, path) =>
    ipcRenderer.invoke(CMD.setWorkspace, sessionId, path),
  resetWorkspace: (sessionId) =>
    ipcRenderer.invoke(CMD.resetWorkspace, sessionId),
  getDreamConfig: () => ipcRenderer.invoke(CMD.getDreamConfig),
  setDreamConfig: (cfg) => ipcRenderer.invoke(CMD.setDreamConfig, cfg),
  getBackendConfig: () => ipcRenderer.invoke(CMD.getBackendConfig),
  setBackendConfig: (cfg) => ipcRenderer.invoke(CMD.setBackendConfig, cfg),
  getLocale: () => ipcRenderer.invoke(CMD.getLocale),
  setLocale: (locale) => ipcRenderer.invoke(CMD.setLocale, locale),
  getInteractionLanguage: () => ipcRenderer.invoke(CMD.getInteractionLanguage),
  setInteractionLanguage: (choice) =>
    ipcRenderer.invoke(CMD.setInteractionLanguage, choice),
  getCloseToTray: () => ipcRenderer.invoke(CMD.getCloseToTray),
  setCloseToTray: (enabled) => ipcRenderer.invoke(CMD.setCloseToTray, enabled),
  getAutoUpdate: () => ipcRenderer.invoke(CMD.getAutoUpdate),
  setAutoUpdate: (enabled) => ipcRenderer.invoke(CMD.setAutoUpdate, enabled),
  getTheme: () => ipcRenderer.invoke(CMD.getTheme),
  setTheme: (theme) => ipcRenderer.invoke(CMD.setTheme, theme),
  getDeepSeekKeyStatus: () => ipcRenderer.invoke(CMD.getDeepSeekKeyStatus),
  setDeepSeekKey: (key) => ipcRenderer.invoke(CMD.setDeepSeekKey, key),
  clearDeepSeekKey: () => ipcRenderer.invoke(CMD.clearDeepSeekKey),
  windowMinimize: () => ipcRenderer.send(CMD.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.send(CMD.windowToggleMaximize),
  windowClose: () => ipcRenderer.send(CMD.windowClose),
  windowIsMaximized: () => ipcRenderer.invoke(CMD.windowIsMaximized),
  onWindowMaximized: (cb) => subscribe(EVT.windowMaximized, cb),
  onWorkspace: (cb) => subscribe(EVT.workspace, cb),
  onRecord: (cb) => subscribe(EVT.record, cb),
  onOverlay: (cb) => subscribe(EVT.overlay, cb),
  onSpeech: (cb) => subscribe(EVT.speech, cb),
  onAgent: (cb) => subscribe(EVT.agent, cb),
  onTurn: (cb) => subscribe(EVT.turn, cb),
  onReset: (cb) => subscribe(EVT.reset, cb),
  onTitle: (cb) => subscribe(EVT.title, cb),
  onSessionDeleted: (cb) => subscribe(EVT.sessionDeleted, cb),
  onNavBlocked: (cb) => subscribe(EVT.navBlocked, cb),
  onVoice: (cb) => subscribe(EVT.voice, cb),
};

contextBridge.exposeInMainWorld("herta", bridge);
