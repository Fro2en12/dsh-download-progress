// dsh-download-progress client half（AMD bundle，__ModuleLoader__ 格式）
// 仅在浏览器中执行；Node 环境跳过。
// 在 shell.overlay 浮层注册右下角「下载进度」面板：
// - 胶囊按钮/面板均可拖拽（延迟指针捕获，点击与拖动分离）
// - 输入 URL 直接下载；列表展示所有传输任务实时进度
// - 通过 fetch('/api/download-progress/*') 与 host 半部分通信
if (typeof window !== 'undefined') {
  window.__ModuleLoader__.load({
    id: 'dsh-download-progress',
    factory: (require) => {
      const react = require('react')
      const h = react.createElement

      // ---- 样式注入（data-plugin-css 官方模式）----
      const CSS_ID = 'dsh-download-progress/panel.css'
      const cssText = [
        '.dlp-root{position:fixed;inset:0;z-index:60;pointer-events:none;font-family:inherit;font-size:12px}',
        '.dlp-root *{box-sizing:border-box}',
        '.dlp-pill,.dlp-card{pointer-events:auto;position:fixed;right:16px;bottom:16px}',
        '.dlp-pill{display:flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:8px 14px;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:12px;line-height:1}',
        '.dlp-pill:hover{border-color:var(--dsw-alias-brand-primary)}',
        '.dlp-pill:active{cursor:grabbing}',
        '.dlp-card{width:368px;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.35)}',
        '.dlp-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}',
        '.dlp-head:active{cursor:grabbing}',
        '.dlp-title{font-weight:600;color:var(--dsw-alias-label-primary);font-size:13px}',
        '.dlp-badge{background:var(--dsw-alias-brand-primary);color:#fff;border-radius:999px;padding:1px 8px;font-size:11px}',
        '.dlp-spacer{flex:1}',
        '.dlp-ghost{background:transparent;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer}',
        '.dlp-ghost:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
        '.dlp-inputs{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.dlp-row{display:flex;gap:6px}',
        '.dlp-input{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 8px;font-size:12px;outline:none;width:100%}',
        '.dlp-input:focus{border-color:var(--dsw-alias-brand-primary)}',
        '.dlp-grow{flex:1}',
        '.dlp-btn{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;white-space:nowrap}',
        '.dlp-btn:disabled{opacity:.6;cursor:default}',
        '.dlp-err{color:var(--dsw-alias-state-error-primary);font-size:11px}',
        '.dlp-list{max-height:320px;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
        '.dlp-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:16px 4px;font-size:12px}',
        '.dlp-item{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px}',
        '.dlp-item-top{display:flex;align-items:flex-start;gap:8px}',
        '.dlp-icon{flex:none;line-height:1.2}',
        '.dlp-item-body{flex:1;min-width:0}',
        '.dlp-item-title{color:var(--dsw-alias-label-primary);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dlp-item-meta{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}',
        '.dlp-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:8px}',
        '.dlp-fill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}',
        '.dlp-indet{width:40%;animation:dlp-slide 1.2s linear infinite}',
        '@keyframes dlp-slide{0%{margin-left:-40%}100%{margin-left:100%}}',
        '.dlp-status{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:5px}',
        '.dlp-status-err{color:var(--dsw-alias-state-error-primary)}',
      ].join('')
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-download-progress'
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = cssText
        document.head.appendChild(tag)
      }

      // ---- API（host 半部分 HTTP 路由）----
      function apiGet(path) {
        return fetch('/api/download-progress' + path)
          .then((r) => r.json().then((j) => { if (!j.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j.data !== undefined ? j.data : j }))
      }
      function apiPost(path, body) {
        return fetch('/api/download-progress' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }).then((r) => r.json())
      }

      function fmtBytes(n) {
        if (!Number.isFinite(n) || n < 0) return '0 B'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        let v = n
        let i = 0
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
        return (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[i]
      }

      function fmtDur(ms) {
        if (!Number.isFinite(ms) || ms < 0) return ''
        const total = Math.round(ms / 1000)
        if (total < 60) return total + 's'
        const m = Math.floor(total / 60)
        const s = total % 60
        return m + 'm ' + (s < 10 ? '0' : '') + s + 's'
      }

      function Panel() {
        const [open, setOpen] = react.useState(false)
        const [items, setItems] = react.useState([])
        const [urlText, setUrlText] = react.useState('')
        const [destText, setDestText] = react.useState('')
        const [busy, setBusy] = react.useState(false)
        const [err, setErr] = react.useState('')
        const [pos, setPos] = react.useState({ pill: null, card: null })
        const pillRef = react.useRef(null)
        const cardRef = react.useRef(null)
        const dragRef = react.useRef(null)
        const wasDrag = react.useRef(false)

        react.useEffect(() => {
          let mounted = true
          const poll = () => {
            apiGet('/state').then((data) => {
              if (mounted && Array.isArray(data)) setItems(data)
            }).catch(() => {})
          }
          poll()
          const slow = window.setInterval(poll, 2000)
          return () => { mounted = false; window.clearInterval(slow) }
        }, [])

        react.useEffect(() => {
          if (!open) return
          let mounted = true
          const poll = () => {
            apiGet('/state').then((data) => {
              if (mounted && Array.isArray(data)) setItems(data)
            }).catch(() => {})
          }
          const fast = window.setInterval(poll, 500)
          return () => { mounted = false; window.clearInterval(fast) }
        }, [open])

        const activeCount = items.filter((i) => i.status === 'active').length

        function viewSizeOf(e) {
          const doc = e && e.target && e.target.ownerDocument
          const view = doc && doc.defaultView
          return { w: view && view.innerWidth ? view.innerWidth : 1200, h: view && view.innerHeight ? view.innerHeight : 800 }
        }

        function onPointerDown(e, kind) {
          if (e.button !== 0) return
          const el = kind === 'pill' ? pillRef.current : cardRef.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          dragRef.current = {
            kind, pointerId: e.pointerId,
            startX: e.clientX, startY: e.clientY,
            origX: rect.left, origY: rect.top,
            moved: false,
          }
          wasDrag.current = false
        }

        function onPointerMove(e, kind) {
          const st = dragRef.current
          if (!st || st.kind !== kind || st.pointerId !== e.pointerId) return
          const dx = e.clientX - st.startX
          const dy = e.clientY - st.startY
          if (!st.moved && Math.abs(dx) + Math.abs(dy) > 4) {
            st.moved = true
            wasDrag.current = true
            const el = kind === 'pill' ? pillRef.current : cardRef.current
            if (el) { try { el.setPointerCapture(e.pointerId) } catch (err) {} }
          }
          if (!st.moved) return
          const el = kind === 'pill' ? pillRef.current : cardRef.current
          const size = el ? { w: el.offsetWidth, h: el.offsetHeight } : { w: 0, h: 0 }
          const vs = viewSizeOf(e)
          const nx = Math.min(Math.max(8, st.origX + dx), Math.max(8, vs.w - size.w - 8))
          const ny = Math.min(Math.max(8, st.origY + dy), Math.max(8, vs.h - size.h - 8))
          setPos((prev) => {
            const next = { pill: prev.pill, card: prev.card }
            next[kind] = { x: nx, y: ny }
            return next
          })
        }

        function onPointerEnd(e, kind) {
          const st = dragRef.current
          if (st && st.kind === kind && st.pointerId === e.pointerId) dragRef.current = null
        }

        function styleOf(kind) {
          const p = pos[kind]
          if (!p) return undefined
          return { left: p.x, top: p.y, right: 'auto', bottom: 'auto' }
        }

        const resetPos = () => setPos({ pill: null, card: null })

        const openPanel = () => {
          if (wasDrag.current) { wasDrag.current = false; return }
          if (pos.card === null && pos.pill !== null) {
            let vw = 1200
            let vh = 800
            const el = pillRef.current
            const doc = el && el.ownerDocument
            const view = doc && doc.defaultView
            if (view) { vw = view.innerWidth || 1200; vh = view.innerHeight || 800 }
            const x = Math.min(Math.max(8, pos.pill.x), Math.max(8, vw - 368 - 8))
            const y = Math.min(Math.max(8, pos.pill.y), Math.max(8, vh - 420 - 8))
            setPos((prev) => ({ pill: prev.pill, card: { x, y } }))
          }
          setOpen(true)
        }

        const doDownload = async () => {
          if (busy) return
          const url = urlText.trim()
          if (!url) { setErr('请输入下载链接'); return }
          setBusy(true)
          setErr('')
          try {
            const res = await apiPost('/download', { url, dest: destText.trim() || undefined })
            if (res && res.ok) {
              setUrlText('')
              setDestText('')
            } else if (res && res.error) {
              setErr(res.error)
            } else {
              setErr('启动失败，请重试')
            }
          } catch (e) {
            setErr('请求失败，请重试')
          }
          setBusy(false)
        }

        const doCancel = async (id) => {
          try { await apiPost('/cancel', { id }) } catch (e) {}
        }
        const doDismiss = async (id) => {
          try { await apiPost('/dismiss', { id }) } catch (e) {}
        }
        const doClear = async () => {
          try { await apiPost('/clear-finished', {}) } catch (e) {}
        }

        if (!open) {
          return h('div', { className: 'dlp-root' },
            h('button', {
              ref: pillRef,
              className: 'dlp-pill',
              style: styleOf('pill'),
              title: '点击展开；按住可拖动位置',
              onPointerDown: (e) => onPointerDown(e, 'pill'),
              onPointerMove: (e) => onPointerMove(e, 'pill'),
              onPointerUp: (e) => onPointerEnd(e, 'pill'),
              onPointerCancel: (e) => onPointerEnd(e, 'pill'),
              onClick: openPanel,
            }, activeCount > 0 ? '⏳ 下载 ' + activeCount : '⬇ 下载'))
        }

        return h('div', { className: 'dlp-root' },
          h('div', {
            ref: cardRef,
            className: 'dlp-card',
            style: styleOf('card'),
            onPointerMove: (e) => onPointerMove(e, 'card'),
            onPointerUp: (e) => onPointerEnd(e, 'card'),
            onPointerCancel: (e) => onPointerEnd(e, 'card'),
          },
            h('div', {
              className: 'dlp-head',
              title: '按住标题栏可拖动面板',
              onPointerDown: (e) => onPointerDown(e, 'card'),
            },
              h('span', { className: 'dlp-title' }, '下载进度'),
              activeCount > 0 ? h('span', { className: 'dlp-badge' }, String(activeCount)) : null,
              h('span', { className: 'dlp-spacer' }),
              h('button', { className: 'dlp-ghost', onPointerDown: (e) => e.stopPropagation(), onClick: resetPos, title: '复位到默认位置（右下角）' }, '↺'),
              h('button', { className: 'dlp-ghost', onPointerDown: (e) => e.stopPropagation(), onClick: doClear, title: '清除已完成/失败记录' }, '清除'),
              h('button', { className: 'dlp-ghost', onPointerDown: (e) => e.stopPropagation(), onClick: () => setOpen(false), title: '收起面板' }, '✕')),
            h('div', { className: 'dlp-inputs' },
              h('input', {
                className: 'dlp-input',
                placeholder: 'https://… 下载链接',
                value: urlText,
                onChange: (e) => setUrlText(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') doDownload() },
              }),
              h('div', { className: 'dlp-row' },
                h('input', {
                  className: 'dlp-input dlp-grow',
                  placeholder: '保存路径（可选，默认工作区）',
                  value: destText,
                  onChange: (e) => setDestText(e.target.value),
                }),
                h('button', { className: 'dlp-btn', onClick: doDownload, disabled: busy }, busy ? '…' : '下载')),
              err ? h('div', { className: 'dlp-err' }, err) : null),
            h('div', { className: 'dlp-list' },
              items.length === 0
                ? h('div', { className: 'dlp-empty' }, '暂无下载任务。上方输入链接开始下载，或让 agent 使用 download_url / ssh_download，或直接用 curl / iwr / wget 下载；任何工作区里增长中的文件也会被自动捕捉。')
                : items.map((it) => Item(it, doCancel, doDismiss)))))
      }

      function Item(it, doCancel, doDismiss) {
        const pct = typeof it.percent === 'number' ? it.percent : null
        const barWidth = pct !== null ? Math.max(0, Math.min(100, pct)) : null
        const statusText = (() => {
          if (it.status === 'active') {
            const parts = []
            if (pct !== null) parts.push(pct.toFixed(1) + '%')
            if (typeof it.bytes === 'number' && it.bytes > 0) {
              parts.push(typeof it.total === 'number' && it.total > 0 && it.kind === 'download' ? fmtBytes(it.bytes) + ' / ' + fmtBytes(it.total) : fmtBytes(it.bytes))
            }
            if (typeof it.speed === 'number' && it.speed > 0) parts.push(fmtBytes(it.speed) + '/s')
            if (typeof it.etaSec === 'number' && it.etaSec > 0) parts.push('剩余 ' + fmtDur(it.etaSec * 1000))
            if (parts.length === 0) parts.push('传输中…')
            return parts.join(' · ')
          }
          if (it.status === 'done') {
            const parts = ['✓ 完成']
            if (typeof it.bytes === 'number' && it.bytes > 0) parts.push(fmtBytes(it.bytes))
            if (it.elapsedMs) parts.push(fmtDur(it.elapsedMs))
            return parts.join(' · ')
          }
          if (it.status === 'canceled') return '已取消'
          if (it.status === 'error') return '✕ ' + (it.error || '失败')
          return it.status
        })()
        const icon = it.source === 'ssh'
          ? (it.kind === 'upload' ? '⇧' : '⇩')
          : it.source === 'shell' ? '💻' : it.source === 'fs' ? '📥' : '🌐'
        const meta = it.source === 'ssh'
          ? (it.kind === 'upload' ? (it.alias + ': ' + it.localPath + ' → ' + it.remotePath) : (it.alias + ': ' + it.remotePath))
          : (it.url || it.dest || it.localPath || '')
        return h('div', { key: it.id, className: 'dlp-item' },
          h('div', { className: 'dlp-item-top' },
            h('span', { className: 'dlp-icon' }, icon),
            h('div', { className: 'dlp-item-body' },
              h('div', { className: 'dlp-item-title', title: it.label }, it.label || '(未命名)'),
              meta ? h('div', { className: 'dlp-item-meta', title: meta }, meta) : null),
            it.status === 'active' && it.source === 'url'
              ? h('button', { className: 'dlp-ghost', onClick: () => doCancel(it.id) }, '取消')
              : it.status !== 'active'
                ? h('button', { className: 'dlp-ghost', onClick: () => doDismiss(it.id), title: '移除该记录' }, '✕')
                : null),
          h('div', { className: 'dlp-bar' },
            h('div', {
              className: 'dlp-fill' + (barWidth === null ? ' dlp-indet' : ''),
              style: barWidth === null ? null : { width: barWidth + '%' },
            })),
          h('div', { className: 'dlp-status' + (it.status === 'error' ? ' dlp-status-err' : '') }, statusText))
      }

      // ---- 注册 shell.overlay 浮层条目 ----
      function apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-download-progress-panel',
          order: 10,
          label: '下载进度',
        }, Panel))
      }

      const inject = ['slots']

      return { apply, inject }
    },
  })
}
