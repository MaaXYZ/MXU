// Repair a locally built executable copied into an existing macOS app bundle.
// Run after quitting the app. This is local ad-hoc signing, not distribution signing.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyBundleLayout, planBundleLayout } from './macos-bundle-layout.mjs';
import {
  acquireBundleLock,
  beginBundleRepair,
  recoverBundleRepair,
} from './macos-bundle-state.mjs';

const CODESIGN = '/usr/bin/codesign';
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';

export function repairMacosBundle(
  bundlePath,
  {
    platform = process.platform,
    run = spawnSync,
    repairLayout = false,
    entitlements,
    fileSystem = fs,
    onProgress = () => {},
  } = {},
) {
  if (platform !== 'darwin') throw new Error('This command must be run on macOS.');
  const { realpathSync, statSync } = fileSystem;
  const bundle = realpathSync(bundlePath);
  if (!bundle.endsWith('.app') || !statSync(bundle).isDirectory()) {
    throw new Error('Specify an existing .app bundle.');
  }
  const release = acquireBundleLock(bundle, fileSystem);
  try {
    recoverBundleRepair(bundle, fileSystem, onProgress);
    return repairLockedBundle(bundle, {
      run,
      repairLayout,
      entitlements,
      fileSystem,
      onProgress,
      lockFd: release.fd,
    });
  } finally {
    release();
  }
}

