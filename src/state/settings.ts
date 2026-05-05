import { useSyncExternalStore } from 'react';
import { applyEditorTheme, watchSystemTheme, type EditorTheme } from '../lib/editorTheme';
import { applyThemeToDom, getTheme, DEFAULT_LIGHT_ID, DEFAULT_DARK_ID } from '../lib/themes';

export type ThemeMode = 'system' | 'light' | 'dark';

export type EditorKeymap = 'default' | 'vim' | 'emacs';

export type FolderSortKey = 'name' | 'modified' | 'created' | 'size' | 'type';
export type SortDirection = 'asc' | 'desc';

export interface FolderSort {
  key: FolderSortKey;
  direction: SortDirection;
  foldersFirst: boolean;
}

export interface WorkspaceBookmark {
  name: string;
  path: string;
}

export type SearchEngineId = 'google' | 'duckduckgo' | 'kagi' | 'bing' | 'brave' | 'custom';

/** Built-in search engines. The `template` uses `{q}` as the (already
 *  url-encoded) query placeholder. `custom` is a user-defined template that
 *  lives separately in `customSearchUrl`. */
export const SEARCH_ENGINES: {
  id: Exclude<SearchEngineId, 'custom'>;
  name: string;
  template: string;
  host: string;
}[] = [
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q={q}', host: 'google.com' },
  { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={q}', host: 'duckduckgo.com' },
  { id: 'kagi', name: 'Kagi', template: 'https://kagi.com/search?q={q}', host: 'kagi.com' },
  { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q={q}', host: 'bing.com' },
  { id: 'brave', name: 'Brave Search', template: 'https://search.brave.com/search?q={q}', host: 'search.brave.com' },
];

/** Build the search URL for `query` using current settings. Falls back to
 *  Google if the user picked custom but didn't supply a template. */
export function buildSearchUrl(s: Settings, query: string): { url: string; host: string } {
  const encoded = encodeURIComponent(query);
  if (s.searchEngine === 'custom' && s.customSearchUrl.includes('{q}')) {
    const url = s.customSearchUrl.replace(/\{q\}/g, encoded);
    let host = 'custom';
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    return { url, host };
  }
  const id = s.searchEngine === 'custom' ? 'google' : s.searchEngine;
  const engine = SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0];
  return { url: engine.template.replace('{q}', encoded), host: engine.host };
}

export interface Settings {
  theme: ThemeMode;
  editorTheme: EditorTheme;
  /** Color theme id used when the app is in light mode. */
  lightThemeId: string;
  /** Color theme id used when the app is in dark mode. */
  darkThemeId: string;
  contentFont: string;
  uiFont: string;
  codeFont: string;
  fontSize: number;
  maxContentWidth: number; // 0 = no cap
  /** Modal keymap layered on top of the code editor's default bindings.
   *  'default' = no modal layer; 'vim' / 'emacs' wire the corresponding
   *  CodeMirror extension. Markdown editor is unaffected. */
  editorKeymap: EditorKeymap;
  folderSort: FolderSort;
  /** Icon size for the finder/folder grid, in px (square). */
  folderIconSize: number;
  showHiddenFiles: boolean;
  workspaceBookmarks: WorkspaceBookmark[];
  /** Most-recently-opened file paths, newest first. Capped at MAX_RECENT_FILES. */
  recentFiles: string[];
  /** Last-used timestamp per launcher-command keyword (e.g., "chat",
   *  "git"). Drives the ⌘T / launcher empty-query order so commands
   *  the user actually uses bubble to the top. The keyword is the
   *  command's canonical name (keywords[0]). */
  commandUsage: Record<string, number>;
  /** Most-recently-opened URLs (web tabs), newest first. Same cap. */
  recentUrls: string[];
  /** Search engine used by ⌘T's web-search fallback. */
  searchEngine: SearchEngineId;
  /** When `searchEngine === 'custom'`, the URL template (must contain `{q}`). */
  customSearchUrl: string;
  /** Global hotkey that wakes the launcher window. Electron accelerator
   *  syntax (Cmd+Alt+Space, Alt+Space, F12, …). */
  launcherHotkey: string;
  /** True once the user has dismissed the first-run onboarding tour.
   *  Drives the modal in `App.tsx` — fresh installs see it on first
   *  launch, existing users see it once after upgrading. */
  hasSeenOnboarding: boolean;
}

export const MAX_RECENT_FILES = 30;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  editorTheme: 'frame',
  lightThemeId: DEFAULT_LIGHT_ID,
  darkThemeId: DEFAULT_DARK_ID,
  contentFont: `'New York', 'Iowan Old Style', 'PT Serif', Georgia, serif`,
  uiFont: `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif`,
  codeFont: `'SF Mono', Menlo, Monaco, Consolas, monospace`,
  fontSize: 17,
  maxContentWidth: 0,
  editorKeymap: 'default',
  folderSort: { key: 'name', direction: 'asc', foldersFirst: true },
  folderIconSize: 72,
  showHiddenFiles: false,
  workspaceBookmarks: [],
  recentFiles: [],
  commandUsage: {},
  recentUrls: [],
  searchEngine: 'google',
  customSearchUrl: 'https://example.com/?q={q}',
  launcherHotkey: 'Cmd+Alt+Space',
  hasSeenOnboarding: false,
};

