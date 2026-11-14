const MODS = new Set(['Control', 'Ctrl', 'Alt', 'Shift', 'Super', 'CommandOrControl', 'CmdOrCtrl', 'AltGr']);
const KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|[`\-=\[\];',./\\]|num[0-9])$/;

/** Checks a global-shortcut string such as "Control+Alt+G": at least one modifier and exactly one key. */
export function validateAccelerator(acc: unknown): string {
  if (typeof acc !== 'string' || acc.length > 60) throw new Error('That shortcut is not valid.');
  const parts = acc.split('+').map((p) => p.trim()).filter(Boolean);
  const mods = parts.filter((p) => MODS.has(p));
  const keys = parts.filter((p) => !MODS.has(p));
  if (keys.length !== 1 || !KEY.test(keys[0])) throw new Error('A shortcut needs exactly one main key (a letter, number or function key).');
  if (mods.length === 0 && !/^F\d+$/.test(keys[0])) throw new Error('Add Ctrl, Alt or Shift so the shortcut does not fire while typing.');
  if (new Set(mods).size !== mods.length) throw new Error('A modifier is repeated.');
  if (keys[0] === 'Escape') throw new Error('Escape is reserved for cancelling.');
  return [...mods, keys[0]].join('+');
}

export const SUGGESTED_HOTKEYS = ['Control+Alt+G', 'Control+Shift+G', 'Control+Alt+Space', 'Alt+Shift+G', 'Control+Alt+B', 'F9'];
