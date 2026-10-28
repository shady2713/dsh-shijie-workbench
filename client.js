window.__ModuleLoader__.load({
  id: 'dsh-shijie-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CSS = `
      .sj-dashboard {
        display: flex;
        flex-direction: column;
        gap: 18px;
        padding: 4px 4px 28px;
        color: var(--dsw-alias-label-primary);
        font: inherit;
      }
      .sj-dashboard-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .sj-dashboard-title {
        margin: 0;
        font-size: 22px;
        line-height: 1.25;
        font-weight: 600;
      }
      .sj-dashboard-sub {
        margin: 6px 0 0;
        color: var(--dsw-alias-label-secondary);
        font-size: 13px;
        line-height: 1.5;
      }
      .sj-button {
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        border-radius: 8px;
        padding: 7px 12px;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .sj-button:hover {
        border-color: var(--dsw-alias-border-l2);
      }
      .sj-button:disabled {
        cursor: default;
        opacity: .55;
      }
      .sj-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
        gap: 12px;
      }
      .sj-card {
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 10px;
        padding: 14px 15px;
      }
      .sj-card-label {
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        line-height: 1.4;
      }
      .sj-card-value {
        margin-top: 7px;
        font-size: 24px;
        line-height: 1.15;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .sj-card-hint {
        margin-top: 7px;
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        line-height: 1.4;
      }
      .sj-panel {
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 10px;
        overflow: hidden;
      }
      .sj-panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        padding: 13px 16px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
      }
      .sj-panel-title {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      .sj-panel-note {
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
      }
      .sj-table-wrap {
        overflow-x: auto;
      }
      .sj-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .sj-table th {
        color: var(--dsw-alias-label-secondary);
        font-weight: 500;
        text-align: left;
        padding: 9px 16px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
        white-space: nowrap;
      }
      .sj-table td {
        padding: 9px 16px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
        vertical-align: top;
      }
      .sj-table tr:last-child td {
        border-bottom: 0;
      }
      .sj-muted {
        color: var(--dsw-alias-label-secondary);
      }
      .sj-badge {
        display: inline-block;
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 12px;
        line-height: 1.5;
        white-space: nowrap;
      }
      .sj-badge.tone-success {
        color: var(--dsw-alias-state-success-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
      }
      .sj-badge.tone-error {
        color: var(--dsw-alias-state-error-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
      }
      .sj-badge.tone-warn {
        color: var(--dsw-alias-state-warn-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
      }
      .sj-badge.tone-brand {
        color: var(--dsw-alias-brand-primary);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
      }
      .sj-badge.tone-idle {
        color: var(--dsw-alias-state-idle-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-idle-primary) 12%, transparent);
      }
      .sj-empty {
        padding: 24px 16px;
        color: var(--dsw-alias-label-secondary);
        font-size: 13px;
        text-align: center;
      }
      .sj-error {
        border: 1px solid var(--dsw-alias-state-error-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
        border-radius: 10px;
        padding: 12px 14px;
        color: var(--dsw-alias-state-error-primary);
        font-size: 13px;
        line-height: 1.5;
      }
      .sj-footer {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        line-height: 1.5;
      }
    `

    const STATUS_TEXT = {
      DRAFT: '草稿',
      READY: '就绪',
      RUNNING: '运行中',
      WAITING_AGENT: '等待模型',
      WAITING_APPROVAL: '等待审核',
      BLOCKED: '受阻',
      REVIEW_READY: '待审核',
      CLOSED_COMPLETE: '已完成',
      CLOSED_PARTIAL: '部分完成',
      CANCELLED: '已取消',
      QUEUED: '排队',
      SUCCEEDED: '成功',
      FAILED: '失败',
      OPEN: '开放',
      REVIEWED: '已审核',
      EXPORTED: '已导出',
      SUPERSEDED: '已替换',
      ACQUIRED: '已获取',
      VERIFIED: '已校验',
      CORRUPT: '损坏',
      NEEDS_MEDIA_REVIEW: '待媒体审核',
      VIDEO: '视频',
      IMAGE: '图片',
    }

    const STATUS_TONE = {
      SUCCEEDED: 'success',
      VERIFIED: 'success',
      CLOSED_COMPLETE: 'success',
      READY: 'brand',
      RUNNING: 'brand',
      WAITING_AGENT: 'warn',
      WAITING_APPROVAL: 'warn',
      BLOCKED: 'warn',
      REVIEW_READY: 'warn',
      QUEUED: 'idle',
      OPEN: 'warn',
      FAILED: 'error',
      CORRUPT: 'error',
      NEEDS_MEDIA_REVIEW: 'warn',
      CLOSED_PARTIAL: 'warn',
    }

    function statusLabel(status) {
      return STATUS_TEXT[status] || String(status || '—')
    }

    function badge(status) {
      const tone = STATUS_TONE[status] || 'idle'
      return h('span', { className: 'sj-badge tone-' + tone }, statusLabel(status))
    }

    function formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    function formatBytes(value) {
      if (value === null || value === undefined) return '—'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function formatDuration(value) {
      if (value === null || value === undefined) return '—'
      const seconds = Number(value)
      if (!Number.isFinite(seconds)) return '—'
      if (seconds < 60) return seconds.toFixed(1) + ' 秒'
      const minutes = Math.floor(seconds / 60)
      const rest = Math.round(seconds - minutes * 60)
      return minutes + ' 分 ' + rest + ' 秒'
    }

    function StatCard(props) {
      return h('div', { className: 'sj-card' },
        h('div', { className: 'sj-card-label' }, props.label),
        h('div', { className: 'sj-card-value' }, props.value),
        props.hint ? h('div', { className: 'sj-card-hint' }, props.hint) : null,
      )
    }

    function EmptyRow(props) {
      return h('tr', null,
        h('td', { colSpan: props.colspan, className: 'sj-empty' }, props.children || '暂无数据'),
      )
    }

    function DataTable(props) {
      return h('div', { className: 'sj-table-wrap' },
        h('table', { className: 'sj-table' },
          h('thead', null,
            h('tr', null, props.columns.map((column) => h('th', { key: column.key }, column.label))),
          ),
          h('tbody', null,
            props.rows.length === 0
              ? h(EmptyRow, { colspan: props.columns.length })
              : props.rows.map((row, index) => h('tr', { key: row.id || row[props.keyField] || index },
                props.columns.map((column) => h('td', { key: column.key }, column.render(row))),
              )),
          ),
        ),
      )
    }

    function Panel(props) {
      return h('section', { className: 'sj-panel' },
        h('div', { className: 'sj-panel-head' },
          h('h3', { className: 'sj-panel-title' }, props.title),
          props.note ? h('span', { className: 'sj-panel-note' }, props.note) : null,
        ),
        props.children,
      )
    }

    function useDashboard() {
      const [snapshot, setSnapshot] = React.useState({
        data: null,
        error: null,
        loading: true,
        refreshedAt: null,
      })

      const refresh = React.useCallback(async () => {
        setSnapshot((current) => ({ ...current, loading: true, error: null }))
        try {
          const response = await fetch('/api/shijie-workbench/status', {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const data = await response.json()
          if (data && data.status === 'ERROR') throw new Error(data.code || 'DASHBOARD_UNAVAILABLE')
          setSnapshot({ data, error: null, loading: false, refreshedAt: new Date() })
        } catch (error) {
          setSnapshot((current) => ({
            ...current,
            loading: false,
            error: error && error.message ? error.message : String(error),
          }))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        const timer = setInterval(() => { void refresh() }, 5000)
        return () => clearInterval(timer)
      }, [refresh])

      return { ...snapshot, refresh }
    }

    function Dashboard() {
      const state = useDashboard()
      const data = state.data
      const totals = data ? data.totals : null
      const jobStatus = data ? data.job_status || {} : {}

      return h('div', { className: 'sj-dashboard' },
        h('div', { className: 'sj-dashboard-head' },
          h('div', null,
            h('h2', { className: 'sj-dashboard-title' }, '视界工作台'),
            h('p', { className: 'sj-dashboard-sub' }, '航拍素材采集进度、媒体与最近活动（只读）'),
          ),
          h('button', { className: 'sj-button', onClick: state.refresh, disabled: state.loading },
            state.loading ? '刷新中…' : '刷新',
          ),
        ),

        state.error ? h('div', { className: 'sj-error' },
          '无法读取工作台状态：', state.error, '。请确认插件已加载，且 DSH 的本地 Web 服务可用。',
        ) : null,

        totals ? h('div', { className: 'sj-grid' },
          h(StatCard, {
            label: '任务',
            value: totals.tasks,
            hint: '进行中 ' + totals.tasks_active,
          }),
          h(StatCard, {
            label: '作业',
            value: totals.jobs,
            hint: '排队 ' + (jobStatus.QUEUED || 0) + ' · 运行 ' + (jobStatus.RUNNING || 0) + ' · 失败 ' + (jobStatus.FAILED || 0),
          }),
          h(StatCard, {
            label: '媒体',
            value: totals.media,
            hint: '视频 ' + totals.videos + ' · 图片 ' + totals.images,
          }),
          h(StatCard, {
            label: '帧',
            value: totals.frames,
            hint: '覆盖事件 ' + totals.coverage_events,
          }),
          h(StatCard, {
            label: '已取样 / 已看',
            value: totals.sampled_events + ' / ' + totals.reviewed_events,
            hint: '只统计覆盖事件',
          }),
          h(StatCard, {
            label: '审核 / 导出',
            value: totals.review_batches + ' / ' + totals.exports,
            hint: '开放审核 ' + totals.open_review_batches,
          }),
        ) : null,

        data ? h(Panel, { title: '最近任务', note: '更新 ' + formatTime(data.generated_at) },
          h(DataTable, {
            keyField: 'task_id',
            rows: data.recent_tasks || [],
            columns: [
              { key: 'name', label: '任务', render: (row) => h('span', null, row.name || '未命名') },
              { key: 'status', label: '状态', render: (row) => badge(row.status) },
              { key: 'revision', label: '修订', render: (row) => 'r' + row.current_revision },
              { key: 'updated_at', label: '更新时间', render: (row) => h('span', { className: 'sj-muted' }, formatTime(row.updated_at)) },
            ],
          }),
        ) : null,

        data ? h(Panel, { title: '最近作业', note: '最多 ' + (data.recent_jobs || []).length + ' 条' },
          h(DataTable, {
            keyField: 'job_id',
            rows: data.recent_jobs || [],
            columns: [
              { key: 'kind', label: '类型', render: (row) => row.kind },
              { key: 'task', label: '任务', render: (row) => row.task_name || row.task_id || '—' },
              { key: 'status', label: '状态', render: (row) => badge(row.status) },
              { key: 'attempt', label: '尝试', render: (row) => row.attempt + '/' + row.max_attempts },
              { key: 'updated_at', label: '更新时间', render: (row) => h('span', { className: 'sj-muted' }, formatTime(row.updated_at)) },
            ],
          }),
        ) : null,

        data ? h(Panel, { title: '最近媒体', note: '本地已获取素材' },
          h(DataTable, {
            keyField: 'media_id',
            rows: data.recent_media || [],
            columns: [
              { key: 'kind', label: '类型', render: (row) => statusLabel(row.media_kind) },
              { key: 'state', label: '状态', render: (row) => badge(row.state) },
              {
                key: 'size',
                label: '尺寸 / 时长',
                render: (row) => {
                  const size = row.width && row.height ? row.width + '×' + row.height : '—'
                  return row.media_kind === 'VIDEO' ? size + ' · ' + formatDuration(row.duration_s) : size
                },
              },
              { key: 'created_at', label: '获取时间', render: (row) => h('span', { className: 'sj-muted' }, formatTime(row.created_at)) },
            ],
          }),
        ) : null,

        data ? h(Panel, { title: '最近活动', note: '审计事件，只读' },
          h(DataTable, {
            keyField: 'event_id',
            rows: data.recent_events || [],
            columns: [
              { key: 'event_type', label: '事件', render: (row) => row.event_type },
              { key: 'entity', label: '对象', render: (row) => (row.entity_type || '') + ' · ' + (row.entity_id || '') },
              { key: 'actor', label: '操作者', render: (row) => row.actor_id || '—' },
              { key: 'created_at', label: '时间', render: (row) => h('span', { className: 'sj-muted' }, formatTime(row.created_at)) },
            ],
          }),
        ) : null,

        h('div', { className: 'sj-footer' },
          h('span', null,
            data
              ? 'SQLite 本地库 · schema ' + data.schema_version + ' · ' + formatBytes(data.database && data.database.size_bytes)
              : 'SQLite 本地库',
          ),
          h('span', null,
            state.refreshedAt ? '页面刷新于 ' + formatTime(state.refreshedAt.toISOString()) : '每 5 秒自动刷新',
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-shijie-workbench'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove())

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'shijie-workbench',
          order: 95,
          label: () => '视界工作台',
        }, Dashboard))
      },
    }
  },
})