const LEGACY_STORAGE_KEY = 'milu:settings';

function load(): Settings {
  try {
    // Primary: file-backed blob from ~/.milu/settings.json (synchronously
    // read by preload at boot). Shared across dev and packaged builds.
    let raw =
      typeof window !== 'undefined' ? window.milu?.initialSettings ?? null : null;
    // Fallback: one-time migration from the old localStorage key. After
    // the next save, the file becomes the source of truth and the old
    // key gets cleared.
    if (!raw && typeof localStorage !== 'undefined') {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw && typeof window !== 'undefined' && window.milu?.settingsWrite) {
        void window.milu.settingsWrite(raw);
        try {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }
    }
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings> & { vimMode?: boolean };
    // Migrate legacy `vimMode: boolean` → `editorKeymap`. Users who had
    // vimMode enabled keep their modal editing; everyone else lands on
    // the new default of no modal layer.
    if (parsed.editorKeymap === undefined && typeof parsed.vimMode === 'boolean') {
      parsed.editorKeymap = parsed.vimMode ? 'vim' : 'default';
    }
    delete parsed.vimMode;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persist(settings: Settings) {
  // Write to ~/.milu/settings.json via main. Fire-and-forget — the
  // tmp+rename in main makes it safe against partial writes.
  try {
    if (typeof window !== 'undefined' && window.milu?.settingsWrite) {
      void window.milu.settingsWrite(JSON.stringify(settings));
    }
  } catch {
    /* main might not be ready, or non-Electron context */
  }
  // Push tray-relevant state to main so the menubar tray's submenus
  // stay current. Main can't read localStorage, so we send a minimal
  // snapshot. Guarded by typeof since the launcher window also imports
  // this module but doesn't need to push (main is fed by main window).
  try {
    if (typeof window !== 'undefined' && window.milu?.trayPushState) {
      window.milu.trayPushState({
        recentFiles: settings.recentFiles,
        bookmarks: settings.workspaceBookmarks.map((b) => ({ name: b.name, path: b.path })),
      });
    }
  } catch {
    // ignore — main might not be ready, or we're in a non-Electron context
  }
}

let state: Settings = load();
const listeners = new Set<() => void>();
// Push initial tray state once at boot so the tray menu shows recent
// files / bookmarks even if the user hasn't changed any settings yet.
// Wrapped in try because the launcher window also imports this module
// and may not have the milu bridge.
try {
  if (typeof window !== 'undefined' && window.milu?.trayPushState) {
    window.milu.trayPushState({
      recentFiles: state.recentFiles,
      bookmarks: state.workspaceBookmarks.map((b) => ({ name: b.name, path: b.path })),
    });
  }
} catch {
  // ignore
}

function effectiveDark(theme: ThemeMode): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function activeTheme(s: Settings) {
  const dark = effectiveDark(s.theme);
  const id = dark ? s.darkThemeId : s.lightThemeId;
  return getTheme(id) ?? getTheme(dark ? DEFAULT_DARK_ID : DEFAULT_LIGHT_ID)!;
}

function applyToDom(s: Settings) {
  const root = document.documentElement;
  if (s.theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', s.theme);
  }
  // Apply the picked color theme — overrides default light/dark CSS vars.
  applyThemeToDom(activeTheme(s));
  root.style.setProperty('--font-content', s.contentFont);
  root.style.setProperty('--font-ui', s.uiFont);
  root.style.setProperty('--font-mono', s.codeFont);
  root.style.setProperty('--editor-font-size', `${s.fontSize}px`);
  root.style.setProperty('--editor-max-width', s.maxContentWidth > 0 ? `${s.maxContentWidth}px` : 'none');
  root.style.setProperty('--folder-icon-size', `${s.folderIconSize}px`);
  applyEditorTheme(s.editorTheme, s.theme);
}

applyToDom(state);
watchSystemTheme(() => ({ appTheme: state.theme, editorTheme: state.editorTheme }));

/** Push the user's launcher hotkey to the main process. We re-send on
 *  every settings update — main re-registers the global shortcut if the
 *  value changed. The boot send happens here (right after initial load)
 *  so main can override its own default with the persisted value. */
function pushLauncherHotkey() {
  try {
    void window.milu.launcherSetHotkey?.(state.launcherHotkey);
  } catch {
    // window.milu may not be ready in some early-render edge cases.
  }
}
pushLauncherHotkey();

// Re-apply when system color scheme flips (so the right light/dark theme kicks in).
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.theme === 'system') applyToDom(state);
});

