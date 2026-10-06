// Type-level conformance for core's ports (packages/core/src/ports.ts).
//
// Compiles two fixtures with tsc (no emit, nothing runs):
//   cli.ts      the CLI adapters (src/ports/) satisfy every port interface,
//               and createCliPorts / the root export return HarnessPorts;
//   browser.ts  a host with only web APIs (lib DOM, no @types/node) can
//               implement every port: no Node type leaks into a signature.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(repoRoot, 'tests', 'fixtures', 'ports-conformance');
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

function compile(project) {
  const r = spawnSync(process.execPath, [tsc, '-p', join(fixtures, project)], { encoding: 'utf-8', cwd: repoRoot });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

test('CLI adapters satisfy the core port interfaces', () => {
  const { status, output } = compile('tsconfig.cli.json');
  assert.equal(status, 0, output);
});

test('every port is implementable with web APIs only (no Node types in core signatures)', () => {
  const { status, output } = compile('tsconfig.browser.json');
  assert.equal(status, 0, output);
});
