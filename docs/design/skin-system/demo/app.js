'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const mascot = document.querySelector('.mascot-actor');
  const appWrap = document.querySelector('.app-wrap');
  const sceneDefs = {
    mascot: {
      name: '捣蛋团子',
      code: 'SCENE 001 — MISCHIEF',
      kicker: 'MAKE SOME ROOM.',
      title: '借过，我也要上班。',
      heading: '它不只是贴纸。',
      description:
        '右侧宿主按钮可用 Tab 聚焦、Enter 或空格激活，让团子进入操作栏。按钮与点击范围跟随真实布局移动；角色图片本身不接收输入。',
      tags: ['host hotspot', 'reservation', 'state'],
      caption: '↳ 小家伙走进来，按钮真的为它让出位置。',
      trigger: ['角色互动：让团子挤进来', '角色互动：请团子让一让'],
      effect: 'mischief',
      range: [80, 164, 132],
      rangeLabel: '请求占位宽度',
      unit: 'px',
      device: '运行概览',
    },
    mecha: {
      name: '边界破坏者',
      code: 'SCENE 002 — OVERFLOW',
      kicker: 'BEYOND THE FRAME.',
      title: '边框，不是它的边界。',
      heading: '框装不下想象力。',
      description:
        '机甲挂在面板之外的装饰层，长枪穿出卡片边界。装饰不接收鼠标，下面的宿主按钮仍能正常操作。',
      tags: ['stage.foreground', 'bleed', 'hitTest:none'],
      caption: '↳ 越过的是 UI 面板边框；装饰仍受整个窗口约束。',
      trigger: ['能量出鞘', '收起能量'],
      effect: 'armed',
      range: [80, 115, 100],
      rangeLabel: '机甲显示比例',
      unit: '%',
      device: '运行概览',
    },
    garden: {
      name: '微型生态舱',
      code: 'SCENE 003 — LIVING STATE',
      kicker: 'A LITTLE MORE ALIVE.',
      title: '任务在跑，世界在生长。',
      heading: '把进度养成风景。',
      description:
        '点击开始任务，生态舱随进度舒展开来。用只读状态驱动表现，也可以拓展为抽芽、花开、昼夜和天气变化。',
      tags: ['state.progress', 'CSS variable', 'idle'],
      caption: '↳ 运行任务看生态舱生长，也可以切换夜间氛围。',
      trigger: ['切换到夜晚', '迎接新一天'],
      effect: 'night',
      range: [60, 110, 75],
      rangeLabel: '初始生长比例',
      unit: '%',
      device: '生态监测',
    },
    vinyl: {
      name: '黑胶工作台',
      code: 'SCENE 004 — ANALOG CONTROL',
      kicker: 'GET INTO YOUR GROOVE.',
      title: '让任务，进入节奏。',
      heading: '操作可以有仪式感。',
      description:
        '运行时唱针落下、唱片旋转；暂停时停转。控件仍然是原来的开始与停止，熟悉的操作可以拥有新的视觉隐喻。演示不播放音频。',
      tags: ['state.running', 'semantic control', 'CSS animation'],
      caption: '↳ 点击开始 / 暂停，唱片和唱针跟随真实的模拟状态。',
      trigger: ['试一下落针', '唱针归位'],
      effect: 'audition',
      range: [20, 80, 50],
      rangeLabel: '唱片转速',
      unit: 'rpm',
      device: 'SIDE A / DAILY MIX',
    },
    paper: {
      name: '纸上事务所',
      code: 'SCENE 005 — MATERIAL FEEDBACK',
      kicker: 'LESS WORK. MORE LIFE.',
      title: '办完一件，盖一个章。',
      heading: '反馈也能有触感。',
      description:
        '任务变成纸上的清单，完成时盖下印章。折角、叠纸和投影赋予平面材质感；不需要替换业务逻辑，也不需要 3D 引擎。',
      tags: ['state.success', 'material', 'transition'],
      caption: '↳ 完成模拟任务会自动盖章；右侧可以单独预览效果。',
      trigger: ['预览完成印章', '收起印章'],
      effect: 'stamped',
      range: [0, 16, 5],
      rangeLabel: '便签倾斜角度',
      unit: '°',
      device: 'DESK NOTES',
    },
    sonar: {
      name: '深海声呐站',
      code: 'SCENE 006 — SIGNALS',
      kicker: 'EVERY TASK, A SIGNAL.',
      title: '安静航行，等待回声。',
      heading: '让状态成为环境。',
      description:
        '声呐在运行时扫描，任务信号依次闪亮。状态不仅是角落的一行文字，也可以成为整个界面的节奏。关闭动效后仍保留文字进度。',
      tags: ['state.running', 'event pulse', 'reduced-motion'],
      caption: '↳ 声呐只是状态的第二种表达，文字状态始终保留。',
      trigger: ['开启扫描预览', '结束扫描预览'],
      effect: 'pinging',
      range: [20, 90, 50],
      rangeLabel: '扫描速度',
      unit: '%',
      device: 'SIGNAL / 03',
    },
    deepseek: {
      name: '蓝色大肥鱼吃白饭',
      code: 'SCENE 007 — DEEPSEEK',
      kicker: 'DEEPSEEK / EATING RICE',
      title: '蓝色大肥鱼 · 吃白饭',
      heading: '蓝色大肥鱼 · 吃白饭',
      description:
        '点击“投喂白饭”播放本地吃饭视频，或在任务执行和完成时播放。暂停、失败、取消或减少动效时显示静态图；视频始终静音。',
      tags: ['task.progress', 'host hotspot', 'interaction.timeout'],
      caption: '↳ 互动仅改变角色显示，不改变任务状态或进度。',
      trigger: ['投喂白饭', '再次投喂白饭'],
      effect: 'feeding',
      range: [60, 140, 100],
      rangeLabel: '吃饭播放速度',
      unit: '%',
      device: '运行概览',
    },
    naiwa: {
      name: '奶蛙',
      code: 'SCENE 008 — NAIWA',
      kicker: 'NAIWA / LAUGHING',
      title: '奶蛙 · 大笑',
      heading: '奶蛙 · 大笑',
      description:
        '点击“播放大笑”预览本地视频，或在任务完成时播放。失败、取消或减少动效时显示静态图；视频始终静音。',
      tags: ['task.state', 'host hotspot', 'reduced-motion'],
      caption: '↳ 视频播放与任务状态分开；减少动效时保留静态图和任务信息。',
      trigger: ['播放大笑', '再次播放大笑'],
      effect: 'laughing',
      range: [50, 150, 100],
      rangeLabel: '大笑播放速度',
      unit: '%',
      device: '运行概览',
    },
  };
  const state = {
    skin: 'mascot',
    effect: false,
    intensity: 132,
    phase: 'idle',
    progress: 0,
    timer: null,
    interactionTimer: null,
    interactionRevision: 0,
    accent: null,
    presetName: null,
    announcementKey: '',
  };
  const taskInputs = [...document.querySelectorAll('[data-task]')];
  const taskRows = [...document.querySelectorAll('.task-row')];
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const log = (message) => {
    $('event-log').textContent = message;
  };
  const selected = () => taskInputs.flatMap((input, index) => (input.checked ? [index] : []));
  const isMemeScene = () => ['deepseek', 'naiwa'].includes(state.skin);
  let pageActive = true;
  const characterPlayback = {
    deepseek: { pending: false, revision: 0 },
    naiwa: { pending: false, revision: 0 },
  };
  function syncSkinVideos(reset = false) {
    for (const [skin, playback] of Object.entries(characterPlayback)) {
      const video = $(`${skin}-motion`);
      if (!video) continue;
      // Both bundled clips remain silent, including after a browser restores this page.
      video.muted = true;
      video.defaultMuted = true;
      video.loop = true;
      video.playsInline = true;
      if (state.skin === skin) video.playbackRate = state.intensity / 100;
      const performing =
        state.skin === skin &&
        (state.effect ||
          state.phase === 'success' ||
          (skin === 'deepseek' && state.phase === 'running')) &&
        !media.matches &&
        !$('reduce-motion').checked &&
        !document.hidden &&
        pageActive;
      if (!performing) {
        playback.revision++;
        playback.pending = false;
        stage.classList.remove(`${skin}-performing`);
        if (!video.paused) video.pause();
        if (
          reset ||
          state.skin !== skin ||
          ['error', 'cancelled'].includes(state.phase) ||
          (state.phase === 'idle' && !state.effect)
        ) {
          if (video.currentTime !== 0) video.currentTime = 0;
        }
        continue;
      }
      stage.classList.add(`${skin}-performing`);
      // Progress ticks never restart a playing clip or repeat an unresolved play request.
      if (!video.paused || playback.pending) continue;
      playback.pending = true;
      const revision = ++playback.revision;
      try {
        Promise.resolve(video.play()).then(
          () => {
            if (revision === playback.revision) playback.pending = false;
            else syncSkinVideos();
          },
          () => {
            if (revision !== playback.revision) return;
            playback.pending = false;
            stage.classList.remove(`${skin}-performing`);
          },
        );
      } catch {
        playback.pending = false;
        stage.classList.remove(`${skin}-performing`);
      }
    }
  }
  function snippet() {
    const n = state.intensity;
    const snippets = {
      mascot: `"slot": "toolbar.actions",\n"edge": "inline-start",\n"size": ${n}, "maxFraction": 0.4`,
      mecha: '"layer": "ornament-front",\n"bleed": { "top": 96, "right": 96 },\n"hitTest": "none"',
      garden: 'task.progress\n  → CSS --growth\n  → 生态舱生长',
      vinyl: 'task.runState\n  running → 唱针落下\n  paused  → 唱片停转',
      paper: 'task.runState = success\n  → setSceneState: stamped\n  → 静态模式保留印章',
      sonar: 'task.runState\n  running → 扫描\n  reducedMotion → 静态信号',
      deepseek:
        'task.progress → 任务进度\ninteraction.feeding → 2400 ms\ntimeout 只复位互动，不改任务',
      naiwa:
        'task.state = success → 捧腹大笑\nerror / cancelled → 立即止笑\nreducedMotion → 静态姿态',
    };
    $('scene-snippet').textContent = snippets[state.skin];
  }
  function setIntensity(value) {
    const def = sceneDefs[state.skin];
    state.intensity = Math.max(def.range[0], Math.min(def.range[1], Number(value)));
    $('intensity').value = String(state.intensity);
    $('intensity-value').textContent = `${state.intensity} ${def.unit}`;
    stage.style.setProperty('--reserve', `${state.intensity}px`);
    stage.style.setProperty('--art-scale', state.intensity / 100);
    stage.style.setProperty(
      '--growth',
      state.skin === 'garden' ? Math.min(1.1, state.intensity / 100 + state.progress / 300) : 0.75,
    );
    document.querySelector('.record').style.animationDuration =
      `${60 / Math.max(1, state.intensity)}s`;
    document.querySelector('.sonar-sweep').style.animationDuration = `${9 - state.intensity / 12}s`;
    document.querySelector('.paper-art').style.transform =
      state.skin === 'paper' ? `rotate(${state.intensity}deg)` : '';
    snippet();
    renderMeme();
  }
  function stopClock() {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }
  function stopInteraction() {
    if (state.interactionTimer !== null) {
      clearTimeout(state.interactionTimer);
      state.interactionTimer = null;
    }
    state.interactionRevision++;
    stage.classList.remove('feeding', 'laughing');
    if (isMemeScene()) state.effect = false;
  }
  function renderMeme() {
    syncSkinVideos();
    if (!isMemeScene()) return;
    const phases = {
      idle: '待机中',
      running: '执行中',
      paused: '已暂停',
      success: '已完成',
      error: '执行失败',
      cancelled: '已取消',
    };
    if ($('meme-state'))
      $('meme-state').textContent = state.effect
        ? `${phases[state.phase]} · ${state.skin === 'deepseek' ? '投喂中' : '播放大笑'}`
        : phases[state.phase];
    if ($('rice-fill'))
      $('rice-fill').style.setProperty('--task-progress', String(state.progress / 100));
    if ($('meme-progress-text'))
      $('meme-progress-text').textContent = `任务进度 ${state.progress}%`;
  }
  function syncMotion() {
    const reduced = media.matches || $('reduce-motion').checked;
    if (media.matches) {
      $('reduce-motion').checked = true;
    }
    $('reduce-motion').disabled = media.matches;
    $('reduce-motion').title = media.matches ? '已遵循系统减少动态效果设置' : '';
    stage.classList.toggle('reduce-motion', reduced);
    $('motion-state').textContent = reduced ? 'MOTION REDUCED' : 'MOTION ON';
    syncSkinVideos();
  }
  function renderTasks() {
    if (isMemeScene() && ['success', 'error', 'cancelled'].includes(state.phase)) stopInteraction();
    const indexes = selected();
    const completed =
      state.progress === 100 ? indexes.length : Math.floor((state.progress / 100) * indexes.length);
    $('selected-count').textContent = String(indexes.length);
    $('completed-count').textContent = String(completed);
    $('progress-value').textContent = `${state.progress}%`;
    $('progress-fill').style.width = `${state.progress}%`;
    $('task-progress').setAttribute('aria-valuenow', String(state.progress));
    stage.dataset.runState = state.phase;
    const active = state.phase === 'running',
      paused = state.phase === 'paused';
    const def = sceneDefs[state.skin];
    const taskOwnsPreview =
      (['vinyl', 'sonar', 'paper'].includes(state.skin) && state.phase !== 'idle') ||
      (isMemeScene() && ['paused', 'success', 'error', 'cancelled'].includes(state.phase));
    $('scene-trigger').disabled = taskOwnsPreview;
    $('scene-trigger').replaceChildren(
      document.createTextNode(
        state.skin === 'paper' && state.phase === 'success'
          ? '本次完成印章已生效'
          : taskOwnsPreview
            ? '任务反馈由当前状态控制'
            : def.trigger[state.effect ? 1 : 0],
      ),
      Object.assign(document.createElement('span'), { textContent: state.effect ? '↶' : '→' }),
    );
    $('scene-trigger').setAttribute('aria-pressed', String(state.effect));
    stage.classList.toggle('running', active);
    stage.classList.toggle('complete', state.phase === 'success');
    stage.classList.toggle('failed', state.phase === 'error');
    stage.classList.toggle('cancelled', state.phase === 'cancelled');
    const phaseText = {
      idle: '待机中',
      running: '执行中',
      paused: '已暂停',
      cancelled: '已取消',
      error: '执行失败',
      success: '已完成',
    };
    $('status-label').textContent = phaseText[state.phase];
    $('task-progress').setAttribute(
      'aria-valuetext',
      `${phaseText[state.phase]}，进度 ${state.progress}%，已完成 ${completed} 项，共 ${indexes.length} 项`,
    );
    $('run-label').textContent = active
      ? '暂停任务'
      : paused
        ? '继续任务'
        : state.phase === 'success'
          ? '再运行一次'
          : state.phase === 'error'
            ? '重试任务'
            : state.phase === 'cancelled'
              ? '重新开始'
              : '开始任务';
    $('run-icon').textContent = active ? 'Ⅱ' : '▶';
    $('run-button').disabled = indexes.length === 0;
    $('stop-button').disabled = !(active || paused);
    $('fail-button').disabled = !(active || paused);
    $('task-caption').textContent =
      indexes.length === 0
        ? '请至少选择一项任务'
        : active
          ? '正在模拟执行，请稍候'
          : paused
            ? '任务已暂停，随时继续'
            : state.phase === 'success'
              ? '全部完成，辛苦啦！'
              : state.phase === 'error'
                ? '模拟连接失败；可重试，不计为成功'
                : state.phase === 'cancelled'
                  ? '本次执行已取消，不计为成功'
                  : '准备就绪，随时出发';
    taskRows.forEach((row, index) => {
      const order = indexes.indexOf(index),
        done = order >= 0 && order < completed;
      const firstUnfinished = order === completed && order >= 0;
      const current = firstUnfinished && (active || paused);
      const interrupted = state.phase === 'error' || state.phase === 'cancelled';
      row.classList.toggle('done', done);
      row.classList.toggle('current', current);
      row.classList.toggle('failed', firstUnfinished && state.phase === 'error');
      row.querySelector('.task-state').textContent =
        order < 0
          ? '跳过'
          : done
            ? '✓ 完成'
            : current
              ? paused
                ? 'Ⅱ 暂停'
                : '执行中'
              : firstUnfinished && interrupted
                ? state.phase === 'error'
                  ? '! 失败'
                  : '已取消'
                : interrupted
                  ? '未执行'
                  : '等待';
      taskInputs[index].disabled = active || paused;
    });
    if (state.skin === 'garden')
      stage.style.setProperty(
        '--growth',
        Math.min(1.1, state.intensity / 100 + state.progress / 300),
      );
    $('speech-bubble').textContent =
      state.phase === 'success'
        ? '下班啦！一起摸鱼～'
        : state.phase === 'error'
          ? '出点小状况，再试一次？'
          : state.phase === 'cancelled'
            ? '收到，今天先停在这里。'
            : active
              ? '我在认真监督！'
              : state.effect
                ? '嘿嘿，这里归我啦！'
                : '给我腾个位置嘛！';
    renderMeme();
    // A phase change is announced once. Progress ticks update the progressbar, not the live region.
    const announcementKey = `${state.phase}:${indexes.length}`;
    if (state.announcementKey !== announcementKey) {
      state.announcementKey = announcementKey;
      $('task-announcement').textContent =
        indexes.length === 0
          ? '请至少选择一项模拟任务。'
          : `${phaseText[state.phase]}。${
              state.phase === 'success'
                ? `已完成 ${completed} 项任务。`
                : state.phase === 'error'
                  ? '模拟连接失败，可使用重试任务按钮从头重试。'
                  : state.phase === 'cancelled'
                    ? '用户停止了本次执行，未完成的任务不计为成功。'
                    : `已选择 ${indexes.length} 项模拟任务。`
            }`;
    }
  }
  function selectSkin(key, updateHash = true) {
    if (!Object.hasOwn(sceneDefs, key)) return;
    stopClock();
    stopInteraction();
    state.skin = key;
    state.effect = false;
    state.phase = 'idle';
    state.progress = 0;
    state.accent = null;
    state.presetName = null;
    const def = sceneDefs[key];
    if (updateHash && window.location.hash !== `#${key}`)
      window.history.replaceState(null, '', `#${key}`);
    appWrap.append(mascot);
    stage.className = `stage theme-${key}`;
    stage.style.removeProperty('--app-accent');
    stage.classList.toggle('show-bounds', $('show-bounds').checked);
    syncMotion();
    document
      .querySelectorAll('[data-skin]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.skin === key)),
      );
    const fields = {
      'scene-code': def.code,
      'scene-kicker': def.kicker,
      'scene-title': def.title,
      'inspector-title': def.heading,
      'inspector-description': def.description,
      'scene-caption': def.caption,
      'intensity-label': def.rangeLabel,
      'device-title': def.device,
    };
    Object.entries(fields).forEach(([id, value]) => {
      $(id).textContent = value;
    });
    $('scene-trigger').replaceChildren(
      document.createTextNode(def.trigger[0]),
      Object.assign(document.createElement('span'), { textContent: '→' }),
    );
    $('scene-trigger').setAttribute('aria-pressed', 'false');
    if (key === 'mascot') {
      $('scene-trigger').dataset.hostHotspot = 'mascot';
      $('scene-trigger').setAttribute('aria-controls', 'reservation');
      $('hotspot-note').textContent =
        '宿主拥有的角色热点：Tab 聚焦，Enter / 空格激活。只改变场景，不启动任务；此 demo 未验证隔离渲染器的命中保护。';
    } else if (isMemeScene()) {
      $('scene-trigger').dataset.hostHotspot = key;
      $('scene-trigger').setAttribute('aria-controls', 'meme-state');
      $('hotspot-note').textContent =
        '宿主按钮支持 Tab、Enter 和空格。互动持续 2.4 秒，重复触发只延长互动；不写任务进度。暂停、失败、取消和完成时由任务状态接管。';
    } else {
      delete $('scene-trigger').dataset.hostHotspot;
      $('scene-trigger').removeAttribute('aria-controls');
      $('hotspot-note').textContent =
        '此按钮由演示宿主管理。任务反馈预览仅在待机时启用；重置可返回待机。运行、失败与取消状态由任务控件决定。';
    }
    $('capability-tags').replaceChildren(
      ...def.tags.map((tag) => Object.assign(document.createElement('span'), { textContent: tag })),
    );
    $('intensity').min = def.range[0];
    $('intensity').max = def.range[1];
    setIntensity(def.range[2]);
    renderTasks();
    log(`skin.mounted → ${def.name} · 等待交互`);
  }
  function toggleEffect() {
    const def = sceneDefs[state.skin];
    if (isMemeScene()) {
      if (!['idle', 'running'].includes(state.phase)) return;
      stopInteraction();
      state.effect = true;
      stage.classList.add(def.effect);
      const revision = state.interactionRevision;
      state.interactionTimer = setTimeout(() => {
        if (state.interactionRevision !== revision) return;
        stopInteraction();
        renderTasks();
        log('interaction.timeout → rest · 任务状态和进度保持不变');
      }, 2400);
      renderTasks();
      log(`interaction.${def.effect} → 2400 ms · 仅角色互动，不改变任务`);
      return;
    }
    state.effect = !state.effect;
    stage.classList.toggle(def.effect, state.effect);
    if (state.skin === 'mascot') (state.effect ? $('reservation') : appWrap).append(mascot);
    $('scene-trigger').replaceChildren(
      document.createTextNode(def.trigger[state.effect ? 1 : 0]),
      Object.assign(document.createElement('span'), { textContent: state.effect ? '↶' : '→' }),
    );
    $('scene-trigger').setAttribute('aria-pressed', String(state.effect));
    renderTasks();
    log(
      state.skin === 'mascot'
        ? `layout.request → ${state.effect ? state.intensity : 0}px · 宿主最多分配操作栏的 40%`
        : `preview.${def.effect} → ${state.effect ? 'on' : 'off'} · ${def.name}`,
    );
  }
  function startClock() {
    stopClock();
    if (['vinyl', 'sonar', 'paper'].includes(state.skin)) {
      state.effect = false;
      stage.classList.remove(sceneDefs[state.skin].effect);
    }
    state.phase = 'running';
    renderTasks();
    log('task.status → running · 仅模拟执行，不连接真实设备');
    state.timer = setInterval(() => {
      state.progress = Math.min(100, state.progress + 5);
      if (state.progress === 100) {
        stopClock();
        state.phase = 'success';
        log('task.status → success · 全部完成，皮肤接收成功状态');
      }
      renderTasks();
    }, 650);
  }
  $('run-button').addEventListener('click', () => {
    if (!selected().length) return;
    if (state.phase === 'running') {
      stopClock();
      stopInteraction();
      state.phase = 'paused';
      renderTasks();
      log('task.status → paused · 动画跟随暂停');
      return;
    }
    if (state.phase !== 'paused') state.progress = 0;
    startClock();
  });
  $('stop-button').addEventListener('click', () => {
    if (!['running', 'paused'].includes(state.phase)) return;
    stopClock();
    state.phase = 'cancelled';
    renderTasks();
    log('task.status → cancelled · 用户停止，不触发成功反馈');
  });
  $('fail-button').addEventListener('click', () => {
    if (!['running', 'paused'].includes(state.phase)) return;
    stopClock();
    state.phase = 'error';
    renderTasks();
    log('task.status → error · 模拟连接失败，可从头重试');
  });
  taskInputs.forEach((input) =>
    input.addEventListener('change', () => {
      stopClock();
      stopInteraction();
      state.progress = 0;
      state.phase = 'idle';
      renderTasks();
      log(`selection.changed → 已选择 ${selected().length} 项任务`);
    }),
  );
  document
    .querySelectorAll('[data-skin]')
    .forEach((button) => button.addEventListener('click', () => selectSkin(button.dataset.skin)));
  $('scene-trigger').addEventListener('click', toggleEffect);
  $('intensity').addEventListener('input', (event) => {
    setIntensity(event.target.value);
    if (state.skin === 'mascot' && state.effect)
      log(`layout.request → ${state.intensity}px · 受可用空间上限约束`);
  });
  $('show-bounds').addEventListener('change', (event) => {
    stage.classList.toggle('show-bounds', event.target.checked);
    log(`debug.bounds → ${event.target.checked ? 'on · 橙色面板 / 绿色布局 / 紫色装饰' : 'off'}`);
  });
  $('reduce-motion').addEventListener('change', syncMotion);
  if (media.addEventListener) media.addEventListener('change', syncMotion);
  $('reset').addEventListener('click', () => {
    taskInputs.forEach((input) => {
      input.checked = true;
    });
    $('show-bounds').checked = false;
    $('reduce-motion').checked = media.matches;
    selectSkin(state.skin);
    $('import-result').textContent = '已恢复当前场景默认配置。';
  });
  function makePreset() {
    return {
      format: 'mxu-skin-demo/0.1',
      name: state.presetName || sceneDefs[state.skin].name,
      scene: state.skin,
      accent: state.accent || getComputedStyle(stage).getPropertyValue('--app-accent').trim(),
      intensity: state.intensity,
      effect: state.effect,
    };
  }
  function validatePreset(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('文件内容必须是一个 JSON 对象。');
    const allowed = ['format', 'name', 'scene', 'accent', 'intensity', 'effect'];
    if (Object.keys(data).some((key) => !allowed.includes(key)))
      throw new Error('含有不支持的字段；此演示器只接受导出的轻量预设。');
    if (data.format !== 'mxu-skin-demo/0.1')
      throw new Error('格式不匹配，请使用 mxu-skin-demo/0.1 演示预设。');
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 40)
      throw new Error('预设名称必须是 1–40 个字符。');
    if (typeof data.scene !== 'string' || !Object.hasOwn(sceneDefs, data.scene))
      throw new Error('场景必须是八个内置场景之一。');
    if (typeof data.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(data.accent))
      throw new Error('accent 需要 #RRGGBB 格式的颜色。');
    const [min, max] = sceneDefs[data.scene].range;
    if (!Number.isFinite(data.intensity) || data.intensity < min || data.intensity > max)
      throw new Error(`此场景的 intensity 必须介于 ${min} 和 ${max}。`);
    if (typeof data.effect !== 'boolean') throw new Error('effect 必须是 true 或 false。');
    return data;
  }
  $('export-preset').addEventListener('click', () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(makePreset(), null, 2) + '\n'], { type: 'application/json' }),
    );
    const link = Object.assign(document.createElement('a'), {
      href: url,
      download: `mxu-${state.skin}.demo.json`,
    });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('import-result').textContent =
      '已导出演示预设。可修改 name、accent 和 intensity 后重新导入。';
  });
  $('import-preset').addEventListener('click', () => $('preset-file').click());
  $('preset-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 16 * 1024) throw new Error('演示预设最大为 16 KB。');
      const data = validatePreset(JSON.parse(await file.text()));
      selectSkin(data.scene);
      state.accent = data.accent;
      state.presetName = data.name.trim();
      stage.style.setProperty('--app-accent', data.accent);
      setIntensity(data.intensity);
      if (data.effect) toggleEffect();
      $('import-result').textContent =
        `已应用「${data.name.trim()}」。只导入演示配置，没有加载 HTML、脚本或外部资源。`;
      log(`preset.imported → ${data.name.trim()} · ${data.format}`);
    } catch (error) {
      $('import-result').textContent =
        `导入失败：${error instanceof SyntaxError ? 'JSON 格式有误，请检查逗号与引号。' : error.message}`;
    }
    event.target.value = '';
  });
  function renderIdeas(filter = '全部') {
    const ideas = Array.isArray(window.MXU_IDEAS) ? window.MXU_IDEAS : [];
    const cards = ideas
      .filter((idea) => filter === '全部' || idea.category === filter)
      .map((idea) => {
        const card = document.createElement('article');
        card.className = 'idea-card';
        const top = document.createElement('div');
        top.className = 'idea-top';
        const index = ideas.indexOf(idea) + 1;
        top.append(
          Object.assign(document.createElement('span'), {
            textContent: `IDEA ${String(index).padStart(2, '0')} / ${idea.category}`,
          }),
          Object.assign(document.createElement('span'), {
            textContent: idea.level === 'L2' ? 'L2 · 进阶扩展' : 'L1 · 声明式',
          }),
        );
        const title = Object.assign(document.createElement('h4'), { textContent: idea.title });
        const concept = Object.assign(document.createElement('p'), { textContent: idea.concept });
        const tags = document.createElement('div');
        tags.className = 'idea-tags';
        tags.append(
          ...idea.capability.map((tag) =>
            Object.assign(document.createElement('span'), { textContent: tag }),
          ),
        );
        const detail = document.createElement('details');
        detail.append(
          Object.assign(document.createElement('summary'), { textContent: '正常操作如何保留' }),
          Object.assign(document.createElement('p'), { textContent: idea.restraint }),
        );
        card.append(top, title, concept, tags, detail);
        return card;
      });
    $('ideas-grid').replaceChildren(...cards);
    document.querySelectorAll('[data-filter]').forEach((button) => {
      const active = button.dataset.filter === filter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  document
    .querySelectorAll('[data-filter]')
    .forEach((button) =>
      button.addEventListener('click', () => renderIdeas(button.dataset.filter)),
    );
  window.addEventListener('pagehide', () => {
    pageActive = false;
    stopClock();
    stopInteraction();
    syncSkinVideos(true);
    if (state.phase === 'running') {
      state.phase = 'paused';
      log('task.status → paused · 离开页面时自动暂停');
    }
    renderTasks();
  });
  window.addEventListener('pageshow', () => {
    pageActive = true;
    syncSkinVideos();
  });
  document.addEventListener('visibilitychange', () => syncSkinVideos());
  const sectionAnchors = new Set(['playground', 'ideas', 'architecture']);
  function selectHashScene() {
    const key = window.location.hash.slice(1);
    // Page navigation anchors must not reset an ongoing task simulation.
    if (sectionAnchors.has(key)) return;
    selectSkin(Object.hasOwn(sceneDefs, key) ? key : 'mascot', false);
  }
  window.addEventListener('hashchange', selectHashScene);
  selectSkin(
    Object.hasOwn(sceneDefs, window.location.hash.slice(1))
      ? window.location.hash.slice(1)
      : 'mascot',
    false,
  );
  renderIdeas();
  // An intentionally narrow, read-only entry point for static contract checks.
  window.MXUSkinDemo = { validatePreset, makePreset };
})();
