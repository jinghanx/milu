import { useEffect, useState, type ReactNode } from 'react';
import { useSettings, settings } from '../state/settings';
import iconUrl from '../assets/icon.png';

const SPLIT_DIAGRAM = String.raw`
┌──────────┬──────────┐
│          │  code    │
│  notes   ├──────────┤
│          │ terminal │
└──────────┴──────────┘
`;

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="onb-kbd">{children}</kbd>;
}

/** Groups one-or-more Kbd elements into a single grid cell so the
 *  shortcut list's two-column layout doesn't get torn apart when a row
 *  has multiple keys (e.g. "⌘⇧[ ⌘⇧]"). */
function Keys({ children }: { children: ReactNode }) {
  return <span className="onb-keys">{children}</span>;
}

/** A single "hero" shortcut for slides that focus on one key. Bigger
 *  than inline Kbd, centred, with a soft glow. The label below names
 *  what the key does in plain prose. */
function HeroShortcut({ keys, label }: { keys: ReactNode; label: string }) {
  return (
    <div className="onb-hero">
      <div className="onb-hero-key">{keys}</div>
      <div className="onb-hero-label">{label}</div>
    </div>
  );
}

/** Miniature mockup of a Milu window — two panes side-by-side, the right
 *  one itself split top/bottom. Each pane has its own tab bar. Labels on
 *  the periphery point at workspace / pane / tabs so the hierarchy is
 *  visible spatially, not as a file tree. */
