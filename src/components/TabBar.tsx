import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Reorder, type PanInfo } from 'framer-motion';
import { useWorkspace, workspace, findLeaf, getActiveSession, type Tab } from '../state/workspace';
import { openFolderInEditor } from '../lib/actions';
import { uiBus } from '../lib/uiBus';

interface TabBarProps {
  paneId: string;
  sessionId: string;
  /** Whether this tabbar's pane sits at the leftmost / rightmost edge
   *  of the pane tree. The leftmost tabbar gets the "show sidebar"
   *  reveal button (when sidebar is hidden); the rightmost gets the
   *  "show outline" button (when outline is hidden). */
  edges?: { left: boolean; right: boolean };
}

export function TabBar({ paneId, sessionId, edges = { left: true, right: true } }: TabBarProps) {
  const allTabs = useWorkspace((s) => s.tabs);
  const leaf = useWorkspace((s) => {
    const session = s.sessions.find((x) => x.id === sessionId);
    return session ? findLeaf(session.root, paneId) : null;
  });
  // Sidebar / outline visibility — drives the toggle buttons' tooltips
  // (the icon stays the same; only the title flips between Show/Hide).
  // Buttons are always rendered on the outer-edge tab bars regardless
  // of state so they sit at exactly the same pixel position whether
  // the panel is open or closed — no visual shift on toggle.
  const sidebarVisible = useWorkspace((s) => getActiveSession(s).sidebarVisible);
  const outlineVisible = useWorkspace((s) => getActiveSession(s).outlineVisible);
  const tabs = useMemo(() => {
    if (!leaf) return [];
    const map = new Map(allTabs.map((t) => [t.id, t]));
    return leaf.tabIds.map((id) => map.get(id)).filter((t): t is Tab => !!t);
  }, [leaf, allTabs]);
  const activeTabId = leaf?.activeTabId ?? null;
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onMouse = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest('.ctx-menu')) return;
      setMenu(null);
    };
    const onKey = () => setMenu(null);
    document.addEventListener('mousedown', onMouse, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onMouse, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  // Local copy of the tabs array that framer's <Reorder.Group> drives
  // during a drag — sibling tabs slide aside as the cursor crosses each
  // tab's midpoint. We only commit the reorder back to the workspace
  // store on dragEnd, so framer's animation runs uninterrupted by
  // store updates mid-drag. localTabs re-syncs from the store whenever
  // the source-of-truth order actually changes (close, open, etc.).
  const [localTabs, setLocalTabs] = useState(tabs);
  const draggingRef = useRef(false);
  // Free-floating cursor-attached ghost rendered via portal so it can
  // visually leave the source `.tabbar` (which has overflow:hidden) and
  // float over neighboring panes. Framer's Reorder.Item itself stays
  // constrained to its group; this ghost is what the user actually
  // sees following their cursor across panes.
  const [ghost, setGhost] = useState<
    | {
        tab: Tab;
        x: number;
        y: number;
        width: number;
        height: number;
      }
    | null
  >(null);
  useEffect(() => {
    if (draggingRef.current) return;
    // Re-sync on every workspace change (renames, dirty toggles,
    // viewMode flips, etc.) — not just structural id/length diffs,
    // which silently dropped non-order updates and made tab renames
    // appear to revert. Drag state still gates the sync so framer's
    // animation isn't clobbered mid-drag.
    setLocalTabs(tabs);
  }, [tabs]);

  /** Ref to the outer .tabbar — used by the ResizeObserver below to
   *  watch every tab's measured width and tag narrow ones. */
  const tabbarRef = useRef<HTMLDivElement | null>(null);

  /** When tabs are squeezed by a full strip, the close button steals
   *  room from the title and looks crowded. Toggle a `tab--narrow`
   *  class on each tab whose width drops below ~140px (enough for
   *  icon + a meaningful title slice + X) so the X hides via CSS.
   *  CSS container queries can't be used because `container-type:
   *  inline-size` strips the tab's content-based intrinsic width and
   *  the flex layout collapses. We observe each tab individually
   *  because the tabbar's own size often doesn't change when tabs are
   *  added/removed — only the per-tab flex share does. */
  useEffect(() => {
    const root = tabbarRef.current;
    if (!root) return;
    const NARROW_THRESHOLD = 84;
    const apply = (el: HTMLElement) => {
      if (el.classList.contains('tab--pinned')) return;
      el.classList.toggle('tab--narrow', el.offsetWidth < NARROW_THRESHOLD);
    };
    const tabsEls = Array.from(root.querySelectorAll<HTMLElement>('.tab'));
    tabsEls.forEach(apply);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) apply(entry.target as HTMLElement);
    });
    tabsEls.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [localTabs.length]);

  const handleReorder = (next: Tab[]) => {
    // Pinned partition: pinned tabs always live to the left. As the
    // user drags, framer proposes orders that may violate this; we
    // re-partition locally so the visual state always satisfies it
    // (a non-pinned drag dropped at index 0 lands right after the
    // last pinned tab, etc.).
    const pinned = next.filter((t) => t.pinned);
    const rest = next.filter((t) => !t.pinned);
    setLocalTabs([...pinned, ...rest]);
  };

  /** elementFromPoint(x,y) → the .tabbar element under the cursor at
   *  drag end (could be this strip or another). Used for cross-strip
   *  drop routing. */
  const stripUnderPoint = (x: number, y: number): HTMLElement | null => {
    const el = document.elementFromPoint(x, y);
    return (el as HTMLElement | null)?.closest('[data-tabbar-pane-id]') as HTMLElement | null;
  };

  const handleDragStart = (tab: Tab) => (e: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) => {
    draggingRef.current = true;
    // Snapshot the source tab's rendered size so the ghost matches —
    // tabs vary in width based on title length.
    const target = e.target as HTMLElement | null;
    const tabEl = target?.closest('.tab') as HTMLElement | null;
    const r = tabEl?.getBoundingClientRect();
    if (r) {
      setGhost({
        tab,
        x: info.point.x,
        y: info.point.y,
        width: r.width,
        height: r.height,
      });
    }
  };

  const handleDrag = (_e: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) => {
    setGhost((g) => (g ? { ...g, x: info.point.x, y: info.point.y } : g));
  };

  const handleDragEnd = (tab: Tab) => (_e: PointerEvent, info: PanInfo) => {
    draggingRef.current = false;
    setGhost(null);
    const targetStrip = stripUnderPoint(info.point.x, info.point.y);
    const targetPaneId = targetStrip?.getAttribute('data-tabbar-pane-id') ?? null;
    const fromIdx = tabs.findIndex((t) => t.id === tab.id);

    // Cross-strip drop: dispatch moveTab to the other pane. The drop
    // index is computed from the cursor's x position relative to the
    // tabs in the target strip's reorder container.
    if (targetPaneId && targetPaneId !== paneId) {
      const reorderContainer = targetStrip?.querySelector('[data-tabbar-reorder]');
      let toIdx = 0;
      if (reorderContainer) {
        const tabEls = Array.from(
          reorderContainer.querySelectorAll<HTMLElement>('.tab'),
        );
        for (const el of tabEls) {
          const r = el.getBoundingClientRect();
          if (info.point.x < r.left + r.width / 2) break;
          toIdx++;
        }
      }
      // Don't reset localTabs — let the layout-animation flow handle
      // the visual transit. moveTab triggers a workspace re-render
      // that unmounts this tab from the source Reorder.Group; the
      // shared layoutId tells framer to animate from the dragged
      // position into the target Reorder.Group's new slot.
      if (fromIdx >= 0) workspace.moveTab(paneId, fromIdx, targetPaneId, toIdx);
      return;
    }

    // Intra-strip: commit localTabs's order back to the store. Find
    // the first index where localTabs and tabs disagree — that's the
    // drop position; the moved tab id tells us where it came from.
    const newIds = localTabs.map((t) => t.id);
    const oldIds = tabs.map((t) => t.id);
    for (let i = 0; i < oldIds.length; i++) {
      if (oldIds[i] !== newIds[i]) {
        const movedId = newIds[i];
        const sourceIdx = oldIds.indexOf(movedId);
        if (sourceIdx >= 0 && sourceIdx !== i) {
          workspace.reorderTabInLeaf(paneId, sourceIdx, i);
        }
        return;
      }
    }
  };

  // Render an empty bar with just the `+` button when the leaf has no tabs,
  // so the pane stays visually anchored and the user always has a way to
  // add a new tab (the WelcomeScreen below also has shortcuts).
  if (tabs.length === 0) {
    // Empty tabbars are still valid drop targets — `data-tabbar-pane-id`
    // lets the framer-driven cross-strip drop detect this strip via
    // elementFromPoint when the user releases over it.
    return (
      <div className="tabbar tabbar--empty" data-tabbar-pane-id={paneId}>
        {edges.left && <SidebarToggle visible={sidebarVisible} />}
        <button
          className="tab-new"
          onClick={() => uiBus.emit('open-path')}
          aria-label="New tab"
        >
          +
        </button>
        <SplitButtons paneId={paneId} />
        {edges.right && <OutlineToggle visible={outlineVisible} />}
      </div>
    );
  }

  const closeWithDirtyCheck = (toClose: Tab[]) => {
    const dirty = toClose.filter((t) => t.dirty);
    if (dirty.length > 0) {
      const msg =
        dirty.length === 1
          ? `"${dirty[0].title}" has unsaved changes. Close anyway?`
          : `${dirty.length} tabs have unsaved changes. Close anyway?`;
      if (!window.confirm(msg)) return;
    }
    workspace.closeTabsInLeaf(paneId, toClose.map((t) => t.id));
  };

  return (
    <div className="tabbar" data-tabbar-pane-id={paneId} ref={tabbarRef}>
      {edges.left && <SidebarToggle visible={sidebarVisible} />}
      <Reorder.Group
        as="div"
        axis="x"
        values={localTabs}
        onReorder={handleReorder}
        data-tabbar-reorder=""
        // The group is its own flex row that holds just the tabs, sitting
        // inside the larger .tabbar flex strip alongside the toggles and
        // the `+` button. flex:1 lets it consume available width so the
        // OutlineToggle's margin-left:auto still pushes to the far right.
        className="tabbar-reorder"
      >
        {localTabs.map((tab) => {
          const active = tab.id === activeTabId;
          // Renaming uses an inline <input> — disable drag while the
          // user is typing so cursor moves don't initiate a drag.
          const dragDisabled = renamingId === tab.id;
          return (
            <Reorder.Item
              as="div"
              key={tab.id}
              value={tab}
              // Shared layoutId pairs this tab with itself across all
              // panes so a cross-pane drop animates the tab from its
              // source slot to its destination slot via the LayoutGroup
              // wrapper in App.tsx — instead of unmount-then-pop.
              layoutId={`tab-${tab.id}`}
              drag={dragDisabled ? false : 'x'}
              onDragStart={handleDragStart(tab)}
              onDrag={handleDrag}
              onDragEnd={handleDragEnd(tab)}
              // While this tab is the one being dragged, fade its
              // in-strip rendering so the user perceives it as "lifted
              // out" — the portaled ghost is the real visual now.
              animate={{ opacity: ghost?.tab.id === tab.id ? 0.25 : 1 }}
              // The flat layout in our existing CSS is built around
              // tabs being plain divs; framer's default <li> wrapping
              // would change that, so we render as a div and rely on
              // the parent flex.
              className={
                `tab tab--${tab.kind} ${active ? 'tab--active' : ''}` +
                (tab.pinned ? ' tab--pinned' : '')
              }
              onClick={() => {
                if (renamingId === tab.id) return;
                workspace.setActiveTab(tab.id);
                workspace.requestEditorFocus();
              }}
              onDoubleClick={(e) => {
                // Match the workspace strip's rename UX: double-click
                // the tab to inline-edit its title.
                e.stopPropagation();
                setRenamingId(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                workspace.setActiveTab(tab.id);
                setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeWithDirtyCheck([tab]);
                }
              }}
              title={tab.filePath ?? tab.title}
              // Spring tuned for snappy reorder — feels faster than
              // framer's default which is too soft for tab strips.
              transition={{ type: 'spring', stiffness: 600, damping: 38, mass: 0.6 }}
              whileDrag={{ cursor: 'grabbing' }}
            >
              <span className={`tab-icon tab-icon--${tab.kind}`} aria-hidden>
                <KindIcon tab={tab} />
              </span>
              {renamingId === tab.id ? (
                <TabRenameInput
                  initial={tab.title}
                  onCommit={(name) => {
                    const trimmed = name.trim();
                    workspace.renameTab(tab.id, name);
                    // Mirror the rename into localTabs synchronously —
                    // the post-render useEffect would normally handle
                    // this, but framer's <Reorder.Group> seems to
                    // suppress the secondary re-render in some cases,
                    // making the rename appear stale until another
                    // workspace event (open tab, switch focus, etc.)
                    // forces another render.
                    if (trimmed) {
                      setLocalTabs((prev) =>
                        prev.map((t) => (t.id === tab.id ? { ...t, title: trimmed } : t)),
                      );
                    }
                    setRenamingId(null);
                  }}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <span className="tab-title">{tab.title}</span>
              )}
              {tab.kind === 'markdown' && tab.viewMode === 'raw' && (
                <span className="tab-mode-badge" title="Raw markdown (⌘⇧M cycles)">RAW</span>
              )}
              {tab.kind === 'markdown' && tab.viewMode === 'split' && (
                <span className="tab-mode-badge" title="Split markdown (⌘⇧M cycles)">SPLIT</span>
              )}
              {tab.dirty && <span className="tab-dirty" aria-label="unsaved" />}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeWithDirtyCheck([tab]);
                }}
                onPointerDown={(e) => {
                  // Stop the close button from initiating framer's
                  // drag — clicks on × should close, not pick up.
                  e.stopPropagation();
                }}
                aria-label="Close tab"
              >
                ×
              </button>
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
      <button className="tab-new" onClick={() => uiBus.emit('open-path')} aria-label="New tab">
        +
      </button>
      <SplitButtons paneId={paneId} />
      {edges.right && <OutlineToggle visible={outlineVisible} />}

      {menu && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          tab={tabs.find((t) => t.id === menu.tabId)!}
          allTabs={tabs}
          onClose={() => setMenu(null)}
          onCloseTab={(t) => closeWithDirtyCheck([t])}
          // "Close Other" and "Close to Right" never close pinned tabs —
          // matches Chrome's pinned-tab behavior.
          onCloseOthers={(t) =>
            closeWithDirtyCheck(tabs.filter((x) => x.id !== t.id && !x.pinned))
          }
          onCloseToRight={(t) => {
            const idx = tabs.findIndex((x) => x.id === t.id);
            closeWithDirtyCheck(tabs.slice(idx + 1).filter((x) => !x.pinned));
          }}
          onCloseAll={() => closeWithDirtyCheck(tabs.filter((x) => !x.pinned))}
          onTogglePin={(t) => workspace.togglePinTab(t.id)}
          onOpenParentFolder={(t) => {
            // Strip the final segment from the absolute path; fall back
            // to "/" if we'd otherwise produce an empty string (file at
            // root level).
            if (!t.filePath) return;
            const parent = t.filePath.replace(/\/[^/]+\/?$/, '') || '/';
            void openFolderInEditor(parent, { focus: true });
          }}
        />
      )}

      {/* Portaled drag ghost — renders at body level so it can fly
        * across panes without being clipped by the source `.tabbar`'s
        * overflow. Only the source TabBar of the active drag renders
        * its own ghost. */}
      {ghost &&
        createPortal(
          <div
            className={`tab tab--${ghost.tab.kind} tab-drag-ghost`}
            style={{
              position: 'fixed',
              left: ghost.x,
              top: ghost.y,
              width: ghost.width,
              height: ghost.height,
              transform: 'translate(-50%, -50%) scale(1.04)',
              pointerEvents: 'none',
              zIndex: 9999,
              boxShadow:
                '0 12px 32px color-mix(in srgb, var(--text) 26%, transparent)',
            }}
          >
            <span className={`tab-icon tab-icon--${ghost.tab.kind}`} aria-hidden>
              <KindIcon tab={ghost.tab} />
            </span>
            <span className="tab-title">{ghost.tab.title}</span>
            {ghost.tab.dirty && <span className="tab-dirty" aria-label="unsaved" />}
          </div>,
          document.body,
        )}
    </div>
  );
}

