import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useWorkspace,
  workspace,
  findLeaf,
  getActiveSession,
  subscribeWorkspace,
} from '../state/workspace';
import { normalizeUrl, openUrlInTab } from '../lib/actions';
import { settings, buildSearchUrl } from '../state/settings';
import { uiBus } from '../lib/uiBus';
import { useGlideCaret } from '../lib/useGlideCaret';
import { saveForLater, isYoutubeUrl } from '../lib/laterStore';
import {
  saveTrackToLibrary,
  parseVideoId,
  detectGenre,
} from '../lib/musicLibraryStore';

/** Type of the Electron `<webview>` element with the methods we use.
 *  React's typings don't model the custom element, so we cast through
 *  this shape. */
type WebviewEl = HTMLElement & {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(u: string): void;
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
};

/** Body-level overlay container that holds every web tab's <webview>.
 *  Reparenting an Electron <webview> between DOM nodes destroys the
 *  guest WebContents (page goes blank for ~1min while it re-attaches),
 *  so we never reparent. The webview is appended once into this
 *  container and absolutely-positioned to overlay whatever pane slot
 *  the React tree currently shows it in. Position is synced every
 *  animation frame from the slot's bounding rect.
 *
 *  z-index is low (1) so modals/palettes (z-index 999+) layer above. */
let webviewOverlay: HTMLDivElement | null = null;
function getWebviewOverlay(): HTMLDivElement {
  if (!webviewOverlay || !webviewOverlay.isConnected) {
    webviewOverlay = document.createElement('div');
    webviewOverlay.style.cssText =
      'position:fixed; top:0; left:0; width:0; height:0; pointer-events:none; z-index:1;';
    webviewOverlay.className = 'webview-overlay-root';
    document.body.appendChild(webviewOverlay);
  }
  return webviewOverlay;
}

/** Persistent <webview> element keyed by tabId — lives in the overlay
 *  container for the lifetime of the tab. Destroyed only when the tab
 *  itself is closed. */
const webviewSessions = new Map<string, WebviewEl>();
/** The currently-rendered React "slot" for each tab (the placeholder
 *  div inside the pane). Updated on mount; cleared on unmount. */
const slotByTab = new Map<string, HTMLElement>();
/** Per-tab position-sync loop. Started on first session creation and
 *  cancelled when the session is destroyed. Runs once per frame and
 *  is essentially free per tab (a getBoundingClientRect + a few style
 *  writes). */
const stopByTab = new Map<string, () => void>();

