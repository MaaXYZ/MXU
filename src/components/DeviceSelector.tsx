import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Smartphone,
  Monitor,
  RefreshCw,
  Loader2,
  ChevronDown,
  Check,
  AlertCircle,
  Wifi,
  WifiOff,
  Apple,
  Gamepad2,
  Info,
} from 'lucide-react';
import clsx from 'clsx';
import { maaService } from '@/services/maaService';
import { useAppStore } from '@/stores/appStore';
import type { AdbDevice, Win32Window, ControllerConfig } from '@/types/maa';
import type { ControllerItem } from '@/types/interface';
import {
  buildDesktopWindowControllerConfig,
  getDesktopWindowFilters,
  isDesktopWindowControllerType,
} from '@/utils/controller';
import { loggers } from '@/utils/logger';

const log = loggers.device;

interface DeviceSelectorProps {
  instanceId: string;
  controllerDef: ControllerItem;
  onConnectionChange?: (connected: boolean) => void;
}

export function DeviceSelector({
  instanceId,
  controllerDef,
  onConnectionChange,
}: DeviceSelectorProps) {
  const { t } = useTranslation();

  const [isSearching, setIsSearching] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 从全局 store 获取缓存的设备列表和 ID 映射
  const {
    cachedAdbDevices,
    cachedWin32Windows,
    setCachedAdbDevices,
    setCachedWin32Windows,
    registerCtrlIdName,
  } = useAppStore();

  // 选中的设备（本地状态）
  const [selectedAdbDevice, setSelectedAdbDevice] = useState<AdbDevice | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<Win32Window | null>(null);

  const [showDropdown, setShowDropdown] = useState(false);

  // 等待中的操作 ID（用于回调匹配）
  const [pendingCtrlId, setPendingCtrlId] = useState<number | null>(null);

  // 下拉框触发按钮和菜单的 ref
  const dropdownRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // 计算下拉框位置
  const calcDropdownPosition = useCallback(() => {
    if (!dropdownRef.current) return null;
    const rect = dropdownRef.current.getBoundingClientRect();
    return {
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    };
  }, []);

  // 点击外部关闭下拉框
  useEffect(() => {
    if (!showDropdown) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const inButton = dropdownRef.current?.contains(target);
      const inMenu = menuRef.current?.contains(target);
      if (!inButton && !inMenu) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDropdown]);

  const controllerType = controllerDef.type;
  const isDesktopWindowController = isDesktopWindowControllerType(controllerType);
  const { classRegex: desktopWindowClassRegex, titleRegex: desktopWindowTitleRegex } =
    getDesktopWindowFilters(controllerDef);

  // PlayCover 地址输入
  const [playcoverAddress, setPlaycoverAddress] = useState('127.0.0.1:1717');

  // 监听 MaaFramework 回调事件，处理连接完成
  useEffect(() => {
    if (pendingCtrlId === null) return;

    let unlisten: (() => void) | null = null;

    maaService
      .onCallback((message, details) => {
        if (details.ctrl_id !== pendingCtrlId) return;

        if (message === 'Controller.Action.Succeeded') {
          setIsConnected(true);
          onConnectionChange?.(true);
          setIsConnecting(false);
          setPendingCtrlId(null);
        } else if (message === 'Controller.Action.Failed') {
          log.error('连接失败');
          setError('连接失败');
          setIsConnected(false);
          onConnectionChange?.(false);
          setIsConnecting(false);
          setPendingCtrlId(null);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, [pendingCtrlId, onConnectionChange]);

  // 判断是否需要搜索设备（PlayCover 不需要搜索）
  const needsDeviceSearch = controllerType === 'Adb' || isDesktopWindowController;

  // 初始化 MaaFramework（如果还没初始化）
  const ensureMaaInitialized = async () => {
    try {
      await maaService.getVersion();
      return true;
    } catch {
      // 未初始化，使用默认路径初始化（exe 目录下的 maafw）
      await maaService.init();
      return true;
    }
  };

  // 搜索设备
  const handleSearch = async () => {
    setIsSearching(true);
    setError(null);

    try {
      // 确保 MaaFramework 已初始化
      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error(
          '无法初始化 MaaFramework，请确保 MaaFramework 和 MaaToolkit 动态库在正确的位置',
        );
      }

      if (controllerType === 'Adb') {
        const devices = await maaService.findAdbDevices();
        setCachedAdbDevices(devices);
        if (devices.length === 1) {
          setSelectedAdbDevice(devices[0]);
        }
        if (devices.length > 0) {
          setShowDropdown(true);
        }
      } else if (isDesktopWindowController) {
        const windows = await maaService.findWin32Windows(
          desktopWindowClassRegex,
          desktopWindowTitleRegex,
        );
        setCachedWin32Windows(windows);
        if (windows.length === 1) {
          setSelectedWindow(windows[0]);
        }
        if (windows.length > 0) {
          setShowDropdown(true);
        }
      }
    } catch (err) {
      log.error('搜索设备失败:', err);
      setError(err instanceof Error ? err.message : '搜索失败');
    } finally {
      setIsSearching(false);
    }
  };

  // 连接设备
  const handleConnect = async () => {
    setIsConnecting(true);
    setError(null);

    try {
      // 确保 MaaFramework 已初始化（用户可能跳过刷新直接点连接）
      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error('无法初始化 MaaFramework，请确保 MaaFramework 动态库在正确的位置');
      }

      // 确保实例已创建
      await maaService.createInstance(instanceId).catch(() => {});

      let config: ControllerConfig;

      if (controllerType === 'Adb' && selectedAdbDevice) {
        config = {
          type: 'Adb',
          adb_path: selectedAdbDevice.adb_path,
          address: selectedAdbDevice.address,
          screencap_methods: selectedAdbDevice.screencap_methods,
          input_methods: selectedAdbDevice.input_methods,
          config: selectedAdbDevice.config,
          display_short_side: controllerDef.display_short_side,
        };
      } else if (isDesktopWindowController && selectedWindow) {
        const desktopConfig = buildDesktopWindowControllerConfig(
          controllerDef,
          selectedWindow.handle,
        );
        if (!desktopConfig) {
          throw new Error(t('controller.selectWindow'));
        }
        config = desktopConfig;
      } else if (controllerType === 'PlayCover') {
        config = {
          type: 'PlayCover',
          address: playcoverAddress,
          display_short_side: controllerDef.display_short_side,
        };
      } else {
        throw new Error('请先选择设备');
      }

      const ctrlId = await maaService.connectController(instanceId, config);

      // 注册 ctrl_id 与设备名/类型的映射
      let deviceName = '';
      let targetType: 'device' | 'window' = 'device';
      if (controllerType === 'Adb' && selectedAdbDevice) {
        deviceName = selectedAdbDevice.name || selectedAdbDevice.address;
        targetType = 'device';
      } else if (isDesktopWindowController && selectedWindow) {
        deviceName = selectedWindow.window_name || selectedWindow.class_name;
        targetType = 'window';
      } else if (controllerType === 'PlayCover') {
        deviceName = playcoverAddress;
        targetType = 'device';
      }
      registerCtrlIdName(instanceId, ctrlId, deviceName, targetType);

      // 记录等待中的 ctrl_id，后续由回调处理完成状态
      setPendingCtrlId(ctrlId);
    } catch (err) {
      log.error('连接失败:', err);
      setError(err instanceof Error ? err.message : '连接失败');
      setIsConnected(false);
      onConnectionChange?.(false);
      setIsConnecting(false);
    }
  };

  // 断开连接
  const handleDisconnect = async () => {
    try {
      await maaService.destroyInstance(instanceId);
      setIsConnected(false);
      useAppStore.getState().setInstanceResourceLoaded(instanceId, false);
      onConnectionChange?.(false);
      log.info('已断开连接');
    } catch (err) {
      log.error('断开连接失败:', err);
    }
  };

  // 获取当前选中的显示文本
  const getSelectedText = () => {
    if (controllerType === 'Adb' && selectedAdbDevice) {
      return `${selectedAdbDevice.name} (${selectedAdbDevice.address})`;
    }
    if (isDesktopWindowController && selectedWindow) {
      return selectedWindow.window_name || selectedWindow.class_name;
    }

    return t('controller.selectController');
  };

  // 选择 ADB 设备并自动连接
  const handleSelectAdbDevice = async (device: AdbDevice) => {
    setSelectedAdbDevice(device);
    setShowDropdown(false);

    // 自动连接
    setIsConnecting(true);
    setError(null);

    try {
      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error('无法初始化 MaaFramework，请确保 MaaFramework 动态库在正确的位置');
      }

      await maaService.createInstance(instanceId).catch(() => {});

      const config: ControllerConfig = {
        type: 'Adb',
        adb_path: device.adb_path,
        address: device.address,
        screencap_methods: device.screencap_methods,
        input_methods: device.input_methods,
        config: device.config,
        display_short_side: controllerDef.display_short_side,
      };

      const ctrlId = await maaService.connectController(instanceId, config);

      // 注册 ctrl_id 与设备名/类型的映射
      registerCtrlIdName(instanceId, ctrlId, device.name || device.address, 'device');

      // 记录等待中的 ctrl_id，后续由回调处理完成状态
      setPendingCtrlId(ctrlId);
    } catch (err) {
      log.error('自动连接失败:', err);
      setError(err instanceof Error ? err.message : '连接失败');
      setIsConnected(false);
      onConnectionChange?.(false);
      setIsConnecting(false);
    }
  };

  // 选择 Win32 窗口并自动连接
  const handleSelectWindow = async (win: Win32Window) => {
    setSelectedWindow(win);
    setShowDropdown(false);

    // 自动连接
    setIsConnecting(true);
    setError(null);

    try {
      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error('无法初始化 MaaFramework，请确保 MaaFramework 动态库在正确的位置');
      }

      await maaService.createInstance(instanceId).catch(() => {});

      const config = buildDesktopWindowControllerConfig(controllerDef, win.handle);
      if (!config) {
        throw new Error(t('controller.selectWindow'));
      }

      const ctrlId = await maaService.connectController(instanceId, config);

      // 注册 ctrl_id 与窗口名/类型的映射
      registerCtrlIdName(instanceId, ctrlId, win.window_name || win.class_name, 'window');

      // 记录等待中的 ctrl_id，后续由回调处理完成状态
      setPendingCtrlId(ctrlId);
    } catch (err) {
      log.error('自动连接失败:', err);
      setError(err instanceof Error ? err.message : '连接失败');
      setIsConnected(false);
      onConnectionChange?.(false);
      setIsConnecting(false);
    }
  };

  // 获取设备列表
  const getDeviceList = () => {
    if (controllerType === 'Adb') {
      return cachedAdbDevices.map((device) => ({
        id: `${device.adb_path}:${device.address}`,
        name: device.name,
        description: device.address,
        selected: selectedAdbDevice?.address === device.address,
        onClick: () => handleSelectAdbDevice(device),
      }));
    }
    if (isDesktopWindowController) {
      return cachedWin32Windows.map((window) => ({
        id: String(window.handle),
        name: window.window_name || '(无标题)',
        description: window.class_name,
        selected: selectedWindow?.handle === window.handle,
        onClick: () => handleSelectWindow(window),
      }));
    }

    return [];
  };

  // 判断是否可以连接
  const canConnect = () => {
    if (controllerType === 'Adb') return !!selectedAdbDevice;
    if (isDesktopWindowController) return !!selectedWindow;

    if (controllerType === 'PlayCover') return playcoverAddress.trim().length > 0;
    return false;
  };

  const deviceList = getDeviceList();

  // 获取控制器图标
  const getControllerIcon = () => {
    switch (controllerType) {
      case 'Adb':
        return <Smartphone className="w-4 h-4" />;
      case 'Win32':
        return <Monitor className="w-4 h-4" />;
      case 'MacOS':
      case 'PlayCover':
        return <Apple className="w-4 h-4" />;
      case 'Gamepad':
        return <Gamepad2 className="w-4 h-4" />;
      default:
        return <Smartphone className="w-4 h-4" />;
    }
  };

  // 获取控制器类型名称
  const getControllerTypeName = () => {
    switch (controllerType) {
      case 'Adb':
        return t('controller.adb');
      case 'Win32':
        return t('controller.win32');
      case 'PlayCover':
        return t('controller.playcover');
      case 'MacOS':
        return t('controller.macos');
      case 'Gamepad':
        return t('controller.gamepad');
      default:
        return controllerType;
    }
  };

  return (
    <div className="space-y-3">
      {/* 控制器类型标签 */}
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        {getControllerIcon()}
        <span>{getControllerTypeName()}</span>
        {isConnected && (
          <span className="flex items-center gap-1 text-success text-xs">
            <Wifi className="w-3 h-3" />
            {t('controller.connected')}
          </span>
        )}
      </div>

      {/* PlayCover 地址输入 */}
      {controllerType === 'PlayCover' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Info className="w-3 h-3" />
            <span>{t('controller.playcoverHint')}</span>
          </div>
          <input
            type="text"
            value={playcoverAddress}
            onChange={(e) => setPlaycoverAddress(e.target.value)}
            placeholder="127.0.0.1:1717"
            disabled={isConnected || isConnecting}
            className={clsx(
              'w-full px-3 py-2.5 rounded-lg border bg-bg-tertiary border-border',
              'text-text-primary placeholder:text-text-muted',
              'focus:outline-none focus:border-accent transition-colors',
              isConnected && 'opacity-60 cursor-not-allowed',
            )}
          />
        </div>
      )}

      {/* 设备选择下拉框 - 仅对需要搜索设备的控制器显示 */}
      {needsDeviceSearch && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <button
              ref={dropdownRef}
              onClick={() => {
                if (isConnecting || isConnected) return;
                if (!showDropdown) {
                  setDropdownPos(calcDropdownPosition());
                }
                setShowDropdown(!showDropdown);
              }}
              disabled={isConnecting || isConnected}
              className={clsx(
                'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors',
                'bg-bg-tertiary border-border',
                isConnected
                  ? 'opacity-60 cursor-not-allowed'
                  : 'hover:border-accent cursor-pointer',
              )}
            >
              <span
                className={clsx(
                  'truncate',
                  (controllerType === 'Adb' ? selectedAdbDevice : selectedWindow)
                    ? 'text-text-primary'
                    : 'text-text-muted',
                )}
              >
                {getSelectedText()}
              </span>
              <ChevronDown
                className={clsx(
                  'w-4 h-4 text-text-muted transition-transform',
                  showDropdown && 'rotate-180',
                )}
              />
            </button>

            {/* 下拉菜单 - 使用 fixed 定位避免被父容器裁剪 */}
            {showDropdown && dropdownPos && (
              <div
                ref={menuRef}
                className="mxu-overlay-surface fixed z-[100] bg-bg-secondary border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto"
                style={{
                  top: dropdownPos.top,
                  left: dropdownPos.left,
                  width: dropdownPos.width,
                }}
              >
                {deviceList.length > 0 ? (
                  deviceList.map((item) => (
                    <button
                      key={item.id}
                      onClick={item.onClick}
                      className={clsx(
                        'w-full flex items-center justify-between px-3 py-2 text-left transition-colors',
                        'hover:bg-bg-hover',
                        item.selected && 'bg-accent/10',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-text-primary truncate">{item.name}</div>
                        <div className="text-xs text-text-muted truncate">{item.description}</div>
                      </div>
                      {item.selected && (
                        <Check className="w-4 h-4 text-accent flex-shrink-0 ml-2" />
                      )}
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-4 text-center text-text-muted text-sm">
                    {isSearching ? t('common.loading') : '点击刷新按钮搜索设备'}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 刷新按钮 */}
          <button
            onClick={handleSearch}
            disabled={isSearching || isConnecting || isConnected}
            className={clsx(
              'flex items-center justify-center p-2.5 rounded-lg border transition-colors',
              'bg-bg-tertiary border-border',
              isSearching || isConnecting || isConnected
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:bg-bg-hover hover:border-accent',
            )}
            title={
              isDesktopWindowController
                ? t('controller.refreshWindows')
                : t('controller.refreshDevices')
            }
          >
            {isSearching ? (
              <Loader2 className="w-4 h-4 animate-spin text-text-secondary" />
            ) : (
              <RefreshCw className="w-4 h-4 text-text-secondary" />
            )}
          </button>
        </div>
      )}

      {/* 操作按钮 */}
      {/* 已连接时显示断开按钮 */}
      {isConnected && (
        <button
          onClick={handleDisconnect}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-error/10 text-error hover:bg-error/20 transition-colors"
        >
          <WifiOff className="w-4 h-4" />
          {t('controller.disconnect')}
        </button>
      )}

      {/* PlayCover 需要手动连接按钮 */}
      {controllerType === 'PlayCover' && !isConnected && (
        <button
          onClick={handleConnect}
          disabled={isConnecting || !canConnect()}
          className={clsx(
            'w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            isConnecting || !canConnect()
              ? 'bg-accent/50 text-white/70 cursor-not-allowed'
              : 'bg-accent text-white hover:bg-accent-hover',
          )}
        >
          {isConnecting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('controller.connecting')}
            </>
          ) : (
            <>
              <Wifi className="w-4 h-4" />
              {t('controller.connect')}
            </>
          )}
        </button>
      )}

      {/* 正在连接时显示状态（用于自动连接） */}
      {needsDeviceSearch && isConnecting && !isConnected && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 text-sm text-text-secondary">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('controller.connecting')}
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-error/10 text-error text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
