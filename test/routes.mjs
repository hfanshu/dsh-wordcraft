/**
 * Host-route unit tests for dsh-wordcraft (no DSH host needed):
 *   node test/routes.mjs
 * Covers path containment, the save route (happy path / escapes / unknown
 * session / empty body), the bridge-page and vendor routes (MIME + cache +
 * traversal refusal) and the presented-file resolve route (coordinates →
 * declared path).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createWordcraftRoutes, createResolveRoute, resolveInsideWorkspace } from '../lib/routes.js'

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-wordcraft-test-'))
const WORKSPACE = join(ROOT, 'ws')
const APP = join(ROOT, 'app')
const VENDOR = join(ROOT, 'static')
mkdirSync(WORKSPACE)
mkdirSync(APP)
mkdirSync(VENDOR)
writeFileSync(join(APP, 'app.html'), '<html>wc-page</html>')
writeFileSync(join(APP, 'app.js'), '// wc-bridge')
writeFileSync(join(VENDOR, 'superdoc.min.js'), '// superdoc')
writeFileSync(join(VENDOR, 'superdoc.min.css'), '/* superdoc */')

// ── resolveInsideWorkspace ────────────────────────────────────────────
assert.equal(resolveInsideWorkspace(WORKSPACE, 'book.docx'), join(WORKSPACE, 'book.docx'))
assert.equal(resolveInsideWorkspace(WORKSPACE, 'sub/dir/book.docx'), join(WORKSPACE, join('sub', 'dir', 'book.docx')))
assert.equal(resolveInsideWorkspace(WORKSPACE, ''), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, '..'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, '../escape.docx'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, 'a/../../escape.docx'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, '/etc/hosts'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, 'C:\\Windows\\evil.docx'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, 'ok\0evil'), undefined)
assert.equal(resolveInsideWorkspace(WORKSPACE, '.hidden.docx'), join(WORKSPACE, '.hidden.docx'), 'dotfiles are legal names')
console.log('✅ resolveInsideWorkspace containment')

// ── route fixtures ────────────────────────────────────────────────────
const sessions = {
  get(id) {
    if (id === 's1') return { header: { cwd: WORKSPACE } }
    if (id === 's2') return { header: {} } // no cwd
    return undefined
  },
}
const routes = createWordcraftRoutes({ appDir: APP, staticDir: VENDOR, sessions })
const saveRoute = routes.find(route => route.path === '/api/dsh-wordcraft/save')
const htmlRoute = routes.find(route => route.path === '/api/dsh-wordcraft/app.html')
const jsRoute = routes.find(route => route.path === '/api/dsh-wordcraft/app.js')
const vendorRoute = routes.find(route => route.kind === 'prefix')
assert.ok(saveRoute && htmlRoute && jsRoute && vendorRoute)

function mockRes() {
  const res = new PassThrough()
  res.statusCode = 0
  res.headers = {}
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers }
  res.body = []
  res.on('data', chunk => res.body.push(chunk))
  res.done = new Promise(resolvePromise => res.on('end', resolvePromise))
  return res
}

async function readBodyOf(res) {
  await res.done
  return Buffer.concat(res.body).toString('utf8')
}

// ── save route ────────────────────────────────────────────────────────
function mockReq(method, url, body) {
  // Minimal IncomingMessage stand-in: async-iterable chunks.
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  let index = 0
  return {
    method,
    url,
    on(event, handler) {
      if (event === 'data') { setImmediate(() => { if (index < chunks.length) handler(chunks[index++]) }) }
      if (event === 'end') { setImmediate(handler) }
      if (event === 'error') { /* unused */ }
    },
    destroy() { /* unused */ },
  }
}

{
  const res = mockRes()
  await saveRoute.handler(mockReq('POST', '/api/dsh-wordcraft/save?sessionId=s1&path=reports/book.docx', 'DOCX-BYTES'), res)
  const json = JSON.parse(await readBodyOf(res))
  assert.equal(res.statusCode, 200)
  assert.equal(json.success, true)
  assert.equal(json.data.path, 'reports/book.docx')
  assert.equal(readFileSync(join(WORKSPACE, 'reports', 'book.docx'), 'utf8'), 'DOCX-BYTES')
  const leftovers = readdirSafe(join(WORKSPACE, 'reports'))
  assert.equal(leftovers.filter(name => name.includes('.tmp')).length, 0, 'no tmp leftovers')
  console.log('✅ save: writes inside workspace, atomic (no tmp leftovers)')
}
{
  const res = mockRes()
  await saveRoute.handler(mockReq('POST', '/api/dsh-wordcraft/save?sessionId=s1&path=../escape.docx', 'X'), res)
  assert.equal(res.statusCode, 400)
  const res2 = mockRes()
  await saveRoute.handler(mockReq('POST', '/api/dsh-wordcraft/save?sessionId=unknown&path=a.docx', 'X'), res2)
  assert.equal(res2.statusCode, 404)
  const res3 = mockRes()
  await saveRoute.handler(mockReq('POST', '/api/dsh-wordcraft/save?sessionId=s2&path=a.docx', 'X'), res3)
  assert.equal(res3.statusCode, 404, 'session without cwd rejects')
  const res4 = mockRes()
  await saveRoute.handler(mockReq('POST', '/api/dsh-wordcraft/save?sessionId=s1&path=', 'X'), res4)
  assert.equal(res4.statusCode, 400, 'empty path rejects')
  const res5 = mockRes()
  await saveRoute.handler(mockReq('POST', '/api/dsh-wordcraft/save?sessionId=s1&path=a.docx', ''), res5)
  assert.equal(res5.statusCode, 400, 'empty body rejects')
  const res6 = mockRes()
  await saveRoute.handler(mockReq('GET', '/api/dsh-wordcraft/save?sessionId=s1&path=a.docx'), res6)
  assert.equal(res6.statusCode, 405)
  console.log('✅ save: escapes/unknown/no-cwd/empty/method all rejected')
}
{
  // Overwrite round-trip: second save replaces content and leaves no tmp.
  writeFileSync(join(WORKSPACE, 'book.docx'), 'OLD')
  const res = mockRes()
  await saveRoute.handler(mockReq('POST', '/api/dsh-wordcraft/save?sessionId=s1&path=book.docx', 'NEW-CONTENT'), res)
  assert.equal(res.statusCode, 200)
  assert.equal(readFileSync(join(WORKSPACE, 'book.docx'), 'utf8'), 'NEW-CONTENT')
  console.log('✅ save: overwrite replaces content')
}

