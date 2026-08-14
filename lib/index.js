// dsh-download-progress host half
//
// 职责：
// - /api/download-progress/* HTTP 路由：面板查询/发起下载/取消/清理
// - 注册 download_url / download_status 两个模型工具
// - 传输状态引擎：URL 下载（curl 子进程 + HEAD 总大小 + 文件轮询）、
//   ssh_download/ssh_upload 工具追踪、pwsh/bash 中 curl/iwr/wget 命令解析、
//   工作区文件增长监控（黑箱下载兜底）
//
// 仅依赖 cordis 注入服务（webServer/timer），其余服务按需 ctx.get：
// fs、subprocess、sandboxPolicy、workspaceRegistry、tools。

export const name = 'dsh-download-progress'

export const inject = ['timer', 'webServer']

export function apply(ctx) {
  const fs = ctx.get('fs')
  const subprocess = ctx.get('subprocess')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const tools = ctx.get('tools')

  const transfers = new Map()
  const downloadSpawns = new Map()
  const liveHandles = new Set()
  let seq = 0
  let seq2 = 0
  let ticking = false

  const now = () => Date.now()
  const rootsP = workspaceRoots()
  const rootP = rootsP.then((roots) => roots[0] || '.')

  const fsWatch = { roots: [], busy: false }

  // ---- 小工具 ----

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let v = n
    let i = 0
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
    return (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[i]
  }

  function basename(p) {
    if (typeof p !== 'string') return ''
    const s = p.replace(/[\\/]+$/, '')
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
    return i >= 0 ? s.slice(i + 1) : s
  }

  function safeNameFromUrl(u) {
    let s = String(u || '')
    const q = s.indexOf('?')
    if (q >= 0) s = s.slice(0, q)
    const h = s.indexOf('#')
    if (h >= 0) s = s.slice(0, h)
    s = basename(s)
    try { s = decodeURIComponent(s) } catch (e) { /* 保留原样 */ }
    s = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
    return s || 'download.bin'
  }

  function isAbsolutePath(p) {
    if (typeof p !== 'string') return false
    return /^[A-Za-z]:[\\/]/.test(p) || p.charAt(0) === '/' || p.slice(0, 2) === '\\\\'
  }

  // 工作区根目录列表：优先 workspaceRegistry（GUI 工作区），
  // 兜底 sandboxPolicy.workspaceRoot，再兜底进程 cwd。
  async function workspaceRoots() {
    const list = []
    const add = (p) => {
      if (typeof p !== 'string' || p === '') return
      const norm = p.replace(/[\\/]+$/, '')
      let found = false
      for (const x of list) { if (x.toLowerCase() === norm.toLowerCase()) { found = true; break } }
      if (!found) list.push(norm)
    }
    if (workspaceRegistry && typeof workspaceRegistry.list === 'function') {
      try {
        const ws = workspaceRegistry.list()
        if (Array.isArray(ws)) {
          for (const w of ws) {
            if (w && typeof w.path === 'string') add(w.path)
          }
        }
      } catch (e) {
        console.error('[dsh-download-progress] workspaceRegistry.list failed:', e)
      }
    }
    if (list.length === 0 && sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) {
      add(sandboxPolicy.workspaceRoot)
    }
    if (list.length === 0 && fs) {
      try { add(fs.processPath(await fs.resolve('.'))) } catch (e) { /* 忽略 */ }
    }
    if (list.length === 0) list.push('.')
    return list
  }

  async function statBytes(target, bytesStart) {
    if (!target || !fs) return null
    try {
      const info = await fs.stat(target)
      if (info && typeof info.size === 'number') return Math.max(0, info.size - (bytesStart || 0))
    } catch (e) { /* 文件尚未创建 */ }
    return null
  }

  // 从 pwsh/bash 命令中解析下载目标与 URL（黑箱监控之外的精确通道）。
  function parseShellDownload(cmd, workdir, root) {
    if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > 20000) return null
    const isCurl = /(?:^|[\s;&|])curl(?:\.exe)?\b/i.test(cmd)
    const isIwr = /(?:^|[\s;&|])(?:iwr|invoke-webrequest)\b/i.test(cmd)
    const isWget = /(?:^|[\s;&|])wget(?:\.exe)?\b/i.test(cmd)
    if (!isCurl && !isIwr && !isWget) return null
    const urls = cmd.match(/https?:\/\/[^\s"'`$;)]+/gi) || []
    const rawUrl = urls.length ? urls[0] : null
    let dest = null
    if (isCurl) {
      let m = cmd.match(/(?:^|[\s;&|])--output[=\s]+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/i)
      if (m) dest = m[1] || m[2] || m[3]
      if (!dest) {
        m = cmd.match(/(?:^|[\s;&|])-o\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/)
        if (m) dest = m[1] || m[2] || m[3]
      }
      if (!dest) return null
    } else if (isIwr) {
      const m = cmd.match(/(?:^|[\s;&|])-OutFile\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/i)
      if (!m) return null
      dest = m[1] || m[2] || m[3]
    } else {
      const m = cmd.match(/(?:^|[\s;&|])-O\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/)
      if (m) dest = m[1] || m[2] || m[3]
      else if (rawUrl) dest = basename(rawUrl)
      else return null
    }
    if (typeof dest !== 'string' || dest.length === 0 || dest.charAt(0) === '-') return null
    if (/[${}`()]/.test(dest)) return null
    let destPath = dest.trim()
    if (!isAbsolutePath(destPath)) {
      const base = typeof workdir === 'string' && workdir && !/[${}`()]/.test(workdir) ? workdir : root
      destPath = String(base).replace(/[\\/]+$/, '') + '\\' + destPath
    }
    const url = rawUrl && !/[${}`()]/.test(rawUrl) ? rawUrl : null
    return { dest: destPath, url: url }
  }

  // ---- 传输状态（对外只暴露叶子字段）----

  function snapItem(t) {
    if (t.hidden) return null
    return {
      id: t.id,
      kind: t.kind,
      source: t.source,
      label: t.label,
      url: t.url || null,
      alias: t.alias || null,
      remotePath: t.remotePath || null,
      localPath: t.localPath || null,
      dest: t.dest || null,
      status: t.status,
      bytes: t.bytes,
      total: t.total,
      percent: t.percent,
      speed: t.speed,
      etaSec: t.etaSec,
      elapsedMs: t.elapsedMs,
      error: t.error || null,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
    }
  }

  function snapshot() {
    const list = []
    for (const t of transfers.values()) {
      const s = snapItem(t)
      if (s) list.push(s)
    }
    list.sort((a, b) => b.startedAt - a.startedAt)
    return list.slice(0, 40)
  }

  function prune() {
    const cutoff = now() - 10 * 60 * 1000
    for (const [id, t] of transfers) {
      if (t.status !== 'active' && t.finishedAt && t.finishedAt < cutoff) transfers.delete(id)
    }
    while (transfers.size > 40) {
      let oldest = null
      for (const t of transfers.values()) {
        if (t.status !== 'active' && (oldest === null || t.startedAt < oldest.startedAt)) oldest = t
      }
      if (oldest === null) break
      transfers.delete(oldest.id)
    }
  }

  function makeTransfer(extra) {
    return {
      id: extra.id, kind: extra.kind, source: extra.source,
      label: extra.label,
      url: extra.url || null, dest: extra.dest || null,
      alias: extra.alias || null, remotePath: extra.remotePath || null,
      localPath: extra.localPath || null,
      status: 'active', bytes: 0, bytesStart: 0, total: null,
      percent: null, speed: null, etaSec: null, elapsedMs: 0,
      error: null, startedAt: now(), finishedAt: null,
      target: null, lastBytes: 0, lastSampleAt: 0,
      shellEndedAt: null, stableTicks: 0, hidden: extra.hidden || false,
    }
  }

  async function finalizeShellDone(t) {
    if (t.status !== 'active') return
    if (t.hidden) {
      // 小于阈值的 shell 下载静默丢弃，不进入面板
      transfers.delete(t.id)
      return
    }
    t.status = 'done'
    const finalBytes = await statBytes(t.target, t.bytesStart)
    if (finalBytes !== null && finalBytes > t.bytes) t.bytes = finalBytes
    if (t.kind === 'download' && typeof t.total === 'number' && t.total > 0) { t.percent = 100; t.bytes = t.total }
    t.finishedAt = now()
    t.elapsedMs = t.finishedAt - t.startedAt
    t.speed = null
    t.etaSec = null
    t.shellEndedAt = null
  }

  // ---- 工具调用追踪（ssh_* 与 pwsh/bash）----

  ctx.on('tools/execute', (exec, next) => {
    try {
      if (!exec) return
      const args = exec && typeof exec === 'object' ? exec.arguments : undefined
      if (exec.name === 'ssh_download' || exec.name === 'ssh_upload') {
        if (args && typeof args === 'object' && typeof args.localPath === 'string') {
          const id = 'ssh-' + String(exec.callId)
          if (!transfers.has(id)) {
            const kind = exec.name === 'ssh_upload' ? 'upload' : 'download'
            const t = makeTransfer({
              id, kind, source: 'ssh',
              label: basename(kind === 'upload' ? args.localPath : args.remotePath),
              alias: typeof args.alias === 'string' ? args.alias : '',
              remotePath: typeof args.remotePath === 'string' ? args.remotePath : '',
              localPath: args.localPath,
            })
            transfers.set(id, t)
            if (fs) {
              fs.resolve(args.localPath).then((target) => {
                t.target = target
                return fs.stat(target)
              }).then((info) => {
                if (info && typeof info.size === 'number') {
                  t.bytesStart = info.size
                  if (kind === 'upload') t.total = info.size
                }
              }).catch(() => { /* 忽略 */ })
            }
          }
        }
      } else if (exec.name === 'pwsh' || exec.name === 'bash') {
        if (args && typeof args === 'object' && typeof args.command === 'string') {
          let sessCwd = null
          try {
            sessCwd = exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.cwd : null
          } catch (e) { /* 忽略 */ }
          const rootFor = typeof sessCwd === 'string' && sessCwd ? Promise.resolve(sessCwd.replace(/[\\/]+$/, '')) : rootP
          rootFor.then((root) => {
            const parsed = parseShellDownload(args.command, args.workdir, root)
            if (!parsed) return
            const id = 'shell-' + String(exec.callId)
            if (transfers.has(id)) return
            const t = makeTransfer({
              id, kind: 'download', source: 'shell',
              label: basename(parsed.dest),
              url: parsed.url, dest: parsed.dest, localPath: parsed.dest,
              hidden: true,
            })
            transfers.set(id, t)
            if (fs) {
              fs.resolve(parsed.dest).then((target) => {
                t.target = target
                return fs.stat(target)
              }).then((info) => {
                if (info && typeof info.size === 'number') t.bytesStart = info.size
              }).catch(() => { /* 忽略 */ })
            }
            if (subprocess && parsed.url) {
              subprocess.resolveExecutable('curl').then((exe) => {
                return headContentLength(exe, parsed.url, root)
              }).then((total) => {
                if (total === null) return
                t.total = total
                if (t.status === 'active' && t.hidden && total >= 65536) t.hidden = false
              }).catch(() => { /* 忽略 */ })
            }
          }).catch(() => { /* 忽略 */ })
        }
      }
    } catch (e) {
      console.error('[dsh-download-progress] tools/execute listener failed:', e)
    }
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec) return
      const id1 = 'ssh-' + String(exec.callId)
      const id2 = 'shell-' + String(exec.callId)
      const t = transfers.get(id1) || transfers.get(id2)
      if (!t || t.status !== 'active') return
      const failed = !!(result && result.isError)
      if (t.source === 'shell' && !failed) {
        // 后台任务此时可能仍在传输，完成判定交给静止检测（tick）
        t.shellEndedAt = now()
        return
      }
      t.status = failed ? 'error' : 'done'
      if (failed) t.error = '工具执行失败'
      t.finishedAt = now()
      t.elapsedMs = t.finishedAt - t.startedAt
      t.speed = null
      t.etaSec = null
      if (!failed && t.kind === 'download') {
        statBytes(t.target, t.bytesStart).then((finalBytes) => {
          if (finalBytes !== null && t.status === 'done') t.bytes = finalBytes
        }).catch(() => { /* 忽略 */ })
      }
    } catch (e) {
      console.error('[dsh-download-progress] tools/result listener failed:', e)
    }
  })

  // ---- 轮询：字节/速度/百分比/ETA + shell 静止判定 ----

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const active = []
      for (const t of transfers.values()) if (t.status === 'active' && t.source !== 'fs') active.push(t)
      if (active.length === 0) return
      const t0 = now()
      for (const t of active) {
        t.elapsedMs = t0 - t.startedAt
        const prevBytes = t.lastBytes
        const prevSampleAt = t.lastSampleAt
        let bytes = t.bytes
        const sampled = await statBytes(t.target, t.bytesStart)
        if (sampled !== null) bytes = sampled
        const sampleAt = now()
        if (prevSampleAt > 0 && sampleAt > prevSampleAt && bytes >= prevBytes) {
          const instant = ((bytes - prevBytes) / (sampleAt - prevSampleAt)) * 1000
          t.speed = t.speed === null ? instant : t.speed * 0.6 + instant * 0.4
        }
        t.lastBytes = bytes
        t.lastSampleAt = sampleAt
        t.bytes = bytes
        // 只有下载任务计算百分比；上传无总大小可观测，保持不定进度
        if (t.kind === 'download' && typeof t.total === 'number' && t.total > 0) {
          t.percent = Math.min(99.9, Math.max(0, (bytes / t.total) * 100))
          if (t.percent > 0) t.etaSec = (t.elapsedMs / 1000) * (100 / t.percent - 1)
        }
        if (t.source === 'shell' && t.hidden) {
          if (bytes >= 65536 || (typeof t.total === 'number' && t.total >= 65536)) t.hidden = false
        }
        if (t.source === 'shell' && t.shellEndedAt) {
          if (prevSampleAt >= t.shellEndedAt && bytes === prevBytes) t.stableTicks += 1
          else t.stableTicks = 0
          const quietMs = sampleAt - t.shellEndedAt
          // 连续 10 个采样（约 4s）无增长且已有数据才判完成；30s 兜底
          if ((t.stableTicks >= 10 && quietMs >= 4000 && bytes > 0) || quietMs >= 30000) {
            await finalizeShellDone(t)
          }
        }
      }
    } catch (e) {
      console.error('[dsh-download-progress] tick failed:', e)
    } finally {
      ticking = false
    }
  }
  ctx.interval(tick, 400)

  // ---- 黑箱监控：工作区顶层文件/新目录增长 ----

  async function dirSize(target, cap) {
    let total = 0
    let files = 0
    const queue = [target]
    while (queue.length > 0 && files < cap) {
      const cur = queue.pop()
      let entries
      try { entries = await fs.listDir(cur) } catch (e) { continue }
      for (const e of entries) {
        if (files >= cap) break
        if (e.type === 'file') { total += e.size || 0; files += 1 }
        else if (e.type === 'directory') queue.push(e.target)
      }
    }
    return total
  }

  function fsActiveCount() {
    let n = 0
    for (const t of transfers.values()) if (t.source === 'fs' && t.status === 'active') n += 1
    return n
  }

  function isTrackedLocalPath(rtPath, name) {
    const want = (rtPath + '\\' + name).toLowerCase()
    for (const t of transfers.values()) {
      if (t.status === 'active' && typeof t.localPath === 'string' && t.localPath.toLowerCase() === want) return true
    }
    return false
  }

  function finalizeFs(rec, size) {
    const t = transfers.get(rec.recId)
    rec.recId = null
    rec.quiet = 0
    if (!t || t.status !== 'active') return
    t.status = 'done'
    t.bytes = size
    t.finishedAt = now()
    t.elapsedMs = t.finishedAt - t.startedAt
    t.speed = null
    t.etaSec = null
  }

  async function scanRoot(rt) {
    let entries
    try { entries = await fs.listDir(rt.target) } catch (e) { return }
    const t0 = now()
    const seen = new Set()
    for (const e of entries) {
      if (!e || typeof e.name !== 'string' || e.name === '') continue
      if (e.name.charAt(0) === '.') continue
      if (e.name === 'node_modules') continue
      seen.add(e.name)
      const prev = rt.entries.get(e.name)
      let size = null
      if (e.type === 'file' && typeof e.size === 'number') {
        size = e.size
      } else if (e.type === 'directory') {
        if (!prev || (prev.recId && transfers.get(prev.recId) && transfers.get(prev.recId).status === 'active')) {
          size = await dirSize(e.target, 500)
        } else {
          continue
        }
      } else {
        continue
      }
      if (!prev) {
        rt.entries.set(e.name, { size: size, recId: null, quiet: 0, lastAt: t0 })
        continue
      }
      const rec = prev.recId ? transfers.get(prev.recId) : null
      if (rec && rec.status === 'active') {
        if (size > prev.size) {
          const dt = Math.max(1, t0 - prev.lastAt)
          const instant = ((size - prev.size) / dt) * 1000
          rec.bytes = size
          rec.speed = rec.speed === null ? instant : rec.speed * 0.6 + instant * 0.4
          rec.elapsedMs = t0 - rec.startedAt
          prev.quiet = 0
          prev.lastAt = t0
        } else {
          prev.quiet += 1
          if (prev.quiet >= 3) finalizeFs(prev, size)
        }
        prev.size = size
        continue
      }
      if (prev.recId && (!rec || rec.status !== 'active')) prev.recId = null
      const grew = size >= prev.size + 65536
      if (grew && size >= 65536 && fsActiveCount() < 3 && !isTrackedLocalPath(rt.path, e.name)) {
        const id = 'fs-' + (++seq2)
        const isDir = e.type === 'directory'
        const t = makeTransfer({
          id, kind: 'download', source: 'fs',
          label: isDir ? e.name + ' (目录)' : e.name,
          localPath: rt.path + '\\' + e.name,
        })
        transfers.set(id, t)
        t.bytes = size
        prev.recId = id
        prev.quiet = 0
        prev.lastAt = t0
      }
      prev.size = size
    }
    for (const [name, rec] of rt.entries) {
      if (!seen.has(name)) {
        if (rec.recId) finalizeFs(rec, rec.size)
        rt.entries.delete(name)
      }
    }
  }

  async function watchTick() {
    if (!fs || fsWatch.busy) return
    fsWatch.busy = true
    try {
      if (fsWatch.roots.length === 0) {
        const roots = await rootsP
        for (const path of roots) {
          try {
            const target = await fs.resolve(path)
            fsWatch.roots.push({ path: path, target: target, entries: new Map() })
          } catch (e) {
            console.error('[dsh-download-progress] watch root resolve failed:', path, e)
          }
        }
      }
      for (const rt of fsWatch.roots) {
        await scanRoot(rt)
      }
    } catch (e) {
      console.error('[dsh-download-progress] watchTick failed:', e)
    } finally {
      fsWatch.busy = false
    }
  }
  ctx.interval(watchTick, 1500)

  // ---- curl 子进程下载引擎 ----

  function collectText(handle, stream) {
    try {
      if (!handle || !handle.collected || !handle.collected[stream]) return ''
      const read = handle.collected[stream].readFrom(0)
      return read && typeof read.text === 'string' ? read.text : ''
    } catch (e) {
      return ''
    }
  }

  async function headContentLength(exe, url, root) {
    let handle
    try {
      handle = subprocess.spawn({
        argv: [exe, '-sS', '-L', '-I', '--connect-timeout', '15', '--', url],
        cwd: root,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 16384 } },
        graceMs: 5000,
      })
    } catch (e) {
      return null
    }
    liveHandles.add(handle)
    try {
      const outcome = await handle.done
      if (!outcome || outcome.exitCode !== 0) return null
      const text = collectText(handle, 'stdout')
      const matches = text.match(/content-length:\s*(\d+)/gi)
      if (!matches || matches.length === 0) return null
      const num = parseInt(matches[matches.length - 1].replace(/[^\d]/g, ''), 10)
      return Number.isFinite(num) && num > 0 ? num : null
    } catch (e) {
      return null
    } finally {
      liveHandles.delete(handle)
    }
  }

  async function startDownload(args) {
    const url = args && typeof args.url === 'string' ? args.url : ''
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL 必须以 http:// 或 https:// 开头' }
    if (!subprocess) return { ok: false, error: 'subprocess 服务不可用' }
    const root = await rootP
    let destPath
    if (args && typeof args.dest === 'string' && args.dest.trim() !== '') {
      const d = args.dest.trim()
      destPath = isAbsolutePath(d) ? d : root + '\\' + d
    } else {
      destPath = root + '\\' + safeNameFromUrl(url)
    }
    let exe
    try {
      exe = await subprocess.resolveExecutable('curl')
    } catch (e) {
      return { ok: false, error: '未找到 curl 可执行文件（Windows 10+ 自带 curl.exe）' }
    }
    const id = 'dl-' + (++seq)
    const t = makeTransfer({
      id, kind: 'download', source: 'url',
      label: (args && typeof args.label === 'string' && args.label.trim()) ? args.label.trim() : safeNameFromUrl(url),
      url, dest: destPath, localPath: destPath,
    })
    transfers.set(id, t)
    if (fs) {
      fs.resolve(destPath).then((target) => { t.target = target }).catch(() => { /* 忽略 */ })
    }
    headContentLength(exe, url, root).then((total) => {
      if (total === null) return
      t.total = total
      if (t.status === 'done') { t.percent = 100; t.bytes = total }
    }).catch(() => { /* 忽略 */ })
    let handle
    try {
      handle = subprocess.spawn({
        argv: [exe, '-sS', '-L', '-f', '--retry', '1', '--connect-timeout', '15', '-o', destPath, '--', url],
        cwd: root,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 65536 } },
        graceMs: 5000,
      })
    } catch (e) {
      t.status = 'error'
      t.error = '无法启动 curl：' + String(e && e.message ? e.message : e)
      t.finishedAt = now()
      t.elapsedMs = t.finishedAt - t.startedAt
      return { ok: false, id: id, dest: destPath, error: t.error }
    }
    downloadSpawns.set(id, handle)
    liveHandles.add(handle)
    handle.done.then(async (outcome) => {
      liveHandles.delete(handle)
      downloadSpawns.delete(id)
      if (t.status !== 'active') return
      const ok = outcome && outcome.exitCode === 0
      t.status = ok ? 'done' : 'error'
      if (!ok) {
        const tail = collectText(handle, 'stderr').replace(/\r+/g, ' ').trim()
        t.error = 'curl 退出码 ' + (outcome ? outcome.exitCode : '?') + (tail ? '：' + tail.slice(-300) : '')
      } else {
        const finalBytes = await statBytes(t.target, t.bytesStart)
        if (finalBytes !== null) t.bytes = finalBytes
        if (t.kind === 'download' && typeof t.total === 'number' && t.total > 0) { t.percent = 100; t.bytes = t.total }
      }
      t.finishedAt = now()
      t.elapsedMs = t.finishedAt - t.startedAt
      t.speed = null
      t.etaSec = null
    }).catch((e) => {
      liveHandles.delete(handle)
      downloadSpawns.delete(id)
      if (t.status !== 'active') return
      t.status = 'error'
      t.error = '下载进程异常：' + String(e && e.message ? e.message : e)
      t.finishedAt = now()
      t.elapsedMs = t.finishedAt - t.startedAt
    })
    return { ok: true, id: id, dest: destPath, label: t.label }
  }

  // ---- 生命周期清理：插件停止时终止所有在跑的 curl 进程 ----

  ctx.effect(() => () => {
    for (const h of liveHandles) {
      try { h.terminate() } catch (e) { /* 忽略 */ }
    }
    liveHandles.clear()
    downloadSpawns.clear()
  }, 'dsh-download-progress: cleanup spawns')

  ctx.interval(prune, 30000)

  // ---- HTTP 路由（面板 RPC）----

  function readBody(req, limit = 1 << 20) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > limit) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve(raw ? JSON.parse(raw) : {})
        } catch (e) {
          reject(new Error('invalid JSON body: ' + e.message))
        }
      })
      req.on('error', reject)
    })
  }

  function json(res, code, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/download-progress',
    handler: async (req, res) => {
      const u = new URL(req.url, 'http://localhost')
      const path = u.pathname.replace(/\/+$/, '')
      try {
        if (req.method === 'GET' && path === '/api/download-progress/state') {
          json(res, 200, { ok: true, data: snapshot() })
          return
        }
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed: ' + req.method })
          return
        }
        const body = await readBody(req)
        switch (path) {
          case '/api/download-progress/download': {
            const result = await startDownload(body && typeof body === 'object' ? body : {})
            json(res, 200, result)
            return
          }
          case '/api/download-progress/cancel': {
            const id = body && typeof body.id === 'string' ? body.id : ''
            const t = transfers.get(id)
            if (!t) { json(res, 200, { ok: false, error: '未找到该传输任务' }); return }
            if (t.source !== 'url') { json(res, 200, { ok: false, error: '该任务无法从面板取消，请中断对应的工具调用' }); return }
            const h = downloadSpawns.get(id)
            if (!h) { json(res, 200, { ok: false, error: '该下载不在进行中' }); return }
            try { h.terminate() } catch (e) { /* 忽略 */ }
            t.status = 'canceled'
            t.finishedAt = now()
            t.elapsedMs = t.finishedAt - t.startedAt
            t.speed = null
            t.etaSec = null
            downloadSpawns.delete(id)
            json(res, 200, { ok: true })
            return
          }
          case '/api/download-progress/dismiss': {
            const id = body && typeof body.id === 'string' ? body.id : ''
            const t = transfers.get(id)
            if (!t) { json(res, 200, { ok: true }); return }
            if (t.status === 'active') { json(res, 200, { ok: false, error: '进行中的任务不能关闭' }); return }
            transfers.delete(id)
            json(res, 200, { ok: true })
            return
          }
          case '/api/download-progress/clear-finished': {
            for (const [id, t] of transfers) {
              if (t.status !== 'active') transfers.delete(id)
            }
            json(res, 200, { ok: true })
            return
          }
          default:
            json(res, 404, { ok: false, error: 'unknown action: ' + path })
        }
      } catch (e) {
        try {
          json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
        } catch (e2) { /* response already closed */ }
      }
    },
  }), 'dsh-download-progress: http routes')

  // ---- 模型工具 ----

  if (tools && typeof tools.register === 'function') {
    const downloadTool = {
      name: 'download_url',
      description: '后台下载一个 HTTP(S) URL 到本机工作区，带实时进度（百分比/速度/预计剩余时间），完成后可用 download_status 确认。目标目录必须已存在；dest 省略时保存到工作区根目录并按 URL 文件名命名。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要下载的完整 http(s) URL' },
          dest: { type: 'string', description: '目标文件路径（绝对路径，或相对工作区根目录的路径）；省略则使用 URL 中的文件名' },
          label: { type: 'string', description: '可选：面板中显示的友好名称' },
        },
        required: ['url'],
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            dest: { type: 'string' },
            label: { type: 'string' },
            error: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (args, value) => {
          if (value && value.ok) {
            return [{ type: 'text', text: '下载已启动：' + (value.label || '') + ' → ' + (value.dest || '') + '（任务 id: ' + (value.id || '') + '）。可调用 download_status 查询进度。' }]
          }
          return [{ type: 'text', text: '启动下载失败：' + (value && value.error ? value.error : '未知错误') }]
        },
      },
      async execute(args, exec) {
        return startDownload(args && typeof args === 'object' ? args : {})
      },
    }
    ctx.effect(() => tools.register(downloadTool), 'dsh-download-progress: tool download_url')

    const statusTool = {
      name: 'download_status',
      description: '查询当前所有下载/传输任务的实时进度（本插件的 URL 下载、agent 用 curl/iwr/wget 的下载、dsh-ssh 的文件传输、以及工作区中自动捕捉到的黑箱下载/文件增长均会被追踪）。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'array', items: { type: 'object' } },
        render: (args, value) => {
          const rows = Array.isArray(value) ? value : []
          if (rows.length === 0) return [{ type: 'text', text: '当前没有下载任务。' }]
          const lines = rows.map((r) => {
            const pct = typeof r.percent === 'number' ? r.percent.toFixed(1) + '%' : ''
            const bytes = r.bytes ? fmtBytes(r.bytes) : ''
            const speed = typeof r.speed === 'number' && r.speed > 0 ? fmtBytes(r.speed) + '/s' : ''
            const eta = typeof r.etaSec === 'number' && r.etaSec > 0 ? Math.round(r.etaSec) + 's' : ''
            const bits = ['[' + r.id + ']', r.label || '', r.status]
            if (pct) bits.push(pct)
            if (bytes) bits.push(bytes)
            if (speed) bits.push(speed)
            if (eta) bits.push('预计剩余 ' + eta)
            if (r.error) bits.push('错误：' + r.error)
            return '- ' + bits.join(' ')
          })
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        return snapshot()
      },
    }
    ctx.effect(() => tools.register(statusTool), 'dsh-download-progress: tool download_status')
  }
}
