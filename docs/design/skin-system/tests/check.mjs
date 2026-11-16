import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';
import { marked } from 'marked';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const results = [];
const pass = (label) => results.push(label);
const plain = (value) => JSON.parse(JSON.stringify(value));

// These are document/data checks, not a production skin-package schema validator.
const ideas = JSON.parse(read('ideas.json'));
assert.equal(ideas.length, 24);
assert.equal(new Set(ideas.map((idea) => idea.id)).size, ideas.length);
const categories = new Set(['角色', '空间', '状态', '交互', '叙事']);
for (const [index, idea] of ideas.entries()) {
  assert.equal(idea.number, index + 1);
  for (const key of ['id', 'title', 'concept', 'restraint']) {
    assert.equal(typeof idea[key], 'string', `idea ${index + 1}: ${key}`);
    assert(idea[key].trim().length > 0);
  }
  assert(categories.has(idea.category));
  assert(['L1', 'L2'].includes(idea.level));
  assert(Array.isArray(idea.capability));
  assert(idea.capability.length >= 3 && idea.capability.length <= 4);
  assert(idea.capability.every((tag) => typeof tag === 'string' && tag.trim()));
}
pass('ideas.json: 24 unique ideas, stable numbering and typed fields');

const manifest = JSON.parse(read('demo/examples/mascot.skin.json'));
const protocolTokens = marked.lexer(read('protocol.md'));
const jsonExamples = [];
marked.walkTokens(protocolTokens, (token) => {
  if (token.type === 'code' && token.lang === 'json') {
    jsonExamples.push(JSON.parse(token.text));
  }
});
const documentedManifest = jsonExamples.find((example) => example.id === manifest.id);
assert(documentedManifest, 'protocol.md must include the downloadable manifest example');
assert.deepEqual(documentedManifest, manifest);
assert.equal(typeof manifest.schemaVersion, 'string');
assert.equal(typeof manifest.version, 'string');
assert.equal(typeof manifest.mxu.skinApi, 'string');
assert(manifest.name && typeof manifest.name === 'object' && !Array.isArray(manifest.name));
assert(Object.values(manifest.name).every((name) => typeof name === 'string' && name.trim()));
for (const field of ['required', 'optional']) {
  assert(Array.isArray(manifest.capabilities[field]));
  assert(manifest.capabilities[field].every((value) => typeof value === 'string'));
}
pass('protocol JSON examples parse; manifest example exactly matches its downloadable JSON');

// Check references and declared write targets rather than inventing a skin runtime
// to execute a design-only manifest. Neither binding may write the host task state.
const interactionStates = new Set(manifest.scene.interactionStates);
assert(interactionStates.has(manifest.scene.initialInteractionState));
const placements = new Set(manifest.placements.map((placement) => placement.id));
const hotspots = new Set(manifest.hotspots.map((hotspot) => hotspot.id));
assert.equal(placements.size, manifest.placements.length);
assert(
  manifest.placements.every(
    (placement) =>
      typeof placement.id === 'string' &&
      placement.id &&
      typeof placement.element === 'string' &&
      placement.element,
  ),
);
assert.equal(hotspots.size, manifest.hotspots.length);
for (const hotspot of manifest.hotspots) assert(placements.has(hotspot.placement));
for (const binding of manifest.bindings) {
  assert(interactionStates.has(binding.setInteractionState));
  if (binding.event === 'host.hotspot.activate') {
    assert.deepEqual(Object.keys(binding).sort(), ['event', 'setInteractionState', 'target']);
    assert(hotspots.has(binding.target));
  } else {
    assert.equal(binding.event, 'interaction.timeout');
    assert.deepEqual(Object.keys(binding).sort(), [
      'afterMs',
      'event',
      'setInteractionState',
      'state',
    ]);
    assert(interactionStates.has(binding.state));
    assert(Number.isFinite(binding.afterMs) && binding.afterMs > 0);
  }
}
for (const reservation of manifest.reservations) {
  assert(interactionStates.has(reservation.when['interaction.state']));
}
pass(
  'manifest hotspots, placements and interaction references resolve; bindings only write interaction state',
);

const htmlDocuments = new Map();
function htmlDocument(file) {
  if (!htmlDocuments.has(file)) {
    const document = new JSDOM(fs.readFileSync(file, 'utf8')).window.document;
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `duplicate HTML id in ${path.relative(root, file)}`,
    );
    htmlDocuments.set(file, document);
  }
  return htmlDocuments.get(file);
}
let checkedLinks = 0;
function checkLink(source, href) {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return;
  const url = new URL(href, pathToFileURL(source));
  const target = fileURLToPath(url);
  assert(fs.existsSync(target), `${path.relative(root, source)}: missing local link ${href}`);
  assert(
    fs.statSync(target).isFile(),
    `${path.relative(root, source)}: expected a file for ${href}`,
  );
  if (url.hash && path.extname(target) === '.html') {
    assert(
      htmlDocument(target).getElementById(decodeURIComponent(url.hash.slice(1))),
      `${path.relative(root, source)}: missing HTML fragment ${href}`,
    );
  }
  checkedLinks++;
}
for (const relative of [
  'README.md',
  'protocol.md',
  'ideas.md',
  'meme-skins.md',
  'review-notes.md',
]) {
  const source = path.join(root, relative);
  marked.walkTokens(marked.lexer(read(relative)), (token) => {
    if (token.type === 'link' || token.type === 'image') checkLink(source, token.href);
  });
}
for (const relative of ['demo/index.html', 'demo/protocol.html']) {
  const source = path.join(root, relative);
  for (const element of htmlDocument(source).querySelectorAll('[href], [src], [poster]')) {
    for (const attribute of ['href', 'src', 'poster']) {
      if (element.hasAttribute(attribute)) checkLink(source, element.getAttribute(attribute));
    }
  }
}
for (const document of htmlDocuments.values()) document.defaultView.close();
pass(`local documentation links, images and HTML fragments resolve (${checkedLinks} references)`);