function KindIcon({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case 'folder':
      return <FolderGlyph />;
    case 'web':
      return <WebFavicon url={tab.filePath} stored={tab.favicon} />;
    case 'markdown':
      return <MarkdownGlyph />;
    case 'image':
      return <ImageGlyph />;
    case 'media':
      return <MediaGlyph />;
    case 'pdf':
      return <PdfGlyph />;
    case 'csv':
      return <TableGlyph />;
    case 'json':
      return <JsonGlyph />;
    case 'diff':
      return <DiffGlyph />;
    case 'binary':
      return <BinaryGlyph />;
    case 'terminal':
      return <TerminalGlyph />;
    case 'process':
      return <ProcessGlyph />;
    case 'git':
      return <GitGlyph />;
    case 'excalidraw':
      return <DrawGlyph />;
    case 'chat':
      return <ChatGlyph />;
    case 'search':
      return <SearchGlyph />;
    case 'http':
      return <HttpGlyph />;
    case 'clipboard':
      return <ClipboardGlyph />;
    case 'settings':
      return <SettingsGlyph />;
    case 'sqlite':
      return <SqliteGlyph />;
    case 'shortcuts':
      return <ShortcutsTabGlyph />;
    case 'music':
      return <MusicGlyph />;
    case 'later':
      return <BookmarkTabGlyph />;
    case 'agent':
      return <AgentGlyph />;
    case 'code':
    default:
      return <CodeGlyph />;
  }
}

function AgentGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      {/* Chat bubble with a sparkle inside — reads as "AI agent". */}
      <path
        d="M2.5 3 a1 1 0 0 1 1 -1 h9 a1 1 0 0 1 1 1 v6.5 a1 1 0 0 1 -1 1 h-5.5 l-2.5 2.5 v-2.5 h-1 a1 1 0 0 1 -1 -1 z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 4.5 l0.6 1.4 l1.4 0.6 l-1.4 0.6 l-0.6 1.4 l-0.6 -1.4 l-1.4 -0.6 l1.4 -0.6 z"
        fill="currentColor"
      />
    </svg>
  );
}

function BookmarkTabGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <path
        d="M3.5 2 a0.5 0.5 0 0 1 0.5 -0.5 h8 a0.5 0.5 0 0 1 0.5 0.5 v12 l-4.5 -2.8 l-4.5 2.8 z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MusicGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      {/* Eighth-note: stem with a beam, two filled note heads. Reads as
        * "music" at every size and is visually distinct from the code
        * file glyph (which has a file outline + chevrons inside). */}
      <path
        d="M6 11 V3 L13 2 V10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="4.6" cy="11.2" rx="2" ry="1.4" fill="currentColor" />
      <ellipse cx="11.6" cy="10.2" rx="2" ry="1.4" fill="currentColor" />
    </svg>
  );
}

function ShortcutsTabGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <rect x="2" y="4" width="12" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 6.6 L4.5 6.7 M7 6.6 L7 6.7 M9.5 6.6 L9.5 6.7 M12 6.6 L12 6.7 M5 9.4 H11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Renders a site favicon for web tabs. Prefers the page-declared
 *  icon URL (captured by WebView from `page-favicon-updated`) since
 *  that picks up real <link rel="icon"> entries with proper sizing.
 *  Falls back to the host's `/favicon.ico` for tabs that haven't
 *  loaded yet, and finally to the globe glyph if both fail or the
 *  filePath isn't an http(s) URL. */
function WebFavicon({ url, stored }: { url: string | null; stored: string | undefined }) {
  const [erroredStored, setErroredStored] = useState(false);
  const [erroredFallback, setErroredFallback] = useState(false);
  let host: string | null = null;
  let origin: string | null = null;
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        host = u.hostname;
        origin = u.origin;
      }
    } catch {
      // ignore — non-URL filePath, fall through to globe
    }
  }
  // Reset error state when the source changes — a different host or a
  // newly-captured stored icon should get a retry.
  useEffect(() => {
    setErroredStored(false);
  }, [stored]);
  useEffect(() => {
    setErroredFallback(false);
  }, [origin]);

  // 1) Page-declared icon: best quality, takes priority while loadable.
  if (stored && !erroredStored) {
    return (
      <img
        className="tab-favicon"
        src={stored}
        alt=""
        width={14}
        height={14}
        loading="lazy"
        decoding="async"
        onError={() => setErroredStored(true)}
      />
    );
  }
  // 2) Bare /favicon.ico probe — works for the brief window before
  //    page-favicon-updated fires, and for sites that don't declare one.
  if (origin && host && !erroredFallback) {
    return (
      <img
        className="tab-favicon"
        src={`${origin}/favicon.ico`}
        alt=""
        width={14}
        height={14}
        loading="lazy"
        decoding="async"
        onError={() => setErroredFallback(true)}
      />
    );
  }
  // 3) Globe glyph fallback.
  return <GlobeGlyph />;
}

function SqliteGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <ellipse cx="8" cy="3.6" rx="5" ry="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 3.6 V8 a5 1.6 0 0 0 10 0 V3.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 8 V12.4 a5 1.6 0 0 0 10 0 V8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function SettingsGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.6 L8 3.4 M8 12.6 L8 14.4 M14.4 8 L12.6 8 M3.4 8 L1.6 8 M12.5 3.5 L11.2 4.8 M4.8 11.2 L3.5 12.5 M12.5 12.5 L11.2 11.2 M4.8 4.8 L3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ClipboardGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <rect x="3.5" y="3" width="9" height="11" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="6" y="1.6" width="4" height="2.6" rx="0.6" stroke="currentColor" strokeWidth="1.2" fill="currentColor" fillOpacity="0.15" />
      <path d="M5.5 8 H10.5 M5.5 10.5 H9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function TerminalGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 6.5 L7 8 L4.5 9.5 M8.5 10 H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TableGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <FileBase />
      <path d="M4 8 H12 M4 11 H12 M8 5 V13" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function JsonGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <FileBase />
      <path
        d="M6.5 6 q-1 0 -1 1 v1 q0 0.6 -0.6 0.6 q0.6 0 0.6 0.6 v1 q0 1 1 1 M9.5 6 q1 0 1 1 v1 q0 0.6 0.6 0.6 q-0.6 0 -0.6 0.6 v1 q0 1 -1 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DiffGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <path d="M3 4 H7 M5 2 V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9 11 H13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3 9 L13 9" stroke="currentColor" strokeWidth="0.8" strokeDasharray="2 1.5" opacity="0.6" />
    </svg>
  );
}

function PdfGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <FileBase />
      <text
        x="8"
        y="11.6"
        textAnchor="middle"
        fontSize="4"
        fontWeight="700"
        fontFamily="-apple-system, sans-serif"
        fill="currentColor"
      >
        PDF
      </text>
    </svg>
  );
}

function MediaGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <FileBase />
      <path d="M6 8 L11 5 L11 11 Z" fill="currentColor" />
    </svg>
  );
}

function ProcessGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <path d="M2 12 L5 8 L8 10 L11 5 L14 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HttpGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <path d="M2 5 L8 5 L8 11 L14 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 8 L14 11 L11 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 10 L13.5 13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ChatGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <path
        d="M2 4 a1 1 0 0 1 1 -1 h10 a1 1 0 0 1 1 1 v6 a1 1 0 0 1 -1 1 h-7 l-3 2.5 v-2.5 h-0 a1 1 0 0 1 -1 -1 z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="7" r="0.9" fill="currentColor" />
      <circle cx="8.5" cy="7" r="0.9" fill="currentColor" />
      <circle cx="11" cy="7" r="0.9" fill="currentColor" />
    </svg>
  );
}

function DrawGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <path
        d="M3 13 L3 11 L10.5 3.5 L12.5 5.5 L5 13 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M9.5 4.5 L11.5 6.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function GitGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <circle cx="4" cy="3" r="1.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="13" r="1.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="3" r="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 4.4 V11.6 M4 6 q0 4 8 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <path
        d="M2 4 a1 1 0 0 1 1 -1 h3.5 l1.5 1.5 h5 a1 1 0 0 1 1 1 v6 a1 1 0 0 1 -1 1 h-10 a1 1 0 0 1 -1 -1 z"
        fill="currentColor"
      />
    </svg>
  );
}

function GlobeGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 8 h12 M8 2 c-3 4 -3 8 0 12 M8 2 c3 4 3 8 0 12" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FileBase() {
  return (
    <path
      d="M3 2 h7 l3 3 v9 a0.5 0.5 0 0 1 -0.5 0.5 h-9.5 a0.5 0.5 0 0 1 -0.5 -0.5 v-11.5 a0.5 0.5 0 0 1 0.5 -0.5 z M10 2 v3 h3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  );
}

function MarkdownGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <FileBase />
      <text
        x="8"
        y="11.6"
        textAnchor="middle"
        fontSize="4.5"
        fontWeight="700"
        fontFamily="-apple-system, sans-serif"
        fill="currentColor"
      >
        MD
      </text>
    </svg>
  );
}

function CodeGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <FileBase />
      <path
        d="M6.4 8.5 L4.8 10.1 L6.4 11.7 M9.6 8.5 L11.2 10.1 L9.6 11.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ImageGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <FileBase />
      <circle cx="6" cy="9.5" r="0.9" fill="currentColor" />
      <path
        d="M3.6 13 L6.5 10.5 L8.5 12 L11 9.6 L13 11.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BinaryGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <FileBase />
      <text
        x="8"
        y="12.2"
        textAnchor="middle"
        fontSize="4.2"
        fontFamily="ui-monospace, Menlo, monospace"
        fill="currentColor"
      >
        01
      </text>
    </svg>
  );
}

