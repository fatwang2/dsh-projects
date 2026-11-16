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
 * through the `projects_add_task` tool.
 *
 * `task.status` is the one task-status enum (`queued | running | review |
 * failed | blocked | resolved`) and the page writes exactly one field of it:
 * `status`, and only two of its values — `resolved` accepts the work, `review`
 * takes that acceptance back. There is no second `resolved` boolean; a task is
 * in exactly one bucket, so the sidebar tally and the Resolved group agree.
 */

window.__ModuleLoader__.load({
  id: '@fatwang2/dsh-projects',
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
      settings: 'Settings',
      settingsNav: 'Settings sections',
      general: 'General',
      close: 'Close',
      startCoordinator: 'Start coordinator',
      startCoordinatorHint: 'The coordinator plans the goal and dispatches tasks. Its conversation lives in this column.',
      noConversation: 'This task has no executor session yet.',
      workerChatFailed: 'The executor conversation could not start. Open it in the workspace instead.',
      projects: 'Projects',
      project: 'Project',
      newProject: 'New project',
      projectName: 'Project name',
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
      instructions: 'Project instructions',
      instructionsHint: 'Sent to every worker, together with the shared memory and the task brief.',
      instructionsPlaceholder: 'Goal, constraints, conventions…',
      memory: 'Shared memory',
      memoryHint: 'Every worker reads this before starting and can append findings to it.',
      memoryPlaceholder: 'Findings, decisions, codebase knowledge…',
      memoryEmpty: 'The shared memory is empty.',
      memoryFiles: 'files',
      memoryChars: 'chars',
      memoryStale: 'superseded',
      memoryArchived: 'Archived',
      memoryArchivedHint:
        'Compaction moved this file out of the live memory. It stays in memory/archive/ and is read-only here.',
      memoryLoading: 'Loading…',
      memoryLoadFailed: 'The memory file could not be read:',
      memoryBody: 'Memory file text',
      memoryEditFile: 'Edit file',
      memoryDeleteFile: 'Delete file',
      memoryDeleted: 'Memory file deleted.',
      memoryIndex: 'Index',
      memoryReadOnly: 'Read-only',
      memoryIndexDesc: 'Generated index of the shared memory',
      memoryIndexHint:
        'MEMORY.md is rebuilt from the topic files on every write, so it is read-only here. Edit or delete a topic file instead.',
      save: 'Save',
      concurrency: 'Concurrency',
      concurrencyHint: 'How many threads run at once.',
      workspace: 'Workspace',
      emptyTasks: 'No tasks yet. Ask the coordinator in the conversation to split the goal.',
      approve: 'Approve',
      approvedBadge: 'Approved',
      noTask: 'This task is no longer on the board.',
      resolve: 'Resolve',
      unresolve: 'Unresolve',
      resolvedBadge: 'Resolved',
      deleteConfirm: 'Confirm delete',
      deleteOnlyTask: 'Delete task only',
      deleteOnlyTaskHint: 'The executor session is kept.',
      deleteAndArchive: 'Delete and archive session',
      archiveSessionHint:
        'Archives the executor session: it leaves the sidebar and will not run again. No disk space is freed.',
      archiveSessionTitle:
        'Archives the executor session — it is not deleted. No disk space is freed; it only leaves the sidebar.',
      deleteArchived: 'Task deleted, session archived.',
      archiveRunning: 'The executor is still running. Wait for it to finish first.',
      archiveParamRejected: 'The archive request was rejected, so the task was not deleted:',
      switchDiscard: 'Discard unsaved changes and switch projects?',
      archivedHint: 'This project is archived. Unarchive it to dispatch tasks.',
      worker: 'worker',
      archive: 'Archive',
      unarchive: 'Unarchive',
      archivedBadge: 'Archived',
      archiveSection: 'Archive project',
      archiveWarning:
        'Archiving hides this project from the list. Its tasks, shared memory and sessions are kept, and you can unarchive it here at any time. Worktrees created for its tasks are removed.',
      archiveConfirm: 'Confirm archive',
      queued: 'Queued',
      running: 'Running',
      review: 'Ready for review',
      failed: 'Failed',
      blocked: 'Blocked',
      resolved: 'Resolved',
      status: 'Status',
      delete: 'Delete',
      error: 'Something went wrong',
      counts: 'tasks',
      coordinatorCreated: 'Coordinator session started.',
      coordinatorResumed: 'Coordinator session opened.',
      coordinatorRulesUpdated: 'Coordinator rules updated and pushed into this session.',
      coordinatorChatFailed: 'The embedded conversation could not start. Open it in the workspace instead.',
      coordinatorArchived: 'This conversation is archived, so new messages do not run. Restore it to continue.',
      restore: 'Restore',
      coordinatorRestored: 'Conversation restored.',
      collapseList: 'Collapse project list',
      expandList: 'Expand project list',
      collapseThreads: 'Collapse threads',
      expandThreads: 'Expand threads',
      resizeColumns: 'Resize columns',
      taskActions: 'Task actions',
      threads: 'Threads',
      threadsHint:
        'Default model and reasoning effort for the threads this project dispatches. A task may override them; the coordinator itself follows the host default.',
      worktreeIsolation: 'Isolated worktree per task',
      worktreeIsolationHint:
        'Each task runs in its own git worktree on branch task/<id>. The workspace must be a git repository, and .worktrees/ must already be in its .gitignore.',
      worktreeWorkspaceMissing:
        'Worktree isolation is on, but the workspace folder is missing, so this task ran in the project folder instead.',
      worktreeNotGit:
        'Worktree isolation is on, but the workspace is not a git repository, so this task ran in the project folder instead.',
      copyBranch: 'Copy branch name',
      branchCopied: 'Branch name copied.',
      copyFailed: 'The clipboard is unavailable, so the branch name was not copied.',
      searchThreads: 'Search threads',
      filterThreads: 'Filter threads',
      filterGroups: 'Groups shown',
      showAllGroups: 'Show all groups',
      collapseAll: 'Collapse all',
      expandAll: 'Expand all',
      noMatches: 'No threads match.',
      groupRunning: 'Running',
      groupReview: 'Ready for review',
      groupWaiting: 'Waiting on you',
      groupIdle: 'Idle',
      groupResolved: 'Resolved',
      justNow: 'just now',
      dispatchCard: 'Dispatched task',
      dispatchPreparing: 'Dispatching…',
      dispatchOpenHint: 'Open this task',
      model: 'Model',
      reasoningEffort: 'Reasoning effort',
      effortShort: 'Effort',
      modelDefault: 'Default (inherits host)',
      effortDefault: 'Default (follows host)',
      modelRoutePlaceholder: 'provider/model',
      modelFreeTextHint:
        'The model list could not be enumerated — type a route such as provider/model.',
      effortFreeTextHint:
        'The effort list could not be enumerated — type an effort id such as low or high.',
      effortOff: 'Off',
      effortLow: 'Low',
      effortHigh: 'High',
      effortMax: 'Max',
      effectiveModel: 'Effective model',
      fromTask: 'from task',
      fromProject: 'from project',
      fromHost: 'host default',
      sessionUnavailable: 'The session service is unavailable on this page.',
      pickerUnavailable: 'The directory picker is unavailable on this page.',
      promptRejected: 'The coordinator prompt was rejected.',
    }

    const ZH = {
      nav: '项目',
      title: '项目',
      settings: '设置',
      settingsNav: '设置分组',
      general: '通用',
      close: '关闭',
      startCoordinator: '启动协调者',
      startCoordinatorHint: '协调者负责拆解目标、派发任务；它的对话就在这一栏。',
      noConversation: '这个任务还没有执行者会话。',
      workerChatFailed: '执行者对话启动失败，请在会话中打开。',
      projects: '项目',
      project: '项目',
      newProject: '新建项目',
      projectName: '项目名称',
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
      instructions: '项目指令',
      instructionsHint: '每个执行者都会收到它，连同共享记忆和任务说明。',
      instructionsPlaceholder: '目标、约束、约定……',
      memory: '共享记忆',
      memoryHint: '每个执行者开始前都会读它，也可以把结论追加进来。',
      memoryPlaceholder: '结论、决策、对代码库的了解……',
      memoryEmpty: '共享记忆还是空的。',
      memoryFiles: '个文件',
      memoryChars: '字符',
      memoryStale: '已过时',
      memoryArchived: '已归档',
      memoryArchivedHint: '自动压缩已把这个文件移出活动记忆：它保留在 memory/archive/ 里，在这里只能查看。',
      memoryLoading: '读取中…',
      memoryLoadFailed: '读取记忆文件失败：',
      memoryBody: '记忆正文',
      memoryEditFile: '编辑文件',
      memoryDeleteFile: '删除文件',
      memoryDeleted: '记忆文件已删除。',
      memoryIndex: '索引',
      memoryReadOnly: '只读',
      memoryIndexDesc: '共享记忆的索引，由主题文件自动生成',
      memoryIndexHint: 'MEMORY.md 每次写入都会按主题文件重建，因此在这里只能查看；要改内容请编辑或删除主题文件。',
      save: '保存',
      concurrency: '并发',
      concurrencyHint: '同时运行的线程数。',
      workspace: '工作区',
      emptyTasks: '还没有任务。在对话里让协调者拆解目标，任务由它派生。',
      approve: '批准',
      approvedBadge: '已批准',
      noTask: '这个任务已不在看板上了。',
      resolve: '解决',
      unresolve: '取消解决',
      resolvedBadge: '已解决',
      deleteConfirm: '确认删除',
      deleteOnlyTask: '只删任务',
      deleteOnlyTaskHint: '执行者会话保留。',
      deleteAndArchive: '删除并归档会话',
      archiveSessionHint: '会归档执行者会话：不再出现在侧栏、不再运行；不释放磁盘空间。',
      archiveSessionTitle: '归档执行者会话，不会删除它；不释放磁盘空间，只是不再出现在侧栏。',
      deleteArchived: '任务已删除，会话已归档。',
      archiveRunning: '执行者仍在运行，请先等它结束。',
      archiveParamRejected: '归档参数被拒绝，任务未删除：',
      switchDiscard: '放弃未保存的修改并切换项目？',
      archivedHint: '项目已归档，取消归档后才能派发任务。',
      worker: '执行者',
      archive: '归档',
      unarchive: '取消归档',
      archivedBadge: '已归档',
      archiveSection: '归档项目',
      archiveWarning:
        '归档后项目会从列表中隐藏。任务、共享记忆与会话都会保留，随时可以在这里取消归档；为任务创建的 worktree 会被删除。',
      archiveConfirm: '确认归档',
      queued: '排队中',
      running: '执行中',
      review: '待验收',
      failed: '失败',
      blocked: '受阻',
      resolved: '已解决',
      status: '状态',
      delete: '删除',
      error: '出错了',
      counts: '个任务',
      coordinatorCreated: '协调者会话已启动。',
      coordinatorResumed: '已打开协调者会话。',
      coordinatorRulesUpdated: '协调者规则已更新，已推送到这个会话。',
      coordinatorChatFailed: '内嵌对话启动失败，请在会话中打开。',
      coordinatorArchived: '这个会话已归档，新消息不会运行。恢复后才能继续。',
      restore: '恢复',
      coordinatorRestored: '会话已恢复。',
      collapseList: '收起项目栏',
      expandList: '展开项目栏',
      collapseThreads: '收起线程栏',
      expandThreads: '展开线程栏',
      resizeColumns: '调整栏宽',
      taskActions: '任务操作',
      threads: '线程',
      threadsHint:
        '本项目派发的线程（Threads）的默认模型与思考程度；单个任务可以覆盖。协调者本身沿用宿主默认。',
      worktreeIsolation: '每任务独立 worktree',
      worktreeIsolationHint:
        '每个任务在自己的 git worktree 里运行，分支为 task/<id>。工作区必须是 git 仓库，且 .worktrees/ 要已在 .gitignore 里。',
      worktreeWorkspaceMissing: '已开启 worktree 隔离，但工作区目录不存在，这个任务改为在项目目录里运行。',
      worktreeNotGit: '已开启 worktree 隔离，但工作区不是 git 仓库，这个任务改为在项目目录里运行。',
      copyBranch: '复制分支名',
      branchCopied: '分支名已复制。',
      copyFailed: '剪贴板不可用，分支名没有复制。',
      searchThreads: '搜索线程',
      filterThreads: '筛选线程',
      filterGroups: '显示的分组',
      showAllGroups: '显示全部分组',
      collapseAll: '全部折叠',
      expandAll: '全部展开',
      noMatches: '没有匹配的线程。',
      groupRunning: '执行中',
      groupReview: '待验收',
      groupWaiting: '等你处理',
      groupIdle: '空闲',
      groupResolved: '已解决',
      justNow: '刚刚',
      dispatchCard: '派发的任务',
      dispatchPreparing: '派发中…',
      dispatchOpenHint: '打开这个任务',
      model: '模型',
      reasoningEffort: '思考程度',
      effortShort: '思考',
      modelDefault: '默认（继承宿主）',
      effortDefault: '默认（跟随宿主）',
      modelRoutePlaceholder: 'provider/model',
      modelFreeTextHint: '无法枚举模型列表，请手填路由，例如 provider/model。',
      effortFreeTextHint: '无法枚举思考程度列表，请手填档位 id，例如 low 或 high。',
      effortOff: '关闭',
      effortLow: '低',
      effortHigh: '高',
      effortMax: '最高',
      effectiveModel: '生效模型',
      fromTask: '来自任务',
      fromProject: '来自项目',
      fromHost: '宿主默认',
      sessionUnavailable: '这个页面无法使用会话服务。',
      pickerUnavailable: '这个页面无法使用目录选择器。',
      promptRejected: '协调者指令被拒绝了。',
    }

    // ---------------------------------------------------------------------
    // Styles (theme tokens only; the element unmounts with the page)

    // Rules the dispatch card shares with the board: the group glyph, the
    // status pill and the chip. The card can render outside the board — the
    // coordinator Session opened as a normal conversation, where the page's
    // <style> is not mounted — so it carries its own copy of exactly these
    // rules. The page sheet interpolates the same constants, so there is one
    // source of truth for both surfaces.
    const SHARED_CSS = `
.pj-thread-icon{grid-area:icon;align-self:start;margin-top:3px;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:0 0 auto}
.pj-thread-review{color:var(--dsw-alias-state-success-primary)}
.pj-thread-waiting{color:var(--dsw-alias-state-warn-primary)}
.pj-thread-idle{color:var(--dsw-alias-label-tertiary)}
.pj-thread-resolved{color:var(--dsw-alias-label-secondary)}
.pj-thread-spinner{animation:pj-spin .9s linear infinite;transform-origin:center}
@keyframes pj-spin{to{transform:rotate(360deg)}}
.pj-chip{display:inline-flex;align-items:center;max-width:100%;height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* A branch is a ref, not prose: the one chip that reads in the monospace face
   and in the brighter ink, so a worktree'd task is recognisable at a glance. */
.pj-chip-branch{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pj-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
.pj-pill-queued{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pj-pill-running{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);color:var(--dsw-alias-state-business-primary)}
.pj-pill-review{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent);color:var(--dsw-alias-state-warn-primary)}
.pj-pill-failed{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);color:var(--dsw-alias-state-error-primary)}
.pj-pill-blocked{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);color:var(--dsw-alias-state-warn-primary);border:1px dashed color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}
/* resolved is a status like the others, so it gets its own pill rule rather
   than borrowing review: accepted work reads as done (success), not as
   something still waiting on the human. */
.pj-pill-resolved{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary)}
`

    /** The dispatch card's own rules; the board sheet interpolates them too. */
    const DISPATCH_RULES = `
.pj-dispatch{display:flex;align-items:center;gap:8px;width:100%;margin:2px 0;padding:6px 10px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:inherit;text-align:left;font:inherit;cursor:pointer}
.pj-dispatch:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pj-dispatch:disabled{cursor:default;opacity:.7}
.pj-dispatch .pj-thread-icon{margin-top:0}
.pj-dispatch-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary)}
.pj-dispatch-time{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
`

    /** Everything a dispatch card needs to render on its own. */
    const DISPATCH_CSS = `${SHARED_CSS}${DISPATCH_RULES}`

    const CSS = `
.pj-page{display:flex;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.pj-page :focus-visible{outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}
/* Three columns, one priority order. Each column owns a floor; the conversation's
   floor is the widest, and the side columns are the only ones that shrink, so a
   narrow window squeezes them first and can never take the conversation to zero.
   The floors are repeated in the layout math above (LIST_MIN / EXEC_MIN /
   MAIN_MIN), which is what keeps the drag and the fold in step with the CSS. */
.pj-list{display:flex;flex-direction:column;flex:0 1 264px;width:264px;min-width:180px;min-height:0;border-right:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.pj-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px 14px 10px}
.pj-list-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.pj-list-scroll{flex:1;min-height:0;overflow:auto;padding:0 8px 16px}
.pj-list-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:9px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.pj-list-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pj-list-item.pj-active{background:var(--dsw-alias-interactive-bg-active)}
.pj-list-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-list-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.pj-list.pj-collapsed{flex:0 0 44px;width:44px;min-width:44px;overflow:hidden}
.pj-exec.pj-collapsed{flex:0 0 44px;width:44px;min-width:44px;overflow:hidden}
.pj-rail{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0;min-height:0;overflow:auto}
.pj-rail-count{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.pj-rail-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.pj-rail-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pj-rail-btn.pj-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.pj-resizer{position:relative;flex:0 0 5px;width:5px;padding:0;border:0;background:transparent;cursor:col-resize;touch-action:none}
.pj-resizer::after{content:'';position:absolute;inset:0 -3px}
.pj-resizer:hover,.pj-resizer:focus-visible{background:var(--dsw-alias-border-l2)}
.pj-page.pj-resizing{cursor:col-resize;user-select:none}
.pj-main{display:flex;flex-direction:column;flex:1 1 0;min-width:420px;min-height:0;border-right:1px solid var(--dsw-alias-border-l2)}
.pj-main-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);box-sizing:border-box}
[data-platform='darwin'] .pj-list-head{padding-top:calc(16px + var(--dsh-frame-top-clearance, 0px))}
[data-platform='darwin'] .pj-rail{padding-top:calc(10px + var(--dsh-frame-top-clearance, 0px))}
[data-platform='darwin'] .pj-main-head{padding-top:calc(14px + var(--dsh-frame-top-clearance, 0px))}
[data-platform='darwin'] .pj-exec-head{padding-top:calc(12px + var(--dsh-frame-top-clearance, 0px))}
/* The conversation head and the Threads head share one height, the macOS top
   clearance included. The Threads head is the denser of the two (12px padding,
   a 14px title), so a bare 56px floor let its divider sit ~8px above the
   conversation's once the clearance was added to both. One floor, both equal. */
.pj-main-head,.pj-exec-head{min-height:calc(56px + var(--dsh-frame-top-clearance, 0px))}
.pj-main-title{display:flex;align-items:center;gap:8px;min-width:0}
.pj-title{margin:0;font-size:18px;line-height:26px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-main-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
/* The settings dialog body owns the only scroll source, so the form is a plain
   column: no column-width cap and no centred gutter of its own. */
.pj-settings{display:flex;flex-direction:column;min-width:0}
.pj-chat-body{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.pj-exec{display:flex;flex-direction:column;flex:0 1 380px;width:380px;min-width:280px;min-height:0;background:var(--dsw-alias-bg-layer-1)}
.pj-exec-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);box-sizing:border-box}
.pj-exec-title{margin:0;font-size:14px;font-weight:600}
.pj-exec-task{min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-secondary)}
.pj-exec-scroll{flex:1;min-height:0;overflow:auto;padding:12px 14px 32px}
/* The detail column is a plain vertical flex box with exactly one child: the
   embedded conversation. It clips instead of scrolling, so the Host Chat view
   owns the only scrollbar on the page. No percentage caps and no absolutely
   positioned layers, so nothing can paint over anything else. */
.pj-exec-detail{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.pj-exec-detail > .pj-chat-body{flex:1 1 0;min-height:140px}
/* The detail header is up to three dense rows: back + title + state controls,
   then one secondary line (model · executor) with the remaining actions, then —
   only when the task has a worktree or a reason it has none — where its code
   lives. Everything the old field form stacked as labelled blocks now lives in
   the conversation. */
.pj-detail-head{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.pj-detail-row{display:flex;align-items:center;gap:6px;min-width:0}
.pj-detail-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.pj-detail-meta-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The detail head's third row: where the task's code lives. The branch is the
   one value a human pastes into a shell, so it sits in a monospace chip with its
   own copy control; a task the Host could not isolate shows the reason here in
   the warn ink instead of leaving the reader to guess. */
.pj-detail-worktree{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.pj-worktree-branch{display:inline-flex;flex:0 1 auto;align-items:center;gap:4px;max-width:100%;min-width:0;height:20px;padding:0 2px 0 6px;box-sizing:border-box;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pj-worktree-branch svg{flex:none;width:12px;height:12px}
.pj-worktree-branch-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px}
.pj-worktree-note{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-warn-primary)}
/* The search row sits under the Threads head, so it needs its own gap: the head
   owns a 1px divider and nothing else, and a field flush against it reads as
   part of the border. */
.pj-exec-tools{display:flex;align-items:center;gap:8px;padding:12px 14px 10px}
/* Search field, copied from the Host's SearchInput primitive: a bordered
   wrapper that owns the focus ring, a 16px leading glyph, and a borderless
   input inside it. */
.pj-search{display:inline-flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;height:32px;padding:0 8px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.pj-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.pj-search-icon{display:inline-flex;flex:0 0 auto;width:16px;height:16px;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.pj-search input{flex:1;min-width:0;border:0;outline:none;background:transparent;padding:0;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.pj-search input::placeholder{color:var(--dsw-alias-label-dimmed)}
.pj-search input:focus-visible{outline:none}
.pj-group{margin-bottom:14px}
.pj-group-title{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;margin-bottom:2px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:15px;font-weight:500;text-align:left;cursor:pointer}
.pj-group-title:hover{color:var(--dsw-alias-label-primary)}
.pj-group-chevron{display:inline-block;width:10px;flex:0 0 auto;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary)}
.pj-group-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-start{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:24px;text-align:center}
.pj-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
/* Buttons follow the Host Button primitive's sm scale and its three
   variants: primary (fill), outline (hairline inset ring, the default here so
   a bare .pj-btn keeps reading as a secondary action) and ghost. */
.pj-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}
.pj-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.pj-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.pj-btn:disabled{cursor:not-allowed;opacity:.4}
.pj-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);box-shadow:none}
.pj-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.pj-btn-ghost{background:transparent;box-shadow:none;color:var(--dsw-alias-label-secondary)}
.pj-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* The page's one destructive action: a hairline in the danger ink, and a filled
   variant for the second, confirming press. Both stay on theme tokens. */
.pj-btn-danger{box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.pj-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.pj-btn-danger-fill{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);box-shadow:none}
.pj-btn-danger-fill:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);opacity:.88}
.pj-icon-btn{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:1;cursor:pointer}
.pj-icon-btn svg{width:15px;height:15px}
/* The header glyphs are the Host's own 16px outline set, so they keep their
   native seat instead of the 15px default of this button. */
.pj-icon-btn .pj-icon-16{width:16px;height:16px}
.pj-icon-btn .pj-icon-18{width:18px;height:18px}
/* The copy control inside the branch chip: the 28px seat is taller than the
   20px row it sits in, so it keeps the glyph and drops the padding. */
.pj-icon-btn.pj-icon-btn-xs{width:20px;height:20px;padding:2px}
.pj-icon-btn-xs svg{width:12px;height:12px}
.pj-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pj-icon-btn:disabled{opacity:.4;cursor:default}
.pj-icon-btn.pj-on{color:var(--dsw-alias-state-success-primary)}
/* A header glyph that is holding something open (the unfolded search, the
   filter with a hidden group) reads as pressed, not as a success state. */
.pj-icon-btn.pj-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.pj-spacer{flex:1 1 auto;min-width:0}
/* The context menu copies the Host Menu primitive: 4px padding on an elevated
   card, 34px rows with a 14px icon seat, a hairline separator, and a danger row
   that swaps the hover fill. */
.pj-menu{position:fixed;z-index:60;display:flex;flex-direction:column;min-width:168px;max-width:280px;padding:4px;box-sizing:border-box;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)}
.pj-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.pj-menu-item:hover:not(:disabled),.pj-menu-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}
.pj-menu-item:disabled{opacity:.4;cursor:not-allowed}
.pj-menu-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px;color:var(--dsw-alias-menu-icon)}
.pj-menu-icon svg{width:14px;height:14px}
.pj-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The delete confirmation's caption and its two-line rows: the action on the
   first line, the plain-language consequence under it. */
.pj-menu-caption{padding:4px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pj-menu-text{display:flex;flex-direction:column;flex:1;min-width:0;gap:2px}
.pj-menu-text .pj-menu-label{flex:none;white-space:nowrap}
.pj-menu-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:normal}
.pj-menu-separator{height:.5px;margin:3px 8px;background:var(--dsw-alias-border-l2)}
.pj-menu-item.pj-danger{color:var(--dsw-alias-state-error-primary)}
.pj-menu-item.pj-danger .pj-menu-icon{color:var(--dsw-alias-state-error-primary)}
.pj-menu-item.pj-danger:hover:not(:disabled),.pj-menu-item.pj-danger:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
/* The Threads filter popover: the same elevated card as the context menu, but
   anchored under its own trigger instead of at the pointer, so it needs a
   positioned wrapper. Rows carry a drawn check seat, because a native checkbox
   would not match the Host's menu rows. */
.pj-filter{position:relative;display:inline-flex;flex:none}
.pj-filter-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:70;display:flex;flex-direction:column;min-width:196px;padding:4px;box-sizing:border-box;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)}
.pj-filter-check{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px;color:var(--dsw-alias-state-business-primary)}
.pj-filter-check svg{width:14px;height:14px}
.pj-filter-menu .pj-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pj-section{padding:12px 0}
.pj-section:first-child{padding-top:0}
.pj-section+.pj-section{border-top:.5px solid var(--dsw-alias-border-l2)}
.pj-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.pj-section-title{font-size:14px;font-weight:600;margin:0}
.pj-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.pj-section > .pj-hint{margin-bottom:8px}
/* The danger rule closes the general group: a danger-tinted rule above it and
   the error ink on its title, so the one irreversible action never reads as
   another settings row. */
/* Two classes, because the sibling-section rule also draws a top border and
   would otherwise win on specificity. */
.pj-section.pj-danger-zone{margin-top:8px;padding-top:16px;border-top:.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-bg-layer-2))}
.pj-section.pj-danger-zone .pj-section-title{color:var(--dsw-alias-state-error-primary)}
.pj-danger-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.pj-textarea,.pj-input,.pj-select{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
.pj-textarea{min-height:96px;padding:8px 12px;resize:vertical}
.pj-textarea:focus-visible,.pj-input:focus-visible,.pj-select:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.pj-input{height:34px;padding:0 12px}
.pj-input:disabled,.pj-select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
/* A native select cannot carry a chevron, so it sits in a wrapper that draws
   the Host's 12px caret in the menu-icon tone. */
.pj-select-wrap{position:relative;display:flex;align-items:center;min-width:0;width:100%}
.pj-select{height:34px;padding:0 30px 0 12px;appearance:none;-webkit-appearance:none}
.pj-select-chevron{position:absolute;right:10px;display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;color:var(--dsw-alias-menu-icon);pointer-events:none}
.pj-select-chevron svg{width:12px;height:12px}
.pj-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.pj-row > .pj-grow{flex:1 1 220px;min-width:0}
.pj-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.pj-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
/* An on/off project setting: the label and its two-line hint on the left, the
   switch on the right. The track carries the state (border ink when off, the
   business fill when on) and the thumb only reinforces it, so the control still
   reads on a monochrome screenshot. */
.pj-switch-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-top:14px}
.pj-switch-text{display:flex;flex-direction:column;gap:4px;min-width:0}
.pj-switch{position:relative;flex:none;width:36px;height:20px;margin-top:2px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l4);cursor:pointer;transition:background .12s}
.pj-switch[aria-checked='true']{background:var(--dsw-alias-state-business-primary)}
.pj-switch:disabled{opacity:.4;cursor:not-allowed}
.pj-switch-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s}
.pj-switch[aria-checked='true'] .pj-switch-thumb{transform:translateX(16px)}
/* A chosen workspace is data, not a field: the Host input's geometry with no
   caret and no typing, so the path reads as the value the picker produced. */
.pj-path{display:flex;align-items:center;min-width:0;height:34px;padding:0 12px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.pj-path.pj-path-empty{color:var(--dsw-alias-label-tertiary)}
.pj-path-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The memory is a file list, not one textarea: one row per file with its name,
   one-line description, size and modified date. A row only browses: it opens the
   file's preview, and the preview owns editing and deleting. */
.pj-memory-list{display:flex;flex-direction:column;gap:2px;margin-top:2px}
.pj-memory-row{display:flex;align-items:flex-start;gap:8px;width:100%;padding:8px 10px;border-radius:var(--dsw-radius-sm)}
.pj-memory-row:hover,.pj-memory-row:focus-within{background:var(--dsw-alias-interactive-bg-hover)}
.pj-memory-open{display:flex;flex:1 1 auto;flex-direction:column;gap:2px;min-width:0;padding:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.pj-memory-row-head{display:flex;align-items:center;gap:8px;min-width:0}
.pj-memory-row-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.pj-memory-row-desc{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.pj-memory-row-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
/* The generated index leads the list and is separated from the topic files by a
   hairline: it is a different kind of row, read-only and outside the budget. */
.pj-memory-row.pj-index{margin-bottom:4px;border-bottom:.5px solid var(--dsw-alias-border-l4)}
.pj-memory-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}
/* A dialog's meta line: the size and date of the one file it shows, plus the
   badges only the dialog can know (superseded, archived, the read-only index). */
.pj-memory-preview-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
.pj-memory-preview-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;overflow-wrap:anywhere}
.pj-memory-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
/* The memory group's own tally: the file count and the total size, on the same
   muted line as a row's meta. */
.pj-memory-tally{margin:0 0 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
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
.pj-warn{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 16px 0;padding:8px 12px;border-radius:var(--dsw-radius-sm);font-size:13px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, var(--dsw-alias-bg-base));color:var(--dsw-alias-state-warn-primary)}
.pj-warn-text{min-width:0}
.pj-notice{margin:8px 16px 0;padding:8px 12px;border-radius:var(--dsw-radius-sm);font-size:13px;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, var(--dsw-alias-bg-base));color:var(--dsw-alias-state-success-primary)}
.pj-error{margin:8px 16px 0;padding:8px 12px;border-radius:var(--dsw-radius-sm);font-size:13px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, var(--dsw-alias-bg-base));color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
.pj-empty{padding:24px 16px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center}
.pj-empty-action{margin-top:12px}
/* The modal, copied from the Host Modal primitive (its CSS module rules, not an
   import): a fixed full-viewport layer, a blurred mask that fades in, and a
   layer-2 card with the panel radius and the prominent elevation. The dialog is
   a flex column with one 20px gap, so the header, the body and the pinned footer
   keep the Host's rhythm; the body is the only scroll source. */
.pj-modal-root{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top, 24px)) 24px}
.pj-modal-mask{position:absolute;inset:var(--dsh-frame-chrome-top, 0px) 0 0;backdrop-filter:var(--dsw-mask-blur)}
.pj-modal-mask:after{content:"";position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);animation:pj-modal-enter var(--ds-transition-duration) var(--ds-ease-in-out)}
.pj-modal-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);max-height:100%;padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:pj-modal-enter var(--ds-transition-duration) var(--ds-ease-in-out)}
.pj-modal-dialog:focus{outline:none}
/* Programmatic focus must not flash the focus ring; the first real key press
   drops the marker, so keyboard users still get the ring on the next Tab. */
.pj-modal-dialog [data-pj-automatic-focus]:focus-visible{outline:none}
.pj-modal-form{width:min(460px,100%)}
/* The wide card is the memory preview: its content scrolls, and when the file
   has actions the footer sits on the card's own bottom padding, so the body
   never scrolls under it. */
.pj-modal-wide{width:min(560px,100%)}
.pj-modal-content{display:flex;flex-direction:column;width:100%;min-height:0;overflow-y:auto}
.pj-modal-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.pj-modal-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.pj-modal-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.pj-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pj-modal-body{display:flex;flex-direction:column;gap:10px;min-width:0;margin-top:20px;padding:0 24px}
.pj-modal-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.pj-modal-action{min-width:72px}
.pj-modal-body > .pj-error{margin:0}
/* The settings dialog is the Host settings panel: a 188px navigation rail and a
   scrolling options column, so switching groups never resizes the dialog and
   each group owns its own scroll source. The four seats are grid areas: the
   title and the close control share the first row, the rail and the active
   group the second. */
.pj-settings-panel{display:grid;grid-template-columns:188px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);grid-template-areas:'title header' 'nav options';width:min(800px,100%);height:min(800px,100%);padding:0;gap:0;overflow:hidden}
.pj-settings-title{grid-area:title;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:22px 12px 8px 24px;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.pj-settings-head{grid-area:header;display:flex;align-items:flex-start;justify-content:flex-end;gap:8px;height:54px;padding:20px 14px 8px 10px;box-sizing:border-box}
.pj-settings-nav{grid-area:nav;min-width:0;min-height:0;display:flex;flex-direction:column;padding:10px 12px 0;box-sizing:border-box}
.pj-settings-nav-list{display:flex;flex-direction:column;gap:4px;min-height:0;overflow-y:auto}
/* The Host's nav cell: 40px tall, 9/16/9/12 padding, an 8px gap and a 16px
   icon seat. The selected fill is the sidebar's own active token. */
.pj-settings-nav-cell{display:flex;align-items:center;gap:8px;height:40px;padding:9px 16px 9px 12px;box-sizing:border-box;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;font-weight:400;text-align:left;cursor:pointer}
.pj-settings-nav-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pj-settings-nav-cell.pj-active{background:var(--dsw-specific-sidebar-nav-item-active)}
.pj-settings-nav-icon{display:flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px}
.pj-settings-nav-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.pj-settings-options{grid-area:options;min-width:0;min-height:0;padding:0 24px 24px;overflow-y:auto}
.pj-settings-options > .pj-error,.pj-settings-options > .pj-notice{margin:0 0 12px}
/* A narrow window turns the rail into a horizontal strip, as the Host panel
   does: the title and close keep the first row, the cells run edge to edge. */
@media (max-width: 640px){
  .pj-settings-panel{grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto minmax(0,1fr);grid-template-areas:'title header' 'nav nav' 'options options';width:100%;height:100%}
  .pj-settings-title{padding:22px 0 0 16px}
  .pj-settings-head{height:auto;padding:20px 16px 0 10px}
  .pj-settings-nav{padding:0}
  .pj-settings-nav-list{flex-direction:row;gap:4px;padding:12px 16px 14px;overflow-x:auto;overflow-y:hidden}
  .pj-settings-nav-cell{flex:1 0 auto;justify-content:center;min-width:108px;padding:0 14px}
  .pj-settings-nav-label{flex:none}
  .pj-settings-options{padding:0 16px 24px}
}
@keyframes pj-modal-enter{0%{opacity:0}to{opacity:1}}
${SHARED_CSS}${DISPATCH_RULES}

`

    // ---------------------------------------------------------------------
    // Data

    function messageOf(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    async function api(path, init) {
      // Every write route fences on `x-projects-api`; sending it on reads too
      // keeps one code path and costs nothing. The JSON content type is the
      // other half of the Host's fence, so both stay here rather than at each
      // call site.
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-projects-api': '1',
          ...(init && init.headers),
        },
      })
      let payload = {}
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok) {
        const failure = new Error(payload?.error || `HTTP ${response.status}`)
        // The status has to survive the throw: the delete confirmation tells a
        // running worker (409) apart from a rejected request (400), and neither
        // may be reported as a plain failure.
        failure.status = response.status
        throw failure
      }
      return payload
    }

    /**
     * The delete confirmation's failure text. A 409 on the archive call means the
     * worker is still running (the Host refuses to archive a live session) and a
     * 400 means the request itself was wrong; both leave the task on the board,
     * so neither may be swallowed into a generic message.
     */
    function taskDeleteFailure(failure, t, archive) {
      const status = failure && failure.status
      const detail = messageOf(failure)
      if (archive && status === 409) {
        // The Host answers 409 for a live worker and, in a corner case, for the
        // coordinator's own session. Only the first one is a "wait" message;
        // the second keeps the Host's wording rather than claiming a worker.
        return /still running/i.test(detail) ? t('archiveRunning') : detail
      }
      if (archive && status === 400) return `${t('archiveParamRejected')} ${detail}`
      return detail
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
    // The conversation is the page's reason to exist, so its floor is the
    // widest of the three and the side columns give way first. The rail is the
    // folded width of a side column; the separator is the drag handle.
    const MAIN_MIN = 420
    const RAIL_WIDTH = 44
    const RESIZER_WIDTH = 5
    // A side column folds on its own once the three floors no longer fit side
    // by side: Threads first, then the project list. An explicit press overrides
    // the fold, which is why these are floors of the *default* state, not a
    // hard cap on the window.
    const EXEC_FOLD_BELOW = MAIN_MIN + LIST_MIN + EXEC_MIN + RESIZER_WIDTH * 2
    const LIST_FOLD_BELOW = MAIN_MIN + LIST_MIN + RAIL_WIDTH + RESIZER_WIDTH
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
    // Cross-subtree dispatch cards
    //
    // A `projects_dispatch` call renders in the conversation's Tool row, which
    // is a different React subtree from the board page. Two module-level
    // stores bridge them without a dependency and without a shared context:
    // the page publishes the board it has loaded (so a card can resolve the
    // task it dispatched), and a card publishes "open this task" requests the
    // page consumes. Both are page-local state, never Host data.

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) {
            try {
              listener(value)
            } catch {
              // One broken subscriber must not break the others.
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /** The board the page last loaded: `{ projectId, project }`, or null. */
    const projectSnapshot = createStore(null)
    /** The last "open this task" request: `{ projectId, taskId, seq }`. */
    const openTaskRequest = createStore(null)
    let openTaskSeq = 0

    /** Ask the board to open one task's conversation. A no-op when unbound. */
    function requestOpenTask(projectId, taskId) {
      openTaskSeq += 1
      openTaskRequest.set({ projectId, taskId, seq: openTaskSeq })
    }

    /** Read a module-level store as React state. */
    function useStoreValue(store) {
      const [value, setValue] = useState(store.get)
      useEffect(() => {
        setValue(store.get())
        return store.subscribe(setValue)
      }, [store])
      return value
    }

    // ---------------------------------------------------------------------
    // Threads panel helpers
    //
    // The right column is a Threads panel: five fixed groups, one card per task
    // with a title line, a one-line summary and optional chips. The groups are
    // a partition of the one status enum, so every task lands in exactly one of
    // them and the panel cannot disagree with the sidebar tally.

    /** The five groups, in render order: one slice of the status enum each. */
    const THREAD_GROUPS = [
      { key: 'running', icon: 'spinner', titleKey: 'groupRunning', statuses: ['running'] },
      { key: 'review', icon: 'review', titleKey: 'groupReview', statuses: ['review'] },
      { key: 'waiting', icon: 'waiting', titleKey: 'groupWaiting', statuses: ['blocked', 'failed'] },
      { key: 'idle', icon: 'idle', titleKey: 'groupIdle', statuses: ['queued'] },
      { key: 'resolved', icon: 'resolved', titleKey: 'groupResolved', statuses: ['resolved'] },
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
     * Why a task has no worktree, in the reader's language.
     *
     * The Host writes `worktreeNote` itself and it names the offending path, so
     * that sentence is what the detail page shows. The enum is the fallback for
     * a payload that carries the code without the sentence; an unknown code
     * with no note renders nothing rather than an empty line.
     */
    function worktreeNoteOf(task, t) {
      const note = String((task && task.worktreeNote) || '').trim()
      if (note) return note
      if (task && task.worktreeDegraded === 'workspace_missing') return t('worktreeWorkspaceMissing')
      if (task && task.worktreeDegraded === 'not_a_git_repository') return t('worktreeNotGit')
      return ''
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

    /**
     * At most two chips: the branch, then the model route, then the task id
     * short code. A task with a worktree puts its branch first — the Host names
     * it `task/<id>`, so the id chip would only repeat it — and the model keeps
     * the second seat. Without a branch the old pair (model, id) is unchanged.
     */
    function taskChips(task) {
      const chips = []
      const branch = String(task.branch || '').trim()
      if (branch) chips.push({ text: branch, branch: true })
      const model = String(task.model || '').trim()
      if (model) chips.push({ text: model.split('/').pop() || model })
      if (task.id) chips.push({ text: String(task.id).slice(0, 6) })
      return chips.slice(0, 2)
    }

    /**
     * One thread-card chip. The branch chip is marked so the sheet can set it in
     * the monospace face, and it carries the full ref as a tooltip because the
     * chip itself may be ellipsized.
     */
    function chipElement(chip) {
      return h(
        'span',
        {
          key: chip.text,
          className: `pj-chip${chip.branch ? ' pj-chip-branch' : ''}`,
          title: chip.branch ? chip.text : undefined,
        },
        chip.text,
      )
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
     * The effort ids the Host itself ships for a reasoning model. The Host has
     * no global enum (`ReasoningEffortId` is an opaque branded string defined
     * per adapter), so this is the DeepSeek adapter's set — `off / low / high /
     * max` — used only when the catalog cannot advertise the model's own list.
     */
    const GENERIC_EFFORTS = ['off', 'low', 'high', 'max']

    /** A stored effort id; an empty string means "not set". */
    function effortValue(value) {
      return String(value || '').trim()
    }

    /**
     * The effort choices for one model route. The catalog's per-model `efforts`
     * win; an unknown route or an empty list falls back to the generic set so
     * the picker is never empty.
     */
    function effortsFor(catalog, route) {
      const found = (catalog.models || []).find((entry) => entry && entry.id === modelRouteOf(route))
      const advertised = found && Array.isArray(found.efforts) ? found.efforts : []
      const entries = advertised
        .filter((entry) => entry && entry.id)
        .map((entry) => ({ id: String(entry.id), name: entry.name ? String(entry.name) : String(entry.id) }))
      if (entries.length) return entries
      return GENERIC_EFFORTS.map((id) => ({ id, name: '' }))
    }

    /** A picker label for a stored effort; an unknown id stays visible. */
    function effortLabel(catalog, route, value, t) {
      const id = effortValue(value)
      if (!id) return ''
      const found = effortsFor(catalog, route).find((entry) => entry.id === id)
      if (found && found.name) return found.name
      const key = `effort${id.charAt(0).toUpperCase()}${id.slice(1)}`
      const localised = t(key)
      return localised === key ? id : localised
    }

    /**
     * Which layer supplies the effort a dispatch would use: the task override,
     * the project default, or (when both are empty) the host's own default.
     */
    function effectiveEffort(project, task) {
      const fromTask = effortValue(task && task.reasoningEffort)
      if (fromTask) return { value: fromTask, source: 'task' }
      const fromProject = effortValue(project && project.reasoningEffort)
      if (fromProject) return { value: fromProject, source: 'project' }
      return { value: '', source: 'host' }
    }

    /**
     * Options for the effort picker. A stored id the catalog does not advertise
     * (set by the coordinator, or a stale catalog) is appended so the control
     * never silently drops the current setting.
     */
    function effortOptions(catalog, route, current, t) {
      const entries = effortsFor(catalog, route)
      const options = entries.map((entry) =>
        h('option', { key: entry.id, value: entry.id }, entry.name || effortLabel(catalog, route, entry.id, t)),
      )
      const value = effortValue(current)
      if (value && !entries.some((entry) => entry.id === value)) {
        options.push(h('option', { key: value, value }, effortLabel(catalog, route, value, t)))
      }
      return options
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
     * Bucket tasks into the five groups. `status` is the only input: `resolved`
     * is one of its values, so accepted work lands in `Resolved` and nowhere
     * else, exactly where the sidebar's `counts.resolved` counts it.
     */
    function threadGroups(tasks) {
      const buckets = new Map(THREAD_GROUPS.map((group) => [group.key, []]))
      for (const task of tasks) {
        const group = THREAD_GROUPS.find((entry) => entry.statuses.includes(task.status))
        if (group) buckets.get(group.key).push(task)
      }
      return THREAD_GROUPS.map((group) => ({ ...group, tasks: buckets.get(group.key) }))
    }

    /** The glyph a card shows: the same one its group carries. */
    function threadIconOf(task) {
      return threadIconForStatus(task.status)
    }

    /** The glyph for a bare status, when no task record is loaded yet. */
    function threadIconForStatus(status) {
      const group = THREAD_GROUPS.find((entry) => entry.statuses.includes(status))
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

    // ---------------------------------------------------------------------
    // Shared memory
    //
    // The Host owns the memory: one markdown file per topic under
    // `memory/<name>.md`, plus a generated `MEMORY.md` index it lists beside
    // them as `memory.indexFile`. The project payload carries metadata only
    // (`memory.files`), so the page lists files and fetches one body from
    // `GET /projects/:id/memory/:name` when a file opens. Editing is per file
    // too: `POST /projects/:id/memory` takes that file's `name`. The index has
    // no write path at all.

    /** The memory's topic files from the project payload, never a body. */
    function memoryFilesOf(memory) {
      return memory && Array.isArray(memory.files) ? memory.files.filter(Boolean) : []
    }

    /** The generated `MEMORY.md` the Host lists beside the topic files, or null. */
    function memoryIndexFileOf(memory) {
      const file = memory && memory.indexFile
      return file && typeof file === 'object' ? file : null
    }

    /**
     * True for the generated index rather than a topic file. The Host marks it
     * `readOnly` and `isIndex`, and it has no write or delete path: the page
     * lists it, previews it, and offers no actions for it.
     */
    function isMemoryIndex(file) {
      return Boolean(file && (file.isIndex === true || file.readOnly === true))
    }

    /**
     * The index as a list row: the Host's metadata, but with the page's own
     * description (the Host's is an English fallback) and the read-only flags
     * the preview and the actions read.
     */
    function memoryIndexRow(indexFile, t) {
      return {
        ...indexFile,
        name: indexFile.name || 'MEMORY.md',
        description: t('memoryIndexDesc'),
        readOnly: true,
        isIndex: true,
      }
    }

    /** The `YYYY-MM-DD` date a `modified` timestamp carries, or ''. */
    function memoryDateOf(modified) {
      const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(modified ?? ''))
      return match ? match[1] : ''
    }

    /** A character count, rounded to `k` once it stops being readable. */
    function memorySize(chars, t) {
      const value = Number(chars) || 0
      const text = value < 1000 ? String(value) : `${Math.round(value / 100) / 10}k`
      return `${text} ${t('memoryChars')}`
    }

    /** The size and modified-date line under a file row's name. */
    function memoryMeta(file, t) {
      const parts = [memorySize(file && file.size, t)]
      const date = memoryDateOf(file && file.modified)
      if (date) parts.push(date)
      return parts.join(' · ')
    }

    /**
     * The settings entry row's tally: how many topic files the memory holds and
     * how big they are together. `total` is the Host's own body-character count,
     * so the page never re-adds the files it happens to list.
     */
    function memorySummary(memory, t) {
      const files = memoryFilesOf(memory)
      const total = Number(memory && memory.total)
      const chars = Number.isFinite(total)
        ? total
        : files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
      return `${files.length} ${t('memoryFiles')} · ${memorySize(chars, t)}`
    }

    /**
     * The left column's one-line tally, read straight from the Host's
     * `counts` object. `resolved` is a status, so it is listed like the others:
     * the sidebar and the Threads panel bucket a task the same way, and a board
     * the panel shows as "Resolved · 37" can no longer read "36 ready for
     * review" here.
     */
    function countsLine(project, t) {
      const counts = project.counts || {}
      const parts = ['running', 'review', 'queued', 'failed', 'blocked', 'resolved']
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
      // The prompt carries the control plane only. A project that has run for a
      // week has dozens of accepted tasks; listing them here would make every
      // coordinator turn pay for history it never reads. The counts line still
      // says how many are resolved, and projects_get with include_resolved: true
      // is the way back to their output.
      const open = tasks.filter((task) => task.status !== 'resolved')
      const tally = {}
      for (const task of tasks) tally[task.status] = (tally[task.status] || 0) + 1
      // Same order and separator as the Host's `projects_get` counts line, so the
      // prompt and the tool read identically for the same board.
      const countsText =
        ['running', 'review', 'queued', 'failed', 'blocked', 'resolved']
          .filter((status) => (tally[status] || 0) > 0)
          .map((status) => `${tally[status]} ${status}`)
          .join(', ') || (zh ? '无' : 'none')
      const taskLines = open.length
        ? open.map((task) => `- ${task.id} [${task.status}] ${task.title}`).join('\n')
        : tasks.length === 0
          ? zh
            ? '(还没有任务)'
            : '(none yet)'
          : zh
            ? '(没有未完成的任务)'
            : '(no open tasks)'
      const resolvedNote =
        tally.resolved > 0
          ? zh
            ? `已 resolved 的 ${tally.resolved} 条任务不在此列出；需要产出时用 projects_get 并传 include_resolved: true。`
            : `${tally.resolved} resolved task(s) are not listed here; read their output with projects_get and include_resolved: true.`
          : ''
      // The header changes with the board; the rules below it change when this
      // plugin is upgraded. They are built separately so the fingerprint can
      // cover the rules alone: a task moving from queued to running must not
      // look like a rules change.
      const header = zh
        ? [
            `你是 DSH 项目「${project.name}」的协调者（project_id: ${project.id}）。`,
            '',
            '## 项目目标与指令',
            project.goal?.trim() || '（未填写）',
            '',
            '## 当前任务',
            `counts: ${countsText}`,
            taskLines,
            ...(resolvedNote ? [resolvedNote] : []),
          ]
        : [
            `You are the coordinator of the DSH project "${project.name}" (project_id: ${project.id}).`,
            '',
            '## Project instructions',
            project.goal?.trim() || '(none)',
            '',
            '## Current tasks',
            `counts: ${countsText}`,
            taskLines,
            ...(resolvedNote ? [resolvedNote] : []),
          ]
      return [...header, '', coordinatorRules(project, locale)].join('\n')
    }

    /**
     * The rules half of the coordinator prompt: the job, the brief rules and the
     * reply rules, without the project header. This is the text a plugin upgrade
     * changes, so it is the text `coordinatorPromptFingerprint` hashes.
     */
    function coordinatorRules(project, locale) {
      const zh = String(locale || '').toLowerCase().startsWith('zh')
      if (zh) {
        return [
          '## 你的职责',
          '你只负责四件事：拆解、分派、验收、汇报。',
          '',
          '1. 需要读文件、改代码、跑命令、多步排查的工作，一律用 projects_add_task 派生任务交给执行者，不要在对话里自己动手，也不要把命令输出、文件内容、排查过程贴进对话。',
          '2. 用 projects_add_task 把目标拆成可并行的任务，每个任务要能独立完成；任务说明里写清做什么、在哪里做、如何验收。',
          '3. 用 projects_dispatch 派发任务；派发后继续响应用户，不要等待。',
          '4. 执行者交回结果后，用 projects_get 查看产出，用一两句话向用户汇报结论，并请用户在项目页验收。',
          '5. 用 projects_memory 维护共享记忆，让所有执行者共享结论。',
          '6. 任务是否完成由人验收：只有用户明确表示通过时，你才用 projects_update_task 把状态设为 resolved；不要替用户宣布任务已完成。',
          project.autonomy === 'manual'
            ? '7. 当前自主程度是手动：派发前需要用户在主对话里明确同意，再由你用 projects_update_task 把该任务标为 approved，然后派发。'
            : '7. 当前自主程度是自动：你可以直接派发任务。',
          '8. 派发前先看上面的任务列表：如果这次要做的是某条未完成任务（同一件事）的后续阶段，用 projects_dispatch 的 note 参数继续那条任务，不要新建；只有不同的事才用 projects_add_task 新建任务。任务说明要补充时用 projects_update_task 的 append_brief，不要另起一条任务。',
          '',
          '## 任务说明怎么写（硬约束）',
          '1. 任务说明（brief）只写三件事：问题是什么、约束是什么、怎么算做完。不写实现方案。',
          '2. 不要预先设计：不写「用 X 方案」「改第 N 行」「分三步做」，怎么做由执行者自己判断。',
          '3. 不写行号：行号会过期，让执行者自己定位。',
          '4. 长度上限：brief 一般 ≤ 15 行；超过必须是因为约束确实多（比如安全要求、兼容性要求）。',
          '5. 不重复项目指令：项目级约束写在项目指令里，brief 里不要重复。',
          '6. 验收标准要具体：写清怎么验证，比如「npm test 全绿」「截图确认 X」。',
          '',
          '## 回答方式（硬约束）',
          '1. 先判断再展开：简单问题（是什么、能不能、怎么做）直接给答案，不要先分析再回答。',
          '2. 不要无谓的结构化：不要在回复里用表格、编号清单、分节标题，除非用户明确要求，或内容确实并列。',
          '3. 不要过程叙述：不写「我先看看」「让我分析一下」「有几种可能」，直接给结论；不要解释你打算怎么做，直接做（拆任务、派发）或直接回答。',
          '4. 不要重复：同一件事只说一次，不要开头说一遍、结尾再说一遍。',
          '5. 长度硬上限：一般 ≤ 3 句；需要解释时 ≤ 6 句；超过 6 句必须说明理由（例如用户问了复杂问题）。这是上限，不是目标。',
          '6. 派任务时只说三件事：派了什么、为什么、等什么；不要复述任务 brief，不要复述任务产出（执行者的 output 已经在任务里）。',
          '7. 不确定时问一句：一次只问必要的问题，不要列举所有可能性，也不要一次抛多个。',
          '8. 不要罗列已完成任务清单。',
        ].join('\n')
      }
      return [
        '## Your job',
        'You do four things only: split the goal, dispatch, review, report.',
        '',
        '1. Anything that needs reading files, editing code, running commands, or multi-step investigation must be derived into a task with projects_add_task. Do not do that work in the conversation, and do not paste command output, file contents, or investigation steps into it.',
        '2. Use projects_add_task to split the goal into parallel, independently finishable tasks; each brief says what to do, where, and how to verify it.',
        '3. Use projects_dispatch to start tasks; stay responsive instead of waiting.',
        '4. When a worker reports back, use projects_get to read its output, report the conclusion to the user in a sentence or two, and ask the user to review it on the Projects page.',
        '5. Keep shared knowledge in projects_memory so every worker starts informed.',
        '6. The human accepts tasks: set status "resolved" with projects_update_task only when the user says so, and never declare a task complete on the user\'s behalf.',
        project.autonomy === 'manual'
          ? '7. Autonomy is manual: get the user\'s explicit go-ahead in this conversation, mark the task approved with projects_update_task, then dispatch.'
          : '7. Autonomy is auto: you may dispatch without waiting for approval.',
        '8. Before dispatching, read the task list above: when the next step is a later stage of an unfinished task (the same piece of work), continue that task with the projects_dispatch note parameter instead of creating a new one; create a task only for different work. To add to a brief, use projects_update_task append_brief rather than opening another task.',
        '',
        '## How to write a task brief (hard rules)',
        '1. A brief says three things only: what the problem is, what the constraints are, and what counts as done. Never the implementation plan.',
        '2. Do not pre-design: never write "use approach X", "change line N", or "do it in three steps" — how to do it is the worker\'s call.',
        '3. No line numbers: they go stale; let the worker locate the code.',
        '4. Length cap: a brief is usually ≤ 15 lines; going over must be justified by genuinely many constraints (security, compatibility).',
        '5. Do not repeat the project instructions: project-wide constraints belong in the project instructions, not in every brief.',
        '6. Acceptance criteria must be concrete: say how to verify, e.g. "npm test is green" or "screenshot confirms X".',
        '',
        '## Reply style (hard rules)',
        '1. Decide first, then expand: for a simple question (what / can it / how), answer directly. Do not analyse before answering.',
        '2. No needless structure: in your replies, no tables, numbered lists, or section headings unless the user asks for them or the content is genuinely parallel.',
        '3. No process narration: never write "Let me take a look", "Let me analyse", or "There are several possibilities" — give the conclusion. Do not explain what you are about to do; just do it (split, dispatch) or answer.',
        '4. No repetition: say each thing once; do not say it at the start and again at the end.',
        '5. Hard length cap: usually ≤ 3 sentences; ≤ 6 when an explanation is genuinely needed; more than 6 requires a stated reason (e.g. the user asked a complex question). The cap is a ceiling, not a target.',
        '6. When dispatching, say three things only: what you dispatched, why, and what you are waiting for. Do not restate the task brief. Do not restate task output — the worker output already lives in the task.',
        '7. When unsure, ask one question instead of listing every possibility. Ask one necessary question at a time, never several at once.',
        '8. Do not list completed tasks.',
      ].join('\n')
    }

    /**
     * A short stable fingerprint of one string (FNV-1a, 32 bit, hex). The client
     * has no crypto dependency and the value only has to answer "same rules or
     * not", so a non-cryptographic hash is enough.
     */
    function promptFingerprint(value) {
      const source = String(value ?? '')
      let hash = 0x811c9dc5
      for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16).padStart(8, '0')
    }

    /**
     * Which rules a coordinator Session has seen. The page records it on the
     * project as `coordinatorPromptHash`; the next start appends an update only
     * when the current rules hash to a different value. The board header is
     * deliberately outside the hash: tasks, counts, goal and name change all the
     * time and none of them is a rules change.
     */
    function coordinatorPromptFingerprint(project, locale) {
      return promptFingerprint(coordinatorRules(project, locale))
    }

    /**
     * The message appended to an existing coordinator Session whose rules are
     * stale. It is an append, never a replacement: the old rules stay in the
     * transcript and this note says which version supersedes them. The full
     * prompt follows, so the same message also refreshes the board snapshot
     * (goal, tasks, counts) the coordinator reasons about.
     */
    function coordinatorUpdatePrompt(prompt, fingerprint, locale) {
      const zh = String(locale || '').toLowerCase().startsWith('zh')
      const note = zh
        ? `协调者规则已更新（版本 ${fingerprint}）。以下是最新的协调者规则，取代之前消息里的旧规则；请按下面的规则继续工作。`
        : `The coordinator rules have been updated (version ${fingerprint}). The rules below replace the earlier ones — follow them from now on.`
      return `${note}\n\n${prompt}`
    }

    // ---------------------------------------------------------------------
    // Components

    /**
     * The sidebar glyph: a stack of cards, drawn on the host's 24x24 grid.
     * Two centred rules (the short one on top, the long one under it) sit above
     * a rounded card body, so the mark reads as "a pile of cards". Pure outline,
     * no fill and no check.
     *
     * Geometry is tuned to the host's optical weight: the ink box (stroke
     * included) is exactly 2..22 on both axes, i.e. 20/24 = 83.3% fill, the same
     * as a host-shaped glyph. The three strokes are 5 units apart on the grid,
     * which leaves 3.2 units of clear space, so at 16px the rules stay 2.13px
     * apart and do not smear into one blob.
     */
    function ProjectsIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 18
      const stroke = {
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }
      return h(
        'svg',
        { width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M7 2.9H17', ...stroke }),
        h('path', { d: 'M5 7.9H19', ...stroke }),
        h('path', {
          d: 'M5.9 12.9H18.1Q21.1 12.9 21.1 15.9V18.1Q21.1 21.1 18.1 21.1H5.9Q2.9 21.1 2.9 18.1V15.9Q2.9 12.9 5.9 12.9Z',
          ...stroke,
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

    /**
     * The Host's 16px outline glyphs, drawn from its own symbol paths.
     *
     * A client bundle may not import a Host package, so every icon below is the
     * path data of the matching `Icon*OutlineRegular` symbol, redrawn inline on
     * the Host's 16 grid. The Host's `regular` stroke weight is 1 and its
     * `medium` 1.3; these use 1.4 so they carry the same optical weight as the
     * 16px glyphs this file already draws (the resolve ring, the trash can),
     * which is what makes a header row of them read as one set.
     */
    const ICON_STROKE = 1.4

    /** One outline glyph on the Host's 16 grid. */
    function OutlineIcon({ size, className, children }) {
      const edge = typeof size === 'number' && size > 0 ? size : 16
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          className,
        },
        children,
      )
    }

    /** `IconPanelLeftOutlineRegular`: the Host's sidebar-collapse mark. */
    function PanelLeftIcon({ size }) {
      return h(
        OutlineIcon,
        { size, className: size === 18 ? 'pj-icon-18' : 'pj-icon-16' },
        h('path', {
          d: 'M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
        }),
        h('path', { d: 'M5.5 1.5V14.5', stroke: 'currentColor', strokeWidth: ICON_STROKE }),
      )
    }

    /**
     * The panel glyph mirrored, for the column that folds to the right.
     *
     * The Host's symbol set ships `panel-left-outline` and nothing for the right
     * side, so this is that path with the divider on the other edge — same 16
     * grid, same stroke, so the two fold controls read as one pair.
     */
    function PanelRightIcon({ size }) {
      return h(
        OutlineIcon,
        { size, className: size === 18 ? 'pj-icon-18' : 'pj-icon-16' },
        h('path', {
          d: 'M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
        }),
        h('path', { d: 'M10.5 1.5V14.5', stroke: 'currentColor', strokeWidth: ICON_STROKE }),
      )
    }

    /** `IconSettingsOutlineRegular`: the settings-dialog trigger. */
    function GearIcon({ size }) {
      return h(
        OutlineIcon,
        { size, className: 'pj-icon-16' },
        h('path', {
          d: 'M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
        }),
        h('path', {
          d: 'M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeMiterlimit: 10,
        }),
      )
    }

    /** `IconPlusOutlineRegular`: the new-project trigger. */
    function PlusIcon({ size }) {
      return h(
        OutlineIcon,
        { size, className: 'pj-icon-16' },
        h('path', { d: 'M8 2V14', stroke: 'currentColor', strokeWidth: ICON_STROKE }),
        h('path', { d: 'M2 8H14', stroke: 'currentColor', strokeWidth: ICON_STROKE }),
      )
    }

    /** `IconSearchOutlineRegular`: the search trigger and the field's glyph. */
    function SearchIcon({ size }) {
      return h(
        OutlineIcon,
        { size, className: 'pj-icon-16' },
        h('path', {
          d: 'M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
        }),
        h('path', {
          d: 'M10.2991 10.3933L14.7783 14.8725',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
        }),
      )
    }

    /** `IconSlidersTwoOutlineRegular`: the group-filter trigger. */
    function FilterIcon({ size }) {
      return h(
        OutlineIcon,
        { size, className: 'pj-icon-16' },
        h('path', {
          d: 'M2.3 5h5.85M12.05 5h1.65',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 9.95, cy: 5, r: 1.45, stroke: 'currentColor', strokeWidth: ICON_STROKE }),
        h('path', {
          d: 'M2.3 11h1.65M7.85 11h5.85',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 5.75, cy: 11, r: 1.45, stroke: 'currentColor', strokeWidth: ICON_STROKE }),
      )
    }

    /** `IconCloseOutlineRegular`: the dialog's dismiss control. */
    function CloseIcon({ size }) {
      return h(
        OutlineIcon,
        { size },
        h('path', { d: 'M2.5 2.5L13.5 13.5', stroke: 'currentColor', strokeWidth: ICON_STROKE }),
        h('path', { d: 'M13.5 2.5L2.5 13.5', stroke: 'currentColor', strokeWidth: ICON_STROKE }),
      )
    }

    /** `IconArchiveOutlineRegular`: the danger-zone action. */
    function ArchiveIcon({ size }) {
      return h(
        OutlineIcon,
        { size },
        h('path', {
          d: 'M13.5 2.5H2.5C1.94772 2.5 1.5 2.94772 1.5 3.5V4.5C1.5 5.05228 1.94772 5.5 2.5 5.5H13.5C14.0523 5.5 14.5 5.05228 14.5 4.5V3.5C14.5 2.94772 14.0523 2.5 13.5 2.5Z',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
        }),
        h('path', {
          d: 'M2.5 5.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V5.5',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
        }),
        h('path', { d: 'M6.5 9.5H9.5', stroke: 'currentColor', strokeWidth: ICON_STROKE }),
      )
    }

    /** `IconCheckOutlineRegular`: a drawn check for the filter menu's rows. */
    function CheckIcon() {
      return h(
        OutlineIcon,
        { size: 14 },
        h('path', {
          d: 'M3.2 8.4L6.2 11.4L12.8 4.8',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** A ruled page: the settings rail's shared-memory group. */
    function MemoryIcon({ size }) {
      return h(
        OutlineIcon,
        { size },
        h('path', {
          d: 'M4 1.5H9.5L12.5 4.5V14.5H4V1.5Z',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M9.5 1.5V4.5H12.5', stroke: 'currentColor', strokeWidth: ICON_STROKE }),
        h('path', {
          d: 'M6 7.5H10.5M6 10.5H10.5',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * A git branch: one trunk with two commits on it and a second line forking
     * off. It marks the worktree's branch name in the detail head, so it is
     * drawn on the same 16 grid and stroke as the other outline glyphs.
     */
    function BranchIcon({ size }) {
      return h(
        OutlineIcon,
        { size },
        h('path', {
          d: 'M4.5 4.2V11.8',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M4.5 8.2C4.5 6 6.1 4.6 8.1 4.6H11.5',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 4.5, cy: 3.1, r: 1.4, stroke: 'currentColor', strokeWidth: ICON_STROKE }),
        h('circle', { cx: 4.5, cy: 12.9, r: 1.4, stroke: 'currentColor', strokeWidth: ICON_STROKE }),
        h('circle', { cx: 11.5, cy: 4.6, r: 1.4, stroke: 'currentColor', strokeWidth: ICON_STROKE }),
      )
    }

    /** Two offset sheets: the copy control beside the branch name. */
    function CopyIcon({ size }) {
      return h(
        OutlineIcon,
        { size },
        h('rect', {
          x: 5.6,
          y: 5.6,
          width: 7.4,
          height: 7.4,
          rx: 1.4,
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
        }),
        h('path', {
          d: 'M10.4 5.6V4.2C10.4 3.4 9.8 2.8 9 2.8H4.2C3.4 2.8 2.8 3.4 2.8 4.2V9C2.8 9.8 3.4 10.4 4.2 10.4H5.6',
          stroke: 'currentColor',
          strokeWidth: ICON_STROKE,
          strokeLinejoin: 'round',
        }),
      )
    }

    // ---------------------------------------------------------------------
    // Modal
    //
    // Copied from the Host Modal primitive (`dsh-client-ui-primitives`), which a
    // client bundle may not import: the same layer / mask / card geometry and
    // the same focus contract.
    //   - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
    //   - Escape closes; a click on the mask closes unless the dialog opts out
    //     (a destructive confirmation must not dismiss on a stray click)
    //   - focus moves into the dialog on open and returns to the trigger on
    //     close
    //   - Tab and Shift+Tab cycle inside the dialog and cannot escape it
    //   - the page behind the mask does not scroll

    /** The Host's focusable selector, verbatim. */
    const FOCUSABLE =
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

    /** Keys that end the "focus arrived programmatically" state. */
    const NAV_KEYS = ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']

    /**
     * Focus a node without flashing the focus ring, the way the Host's
     * `focusWithoutRing` does: mark the node, drop the mark on blur or on the
     * first navigation key, so a keyboard user still gets the ring on the next
     * Tab. Degrades to a plain `focus()` when the node cannot be marked.
     */
    function focusWithoutRing(node) {
      if (!node || typeof node.focus !== 'function') return
      const release = () => {
        try {
          node.removeAttribute('data-pj-automatic-focus')
          node.removeEventListener('blur', release)
          node.removeEventListener('keydown', onKey, true)
        } catch {
          // A detached node is already released.
        }
      }
      const onKey = (event) => {
        if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
        if (NAV_KEYS.includes(event.key)) release()
      }
      try {
        node.setAttribute('data-pj-automatic-focus', '')
        node.addEventListener('blur', release)
        node.addEventListener('keydown', onKey, true)
      } catch {
        // No listener surface: focus plainly.
      }
      node.focus({ preventScroll: true })
      if (typeof node.matches === 'function' && !node.matches(':focus')) release()
    }

    /**
     * The open dialog layers, innermost last. Two dialogs can be open at once —
     * the settings dialog and a memory preview opened from it — so only the top
     * layer answers Escape and traps Tab: otherwise one Escape would close both,
     * and the outer trap would pull focus back out of the inner dialog.
     */
    const MODAL_LAYERS = []

    /** The overflow the outermost layer found, restored by the last one out. */
    let modalSavedOverflow = ''

    /**
     * Hold one dialog open for its lifetime: move focus in, trap Tab, close on
     * Escape, lock the page scroll and hand focus back to the trigger.
     *
     * Escape closes exactly one level: only the innermost layer answers, so a
     * memory preview opened over the settings dialog closes first and the
     * settings dialog stays open.
     *
     * A no-op without a document, so the element-tree harness can render the
     * page. `returnFocusRef` is the trigger element's ref; when it is gone the
     * element that had focus when the dialog opened gets it back.
     */
    function useModalLayer(ref, open, onClose, returnFocusRef) {
      const closeRef = useRef(onClose)
      closeRef.current = onClose
      const returnRef = useRef(returnFocusRef)
      returnRef.current = returnFocusRef
      useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const node = ref && ref.current
        if (!node || typeof node.querySelector !== 'function') return undefined
        const previous = document.activeElement
        // The Host's order: the marked control, else the first focusable, else
        // the dialog itself.
        const target =
          node.querySelector('[data-pj-modal-autofocus]') || node.querySelector(FOCUSABLE) || node
        if (!node.contains(document.activeElement)) focusWithoutRing(target)
        const layer = {}
        MODAL_LAYERS.push(layer)
        const onKeyDown = (event) => {
          // Only the innermost dialog reacts, so a preview on top of the
          // settings dialog never closes the dialog underneath it.
          if (MODAL_LAYERS[MODAL_LAYERS.length - 1] !== layer) return
          if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
          if (event.ctrlKey || event.altKey || event.metaKey) return
          if (event.key === 'Escape') {
            if (event.shiftKey) return
            event.preventDefault()
            if (!event.repeat) closeRef.current()
            return
          }
          if (event.key !== 'Tab') return
          const focusable = [...node.querySelectorAll(FOCUSABLE)]
          const first = focusable[0] || node
          const last = focusable[focusable.length - 1] || node
          const active = document.activeElement
          const cycling =
            active === last ? !event.shiftKey : active === first ? event.shiftKey : false
          if (!node.contains(active) || cycling) {
            event.preventDefault()
            const next = event.shiftKey ? last : first
            if (typeof next.focus === 'function') next.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        // The mask covers the viewport, but a wheel over it would still scroll
        // the page behind: lock the body while the outermost dialog is open, so
        // a preview closing under the settings dialog cannot unlock it early.
        const body = document.body
        if (body && MODAL_LAYERS.length === 1) {
          modalSavedOverflow = body.style.overflow
          body.style.overflow = 'hidden'
        }
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          const at = MODAL_LAYERS.indexOf(layer)
          if (at >= 0) MODAL_LAYERS.splice(at, 1)
          if (body && MODAL_LAYERS.length === 0) body.style.overflow = modalSavedOverflow
          const trigger = returnRef.current && returnRef.current.current
          const back = trigger && trigger.isConnected ? trigger : previous
          if (back && back.isConnected) focusWithoutRing(back)
        }
      }, [ref, open])
    }

    /**
     * One dialog. The page root is already a full-size surface, so the layer is
     * a plain child with `position:fixed` instead of a portal: it still covers
     * the viewport, and it unmounts with the page.
     *
     * `nav` turns the dialog into the Host settings panel: a fixed two-column
     * card with the title and close in the first row, the navigation rail on
     * the left and the active group in the scrolling options column. Without
     * it the dialog keeps the plain header + body card.
     */
    function Modal(props) {
      const {
        open,
        titleId,
        title,
        closeLabel,
        onClose,
        maskClose = true,
        returnFocusRef,
        className,
        children,
        footer,
        nav,
      } = props
      const dialogRef = useRef(null)
      useModalLayer(dialogRef, open, onClose, returnFocusRef)
      if (!open) return null
      const close = h(
        'button',
        {
          className: 'pj-modal-close',
          type: 'button',
          'aria-label': closeLabel,
          onClick: onClose,
        },
        h(CloseIcon, { size: 14 }),
      )
      const mask = h('div', {
        className: 'pj-modal-mask',
        'aria-hidden': 'true',
        // A destructive confirmation opts out: a stray press outside it must
        // not dismiss the dialog that is about to archive the project.
        onClick: maskClose ? onClose : undefined,
      })
      if (nav) {
        return h(
          'div',
          { className: 'pj-modal-root', role: 'presentation' },
          mask,
          h(
            'div',
            {
              ref: dialogRef,
              tabIndex: -1,
              className: `pj-modal-dialog pj-settings-panel${className ? ` ${className}` : ''}`,
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': titleId,
            },
            h('h2', { className: 'pj-modal-title pj-settings-title', id: titleId }, title),
            h('div', { className: 'pj-settings-head' }, close),
            h(
              'nav',
              { className: 'pj-settings-nav', 'aria-label': nav.label },
              h(
                'div',
                { className: 'pj-settings-nav-list' },
                nav.items.map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      type: 'button',
                      className: `pj-settings-nav-cell${item.id === nav.active ? ' pj-active' : ''}`,
                      'aria-current': item.id === nav.active ? 'true' : undefined,
                      // The Host focuses the selected cell when the panel opens.
                      'data-pj-modal-autofocus': item.id === nav.active ? '' : undefined,
                      onClick: () => nav.onSelect(item.id),
                    },
                    h('span', { className: 'pj-settings-nav-icon', 'aria-hidden': true }, item.icon),
                    h('span', { className: 'pj-settings-nav-label' }, item.label),
                  ),
                ),
              ),
            ),
            h('div', { className: 'pj-settings-options' }, children),
          ),
        )
      }
      return h(
        'div',
        { className: 'pj-modal-root', role: 'presentation' },
        mask,
        h(
          'div',
          {
            ref: dialogRef,
            tabIndex: -1,
            className: `pj-modal-dialog${className ? ` ${className}` : ''}`,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': titleId,
          },
          h(
            'div',
            { className: 'pj-modal-content' },
            h(
              'div',
              { className: 'pj-modal-header' },
              h('h2', { className: 'pj-modal-title', id: titleId }, title),
              close,
            ),
            h('div', { className: 'pj-modal-body' }, children),
          ),
          footer ? h('div', { className: 'pj-modal-footer' }, footer) : null,
        ),
      )
    }

    /** The select caret, matching the Host's 12px chevron in the menu-icon tone. */
    function ChevronDownIcon() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M3 4.75L6 7.75l3-3',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** The context menu's delete glyph, at the Host's 14px icon seat. */
    function TrashIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M3.2 5.2h9.6M6.4 5.2V3.6h3.2v1.6M4.6 5.2l.6 7.2h5.6l.6-7.2',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    // The Idle ring, dot by dot: eight dots on a 5.6 radius around the 16-grid
    // centre. Drawn as separate dots rather than a dashed border so the ring
    // keeps its rhythm at 14px instead of smearing into a solid stroke.
    const IDLE_DOTS = [
      [13.6, 8],
      [11.96, 11.96],
      [8, 13.6],
      [4.04, 11.96],
      [2.4, 8],
      [4.04, 4.04],
      [8, 2.4],
      [11.96, 4.04],
    ]

    /**
     * The group glyph: thin open arc, ring around a pie, warning ring, dotted
     * ring, filled check disc.
     *
     * The five follow the reference Threads panel, and each silhouette is
     * different on purpose: a thin open arc that spins (Working), a closed ring
     * around a filled three-quarter pie that stands still (Ready-for-review —
     * the work is done but not accepted, so the pie says the circle is not
     * filled yet), a ring around a bar (Waiting), a ring of dots (Idle), a
     * filled disc with a knocked-out check (Resolved, the one glyph that means
     * accepted). All five sit on the same 16 grid, so they read as one family
     * at 14px; only the ink is drawn, and every colour is `currentColor` or a
     * `--dsw-*` token, so the theme owns the palette.
     */
    function ThreadIcon({ kind }) {
      if (kind === 'spinner') {
        // Three quarters of a circle, drawn from cubics only so the arc has no
        // straight segment to catch the eye, and open at the top-left so the
        // spin is visible.
        return h(
          'svg',
          {
            className: 'pj-thread-icon pj-thread-spinner',
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': true,
          },
          h('path', {
            d: 'M8 2.4C11.09 2.4 13.6 4.91 13.6 8C13.6 11.09 11.09 13.6 8 13.6C4.91 13.6 2.4 11.09 2.4 8',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
          }),
        )
      }
      if (kind === 'review') {
        // A complete ring with a three-quarter pie inside it: the work is
        // finished, but the circle is not filled yet, so the glyph reads as
        // "not turned all the way round" without borrowing Working's open-arc
        // silhouette. Two layers, two paints — the ring is stroked at 1.6 and
        // the pie is filled, both in `currentColor` — and the 90° the pie is
        // missing sits in the top-right quadrant (from 12 o'clock round to 3
        // o'clock), away from Working's top-left bite. The ring keeps a 2-unit
        // gutter around the pie so the two layers stay apart at 14px, and
        // nothing here animates.
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
          // The pie: a 270° sector on a 3.6 radius, drawn from cubics only, with
          // its two radial edges running back to the centre and closing.
          h('path', {
            d: 'M11.6 8C11.6 9.99 9.99 11.6 8 11.6C6.01 11.6 4.4 9.99 4.4 8C4.4 6.01 6.01 4.4 8 4.4L8 8Z',
            fill: 'currentColor',
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
        // A ring of dots: nothing is moving and nothing is asked of anyone.
        return h(
          'svg',
          {
            className: 'pj-thread-icon pj-thread-idle',
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': true,
          },
          IDLE_DOTS.map(([cx, cy]) =>
            h('circle', { key: `${cx}:${cy}`, cx, cy, r: 1, fill: 'currentColor' }),
          ),
        )
      }
      if (kind === 'resolved') {
        // A filled disc with the check knocked out of it in the surface colour,
        // so the glyph reads as a stamp rather than as another ring.
        return h(
          'svg',
          {
            className: 'pj-thread-icon pj-thread-resolved',
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': true,
          },
          h('circle', { cx: 8, cy: 8, r: 6.4, fill: 'currentColor' }),
          h('path', {
            d: 'M5 8.3L7.1 10.4L11.1 6.2',
            stroke: 'var(--dsw-alias-bg-base)',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )
      }
      return null
    }

    /**
     * One `projects_dispatch` call in the conversation, as a compact card.
     *
     * The card is the only button and carries no other control: it shows the
     * task the call dispatched and opens that task's conversation in the
     * board's right column. It reads, never writes — the pill and the badge
     * only display `task.status`, which the human accepts elsewhere.
     *
     * The call's arguments arrive lazily and may still be streaming, so every
     * read is total: a missing `task_id` degrades to the "dispatching" label
     * instead of throwing. The task record itself comes from the board the page
     * publishes; without it the card falls back to the id and the phase, and a
     * click is a no-op when no board is bound (a Session outside the page).
     */
    function ProjectsDispatchRow(props) {
      const t = typeof props.translate === 'function' ? props.translate : (key) => key
      const locale = typeof props.activeLocale === 'function' ? props.activeLocale() : undefined
      const block = props.block
      const args = block && block.args
      const readArg = (name) => {
        try {
          return args && typeof args.text === 'function' ? String(args.text(name) || '') : ''
        } catch {
          // A half-streamed argument view answers undefined; never throw here.
          return ''
        }
      }
      const projectId = readArg('project_id')
      const taskId = readArg('task_id')
      const snapshot = useStoreValue(projectSnapshot)
      const tasks = snapshot && snapshot.projectId === projectId ? snapshot.project.tasks || [] : []
      const task = tasks.find((entry) => entry && entry.id === taskId) || null
      // A dispatch that was refused (approval, concurrency, archived project)
      // answers with prose rather than an error, so the result text is the only
      // evidence that a worker actually started.
      const resultText =
        props.phase === 'result' && block && Array.isArray(block.content)
          ? block.content
              .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
              .map((entry) => entry.text)
              .join('\n')
              .trim()
          : ''
      const status = task
        ? task.status
        : props.phase === 'result'
          ? block && block.isError
            ? 'failed'
            : /^Dispatched task\b/.test(resultText)
              ? 'running'
              : 'queued'
          : props.phase === 'start'
            ? 'running'
            : 'queued'
      const title = (task && task.title) || taskId || t('dispatchPreparing')
      const stamp = task ? relativeTime(task, t, locale) : ''
      const openable = Boolean(projectId && taskId)
      const cells = [
        h(ThreadIcon, { kind: task ? threadIconOf(task) : threadIconForStatus(status) }),
        h('span', { className: 'pj-dispatch-name' }, title),
        stamp ? h('span', { className: 'pj-dispatch-time' }, stamp) : null,
        h(StatusPill, { status, t }),
        task && task.status === 'resolved' ? h('span', { className: 'pj-chip' }, t('resolvedBadge')) : null,
      ].filter(Boolean)
      return h(
        'div',
        { className: 'pj-dispatch-wrap' },
        h('style', { dangerouslySetInnerHTML: { __html: DISPATCH_CSS } }),
        h(
          'button',
          {
            className: 'pj-dispatch',
            type: 'button',
            disabled: !openable,
            'aria-label': `${t('dispatchCard')}: ${title}`,
            title: openable ? `${title}\n${t('dispatchOpenHint')}` : title,
            onClick: () => {
              if (openable) requestOpenTask(projectId, taskId)
            },
          },
          ...cells,
        ),
      )
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
      const [goalDirty, setGoalDirty] = useState(false)
      const [memoryDirty, setMemoryDirty] = useState(false)
      // The memory is one file per topic: a row opens that file's body in a
      // read-only preview, and the preview offers the file's two actions. The
      // editor edits that one file and saves it by name. Both are dialogs on
      // top of settings.
      const [memoryPreview, setMemoryPreview] = useState(null)
      const [memoryEditor, setMemoryEditor] = useState(null)
      // Deleting one memory file is destructive, so the preview arms it on the
      // first press and only the second one deletes.
      const [memoryDeleteArmed, setMemoryDeleteArmed] = useState('')
      // Both project-level surfaces are dialogs now: the list header carries a
      // plus glyph and the main header a gear, and neither takes a column.
      const [showNewProject, setShowNewProject] = useState(false)
      const [newProject, setNewProject] = useState({
        name: '',
        goal: '',
        workspace: '',
        concurrency: 2,
      })
      const [showSettings, setShowSettings] = useState(false)
      // The settings dialog is the Host's two-column panel: a navigation rail
      // with one cell per group and a content column that renders only the
      // selected group. Switching groups never closes the dialog and never
      // stacks a second one.
      const [settingsGroup, setSettingsGroup] = useState('general')
      // Archiving is destructive, so the settings dialog arms it on the first
      // press and only the second one archives.
      const [archiveArmed, setArchiveArmed] = useState(false)
      const newProjectTrigger = useRef(null)
      const settingsTrigger = useRef(null)
      const [confirmDeleteId, setConfirmDeleteId] = useState(null)
      const confirmDeleteAt = useRef(0)
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
      //
      // Folding a column is a three-state choice, not a boolean: `'1'` folded,
      // `'0'` open, and the empty string (the default) means "follow the
      // viewport". That is what lets a narrow window fold the side columns on
      // its own while an explicit press — in either direction — always wins.
      const [listChoice, setListChoice] = useState(() => readStored('listCollapsed', ''))
      const [execChoice, setExecChoice] = useState(() => readStored('execCollapsed', ''))
      const [listWidth, setListWidth] = useState(() => readStoredNumber('listWidth', LIST_WIDTH))
      const [execWidth, setExecWidth] = useState(() => readStoredNumber('execWidth', EXEC_WIDTH))
      // The window width drives the default fold, so the page tracks it.
      const [viewport, setViewport] = useState(viewportWidth)
      const [resizing, setResizing] = useState(null)

      // The conversation outranks both side columns: a column folds itself once
      // the window is too narrow for the three floors to sit side by side.
      const listCollapsed =
        listChoice === '1' || (listChoice !== '0' && viewport > 0 && viewport < LIST_FOLD_BELOW)
      const execCollapsed =
        execChoice === '1' || (execChoice !== '0' && viewport > 0 && viewport < EXEC_FOLD_BELOW)

      /**
       * The widths the three columns actually paint with.
       *
       * The conversation keeps `MAIN_MIN` and the side columns give way: a
       * stored width is capped at whatever is left after the conversation's
       * floor, and when both are open and too wide for the room they shrink in
       * proportion to what each holds above its own floor, the way two
       * shrinkable flex items would. A folded column is its rail and owns no
       * separator. With no viewport to measure (a harness, a prerender) the
       * stored widths stand as they are.
       */
      const columnLayout = () => {
        const listSpan = listCollapsed ? RAIL_WIDTH : listWidth
        const execSpan = execCollapsed ? RAIL_WIDTH : execWidth
        if (!(viewport > 0) || (listCollapsed && execCollapsed)) {
          return { list: listSpan, exec: execSpan }
        }
        const separators = (listCollapsed ? 0 : RESIZER_WIDTH) + (execCollapsed ? 0 : RESIZER_WIDTH)
        const room = viewport - MAIN_MIN - separators
        if (listCollapsed) {
          return { list: listSpan, exec: clamp(execWidth, EXEC_MIN, room - RAIL_WIDTH) }
        }
        if (execCollapsed) {
          return { list: clamp(listWidth, LIST_MIN, room - RAIL_WIDTH), exec: execSpan }
        }
        if (listWidth + execWidth <= room) return { list: listWidth, exec: execWidth }
        const spare = Math.max(0, room - LIST_MIN - EXEC_MIN)
        const excess = listWidth - LIST_MIN + (execWidth - EXEC_MIN)
        const scale = excess > 0 ? Math.min(1, spare / excess) : 0
        const list = LIST_MIN + Math.round((listWidth - LIST_MIN) * scale)
        return { list, exec: Math.max(EXEC_MIN, room - list) }
      }

      /**
       * The widest one side column may get without eating the conversation's
       * floor. This is the drag ceiling as well as the separator's
       * `aria-valuemax`, so a drag can never squeeze the conversation to zero.
       */
      const columnCeiling = (which) => {
        if (!(viewport > 0)) return 720
        const layout = columnLayout()
        const other = which === 'list' ? layout.exec : layout.list
        const separators = (listCollapsed ? 0 : RESIZER_WIDTH) + (execCollapsed ? 0 : RESIZER_WIDTH)
        const floor = which === 'list' ? LIST_MIN : EXEC_MIN
        return Math.max(floor, Math.round(viewport - MAIN_MIN - other - separators))
      }

      // The task context menu: `{ taskId, x, y }` in viewport coordinates.
      const [menu, setMenu] = useState(null)
      const menuRef = useRef(null)
      // Roving focus inside the open menu: the row index, and one ref per row.
      const [menuIndex, setMenuIndex] = useState(0)
      const menuItemRefs = useRef([])

      // Threads panel: the live search query, the folded groups and the groups
      // the filter hides. The folded set is a page-local preference, so it
      // persists like the column widths; the hidden set is per visit.
      const [query, setQuery] = useState('')
      const [collapsedGroups, setCollapsedGroups] = useState(readCollapsedGroups)
      const [searchOpen, setSearchOpen] = useState(false)
      const [filterOpen, setFilterOpen] = useState(false)
      const [hiddenGroups, setHiddenGroups] = useState({})
      const searchInputRef = useRef(null)
      const filterTrigger = useRef(null)
      const filterPanel = useRef(null)
      const filterItemRefs = useRef([])

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

      // Column preferences survive a reload. The choice itself is stored, never
      // the derived state, so a column that folded only because the window was
      // narrow opens again on a wide one.
      useEffect(() => {
        writeStored('listCollapsed', listChoice)
      }, [listChoice])
      useEffect(() => {
        writeStored('execCollapsed', execChoice)
      }, [execChoice])

      // A narrow window folds the side columns, so the page has to know its
      // width. The listener is the only reason the state exists; the layout
      // math reads the state, so one resize is one reflow.
      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const onResize = () => setViewport(viewportWidth())
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // Folded thread groups survive a reload too.
      useEffect(() => {
        writeStored('collapsedGroups', JSON.stringify(collapsedGroups))
      }, [collapsedGroups])

      // The Threads filter popover closes on an outside press, Escape, any
      // scroll and a resize, and Escape hands focus back to its trigger.
      useEffect(() => {
        if (!filterOpen || typeof window === 'undefined') return undefined
        const onPointerDown = (event) => {
          const panel = filterPanel.current
          if (panel && typeof panel.contains === 'function' && panel.contains(event.target)) return
          const trigger = filterTrigger.current
          if (trigger && typeof trigger.contains === 'function' && trigger.contains(event.target)) return
          setFilterOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          setFilterOpen(false)
          const trigger = filterTrigger.current
          if (trigger && typeof trigger.focus === 'function') trigger.focus()
        }
        const onScroll = () => setFilterOpen(false)
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
      }, [filterOpen])

      // Opening the filter arms its first row, the way the context menu does.
      useEffect(() => {
        if (!filterOpen) return
        const node = filterItemRefs.current[0]
        if (node && typeof node.focus === 'function') node.focus({ preventScroll: true })
      }, [filterOpen])

      // Expanding the search puts the caret in the field. Collapsing it clears
      // the query, so results never stay filtered by an invisible needle.
      useEffect(() => {
        if (!searchOpen) return
        const node = searchInputRef.current
        if (node && typeof node.focus === 'function') node.focus({ preventScroll: true })
      }, [searchOpen])

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

      // Opening the menu arms the first row; arrow keys move the roving focus
      // and the row's native activation handles Enter and Space.
      useEffect(() => {
        if (menu) setMenuIndex(0)
      }, [menu])

      useEffect(() => {
        if (!menu) return
        const node = menuItemRefs.current[menuIndex]
        if (node && typeof node.focus === 'function') node.focus({ preventScroll: true })
      }, [menu, menuIndex])

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
      // conversation when the project is selected. Opening it is also the only
      // way an existing Session can learn new rules — the start button is not
      // on screen while the conversation is open — so `ensure` appends the
      // update when the recorded fingerprint is stale, and the project records
      // the fingerprint it now has. `create: false` keeps a page load from
      // creating a Session: a stale id stays closed, and the start button
      // creates a fresh coordinator.
      useEffect(() => {
        const coordinatorId = detail?.project?.coordinatorSessionId
        if (!coordinatorId) {
          setThread((current) => (current ? null : current))
          return
        }
        if (!threadApi || typeof threadApi.ensure !== 'function') return undefined
        if (thread && thread.sessionId === coordinatorId) return undefined
        let cancelled = false
        const open = async () => {
          try {
            const archived = Array.isArray(archivedSessionIds) && archivedSessionIds.includes(coordinatorId)
            if (archived) await threadApi.restoreSession(coordinatorId)
            let locale = 'zh'
            try {
              locale = typeof getLocale === 'function' ? getLocale() : 'zh'
            } catch {
              locale = 'zh'
            }
            const current = detail?.project
            const result = await threadApi.ensure(current, coordinatorPrompt(current, locale), {
              locale,
              create: false,
            })
            if (!result) return
            if (cancelled) {
              try {
                result.reference.release()
              } catch {
                // Already released.
              }
            } else {
              setThread({ sessionId: result.sessionId, reference: result.reference })
              if (result.promptUpdated) setNotice(t('coordinatorRulesUpdated'))
            }
            // The message landed: record the fingerprint even when the page has
            // moved on, so the same update is never appended twice. The write
            // goes straight to the Host instead of through `refresh`, which
            // would pull this project back over the one the user selected.
            if (result.promptUpdated) {
              await api(`/projects/${current.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ coordinatorPromptHash: result.fingerprint }),
              })
            }
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

      // A different project resets the edit buffers, the executor pane, the
      // armed archive, the settings group and the Threads filter before they
      // are synced.
      useEffect(() => {
        goalDirtyRef.current = false
        memoryDirtyRef.current = false
        setGoalDirty(false)
        setMemoryDirty(false)
        setArchiveArmed(false)
        setFilterOpen(false)
        setHiddenGroups({})
        setMemoryPreview(null)
        setMemoryEditor(null)
        setMemoryDeleteArmed('')
        setSettingsGroup('general')
        setExecTarget((current) => (current ? null : current))
        setMenu(null)
      }, [detail?.project?.id])

      useEffect(() => {
        if (!detail) return
        if (!goalDirtyRef.current) setGoalText(detail.project?.goal || '')
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
      // The header's resolve control is a toggle over one status value: the
      // filled glyph and the "unresolve" label both mean `status === 'resolved'`.
      const execAccepted = execTask?.status === 'resolved'
      const execTitle = execTask?.title || execTarget?.title || ''
      // The detail header's one secondary line: the model and reasoning effort
      // a dispatch would use right now (task override, else project default,
      // else the host's own) and who runs it. The full routes and their sources
      // stay in the tooltip.
      const execEffective = execTask ? effectiveModel(project, execTask) : null
      const execSourceKey =
        execEffective?.source === 'task'
          ? 'fromTask'
          : execEffective?.source === 'project'
            ? 'fromProject'
            : 'fromHost'
      const execEffort = execTask ? effectiveEffort(project, execTask) : null
      const execEffortSourceKey =
        execEffort?.source === 'task'
          ? 'fromTask'
          : execEffort?.source === 'project'
            ? 'fromProject'
            : 'fromHost'
      const execEffortLabel = execEffort?.value
        ? effortLabel(catalog, execEffective?.value, execEffort.value, t)
        : ''
      const execMeta = execTask
        ? [
            execEffective.value ? modelLabel(catalog, execEffective.value) : t('fromHost'),
            execEffortLabel ? `${t('effortShort')}: ${execEffortLabel}` : '',
            execTask.childName || '',
          ]
            .filter(Boolean)
            .join(' · ')
        : ''
      const execMetaTitle = execTask
        ? [
            `${t('effectiveModel')}: ${
              execEffective.value ? `${execEffective.value} · ${t(execSourceKey)}` : t('fromHost')
            }`,
            `${t('reasoningEffort')}: ${
              execEffort.value ? `${execEffort.value} · ${t(execEffortSourceKey)}` : t('fromHost')
            }`,
          ].join('\n')
        : ''
      // The head's third row: the branch this task's worktree sits on, and — when
      // the Host could not isolate it — the reason, so a degraded dispatch is
      // never silent. Both are empty for a task that never asked for a worktree,
      // and the row is then not rendered at all.
      const execBranch = execTask ? String(execTask.branch || '').trim() : ''
      const execWorktreeNote = execTask ? worktreeNoteOf(execTask, t) : ''
      const execWorktreeTitle = execTask
        ? String(execTask.worktreePath || execTask.branch || '').trim()
        : ''

      // The new-project dialog starts from the Host's own defaults (two
      // workers, no folder), so the fields it does show are never blank.
      const BLANK_PROJECT = { name: '', goal: '', workspace: '', concurrency: 2 }

      const openNewProject = () => {
        setNewProject(BLANK_PROJECT)
        setShowNewProject(true)
      }

      const closeNewProject = () => {
        if (busy) return
        setShowNewProject(false)
        setNewProject(BLANK_PROJECT)
      }

      // Closing the editor drops the buffer and its dirty flag together: the
      // switch-project guard must not keep asking about a dialog that is gone.
      const closeMemoryEditor = () => {
        memoryDirtyRef.current = false
        setMemoryDirty(false)
        setMemoryEditor(null)
      }

      const openSettings = () => {
        setArchiveArmed(false)
        // The panel always opens on the first group, never on whatever group
        // the last visit ended on.
        setSettingsGroup('general')
        setMemoryPreview(null)
        closeMemoryEditor()
        setMemoryDeleteArmed('')
        setShowSettings(true)
      }

      // Closing the settings dialog closes whatever it opened on top: a memory
      // preview or the editor must not outlive the surface it belongs to.
      const closeSettings = () => {
        setArchiveArmed(false)
        setMemoryPreview(null)
        closeMemoryEditor()
        setMemoryDeleteArmed('')
        setSettingsGroup('general')
        setShowSettings(false)
      }

      // Switching groups only swaps the options column. The archive
      // confirmation, the armed memory delete and the two memory dialogs belong
      // to the group that opens them, so a switch disarms and closes them.
      const selectSettingsGroup = (group) => {
        setArchiveArmed(false)
        setMemoryPreview(null)
        closeMemoryEditor()
        setMemoryDeleteArmed('')
        setSettingsGroup(group)
      }

      // One POST carries every field the dialog collects. Autonomy is not one of
      // them: the Host's own default (manual) applies, and the coordinator can
      // still change it through `projects_update`. Concurrency is.
      const createProject = () =>
        run(async () => {
          if (!newProject.name.trim()) throw new Error(t('nameRequired'))
          const created = await api('/projects', {
            method: 'POST',
            body: JSON.stringify({
              name: newProject.name.trim(),
              goal: newProject.goal.trim(),
              workspace: newProject.workspace.trim(),
              concurrency: Number(newProject.concurrency) || 2,
            }),
          })
          setNewProject(BLANK_PROJECT)
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

      // The branch name is the one value on this page a human pastes into a
      // shell, so it gets its own copy control. A page without the async
      // clipboard API — or a denied permission — says so instead of reporting a
      // copy that never happened; the ref stays on screen either way.
      const copyBranch = (branch) =>
        run(async () => {
          const clipboard = globalThis.navigator && globalThis.navigator.clipboard
          if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error(t('copyFailed'))
          await clipboard.writeText(branch)
          return t('branchCopied')
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

      // One memory file, fetched by name: the project payload carries metadata
      // only. A stale answer for another file — or for a dialog that has since
      // closed — is dropped instead of overwriting what is on screen.
      const fetchMemoryFile = async (name) => {
        if (!projectId || !name) return null
        return api(`/projects/${projectId}/memory/${encodeURIComponent(name)}`)
      }

      // The preview is the file's own dialog: closing it also disarms its delete,
      // because the confirmation belongs to the dialog that opened it.
      const closeMemoryPreview = () => {
        setMemoryDeleteArmed('')
        setMemoryPreview(null)
      }

      const openMemoryPreview = (file) => {
        if (!file || !projectId) return
        setMemoryDeleteArmed('')
        setMemoryPreview({ ...file, text: '', loading: true, error: '' })
        void fetchMemoryFile(file.name)
          .then((data) => {
            if (!data) return
            setMemoryPreview((current) =>
              current && current.name === file.name
                ? {
                    ...current,
                    ...data,
                    // The Host's index description is an English fallback: the
                    // page's own wording is what the list and the dialog show.
                    description: current.description || data.description,
                    loading: false,
                    error: '',
                  }
                : current,
            )
          })
          .catch((failure) => {
            setMemoryPreview((current) =>
              current && current.name === file.name
                ? { ...current, loading: false, error: `${t('memoryLoadFailed')} ${messageOf(failure)}` }
                : current,
            )
          })
      }

      const openMemoryEditor = (file) => {
        if (!file || !projectId) return
        memoryDirtyRef.current = false
        setMemoryDirty(false)
        setMemoryDeleteArmed('')
        setMemoryEditor({
          ...file,
          description: file.description || '',
          type: file.type || '',
          text: '',
          loading: true,
          error: '',
        })
        void fetchMemoryFile(file.name)
          .then((data) => {
            if (!data) return
            setMemoryEditor((current) =>
              current && current.name === file.name
                ? { ...current, ...data, loading: false, error: '' }
                : current,
            )
          })
          .catch((failure) => {
            setMemoryEditor((current) =>
              current && current.name === file.name
                ? { ...current, loading: false, error: `${t('memoryLoadFailed')} ${messageOf(failure)}` }
                : current,
            )
          })
      }

      // The preview's edit action hands the same file to the editor. The preview
      // closes first, so saving cannot leave a stale body on screen behind it.
      const editPreviewFile = () => {
        const file = memoryPreview
        if (!file) return
        closeMemoryPreview()
        openMemoryEditor(file)
      }

      // The per-file editor saves that one file. `name` is required by the Host
      // (the old whole-memory `{ text }` save is a 400 now), and the description
      // and type are carried through so a body edit never drops the metadata.
      const saveMemory = () =>
        run(async () => {
          if (!projectId || !memoryEditor) return ''
          await api(`/projects/${projectId}/memory`, {
            method: 'POST',
            body: JSON.stringify({
              name: memoryEditor.name,
              description: memoryEditor.description || '',
              type: memoryEditor.type || '',
              text: memoryEditor.text,
            }),
          })
          closeMemoryEditor()
          await refresh(projectId)
          return t('saved')
        })

      // Deleting one file is destructive, so the preview arms it on the first
      // press and only the second one deletes. The Host deletes live files only,
      // which is why an archived file's actions are disabled. The generated
      // index has no delete path at all, so its preview never offers one.
      const deleteMemoryFile = (file) =>
        run(async () => {
          if (!projectId || !file || isMemoryIndex(file)) return ''
          if (memoryDeleteArmed !== file.name) {
            setMemoryDeleteArmed(file.name)
            return ''
          }
          setMemoryDeleteArmed('')
          await api(`/projects/${projectId}/memory/${encodeURIComponent(file.name)}`, { method: 'DELETE' })
          setMemoryPreview((current) => (current && current.name === file.name ? null : current))
          await refresh(projectId)
          return t('memoryDeleted')
        })

      // The Host's own directory chooser: the same dialog the workspace picker
      // uses, so a project folder is chosen rather than typed.
      const chooseNewProjectFolder = () =>
        run(async () => {
          const path = await pickFolder()
          if (path) setNewProject((current) => ({ ...current, workspace: path }))
          return ''
        })

      // The workspace is chosen, never typed: the picker writes the path and the
      // page shows it read-only.
      const chooseWorkspace = () =>
        run(async () => {
          const path = await pickFolder()
          if (!path) return ''
          await saveProjectPatch({ workspace: path })
          return t('saved')
        })

      const clearWorkspace = () =>
        run(async () => {
          await saveProjectPatch({ workspace: '' })
          return t('saved')
        })

      // Archiving hides the project from the list, so it is armed first and
      // only the second press archives. Unarchiving is not destructive and
      // stays a single press.
      const archiveProject = () =>
        run(async () => {
          if (!projectId || !project) return ''
          if (!project.archived && !archiveArmed) {
            setArchiveArmed(true)
            return ''
          }
          const archived = !project.archived
          setArchiveArmed(false)
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

      // `status` is the only task field the task PATCH accepts, and only two of
      // its values: `resolved` accepts the work, `review` takes that acceptance
      // back. Approval has its own narrow route below.
      const toggleResolved = (task) =>
        patchTask(task.id, { status: task.status === 'resolved' ? 'review' : 'resolved' })

      // Fold one authoritative task returned by the Host back into the board so
      // the badge flips without waiting for the next poll.
      const applyTask = (next) =>
        setDetail((current) => {
          if (!current || !current.project) return current
          const tasks = (current.project.tasks || []).map((task) => (task.id === next.id ? next : task))
          return { ...current, project: { ...current.project, tasks } }
        })

      // Approval is its own Host route (`POST .../tasks/:taskId/approve`, no
      // body, idempotent): the task PATCH rejects every field but `status`.
      const approveTask = (task) =>
        run(async () => {
          const data = await api(`/projects/${projectId}/tasks/${task.id}/approve`, { method: 'POST' })
          if (data && data.task) applyTask(data.task)
          return ''
        })

      // The Host deletes the task row; the executor session is a separate,
      // archive-only resource (`?session=archive`). DSH has no session delete at
      // all, so the page never asks for one and the archive action says so. A
      // failure leaves the task on the board: the refresh only runs after the
      // Host has answered 200.
      const deleteTask = (taskId, options) =>
        run(async () => {
          const archive = Boolean(options && options.archive)
          const query = archive ? '?session=archive' : ''
          let data
          try {
            data = await api(`/projects/${projectId}/tasks/${taskId}${query}`, { method: 'DELETE' })
          } catch (failure) {
            throw new Error(taskDeleteFailure(failure, t, archive))
          }
          if (execTarget && execTarget.taskId === taskId) setExecTarget(null)
          await refresh(projectId)
          // The Host answers `archived: false` when the session was already gone,
          // so the notice only claims an archive when one actually happened.
          const archived = Boolean(data && data.session && data.session.archived)
          return archive && archived ? t('deleteArchived') : t('deleted')
        })

      // -------------------------------------------------------------------
      // Layout interactions

      // A press writes the opposite of what is on screen, so pressing "expand"
      // on a column that folded itself also pins it open for this window size.
      const toggleListCollapsed = () => setListChoice(listCollapsed ? '0' : '1')
      const toggleExecCollapsed = () => setExecChoice(execCollapsed ? '0' : '1')

      // -------------------------------------------------------------------
      // Threads panel interactions

      const toggleGroup = (key) =>
        setCollapsedGroups((current) => ({ ...current, [key]: !current[key] }))

      const allGroupsCollapsed = THREAD_GROUPS.every((group) => collapsedGroups[group.key])

      // One row flips every group at once: collapse all when any is open,
      // expand all once everything is folded.
      const toggleAllGroups = () => {
        const next = {}
        for (const group of THREAD_GROUPS) next[group.key] = !allGroupsCollapsed
        setCollapsedGroups(next)
        setFilterOpen(false)
      }

      // A hidden group leaves the panel entirely; the filter row is its
      // checkbox, so the same press shows it again.
      const toggleGroupVisible = (key) =>
        setHiddenGroups((current) => ({ ...current, [key]: !current[key] }))

      const anyGroupHidden = THREAD_GROUPS.some((group) => hiddenGroups[group.key])

      const showAllGroups = () => {
        setHiddenGroups({})
        setFilterOpen(false)
      }

      // The search field is collapsed by default, so the panel head is two
      // glyphs. Collapsing the field drops the needle with it.
      const toggleSearch = () => {
        setSearchOpen((open) => {
          if (open) setQuery('')
          return !open
        })
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
          (goalDirtyRef.current || memoryDirtyRef.current) &&
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
      //
      // The drag starts from the width on screen (the fitted one, not the
      // stored one) and stops at `columnCeiling`, so no drag can take the
      // conversation below its floor.
      const startResize = (which, event) => {
        if (!event || (typeof event.button === 'number' && event.button !== 0)) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof window === 'undefined') return
        const startX = Number(event.clientX) || 0
        const layout = columnLayout()
        const from = which === 'list' ? layout.list : layout.exec
        const min = which === 'list' ? LIST_MIN : EXEC_MIN
        const max = columnCeiling(which)
        let latest = from
        const body = typeof document !== 'undefined' ? document.body : null
        const previousSelect = body ? body.style.userSelect : ''
        if (body) body.style.userSelect = 'none'
        setResizing(which)
        const onMove = (moveEvent) => {
          const delta = (Number(moveEvent.clientX) || 0) - startX
          // The executor column sits on the right, so dragging right narrows it.
          const raw = which === 'list' ? from + delta : from - delta
          latest = Math.round(clamp(raw, min, max))
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
        const layout = columnLayout()
        if (which === 'list') {
          const next = Math.round(clamp(layout.list + delta, LIST_MIN, columnCeiling('list')))
          setListWidth(next)
          writeStored('listWidth', next)
          return
        }
        const next = Math.round(clamp(layout.exec - delta, EXEC_MIN, columnCeiling('exec')))
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
            throw new Error(t('sessionUnavailable'))
          }
          let locale = 'zh'
          try {
            locale = typeof getLocale === 'function' ? getLocale() : 'zh'
          } catch {
            locale = 'zh'
          }
          const restored = coordinatorArchived && Boolean(project.coordinatorSessionId)
          if (restored) await threadApi.restoreSession(project.coordinatorSessionId)
          const result = await threadApi.ensure(project, coordinatorPrompt(project, locale), { locale })
          setThread({ sessionId: result.sessionId, reference: result.reference })
          const patch = {}
          if (result.created && result.sessionId !== project.coordinatorSessionId) {
            patch.coordinatorSessionId = result.sessionId
          }
          // Which rules this Session has seen. Recorded only after the message
          // landed, so a rejected append is retried on the next start instead of
          // being remembered as delivered.
          if (result.fingerprint && result.fingerprint !== project.coordinatorPromptHash) {
            patch.coordinatorPromptHash = result.fingerprint
          }
          if (Object.keys(patch).length > 0) await saveProjectPatch(patch)
          if (patch.coordinatorSessionId) return t('coordinatorCreated')
          if (result.promptUpdated) return t('coordinatorRulesUpdated')
          if (restored) return t('coordinatorRestored')
          return t('coordinatorResumed')
        })

      // A task row opens its detail pane. The executor conversation is embedded
      // underneath when the task already has a child Session. Opening a task is
      // a deliberate use of the Threads column, so the column opens with it
      // instead of staying folded out of sight.
      const openTaskDetail = (task) => {
        setExecChoice('0')
        return run(async () => {
          if (!task.childSessionId) {
            setExecTarget({ taskId: task.id, title: task.title, sessionId: '', reference: null })
            return ''
          }
          if (!threadApi || typeof threadApi.retainWorker !== 'function') {
            throw new Error(t('sessionUnavailable'))
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
      }

      // The board is published for the dispatch cards in the conversation, which
      // live in another React subtree. The poll replaces the project object every
      // 4s, so a card's status and time stay current without its own fetch.
      useEffect(() => {
        projectSnapshot.set(
          detail?.project ? { projectId: detail.project.id, project: detail.project } : null,
        )
      }, [detail])
      // Unmounting the page unbinds the cards: a click then does nothing instead
      // of driving a board that is no longer there.
      useEffect(() => () => projectSnapshot.set(null), [])

      // A dispatch card asks the board to open its task. When the request names
      // another project, switch to it first and open the task once its board
      // lands; when the project is gone, the request is dropped silently.
      const pendingOpenRef = useRef(null)
      useEffect(() => {
        return openTaskRequest.subscribe((request) => {
          if (!request) return
          if (request.projectId && request.projectId !== selectedRef.current) {
            if (!projects.some((entry) => entry && entry.id === request.projectId)) return
            pendingOpenRef.current = request
            selectedRef.current = request.projectId
            setSelectedId(request.projectId)
            void refresh(request.projectId).catch((failure) => setError(messageOf(failure)))
            return
          }
          const loaded = detail?.project?.id === request.projectId ? detail.project.tasks || [] : []
          const task = loaded.find((entry) => entry && entry.id === request.taskId)
          if (task) {
            void openTaskDetail(task)
            return
          }
          // The board for that project has not landed yet: open it when it does.
          if (detail?.project?.id !== request.projectId) pendingOpenRef.current = request
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [detail, projects])

      useEffect(() => {
        const pending = pendingOpenRef.current
        if (!pending || !detail?.project || detail.project.id !== pending.projectId) return
        const task = (detail.project.tasks || []).find((entry) => entry && entry.id === pending.taskId)
        if (!task) return
        pendingOpenRef.current = null
        void openTaskDetail(task)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [detail])

      const restoreCoordinator = () =>
        run(async () => {
          if (!project?.coordinatorSessionId || !threadApi) return ''
          await threadApi.restoreSession(project.coordinatorSessionId)
          return t('coordinatorRestored')
        })

      // The memory group's list reads the saved files, not the editor's buffer:
      // a row is a file the workers can actually read right now. The Host sends
      // metadata only, so a row's body is fetched when the row opens.
      const memoryFiles = memoryFilesOf(detail?.memory)

      // The settings rail: one cell per group, each with the Host's 16px glyph.
      // Two groups only. The general group carries every project setting —
      // including the threads' defaults and, at its very end, the archive
      // action — and the memory group owns the shared memory.
      const settingsGroups = [
        { id: 'general', label: t('general'), icon: h(GearIcon, { size: 16 }) },
        { id: 'memory', label: t('memory'), icon: h(MemoryIcon, { size: 16 }) },
      ]

      // The general group: the project's name, its instructions, the workspace,
      // the threads' defaults (how many run at once, their model and effort),
      // and the archive action last.
      const renderGeneralSettings = () =>
        h(
          'div',
          { className: 'pj-settings' },
          h(
            'div',
            { className: 'pj-section' },
            h('div', { className: 'pj-section-head' }, h('h2', { className: 'pj-section-title' }, t('project'))),
            h(
              'label',
              { className: 'pj-field' },
              h('span', { className: 'pj-label' }, t('projectName')),
              h('input', {
                className: 'pj-input',
                type: 'text',
                'aria-label': t('projectName'),
                defaultValue: project.name,
                // Re-key on the stored name so a refresh (or a project switch)
                // re-seeds the uncontrolled field without clobbering typing.
                key: `${project.id}:${project.name}`,
                disabled: busy,
                onBlur: (event) => {
                  const value = event.target.value.trim()
                  if (value && value !== project.name) void patchProject({ name: value })
                },
              }),
            ),
          ),
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
            h('div', { className: 'pj-section-head' }, h('h2', { className: 'pj-section-title' }, t('workspace'))),
            // The workspace is chosen, never typed: the picker writes the path
            // and this section only shows it. It is the only setting here — the
            // concurrency cap belongs to the threads, not to the folder.
            h(
              'div',
              { className: 'pj-row', style: { flexWrap: 'nowrap', gap: '8px' } },
              h(
                'div',
                {
                  className: `pj-path pj-grow${project.workspace ? '' : ' pj-path-empty'}`,
                  title: project.workspace || t('noWorkspace'),
                },
                h('span', { className: 'pj-path-text' }, project.workspace || t('noWorkspace')),
              ),
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
          // The threads' defaults, then the archive action at the very end.
          renderThreadsSection(),
          renderArchiveSection(),
        )

      // The threads section: how many threads this project runs at once, and
      // their default model and reasoning effort. All three are thread
      // settings, so they live together — the workspace section above owns the
      // folder only. The coordinator Session itself has no model or effort of
      // its own — it follows the host default — so there is no separate
      // Coordinator section.
      const renderThreadsSection = () =>
        h(
          'div',
          { className: 'pj-section' },
          h(
            'div',
            { className: 'pj-section-head' },
            h('h2', { className: 'pj-section-title' }, t('threads')),
          ),
          h('div', { className: 'pj-hint' }, t('threadsHint')),
          h(
            'div',
            { className: 'pj-row' },
            // The cap the Host enforces on this project's parallel threads. It
            // sits on its own line so the short hint stays beside the input
            // instead of pushing the two pickers onto a second row.
            h(
              'label',
              { className: 'pj-field' },
              h('span', { className: 'pj-label' }, t('concurrency')),
              h(
                'div',
                { className: 'pj-row', style: { flexWrap: 'nowrap', gap: '8px' } },
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
                h('span', { className: 'pj-hint' }, t('concurrencyHint')),
              ),
            ),
          ),
          h(
            'div',
            { className: 'pj-row' },
            h(
              'label',
              { className: 'pj-field pj-grow' },
              h('span', { className: 'pj-label' }, t('model')),
              catalog.enumerable
                ? h(
                    'span',
                    { className: 'pj-select-wrap' },
                    h(
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
                    ),
                    h('span', { className: 'pj-select-chevron', 'aria-hidden': true }, h(ChevronDownIcon, null)),
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
              h('span', { className: 'pj-label' }, t('reasoningEffort')),
              catalog.enumerable
                ? h(
                    'span',
                    { className: 'pj-select-wrap' },
                    h(
                      'select',
                      {
                        className: 'pj-select',
                        'aria-label': t('reasoningEffort'),
                        value: effortValue(project.reasoningEffort),
                        disabled: busy,
                        onChange: (event) =>
                          void patchProject({ reasoningEffort: event.target.value }),
                      },
                      h('option', { value: '' }, t('effortDefault')),
                      ...effortOptions(catalog, project.model, project.reasoningEffort, t),
                    ),
                    h('span', { className: 'pj-select-chevron', 'aria-hidden': true }, h(ChevronDownIcon, null)),
                  )
                : h('input', {
                    className: 'pj-input',
                    type: 'text',
                    'aria-label': t('reasoningEffort'),
                    placeholder: t('effortDefault'),
                    defaultValue: effortValue(project.reasoningEffort),
                    key: `${project.id}:${effortValue(project.reasoningEffort)}`,
                    disabled: busy,
                    onBlur: (event) => {
                      const value = event.target.value.trim()
                      if (value !== effortValue(project.reasoningEffort)) {
                        void patchProject({ reasoningEffort: value })
                      }
                    },
                  }),
              !catalog.enumerable && h('span', { className: 'pj-hint' }, t('effortFreeTextHint')),
            ),
          ),
          // Isolation is a thread setting too: it decides where each dispatched
          // thread runs, so it closes the section after the defaults. The Host
          // owns the git work (branch, checkout, cleanup); this only turns it on.
          h(
            'div',
            { className: 'pj-switch-row' },
            h(
              'div',
              { className: 'pj-switch-text' },
              h('span', { className: 'pj-label' }, t('worktreeIsolation')),
              h('span', { className: 'pj-hint' }, t('worktreeIsolationHint')),
            ),
            h(
              'button',
              {
                className: 'pj-switch',
                type: 'button',
                role: 'switch',
                'aria-checked': project.worktreeIsolation === true ? 'true' : 'false',
                'aria-label': t('worktreeIsolation'),
                disabled: busy,
                onClick: () =>
                  void patchProject({ worktreeIsolation: project.worktreeIsolation !== true }),
              },
              h('span', { className: 'pj-switch-thumb', 'aria-hidden': true }),
            ),
          ),
        )

      // The memory group: the file list, in the options column. A long memory
      // scrolls here instead of pushing the other groups out of the dialog.
      const renderMemorySettings = () =>
        h(
          'div',
          { className: 'pj-settings' },
          h(
            'div',
            { className: 'pj-section' },
            h(
              'div',
              { className: 'pj-section-head' },
              h('h2', { className: 'pj-section-title' }, t('memory')),
            ),
            h('div', { className: 'pj-hint' }, t('memoryHint')),
            h('div', { className: 'pj-memory-tally' }, memorySummary(detail?.memory, t)),
            renderMemoryList(),
          ),
        )

      // The archive section closes the general group: archiving hides the
      // project from the list, so the first press only arms it and the second
      // one acts; unarchiving is not destructive and stays a single press.
      const renderArchiveSection = () =>
        h(
          'div',
          { className: 'pj-section pj-danger-zone' },
          h(
            'div',
            { className: 'pj-section-head' },
            h('h2', { className: 'pj-section-title' }, t('archiveSection')),
          ),
          h('div', { className: 'pj-hint' }, t('archiveWarning')),
          h(
            'div',
            { className: 'pj-danger-actions' },
            project.archived
              ? h(
                  'button',
                  {
                    className: 'pj-btn',
                    type: 'button',
                    disabled: busy,
                    onClick: archiveProject,
                  },
                  t('unarchive'),
                )
              : archiveArmed
                ? [
                    h(
                      'button',
                      {
                        key: 'confirm',
                        className: 'pj-btn pj-btn-danger-fill',
                        type: 'button',
                        disabled: busy,
                        onClick: archiveProject,
                      },
                      t('archiveConfirm'),
                    ),
                    h(
                      'button',
                      {
                        key: 'cancel',
                        className: 'pj-btn pj-btn-ghost',
                        type: 'button',
                        disabled: busy,
                        onClick: () => setArchiveArmed(false),
                      },
                      t('cancel'),
                    ),
                  ]
                : h(
                    'button',
                    {
                      className: 'pj-btn pj-btn-danger',
                      type: 'button',
                      disabled: busy,
                      onClick: archiveProject,
                    },
                    h(ArchiveIcon, { size: 14 }),
                    t('archive'),
                  ),
          ),
        )

      // The active group's content. Only one group is mounted at a time, so
      // each group owns the whole options column and no group can push another
      // one out of view.
      const renderSettings = () => {
        if (settingsGroup === 'memory') return renderMemorySettings()
        return renderGeneralSettings()
      }

      // One browse-only row: the file's name, description, size and modified
      // date. It opens the file's preview, and nothing else — editing and
      // deleting are the preview's actions, so a hovered row has no buttons.
      const renderMemoryRow = (file) => {
        const isIndex = isMemoryIndex(file)
        return h(
          'div',
          {
            key: file.name,
            className: `pj-memory-row${isIndex ? ' pj-index' : ''}`,
          },
          h(
            'button',
            {
              className: 'pj-memory-open',
              type: 'button',
              title: file.description || file.name,
              'aria-haspopup': 'dialog',
              onClick: () => openMemoryPreview(file),
            },
            h(
              'span',
              { className: 'pj-memory-row-head' },
              h('span', { className: 'pj-memory-row-title' }, file.name),
              isIndex && h('span', { className: 'pj-badge' }, t('memoryIndex')),
              isIndex && h('span', { className: 'pj-badge' }, t('memoryReadOnly')),
            ),
            file.description && h('span', { className: 'pj-memory-row-desc' }, file.description),
            h('span', { className: 'pj-memory-row-meta' }, memoryMeta(file, t)),
          ),
        )
      }

      // The list: the generated index first, then one row per topic file. The
      // index is not a topic file — it is not counted in the tally, and its row
      // is read-only — so it is rendered from `memory.indexFile`, never from
      // `memory.files`, and only when the Host reports one.
      const renderMemoryList = () => {
        const indexFile = memoryIndexFileOf(detail?.memory)
        const rows = indexFile ? [memoryIndexRow(indexFile, t), ...memoryFiles] : memoryFiles
        return rows.length === 0
          ? h('div', { className: 'pj-hint' }, t('memoryEmpty'))
          : h('div', { className: 'pj-memory-list' }, rows.map(renderMemoryRow))
      }

      // The preview owns the file's two actions: editing opens the per-file
      // editor, deleting arms the same dialog and only the second press deletes.
      // The generated index has neither action, and an archived file is
      // read-only here, so its actions are disabled rather than hidden.
      const renderMemoryPreviewActions = () => {
        if (!memoryPreview || isMemoryIndex(memoryPreview)) return null
        const archived = memoryPreview.archived === true
        const armed = memoryDeleteArmed === memoryPreview.name
        if (armed) {
          return [
            h(
              'button',
              {
                key: 'confirm',
                className: 'pj-btn pj-btn-danger-fill pj-modal-action',
                type: 'button',
                disabled: busy,
                onClick: () => deleteMemoryFile(memoryPreview),
              },
              t('deleteConfirm'),
            ),
            h(
              'button',
              {
                key: 'cancel',
                className: 'pj-btn pj-btn-ghost pj-modal-action',
                type: 'button',
                disabled: busy,
                onClick: () => setMemoryDeleteArmed(''),
              },
              t('cancel'),
            ),
          ]
        }
        return [
          h(
            'button',
            {
              key: 'edit',
              className: 'pj-btn pj-modal-action',
              type: 'button',
              disabled: busy || archived || memoryPreview.loading,
              title: archived ? t('memoryArchivedHint') : t('memoryEditFile'),
              'aria-label': `${t('memoryEditFile')} ${memoryPreview.name}`,
              onClick: editPreviewFile,
            },
            t('memoryEditFile'),
          ),
          h(
            'button',
            {
              key: 'delete',
              className: 'pj-btn pj-btn-danger pj-modal-action',
              type: 'button',
              disabled: busy || archived || memoryPreview.loading,
              title: archived ? t('memoryArchivedHint') : t('memoryDeleteFile'),
              'aria-label': `${t('memoryDeleteFile')} ${memoryPreview.name}`,
              onClick: () => deleteMemoryFile(memoryPreview),
            },
            t('memoryDeleteFile'),
          ),
        ]
      }

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
            // The rail shows the same panel glyph, one step larger: the Host's
            // rail spec renders this control at 18 and the expanded one at 16.
            h(PanelLeftIcon, { size: 18 }),
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

      // The collapsed Threads column: the same 44px rail as the project list,
      // with the fold control and a tally so the strip still says something.
      const renderExecRail = () =>
        h(
          'div',
          { className: 'pj-rail' },
          h(
            'button',
            {
              className: 'pj-rail-btn',
              type: 'button',
              title: t('expandThreads'),
              'aria-label': t('expandThreads'),
              'aria-expanded': 'false',
              onClick: toggleExecCollapsed,
            },
            h(PanelRightIcon, { size: 18 }),
          ),
          taskList.length > 0 &&
            h(
              'span',
              { className: 'pj-rail-count', title: `${taskList.length} ${t('counts')}` },
              String(taskList.length),
            ),
        )

      // The row context menu. It is `position:fixed` (see `.pj-menu`) so the
      // list's `overflow:auto` cannot clip it; the open handler stores the
      // pointer position and the effect above clamps it into the viewport.
      // Rows carry a 14px icon seat and a hairline separator before the danger
      // action, and the arrow keys move focus between them.
      //
      // The delete action is two-stage. The second stage is a confirmation with
      // two explicit actions instead of a checkbox: a checked box is easy to
      // miss, and archiving the executor session has to be read before it is
      // chosen. Archiving is the only session operation DSH supports — it never
      // deletes a session — so the hint says what it does and does not do.
      const renderTaskMenu = () => {
        if (!menu) return null
        const task = taskList.find((entry) => entry.id === menu.taskId)
        if (!task) return null
        const confirming = confirmDeleteId === task.id
        // A task that never ran has no executor session, so there is nothing to
        // archive and the second stage offers a single action.
        const canArchive = Boolean(task.childSessionId)
        const armDelete = () => {
          setConfirmDeleteId(task.id)
          confirmDeleteAt.current = Date.now()
          setTimeout(() => {
            setConfirmDeleteId((current) => (current === task.id ? null : current))
          }, 3000)
        }
        // A double-click cannot confirm itself: the second press only counts
        // once the arm has settled, and a press that arrives too early re-arms.
        const settled = () => Date.now() - confirmDeleteAt.current > 600
        const confirmDelete = () => {
          if (!settled()) {
            confirmDeleteAt.current = Date.now()
            return
          }
          setConfirmDeleteId(null)
          setMenu(null)
          void deleteTask(task.id)
        }
        const confirmArchive = () => {
          if (!settled()) {
            confirmDeleteAt.current = Date.now()
            return
          }
          setConfirmDeleteId(null)
          setMenu(null)
          void deleteTask(task.id, { archive: true })
        }
        // `resolved` is a status value now, so the row's label and its filled
        // glyph both read the same field the PATCH writes.
        const accepted = task.status === 'resolved'
        const entries = [
          {
            key: 'resolve',
            icon: h(ResolveIcon, { done: accepted }),
            label: accepted ? t('unresolve') : t('resolve'),
            onSelect: () => {
              setMenu(null)
              void toggleResolved(task)
            },
          },
          { key: 'separator', separator: true },
          ...(confirming
            ? [
                { key: 'confirm', caption: t('deleteConfirm') },
                {
                  key: 'delete',
                  danger: true,
                  icon: h(TrashIcon, null),
                  label: t('deleteOnlyTask'),
                  hint: t('deleteOnlyTaskHint'),
                  describedBy: 'pj-delete-only-hint',
                  onSelect: confirmDelete,
                },
                ...(canArchive
                  ? [
                      {
                        key: 'archive',
                        icon: h(ArchiveIcon, null),
                        label: t('deleteAndArchive'),
                        hint: t('archiveSessionHint'),
                        title: t('archiveSessionTitle'),
                        describedBy: 'pj-archive-session-hint',
                        onSelect: confirmArchive,
                      },
                    ]
                  : []),
              ]
            : [
                {
                  key: 'delete',
                  danger: true,
                  icon: h(TrashIcon, null),
                  label: t('delete'),
                  onSelect: armDelete,
                },
              ]),
        ]
        let row = -1
        const rows = entries.map((entry) =>
          entry.separator || entry.caption ? entry : { ...entry, index: (row += 1) },
        )
        const count = row + 1
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
            onKeyDown: (event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setMenuIndex((current) => (current + 1) % count)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setMenuIndex((current) => (current - 1 + count) % count)
              } else if (event.key === 'Home') {
                event.preventDefault()
                setMenuIndex(0)
              } else if (event.key === 'End') {
                event.preventDefault()
                setMenuIndex(count - 1)
              }
            },
          },
          ...rows.map((entry) =>
            entry.separator
              ? h('div', { key: entry.key, className: 'pj-menu-separator', role: 'separator' })
              : entry.caption
                ? h('div', { key: entry.key, className: 'pj-menu-caption', role: 'presentation' }, entry.caption)
                : h(
                    'button',
                    {
                      key: entry.key,
                      ref: (node) => {
                        menuItemRefs.current[entry.index] = node
                      },
                      className: `pj-menu-item${entry.danger ? ' pj-danger' : ''}`,
                      type: 'button',
                      role: 'menuitem',
                      tabIndex: -1,
                      title: entry.title,
                      // The hint is the description, not part of the name: a
                      // screen reader announces the action, then why.
                      'aria-label': entry.hint ? entry.label : undefined,
                      'aria-describedby': entry.describedBy,
                      disabled: busy,
                      onMouseEnter: () => setMenuIndex(entry.index),
                      onClick: entry.onSelect,
                    },
                  h('span', { className: 'pj-menu-icon', 'aria-hidden': true }, entry.icon),
                  // A row with a hint gets a two-line text column: the action,
                  // then the honest one-liner under it.
                  entry.hint
                    ? h(
                        'span',
                        { className: 'pj-menu-text' },
                        h('span', { className: 'pj-menu-label' }, entry.label),
                        h('span', { className: 'pj-menu-hint', id: entry.describedBy }, entry.hint),
                      )
                    : h('span', { className: 'pj-menu-label' }, entry.label),
                ),
          ),
        )
      }

      // One thread card: the group glyph in the gutter, then the title line with
      // its relative time, a one-line summary and up to two chips. The card is
      // the only button — every action lives in the context menu.
      const renderTask = (task) => {
        const chips = taskChips(task)
        const stamp = relativeTime(task, t, activeLocale())
        return h(
          'button',
          {
            className: `pj-task-row${execTarget && execTarget.taskId === task.id ? ' pj-active' : ''}`,
            type: 'button',
            disabled: busy,
            title: `${task.title || ''}\n${taskSubtitle(task, t)}`,
            onClick: () => openTaskDetail(task),
            onContextMenu: (event) => openTaskMenu(event, task),
          },
          h(ThreadIcon, { kind: threadIconOf(task) }),
          h('span', { className: 'pj-task-name' }, task.title || ''),
          stamp && h('span', { className: 'pj-thread-time' }, stamp),
          h('span', { className: 'pj-thread-sub' }, taskSubtitle(task, t)),
          chips.length > 0 &&
            h('span', { className: 'pj-thread-chips' }, chips.map(chipElement)),
        )
      }

      // A group header folds its cards and carries the count; the whole header
      // is the toggle, so the chevron is decorative.
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

      // The group filter popover. One checkbox row per group, then a hairline
      // and the fold-all action, then a reset while anything is hidden. Rows are
      // `menuitemcheckbox`, so the shown/hidden state is announced; the drawn
      // check stands in for a native checkbox, which would not match the Host's
      // menu rows. Arrow keys rove between the rows, and Escape (handled by the
      // effect above) closes the popover and returns focus to the trigger.
      const renderFilterMenu = () => {
        if (!filterOpen) return null
        filterItemRefs.current = []
        let seat = 0
        const row = (options) => {
          const index = seat
          seat += 1
          return h(
            'button',
            {
              key: options.key,
              ref: (node) => {
                filterItemRefs.current[index] = node
              },
              className: 'pj-menu-item',
              type: 'button',
              role: options.role,
              tabIndex: -1,
              'aria-checked': options.checked === undefined ? undefined : options.checked,
              onClick: options.onSelect,
            },
            h(
              'span',
              { className: 'pj-filter-check', 'aria-hidden': true },
              options.checked ? h(CheckIcon, null) : null,
            ),
            h('span', { className: 'pj-menu-label' }, options.label),
          )
        }
        return h(
          'div',
          {
            className: 'pj-filter-menu',
            role: 'menu',
            'aria-label': t('filterGroups'),
            ref: filterPanel,
            onKeyDown: (event) => {
              const items = filterItemRefs.current.filter(Boolean)
              if (!items.length) return
              const at = items.indexOf(event.target)
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                items[(at + 1) % items.length].focus()
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                items[(at - 1 + items.length) % items.length].focus()
              } else if (event.key === 'Home') {
                event.preventDefault()
                items[0].focus()
              } else if (event.key === 'End') {
                event.preventDefault()
                items[items.length - 1].focus()
              }
            },
          },
          ...THREAD_GROUPS.map((group) =>
            row({
              key: group.key,
              role: 'menuitemcheckbox',
              checked: !hiddenGroups[group.key],
              label: t(group.titleKey),
              onSelect: () => toggleGroupVisible(group.key),
            }),
          ),
          h('div', { key: 'separator', className: 'pj-menu-separator', role: 'separator' }),
          row({
            key: 'fold',
            role: 'menuitem',
            label: allGroupsCollapsed ? t('expandAll') : t('collapseAll'),
            onSelect: toggleAllGroups,
          }),
          anyGroupHidden
            ? row({
                key: 'all',
                role: 'menuitem',
                label: t('showAllGroups'),
                onSelect: showAllGroups,
              })
            : null,
        )
      }

      // The detail page is a conversation, not a form. Its body is exactly the
      // executor's own Session, rendered by the same Chat view the main
      // conversation uses, so `ui-chat`'s transcriptView / collapseTiming /
      // foldedReplies already apply here unchanged — the page must not draw its
      // own transcript. The task brief is deliberately not repeated above the
      // conversation: the coordinator already pasted it into the worker's
      // prompt, so the Session's first message is the brief, rendered properly.
      // State, resolve and approval live in the column header; deletion lives
      // in the row menu.
      const renderTaskDetail = () =>
        h(
          'div',
          { className: 'pj-exec-detail' },
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

      // Five fixed groups, in reference order: each one is a slice of the status
      // enum, so a task lands in exactly one and `resolved` is simply its last
      // bucket. The search box filters on the title and the one-line summary
      // before the bucketing happens.
      const needle = query.trim().toLowerCase()
      const visibleTasks = needle
        ? taskList.filter((task) =>
            `${task.title || ''} ${taskSubtitle(task, t)}`.toLowerCase().includes(needle),
          )
        : taskList
      const groups = threadGroups(visibleTasks)
      // A group the filter hides leaves the panel entirely; when every group is
      // hidden or empty the panel says so instead of going blank.
      const shownGroups = groups.filter(
        (group) => group.tasks.length > 0 && !hiddenGroups[group.key],
      )

      // The widths actually painted, after the conversation's floor has taken
      // what it needs. Both the columns and their separators read this, so the
      // ARIA values describe the layout on screen rather than the preference.
      const layout = columnLayout()

      return h(
        'div',
        { className: `pj-page${resizing ? ' pj-resizing' : ''}` },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'aside',
          {
            className: `pj-list${listCollapsed ? ' pj-collapsed' : ''}`,
            style: listCollapsed ? undefined : { flexBasis: `${layout.list}px`, width: `${layout.list}px` },
          },
          listCollapsed
            ? renderListRail()
            : [
                h(
                  'div',
                  // The three column heads are the page's top strip. The Host's
                  // window-region convention (`data-window-drag`, the same
                  // attribute its own page heads and sidebar rows carry) makes
                  // the blank part of each one drag the macOS window; the glyph
                  // buttons inside are excluded by the Host's own stylesheet, so
                  // they still click. Nothing here sets `-webkit-app-region`
                  // itself: that is the frame's job, not a plugin's.
                  { className: 'pj-list-head', 'data-window-drag': true },
                  h('span', { className: 'pj-list-title' }, t('projects')),
                  h(
                    'div',
                    { className: 'pj-actions' },
                    // Both header controls are glyphs, the way the Host's own
                    // sidebar head is: create, then collapse at the right edge.
                    h(
                      'button',
                      {
                        className: 'pj-icon-btn',
                        type: 'button',
                        ref: newProjectTrigger,
                        title: t('newProject'),
                        'aria-label': t('newProject'),
                        'aria-haspopup': 'dialog',
                        'aria-expanded': showNewProject ? 'true' : 'false',
                        onClick: openNewProject,
                        disabled: busy,
                      },
                      h(PlusIcon, { size: 16 }),
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
                      h(PanelLeftIcon, { size: 16 }),
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
                              onClick: openNewProject,
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
              'aria-valuenow': layout.list,
              'aria-valuemin': LIST_MIN,
              'aria-valuemax': columnCeiling('list'),
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
            // Draggable window strip, like the Host's own conversation and
            // plugin-page heads; the gear inside stays a no-drag control.
            { className: 'pj-main-head', 'data-window-drag': true },
            h(
              'div',
              { className: 'pj-main-title' },
              h('h1', { className: 'pj-title' }, project ? project.name : t('title')),
              project?.archived && h('span', { className: 'pj-badge' }, t('archivedBadge')),
            ),
            // One glyph replaces the old tab row: the column always shows the
            // conversation, and settings (with the archive action at the end of
            // its general group) is a dialog behind this gear.
            project &&
              h(
                'div',
                { className: 'pj-actions' },
                h(
                  'button',
                  {
                    className: 'pj-icon-btn',
                    type: 'button',
                    ref: settingsTrigger,
                    title: t('settings'),
                    'aria-label': t('settings'),
                    'aria-haspopup': 'dialog',
                    'aria-expanded': showSettings ? 'true' : 'false',
                    onClick: openSettings,
                  },
                  h(GearIcon, { size: 16 }),
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
        execCollapsed
          ? null
          : h('div', {
              className: 'pj-resizer',
              role: 'separator',
              'aria-orientation': 'vertical',
              'aria-label': t('resizeColumns'),
              'aria-valuenow': layout.exec,
              'aria-valuemin': EXEC_MIN,
              'aria-valuemax': columnCeiling('exec'),
              tabIndex: 0,
              title: t('resizeColumns'),
              onPointerDown: (event) => startResize('exec', event),
              onKeyDown: (event) => nudgeWidth('exec', event),
            }),
        h(
          'aside',
          {
            className: `pj-exec${execCollapsed ? ' pj-collapsed' : ''}`,
            style: execCollapsed
              ? undefined
              : { flexBasis: `${layout.exec}px`, width: `${layout.exec}px` },
          },
          execCollapsed
            ? renderExecRail()
            : [
                h(
                  'header',
                  // The Threads head closes the page's top strip: same drag region as
                  // the other two heads, with its glyphs excluded by the Host.
                  { className: 'pj-exec-head', 'data-window-drag': true },
                  execTarget
                    ? h(
                        'div',
                        { className: 'pj-detail-head' },
                        h(
                          'div',
                          { className: 'pj-detail-row' },
                          h(
                            'button',
                            { className: 'pj-btn pj-btn-ghost', type: 'button', onClick: () => setExecTarget(null) },
                            `← ${t('threads')}`,
                          ),
                          h('span', { className: 'pj-exec-task', title: execTitle }, shortTitle(execTitle)),
                          h('span', { className: 'pj-spacer' }),
                          execTask && h(StatusPill, { status: execTask.status, t }),
                          execTask &&
                            h(
                              'button',
                              {
                                className: `pj-icon-btn${execAccepted ? ' pj-on' : ''}`,
                                type: 'button',
                                disabled: busy,
                                title: execAccepted ? t('unresolve') : t('resolve'),
                                'aria-label': execAccepted ? t('unresolve') : t('resolve'),
                                'aria-pressed': execAccepted ? 'true' : 'false',
                                onClick: () => void toggleResolved(execTask),
                              },
                              h(ResolveIcon, { done: execAccepted }),
                            ),
                          execTask &&
                            project &&
                            project.autonomy === 'manual' &&
                            !execTask.approved &&
                            execTask.status !== 'running' &&
                            h(
                              'button',
                              {
                                className: 'pj-btn',
                                type: 'button',
                                disabled: busy || project.archived,
                                onClick: () => void approveTask(execTask),
                              },
                              t('approve'),
                            ),
                        ),
                        (execTask || execTarget.sessionId) &&
                          h(
                            'div',
                            { className: 'pj-detail-meta' },
                            execMeta &&
                              h('span', { className: 'pj-detail-meta-text', title: execMetaTitle }, execMeta),
                            execTask?.approved && h('span', { className: 'pj-badge' }, t('approvedBadge')),
                            execAccepted && h('span', { className: 'pj-badge' }, t('resolvedBadge')),
                          ),
                        (execBranch || execWorktreeNote) &&
                          h(
                            'div',
                            { className: 'pj-detail-worktree' },
                            execBranch &&
                              h(
                                'span',
                                { className: 'pj-worktree-branch' },
                                h(BranchIcon, { size: 12 }),
                                h(
                                  'code',
                                  { className: 'pj-worktree-branch-name', title: execWorktreeTitle },
                                  execBranch,
                                ),
                                h(
                                  'button',
                                  {
                                    className: 'pj-icon-btn pj-icon-btn-xs',
                                    type: 'button',
                                    title: t('copyBranch'),
                                    'aria-label': t('copyBranch'),
                                    onClick: () => void copyBranch(execBranch),
                                  },
                                  h(CopyIcon, { size: 12 }),
                                ),
                              ),
                            execWorktreeNote &&
                              h(
                                'span',
                                { className: 'pj-worktree-note', title: execWorktreeNote },
                                execWorktreeNote,
                              ),
                          ),
                      )
                    : h('h2', { className: 'pj-exec-title' }, t('threads')),
                  // The head's right edge is glyphs, and only on the list view:
                  // the search and the group filter on the panel, and the fold
                  // control, so the column can always be put away from the list.
                  // The detail page is a reading surface whose back control is
                  // the only way out, so it carries no glyph cluster at all. The
                  // 4s poll keeps the cards current, so there is no refresh
                  // control to press.
                  execTarget
                    ? null
                    : h(
                        'div',
                        { className: 'pj-actions' },
                        !project
                          ? null
                          : [
                              h(
                                'button',
                                {
                                  key: 'search',
                                  className: `pj-icon-btn${searchOpen ? ' pj-active' : ''}`,
                                  type: 'button',
                                  title: t('searchThreads'),
                                  'aria-label': t('searchThreads'),
                                  'aria-expanded': searchOpen ? 'true' : 'false',
                                  onClick: toggleSearch,
                                },
                                h(SearchIcon, { size: 16 }),
                              ),
                              h(
                                'div',
                                { key: 'filter', className: 'pj-filter' },
                                h(
                                  'button',
                                  {
                                    className: `pj-icon-btn${anyGroupHidden ? ' pj-active' : ''}`,
                                    type: 'button',
                                    ref: filterTrigger,
                                    title: t('filterThreads'),
                                    'aria-label': t('filterThreads'),
                                    'aria-haspopup': 'menu',
                                    'aria-expanded': filterOpen ? 'true' : 'false',
                                    onClick: () => setFilterOpen((open) => !open),
                                  },
                                  h(FilterIcon, { size: 16 }),
                                ),
                                renderFilterMenu(),
                              ),
                            ],
                        // The mirror of the project column's fold control: same
                        // 28px seat, same glyph weight, the panel on the other
                        // side.
                        h(
                          'button',
                          {
                            className: 'pj-icon-btn',
                            type: 'button',
                            title: t('collapseThreads'),
                            'aria-label': t('collapseThreads'),
                            'aria-expanded': 'true',
                            onClick: toggleExecCollapsed,
                          },
                          h(PanelRightIcon, { size: 16 }),
                        ),
                      ),
                ),
                // The search field unfolds under the head; the filter popover carries
                // the fold-all action, so neither needs a row of its own.
                !execTarget && project && searchOpen
                  ? h(
                      'div',
                      { className: 'pj-exec-tools' },
                      h(
                        'div',
                        { className: 'pj-search' },
                        h('span', { className: 'pj-search-icon', 'aria-hidden': true }, h(SearchIcon, null)),
                        h('input', {
                          ref: searchInputRef,
                          type: 'search',
                          value: query,
                          placeholder: t('searchThreads'),
                          'aria-label': t('searchThreads'),
                          onChange: (event) => setQuery(event.target.value),
                        }),
                      ),
                    )
                  : null,
                !project
                  ? null
                  : execTarget
                    ? execTask
                      ? renderTaskDetail()
                      : h('div', { className: 'pj-empty' }, t('noTask'))
                    : h(
                        'div',
                        { className: 'pj-exec-scroll' },
                        taskList.length === 0
                          ? h('div', { className: 'pj-empty' }, t('emptyTasks'))
                          : shownGroups.length === 0
                            ? h('div', { className: 'pj-empty' }, t('noMatches'))
                            : shownGroups.map(renderThreadGroup),
                      ),
            ],
        ),
        renderTaskMenu(),
        // Both project-level surfaces are dialogs, rendered last so they paint
        // over every column. Each is unmounted while closed, so neither holds
        // focus or a scroll lock.
        h(Modal, {
          open: showNewProject,
          titleId: 'pj-new-project-title',
          title: t('newProject'),
          closeLabel: t('close'),
          onClose: closeNewProject,
          returnFocusRef: newProjectTrigger,
          className: 'pj-modal-form',
          footer: [
            h(
              'button',
              {
                key: 'cancel',
                className: 'pj-btn pj-modal-action',
                type: 'button',
                disabled: busy,
                onClick: closeNewProject,
              },
              t('cancel'),
            ),
            h(
              'button',
              {
                key: 'create',
                className: 'pj-btn pj-btn-primary pj-modal-action',
                type: 'button',
                disabled: busy,
                onClick: createProject,
              },
              t('create'),
            ),
          ],
          children: [
            error && h('div', { key: 'error', className: 'pj-error', role: 'alert' }, `${t('error')}: ${error}`),
            h(
              'label',
              { key: 'name', className: 'pj-field' },
              h('span', { className: 'pj-label' }, t('projectName')),
              h('input', {
                className: 'pj-input',
                'aria-label': t('projectName'),
                placeholder: t('projectName'),
                value: newProject.name,
                'data-pj-modal-autofocus': '',
                onChange: (event) => setNewProject({ ...newProject, name: event.target.value }),
              }),
            ),
            h(
              'label',
              { key: 'goal', className: 'pj-field' },
              h('span', { className: 'pj-label' }, t('instructions')),
              h('textarea', {
                className: 'pj-textarea',
                style: { minHeight: '72px' },
                'aria-label': t('instructions'),
                placeholder: t('instructionsPlaceholder'),
                value: newProject.goal,
                onChange: (event) => setNewProject({ ...newProject, goal: event.target.value }),
              }),
            ),
            h(
              'div',
              { key: 'workspace', className: 'pj-field' },
              h('span', { className: 'pj-label' }, t('workspace')),
              // A folder is chosen, not typed: the picker is the only input and
              // the chosen path is shown read-only beside it.
              h(
                'div',
                { className: 'pj-row', style: { flexWrap: 'nowrap', gap: '8px' } },
                h(
                  'div',
                  {
                    className: `pj-path pj-grow${newProject.workspace ? '' : ' pj-path-empty'}`,
                    title: newProject.workspace || t('noWorkspace'),
                  },
                  h('span', { className: 'pj-path-text' }, newProject.workspace || t('noWorkspace')),
                ),
                h(
                  'button',
                  { className: 'pj-btn', type: 'button', disabled: busy, onClick: chooseNewProjectFolder },
                  t('chooseFolderShort'),
                ),
              ),
            ),
            h(
              'div',
              { key: 'concurrency', className: 'pj-row' },
              h(
                'label',
                { className: 'pj-field' },
                h('span', { className: 'pj-label' }, t('concurrency')),
                h(
                  'div',
                  { className: 'pj-row', style: { flexWrap: 'nowrap', gap: '8px' } },
                  h('input', {
                    className: 'pj-input',
                    'aria-label': t('concurrency'),
                    type: 'number',
                    min: 1,
                    max: 8,
                    value: newProject.concurrency,
                    disabled: busy,
                    style: { width: '88px' },
                    onChange: (event) =>
                      setNewProject({ ...newProject, concurrency: event.target.value }),
                  }),
                  h('span', { className: 'pj-hint' }, t('concurrencyHint')),
                ),
              ),
            ),
          ],
        }),
        h(Modal, {
          open: showSettings,
          titleId: 'pj-settings-title',
          title: t('settings'),
          closeLabel: t('close'),
          onClose: closeSettings,
          // The armed archive is a destructive confirmation, so the mask stops
          // dismissing the dialog until it is cancelled or confirmed.
          maskClose: !archiveArmed,
          returnFocusRef: settingsTrigger,
          // The Host settings panel: a navigation rail on the left, the active
          // group in the scrolling options column on the right. Switching
          // groups swaps the column; it never closes the dialog.
          nav: {
            label: t('settingsNav'),
            active: settingsGroup,
            onSelect: selectSettingsGroup,
            items: settingsGroups,
          },
          children: project
            ? [
                error &&
                  h('div', { key: 'error', className: 'pj-error', role: 'alert' }, `${t('error')}: ${error}`),
                notice && h('div', { key: 'notice', className: 'pj-notice', role: 'status' }, notice),
                renderSettings(),
              ]
            : null,
        }),
        // One memory file opens as a read-only preview on top of the settings
        // panel; the same file opens in an editor from that preview. Both are
        // dialogs, so each surface keeps one scroll source, and Escape closes
        // only the top one (see `MODAL_LAYERS`).
        h(Modal, {
          open: Boolean(memoryPreview),
          titleId: 'pj-memory-preview-title',
          title: memoryPreview ? memoryPreview.name : t('memory'),
          closeLabel: t('close'),
          onClose: closeMemoryPreview,
          className: 'pj-modal-wide',
          footer: memoryPreview ? renderMemoryPreviewActions() : null,
          children: memoryPreview
            ? [
                h(
                  'div',
                  { key: 'meta', className: 'pj-memory-preview-meta' },
                  h('span', { className: 'pj-memory-row-meta' }, memoryMeta(memoryPreview, t)),
                  memoryPreview.stale && h('span', { className: 'pj-badge' }, t('memoryStale')),
                  memoryPreview.archived && h('span', { className: 'pj-badge' }, t('memoryArchived')),
                  isMemoryIndex(memoryPreview) &&
                    h('span', { className: 'pj-badge' }, t('memoryReadOnly')),
                ),
                memoryPreview.description &&
                  h('div', { key: 'desc', className: 'pj-memory-preview-desc' }, memoryPreview.description),
                isMemoryIndex(memoryPreview) &&
                  h('div', { key: 'index', className: 'pj-hint' }, t('memoryIndexHint')),
                memoryPreview.archived &&
                  h('div', { key: 'archived', className: 'pj-hint' }, t('memoryArchivedHint')),
                memoryPreview.loading
                  ? h('div', { key: 'loading', className: 'pj-hint' }, t('memoryLoading'))
                  : memoryPreview.error
                    ? h('div', { key: 'error', className: 'pj-memory-error' }, memoryPreview.error)
                    : h('div', { key: 'body', className: 'pj-memory-body' }, memoryPreview.text),
              ]
            : null,
        }),
        h(Modal, {
          open: Boolean(memoryEditor),
          titleId: 'pj-memory-editor-title',
          title: memoryEditor ? memoryEditor.name : t('memory'),
          closeLabel: t('close'),
          onClose: closeMemoryEditor,
          className: 'pj-modal-form',
          footer: [
            h(
              'button',
              {
                key: 'cancel',
                className: 'pj-btn pj-modal-action',
                type: 'button',
                disabled: busy,
                onClick: closeMemoryEditor,
              },
              t('cancel'),
            ),
            h(
              'button',
              {
                key: 'save',
                className: 'pj-btn pj-btn-primary pj-modal-action',
                type: 'button',
                disabled: busy || !memoryDirty || Boolean(memoryEditor && memoryEditor.loading),
                onClick: saveMemory,
              },
              t('save'),
            ),
          ],
          children: memoryEditor
            ? [
                h('div', { key: 'hint', className: 'pj-hint' }, t('memoryHint')),
                h(
                  'div',
                  { key: 'meta', className: 'pj-memory-preview-meta' },
                  h('span', { className: 'pj-memory-row-meta' }, memoryMeta(memoryEditor, t)),
                  memoryEditor.archived && h('span', { className: 'pj-badge' }, t('memoryArchived')),
                ),
                memoryEditor.error &&
                  h('div', { key: 'error', className: 'pj-memory-error' }, memoryEditor.error),
                h('textarea', {
                  key: 'text',
                  className: 'pj-textarea',
                  style: { minHeight: '260px' },
                  'aria-label': t('memoryBody'),
                  placeholder: t('memoryPlaceholder'),
                  value: memoryEditor.loading ? '' : memoryEditor.text,
                  disabled: busy,
                  'data-pj-modal-autofocus': '',
                  onChange: (event) => {
                    // A body that is still loading must not be typed over: the
                    // fetched text would land on top of the first keystroke.
                    if (memoryEditor.loading) return
                    memoryDirtyRef.current = true
                    setMemoryDirty(true)
                    setMemoryEditor((current) =>
                      current ? { ...current, text: event.target.value } : current,
                    )
                  },
                }),
              ]
            : null,
        }),
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
            throw new Error(translate('pickerUnavailable'))
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
          async ensure(project, prompt, options = {}) {
            const sessions = ctx.get('sessions')
            if (!sessions || typeof sessions.create !== 'function') {
              throw new Error(translate('sessionUnavailable'))
            }
            const fingerprint = coordinatorPromptFingerprint(project, options.locale)
            const stored =
              typeof project.coordinatorPromptHash === 'string' ? project.coordinatorPromptHash : ''
            const existing = typeof project.coordinatorSessionId === 'string' ? project.coordinatorSessionId : ''
            let sessionId = existing
            let created = false
            let promptUpdated = false
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
              // The caller asked for an existing Session only (the page's
              // auto-open path): a stale id reports "nothing to open" instead of
              // creating one behind the user's back.
              if (options.create === false) return null
              sessionId = await sessions.create(project.workspace ? { cwd: project.workspace } : {})
              created = true
              reference = sessions.retain(sessionId, { source: 'projects' })
              await reference.ready
            }
            // The prompt is sent once, when the Session is created. An existing
            // Session keeps the rules it was born with, so a plugin upgrade would
            // never reach it; when the recorded fingerprint differs from the
            // current rules, append an update message instead of doing nothing.
            // The same fingerprint sends nothing, so a board change never
            // re-sends the rules.
            if (created || stored !== fingerprint) {
              const message = created ? prompt : coordinatorUpdatePrompt(prompt, fingerprint, options.locale)
              const result = await reference.binding.session.prompt([{ type: 'text', text: message }], 'queue')
              if (!result || result.ok !== true) {
                reference.release()
                throw new Error(
                  (result && result.error && result.error.message) || translate('promptRejected'),
                )
              }
              promptUpdated = !created
            }
            return { sessionId, reference, created, promptUpdated, fingerprint }
          },
          retainWorker(childSessionId, parentSessionId) {
            const sessions = ctx.get('sessions')
            if (!sessions || typeof sessions.retain !== 'function') {
              throw new Error(translate('sessionUnavailable'))
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
        // A dispatch call renders as a compact card in the conversation itself,
        // so the subtask appears the moment the coordinator dispatches it rather
        // than only when its final message lands. `translate` and `activeLocale`
        // are injected because the card reads the active locale at call time.
        //
        // `tool.call.toolview` is declared by `@deepseek-ai/dsh-client-ui-tool`
        // (the `tool-call` entry of `conversation.chat.node`), which may activate
        // after this plugin. That is safe: `ctx.slots.inject` keeps the callback
        // until the declaration exists and re-runs it on every declaration
        // lifetime, so the entry installs whenever the owner mounts. No `locale`
        // namespace is declared here — the card renders through its own injected
        // `translate`, so it never depends on the host locale face.
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            {
              name: 'tool.call.toolview',
              key: 'projects_dispatch',
              inject: () => ({ translate, activeLocale }),
            },
            ProjectsDispatchRow,
          ),
        )
      },
    }
  },
})
