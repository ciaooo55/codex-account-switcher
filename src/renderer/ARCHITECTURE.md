# Renderer architecture

Modern Electron renderer stack (2026):

- **React 19** + TypeScript
- **Vite 6** via electron-vite
- **Tailwind CSS v4** (`@tailwindcss/vite`) for utility-first styling
- **shadcn-style primitives**: `class-variance-authority` + `clsx` + `tailwind-merge` under `components/ui`
- **lucide-react** icons
- **@tanstack/react-virtual** for large account tables
- Path alias: `@/*` → `src/renderer/src/*`

Legacy `styles.css` remains during migration; new UI prefers Tailwind utilities + design tokens in `styles/tokens.css`.

## Structure

```
src/renderer/src/
  main.tsx
  App.tsx
  components/ui/          # Button, Badge, Input, Select, Card, Progress, PageView, Toolbar, Dialog*, Segmented*
  components/layout/
  pages/
  hooks/
  lib/                    # cn, theme, navigation, snapshot
  styles/
    tokens.css
    tailwind.css
    layout-polish.css
  styles.css              # legacy (phasing out)
```

## Conventions

1. New components: Tailwind + `cn()` + CVA variants.
2. Reuse CSS variables from `tokens.css` for light/dark.
3. Keep IPC / snapshot state in `App.tsx` + page props for now.
4. Dialogs use `DialogBackdrop` / `DialogPanel` / `DialogHeader` / `DialogActions`.
5. Segmented toggles use `SegmentedControl` + `SegmentedButton`.