let webviewCleanupSubscribed = false;
function ensureWebviewCleanupSubscribed() {
  if (webviewCleanupSubscribed) return;
  webviewCleanupSubscribed = true;
  let tracked = new Set<string>();
  subscribeWorkspace(() => {
    const tabs = workspace.getState().tabs;
    const currentIds = new Set(
      tabs.filter((t) => t.kind === 'web').map((t) => t.id),
    );
    for (const id of tracked) {
      if (!currentIds.has(id)) destroyWebviewSession(id);
    }
    tracked = currentIds;
  });
}
function destroyWebviewSession(tabId: string) {
  stopByTab.get(tabId)?.();
  stopByTab.delete(tabId);
  slotByTab.delete(tabId);
  const el = webviewSessions.get(tabId);
  if (el) el.remove();
  webviewSessions.delete(tabId);
}
function startPositionLoop(tabId: string) {
  if (stopByTab.has(tabId)) return;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    const wv = webviewSessions.get(tabId);
    if (!wv) return;
    const slot = slotByTab.get(tabId);
    if (slot && slot.isConnected) {
      const r = slot.getBoundingClientRect();
      // A slot inside a `display:none` editor-host (inactive tab in
      // the same leaf) reports 0×0. Park the webview offscreen but
      // KEEP it visible — `display:none` on the webview itself would
      // pause Chromium and stop audio playback.
      if (r.width <= 0 || r.height <= 0) {
        wv.style.top = '-99999px';
        wv.style.left = '-99999px';
        wv.style.width = '800px';
        wv.style.height = '600px';
      } else {
        wv.style.top = `${r.top}px`;
        wv.style.left = `${r.left}px`;
        wv.style.width = `${r.width}px`;
        wv.style.height = `${r.height}px`;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  stopByTab.set(tabId, () => { cancelled = true; });
}
/** Strip the "Electron/..." token from the default UA so sites don't
 *  mistake us for an automated/headless client and downgrade hover-
 *  driven UI (e.g. nav fly-outs that only render when the page thinks
 *  it has a real desktop browser). Built lazily because navigator.user-
 *  Agent is only stable post-document-ready in some host setups. */
let cachedDesktopUA: string | null = null;
function desktopUserAgent(): string {
  if (cachedDesktopUA) return cachedDesktopUA;
  const raw = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  // Drop "Milu/x.y.z" and "Electron/x.y.z" tokens; collapse double spaces.
  cachedDesktopUA = raw
    .replace(/\s*Milu\/\S+/i, '')
    .replace(/\s*Electron\/\S+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cachedDesktopUA;
}

function getOrCreateWebviewElement(tabId: string, url: string): WebviewEl {
  const existing = webviewSessions.get(tabId);
  if (existing) return existing;
  const wv = document.createElement('webview') as WebviewEl;
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', 'true');
  wv.setAttribute('webpreferences', 'contextIsolation=yes');
  wv.setAttribute('useragent', desktopUserAgent());
  wv.className = 'webview-frame';
  // Absolute positioning inside the fixed overlay → free-floating
  // rectangle that we sync to the slot's bounding rect each frame.
  wv.style.cssText =
    'position:absolute; top:-99999px; left:-99999px; width:800px; height:600px; pointer-events:auto; background:white; border:0;';
  getWebviewOverlay().appendChild(wv);
  webviewSessions.set(tabId, wv);
  startPositionLoop(tabId);
  return wv;
}

interface Props {
  tabId: string;
  url: string;
}

export function WebView({ tabId, url }: Props) {
  const wvRef = useRef<WebviewEl | null>(null);
  const frameHostRef = useRef<HTMLDivElement | null>(null);

  const [addressBar, setAddressBar] = useState(url);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [pageFavicon, setPageFavicon] = useState<string | null>(null);
  // Visual confirmation when a save button is hit — flips the icon
  // for ~1.5s so the user sees feedback without a toast or modal.
  const [savedToLater, setSavedToLater] = useState(false);
  const [savedToMusic, setSavedToMusic] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatch, setFindMatch] = useState<{ ordinal: number; total: number } | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  /** True while a video / element inside the page is in HTML
   *  fullscreen. Drives the slot's `--fs` class so its bounds (and
   *  therefore the position-loop-driven webview) fill the entire
   *  window; we also tell the main process to take the BrowserWindow
   *  into native fullscreen so the menu bar / dock get out of the
   *  way on macOS. */
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** Right-click context-menu state — populated when the webview's
   *  `context-menu` event fires, with details about whatever the
   *  user clicked (link URL, selection text, image source, etc.). */
  const [contextMenu, setContextMenu] = useState<
    | {
        x: number;
        y: number;
        linkURL?: string;
        srcURL?: string;
        selectionText?: string;
        mediaType?: string;
      }
    | null
  >(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const { mirrorRef: addrMirrorRef, caretRef: addrCaretRef, bumpInput: addrBump, recompute: addrRecompute } =
    useGlideCaret(addressRef, addressBar);
  const isActive = useWorkspace((s) => {
    const session = getActiveSession(s);
    const focused = findLeaf(session.root, session.focusedLeafId);
    return focused?.activeTabId === tabId;
  });

  // Cmd+L: only the active web tab responds.
  useEffect(() => {
    if (!isActive) return;
    return uiBus.on('focus-address', () => {
      const el = addressRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
  }, [isActive]);

  // Cmd+R: refresh just this page, never the whole app. Only the active
  // web tab reacts; other tab kinds let the bus event fall on the floor.
  useEffect(() => {
    if (!isActive) return;
    return uiBus.on('reload-page', () => {
      try {
        wvRef.current?.reload();
      } catch {
        // webview not yet attached
      }
    });
  }, [isActive]);

  // Cmd+F — open the find-on-page bar. The actual focus happens in
  // the effect below once React has mounted the input; on first
  // open the input doesn't exist yet, so a same-tick `.focus()`
  // would no-op against a null ref.
  useEffect(() => {
    if (!isActive) return;
    return uiBus.on('find-on-page', () => setFindOpen(true));
  }, [isActive]);
  // Whenever the bar opens, focus + select the input. Runs after
  // mount, so even the first ⌘F press lands the cursor properly.
  useEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  // HTML-fullscreen handling. The webview tag dispatches these
  // events when a `<video>` (or any element) inside the page calls
  // requestFullscreen. Without handling them, the body-level
  // overlay positioning holds the webview at its slot size while
  // Chromium thinks the video is fullscreen — the page appears to
  // vanish. We toggle a CSS class on the slot so it takes the full
  // viewport. We deliberately do NOT touch the BrowserWindow:
  // calling setFullScreen in `accessory` activation policy makes the
  // window vanish (Space allocation fails), and even simpleFullScreen
  // collides with Electron's own auto-fullscreen path. Just letting
  // the slot fill the existing window is the only reliable path.
  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;
    const onEnter = () => setIsFullscreen(true);
    const onLeave = () => setIsFullscreen(false);
    wv.addEventListener('enter-html-full-screen', onEnter);
    wv.addEventListener('leave-html-full-screen', onLeave);
    return () => {
      wv.removeEventListener('enter-html-full-screen', onEnter);
      wv.removeEventListener('leave-html-full-screen', onLeave);
    };
  }, []);

  // Mirror the webview's `found-in-page` event into our match counter
  // so the bar can show "n / total".
  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;
    const onFound = (e: Event) => {
      const r = (e as unknown as { result: { activeMatchOrdinal: number; matches: number } }).result;
      if (!r) return;
      setFindMatch({ ordinal: r.activeMatchOrdinal, total: r.matches });
    };
    wv.addEventListener('found-in-page', onFound);
    return () => wv.removeEventListener('found-in-page', onFound);
  }, []);

  // Right-click context menu — intercept the webview's `context-menu`
  // event and render our own Milu-aware menu (Open in New Tab, Save
  // Link to Later, Search Selection, etc.) instead of letting the
  // guest show its default. Coordinates are page-relative; we add
  // the webview element's viewport offset before positioning.
  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;
    const onContextMenu = (e: Event) => {
      const params = (e as unknown as {
        params: {
          x: number;
          y: number;
          linkURL?: string;
          srcURL?: string;
          selectionText?: string;
          mediaType?: string;
        };
      }).params;
      if (!params) return;
      const r = (wv as HTMLElement).getBoundingClientRect();
      setContextMenu({
        x: r.left + params.x,
        y: r.top + params.y,
        linkURL: params.linkURL || undefined,
        srcURL: params.srcURL || undefined,
        selectionText: params.selectionText || undefined,
        mediaType: params.mediaType || undefined,
      });
    };
    wv.addEventListener('context-menu', onContextMenu);
    return () => wv.removeEventListener('context-menu', onContextMenu);
  }, []);
  // Close the context menu on outside click or any keypress.
  useEffect(() => {
    if (!contextMenu) return;
    const onMouse = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest('.webview-ctx-menu')) return;
      setContextMenu(null);
    };
    const onKey = () => setContextMenu(null);
    document.addEventListener('mousedown', onMouse, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onMouse, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [contextMenu]);

  // History navigation triggers — fire from any of three sources:
  //   1. MX-style mouse side buttons (button 3 / 4) outside the webview
  //   2. Cmd+[ / Cmd+] (macOS browser-history shortcut)
  //   3. The toolbar's chevron buttons (wired below in the JSX)
  // Most users with Logitech mice on macOS have the side buttons
  // mapped to Cmd+[ / Cmd+] by the Options+ driver, so the keyboard
  // path is the one that usually fires. The mouse-button path covers
  // people with raw button-3/4 mappings and clicks on the toolbar.
  useEffect(() => {
    if (!isActive) return;
    const navigate = (delta: -1 | 1) => {
      const wv = wvRef.current;
      if (!wv) return;
      try {
        if (delta < 0 && wv.canGoBack()) wv.goBack();
        else if (delta > 0 && wv.canGoForward()) wv.goForward();
      } catch {
        // webview detached
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      // Only the active web tab navigates — the isActive guard above
      // already restricts the listener to one component instance.
      e.preventDefault();
      navigate(e.button === 3 ? -1 : 1);
    };
    const onKey = (e: KeyboardEvent) => {
      // Cmd+[ / Cmd+] only — must be the modifier-only shortcut, not
      // Shift+Cmd+[ (used for tab cycling) or any other combo.
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      // Don't hijack the address bar's own field shortcuts — leaving
      // the keystroke alone there lets users navigate text selection
      // with arrow keys etc. without competing.
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (e.key === '[') {
        e.preventDefault();
        navigate(-1);
      } else if (e.key === ']') {
        e.preventDefault();
        navigate(1);
      }
    };
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('keydown', onKey);
    };
  }, [isActive]);

  // Register this slot as the position target for the tab's webview.
  // The actual <webview> lives in webviewSessions / overlay root, never
  // moves between DOM parents — a per-frame loop keeps it positioned
  // over our slot. This avoids Electron's "guest reload on reparent"
  // pain (page goes blank for ~1min when <webview> is removed and
  // re-added to the document).
  useEffect(() => {
    const slot = frameHostRef.current;
    if (!slot) return;
    ensureWebviewCleanupSubscribed();
    const wv = getOrCreateWebviewElement(tabId, url);
    slotByTab.set(tabId, slot);
    wvRef.current = wv;
    // Re-mount of an already-loaded webview: sync UI state from the
    // live element so the address bar / nav buttons aren't stale.
    try {
      const live = wv.getURL();
      if (live) {
        setCurrentUrl(live);
        setAddressBar(live);
        setCanBack(wv.canGoBack());
        setCanForward(wv.canGoForward());
        setLoading(false);
      }
    } catch {
      /* guest not yet attached */
    }
    return () => {
      // Only clear the slot if it's still ours — a remount may have
      // already swapped it. Don't stop the position loop or remove
      // the webview; the next mount picks up where we left off.
      if (slotByTab.get(tabId) === slot) slotByTab.delete(tabId);
      wvRef.current = null;
    };
  }, [tabId]);

  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;
    const sync = () => {
      try {
        setCanBack(wv.canGoBack());
        setCanForward(wv.canGoForward());
        const u = wv.getURL();
        setCurrentUrl(u);
        setAddressBar(u);
        // Persist the navigated URL back to the tab so a restart picks
        // up where the user left off, not where they started.
        const cur = workspace.getState().tabs.find((t) => t.id === tabId);
        if (cur && u && cur.filePath !== u) {
          workspace.setState((prev) => ({
            tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, filePath: u } : t)),
          }));
        }
      } catch {
        // webview not yet attached
      }
    };
    const onStart = () => setLoading(true);
    const onStop = () => {
      setLoading(false);
      sync();
    };
    const onTitle = (e: any) => setPageTitle(e.title);
    // Capture the page-declared favicon URL and stash it on the tab.
    // Pages emit this event for any <link rel="icon"> they ship; we
    // pick the first (most-relevant) entry. The TabBar reads tab.favicon
    // and prefers it over the blunt /favicon.ico probe.
    const onFavicon = (e: any) => {
      const urls: string[] | undefined = e?.favicons;
      const url = urls && urls.length > 0 ? urls[0] : null;
      if (!url) return;
      setPageFavicon(url);
      workspace.setState((prev) => ({
        tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, favicon: url } : t)),
      }));
    };
    const onMediaPlay = () => workspace.setTabPlaying(tabId, true);
    const onMediaPause = () => workspace.setTabPlaying(tabId, false);
    // The <webview> tag runs in its own process, so click events inside
    // it never bubble to the parent React tree — meaning Pane's
    // onMouseDown can't focus this leaf when the user clicks INTO the
    // webpage. Webview's 'focus' event fires whenever the embedded page
    // takes focus (clicks, tabs, programmatic focus), and that's the
    // hook we use to flip the focused leaf.
    const onFocus = () => workspace.setActiveTab(tabId);

    // Mouse-button history navigation. Mousedown events fire inside
    // the guest's Chromium process and never bubble to our renderer,
    // so the host-window listener can't see them. Inject a tiny
    // capturing listener into the guest itself that maps button 3/4
    // (raw MX side buttons) to history.back/forward. dom-ready fires
    // on every navigation, so the script is re-injected after each
    // page load; the __miluNavBound flag keeps it from double-
    // binding within a single document.
    const onDomReady = () => {
      void wv.executeJavaScript(`
        (function () {
          if (window.__miluNavBound) return;
          window.__miluNavBound = true;
          // Only fire on bare back/forward mouse-button presses. If
          // any modifier is held, bail — Logitech Options+ profiles
          // can synthesize both a keystroke (Cmd+Shift+[) and the
          // underlying button event for the same press, and we don't
          // want both "cycle tab" and "go back" firing at once.
          window.addEventListener('mousedown', function (e) {
            if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.button === 3) { e.preventDefault(); window.history.back(); }
            else if (e.button === 4) { e.preventDefault(); window.history.forward(); }
          }, true);
          window.addEventListener('auxclick', function (e) {
            if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.button === 3 || e.button === 4) e.preventDefault();
          }, true);
        })();
      `);
    };

    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-navigate', sync);
    wv.addEventListener('did-navigate-in-page', sync);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('page-favicon-updated', onFavicon);
    wv.addEventListener('media-started-playing', onMediaPlay);
    wv.addEventListener('media-paused', onMediaPause);
    wv.addEventListener('focus', onFocus);
    wv.addEventListener('dom-ready', onDomReady);
    return () => {
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-navigate', sync);
      wv.removeEventListener('did-navigate-in-page', sync);
      wv.removeEventListener('page-title-updated', onTitle);
      wv.removeEventListener('page-favicon-updated', onFavicon);
      wv.removeEventListener('media-started-playing', onMediaPlay);
      wv.removeEventListener('media-paused', onMediaPause);
      wv.removeEventListener('focus', onFocus);
      wv.removeEventListener('dom-ready', onDomReady);
      workspace.setTabPlaying(tabId, false);
    };
  }, [tabId]);

  // Sync the title back into the tab.
  useEffect(() => {
    if (!pageTitle) return;
    const cur = workspace.getState().tabs.find((t) => t.id === tabId);
    if (!cur || cur.title === pageTitle) return;
    workspace.setState((prev) => ({
      tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, title: pageTitle } : t)),
    }));
  }, [pageTitle, tabId]);

  /** Run / step a find-on-page search. The first call (or after the
   *  query changes) does a fresh search via `findNext: false`; arrow
   *  keys / next-prev buttons step through with `findNext: true`. */
  const runFind = (forward: boolean = true, fresh: boolean = false) => {
    const wv = wvRef.current;
    if (!wv || !findQuery) return;
    try {
      wv.findInPage(findQuery, { forward, findNext: !fresh });
    } catch {
      /* webview not ready */
    }
  };
  const closeFind = () => {
    setFindOpen(false);
    setFindMatch(null);
    try {
      wvRef.current?.stopFindInPage('clearSelection');
    } catch {
      /* ignore */
    }
  };

  /** Debounced live search — coalesces rapid keystrokes so
   *  Chromium's findInPage gets one settled query rather than a
   *  flurry that races against itself (rapid back-to-back calls
   *  cause the search to ignore later text). 50ms is short enough
   *  to feel instant while reliably letting the previous request
   *  resolve. We do NOT call stopFindInPage between calls — that
   *  drops the "active match" highlight (orange in Chrome) and
   *  leaves only the dim "all matches" yellow. */
  const findTimerRef = useRef<number | null>(null);
  const runLiveFind = (next: string) => {
    if (findTimerRef.current !== null) {
      window.clearTimeout(findTimerRef.current);
      findTimerRef.current = null;
    }
    if (!next) {
      setFindMatch(null);
      try {
        wvRef.current?.stopFindInPage('clearSelection');
      } catch {
        /* ignore */
      }
      return;
    }
    findTimerRef.current = window.setTimeout(() => {
      findTimerRef.current = null;
      try {
        wvRef.current?.findInPage(next);
      } catch {
        /* webview not ready */
      }
    }, 50);
  };

  /** Save the current page into ~/.milu/later.json so the user can
   *  read it from the Later tab later on. The bookmark icon flips to
   *  a check for ~1.5s as visual feedback. */
  const handleSaveLater = async () => {
    if (!currentUrl) return;
    await saveForLater({
      url: currentUrl,
      title: pageTitle ?? currentUrl,
      favicon: pageFavicon ?? undefined,
    });
    setSavedToLater(true);
    setTimeout(() => setSavedToLater(false), 1500);
  };

  /** Save a YouTube video into the music library — same flow as the
   *  Add Link modal in MusicView, just driven from the address bar.
   *  Fetches metadata for proper title / channel / live flag and
   *  guesses a genre from the description. */
  const handleSaveToMusic = async () => {
    const videoId = parseVideoId(currentUrl);
    if (!videoId) return;
    let title = pageTitle ?? '';
    let channel = '';
    let isLive = false;
    let genre: string | null = null;
    try {
      const meta = await window.milu.youtubeMetadata(videoId);
      if (meta.ok) {
        if (meta.title) title = meta.title;
        if (meta.channel) channel = meta.channel;
        isLive = meta.isLive;
        genre = detectGenre(`${meta.title}\n${meta.description}`);
      }
    } catch {
      /* metadata fetch failed — save with whatever we have */
    }
    await saveTrackToLibrary({
      videoId,
      title,
      channel,
      genre: genre ?? 'Other',
      isLive,
    });
    setSavedToMusic(true);
    setTimeout(() => setSavedToMusic(false), 1500);
  };

  const loadAddress = () => {
    const next = normalizeUrl(addressBar);
    wvRef.current?.loadURL(next);
  };

  return (
    <div className="webview-host">
      <div className="webview-toolbar">
        <button
          className="webview-btn"
          disabled={!canBack}
          onClick={() => wvRef.current?.goBack()}
          title="Back"
          aria-label="Back"
        >
          <Chev dir="left" />
        </button>
        <button
          className="webview-btn"
          disabled={!canForward}
          onClick={() => wvRef.current?.goForward()}
          title="Forward"
          aria-label="Forward"
        >
          <Chev dir="right" />
        </button>
        <button
          className="webview-btn"
          onClick={() => wvRef.current?.reload()}
          title="Reload"
          aria-label="Reload"
        >
          {loading ? '×' : '↻'}
        </button>
        <div className="webview-address-wrap">
          <input
            ref={addressRef}
            className="webview-address"
            value={addressBar}
            onChange={(e) => {
              addrBump();
              setAddressBar(e.target.value);
            }}
            onKeyDown={(e) => {
              addrBump();
              if (e.key === 'Enter') {
                e.preventDefault();
                loadAddress();
              }
            }}
            onKeyUp={addrRecompute}
            onClick={addrRecompute}
            spellCheck={false}
          />
          <span ref={addrMirrorRef} className="webview-address-mirror" aria-hidden />
          <div ref={addrCaretRef} className="webview-address-caret" aria-hidden />
        </div>
        {/* Music save — only on YouTube URLs. Hits the same metadata
          * fetch + genre detector the Add Link modal uses, so the
          * resulting library entry matches what the modal would
          * produce. */}
        {isYoutubeUrl(currentUrl) && (
          <button
            className={
              'webview-btn' + (savedToMusic ? ' webview-btn--saved' : '')
            }
            onClick={() => void handleSaveToMusic()}
            title={savedToMusic ? 'Saved to Music' : 'Save to Music'}
            aria-label="Save to Music"
          >
            {savedToMusic ? <CheckGlyph /> : <NoteGlyph />}
          </button>
        )}
        {/* Save for later — works on any web page. Reads the current
          * URL + title + favicon and writes to ~/.milu/later.json. */}
        <button
          className={
            'webview-btn' + (savedToLater ? ' webview-btn--saved' : '')
          }
          onClick={() => void handleSaveLater()}
          title={savedToLater ? 'Saved for later' : 'Save for later'}
          aria-label="Save for later"
        >
          {savedToLater ? <CheckGlyph /> : <BookmarkGlyph />}
        </button>
      </div>
      {/* Find-on-page bar — shows when ⌘F is hit. Live matches the
        * query against the page via the webview's findInPage API and
        * mirrors the result count back here. */}
      {findOpen && (
        <div className="webview-find">
          <input
            ref={findInputRef}
            className="webview-find-input"
            value={findQuery}
            onChange={(e) => {
              const next = e.target.value;
              setFindQuery(next);
              // Search synchronously on every keystroke — matches
              // Chrome's "live" find behaviour. Enter / Shift+Enter
              // step through results without re-running the search.
              runLiveFind(next);
            }}
            placeholder="Find on page"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                closeFind();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) runFind(false);
                else runFind(true);
              }
            }}
          />
          <span className="webview-find-count">
            {findQuery
              ? findMatch && findMatch.total > 0
                ? `${findMatch.ordinal}/${findMatch.total}`
                : '0/0'
              : ''}
          </span>
          <button
            className="webview-btn webview-find-btn"
            onClick={() => runFind(false)}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            disabled={!findQuery}
          >
            <Chev dir="up" />
          </button>
          <button
            className="webview-btn webview-find-btn"
            onClick={() => runFind(true)}
            title="Next match (Enter)"
            aria-label="Next match"
            disabled={!findQuery}
          >
            <Chev dir="down" />
          </button>
          <button
            className="webview-btn webview-find-btn"
            onClick={closeFind}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}
      {/* The actual <webview> lives in webviewSessions (module scope) and
          is appended into this host imperatively by the mount effect.
          Lifting it out of React's tree lets it survive component
          unmounts during pane splits without reloading. */}
      <div
        ref={frameHostRef}
        className={
          'webview-frame-host' + (isFullscreen ? ' webview-frame-host--fs' : '')
        }
      />
      <div className="webview-status">{currentUrl}</div>

      {/* Right-click context menu — rendered at body level via portal
        * so it sits above the webview overlay. */}
      {contextMenu &&
        createPortal(
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            linkURL={contextMenu.linkURL}
            srcURL={contextMenu.srcURL}
            selectionText={contextMenu.selectionText}
            mediaType={contextMenu.mediaType}
            onClose={() => setContextMenu(null)}
            onSaveLinkLater={async (u) => {
              await saveForLater({
                url: u,
                title: u,
              });
            }}
            onOpenLinkInTab={(u) => openUrlInTab(u)}
            onCopy={(text) => void navigator.clipboard.writeText(text)}
            onSearch={(q) => {
              const { url } = buildSearchUrl(settings.get(), q);
              openUrlInTab(url);
            }}
            onReload={() => wvRef.current?.reload()}
            onSavePageLater={async () => {
              await saveForLater({
                url: currentUrl,
                title: pageTitle ?? currentUrl,
                favicon: pageFavicon ?? undefined,
              });
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function ContextMenu({
  x,
  y,
  linkURL,
  srcURL,
  selectionText,
  mediaType,
  onClose,
  onSaveLinkLater,
  onOpenLinkInTab,
  onCopy,
  onSearch,
  onReload,
  onSavePageLater,
}: {
  x: number;
  y: number;
  linkURL?: string;
  srcURL?: string;
  selectionText?: string;
  mediaType?: string;
  onClose: () => void;
  onSaveLinkLater: (url: string) => Promise<void>;
  onOpenLinkInTab: (url: string) => void;
  onCopy: (text: string) => void;
  onSearch: (query: string) => void;
  onReload: () => void;
  onSavePageLater: () => Promise<void>;
}) {
  const wrap = (fn: () => void | Promise<void>) => () => {
    onClose();
    void fn();
  };
  const sel = selectionText?.trim() ?? '';
  const truncatedSel =
    sel.length > 28 ? `${sel.slice(0, 28).trim()}…` : sel;
  return (
    <div
      className="ctx-menu webview-ctx-menu"
      style={{ position: 'fixed', left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {linkURL && (
        <>
          <button
            className="ctx-menu-item"
            onClick={wrap(() => onOpenLinkInTab(linkURL))}
          >
            Open Link in New Tab
          </button>
          <button className="ctx-menu-item" onClick={wrap(() => onCopy(linkURL))}>
            Copy Link
          </button>
          <button
            className="ctx-menu-item"
            onClick={wrap(() => onSaveLinkLater(linkURL))}
          >
            Save Link to Later
          </button>
          <div className="ctx-menu-sep" />
        </>
      )}
      {srcURL && mediaType === 'image' && (
        <>
          <button className="ctx-menu-item" onClick={wrap(() => onCopy(srcURL))}>
            Copy Image URL
          </button>
          <button
            className="ctx-menu-item"
            onClick={wrap(() => onOpenLinkInTab(srcURL))}
          >
            Open Image in New Tab
          </button>
          <div className="ctx-menu-sep" />
        </>
      )}
      {sel && (
        <>
          <button className="ctx-menu-item" onClick={wrap(() => onCopy(sel))}>
            Copy
          </button>
          <button className="ctx-menu-item" onClick={wrap(() => onSearch(sel))}>
            Search “{truncatedSel}”
          </button>
          <div className="ctx-menu-sep" />
        </>
      )}
      <button className="ctx-menu-item" onClick={wrap(onSavePageLater)}>
        Save Page to Later
      </button>
      <button className="ctx-menu-item" onClick={wrap(onReload)}>
        Reload
      </button>
    </div>
  );
}

function Chev({ dir }: { dir: 'left' | 'right' | 'up' | 'down' }) {
  const path =
    dir === 'left'
      ? 'M10 3 L5 8 L10 13'
      : dir === 'right'
        ? 'M6 3 L11 8 L6 13'
        : dir === 'up'
          ? 'M3 10 L8 5 L13 10'
          : 'M3 6 L8 11 L13 6';
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BookmarkGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden fill="none">
      <path
        d="M4 2.5 a0.5 0.5 0 0 1 0.5 -0.5 h7 a0.5 0.5 0 0 1 0.5 0.5 v11 l-4 -2.5 l-4 2.5 z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NoteGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden fill="none">
      <path
        d="M6 11.5 V3 L13 2 V10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="4.4" cy="11.6" rx="1.8" ry="1.3" fill="currentColor" />
      <ellipse cx="11.4" cy="10.6" rx="1.8" ry="1.3" fill="currentColor" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden fill="none">
      <path
        d="M3 8.5 L6.5 12 L13 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
