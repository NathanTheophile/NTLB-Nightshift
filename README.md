# NightShift V2

Windows-first desktop project workspace and coding automation hub.

## Commands

```powershell
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run package:dir
```

The application database is created under Electron's `userData` directory, never inside an opened project. Development and production both use the SQLite implementation bundled with Electron through `node:sqlite`; no native addon rebuild is required. The API is isolated behind `DatabaseService` and repositories because `node:sqlite` is still marked release candidate by Node.js.

## Runtime boundaries

- `src/main`: privileged Electron runtime, SQLite, workspace validation and process launchers.
- `src/preload`: narrow typed bridge only.
- `src/renderer`: React UI without Node.js access.
- `src/shared`: domain types and IPC contracts shared without duplicating models.

FCC and coding-agent execution are intentionally represented by interfaces only in this bootstrap. No agent, model or AI response is simulated.
