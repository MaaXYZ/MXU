import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getControllerDisplayOptions } from '../src/utils/controllerDisplay.ts';
import { buildIosControllerConfig } from '../src/utils/iosController.ts';
import { buildPlayCoverControllerConfig } from '../src/utils/playCoverController.ts';

test('截图缩放四种模式保持原值，缺省继续由后端使用 720 短边', () => {
  assert.deepEqual(getControllerDisplayOptions(), { display_short_side: undefined });
  for (const mode of [
    { display_short_side: 720 },
    { display_long_side: 1920 },
    { display_expand: [1920, 1080] as [number, number] },
    { display_raw: true },
  ]) {
    assert.deepEqual(getControllerDisplayOptions(mode), { display_short_side: undefined, ...mode });
  }
  assert.deepEqual(getControllerDisplayOptions({ display_raw: false, display_long_side: 1080 }), {
    display_short_side: undefined,
    display_raw: false,
    display_long_side: 1080,
  });
});

test('互斥截图模式、非正整数尺寸和越界值被拒绝', () => {
  for (const mode of [
    { display_raw: true, display_short_side: 720 },
    { display_long_side: 1080, display_expand: [1920, 1080] as [number, number] },
    { display_short_side: 0 },
    { display_long_side: 2.5 },
    { display_short_side: 2147483648 },
    { display_expand: [1920, -1] as [number, number] },
  ]) {
    assert.throws(() => getControllerDisplayOptions(mode), /PI_DISPLAY_OPTIONS_INVALID/);
  }
});

test('PlayCover 保留旧短边参数调用，并转发新缩放模式', () => {
  assert.equal(
    buildPlayCoverControllerConfig('localhost:1717', undefined, 900).display_short_side,
    900,
  );
  assert.equal(
    buildPlayCoverControllerConfig('localhost:1717', 'bundle', { display_raw: true }).display_raw,
    true,
  );
});

test('iOS 使用 PI 指定 UDID、连接和截图方法，并保留配置与缩放', () => {
  const config = buildIosControllerConfig(
    {
      name: 'Phone',
      type: 'IOS',
      display_raw: true,
      ios: {
        udid: 'fixed-device',
        connection: 'WiFi',
        screencap: 'Stream|ScreenshotService',
        config: { server_port: 17424, wifi_address: 'auto' },
      },
    },
    'selected-device',
  );
  assert.equal(config.udid, 'fixed-device');
  assert.equal(config.connection_method, 2);
  assert.equal(config.screencap_methods, '3');
  assert.equal(config.display_raw, true);
  assert.deepEqual(JSON.parse(config.config), { server_port: 17424, wifi_address: 'auto' });
});

test('iOS 可选择设备并仅使用截图服务，缺少 UDID 或未知方法时明确报错', () => {
  const config = buildIosControllerConfig(
    { name: 'Phone', type: 'IOS', ios: { screencap: 'ScreenshotService', connection: 'USB' } },
    ' selected ',
  );
  assert.equal(config.udid, 'selected');
  assert.equal(config.screencap_methods, '2');
  assert.equal(config.connection_method, 1);
  assert.throws(
    () => buildIosControllerConfig({ name: 'Phone', type: 'IOS' }),
    /IOS_UDID_REQUIRED/,
  );
  assert.throws(
    () =>
      buildIosControllerConfig({
        name: 'Phone',
        type: 'IOS',
        ios: { udid: 'device', screencap: 'Unknown' },
      }),
    /IOS_CONFIG_INVALID/,
  );
});
