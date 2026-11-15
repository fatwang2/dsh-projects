/**
 * Projects — Client half.
 *
 * Registers two slot contributions:
 *   - `sidebar.panellist` id `projects`: the board glyph in the left column.
 *   - `main` key `projects`: the project board (project list, instructions,
 *     shared memory, task board) that glyph selects.
 *
 * All data comes from the Host half's same-origin `/projects-api/*` routes.
 * The page is a viewer and a human control surface: it creates projects,
 * approves tasks for dispatch, resolves finished work, edits the shared memory
 * and reads worker output. Tasks themselves are derived by the coordinator
 * through the `projects_add_task` tool, and `task.status` is system-owned: the
 * page renders it and never writes it. The only task field a human writes is
 * `resolved`.
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
      startCoordinator: 'Start coordinator',
      startCoordinatorHint: 'The coordinator plans the goal and dispatches tasks. Its conversation lives in this column.',
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
      projectCreated: 'Project created.',
      saved: 'Saved.',
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
      autonomyManual: 'Manual — the user approves each dispatch in the conversation',
      autonomyAuto: 'Auto — the coordinator dispatches freely',
      concurrency: 'Parallel workers',
      workspace: 'Workspace',
      emptyTasks: 'No tasks yet. Ask the coordinator in the conversation to split the goal.',
      approve: 'Approve',
      approvedBadge: 'Approved',
      brief: 'Brief',
      output: 'Output',
      noBrief: 'No brief recorded.',
      noTask: 'This task is no longer on the board.',
      resolve: 'Mark resolved',
      unresolve: 'Mark unresolved',
      resolvedBadge: 'Resolved',
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
      collapseList: 'Collapse project list',
      expandList: 'Expand project list',
      resizeColumns: 'Resize columns',
      taskActions: 'Task actions',
      threads: 'Threads',
      searchThreads: 'Search threads',
      collapseAll: 'Collapse all',
      expandAll: 'Expand all',
      noMatches: 'No threads match.',
      groupRunning: 'Running',
      groupReview: 'Ready for review',
      groupWaiting: 'Waiting on you',
      groupIdle: 'Idle',
      groupResolved: 'Resolved',
      justNow: 'just now',
      execution: 'Execution',
      executionHint:
        'Default model and agent preset for every worker in this project. A task may override them.',
      model: 'Model',
      agentPreset: 'Agent preset',
      modelDefault: 'Default (inherits host)',
      modelInheritProject: 'Inherit project default',
      modelRoutePlaceholder: 'provider/model',
      modelFreeTextHint:
        'The model list could not be enumerated — type a route such as provider/model.',
      presetFreeTextHint: 'The preset list could not be enumerated — type a preset id.',
      effectiveModel: 'Effective model',
      fromTask: 'from task',
      fromProject: 'from project',
      fromHost: 'host default',
      taskModel: 'Task model',
      taskModelReadonly:
        'Task-level model is set by the coordinator (projects_update_task); this page is read-only.',
    }

    const ZH = {
      nav: '项目',
      title: '项目',
      chatTab: '对话',
      settingsTab: '设置',
      startCoordinator: '启动协调者',
      startCoordinatorHint: '协调者负责拆解目标、派发任务；它的对话就在这一栏。',
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
      projectCreated: '项目已创建。',
      saved: '已保存。',
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
      autonomyManual: '手动 —— 每次派发都需要用户在对话里同意',
      autonomyAuto: '自动 —— 协调者可直接派发',
      concurrency: '并行执行者',
      workspace: '工作区',
      emptyTasks: '还没有任务。在对话里让协调者拆解目标，任务由它派生。',
      approve: '批准',
      approvedBadge: '已批准',
      brief: '任务说明',
      output: '产出',
      noBrief: '没有任务说明。',
      noTask: '这个任务已不在看板上了。',
      resolve: '标记为已解决',
      unresolve: '标记为未解决',
      resolvedBadge: '已解决',
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
      collapseList: '收起项目栏',
      expandList: '展开项目栏',
      resizeColumns: '调整栏宽',
      taskActions: '任务操作',
      threads: '线程',
      searchThreads: '搜索线程',
      collapseAll: '全部折叠',
      expandAll: '全部展开',
      noMatches: '没有匹配的线程。',
      groupRunning: '执行中',
      groupReview: '待验收',
      groupWaiting: '等你处理',
      groupIdle: '空闲',
      groupResolved: '已解决',
      justNow: '刚刚',
      execution: '执行',
      executionHint: '本项目所有执行者的默认模型与 Agent 预设；单个任务可以覆盖。',
      model: '模型',
      agentPreset: 'Agent 预设',
      modelDefault: '默认（继承宿主）',
      modelInheritProject: '继承项目默认',
      modelRoutePlaceholder: 'provider/model',
      modelFreeTextHint: '无法枚举模型列表，请手填路由，例如 provider/model。',
      presetFreeTextHint: '无法枚举预设列表，请手填预设 id。',
      effectiveModel: '生效模型',
      fromTask: '来自任务',
      fromProject: '来自项目',
      fromHost: '宿主默认',
      taskModel: '任务模型',
      taskModelReadonly: '任务级模型由协调者设置（projects_update_task），页面只读。',
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
.pj-list.pj-collapsed{flex:0 0 44px;width:44px;overflow:hidden}
.pj-rail{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0;min-height:0;overflow:auto}
.pj-rail-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.pj-rail-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pj-rail-btn.pj-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.pj-resizer{position:relative;flex:0 0 5px;width:5px;padding:0;border:0;background:transparent;cursor:col-resize;touch-action:none}
.pj-resizer::after{content:'';position:absolute;inset:0 -3px}
.pj-resizer:hover,.pj-resizer:focus-visible{background:var(--dsw-alias-border-l2)}
.pj-page.pj-resizing{cursor:col-resize;user-select:none}
.pj-new-project{display:flex;flex-direction:column;gap:8px;padding:4px 14px 14px}
.pj-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;border-right:1px solid var(--dsw-alias-border-l2)}
.pj-main-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);min-height:56px;box-sizing:border-box}
[data-platform='darwin'] .pj-list-head{padding-top:calc(16px + var(--dsh-frame-top-clearance, 0px))}
[data-platform='darwin'] .pj-rail{padding-top:calc(10px + var(--dsh-frame-top-clearance, 0px))}
[data-platform='darwin'] .pj-main-head{padding-top:calc(14px + var(--dsh-frame-top-clearance, 0px))}
[data-platform='darwin'] .pj-exec-head{padding-top:calc(12px + var(--dsh-frame-top-clearance, 0px))}
.pj-main-title{display:flex;align-items:center;gap:8px;min-width:0}
.pj-title{margin:0;font-size:18px;line-height:26px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-main-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.pj-main-scroll{flex:1;min-height:0;overflow:auto;padding:16px clamp(16px,3vw,32px) 40px}
.pj-settings{max-width:760px;margin:0 auto}
.pj-chat-body{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.pj-exec{display:flex;flex-direction:column;flex:0 0 380px;width:380px;min-width:0;min-height:0;background:var(--dsw-alias-bg-layer-1)}
.pj-exec-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);min-height:56px;box-sizing:border-box}
.pj-exec-title{margin:0;font-size:14px;font-weight:600}
.pj-exec-task{min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-secondary)}
.pj-exec-scroll{flex:1;min-height:0;overflow:auto;padding:12px 14px 32px}
/* The detail column is a plain vertical flex box: the info pane shrinks and
   scrolls, the executor conversation keeps a floor and takes the rest. No
   percentage caps and no absolutely positioned layers, so the two halves can
   never paint over each other. */