const css = read('demo/style.css');
for (const script of ['demo/app.js', 'demo/ideas.js']) {
  new vm.Script(read(script), { filename: script });
}
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => errors.push(error.message));
const dom = new JSDOM(read('demo/index.html'), {
  runScripts: 'outside-only',
  url: 'https://test.invalid/',
  virtualConsole,
});
const w = dom.window;
const d = w.document;
const visibility = { hidden: false };
Object.defineProperty(d, 'hidden', { configurable: true, get: () => visibility.hidden });
const playback = { plays: 0, pauses: 0, mode: 'resolve', pending: [] };
const pausedMedia = new WeakMap();
Object.defineProperty(w.HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  get() {
    return pausedMedia.get(this) ?? true;
  },
});
w.HTMLMediaElement.prototype.play = function () {
  playback.plays++;
  if (playback.mode === 'throw') throw new Error('Playback is unavailable');
  if (playback.mode === 'reject') return Promise.reject(new Error('Playback was denied'));
  if (playback.mode === 'pending') {
    return new Promise((resolve) =>
      playback.pending.push(() => {
        pausedMedia.set(this, false);
        resolve();
      }),
    );
  }
  pausedMedia.set(this, false);
  return Promise.resolve();
};
w.HTMLMediaElement.prototype.pause = function () {
  playback.pauses++;
  pausedMedia.set(this, true);
};
const $ = (id) => {
  const element = d.getElementById(id);
  assert(element, `missing demo element #${id}`);
  return element;
};
const style = d.createElement('style');
style.textContent = css;
d.head.append(style);
const timers = new Map();
const timeouts = new Map();
let timerSequence = 0;
w.setInterval = (callback, delay) => {
  const id = ++timerSequence;
  timers.set(id, { callback, delay });
  return id;
};
w.clearInterval = (id) => timers.delete(id);
w.setTimeout = (callback, delay) => {
  const id = ++timerSequence;
  timeouts.set(id, { callback, delay });
  return id;
};
w.clearTimeout = (id) => timeouts.delete(id);
const media = {
  matches: false,
  listener: null,
  addEventListener(type, listener) {
    assert.equal(type, 'change');
    this.listener = listener;
  },
};
w.matchMedia = () => media;
const tick = (count = 1) => {
  for (let i = 0; i < count; i++) {
    for (const timer of [...timers.values()]) timer.callback();
  }
};
const expireInteractions = () => {
  const pending = [...timeouts.values()];
  timeouts.clear();
  for (const timer of pending) timer.callback();
};
const change = (id, checked) => {
  const element = $(id);
  element.checked = checked;
  element.dispatchEvent(new w.Event('change'));
};
const skin = (name) => d.querySelector(`[data-skin="${name}"]`).click();
const state = (name, text) => {
  assert.equal($('stage').dataset.runState, name);
  assert.equal($('status-label').textContent, text);
};
w.eval(read('demo/ideas.js'));
w.eval(read('demo/app.js'));
assert.deepEqual(plain(w.MXU_IDEAS), ideas);
assert.equal(d.querySelectorAll('.idea-card').length, 24);
assert.equal(timers.size, 0);
assert.equal(timeouts.size, 0);
pass('demo mounts without timers and renders the canonical 24 ideas');

