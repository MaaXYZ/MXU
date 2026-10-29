export default {
  // 공통
  common: {
    confirm: '확인',
    cancel: '취소',
    undo: '실행 취소',
    save: '저장',
    delete: '삭제',
    edit: '편집',
    add: '추가',
    open: '열기',
    close: '닫기',
    loading: '로딩 중...',
    error: '오류',
    success: '성공',
    warning: '경고',
    info: '알림',
    resizeOrCollapse: '드래그하여 너비 조정, 오른쪽 끝까지 드래그하면 접기',
    copySuffix: ' (복사)',
    desktopOnly: '데스크톱 전용',
  },

  // 타이틀바
  titleBar: {
    newTab: '새 탭',
    closeTab: '탭 닫기',
    settings: '설정',
    about: '정보',
    renameInstance: '인스턴스 이름 변경',
    instanceName: '인스턴스 이름',
    dragToReorder: '드래그하여 순서 변경',
    closeTabConfirmTitle: '탭 닫기',
    closeTabConfirmMessage: '"{{name}}"을(를) 닫으시겠습니까?',
    closeMultiTabConfirmTitle: '탭 여러 개 닫기',
    closeMultiTabConfirmMessage: '{{count}}개의 탭을 닫으시겠습니까?',
  },

  // 창 컨트롤
  windowControls: {
    minimize: '최소화',
    maximize: '최대화',
    restore: '복원',
    close: '닫기',
  },

  // 설정
  settings: {
    title: '설정',
    appearance: '외관',
    hotkeys: '단축키',
    general: '일반',
    taskSettings: '작업 설정',
    taskSettingsEmpty: '표시할 수 있는 설정 항목이 없습니다',
    language: '언어',
    backgroundImage: '배경 이미지',
    backgroundOpacity: '배경 불투명도',
    selectBackgroundImage: '배경 선택',
    removeBackgroundImage: '배경 제거',
    languageSystem: '시스템',
    theme: '테마',
    themeLight: '라이트',
    themeDark: '다크',
    accentColor: '강조 색상',
    themeSystem: '시스템 설정',
    showOptionPreview: '옵션 미리보기 표시',
    showOptionPreviewHint: '작업 목록에 옵션의 빠른 미리보기를 표시합니다',
    openLogDir: '로그 폴더 열기',
    // 사용자 지정 강조 색상
    customAccents: '사용자 지정 강조 색상',
    addCustomAccent: '추가',
    editCustomAccent: '사용자 지정 강조 색상 편집',
    deleteCustomAccent: '삭제',
    noCustomAccents: '사용자 지정 강조 색상이 없습니다',
    customAccentNameRequired: '이름을 입력하세요',
    deleteCustomAccentConfirm: '이 사용자 지정 강조 색상을 삭제하시겠습니까?',
    openNav: '내비게이션 열기',
    closeNav: '내비게이션 닫기',
    customAccentDeleted: '{{name}} 삭제됨',
    accentName: '이름',
    accentNamePlaceholder: '예: 다크 바이올렛',
    autoAccentName: '{{hex}}',
    accentMainColor: '메인 색상',
    accentHoverColor: '호버 색상',
    accentLightColor: '라이트 배경',
    accentLightDarkColor: '다크 배경',
    accentColorConfig: '색상 구성',
    accentPreview: '미리보기',
    accentPreviewMainButton: '주요 버튼',
    accentPreviewLightBg: '라이트 배경',
    accentPreviewDarkBg: '다크 배경',
    hotkeysStartTasks: '작업 시작 단축키',
    hotkeysStopTasks: '작업 중지 단축키',
    hotkeysHint:
      '메인 화면에서만 동작하며, 현재 인스턴스의 작업 시작 / 중지에 사용됩니다. Ctrl+F10, Ctrl+Shift+F11 과 같은 조합키도 지원합니다. F5 / F12 단독 키는 계속해서 시스템 / 브라우저용으로 예약됩니다.',
    hotkeysConflict: '시작과 중지 단축키는 서로 다른 키여야 합니다. 다른 키를 선택해 주세요.',
    hotkeysModifierRequired:
      '단일 키는 F1–F24만 사용할 수 있습니다. Ctrl, Alt, Shift 같은 보조 키를 함께 누르세요.',
    hotkeysGlobal: '전역 단축키',
    hotkeysGlobalHint: '창이 비활성화되어도 단축키 사용',
    hotkeysGlobalOnlyStart: '전역 모드에서는 시작만 작동',
    hotkeysGlobalConflict:
      '단축키 {{combo}}이(가) 이미 사용 중이어서 전역 단축키가 현재 작동하지 않습니다. 다른 키로 변경하거나, 다른 프로그램 또는 중복 실행된 인스턴스가 해당 조합을 사용하고 있는지 확인해 주세요.',
    hotkeysGlobalRegisterFailed: '전역 단축키 {{combo}} 등록 실패: {{error}}',
    minimizeToTray: '닫을 때 트레이로 최소화',
    minimizeToTrayHint: '닫기 버튼을 클릭하면 종료하지 않고 시스템 트레이에 숨깁니다',
    autoStart: '시작 시 자동 실행',
    autoStartHint: '시스템 부팅 시 이 애플리케이션을 자동으로 시작합니다',
    autoStartInstance: '시작 후 자동 실행',
    autoStartInstanceHint:
      '시작 후 자동으로 활성화하고 작업을 실행할 구성을 선택합니다. 다른 구성의 예약 작업은 정상적으로 실행됩니다',
    autoStartInstanceNone: '자동 실행 안 함',
    autoStartInstanceRemoved:
      '이전에 선택한 구성 "{{name}}"이(가) 삭제되었습니다. 자동 실행이 비활성화되었습니다',
    autoRunOnLaunch: '수동 실행 시에도 자동 실행',
    autoRunOnLaunchHint:
      '앱을 수동으로 열 때도 위에서 선택한 구성을 자동 실행합니다 (비활성화 시 시스템 시작 시에만 실행)',
    confirmBeforeDelete: '삭제 작업 확인',
    confirmBeforeDeleteHint: '삭제/목록 비우기 등 위험한 작업 전에 확인 대화 상자를 표시합니다',
    helpImproveSoftware: '소프트웨어 개선에 참여',
    helpImproveSoftwareHint:
      '충돌, 작업 통계, 실패한 작업의 관련 로그와 오류 스크린샷을 익명으로 전송하여 일반적인 문제를 찾는 데 도움을 줍니다.',
    helpImproveSoftwareDisabledHint: '디버그 / 개발 버전에서는 익명 데이터 전송이 비활성화됩니다',
    maxLogsPerInstance: '인스턴스당 로그 최대 개수',
    maxLogsPerInstanceHint: '한도를 초과하면 가장 오래된 로그가 자동으로 삭제됩니다(권장 500~2000)',
    resetWindowLayout: '창 레이아웃 초기화',
    resetWindowLayoutHint: '창 크기를 기본값으로 복원하고 화면 중앙에 배치합니다',
    autoClearLogsOnLaunch: '로그 자동 지우기',
    autoClearLogsOnLaunchHint: '프로젝트를 시작할 때 런타임 로그와 디버그 파일을 자동으로 지웁니다',
  },

  // 특수 작업
  specialTask: {
    sleep: {
      label: '⏳ 카운트다운',
      optionLabel: '카운트다운 설정',
      inputLabel: '대기 시간(초)',
      inputError: '양의 정수를 입력해 주세요',
    },
    waitUntil: {
      label: '⏰ 시간까지 대기',
      optionLabel: '시간 설정',
      optionDescription:
        '지정된 시간까지 대기한 후 계속합니다. 24시간 이내만 지원됩니다. 대상 시간이 이미 지났으면 다음 날 해당 시간까지 대기합니다',
      inputLabel: '대상 시간',
    },
    launch: {
      label: '▶️ 사용자 지정 프로그램',
      optionLabel: '프로그램 설정',
      programLabel: '프로그램 경로',
      programPlaceholder: '프로그램 경로를 입력하거나 오른쪽 찾아보기를 클릭...',
      argsLabel: '추가 인수',
      argsPlaceholder: '추가 인수 입력 (선택 사항)',
      waitLabel: '종료 대기',
      waitDescription:
        '비활성화하면 실행 후 즉시 계속합니다. 활성화하면 프로세스 종료 후 계속합니다. 스크립트 등 동기 완료가 필요한 작업에 적합합니다',
      waitYes: '프로그램 종료 후 계속',
      waitNo: '실행 후 즉시 계속',
      skipLabel: '실행 중이면 건너뛰기',
      skipDescription:
        '활성화하면 프로그램이 이미 실행 중일 때 중복 실행을 방지하기 위해 시작을 건너뜁니다',
      skipYes: '이미 실행 중이면 시작 건너뛰기',
      skipNo: '항상 새 인스턴스 시작',
      cmdLabel: 'cmd로 실행',
      cmdDescription:
        '활성화하면 cmd /c로 프로그램을 실행하여 현재 프로세스 트리에서 분리합니다. 일부 게임은 프로세스 트리를 감지할 수 있습니다 (Windows 전용)',
      cmdYes: 'cmd /c로 실행',
      cmdNo: '직접 서브프로세스로 실행',
    },
    notify: {
      label: '💬 시스템 알림',
      optionLabel: '알림 설정',
      titleLabel: '알림 제목',
      titlePlaceholder: '알림 제목을 입력하세요',
      bodyLabel: '알림 내용',
      bodyPlaceholder: '알림 내용을 입력하세요',
    },
    webhook: {
      label: '🔔 Webhook',
      optionLabel: '요청 설정',
      urlLabel: '요청 URL',
      urlPlaceholder: '전체 URL을 입력하세요 (예: https://example.com/webhook?key=xxx)',
    },
    killProc: {
      label: '⛔ 프로세스 종료',
      selfLabel: '자체 프로세스 종료',
      selfDescription:
        '활성화하면 이 프로그램 자체를 종료합니다. 비활성화하면 다른 프로세스 이름을 입력하여 종료할 수 있습니다',
      selfYes: '자체 종료',
      selfNo: '지정 프로세스 종료',
      nameOptionLabel: '프로세스 설정',
      nameLabel: '프로세스 이름',
      namePlaceholder: '종료할 프로세스 이름을 입력하세요 (예: notepad.exe)',
    },
    power: {
      label: '⚡ PC 작업',
      optionLabel: '작업 유형',
      shutdown: '종료',
      restart: '재시작',
      screenoff: '화면 끄기',
      sleep: '절전 모드',
      hibernate: '최대 절전 모드',
      mute: '음소거',
      unmute: '음소거 해제',
    },
  },

  // 작업 목록
  taskList: {
    title: '작업 목록',
    selectAll: '모두 선택',
    deselectAll: '모두 선택 해제',
    collapseAll: '모두 접기',
    expandAll: '모두 펼치기',
    addTask: '작업 추가',
    noTasks: '작업이 없습니다',
    dragToReorder: '드래그하여 순서 변경',
    startTasks: '실행 시작',
    stopTasks: '실행 중지',
    startingTasks: '시작 중...',
    stoppingTasks: '중지 중...',
    taskSkippedByWeeklySchedule:
      '작업 「{{taskName}}」은 오늘 실행 대상이 아닙니다: 주간 일정에 오늘이 포함되어 있지 않습니다',
    allTasksSkippedByWeeklySchedule:
      '작업을 시작하지 않았습니다: 선택한 작업 중 오늘의 주간 일정에 맞는 작업이 없습니다',
    checkboxTaskScope: '작업 「{{task}}」',
    checkboxGlobalScope: '전역 설정',
    checkboxMinimumNotMet:
      '{{scope}}의 옵션 「{{option}}」은(는) 최소 {{min}}개가 필요합니다 (현재 {{count}}개)',
    checkboxMaximumExceeded:
      '{{scope}}의 옵션 「{{option}}」은(는) 최대 {{max}}개까지 가능합니다 (현재 {{count}}개)',
    // 자동 연결 관련
    autoConnect: {
      searching: '기기 검색 중...',
      searchingWindow: '창 검색 중...',
      connecting: '기기 연결 중...',
      connectingWindow: '창 연결 중...',
      loadingResource: '리소스 로딩 중...',
      deviceNotFound: '기기를 찾을 수 없습니다: {{name}}',
      windowNotFound: '창을 찾을 수 없습니다: {{name}}',
      noSavedDevice: '저장된 기기 설정이 없습니다',
      noDeviceFound: '기기를 찾을 수 없습니다',
      noWindowFound: '창을 찾을 수 없습니다',
      connectFailed: '자동 연결에 실패했습니다',
      retryConnect: '연결 실패, {{attempt}}번째 재시도...',
      autoSelectedDevice:
        '기기가 설정되지 않아 「{{name}}」을(를) 자동으로 선택했습니다. 변경하려면 연결 설정에서 수동으로 선택하세요. 다음 번에는 선택 내용이 저장됩니다.',
      autoSelectedWindow:
        '창이 설정되지 않아 「{{name}}」을(를) 자동으로 선택했습니다. 변경하려면 연결 설정에서 수동으로 선택하세요. 다음 번에는 선택 내용이 저장됩니다.',
      resourceFailed: '리소스 로딩에 실패했습니다',
      startFailed: '작업 시작에 실패했습니다',
      alreadyRunning: '작업이 이미 실행 중이거나 사전 작업을 실행하고 있습니다',
      taskNotFound: '지정한 작업이 없거나 삭제되었습니다',
      noRunnableTasks: '실행 가능한 작업이 없습니다. 작업 정의와 진입점 설정을 확인하세요',
      workstationLocked: '컴퓨터가 잠금 화면 상태입니다. 잠금을 해제한 후 작업을 실행하세요',
      agentStartParams: 'Agent #{{index}} 시작 파라미터: {{cmd}}  (작업 디렉토리: {{cwd}})',
      agentSpawnHintFileNotFound:
        'Agent가 백신에 의해 차단되지 않았는지 확인한 뒤, 문제가 없으면 덮어쓰기 재설치를 진행하세요.',
      agentSpawnHintAppControl:
        '「Windows 보안 → 앱 및 브라우저 제어 → 스마트 앱 컨트롤」에서 해당 기능을 끈 후 다시 시도하세요.',
      needConfig: '먼저 기기를 연결하고 리소스를 로드하거나 연결 패널에서 기기 설정을 저장하세요',
    },
  },

  // 작업 항목
  taskItem: {
    options: '옵션 설정',
    noOptions: '설정 가능한 옵션이 없습니다',
    enabled: '활성화됨',
    disabled: '비활성화됨',
    expand: '옵션 펼치기',
    collapse: '옵션 접기',
    remove: '작업 삭제',
    removeConfirmTitle: '작업 삭제',
    removeConfirmMessage: '이 작업을 삭제하시겠습니까?',
    rename: '이름 변경',
    clickToToggle: '클릭하여 전환',
    runOnceHint: '1회 실행: 다음 시작 시 한 번만 실행',
    weeklyScheduleTitle: '주간 일정',
    weeklyScheduleSkippedToday: '오늘은 실행 대상 아님',
    weeklyScheduleSkippedTodayHint:
      '선택은 유지되지만 오늘은 주간 일정에 없어 일반적으로 시작할 때 실행 대기열에 추가되지 않습니다. 개별 실행하거나 1회 실행으로 설정할 수 있습니다.',
    weeklyScheduleToday: '오늘',
    renameTask: '작업 이름 변경',
    customName: '사용자 지정 이름',
    originalName: '원래 이름',
    cannotEditRunningTask: '실행 중이거나 완료된 작업의 옵션은 편집할 수 없습니다',
    // 설명 콘텐츠 로딩
    loadingDescription: '설명 로딩 중...',
    loadedFromFile: '로컬 파일에서 로드됨',
    loadedFromUrl: '네트워크에서 로드됨',
    loadDescriptionFailed: '로딩 실패',
    // 작업 실행 상태
    status: {
      idle: '미실행',
      pending: '대기 중',
      running: '실행 중',
      succeeded: '완료',
      failed: '실패',
    },
    // 작업 호환성
    incompatibleController: '현재 컨트롤러에서 지원되지 않음',
    incompatibleResource: '현재 리소스에서 지원되지 않음',
    supportedControllers: '지원 대상: {{controllers}}',
  },

  // 옵션
  option: {
    select: '선택하세요',
    input: '입력하세요',
    yes: '예',
    no: '아니오',
    invalidInput: '입력 형식이 올바르지 않습니다',
  },

  action: {
    preAction: '▶️ 전처리 프로그램',
    program: '프로그램 경로',
    programPlaceholder: '프로그램 경로를 입력하거나 찾아보기...',
    args: '추가 인수',
    argsPlaceholder: '추가 인수 입력 (선택사항)',
    browse: '찾아보기',
    waitForExit: '종료 대기',
    waitForExitHintPre:
      '비활성화하면 프로세스 시작 후 즉시 계속하고 장치 연결 상태를 폴링합니다. 게임 시작과 같은 비동기 시나리오에 적합합니다. 활성화하면 프로세스가 종료될 때까지 대기한 후 계속합니다. 스크립트 실행과 같은 동기 작업에 적합합니다',
    skipIfRunning: '실행 중이면 건너뛰기',
    skipIfRunningHint:
      '활성화하면 프로그램이 이미 실행 중인 경우 실행을 건너뛱니다. 게임 등의 재시작을 피하는 데 유용합니다',
    useCmd: 'cmd로 실행',
    useCmdHint:
      '활성화하면 cmd /c로 프로그램을 실행하여 현재 프로세스 트리에서 분리합니다. 일부 게임은 프로세스 트리를 감지할 수 있습니다 (Windows 전용)',
    preActionSkipped: '전처리 프로그램 {{name}} 이(가) 실행 중이므로 건너뜁니다',
    waitingForDevice: '장치 준비 대기 중...',
    waitingForWindow: '윈도우 준비 대기 중...',
    waitingForDeviceNamed: '장치 「{{name}}」 준비 대기 중...',
    waitingForWindowNamed: '윈도우 「{{name}}」 준비 대기 중...',
    waitingForAnyDevice:
      '일치하는 장치가 나타날 때까지 대기 중. 원하는 장치가 아닌 경우, 먼저 연결 설정에서 수동으로 선택한 후 시작하세요.',
    waitingForAnyWindow:
      '일치하는 윈도우가 나타날 때까지 대기 중. 원하는 윈도우가 아닌 경우, 먼저 연결 설정에서 수동으로 선택한 후 시작하세요.',
    deviceReady: '장치 준비 완료',
    windowReady: '윈도우 준비 완료',
    deviceWaitTimeout: '장치 대기 시간 초과',
    windowWaitTimeout: '윈도우 대기 시간 초과',
    preActionStarting: '전처리 프로그램 실행 중...',
    preActionStartingNamed: '전처리 프로그램 실행 중: {{name}}...',
    preActionCompleted: '전처리 프로그램 완료',
    preActionCompletedNamed: '전처리 프로그램 {{name}} 완료',
    preActionFailed: '전처리 프로그램 실패: {{error}}',
    preActionExitCode: '전처리 프로그램 종료 코드: {{code}}',
    pretaskStarting: '사전 작업 실행 중: {{name}}',
    pretaskCompleted: '사전 작업 완료: {{name}}',
    pretaskExitCode: '사전 작업 종료 코드: {{code}}',
    pretaskFailed: '사전 작업 실행 실패: {{error}}',
    preActionConnectDelay: '{{seconds}}초 후 연결합니다...',
    removeConfirmTitle: '전처리 프로그램 삭제',
    removeConfirmMessage: '이 전처리 프로그램을 삭제하시겠습니까?',
  },

  // 옵션 에디터
  optionEditor: {
    loadingDescription: '설명 로딩 중...',
    loadedFromFile: '로컬 파일에서 로드됨',
    loadedFromUrl: '네트워크에서 로드됨',
    loadDescriptionFailed: '로딩 실패',
    searchPlaceholder: '옵션 검색...',
    noMatchingOptions: '일치하는 옵션 없음',
    incompatibleController: '현재 컨트롤러에서 지원되지 않음',
    incompatibleResource: '현재 리소스 팩에서 지원되지 않음',
    hotkeyPlaceholder: '클릭하여 단축키 입력',
    hotkeyCapturing: '키를 누르세요...',
    expandOptions: '하위 옵션 펼치기',
    collapseOptions: '하위 옵션 접기',
    checkboxCountRange: '최소 {{min}}개, 최대 {{max}}개',
    checkboxCountMinimum: '최소 {{min}}개',
    checkboxCountMaximum: '최대 {{max}}개',
    checkboxSelectedCount: '{{count}}개 선택됨 ({{constraint}})',
    checkboxMinimumRequired: '최소 {{min}}개를 선택하세요 (현재 {{count}}개)',
    checkboxMaximumReached: '최대 {{max}}개까지 선택할 수 있습니다',
  },

  // 프리셋
  preset: {
    title: '프리셋 선택',
    hint: '미리 정의된 작업 구성을 원클릭으로 적용하여 빠르게 시작하세요',
    taskCount: '개 작업',
    skipToManual: '건너뛰고 수동으로 작업 추가',
    importConfig: '클립보드에서 설정 가져오기',
    importConfigFromFile: '파일에서 설정 가져오기',
    importSuccess: '설정 가져오기 성공',
    importFailed: '가져오기 실패: 잘못된 형식',
    importProjectMismatch: '가져오기 실패: 프로젝트 불일치',
    importVersionUnsupported:
      '가져오기 실패: 이 설정은 더 새로운 버전의 {{projectName}}에서 내보낸 것입니다. {{projectName}}를 업데이트한 후 다시 시도해 주세요',
    exportSuccess: '설정이 클립보드에 복사되었습니다',
    exportFailed: '내보내기 실패: 클립보드에 쓸 수 없습니다',
    exportFileSuccess: '설정을 txt 파일로 내보냈습니다',
    exportFileFailed: '내보내기 실패: 파일에 쓸 수 없습니다',
    exportShareHint: '{{projectName}} 의 「{{tabName}}」 설정 공유해요~',
    exportShareFooter:
      '👆 이 메시지를 복사해서 {{projectName}} 에서 새 탭을 만들고 「설정 가져오기」를 누르면 바로 사용할 수 있어요',
  },

  // 컨트롤러
  controller: {
    title: '컨트롤러',
    selectController: '컨트롤러 선택',
    adb: 'Android 기기',
    win32: 'Windows 창',
    wlroots: 'WlRoots (Linux)',
    linux: 'Linux',
    portal: 'Portal',
    uinputWidth: '너비 (px)',
    uinputHeight: '높이 (px)',
    playcover: 'PlayCover (macOS)',
    macos: 'macOS 창',
    macosPermissionsRequired:
      '화면 기록 및 손쉬운 사용 권한이 필요합니다. macOS 시스템 설정의 개인정보 보호 및 보안에서 권한을 허용한 후 다시 시도하세요.',
    macosUnsupportedPlatform: 'macOS 네이티브 창 컨트롤러는 macOS에서만 사용할 수 있습니다.',
    macosVersionRequired:
      'macOS 네이티브 창 컨트롤러에는 MaaFramework v5.10.0-beta.1 이상이 필요합니다.',
    macosSystemVersionRequired: 'macOS 네이티브 창 컨트롤러에는 macOS 14.0 이상이 필요합니다.',
    macosSystemVersionDetectionFailed:
      '현재 macOS 버전을 확인할 수 없습니다. 자세한 내용은 로그를 확인하세요.',
    linuxVersionRequired: 'Linux 컨트롤러에는 MaaFramework v5.13.0-beta.3 이상이 필요합니다.',
    gamepad: '게임패드',
    connecting: '연결 중...',
    connected: '연결됨',
    disconnected: '연결 안 됨',
    connectionFailed: '연결에 실패했습니다',
    refreshDevices: '기기 새로고침',
    refreshWindows: '윈도우 새로고침',
    refresh: '기기 새로고침',
    connect: '연결',
    disconnect: '연결 해제',
    selectDevice: '기기를 선택하세요',
    selectWindow: '윈도우를 선택하세요',
    noDevices: '기기를 찾을 수 없습니다',
    noWindows: '윈도우를 찾을 수 없습니다',
    playcoverHint: 'PlayCover 앱 리슨 주소를 입력하세요',
    lastSelected: '이전 선택 · 클릭하여 검색',
    savedDeviceNotFound: '이전 기기를 찾을 수 없습니다. 연결을 확인하거나 다른 기기를 선택하세요',
    savedWindowNotFound:
      '이전 윈도우를 찾을 수 없습니다. 연결을 확인하거나 다른 윈도우를 선택하세요',
    connectedLog: '컨트롤러에 연결되었습니다 [{{name}}]',
  },

  // 리소스
  resource: {
    title: '리소스 팩',
    selectResource: '리소스 팩 선택',
    loading: '리소스 로딩 중...',
    loaded: '리소스 로드됨',
    loadFailed: '리소스 로딩에 실패했습니다',
    loadResource: '리소스 로드',
    switchFailed: '리소스 전환에 실패했습니다',
    cannotSwitchWhileRunning: '작업 실행 중에는 리소스를 전환할 수 없습니다',
    hashMismatch:
      '리소스 무결성 검증 실패 (예상: {{expected}}, 실제: {{actual}}). 리소스 팩을 다시 다운로드하는 것을 권장합니다.',
    incompatibleController: '현재 컨트롤러에서 지원되지 않음',
  },

  // MaaFramework
  maa: {
    notInitialized: 'MaaFramework가 초기화되지 않았습니다',
    initFailed: '초기화에 실패했습니다',
    version: '버전',
    needConnection: '먼저 기기를 연결하세요',
    needResource: '먼저 리소스를 로드하세요',
  },

  // 스크린샷 미리보기
  screenshot: {
    title: '실시간 스크린샷',
    autoRefresh: '자동 새로고침',
    noScreenshot: '스크린샷이 없습니다',
    startStream: '라이브 스트림 시작',
    stopStream: '라이브 스트림 중지',
    connectFirst: '먼저 기기를 연결하세요',
    fullscreen: '전체 화면',
    exitFullscreen: '전체 화면 종료',
    clickHint: '화면을 클릭하면 기기에 탭을 전송합니다',
    // 프레임률 설정
    frameRate: {
      title: '스크린샷 프레임률',
      hint: '미리보기 부드러움과 시스템 리소스 사용량에만 영향을 미치며, 작업 인식이나 실행에는 영향을 주지 않습니다',
      unlimited: '제한 없음',
      fps5: '5 FPS',
      fps1: '1 FPS',
      every5s: '5초마다',
      every30s: '30초마다',
    },
  },

  // 로그
  logs: {
    title: '실행 로그',
    clear: '지우기',
    autoscroll: '자동 스크롤',
    noLogs: '로그가 없습니다',
    copyAll: '모두 복사',
    showMoreLogs: '로그 더 보기',
    expand: '상단 패널 펼치기',
    collapse: '상단 패널 접기',
    scrollToLogs: '로그 보기',
    // 로그 메시지
    messages: {
      // 연결 메시지
      connecting: '{{target}}에 연결 중...',
      connected: '{{target}} 연결됨:',
      connectFailed: '{{target}} 연결 실패:',
      targetDevice: '기기',
      targetWindow: '윈도우',
      // 리소스 로딩 메시지
      loadingResource: '리소스 로딩 중: {{name}}',
      resourceLoaded: '리소스 로드됨: {{name}}',
      resourceFailed: '리소스 로딩 실패: {{name}}',
      resourceFailedHint: '해당 리소스 디렉터리를 삭제한 뒤 덮어쓰기 재설치 후 다시 시도해 보세요.',
      // 작업 메시지
      taskStarting: '작업 시작: {{name}}',
      taskSucceeded: '작업 완료: {{name}}',
      taskFailed: '작업 실패: {{name}}',
      stopTask: '작업 중지',
      // 예약 메시지
      scheduleStarting: '예약 일정 도달 [{{policy}}] {{time}}, 실행할 작업 확인 중',
      // Agent 메시지
      agentStarting: 'Agent 시작 중...',
      agentStarted: 'Agent가 시작되었습니다',
      agentConnected: 'Agent가 연결되었습니다',
      agentDisconnected: 'Agent 연결이 끊어졌습니다',
      agentFailed: 'Agent 시작에 실패했습니다',
      agentLogFloodWarning:
        'Agent가 로그 폭주 상태입니다. 성능 문제를 방지하기 위해 로그 표시를 일시 중지했습니다. 전체 로그는 로컬 로그 파일에서 확인할 수 있습니다.',
      agentLogFloodRecovered: 'Agent 로그 폭주가 완화되었습니다',
      // 단축키
      hotkeyDetected: '단축키 감지: {{combo}} ({{action}})',
      hotkeyActionStart: '작업 시작',
      hotkeyActionStop: '작업 중지',
      hotkeyStartSuccess: '단축키로 작업을 시작했습니다:',
      hotkeyStopSuccess: '단축키로 작업을 중지했습니다',
      hotkeyStopPending:
        '중지 요청을 보냈지만 작업은 아직 현재 작업이 종료되기를 기다리고 있습니다.',
      hotkeyStopFailed: '단축키로 작업을 중지하지 못했습니다',
    },
  },

  // 작업 추가 패널
  addTaskPanel: {
    title: '작업 추가',
    searchPlaceholder: '작업 검색...',
    noResults: '일치하는 작업을 찾을 수 없습니다',
    alreadyAdded: '추가됨',
    collapse: '패널 접기',
    specialTasks: '특수 작업',
    pretasks: '사전 작업',
    allSpecialTasksAdded: '모두 추가됨',
    ungroupedTasks: '기타',
    resizeHandleAriaLabel: '작업 추가 패널 높이 조정',
  },

  // 정보
  about: {
    title: '정보',
    version: '버전',
    description: '설명',
    license: '라이선스',
    contact: '연락처',
    github: 'GitHub 저장소',
  },

  // 디버그
  debug: {
    title: '디버그',
    versions: '버전 정보',
    interfaceVersion: '{{name}} 버전',
    maafwVersion: 'maafw 버전',
    mxuVersion: 'mxu 버전',
    environment: '실행 환경',
    envTauri: 'Tauri 데스크톱',
    envBrowser: '브라우저',
    systemInfo: '시스템 정보',
    operatingSystem: '운영 체제',
    architecture: '시스템 아키텍처',
    tauriVersion: 'Tauri 버전',
    pathInfo: '경로 정보',
    cwd: '현재 작업 디렉토리',
    exeDir: '실행 파일 디렉토리',
    webview2Dir: 'WebView2 디렉토리',
    webview2System: '시스템',
    resetWindowSize: '창 크기 초기화',
    openConfigDir: '설정 폴더 열기',
    openLogDir: '로그 폴더 열기',
    exportLogs: '로그 내보내기',
    exportLogsHint:
      '로그와 config를 zip으로 묶고, 약 24.5 MB까지 최신 디버그 이미지를 자동으로 유지; "디버그 이미지 저장" 활성화 시 vision 이미지도 포함',
    exportingLogs: '로그 내보내는 중...',
    logsExported: '로그를 내보냈습니다',
    exportLogsFailed: '로그 내보내기 실패',
    devMode: '개발자 모드',
    devModeHint: '활성화하면 F5 키로 UI를 새로고침할 수 있습니다',
    saveDraw: '디버그 이미지 저장',
    saveDrawHint:
      '인식 및 작업의 디버그 이미지를 로그 폴더에 저장합니다 (재시작 후 자동으로 비활성화됨)',
    tcpCompatMode: '통신 호환 모드',
    tcpCompatModeHint:
      '작업 시작 후 앱이 즉시 충돌하면 활성화해 보세요. 이 경우에만 사용하세요, 성능에 영향을 줄 수 있습니다',
  },

  webserver: {
    title: 'Web 서버',
    enabled: 'Web 서버 활성화',
    enabledHint: '비활성화하면 내장 Web 서버가 시작되지 않습니다 (재시작 필요)',
    port: 'Web 서버 포트',
    portHint: 'Web 서버 수신 포트를 사용자 지정합니다 (기본값 12701, 재시작 필요)',
    allowLanAccess: 'LAN 접근 허용',
    allowLanAccessHint:
      '활성화하면 Web UI가 0.0.0.0에서 수신하여 LAN 내 다른 기기에서 접근할 수 있습니다',
    restartMessage: 'Web 서버 설정 변경을 적용하려면 재시작이 필요합니다. 지금 재시작하시겠습니까?',
    restartLater: '나중에',
    restartNow: '지금 재시작',
    address: 'Web 서버 주소',
  },

  // 설정 자동 복구 알림
  config: {
    recoveredFromBackup: '설정 파일이 손상되어 {{time}} 백업에서 자동으로 복원했습니다',
    recoveryFailed:
      '설정 파일이 손상되었고 사용할 수 있는 백업이 없어 기본 설정으로 초기화했습니다',
  },

  // 환영 대화상자
  welcome: {
    dismiss: '확인했습니다',
    viewAgain: '환영 메시지 보기',
  },

  // 신규 사용자 가이드
  onboarding: {
    title: '기기 연결',
    message:
      '오른쪽 "연결 설정" 패널에서 기기를 선택하고 리소스를 로드하면 작업을 실행할 준비가 완료됩니다.',
    addTaskTitle: '작업 추가',
    addTaskMessage: '여기를 클릭하여 사용 가능한 작업을 확인하고 필요한 작업을 목록에 추가하세요.',
    tabBarTitle: '여러 구성 관리',
    tabBarMessage:
      '상단 탭을 사용하여 구성을 새로 만들거나 전환할 수 있습니다. 예를 들어 하나는 일상 자동화용, 다른 하나는 실시간 유틸리티용으로 사용하며, 각 구성은 독립적인 작업과 기기 설정을 가집니다.',
    next: '다음',
    prev: '이전',
    gotIt: '알겠습니다',
    skipDev: '건너뛰기 (DEV)',
  },

  // 인스턴스
  instance: {
    defaultName: '설정',
  },

  // 연결 패널
  connection: {
    title: '연결 설정',
  },

  // 대시보드
  dashboard: {
    title: '대시보드',
    toggle: '대시보드 보기',
    exit: '대시보드 나가기',
    instances: '개의 인스턴스',
    noInstances: '인스턴스가 없습니다',
    running: '실행 중',
    succeeded: '완료',
    failed: '실패',
    noEnabledTasks: '활성화된 작업이 없습니다',
    alignLeft: '왼쪽 정렬',
    alignCenter: '가운데 정렬',
    alignRight: '오른쪽 정렬',
    zoomIn: '확대',
    zoomOut: '축소',
  },

  // 최근 닫은 탭
  recentlyClosed: {
    title: '최근에 닫은 탭',
    empty: '최근에 닫은 탭이 없습니다',
    reopen: '다시 열기',
    remove: '목록에서 삭제',
    clearAll: '모두 지우기',
    clearAllConfirmTitle: '최근에 닫은 탭 지우기',
    clearAllConfirmMessage: '최근에 닫은 탭 목록을 모두 지우시겠습니까?',
    justNow: '방금',
    minutesAgo: '{{count}}분 전',
    hoursAgo: '{{count}}시간 전',
    daysAgo: '{{count}}일 전',
    noTasks: '작업 없음',
    tasksCount: '{{first}} 외 {{count}}개 작업',
  },

  // MirrorChyan 업데이트
  mirrorChyan: {
    title: '업데이트',
    debugModeNotice: '디버그 버전이므로 자동 업데이트 기능이 비활성화되었습니다',
    channel: '업데이트 채널',
    channelStable: '안정 버전',
    channelBeta: '베타 버전',
    cdk: 'Mirror짱 CDK',
    cdkPlaceholder: 'CDK 입력 (선택사항)',
    serviceName: 'Mirror짱',
    cdkHintAfterLink:
      '는 독립적인 서드파티 고속 다운로드 서비스이며 유료 구독이 필요합니다. 이것은 "{{projectName}}"의 요금이 아닙니다. 운영비는 구독 수익으로 충당되며 일부는 개발자에게 환원됩니다. CDK를 구독하여 고속 다운로드를 즐기세요. CDK가 없으면 GitHub에서 다운로드됩니다. 실패하면 네트워크 프록시를 설정하세요.',
    getCdk: 'CDK가 없으신가요? 지금 구독하세요',
    cdkHint: 'CDK가 올바른지 또는 만료되지 않았는지 확인하세요',
    slowDownloadHint: '다른 채널',
    checkUpdate: '업데이트 확인',
    checking: '확인 중...',
    upToDate: '최신 버전입니다 ({{version}})',
    newVersion: '새 버전 사용 가능',
    currentVersion: '현재 버전',
    latestVersion: '최신 버전',
    releaseNotes: '릴리스 노트',
    downloadNow: '지금 다운로드',
    later: '나중에 알림',
    dismiss: '이 버전 건너뛰기',
    noReleaseNotes: '릴리스 노트가 없습니다',
    checkFailed: '업데이트 확인에 실패했습니다',
    checkFailedHint: '네트워크 연결을 확인하고 다시 시도해 주세요',
    downloading: '다운로드 중',
    downloadComplete: '다운로드 완료',
    downloadFailed: '다운로드 실패',
    viewDetails: '상세 보기',
    noDownloadUrl: '다운로드 URL이 없습니다. CDK를 입력하거나 네트워크 환경을 확인하세요',
    openFolder: '폴더 열기',
    retry: '재시도',
    preparingDownload: '다운로드 준비 중...',
    downloadFromGitHub: 'GitHub에서 다운로드',
    downloadFromMirrorChyan: 'Mirror짱 CDN에서 다운로드',
    // 업데이트 설치
    installing: '업데이트 설치 중...',
    installComplete: '설치 완료',
    installFailed: '설치 실패',
    installNow: '지금 설치',
    installUpdate: '업데이트 설치',
    installStages: {
      extracting: '압축 해제 중...',
      checking: '업데이트 유형 확인 중...',
      applying: '업데이트 적용 중...',
      cleanup: '임시 파일 정리 중...',
      done: '업데이트 완료',
      incremental: '증분 업데이트',
      full: '전체 업데이트',
      fallback: '대체 업데이트 수행 중...',
    },
    restartRequired: '업데이트가 설치되었습니다. 변경 사항을 적용하려면 재시작하세요',
    restartNow: '지금 재시작',
    restarting: '재시작 중...',
    installerOpened: '설치 프로그램이 열렸습니다',
    installerOpenedHint: '설치 프로그램을 완료한 후 이 앱을 다시 시작하세요',
    // 업데이트 완료 후
    updateCompleteTitle: '업데이트 완료',
    updateCompleteMessage: '최신 버전으로 성공적으로 업데이트되었습니다',
    previousVersion: '이전 버전',
    gotIt: '확인',
    // MirrorChyan API 오류 코드
    errors: {
      1001: '매개변수가 올바르지 않습니다. 설정을 확인하세요',
      7001: 'CDK가 만료되었습니다. 갱신하거나 다른 CDK를 사용하세요',
      7002: 'CDK가 유효하지 않습니다. 입력을 확인하세요',
      7003: 'CDK의 오늘 다운로드 횟수가 한도에 도달했습니다',
      7004: 'CDK 유형이 리소스와 일치하지 않습니다',
      7005: 'CDK가 차단되었습니다. 고객 지원에 문의하세요',
      8001: '현재 OS/아키텍처에서 사용 가능한 리소스가 없습니다',
      8002: 'OS 매개변수가 유효하지 않습니다',
      8003: '아키텍처 매개변수가 유효하지 않습니다',
      8004: '업데이트 채널 매개변수가 유효하지 않습니다',
      1: '서비스 오류가 발생했습니다. 나중에 다시 시도하세요',
      unknown: '알 수 없는 오류 ({{code}}): {{message}}',
      negative: '서버 오류가 발생했습니다. 기술 지원에 문의하세요',
    },
  },

  // 예약
  schedule: {
    title: '예약 실행',
    button: '예약',
    addPolicy: '예약 추가',
    defaultPolicyName: '예약',
    policyName: '예약 이름',
    noPolicies: '예약이 없습니다',
    noPoliciesHint: '예약을 추가하여 작업을 자동으로 실행하세요',
    repeatDays: '반복 요일',
    startTime: '시작 시간',
    selectDays: '요일 선택...',
    addTime: '시간 추가',
    noWeekdays: '요일이 선택되지 않았습니다',
    noTimes: '시간이 선택되지 않았습니다',
    everyday: '매일',
    timesSelected: '개의 시간',
    timeZoneHint: '로컬 시간대 사용',
    multiSelect: '다중 선택',
    enable: '예약 활성화',
    disable: '예약 비활성화',
    enableAll: '모든 예약 활성화',
    disableAll: '모든 예약 비활성화',
    hint: '예약된 작업은 설정된 시간에 자동으로 실행됩니다',
    executingPolicy: '「{{name}}」 예약 실행 중',
    startedAt: '시작 시간: {{time}}',
    deletePolicyTitle: '예약 삭제',
    deletePolicyConfirm: '예약 "{{name}}"을(를) 삭제하시겠습니까?',
    // Date.getDay()에 대응: 0=일, 1=월, ..., 6=토
    weekdays: ['일', '월', '화', '수', '목', '금', '토'],
  },

  // 오류 메시지
  errors: {
    loadInterfaceFailed: 'interface.json 로딩에 실패했습니다',
    invalidInterface: 'interface.json 형식이 유효하지 않습니다',
    invalidConfig: '설정 파일 형식이 유효하지 않습니다',
    taskNotFound: '작업을 찾을 수 없습니다',
    controllerNotFound: '컨트롤러를 찾을 수 없습니다',
    resourceNotFound: '리소스 팩을 찾을 수 없습니다',
  },

  // 컨텍스트 메뉴
  contextMenu: {
    // 탭 컨텍스트 메뉴
    newTab: '새 탭',
    duplicateTab: '탭 복제',
    renameTab: '이름 변경',
    moveLeft: '왼쪽으로 이동',
    moveRight: '오른쪽으로 이동',
    moveToFirst: '맨 앞으로 이동',
    moveToLast: '맨 뒤로 이동',
    closeTab: '탭 닫기',
    closeOtherTabs: '다른 탭 닫기',
    closeAllTabs: '모든 탭 닫기',
    closeTabsToRight: '오른쪽 탭 닫기',
    exportConfig: '설정 내보내기',
    exportToClipboard: '클립보드로 내보내기',
    exportToTxt: 'txt 파일로 내보내기',
    importConfig: '설정 가져오기',
    importFromClipboard: '클립보드에서 가져오기',
    importFromTxt: 'txt 파일에서 가져오기',

    // 전처리 프로그램 컨텍스트 메뉴
    duplicateAction: '복제',
    deleteAction: '삭제',
    renameAction: '이름 변경',
    enableAction: '활성화',
    disableAction: '비활성화',
    expandAction: '설정 펼치기',
    collapseAction: '설정 접기',

    // 작업 컨텍스트 메뉴
    addTask: '작업 추가',
    duplicateTask: '작업 복제',
    deleteTask: '작업 삭제',
    renameTask: '작업 이름 변경',
    enableTask: '작업 활성화',
    disableTask: '작업 비활성화',
    moveUp: '위로 이동',
    moveDown: '아래로 이동',
    moveToTop: '맨 위로 이동',
    moveToBottom: '맨 아래로 이동',
    expandOptions: '옵션 펼치기',
    collapseOptions: '옵션 접기',
    selectAll: '모두 선택',
    deselectAll: '모두 선택 해제',
    expandAllTasks: '모두 펼치기',
    collapseAllTasks: '모두 접기',
    runFromHere: '여기서 실행',
    runSingleTask: '이 작업만 실행',
    runOnceTask: '1회 실행',
    clearRunOnceTask: '1회 실행 취소',
    enableWeeklySchedule: '주간 일정 활성화',

    // 스크린샷 패널 컨텍스트 메뉴
    reconnect: '다시 연결',
    forceRefresh: '강제 새로고침',
    startStream: '라이브 스트림 시작',
    stopStream: '라이브 스트림 중지',
    fullscreen: '전체 화면',
    saveScreenshot: '스크린샷 저장',
    copyScreenshot: '스크린샷 복사',

    // 연결 패널 컨텍스트 메뉴
    refreshDevices: '기기 목록 새로고침',
    disconnect: '연결 해제',

    // 공통
    openFolder: '폴더 열기',
  },

  // 버전 경고
  versionWarning: {
    title: 'MaaFramework 버전이 너무 낮습니다',
    message:
      '현재 MaaFramework 버전 ({{current}})이 지원되는 최소 버전 ({{minimum}})보다 낮습니다. 일부 기능이 제대로 작동하지 않을 수 있습니다.',
    suggestion: 'MaaFramework 버전을 업데이트하려면 프로젝트 개발자에게 문의하세요.',
    understand: '확인했습니다',
  },

  // 권한 프롬프트
  permission: {
    title: '관리자 권한이 필요합니다',
    message:
      '현재 컨트롤러가 대상 창을 조작하려면 관리자 권한이 필요합니다. 관리자 권한으로 재시작하세요.',
    hint: '재시작 후 현재 설정이 자동으로 복원됩니다.',
    restart: '관리자 권한으로 재시작',
    restarting: '재시작 중...',
  },

  // 로딩 화면
  loadingScreen: {
    loadingInterface: 'interface.json을 로드 중...',
    loadFailed: '로드 실패',
    retry: '다시 시도',
  },

  // VC++ 런타임
  vcredist: {
    title: '런타임 누락',
    description: 'MaaFramework가 제대로 작동하려면 Microsoft Visual C++ 런타임이 필요합니다.',
    downloading: '런타임 다운로드 중...',
    downloadFailed: '다운로드 실패',
    waitingInstall: '설치 완료를 기다리고 있습니다. 설치 프로그램에서 설치를 완료하세요...',
    retrying: '다시 로드 중...',
    success: '런타임 설치 완료!',
    stillFailed:
      '설치가 완료되었지만 로드에 실패했습니다. 컴퓨터를 다시 시작한 후 다시 시도하세요.',
    restartHint: '문제가 지속되면 컴퓨터를 다시 시작한 후 다시 시도하세요.',
    retry: '다시 시도',
  },

  // 연결 끊김 (WebUI 모드)
  connectionLost: {
    title: '연결이 끊어졌습니다',
    message: '백엔드 서비스와의 연결이 끊어졌습니다. 재연결을 시도하고 있습니다...',
    reconnecting: '재연결 중...',
  },

  // WebUI 베타 배너
  webuiBeta: {
    message:
      'Web UI는 현재 베타 버전입니다. 일부 기능이 불안정할 수 있습니다. 문제가 발생하면 GitHub에서',
    reportIssue: 'Issue를 제출',
    desktopHint: '보다 안정적인 환경을 원하시면 데스크톱 클라이언트를 사용해 주세요',
  },

  // 경로 경고
  badPath: {
    title: '프로그램 위치가 잘못되었습니다',
    rootTitle: '디스크 루트에 프로그램을 두지 마세요!',
    rootDescription:
      '드라이브 루트(C:\\ 또는 D:\\ 등)에서 실행하면 문제가 발생할 수 있습니다. "D:\\MyApps\\"와 같은 폴더로 이동하세요.',
    tempTitle: '압축 파일에서 직접 실행한 것 같습니다',
    tempDescription:
      '프로그램이 임시 폴더에서 실행 중입니다. 닫으면 사라질 수 있습니다. 먼저 압축 파일을 폴더에 풀고 거기서 프로그램을 실행하세요.',
    hint: '팁: "D:\\MaaXXX"와 같은 전용 폴더에 압축을 푸는 것이 좋습니다. 관리하기 쉽도록 바탕화면이나 다운로드 폴더는 피하세요.',
    exit: '종료',
  },
  // 프록시 설정
  proxy: {
    title: '네트워크 프록시',
    url: '프록시 주소',
    urlPlaceholder: '예: http://127.0.0.1:7890',
    urlHint: 'HTTP/SOCKS5 지원, 비워두면 프록시를 사용하지 않음',
    urlHintDisabled: 'Mirror짱 CDK가 입력되어 프록시 기능이 비활성화되었습니다',
    invalid: '프록시 주소 형식이 올바르지 않습니다',
    examples: '예시 형식',
  },
};
