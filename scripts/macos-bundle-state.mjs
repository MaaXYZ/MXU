import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import {
  inside,
  rollbackBundleLayout,
  statIfPresent,
  syncDirectory,
} from './macos-bundle-layout.mjs';

export function acquireBundleLock(bundle, fileSystem = fs) {
  // Darwin open(2): O_EXLOCK | O_NONBLOCK. libuv passes numeric flags to open(2).
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
  // Keep this file: unlinking a locked inode would let another process acquire a new one.
  const flags = 0x0002 | 0x0200 | 0x0020 | 0x0004 | 0x0100;
  let fd;
  try {
    fd = fileSystem.openSync(`${bundle}.mxu-repair.lock`, flags, 0o600);
  } catch (error) {
    if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) {
      throw new Error(`Another repair is running for ${bundle}. Wait for it to finish.`);
    }
    throw error;
  }
  return Object.assign(() => fileSystem.closeSync(fd), { fd });
}

function writeState(directory, state, fileSystem) {
  const temporary = join(directory, 'transaction.tmp');
  const fd = fileSystem.openSync(temporary, 'w', 0o600);
  try {
    fileSystem.writeFileSync(fd, JSON.stringify(state));
    fileSystem.fsyncSync(fd);
  } finally {
    fileSystem.closeSync(fd);
  }
  fileSystem.renameSync(temporary, join(directory, 'transaction.json'));
  syncDirectory(directory, fileSystem);
}

function syncTree(path, fileSystem) {
  const stat = fileSystem.lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Recovery copies must not contain symlinks: ${path}`);
  if (stat.isDirectory()) {
    for (const name of fileSystem.readdirSync(path)) syncTree(join(path, name), fileSystem);
    syncDirectory(path, fileSystem);
  } else {
    const fd = fileSystem.openSync(path, 'r+');
    try {
      fileSystem.fsyncSync(fd);
    } finally {
      fileSystem.closeSync(fd);
    }
  }
}

function bundleIdentity(bundle, fileSystem) {
  // Signing may replace the executable and signature files. These directories and
  // Info.plist must remain unchanged throughout a repair and identify its host.
  const directories = ['', 'Contents', join('Contents', 'MacOS')].map((name) => {
    const path = join(bundle, name);
    const stat = fileSystem.lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Bundle identity must use real directories: ${path}`);
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs),
    };
  });
  const plist = join(bundle, 'Contents', 'Info.plist');
  const stat = fileSystem.lstatSync(plist, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Bundle identity must use a regular Info.plist: ${plist}`);
  return {
    directories,
    plist: {
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs),
      hash: createHash('sha256').update(fileSystem.readFileSync(plist)).digest('hex'),
    },
  };
}

export function recoverBundleRepair(bundle, fileSystem = fs, onProgress = () => {}) {
  const directory = `${bundle}.mxu-repair`;
  const stat = statIfPresent(fileSystem, directory);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Invalid recovery directory: ${directory}`);
  const state = JSON.parse(fileSystem.readFileSync(join(directory, 'transaction.json'), 'utf8'));
  const executable = join(bundle, state.executable);
  if (
    state.version !== 2 ||
    state.bundle !== bundle ||
    state.plan.bundle !== bundle ||
    !inside(join(bundle, 'Contents', 'MacOS'), executable) ||
    !['preparing', 'prepared', 'signing', 'committed'].includes(state.phase)
  ) {
    throw new Error(`Invalid recovery journal: ${directory}`);
  }
  if (JSON.stringify(state.identity) !== JSON.stringify(bundleIdentity(bundle, fileSystem))) {
    throw new Error(
      `The app bundle changed since this repair began. Refusing to restore a different app; recovery copy retained at ${directory}.`,
    );
  }
  if (['prepared', 'signing'].includes(state.phase)) {
    onProgress(`Restoring interrupted repair from ${directory}`);
    rollbackBundleLayout(state.plan, fileSystem);
    if (state.phase === 'signing') {
      syncTree(join(directory, 'executable'), fileSystem);
      fileSystem.copyFileSync(join(directory, 'executable'), executable);
      const signature = join(bundle, 'Contents', '_CodeSignature');
      fileSystem.rmSync(signature, { recursive: true, force: true });
      if (state.hasSignature) {
        syncTree(join(directory, 'signature'), fileSystem);
        fileSystem.cpSync(join(directory, 'signature'), signature, { recursive: true });
      }
      syncTree(executable, fileSystem);
      if (state.hasSignature) syncTree(signature, fileSystem);
      syncDirectory(dirname(signature), fileSystem);
    }
  }
  fileSystem.rmSync(directory, { recursive: true });
  syncDirectory(dirname(directory), fileSystem);
}

export function beginBundleRepair(bundle, executable, hasSignature, plan, fileSystem = fs) {
  const directory = `${bundle}.mxu-repair`;
  const identity = bundleIdentity(bundle, fileSystem);
  fileSystem.mkdirSync(directory, { mode: 0o700 });
  const state = {
    version: 2,
    bundle,
    identity,
    executable: relative(bundle, executable),
    hasSignature,
    plan,
    phase: 'preparing',
  };
  const save = () => writeState(directory, state, fileSystem);
  save();
  syncDirectory(dirname(directory), fileSystem);
  try {
    fileSystem.copyFileSync(executable, join(directory, 'executable'));
    if (hasSignature)
      fileSystem.cpSync(join(bundle, 'Contents', '_CodeSignature'), join(directory, 'signature'), {
        recursive: true,
      });
    syncTree(directory, fileSystem);
    state.phase = 'prepared';
    save();
  } catch (error) {
    recoverBundleRepair(bundle, fileSystem);
    throw error;
  }
  return {
    directory,
    save,
    markSigning() {
      state.phase = 'signing';
      save();
    },
    commit() {
      syncTree(executable, fileSystem);
      const signature = join(bundle, 'Contents', '_CodeSignature');
      if (statIfPresent(fileSystem, signature)) syncTree(signature, fileSystem);
      syncDirectory(dirname(signature), fileSystem);
      state.phase = 'committed';
      save();
      recoverBundleRepair(bundle, fileSystem);
    },
    rollback() {
      recoverBundleRepair(bundle, fileSystem);
    },
  };
}
