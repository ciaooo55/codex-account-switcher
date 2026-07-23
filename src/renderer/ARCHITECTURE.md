# Renderer architecture

React 19 + TypeScript + electron-vite layered frontend for **Electron + IPC snapshot**.

## Structure

```
src/renderer/src/
  main.tsx
  App.tsx                         # composition root (IPC session + dialogs wiring)
  context/AppSessionContext.tsx   # shared session chrome
  pages/
    AccountsPage.tsx
    AutomationPage.tsx
    GrokPage.tsx                  # Grok + CPA
  components/
    layout/                       # header / toast / global progress
    accounts/                     # Quota / chips
    dialogs/                      # SettingsDialog (+ more extractions)
    *.tsx                         # feature dialogs already modular
  services/codexApi.ts
  lib/                            # pure helpers
  domain/                         # filters / sort / status boundary
  hooks/
  styles/
    tokens.css                    # design tokens
    layout-polish.css             # visual hierarchy
  styles.css                      # legacy component styles (stable class API)
```

## Data flow

Page → codexApi() → main IPC → AppSnapshot → App / AppSessionContext → pages/components

## Stack

| Layer | Choice |
|------|--------|
| Runtime | Electron + electron-vite |
| UI | React 19 + TypeScript |
| Session data | IPC snapshot (single source of truth) |
| UI chrome | React Context |
| Styling | CSS variables design system + polished workbench chrome |
| Icons | lucide-react |

## Invariants

1. No user-facing regression; IPC contracts stable.
2. Prefer extraction over rewrites of behavior.
3. Gate every step with `npm run typecheck` and `npm test`.