const configurations = {
  mascot: [132, 'mischief'],
  mecha: [100, 'armed'],
  garden: [75, 'night'],
  vinyl: [50, 'audition'],
  paper: [5, 'stamped'],
  sonar: [50, 'pinging'],
  deepseek: [100, 'feeding'],
  naiwa: [100, 'laughing'],
};
assert.equal(d.querySelectorAll('[data-skin]').length, 8);
const memeScenes = ['deepseek', 'naiwa'];
const tasks = [...d.querySelectorAll('[data-task]')];
for (const [name, [intensity, effect]] of Object.entries(configurations)) {
  skin(name);
  state('idle', '待机中');
  assert($('stage').classList.contains(`theme-${name}`));
  assert.equal(d.querySelectorAll('[data-skin][aria-pressed="true"]').length, 1);
  assert.equal(Number($('intensity').value), intensity);
  $('scene-trigger').click();
  assert($('stage').classList.contains(effect));
  assert.equal($('scene-trigger').getAttribute('aria-pressed'), 'true');
  $('scene-trigger').click();
  if (memeScenes.includes(name)) {
    assert($('stage').classList.contains(effect));
    assert.equal(timeouts.size, 1, 'repeated interaction replaces its timeout');
    assert.equal([...timeouts.values()][0].delay, 2400);
    expireInteractions();
  }
  assert(!$('stage').classList.contains(effect));
  const preset = w.MXUSkinDemo.makePreset();
  assert.equal(preset.scene, name);
  w.MXUSkinDemo.validatePreset(preset);

  $('run-button').click();
  state('running', '执行中');
  assert.equal(timers.size, 1);
  assert(tasks.every((input) => input.disabled));
  const runningAnnouncement = $('task-announcement').textContent;
  tick(3);
  assert.equal($('progress-value').textContent, '15%');
  assert.equal($('task-progress').getAttribute('aria-valuenow'), '15');
  assert.equal($('task-announcement').textContent, runningAnnouncement);
  $('run-button').click();
  state('paused', '已暂停');
  assert.equal(timers.size, 0);
  assert.equal(timeouts.size, 0);
  assert.equal($('run-label').textContent, '继续任务');
  tick();
  assert.equal($('progress-value').textContent, '15%');
  $('run-button').click();
  assert.equal(timers.size, 1);
  tick();
  assert.equal($('progress-value').textContent, '20%');

  $('stop-button').click();
  state('cancelled', '已取消');
  assert.equal(timers.size, 0);
  assert($('stop-button').disabled);
  assert($('fail-button').disabled);
  assert(tasks.every((input) => !input.disabled));
  assert.equal($('run-label').textContent, '重新开始');
  assert(!$('stage').classList.contains('complete'));
  $('run-button').click();
  assert.equal($('progress-value').textContent, '0%');
  tick(2);
  $('fail-button').click();
  state('error', '执行失败');
  assert.equal(timers.size, 0);
  assert.equal($('run-label').textContent, '重试任务');
  assert.equal($('progress-value').textContent, '10%');
  assert(tasks.every((input) => !input.disabled));
  assert(!$('stage').classList.contains('complete'));
  assert($('fail-button').disabled);
  tick(20);
  assert.equal($('progress-value').textContent, '10%');
  $('run-button').click();
  assert.equal($('progress-value').textContent, '0%');
  tick(20);
  state('success', '已完成');
  assert.equal(timers.size, 0);
  assert.equal($('completed-count').textContent, '3');
  assert.equal(d.querySelectorAll('.task-row.done').length, 3);
  assert($('stage').classList.contains('complete'));
  assert.equal($('task-progress').getAttribute('aria-valuenow'), '100');
  $('run-button').click();
  assert.equal(timers.size, 1);
  skin(name === 'mascot' ? 'mecha' : 'mascot');
  assert.equal(timers.size, 0);
  assert.equal($('progress-value').textContent, '0%');
  pass(
    `${name}: effects, export, start, pause, resume, cancel, error, retry, success and timer cleanup`,
  );
}

