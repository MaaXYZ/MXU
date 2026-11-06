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
for (const relative of ['README.md', 'protocol.md', 'ideas.md']) {
  const source = path.join(root, relative);
  marked.walkTokens(marked.lexer(read(relative)), (token) => {
    if (token.type === 'link' || token.type === 'image') checkLink(source, token.href);
  });
}
for (const relative of ['demo/index.html', 'demo/protocol.html']) {
  const source = path.join(root, relative);
  for (const element of htmlDocument(source).querySelectorAll('[href], [src]')) {
    for (const attribute of ['href', 'src']) {
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
const $ = (id) => {
  const element = d.getElementById(id);
  assert(element, `missing demo element #${id}`);
  return element;
};
const style = d.createElement('style');
style.textContent = css;
d.head.append(style);
const timers = new Map();
let timerSequence = 0;
w.setInterval = (callback, delay) => {
  const id = ++timerSequence;
  timers.set(id, { callback, delay });
  return id;
};
w.clearInterval = (id) => timers.delete(id);
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
pass('demo mounts without timers and renders the canonical 24 ideas');

const configurations = {
  mascot: [132, 'mischief'],
  mecha: [100, 'armed'],
  garden: [75, 'night'],
  vinyl: [50, 'audition'],
  paper: [5, 'stamped'],
  sonar: [50, 'pinging'],
};
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

skin('vinyl');
assert.equal(
  Number.parseFloat(d.querySelector('.record').style.animationDuration),
  60 / Number($('intensity').value),
);
assert.equal(timers.size, 0);
assert.deepEqual(errors, []);
pass('vinyl rpm matches the declared duration; no pending intervals or jsdom runtime errors');

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