// ── bridge page routes ────────────────────────────────────────────────
{
  const res = mockRes()
  await htmlRoute.handler(mockReq('GET', '/api/dsh-wordcraft/app.html'), res)
  await res.done
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Type'], /text\/html/)
  assert.equal(res.headers['Cache-Control'], 'no-cache', 'bridge page revalidates')
  assert.equal(Buffer.concat(res.body).toString('utf8'), '<html>wc-page</html>')

  const res2 = mockRes()
  await jsRoute.handler(mockReq('GET', '/api/dsh-wordcraft/app.js'), res2)
  await res2.done
  assert.equal(res2.statusCode, 200)
  assert.match(res2.headers['Content-Type'], /text\/javascript/)
  assert.equal(Buffer.concat(res2.body).toString('utf8'), '// wc-bridge')

  const res3 = mockRes()
  await htmlRoute.handler(mockReq('POST', '/api/dsh-wordcraft/app.html'), res3)
  assert.equal(res3.statusCode, 405, 'non-GET rejects')
  console.log('✅ app.html/app.js: served no-cache from the committed app/ source')
}

// ── vendor route ──────────────────────────────────────────────────────
{
  const res = mockRes()
  await vendorRoute.handler(mockReq('GET', '/api/dsh-wordcraft/vendor/superdoc.min.js'), res)
  await res.done
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Type'], /text\/javascript/)
  assert.match(res.headers['Cache-Control'], /immutable/, 'vendor assets cache hard')
  assert.equal(Buffer.concat(res.body).toString('utf8'), '// superdoc')

  const res2 = mockRes()
  await vendorRoute.handler(mockReq('GET', '/api/dsh-wordcraft/vendor/superdoc.min.css'), res2)
  await res2.done
  assert.match(res2.headers['Content-Type'], /text\/css/)

  const res3 = mockRes()
  await vendorRoute.handler(mockReq('GET', '/api/dsh-wordcraft/vendor/%2e%2e%2fdsh-host.d.ts'), res3)
  assert.equal(res3.statusCode, 400, 'encoded traversal rejected')

  const res4 = mockRes()
  await vendorRoute.handler(mockReq('GET', '/api/dsh-wordcraft/vendor/missing.js'), res4)
  await res4.done
  assert.equal(res4.statusCode, 404)
  console.log('✅ vendor: MIME + immutable cache + traversal/404')
}

// ── resolve route (presented coordinates → declared path) ─────────────
{
  const sessionQuery = {
    async readEvent({ sessionId, seq }) {
      if (sessionId === 's1' && seq === 7) {
        return {
          target: {
            type: 'deliverables/presented',
            data: { turn: 3, callId: 'c1', files: [{ path: 'reports/demo.docx' }, { path: 'notes.md' }] },
          },
          session: { cwd: WORKSPACE },
        }
      }
      if (sessionId === 's1' && seq === 9) throw new Error('session store offline')
      return { target: { type: 'conversation/message', data: {} } }
    },
  }
  const resolveRoute = createResolveRoute({ sessionQuery })

  const res = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-wordcraft/resolve?sessionId=s1&seq=7&index=0'), res)
  const json = JSON.parse(await readBodyOf(res))
  assert.equal(res.statusCode, 200)
  assert.equal(json.success, true)
  assert.deepEqual(json.data, { sessionId: 's1', path: 'reports/demo.docx', name: 'demo.docx' })

  const res2 = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-wordcraft/resolve?sessionId=s1&seq=7&index=5'), res2)
  assert.equal(res2.statusCode, 404, 'index out of range rejects')

  const res3 = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-wordcraft/resolve?sessionId=s1&seq=7&index=1'), res3)
  assert.equal(res3.statusCode, 200, 'non-document declared files still resolve (client filters)')

  const res4 = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-wordcraft/resolve?sessionId=s1&seq=8&index=0'), res4)
  assert.equal(res4.statusCode, 404, 'non-presented event rejects')

  const res5 = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-wordcraft/resolve?sessionId=s1&seq=abc&index=0'), res5)
  assert.equal(res5.statusCode, 400, 'non-numeric coordinates reject')

  const res6 = mockRes()
  await resolveRoute.handler(mockReq('GET', '/api/dsh-wordcraft/resolve?sessionId=s1&seq=9&index=0'), res6)
  assert.equal(res6.statusCode, 502, 'session store failures surface as 502')

  const res7 = mockRes()
  await resolveRoute.handler(mockReq('POST', '/api/dsh-wordcraft/resolve?sessionId=s1&seq=7&index=0'), res7)
  assert.equal(res7.statusCode, 405, 'non-GET rejects')
  console.log('✅ resolve: happy path + 404/400/405/502 rejections')
}

function readdirSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

rmSync(ROOT, { recursive: true, force: true })
console.log('ALL ROUTE TESTS PASSED')
