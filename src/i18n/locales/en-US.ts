export default {
  // Common
  common: {
    confirm: 'Confirm',
    cancel: 'Cancel',
    undo: 'Undo',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    add: 'Add',
    open: 'Open',
    close: 'Close',
    reset: 'Reset',
    loading: 'Loading...',
    error: 'Error',
    success: 'Success',
    warning: 'Warning',
    info: 'Info',
    resizeOrCollapse: 'Drag to resize, drag to the right edge to collapse',
    copySuffix: ' (Copy)',
    desktopOnly: 'Desktop only',
  },

  // Title bar
  titleBar: {
    newTab: 'New Tab',
    closeTab: 'Close Tab',
    settings: 'Settings',
    about: 'About',
    renameInstance: 'Rename Instance',
    instanceName: 'Instance Name',
    dragToReorder: 'Drag to reorder',
    closeTabConfirmTitle: 'Close Tab',
    closeTabConfirmMessage: 'Are you sure you want to close "{{name}}"?',
    closeMultiTabConfirmTitle: 'Close Tabs',
    closeMultiTabConfirmMessage: 'Are you sure you want to close {{count}} tabs?',
  },

  // Window controls
  windowControls: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore',
    close: 'Close',
  },

  // Settings
  settings: {
    title: 'Settings',
    appearance: 'Appearance',
    hotkeys: 'Hotkeys',
    general: 'General',
    taskSettings: 'Task Settings',
    taskSettingsEmpty: 'No settings available to display',
    language: 'Language',
    backgroundImage: 'Background Image',
    backgroundOpacity: 'Background Opacity',
    selectBackgroundImage: 'Select Background',
    removeBackgroundImage: 'Remove Background',
    languageSystem: 'System',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    accentColor: 'Accent Color',
    themeSystem: 'System',
    showOptionPreview: 'Show Option Preview',
    showOptionPreviewHint: 'Display quick preview of options in the task list',
    openLogDir: 'Open Log Directory',
    // Custom accents
    customAccents: 'Custom Accents',
    addCustomAccent: 'Add',
    editCustomAccent: 'Edit Custom Accent',
    deleteCustomAccent: 'Delete',
    noCustomAccents: 'No custom accents yet',
    customAccentNameRequired: 'Please enter a name',
    deleteCustomAccentConfirm: 'Are you sure you want to delete this custom accent?',
    openNav: 'Open navigation menu',
    closeNav: 'Close navigation menu',
    customAccentDeleted: 'Deleted {{name}}',
    accentName: 'Name',
    accentNamePlaceholder: 'e.g. Dark Violet',
    autoAccentName: '{{hex}}',
    accentMainColor: 'Main Color',
    accentHoverColor: 'Hover Color',
    accentLightColor: 'Light Background',
    accentLightDarkColor: 'Dark Background',
    accentColorConfig: 'Color Configuration',
    accentPreview: 'Preview',
    accentPreviewMainButton: 'Primary Button',
    accentPreviewLightBg: 'Light Background',
    accentPreviewDarkBg: 'Dark Background',
    hotkeysStartTasks: 'Start Tasks Hotkey',
    hotkeysStopTasks: 'Stop Tasks Hotkey',
    hotkeysHint:
      'Effective only on the main screen, used to start/stop tasks of the current instance. Modifier combinations are supported (e.g. Ctrl+F10, Ctrl+Shift+F11); plain F5/F12 remain reserved by the system/browser.',
    hotkeysConflict: 'Start and stop hotkeys should not be the same. Please choose different keys.',
    hotkeysModifierRequired:
      'A single key must be F1–F24. Add a modifier such as Ctrl, Alt, or Shift.',
    hotkeysGlobal: 'Global hotkeys',
    hotkeysGlobalHint: 'Enable hotkeys when window is not focused',
    hotkeysGlobalOnlyStart: 'only start works in global mode',
    hotkeysGlobalConflict:
      'Hotkey {{combo}} is already taken, so global hotkeys are currently inactive. Please pick another key, or check whether another program or a duplicate instance is holding this combination.',
    hotkeysGlobalRegisterFailed: 'Failed to register global hotkey {{combo}}: {{error}}',
    minimizeToTray: 'Minimize to tray on close',
    minimizeToTrayHint: 'Hide to system tray instead of exiting when clicking close button',
    autoStart: 'Launch at startup',
    autoStartHint: 'Automatically start this application when the system boots',
    autoStartInstance: 'Auto-execute on startup',
    autoStartInstanceHint:
      'Select a configuration to activate and run tasks automatically after startup. Scheduled tasks for other configurations will still run normally',
    autoStartInstanceNone: 'Do not auto-execute',
    autoStartInstanceRemoved:
      'Previously selected configuration "{{name}}" has been deleted. Auto-execute has been disabled',
    autoRunOnLaunch: 'Also auto-execute on manual launch',
    autoRunOnLaunchHint:
      'Automatically execute the selected configuration when manually opening the app (if disabled, only triggers on system startup)',
    confirmBeforeDelete: 'Confirm delete actions',
    confirmBeforeDeleteHint:
      'Show a confirmation dialog before delete/clear list and other dangerous actions.',
    helpImproveSoftware: 'Help Improve the Software',
    helpImproveSoftwareHint:
      'Anonymously send crash reports, task statistics, and relevant logs and error screenshots from failed tasks to help find common issues.',
    helpImproveSoftwareDisabledHint:
      'Anonymous data reporting is disabled in debug / development builds.',
    maxLogsPerInstance: 'Max logs per instance',
    maxLogsPerInstanceHint:
      'Oldest logs will be discarded when exceeding the limit (recommended 500–2000)',
    resetWindowLayout: 'Reset Window Layout',
    resetWindowLayoutHint: 'Restore window size to default and center the window',
    autoClearLogsOnLaunch: 'Auto-clear Runtime Logs',
    autoClearLogsOnLaunchHint:
      'Automatically clear runtime logs and debug files every time the project is launched',
  },

  // Special tasks
  specialTask: {
    sleep: {
      label: '⏳ Countdown',
      optionLabel: 'Countdown Settings',
      inputLabel: 'Wait Time (seconds)',
      inputError: 'Please enter a positive integer',
    },
    waitUntil: {
      label: '⏰ Wait Until',
      optionLabel: 'Time Settings',
      optionDescription:
        'Waits until the specified time before continuing. Only supports within 24 hours. If the target time has passed today, it will wait until that time tomorrow',
      inputLabel: 'Target Time',
    },
    launch: {
      label: '▶️ Custom Program',
      optionLabel: 'Program Settings',
      programLabel: 'Program Path',
      programPlaceholder: 'Enter program path or click browse...',
      argsLabel: 'Additional Arguments',
      argsPlaceholder: 'Enter additional arguments (optional)',
      waitLabel: 'Wait for Exit',
      waitDescription:
        'When disabled, continues immediately after launch; when enabled, waits for the process to exit before continuing, suitable for scripts that need to complete synchronously',
      waitYes: 'Wait for program to exit before continuing',
      waitNo: 'Continue immediately after launch',
      skipLabel: 'Skip if Running',
      skipDescription:
        'When enabled, skips launching if the program is already running to avoid duplicates',
      skipYes: 'Skip launch if already running',
      skipNo: 'Always launch new instance',
      cmdLabel: 'Launch via cmd',
      cmdDescription:
        'When enabled, launches the program via cmd /c to detach from the current process tree. Some games may detect the process tree (Windows only)',
      cmdYes: 'Launch via cmd /c',
      cmdNo: 'Launch as direct subprocess',
    },
    notify: {
      label: '💬 System Notification',
      optionLabel: 'Notification Settings',
      titleLabel: 'Title',
      titlePlaceholder: 'Enter notification title',
      bodyLabel: 'Content',
      bodyPlaceholder: 'Enter notification content',
    },
    webhook: {
      label: '🔔 Webhook',
      optionLabel: 'Request Settings',
      urlLabel: 'Request URL',
      urlPlaceholder: 'Enter full URL (e.g. https://example.com/webhook?key=xxx)',
    },
    killProc: {
      label: '⛔ Kill Process',
      selfLabel: 'Kill Self',
      selfDescription:
        'When enabled, terminates this application itself; when disabled, you can enter another process name to kill',
      selfYes: 'Kill self',
      selfNo: 'Kill specified process',
      nameOptionLabel: 'Process Settings',
      nameLabel: 'Process Name',
      namePlaceholder: 'Enter process name (e.g. notepad.exe)',
    },
    power: {
      label: '⚡ Power Action',
      optionLabel: 'Action Type',
      shutdown: 'Shutdown',
      restart: 'Restart',
      screenoff: 'Turn Off Screen',
      sleep: 'Sleep',
      mute: 'Mute',
      unmute: 'Unmute',
    },
  },

  // Task list
  taskList: {
    title: 'Task List',
    selectAll: 'Select All',
    deselectAll: 'Deselect All',
    collapseAll: 'Collapse All',
    expandAll: 'Expand All',
    addTask: 'Add Task',
    noTasks: 'No tasks',
    dragToReorder: 'Drag to reorder',
    startTasks: 'Start Tasks',
    stopTasks: 'Stop Tasks',
    startingTasks: 'Starting...',
    stoppingTasks: 'Stopping...',
    tasksSkippedDueToIncompatibility: '{{count}} incompatible task(s) skipped',
    taskSkippedController: 'Task "{{taskName}}" does not support current controller',
    taskSkippedResource: 'Task "{{taskName}}" does not support current resource',
    noCompatibleTasks: 'No tasks compatible with current controller and resource',
    checkboxTaskScope: 'task "{{task}}"',
    checkboxGlobalScope: 'global settings',
    checkboxMinimumNotMet:
      'Option "{{option}}" in {{scope}} requires at least {{min}} selections; currently {{count}}',
    checkboxMaximumExceeded:
      'Option "{{option}}" in {{scope}} allows at most {{max}} selections; currently {{count}}',
    // Auto connect
    autoConnect: {
      searching: 'Searching devices...',
      searchingWindow: 'Searching windows...',
      connecting: 'Connecting device...',
      connectingWindow: 'Connecting window...',
      loadingResource: 'Loading resource...',
      deviceNotFound: 'Device not found: {{name}}',
      windowNotFound: 'Window not found: {{name}}',
      noSavedDevice: 'No saved device configuration',
      noDeviceFound: 'No devices found',
      noWindowFound: 'No windows found',
      connectFailed: 'Auto connect failed',
      retryConnect: 'Connection failed, retry {{attempt}}...',
      autoSelectedDevice:
        'No device was previously selected. Automatically matched "{{name}}". To change, select manually in Connection Settings — your choice will be remembered next time.',
      autoSelectedWindow:
        'No window was previously selected. Automatically matched "{{name}}". To change, select manually in Connection Settings — your choice will be remembered next time.',
      resourceFailed: 'Resource loading failed',
      startFailed: 'Failed to start tasks',
      alreadyRunning: 'Tasks are already running or a pre-action is still in progress',
      taskNotFound: 'The specified task does not exist or has been deleted',
      noRunnableTasks: 'No runnable tasks; check the task definitions and entry configuration',
      workstationLocked: 'The computer is locked. Please unlock it before running tasks.',
      agentStartParams: 'Agent #{{index}} start params: {{cmd}}  (cwd: {{cwd}})',
      agentSpawnHintFileNotFound:
        'Check whether antivirus blocked the Agent, then reinstall by overwriting the installation.',
      agentSpawnHintAppControl:
        'Turn off Smart App Control under Windows Security → App & browser control, then retry.',
      needConfig:
        'Please connect device and load resource first, or save device config in connection panel',
    },
  },

  // Task item
  taskItem: {
    options: 'Options',
    noOptions: 'No configurable options',
    enabled: 'Enabled',
    disabled: 'Disabled',
    expand: 'Expand options',
    collapse: 'Collapse options',
    remove: 'Remove task',
    removeConfirmTitle: 'Delete task',
    removeConfirmMessage: 'Are you sure you want to delete this task?',
    rename: 'Rename',
    clickToToggle: 'Click to toggle',
    runOnceHint: 'Run once: included in the next start only',
    renameTask: 'Rename Task',
    customName: 'Custom Name',
    originalName: 'Original Name',
    cannotEditRunningTask: 'Cannot edit options for running or completed tasks',
    // Description content loading
    loadingDescription: 'Loading description...',
    loadedFromFile: 'Content loaded from local file',
    loadedFromUrl: 'Content loaded from URL',
    loadDescriptionFailed: 'Failed to load',
    // Task run status
    status: {
      idle: 'Not started',
      pending: 'Pending',
      running: 'Running',
      succeeded: 'Completed',
      failed: 'Failed',
    },
    // Task compatibility
    incompatibleController: 'Not supported by current controller',
    incompatibleResource: 'Not supported by current resource',
    supportedControllers: 'Only: {{controllers}}',
  },

  // Options
  option: {
    select: 'Please select',
    input: 'Please enter',
    yes: 'Yes',
    no: 'No',
    invalidInput: 'Invalid input format',
  },

  action: {
    preAction: '▶️ Pre-Program',
    program: 'Program Path',
    programPlaceholder: 'Enter program path or browse...',
    args: 'Arguments',
    argsPlaceholder: 'Enter additional arguments (optional)',
    browse: 'Browse',
    waitForExit: 'Wait for Exit',
    waitForExitHintPre:
      'When disabled, continues immediately after launching the process and polls for device connection, suitable for asynchronous scenarios like launching games; when enabled, blocks until the process exits before continuing, suitable for synchronous operations like running scripts',
    skipIfRunning: 'Skip if Running',
    skipIfRunningHint:
      'When enabled, skips execution if the program is already running, useful for avoiding restarting games or other applications',
    useCmd: 'Launch via cmd',
    useCmdHint:
      'When enabled, launches the program via cmd /c to detach from the current process tree. Some games may detect the process tree (Windows only)',
    preActionSkipped: 'Pre-program {{name}} is already running, skipped',
    waitingForDevice: 'Waiting for device to be ready...',
    waitingForWindow: 'Waiting for window to be ready...',
    waitingForDeviceNamed: 'Waiting for device "{{name}}" to be ready...',
    waitingForWindowNamed: 'Waiting for window "{{name}}" to be ready...',
    waitingForAnyDevice:
      'Waiting for any matching device to appear. If this is not the target device, please select manually in Connection Settings before starting.',
    waitingForAnyWindow:
      'Waiting for any matching window to appear. If this is not the target window, please select manually in Connection Settings before starting.',
    deviceReady: 'Device is ready',
    windowReady: 'Window is ready',
    deviceWaitTimeout: 'Device wait timeout',
    windowWaitTimeout: 'Window wait timeout',
    preActionStarting: 'Running pre-program...',
    preActionStartingNamed: 'Running pre-program: {{name}}...',
    preActionCompleted: 'Pre-program completed',
    preActionCompletedNamed: 'Pre-program {{name}} completed',
    preActionFailed: 'Pre-program failed: {{error}}',
    preActionExitCode: 'Pre-program exit code: {{code}}',
    pretaskStarting: 'Running pre-task: {{name}}',
    pretaskCompleted: 'Pre-task completed: {{name}}',
    pretaskExitCode: 'Pre-task exit code: {{code}}',
    pretaskFailed: 'Pre-task failed: {{error}}',
    preActionConnectDelay: 'Waiting {{seconds}} seconds before connecting...',
    autoPreActionName: '▶️ Launch {{name}}',
    autoPreActionAdded: 'Auto-added pre-action: {{name}} (disabled by default)',
    removeConfirmTitle: 'Delete pre-action',
    removeConfirmMessage: 'Are you sure you want to delete this pre-action?',
  },

  // Option Editor
  optionEditor: {
    loadingDescription: 'Loading description...',
    loadedFromFile: 'Content loaded from local file',
    loadedFromUrl: 'Content loaded from URL',
    loadDescriptionFailed: 'Failed to load',
    searchPlaceholder: 'Search options...',
    noMatchingOptions: 'No matching options',
    incompatibleController: 'Not supported by current controller',
    incompatibleResource: 'Not supported by current resource',
    hotkeyPlaceholder: 'Click to record shortcut',
    hotkeyCapturing: 'Press keys...',
    expandOptions: 'Expand sub-options',
    collapseOptions: 'Collapse sub-options',
    checkboxCountRange: 'at least {{min}}, at most {{max}}',
    checkboxCountMinimum: 'at least {{min}}',
    checkboxCountMaximum: 'at most {{max}}',
    checkboxSelectedCount: '{{count}} selected ({{constraint}})',
    checkboxMinimumRequired: 'Select at least {{min}} (currently {{count}})',
    checkboxMaximumReached: 'You can select at most {{max}}',
  },

  // Preset
  preset: {
    title: 'Choose a Preset',
    hint: 'Apply a predefined task configuration to get started quickly',
    taskCount: 'tasks',
    skipToManual: 'Skip, add tasks manually',
    importConfig: 'Import config from clipboard',
    importConfigFromFile: 'Import config from file',
    importSuccess: 'Config imported successfully',
    importFailed: 'Import failed: invalid format',
    importProjectMismatch: 'Import failed: project mismatch',
    importVersionUnsupported:
      'Import failed: this config was exported by a newer version of {{projectName}}, please update {{projectName}} and try again',
    exportSuccess: 'Config copied to clipboard',
    exportFailed: 'Export failed: unable to write to clipboard',
    exportFileSuccess: 'Config exported as txt file',
    exportFileFailed: 'Export failed: unable to write file',
    exportShareHint: 'Sharing my {{projectName}} config "{{tabName}}" with you~',
    exportShareFooter:
      '👆 Copy this message, open {{projectName}}, create a new tab, and tap "Import Config" to use it instantly',
  },

  // Controller
  controller: {
    title: 'Controller',
    selectController: 'Select Controller',
    adb: 'Android Device',
    win32: 'Windows Window',
    wlroots: 'WlRoots (Linux)',
    linux: 'Linux',
    portal: 'Portal',
    uinputWidth: 'Width (px)',
    uinputHeight: 'Height (px)',
    playcover: 'PlayCover (macOS)',
    macos: 'macOS Window',
    macosPermissionsRequired:
      'Screen Recording and Accessibility permissions are required. Grant them in macOS System Settings under Privacy & Security, then try again.',
    macosUnsupportedPlatform: 'The native macOS window controller is only available on macOS.',
    macosVersionRequired:
      'The native macOS window controller requires MaaFramework v5.10.0-beta.1 or later.',
    macosSystemVersionRequired: 'The native macOS window controller requires macOS 14.0 or later.',
    macosSystemVersionDetectionFailed:
      'The current macOS version could not be detected. Check the logs for details.',
    linuxVersionRequired: 'The Linux controller requires MaaFramework v5.13.0-beta.3 or later.',
    gamepad: 'Gamepad',
    connecting: 'Connecting...',
    connected: 'Connected',
    disconnected: 'Disconnected',
    connectionFailed: 'Connection failed',
    refreshDevices: 'Refresh Devices',
    refreshWindows: 'Refresh Windows',
    refresh: 'Refresh Devices',
    connect: 'Connect',
    disconnect: 'Disconnect',
    selectDevice: 'Select a device',
    selectWindow: 'Select a window',
    noDevices: 'No devices found',
    noWindows: 'No windows found',
    playcoverHint: 'Enter PlayCover app listen address',
    lastSelected: 'Last selected · Click to search',
    savedDeviceNotFound: 'Previous device not found, please check connection or select another',
    savedWindowNotFound: 'Previous window not found, please check connection or select another',
    connectedLog: 'Connected controller [{{name}}]',
  },

  // Resource
  resource: {
    title: 'Resource',
    selectResource: 'Select Resource',
    loading: 'Loading resource...',
    loaded: 'Resource loaded',
    loadFailed: 'Failed to load resource',
    loadResource: 'Load Resource',
    switchFailed: 'Failed to switch resource',
    cannotSwitchWhileRunning: 'Cannot switch resource while tasks are running',
    hashMismatch:
      'Resource integrity check failed (expected: {{expected}}, actual: {{actual}}). Consider re-downloading the resource package.',
    incompatibleController: 'Not supported by current controller',
  },

  // MaaFramework
  maa: {
    notInitialized: 'MaaFramework not initialized',
    initFailed: 'Initialization failed',
    version: 'Version',
    needConnection: 'Please connect a device first',
    needResource: 'Please load resources first',
  },

  // Screenshot preview
  screenshot: {
    title: 'Live Screenshot',
    autoRefresh: 'Auto Refresh',
    noScreenshot: 'No screenshot',
    startStream: 'Start Live Stream',
    stopStream: 'Stop Live Stream',
    connectFirst: 'Please connect a device first',
    fullscreen: 'Fullscreen',
    exitFullscreen: 'Exit Fullscreen',
    clickHint: 'Click on the image to send a tap to the device',
    // Frame rate settings
    frameRate: {
      title: 'Screenshot Frame Rate',
      hint: 'Only affects preview smoothness and system resource usage, does not impact task recognition or execution',
      unlimited: 'Unlimited',
      fps5: '5 FPS',
      fps1: '1 FPS',
      every5s: 'Every 5s',
      every30s: 'Every 30s',
    },
  },

  // Logs
  logs: {
    title: 'Logs',
    clear: 'Clear',
    autoscroll: 'Auto Scroll',
    noLogs: 'No logs',
    copyAll: 'Copy All',
    showMoreLogs: 'Show more logs',
    expand: 'Expand panels above',
    collapse: 'Collapse panels above',
    scrollToLogs: 'View logs',
    // Log messages
    messages: {
      // Connection messages
      connecting: 'Connecting to {{target}}...',
      connected: '{{target}} connected:',
      connectFailed: '{{target}} connection failed:',
      targetDevice: 'device',
      targetWindow: 'window',
      // Resource loading messages
      loadingResource: 'Loading resource: {{name}}',
      resourceLoaded: 'Resource loaded: {{name}}',
      resourceFailed: 'Resource load failed: {{name}}',
      resourceFailedHint:
        'Try deleting the resource directory and reinstalling (overwrite) before retrying.',
      // Task messages
      taskStarting: 'Task started: {{name}}',
      taskSucceeded: 'Task completed: {{name}}',
      taskFailed: 'Task failed: {{name}}',
      stopTask: 'Stop Task',
      // Schedule messages
      scheduleStarting: 'Scheduled execution started [{{policy}}] {{time}}',
      // Agent messages
      agentStarting: 'Agent starting...',
      agentStarted: 'Agent started',
      agentConnected: 'Agent connected',
      agentDisconnected: 'Agent disconnected',
      agentFailed: 'Agent start failed',
      agentLogFloodWarning:
        'Agent is in a log flood state. To avoid performance issues, log display has been paused. The complete log is available in the local log file.',
      agentLogFloodRecovered: 'Agent log flood has eased',
      // Hotkeys
      hotkeyDetected: 'Hotkey detected: {{combo}} ({{action}})',
      hotkeyActionStart: 'Start tasks',
      hotkeyActionStop: 'Stop tasks',
      hotkeyStartSuccess: 'Started tasks via hotkey:',
      hotkeyStopSuccess: 'Stopped tasks via hotkey',
      hotkeyStopPending:
        'The stop request was sent, but the task is still waiting for the current operation to exit.',
      hotkeyStopFailed: 'Failed to stop tasks via hotkey',
    },
  },

  // Add task panel
  addTaskPanel: {
    title: 'Add Task',
    searchPlaceholder: 'Search tasks...',
    noResults: 'No matching tasks found',
    alreadyAdded: 'Already added',
    collapse: 'Collapse panel',
    specialTasks: 'Special Tasks',
    pretasks: 'Pre-tasks',
    allSpecialTasksAdded: 'All added',
    ungroupedTasks: 'Others',
    resizeHandleAriaLabel: 'Resize add task panel height',
  },

  // About
  about: {
    title: 'About',
    version: 'Version',
    description: 'Description',
    license: 'License',
    contact: 'Contact',
    github: 'GitHub Repository',
  },

  // Debug
  debug: {
    title: 'Debug',
    versions: 'Versions',
    interfaceVersion: '{{name}} version',
    maafwVersion: 'maafw version',
    mxuVersion: 'mxu version',
    environment: 'Environment',
    envTauri: 'Tauri Desktop',
    envBrowser: 'Browser',
    systemInfo: 'System Information',
    operatingSystem: 'Operating System',
    architecture: 'Architecture',
    tauriVersion: 'Tauri Version',
    pathInfo: 'Path Information',
    cwd: 'Current Working Directory',
    exeDir: 'Executable Directory',
    webview2Dir: 'WebView2 Directory',
    webview2System: 'System',
    resetWindowLayout: 'Reset Window Layout',
    openConfigDir: 'Open Config Dir',
    openLogDir: 'Open Log Dir',
    exportLogs: 'Export Logs',
    exportLogsHint:
      'Pack logs and config into a zip archive, keeping newest debug images until it reaches about 24.5 MB; when "Save debug images" is on, vision images are also included',
    exportingLogs: 'Exporting logs...',
    logsExported: 'Logs exported',
    exportLogsFailed: 'Failed to export logs',
    devMode: 'Developer Mode',
    devModeHint: 'Allow pressing F5 to refresh UI when enabled',
    saveDraw: 'Save Debug Images',
    saveDrawHint:
      'Save recognition and action debug images to log directory (auto-disabled on restart)',
    tcpCompatMode: 'Communication Compat Mode',
    tcpCompatModeHint:
      'Try enabling this if the app crashes immediately after starting tasks. Only use in this case, as it may reduce performance',
  },

  webserver: {
    title: 'Web Server',
    enabled: 'Enable Web Server',
    enabledHint: 'When disabled, the built-in web server will not start (restart required)',
    port: 'Web Server Port',
    portHint: 'Custom Web server listening port (default 12701, restart required)',
    allowLanAccess: 'Allow LAN Access',
    allowLanAccessHint:
      'When enabled, Web UI listens on 0.0.0.0, allowing other devices on the local network to access it',
    restartMessage: 'Changing Web server settings requires a restart to take effect. Restart now?',
    restartLater: 'Later',
    restartNow: 'Restart Now',
    address: 'Web Server Address',
  },

  // Config self-heal notices
  config: {
    recoveredFromBackup:
      'The config file was corrupted and has been restored from the {{time}} backup',
    recoveryFailed:
      'The config file was corrupted and no usable backup was found, so it has been reset to defaults',
  },

  // Welcome dialog
  welcome: {
    dismiss: 'Got it',
    viewAgain: 'View welcome message',
  },

  // Onboarding
  onboarding: {
    title: 'Connect a Device',
    message:
      'Select a device and load resources in the "Connection Settings" panel on the right — once done, you\'re ready to run tasks.',
    addTaskTitle: 'Add Tasks',
    addTaskMessage: 'Click here to browse available tasks and add the ones you need to the list.',
    tabBarTitle: 'Manage Configurations',
    tabBarMessage:
      'Use the tabs at the top to create or switch between configurations — for example, one for daily automation and another for real-time utilities. Each configuration maintains its own tasks and device settings independently.',
    next: 'Next',
    prev: 'Previous',
    gotIt: 'Got it',
    skipDev: 'Skip (DEV)',
  },

  // Instance
  instance: {
    defaultName: 'Config 1',
  },

  // Connection panel
  connection: {
    title: 'Connection Settings',
  },

  // Dashboard
  dashboard: {
    title: 'Dashboard',
    toggle: 'Dashboard View',
    exit: 'Exit Dashboard',
    instances: 'instances',
    noInstances: 'No instances',
    running: 'Running',
    succeeded: 'Succeeded',
    failed: 'Failed',
    noEnabledTasks: 'No enabled tasks',
    alignLeft: 'Align cards to left',
    alignCenter: 'Align cards to center',
    alignRight: 'Align cards to right',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
  },

  // Recently Closed
  recentlyClosed: {
    title: 'Recently Closed',
    empty: 'No recently closed tabs',
    reopen: 'Reopen',
    remove: 'Remove from list',
    clearAll: 'Clear all',
    clearAllConfirmTitle: 'Clear recently closed',
    clearAllConfirmMessage: 'Are you sure you want to clear the recently closed list?',
    justNow: 'Just now',
    minutesAgo: '{{count}} minutes ago',
    hoursAgo: '{{count}} hours ago',
    daysAgo: '{{count}} days ago',
    noTasks: 'No tasks',
    tasksCount: '{{first}} and {{count}} tasks',
  },

  // MirrorChyan Update
  mirrorChyan: {
    title: 'Update',
    debugModeNotice: 'Debug version detected, auto-update is disabled',
    channel: 'Update Channel',
    channelStable: 'Stable',
    channelBeta: 'Beta',
    cdk: 'MirrorChyan CDK',
    cdkPlaceholder: 'Enter your CDK (optional)',
    serviceName: 'MirrorChyan',
    cdkHintAfterLink:
      ' is an independent third-party accelerated download service that requires a paid subscription, not a fee charged by "{{projectName}}". Its operating costs are covered by subscription revenue, with a portion supporting project developers. Subscribe for high-speed downloads while supporting ongoing development. Without a CDK, downloads will fall back to GitHub. If that fails, please configure a network proxy.',
    getCdk: 'No CDKey? Subscribe Now',
    cdkHint: 'Please check if your CDK is correct or has expired',
    slowDownloadHint: 'Other channels',
    checkUpdate: 'Check for Updates',
    checking: 'Checking...',
    upToDate: 'You are up to date ({{version}})',
    newVersion: 'New Version Available',
    currentVersion: 'Current Version',
    latestVersion: 'Latest Version',
    releaseNotes: 'Release Notes',
    downloadNow: 'Download Now',
    later: 'Remind Later',
    dismiss: 'Skip This Version',
    noReleaseNotes: 'No release notes available',
    checkFailed: 'Failed to check for updates',
    checkFailedHint: 'Please check your network connection and try again',
    downloading: 'Downloading',
    downloadComplete: 'Download Complete',
    downloadFailed: 'Download Failed',
    viewDetails: 'View Details',
    noDownloadUrl: 'No download URL available. Please fill in CDK or check network environment',
    openFolder: 'Open Folder',
    retry: 'Retry',
    preparingDownload: 'Preparing download...',
    downloadFromGitHub: 'Download from GitHub',
    downloadFromMirrorChyan: 'Download via MirrorChyan CDN',
    // Update installation
    installing: 'Installing update...',
    installComplete: 'Installation Complete',
    installFailed: 'Installation Failed',
    installNow: 'Install Now',
    installUpdate: 'Install Update',
    installStages: {
      extracting: 'Extracting...',
      checking: 'Checking update type...',
      applying: 'Applying update...',
      cleanup: 'Cleaning up...',
      done: 'Update complete',
      incremental: 'Incremental update',
      full: 'Full update',
      fallback: 'Performing fallback update...',
    },
    restartRequired: 'Update installed. Please restart to apply changes.',
    restartNow: 'Restart Now',
    restarting: 'Restarting...',
    installerOpened: 'Installer Opened',
    installerOpenedHint: 'Please complete the installer, then restart this app after installation',
    // After update complete
    updateCompleteTitle: 'Update Complete',
    updateCompleteMessage: 'Successfully updated to the latest version',
    previousVersion: 'Previous Version',
    gotIt: 'Got it',
    // MirrorChyan API error codes
    errors: {
      1001: 'Invalid parameters, please check configuration',
      7001: 'CDK expired, please renew or replace your CDK',
      7002: 'Invalid CDK, please check your input',
      7003: 'CDK daily download quota exhausted',
      7004: 'CDK type does not match the resource',
      7005: 'CDK has been blocked, please contact support',
      8001: 'No resource available for current OS/architecture',
      8002: 'Invalid OS parameter',
      8003: 'Invalid architecture parameter',
      8004: 'Invalid update channel parameter',
      1: 'Service error, please try again later',
      unknown: 'Unknown error ({{code}}): {{message}}',
      negative: 'Server error, please contact technical support',
    },
  },

  // Schedule
  schedule: {
    title: 'Scheduled Tasks',
    button: 'Schedule',
    addPolicy: 'Add Schedule',
    defaultPolicyName: 'Schedule',
    policyName: 'Name',
    noPolicies: 'No schedules',
    noPoliciesHint: 'Add a schedule to run tasks automatically',
    repeatDays: 'Repeat Days',
    startTime: 'Start Time',
    selectDays: 'Select days...',
    addTime: 'Add time',
    noWeekdays: 'No days selected',
    noTimes: 'No times selected',
    everyday: 'Every day',
    timesSelected: 'times selected',
    timeZoneHint: 'Using local timezone',
    multiSelect: 'multi-select',
    enable: 'Enable schedule',
    disable: 'Disable schedule',
    enableAll: 'Enable all schedules',
    disableAll: 'Disable all schedules',
    hint: 'Scheduled tasks will run automatically at set times',
    executingPolicy: 'Running scheduled "{{name}}"',
    startedAt: 'Started at: {{time}}',
    deletePolicyTitle: 'Delete schedule',
    deletePolicyConfirm: 'Are you sure you want to delete schedule "{{name}}"?',
    // Index corresponds to Date.getDay(): 0=Sun, 1=Mon, ..., 6=Sat
    weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  },

  // Error messages
  errors: {
    loadInterfaceFailed: 'Failed to load interface.json',
    invalidInterface: 'Invalid interface.json format',
    invalidConfig: 'Invalid configuration file format',
    taskNotFound: 'Task not found',
    controllerNotFound: 'Controller not found',
    resourceNotFound: 'Resource not found',
  },

  // Context Menu
  contextMenu: {
    // Tab context menu
    newTab: 'New Tab',
    duplicateTab: 'Duplicate Tab',
    renameTab: 'Rename',
    moveLeft: 'Move Left',
    moveRight: 'Move Right',
    moveToFirst: 'Move to First',
    moveToLast: 'Move to Last',
    closeTab: 'Close Tab',
    closeOtherTabs: 'Close Other Tabs',
    closeAllTabs: 'Close All Tabs',
    closeTabsToRight: 'Close Tabs to the Right',
    exportConfig: 'Export Config',
    exportToClipboard: 'Export to Clipboard',
    exportToTxt: 'Export as txt File',
    importConfig: 'Import Config',
    importFromClipboard: 'Import from Clipboard',
    importFromTxt: 'Import from txt File',

    // Pre-action context menu
    duplicateAction: 'Duplicate',
    deleteAction: 'Delete',
    renameAction: 'Rename',
    enableAction: 'Enable',
    disableAction: 'Disable',
    expandAction: 'Expand Settings',
    collapseAction: 'Collapse Settings',

    // Task context menu
    addTask: 'Add Task',
    duplicateTask: 'Duplicate Task',
    deleteTask: 'Delete Task',
    renameTask: 'Rename Task',
    enableTask: 'Enable Task',
    disableTask: 'Disable Task',
    moveUp: 'Move Up',
    moveDown: 'Move Down',
    moveToTop: 'Move to Top',
    moveToBottom: 'Move to Bottom',
    expandOptions: 'Expand Options',
    collapseOptions: 'Collapse Options',
    selectAll: 'Select All Tasks',
    deselectAll: 'Deselect All',
    expandAllTasks: 'Expand All',
    collapseAllTasks: 'Collapse All',
    runFromHere: 'Run From Here',
    runSingleTask: 'Run This Task Only',
    runOnceTask: 'Run Once',
    clearRunOnceTask: 'Clear Run Once',

    // Screenshot panel context menu
    reconnect: 'Reconnect',
    forceRefresh: 'Force Refresh',
    startStream: 'Start Live Stream',
    stopStream: 'Stop Live Stream',
    fullscreen: 'Fullscreen',
    saveScreenshot: 'Save Screenshot',
    copyScreenshot: 'Copy Screenshot',

    // Connection panel context menu
    refreshDevices: 'Refresh Device List',
    disconnect: 'Disconnect',

    // Common
    openFolder: 'Open Containing Folder',
  },

  // Version warning
  versionWarning: {
    title: 'MaaFramework Version Too Low',
    message:
      'Current MaaFramework version ({{current}}) is lower than the minimum supported version ({{minimum}}). Some features may not work properly.',
    suggestion: 'Please contact the project developer to update MaaFramework.',
    understand: 'I Understand',
  },

  // Permission prompt
  permission: {
    title: 'Administrator Privileges Required',
    message:
      'The current controller requires administrator privileges to interact with the target window. Please restart the application as administrator.',
    hint: 'Your current configuration will be restored after restart.',
    restart: 'Restart as Administrator',
    restarting: 'Restarting...',
  },

  // Loading screen
  loadingScreen: {
    loadingInterface: 'Loading interface.json...',
    loadFailed: 'Loading Failed',
    retry: 'Retry',
  },

  // VC++ Runtime
  vcredist: {
    title: 'Missing Runtime',
    description: 'MaaFramework requires Microsoft Visual C++ Runtime to work properly.',
    downloading: 'Downloading runtime...',
    downloadFailed: 'Download Failed',
    waitingInstall:
      'Waiting for installation. Please complete the installation in the installer window...',
    retrying: 'Reloading...',
    success: 'Runtime installed successfully!',
    stillFailed:
      'Installation complete, but loading still failed. Please restart your computer and try again.',
    restartHint: 'If the problem persists, please restart your computer and try again.',
    retry: 'Retry',
  },

  // Connection lost (WebUI mode)
  connectionLost: {
    title: 'Connection Lost',
    message: 'The connection to the backend has been lost. Attempting to reconnect...',
    reconnecting: 'Reconnecting...',
  },

  // WebUI beta banner
  webuiBeta: {
    message:
      'Web UI is currently in beta — some features may be unstable. If you encounter any issues, please',
    reportIssue: 'submit an Issue on GitHub',
    desktopHint: 'For a more stable experience, consider using the desktop client',
  },

  // Bad path warning
  badPath: {
    title: 'Wrong Location',
    rootTitle: "Don't put the program in the disk root!",
    rootDescription:
      'Running from the root of a drive (like C:\\ or D:\\) can cause issues. Please move it to a folder, like "D:\\MyApps\\".',
    tempTitle: 'Looks like you ran it directly from the archive',
    tempDescription:
      'The program is running from a temporary folder. It may disappear when closed. Please extract the archive to a folder first, then run the program from there.',
    hint: 'Tip: We recommend extracting to a dedicated folder like "D:\\MaaXXX". Avoid Desktop or Downloads for easier management.',
    exit: 'Exit',
  },
  // Proxy Settings
  proxy: {
    title: 'Network Proxy',
    url: 'Proxy URL',
    urlPlaceholder: 'e.g., http://127.0.0.1:7890',
    urlHint: 'Supports HTTP/SOCKS5, leave empty to disable proxy',
    urlHintDisabled: 'MirrorChyan CDK filled, proxy is disabled',
    invalid: 'Invalid proxy URL format',
    examples: 'Example Formats',
  },
};