for (const name of memeScenes) {
  const effect = configurations[name][1];
  skin(name);
  const title = name === 'deepseek' ? '蓝色大肥鱼 · 吃白饭' : '奶蛙 · 大笑';
  assert.equal($('scene-title').textContent, title);
  assert.equal($('inspector-title').textContent, title);
  assert($('scene-trigger').textContent.startsWith(name === 'deepseek' ? '投喂白饭' : '播放大笑'));
  assert.equal($('scene-trigger').dataset.hostHotspot, name);
  assert.equal($('scene-trigger').getAttribute('aria-controls'), 'meme-state');
  $('run-button').click();
  tick(2);
  const progress = $('progress-value').textContent;
  const renderedProgress = $('rice-fill').style.getPropertyValue('--task-progress');
  assert.equal(renderedProgress, '0.1');
  assert.equal($('meme-progress-text').textContent, '任务进度 10%');
  assert.equal($('meme-state').textContent, '执行中');
  assert.equal(d.getElementById('meme-dialogue'), null);
  assert.equal(d.querySelector('.laugh-caption'), null);
  $('scene-trigger').click();
  assert(
    $('scene-trigger').textContent.startsWith(
      name === 'deepseek' ? '再次投喂白饭' : '再次播放大笑',
    ),
  );
  const firstTimeout = [...timeouts.keys()][0];
  const firstCallback = timeouts.get(firstTimeout).callback;
  assert.equal(timeouts.size, 1);
  $('scene-trigger').click();
  assert.equal(timeouts.size, 1);
  assert(!timeouts.has(firstTimeout), 'repeated activation cancels its previous timeout');
  firstCallback();
  assert($('stage').classList.contains(effect), 'a stale timeout cannot clear a newer interaction');
  assert.equal(timeouts.size, 1);
  assert.equal($('progress-value').textContent, progress, 'interaction never advances a task');
  assert.equal($('rice-fill').style.getPropertyValue('--task-progress'), renderedProgress);
  assert.equal($('meme-progress-text').textContent, '任务进度 10%');
  assert.equal(
    $('meme-state').textContent,
    `执行中 · ${name === 'deepseek' ? '投喂中' : '播放大笑'}`,
  );
  expireInteractions();
  state('running', '执行中');
  assert.equal(timers.size, 1, 'interaction expiry preserves the task clock');
  assert.equal($('progress-value').textContent, progress);
  assert(!$('stage').classList.contains(effect));
  assert.equal($('scene-trigger').getAttribute('aria-pressed'), 'false');
  assert($('meme-state').textContent.trim());

  $('scene-trigger').click();
  $('run-button').click();
  state('paused', '已暂停');
  assert.equal(timeouts.size, 0);
  assert.equal(timers.size, 0);
  assert(!$('stage').classList.contains(effect));
  assert(!$('stage').classList.contains('running'));
  assert($('scene-trigger').disabled);
  tick(2);
  expireInteractions();
  assert.equal($('progress-value').textContent, progress);
  assert.match($('meme-state').textContent, /暂停|继续/);
  $('run-button').click();
  $('scene-trigger').click();
  $('stop-button').click();
  state('cancelled', '已取消');
  assert.equal(timeouts.size, 0);
  assert(!$('stage').classList.contains(effect));
  assert.match($('meme-state').textContent, /取消/);
  assert($('scene-trigger').disabled);
  expireInteractions();
  state('cancelled', '已取消');

  $('run-button').click();
  tick(2);
  $('scene-trigger').click();
  $('fail-button').click();
  state('error', '执行失败');
  assert.equal(timeouts.size, 0);
  assert(!$('stage').classList.contains(effect));
  assert.match($('meme-state').textContent, /失败/);
  assert($('scene-trigger').disabled);
  expireInteractions();
  state('error', '执行失败');

  $('run-button').click();
  tick(19);
  $('scene-trigger').click();
  tick();
  state('success', '已完成');
  assert.equal(timeouts.size, 0);
  assert.equal(timers.size, 0);
  assert(!$('stage').classList.contains(effect));
  assert.match($('meme-state').textContent, /完成/);
  assert($('scene-trigger').disabled);
  expireInteractions();
  state('success', '已完成');
  pass(
    `${name}: repeated interaction and expiry preserve task progress; pause and terminal states take priority`,
  );

  $('reset').click();
  $('scene-trigger').click();
  assert.equal(timeouts.size, 1);
  $('reset').click();
  assert.equal(timeouts.size, 0);
  assert(!$('stage').classList.contains(effect));
  $('scene-trigger').click();
  const previousSceneCallback = [...timeouts.values()][0].callback;
  skin(name === 'deepseek' ? 'naiwa' : 'deepseek');
  assert.equal(timeouts.size, 0);
  assert(!$('stage').classList.contains(effect));
  assert.equal($('progress-value').textContent, '0%');
  $('scene-trigger').click();
  previousSceneCallback();
  assert.equal(timeouts.size, 1, 'an unloaded scene cannot clear the new scene interaction');
  assert(
    $('stage').classList.contains(configurations[name === 'deepseek' ? 'naiwa' : 'deepseek'][1]),
  );
  skin(name);
  $('run-button').click();
  tick(2);
  $('scene-trigger').click();
  w.dispatchEvent(new w.Event('pagehide'));
  state('paused', '已暂停');
  assert.equal(timeouts.size, 0);
  assert.equal(timers.size, 0);
  assert(!$('stage').classList.contains(effect));
  assert.equal($('progress-value').textContent, '10%');
  $('reset').click();
  $('scene-trigger').click();
  w.dispatchEvent(new w.Event('pagehide'));
  state('idle', '待机中');
  assert.equal(timeouts.size, 0);
  assert.equal($('scene-trigger').getAttribute('aria-pressed'), 'false');
  pass(`${name}: reset, scene change and pagehide cancel interactions without stale task feedback`);
}

tasks.forEach((input) => {
  input.checked = false;
  input.dispatchEvent(new w.Event('change'));
});
assert.equal($('selected-count').textContent, '0');
assert($('run-button').disabled);
$('run-button').click();
assert.equal(timers.size, 0);
tasks[1].checked = true;
tasks[1].dispatchEvent(new w.Event('change'));
assert.equal($('selected-count').textContent, '1');
$('run-button').click();
tick(20);
assert.equal($('completed-count').textContent, '1');
assert.equal(d.querySelectorAll('.task-row.done').length, 1);
assert.equal(tasks[0].closest('.task-row').querySelector('.task-state').textContent, '跳过');
pass('selection: no tasks disables start; selected subset completes independently');

