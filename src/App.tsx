import { useEffect, useState } from 'react';
import { LayoutGroup } from 'framer-motion';
import { useWorkspace, workspace, getActiveSession, getAllLeaves, findLeaf } from './state/workspace';
import { Sidebar } from './components/Sidebar';
import { PaneNode } from './components/PaneNode';
import { Outline } from './components/Outline';
import { FilePalette } from './components/FilePalette';
import { NewFilePicker } from './components/NewFilePicker';
import { Onboarding } from './components/Onboarding';
import { PathInput } from './components/PathInput';
import { SessionStrip } from './components/SessionStrip';
import { NowPlaying } from './components/NowPlaying';
import { saveActive, saveActiveAs, openFileViaDialog, openFolderViaDialog, closeActiveTab, openTerminalTab, openProcessTab, openSearchTab, openClipboardTab, openSettingsTab, openShortcutsTab, openUrlInTab, openFileFromPath, reopenLastClosedTab } from './lib/actions';
import { uiBus } from './lib/uiBus';
import { resetWorkspaceAndReload } from './lib/persistence';
import { runLauncherAction } from './lib/runLauncherAction';

// One modal at a time. Opening any modal automatically closes the others.
type Modal =
  | null
  | { kind: 'palette'; replace: boolean }
  | { kind: 'path'; replace: boolean }
  | { kind: 'newFile' };

/** Activate the Nth tab in the currently-focused leaf. `idx === -1` means
 *  the last tab. Out-of-range indexes silently no-op (Chrome behavior). */
function gotoTabInFocused(idx: number) {
  const leaf = workspace.getFocusedLeaf();
  if (!leaf || leaf.tabIds.length === 0) return;
  const target = idx < 0 ? leaf.tabIds[leaf.tabIds.length - 1] : leaf.tabIds[idx];
  if (!target) return;
  workspace.setActiveTab(target);
  workspace.requestEditorFocus();
}

