# Cicada — UI section mockups

Self-contained SVG mockups of each UI section, built from the app's real design
tokens (`src/renderer/styles.css`) and the real flower-mark sprite
(`src/renderer/index.html`). Nothing in `src/` was changed to produce these —
they're reference artwork only.

Open any `.svg` in a browser or design tool. Colors, radii, type scale and the
logo are taken verbatim from the app; `Inter` falls back to the system sans if
the font isn't installed locally.

| File | UI section | Source element |
|------|------------|----------------|
| `00-overview-workbench.svg` | Full app layout (everything together) | `#topbar` + `#main` |
| `01-splash.svg` | Loading splash | `#splash` |
| `02-kinetic-intro.svg` | Kinetic-typography intro | `#onboard-intro` |
| `03-onboarding-modal.svg` | Onboarding / welcome modal | `#onboard-overlay` |
| `04-topbar.svg` | Top bar | `#topbar` |
| `05-pipeline-sidebar.svg` | Agent Pipeline sidebar | `#agent` / `#stages` |
| `06-explorer-sidebar.svg` | File explorer | `#filetree-panel` |
| `07-editor.svg` | Code editor | `#editor-region` |
| `08-dock.svg` | Bottom dock (Console + tabs) | `#dock` |
| `09-settings.svg` | Settings overlay | `#settings-overlay` |

## Design tokens used

- Surfaces: `#050506` (bg), `#0c0c0f` (elevated), `#16161a`, `#08080a` (inputs)
- Text: `#f5f5f7` at 100 / 60 / 34% opacity
- Lines: white at 8% / 14%
- State: `#4ade80` done · `#fbbf24` running/init · `#f87171` error
- Accent eyebrow: `#95e3ff` · radii 12 / 10 · Inter / SF Mono