$('reset').click();
assert.equal($('selected-count').textContent, '3');
assert.equal(timers.size, 0);
change('show-bounds', true);
assert($('stage').classList.contains('show-bounds'));
skin('mecha');
assert($('stage').classList.contains('show-bounds'));
change('reduce-motion', true);
assert($('stage').classList.contains('reduce-motion'));
skin('garden');
assert($('stage').classList.contains('reduce-motion'));
change('reduce-motion', false);
assert(!$('stage').classList.contains('reduce-motion'));
media.matches = true;
media.listener();
assert($('reduce-motion').disabled);
assert($('stage').classList.contains('reduce-motion'));
pass('reset, persistent debug/motion controls and enforced system motion reduction');
for (const name of memeScenes) {
  skin(name);
  assert($('stage').classList.contains('reduce-motion'));
  assert($('reduce-motion').disabled);
  $('run-button').click();
  tick(20);
  state('success', '已完成');
  assert.match($('meme-state').textContent, /完成/);
  assert.equal($('meme-progress-text').textContent, '任务进度 100%');
  assert.equal($('task-progress').getAttribute('aria-valuenow'), '100');
  assert.equal($('rice-fill').style.getPropertyValue('--task-progress'), '1');
  assert.equal(timeouts.size, 0);
}
pass('both meme scenes retain readable task results with system motion reduction enforced');

const valid = {
  format: 'mxu-skin-demo/0.1',
  name: 'My preset',
  scene: 'mascot',
  accent: '#aadea6',
  intensity: 132,
  effect: true,
};
assert.doesNotThrow(() => w.MXUSkinDemo.validatePreset(valid));
const invalid = [
  null,
  [],
  {},
  { ...valid, script: 'alert(1)' },
  { ...valid, format: '0.1' },
  { ...valid, scene: '__proto__' },
  { ...valid, scene: 'unknown' },
  { ...valid, scene: ['mascot'] },
  { ...valid, name: '' },
  { ...valid, name: 'a'.repeat(41) },
  { ...valid, accent: 'url(https://bad.invalid)' },
  { ...valid, accent: '#ff00ff;display:none' },
  { ...valid, intensity: 1000 },
  { ...valid, intensity: '132' },
  { ...valid, intensity: Infinity },
  { ...valid, effect: 1 },
  JSON.parse('{"__proto__":{},"format":"mxu-skin-demo/0.1"}'),
];
for (const value of invalid) assert.throws(() => w.MXUSkinDemo.validatePreset(value));
pass(`preset validator rejects ${invalid.length} invalid structures, fields, values and types`);

for (const button of d.querySelectorAll('[data-filter]')) {
  button.click();
  const category = button.dataset.filter;
  const expected = ideas.filter((idea) => category === '全部' || idea.category === category);
  const cards = [...d.querySelectorAll('.idea-card')];
  assert.equal(cards.length, expected.length);
  assert.equal(d.querySelectorAll('[data-filter][aria-pressed="true"]').length, 1);
  for (const [index, card] of cards.entries()) {
    assert.equal(card.querySelector('h4').textContent, expected[index].title);
    assert(
      card
        .querySelector('.idea-top')
        .textContent.includes(`IDEA ${String(expected[index].number).padStart(2, '0')}`),
    );
  }
}
pass('all category filters retain the canonical idea titles and stable numbers');

const input = $('preset-file');
async function importFile(data, size = 100) {
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [{ size, text: async () => (typeof data === 'string' ? data : JSON.stringify(data)) }],
  });
  input.dispatchEvent(new w.Event('change'));
  await Promise.resolve();
  await Promise.resolve();
}
await importFile({ ...valid, name: '<img src=x onerror=alert(1)>', accent: '#123456' });
assert.equal(w.MXUSkinDemo.makePreset().accent, '#123456');
assert.equal($('import-result').querySelector('img'), null);
assert($('stage').classList.contains('mischief'));
const importedPreset = plain(w.MXUSkinDemo.makePreset());
await importFile(valid, 17000);
assert($('import-result').textContent.includes('16 KB'));
assert.deepEqual(plain(w.MXUSkinDemo.makePreset()), importedPreset);
await importFile('{broken');
assert($('import-result').textContent.includes('JSON 格式有误'));
assert.deepEqual(plain(w.MXUSkinDemo.makePreset()), importedPreset);
pass('import handler applies data as text and preserves the current preset on invalid files');
for (const name of memeScenes) {
  const example = JSON.parse(read(`demo/examples/${name}.demo.json`));
  assert.equal(example.scene, name);
  assert.doesNotThrow(() => w.MXUSkinDemo.validatePreset(example));
  await importFile(example);
  assert.deepEqual(plain(w.MXUSkinDemo.makePreset()), example);
  assert($('stage').classList.contains(`theme-${name}`));
  for (const intensity of [name === 'deepseek' ? 59 : 49, name === 'deepseek' ? 141 : 151])
    assert.throws(() => w.MXUSkinDemo.validatePreset({ ...example, intensity }));
}
pass('downloadable meme presets import and export unchanged and enforce scene-specific ranges');

$('run-button').click();
assert.equal(timers.size, 1);
w.dispatchEvent(new w.Event('pagehide'));
assert.equal(timers.size, 0);
state('paused', '已暂停');
$('run-button').click();
assert.equal(timers.size, 1);
tick();
assert.equal($('progress-value').textContent, '5%');
$('stop-button').click();
pass('pagehide clears the interval and leaves a resumable paused task');

