import type { RunStartSpec, WorkerStartSpec } from '../../contracts/AgentAdapter';

const boundedFileEditTools = 'Read,Edit,Write,Glob,Grep';
const plannerTools = `${boundedFileEditTools},Bash`;
const plannerBashPermissions = [
  'Bash(npm run typecheck)',
  'Bash(npm run lint)',
  'Bash(npm test)',
  'Bash(npm test *)',
  'Bash(npm run build)',
  'Bash(npx vitest *)',
  'Bash(npm exec vitest *)',
  'Bash(git status)',
  'Bash(git status *)',
  'Bash(git diff)',
  'Bash(git diff *)',
  'Bash(git log)',
  'Bash(git log *)',
  'Bash(git show)',
  'Bash(git show *)',
  'Bash(git rev-parse)',
  'Bash(git rev-parse *)',
] as const;

export const buildClaudeRunArguments = (spec: RunStartSpec): readonly string[] => {
  if (!spec.modelId.trim()) throw new Error('Claude runs require an explicit model.');
  if (!spec.prompt.trim()) throw new Error('Claude runs require a non-empty prompt.');
  if (!spec.workingDirectory.trim()) throw new Error('Claude runs require an explicit working directory.');

  return [
    '-p',
    '--verbose',
    '--model',
    spec.modelId,
    '--permission-mode',
    'acceptEdits',
    '--tools',
    plannerTools,
    '--allowedTools',
    ...plannerBashPermissions,
    '--output-format',
    'stream-json',
    spec.prompt,
  ];
};

export const buildClaudeWorkerArguments = (spec: WorkerStartSpec): readonly string[] => {
  if (!spec.modelId.trim()) throw new Error('Claude Workers require an explicit model.');
  if (!spec.prompt.trim()) throw new Error('Claude Workers require a non-empty message.');
  if (!spec.workingDirectory.trim()) throw new Error('Claude Workers require an explicit working directory.');

  const readOnly = spec.permissionProfile === 'read_only';
  return [
    '-p',
    '--verbose',
    '--model',
    spec.modelId,
    '--permission-mode',
    readOnly ? 'plan' : 'acceptEdits',
    '--tools',
    readOnly ? 'Read,Glob,Grep' : boundedFileEditTools,
    '--output-format',
    'stream-json',
    ...(spec.externalSessionId ? ['--resume', spec.externalSessionId] : []),
    spec.prompt,
  ];
};
