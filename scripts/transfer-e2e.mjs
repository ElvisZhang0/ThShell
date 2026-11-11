#!/usr/bin/env node
/**
 * 传输内核的端到端自测：本地起一个真 SFTP 服务端，用真 ssh2 客户端跑
 * 下载 / 上传 / 暂停 / 继续 / 取消 / 断点续传。
 *
 * 为什么要有这个脚本：
 *   暂停、续传这类功能靠"看代码"是验不出来的 —— 数据停没停、断点接没接上，
 *   只有真跑一遍 8MB 才知道。而真跑又不想连生产服务器，所以这里用 ssh2 的
 *   服务端实现搭一个只认密码、只映射本地临时目录的迷你 SFTP。
 *
 * 跑法：`pnpm test:transfer`（不需要网络，不需要任何凭据，跑完自动清理临时目录）
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* --------------------------------------------------- 把 TS 内核转译出来再 import */

/**
 * esbuild 是 vite 的依赖，pnpm 不会把它提升到顶层，直接 `import('esbuild')` 是找不到的。
 * 从 vite 自己的位置去解析，就能命中 .pnpm 里那一份 —— 不用为此多装一个依赖。
 */
const { createRequire } = await import('node:module')
const esbuildPath = createRequire(import.meta.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const ttFile = path.join(os.tmpdir(), `thshell-tt-${process.pid}.mjs`)
await build({
  entryPoints: [path.join(ROOT, 'electron/modules/transfer-task.ts')],
  outfile: ttFile,
  format: 'esm',
  platform: 'node',
  logLevel: 'warning'
})
const TT = await import(pathToFileURL(ttFile).href)

const ssh2 = await import('ssh2')
const { Server, Client, utils } = ssh2.default ?? ssh2
const { STATUS_CODE, OPEN_MODE } = utils.sftp

/* ------------------------------------------------------------ 迷你 SFTP 服务端 */

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
})

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'thshell-e2e-'))
const handles = []

/** SFTP 的 pflags 位掩码 → fs.open 的 flag。APPEND 必须走 'a'，否则续传会覆盖前半段 */
function mapMode(pflags) {
  if (pflags & OPEN_MODE.APPEND) return { flag: 'a', append: true }
  if (pflags & OPEN_MODE.WRITE && pflags & OPEN_MODE.CREAT && pflags & OPEN_MODE.TRUNC) {
    return { flag: 'w', append: false }
  }
  if (pflags & OPEN_MODE.WRITE) return { flag: 'r+', append: false }
  return { flag: 'r', append: false }
}

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on('authentication', (ctx) => ctx.accept())
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp()
        const newHandle = (fd, append) => {
          const h = Buffer.alloc(4)
          h.writeUInt32BE(handles.length, 0)
          handles.push({ fd, append })
          return h
        }
        const get = (h) => handles[h.readUInt32BE(0)]

        const statOf = (reqid, p) => {
          fs.stat(p, (err, st) => {
            if (err) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            sftp.attrs(reqid, {
              mode: st.isDirectory() ? 0o040755 : 0o100644,
              size: st.size,
              uid: 0,
              gid: 0,
              atime: Math.floor(st.atimeMs / 1000),
              mtime: Math.floor(st.mtimeMs / 1000)
            })
          })
        }

        sftp.on('REALPATH', (reqid, p) =>
          sftp.name(reqid, [{ filename: p, longname: p, attrs: {} }])
        )
        sftp.on('STAT', statOf)
        sftp.on('LSTAT', statOf)

        sftp.on('OPEN', (reqid, filename, pflags) => {
          const { flag, append } = mapMode(pflags)
          fs.open(filename, flag, (err, fd) => {
            if (err) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            sftp.handle(reqid, newHandle(fd, append))
          })
        })

        sftp.on('READ', (reqid, handle, offset, len) => {
          const h = get(handle)
          const buf = Buffer.alloc(len)
          fs.read(h.fd, buf, 0, len, offset, (err, n) => {
            if (err) return sftp.status(reqid, STATUS_CODE.FAILURE)
            if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF)
            sftp.data(reqid, buf.subarray(0, n))
          })
        })

        sftp.on('WRITE', (reqid, handle, offset, payload) => {
          const h = get(handle)
          // 追加模式必须传 null 作 position，否则服务端会按绝对偏移写，把前面覆盖掉
          fs.write(h.fd, payload, 0, payload.length, h.append ? null : offset, (err) =>
            sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK)
          )
        })

        sftp.on('CLOSE', (reqid, handle) => {
          fs.close(get(handle).fd, () => sftp.status(reqid, STATUS_CODE.OK))
        })

        sftp.on('REMOVE', (reqid, p) =>
          fs.unlink(p, (err) =>
            sftp.status(reqid, err ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.OK)
          )
        )

        sftp.on('RENAME', (reqid, from, to) =>
          fs.rename(from, to, (err) => sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK))
        )

        sftp.on('MKDIR', (reqid, p) =>
          fs.mkdir(p, { recursive: true }, (err) =>
            sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK)
          )
        )
      })
    })
  })
})

/* ---------------------------------------------------------------------- 工具 */