skin('deepseek');
$('run-button').click();
tick(2);
$('scene-trigger').click();
for (const anchor of ['playground', 'ideas', 'architecture']) {
  w.history.replaceState(null, '', `#${anchor}`);
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  assert($('stage').classList.contains('theme-deepseek'));
  state('running', '执行中');
  assert.equal($('progress-value').textContent, '10%');
  assert.equal(timers.size, 1);
  assert.equal(timeouts.size, 1);
}
for (const anchor of ['unknown', '__proto__']) {
  w.history.replaceState(null, '', `#${anchor}`);
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  assert($('stage').classList.contains('theme-mascot'));
  state('idle', '待机中');
  assert.equal(timers.size, 0);
  assert.equal(timeouts.size, 0);
}
pass('page section hashes preserve ongoing tasks; unknown scene hashes fall back and clean up');
for (const name of memeScenes) {
  const direct = new JSDOM(read('demo/index.html'), {
    runScripts: 'outside-only',
    url: `https://test.invalid/#${name}`,
  });
  direct.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  direct.window.eval(read('demo/ideas.js'));
  direct.window.eval(read('demo/app.js'));
  assert(direct.window.document.getElementById('stage').classList.contains(`theme-${name}`));
  assert.equal(direct.window.MXUSkinDemo.makePreset().scene, name);
  direct.window.close();
}
pass('direct links mount each meme scene without an intermediate scene selection');

for (const name of ['vinyl', 'sonar', 'paper']) {
  skin(name);
  $('scene-trigger').click();
  assert($('stage').classList.contains(configurations[name][1]));
  $('run-button').click();
  assert(!$('stage').classList.contains(configurations[name][1]));
  assert($('scene-trigger').disabled);
  assert.equal($('scene-trigger').getAttribute('aria-pressed'), 'false');
  $('run-button').click();
  state('paused', '已暂停');
  assert(!$('stage').classList.contains(configurations[name][1]));
  assert($('scene-trigger').disabled);
  $('fail-button').click();
  state('error', '执行失败');
  assert.equal(timers.size, 0);
  assert(!$('stage').classList.contains('complete'));
  assert($('scene-trigger').disabled);
}
pass('independent scene previews do not override task states; paused failures clear timers');

skin('mascot');
assert.equal($('scene-trigger').tagName, 'BUTTON');
assert.equal($('scene-trigger').dataset.hostHotspot, 'mascot');
assert.equal($('scene-trigger').getAttribute('aria-controls'), 'reservation');
assert.equal($('scene-trigger').getAttribute('aria-describedby'), 'hotspot-note');
$('scene-trigger').focus();
assert.equal(d.activeElement, $('scene-trigger'));
$('run-button').click();
$('scene-trigger').click();
state('running', '执行中');
tick(2);
$('scene-trigger').click();
state('running', '执行中');
assert.equal($('progress-value').textContent, '10%');
assert.equal(timers.size, 1);
$('stop-button').click();
skin('mascot');
$('scene-trigger').click();
assert.equal(d.querySelector('.mascot-actor').parentElement, $('reservation'));
$('scene-trigger').click();
assert.equal(d.querySelector('.mascot-actor').parentElement, d.querySelector('.app-wrap'));
$('scene-trigger').click();
skin('mecha');
assert.equal(d.querySelector('.mascot-actor').parentElement, d.querySelector('.app-wrap'));
assert.equal($('scene-trigger').getAttribute('data-host-hotspot'), null);
assert(!$('host-status').closest('.device-panel'));
assert($('host-status').contains($('completed-count')));
assert.equal($('task-progress').getAttribute('role'), 'progressbar');
assert.equal($('task-progress').getAttribute('aria-valuemin'), '0');
assert.equal($('task-progress').getAttribute('aria-valuemax'), '100');
assert.equal($('task-announcement').getAttribute('aria-live'), 'polite');
pass(
  'host hotspot remains focusable; actor reservation, progress semantics and status placement are preserved',
);

// Browser media methods are mocked here; decoding, frame output and geometry need a real browser.
const flushPlayback = () => new Promise((resolve) => setImmediate(resolve));
await flushPlayback();
media.matches = false;
media.listener();
change('reduce-motion', false);
w.dispatchEvent(new w.Event('pageshow'));
skin('naiwa');
const video = $('naiwa-motion');
assert(video.muted && video.defaultMuted && video.loop && video.playsInline);
assert(
  video.hasAttribute('muted') && video.hasAttribute('loop') && video.hasAttribute('playsinline'),
);
assert(!video.hasAttribute('autoplay'));
assert.equal(video.querySelector('source').getAttribute('type'), 'video/mp4');
assert.equal(video.paused, true);
const initialPlays = playback.plays;
$('scene-trigger').click();
assert.equal(playback.plays, initialPlays + 1);
assert.equal(video.paused, false);
assert($('stage').classList.contains('naiwa-performing'));
video.currentTime = 1.25;
assert.equal(video.playbackRate, 1, 'Naiwa starts at its original playback speed');
for (const [intensity, rate] of [
  [50, 0.5],
  [150, 1.5],
]) {
  $('intensity').value = String(intensity);
  $('intensity').dispatchEvent(new w.Event('input'));
  assert.equal(video.playbackRate, rate);
  assert.equal(playback.plays, initialPlays + 1, 'speed changes never restart a playing clip');
  assert.equal(video.currentTime, 1.25, 'speed changes preserve the current playback position');
}
$('run-button').click();
tick(3);
assert.equal(playback.plays, initialPlays + 1, 'task progress never restarts a playing clip');
assert.equal(video.currentTime, 1.25);
$('scene-trigger').click();
assert.equal(playback.plays, initialPlays + 1, 'repeated pokes keep a playing clip continuous');
expireInteractions();
assert.equal(video.paused, true);
assert(!$('stage').classList.contains('naiwa-performing'));
$('scene-trigger').click();
const continuingPlays = playback.plays;
tick(17);
state('success', '已完成');
assert.equal(video.paused, false);
assert.equal(playback.plays, continuingPlays, 'success continues an already playing celebration');
pass(
  'Naiwa uses a muted inline clip only for interaction or success and never seeks on progress ticks',
);

