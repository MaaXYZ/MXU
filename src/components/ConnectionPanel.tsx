import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  Smartphone,
  Monitor,
  Apple,
  Gamepad2,
  RefreshCw,
  Loader2,
  Check,
  AlertCircle,
  Wifi,
  WifiOff,
  CheckCircle,
  Settings2,
  History,
} from 'lucide-react';
import clsx from 'clsx';
import { maaService } from '@/services/maaService';
import { useAppStore } from '@/stores/appStore';
import { resolveI18nText } from '@/services/contentResolver';
import { LinuxInputMethod, parseLinuxInputMethod } from '@/types/maa';
import type { AdbDevice, Win32Window, GamescopeInstance, ControllerConfig } from '@/types/maa';
import type { ControllerItem, ResourceItem } from '@/types/interface';
import { computeResourcePaths } from '@/utils/resourcePath';
import { getProcessNameFromPath } from '@/utils/paths';
import { buildPlayCoverControllerConfig } from '@/utils/playCoverController';
import {
  buildDesktopWindowControllerConfig,
  buildLinuxControllerConfig,
  getDesktopWindowFilters,
  findMatchingAdbDevice,
  getLinuxDeviceName,
  getLinuxDiscoveryNeeds,
  isDesktopWindowControllerType,
} from '@/utils/controller';
import { getInterfaceLangKey } from '@/i18n';
import { generateId } from '@/stores/helpers';
import {
  startGlobalCallbackListener,
  waitForCtrlResult,
  waitForResResult,
  autoReconnectAttempted,
} from './connection';

