import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairMacosBundle as repairBundle } from '../scripts/macos-resign.mjs';
import { applyBundleLayout, planBundleLayout } from '../scripts/macos-bundle-layout.mjs';
import { beginBundleRepair } from '../scripts/macos-bundle-state.mjs';
import { acquireBundleLock } from '../scripts/macos-bundle-state.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';

const heldLocks = new Set<string>();
function repairMacosBundle(bundlePath: string, options: Parameters<typeof repairBundle>[1] = {}) {
  if (process.platform === 'darwin') return repairBundle(bundlePath, options);
  const base = options.fileSystem ?? fs;
  const descriptors = new Map<number, string>();
  const fileSystem = {
    ...base,
    openSync(path: string, flags: string | number, mode?: number) {
      if (!String(path).endsWith('.mxu-repair.lock')) return base.openSync(path, flags, mode);
      if (heldLocks.has(path)) throw Object.assign(new Error('busy'), { code: 'EAGAIN' });
      const fd = fs.openSync(path, 'a+', mode);
      heldLocks.add(path);
      descriptors.set(fd, path);
      return fd;
    },
    closeSync(fd: number) {
      base.closeSync(fd);
      const path = descriptors.get(fd);
      if (path) heldLocks.delete(path);
      descriptors.delete(fd);
    },
  };
  return repairBundle(bundlePath, { ...options, fileSystem });
}

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
    entitlementsBefore?: string;
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
    if (program === '/usr/bin/plutil') return { status: 0, stdout: 'OK', stderr: '' };
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
      if (args.includes('--entitlements')) {
        return { status: 0, stdout: options.entitlementsBefore ?? '', stderr: '' };
      }
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
  mkdirSync(join(macos, 'locales'));
  writeFileSync(join(macos, 'locales', 'zh_cn.json'), '{"saved":true}');
  mkdirSync(join(macos, 'resource'));
  writeFileSync(join(macos, 'resource', 'model.onnx'), 'model bytes');
  writeFileSync(join(macos, 'interface.json'), '{"name":"MaaEnd"}');
  mkdirSync(join(macos, 'agent'));
  const native = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
  writeFileSync(join(macos, 'agent', 'go-service'), native);
  writeFileSync(join(macos, 'agent', 'schema.json'), '{"agent":true}');
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
  assert.equal(fs.readFileSync(join(macos, 'locales', 'zh_cn.json'), 'utf8'), '{"saved":true}');
  assert.equal(
    fs.readFileSync(join(resources, 'MXU-portable', 'locales', 'zh_cn.json'), 'utf8'),
    '{"saved":true}',
  );
  assert.equal(fs.readFileSync(join(macos, 'interface.json'), 'utf8'), '{"name":"MaaEnd"}');
  assert.equal(
    fileSystem.readlinkSync(join(macos, 'interface.json')),
    join('..', 'Resources', 'MXU-portable', 'interface.json'),
  );
  assert.deepEqual(fs.readFileSync(join(macos, 'agent', 'go-service')), native);
  assert.equal(fileSystem.lstatSync(join(macos, 'agent', 'go-service')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(join(macos, 'agent', 'schema.json'), 'utf8'), '{"agent":true}');
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
  assert.equal(fs.readFileSync(join(macos, 'locales', 'zh_cn.json'), 'utf8'), '{"saved":true}');
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
  assert.equal(fs.readFileSync(join(macos, 'locales', 'zh_cn.json'), 'utf8'), '{"saved":true}');
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
  assert.equal(fileSystem.lstatSync(join(macos, 'resource', 'model.onnx')).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(javaClass), bytes);
});

