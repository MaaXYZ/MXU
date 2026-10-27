import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairMacosBundle } from '../scripts/macos-resign.mjs';
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'mxu-signing-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, "Maa End's [$local].app");
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist/>');
  writeFileSync(join(bundle, 'Contents', 'MacOS', 'MaaEnd'), 'test executable');
  return bundle;
}

function codesignStub(
  options: {
    validBefore?: boolean;
    identifierBefore?: string;
    identifierAfter?: string;
    verifyAfter?: number;
    signStatus?: number;
    executableName?: string;
    displayStatus?: number;
  } = {},
) {
  let signed = false;
  const calls: { program: string; args: string[] }[] = [];
  const run = (program: string, args: string[], spawnOptions: { shell: boolean }) => {
    assert.equal(spawnOptions.shell, false);
    calls.push({ program, args });
    if (program === '/usr/libexec/PlistBuddy') {
      return {
        status: 0,
        stdout:
          args[1] === 'Print :CFBundleIdentifier'
            ? 'com.maaend.app\n'
            : `${options.executableName ?? 'MaaEnd'}\n`,
        stderr: '',
      };
    }
    if (program === '/usr/bin/file') {
      return { status: 0, stdout: 'Mach-O 64-bit executable arm64', stderr: '' };
    }
    assert.equal(program, '/usr/bin/codesign');
    if (args[0] === '--verify') {
      if (!args.at(-1)?.endsWith('.app')) return { status: 0, stdout: '', stderr: '' };
      const status = signed ? (options.verifyAfter ?? 0) : options.validBefore ? 0 : 1;
      return {
        status,
        stdout: '',
        stderr: status ? 'code has no resources but signature indicates they must be present' : '',
      };
    }
    if (args[0] === '--display') {
      const identifier = signed
        ? (options.identifierAfter ?? 'com.maaend.app')
        : (options.identifierBefore ?? 'mxu-1c20cadb94bd224c');
      return {
        status: options.displayStatus ?? 0,
        stdout: '',
        stderr: `Executable=MaaEnd\nIdentifier=${identifier}\nSignature=adhoc\n`,
      };
    }
    assert.equal(args[0], '--force');
    signed = true;
    return { status: options.signStatus ?? 0, stdout: '', stderr: 'codesign failed' };
  };
  return { run, calls };
}

test('repairs the replaced executable by signing the bundle with its own identifier', (t) => {
  const bundle = fixture(t);
  const tools = codesignStub();
  const result = repairMacosBundle(bundle, { platform: 'darwin', run: tools.run });
  assert.equal(result.resigned, true);
  assert.equal(result.bundleId, 'com.maaend.app');
  const signing = tools.calls.find(({ args }) => args[0] === '--force');
  assert.deepEqual(signing?.args, [
    '--force',
    '--sign',
    '-',
    '--identifier',
    'com.maaend.app',
    result.bundle,
  ]);
  assert.equal(tools.calls.filter(({ args }) => args[0] === '--verify').length, 2);
});

// Windows cannot create unprivileged file symlinks. Use hard links for file I/O
// and model symlink metadata; macOS/Linux exercise native relative symlinks.
function layoutFs() {
  const links = new Map<string, string>();
  return {
    ...fs,
    symlinkSync(target: string, path: string, type: 'dir' | 'file') {
      if (process.platform === 'win32') {
        const destination = resolve(dirname(path), target);
        if (type === 'dir') fs.symlinkSync(destination, path, 'junction');
        else fs.linkSync(destination, path);
      } else fs.symlinkSync(target, path, type);
      links.set(resolve(path), target);
    },
    lstatSync(path: string) {
      const stat = fs.lstatSync(path);
      if (links.has(resolve(path))) stat.isSymbolicLink = () => true;
      return stat;
    },
    readlinkSync(path: string) {
      return links.get(resolve(path)) ?? fs.readlinkSync(path);
    },
    realpathSync(path: string) {
      const target = links.get(resolve(path));
      return fs.realpathSync(target ? resolve(dirname(path), target) : path);
    },
    unlinkSync(path: string) {
      fs.unlinkSync(path);
      links.delete(resolve(path));
    },
  };
}