/** 将 uinput 尺寸输入字符串解析为正整数；空串或非法输入返回 undefined */
function parseUinputDimension(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function ConnectionPanel() {
  const { t } = useTranslation();
  const {
    projectInterface,
    basePath,
    language,
    interfaceTranslations,
    activeInstanceId,
    instances,
    cachedAdbDevices,
    cachedWin32Windows,
    cachedWlrootsSockets,
    cachedGamescopeInstances,
    setCachedAdbDevices,
    setCachedWin32Windows,
    setCachedWlrootsSockets,
    setCachedGamescopeInstances,
    selectedController,
    selectedResource,
    setSelectedController,
    setSelectedResource,
    instanceConnectionStatus,
    instanceResourceLoaded,
    setInstanceConnectionStatus,
    setInstanceResourceLoaded,
    setInstanceSavedDevice,
    connectionPanelExpanded,
    setConnectionPanelExpanded,
    registerCtrlIdName,
    registerResIdName,
    registerResBatch,
    addLog,
    addPreAction,
  } = useAppStore();

  // 获取当前活动实例
  const activeInstance = instances.find((i) => i.id === activeInstanceId);

  // 获取当前实例的连接和资源状态（从 store）
  const storedConnectionStatus = activeInstanceId
    ? instanceConnectionStatus[activeInstanceId]
    : undefined;
  const storedResourceLoaded = activeInstanceId ? instanceResourceLoaded[activeInstanceId] : false;

  // 设备相关状态
  const [isSearching, setIsSearching] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [selectedAdbDevice, setSelectedAdbDevice] = useState<AdbDevice | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<Win32Window | null>(null);
  const [selectedWlrootsSocket, setSelectedWlrootsSocket] = useState<string | null>(null);
  const [selectedGamescopeInstance, setSelectedGamescopeInstance] =
    useState<GamescopeInstance | null>(null);
  // uinput 输入的物理屏幕分辨率（宽/高）
  const [uinputScreenWidth, setUinputScreenWidth] = useState<string>(
    activeInstance?.savedDevice?.uinputScreenWidth?.toString() ?? '',
  );
  const [uinputScreenHeight, setUinputScreenHeight] = useState<string>(
    activeInstance?.savedDevice?.uinputScreenHeight?.toString() ?? '',
  );
  const [showDeviceDropdown, setShowDeviceDropdown] = useState(false);
  // PlayCover 地址从保存的配置初始化
  const [playcoverAddress, setPlaycoverAddress] = useState(
    activeInstance?.savedDevice?.playcoverAddress || '127.0.0.1:1717',
  );

  // 资源相关状态
  const [isLoadingResource, setIsLoadingResource] = useState(false);
  const [isResourceLoaded, setIsResourceLoaded] = useState(false);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [showResourceDropdown, setShowResourceDropdown] = useState(false);

  // 记录已加载的资源名称，避免重复加载
  const lastLoadedResourceRef = useRef<string | null>(null);

  // 下拉框触发按钮和菜单的 ref
  const deviceDropdownRef = useRef<HTMLButtonElement>(null);
  const deviceMenuRef = useRef<HTMLDivElement>(null);
  const resourceDropdownRef = useRef<HTMLButtonElement>(null);
  const resourceMenuRef = useRef<HTMLDivElement>(null);
  const [deviceDropdownPos, setDeviceDropdownPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [resourceDropdownPos, setResourceDropdownPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // 计算下拉框位置（向下展开）
  const calcDropdownPosition = useCallback((ref: React.RefObject<HTMLButtonElement | null>) => {
    if (!ref.current) return null;
    const rect = ref.current.getBoundingClientRect();
    return {
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    };
  }, []);

  // 计算下拉框位置（向上展开）
  const calcDropdownPositionUp = useCallback((ref: React.RefObject<HTMLButtonElement | null>) => {
    if (!ref.current) return null;
    const rect = ref.current.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
    };
  }, []);

  const langKey = getInterfaceLangKey(language);
  const translations = interfaceTranslations[langKey];

  // 启动全局回调监听器（只启动一次）
  useEffect(() => {
    void startGlobalCallbackListener().catch(() => {});
  }, []);

  // 点击外部关闭下拉框
  useEffect(() => {
    if (!showDeviceDropdown && !showResourceDropdown) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // 检查点击是否在触发按钮或下拉菜单内部
      if (showDeviceDropdown) {
        const inButton = deviceDropdownRef.current?.contains(target);
        const inMenu = deviceMenuRef.current?.contains(target);
        if (!inButton && !inMenu) {
          setShowDeviceDropdown(false);
        }
      }
      if (showResourceDropdown) {
        const inButton = resourceDropdownRef.current?.contains(target);
        const inMenu = resourceMenuRef.current?.contains(target);
        if (!inButton && !inMenu) {
          setShowResourceDropdown(false);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDeviceDropdown, showResourceDropdown]);

  // 获取当前实例 ID
  const instanceId = activeInstanceId || '';

  // 任务运行中时禁止切换控制器
  const isRunning = activeInstance?.isRunning || false;

  // 获取控制器列表（已在 interfaceLoader 解析阶段按平台过滤）
  const controllers = projectInterface?.controller || [];
  const currentControllerName = selectedController[instanceId] || controllers[0]?.name;
  const currentController =
    controllers.find((c) => c.name === currentControllerName) || controllers[0];
  const controllerType = currentController?.type;
  const isDesktopWindowController = isDesktopWindowControllerType(controllerType);
  const { classRegex: desktopWindowClassRegex, titleRegex: desktopWindowTitleRegex } =
    getDesktopWindowFilters(currentController);
  const linuxNeeds = controllerType === 'Linux' ? getLinuxDiscoveryNeeds(currentController) : null;
  const isUinputInput =
    controllerType === 'Linux' &&
    parseLinuxInputMethod(currentController?.linux?.input) === LinuxInputMethod.UInput;

  // 获取资源列表
  const allResources = projectInterface?.resource || [];

  // 检查资源是否与当前控制器兼容
  const getResourceCompatibility = useCallback(
    (resource: ResourceItem) => {
      const isControllerIncompatible =
        !!resource.controller &&
        resource.controller.length > 0 &&
        !!currentControllerName &&
        !resource.controller.includes(currentControllerName);

      return {
        isIncompatible: isControllerIncompatible,
        reason: isControllerIncompatible ? t('resource.incompatibleController') : '',
      };
    },
    [currentControllerName, t],
  );

  // 获取兼容的资源列表（用于默认选择）
  const compatibleResources = useMemo(() => {
    return allResources.filter((r) => !getResourceCompatibility(r).isIncompatible);
  }, [allResources, getResourceCompatibility]);

  const currentResourceName = selectedResource[instanceId] || compatibleResources[0]?.name;
  const currentResource =
    allResources.find((r) => r.name === currentResourceName) || compatibleResources[0];

  // 当设备和资源都准备好时自动折叠
  useEffect(() => {
    if (isConnected && isResourceLoaded) {
      setConnectionPanelExpanded(false);
    }
  }, [isConnected, isResourceLoaded, setConnectionPanelExpanded]);

  // 当实例切换时，重置和恢复状态
  useEffect(() => {
    // 从 store 恢复连接状态
    const isInstanceConnected = storedConnectionStatus === 'Connected';
    const isInstanceResourceLoaded = storedResourceLoaded;

    setIsConnected(isInstanceConnected);
    setIsResourceLoaded(isInstanceResourceLoaded);

    // 重置临时状态
    setIsSearching(false);
    setIsConnecting(false);
    setIsLoadingResource(false);
    setDeviceError(null);
    setResourceError(null);
    setShowDeviceDropdown(false);
    setShowResourceDropdown(false);

    // 从缓存的设备列表中恢复选中的设备
    const savedDevice = activeInstance?.savedDevice;
    if (savedDevice?.adbDeviceName && cachedAdbDevices.length > 0) {
      // 从缓存中找到匹配的 ADB 设备
      const matchedDevice = findMatchingAdbDevice(cachedAdbDevices, savedDevice);
      setSelectedAdbDevice(matchedDevice || null);
    } else {
      setSelectedAdbDevice(null);
    }

    if (savedDevice?.windowName && cachedWin32Windows.length > 0) {
      // 从缓存中找到匹配的窗口
      const matchedWindow = cachedWin32Windows.find(
        (w) => w.window_name === savedDevice.windowName,
      );
      setSelectedWindow(matchedWindow || null);
    } else {
      setSelectedWindow(null);
    }

    if (savedDevice?.wlrSocketPath && cachedWlrootsSockets.length > 0) {
      // 从缓存中找到匹配的 WlRoots socket
      const matchedSocket = cachedWlrootsSockets.find((s) => s === savedDevice.wlrSocketPath);
      setSelectedWlrootsSocket(matchedSocket || null);
    } else {
      setSelectedWlrootsSocket(null);
    }

    if (savedDevice?.gamescopeDisplayNo !== undefined && cachedGamescopeInstances.length > 0) {
      // 从缓存中找到匹配的 gamescope 实例（按 display 号匹配，节点 id 会随会话变化）
      const matchedInstance = cachedGamescopeInstances.find(
        (i) => i.display_no === savedDevice.gamescopeDisplayNo,
      );
      setSelectedGamescopeInstance(matchedInstance || null);
    } else {
      setSelectedGamescopeInstance(null);
    }

    // 恢复 PlayCover 地址
    if (savedDevice?.playcoverAddress) {
      setPlaycoverAddress(savedDevice.playcoverAddress);
    } else {
      setPlaycoverAddress('127.0.0.1:1717');
    }

    // 如果已连接但未展开，自动折叠
    if (isInstanceConnected && isInstanceResourceLoaded) {
      setConnectionPanelExpanded(false);
    } else {
      setConnectionPanelExpanded(true);
    }
  }, [activeInstanceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 监听 store 中连接状态变化（当 Toolbar 自动连接时同步状态）
  useEffect(() => {
    const isInstanceConnected = storedConnectionStatus === 'Connected';
    // 只在状态从非连接变为已连接时更新，避免覆盖正在连接中的状态
    if (isInstanceConnected && !isConnecting) {
      setIsConnected(true);
      setIsConnecting(false);
    } else if (storedConnectionStatus === 'Disconnected' && !isConnecting) {
      setIsConnected(false);
    }
  }, [storedConnectionStatus, isConnecting]);

  // 监听 store 中资源加载状态变化
  useEffect(() => {
    // 只在状态从未加载变为已加载时更新，避免覆盖正在加载中的状态
    if (storedResourceLoaded && !isLoadingResource) {
      setIsResourceLoaded(true);
      setIsLoadingResource(false);
      // 同步更新 lastLoadedResourceRef，避免重复加载
      if (currentResourceName) {
        lastLoadedResourceRef.current = currentResourceName;
      }
    } else if (!storedResourceLoaded && !isLoadingResource) {
      setIsResourceLoaded(false);
      lastLoadedResourceRef.current = null;
    }
  }, [storedResourceLoaded, isLoadingResource, currentResourceName]);

  // 判断是否需要搜索设备（PlayCover 不需要搜索）
  const needsDeviceSearch =
    controllerType === 'Adb' ||
    isDesktopWindowController ||
    controllerType === 'WlRoots' ||
    controllerType === 'Linux';

  // 记录上一次的控制器名称，用于检测切换
  const prevControllerNameRef = useRef<string | undefined>(currentControllerName);

  // 当控制器切换时自动触发设备搜索
  useEffect(() => {
    const prevName = prevControllerNameRef.current;
    prevControllerNameRef.current = currentControllerName;

    // 检测是否发生了切换（排除初始化和实例切换的情况）
    if (prevName !== undefined && prevName !== currentControllerName && needsDeviceSearch) {
      handleSearch();
    }
  }, [currentControllerName]); // eslint-disable-line react-hooks/exhaustive-deps

  // 应用启动/实例切换时自动重连之前保存的设备
  useEffect(() => {
    if (!instanceId || !activeInstance || !currentController) return;

    // 如果已连接或正在连接/搜索，不触发自动重连
    if (isConnected || isConnecting || isSearching) return;

    // 后端已报告连接成功（如 WebUI 刷新后 restoreBackendStates 恢复），跳过重连
    if (storedConnectionStatus === 'Connected') return;

    // 如果该实例已经尝试过自动重连，不再重复
    if (autoReconnectAttempted.has(instanceId)) return;

    const savedDevice = activeInstance.savedDevice;
    const hasHistoricalDevice =
      savedDevice &&
      ((controllerType === 'Adb' && savedDevice.adbDeviceName) ||
        (isDesktopWindowController && savedDevice.windowName) ||
        (controllerType === 'WlRoots' && savedDevice.wlrSocketPath) ||
        (controllerType === 'Linux' &&
          ((savedDevice.gamescopeDisplayNo !== undefined &&
            (linuxNeeds?.needGamescopeNode || linuxNeeds?.needEisSocket)) ||
            (savedDevice.wlrSocketPath && linuxNeeds?.needWlrSocket))) ||
        (controllerType === 'PlayCover' && savedDevice.playcoverAddress));

    if (hasHistoricalDevice && needsDeviceSearch) {
      // 标记该实例已尝试过自动重连
      autoReconnectAttempted.add(instanceId);
      // 触发搜索并自动连接（handleSearch 内部已有匹配+自动连接逻辑）
      handleSearch();
    } else if (hasHistoricalDevice && controllerType === 'PlayCover') {
      // PlayCover 不需要搜索，直接连接
      autoReconnectAttempted.add(instanceId);
      handleConnect();
    }
  }, [instanceId, activeInstance, currentController, isConnected, isConnecting, isSearching]); // eslint-disable-line react-hooks/exhaustive-deps

  // 初始化 MaaFramework
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
    if (!currentController) return;

    setIsSearching(true);
    setDeviceError(null);

    try {
      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error(t('maa.initFailed'));
      }

      const savedDevice = activeInstance?.savedDevice;

      if (controllerType === 'Adb') {
        const devices = await maaService.findAdbDevices();
        setCachedAdbDevices(devices);

        // 自动连接策略：
        // 1. 如果有保存的设备信息且能唯一匹配 → 自动连接该设备
        // 2. 如果没有保存的设备信息（首次使用）且扫描到设备 → 自动连接第一个
        // 3. 如果有保存的设备但匹配不到 → 显示下拉框让用户选择
        let autoSelected: AdbDevice | null = null;
        if (savedDevice?.adbDeviceName) {
          autoSelected = findMatchingAdbDevice(devices, savedDevice, true) || null;
        } else if (devices.length > 0) {
          // 没有保存设备时自动选择第一个
          autoSelected = devices[0];
          // 给出首次自动匹配提示
          if (instanceId) {
            addLog(instanceId, {
              type: 'info',
              message: t('taskList.autoConnect.autoSelectedDevice', {
                name: autoSelected.name || autoSelected.address,
              }),
            });
          }
        }

        if (autoSelected) {
          handleSelectAdbDevice(autoSelected);
        } else if (devices.length > 0) {
          // 有保存设备但匹配失败，显示下拉框让用户选择
          setShowDeviceDropdown(true);
        }
      } else if (isDesktopWindowController) {
        const windows = await maaService.findWin32Windows(
          desktopWindowClassRegex,
          desktopWindowTitleRegex,
        );
        setCachedWin32Windows(windows);

        // 自动连接策略（与 Adb 一致）
        let autoSelected: Win32Window | null = null;
        if (savedDevice?.windowName) {
          const matched = windows.filter((w) => w.window_name === savedDevice.windowName);
          if (matched.length === 1) {
            autoSelected = matched[0];
          }
        } else if (windows.length > 0) {
          // 没有保存窗口时自动选择第一个
          autoSelected = windows[0];
          // 给出首次自动匹配提示
          if (instanceId) {
            addLog(instanceId, {
              type: 'info',
              message: t('taskList.autoConnect.autoSelectedWindow', {
                name: autoSelected.window_name || autoSelected.class_name,
              }),
            });
          }
        }

        if (autoSelected) {
          handleSelectWindow(autoSelected);
        } else if (windows.length > 0) {
          // 有保存窗口但匹配失败，显示下拉框让用户选择
          setShowDeviceDropdown(true);
        }
      } else if (controllerType === 'WlRoots') {
        const sockets = await maaService.findWlrootsSockets();
        setCachedWlrootsSockets(sockets);

        let autoSelected: string | null = null;
        if (savedDevice?.wlrSocketPath) {
          const matched = sockets.filter((s) => s === savedDevice.wlrSocketPath);
          if (matched.length === 1) {
            autoSelected = matched[0];
          }
        } else if (sockets.length > 0) {
          // 没有保存连接时自动选择第一个
          autoSelected = sockets[0];
          // 给出首次自动匹配提示
          if (instanceId) {
            addLog(instanceId, {
              type: 'info',
              message: t('taskList.autoConnect.autoSelectedDevice', {
                name: autoSelected,
              }),
            });
          }
        }

        if (autoSelected) {
          handleSelectWlrootsSocket(autoSelected);
        } else if (sockets.length > 0) {
          // 有保存连接但匹配失败，显示下拉框让用户选择
          setShowDeviceDropdown(true);
        }
      } else if (controllerType === 'Linux' && linuxNeeds) {
        // 发现所需的全部设备（按当前配置的截图/输入方法）
        let wlrSockets: string[] = [];
        let instances: GamescopeInstance[] = [];

        if (linuxNeeds.needWlrSocket) {
          wlrSockets = await maaService.findWlrootsSockets();
          setCachedWlrootsSockets(wlrSockets);
        }
        if (linuxNeeds.needGamescopeNode || linuxNeeds.needEisSocket) {
          instances = await maaService.findGamescopeInstances();
          setCachedGamescopeInstances(instances);
        }

        // 按需过滤：仅保留提供所需字段的实例（截图需 node id，输入需 EIS socket）
        const eligibleInstances = instances.filter((inst) => {
          if (linuxNeeds.needGamescopeNode && inst.pipewire_node_id === 0) return false;
          if (linuxNeeds.needEisSocket && !inst.eis_socket_path) return false;
          return true;
        });

        // 自动选择：优先匹配保存的 display 号，否则选第一个符合条件实例
        let autoInstance: GamescopeInstance | null = null;
        let autoWlr: string | null = null;

        if (linuxNeeds.needGamescopeNode || linuxNeeds.needEisSocket) {
          if (savedDevice?.gamescopeDisplayNo !== undefined) {
            const matched = eligibleInstances.filter(
              (i) => i.display_no === savedDevice.gamescopeDisplayNo,
            );
            if (matched.length === 1) autoInstance = matched[0];
          } else if (eligibleInstances.length > 0) {
            autoInstance = eligibleInstances[0];
          }
        }
        if (linuxNeeds.needWlrSocket) {
          if (savedDevice?.wlrSocketPath) {
            const matched = wlrSockets.filter((s) => s === savedDevice.wlrSocketPath);
            if (matched.length === 1) autoWlr = matched[0];
          } else if (wlrSockets.length > 0) {
            autoWlr = wlrSockets[0];
          }
        }

        setSelectedGamescopeInstance(autoInstance);
        setSelectedWlrootsSocket(autoWlr);

        if (isLinuxReadyWith(autoInstance, autoWlr)) {
          void connectLinuxDevice(autoInstance, autoWlr);
        } else {
          setShowDeviceDropdown(true);
        }
      }
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
    } finally {
      setIsSearching(false);
    }
  };

  // 连接控制器的内部实现（使用缓存机制解决竞态问题）
  const connectControllerInternal = async (
    config: ControllerConfig,
    deviceName: string,
    targetType: 'device' | 'window',
  ) => {
    await startGlobalCallbackListener();
    const ctrlId = await maaService.connectController(instanceId, config);

    // 注册 ctrl_id 与设备/窗口名及类型的映射，用于日志显示
    registerCtrlIdName(instanceId, ctrlId, deviceName || '', targetType);

    // 等待连接结果（先查缓存，没有则轮询等待）
    const result = await waitForCtrlResult(ctrlId);

    if (result === 'succeeded') {
      setIsConnected(true);
      setInstanceConnectionStatus(instanceId, 'Connected');
      setIsConnecting(false);
      const controllerDisplayName = currentController
        ? getControllerDisplayName(currentController)
        : '';
      const desc = currentController
        ? resolveI18nText(currentController.description, translations)
        : '';
      const logMessage = desc
        ? t('controller.connectedLog', { name: controllerDisplayName }) + '\n' + desc
        : t('controller.connectedLog', { name: controllerDisplayName });
      addLog(instanceId, { type: 'info', message: logMessage });
    } else {
      setDeviceError(t('controller.connectionFailed'));
      setIsConnected(false);
      setInstanceConnectionStatus(instanceId, 'Disconnected');
      setIsConnecting(false);
    }
  };

  // 连接设备
  const handleConnect = async () => {
    if (!currentController) return;

    setIsConnecting(true);
    setDeviceError(null);

    try {
      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error(t('maa.initFailed'));
      }

      await maaService.createInstance(instanceId).catch(() => {});

      let config: ControllerConfig;
      let deviceName = '';
      let targetType: 'device' | 'window' = 'device';

      if (controllerType === 'Adb' && selectedAdbDevice) {
        config = {
          type: 'Adb',
          adb_path: selectedAdbDevice.adb_path,
          address: selectedAdbDevice.address,
          screencap_methods: selectedAdbDevice.screencap_methods,
          input_methods: selectedAdbDevice.input_methods,
          config: selectedAdbDevice.config,
          display_short_side: currentController?.display_short_side,
        };
        deviceName = selectedAdbDevice.name || selectedAdbDevice.address;
        targetType = 'device';
      } else if (isDesktopWindowController && selectedWindow) {
        const desktopConfig = buildDesktopWindowControllerConfig(
          currentController,
          selectedWindow.handle,
        );
        if (!desktopConfig) {
          throw new Error(t('controller.selectWindow'));
        }
        config = desktopConfig;
        deviceName = selectedWindow.window_name || selectedWindow.class_name;
        targetType = 'window';
      } else if (controllerType === 'WlRoots' && selectedWlrootsSocket) {
        config = {
          type: 'WlRoots',
          wlr_socket_path: selectedWlrootsSocket,
          use_win32_vk_code: currentController?.wlroots?.use_win32_vk_code ?? false,
        };
        deviceName = selectedWlrootsSocket;
        targetType = 'device';
      } else if (controllerType === 'PlayCover') {
        // 保存 PlayCover 地址到实例配置
        setInstanceSavedDevice(instanceId, { playcoverAddress });
        config = buildPlayCoverControllerConfig(
          playcoverAddress,
          currentController?.playcover?.uuid,
          currentController?.display_short_side,
        );
        deviceName = playcoverAddress;
        targetType = 'device';
      } else {
        throw new Error(
          isDesktopWindowController ? t('controller.selectWindow') : t('controller.selectDevice'),
        );
      }

      await connectControllerInternal(config, deviceName, targetType);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
      setIsConnected(false);
      setInstanceConnectionStatus(instanceId, 'Disconnected');
      setIsConnecting(false);
    }
  };

  // 加载资源（使用缓存机制解决竞态问题）
  const loadResourceInternal = async (resource: ResourceItem) => {
    setIsLoadingResource(true);
    setResourceError(null);

    try {
      await maaService.createInstance(instanceId).catch(() => {});
      await startGlobalCallbackListener();
      // 计算完整的资源路径（包括 controller.attach_resource_path）
      const resourcePaths = computeResourcePaths(resource, currentController, basePath);

      const resIds = await maaService.loadResource(instanceId, resourcePaths);

      // 注册 res_id 与资源名的映射，用于日志显示
      const resourceDisplayName = resolveI18nText(resource.label, translations) || resource.name;
      registerResBatch(resIds);
      resIds.forEach((resId) => {
        registerResIdName(resId, resourceDisplayName);
      });

      // 如果没有有效的 resIds，直接标记为加载失败
      if (resIds.length === 0) {
        setResourceError(t('resource.loadFailed'));
        setIsLoadingResource(false);
        return;
      }

      // 记录已加载的资源名称
      lastLoadedResourceRef.current = resource.name;

      // 等待所有资源加载完成（先查缓存，没有则轮询等待）
      const results = await Promise.all(resIds.map((resId) => waitForResResult(resId)));

      // 检查是否有失败的
      const hasFailed = results.some((r) => r === 'failed');

      if (hasFailed) {
        setResourceError(t('resource.loadFailed'));
        setIsResourceLoaded(false);
        setInstanceResourceLoaded(instanceId, false);
        setIsLoadingResource(false);
        lastLoadedResourceRef.current = null;
      } else {
        setIsResourceLoaded(true);
        setInstanceResourceLoaded(instanceId, true);
        setIsLoadingResource(false);
      }
    } catch (err) {
      setResourceError(err instanceof Error ? err.message : t('resource.loadFailed'));
      setIsResourceLoaded(false);
      setInstanceResourceLoaded(instanceId, false);
      setIsLoadingResource(false);
      lastLoadedResourceRef.current = null;
    }
  };

  // 切换资源：销毁旧资源后加载新资源
  const switchResource = async (newResource: ResourceItem) => {
    setIsLoadingResource(true);
    setResourceError(null);
    setIsResourceLoaded(false);
    setInstanceResourceLoaded(instanceId, false);

    try {
      // 销毁旧的资源
      await maaService.destroyResource(instanceId);

      // 加载新资源
      await loadResourceInternal(newResource);
    } catch (err) {
      setResourceError(err instanceof Error ? err.message : t('resource.switchFailed'));
      setIsLoadingResource(false);
      lastLoadedResourceRef.current = null;
    }
  };

  // 处理资源选择（自动加载）
  const handleResourceSelect = async (resource: ResourceItem) => {
    setShowResourceDropdown(false);

    // 检查是否正在运行任务
    const isRunning = activeInstance?.isRunning || false;
    if (isRunning) {
      // 任务运行中不允许切换资源
      setResourceError(t('resource.cannotSwitchWhileRunning'));
      return;
    }

    // 如果选择的是同一个资源且已加载，不做任何操作
    if (resource.name === lastLoadedResourceRef.current && isResourceLoaded) {
      setSelectedResource(instanceId, resource.name);
      return;
    }

    // 更新选中状态
    setSelectedResource(instanceId, resource.name);

    // 如果之前已加载过资源，需要先销毁再加载
    if (lastLoadedResourceRef.current !== null) {
      await switchResource(resource);
    } else {
      // 首次加载
      await loadResourceInternal(resource);
    }
  };

  // 获取控制器图标
  const getControllerIcon = (type?: string) => {
    switch (type) {
      case 'Adb':
        return <Smartphone className="w-4 h-4" />;
      case 'Win32':
      case 'WlRoots':
      case 'Linux':
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

  // 获取选中设备的显示文本
  const getSelectedDeviceText = () => {
    const savedDevice = activeInstance?.savedDevice;

    if (controllerType === 'Adb') {
      if (selectedAdbDevice) {
        return `${selectedAdbDevice.name} (${selectedAdbDevice.address})`;
      }
      // 缓存为空但有历史设备名称
      if (savedDevice?.adbDeviceName) {
        return savedDevice.adbDeviceName;
      }
      return t('controller.selectDevice');
    }
    if (isDesktopWindowController) {
      if (selectedWindow) {
        return selectedWindow.window_name || selectedWindow.class_name;
      }
      // 缓存为空但有历史窗口名称
      if (savedDevice?.windowName) {
        return savedDevice.windowName;
      }
      return t('controller.selectWindow');
    }
    if (controllerType === 'WlRoots') {
      if (selectedWlrootsSocket) {
        return selectedWlrootsSocket;
      }
      // 缓存为空但有历史窗口名称
      if (savedDevice?.wlrSocketPath) {
        return savedDevice.wlrSocketPath;
      }
      return t('controller.selectDevice');
    }
    if (controllerType === 'Linux') {
      const parts: string[] = [];
      if (linuxNeeds?.needGamescopeNode || linuxNeeds?.needEisSocket) {
        const displayNo = selectedGamescopeInstance?.display_no ?? savedDevice?.gamescopeDisplayNo;
        parts.push(displayNo !== undefined ? `gamescope-${displayNo}` : '');
      }
      if (linuxNeeds?.needWlrSocket) {
        parts.push(selectedWlrootsSocket || savedDevice?.wlrSocketPath || '');
      }
      if (linuxNeeds?.isPortal) {
        parts.push(t('controller.portal'));
      }
      const filtered = parts.filter(Boolean);
      return filtered.length > 0 ? filtered.join(' + ') : t('controller.selectDevice');
    }
    return t('controller.selectDevice');
  };

  // 选择 ADB 设备并自动连接（如已连接会先断开旧连接）
  const handleSelectAdbDevice = async (device: AdbDevice) => {
    setSelectedAdbDevice(device);
    setShowDeviceDropdown(false);

    // 保存设备名称和地址到实例配置。
    setInstanceSavedDevice(instanceId, {
      adbDeviceName: device.name,
      adbDeviceAddress: device.address,
    });

    // 自动连接
    setIsConnecting(true);
    setDeviceError(null);

    try {
      // 先断开旧连接
      if (isConnected) {
        await maaService.destroyInstance(instanceId).catch(() => {});
        setIsConnected(false);
        setInstanceResourceLoaded(instanceId, false);
      }

      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error(t('maa.initFailed'));
      }

      await maaService.createInstance(instanceId).catch(() => {});

      const config: ControllerConfig = {
        type: 'Adb',
        adb_path: device.adb_path,
        address: device.address,
        screencap_methods: device.screencap_methods,
        input_methods: device.input_methods,
        config: device.config,
        display_short_side: currentController?.display_short_side,
      };

      await connectControllerInternal(config, device.name || device.address, 'device');
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
      setIsConnected(false);
      setInstanceConnectionStatus(instanceId, 'Disconnected');
      setIsConnecting(false);
    }
  };

  // 连接成功后尝试获取窗口进程路径，自动添加前置程序
  const fetchAndStoreProcessPath = async (hwnd: number) => {
    try {
      const programPath = await maaService.getProcessPathFromHwnd(hwnd);
      if (!programPath) return;

      const inst = useAppStore.getState().instances.find((i) => i.id === instanceId);
      setInstanceSavedDevice(instanceId, {
        ...inst?.savedDevice,
        connectedProgramPath: programPath,
      });

      const processName = getProcessNameFromPath(programPath);

      // 自动添加禁用的前置程序（启动进程），dedup 在 store 内原子检查
      const added = addPreAction(
        instanceId,
        {
          id: generateId(),
          customName: t('action.autoPreActionName', { name: processName }),
          enabled: false,
          program: programPath,
          args: '',
          waitForExit: false,
          skipIfRunning: true,
          useCmd: false,
        },
        { field: 'program', value: programPath },
      );
      if (added) {
        addLog(instanceId, {
          type: 'info',
          message: t('action.autoPreActionAdded', { name: processName }),
        });
      }
    } catch {
      // best-effort, 静默忽略
    }
  };

  // 选择 Win32 窗口并自动连接（如已连接会先断开旧连接）
  const handleSelectWindow = async (win: Win32Window) => {
    setSelectedWindow(win);
    setShowDeviceDropdown(false);

    // 保存窗口名称到实例配置
    setInstanceSavedDevice(instanceId, { windowName: win.window_name });

    // 自动连接
    setIsConnecting(true);
    setDeviceError(null);

    try {
      // 先断开旧连接
      if (isConnected) {
        await maaService.destroyInstance(instanceId).catch(() => {});
        setIsConnected(false);
        setInstanceResourceLoaded(instanceId, false);
      }

      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error(t('maa.initFailed'));
      }

      await maaService.createInstance(instanceId).catch(() => {});

      const config = buildDesktopWindowControllerConfig(currentController, win.handle);
      if (!config) {
        throw new Error(t('controller.selectWindow'));
      }

      await connectControllerInternal(config, win.window_name || win.class_name, 'window');

      // 仅 Windows 窗口句柄支持进程路径查询。
      if (controllerType === 'Win32' || controllerType === 'Gamepad') {
        void fetchAndStoreProcessPath(win.handle);
      }
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
      setIsConnected(false);
      setInstanceConnectionStatus(instanceId, 'Disconnected');
      setIsConnecting(false);
    }
  };

  // 选择 WlRoots socket 并自动连接（如已连接会先断开旧连接）
  const handleSelectWlrootsSocket = async (socketPath: string) => {
    setSelectedWlrootsSocket(socketPath);
    setShowDeviceDropdown(false);

    // 保存 socket path 到实例配置
    setInstanceSavedDevice(instanceId, { wlrSocketPath: socketPath });

    // 自动连接
    setIsConnecting(true);
    setDeviceError(null);

    try {
      // 先断开旧连接
      if (isConnected) {
        await maaService.destroyInstance(instanceId).catch(() => {});
        setIsConnected(false);
        setInstanceResourceLoaded(instanceId, false);
      }

      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error(t('maa.initFailed'));
      }

      await maaService.createInstance(instanceId).catch(() => {});

      const config: ControllerConfig = {
        type: 'WlRoots',
        wlr_socket_path: socketPath,
        use_win32_vk_code: currentController?.wlroots?.use_win32_vk_code ?? false,
      };

      await connectControllerInternal(config, socketPath, 'device');
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
      setIsConnected(false);
      setInstanceConnectionStatus(instanceId, 'Disconnected');
      setIsConnecting(false);
    }
  };

  // === Linux 控制器连接逻辑 ===

  // Linux：判断给定选择是否满足当前配置所需的全部设备
  const isLinuxReadyWith = (instance: GamescopeInstance | null, wlr: string | null) => {
    if (!linuxNeeds) return false;
    if (linuxNeeds.needGamescopeNode || linuxNeeds.needEisSocket) {
      if (!instance) return false;
      if (linuxNeeds.needGamescopeNode && instance.pipewire_node_id === 0) return false;
      if (linuxNeeds.needEisSocket && !instance.eis_socket_path) return false;
    }
    if (linuxNeeds.needWlrSocket && !wlr) return false;
    return true;
  };

  // Linux：执行连接（断开旧连接、初始化、创建实例、构建配置并连接）
  const connectLinuxDevice = async (instance: GamescopeInstance | null, wlr: string | null) => {
    setIsConnecting(true);
    setDeviceError(null);

    try {
      if (isConnected) {
        await maaService.destroyInstance(instanceId).catch(() => {});
        setIsConnected(false);
        setInstanceResourceLoaded(instanceId, false);
      }

      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error(t('maa.initFailed'));
      }

      await maaService.createInstance(instanceId).catch(() => {});

      const parsedWidth = parseUinputDimension(uinputScreenWidth);
      const parsedHeight = parseUinputDimension(uinputScreenHeight);

      const config = buildLinuxControllerConfig(currentController, {
        wlrSocketPath: wlr ?? undefined,
        pwNodeId: instance?.pipewire_node_id,
        eisSocketPath: instance?.eis_socket_path || undefined,
        uinputScreenWidth: parsedWidth,
        uinputScreenHeight: parsedHeight,
      });

      saveLinuxDeviceInfo({
        uinputScreenWidth: parsedWidth,
        uinputScreenHeight: parsedHeight,
      });

      const deviceName = getLinuxDeviceName(
        currentController,
        {
          wlrSocketPath: wlr ?? undefined,
          gamescopeDisplayNo: instance?.display_no,
        },
        { portal: t('controller.portal'), linux: t('controller.linux') },
      );
      await connectControllerInternal(config, deviceName, 'device');
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
      setIsConnected(false);
      setInstanceConnectionStatus(instanceId, 'Disconnected');
      setIsConnecting(false);
    }
  };

  // 合并保存 Linux 设备信息（保留其它已保存字段）
  const saveLinuxDeviceInfo = (
    patch: Partial<NonNullable<typeof activeInstance>['savedDevice']>,
  ) => {
    const inst = useAppStore.getState().instances.find((i) => i.id === instanceId);
    setInstanceSavedDevice(instanceId, { ...inst?.savedDevice, ...patch });
  };

  const handleSelectLinuxGamescopeInstance = (instance: GamescopeInstance) => {
    setSelectedGamescopeInstance(instance);
    saveLinuxDeviceInfo({ gamescopeDisplayNo: instance.display_no });
    setShowDeviceDropdown(false);

    if (isLinuxReadyWith(instance, selectedWlrootsSocket)) {
      void connectLinuxDevice(instance, selectedWlrootsSocket);
    } else {
      // 还有其它设备需要选择，重新打开下拉框
      setShowDeviceDropdown(true);
    }
  };

  const handleSelectLinuxWlrSocket = (path: string) => {
    setSelectedWlrootsSocket(path);
    saveLinuxDeviceInfo({ wlrSocketPath: path });
    setShowDeviceDropdown(false);

    if (isLinuxReadyWith(selectedGamescopeInstance, path)) {
      void connectLinuxDevice(selectedGamescopeInstance, path);
    } else {
      setShowDeviceDropdown(true);
    }
  };

  // 点击历史设备条目时，触发搜索并自动匹配连接
  const handleSearchAndConnectHistorical = async () => {
    if (!currentController) return;

    setIsSearching(true);
    setDeviceError(null);
    setShowDeviceDropdown(false);

    try {
      const initialized = await ensureMaaInitialized();
      if (!initialized) {
        throw new Error(t('maa.initFailed'));
      }

      const savedDevice = activeInstance?.savedDevice;

      if (controllerType === 'Adb') {
        const devices = await maaService.findAdbDevices();
        setCachedAdbDevices(devices);

        // 尝试匹配保存的设备信息
        if (savedDevice?.adbDeviceName) {
          const matched = findMatchingAdbDevice(devices, savedDevice);
          if (matched) {
            // 找到匹配的，自动连接
            setIsSearching(false);
            handleSelectAdbDevice(matched);
            return;
          }
          // 没找到匹配的，显示错误提示
          setDeviceError(t('controller.savedDeviceNotFound'));
        }

        // 显示搜索结果供用户选择
        if (devices.length > 0) {
          setShowDeviceDropdown(true);
        }
      } else if (isDesktopWindowController) {
        const windows = await maaService.findWin32Windows(
          desktopWindowClassRegex,
          desktopWindowTitleRegex,
        );
        setCachedWin32Windows(windows);

        // 尝试匹配保存的窗口名称
        if (savedDevice?.windowName) {
          const matched = windows.find((w) => w.window_name === savedDevice.windowName);
          if (matched) {
            // 找到匹配的，自动连接
            setIsSearching(false);
            handleSelectWindow(matched);
            return;
          }
          // 没找到匹配的，显示错误提示
          setDeviceError(t('controller.savedWindowNotFound'));
        }

        // 显示搜索结果供用户选择
        if (windows.length > 0) {
          setShowDeviceDropdown(true);
        }
      } else if (controllerType === 'WlRoots') {
        const sockets = await maaService.findWlrootsSockets();
        setCachedWlrootsSockets(sockets);

        // 尝试匹配保存的窗口名称
        if (savedDevice?.wlrSocketPath) {
          const matched = sockets.find((s) => s === savedDevice.wlrSocketPath);
          if (matched) {
            // 找到匹配的，自动连接
            setIsSearching(false);
            handleSelectWlrootsSocket(matched);
            return;
          }
          // 没找到匹配的，显示错误提示
          setDeviceError(t('controller.savedDeviceNotFound'));
        }

        // 显示搜索结果供用户选择
        if (sockets.length > 0) {
          setShowDeviceDropdown(true);
        }
      } else if (controllerType === 'Linux' && linuxNeeds) {
        // Linux：复用 handleSearch 的发现+匹配+自动连接逻辑
        setIsSearching(false);
        await handleSearch();
        return;
      }
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : t('controller.connectionFailed'));
    } finally {
      setIsSearching(false);
    }
  };

  // 获取设备列表
  const getDeviceList = () => {
    const savedDevice = activeInstance?.savedDevice;

    if (controllerType === 'Adb') {
      // 如果缓存中有设备，使用缓存列表
      if (cachedAdbDevices.length > 0) {
        return cachedAdbDevices.map((device) => ({
          id: `${device.adb_path}:${device.address}`,
          name: device.name,
          description: device.address,
          selected: selectedAdbDevice?.address === device.address,
          onClick: () => handleSelectAdbDevice(device),
          isHistorical: false,
        }));
      }

      // 缓存为空但有历史设备名称，显示历史设备条目
      if (savedDevice?.adbDeviceName) {
        return [
          {
            id: 'historical-device',
            name: savedDevice.adbDeviceName,
            description: t('controller.lastSelected'),
            selected: true,
            onClick: handleSearchAndConnectHistorical,
            isHistorical: true,
          },
        ];
      }

      return [];
    }
    if (isDesktopWindowController) {
      // 如果缓存中有窗口，使用缓存列表
      if (cachedWin32Windows.length > 0) {
        return cachedWin32Windows.map((window) => ({
          id: String(window.handle),
          name: window.window_name || '(无标题)',
          description: window.class_name,
          selected: selectedWindow?.handle === window.handle,
          onClick: () => handleSelectWindow(window),
          isHistorical: false,
        }));
      }

      // 缓存为空但有历史窗口名称，显示历史窗口条目
      if (savedDevice?.windowName) {
        return [
          {
            id: 'historical-window',
            name: savedDevice.windowName,
            description: t('controller.lastSelected'),
            selected: true,
            onClick: handleSearchAndConnectHistorical,
            isHistorical: true,
          },
        ];
      }

      return [];
    }
    if (controllerType === 'WlRoots') {
      // 如果缓存中有窗口，使用缓存列表
      if (cachedWlrootsSockets.length > 0) {
        return cachedWlrootsSockets.map((socket) => ({
          id: `wlr:${socket}`,
          name: socket,
          description: socket,
          selected: selectedWlrootsSocket === socket,
          onClick: () => handleSelectWlrootsSocket(socket),
          isHistorical: false,
        }));
      }

      // 缓存为空但有历史窗口名称，显示历史窗口条目
      if (savedDevice?.wlrSocketPath) {
        return [
          {
            id: 'historical-wlroots-socket',
            name: savedDevice.wlrSocketPath,
            description: t('controller.lastSelected'),
            selected: true,
            onClick: handleSearchAndConnectHistorical,
            isHistorical: true,
          },
        ];
      }

      return [];
    }
    if (controllerType === 'Linux' && linuxNeeds) {
      // 展示所有已发现的选择项（含当前选中项），保证下拉不为空
      const instanceItems =
        linuxNeeds.needGamescopeNode || linuxNeeds.needEisSocket
          ? cachedGamescopeInstances
              .filter((inst) => {
                if (linuxNeeds.needGamescopeNode && inst.pipewire_node_id === 0) return false;
                if (linuxNeeds.needEisSocket && !inst.eis_socket_path) return false;
                return true;
              })
              .map((inst) => ({
                id: `gamescope:${inst.display_no}`,
                name: `gamescope-${inst.display_no}`,
                description: [
                  inst.pipewire_node_id ? `node ${inst.pipewire_node_id}` : '',
                  inst.eis_socket_path,
                ]
                  .filter(Boolean)
                  .join(' · '),
                selected: selectedGamescopeInstance?.display_no === inst.display_no,
                onClick: () => handleSelectLinuxGamescopeInstance(inst),
                isHistorical: false,
              }))
          : [];
      const wlrItems = linuxNeeds.needWlrSocket
        ? cachedWlrootsSockets.map((socket) => ({
            id: `wlr:${socket}`,
            name: socket,
            description: socket,
            selected: selectedWlrootsSocket === socket,
            onClick: () => handleSelectLinuxWlrSocket(socket),
            isHistorical: false,
          }))
        : [];
      return [...instanceItems, ...wlrItems];
    }
    return [];
  };

  // 判断是否可以连接
  const canConnect = () => {
    if (controllerType === 'Adb') return !!selectedAdbDevice;
    if (isDesktopWindowController) return !!selectedWindow;
    if (controllerType === 'WlRoots') return !!selectedWlrootsSocket;
    if (controllerType === 'Linux') {
      return isLinuxReadyWith(selectedGamescopeInstance, selectedWlrootsSocket);
    }
    if (controllerType === 'PlayCover') return playcoverAddress.trim().length > 0;
    return false;
  };

  // 获取资源显示名称
  const getResourceDisplayName = (resource: ResourceItem) => {
    return resolveI18nText(resource.label, translations) || resource.name;
  };

  // 获取控制器显示名称
  const getControllerDisplayName = (controller: ControllerItem) => {
    return resolveI18nText(controller.label, translations) || controller.name;
  };

  const deviceList = getDeviceList();

  // 状态指示器
  const StatusIndicator = () => {
    // 截断文本并添加省略号
    const truncateText = (text: string, maxLength: number) => {
      if (text.length <= maxLength) return text;
      return text.slice(0, maxLength) + '...';
    };

    // 获取设备显示文本（优先显示具体设备名）
    const getDeviceStatusText = () => {
      const savedDevice = activeInstance?.savedDevice;
      if (savedDevice?.adbDeviceName) {
        return truncateText(savedDevice.adbDeviceName, 6);
      }
      if (savedDevice?.windowName) {
        return truncateText(savedDevice.windowName, 6);
      }
      if (controllerType === 'Linux' && savedDevice) {
        // Linux：按当前配置输出实际使用的设备（portal/uinput 等忽略残留的 gamescope-<n>）
        return truncateText(
          getLinuxDeviceName(
            currentController,
            {
              wlrSocketPath: savedDevice.wlrSocketPath,
              gamescopeDisplayNo: savedDevice.gamescopeDisplayNo,
            },
            { portal: t('controller.portal'), linux: t('controller.linux') },
          ),
          24,
        );
      }
      if (savedDevice?.wlrSocketPath) {
        return truncateText(savedDevice.wlrSocketPath, 6);
      }
      if (savedDevice?.gamescopeDisplayNo !== undefined) {
        return `gamescope-${savedDevice.gamescopeDisplayNo}`;
      }
      if (savedDevice?.playcoverAddress) {
        return truncateText(savedDevice.playcoverAddress, 6);
      }
      // 没有设备名时回退到控制器名称
      if (currentController) {
        return getControllerDisplayName(currentController);
      }
      return t('controller.disconnected');
    };

    // 判断是否有历史设备记录（按当前控制器配置筛选：不依赖 gamescope 的配置不把残留的 gamescopeDisplayNo 视为历史设备）
    const hasHistoricalDevice = () => {
      const s = activeInstance?.savedDevice;
      if (!s) return false;
      return (
        s.adbDeviceName ||
        s.windowName ||
        (controllerType === 'WlRoots' && s.wlrSocketPath) ||
        (controllerType === 'Linux' &&
          ((s.gamescopeDisplayNo !== undefined &&
            (linuxNeeds?.needGamescopeNode || linuxNeeds?.needEisSocket)) ||
            (s.wlrSocketPath && linuxNeeds?.needWlrSocket))) ||
        s.playcoverAddress
      );
    };

    return (
      <div className="flex items-center gap-2">
        {isConnecting ? (
          <span className="flex items-center gap-1 text-accent text-xs">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('controller.connecting')}
          </span>
        ) : isConnected ? (
          <span
            className="flex items-center gap-1 text-success text-xs"
            title={getDeviceStatusText()}
          >
            <Wifi className="w-3 h-3" />
            {getDeviceStatusText()}
          </span>
        ) : hasHistoricalDevice() && currentController ? (
          <span
            className="flex items-center gap-1 text-text-muted text-xs"
            title={getDeviceStatusText()}
          >
            <WifiOff className="w-3 h-3" />
            {getDeviceStatusText()}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-text-muted text-xs">
            <WifiOff className="w-3 h-3" />
            {t('controller.disconnected')}
          </span>
        )}
        {isResourceLoaded && currentResource && (
          <span
            className="flex items-center gap-1 text-success text-xs"
            title={getResourceDisplayName(currentResource)}
          >
            <CheckCircle className="w-3 h-3" />
            {truncateText(getResourceDisplayName(currentResource), 6)}
          </span>
        )}
      </div>
    );
  };

  if (!projectInterface || controllers.length === 0) {
    return null;
  }

  return (
    <div
      id="connection-panel"
      className="bg-bg-secondary rounded-lg ring-1 ring-inset ring-border overflow-hidden"
    >
      {/* 标题栏（可点击折叠） */}
      <button
        onClick={() => setConnectionPanelExpanded(!connectionPanelExpanded)}
        className={clsx(
          'w-full flex items-center justify-between px-3 py-2 hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 outline-none',
          connectionPanelExpanded ? 'rounded-t-lg' : 'rounded-lg',
        )}
        style={{
          transition: `background-color 150ms, border-radius 0s${connectionPanelExpanded ? '' : ' 150ms'}`,
        }}
      >
        <div className="flex items-center gap-2">
          <Settings2 className="w-4 h-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">{t('connection.title')}</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusIndicator />
          <ChevronDown
            className={clsx(
              'w-4 h-4 text-text-muted transition-transform duration-150 ease-out',
              connectionPanelExpanded && 'rotate-180',
            )}
          />
        </div>
      </button>

      {/* 可折叠内容 - 使用 grid 动画实现平滑展开/折叠 */}
      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: connectionPanelExpanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden min-h-0">
          {/* 分隔线放在 overflow-hidden 内部，避免展开瞬间闪烁 */}
          <div className="border-t border-border" />
          <div className="p-3 space-y-3">
            {/* 控制器选择 - 标题和按钮同一行 */}
            {controllers.length > 1 && (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-text-secondary flex-shrink-0">
                  {getControllerIcon(controllerType)}
                  <span>{t('controller.title')}</span>
                </div>
                <div className="flex flex-wrap gap-1 justify-end">
                  {controllers.map((controller) => {
                    const desc = resolveI18nText(controller.description, translations);
                    return (
                      <button
                        key={controller.name}
                        title={desc || undefined}
                        onClick={async () => {
                          // 点击当前已选中的控制器，不做任何操作
                          if (currentControllerName === controller.name) return;

                          // 切换控制器：销毁实例（清除 tasker）并重新创建
                          // 保留资源加载状态（资源在 Rust 后端独立存储）
                          await maaService.destroyInstance(instanceId).catch(() => {});
                          await maaService.createInstance(instanceId).catch(() => {});

                          setSelectedController(instanceId, controller.name);
                          setIsConnected(false);
                          setInstanceConnectionStatus(instanceId, 'Disconnected');
                          setSelectedAdbDevice(null);
                          setSelectedWindow(null);
                          setSelectedWlrootsSocket(null);
                          setSelectedGamescopeInstance(null);

                          // 检查当前资源是否支持新控制器，如果不支持则切换到第一个可用资源
                          const newControllerResources = allResources.filter((r) => {
                            if (r.controller && r.controller.length > 0) {
                              return r.controller.includes(controller.name);
                            }
                            return true;
                          });

                          const currentResourceSupported = newControllerResources.some(
                            (r) => r.name === currentResourceName,
                          );

                          if (!currentResourceSupported && newControllerResources.length > 0) {
                            // 当前资源不支持新控制器，切换到第一个可用资源
                            setSelectedResource(instanceId, newControllerResources[0].name);
                            // 资源切换后需要重新加载
                            setIsResourceLoaded(false);
                            setInstanceResourceLoaded(instanceId, false);
                            lastLoadedResourceRef.current = null;
                          } else {
                            // 资源不变，但新实例需要重新绑定资源
                            setIsResourceLoaded(false);
                            setInstanceResourceLoaded(instanceId, false);
                            lastLoadedResourceRef.current = null;
                          }
                        }}
                        disabled={isConnecting || isSearching || isRunning}
                        className={clsx(
                          'px-2 py-0.5 text-xs rounded-md transition-colors',
                          currentControllerName === controller.name
                            ? 'bg-accent text-white'
                            : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                          (isConnecting || isSearching || isRunning) &&
                            'opacity-50 cursor-not-allowed',
                        )}
                      >
                        {getControllerDisplayName(controller)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* uinput 输入的屏幕分辨率 */}
            {isUinputInput && (
              <div className="flex gap-2">
                <input
                  type="number"
                  min={1}
                  value={uinputScreenWidth}
                  onChange={(e) => setUinputScreenWidth(e.target.value)}
                  placeholder={t('controller.uinputWidth')}
                  disabled={isConnected || isConnecting || isRunning}
                  className={clsx(
                    'flex-1 min-w-0 px-2.5 py-1.5 rounded-md border bg-bg-tertiary border-border text-sm',
                    'text-text-primary placeholder:text-text-muted',
                    'focus:outline-none focus:border-accent transition-colors',
                    (isConnected || isRunning) && 'opacity-60 cursor-not-allowed',
                  )}
                />
                <input
                  type="number"
                  min={1}
                  value={uinputScreenHeight}
                  onChange={(e) => setUinputScreenHeight(e.target.value)}
                  placeholder={t('controller.uinputHeight')}
                  disabled={isConnected || isConnecting || isRunning}
                  className={clsx(
                    'flex-1 min-w-0 px-2.5 py-1.5 rounded-md border bg-bg-tertiary border-border text-sm',
                    'text-text-primary placeholder:text-text-muted',
                    'focus:outline-none focus:border-accent transition-colors',
                    (isConnected || isRunning) && 'opacity-60 cursor-not-allowed',
                  )}
                />
              </div>
            )}

            {/* PlayCover 地址输入和连接按钮 */}
            {controllerType === 'PlayCover' && (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={playcoverAddress}
                  onChange={(e) => setPlaycoverAddress(e.target.value)}
                  placeholder="127.0.0.1:1717"
                  disabled={isConnected || isConnecting || isRunning}
                  className={clsx(
                    'flex-1 min-w-0 px-2.5 py-1.5 rounded-md border bg-bg-tertiary border-border text-sm',
                    'text-text-primary placeholder:text-text-muted',
                    'focus:outline-none focus:border-accent transition-colors',
                    (isConnected || isRunning) && 'opacity-60 cursor-not-allowed',
                  )}
                />
                <button
                  onClick={handleConnect}
                  disabled={isConnecting || isConnected || !canConnect() || isRunning}
                  className={clsx(
                    'flex items-center justify-center px-3 py-1.5 rounded-md border transition-colors',
                    isConnected
                      ? 'bg-success/20 border-success/50 cursor-not-allowed'
                      : isConnecting || !canConnect() || isRunning
                        ? 'bg-bg-tertiary border-border opacity-50 cursor-not-allowed'
                        : 'bg-accent border-accent text-white hover:bg-accent-hover',
                  )}
                  title={t('controller.connect')}
                >
                  {isConnecting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-text-secondary" />
                  ) : isConnected ? (
                    <Check className="w-3.5 h-3.5 text-success" />
                  ) : (
                    <Wifi className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            )}

            {/* 设备选择（Adb/Win32/MacOS/Gamepad/Wlroots）- 下拉框和刷新按钮同一行 */}
            {needsDeviceSearch && (
              <div className="flex gap-2">
                <div className="relative flex-1 min-w-0">
                  <button
                    ref={deviceDropdownRef}
                    onClick={() => {
                      if (!showDeviceDropdown) {
                        setDeviceDropdownPos(calcDropdownPosition(deviceDropdownRef));
                      }
                      setShowDeviceDropdown(!showDeviceDropdown);
                    }}
                    disabled={isConnecting || isRunning}
                    className={clsx(
                      'w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border transition-colors text-sm',
                      'bg-bg-tertiary border-border',
                      isConnecting || isRunning
                        ? 'opacity-60 cursor-not-allowed'
                        : 'hover:border-accent cursor-pointer',
                    )}
                  >
                    <span
                      className={clsx(
                        'truncate',
                        isConnected || canConnect() ? 'text-text-primary' : 'text-text-muted',
                      )}
                    >
                      {getSelectedDeviceText()}
                    </span>
                    <ChevronDown
                      className={clsx(
                        'w-4 h-4 text-text-muted transition-transform flex-shrink-0',
                        showDeviceDropdown && 'rotate-180',
                      )}
                    />
                  </button>

                  {/* 下拉菜单 - 使用 fixed 定位避免被父容器裁剪 */}
                  {showDeviceDropdown && deviceDropdownPos && (
                    <div
                      ref={deviceMenuRef}
                      className="mxu-overlay-surface fixed z-[100] bg-bg-secondary border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto"
                      style={{
                        top: deviceDropdownPos.top,
                        left: deviceDropdownPos.left,
                        width: deviceDropdownPos.width,
                      }}
                    >
                      {deviceList.length > 0 ? (
                        deviceList.map((item) => (
                          <button
                            key={item.id}
                            onClick={item.onClick}
                            className={clsx(
                              'w-full flex items-center justify-between px-2.5 py-1.5 text-left transition-colors',
                              'hover:bg-bg-hover',
                              item.selected && !item.isHistorical && 'bg-accent/10',
                              item.isHistorical && 'bg-amber-500/10',
                            )}
                          >
                            <div className="min-w-0 flex-1 flex items-center gap-2">
                              {item.isHistorical && (
                                <History className="w-3.5 h-3.5 text-warning flex-shrink-0" />
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="text-sm text-text-primary truncate">
                                  {item.name}
                                </div>
                                <div
                                  className={clsx(
                                    'text-xs truncate',
                                    item.isHistorical ? 'text-warning' : 'text-text-muted',
                                  )}
                                >
                                  {item.description}
                                </div>
                              </div>
                            </div>
                            {item.selected && !item.isHistorical && (
                              <Check className="w-4 h-4 text-accent flex-shrink-0 ml-2" />
                            )}
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-3 text-center text-text-muted text-xs">
                          {isSearching
                            ? t('common.loading')
                            : isConnected
                              ? t('controller.connected')
                              : isDesktopWindowController
                                ? t('controller.noWindows')
                                : t('controller.noDevices')}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 刷新按钮 - 与加载资源按钮保持一致的尺寸 */}
                <button
                  onClick={handleSearch}
                  disabled={isSearching || isConnecting || isRunning}
                  className={clsx(
                    'flex items-center justify-center px-3 py-1.5 rounded-md border transition-colors',
                    'bg-bg-tertiary border-border',
                    isSearching || isConnecting || isRunning
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
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-text-secondary" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5 text-text-secondary" />
                  )}
                </button>
              </div>
            )}

            {/* 设备错误提示 */}
            {deviceError && (
              <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-error/10 text-error text-xs">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{deviceError}</span>
              </div>
            )}

            {/* 分隔线 */}
            <div className="border-t border-border" />

            {/* 资源选择 - 选中即自动加载 */}
            <div className="relative">
              {/* 资源下拉框 */}
              {(() => {
                const selectedResourceCompatibility = currentResource
                  ? getResourceCompatibility(currentResource)
                  : { isIncompatible: false, reason: '' };
                const isSelectedIncompatible = selectedResourceCompatibility.isIncompatible;

                return (
                  <button
                    ref={resourceDropdownRef}
                    onClick={() => {
                      if (isLoadingResource || activeInstance?.isRunning) return;
                      if (!showResourceDropdown) {
                        setResourceDropdownPos(calcDropdownPositionUp(resourceDropdownRef));
                      }
                      setShowResourceDropdown(!showResourceDropdown);
                    }}
                    disabled={isLoadingResource || activeInstance?.isRunning || false}
                    className={clsx(
                      'w-full flex items-center justify-between px-2.5 py-1.5 rounded-md border transition-colors text-sm',
                      'bg-bg-tertiary',
                      isSelectedIncompatible ? 'border-warning/50' : 'border-border',
                      isLoadingResource || activeInstance?.isRunning
                        ? 'opacity-60 cursor-not-allowed'
                        : 'hover:border-accent cursor-pointer',
                    )}
                    title={
                      isSelectedIncompatible ? selectedResourceCompatibility.reason : undefined
                    }
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {isSelectedIncompatible && (
                        <AlertCircle className="w-3.5 h-3.5 text-warning flex-shrink-0" />
                      )}
                      <span
                        className={clsx(
                          'truncate',
                          currentResource
                            ? isSelectedIncompatible
                              ? 'text-text-muted'
                              : 'text-text-primary'
                            : 'text-text-muted',
                        )}
                      >
                        {currentResource
                          ? getResourceDisplayName(currentResource)
                          : t('resource.selectResource')}
                      </span>
                      {isLoadingResource && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-accent flex-shrink-0" />
                      )}
                      {!isLoadingResource && isResourceLoaded && !isSelectedIncompatible && (
                        <CheckCircle className="w-3.5 h-3.5 text-success flex-shrink-0" />
                      )}
                    </div>
                    <ChevronDown
                      className={clsx(
                        'w-4 h-4 text-text-muted transition-transform flex-shrink-0',
                        showResourceDropdown && 'rotate-180',
                      )}
                    />
                  </button>
                );
              })()}

              {/* 资源下拉菜单 - 使用 fixed 定位向上展开 */}
              {showResourceDropdown && resourceDropdownPos && (
                <div
                  ref={resourceMenuRef}
                  className="mxu-overlay-surface fixed z-[100] bg-bg-secondary border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto"
                  style={{
                    bottom: window.innerHeight - resourceDropdownPos.top + 4,
                    left: resourceDropdownPos.left,
                    width: resourceDropdownPos.width,
                  }}
                >
                  {allResources.map((resource) => {
                    const { isIncompatible, reason } = getResourceCompatibility(resource);
                    const isSelected = currentResourceName === resource.name;

                    return (
                      <button
                        key={resource.name}
                        onClick={() => !isIncompatible && handleResourceSelect(resource)}
                        disabled={isIncompatible}
                        className={clsx(
                          'w-full flex items-center justify-between px-2.5 py-1.5 text-left transition-colors',
                          isIncompatible
                            ? 'opacity-60 cursor-not-allowed'
                            : 'hover:bg-bg-hover cursor-pointer',
                          isSelected && !isIncompatible && 'bg-accent/10',
                        )}
                        title={isIncompatible ? reason : undefined}
                      >
                        <div className="min-w-0 flex-1">
                          <div
                            className={clsx(
                              'text-sm truncate flex items-center gap-1.5',
                              isIncompatible ? 'text-text-muted' : 'text-text-primary',
                            )}
                          >
                            {isIncompatible && (
                              <AlertCircle className="w-3.5 h-3.5 text-warning flex-shrink-0" />
                            )}
                            <span className="truncate">{getResourceDisplayName(resource)}</span>
                          </div>
                          {/* 描述或不兼容提示 */}
                          {isIncompatible ? (
                            <div className="text-xs text-warning truncate">{reason}</div>
                          ) : (
                            resource.description && (
                              <div className="text-xs text-text-muted truncate">
                                {resolveI18nText(resource.description, translations)}
                              </div>
                            )
                          )}
                        </div>
                        {isSelected && !isIncompatible && (
                          <Check className="w-4 h-4 text-accent flex-shrink-0 ml-2" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 资源错误提示 */}
            {resourceError && (
              <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-error/10 text-error text-xs">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{resourceError}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