export function App() {
  const sidebarVisible = useWorkspace((s) => getActiveSession(s).sidebarVisible);
  const outlineVisible = useWorkspace((s) => getActiveSession(s).outlineVisible);
  // True when the active session has a pane maximized to full window.
  // Suppresses sidebar, outline, and (via CSS) the in-pane tab bar.
  const zoomed = useWorkspace((s) => !!getActiveSession(s).maximizedLeafId);
  const rootDir = useWorkspace((s) => getActiveSession(s).rootDir);
  const sessions = useWorkspace((s) => s.sessions);
  const activeSessionId = useWorkspace((s) => s.activeSessionId);
  const [modal, setModal] = useState<Modal>(null);
  const close = () => setModal(null);

  useEffect(() => {
    if (rootDir != null) return;
    let cancelled = false;
    (async () => {
      // Try the last-opened workspace first; fall back to home dir if it's
      // gone or unreadable.
      let chosen: string | null = null;
      try {
        const saved = localStorage.getItem('milu:lastWorkspace');
        if (saved) {
          const st = await window.milu.stat(saved);
          if (st.exists && st.isDirectory) chosen = saved;
        }
      } catch {
        // ignore
      }
      if (!chosen) chosen = await window.milu.homeDir();
      if (!cancelled && getActiveSession().rootDir == null) {
        workspace.setRootDir(chosen);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootDir]);

  useEffect(() => {
    const offs = [
      // Launcher (global hotkey window) dispatches actions back here.
      window.milu.onLauncherRun((action) => {
        console.log('[milu] onLauncherRun fired with action:', action);
        void runLauncherAction(action as Parameters<typeof runLauncherAction>[0]);
      }),
      // New-tab links inside web tabs are forwarded from main — open
      // them as a Milu web tab in the active session.
      window.milu.onWebviewOpenUrl?.((url) => {
        console.log('[milu] webview:open-url received:', url);
        openUrlInTab(url);
      }) ?? (() => {}),
      // Tray menu → recent file / workspace bookmark click. Main
      // dispatches the path; we route through the standard
      // openFileFromPath which handles files OR folders correctly.
      window.milu.onTrayOpenPath?.((path) => {
        void openFileFromPath(path, { focus: true });
      }) ?? (() => {}),
      uiBus.on('open-palette', () => setModal({ kind: 'palette', replace: false })),
      uiBus.on('open-settings', () => openSettingsTab()),
      uiBus.on('open-process-viewer', () => openProcessTab()),
      uiBus.on('open-new-file', () => setModal({ kind: 'newFile' })),
      uiBus.on('open-path', () => setModal({ kind: 'path', replace: false })),
      uiBus.on('open-shortcuts', () => openShortcutsTab()),
      window.milu.onMenu('menu:new', () => setModal({ kind: 'newFile' })),
      window.milu.onMenu('menu:open-file', () => void openFileViaDialog()),
      window.milu.onMenu('menu:open-folder', () => void openFolderViaDialog()),
      window.milu.onMenu('menu:save', () => void saveActive()),
      window.milu.onMenu('menu:save-as', () => void saveActiveAs()),
      window.milu.onMenu('menu:close-tab', () => closeActiveTab()),
      window.milu.onMenu('menu:prev-tab', () => workspace.cycleTab(-1)),
      window.milu.onMenu('menu:next-tab', () => workspace.cycleTab(1)),
      // ⌘1-8 = activate Nth tab in focused leaf; ⌘9 = activate last tab.
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
        window.milu.onMenu(`menu:goto-tab-${n}`, () => gotoTabInFocused(n - 1)),
      ),
      window.milu.onMenu('menu:goto-tab-last', () => gotoTabInFocused(-1)),
      window.milu.onMenu('menu:toggle-sidebar', () => workspace.toggleSidebar()),
      window.milu.onMenu('menu:toggle-outline', () => workspace.toggleOutline()),
      window.milu.onMenu('menu:toggle-markdown-mode', () => workspace.toggleMarkdownViewMode()),
      window.milu.onMenu('menu:preferences', () => openSettingsTab()),
      window.milu.onMenu('menu:find-in-files', () => {
        // Reuse an existing Search tab in the active session if one exists,
        // otherwise open a new one.
        const s = workspace.getState();
        const session = getActiveSession(s);
        const leaves = getAllLeaves(session.root);
        for (const leaf of leaves) {
          for (const id of leaf.tabIds) {
            const tab = s.tabs.find((t) => t.id === id);
            if (tab?.kind === 'search') {
              workspace.revealTab(tab.id);
              return;
            }
          }
        }
        openSearchTab();
      }),
      window.milu.onMenu('menu:quick-open', () => setModal({ kind: 'palette', replace: false })),
      window.milu.onMenu('menu:quick-open-replace', () => setModal({ kind: 'palette', replace: true })),
      window.milu.onMenu('menu:goto-path', () => setModal({ kind: 'path', replace: false })),
      window.milu.onMenu('menu:goto-path-replace', () => setModal({ kind: 'path', replace: true })),
      window.milu.onMenu('menu:reopen-closed-tab', () => void reopenLastClosedTab()),
      window.milu.onMenu('menu:new-terminal', () => openTerminalTab()),
      window.milu.onMenu('menu:focus-address', () => uiBus.emit('focus-address')),
      // ⌘R: only the active web tab listens — non-web tabs no-op so the
      // keystroke can never reload the whole BrowserWindow by accident.
      window.milu.onMenu('menu:reload-page', () => uiBus.emit('reload-page')),
      // ⌘F — find-on-page in the active web tab. Non-web tabs no-op.
      window.milu.onMenu('menu:find-on-page', () => uiBus.emit('find-on-page')),
      window.milu.onMenu('menu:process-viewer', () => openProcessTab()),
      window.milu.onMenu('menu:open-clipboard', () => openClipboardTab()),
      window.milu.onMenu('menu:show-shortcuts', () => openShortcutsTab()),
      window.milu.onMenu('menu:split-right', () => workspace.splitFocused('horizontal')),
      window.milu.onMenu('menu:split-down', () => workspace.splitFocused('vertical')),
      window.milu.onMenu('menu:close-pane', () => workspace.closePane(workspace.getFocusedLeaf().id)),
      window.milu.onMenu('menu:cycle-layout', () => workspace.cycleLayout()),
      window.milu.onMenu('menu:toggle-pane-zoom', () => workspace.toggleMaximizePane()),
      window.milu.onMenu('menu:new-session', () => workspace.newSession()),
      window.milu.onMenu('menu:close-session', () => {
        const id = workspace.getState().activeSessionId;
        workspace.closeSession(id);
      }),
      window.milu.onMenu('menu:next-session', () => workspace.cycleSession(1)),
      window.milu.onMenu('menu:prev-session', () => workspace.cycleSession(-1)),
      window.milu.onMenu('menu:reset-workspace', () => {
        const ok = window.confirm(
          'Reset workspace?\n\nThis closes all open tabs and removes every session. ' +
            'Your saved files, settings, and recent-files list are NOT touched.',
        );
        if (ok) void resetWorkspaceAndReload();
      }),
      window.milu.onMenu('menu:focus-pane-next', () => {
        const s = workspace.getState();
        const session = getActiveSession(s);
        const leaves = getAllLeaves(session.root);
        if (leaves.length < 2) return;
        const idx = leaves.findIndex((l) => l.id === session.focusedLeafId);
        const next = (idx + 1) % leaves.length;
        workspace.setFocusedPane(leaves[next].id);
      }),
      window.milu.onMenu('menu:focus-pane-prev', () => {
        const s = workspace.getState();
        const session = getActiveSession(s);
        const leaves = getAllLeaves(session.root);
        if (leaves.length < 2) return;
        const idx = leaves.findIndex((l) => l.id === session.focusedLeafId);
        const prev = (idx - 1 + leaves.length) % leaves.length;
        workspace.setFocusedPane(leaves[prev].id);
      }),
    ];
    return () => {
      offs.forEach((off) => off());
    };
  }, []);

  return (
    <div className="app">
      {/* In zoom mode, the titlebar is reduced to an empty drag
        * region — the traffic-light area stays (macOS draws those over
        * the window chrome), but the session strip and now-playing pill
        * are hidden. The bar itself is kept so its height still spaces
        * the pane content away from the traffic lights. */}
      <div className={`titlebar${zoomed ? ' titlebar--zoom' : ''}`}>
        {!zoomed && <SessionStrip />}
        {!zoomed && <NowPlaying />}
      </div>
      <div className={`app-body${zoomed ? ' app-body--zoom' : ''}`}>
        {!zoomed && (
          <aside className={`sidebar ${sidebarVisible ? '' : 'sidebar--hidden'}`}>
            <Sidebar />
          </aside>
        )}
        <div className="panes">
          {/* LayoutGroup connects every <Reorder.Item> across panes
            * so a tab moving between strips animates from its old
            * position to its new one (via shared layoutId), instead
            * of disappearing from one and popping into the other. */}
          <LayoutGroup>
            {sessions.map((session) => {
              const multi = getAllLeaves(session.root).length > 1;
              // When a leaf is "maximized", render it alone instead of
              // walking the whole tree. Defensive lookup — if the leaf
              // was destroyed (closed tab path) we silently fall back
              // to the full tree, so stale state never shows a blank.
              const maximized =
                session.maximizedLeafId
                  ? findLeaf(session.root, session.maximizedLeafId)
                  : null;
              const renderRoot = maximized ?? session.root;
              return (
                <div
                  key={session.id}
                  className={`session-stack${multi ? ' session-stack--multi' : ''}${maximized ? ' session-stack--zoom' : ''}`}
                  data-session-id={session.id}
                  style={{ display: session.id === activeSessionId ? 'flex' : 'none' }}
                >
                  <PaneNode node={renderRoot} sessionId={session.id} />
                </div>
              );
            })}
          </LayoutGroup>
        </div>
        {outlineVisible && !zoomed && (
          <aside className="outline">
            <Outline />
          </aside>
        )}
      </div>
      <FilePalette
        open={modal?.kind === 'palette'}
        replace={modal?.kind === 'palette' ? modal.replace : false}
        onClose={close}
      />
      <NewFilePicker open={modal?.kind === 'newFile'} onClose={close} />
      <PathInput
        open={modal?.kind === 'path'}
        replace={modal?.kind === 'path' ? modal.replace : false}
        onClose={close}
      />
      <Onboarding />
    </div>
  );
}