function WindowMock() {
  return (
    <div className="onb-mock" aria-hidden="true">
      <div className="onb-mock-titlebar">
        <span className="onb-mock-traffic" />
        <span className="onb-mock-traffic" />
        <span className="onb-mock-traffic" />
        <span className="onb-mock-title">workspace · 1 of 3</span>
      </div>
      <div className="onb-mock-body">
        <div className="onb-mock-pane">
          <div className="onb-mock-tabs">
            <span className="onb-mock-tab onb-mock-tab--active">notes.md</span>
          </div>
          <div className="onb-mock-content onb-mock-content--md">
            <span /><span /><span />
          </div>
        </div>
        <div className="onb-mock-col">
          <div className="onb-mock-pane">
            <div className="onb-mock-tabs">
              <span className="onb-mock-tab onb-mock-tab--active">app.tsx</span>
              <span className="onb-mock-tab">README</span>
            </div>
            <div className="onb-mock-content onb-mock-content--code">
              <span /><span /><span />
            </div>
          </div>
          <div className="onb-mock-pane">
            <div className="onb-mock-tabs">
              <span className="onb-mock-tab onb-mock-tab--active">terminal</span>
            </div>
            <div className="onb-mock-content onb-mock-content--term">$ _</div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface Slide {
  title: string;
  subtitle?: string;
  vis: ReactNode;
  body: ReactNode;
}

const SLIDES: Slide[] = [
  // 1 — high-level pitch
  {
    title: 'Welcome to Milu',
    subtitle: 'One window for everything you keep open.',
    vis: <img src={iconUrl} alt="" className="onb-logo-img" />,
    body: (
      <p>
        Markdown, code, folders, browser, terminal — all share one recursive
        split-pane layout. <em>Sixty seconds, seven things worth knowing.</em>
      </p>
    ),
  },

  // 2 — mental model: workspace → pane → tab
  {
    title: 'Workspace · Pane · Tab',
    subtitle: 'The mental model, in one window.',
    vis: <WindowMock />,
    body: (
      <p>
        A <strong>workspace</strong> is one folder. It holds a tree of{' '}
        <strong>panes</strong> you split however you like, and each pane has
        its own <strong>tabs</strong> — editor, browser, terminal, anything.
      </p>
    ),
  },

  // 3 — starting a workspace
  {
    title: 'Start a workspace',
    subtitle: 'Open a folder. The sidebar shows its tree.',
    vis: <HeroShortcut keys={<Kbd>⌘⇧O</Kbd>} label="open folder" />,
    body: (
      <p>
        Each workspace is rooted at one folder. You can open several at
        once and switch between them — the rest of the workspace controls
        live in the menu bar.
      </p>
    ),
  },

  // 4 — splitting a pane
  {
    title: 'Split a pane',
    subtitle: 'Recursive splits, in any direction.',
    vis: <pre className="onb-ascii">{SPLIT_DIAGRAM}</pre>,
    body: (
      <p>
        <Keys><Kbd>⌘\</Kbd></Keys> splits to the right,{' '}
        <Keys><Kbd>⌘=</Kbd></Keys> splits down. Splits can nest as deep
        as you like — drag the seam to resize.
      </p>
    ),
  },

  // 5 — quick-opening a file
  {
    title: 'Open a file quickly',
    subtitle: 'Fuzzy-find any file in the workspace.',
    vis: <HeroShortcut keys={<Kbd>⌘P</Kbd>} label="quick open" />,
    body: (
      <p>
        Type to fuzzy-match across <strong>markdown</strong>,{' '}
        <strong>code</strong>, plain text — anything in your workspace
        tree. Recently-opened files surface first.
      </p>
    ),
  },

  // 6 — global launcher
  {
    title: 'The global launcher',
    subtitle: 'Works from anywhere on your Mac — even when Milu is hidden.',
    vis: <HeroShortcut keys={<Kbd>⌘⌥Space</Kbd>} label="global launcher" />,
    body: (
      <p>
        One hotkey from <em>any</em> app: search files, run commands, open
        URLs, jump to a path. Rebind it under Settings → Launcher.
      </p>
    ),
  },

  // 7 — explore more, ⌘T as the discoverability hub
  {
    title: 'Go anywhere',
    subtitle: 'Files, commands, URLs, paths, every tab kind — one prompt.',
    vis: <HeroShortcut keys={<Kbd>⌘T</Kbd>} label="go to anything" />,
    body: (
      <p>
        <Kbd>⌘T</Kbd> is the discoverability hub. Browse the menus when
        you want to look something up; otherwise, this is where you start.
      </p>
    ),
  },
];

export function Onboarding() {
  const seen = useSettings().hasSeenOnboarding;
  const [step, setStep] = useState(0);

  // Allow the user to re-trigger the tour from the tray menu — main
  // sends `menu:show-onboarding` and we just flip the persisted flag
  // back to false. Dismissing then re-sets it to true as usual.
  useEffect(() => {
    return window.milu.onMenu('menu:show-onboarding', () => {
      setStep(0);
      settings.update({ hasSeenOnboarding: false });
    });
  }, []);

  const next = () => setStep((s) => Math.min(s + 1, SLIDES.length - 1));
  const prev = () => setStep((s) => Math.max(s - 1, 0));
  const finish = () => settings.update({ hasSeenOnboarding: true });

  useEffect(() => {
    if (seen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (step >= SLIDES.length - 1) finish();
        else next();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [seen, step]);

  if (seen) return null;

  const isLast = step === SLIDES.length - 1;
  const slide = SLIDES[step];

  return (
    <div className="modal-backdrop onb-backdrop" onClick={finish}>
      <div
        className="onb-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onb-title"
      >
        <div className="onb-head">
          <span className="onb-tag">
            <em>milu · the tour</em>
            <span className="onb-tag-sep">·</span>
            <span className="onb-tag-step">{step + 1} of {SLIDES.length}</span>
          </span>
          <button type="button" className="onb-skip" onClick={finish}>
            Skip
          </button>
        </div>

        <div className="onb-vis">{slide.vis}</div>

        <div className="onb-text">
          <h2 id="onb-title" className="onb-title">{slide.title}</h2>
          {slide.subtitle && <p className="onb-subtitle">{slide.subtitle}</p>}
          <div className="onb-body">{slide.body}</div>
        </div>

        <div className="onb-foot">
          <div className="onb-dots" role="tablist">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Slide ${i + 1}`}
                aria-selected={i === step}
                className={`onb-dot${i === step ? ' onb-dot--active' : ''}`}
                onClick={() => setStep(i)}
              />
            ))}
          </div>
          <div className="onb-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={prev}
              disabled={step === 0}
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={isLast ? finish : next}
            >
              {isLast ? 'Get started' : 'Next →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