function portableLayout(bundle: string) {
  const macos = join(bundle, 'Contents', 'MacOS');
  const resources = join(bundle, 'Contents', 'Resources');
  mkdirSync(join(macos, 'config'));
  writeFileSync(join(macos, 'config', 'maa_option.json'), '{"saved":true}');
  mkdirSync(join(macos, 'resource'));
  writeFileSync(join(macos, 'resource', 'model.onnx'), 'model bytes');
  writeFileSync(join(macos, 'interface.json'), '{"name":"MaaEnd"}');
  mkdirSync(join(macos, 'agent'));
  const native = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
  writeFileSync(join(macos, 'agent', 'go-service'), native);
  writeFileSync(join(macos, 'agent', 'config.json'), '{"agent":true}');
  mkdirSync(resources);
  writeFileSync(join(resources, 'maaend.icns'), 'original icon');
  return { macos, resources, native };
}

test('portable data is moved out of MacOS while native agent paths and resource contents stay intact', (t) => {
  const bundle = fixture(t);
  const { macos, resources, native } = portableLayout(bundle);
  const fileSystem = layoutFs();
  const tools = codesignStub();
  const result = repairMacosBundle(bundle, {
    platform: 'darwin',
    run: tools.run,
    repairLayout: true,
    fileSystem,
  });
  assert.equal(result.relocated, 4);
  assert.equal(fs.readFileSync(join(macos, 'config', 'maa_option.json'), 'utf8'), '{"saved":true}');
  assert.equal(
    fs.readFileSync(join(resources, 'MXU-portable', 'config', 'maa_option.json'), 'utf8'),
    '{"saved":true}',
  );
  assert.equal(fs.readFileSync(join(macos, 'interface.json'), 'utf8'), '{"name":"MaaEnd"}');
  assert.equal(
    fileSystem.readlinkSync(join(macos, 'interface.json')),
    join('..', 'Resources', 'MXU-portable', 'interface.json'),
  );
  assert.deepEqual(fs.readFileSync(join(macos, 'agent', 'go-service')), native);
  assert.equal(fileSystem.lstatSync(join(macos, 'agent', 'go-service')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(join(macos, 'agent', 'config.json'), 'utf8'), '{"agent":true}');
  assert.equal(fs.readFileSync(join(resources, 'maaend.icns'), 'utf8'), 'original icon');
  assert.ok(
    tools.calls
      .filter(({ args }) => args[0] === '--force')
      .every(({ args }) => args.at(-1) === result.bundle),
  );
  const again = repairMacosBundle(bundle, {
    platform: 'darwin',
    run: codesignStub().run,
    repairLayout: true,
    fileSystem,
  });
  assert.equal(again.relocated, 0);
});

test('portable layouts require an explicit repair option before any signing mutation', (t) => {
  const bundle = fixture(t);
  const { macos } = portableLayout(bundle);
  const tools = codesignStub();
  assert.throws(
    () => repairMacosBundle(bundle, { platform: 'darwin', run: tools.run }),
    /--repair-layout/,
  );
  assert.equal(
    tools.calls.some(({ args }) => args[0] === '--force'),
    false,
  );
  assert.equal(fs.readFileSync(join(macos, 'config', 'maa_option.json'), 'utf8'), '{"saved":true}');
});

test('unsigned nested code is reported before resources are relocated', (t) => {
  const bundle = fixture(t);
  const { macos, resources } = portableLayout(bundle);
  const tools = codesignStub();
  const run = (...args: Parameters<typeof tools.run>) => {
    if (args[0] === '/usr/bin/codesign' && args[1].at(-1) === join(macos, 'agent', 'go-service')) {
      return { status: 1, stdout: '', stderr: 'code object is not signed at all' };
    }
    return tools.run(...args);
  };
  assert.throws(
    () =>
      repairMacosBundle(bundle, {
        platform: 'darwin',
        run,
        repairLayout: true,
        fileSystem: layoutFs(),
      }),
    /Nested code must have a valid signature/,
  );
  assert.equal(fs.existsSync(join(resources, 'MXU-portable')), false);
  assert.equal(fs.readFileSync(join(macos, 'config', 'maa_option.json'), 'utf8'), '{"saved":true}');
});

test('CAFEBABE data is not mistaken for a universal Mach-O executable', (t) => {
  const bundle = fixture(t);
  const { macos } = portableLayout(bundle);
  const javaClass = join(macos, 'resource', 'Example.class');
  const bytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]);
  writeFileSync(javaClass, bytes);
  const tools = codesignStub();
  const run = (...args: Parameters<typeof tools.run>) => {
    if (args[0] === '/usr/bin/file' && args[1].at(-1) === javaClass) {
      return { status: 0, stdout: 'compiled Java class data, version 52.0', stderr: '' };
    }
    return tools.run(...args);
  };
  const fileSystem = layoutFs();
  repairMacosBundle(bundle, { platform: 'darwin', run, repairLayout: true, fileSystem });
  assert.equal(fileSystem.lstatSync(join(macos, 'resource')).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(javaClass), bytes);
});

