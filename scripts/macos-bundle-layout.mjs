import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function statIfPresent(fileSystem, path) {
  try {
    return fileSystem.lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function checkDestinationParents(bundle, directory, fileSystem) {
  if (!inside(bundle, directory)) throw new Error(`Path leaves the app bundle: ${directory}`);
  for (let path = directory; path !== bundle; path = dirname(path)) {
    const stat = statIfPresent(fileSystem, path);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`Resource destination must use real directories: ${path}`);
    }
  }
}

const mutableNames = new Set([
  'config',
  'data',
  'debug',
  'logs',
  'log',
  'cache',
  'caches',
  'userdata',
  'user-data',
]);

// 已迁移的兼容链接也要检查，不能把旧修复留下的运行数据重新封入签名。
function rejectMutableData(path, fileSystem) {
  if (mutableNames.has(basename(path).toLowerCase()) || /\.(log|sqlite|sqlite3|db)$/i.test(path)) {
    throw new Error(
      `Mutable data must be stored outside the signed app bundle: ${path}. Move it to Application Support and configure the host/agent to use that location before signing.`,
    );
  }
  const stat = fileSystem.lstatSync(path);
  if (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    !/\.(app|framework|bundle|xpc)$/i.test(path)
  ) {
    for (const name of fileSystem.readdirSync(path))
      rejectMutableData(join(path, name), fileSystem);
  }
}

/** Plan before changing anything. Keep executable paths and existing symlinks intact. */
export function planBundleLayout(bundle, executableName, isCode, fileSystem = fs) {
  const macos = join(bundle, 'Contents', 'MacOS');
  const resources = join(bundle, 'Contents', 'Resources', 'MXU-portable');
  const main = join(macos, executableName);
  checkDestinationParents(bundle, macos, fileSystem);
  checkDestinationParents(bundle, resources, fileSystem);
  const codeObjects = [];
  for (const directory of [macos, resources]) {
    if (statIfPresent(fileSystem, directory)) {
      for (const name of fileSystem.readdirSync(directory)) {
        if (join(directory, name) !== main) rejectMutableData(join(directory, name), fileSystem);
      }
    }
  }

  const inspect = (path) => {
    const stat = fileSystem.lstatSync(path);
    if (path === main) return { path, keep: true };
    if (stat.isSymbolicLink()) {
      if (!inside(bundle, fileSystem.realpathSync(path))) {
        throw new Error(`Bundle symlink points outside the app: ${path}`);
      }
      return { path, keep: true };
    }
    if (stat.isDirectory()) {
      if (/\.(app|framework|bundle|xpc)$/i.test(path)) {
        codeObjects.push(path);
        return { path, keep: true };
      }
      const children = fileSystem
        .readdirSync(path)
        .sort()
        .map((name) => inspect(join(path, name)));
      return { path, keep: true, children };
    }
    if (!stat.isFile()) throw new Error(`Unsupported file in app bundle: ${path}`);
    const keep = isCode(path);
    if (keep) codeObjects.push(path);
    return { path, directory: false, keep };
  };

  const moves = [];
  const collect = (entry) => {
    if (!entry.keep) {
      const destination = join(resources, relative(macos, entry.path));
      checkDestinationParents(bundle, dirname(destination), fileSystem);
      if (statIfPresent(fileSystem, destination)) {
        throw new Error(`Refusing to overwrite existing resource: ${destination}`);
      }
      const stat = fileSystem.lstatSync(entry.path);
      moves.push({ source: entry.path, destination, dev: stat.dev, ino: stat.ino });
    } else {
      entry.children?.forEach(collect);
    }
  };
  fileSystem
    .readdirSync(macos)
    .sort()
    .map((name) => inspect(join(macos, name)))
    .forEach(collect);
  return { bundle, moves, codeObjects, createdDirectories: [] };
}

/** All moves stay inside the same .app; relative links retain the old lookup paths. */
export function applyBundleLayout(plan, fileSystem = fs, save = () => {}) {
  const makeDirectory = (path) => {
    if (statIfPresent(fileSystem, path)) return;
    makeDirectory(dirname(path));
    fileSystem.mkdirSync(path);
    const stat = fileSystem.lstatSync(path);
    plan.createdDirectories.push({ path, dev: stat.dev, ino: stat.ino });
    save();
  };
  for (const move of plan.moves) {
    checkDestinationParents(plan.bundle, dirname(move.source), fileSystem);
    checkDestinationParents(plan.bundle, dirname(move.destination), fileSystem);
    if (!sameFile(fileSystem.lstatSync(move.source), move)) {
      throw new Error(`Resource changed during repair: ${move.source}`);
    }
    makeDirectory(dirname(move.destination));
    // link(2) 原子拒绝已存在的目标；不能用会覆盖并发新文件的 rename(2)。
    fileSystem.linkSync(move.source, move.destination);
    syncDirectory(dirname(move.destination), fileSystem);
    fileSystem.unlinkSync(move.source);
    fileSystem.symlinkSync(relative(dirname(move.source), move.destination), move.source, 'file');
    syncDirectory(dirname(move.source), fileSystem);
  }
}

function sameFile(stat, expected) {
  return stat && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino;
}

export function syncDirectory(path, fileSystem = fs) {
  // Windows 测试适配器不能打开目录；生产脚本只在 macOS 执行。
  if (process.platform === 'win32') return;
  const fd = fileSystem.openSync(path, 'r');
  try {
    fileSystem.fsyncSync(fd);
  } finally {
    fileSystem.closeSync(fd);
  }
}

/** Infer incomplete link/unlink operations from the durable plan and original inodes. */
export function rollbackBundleLayout(plan, fileSystem = fs) {
  for (const move of [...plan.moves].reverse()) {
    if (
      !inside(join(plan.bundle, 'Contents', 'MacOS'), move.source) ||
      !inside(join(plan.bundle, 'Contents', 'Resources', 'MXU-portable'), move.destination)
    ) {
      throw new Error('Recovery plan leaves the app bundle.');
    }
    checkDestinationParents(plan.bundle, dirname(move.source), fileSystem);
    checkDestinationParents(plan.bundle, dirname(move.destination), fileSystem);
    let source = statIfPresent(fileSystem, move.source);
    const destination = statIfPresent(fileSystem, move.destination);
    if (!sameFile(destination, move)) {
      if (sameFile(source, move)) continue; // 未执行的移动或他人创建的目标，不能删除它。
      throw new Error(`Cannot locate the original resource during recovery: ${move.source}`);
    }
    if (
      source?.isSymbolicLink() &&
      resolve(dirname(move.source), fileSystem.readlinkSync(move.source)) === move.destination
    ) {
      fileSystem.unlinkSync(move.source);
      source = undefined;
    }
    if (!source) fileSystem.linkSync(move.destination, move.source);
    else if (!sameFile(source, move))
      throw new Error(`Cannot restore resource over a changed path: ${move.source}`);
    syncDirectory(dirname(move.source), fileSystem);
    fileSystem.unlinkSync(move.destination);
    syncDirectory(dirname(move.destination), fileSystem);
  }
  for (const entry of [...plan.createdDirectories].reverse()) {
    if (!inside(join(plan.bundle, 'Contents', 'Resources'), entry.path))
      throw new Error('Invalid recovery directory.');
    try {
      if (sameFile(statIfPresent(fileSystem, entry.path), entry)) fileSystem.rmdirSync(entry.path);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
  }
}
