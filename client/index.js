/**
 * Projects — Client half.
 *
 * Registers two slot contributions:
 *   - `sidebar.panellist` id `projects`: the board glyph in the left column.
 *   - `main` key `projects`: the project board (project list, instructions,
 *     shared memory, task board) that glyph selects.
 *
 * All data comes from the Host half's same-origin `/projects-api/*` routes.
 * The page is a viewer and a human control surface: it creates projects and
 * tasks, approves tasks for dispatch, edits the shared memory and reviews
 * worker output. Dispatching itself belongs to the coordinator agent through
 * the `projects_dispatch` tool.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-projects',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'projects'
    const API = '/projects-api'

    // ---------------------------------------------------------------------
    // Text

    const EN = {
      nav: 'Projects',
      title: 'Projects',
      chatTab: 'Conversation',
      settingsTab: 'Settings',
      executors: 'Executors',
      startCoordinator: 'Start coordinator',
      startCoordinatorHint: 'The coordinator plans the goal and dispatches tasks. Its conversation lives in this column.',
      openConversation: 'Open conversation',
      noConversation: 'This task has no executor session yet.',
      workerChatFailed: 'The executor conversation could not start. Open it in the workspace instead.',
      projects: 'Projects',
      newProject: 'New project',
      projectName: 'Project name',
      workspacePlaceholder: 'Workspace path (optional)',
      chooseFolder: 'Choose folder',
      chooseFolderShort: 'Choose…',
      clear: 'Clear',
      noWorkspace: 'No folder — inherits the session directory',
      create: 'Create',
      cancel: 'Cancel',
      noProjects: 'No projects yet. Create one to give the coordinator a goal.',
      noSelection: 'Select a project, or create one.',
      nameRequired: 'A project needs a name.',
      titleRequired: 'A task needs a title.',
      projectCreated: 'Project created.',
      saved: 'Saved.',
      taskAdded: 'Task added.',
      deleted: 'Deleted.',
      archived: 'Archived.',
      unarchived: 'Unarchived.',
      refresh: 'Refresh',
      instructions: 'Project instructions',
      instructionsHint: 'Sent to every worker, together with the shared memory and the task brief.',
      instructionsPlaceholder: 'Goal, constraints, conventions…',
      memory: 'Shared memory',
      memoryHint: 'Every worker reads this before starting and can append findings to it.',
      memoryPlaceholder: 'Findings, decisions, codebase knowledge…',
      save: 'Save',
      policy: 'Dispatch policy',
      autonomy: 'Autonomy',
      autonomyManual: 'Manual — a human approves each dispatch',
      autonomyAuto: 'Auto — the coordinator dispatches freely',
      concurrency: 'Parallel workers',
      workspace: 'Workspace',
      addTask: 'Add task',
      taskTitle: 'Task title',
      taskBrief: 'What the worker must do, where, and how to verify it…',
      add: 'Add',
      emptyTasks: 'No tasks yet. Ask the coordinator to split the goal, or add one here.',
      approve: 'Approve',
      approvedBadge: 'Approved',
      deleteConfirm: 'Confirm delete',
      switchDiscard: 'Discard unsaved changes and switch projects?',
      archivedHint: 'This project is archived. Unarchive it to dispatch tasks.',
      stopReason: 'Stop reason',
      worker: 'worker',
      noOutput: 'No output recorded yet.',
      archive: 'Archive',
      unarchive: 'Unarchive',
      archivedBadge: 'Archived',
      queued: 'Queued',
      running: 'Running',
      review: 'Ready for review',
      done: 'Done',
      failed: 'Failed',
      blocked: 'Blocked',
      status: 'Status',
      delete: 'Delete',
      error: 'Something went wrong',
      counts: 'tasks',
      openInWorkspace: 'Open in workspace',
      coordinatorCreated: 'Coordinator session started.',
      coordinatorResumed: 'Coordinator session opened.',
      coordinatorChatFailed: 'The embedded conversation could not start. Open it in the workspace instead.',
      coordinatorArchived: 'This conversation is archived, so new messages do not run. Restore it to continue.',
      restore: 'Restore',
      coordinatorRestored: 'Conversation restored.',
    }

    const ZH = {
      nav: '项目',
      title: '项目',
      chatTab: '对话',
      settingsTab: '设置',
      executors: '执行者',
      startCoordinator: '启动协调者',
      startCoordinatorHint: '协调者负责拆解目标、派发任务；它的对话就在这一栏。',
      openConversation: '打开对话',
      noConversation: '这个任务还没有执行者会话。',
      workerChatFailed: '执行者对话启动失败，请在会话中打开。',
      projects: '项目',
      newProject: '新建项目',
      projectName: '项目名称',
      workspacePlaceholder: '工作区路径（可选）',
      chooseFolder: '选择文件夹',
      chooseFolderShort: '选择…',
      clear: '清除',
      noWorkspace: '未选择 —— 继承当前会话目录',
      create: '创建',
      cancel: '取消',
      noProjects: '还没有项目。新建一个，给协调者一个目标。',
      noSelection: '选择一个项目，或新建一个。',
      nameRequired: '项目需要名称。',
      titleRequired: '任务需要标题。',
      projectCreated: '项目已创建。',
      saved: '已保存。',
      taskAdded: '任务已添加。',
      deleted: '已删除。',
      archived: '已归档。',
      unarchived: '已取消归档。',
      refresh: '刷新',
      instructions: '项目指令',
      instructionsHint: '每个执行者都会收到它，连同共享记忆和任务说明。',
      instructionsPlaceholder: '目标、约束、约定……',
      memory: '共享记忆',
      memoryHint: '每个执行者开始前都会读它，也可以把结论追加进来。',
      memoryPlaceholder: '结论、决策、对代码库的了解……',
      save: '保存',
      policy: '派发策略',
      autonomy: '自主程度',
      autonomyManual: '手动 —— 每次派发都需要人批准',
      autonomyAuto: '自动 —— 协调者可直接派发',
      concurrency: '并行执行者',
      workspace: '工作区',
      addTask: '添加任务',
      taskTitle: '任务标题',
      taskBrief: '执行者要做什么、在哪里做、如何验收……',
      add: '添加',
      emptyTasks: '还没有任务。让协调者拆解目标，或在这里手动添加。',
      approve: '批准',
      approvedBadge: '已批准',
      deleteConfirm: '确认删除',
      switchDiscard: '放弃未保存的修改并切换项目？',
      archivedHint: '项目已归档，取消归档后才能派发任务。',
      stopReason: '结束原因',
      worker: '执行者',
      noOutput: '还没有产出。',
      archive: '归档',
      unarchive: '取消归档',
      archivedBadge: '已归档',
      queued: '排队中',
      running: '执行中',
      review: '待验收',
      done: '已完成',
      failed: '失败',
      blocked: '受阻',
      status: '状态',
      delete: '删除',
      error: '出错了',
      counts: '个任务',
      openInWorkspace: '在会话中打开',
      coordinatorCreated: '协调者会话已启动。',
      coordinatorResumed: '已打开协调者会话。',
      coordinatorChatFailed: '内嵌对话启动失败，请在会话中打开。',
      coordinatorArchived: '这个会话已归档，新消息不会运行。恢复后才能继续。',
      restore: '恢复',
      coordinatorRestored: '会话已恢复。',
    }

    // ---------------------------------------------------------------------
    // Styles (theme tokens only; the element unmounts with the page)

    const CSS = `
.pj-page{display:flex;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.pj-page :focus-visible{outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}
.pj-list{display:flex;flex-direction:column;flex:0 0 264px;width:264px;min-height:0;border-right:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.pj-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px 14px 10px}
.pj-list-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.pj-list-scroll{flex:1;min-height:0;overflow:auto;padding:0 8px 16px}
.pj-list-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:9px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.pj-list-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pj-list-item.pj-active{background:var(--dsw-alias-interactive-bg-active)}
.pj-list-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-list-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.pj-new-project{display:flex;flex-direction:column;gap:8px;padding:4px 14px 14px}
.pj-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;border-right:1px solid var(--dsw-alias-border-l2)}
.pj-main-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);min-height:56px;box-sizing:border-box}
[data-platform='darwin'] .pj-list-head{padding-top:calc(16px + var(--dsh-frame-top-clearance, 0px))}
[data-platform='darwin'] .pj-main-head{padding-top:calc(14px + var(--dsh-frame-top-clearance, 0px))}
[data-platform='darwin'] .pj-exec-head{padding-top:calc(12px + var(--dsh-frame-top-clearance, 0px))}
.pj-main-title{display:flex;align-items:center;gap:8px;min-width:0}
.pj-title{margin:0;font-size:18px;line-height:26px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-main-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.pj-main-scroll{flex:1;min-height:0;overflow:auto;padding:16px clamp(16px,3vw,32px) 40px}
.pj-settings{max-width:760px;margin:0 auto}
.pj-chat-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.pj-exec{display:flex;flex-direction:column;flex:0 0 380px;width:380px;min-width:320px;max-width:520px;min-height:0;background:var(--dsw-alias-bg-layer-1)}
.pj-exec-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);min-height:56px;box-sizing:border-box}
.pj-exec-title{margin:0;font-size:14px;font-weight:600}
.pj-exec-task{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-secondary)}
.pj-exec-scroll{flex:1;min-height:0;overflow:auto;padding:12px 14px 32px}
.pj-group{margin-bottom:16px}
.pj-group-title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.pj-start{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:24px;text-align:center}
.pj-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.pj-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.pj-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pj-btn:disabled{opacity:.5;cursor:default}
.pj-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.pj-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.pj-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.pj-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pj-btn-danger{color:var(--dsw-alias-state-error-primary)}
.pj-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pj-section{margin-top:22px}
.pj-section:first-child{margin-top:0}
.pj-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.pj-section-title{font-size:14px;font-weight:600;margin:0}
.pj-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}
.pj-textarea,.pj-input,.pj-select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:8px 10px}
.pj-textarea{min-height:96px;resize:vertical;line-height:1.6}
.pj-textarea:focus-visible,.pj-input:focus-visible,.pj-select:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.pj-input{height:32px;padding:0 10px}
.pj-select{height:32px;padding:0 8px}
.pj-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.pj-row > .pj-grow{flex:1 1 220px;min-width:0}
.pj-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.pj-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.pj-form{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}
.pj-task{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);padding:10px 12px;margin-bottom:8px}
.pj-task-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pj-task-title{font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 140px}
.pj-task-body{font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:6px;white-space:pre-wrap;word-break:break-word}
.pj-task-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}
.pj-task-output{margin-top:8px;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}
.pj-task-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
.pj-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
.pj-pill-queued{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pj-pill-running{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);color:var(--dsw-alias-state-business-primary)}
.pj-pill-review{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent);color:var(--dsw-alias-state-warn-primary)}
.pj-pill-done{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary)}
.pj-pill-failed{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);color:var(--dsw-alias-state-error-primary)}
.pj-pill-blocked{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);color:var(--dsw-alias-state-warn-primary);border:1px dashed color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}
.pj-warn{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 16px 0;padding:8px 12px;border-radius:var(--dsw-radius-sm);font-size:13px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, var(--dsw-alias-bg-base));color:var(--dsw-alias-state-warn-primary)}
.pj-warn-text{min-width:0}
.pj-notice{margin:8px 16px 0;padding:8px 12px;border-radius:var(--dsw-radius-sm);font-size:13px;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, var(--dsw-alias-bg-base));color:var(--dsw-alias-state-success-primary)}
.pj-error{margin:8px 16px 0;padding:8px 12px;border-radius:var(--dsw-radius-sm);font-size:13px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, var(--dsw-alias-bg-base));color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
.pj-empty{padding:24px 16px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center}
.pj-empty-action{margin-top:12px}
@media (max-width: 1200px){.pj-exec{flex-basis:320px;width:320px}}
@media (max-width: 1000px){.pj-list{flex-basis:220px;width:220px}}
`

    // ---------------------------------------------------------------------
    // Data

    function messageOf(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let payload = {}
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      return payload
    }

    function countsLine(project, t) {
      const counts = project.counts || {}
      const parts = ['running', 'review', 'queued', 'done', 'failed']
        .filter((status) => (counts[status] || 0) > 0)
        .map((status) => `${counts[status]} ${t(status)}`)
      return parts.length ? parts.join(' · ') : `${counts.total || 0} ${t('counts')}`
    }

    function coordinatorPrompt(project, locale) {
      const zh = String(locale || '').toLowerCase().startsWith('zh')
      const tasks = project.tasks || []
      const taskLines = tasks.length
        ? tasks.map((task) => `- ${task.id} [${task.status}] ${task.title}`).join('\n')
        : '(还没有任务)'
      if (zh) {
        return [
          `你是 DSH 项目「${project.name}」的协调者（project_id: ${project.id}）。`,
          '',
          '## 项目目标与指令',
          project.goal?.trim() || '（未填写）',
          '',
          '## 当前任务',
          taskLines,
          '',
          '## 你的职责',
          '1. 只做规划和分派，自己不要执行任务、不要改代码。',
          '2. 用 projects_add_task 把目标拆成可并行的任务，每个任务要能独立完成。',
          '3. 用 projects_dispatch 派发任务；派发后继续响应用户，不要等待。',
          '4. 执行者交回结果后，用 projects_get 查看产出，向用户汇报并请用户验收。',
          '5. 用 projects_memory 维护共享记忆，让所有执行者共享结论。',
          project.autonomy === 'manual'
            ? '6. 当前自主程度是手动：派发前需要用户在项目页批准任务。'
            : '6. 当前自主程度是自动：你可以直接派发任务。',
        ].join('\n')
      }
      return [
        `You are the coordinator of the DSH project "${project.name}" (project_id: ${project.id}).`,
        '',
        '## Project instructions',
        project.goal?.trim() || '(none)',
        '',
        '## Current tasks',
        taskLines,
        '',
        '## Your job',
        '1. Plan and dispatch only; do not execute tasks or edit code yourself.',
        '2. Use projects_add_task to split the goal into parallel, independently finishable tasks.',
        '3. Use projects_dispatch to start tasks; stay responsive instead of waiting.',
        '4. When a worker reports back, use projects_get to review its output and report to the user.',
        '5. Keep shared knowledge in projects_memory so every worker starts informed.',
        project.autonomy === 'manual'
          ? '6. Autonomy is manual: the user approves each task on the Projects page before dispatch.'
          : '6. Autonomy is auto: you may dispatch without waiting for approval.',
      ].join('\n')
    }

    // ---------------------------------------------------------------------
    // Components

    function ProjectsIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 18
      return h(
        'svg',
        { width: edge, height: edge, viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M6 12.4c0-1.4 1.1-2.4 2.4-2.4h5.2l2.2 2.6h11.8c1.3 0 2.4 1.1 2.4 2.4v11.6c0 1.4-1.1 2.4-2.4 2.4H8.4C7.1 29 6 27.9 6 26.6V12.4Z',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M13.4 20.2l3 3 6.4-6.6',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function StatusPill({ status, t }) {
      return h('span', { className: `pj-pill pj-pill-${status}` }, t(status))
    }

    /** Contain a failing embedded conversation so the board stays usable. */
    class EmbeddedBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('projects: embedded conversation failed', error)
      }

      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    /** Force the chat view inside the embedded Conversation. */
    function FixedChatView(props) {
      return typeof props.renderSlot === 'function'
        ? props.renderSlot('conversation.session', { view: 'chat' })
        : null
    }

    /** Render the shared Conversation content for one bound Session. */
    function ConversationContentHost(props) {
      const { sessionId, useSession, useConversation, useSessions, renderFactorySlot } = props
      const session = useSession((value) => value)
      const conversation = typeof useConversation === 'function' ? useConversation((value) => value) : undefined
      const active = (conversation && conversation.activeTargets && conversation.activeTargets.size > 0)
        || (!session.blank && !session.awaitingFirstTurn)
        || session.running
      const phase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
      const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank)
      const settling = phase === 'blank' && session.openState === 'loading' && summaryBlank !== true
      const hero = phase === 'blank' && (session.openState === 'open' || summaryBlank === true)
      const resolved = settling ? 'settling' : hero ? 'hero' : 'active'
      return renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: resolved, hero },
        { slots: { views: FixedChatView } },
      )
    }

    /** The `projects.conversation` occupant: one Conversation occurrence. */
    function EmbeddedConversation(props) {
      if (typeof props.useSession !== 'function' || typeof props.renderFactorySlot !== 'function') {
        return h('div', { className: 'pj-empty' }, 'The conversation surface is unavailable.')
      }
      return h(ConversationContentHost, props)
    }

    function ProjectsPage({ translate, getLocale, pickFolder, threadApi, renderSlot, SessionProvider, useWorkspaces }) {
      const t = translate
      const [projects, setProjects] = useState([])
      const [selectedId, setSelectedId] = useState(null)
      const [detail, setDetail] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [goalText, setGoalText] = useState('')
      const [memoryText, setMemoryText] = useState('')
      const [workspaceText, setWorkspaceText] = useState('')
      const [goalDirty, setGoalDirty] = useState(false)
      const [memoryDirty, setMemoryDirty] = useState(false)
      const [showNewProject, setShowNewProject] = useState(false)
      const [newProject, setNewProject] = useState({ name: '', goal: '', workspace: '' })
      const [newTask, setNewTask] = useState({ title: '', brief: '' })
      const [showNewTask, setShowNewTask] = useState(false)
      const [confirmDeleteId, setConfirmDeleteId] = useState(null)
      const confirmDeleteAt = useRef(0)
      const [centerView, setCenterView] = useState('chat')
      const [thread, setThread] = useState(null)
      const [execTarget, setExecTarget] = useState(null)

      const useWorkspacesSafe = typeof useWorkspaces === 'function' ? useWorkspaces : () => undefined
      const archivedSessionIds = useWorkspacesSafe((state) => state.archivedSessionIds)
      const coordinatorSessionId = detail?.project?.coordinatorSessionId
      const coordinatorArchived = Boolean(
        coordinatorSessionId &&
          Array.isArray(archivedSessionIds) &&
          archivedSessionIds.includes(coordinatorSessionId),
      )

      const selectedRef = useRef(null)
      const goalDirtyRef = useRef(false)
      const memoryDirtyRef = useRef(false)
      const workspaceDirtyRef = useRef(false)

      useEffect(() => {
        selectedRef.current = selectedId
      }, [selectedId])

      // One retained Session reference per open conversation; switching or
      // closing releases the previous one.
      useEffect(() => {
        return () => {
          try {
            thread?.reference?.release?.()
          } catch {
            // Already released.
          }
        }
      }, [thread])
      useEffect(() => {
        return () => {
          try {
            execTarget?.reference?.release?.()
          } catch {
            // Already released.
          }
        }
      }, [execTarget])

      const loadProjects = useCallback(async () => {
        const data = await api('/projects')
        setProjects(Array.isArray(data.projects) ? data.projects : [])
        return data.projects || []
      }, [])

      const loadDetail = useCallback(async (id) => {
        const data = await api(`/projects/${id}`)
        setDetail(data)
        return data
      }, [])

      const refresh = useCallback(
        async (preferredId) => {
          const list = await loadProjects()
          const target = preferredId || selectedRef.current || list[0]?.id || null
          if (target) {
            selectedRef.current = target
            setSelectedId(target)
            await loadDetail(target)
          } else {
            setDetail(null)
          }
        },
        [loadDetail, loadProjects],
      )

      // One poll loop keeps the board current while the page is open.
      useEffect(() => {
        let stopped = false
        const tick = async () => {
          try {
            const list = await loadProjects()
            if (stopped) return
            const target = selectedRef.current || list[0]?.id || null
            if (target) {
              if (!selectedRef.current) {
                selectedRef.current = target
                setSelectedId(target)
              }
              const data = await loadDetail(target)
              if (stopped) return
              setDetail(data)
            }
          } catch (failure) {
            if (!stopped) setError(messageOf(failure))
          }
        }
        void tick()
        const timer = setInterval(() => {
          void tick()
        }, 4000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [loadDetail, loadProjects])

      // A project that already has a coordinator Session reopens its
      // conversation when the project is selected.
      useEffect(() => {
        const coordinatorId = detail?.project?.coordinatorSessionId
        if (!coordinatorId) {
          setThread((current) => (current ? null : current))
          return
        }
        if (!threadApi || typeof threadApi.retain !== 'function') return undefined
        if (thread && thread.sessionId === coordinatorId) return undefined
        let cancelled = false
        const open = async () => {
          try {
            const archived = Array.isArray(archivedSessionIds) && archivedSessionIds.includes(coordinatorId)
            if (archived) await threadApi.restoreSession(coordinatorId)
            const reference = threadApi.retain(coordinatorId)
            if (cancelled) {
              try {
                reference.release()
              } catch {
                // Already released.
              }
              return
            }
            setThread({ sessionId: coordinatorId, reference })
          } catch {
            // A stale id stays closed; the start button creates a fresh coordinator.
          }
        }
        void open()
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [detail?.project?.coordinatorSessionId])

      // The Workspace snapshot can arrive after the conversation opened; when it
      // reveals an archived coordinator, restore it once so messages run again.
      useEffect(() => {
        if (!coordinatorArchived || !coordinatorSessionId || !threadApi) return
        void threadApi.restoreSession(coordinatorSessionId).catch(() => {
          // The banner keeps the manual restore available.
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [coordinatorArchived, coordinatorSessionId])

      // A different project resets the edit buffers, the executor pane and the
      // center view before they are synced.
      useEffect(() => {
        goalDirtyRef.current = false
        memoryDirtyRef.current = false
        workspaceDirtyRef.current = false
        setGoalDirty(false)
        setMemoryDirty(false)
        setCenterView('chat')
        setExecTarget((current) => (current ? null : current))
      }, [detail?.project?.id])

      useEffect(() => {
        if (!detail) return
        if (!goalDirtyRef.current) setGoalText(detail.project?.goal || '')
        if (!memoryDirtyRef.current) setMemoryText(detail.memory || '')
        if (!workspaceDirtyRef.current) setWorkspaceText(detail.project?.workspace || '')
      }, [detail])

      // A success notice is transient; an error stays until the next action.
      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(''), 6000)
        return () => clearTimeout(timer)
      }, [notice])

      const run = async (action) => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const message = await action()
          if (message) setNotice(message)
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }

      const project = detail?.project || null
      const projectId = project?.id || null
      const taskList = project?.tasks || []

      const createProject = () =>
        run(async () => {
          if (!newProject.name.trim()) throw new Error(t('nameRequired'))
          const created = await api('/projects', {
            method: 'POST',
            body: JSON.stringify({
              name: newProject.name.trim(),
              goal: newProject.goal.trim(),
              workspace: newProject.workspace.trim(),
            }),
          })
          setNewProject({ name: '', goal: '', workspace: '' })
          setShowNewProject(false)
          await refresh(created.project.id)
          return t('projectCreated')
        })

      const saveProjectPatch = async (patch) => {
        if (!projectId) return
        await api(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(patch) })
        await refresh(projectId)
      }

      const patchProject = (patch) =>
        run(async () => {
          await saveProjectPatch(patch)
          return ''
        })

      const saveInstructions = () =>
        run(async () => {
          if (!projectId) return ''
          await api(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ goal: goalText }) })
          goalDirtyRef.current = false
          setGoalDirty(false)
          await refresh(projectId)
          return t('saved')
        })

      const saveMemory = () =>
        run(async () => {
          if (!projectId) return ''
          await api(`/projects/${projectId}/memory`, { method: 'POST', body: JSON.stringify({ text: memoryText }) })
          memoryDirtyRef.current = false
          setMemoryDirty(false)
          await refresh(projectId)
          return t('saved')
        })

      // The Host's own directory chooser: the same dialog the workspace picker
      // uses, so a project folder is chosen rather than typed.
      const chooseNewProjectFolder = () =>
        run(async () => {
          const path = await pickFolder()
          if (path) setNewProject((current) => ({ ...current, workspace: path }))
          return ''
        })

      const chooseWorkspace = () =>
        run(async () => {
          const path = await pickFolder()
          if (!path) return ''
          setWorkspaceText(path)
          workspaceDirtyRef.current = false
          await saveProjectPatch({ workspace: path })
          return t('saved')
        })

      const clearWorkspace = () =>
        run(async () => {
          setWorkspaceText('')
          workspaceDirtyRef.current = false
          await saveProjectPatch({ workspace: '' })
          return t('saved')
        })

      const toggleArchive = () =>
        run(async () => {
          if (!projectId) return ''
          const archived = !project.archived
          await api(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ archived }) })
          await refresh(projectId)
          return archived ? t('archived') : t('unarchived')
        })

      const addTask = () =>
        run(async () => {
          if (!projectId) return ''
          if (!newTask.title.trim()) throw new Error(t('titleRequired'))
          await api(`/projects/${projectId}/tasks`, {
            method: 'POST',
            body: JSON.stringify({ title: newTask.title.trim(), brief: newTask.brief.trim() }),
          })
          setNewTask({ title: '', brief: '' })
          setShowNewTask(false)
          await refresh(projectId)
          return t('taskAdded')
        })

      const patchTask = (taskId, patch) =>
        run(async () => {
          await api(`/projects/${projectId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(patch) })
          await refresh(projectId)
          return ''
        })

      const deleteTask = (taskId) =>
        run(async () => {
          await api(`/projects/${projectId}/tasks/${taskId}`, { method: 'DELETE' })
          if (execTarget && execTarget.taskId === taskId) setExecTarget(null)
          await refresh(projectId)
          return t('deleted')
        })

      const startCoordinator = () =>
        run(async () => {
          if (!project) return ''
          if (!threadApi || typeof threadApi.ensure !== 'function') {
            throw new Error('The session service is unavailable on this page.')
          }
          let locale = 'zh'
          try {
            locale = typeof getLocale === 'function' ? getLocale() : 'zh'
          } catch {
            locale = 'zh'
          }
          const restored = coordinatorArchived && Boolean(project.coordinatorSessionId)
          if (restored) await threadApi.restoreSession(project.coordinatorSessionId)
          const result = await threadApi.ensure(project, coordinatorPrompt(project, locale))
          setThread({ sessionId: result.sessionId, reference: result.reference })
          setCenterView('chat')
          if (result.created && result.sessionId !== project.coordinatorSessionId) {
            await saveProjectPatch({ coordinatorSessionId: result.sessionId })
            return t('coordinatorCreated')
          }
          if (restored) return t('coordinatorRestored')
          return t('coordinatorResumed')
        })

      const openWorker = (task) =>
        run(async () => {
          if (!task.childSessionId) return t('noConversation')
          if (!threadApi || typeof threadApi.retainWorker !== 'function') {
            throw new Error('The session service is unavailable on this page.')
          }
          const archivedSet = Array.isArray(archivedSessionIds) ? archivedSessionIds : []
          if (project?.coordinatorSessionId && archivedSet.includes(project.coordinatorSessionId)) {
            await threadApi.restoreSession(project.coordinatorSessionId)
          }
          if (archivedSet.includes(task.childSessionId)) {
            await threadApi.restoreSession(task.childSessionId)
          }
          const reference = threadApi.retainWorker(task.childSessionId, project?.coordinatorSessionId)
          setExecTarget({ taskId: task.id, title: task.title, sessionId: task.childSessionId, reference })
          return ''
        })

      const restoreCoordinator = () =>
        run(async () => {
          if (!project?.coordinatorSessionId || !threadApi) return ''
          await threadApi.restoreSession(project.coordinatorSessionId)
          return t('coordinatorRestored')
        })

      const openInWorkspace = (sessionId) => {
        try {
          threadApi.openInWorkspace(sessionId)
        } catch {
          // Navigation is best-effort.
        }
      }

      const renderSettings = () =>
        h(
          'div',
          { className: 'pj-settings' },
          h(
            'div',
            { className: 'pj-section' },
            h(
              'div',
              { className: 'pj-section-head' },
              h('h2', { className: 'pj-section-title' }, t('instructions')),
              h(
                'button',
                { className: 'pj-btn', onClick: saveInstructions, disabled: busy || !goalDirty, type: 'button' },
                t('save'),
              ),
            ),
            h('div', { className: 'pj-hint' }, t('instructionsHint')),
            h('textarea', {
              className: 'pj-textarea',
              'aria-label': t('instructions'),
              placeholder: t('instructionsPlaceholder'),
              value: goalText,
              onChange: (event) => {
                goalDirtyRef.current = true
                setGoalDirty(true)
                setGoalText(event.target.value)
              },
            }),
          ),
          h(
            'div',
            { className: 'pj-section' },
            h('div', { className: 'pj-section-head' }, h('h2', { className: 'pj-section-title' }, t('policy'))),
            h(
              'div',
              { className: 'pj-row' },
              h(
                'label',
                { className: 'pj-field pj-grow' },
                h('span', { className: 'pj-label' }, t('autonomy')),
                h(
                  'select',
                  {
                    className: 'pj-select',
                    value: project.autonomy,
                    disabled: busy,
                    onChange: (event) => void patchProject({ autonomy: event.target.value }),
                  },
                  h('option', { value: 'manual' }, t('autonomyManual')),
                  h('option', { value: 'auto' }, t('autonomyAuto')),
                ),
              ),
              h(
                'label',
                { className: 'pj-field' },
                h('span', { className: 'pj-label' }, t('concurrency')),
                h('input', {
                  className: 'pj-input',
                  'aria-label': t('concurrency'),
                  type: 'number',
                  min: 1,
                  max: 8,
                  defaultValue: project.concurrency,
                  disabled: busy,
                  style: { width: '72px' },
                  onBlur: (event) => {
                    const value = Number(event.target.value)
                    if (Number.isFinite(value) && value !== project.concurrency) {
                      void patchProject({ concurrency: value })
                    }
                  },
                }),
              ),
              h(
                'div',
                { className: 'pj-field pj-grow' },
                h('span', { className: 'pj-label' }, t('workspace')),
                h(
                  'div',
                  { className: 'pj-row', style: { flexWrap: 'nowrap', gap: '8px' } },
                  h('input', {
                    className: 'pj-input pj-grow',
                    'aria-label': t('workspace'),
                    value: workspaceText,
                    placeholder: t('noWorkspace'),
                    disabled: busy,
                    onChange: (event) => {
                      workspaceDirtyRef.current = true
                      setWorkspaceText(event.target.value)
                    },
                    onBlur: (event) => {
                      const value = event.target.value.trim()
                      if (value !== (project.workspace || '')) void patchProject({ workspace: value })
                    },
                  }),
                  h(
                    'button',
                    { className: 'pj-btn', type: 'button', disabled: busy, onClick: chooseWorkspace },
                    t('chooseFolder'),
                  ),
                  project.workspace &&
                    h(
                      'button',
                      {
                        className: 'pj-btn pj-btn-ghost',
                        type: 'button',
                        disabled: busy,
                        onClick: clearWorkspace,
                      },
                      t('clear'),
                    ),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'pj-section' },
            h(
              'div',
              { className: 'pj-section-head' },
              h('h2', { className: 'pj-section-title' }, t('memory')),
              h(
                'button',
                { className: 'pj-btn', onClick: saveMemory, disabled: busy || !memoryDirty, type: 'button' },
                t('save'),
              ),
            ),
            h('div', { className: 'pj-hint' }, t('memoryHint')),
            h('textarea', {
              className: 'pj-textarea',
              'aria-label': t('memory'),
              placeholder: t('memoryPlaceholder'),
              value: memoryText,
              onChange: (event) => {
                memoryDirtyRef.current = true
                setMemoryDirty(true)
                setMemoryText(event.target.value)
              },
            }),
          ),
        )

      const renderTask = (task) =>
        h(
          'div',
          { key: task.id, className: 'pj-task' },
          h(
            'div',
            { className: 'pj-task-head' },
            h(StatusPill, { status: task.status, t }),
            h('span', { className: 'pj-task-title' }, task.title),
            task.approved && h('span', { className: 'pj-badge' }, t('approvedBadge')),
          ),
          task.brief && h('div', { className: 'pj-task-body' }, task.brief),
          task.output
            ? h('div', { className: 'pj-task-output' }, task.output)
            : (task.status === 'review' || task.status === 'done' || task.status === 'failed') &&
              h('div', { className: 'pj-task-output pj-task-meta' }, t('noOutput')),
          task.stopReason && h('div', { className: 'pj-task-meta' }, `${t('stopReason')}: ${task.stopReason}`),
          task.childName && h('div', { className: 'pj-task-meta' }, `${t('worker')}: ${task.childName}`),
          h(
            'div',
            { className: 'pj-task-foot' },
            task.childSessionId &&
              h(
                'button',
                { className: 'pj-btn', type: 'button', disabled: busy, onClick: () => openWorker(task) },
                t('openConversation'),
              ),
            project.autonomy === 'manual' &&
              !task.approved &&
              task.status !== 'running' &&
              h(
                'button',
                {
                  className: 'pj-btn pj-btn-primary',
                  onClick: () => patchTask(task.id, { approved: true }),
                  disabled: busy || project.archived,
                  type: 'button',
                },
                t('approve'),
              ),
            h(
              'select',
              {
                className: 'pj-select',
                style: { width: 'auto' },
                value: task.status,
                disabled: busy || task.status === 'running',
                'aria-label': t('status'),
                onChange: (event) => void patchTask(task.id, { status: event.target.value }),
              },
              ['queued', 'running', 'review', 'done', 'failed', 'blocked'].map((status) =>
                h('option', { key: status, value: status }, t(status)),
              ),
            ),
            task.status !== 'running' &&
              h(
                'button',
                {
                  className: 'pj-btn pj-btn-ghost pj-btn-danger',
                  onClick: () => {
                    // A double-click on "Delete" must not confirm itself: the
                    // second click only counts after the arm has settled.
                    if (confirmDeleteId === task.id && Date.now() - confirmDeleteAt.current > 600) {
                      setConfirmDeleteId(null)
                      void deleteTask(task.id)
                      return
                    }
                    setConfirmDeleteId(task.id)
                    confirmDeleteAt.current = Date.now()
                    setTimeout(() => {
                      setConfirmDeleteId((current) => (current === task.id ? null : current))
                    }, 3000)
                  },
                  disabled: busy,
                  type: 'button',
                },
                confirmDeleteId === task.id ? t('deleteConfirm') : t('delete'),
              ),
          ),
        )

      const groups = ['review', 'running', 'queued', 'done', 'failed', 'blocked']
        .map((status) => ({ status, tasks: taskList.filter((task) => task.status === status) }))
        .filter((group) => group.tasks.length > 0)

      return h(
        'div',
        { className: 'pj-page' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'aside',
          { className: 'pj-list' },
          h(
            'div',
            { className: 'pj-list-head' },
            h('span', { className: 'pj-list-title' }, t('projects')),
            h(
              'button',
              {
                className: 'pj-btn pj-btn-ghost',
                onClick: () => setShowNewProject((value) => !value),
                disabled: busy,
                type: 'button',
              },
              t('newProject'),
            ),
          ),
          showNewProject &&
            h(
              'div',
              { className: 'pj-new-project' },
              h('input', {
                className: 'pj-input',
                'aria-label': t('projectName'),
                placeholder: t('projectName'),
                value: newProject.name,
                onChange: (event) => setNewProject({ ...newProject, name: event.target.value }),
              }),
              h('textarea', {
                className: 'pj-textarea',
                style: { minHeight: '64px' },
                'aria-label': t('instructions'),
                placeholder: t('instructionsPlaceholder'),
                value: newProject.goal,
                onChange: (event) => setNewProject({ ...newProject, goal: event.target.value }),
              }),
              h(
                'div',
                { className: 'pj-row', style: { flexWrap: 'nowrap', gap: '8px' } },
                h('input', {
                  className: 'pj-input pj-grow',
                  'aria-label': t('workspace'),
                  placeholder: t('workspacePlaceholder'),
                  value: newProject.workspace,
                  onChange: (event) => setNewProject({ ...newProject, workspace: event.target.value }),
                }),
                h(
                  'button',
                  { className: 'pj-btn', type: 'button', disabled: busy, onClick: chooseNewProjectFolder },
                  t('chooseFolderShort'),
                ),
              ),
              h(
                'div',
                { className: 'pj-row' },
                h(
                  'button',
                  { className: 'pj-btn pj-btn-primary', onClick: createProject, disabled: busy, type: 'button' },
                  t('create'),
                ),
                h(
                  'button',
                  {
                    className: 'pj-btn pj-btn-ghost',
                    onClick: () => setShowNewProject(false),
                    disabled: busy,
                    type: 'button',
                  },
                  t('cancel'),
                ),
              ),
            ),
          h(
            'div',
            { className: 'pj-list-scroll' },
            projects.length === 0
              ? h(
                  'div',
                  { className: 'pj-empty' },
                  h('div', null, t('noProjects')),
                  h(
                    'div',
                    { className: 'pj-empty-action' },
                    h(
                      'button',
                      {
                        className: 'pj-btn pj-btn-primary',
                        type: 'button',
                        onClick: () => setShowNewProject(true),
                      },
                      t('newProject'),
                    ),
                  ),
                )
              : projects.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.id,
                      type: 'button',
                      className: `pj-list-item${entry.id === selectedId ? ' pj-active' : ''}`,
                      onClick: () => {
                        if (
                          (goalDirtyRef.current || memoryDirtyRef.current || workspaceDirtyRef.current) &&
                          typeof window.confirm === 'function' &&
                          !window.confirm(t('switchDiscard'))
                        ) {
                          return
                        }
                        selectedRef.current = entry.id
                        setSelectedId(entry.id)
                        void loadDetail(entry.id).catch((failure) => setError(messageOf(failure)))
                      },
                    },
                    h('span', { className: 'pj-list-name' }, entry.name),
                    h(
                      'span',
                      { className: 'pj-list-meta' },
                      `${countsLine(entry, t)}${entry.archived ? ` · ${t('archivedBadge')}` : ''}`,
                    ),
                  ),
                ),
          ),
        ),
        h(
          'section',
          { className: 'pj-main' },
          h(
            'header',
            { className: 'pj-main-head' },
            h(
              'div',
              { className: 'pj-main-title' },
              h('h1', { className: 'pj-title' }, project ? project.name : t('title')),
              project?.archived && h('span', { className: 'pj-badge' }, t('archivedBadge')),
            ),
            project &&
              h(
                'div',
                { className: 'pj-actions' },
                h(
                  'button',
                  {
                    className: `pj-btn${centerView === 'chat' ? ' pj-btn-primary' : ''}`,
                    type: 'button',
                    onClick: () => setCenterView('chat'),
                  },
                  t('chatTab'),
                ),
                h(
                  'button',
                  {
                    className: `pj-btn${centerView === 'settings' ? ' pj-btn-primary' : ''}`,
                    type: 'button',
                    onClick: () => setCenterView('settings'),
                  },
                  t('settingsTab'),
                ),
                h(
                  'button',
                  { className: 'pj-btn pj-btn-ghost', onClick: toggleArchive, disabled: busy, type: 'button' },
                  project.archived ? t('unarchive') : t('archive'),
                ),
              ),
          ),
          error && h('div', { className: 'pj-error', role: 'alert' }, `${t('error')}: ${error}`),
          notice && h('div', { className: 'pj-notice', role: 'status' }, notice),
          h(
            'div',
            { className: 'pj-main-body' },
            coordinatorArchived &&
              h(
                'div',
                { className: 'pj-warn', role: 'status' },
                h('span', { className: 'pj-warn-text' }, t('coordinatorArchived')),
                h(
                  'button',
                  { className: 'pj-btn', type: 'button', disabled: busy, onClick: restoreCoordinator },
                  t('restore'),
                ),
              ),
            !project
              ? h('div', { className: 'pj-empty' }, t('noSelection'))
              : centerView === 'settings'
                ? h('div', { className: 'pj-main-scroll' }, renderSettings())
                : h(
                    'div',
                    { className: 'pj-chat-body' },
                    thread
                      ? h(
                          EmbeddedBoundary,
                          { fallback: h('div', { className: 'pj-empty' }, t('coordinatorChatFailed')) },
                          typeof SessionProvider === 'function' && typeof renderSlot === 'function'
                            ? h(SessionProvider, { session: thread.reference }, renderSlot('projects.conversation', {}))
                            : h('div', { className: 'pj-empty' }, t('coordinatorChatFailed')),
                        )
                      : h(
                          'div',
                          { className: 'pj-empty pj-start' },
                          h('div', null, t('startCoordinatorHint')),
                          h(
                            'div',
                            { className: 'pj-empty-action' },
                            h(
                              'button',
                              {
                                className: 'pj-btn pj-btn-primary',
                                type: 'button',
                                onClick: startCoordinator,
                                disabled: busy || project.archived,
                                title: project.archived ? t('archivedHint') : undefined,
                              },
                              t('startCoordinator'),
                            ),
                          ),
                        ),
                  ),
          ),
        ),
        h(
          'aside',
          { className: 'pj-exec' },
          h(
            'header',
            { className: 'pj-exec-head' },
            execTarget
              ? h(
                  'button',
                  { className: 'pj-btn pj-btn-ghost', type: 'button', onClick: () => setExecTarget(null) },
                  `← ${t('executors')}`,
                )
              : h('h2', { className: 'pj-exec-title' }, t('executors')),
            execTarget
              ? h(
                  'div',
                  { className: 'pj-actions' },
                  h('span', { className: 'pj-exec-task', title: execTarget.title }, execTarget.title),
                  h(
                    'button',
                    {
                      className: 'pj-btn pj-btn-ghost',
                      type: 'button',
                      onClick: () => openInWorkspace(execTarget.sessionId),
                    },
                    t('openInWorkspace'),
                  ),
                )
              : h(
                  'div',
                  { className: 'pj-actions' },
                  h(
                    'button',
                    {
                      className: 'pj-btn',
                      type: 'button',
                      disabled: busy || !project,
                      onClick: () => setShowNewTask((value) => !value),
                    },
                    t('addTask'),
                  ),
                  h(
                    'button',
                    {
                      className: 'pj-btn pj-btn-ghost',
                      type: 'button',
                      disabled: busy || !project,
                      onClick: () => {
                        void refresh(projectId).catch((failure) => setError(messageOf(failure)))
                      },
                    },
                    t('refresh'),
                  ),
                ),
          ),
          !project
            ? null
            : execTarget
              ? h(
                  'div',
                  { className: 'pj-chat-body' },
                  h(
                    EmbeddedBoundary,
                    { fallback: h('div', { className: 'pj-empty' }, t('workerChatFailed')) },
                    typeof SessionProvider === 'function' && typeof renderSlot === 'function'
                      ? h(SessionProvider, { session: execTarget.reference }, renderSlot('projects.conversation', {}))
                      : h('div', { className: 'pj-empty' }, t('workerChatFailed')),
                  ),
                )
              : h(
                  'div',
                  { className: 'pj-exec-scroll' },
                  showNewTask &&
                    h(
                      'div',
                      { className: 'pj-form', style: { marginBottom: '10px' } },
                      h('input', {
                        className: 'pj-input',
                        'aria-label': t('taskTitle'),
                        placeholder: t('taskTitle'),
                        value: newTask.title,
                        onChange: (event) => setNewTask({ ...newTask, title: event.target.value }),
                      }),
                      h('textarea', {
                        className: 'pj-textarea',
                        style: { minHeight: '64px' },
                        'aria-label': t('taskBrief'),
                        placeholder: t('taskBrief'),
                        value: newTask.brief,
                        onChange: (event) => setNewTask({ ...newTask, brief: event.target.value }),
                      }),
                      h(
                        'div',
                        { className: 'pj-row' },
                        h(
                          'button',
                          { className: 'pj-btn pj-btn-primary', onClick: addTask, disabled: busy, type: 'button' },
                          t('add'),
                        ),
                        h(
                          'button',
                          {
                            className: 'pj-btn pj-btn-ghost',
                            onClick: () => setShowNewTask(false),
                            disabled: busy,
                            type: 'button',
                          },
                          t('cancel'),
                        ),
                      ),
                    ),
                  groups.length === 0
                    ? h('div', { className: 'pj-empty' }, t('emptyTasks'))
                    : groups.map((group) =>
                        h(
                          'div',
                          { key: group.status, className: 'pj-group' },
                          h(
                            'div',
                            { className: 'pj-group-title' },
                            `${t(group.status)} · ${group.tasks.length}`,
                          ),
                          group.tasks.map(renderTask),
                        ),
                      ),
                ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Plugin

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'sessions'],
      apply(ctx) {
        const activeLocale = () => {
          try {
            return String(ctx.locale.getLocale().active || 'zh')
          } catch {
            return 'zh'
          }
        }
        const dictionary = () => (activeLocale().toLowerCase().startsWith('zh') ? ZH : EN)
        const translate = (key) => dictionary()[key] || EN[key] || key

        try {
          ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'projects: dictionaries')
        } catch {
          // A namespace left behind by an earlier activation must not block the page.
        }

        const pickFolder = async () => {
          const workspace = ctx.get('uiWorkspace')
          if (!workspace || typeof workspace.pickDirectory !== 'function') {
            throw new Error('The directory picker is unavailable on this page.')
          }
          return await workspace.pickDirectory()
        }

        // An archived Session rejects every model step, so a message sent to it
        // silently does nothing. The page knows the archived set from its
        // Workspace snapshot and restores a conversation before opening it.
        const restoreSession = async (sessionId) => {
          if (!sessionId) return false
          const workspace = ctx.get('uiWorkspace')
          if (!workspace || typeof workspace.unarchiveSession !== 'function') return false
          await workspace.unarchiveSession(sessionId)
          return true
        }

        // One coordinator Session per project, retained by this page and shown
        // in the embedded conversation instead of navigating away.
        const threadApi = {
          restoreSession(sessionId) {
            return restoreSession(sessionId)
          },
          async ensure(project, prompt) {
            const sessions = ctx.get('sessions')
            if (!sessions || typeof sessions.create !== 'function') {
              throw new Error('The session service is unavailable on this page.')
            }
            const existing = typeof project.coordinatorSessionId === 'string' ? project.coordinatorSessionId : ''
            let sessionId = existing
            let created = false
            let reference
            if (sessionId) {
              try {
                reference = sessions.retain(sessionId, { source: 'projects' })
                await reference.ready
              } catch {
                // The saved Session is gone: start a fresh coordinator.
                reference = undefined
                sessionId = ''
              }
            }
            if (!sessionId) {
              sessionId = await sessions.create(project.workspace ? { cwd: project.workspace } : {})
              created = true
              reference = sessions.retain(sessionId, { source: 'projects' })
              await reference.ready
            }
            if (created) {
              const result = await reference.binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
              if (!result || result.ok !== true) {
                reference.release()
                throw new Error(
                  (result && result.error && result.error.message) || 'The coordinator prompt was rejected.',
                )
              }
            }
            return { sessionId, reference, created }
          },
          retain(sessionId) {
            const sessions = ctx.get('sessions')
            if (!sessions || typeof sessions.retain !== 'function') {
              throw new Error('The session service is unavailable on this page.')
            }
            return sessions.retain(sessionId, { source: 'projects' })
          },
          retainWorker(childSessionId, parentSessionId) {
            const sessions = ctx.get('sessions')
            if (!sessions || typeof sessions.retain !== 'function') {
              throw new Error('The session service is unavailable on this page.')
            }
            if (parentSessionId) {
              try {
                return sessions.retain(
                  { parentSessionId, childSessionId, mode: 'continuable' },
                  { source: 'projects' },
                )
              } catch {
                // Fall back to the plain identity when the address is stale.
              }
            }
            return sessions.retain(childSessionId, { source: 'projects' })
          },
          openInWorkspace(sessionId) {
            const workspace = ctx.get('uiWorkspace')
            if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
          },
        }

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'projects', order: 30, label: () => translate('nav') },
            ProjectsIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'projects',
              // The page hosts one Conversation occurrence for the coordinator.
              children: { 'projects.conversation': { kind: 'single', scope: 'session' } },
            },
            (props) =>
              h(ProjectsPage, {
                ...props,
                translate,
                getLocale: activeLocale,
                pickFolder,
                threadApi,
              }),
          ),
        )
        ctx.slots.inject('projects.conversation', () =>
          ctx.slots.register({ name: 'projects.conversation' }, EmbeddedConversation),
        )
      },
    }
  },
})
