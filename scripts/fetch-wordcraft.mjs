/**
 * Fetch the SuperDoc web build into static/vendor/.
 *
 * The plugin embeds the unmodified prebuilt CDN bundle shipped in the
 * `superdoc` npm package (dist-cdn/superdoc.min.js + superdoc.min.css), so
 * the binary assets stay out of git: run `npm run fetch-wordcraft` once after
 * cloning. The npm tarball is downloaded from the registry and unpacked with
 * the system tar (bsdtar ships with Windows 10+/most Unix). Idempotent —
 * skips the download when static/vendor/superdoc.min.js already exists unless
 * --force is passed.
 */
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(__dirname, '..')
const VENDOR_DIR = resolve(PLUGIN_ROOT, 'static', 'vendor')
const MARKER = resolve(VENDOR_DIR, 'superdoc.min.js')

const VERSION = '2.28.0'
const TARBALL_URL = `https://registry.npmjs.org/superdoc/-/superdoc-${VERSION}.tgz`
const WANTED = ['dist-cdn/superdoc.min.js', 'dist-cdn/superdoc.min.css']

const force = process.argv.includes('--force')

if (!force && existsSync(MARKER)) {
  console.log(`[fetch-wordcraft] static/vendor/ already populated (${statSync(MARKER).size} bytes superdoc.min.js) — skipping. Use --force to re-download.`)
  process.exit(0)
}

console.log(`[fetch-wordcraft] downloading ${TARBALL_URL} …`)
const res = await fetch(TARBALL_URL, { redirect: 'follow' })
if (!res.ok || !res.body) {
  console.error(`[fetch-wordcraft] download failed: HTTP ${res.status} ${res.statusText}`)
  process.exit(1)
}

// Downloaded archives are untrusted: unpack in a fresh temp directory, then
// copy out only the two wanted files.
const scratch = mkdtempSync(join(tmpdir(), `dsh-wordcraft-fetch-${randomBytes(4).toString('hex')}-`))
const tgzPath = join(scratch, `superdoc-${VERSION}.tgz`)
try {
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tgzPath))
  console.log(`[fetch-wordcraft] downloaded ${statSync(tgzPath).size} bytes`)

  console.log('[fetch-wordcraft] extracting …')
  // Relative filenames with cwd: GNU tar (Git Bash) reads a `C:\...` argument
  // as a remote host spec, so absolute Windows paths must stay off the argv.
  await execFileAsync('tar', ['-xzf', `superdoc-${VERSION}.tgz`], { cwd: scratch })

  mkdirSync(VENDOR_DIR, { recursive: true })
  for (const member of WANTED) {
    const source = join(scratch, 'package', ...member.split('/'))
    if (!existsSync(source)) {
      console.error(`[fetch-wordcraft] tarball is missing ${member} — unexpected package layout`)
      process.exit(1)
    }
    const target = resolve(VENDOR_DIR, member.split('/').pop())
    rmSync(target, { force: true })
    writeFileSync(target, readFileSync(source))
    console.log(`[fetch-wordcraft] ${member} → static/vendor/${member.split('/').pop()} (${statSync(target).size} bytes)`)
  }
  writeFileSync(resolve(VENDOR_DIR, 'version.txt'), `superdoc ${VERSION}\n`)
  console.log('[fetch-wordcraft] done — static/vendor/ ready')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
