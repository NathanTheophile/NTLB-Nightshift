import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { Run, RunChangedFile, RunFileDiff, RunReview, RunReviewExportKind, RunReviewExportResult } from '@shared/domain/entities';

import type { RunRepository } from '../persistence/repositories/RunRepository';
import type { WorkspaceRepository } from '../persistence/repositories/WorkspaceRepository';

const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_FILES = 500;
const MAX_BINARY_PROBE_BYTES = 8 * 1024;

export class RunReviewService {
  public constructor(private readonly runs: RunRepository, private readonly workspaces: WorkspaceRepository) {}

  public async inspect(runId: string): Promise<RunReview> {
    const run = this.runs.findRequired(runId);
    const batchSteps = this.runs.batchSteps(runId);
    const review: RunReview = { run, worktreeHead: null, gitStatus: '', changedFiles: [], result: run.resultSummary, failure: run.failureReason, validationStatus: run.validationStatus, validationCommands: this.runs.validationCommands(runId), batchSteps, activityTotal: this.runs.eventCount(runId, 'activity'), rawProtocolTotal: this.runs.eventCount(runId, 'raw_protocol'), warnings: [] };
    const worktree = await this.validWorktree(run, review.warnings);
    if (!worktree || !run.baseSha) {
      if (!run.baseSha) review.warnings.push('The Run has no recorded base SHA; base-relative review is unavailable.');
      return review;
    }
    const base = await git(worktree, ['rev-parse', '--verify', `${run.baseSha}^{commit}`]);
    if (base.exitCode !== 0) { review.warnings.push(`Recorded base ${run.baseSha} is unavailable in this worktree.`); return review; }
    const [head, status, changes, untracked] = await Promise.all([
      git(worktree, ['rev-parse', '--verify', 'HEAD']),
      git(worktree, ['status', '--porcelain=v1']),
      git(worktree, ['diff', '--name-status', '--find-renames', run.baseSha]),
      git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    review.worktreeHead = head.exitCode === 0 ? head.stdout.trim() : null;
    review.gitStatus = status.stdout;
    review.changedFiles = await this.changedFiles(worktree, changes.stdout, untracked.stdout);
    return review;
  }

  public async fileDiff(runId: string, path: string): Promise<RunFileDiff> {
    const review = await this.inspect(runId);
    const changed = review.changedFiles.find((item) => item.path === path);
    if (!changed) throw new Error('The requested file is not part of this Run review.');
    const run = review.run; const worktree = await this.validWorktree(run, []);
    if (!worktree || !run.baseSha) return { path, content: null, isBinary: false, truncated: false, note: 'Base-relative diff is unavailable.' };
    if (changed.isBinary) return { path, content: null, isBinary: true, truncated: false, note: 'Binary file; content is intentionally not displayed.' };
    if (changed.kind === 'untracked') return this.untrackedDiff(worktree, changed);
    const output = await git(worktree, ['diff', '--no-ext-diff', '--binary', run.baseSha, '--', path], MAX_DIFF_BYTES + 1);
    if (output.truncated) return { path, content: output.stdout.slice(0, MAX_DIFF_BYTES), isBinary: false, truncated: true, note: 'Diff truncated at 512 KiB.' };
    return { path, content: output.stdout || 'No textual diff available.', isBinary: output.stdout.includes('Binary files '), truncated: false, note: null };
  }

  public async exportTo(runId: string, kind: RunReviewExportKind, outputPath: string): Promise<RunReviewExportResult> {
    const review = await this.inspect(runId);
    if (kind === 'markdown') await writeFile(outputPath, markdown(review), 'utf8');
    else if (kind === 'json') await this.writeEvidenceJson(review, outputPath);
    else await this.writeBundle(review, outputPath);
    return { path: outputPath, kind };
  }

  public suggestedFileName(runId: string, kind: RunReviewExportKind): string {
    this.runs.findRequired(runId);
    return `nightshift-run-${runId.slice(0, 8)}-review${kind === 'markdown' ? '.md' : kind === 'json' ? '.json' : '.zip'}`;
  }

  public async resolveValidWorktree(runId: string): Promise<string> {
    const run = this.runs.findRequired(runId);
    const worktree = await this.validWorktree(run, []);
    if (!worktree) throw new Error('This Run no longer has a valid persisted worktree.');
    return worktree;
  }

  private async changedFiles(worktree: string, changes: string, untracked: string): Promise<RunChangedFile[]> {
    const result = new Map<string, RunChangedFile>();
    for (const line of changes.split(/\r?\n/)) {
      if (!line) continue;
      const [code, path, renamedPath] = line.split('\t'); if (!code || !path) continue;
      const kind = code.startsWith('R') ? 'renamed' : code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : code.startsWith('M') ? 'modified' : 'unknown';
      const previousPath = kind === 'renamed' ? path : null;
      const finalPath = kind === 'renamed' ? renamedPath : path;
      if (!finalPath) continue;
      result.set(finalPath, await fileInfo(worktree, finalPath, { path: finalPath, previousPath, kind, staged: false, unstaged: true }));
    }
    for (const path of untracked.split('\0')) {
      if (!path) continue; result.set(path, await fileInfo(worktree, path, { path, previousPath: null, kind: 'untracked', staged: false, unstaged: true }));
    }
    return [...result.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  private async untrackedDiff(worktree: string, file: RunChangedFile): Promise<RunFileDiff> {
    const target = await safeRegularFile(worktree, file.path);
    if (!target || file.sizeBytes === null) return { path: file.path, content: null, isBinary: false, truncated: false, note: file.note ?? 'File is unavailable.' };
    if (file.sizeBytes > MAX_DIFF_BYTES) return { path: file.path, content: null, isBinary: false, truncated: true, note: 'Untracked file exceeds the 512 KiB preview limit.' };
    const data = await readFile(target);
    if (isBinary(data)) return { path: file.path, content: null, isBinary: true, truncated: false, note: 'Binary file; content is intentionally not displayed.' };
    return { path: file.path, content: `--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${data.toString('utf8').split('\n').length} @@\n${data.toString('utf8').split('\n').map((line) => `+${line}`).join('\n')}`, isBinary: false, truncated: false, note: null };
  }

  private async writeBundle(review: RunReview, outputPath: string): Promise<void> {
    const entries: ZipEntry[] = []; let totalBytes = 22;
    const add = (name: string, content: Buffer): boolean => {
      const zipBytes = content.length + Buffer.byteLength(name) * 2 + 76;
      if (entries.length >= MAX_BUNDLE_FILES || totalBytes + zipBytes > MAX_BUNDLE_BYTES) return false;
      entries.push({ name, content }); totalBytes += zipBytes; return true;
    };
    add('run-review.md', Buffer.from(markdown(review)));
    add('run.json', Buffer.from(`${JSON.stringify(compactJsonExport(review), null, 2)}\n`));
    add('status.txt', Buffer.from(review.gitStatus));
    const patch = await this.fullPatch(review, MAX_BUNDLE_BYTES - totalBytes - 128);
    add('changes.patch', Buffer.from(patch));
    const worktree = await this.validWorktree(review.run, []);
    if (worktree) for (const file of review.changedFiles.filter((item) => item.kind === 'untracked')) {
      if (entries.length >= MAX_BUNDLE_FILES) break;
      const source = await safeRegularFile(worktree, file.path); if (!source || file.sizeBytes === null || file.sizeBytes > MAX_FILE_BYTES) continue;
      const content = await readFile(source);
      if (!add(`untracked/${file.path.replaceAll('\\', '/')}`, content)) break;
    }
    await mkdir(dirname(outputPath), { recursive: true }); await writeZip(outputPath, entries);
  }

  private async writeEvidenceJson(review: RunReview, outputPath: string): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    const file = await open(outputPath, 'w');
    try {
      await file.write(`${JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), review })}\n`.replace(/}\n$/, ',"activity":['));
      await this.writeEventStream(file, review.run.id, 'activity');
      await file.write('],"rawProtocol":[');
      await this.writeEventStream(file, review.run.id, 'raw_protocol');
      await file.write(']}\n');
    } finally { await file.close(); }
  }

  private async writeEventStream(file: Awaited<ReturnType<typeof open>>, runId: string, kind: 'activity' | 'raw_protocol'): Promise<void> {
    let cursor: number | null = null; let first = true;
    do {
      const page = this.runs.listEventPage(runId, kind, cursor, 200);
      for (const event of page.events) { await file.write(`${first ? '' : ','}${JSON.stringify(event)}`); first = false; }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  private async fullPatch(review: RunReview, maxBytes = MAX_GIT_OUTPUT): Promise<string> {
    const worktree = await this.validWorktree(review.run, []);
    if (!worktree || !review.run.baseSha) return '';
    const patch = await git(worktree, ['diff', '--no-ext-diff', '--binary', review.run.baseSha], Math.min(MAX_GIT_OUTPUT, Math.max(0, maxBytes)));
    return patch.stdout;
  }

  private async validWorktree(run: Run, warnings: string[]): Promise<string | undefined> {
    if (!run.worktreePath || !run.baseSha) return undefined;
    try {
      const workspace = this.workspaces.findById(run.workspaceId); if (!workspace?.isGit) throw new Error('missing Git workspace');
      const original = await lstat(run.worktreePath); if (original.isSymbolicLink()) throw new Error('symlinked worktree');
      const canonical = await realpath(run.worktreePath); const info = await stat(canonical);
      if (!info.isDirectory()) throw new Error('not a directory');
      const [root, worktreeGitDir, workspaceGitDir] = await Promise.all([
        git(canonical, ['rev-parse', '--show-toplevel']),
        git(canonical, ['rev-parse', '--git-common-dir']),
        git(workspace.rootPath, ['rev-parse', '--git-common-dir']),
      ]);
      if (root.exitCode !== 0 || worktreeGitDir.exitCode !== 0 || workspaceGitDir.exitCode !== 0 || resolve(root.stdout.trim()) !== resolve(canonical) || resolve(canonical, worktreeGitDir.stdout.trim()) !== resolve(workspace.rootPath, workspaceGitDir.stdout.trim())) throw new Error('not a Workspace worktree root');
      return canonical;
    } catch { warnings.push('The persisted Run worktree is missing or invalid.'); return undefined; }
  }
}

const fileInfo = async (root: string, path: string, values: Pick<RunChangedFile, 'path' | 'previousPath' | 'kind' | 'staged' | 'unstaged'>): Promise<RunChangedFile> => {
  const target = safeChild(root, path); if (!target) return { ...values, isBinary: false, sizeBytes: null, diffAvailable: false, note: 'Unsafe path rejected.' };
  try { const source = await safeRegularFile(root, path); if (!source) return { ...values, isBinary: false, sizeBytes: null, diffAvailable: false, note: 'Directory or symlink content is not included.' }; const info = await stat(source); const data = await readPrefix(source, Math.min(info.size, MAX_BINARY_PROBE_BYTES)); return { ...values, isBinary: isBinary(data), sizeBytes: info.size, diffAvailable: info.size <= MAX_DIFF_BYTES, note: info.size > MAX_DIFF_BYTES ? 'File exceeds the 512 KiB diff limit.' : null }; }
  catch { return { ...values, isBinary: false, sizeBytes: null, diffAvailable: true, note: values.kind === 'deleted' ? null : 'File is unavailable.' }; }
};
const readPrefix = async (path: string, length: number): Promise<Buffer> => { const handle = await open(path, 'r'); try { const data = Buffer.alloc(length); const { bytesRead } = await handle.read(data, 0, length, 0); return data.subarray(0, bytesRead); } finally { await handle.close(); } };
const isInside = (root: string, target: string): boolean => target === resolve(root) || target.startsWith(`${resolve(root)}${sep}`);
const safeChild = (root: string, path: string): string | undefined => { if (!path || isAbsolute(path)) return undefined; const target = resolve(root, path); return isInside(root, target) ? target : undefined; };
const safeRegularFile = async (root: string, path: string): Promise<string | undefined> => { const target = safeChild(root, path); if (!target) return undefined; const direct = await lstat(target); if (!direct.isFile() || direct.isSymbolicLink()) return undefined; const canonical = await realpath(target); return isInside(root, canonical) ? canonical : undefined; };
const isBinary = (value: Buffer): boolean => value.includes(0);
const git = (cwd: string, args: string[], maxBytes = MAX_GIT_OUTPUT): Promise<{ stdout: string; exitCode: number; truncated: boolean }> => new Promise((done, reject) => { const child = spawn('git', ['-C', cwd, ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let size = 0; let truncated = false; child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { size += Buffer.byteLength(chunk); if (size <= maxBytes) stdout += chunk; else truncated = true; }); child.once('error', reject); child.once('close', (exitCode) => done({ stdout, exitCode: exitCode ?? -1, truncated })); });
const markdown = (review: RunReview): string => `# NightShift Run Review\n\n- Run: ${review.run.id}\n- Status: ${review.run.status}\n- Mode: ${review.run.executionMode}\n- Agent / model: ${review.run.resolvedAgentId} / ${review.run.resolvedModelId}\n- Session: ${review.run.externalSessionId ?? '—'}\n- Base SHA: ${review.run.baseSha ?? '—'}\n- Worktree HEAD: ${review.worktreeHead ?? review.run.finalHeadSha ?? '—'}\n- Validation: ${review.validationStatus ?? '—'}\n\n## Result\n\n${review.result ?? '—'}\n\n## Failure\n\n${review.failure ?? '—'}\n\n## Validation commands\n\n${review.validationCommands.length ? review.validationCommands.map((command) => `- ${command.status}: ${command.command} (${command.exitCode ?? '—'})`).join('\n') : '—'}\n\n## Changed files\n\n${review.changedFiles.length ? review.changedFiles.map((file) => `- ${file.kind}: \`${file.path}\`${file.previousPath ? ` (from \`${file.previousPath}\`)` : ''}${file.note ? ` — ${file.note}` : ''}`).join('\n') : 'No changes detected.'}\n\n## Batch steps\n\n${review.batchSteps.length ? review.batchSteps.map((step) => `- ${step.stepIndex + 1}. ${step.status}: ${step.prompt}`).join('\n') : '—'}\n\n## Git status\n\n\`\`\`text\n${review.gitStatus}\`\`\`\n`;
const compactJsonExport = (review: RunReview): { schemaVersion: 2; exportedAt: string; review: RunReview } => ({ schemaVersion: 2, exportedAt: new Date().toISOString(), review });
interface ZipEntry { name: string; content: Buffer; }
const writeZip = async (path: string, entries: readonly ZipEntry[]): Promise<void> => { const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0; for (const entry of entries) { if (!validZipName(entry.name)) continue; const name = Buffer.from(entry.name); const crc = crc32(entry.content); const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(entry.content.length, 18); header.writeUInt32LE(entry.content.length, 22); header.writeUInt16LE(name.length, 26); parts.push(header, name, entry.content); const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(entry.content.length, 20); directory.writeUInt32LE(entry.content.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += header.length + name.length + entry.content.length; } const centralSize = central.reduce((total, item) => total + item.length, 0); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); await writeFile(path, Buffer.concat([...parts, ...central, end])); };
const validZipName = (name: string): boolean => !name.includes('..') && !name.startsWith('/') && !name.startsWith('\\') && !name.includes(':');
const crc32 = (value: Buffer): number => { let crc = 0xffffffff; for (const byte of value) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
