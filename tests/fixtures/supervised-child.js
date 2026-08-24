import { spawn } from 'node:child_process';
import process from 'node:process';
import { setInterval } from 'node:timers';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(import.meta.url);
const mode = process.argv[2];

if (mode === 'complete') {
  process.stdout.write('fixture-stdout');
  process.stderr.write('fixture-stderr');
  process.exitCode = 7;
} else if (mode === 'tree-parent') {
  const child = spawn(process.execPath, [fixturePath, 'tree-child'], { stdio: 'ignore' });
  process.stdout.write(`${String(child.pid)}\n`);
  setInterval(() => {}, 1_000);
} else if (mode === 'tree-child') {
  setInterval(() => {}, 1_000);
} else {
  process.stderr.write(`Unknown fixture mode: ${String(mode)}`);
  process.exitCode = 2;
}