export const settings = {
  get(): Settings {
    return state;
  },

  update(patch: Partial<Settings>) {
    const prev = state;
    state = { ...state, ...patch };
    persist(state);
    applyToDom(state);
    if (state.launcherHotkey !== prev.launcherHotkey) {
      pushLauncherHotkey();
    }
    listeners.forEach((fn) => fn());
  },

  reset() {
    state = DEFAULT_SETTINGS;
    persist(state);
    applyToDom(state);
    listeners.forEach((fn) => fn());
  },

  /** Move `filePath` to the front of recentFiles (deduped, capped). */
  pushRecentFile(filePath: string) {
    if (!filePath) return;
    const next = [filePath, ...state.recentFiles.filter((p) => p !== filePath)].slice(
      0,
      MAX_RECENT_FILES,
    );
    state = { ...state, recentFiles: next };
    persist(state);
    listeners.forEach((fn) => fn());
  },

  /** Record that the user just ran a launcher command. The launcher
   *  reads commandUsage to bubble recently-used commands to the top
   *  on empty query (Spotlight/Raycast-style). */
  bumpCommandUsage(keyword: string) {
    if (!keyword) return;
    state = { ...state, commandUsage: { ...state.commandUsage, [keyword]: Date.now() } };
    persist(state);
    listeners.forEach((fn) => fn());
  },

  /** Move `url` to the front of recentUrls (deduped, capped). */
  pushRecentUrl(url: string) {
    if (!url) return;
    const next = [url, ...state.recentUrls.filter((u) => u !== url)].slice(
      0,
      MAX_RECENT_FILES,
    );
    state = { ...state, recentUrls: next };
    persist(state);
    listeners.forEach((fn) => fn());
  },

  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export function useSettings(): Settings {
  return useSyncExternalStore(
    settings.subscribe,
    () => state,
    () => state,
  );
}

/** Returns the currently-active theme (resolved against light/dark mode). */
export function useActiveTheme() {
  const s = useSettings();
  return activeTheme(s);
}
