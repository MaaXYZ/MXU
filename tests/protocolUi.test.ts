import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('PI UI ignores private fields while retaining standard options and Linux controllers', async () => {
  // Vite supplies the same module aliases and import.meta.env as the application.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
  });
  const server = await createServer({
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  try {
    const { useAppStore } = await server.ssrLoadModule('/src/stores/appStore.ts');
    const { OptionEditor, SwitchGrid } = await server.ssrLoadModule(
      '/src/components/OptionEditor.tsx',
    );
    const { isControllerType } = await server.ssrLoadModule('/src/types/interface.ts');
    const { buildLinuxControllerConfig } = await server.ssrLoadModule('/src/utils/controller.ts');
    const { generateTaskPipelineOverride } = await server.ssrLoadModule(
      '/src/utils/pipelineOverride.ts',
    );
    const projectInterface = {
      interface_version: 2,
      name: 'test',
      resource: [],
      controller: [{ name: 'linux', type: 'Linux', linux: { input: 'Wlr', screencap: 'Wlr' } }],
      task: [{ name: 'test', entry: 'Entry', option: ['Hotkey'] }],
      option: {
        Input: {
          type: 'input',
          label: '**Option**',
          inputs: [
            {
              name: 'plain',
              label: '<b>Input</b>',
              input_type: 'time',
              placeholder: 'PRIVATE',
              icon: 'private.png',
            },
            { name: 'secret', password: true },
            { name: 'folder', input_type: 'directory' },
          ],
        },
        Cases: {
          type: 'select',
          label: '**Select**',
          cases: [{ name: 'first', label: '![](icon.png) Case' }],
        },
        Hotkey: {
          type: 'hotkey',
          hotkeys: [{ name: 'key', default: 'A', input_type: 'file', placeholder: 'PRIVATE' }],
          pipeline_override: { Entry: { key: '{key}' } },
        },
      },
    };
    // Zustand's server renderer reads the initial snapshot.
    Object.assign(useAppStore.getInitialState(), {
      projectInterface,
      language: 'en-US',
      instances: [],
      globalOptionValues: {},
    });
    const renderOption = (optionKey: string) =>
      renderToStaticMarkup(createElement(OptionEditor, { optionKey, globalScope: true }));
    const inputHtml = renderOption('Input');
    assert.match(inputHtml, /\*\*Option\*\*/);
    assert.match(inputHtml, /&lt;b&gt;Input&lt;\/b&gt;/);
    assert.doesNotMatch(inputHtml, /PRIVATE|private\.png|type="time"|<b>/);
    assert.match(inputHtml, /type="password"/);
    const casesHtml = renderOption('Cases');
    assert.match(casesHtml, /!\[\]\(icon\.png\) Case/);
    assert.doesNotMatch(casesHtml, /<img/);
    assert.doesNotMatch(renderOption('Hotkey'), /PRIVATE/);
    assert.match(renderOption('__MXU_WAITUNTIL_OPTION__'), /type="time"/);
    assert.match(renderOption('__MXU_LAUNCH_OPTION__'), /placeholder="[^\"]+"/);
    const gridHtml = renderToStaticMarkup(
      createElement(SwitchGrid, {
        instanceId: '',
        taskId: '',
        items: [{ optionKey: 'A', label: '**Grid**', isChecked: false }],
      }),
    );
    assert.match(gridHtml, /\*\*Grid\*\*/);
    for (const value of ['Adb', 'Win32', 'MacOS', 'Linux', 'PlayCover', 'Gamepad']) {
      assert.equal(isControllerType(value), true);
    }
    for (const value of ['WlRoots', 'Custom', '', undefined])
      assert.equal(isControllerType(value), false);
    const linuxConfig = buildLinuxControllerConfig(projectInterface.controller[0], {
      wlrSocketPath: '/run/user/test-wayland',
    });
    assert.equal(linuxConfig.type, 'Linux');
    assert.equal(linuxConfig.wlr_socket_path, '/run/user/test-wayland');
    const task = { id: 'test', taskName: 'test', enabled: true, expanded: true, optionValues: {} };
    assert.deepEqual(JSON.parse(generateTaskPipelineOverride(task, projectInterface, 'linux')), [
      { Entry: { key: 30 } },
    ]);
    projectInterface.controller[0].linux.use_win32_vk_code = true;
    assert.deepEqual(JSON.parse(generateTaskPipelineOverride(task, projectInterface, 'linux')), [
      { Entry: { key: 65 } },
    ]);
  } finally {
    await server.close();
  }
});
