import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const tests = [
  ['guard', true],
  ['api', false],
  ['relay', true],
  ['engine', true],
  ['tostring', true],
  ['deep', true],
  ['correlation', true]
]

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit'
  })

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

for (const [name, needsWsExternals] of tests) {
  const output = path.join('test', `${name}.cjs`)
  await build({
    absWorkingDir: rootDir,
    bundle: true,
    entryPoints: [path.join('test', `verify-${name}.ts`)],
    external: needsWsExternals ? ['bufferutil', 'utf-8-validate'] : [],
    format: 'cjs',
    logLevel: 'info',
    outfile: output,
    platform: 'node'
  })
  run(process.execPath, [output])
}
