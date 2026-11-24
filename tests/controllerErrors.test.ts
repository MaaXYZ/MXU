import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendWindowsDllHint,
  isWindowsDllLoadBlockedMessage,
} from '../src/utils/controllerErrors.ts';

test('detects STATUS_INVALID_IMAGE_FORMAT from Windows DLL loads', () => {
  assert.equal(isWindowsDllLoadBlockedMessage('error 0xC000012F while loading'), true);
  assert.equal(isWindowsDllLoadBlockedMessage('0xc000012f'), true);
});

test('detects localized "not a valid Win32 application" messages', () => {
  assert.equal(
    isWindowsDllLoadBlockedMessage('MaaWin32ControlUnit.dll 没有被指定在 Windows 上运行。'),
    true,
  );
  assert.equal(
    isWindowsDllLoadBlockedMessage('MaaWin32ControlUnit.dll 不是有效的 Win32 应用程序。'),
    true,
  );
  assert.equal(
    isWindowsDllLoadBlockedMessage('MaaWin32ControlUnit: is not a valid Win32 application'),
    true,
  );
  assert.equal(isWindowsDllLoadBlockedMessage('Bad EXE format'), true);
});

test('detects MaaFramework library load failures for control units', () => {
  assert.equal(
    isWindowsDllLoadBlockedMessage('Failed to load library [MaaWin32ControlUnit] [message]'),
    true,
  );
  assert.equal(
    isWindowsDllLoadBlockedMessage('[MaaWin32ControlUnit] Failed to load library [message]'),
    true,
  );
  assert.equal(
    isWindowsDllLoadBlockedMessage('Failed to load library [MaaMacOSControlUnit] [message]'),
    false,
  );
});

test('appends the hint once and leaves unrelated errors untouched', () => {
  const hint = '关闭智能应用控制后重试';
  const message = 'MaaWin32ControlUnit: is not a valid Win32 application';

  const once = appendWindowsDllHint(message, hint);
  assert.equal(once, `${message}\n${hint}`);
  assert.equal(appendWindowsDllHint(once, hint), once);
  assert.equal(appendWindowsDllHint('Connection failed', hint), 'Connection failed');
});

test('ignores unrelated connection errors', () => {
  assert.equal(isWindowsDllLoadBlockedMessage(''), false);
  assert.equal(isWindowsDllLoadBlockedMessage('CONTROLLER_CONNECTION_SUPERSEDED'), false);
  assert.equal(isWindowsDllLoadBlockedMessage('Connection failed'), false);
  assert.equal(isWindowsDllLoadBlockedMessage('Failed to connect to 127.0.0.1:7555'), false);
});
