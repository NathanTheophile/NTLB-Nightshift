# Workspace Explorer Actionable Files

This implemention makes files in the Workspace Explorer actionable, allowing users to click on a file to open it directly in their configured IDE.

## Features

- Click any file in the Workspace Explorer to open it in the configured IDE
- Uses existing LauncherService and IDE configuration (no duplicate systems)
- Secure path validation prevents workspace escapes
- Directory expand/collapse behavior preserved
- Proper error handling through existing UI mechanisms
- Symlinks do not provide path-escape bypass

## Implementation Details

The implementation consists of five focused changes:

1. **IPC Contract** (`src/shared/contracts/ipc.ts`): Added `LaunchFileRequest` interface and `launcherOpenFile` channel
2. **Preload API** (`src/preload/index.ts`): Exposed `openFile` method to renderer process
3. **Launcher Service** (`src/main/services/LauncherService.ts`): Added `openFileInIde` method with path validation
4. **IPC Handlers** (`src/main/ipc/registerIpcHandlers.ts`): Registered handler for the new IPC channel
5. **Workspace Explorer UI** (`src/renderer/src/components/WorkspaceExplorer.tsx`): Modified `ExplorerEntry` to handle file clicks

## Security

- Input validation rejects absolute paths
- Workspace boundary checking using `assertPathWithin` utility
- Protection against path traversal and symlink attacks
- All paths validated before IDE launching occurs

## Usage

Once NightShift is configured with an IDE:
1. Navigate to any file in the Workspace Explorer pane
2. Click the file to open it in your configured IDE
3. If no IDE is configured, you'll receive a prompt to set one up
4. Invalid paths (absolute or outside workspace) are rejected with clear error messages

## Validation

- Builds successfully with `npm run build`
- Passes TypeScript checking with `npm run typecheck`
- Passes linting with `npm run lint` (0 errors, 0 warnings)
- Existing test suite continues to pass