test('layout conflicts are detected before moving any resource', (t) => {
  const bundle = fixture(t);
  const { macos, resources } = portableLayout(bundle);
  mkdirSync(join(resources, 'MXU-portable', 'locales'), { recursive: true });
  writeFileSync(join(resources, 'MXU-portable', 'locales', 'zh_cn.json'), 'do not overwrite');
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
  assert.equal(fs.readFileSync(join(macos, 'agent', 'schema.json'), 'utf8'), '{"agent":true}');
  assert.equal(
    fs.readFileSync(join(resources, 'MXU-portable', 'locales', 'zh_cn.json'), 'utf8'),
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
  assert.equal(fileSystem.lstatSync(join(macos, 'locales')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(join(macos, 'agent', 'schema.json'), 'utf8'), '{"agent":true}');
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
  assert.equal(fs.readFileSync(join(macos, 'locales', 'zh_cn.json'), 'utf8'), '{"saved":true}');
  assert.equal(fileSystem.lstatSync(join(macos, 'locales')).isSymbolicLink(), false);
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

test('refuses known mutable data before sealing resources, including previously migrated data', (t) => {
  for (const path of ['config', 'data', 'debug', 'cache', 'logs', 'resource/state.sqlite']) {
    const bundle = fixture(t);
    const mutable = join(bundle, 'Contents', 'MacOS', path);
    mkdirSync(dirname(mutable), { recursive: true });
    writeFileSync(mutable, 'runtime data');
    const tools = codesignStub();
    assert.throws(
      () => repairMacosBundle(bundle, { platform: 'darwin', run: tools.run, repairLayout: true }),
      /Mutable data/,
    );
    assert.equal(fs.readFileSync(mutable, 'utf8'), 'runtime data');
    assert.equal(
      tools.calls.some(({ args }) => args[0] === '--force'),
      false,
    );
  }
  const bundle = fixture(t);
  const mutable = join(bundle, 'Contents', 'Resources', 'MXU-portable', 'config');
  mkdirSync(mutable, { recursive: true });
  writeFileSync(join(mutable, 'maa_option.json'), '{}');
  assert.throws(
    () =>
      repairMacosBundle(bundle, {
        platform: 'darwin',
        run: codesignStub().run,
        repairLayout: true,
      }),
    /Mutable data/,
  );
});

test('host entitlements require an explicit file and are passed unchanged to signing', (t) => {
  const bundle = fixture(t);
  const entitlements =
    '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>';
  const tools = codesignStub({ entitlementsBefore: entitlements });
  assert.throws(
    () => repairMacosBundle(bundle, { platform: 'darwin', run: tools.run }),
    /--entitlements/,
  );
  assert.equal(
    tools.calls.some(({ args }) => args[0] === '--force'),
    false,
  );
  const path = join(dirname(bundle), 'host entitlements.plist');
  writeFileSync(path, entitlements);
  const signing = codesignStub();
  let applied = false;
  const run = (...args: Parameters<typeof signing.run>) => {
    if (args[1][0] === '--force') {
      const index = args[1].indexOf('--entitlements');
      assert.ok(index > 0);
      assert.equal(fs.readFileSync(args[1][index + 1], 'utf8'), entitlements);
      applied = true;
    }
    return signing.run(...args);
  };
  repairMacosBundle(bundle, { platform: 'darwin', run, entitlements: path });
  assert.equal(applied, true);
});

test('an overlapping repair is rejected before it can snapshot or overwrite a successful signature', (t) => {
  const bundle = fixture(t);
  const tools = codesignStub();
  const competitor = codesignStub();
  const executable = join(bundle, 'Contents', 'MacOS', 'MaaEnd');
  const run = (...args: Parameters<typeof tools.run>) => {
    if (args[1][0] === '--force') {
      writeFileSync(executable, 'new valid signature');
      assert.throws(
        () => repairMacosBundle(bundle, { platform: 'darwin', run: competitor.run }),
        /Another repair/,
      );
      assert.equal(competitor.calls.length, 0);
    }
    return tools.run(...args);
  };
  repairMacosBundle(bundle, { platform: 'darwin', run });
  assert.equal(fs.readFileSync(executable, 'utf8'), 'new valid signature');
});

test('a resource created between planning and linking is never overwritten or removed', (t) => {
  const bundle = fixture(t);
  const { macos, resources } = portableLayout(bundle);
  const destination = join(resources, 'MXU-portable', 'interface.json');
  const fileSystem = layoutFs();
  const link = fileSystem.linkSync;
  fileSystem.linkSync = ((source: string, target: string) => {
    if (target === destination) writeFileSync(destination, 'concurrent resource', { flag: 'wx' });
    link(source, target);
  }) as typeof fs.linkSync;
  assert.throws(
    () =>
      repairMacosBundle(bundle, {
        platform: 'darwin',
        run: codesignStub().run,
        repairLayout: true,
        fileSystem,
      }),
    /EEXIST/,
  );
  assert.equal(fs.readFileSync(destination, 'utf8'), 'concurrent resource');
  assert.equal(fs.readFileSync(join(macos, 'interface.json'), 'utf8'), '{"name":"MaaEnd"}');
  assert.equal(fileSystem.lstatSync(join(macos, 'agent', 'schema.json')).isSymbolicLink(), false);
});

for (const gap of ['before-unlink', 'before-symlink'] as const) {
  test(`a later repair recovers an interrupted migration ${gap} before inspecting signatures`, (t) => {
    const bundle = fs.realpathSync(fixture(t));
    const macos = join(bundle, 'Contents', 'MacOS');
    const source = join(macos, 'interface.json');
    writeFileSync(source, '{"original":true}');
    const fileSystem = layoutFs();
    const plan = planBundleLayout(bundle, 'MaaEnd', () => false, fileSystem);
    const transaction = beginBundleRepair(bundle, join(macos, 'MaaEnd'), false, plan, fileSystem);
    const interruptedFs = {
      ...fileSystem,
      unlinkSync(path: string) {
        if (gap === 'before-unlink' && path === source) throw new Error('simulated process death');
        fileSystem.unlinkSync(path);
      },
      symlinkSync(target: string, path: string, type: 'file' | 'dir') {
        if (gap === 'before-symlink') throw new Error('simulated process death');
        fileSystem.symlinkSync(target, path, type);
      },
    };
    assert.throws(
      () => applyBundleLayout(plan, interruptedFs, transaction.save),
      /simulated process death/,
    );
    // Simulate a new process: no in-memory rollback, use only the persisted journal.
    const tools = codesignStub();
    let inspected = false;
    const run = (...args: Parameters<typeof tools.run>) => {
      if (!inspected) {
        assert.equal(fs.readFileSync(source, 'utf8'), '{"original":true}');
        assert.equal(fileSystem.lstatSync(source).isSymbolicLink(), false);
        inspected = true;
      }
      return tools.run(...args);
    };
    repairMacosBundle(bundle, { platform: 'darwin', run, repairLayout: true, fileSystem });
    assert.equal(fileSystem.lstatSync(source).isSymbolicLink(), true);
    assert.equal(fs.existsSync(transaction.directory), false);
  });
}

test('an interrupted signing attempt restores the executable and seal before retrying', (t) => {
  const bundle = fs.realpathSync(fixture(t));
  const executable = join(bundle, 'Contents', 'MacOS', 'MaaEnd');
  const signature = join(bundle, 'Contents', '_CodeSignature');
  mkdirSync(signature);
  writeFileSync(join(signature, 'CodeResources'), 'original seal');
  const plan = planBundleLayout(bundle, 'MaaEnd', () => false);
  const transaction = beginBundleRepair(bundle, executable, true, plan);
  transaction.markSigning();
  writeFileSync(executable, 'partial signing');
  writeFileSync(join(signature, 'CodeResources'), 'partial seal');
  const tools = codesignStub();
  let inspected = false;
  const run = (...args: Parameters<typeof tools.run>) => {
    if (!inspected) {
      assert.equal(fs.readFileSync(executable, 'utf8'), 'test executable');
      assert.equal(fs.readFileSync(join(signature, 'CodeResources'), 'utf8'), 'original seal');
      inspected = true;
    }
    return tools.run(...args);
  };
  repairMacosBundle(bundle, { platform: 'darwin', run });
  assert.equal(fs.existsSync(transaction.directory), false);
});

test(
  'macOS kernel lock excludes other processes and is released after SIGKILL',
  { skip: process.platform !== 'darwin', timeout: 10000 },
  async (t) => {
    const bundle = fs.realpathSync(fixture(t));
    const moduleUrl = new URL('../scripts/macos-bundle-state.mjs', import.meta.url).href;
    const probe = `const { acquireBundleLock } = await import(process.argv[1]); try { const release = acquireBundleLock(process.argv[2]); release(); } catch { process.exit(7); }`;
    const release = acquireBundleLock(bundle);
    try {
      assert.equal(
        spawnSync(process.execPath, ['--input-type=module', '-e', probe, moduleUrl, bundle]).status,
        7,
      );
    } finally {
      release();
    }
    const holder = `const { acquireBundleLock } = await import(process.argv[1]); acquireBundleLock(process.argv[2]); console.log('ready'); setInterval(() => {}, 1000);`;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', holder, moduleUrl, bundle],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const exited = once(child, 'exit');
    await Promise.race([
      once(child.stdout!, 'data'),
      exited.then(() => {
        throw new Error('Lock holder exited before acquiring the lock');
      }),
    ]);
    child.kill('SIGKILL');
    await exited;
    assert.equal(
      spawnSync(process.execPath, ['--input-type=module', '-e', probe, moduleUrl, bundle]).status,
      0,
    );
  },
);