let pass = 0
let fail = 0
function check(name, ok, note = '') {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${note ? '：' + note : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MB = 1024 * 1024

function connect(port) {
  return new Promise((resolve, reject) => {
    const c = new Client()
    c.on('ready', () => c.sftp((err, sftp) => (err ? reject(err) : resolve({ c, sftp }))))
    c.on('error', reject)
    c.connect({ host: '127.0.0.1', port, username: 'test', password: 'test' })
  })
}

/* ---------------------------------------------------------------------- 测试 */

const PORT = 22331
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const { c: client, sftp } = await connect(PORT)

const SRC = path.join(WORK, 'src.bin')
const data = crypto.randomBytes(8 * MB)
fs.writeFileSync(SRC, data)

console.log('\n[1] 下载 + 暂停 + 继续')
{
  const dst = path.join(WORK, 'out1.bin')
  let moved = 0
  const ctl = new TT.TransferControl('t1')
  const run = TT.pipeFile({
    sftp,
    direction: 'download',
    from: SRC,
    to: dst,
    total: data.length,
    ctl,
    onBytes: (n) => {
      moved += n
    }
  })
  while (moved < 2 * MB) await sleep(5)
  ctl.pause()
  const atPause = moved
  await sleep(700)
  const frozen = Math.abs(moved - atPause) <= 128 * 1024 // 最多再飞进一块
  ctl.resume()
  await run
  check('暂停后确实不再传', frozen, `停在 ${(atPause / MB).toFixed(1)}MB`)
  check('继续后传完', moved === data.length, `${moved} 字节`)
  check('文件内容一致', Buffer.compare(fs.readFileSync(dst), data) === 0)
  check('没有残留 .part', !fs.existsSync(dst + '.part'))
}

console.log('\n[2] 断点续传（本地 .part 已有 3MB）')
{
  const dst = path.join(WORK, 'out2.bin')
  fs.writeFileSync(dst + '.part', data.subarray(0, 3 * MB))
  let moved = 0
  let resumeAt = -1
  await TT.pipeFile({
    sftp,
    direction: 'download',
    from: SRC,
    to: dst,
    total: data.length,
    ctl: new TT.TransferControl('t2'),
    onResume: (s) => {
      resumeAt = s
    },
    onBytes: (n) => {
      moved += n
    }
  })
  check('从断点 3MB 起', resumeAt === 3 * MB, `起点 ${resumeAt}`)
  check('只传了剩下的 5MB', moved === data.length - 3 * MB, `${moved} 字节`)
  check('拼接后内容正确', Buffer.compare(fs.readFileSync(dst), data) === 0)
}

console.log('\n[3] 取消')
{
  const dst = path.join(WORK, 'out3.bin')
  let moved = 0
  const ctl = new TT.TransferControl('t3')
  const run = TT.pipeFile({
    sftp,
    direction: 'download',
    from: SRC,
    to: dst,
    total: data.length,
    ctl,
    onBytes: (n) => {
      moved += n
    }
  }).then(
    () => 'resolved',
    (e) => (e?.name === 'TransferCanceled' ? 'canceled' : 'other:' + e.message)
  )
  while (moved < MB) await sleep(5)
  ctl.cancel()
  const outcome = await run
  await TT.dropPart('download', sftp, dst)
  check('取消以 TransferCanceled 结束', outcome === 'canceled', outcome)
  check('取消后半成品已清掉', !fs.existsSync(dst + '.part') && !fs.existsSync(dst))
}

console.log('\n[4] 上传')
{
  const up = path.join(WORK, 'up1.bin')
  let moved = 0
  await TT.pipeFile({
    sftp,
    direction: 'upload',
    from: SRC,
    to: up,
    total: data.length,
    ctl: new TT.TransferControl('t4'),
    onBytes: (n) => {
      moved += n
    }
  })
  check('上传字节数正确', moved === data.length, `${moved} 字节`)
  check('远端内容一致', Buffer.compare(fs.readFileSync(up), data) === 0)
  check('远端没有残留 .part', !fs.existsSync(up + '.part'))
}

console.log('\n[5] 上传续传（远端 .part 已有 2MB）')
{
  const up = path.join(WORK, 'up2.bin')
  fs.writeFileSync(up + '.part', data.subarray(0, 2 * MB))
  let resumeAt = -1
  await TT.pipeFile({
    sftp,
    direction: 'upload',
    from: SRC,
    to: up,
    total: data.length,
    ctl: new TT.TransferControl('t5'),
    onResume: (s) => {
      resumeAt = s
    },
    onBytes: () => {}
  })
  check('远端断点被识别', resumeAt === 2 * MB, `起点 ${resumeAt}`)
  check('续传后内容正确', Buffer.compare(fs.readFileSync(up), data) === 0)
}

console.log('\n[6] 任务注册表（界面点按钮靠的就是它）')
{
  const ctl = new TT.TransferControl('t6')
  TT.registerTask(ctl)
  check('注册后能按 id 暂停', TT.pauseTask('t6') && ctl.paused)
  check('能按 id 继续', TT.resumeTask('t6') && !ctl.paused)
  check('能按 id 取消', TT.cancelTask('t6') && ctl.canceled)
  TT.unregisterTask('t6')
  check('注销后找不到', TT.pauseTask('t6') === false)
}

client.end()
server.close()
fs.rmSync(WORK, { recursive: true, force: true })
fs.rmSync(ttFile, { force: true })

console.log(`\n结果：${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
