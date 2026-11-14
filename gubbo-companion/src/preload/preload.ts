// The only bridge between the pages and the main process. Channels are allow-listed here and every
// payload is validated again in main. No Node APIs, file paths or secrets are exposed to the page.
import { contextBridge, ipcRenderer } from 'electron';

const INVOKE = new Set([
  'app:status', 'app:info', 'app:quit', 'settings:get', 'settings:set', 'hotkey:set', 'external:open', 'panel:show', 'panel:ready',
  'avatar:move', 'avatar:moved', 'avatar:click', 'avatar:menu', 'avatar:talk',
  'skin:get', 'skin:import', 'skin:model', 'skin:remove',
  'key:set', 'key:clear', 'models:list', 'budget:status', 'budget:verify', 'budget:resolve',
  'chat:conversations', 'chat:messages', 'chat:delete', 'chat:clear', 'chat:cancel', 'chat:send',
  'voice:state', 'voice:transcribe', 'whisper:status', 'whisper:download', 'whisper:cancel',
  'yt:status', 'yt:setClient', 'yt:connect', 'yt:cancelConnect', 'yt:confirmChannel', 'yt:disconnect', 'yt:refresh', 'yt:briefing',
  'videos:list', 'video:get', 'video:create', 'video:update', 'video:delete', 'docs:list', 'doc:get', 'doc:save', 'doc:revert', 'doc:delete',
  'memory:list', 'memory:add', 'memory:update', 'memory:delete', 'source:add', 'source:delete', 'search', 'activity',
  'undo:list', 'undo:do', 'braindump:preview', 'braindump:apply',
  'gubbo:list', 'gubbo:chooseFolder', 'gubbo:rescan', 'gubbo:disconnectFolder', 'gubbo:importFiles', 'gubbo:importPasted', 'gubbo:refreshImports', 'gubbo:remove', 'gubbo:later', 'gubbo:export',
  'backup:export', 'backup:restore',
]);
const EVENTS = new Set(['chat:event', 'avatar:state', 'voice:toggle', 'voice:cancel', 'settings:changed', 'skin:changed', 'nav', 'briefing:request', 'whisper:progress']);

contextBridge.exposeInMainWorld('gubbo', {
  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!INVOKE.has(channel)) throw new Error(`Channel not allowed: ${channel}`);
    const r = await ipcRenderer.invoke(channel, payload);
    if (!r || r.ok !== true) throw new Error(r?.error ?? 'Request failed.');
    return r.value;
  },
  on(channel: string, cb: (payload: unknown) => void): () => void {
    if (!EVENTS.has(channel)) throw new Error(`Event not allowed: ${channel}`);
    const fn = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