function repairLockedBundle(
  bundle,
  { run, repairLayout, entitlements, fileSystem, onProgress, lockFd },
) {
  const { realpathSync, statSync } = fileSystem;

  const invoke = (program, args, allowFailure = false) => {
    // 子进程也持有锁：即使父进程被终止，尚未结束的 codesign 仍排斥另一轮修复。
    const result = run(program, args, {
      encoding: 'utf8',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', lockFd],
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`${program} was interrupted by ${result.signal}.`);
    if (!allowFailure && result.status !== 0) {
      throw new Error(
        `${program} failed: ${(result.stderr || result.stdout || result.signal || result.status).toString().trim()}`,
      );
    }
    return result;
  };
  const plist = join(bundle, 'Contents', 'Info.plist');
  const readPlist = (key) => invoke(PLIST_BUDDY, ['-c', `Print :${key}`, plist]).stdout.trim();
  const bundleId = readPlist('CFBundleIdentifier');
  const executableName = readPlist('CFBundleExecutable');
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new Error('Invalid or missing CFBundleIdentifier.');
  if (!executableName || /[/\\]/.test(executableName) || ['.', '..'].includes(executableName)) {
    throw new Error('Invalid CFBundleExecutable.');
  }
  const executable = realpathSync(join(bundle, 'Contents', 'MacOS', executableName));
  const relativeExecutable = relative(bundle, executable);
  if (
    isAbsolute(relativeExecutable) ||
    relativeExecutable.startsWith(`..${sep}`) ||
    !statSync(executable).isFile()
  ) {
    throw new Error('The main executable must be a file inside the app bundle.');
  }

  const verify = () => invoke(CODESIGN, ['--verify', '--strict', '--verbose=2', bundle], true);
  const signedIdentifier = () => {
    const result = invoke(CODESIGN, ['--display', '--verbose=2', bundle]);
    const identifier = `${result.stdout || ''}\n${result.stderr || ''}`
      .match(/^Identifier=(.+)$/m)?.[1]
      .trim();
    if (!identifier) throw new Error('Could not read the signing identifier.');
    return identifier;
  };

  const alreadyValid = verify().status === 0 && signedIdentifier() === bundleId;

  const isCode = (path) => {
    const fd = fileSystem.openSync(path, 'r');
    const magic = Buffer.alloc(4);
    let count;
    try {
      count = fileSystem.readSync(fd, magic, 0, 4, 0);
    } finally {
      fileSystem.closeSync(fd);
    }
    if (
      count !== 4 ||
      ![
        0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
        0xbfbafeca,
      ].includes(magic.readUInt32BE(0))
    )
      return false;
    // file also distinguishes universal Mach-O binaries from Java's CAFEBABE header.
    const kind = invoke('/usr/bin/file', ['-b', path]).stdout;
    return /Mach-O/.test(kind) && /executable|shared library|bundle/.test(kind);
  };
  onProgress('Inspecting the app bundle layout...');
  const plan = planBundleLayout(bundle, executableName, isCode, fileSystem);
  if (alreadyValid && !entitlements) return { bundle, bundleId, resigned: false };
  if (plan.moves.length && !repairLayout) {
    throw new Error(
      `Data files are stored in Contents/MacOS (${plan.moves
        .map((move) => relative(bundle, move.source))
        .slice(0, 4)
        .join(
          ', ',
        )}). Re-run with --repair-layout to relocate resources and retain compatible symlinks.`,
    );
  }
  // Preserve already signed agents/frameworks, and diagnose invalid nested code before moving data.
  onProgress(`Checking ${plan.codeObjects.length} nested code object(s)...`);
  for (const code of plan.codeObjects) {
    const result = invoke(CODESIGN, ['--verify', '--strict', '--verbose=2', code], true);
    if (result.status !== 0) {
      throw new Error(
        `Nested code must have a valid signature before repairing the app: ${code}\n${result.stderr || result.stdout || ''}`,
      );
    }
  }

  // 替换可执行文件后旧宿主权限已无法推断；允许调用方明确提供保存的权限文件。
  let entitlementBytes;
  if (entitlements) {
    const path = realpathSync(entitlements);
    invoke('/usr/bin/plutil', ['-lint', path]);
    entitlementBytes = fileSystem.readFileSync(path);
  } else {
    const current = invoke(CODESIGN, ['--display', '--entitlements', ':-', executable], true);
    if (current.status !== 0 || /<key(?:\s|>)/.test(current.stdout || '')) {
      throw new Error(
        'Cannot preserve host entitlements implicitly. Supply the original host entitlements with --entitlements /path/to/entitlements.plist before re-signing.',
      );
    }
  }

  const signature = join(bundle, 'Contents', '_CodeSignature');
  let signatureStat;
  try {
    signatureStat = fileSystem.lstatSync(signature);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (signatureStat && (!signatureStat.isDirectory() || signatureStat.isSymbolicLink())) {
    throw new Error('The bundle signature location must be a real directory.');
  }
  const transaction = beginBundleRepair(bundle, executable, !!signatureStat, plan, fileSystem);
  try {
    onProgress(`Recovery copy: ${transaction.directory}`);
    for (const move of plan.moves) {
      onProgress(
        `Relocate ${relative(bundle, move.source)} -> ${relative(bundle, move.destination)}`,
      );
    }
    applyBundleLayout(plan, fileSystem, transaction.save);
    // Signing only the outer app seals resources and binds Info.plist; no --deep re-signing of agents.
    const signingArgs = ['--force', '--sign', '-', '--identifier', bundleId];
    if (entitlementBytes) {
      const path = join(transaction.directory, 'entitlements.plist');
      fileSystem.writeFileSync(path, entitlementBytes);
      signingArgs.push('--entitlements', path);
    }
    transaction.markSigning();
    invoke(CODESIGN, [...signingArgs, bundle]);
    const verification = verify();
    if (verification.status !== 0) {
      throw new Error(
        `Bundle signature verification failed: ${(verification.stderr || verification.stdout || '').trim()}`,
      );
    }
    if (signedIdentifier() !== bundleId) {
      throw new Error('The signing identifier still does not match CFBundleIdentifier.');
    }
    transaction.commit();
    return { bundle, bundleId, resigned: true, relocated: plan.moves.length };
  } catch (error) {
    try {
      transaction.rollback();
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Repair failed; recovery copy retained at ${transaction.directory}. Re-run the same repair command to recover before signing.`,
      );
    }
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    let repairLayout = false;
    let entitlements;
    while (args[0]?.startsWith('--')) {
      const option = args.shift();
      if (option === '--repair-layout') repairLayout = true;
      else if (option === '--entitlements' && args[0]) entitlements = args.shift();
      else throw new Error(`Unknown or incomplete option: ${option}`);
    }
    if (args.length !== 1) {
      throw new Error(
        'Usage: node scripts/macos-resign.mjs [--repair-layout] [--entitlements /path/to/entitlements.plist] /path/to/YourApp.app (quit the app first)',
      );
    }
    const result = repairMacosBundle(args[0], {
      repairLayout,
      entitlements,
      onProgress: console.log,
    });
    console.log(
      `${result.resigned ? 'Re-signed and verified' : 'Signature already valid'}: ${result.bundle}`,
    );
    console.log(`Signing identifier: ${result.bundleId}`);
    console.log('Relaunch the .app before testing notifications.');
  } catch (error) {
    console.error(error.message);
    if (error instanceof AggregateError) {
      for (const cause of error.errors) console.error(cause.message);
    }
    process.exitCode = 1;
  }
}
