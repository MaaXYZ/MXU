export default {
  // 通用
  common: {
    confirm: '确定',
    cancel: '取消',
    undo: '撤销',
    save: '保存',
    delete: '删除',
    edit: '编辑',
    add: '添加',
    open: '打开',
    close: '关闭',
    reset: '重置',
    loading: '加载中...',
    error: '错误',
    success: '成功',
    warning: '警告',
    info: '提示',
    resizeOrCollapse: '拖动调整宽度，向右拖动到底可折叠',
    copySuffix: '（副本）',
    desktopOnly: '仅桌面端可用',
  },

  // 标题栏
  titleBar: {
    newTab: '新标签页',
    closeTab: '关闭标签页',
    settings: '设置',
    about: '关于',
    renameInstance: '重命名实例',
    instanceName: '实例名称',
    dragToReorder: '拖拽以重新排序',
    closeTabConfirmTitle: '关闭配置',
    closeTabConfirmMessage: '确定要关闭「{{name}}」吗？',
    closeMultiTabConfirmTitle: '关闭多个配置',
    closeMultiTabConfirmMessage: '确定要关闭 {{count}} 个配置吗？',
  },

  // 窗口控制按钮
  windowControls: {
    minimize: '最小化',
    maximize: '最大化',
    restore: '还原',
    close: '关闭',
  },

  // 设置
  settings: {
    title: '设置',
    appearance: '外观',
    hotkeys: '快捷键',
    general: '通用',
    taskSettings: '任务设置',
    taskSettingsEmpty: '当前没有可显示的设置项',
    language: '语言',
    backgroundImage: '背景图片',
    backgroundOpacity: '背景不透明度',
    selectBackgroundImage: '选择背景图片',
    removeBackgroundImage: '移除背景',
    languageSystem: '系统',
    theme: '主题',
    themeLight: '浅色',
    themeDark: '深色',
    themeSystem: '系统',
    accentColor: '强调色',
    showOptionPreview: '显示选项预览',
    showOptionPreviewHint: '在任务列表中显示选项的快捷预览信息',
    openLogDir: '打开日志目录',
    // 自定义强调色
    customAccents: '自定义强调色',
    addCustomAccent: '添加',
    editCustomAccent: '编辑自定义强调色',
    deleteCustomAccent: '删除',
    noCustomAccents: '暂无自定义强调色',
    customAccentNameRequired: '请输入名称',
    deleteCustomAccentConfirm: '确定要删除这个自定义强调色吗？',
    openNav: '打开导航菜单',
    closeNav: '关闭导航菜单',
    customAccentDeleted: '已删除 {{name}}',
    accentName: '名称',
    accentNamePlaceholder: '例如：小黑紫',
    autoAccentName: '{{hex}}',
    accentMainColor: '主色',
    accentHoverColor: '悬停色',
    accentLightColor: '浅色背景',
    accentLightDarkColor: '深色背景',
    accentColorConfig: '颜色配置',
    accentPreview: '预览效果',
    accentPreviewMainButton: '主要按钮',
    accentPreviewLightBg: '浅色背景',
    accentPreviewDarkBg: '深色背景',
    hotkeysStartTasks: '开始任务快捷键',
    hotkeysStopTasks: '结束任务快捷键',
    hotkeysHint:
      '仅在主界面中生效，用于开始 / 结束当前实例的任务。支持组合键（如 Ctrl+F10、Ctrl+Shift+F11），纯 F5/F12 仍保留为系统/浏览器快捷键。',
    hotkeysConflict: '开始和结束快捷键不应相同，请选择不同的按键',
    hotkeysModifierRequired: '单独按键仅支持 F1–F24，请再加一个修饰键（如 Ctrl、Alt、Shift）',
    hotkeysGlobal: '全局快捷键',
    hotkeysGlobalHint: '开启后窗口失焦时也能使用快捷键',
    hotkeysGlobalOnlyStart: '全局模式下仅开始生效',
    hotkeysGlobalConflict:
      '快捷键 {{combo}} 已被占用，全局快捷键当前未生效。请更换按键，或检查是否有其他程序 / 重复运行的实例占用该组合键。',
    hotkeysGlobalRegisterFailed: '全局快捷键 {{combo}} 注册失败：{{error}}',
    minimizeToTray: '关闭时最小化到托盘',
    minimizeToTrayHint: '点击关闭按钮时隐藏到系统托盘而非退出程序',
    autoStart: '开机自启动',
    autoStartHint: '系统启动时自动运行本程序',
    autoStartInstance: '启动后自动执行',
    autoStartInstanceHint:
      '选择程序启动后自动激活并执行任务的配置，未选择的配置其定时任务仍会正常运行',
    autoStartInstanceNone: '不自动执行',
    autoStartInstanceRemoved: '之前选择的配置「{{name}}」已被删除，自动执行已停用',
    autoRunOnLaunch: '手动启动时也自动执行',
    autoRunOnLaunchHint:
      '每次手动打开程序时，也自动执行上方选定的配置（关闭则仅在开机自启动时触发）',
    confirmBeforeDelete: '删除操作需要二次确认',
    confirmBeforeDeleteHint: '删除任务、清空列表等危险操作会先弹出确认对话框',
    helpImproveSoftware: '帮助改进软件',
    helpImproveSoftwareHint:
      '匿名发送崩溃、任务统计及失败任务的相关日志与错误截图，帮助发现常见问题',
    helpImproveSoftwareDisabledHint: '当前为调试 / 开发版本，已禁用匿名数据上报',
    maxLogsPerInstance: '每个实例保留的日志上限',
    maxLogsPerInstanceHint: '超过上限会自动丢弃最旧的日志（建议 500～2000）',
    resetWindowLayout: '重置窗口布局',
    resetWindowLayoutHint: '将窗口大小恢复为默认值，并居中显示',
    autoClearLogsOnLaunch: '自动清理运行日志',
    autoClearLogsOnLaunchHint: '每次启动项目时，自动清理运行日志与调试文件',
  },

  // 特殊任务
  specialTask: {
    sleep: {
      label: '⏳ 倒计时',
      optionLabel: '倒计时设置',
      inputLabel: '等待时间（秒）',
      inputError: '请输入正整数',
    },
    waitUntil: {
      label: '⏰ 定时等待',
      optionLabel: '时间设置',
      optionDescription:
        '等待到指定时间点后继续执行，仅支持 24 小时内。若目标时间已过则等待到次日该时间',
      inputLabel: '目标时间',
    },
    launch: {
      label: '▶️ 自定义程序',
      optionLabel: '程序设置',
      programLabel: '程序路径',
      programPlaceholder: '输入程序路径或点击右侧浏览...',
      argsLabel: '附加参数',
      argsPlaceholder: '输入附加参数（可选）',
      waitLabel: '等待退出',
      waitDescription: '禁用时启动进程后立即继续；启用时等待进程退出后再继续工作',
      waitYes: '等待程序退出后继续',
      waitNo: '启动后立即继续',
      skipLabel: '已运行时跳过',
      skipDescription: '启用时，如果程序已在运行则跳过启动，避免重复运行',
      skipYes: '已运行时跳过启动',
      skipNo: '始终启动新实例',
      cmdLabel: '通过 cmd 启动',
      cmdDescription:
        '启用时通过 cmd /c 启动程序，使其脱离当前进程树。一些游戏可能会检测进程树（仅 Windows 生效）',
      cmdYes: '通过 cmd /c 启动',
      cmdNo: '直接启动子进程',
    },
    notify: {
      label: '💬 系统通知',
      optionLabel: '通知设置',
      titleLabel: '通知标题',
      titlePlaceholder: '输入通知标题',
      bodyLabel: '通知内容',
      bodyPlaceholder: '输入通知内容',
    },
    webhook: {
      label: '🔔 Webhook',
      optionLabel: '请求设置',
      urlLabel: '请求地址',
      urlPlaceholder: '输入完整的 URL（如 https://example.com/webhook?key=xxx）',
    },
    killProc: {
      label: '⛔ 结束进程',
      selfLabel: '结束自身进程',
      selfDescription: '开启时结束本程序自身进程；关闭后可输入其他进程名称来结束',
      selfYes: '结束自身',
      selfNo: '结束指定进程',
      nameOptionLabel: '进程设置',
      nameLabel: '进程名称',
      namePlaceholder: '输入要结束的进程名（如 notepad.exe）',
    },
    power: {
      label: '⚡ 电脑操作',
      optionLabel: '操作类型',
      shutdown: '关机',
      restart: '重启',
      screenoff: '息屏',
      sleep: '睡眠',
      hibernate: '休眠',
      mute: '静音',
      unmute: '解除静音',
    },
  },

  // 任务列表
  taskList: {
    title: '任务列表',
    selectAll: '全选',
    deselectAll: '取消全选',
    collapseAll: '全部折叠',
    expandAll: '全部展开',
    addTask: '添加任务',
    noTasks: '暂无任务',
    dragToReorder: '拖拽以重新排序',
    startTasks: '开始任务',
    stopTasks: '停止任务',
    startingTasks: '启动中...',
    stoppingTasks: '停止中...',
    tasksSkippedDueToIncompatibility: '已跳过 {{count}} 个不兼容的任务',
    taskSkippedController: '任务 "{{taskName}}" 不支持当前控制器',
    taskSkippedResource: '任务 "{{taskName}}" 不支持当前资源',
    noCompatibleTasks: '没有兼容当前控制器和资源的任务',
    checkboxTaskScope: '任务「{{task}}」',
    checkboxGlobalScope: '全局设置',
    checkboxMinimumNotMet:
      '{{scope}}的选项「{{option}}」至少需要选择 {{min}} 项，当前选择了 {{count}} 项',
    checkboxMaximumExceeded:
      '{{scope}}的选项「{{option}}」最多只能选择 {{max}} 项，当前选择了 {{count}} 项',
    // 自动连接相关
    autoConnect: {
      searching: '搜索设备...',
      searchingWindow: '搜索窗口...',
      connecting: '连接设备...',
      connectingWindow: '连接窗口...',
      loadingResource: '加载资源...',
      deviceNotFound: '未找到设备: {{name}}',
      windowNotFound: '未找到窗口: {{name}}',
      noSavedDevice: '没有保存的设备配置',
      noDeviceFound: '未搜索到任何设备',
      noWindowFound: '未搜索到任何窗口',
      connectFailed: '自动连接失败',
      retryConnect: '连接失败，第 {{attempt}} 次重试...',
      autoSelectedDevice:
        '尚未手动选择过设备，已自动匹配到「{{name}}」。如需更换，请在连接设置中手动选择，下次将记住您的选择。',
      autoSelectedWindow:
        '尚未手动选择过窗口，已自动匹配到「{{name}}」。如需更换，请在连接设置中手动选择，下次将记住您的选择。',
      resourceFailed: '资源加载失败',
      startFailed: '任务启动失败',
      alreadyRunning: '任务已在运行或正在执行前置动作',
      taskNotFound: '指定的任务不存在或已被删除',
      noRunnableTasks: '没有可执行的任务，请检查任务定义和入口配置',
      workstationLocked: '检测到电脑处于锁屏状态，请先解锁后再运行任务',
      agentStartParams: 'Agent #{{index}} 启动参数: {{cmd}}  (工作目录: {{cwd}})',
      agentSpawnHintFileNotFound: '请先检查 Agent 是否被杀软拦截，确认无误后重新覆盖安装。',
      agentSpawnHintAppControl:
        '请在「Windows 安全中心 → 应用和浏览器控制 → 智能应用控制」中关闭该功能后重试。',
      needConfig: '请先连接设备并加载资源，或在连接面板保存设备配置',
    },
  },

  // 任务项
  taskItem: {
    options: '配置选项',
    noOptions: '无可配置选项',
    enabled: '已启用',
    disabled: '已禁用',
    expand: '展开选项',
    collapse: '折叠选项',
    remove: '移除任务',
    removeConfirmTitle: '删除任务',
    removeConfirmMessage: '确定要删除这个任务吗？',
    rename: '重命名',
    clickToToggle: '单击选中/取消',
    runOnceHint: '单次运行：下次启动时执行一次',
    renameTask: '重命名任务',
    customName: '自定义名称',
    originalName: '原始名称',
    cannotEditRunningTask: '已执行或正在执行的任务无法编辑选项',
    // 描述内容加载
    loadingDescription: '加载描述中...',
    loadedFromFile: '内容来自本地文件',
    loadedFromUrl: '内容来自网络',
    loadDescriptionFailed: '加载失败',
    // 任务运行状态
    status: {
      idle: '未执行',
      pending: '等待中',
      running: '执行中',
      succeeded: '已完成',
      failed: '执行失败',
    },
    // 任务兼容性
    incompatibleController: '不支持当前控制器',
    incompatibleResource: '不支持当前资源',
    supportedControllers: '仅支持: {{controllers}}',
  },

  // 选项
  option: {
    select: '请选择',
    input: '请输入',
    yes: '是',
    no: '否',
    invalidInput: '输入格式不正确',
  },

  action: {
    preAction: '▶️ 前置程序',
    program: '程序路径',
    programPlaceholder: '输入程序路径或点击右侧浏览...',
    args: '附加参数',
    argsPlaceholder: '输入附加参数（可选）',
    browse: '浏览',
    waitForExit: '等待退出',
    waitForExitHintPre:
      '禁用时启动进程后立即继续，并循环轮询设备连接状态，适用于启动游戏等异步场景；启用时等待进程退出后再继续，适用于执行脚本等需要同步完成的操作',
    skipIfRunning: '已运行时跳过',
    skipIfRunningHint: '启用时，如果该程序已在运行则跳过执行，适用于避免重复启动游戏等场景',
    useCmd: '通过 cmd 启动',
    useCmdHint:
      '启用时通过 cmd /c 启动程序，使其脱离当前进程树。一些游戏可能会检测进程树（仅 Windows 生效）',
    preActionSkipped: '前置程序 {{name}} 已在运行，跳过执行',
    waitingForDevice: '正在等待设备就绪...',
    waitingForWindow: '正在等待窗口就绪...',
    waitingForDeviceNamed: '正在等待设备「{{name}}」就绪...',
    waitingForWindowNamed: '正在等待窗口「{{name}}」就绪...',
    waitingForAnyDevice:
      '正在等待任意匹配设备就绪。若等待的不是目标设备，请先在连接设置中手动选择后再启动。',
    waitingForAnyWindow:
      '正在等待任意匹配窗口就绪。若等待的不是目标窗口，请先在连接设置中手动选择后再启动。',
    deviceReady: '设备已就绪',
    windowReady: '窗口已就绪',
    deviceWaitTimeout: '等待设备超时',
    windowWaitTimeout: '等待窗口超时',
    preActionStarting: '正在执行前置程序...',
    preActionStartingNamed: '正在执行前置程序: {{name}}...',
    preActionCompleted: '前置程序执行完成',
    preActionCompletedNamed: '前置程序 {{name}} 执行完成',
    preActionFailed: '前置程序执行失败: {{error}}',
    preActionExitCode: '前置程序退出码: {{code}}',
    pretaskStarting: '正在执行预任务: {{name}}',
    pretaskCompleted: '预任务执行完成: {{name}}',
    pretaskExitCode: '预任务退出码: {{code}}',
    pretaskFailed: '预任务执行失败: {{error}}',
    preActionConnectDelay: '等待 {{seconds}} 秒后连接...',
    removeConfirmTitle: '删除前置程序',
    removeConfirmMessage: '确定要删除这个前置程序吗？',
  },

  // 选项编辑器
  optionEditor: {
    loadingDescription: '加载描述中...',
    loadedFromFile: '内容来自本地文件',
    loadedFromUrl: '内容来自网络',
    loadDescriptionFailed: '加载失败',
    searchPlaceholder: '搜索选项...',
    noMatchingOptions: '无匹配选项',
    incompatibleController: '不支持当前控制器',
    incompatibleResource: '不支持当前资源包',
    hotkeyPlaceholder: '点击录入快捷键',
    hotkeyCapturing: '按下快捷键...',
    expandOptions: '展开子选项',
    collapseOptions: '收起子选项',
    checkboxCountRange: '至少 {{min}} 项，最多 {{max}} 项',
    checkboxCountMinimum: '至少 {{min}} 项',
    checkboxCountMaximum: '最多 {{max}} 项',
    checkboxSelectedCount: '已选择 {{count}} 项（{{constraint}}）',
    checkboxMinimumRequired: '至少选择 {{min}} 项（当前 {{count}} 项）',
    checkboxMaximumReached: '最多只能选择 {{max}} 项',
  },

  // 预设配置
  preset: {
    title: '选择预设方案',
    hint: '一键应用预定义的任务配置，快速开始',
    taskCount: '个任务',
    skipToManual: '跳过，手动添加任务',
    importConfig: '从剪贴板导入配置',
    importConfigFromFile: '从文件导入配置',
    importSuccess: '配置导入成功',
    importFailed: '导入失败：格式无效',
    importProjectMismatch: '导入失败：项目不匹配',
    importVersionUnsupported:
      '导入失败：该配置由更高版本的 {{projectName}} 导出，请更新 {{projectName}} 后重试',
    exportSuccess: '配置已复制到剪贴板',
    exportFailed: '导出失败：无法写入剪贴板',
    exportFileSuccess: '配置已导出为 txt 文件',
    exportFileFailed: '导出失败：无法写入文件',
    exportShareHint: '「{{tabName}}」的 {{projectName}} 配置，发给你啦~',
    exportShareFooter: '👆 复制这段文字，在 {{projectName}} 里新建标签页，点「导入配置」就能直接用',
  },

  // 控制器
  controller: {
    title: '控制器',
    selectController: '选择控制器',
    adb: 'Android 设备',
    win32: 'Windows 窗口',
    wlroots: 'WlRoots (Linux)',
    linux: 'Linux',
    portal: 'Portal',
    uinputWidth: '宽 (px)',
    uinputHeight: '高 (px)',
    uinputDimensionsRequired: '请先填写有效的 UInput 屏幕宽度和高度（正整数）',
    playcover: 'PlayCover (macOS)',
    macos: 'macOS 窗口',
    macosPermissionsRequired:
      '需要授予屏幕录制和辅助功能权限。请在 macOS“系统设置”的“隐私与安全性”中授权后重试。',
    macosUnsupportedPlatform: 'macOS 原生窗口控制器仅可在 macOS 上使用。',
    macosVersionRequired: 'macOS 原生窗口控制器需要 MaaFramework v5.10.0-beta.1 或更高版本。',
    macosSystemVersionRequired: 'macOS 原生窗口控制器需要 macOS 14.0 或更高版本。',
    macosSystemVersionDetectionFailed: '无法识别当前 macOS 系统版本，请查看日志了解详情。',
    linuxVersionRequired: 'Linux 控制器需要 MaaFramework v5.13.0-beta.3 或更高版本。',
    gamepad: '游戏手柄',
    connecting: '连接中...',
    connected: '已连接',
    disconnected: '未连接',
    connectionFailed: '连接失败',
    refreshDevices: '刷新设备',
    refreshWindows: '刷新窗口',
    refresh: '刷新设备',
    connect: '连接',
    disconnect: '断开连接',
    selectDevice: '请选择设备',
    selectWindow: '请选择窗口',
    noDevices: '未找到设备',
    noWindows: '未找到窗口',
    playcoverHint: '输入 PlayCover 应用监听地址',
    lastSelected: '上次选择 · 点击搜索',
    savedDeviceNotFound: '未找到上次的设备，请检查连接或重新选择',
    savedWindowNotFound: '未找到上次的窗口，请检查连接或重新选择',
    connectedLog: '已连接控制器 [{{name}}]',
  },

  // 资源
  resource: {
    title: '资源包',
    selectResource: '选择资源包',
    loading: '加载资源中...',
    loaded: '资源已加载',
    loadFailed: '资源加载失败',
    loadResource: '加载资源',
    switchFailed: '切换资源失败',
    cannotSwitchWhileRunning: '任务运行中无法切换资源',
    hashMismatch: '资源完整性校验失败（期望: {{expected}}，实际: {{actual}}），建议重新下载资源包',
    incompatibleController: '不支持当前控制器',
  },

  // MaaFramework
  maa: {
    notInitialized: 'MaaFramework 未初始化',
    initFailed: '初始化失败',
    version: '版本',
    needConnection: '请先连接设备',
    needResource: '请先加载资源',
  },

  // 截图预览
  screenshot: {
    title: '实时截图',
    autoRefresh: '自动刷新',
    noScreenshot: '暂无截图',
    startStream: '开始实时流',
    stopStream: '停止实时流',
    connectFirst: '请先连接设备',
    fullscreen: '全屏显示',
    exitFullscreen: '退出全屏',
    clickHint: '点击画面可向设备发送点击',
    // 帧率设置
    frameRate: {
      title: '实时截图帧率',
      hint: '仅影响画面预览流畅度与系统资源占用，不影响任务识别与执行',
      unlimited: '不限',
      fps5: '每秒 5 帧',
      fps1: '每秒 1 帧',
      every5s: '5 秒一帧',
      every30s: '30 秒一帧',
    },
  },

  // 日志/信息流
  logs: {
    title: '运行日志',
    clear: '清空',
    autoscroll: '自动滚动',
    noLogs: '暂无日志',
    copyAll: '复制全部',
    showMoreLogs: '展示更多日志',
    expand: '展开上方面板',
    collapse: '折叠上方面板',
    scrollToLogs: '查看日志',
    // 日志消息
    messages: {
      // 连接消息
      connecting: '正在连接{{target}}...',
      connected: '{{target}}连接成功:',
      connectFailed: '{{target}}连接失败:',
      targetDevice: '设备',
      targetWindow: '窗口',
      // 资源加载消息
      loadingResource: '正在加载资源: {{name}}',
      resourceLoaded: '资源加载成功: {{name}}',
      resourceFailed: '资源加载失败: {{name}}',
      resourceFailedHint: '可删除该资源目录后重新覆盖安装再试。',
      // 任务消息
      taskStarting: '任务开始: {{name}}',
      taskSucceeded: '任务完成: {{name}}',
      taskFailed: '任务失败: {{name}}',
      stopTask: '停止任务',
      // 定时任务消息
      scheduleStarting: '定时执行开始 [{{policy}}] {{time}}',
      // Agent 消息
      agentStarting: 'Agent 正在启动...',
      agentStarted: 'Agent 已启动',
      agentConnected: 'Agent 已连接',
      agentDisconnected: 'Agent 已断开',
      agentFailed: 'Agent 启动失败',
      agentLogFloodWarning:
        'Agent 处于日志风暴状态，为避免性能问题已暂停显示日志，完整日志可在本地日志文件中查看',
      agentLogFloodRecovered: 'Agent 日志风暴状态已缓解',
      // 快捷键
      hotkeyDetected: '检测到快捷键: {{combo}}（{{action}}）',
      hotkeyActionStart: '开始任务',
      hotkeyActionStop: '停止任务',
      hotkeyStartSuccess: '已通过快捷键开始任务：',
      hotkeyStopSuccess: '已通过快捷键停止任务',
      hotkeyStopPending: '停止请求已发送，但任务仍在等待当前操作退出。',
      hotkeyStopFailed: '未能通过快捷键停止任务',
    },
  },

  // 添加任务面板
  addTaskPanel: {
    title: '添加任务',
    searchPlaceholder: '搜索任务...',
    noResults: '没有找到匹配的任务',
    alreadyAdded: '已添加',
    specialTasks: '特殊任务',
    pretasks: '前置任务',
    allSpecialTasksAdded: '已全部添加',
    collapse: '收起面板',
    ungroupedTasks: '其他',
    resizeHandleAriaLabel: '调整添加任务面板高度',
  },

  // 关于
  about: {
    title: '关于',
    version: '版本',
    description: '描述',
    license: '许可证',
    contact: '联系方式',
    github: 'GitHub 仓库',
  },

  // 调试
  debug: {
    title: '调试',
    versions: '版本信息',
    interfaceVersion: '{{name}} 版本',
    maafwVersion: 'maafw 版本',
    mxuVersion: 'mxu 版本',
    environment: '运行环境',
    envTauri: 'Tauri 桌面端',
    envBrowser: '浏览器',
    systemInfo: '系统信息',
    operatingSystem: '操作系统',
    architecture: '系统架构',
    tauriVersion: 'Tauri 版本',
    pathInfo: '路径信息',
    cwd: '当前工作目录',
    exeDir: '程序所在目录',
    webview2Dir: 'WebView2 目录',
    webview2System: '系统',
    resetWindowLayout: '重置窗口布局',
    openConfigDir: '打开配置目录',
    openLogDir: '打开日志目录',
    exportLogs: '导出日志',
    exportLogsHint:
      '打包日志和 config，并按压缩包 24.5 MB 上限自动保留最近调试图片；开启「保存调试图像」时同时打包 vision 图片',
    exportingLogs: '正在导出日志...',
    logsExported: '日志已导出',
    exportLogsFailed: '导出日志失败',
    devMode: '开发模式',
    devModeHint: '启用后允许按 F5 刷新 UI',
    saveDraw: '保存调试图像',
    saveDrawHint: '保存识别和操作的调试图像到日志目录（重启软件后自动关闭）',
    tcpCompatMode: '通信兼容模式',
    tcpCompatModeHint: '若启动任务后软件立即闪退，可尝试开启。仅限此情况使用，否则会影响运行效率',
  },

  webserver: {
    address: 'Web 服务地址',
    title: 'Web 与 AI',
    enabled: '启用 Web 服务',
    enabledHint: '关闭后内置 Web 服务器将不会启动（重启生效）',
    port: 'Web 服务端口',
    portHint: '自定义 Web 服务器监听端口（默认 12701，重启生效）',
    allowLanAccess: '允许局域网访问',
    allowLanAccessHint: '启用后 Web UI 将监听 0.0.0.0，允许局域网内其他设备访问',
    restartMessage: '更改 Web 服务设置需要重启才能生效，是否立即重启？',
    restartLater: '稍后重启',
    restartNow: '立即重启',
  },

  // MCP 服务
  mcp: {
    enabled: '启用 AI 助手（MCP）',
    enabledHint:
      '允许本机的 AI 工具连接 MXU，管理和启动任务、查看截图。AI 的操作会记录在日志面板中',
    requiresWebServer: 'AI 助手依赖 Web 服务，请先启用 Web 服务',
    address: '连接地址',
    copy: '复制',
    copied: '已复制',
    log: {
      addTask: 'AI：添加任务「{{name}}」',
      updateTask: 'AI：修改任务「{{name}}」',
      removeTask: 'AI：删除任务「{{name}}」',
      startTasks: 'AI：启动任务',
      startTask: 'AI：启动任务「{{name}}」',
      stopTasks: 'AI：停止任务',
    },
    errors: {
      paramNotString: '参数 {{key}} 需要是字符串',
      paramMissing: '缺少参数 {{key}}',
      tabNotFound: '标签页不存在：{{id}}，请先调用 list_tabs',
      noActiveTab: '当前没有打开的标签页',
      adminRequired: '当前控制器需要管理员权限，请用户以管理员身份重启 MXU 后再试',
      startFailedWithReasons: '启动失败：{{reasons}}',
      startFailed: '启动失败，请查看 MXU 日志',
      projectNotLoaded: '项目尚未加载',
      taskNotFound: '任务不存在：{{name}}，请先调用 list_available_tasks',
      taskNotAddable: '任务 {{name}} 不支持添加',
      taskIncompatible: '任务 {{name}} 不适用于当前控制器/资源',
      paramOptionsNotObject: '参数 options 需要是对象',
      paramEnabledNotBoolean: '参数 enabled 需要是布尔值',
      addTaskFailed: '添加任务失败：{{name}}',
      updateWhileRunning: '任务运行中不能修改任务，请先停止任务',
      taskIdNotFound: '任务列表中没有 task_id 为 {{id}} 的任务，请先调用 get_task_list',
      taskDefMissing: '任务 {{name}} 的定义已不存在，无法修改',
      updateIncompatible: '任务 {{name}} 不适用于当前控制器/资源，不能修改',
      nothingToUpdate: '没有要修改的内容，请传入 options 或 enabled',
      removeWhileRunning: '任务运行中不能删除任务，请先停止任务',
      alreadyRunning: '该标签页的任务已在运行中',
      tabStarting: '该标签页正在启动中，请稍后用 get_run_status 查看状态，不要重复启动',
      uiNotReady: 'MXU 界面尚未就绪，请稍后重试',
      unknownOp: '未知操作：{{op}}',
      optionNotFoundForDescribe:
        '任务没有选项 "{{key}}"，请先不带 option_key 调用 describe_task 查看选项列表',
      optionIncompatible: '选项 "{{key}}" 不适用于当前控制器/资源',
      optionNotFound: '任务没有选项 "{{key}}"，可用选项：{{valid}}',
      noSettableOptions: '任务没有可设置的选项',
      inputNeedsObject: '选项 "{{key}}" 需要传入 { 字段名: 值 } 对象',
      inputFieldNotFound: '选项 "{{key}}" 没有字段 "{{name}}"，可用字段：{{valid}}',
      inputFieldNotString: '选项 "{{key}}" 的字段 "{{name}}" 需要传入字符串',
      inputFieldInvalid:
        '选项 "{{key}}" 的字段 "{{name}}" 的值 "{{value}}" 不符合格式要求（正则：{{verify}}）',
      inputFieldInvalidWithHint:
        '选项 "{{key}}" 的字段 "{{name}}" 的值 "{{value}}" 不符合格式要求：{{hint}}（正则：{{verify}}）',
      switchInvalid: '选项 "{{key}}" 是开关，取值只能是 "Yes" 或 "No"',
      checkboxNeedsArray: '选项 "{{key}}" 是多选，需要传入取值名称数组，可选：{{valid}}',
      casesInvalid: '选项 "{{key}}" 没有取值 {{invalid}}，可选：{{valid}}',
      checkboxMin: '选项 "{{key}}" 至少需要选择 {{count}} 项',
      checkboxMax: '选项 "{{key}}" 最多只能选择 {{count}} 项',
      selectInvalid: '选项 "{{key}}" 没有取值 "{{value}}"，可选：{{valid}}',
    },
    notes: {
      pretaskNextRun: '前置任务将在下次启动时生效',
      stopPending: '已发送停止请求，任务尚未完全停止，可稍后用 get_run_status 确认',
    },
    // 推送给后端：MCP 握手 instructions、工具标题/描述、参数说明与后端错误（后端占位符为 {name}）
    server: {
      instructions:
        '你正在通过 MCP 操作 MXU。MXU 是基于 MaaFramework 的通用自动化客户端，具体自动化哪个项目以 list_tabs 返回的项目信息为准。\n\n## 你能做什么\n- 管理任务列表：查看、添加、修改、删除任务（含 MXU 特殊任务，如延迟、定时等待、启动程序）\n- 启动 / 停止任务，查询运行状态与日志\n- 查看设备当前画面截图\n画面上的操作全部由 MXU 的任务执行，你不能直接点击或滑动。\n\n## 基本概念\n- 标签页：MXU 界面顶部的每个标签页，各自有独立的设备连接、任务列表和运行状态。不传 tab_id 时使用当前选中的标签页。\n- 任务：由项目定义，用 list_available_tasks 查看当前可添加的任务；任务可带选项，用 describe_task 查看。\n- 任务列表里的每一项有独立的 task_id，同名任务可以出现多次。\n- 返回结果中的 label 是界面显示的名称（已按当前界面语言翻译），name 是内部名称；调用工具时传 name。\n\n## 推荐流程\n1. 先调用 list_tabs；有多个标签页且用户没说明时，先问用户要操作哪个。\n2. 修改任务列表前先调用 get_task_list 了解现状，避免重复添加。\n3. 添加任务：\n   - 用 list_available_tasks 的名称和描述匹配用户的说法；对应关系不确定时先问用户，不要猜。\n   - 用 describe_task 查看选项，只传用户要求修改的选项，其余保持默认。\n   - 选项值使用 describe_task 返回的取值名称；校验失败时根据错误中的合法取值修正。\n4. 启动任务：start_tasks 会立即返回，之后每 10～30 秒调用一次 get_run_status，直到运行结束；运行中不要重复启动。\n5. 排查失败：先看 get_run_status 返回的日志，必要时用 capture_screen 查看画面；向用户汇报时把证据和推测分开说。\n\n## 注意事项\n- 只在用户明确要求时才启动任务：任务会操控用户的设备。\n- 运行中不能修改或删除任务；运行中添加的普通任务和特殊任务会追加到当前执行队列末尾，前置任务（pretask）要到下次启动才生效。\n- 删除任务不会弹出确认，删除前确认 task_id 是用户要删的那一项。\n- 截图需要设备已连接；未连接时不要为了截图而启动任务，先询问用户。\n- 密码类选项的值已打码；不要让用户在对话中提供密码，请用户在 MXU 界面里填写。\n- 你的所有写操作都会记录在 MXU 的日志面板中。',
      tools: {
        list_tabs: {
          title: '查看标签页',
          description:
            '列出 MXU 的所有标签页（各自有独立的设备连接与任务列表）及其连接、运行状态，并返回当前加载的项目信息。返回的 tab_id 用于在其他工具中指定标签页。',
        },
        list_available_tasks: {
          title: '查看可添加的任务',
          description:
            '列出标签页可以添加的任务（已按当前控制器/资源过滤），包括项目任务、前置任务（pretask: true）和 MXU 特殊任务（special: true）。只返回名称与简介，不含选项结构（用 describe_task 查看）；已添加的任务用 get_task_list 查看。',
        },
        describe_task: {
          title: '查看任务选项',
          description:
            '查看某个任务的选项结构，格式与 interface.json 一致：root_options 是顶层选项 key，options 是 key → 选项定义表（类型、label、默认值、可选取值、输入字段），取值下的 options 是选中后出现的子选项 key，到 options 表里查定义。只描述结构，不返回已添加任务的当前取值（用 get_task_list 查看）。取值列表与另一选项完全相同时省略 cases，用 cases_same_as 指明参照的选项 key；取值超过 50 项时省略 cases（cases_omitted，case_count 为数量），需要时传 option_key 单独查看该选项的完整取值。',
        },
        get_task_list: {
          title: '查看任务列表',
          description:
            '查看标签页任务列表中已添加的任务：每项的 task_id、名称、是否勾选、运行状态及当前选项值（密码已打码）。要查看还能添加哪些任务用 list_available_tasks。',
        },
        add_task: {
          title: '添加任务',
          description:
            '向标签页的任务列表添加一个任务，返回新任务的 task_id；选项的 key 与取值先用 describe_task 查看。标签页运行中时，普通任务和特殊任务会追加到当前执行队列，前置任务下次启动生效。只添加不启动，启动用 start_tasks。',
        },
        update_task: {
          title: '修改任务',
          description:
            '修改任务列表中已有任务的选项或勾选状态，task_id 来自 get_task_list；只传要修改的选项，未传的保持当前值，选项的 key 与取值用 describe_task 查看。标签页运行中时不能修改，需先用 stop_tasks 停止。返回修改后的选项值。',
        },
        remove_task: {
          title: '删除任务',
          description:
            '从标签页的任务列表删除一个任务（不会弹出确认），task_id 来自 get_task_list。标签页运行中时不能删除，需先用 stop_tasks 停止。',
        },
        start_tasks: {
          title: '启动任务',
          description:
            '启动标签页的任务：运行所有已勾选的任务，或用 task_id 只运行其中一个。会自动连接设备、加载资源；启动后立即返回，不等待任务结束，进度用 get_run_status 查询。启动失败时返回原因（如未找到窗口/设备）。',
        },
        stop_tasks: {
          title: '停止任务',
          description: '停止标签页正在运行的任务，等待任务停下后返回。不会删除任务或修改任务列表。',
        },
        get_run_status: {
          title: '查看运行状态',
          description:
            '查询标签页的运行状态：是否在运行、是否正在启动、本次运行中各任务的状态，以及最近的日志。不会启动或停止任务；任务列表的完整内容用 get_task_list 查看。',
        },
        capture_screen: {
          title: '截取设备画面',
          description:
            '获取标签页所连设备的当前画面截图（PNG）。不会自动连接设备：未连接时返回错误，连接由 start_tasks 自动完成。',
        },
      },
      params: {
        tab_id: '标签页 ID（来自 list_tabs）；不传则使用当前选中的标签页',
        task_name: '任务名称（list_available_tasks 返回的 name）',
        task_id: '任务列表中的任务 ID（get_task_list 返回的 task_id）',
        task_id_start:
          '只运行这一个任务（get_task_list 返回的 task_id）；不传则运行所有已勾选的任务',
        option_key:
          '只查看这一个选项（含子选项），取值列表完整列出；用于查看标记了 cases_omitted 的选项',
        options_add:
          '选项值，键为 describe_task 返回的选项 key，只传需要修改的选项：select 传取值名称字符串；checkbox 传取值名称数组；switch 传 "Yes" / "No"；input 传 { 字段名: 字符串值 } 对象',
        options_update:
          '要修改的选项，只传需要修改的选项，未传的保持当前值；格式与 add_task 的 options 相同',
        enabled_add: '是否勾选启用，默认 true',
        enabled_update: '是否勾选启用',
        log_limit: '返回最近多少条日志，默认 20，最大 200',
      },
      errors: {
        uiNotReady: 'MXU 界面尚未就绪，请稍后重试',
        sendFailed: '发送请求到 MXU 界面失败：{error}',
        noResult: 'MXU 界面未返回结果',
        timeout: '等待 MXU 界面响应超时（{seconds} 秒）',
        timeoutStart:
          '等待启动结果超时（{seconds} 秒）：启动可能仍在进行，请用 get_run_status 查看状态，不要直接重试',
        timeoutWrite:
          '等待 MXU 界面响应超时（{seconds} 秒）：操作可能已经执行，请先用 get_task_list 或 get_run_status 确认后再决定是否重试',
        unknownError: '未知错误',
        tabResolveFailed: '无法解析标签页',
        deviceNotConnected: '设备未连接，无法截图',
        captureFailed: '截图失败',
        captureFailedWithError: '截图失败：{error}',
        captureTimeout: '截图超时',
        readImageFailed: '读取截图数据失败',
        noImageData: '暂无截图数据',
      },
    },
  },

  // 配置自愈提示
  config: {
    recoveredFromBackup: '配置文件已损坏，已自动恢复到 {{time}} 的备份',
    recoveryFailed: '配置文件已损坏且没有可用备份，已重置为默认配置',
  },

  // 欢迎弹窗
  welcome: {
    dismiss: '我知道了',
    viewAgain: '查看欢迎信息',
  },

  // 新用户引导
  onboarding: {
    title: '连接设备',
    message: '在右侧「连接设置」面板中选择设备并加载资源，完成后即可开始运行任务。',
    addTaskTitle: '添加任务',
    addTaskMessage: '点击这里浏览可用任务，将需要执行的任务添加到列表中。',
    tabBarTitle: '管理多个配置',
    tabBarMessage:
      '通过顶部标签页可以新建或切换不同的配置——例如一个用于日常挂机，另一个用于实时小工具，各配置的任务和设备设置互相独立。',
    next: '下一步',
    prev: '上一步',
    gotIt: '知道了',
    skipDev: '跳过（DEV）',
  },

  // 实例
  instance: {
    defaultName: '配置',
  },

  // 连接面板
  connection: {
    title: '连接设置',
  },

  // 中控台
  dashboard: {
    title: '中控台',
    toggle: '中控台视图',
    exit: '退出中控台',
    instances: '个实例',
    noInstances: '暂无实例',
    running: '运行中',
    succeeded: '已完成',
    failed: '已失败',
    noEnabledTasks: '没有启用的任务',
    alignLeft: '靠左排列',
    alignCenter: '居中排列',
    alignRight: '靠右排列',
    zoomIn: '放大',
    zoomOut: '缩小',
  },

  // 最近关闭
  recentlyClosed: {
    title: '最近关闭',
    empty: '暂无最近关闭的标签页',
    reopen: '重新打开',
    remove: '从列表中移除',
    clearAll: '清空列表',
    clearAllConfirmTitle: '清空最近关闭',
    clearAllConfirmMessage: '确定要清空最近关闭列表吗？',
    justNow: '刚刚',
    minutesAgo: '{{count}} 分钟前',
    hoursAgo: '{{count}} 小时前',
    daysAgo: '{{count}} 天前',
    noTasks: '无任务',
    tasksCount: '{{first}} 等 {{count}} 个任务',
  },

  // MirrorChyan 更新
  mirrorChyan: {
    title: '更新',
    debugModeNotice: '当前为调试版本，已禁用自动更新功能',
    channel: '更新频道',
    channelStable: '正式版',
    channelBeta: '公测版',
    cdk: 'Mirror酱 CDK',
    cdkPlaceholder: '输入您的 CDK（可选）',
    serviceName: 'Mirror酱',
    cdkHintAfterLink:
      ' 是独立的第三方加速下载服务，需要付费使用，并非「{{projectName}}」收费。其运营成本由订阅收入支撑，部分收益将回馈项目开发者。欢迎订阅 CDK 享受高速下载，同时支持项目持续开发。未填写 CDK 时将自动通过 GitHub 下载，若失败请尝试配置网络代理。',
    getCdk: '没有CDK？立即订阅',
    cdkHint: '请检查您的 CDK 是否正确或已过期',
    slowDownloadHint: '其他渠道',
    checkUpdate: '检查更新',
    checking: '正在检查...',
    upToDate: '当前已是最新版本 ({{version}})',
    newVersion: '发现新版本',
    currentVersion: '当前版本',
    latestVersion: '最新版本',
    releaseNotes: '更新日志',
    downloadNow: '立即下载',
    later: '稍后提醒',
    dismiss: '忽略此版本',
    noReleaseNotes: '暂无更新日志',
    checkFailed: '检查更新失败',
    checkFailedHint: '请检查网络连接后重试',
    downloading: '下载中',
    downloadComplete: '下载完成',
    downloadFailed: '下载失败',
    viewDetails: '查看详情',
    noDownloadUrl: '无可用下载链接，请填写 CDK 或检查网络环境',
    openFolder: '打开目录',
    retry: '重试',
    preparingDownload: '准备下载...',
    downloadFromGitHub: '通过 海外渠道（GitHub）下载',
    downloadFromMirrorChyan: '通过 Mirror酱 CDN 下载',
    // 更新安装
    installing: '正在安装更新...',
    installComplete: '安装完成',
    installFailed: '安装失败',
    installErrors: {
      packageMissing: '更新包不存在，请重新下载',
      packageCorrupt: '更新包已损坏，请重新下载（{{detail}}）',
      extractFailed: '解压更新包失败，可能被安全软件拦截（{{detail}}）',
      rolledBack: '更新失败，已恢复到更新前的版本（{{detail}}）',
      exeMissing:
        '程序文件已丢失，可能被安全软件删除或隔离。请将安装目录加入安全软件白名单后重新下载更新',
    },
    installNow: '立即安装',
    installUpdate: '安装更新',
    installStages: {
      extracting: '正在解压...',
      checking: '检查更新类型...',
      applying: '正在应用更新...',
      cleanup: '清理临时文件...',
      done: '更新完成',
      incremental: '增量更新',
      full: '全量更新',
      fallback: '正在执行兜底更新...',
    },
    restartRequired: '更新已安装，请重启应用以生效',
    restartNow: '立即重启',
    restarting: '正在重启...',
    installerOpened: '安装程序已打开',
    installerOpenedHint: '请完成安装程序的操作，安装完成后重新启动本应用即可',
    // 更新完成后
    updateCompleteTitle: '更新完成',
    updateCompleteMessage: '已成功更新到最新版本',
    previousVersion: '更新前版本',
    gotIt: '知道了',
    // MirrorChyan API 错误码
    errors: {
      1001: '参数不正确，请检查配置',
      7001: 'CDK 已过期，请续费或更换 CDK',
      7002: 'CDK 错误，请检查输入是否正确',
      7003: 'CDK 今日下载次数已达上限',
      7004: 'CDK 类型与资源不匹配',
      7005: 'CDK 已被封禁，请联系客服',
      8001: '当前系统/架构暂无可用资源',
      8002: '系统参数错误',
      8003: '架构参数错误',
      8004: '更新通道参数错误',
      1: '服务异常，请稍后重试',
      unknown: '未知错误 ({{code}}): {{message}}',
      negative: '服务器错误，请联系技术支持',
    },
  },

  // 代理设置
  proxy: {
    title: '网络代理',
    url: '代理地址',
    urlPlaceholder: '例如：http://127.0.0.1:7890',
    urlHint: '支持 HTTP/SOCKS5，留空则不使用代理',
    urlHintDisabled: '已填写 Mirror酱 CDK，代理功能已禁用',
    invalid: '代理地址格式不正确',
    examples: '示例格式',
  },

  // 定时执行
  schedule: {
    title: '定时执行',
    button: '定时',
    addPolicy: '添加定时策略',
    defaultPolicyName: '策略',
    policyName: '策略名称',
    noPolicies: '暂无定时策略',
    noPoliciesHint: '添加策略以自动执行任务',
    repeatDays: '重复日期',
    startTime: '开始时间',
    selectDays: '选择日期...',
    addTime: '添加时间',
    noWeekdays: '未选择日期',
    noTimes: '未选择时间',
    everyday: '每天',
    timesSelected: '个时间点',
    timeZoneHint: '使用本地时区',
    multiSelect: '可多选',
    enable: '启用策略',
    disable: '禁用策略',
    enableAll: '启用所有策略',
    disableAll: '禁用所有策略',
    hint: '定时策略将在设定时间自动开始任务',
    executingPolicy: '正在按照「{{name}}」定时执行',
    startedAt: '开始时间: {{time}}',
    deletePolicyTitle: '删除策略',
    deletePolicyConfirm: '确定要删除策略「{{name}}」吗？',
    // 索引对应 Date.getDay()：0=周日, 1=周一, ..., 6=周六
    weekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  },

  // 错误消息
  errors: {
    loadInterfaceFailed: '加载 interface.json 失败',
    invalidInterface: 'interface.json 格式无效',
    invalidConfig: '配置文件格式无效',
    taskNotFound: '任务不存在',
    controllerNotFound: '控制器不存在',
    resourceNotFound: '资源包不存在',
  },

  // 右键菜单
  contextMenu: {
    // Tab 右键菜单
    newTab: '新建标签页',
    duplicateTab: '复制标签页',
    renameTab: '重命名',
    moveLeft: '向左移动',
    moveRight: '向右移动',
    moveToFirst: '移到最左',
    moveToLast: '移到最右',
    closeTab: '关闭标签页',
    closeOtherTabs: '关闭其他标签页',
    closeAllTabs: '关闭所有标签页',
    closeTabsToRight: '关闭右侧标签页',
    exportConfig: '导出配置',
    exportToClipboard: '导出到剪贴板',
    exportToTxt: '导出为 txt 文件',
    importConfig: '导入配置',
    importFromClipboard: '从剪贴板导入',
    importFromTxt: '从 txt 文件导入',

    // 前置程序右键菜单
    duplicateAction: '复制',
    deleteAction: '删除',
    renameAction: '重命名',
    enableAction: '启用',
    disableAction: '禁用',
    expandAction: '展开设置',
    collapseAction: '折叠设置',

    // 任务右键菜单
    addTask: '添加任务',
    duplicateTask: '复制任务',
    deleteTask: '删除任务',
    renameTask: '重命名任务',
    enableTask: '启用任务',
    disableTask: '禁用任务',
    moveUp: '上移',
    moveDown: '下移',
    moveToTop: '置顶',
    moveToBottom: '置底',
    expandOptions: '展开选项',
    collapseOptions: '折叠选项',
    selectAll: '全选任务',
    deselectAll: '取消全选',
    expandAllTasks: '展开全部',
    collapseAllTasks: '折叠全部',
    runFromHere: '从此处运行',
    runSingleTask: '单独运行',
    runOnceTask: '单次运行',
    clearRunOnceTask: '取消单次运行',

    // 截图面板右键菜单
    reconnect: '重新连接',
    forceRefresh: '强制刷新',
    startStream: '开始实时流',
    stopStream: '停止实时流',
    fullscreen: '全屏显示',
    saveScreenshot: '保存截图',
    copyScreenshot: '复制截图',

    // 连接面板右键菜单
    refreshDevices: '刷新设备列表',
    disconnect: '断开连接',

    // 通用
    openFolder: '打开所在文件夹',
  },

  // 版本警告
  versionWarning: {
    title: 'MaaFramework 版本过低',
    message:
      '当前 MaaFramework 版本 ({{current}}) 低于最低支持版本 ({{minimum}})，部分功能可能无法正常工作。',
    suggestion: '请联系项目开发者更新 MaaFramework 版本。',
    understand: '我已了解',
  },

  // 权限提示
  permission: {
    title: '需要管理员权限',
    message: '当前控制器需要管理员权限才能正常操作目标窗口。请以管理员身份重启应用。',
    hint: '重启后将自动恢复当前配置。',
    restart: '以管理员身份重启',
    restarting: '正在重启...',
  },

  // 加载屏幕
  loadingScreen: {
    loadingInterface: '正在加载 interface.json...',
    loadFailed: '加载失败',
    retry: '重试',
  },

  // VC++ 运行库
  vcredist: {
    title: '缺少运行库',
    description: 'MaaFramework 需要 Microsoft Visual C++ 运行库才能正常工作。',
    downloading: '正在下载运行库...',
    downloadFailed: '下载失败',
    waitingInstall: '正在等待安装完成，请在弹出的安装程序中完成安装...',
    retrying: '正在重新加载...',
    success: '运行库安装成功！',
    stillFailed: '安装完成，但加载仍然失败。请重启电脑后再试。',
    restartHint: '如果问题仍然存在，请重启电脑后再试。',
    retry: '重试',
  },

  // 连接断开提示（WebUI 模式）
  connectionLost: {
    title: '连接已断开',
    message: '与后端服务的连接已中断，正在尝试重新连接...',
    reconnecting: '重连中...',
  },

  // WebUI 测试版横幅
  webuiBeta: {
    message: 'Web UI 当前为测试版本，部分功能可能不够稳定。如遇到问题，欢迎前往 GitHub',
    reportIssue: '提交 Issue',
    desktopHint: '如需更稳定的体验，建议使用桌面客户端',
  },

  // 程序路径问题提示
  badPath: {
    title: '程序位置不对',
    rootTitle: '别把程序放在磁盘根目录啦！',
    rootDescription:
      '程序放在 C盘、D盘 这种根目录下会出问题的。找个文件夹放进去再用吧，比如「D:\\MyApps\\」之类的。',
    tempTitle: '你好像直接双击压缩包里的程序了',
    tempDescription:
      '程序现在在临时目录里跑着呢，一关掉可能就没了。先把压缩包解压到一个文件夹里，再打开里面的程序吧。',
    hint: '小提示：建议解压到一个专门的文件夹，比如「D:\\MaaXXX」，别放桌面或者下载文件夹，那样更方便管理。',
    exit: '退出程序',
  },
};