function TabContextMenu({
  x,
  y,
  tab,
  allTabs,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onTogglePin,
  onOpenParentFolder,
}: {
  x: number;
  y: number;
  tab: Tab;
  allTabs: Tab[];
  onClose: () => void;
  onCloseTab: (t: Tab) => void;
  onCloseOthers: (t: Tab) => void;
  onCloseToRight: (t: Tab) => void;
  onCloseAll: () => void;
  onTogglePin: (t: Tab) => void;
  onOpenParentFolder: (t: Tab) => void;
}) {
  const wrap = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const idx = allTabs.findIndex((t) => t.id === tab.id);
  const hasRight = idx >= 0 && idx < allTabs.length - 1;
  const hasOthers = allTabs.length > 1;
  const isFolder = tab.kind === 'folder';

  return (
    <div
      className="ctx-menu"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className="ctx-menu-item" onClick={wrap(() => onTogglePin(tab))}>
        {tab.pinned ? 'Unpin Tab' : 'Pin Tab'}
      </button>
      <div className="ctx-menu-sep" />
      <button className="ctx-menu-item" onClick={wrap(() => onCloseTab(tab))}>
        Close <span className="ctx-menu-kbd">⌘W</span>
      </button>
      <button
        className="ctx-menu-item"
        onClick={wrap(() => onCloseOthers(tab))}
        disabled={!hasOthers}
        style={!hasOthers ? { opacity: 0.4, cursor: 'default' } : undefined}
      >
        Close Other Tabs
      </button>
      <button
        className="ctx-menu-item"
        onClick={wrap(() => onCloseToRight(tab))}
        disabled={!hasRight}
        style={!hasRight ? { opacity: 0.4, cursor: 'default' } : undefined}
      >
        Close Tabs to the Right
      </button>
      <button className="ctx-menu-item" onClick={wrap(onCloseAll)}>
        Close All Tabs
      </button>

      {tab.filePath && (
        <>
          <div className="ctx-menu-sep" />
          <button
            className="ctx-menu-item"
            onClick={wrap(() => void navigator.clipboard.writeText(tab.filePath!))}
          >
            Copy Path
          </button>
          <button
            className="ctx-menu-item"
            onClick={wrap(() => void window.milu.revealInFinder(tab.filePath!))}
          >
            Reveal in Finder
          </button>
          {!isFolder && (
            <button
              className="ctx-menu-item"
              onClick={wrap(() => onOpenParentFolder(tab))}
            >
              Open Parent Folder
            </button>
          )}
          {isFolder && (
            <button
              className="ctx-menu-item"
              onClick={wrap(() => workspace.setRootDir(tab.filePath!))}
            >
              Open as Workspace
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Sidebar toggle — sits at the leftmost edge of the leftmost pane's
 *  tab bar. Always rendered (regardless of whether the sidebar is
 *  open or closed) so the button stays at exactly the same pixel
 *  position across toggles. Only the icon's "filled" tint changes so
 *  the user can tell at a glance whether the panel is currently open. */
function SidebarToggle({ visible }: { visible: boolean }) {
  return (
    <button
      className="tabbar-edge-btn"
      onClick={() => workspace.toggleSidebar()}
      title={`${visible ? 'Hide' : 'Show'} sidebar · ⌘E`}
      aria-label={visible ? 'Hide sidebar' : 'Show sidebar'}
    >
      <PanelIcon side="left" filled={visible} />
    </button>
  );
}

/** Pair of split buttons: side-by-side and top-bottom. Clicking
 *  either focuses this pane (so splitFocused acts on the right leaf,
 *  not whichever happened to be focused) and then dispatches the
 *  split. The icons match VS Code's convention — two columns for a
 *  side-by-side split, two rows for a top-bottom split. */
function SplitButtons({ paneId }: { paneId: string }) {
  const split = (direction: 'horizontal' | 'vertical') => {
    workspace.setFocusedPane(paneId);
    workspace.splitFocused(direction);
  };
  return (
    <>
      <button
        className="tabbar-edge-btn"
        onClick={() => split('horizontal')}
        title="Split right"
        aria-label="Split right"
      >
        <SplitIcon orientation="vertical" />
      </button>
      <button
        className="tabbar-edge-btn"
        onClick={() => split('vertical')}
        title="Split down"
        aria-label="Split down"
      >
        <SplitIcon orientation="horizontal" />
      </button>
    </>
  );
}

/** Rounded rectangle with a divider line. `orientation='vertical'`
 *  means the divider is vertical → two columns (= side-by-side
 *  split); `orientation='horizontal'` means a horizontal divider →
 *  two rows (= top-bottom split). */
function SplitIcon({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden fill="none">
      <rect x="2" y="3.5" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.4" />
      {orientation === 'vertical' ? (
        <line x1="8" y1="3.5" x2="8" y2="12.5" stroke="currentColor" strokeWidth="1.4" />
      ) : (
        <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.4" />
      )}
    </svg>
  );
}

/** Outline toggle — rightmost edge of the rightmost pane's tab bar.
 *  Same always-rendered pattern as the sidebar toggle. The
 *  margin-left:auto push ensures it anchors to the right edge of the
 *  bar past the tabs and the `+` button. */
function OutlineToggle({ visible }: { visible: boolean }) {
  return (
    <button
      className="tabbar-edge-btn tabbar-edge-btn--push-right"
      onClick={() => workspace.toggleOutline()}
      title={`${visible ? 'Hide' : 'Show'} outline · ⌘⇧\\`}
      aria-label={visible ? 'Hide outline' : 'Show outline'}
    >
      <PanelIcon side="right" filled={visible} />
    </button>
  );
}

/** Same pictogram as IconSidebarPanel in Sidebar.tsx: a rounded
 *  rectangle with a thin column on the indicated side. `filled`
 *  fills that column so users can read the toggle's current state at
 *  a glance — filled = panel currently visible. */
function PanelIcon({ side, filled }: { side: 'left' | 'right'; filled?: boolean }) {
  const barX = side === 'left' ? 2.6 : 10;
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden fill="none">
      <rect x="2" y="3.5" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <rect
        x={barX}
        y="4.1"
        width="3.4"
        height="7.8"
        rx="1.4"
        fill={filled ? 'currentColor' : 'none'}
        opacity={filled ? 0.35 : 1}
        stroke={filled ? undefined : 'currentColor'}
        strokeWidth={filled ? undefined : 1}
      />
    </svg>
  );
}

/** Inline rename field for a file tab. Mirrors SessionStrip's
 *  RenameInput — autoselects the existing title on mount, commits on
 *  Enter or blur, cancels on Escape. */
function TabRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={initial}
      className="tab-rename"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit((e.target as HTMLInputElement).value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={(e) => onCommit(e.target.value)}
    />
  );
}