.pj-exec-detail{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.pj-exec-info{flex:0 1 auto;min-height:0;overflow:auto;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.pj-exec-detail > .pj-chat-body{flex:1 1 0;min-height:140px}
.pj-exec-info .pj-task-output{max-height:none}
.pj-exec-tools{display:flex;align-items:center;gap:8px;padding:0 14px 10px}
.pj-search{flex:1 1 auto;min-width:0;height:28px;padding:0 10px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.pj-search:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.pj-group{margin-bottom:14px}
.pj-group-title{display:flex;align-items:center;gap:6px;width:100%;padding:3px 2px;margin-bottom:4px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;font-weight:500;text-align:left;cursor:pointer}
.pj-group-title:hover{color:var(--dsw-alias-label-primary)}
.pj-group-chevron{display:inline-block;width:10px;flex:0 0 auto;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary)}
.pj-group-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-thread-icon{grid-area:icon;align-self:start;margin-top:3px;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:0 0 auto}
.pj-thread-review{color:var(--dsw-alias-state-success-primary)}
.pj-thread-waiting{color:var(--dsw-alias-state-warn-primary)}
.pj-thread-idle{color:var(--dsw-alias-label-tertiary)}
.pj-thread-spinner{width:12px;height:12px;box-sizing:border-box;border-radius:999px;border:2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 25%, transparent);border-top-color:var(--dsw-alias-state-business-primary);animation:pj-spin .9s linear infinite}
.pj-thread-idle-dot{width:10px;height:10px;box-sizing:border-box;border-radius:999px;border:1.5px dashed currentColor}
@keyframes pj-spin{to{transform:rotate(360deg)}}
.pj-start{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:24px;text-align:center}
.pj-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.pj-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.pj-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pj-btn:disabled{opacity:.5;cursor:default}
.pj-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.pj-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.pj-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.pj-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pj-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.pj-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pj-icon-btn:disabled{opacity:.5;cursor:default}
.pj-icon-btn.pj-on{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent)}
.pj-spacer{flex:1 1 auto;min-width:0}
.pj-menu{position:fixed;z-index:60;display:flex;flex-direction:column;gap:2px;min-width:168px;max-width:280px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel)}
.pj-menu-item{display:flex;align-items:center;width:100%;padding:7px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pj-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pj-menu-item:disabled{opacity:.5;cursor:default}
.pj-menu-item.pj-danger{color:var(--dsw-alias-state-error-primary)}
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
.pj-exec-info .pj-field{margin-top:4px;max-width:320px}
.pj-model-line{font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}
.pj-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
/* A thread card: icon in the gutter, then a title line, a one-line summary and
   optional chips. Two rows plus chips, and no controls at all — every action
   lives in the right-click menu or on the detail page. */
.pj-task-row{display:grid;grid-template-columns:16px minmax(0,1fr) auto;grid-template-areas:"icon title time" "icon sub sub" "icon chips chips";align-items:center;column-gap:8px;row-gap:1px;width:100%;padding:8px 10px;margin-bottom:2px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.pj-task-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pj-task-row.pj-active{background:var(--dsw-alias-interactive-bg-active)}
.pj-task-row:disabled{opacity:.6;cursor:default}
.pj-task-name{grid-area:title;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}
.pj-thread-time{grid-area:time;justify-self:end;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.pj-thread-sub{grid-area:sub;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.pj-thread-chips{grid-area:chips;display:flex;flex-wrap:wrap;gap:4px;min-width:0;margin-top:2px}
.pj-chip{display:inline-flex;align-items:center;max-width:100%;height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pj-task-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pj-task-body{font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:6px;white-space:pre-wrap;word-break:break-word}
.pj-task-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}
.pj-task-output{margin-top:8px;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}
.pj-task-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
.pj-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
.pj-pill-queued{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pj-pill-running{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);color:var(--dsw-alias-state-business-primary)}
.pj-pill-review{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent);color:var(--dsw-alias-state-warn-primary)}
.pj-pill-failed{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);color:var(--dsw-alias-state-error-primary)}
.pj-pill-blocked{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);color:var(--dsw-alias-state-warn-primary);border:1px dashed color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}
.pj-warn{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 16px 0;padding:8px 12px;border-radius:var(--dsw-radius-sm);font-size:13px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, var(--dsw-alias-bg-base));color:var(--dsw-alias-state-warn-primary)}
.pj-warn-text{min-width:0}
.pj-notice{margin:8px 16px 0;padding:8px 12px;border-radius:var(--dsw-radius-sm);font-size:13px;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, var(--dsw-alias-bg-base));color:var(--dsw-alias-state-success-primary)}
.pj-error{margin:8px 16px 0;padding:8px 12px;border-radius:var(--dsw-radius-sm);font-size:13px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, var(--dsw-alias-bg-base));color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
.pj-empty{padding:24px 16px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center}
.pj-empty-action{margin-top:12px}
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

    // ---------------------------------------------------------------------
    // Layout helpers
    //
    // Column widths and the collapsed state are page-local preferences, so they
    // live in localStorage under a `projects.` prefix instead of the Host.

    const LIST_WIDTH = 264
    const EXEC_WIDTH = 380
    const LIST_MIN = 180
    const EXEC_MIN = 280
    const MENU_MARGIN = 8

    function readStored(key, fallback) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return fallback
        const value = window.localStorage.getItem(`projects.${key}`)
        return value === null ? fallback : value
      } catch {
        // Storage can be disabled: preferences are best-effort.
        return fallback
      }
    }

    function writeStored(key, value) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return
        window.localStorage.setItem(`projects.${key}`, String(value))
      } catch {
        // Storage can be disabled: preferences are best-effort.
      }
    }

    function readStoredNumber(key, fallback) {
      const value = Number(readStored(key, ''))
      return Number.isFinite(value) && value > 0 ? value : fallback
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max))
    }

    function viewportWidth() {
      try {
        return Number(window.innerWidth) || 0
      } catch {
        return 0
      }
    }

    function viewportHeight() {
      try {
        return Number(window.innerHeight) || 0
      } catch {
        return 0
      }
    }

    /** Half the viewport, so one column can never eat the other two. */
    function maxColumnWidth() {
      const width = viewportWidth()
      return width > 0 ? Math.round(width * 0.5) : 720
    }

    /** A display-only title: the stored task title is never rewritten. */
    function shortTitle(text, max = 40) {
      const value = String(text || '')
      return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value
    }

    function initialOf(name) {
      const value = String(name || '').trim()
      return value ? value.slice(0, 1).toUpperCase() : '·'
    }

    // ---------------------------------------------------------------------
    // Threads panel helpers
    //
    // The right column is a Threads panel: five fixed groups, one card per task
    // with a title line, a one-line summary and optional chips. Everything here
    // is display-only; no helper reads or writes `task.status`.

    /** The five groups, in render order. `resolved` outranks every status. */
    const THREAD_GROUPS = [
      { key: 'running', icon: 'spinner', titleKey: 'groupRunning', statuses: ['running'] },
      { key: 'review', icon: 'review', titleKey: 'groupReview', statuses: ['review'] },
      { key: 'waiting', icon: 'waiting', titleKey: 'groupWaiting', statuses: ['blocked', 'failed'] },
      { key: 'idle', icon: 'idle', titleKey: 'groupIdle', statuses: ['queued'] },
      { key: 'resolved', icon: 'none', titleKey: 'groupResolved', statuses: [] },
    ]

    /** The first non-empty line of a text, stripped of light markdown noise. */
    function plainLine(text) {
      const value = String(text || '')
      const line = value.split('\n').find((entry) => entry.trim())
      if (!line) return ''
      return line
        .replace(/^\s{0,3}#{1,6}\s*/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*>\s*/, '')
        .replace(/\*\*|__|`/g, '')
        .trim()
    }

    /** One line under the title: output first, then brief, then the status. */
    function taskSubtitle(task, t) {
      return plainLine(task.output) || plainLine(task.brief) || t(task.status)
    }

    /**
     * Relative age of a thread. The Host stamps `createdAt`/`updatedAt` on every
     * task and adds `startedAt`/`finishedAt` around a run, so the freshest stamp
     * wins. An unstamped task renders no time at all rather than a fake one.
     */
    function relativeTime(task, t, locale) {
      const stamp =
        Number(task.finishedAt) || Number(task.updatedAt) || Number(task.createdAt) || 0
      if (!stamp) return ''
      const delta = Date.now() - stamp
      if (!Number.isFinite(delta) || delta < 60000) return t('justNow')
      const hour = 3600000
      const day = 86400000
      if (delta < hour) return `${Math.floor(delta / 60000)}m`
      if (delta < day) return `${Math.floor(delta / hour)}h`
      if (delta < 7 * day) return `${Math.floor(delta / day)}d`
      try {
        return new Date(stamp).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
      } catch {
        return ''
      }
    }

    /** At most two chips: the model route, then the task id short code. */
    function taskChips(task) {
      const chips = []
      const model = String(task.model || '').trim()
      if (model) chips.push(model.split('/').pop() || model)
      if (task.id) chips.push(String(task.id).slice(0, 6))
      return chips.slice(0, 2)
    }

    /**
     * The Host stores a model as a route string (`provider/model`, or a bare
     * model id whose provider is inherited from the parent agent). An empty
     * string means "not set", so every reader normalizes through here.
     */
    function modelRouteOf(value) {
      return String(value || '').trim()
    }

    /** A picker label for a stored route; an unknown route stays visible. */
    function modelLabel(catalog, value) {
      const route = modelRouteOf(value)
      if (!route) return ''
      const found = (catalog.models || []).find((entry) => entry && entry.id === route)
      return found && found.label ? found.label : route
    }

    /**
     * Which layer supplies the route a dispatch would use: the task override,
     * the project default, or (when both are empty) the host's own route.
     */
    function effectiveModel(project, task) {
      const fromTask = modelRouteOf(task && task.model)
      if (fromTask) return { value: fromTask, source: 'task' }
      const fromProject = modelRouteOf(project && project.model)
      if (fromProject) return { value: fromProject, source: 'project' }
      return { value: '', source: 'host' }
    }

    /**
     * Options for a catalog-backed picker. A stored value the catalog does not
     * advertise (set by the coordinator, or a stale catalog) is appended, so
     * the control never silently drops the current setting.
     */
    function catalogOptions(catalog, list, current) {
      const entries = (catalog[list] || []).filter((entry) => entry && entry.id)
      const options = entries.map((entry) =>
        h('option', { key: entry.id, value: entry.id }, entry.label || entry.id),
      )
      const value = modelRouteOf(current)
      if (value && !entries.some((entry) => entry.id === value)) {
        options.push(h('option', { key: value, value }, value))
      }
      return options
    }

    /**
     * Bucket tasks into the five groups. A resolved task lands in `Resolved`
     * whatever its status is: the human verdict outranks the system state.
     */
    function threadGroups(tasks) {
      const buckets = new Map(THREAD_GROUPS.map((group) => [group.key, []]))
      for (const task of tasks) {
        if (task.resolved) {
          buckets.get('resolved').push(task)
          continue
        }
        const group = THREAD_GROUPS.find((entry) => entry.statuses.includes(task.status))
        if (group) buckets.get(group.key).push(task)
      }
      return THREAD_GROUPS.map((group) => ({ ...group, tasks: buckets.get(group.key) }))
    }

    /** The glyph a card shows: the same one its group carries. */
    function threadIconOf(task) {
      if (task.resolved) return 'none'
      const group = THREAD_GROUPS.find((entry) => entry.statuses.includes(task.status))
      return group ? group.icon : 'none'
    }

    /** Which groups start folded: only `Resolved`, per the reference panel. */
    const DEFAULT_COLLAPSED = { resolved: true }
    function readCollapsedGroups() {
      const raw = readStored('collapsedGroups', '')
      if (!raw) return { ...DEFAULT_COLLAPSED }
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_COLLAPSED }
        const next = {}
        for (const group of THREAD_GROUPS) next[group.key] = parsed[group.key] === true
        return next
      } catch {
        return { ...DEFAULT_COLLAPSED }
      }
    }

    function countsLine(project, t) {
      const counts = project.counts || {}
      const parts = ['running', 'review', 'queued', 'failed', 'blocked']
        .filter((status) => (counts[status] || 0) > 0)
        .map((status) => `${counts[status]} ${t(status)}`)
      if (parts.length) return parts.join(' · ')
      // The Host's counts object is per-status only; sum it rather than
      // reading a `total` field that is never sent.
      const total = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0)
      return `${total} ${t('counts')}`
    }

    function coordinatorPrompt(project, locale) {
      const zh = String(locale || '').toLowerCase().startsWith('zh')
      const tasks = project.tasks || []
      const taskLines = tasks.length
        ? tasks
            .map(
              (task) =>
                `- ${task.id} [${task.status}${task.resolved ? ', resolved' : ''}] ${task.title}`,
            )
            .join('\n')
        : zh
          ? '(还没有任务)'
          : '(none yet)'
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
          '你只负责四件事：拆解、分派、验收、汇报。',
          '',
          '1. 需要读文件、改代码、跑命令、多步排查的工作，一律用 projects_add_task 派生任务交给执行者，不要在对话里自己动手，也不要把命令输出、文件内容、排查过程贴进对话。',
          '2. 用 projects_add_task 把目标拆成可并行的任务，每个任务要能独立完成；任务说明里写清做什么、在哪里做、如何验收。',
          '3. 用 projects_dispatch 派发任务；派发后继续响应用户，不要等待。',
          '4. 执行者交回结果后，用 projects_get 查看产出，用一两句话向用户汇报结论，并请用户在项目页验收。',
          '5. 用 projects_memory 维护共享记忆，让所有执行者共享结论。',
          '6. 任务是否完成由人 resolve，你不要改 task.status，也不要替用户宣布任务已完成。',
          project.autonomy === 'manual'
            ? '7. 当前自主程度是手动：派发前需要用户在主对话里明确同意，再由你用 projects_update_task 把该任务标为 approved，然后派发。'
            : '7. 当前自主程度是自动：你可以直接派发任务。',
          '',
          '## 回答方式（硬约束）',
          '- 回答尽量短：一般不超过 3-5 句。',
          '- 不要复述任务产出：执行者的 output 已经在任务里，不要抄进对话。',
          '- 不要罗列已完成任务清单。',
          '- 不要解释你打算怎么做，直接做（拆任务、派发）或直接回答。',
          '- 一次只问必要的问题，不要一次抛多个。',
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
        'You do four things only: split the goal, dispatch, review, report.',
        '',
        '1. Anything that needs reading files, editing code, running commands, or multi-step investigation must be derived into a task with projects_add_task. Do not do that work in the conversation, and do not paste command output, file contents, or investigation steps into it.',
        '2. Use projects_add_task to split the goal into parallel, independently finishable tasks; each brief says what to do, where, and how to verify it.',
        '3. Use projects_dispatch to start tasks; stay responsive instead of waiting.',
        '4. When a worker reports back, use projects_get to read its output, report the conclusion to the user in a sentence or two, and ask the user to review it on the Projects page.',
        '5. Keep shared knowledge in projects_memory so every worker starts informed.',
        '6. The human resolves tasks; never write task.status and never declare a task complete on the user\'s behalf.',
        project.autonomy === 'manual'
          ? '7. Autonomy is manual: get the user\'s explicit go-ahead in this conversation, mark the task approved with projects_update_task, then dispatch.'
          : '7. Autonomy is auto: you may dispatch without waiting for approval.',
        '',
        '## Reply style (hard rules)',
        '- Keep answers short: usually 3-5 sentences at most.',
        '- Do not restate task output. The worker output already lives in the task; never copy it into the conversation.',
        '- Do not list completed tasks.',
        '- Do not explain what you are about to do. Just do it (split, dispatch) or answer.',
        '- Ask one necessary question at a time, never several at once.',
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

    /** The resolve toggle glyph: a check ring, filled once resolved. */
    function ResolveIcon({ done }) {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('circle', {
          cx: 8,
          cy: 8,
          r: 6.4,
          stroke: 'currentColor',
          strokeWidth: 1.6,
          fill: 'currentColor',
          fillOpacity: done ? 0.16 : 0,
        }),
        h('path', {
          d: 'M5.1 8.2l2 2 3.8-4',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** The group glyph: spinner, check ring, warning ring, dashed ring, none. */
    function ThreadIcon({ kind }) {
      if (kind === 'spinner') {
        return h('span', { className: 'pj-thread-icon pj-thread-spinner', 'aria-hidden': true })
      }
      if (kind === 'review') {
        return h(
          'svg',
          {
            className: 'pj-thread-icon pj-thread-review',
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': true,
          },
          h('circle', { cx: 8, cy: 8, r: 6.4, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', {
            d: 'M5.1 8.2l2 2 3.8-4',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )
      }
      if (kind === 'waiting') {
        return h(
          'svg',
          {
            className: 'pj-thread-icon pj-thread-waiting',
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': true,
          },
          h('circle', { cx: 8, cy: 8, r: 6.4, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', {
            d: 'M8 4.8v4',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
          }),
          h('circle', { cx: 8, cy: 11.2, r: 0.9, fill: 'currentColor' }),
        )
      }
      if (kind === 'idle') {
        return h(
          'span',
          { className: 'pj-thread-icon pj-thread-idle', 'aria-hidden': true },
          h('span', { className: 'pj-thread-idle-dot' }),
        )
      }
      // The Resolved group carries no glyph, per the reference panel.
      return null
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
      const [confirmDeleteId, setConfirmDeleteId] = useState(null)
      const confirmDeleteAt = useRef(0)
      const [centerView, setCenterView] = useState('chat')
      const [thread, setThread] = useState(null)
      const [execTarget, setExecTarget] = useState(null)
      // The worker model catalog from `GET /projects-api/models`. The Host
      // caches it for 60s, so one fetch per page load is enough; a failure or
      // `enumerable: false` degrades both pickers to free text.
      const [catalog, setCatalog] = useState({
        models: [],
        enumerable: false,
        presets: [],
        presetsEnumerable: false,
      })

      // Layout preferences (page-local, persisted in localStorage).
      const [listCollapsed, setListCollapsed] = useState(() => readStored('listCollapsed', '0') === '1')
      const [listWidth, setListWidth] = useState(() => readStoredNumber('listWidth', LIST_WIDTH))
      const [execWidth, setExecWidth] = useState(() => readStoredNumber('execWidth', EXEC_WIDTH))
      const [resizing, setResizing] = useState(null)
      // The task context menu: `{ taskId, x, y }` in viewport coordinates.
      const [menu, setMenu] = useState(null)
      const menuRef = useRef(null)

      // Threads panel: the live search query and the folded groups. The folded
      // set is a page-local preference, so it persists like the column widths.
      const [query, setQuery] = useState('')
      const [collapsedGroups, setCollapsedGroups] = useState(readCollapsedGroups)

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

      // Column preferences survive a reload; a bad stored value falls back to
      // the default above.
      useEffect(() => {
        writeStored('listCollapsed', listCollapsed ? '1' : '0')
      }, [listCollapsed])

      // Folded thread groups survive a reload too.
      useEffect(() => {
        writeStored('collapsedGroups', JSON.stringify(collapsedGroups))
      }, [collapsedGroups])

      // The context menu closes on an outside press, Escape, any scroll and a
      // resize, so it can never be left floating over stale content.
      useEffect(() => {
        if (!menu || typeof window === 'undefined') return undefined
        const onPointerDown = (event) => {
          const node = menuRef.current
          if (node && typeof node.contains === 'function' && node.contains(event.target)) return
          setMenu(null)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenu(null)
        }
        const onScroll = () => setMenu(null)
        window.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true)
          window.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
        }
      }, [menu])

      // Measure the painted menu once and pull it back inside the viewport, so a
      // right-click near an edge still shows the whole menu.
      useEffect(() => {
        const node = menuRef.current
        if (!menu || !node || typeof node.getBoundingClientRect !== 'function') return
        const rect = node.getBoundingClientRect()
        const width = viewportWidth()
        const height = viewportHeight()
        const x = clamp(menu.x, MENU_MARGIN, width - rect.width - MENU_MARGIN)
        const y = clamp(menu.y, MENU_MARGIN, height - rect.height - MENU_MARGIN)
        if (x !== menu.x || y !== menu.y) setMenu({ ...menu, x, y })
      }, [menu])

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

      // The model catalog is read-only and cached by the Host, so it is fetched
      // once per page load rather than on the 4s poll. Any failure leaves both
      // pickers in their free-text fallback instead of hiding the setting.
      useEffect(() => {
        let stopped = false
        const load = async () => {
          try {
            const data = await api('/models')
            if (stopped) return
            setCatalog({
              models: Array.isArray(data.models) ? data.models : [],
              enumerable: data.enumerable === true,
              presets: Array.isArray(data.presets) ? data.presets : [],
              presetsEnumerable: data.presetsEnumerable === true,
            })
          } catch {
            if (stopped) return
            setCatalog({ models: [], enumerable: false, presets: [], presetsEnumerable: false })
          }
        }
        void load()
        return () => {
          stopped = true
        }
      }, [])

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
        setMenu(null)
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
      // The open detail pane follows the polled board, so a status change or a
      // late output shows up without reopening the task.
      const execTask = execTarget ? taskList.find((task) => task.id === execTarget.taskId) || null : null
      const execTitle = execTask?.title || execTarget?.title || ''

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

      const patchTask = (taskId, patch) =>
        run(async () => {
          await api(`/projects/${projectId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(patch) })
          await refresh(projectId)
          return ''
        })

      // `resolved` is the only task field the task PATCH accepts; status is
      // system-owned and approval has its own narrow route below.
      const toggleResolved = (task) => patchTask(task.id, { resolved: !task.resolved })

      // Fold one authoritative task returned by the Host back into the board so
      // the badge flips without waiting for the next poll.
      const applyTask = (next) =>
        setDetail((current) => {
          if (!current || !current.project) return current
          const tasks = (current.project.tasks || []).map((task) => (task.id === next.id ? next : task))
          return { ...current, project: { ...current.project, tasks } }
        })

      // Approval is its own Host route (`POST .../tasks/:taskId/approve`, no
      // body, idempotent): the task PATCH rejects every field but `resolved`.
      const approveTask = (task) =>
        run(async () => {
          const data = await api(`/projects/${projectId}/tasks/${task.id}/approve`, { method: 'POST' })
          if (data && data.task) applyTask(data.task)
          return ''
        })

      const deleteTask = (taskId) =>
        run(async () => {
          await api(`/projects/${projectId}/tasks/${taskId}`, { method: 'DELETE' })
          if (execTarget && execTarget.taskId === taskId) setExecTarget(null)
          await refresh(projectId)
          return t('deleted')
        })

      // -------------------------------------------------------------------
      // Layout interactions

      const toggleListCollapsed = () => setListCollapsed((value) => !value)

      // -------------------------------------------------------------------
      // Threads panel interactions

      const toggleGroup = (key) =>
        setCollapsedGroups((current) => ({ ...current, [key]: !current[key] }))

      const allGroupsCollapsed = THREAD_GROUPS.every((group) => collapsedGroups[group.key])

      // One button flips every group at once: collapse all when any is open,
      // expand all once everything is folded.
      const toggleAllGroups = () => {
        const next = {}
        for (const group of THREAD_GROUPS) next[group.key] = !allGroupsCollapsed
        setCollapsedGroups(next)
      }

      const activeLocale = () => {
        try {
          return typeof getLocale === 'function' ? String(getLocale() || 'zh') : 'zh'
        } catch {
          return 'zh'
        }
      }

      const selectProject = (entry) => {
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
      }

      // Native pointer events, no dependency: the drag listens on the window so
      // the pointer may leave the 5px handle. Text selection is suppressed for
      // the duration of the drag.
      const startResize = (which, event) => {
        if (!event || (typeof event.button === 'number' && event.button !== 0)) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof window === 'undefined') return
        const startX = Number(event.clientX) || 0
        const from = which === 'list' ? listWidth : execWidth
        const min = which === 'list' ? LIST_MIN : EXEC_MIN
        let latest = from
        const body = typeof document !== 'undefined' ? document.body : null
        const previousSelect = body ? body.style.userSelect : ''
        if (body) body.style.userSelect = 'none'
        setResizing(which)
        const onMove = (moveEvent) => {
          const delta = (Number(moveEvent.clientX) || 0) - startX
          // The executor column sits on the right, so dragging right narrows it.
          const raw = which === 'list' ? from + delta : from - delta
          latest = Math.round(clamp(raw, min, maxColumnWidth()))
          if (which === 'list') setListWidth(latest)
          else setExecWidth(latest)
        }
        const onEnd = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onEnd)
          window.removeEventListener('pointercancel', onEnd)
          if (body) body.style.userSelect = previousSelect
          setResizing(null)
          writeStored(which === 'list' ? 'listWidth' : 'execWidth', latest)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onEnd)
        window.addEventListener('pointercancel', onEnd)
      }

      // The separator is focusable: arrow keys move it 16px, Shift 48px.
      const nudgeWidth = (which, event) => {
        const step = event && event.shiftKey ? 48 : 16
        const delta = event && event.key === 'ArrowLeft' ? -step : event && event.key === 'ArrowRight' ? step : 0
        if (!delta) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (which === 'list') {
          const next = Math.round(clamp(listWidth + delta, LIST_MIN, maxColumnWidth()))
          setListWidth(next)
          writeStored('listWidth', next)
          return
        }
        const next = Math.round(clamp(execWidth - delta, EXEC_MIN, maxColumnWidth()))
        setExecWidth(next)
        writeStored('execWidth', next)
      }

      // A right-click on a task row opens its menu at the pointer; the position
      // is clamped to the viewport after the menu has been measured.
      const openTaskMenu = (event, task) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        setConfirmDeleteId(null)
        setMenu({
          taskId: task.id,
          x: Number(event && event.clientX) || 0,
          y: Number(event && event.clientY) || 0,
        })
      }

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

      // A task row opens its detail pane. The executor conversation is embedded
      // underneath when the task already has a child Session.
      const openTaskDetail = (task) =>
        run(async () => {
          if (!task.childSessionId) {
            setExecTarget({ taskId: task.id, title: task.title, sessionId: '', reference: null })
            return ''
          }
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
                  max: 10,
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
              h('h2', { className: 'pj-section-title' }, t('execution')),
            ),
            h('div', { className: 'pj-hint' }, t('executionHint')),
            h(
              'div',
              { className: 'pj-row' },
              h(
                'label',
                { className: 'pj-field pj-grow' },
                h('span', { className: 'pj-label' }, t('model')),
                catalog.enumerable
                  ? h(
                      'select',
                      {
                        className: 'pj-select',
                        'aria-label': t('model'),
                        value: project.model || '',
                        disabled: busy,
                        onChange: (event) => void patchProject({ model: event.target.value }),
                      },
                      h('option', { value: '' }, t('modelDefault')),
                      ...catalogOptions(catalog, 'models', project.model),
                    )
                  : h('input', {
                      className: 'pj-input',
                      type: 'text',
                      'aria-label': t('model'),
                      placeholder: t('modelRoutePlaceholder'),
                      defaultValue: project.model || '',
                      // Re-key on the stored value so a refresh (or a project
                      // switch) re-seeds the uncontrolled field without
                      // clobbering what the user is typing.
                      key: `${project.id}:${project.model || ''}`,
                      disabled: busy,
                      onBlur: (event) => {
                        const value = event.target.value.trim()
                        if (value !== (project.model || '')) void patchProject({ model: value })
                      },
                    }),
                !catalog.enumerable && h('span', { className: 'pj-hint' }, t('modelFreeTextHint')),
              ),
              h(
                'label',
                { className: 'pj-field pj-grow' },
                h('span', { className: 'pj-label' }, t('agentPreset')),
                catalog.presetsEnumerable
                  ? h(
                      'select',
                      {
                        className: 'pj-select',
                        'aria-label': t('agentPreset'),
                        value: project.agentPreset || '',
                        disabled: busy,
                        onChange: (event) => void patchProject({ agentPreset: event.target.value }),
                      },
                      h('option', { value: '' }, t('modelDefault')),
                      ...catalogOptions(catalog, 'presets', project.agentPreset),
                    )
                  : h('input', {
                      className: 'pj-input',
                      type: 'text',
                      'aria-label': t('agentPreset'),
                      placeholder: t('agentPreset'),
                      defaultValue: project.agentPreset || '',
                      key: `${project.id}:${project.agentPreset || ''}`,
                      disabled: busy,
                      onBlur: (event) => {
                        const value = event.target.value.trim()
                        if (value !== (project.agentPreset || '')) {
                          void patchProject({ agentPreset: value })
                        }
                      },
                    }),
                !catalog.presetsEnumerable &&
                  h('span', { className: 'pj-hint' }, t('presetFreeTextHint')),
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

      // The collapsed project column: a 44px rail that still shows every
      // project by its first letter, with the selected one highlighted.
      const renderListRail = () =>
        h(
          'div',
          { className: 'pj-rail' },
          h(
            'button',
            {
              className: 'pj-rail-btn',
              type: 'button',
              title: t('expandList'),
              'aria-label': t('expandList'),
              'aria-expanded': 'false',
              onClick: toggleListCollapsed,
            },
            '»',
          ),
          projects.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                className: `pj-rail-btn${entry.id === selectedId ? ' pj-active' : ''}`,
                title: entry.name,
                'aria-label': entry.name,
                'aria-current': entry.id === selectedId ? 'true' : undefined,
                onClick: () => selectProject(entry),
              },
              initialOf(entry.name),
            ),
          ),
        )

      // The row context menu. It is `position:fixed` (see `.pj-menu`) so the
      // list's `overflow:auto` cannot clip it; the open handler stores the
      // pointer position and the effect above clamps it into the viewport.
      const renderTaskMenu = () => {
        if (!menu) return null
        const task = taskList.find((entry) => entry.id === menu.taskId)
        if (!task) return null
        const confirming = confirmDeleteId === task.id
        return h(
          'div',
          {
            className: 'pj-menu',
            role: 'menu',
            'aria-label': t('taskActions'),
            ref: menuRef,
            style: { left: `${menu.x}px`, top: `${menu.y}px` },
            onContextMenu: (event) => {
              if (event && typeof event.preventDefault === 'function') event.preventDefault()
            },
          },
          h(
            'button',
            {
              className: 'pj-menu-item',
              type: 'button',
              role: 'menuitem',
              disabled: busy,
              onClick: () => {
                setMenu(null)
                void toggleResolved(task)
              },
            },
            task.resolved ? t('unresolve') : t('resolve'),
          ),
          h(
            'button',
            {
              className: 'pj-menu-item pj-danger',
              type: 'button',
              role: 'menuitem',
              disabled: busy,
              onClick: () => {
                // Two-stage delete, moved here from the detail page: the second
                // click only counts once the arm has settled, so a double-click
                // cannot confirm itself.
                if (confirming && Date.now() - confirmDeleteAt.current > 600) {
                  setConfirmDeleteId(null)
                  setMenu(null)
                  void deleteTask(task.id)
                  return
                }
                setConfirmDeleteId(task.id)
                confirmDeleteAt.current = Date.now()
                setTimeout(() => {
                  setConfirmDeleteId((current) => (current === task.id ? null : current))
                }, 3000)
              },
            },
            confirming ? t('deleteConfirm') : t('delete'),
          ),
        )
      }

      // One thread card per task: group glyph, title line with a relative time,
      // a one-line summary and up to two chips. No controls at all — the brief,
      // the output and every action live on the detail page, and the card's
      // context menu is the only place a task can be resolved or deleted.
      const renderTask = (task) => {
        const subtitle = taskSubtitle(task, t)
        const chips = taskChips(task)
        return h(
          'button',
          {
            key: task.id,
            type: 'button',
            className: `pj-task-row${execTarget && execTarget.taskId === task.id ? ' pj-active' : ''}`,
            onClick: () => void openTaskDetail(task),
            onContextMenu: (event) => openTaskMenu(event, task),
            disabled: busy,
            title: subtitle ? `${task.title}\n${subtitle}` : task.title,
          },
          h(ThreadIcon, { kind: threadIconOf(task) }),
          h('span', { className: 'pj-task-name' }, task.title),
          h('span', { className: 'pj-thread-time' }, relativeTime(task, t, activeLocale())),
          h('span', { className: 'pj-thread-sub' }, subtitle),
          chips.length
            ? h(
                'span',
                { className: 'pj-thread-chips' },
                chips.map((chip) =>
                  h('span', { key: chip, className: 'pj-chip' }, chip),
                ),
              )
            : null,
        )
      }

      // A group header is a button: it folds and unfolds its cards, and the
      // folded set is persisted. `Resolved` starts folded.
      const renderThreadGroup = (group) => {
        const folded = Boolean(collapsedGroups[group.key])
        return h(
          'div',
          { key: group.key, className: 'pj-group' },
          h(
            'button',
            {
              className: 'pj-group-title',
              type: 'button',
              'aria-expanded': folded ? 'false' : 'true',
              onClick: () => toggleGroup(group.key),
            },
            h('span', { className: 'pj-group-chevron', 'aria-hidden': true }, folded ? '›' : '⌄'),
            h(ThreadIcon, { kind: group.icon }),
            h('span', { className: 'pj-group-label' }, `${t(group.titleKey)} · ${group.tasks.length}`),
          ),
          folded ? null : group.tasks.map(renderTask),
        )
      }

      // The detail page: read-only task state plus the human-only controls, with
      // the executor conversation below. Resolve is the icon button in the
      // top-right corner; approval stays here; deletion lives in the row menu.
      const renderTaskDetail = (task) => {
        const effective = effectiveModel(project, task)
        const sourceKey =
          effective.source === 'task'
            ? 'fromTask'
            : effective.source === 'project'
              ? 'fromProject'
              : 'fromHost'
        return h(
          'div',
          { className: 'pj-exec-detail' },
          h(
            'div',
            { className: 'pj-exec-info' },
            h(
              'div',
              { className: 'pj-task-head' },
              h('span', { className: 'pj-label' }, t('status')),
              h(StatusPill, { status: task.status, t }),
              task.approved && h('span', { className: 'pj-badge' }, t('approvedBadge')),
              task.resolved && h('span', { className: 'pj-badge' }, t('resolvedBadge')),
              h('span', { className: 'pj-spacer' }),
              h(
                'button',
                {
                  className: `pj-icon-btn${task.resolved ? ' pj-on' : ''}`,
                  type: 'button',
                  disabled: busy,
                  title: task.resolved ? t('unresolve') : t('resolve'),
                  'aria-label': task.resolved ? t('unresolve') : t('resolve'),
                  'aria-pressed': task.resolved ? 'true' : 'false',
                  onClick: () => void toggleResolved(task),
                },
                h(ResolveIcon, { done: Boolean(task.resolved) }),
              ),
            ),
            task.childName && h('div', { className: 'pj-task-meta' }, `${t('worker')}: ${task.childName}`),
            h('div', { className: 'pj-task-meta' }, t('effectiveModel')),
            h(
              'div',
              { className: 'pj-model-line' },
              effective.value
                ? `${modelLabel(catalog, effective.value)} · ${t(sourceKey)}`
                : t('fromHost'),
            ),
            h('div', { className: 'pj-task-meta' }, t('taskModel')),
            h(
              'div',
              { className: 'pj-field' },
              h(
                'select',
                {
                  className: 'pj-select',
                  'aria-label': t('taskModel'),
                  value: task.model || '',
                  // The page's task PATCH only accepts `resolved`, so a
                  // task-level route is the coordinator's to set. The control
                  // stays visible and read-only rather than pretending to save.
                  disabled: true,
                  title: t('taskModelReadonly'),
                },
                h('option', { value: '' }, t('modelInheritProject')),
                ...catalogOptions(catalog, 'models', task.model),
              ),
              h('span', { className: 'pj-hint' }, t('taskModelReadonly')),
            ),
            h('div', { className: 'pj-task-meta' }, t('brief')),
            h('div', { className: 'pj-task-body' }, task.brief || t('noBrief')),
            h('div', { className: 'pj-task-meta' }, t('output')),
            h('div', { className: 'pj-task-output' }, task.output || t('noOutput')),
            task.stopReason && h('div', { className: 'pj-task-meta' }, `${t('stopReason')}: ${task.stopReason}`),
            project.autonomy === 'manual' &&
              !task.approved &&
              task.status !== 'running' &&
              h(
                'div',
                { className: 'pj-task-foot' },
                h(
                  'button',
                  {
                    className: 'pj-btn',
                    type: 'button',
                    disabled: busy || project.archived,
                    onClick: () => void approveTask(task),
                  },
                  t('approve'),
                ),
              ),
          ),
          execTarget && execTarget.reference
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
            : h('div', { className: 'pj-empty' }, t('noConversation')),
        )
      }

      // Five fixed groups, in reference order. A resolved task always lands in
      // `Resolved`, whatever its system state is. The search box filters on the
      // title and the one-line summary before the bucketing happens.
      const needle = query.trim().toLowerCase()
      const visibleTasks = needle
        ? taskList.filter((task) =>
            `${task.title || ''} ${taskSubtitle(task, t)}`.toLowerCase().includes(needle),
          )
        : taskList
      const groups = threadGroups(visibleTasks)

      return h(
        'div',
        { className: `pj-page${resizing ? ' pj-resizing' : ''}` },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'aside',
          {
            className: `pj-list${listCollapsed ? ' pj-collapsed' : ''}`,
            style: listCollapsed ? undefined : { flexBasis: `${listWidth}px`, width: `${listWidth}px` },
          },
          listCollapsed
            ? renderListRail()
            : [
                h(
                  'div',
                  { className: 'pj-list-head' },
                  h('span', { className: 'pj-list-title' }, t('projects')),
                  h(
                    'div',
                    { className: 'pj-actions' },
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
                    h(
                      'button',
                      {
                        className: 'pj-icon-btn',
                        type: 'button',
                        title: t('collapseList'),
                        'aria-label': t('collapseList'),
                        'aria-expanded': 'true',
                        onClick: toggleListCollapsed,
                      },
                      '«',
                    ),
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
                            onClick: () => selectProject(entry),
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
              ],
        ),
        listCollapsed
          ? null
          : h('div', {
              className: 'pj-resizer',
              role: 'separator',
              'aria-orientation': 'vertical',
              'aria-label': t('resizeColumns'),
              'aria-valuenow': listWidth,
              'aria-valuemin': LIST_MIN,
              'aria-valuemax': maxColumnWidth(),
              tabIndex: 0,
              title: t('resizeColumns'),
              onPointerDown: (event) => startResize('list', event),
              onKeyDown: (event) => nudgeWidth('list', event),
            }),
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
        h('div', {
          className: 'pj-resizer',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': t('resizeColumns'),
          'aria-valuenow': execWidth,
          'aria-valuemin': EXEC_MIN,
          'aria-valuemax': maxColumnWidth(),
          tabIndex: 0,
          title: t('resizeColumns'),
          onPointerDown: (event) => startResize('exec', event),
          onKeyDown: (event) => nudgeWidth('exec', event),
        }),
        h(
          'aside',
          {
            className: 'pj-exec',
            style: { flexBasis: `${execWidth}px`, width: `${execWidth}px` },
          },
          h(
            'header',
            { className: 'pj-exec-head' },
            execTarget
              ? h(
                  'button',
                  { className: 'pj-btn pj-btn-ghost', type: 'button', onClick: () => setExecTarget(null) },
                  `← ${t('threads')}`,
                )
              : h('h2', { className: 'pj-exec-title' }, t('threads')),
            execTarget
              ? h(
                  'div',
                  { className: 'pj-actions' },
                  h('span', { className: 'pj-exec-task', title: execTitle }, shortTitle(execTitle)),
                  execTarget.sessionId &&
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
          // Search and the fold-all toggle belong to the list view only.
          !execTarget && project
            ? h(
                'div',
                { className: 'pj-exec-tools' },
                h('input', {
                  className: 'pj-search',
                  type: 'search',
                  value: query,
                  placeholder: t('searchThreads'),
                  'aria-label': t('searchThreads'),
                  onChange: (event) => setQuery(event.target.value),
                }),
                h(
                  'button',
                  { className: 'pj-btn pj-btn-ghost', type: 'button', onClick: toggleAllGroups },
                  allGroupsCollapsed ? t('expandAll') : t('collapseAll'),
                ),
              )
            : null,
          !project
            ? null
            : execTarget
              ? execTask
                ? renderTaskDetail(execTask)
                : h('div', { className: 'pj-empty' }, t('noTask'))
              : h(
                  'div',
                  { className: 'pj-exec-scroll' },
                  taskList.length === 0
                    ? h('div', { className: 'pj-empty' }, t('emptyTasks'))
                    : visibleTasks.length === 0
                      ? h('div', { className: 'pj-empty' }, t('noMatches'))
                      : groups
                          .filter((group) => group.tasks.length > 0)
                          .map(renderThreadGroup),
                ),
        ),
        renderTaskMenu(),
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