video.currentTime = 2.5;
visibility.hidden = true;
d.dispatchEvent(new w.Event('visibilitychange'));
assert.equal(video.paused, true);
assert.equal(video.currentTime, 2.5, 'background pause preserves the current frame');
assert(!$('stage').classList.contains('naiwa-performing'));
visibility.hidden = false;
d.dispatchEvent(new w.Event('visibilitychange'));
assert.equal(video.paused, false);
assert.equal(video.currentTime, 2.5);
change('reduce-motion', true);
assert.equal(video.paused, true);
assert(!$('stage').classList.contains('naiwa-performing'));
change('reduce-motion', false);
assert.equal(video.paused, false);
media.matches = true;
media.listener();
assert.equal(video.paused, true);
assert($('reduce-motion').disabled);
media.matches = false;
media.listener();
change('reduce-motion', false);
assert.equal(video.paused, false);
w.dispatchEvent(new w.Event('pagehide'));
assert.equal(video.paused, true);
assert.equal(video.currentTime, 0);
assert(!$('stage').classList.contains('naiwa-performing'));
await flushPlayback();
assert.equal(video.paused, true, 'success rendering cannot restart playback after pagehide');
w.dispatchEvent(new w.Event('pageshow'));
assert.equal(video.paused, false);
state('success', '已完成');
pass(
  'Naiwa media follows visibility and both motion preferences; pagehide cannot restart success playback',
);

for (const action of ['fail-button', 'stop-button', 'reset']) {
  $('reset').click();
  $('run-button').click();
  $('scene-trigger').click();
  assert.equal(video.paused, false);
  video.currentTime = 1.5;
  $(action).click();
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 0);
  assert(!$('stage').classList.contains('naiwa-performing'));
}
$('scene-trigger').click();
video.currentTime = 1.5;
skin('deepseek');
assert.equal(video.paused, true);
assert.equal(video.currentTime, 0);
pass('Naiwa failure, cancellation, reset and scene changes stop and rewind the clip');

skin('naiwa');
await flushPlayback();
playback.mode = 'reject';
$('scene-trigger').click();
await flushPlayback();
assert.equal(video.paused, true);
assert(!$('stage').classList.contains('naiwa-performing'));
assert($('meme-state').textContent.trim(), 'playback rejection retains readable static feedback');
$('reset').click();
playback.mode = 'throw';
$('scene-trigger').click();
assert.equal(video.paused, true);
assert(!$('stage').classList.contains('naiwa-performing'));
$('reset').click();
playback.mode = 'pending';
const beforePending = playback.plays;
$('scene-trigger').click();
$('run-button').click();
tick(3);
assert.equal(
  playback.plays,
  beforePending + 1,
  'an unresolved play promise is not retried each tick',
);
assert.equal(playback.pending.length, 1);
w.dispatchEvent(new w.Event('pagehide'));
playback.pending.shift()();
await flushPlayback();
assert.equal(
  video.paused,
  true,
  'late playback completion is stopped after the page becomes inactive',
);
assert(!$('stage').classList.contains('naiwa-performing'));
assert.equal(timers.size, 0);
assert.equal(timeouts.size, 0);
playback.mode = 'resolve';
w.dispatchEvent(new w.Event('pageshow'));
pass(
  'Naiwa media failures keep a static fallback; pending and stale playback promises cannot replay an inactive page',
);