test('layout conflicts are detected before moving any resource', (t) => {
  const bundle = fixture(t);
  const { macos, resources } = portableLayout(bundle);
  mkdirSync(join(resources, 'MXU-portable', 'config'), { recursive: true });
  writeFileSync(join(resources, 'MXU-portable', 'config', 'keep.txt'), 'do not overwrite');
  assert.throws(
    () =>
      repairMacosBundle(bundle, {
        platform: 'darwin',
        run: codesignStub().run,
        repairLayout: true,
        fileSystem: layoutFs(),
      }),
    /overwrite existing resource/,
  );
  assert.equal(fs.readFileSync(join(macos, 'agent', 'config.json'), 'utf8'), '{"agent":true}');
  assert.equal(
    fs.readFileSync(join(resources, 'MXU-portable', 'config', 'keep.txt'), 'utf8'),
    'do not overwrite',
  );
});

test('a failed link creation restores all moved resources', (t) => {
  const bundle = fixture(t);
  const { macos, resources } = portableLayout(bundle);
  const fileSystem = layoutFs();
  const createLink = fileSystem.symlinkSync;
  let count = 0;
  fileSystem.symlinkSync = (...args) => {
    if (++count === 2) throw new Error('injected link failure');
    createLink(...args);
  };
  assert.throws(
    () =>
      repairMacosBundle(bundle, {
        platform: 'darwin',
        run: codesignStub().run,
        repairLayout: true,
        fileSystem,
      }),
    /injected link failure/,
  );
  assert.equal(fileSystem.lstatSync(join(macos, 'config')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(join(macos, 'agent', 'config.json'), 'utf8'), '{"agent":true}');
  assert.equal(fs.existsSync(join(resources, 'MXU-portable')), false);
});

test('a failed codesign restores the executable, signature files and original resource layout', (t) => {
  const bundle = fixture(t);
  const { macos, resources } = portableLayout(bundle);
  const signature = join(bundle, 'Contents', '_CodeSignature');
  mkdirSync(signature);
  writeFileSync(join(signature, 'CodeResources'), 'old seal');
  const tools = codesignStub();
  const run = (...args: Parameters<typeof tools.run>) => {
    if (args[1][0] === '--force') {
      writeFileSync(join(macos, 'MaaEnd'), 'partially signed executable');
      writeFileSync(join(signature, 'CodeResources'), 'partial seal');
      return { status: 1, stdout: '', stderr: 'injected signing failure' };
    }
    return tools.run(...args);
  };
  const fileSystem = layoutFs();
  assert.throws(
    () => repairMacosBundle(bundle, { platform: 'darwin', run, repairLayout: true, fileSystem }),
    /injected signing failure/,
  );
  assert.equal(fs.readFileSync(join(macos, 'MaaEnd'), 'utf8'), 'test executable');
  assert.equal(fs.readFileSync(join(signature, 'CodeResources'), 'utf8'), 'old seal');
  assert.equal(fs.readFileSync(join(macos, 'config', 'maa_option.json'), 'utf8'), '{"saved":true}');
  assert.equal(fileSystem.lstatSync(join(macos, 'config')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(join(resources, 'MXU-portable')), false);
});

test('a destination symlink cannot redirect relocation outside the bundle', (t) => {
  const bundle = fixture(t);
  const { macos, resources } = portableLayout(bundle);
  const outside = join(dirname(bundle), 'outside');
  mkdirSync(outside);
  const fileSystem = layoutFs();
  fileSystem.symlinkSync(outside, join(resources, 'MXU-portable'), 'dir');
  assert.throws(
    () =>
      repairMacosBundle(bundle, {
        platform: 'darwin',
        run: codesignStub().run,
        repairLayout: true,
        fileSystem,
      }),
    /real directories/,
  );
  assert.equal(fs.readFileSync(join(macos, 'interface.json'), 'utf8'), '{"name":"MaaEnd"}');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('does not replace an already valid signature with the expected identifier', (t) => {
  const bundle = fixture(t);
  const tools = codesignStub({ validBefore: true, identifierBefore: 'com.maaend.app' });
  assert.equal(repairMacosBundle(bundle, { platform: 'darwin', run: tools.run }).resigned, false);
  assert.equal(
    tools.calls.some(({ args }) => args[0] === '--force'),
    false,
  );
});

test('repairs a valid executable signature whose identifier does not match the bundle', (t) => {
  const bundle = fixture(t);
  const tools = codesignStub({ validBefore: true });
  assert.equal(repairMacosBundle(bundle, { platform: 'darwin', run: tools.run }).resigned, true);
});

test('does not report success when signing or post-sign verification fails', (t) => {
  const bundle = fixture(t);
  const signFailure = codesignStub({ signStatus: 1 });
  assert.throws(
    () => repairMacosBundle(bundle, { platform: 'darwin', run: signFailure.run }),
    /codesign failed/,
  );
  assert.equal(signFailure.calls.filter(({ args }) => args[0] === '--verify').length, 1);
  const verifyFailure = codesignStub({ verifyAfter: 1 });
  assert.throws(
    () => repairMacosBundle(bundle, { platform: 'darwin', run: verifyFailure.run }),
    /Bundle signature verification failed/,
  );
  const wrongIdentifier = codesignStub({ identifierAfter: 'mxu-wrong' });
  assert.throws(
    () => repairMacosBundle(bundle, { platform: 'darwin', run: wrongIdentifier.run }),
    /still does not match/,
  );
});

test('rejects executable paths outside the bundle before modifying signatures', (t) => {
  const bundle = fixture(t);
  const tools = codesignStub({ executableName: '../../../outside' });
  assert.throws(
    () => repairMacosBundle(bundle, { platform: 'darwin', run: tools.run }),
    /Invalid CFBundleExecutable/,
  );
  assert.equal(
    tools.calls.some(({ program }) => program === '/usr/bin/codesign'),
    false,
  );
});

test('rejects non-macOS invocation without running system tools', () => {
  const tools = codesignStub();
  assert.throws(
    () => repairMacosBundle('MaaEnd.app', { platform: 'win32', run: tools.run }),
    /must be run on macOS/,
  );
  assert.equal(tools.calls.length, 0);
});

test('does not re-sign when a valid signature cannot be inspected', (t) => {
  const bundle = fixture(t);
  const tools = codesignStub({ validBefore: true, displayStatus: 1 });
  assert.throws(
    () => repairMacosBundle(bundle, { platform: 'darwin', run: tools.run }),
    /codesign failed/,
  );
  assert.equal(
    tools.calls.some(({ args }) => args[0] === '--force'),
    false,
  );
});
