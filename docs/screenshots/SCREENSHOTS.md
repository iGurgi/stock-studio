# Screenshots

The images referenced in the main README live in this folder. They're captured
against the **demo seed**, never a real account — so there's nothing sensitive to
redact and contributors can reproduce the exact view.

## Generate a presentable dashboard

```bash
# 1. seed a throwaway DB with realistic fake data (writes ./data/demo.db)
node scripts/seed-demo.mjs

# 2. run the dashboard against it (placement disabled, demo token)
DB_PATH=data/demo.db PLACEMENT_ENABLED=false CONTROL_TOKEN=demo node src/server.js

# 3. open http://127.0.0.1:8787 and paste "demo" as the control token to unlock
```

The seed populates a funded portfolio, six theses, two pending proposals (the
approval gate), one placed order (Open orders), plus desk activity and runs.

## Shots the README expects

Capture these to this folder with exactly these filenames:

| File | What to frame |
| --- | --- |
| `dashboard.png` | The full console — top stat bar, the gate, theses, desk activity (the hero) |
| `approval-gate.png` | A pending ticket with the "type the ticker" confirm + Approve button (the safety story) |
| `open-orders.png` | The Open orders panel with the placed RIVN order + Cancel button |

A short **GIF** of approve → place → cancel (`lifecycle.gif`) is a nice optional add.

## Rules

- **Always shoot the demo seed, never your live desk.** The real dashboard renders
  actual balances, P&L, and positions — don't publish those. The seed exists so you
  never have to redact.
- Keep `data/` out of git (it already is via `.gitignore`); only the `.png`/`.gif`
  files belong in this folder.
- After adding the images, uncomment the `<img>` slots in the main `README.md`.