skin('deepseek');
const deepseekVideo = $('deepseek-motion');
assert(
  deepseekVideo.muted &&
    deepseekVideo.defaultMuted &&
    deepseekVideo.loop &&
    deepseekVideo.playsInline,
);
assert(!deepseekVideo.hasAttribute('autoplay'));
assert.equal(deepseekVideo.querySelector('source').getAttribute('src'), 'assets/deepseek-eat.mp4');
assert.equal(deepseekVideo.querySelector('source').getAttribute('type'), 'video/mp4');
assert.equal(deepseekVideo.paused, true);
assert(
  !css.includes('@keyframes rice-munch'),
  'the original eating clip replaces simulated CSS movement',
);
assert.equal(w.getComputedStyle(deepseekVideo).objectFit, 'cover');
const deepseekInitialPlays = playback.plays;
$('scene-trigger').click();
assert.equal(playback.plays, deepseekInitialPlays + 1);
assert.equal(deepseekVideo.paused, false);
assert($('stage').classList.contains('deepseek-performing'));
assert.equal(video.paused, true, 'playing DeepSeek never starts Naiwa');
deepseekVideo.currentTime = 1.25;
for (const [intensity, rate] of [
  [60, 0.6],
  [140, 1.4],
]) {
  $('intensity').value = String(intensity);
  $('intensity').dispatchEvent(new w.Event('input'));
  assert.equal(deepseekVideo.playbackRate, rate);
  assert.equal(playback.plays, deepseekInitialPlays + 1);
  assert.equal(deepseekVideo.currentTime, 1.25);
}
$('run-button').click();
tick(3);
expireInteractions();
assert.equal(deepseekVideo.paused, false, 'DeepSeek keeps eating while the task is running');
assert.equal(
  playback.plays,
  deepseekInitialPlays + 1,
  'progress and interaction expiry never restart the clip',
);
assert.equal(deepseekVideo.currentTime, 1.25);
$('run-button').click();
state('paused', '已暂停');
assert.equal(deepseekVideo.paused, true);
assert(!$('stage').classList.contains('deepseek-performing'));
$('run-button').click();
assert.equal(deepseekVideo.paused, false);
change('reduce-motion', true);
assert.equal(deepseekVideo.paused, true);
assert(!$('stage').classList.contains('deepseek-performing'));
change('reduce-motion', false);
assert.equal(deepseekVideo.paused, false);
pass(
  'DeepSeek uses the original muted eating clip, supports playback speed and preserves frames across task ticks',
);

for (const action of ['fail-button', 'stop-button', 'reset']) {
  $('reset').click();
  $('run-button').click();
  deepseekVideo.currentTime = 1.5;
  $(action).click();
  assert.equal(deepseekVideo.paused, true);
  assert.equal(deepseekVideo.currentTime, 0);
  assert(!$('stage').classList.contains('deepseek-performing'));
}
$('run-button').click();
tick(20);
state('success', '已完成');
assert.equal(deepseekVideo.paused, false);
deepseekVideo.currentTime = 2.5;
visibility.hidden = true;
d.dispatchEvent(new w.Event('visibilitychange'));
assert.equal(deepseekVideo.paused, true);
visibility.hidden = false;
d.dispatchEvent(new w.Event('visibilitychange'));
assert.equal(deepseekVideo.paused, false);
w.dispatchEvent(new w.Event('pagehide'));
assert.equal(deepseekVideo.paused, true);
assert.equal(deepseekVideo.currentTime, 0);
await flushPlayback();
assert.equal(deepseekVideo.paused, true);
w.dispatchEvent(new w.Event('pageshow'));
assert.equal(deepseekVideo.paused, false);
pass(
  'DeepSeek error, stop, reset, visibility and pagehide enforce static fallback without changing task results',
);

$('reset').click();
await flushPlayback();
playback.mode = 'reject';
$('scene-trigger').click();
await flushPlayback();
assert.equal(deepseekVideo.paused, true);
assert(!$('stage').classList.contains('deepseek-performing'));
assert.equal(d.getElementById('meme-dialogue'), null);
$('reset').click();
playback.mode = 'throw';
$('scene-trigger').click();
assert.equal(deepseekVideo.paused, true);
assert(!$('stage').classList.contains('deepseek-performing'));
$('reset').click();
playback.mode = 'pending';
const beforeIndependentPlayback = playback.plays;
$('scene-trigger').click();
$('run-button').click();
tick(3);
assert.equal(playback.plays, beforeIndependentPlayback + 1);
assert.equal(playback.pending.length, 1);
skin('naiwa');
$('scene-trigger').click();
assert.equal(playback.pending.length, 2, 'each character owns an independent playback request');
playback.pending.shift()();
await flushPlayback();
assert.equal(
  deepseekVideo.paused,
  true,
  'a stale DeepSeek completion cannot restart an inactive character',
);
assert.equal(video.paused, true, "a stale completion cannot replace Naiwa's pending request");
assert.equal(
  playback.plays,
  beforeIndependentPlayback + 2,
  'a stale completion never duplicates the other request',
);
playback.pending.shift()();
await flushPlayback();
assert.equal(video.paused, false);
assert.equal(deepseekVideo.paused, true);
w.dispatchEvent(new w.Event('pagehide'));
assert.equal(video.paused, true);
assert.equal(deepseekVideo.paused, true);
playback.mode = 'resolve';
w.dispatchEvent(new w.Event('pageshow'));
pass(
  'both character clips retain static fallbacks on playback failures and isolate pending requests across skin changes',
);

skin('vinyl');
assert.equal(
  Number.parseFloat(d.querySelector('.record').style.animationDuration),
  60 / Number($('intensity').value),
);
assert.equal(timers.size, 0);
assert.equal(timeouts.size, 0);
assert.deepEqual(errors, []);
pass('vinyl rpm matches the declared duration; no pending timers or jsdom runtime errors');

dom.window.close();
console.log(
  JSON.stringify(
    {
      checks: results,
      boundary:
        'Document/data/DOM/event checks only. No browser rendering, CSS geometry, native API, or production security verification.',
    },
    null,
    2,
  ),
);
