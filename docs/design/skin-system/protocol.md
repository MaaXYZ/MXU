# MXU Skin Protocol 0.1 草案

> 状态：设计讨论稿。本文描述拟议协议，不代表 MXU 已实现相关能力；字段命名、精确 schema 和兼容性承诺尚未冻结。配套 [demo](demo/index.html) 用于展示视觉与交互方向，不是生产级皮肤运行时。

## 1. 技术选择与职责

MXU 已使用 React 19、TypeScript、Vite、Tailwind、Zustand，以及 Tauri 2 / Axum。建议继续使用浏览器的渲染能力：Grid/Flex 处理布局，CSS 变量处理主题，SVG、CSS animation 和 Web Animations API 处理角色与特效。第一版不需要自研绘图引擎、物理碰撞系统或另一套通用布局语言。

皮肤描述外观、装饰位置和视觉响应；宿主维护真实控件的语义、可用状态与业务行为。启动、停止、设备选择等继续使用 MXU 的真实 React 控件，保留键盘操作、无障碍语义与既有业务判断。皮肤依赖公开契约，不依赖内部组件的 CSS 类名或 DOM 结构。

```text
作者提供                       MXU 宿主                     Web 渲染能力
skin.json                    包校验、稳定锚点              真实业务控件
HTML / CSS / SVG / assets  →  布局占位、图层合成         →  隔离装饰层
                             受控状态与事件                Grid / Flex / CSS / SVG
```

这里的 HTML/CSS 自定义主要指装饰场景和公开的样式变量。任意 HTML 接管应用、修改私有业务 DOM，不属于第一版皮肤能力；更高权限的应用插件应有独立契约。

## 2. 能力分级

| 层级        | 作者提供                                | 表达能力                                       | v0.1 建议              |
| ----------- | --------------------------------------- | ---------------------------------------------- | ---------------------- |
| L0 · Tokens | JSON 色值、圆角等已注册变量             | 明暗模式、强调色、背景，以及逐步开放的控件外观 | 首先落地，兼容已有主题 |
| L1 · Scene  | 受限 HTML/CSS/SVG、本地资源、声明式绑定 | 角色动画、装饰越框、布局占位、任务状态联动     | 第一版目标             |
| L2 · Script | 隔离脚本与明确的能力请求                | 程序化角色、复杂状态机、粒子、可选 WebGL 场景  | 仅预留，不在 v0.1 加载 |

作者按需选择复杂度。L1 的 CSS 关键帧、状态属性与宿主事件应能覆盖六个 demo 的主要表现；一个眨眼动作不需要脚本。内置皮肤和用户导入皮肤使用同一份协议，来源不会自动扩大权限。

L0 的变量也需要逐项注册：现有 CSS 变量可以直接复用；当前没有的圆角、间距、字体等能力，需要宿主先定义类型、范围和兼容策略。

## 3. 皮肤包与 Manifest

拟议的 `.mxuskin` 是 ZIP 容器，根目录必须有 `skin.json`。文件扩展名只用于识别容器；清单决定格式版本。最小皮肤可以只有清单，复杂皮肤再附带场景和资源。

```text
little-trouble.mxuskin
├── skin.json
├── scene.html
├── scene.css
├── preview.webp
└── assets/
    └── mascot.svg
```

以下清单也保存为 [mascot.skin.json](demo/examples/mascot.skin.json)。它是协议示例，不是可安装成品；其中的语义锚点、槽位、场景状态及配套资源仍需宿主和皮肤作者实现。

```json
{
  "schemaVersion": "0.1",
  "id": "studio.example.little-trouble",
  "name": {
    "zh-CN": "捣蛋小怪兽",
    "en-US": "Little Trouble"
  },
  "version": "1.0.0",
  "mxu": {
    "skinApi": "0.1"
  },
  "capabilities": {
    "required": ["tokens.v1"],
    "optional": ["scene.l1", "reservation.edge.v1", "bleed.stage.v1"]
  },
  "fallback": {
    "mode": "tokens-only"
  },
  "tokens": {
    "light": { "--color-accent": "#7357d8" },
    "dark": { "--color-accent": "#b6a4ff" }
  },
  "scene": {
    "entry": "scene.html",
    "initialState": "idle"
  },
  "placements": [
    {
      "element": "mascot",
      "anchor": "toolbar.primary",
      "align": "outside-start-center",
      "offset": { "x": -12, "y": 0 },
      "layer": "ornament-front",
      "bleed": { "top": 48, "right": 16, "bottom": 12, "left": 24 },
      "hitTest": "host-hotspot"
    }
  ],
  "reservations": [
    {
      "id": "mascot-space",
      "slot": "toolbar.actions",
      "edge": "inline-start",
      "size": 112,
      "maxFraction": 0.28,
      "when": { "scene.state": "mischief" }
    }
  ],
  "bindings": [
    {
      "event": "scene.hotspot.activate",
      "target": "mascot",
      "setSceneState": "mischief"
    },
    {
      "event": "scene.state.timeout",
      "state": "mischief",
      "afterMs": 2400,
      "setSceneState": "idle"
    },
    {
      "event": "task.runState.changed",
      "equals": "running",
      "setSceneState": "cheer"
    }
  ]
}
```

| 字段                                 | 拟议语义                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `schemaVersion` / `mxu.skinApi`      | 清单格式版本与宿主皮肤接口版本；与皮肤自身的 SemVer `version` 分离。0.x 不假设跨 minor 兼容。   |
| `id` / `name`                        | 稳定的反向域名式标识与本地化名称。同 ID 更新须显式选择，不能静默覆盖另一来源。                  |
| `capabilities.required`              | 缺少任一必需能力则拒绝启用。                                                                    |
| `capabilities.optional` / `fallback` | 缺少可选能力则移除对应表现并按清单降级；本例可保留 tokens。各能力的依赖关系须由宿主注册表定义。 |
| `tokens`                             | 仅接受宿主注册的变量及对应类型；色值不能替换为任意 CSS。用户的明暗模式偏好继续有效。            |
| `scene`                              | 场景入口与初始状态，入口只能引用包内资源。                                                      |
| `placements`                         | 场景元素绑定到语义锚点，声明对齐、偏移、图层、最大越框量与命中方式。长度单位为 CSS px。         |
| `reservations`                       | 向宿主边缘槽位申请布局空间。`size` 是请求值，`maxFraction` 是作者上限；宿主还要施加自身上限。   |
| `when`                               | 只对公开字段做相等匹配，不执行 JavaScript 表达式；本例用在占位请求上。                          |
| `bindings`                           | 将白名单事件映射到有限场景状态；定时器由宿主管理。                                              |

事件按宿主接收顺序处理；离开一个状态时取消该状态的定时器。引用的元素和状态必须存在，未定义引用应作为包错误报告。状态列表的正式声明方式、绑定冲突处理、hotspot 的尺寸与无障碍名称字段仍需在 schema 冻结前补齐。

下面仅展示样式表达方式，省略样式引用和部分状态，不能直接当作完整场景文件：

```html
<!-- scene.html：表现元素，不声明业务按钮 -->
<div id="mascot" class="mascot" aria-hidden="true">
  <div class="mascot-motion">
    <img src="assets/mascot.svg" alt="" />
  </div>
</div>
```

```css
/* data-scene-state 由受信任 runtime 更新 */
.mascot-motion {
  animation: breathe 2.8s ease-in-out infinite;
}
[data-scene-state='mischief'] .mascot {
  transform: rotate(-8deg);
}
@keyframes breathe {
  50% {
    transform: translateY(-6px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mascot-motion {
    animation: none;
  }
}
```

示例把呼吸位移与状态姿态分到不同包裹层，避免两个效果覆盖同一个 `transform`。

## 4. 真实占位与装饰越框

### 4.1 Reservation：角色占空间，按钮真的移动

角色进入捣蛋状态时，宿主在 `toolbar.actions` 的逻辑起始边插入占位轨道，让 Grid/Flex 中的真实按钮重新排布；退出后释放空间。控件的 DOM 身份、焦点与业务事件处理器保持不变。

只给角色或按钮添加 `transform` 不会改变兄弟元素布局，因此不能替代真实占位。

v0.1 建议只支持边缘槽位和面板 inset，不支持任意多边形障碍、二维碰撞或物理推挤。可用宽度不足时先缩小占位；仍不足时返回零占位，让角色移到备用锚点或隐藏。多个请求按稳定优先级分配，合计不得侵占宿主控件最小宽度。

宿主返回实际分配的 `acceptedSize` 与原因，场景按实际结果摆位，不能按“申请 112 px”绘制而按钮只让出 40 px。用户正按住按钮、拖拽或进行键盘操作时，应延后布局变化，避免控件从手下移走。

### 4.2 Bleed：越过面板边框，仍在应用视口内

机甲挂在根级 `SkinStage`，跟随被锚定面板的位置绘制，绕过该卡片及其滚动容器的裁切。`bleed` 声明最大越框范围；最终允许区域取皮肤请求、宿主安全区和视口边界的交集。装饰越框不参与布局，也不会自动推开其他面板。

`overflow: visible` 无法穿过 iframe、WebView 或原生窗口边界。隔离装饰 renderer 应覆盖宿主允许的 stage，不能把大角色塞进一张小卡片 iframe 后期待它自行越框。

本提案中的“破框”指应用内面板。伸到操作系统桌面需要额外透明窗口与系统级命中处理，不属于 v0.1。

### 4.3 图层、保护区与命中

建议固定合成顺序：

```text
background → content → ornament-front → host-popover → host-modal → emergency-controls
```

皮肤只能选择开放的层，不能提交任意全局 `z-index`。前景装饰默认 `pointer-events: none`；开始、停止、错误处理、恢复默认皮肤等保护区，以及键盘焦点环，不能被装饰遮挡。

“戳一下角色”由宿主生成受限 hotspot，包含本地化名称和键盘行为。宿主验证它不覆盖关键控件后再发送场景事件。全屏透明 iframe 不应接管整个窗口的鼠标。

## 5. 状态、事件与动作边界

皮肤仅接收经过裁剪的公开视图模型，例如任务运行状态、归一化进度、明暗模式、动效偏好和注册锚点矩形。它不读取整个 Zustand store、任务密码、原始日志、文件路径或设备凭据，也不能反向修改业务状态。

建议公开状态区分 `idle`、`running`、`paused`、`success`、`error`、`cancelled`；这是皮肤视图模型提案，不是要求直接暴露 MaaFramework 内部枚举。停止、失败与成功必须分开，不能都触发成功动画。进度未知的任务应有明确的“不确定进度”表达，不能由皮肤伪造百分比。

L1 使用白名单点击、超时和任务事件更新有限场景状态或宿主允许的 CSS 变量：成功时欢呼、错误时亮灯、运行时反应堆发光，均无需作者脚本。

第一版业务操作仍由真实宿主控件触发。未来若提供 `requestAction("task.start")` 等语义动作，必须验证消息实例、动作白名单、最新业务状态与真实用户手势，并继续经过既有启动流程。不得开放通用 `invoke(command, args)`、任意 HTTP、文件读写或全局状态 setter。场景点击事件不等于执行自动化的权限。

最小桥接可围绕三类信息设计：

- 宿主向场景发送 `state / anchors / preferences`。
- 受信任 runtime 按声明提交 `reservation`，作者无需编写 SDK 调用。
- 宿主返回 `reservationResult` 并投递经过验证的点击事件。

消息携带皮肤实例 generation，切换皮肤后丢弃旧消息。最终消息 schema、事件顺序和超时规则需要单独固定，不依赖 demo 中的日志字符串。

## 6. 宿主的五项职责

| 模块                | 职责                                                                                |
| ------------------- | ----------------------------------------------------------------------------------- |
| `SkinLoader`        | 解包、schema 校验、版本协商、资源索引与可回滚启用。安装完成不等于立即替换当前皮肤。 |
| `AnchorRegistry`    | 发布稳定语义锚点及矩形，用 ResizeObserver、滚动监听与合并后的帧更新同步位置。       |
| `LayoutCoordinator` | 分配边缘占位、保护控件最小尺寸、返回实际分配结果，响应缩放、语言和布局变化。        |
| `SkinStage`         | 管理装饰图层、越框裁切、保护区、hotspot、动效生命周期与受信任恢复入口。             |
| `SkinBridge`        | 从 Zustand 派生只读状态，验证消息、调度声明式事件并清理卸载资源。                   |

卸载皮肤时必须清除定时器、观察器、资源 URL、占位与事件订阅。启用后崩溃应能在下一次启动主界面之前禁用最后启用的皮肤，恢复到内置主题。正常换肤不能中断真实任务。

## 7. 导入与权限隔离

建议 L1 使用覆盖允许区域的隔离装饰 renderer，加载受限 HTML/CSS/SVG，由受信任 bootstrap 接收状态消息；用户片段本身不能执行脚本。真实 React 控件留在宿主文档。Shadow DOM 可以隔离样式，不是安全沙箱。

iframe 是候选实现之一：使用不含 `allow-same-origin` 的 sandbox，仅在受信任 bootstrap 必须运行时给予 `allow-scripts`，并通过严格 CSP nonce/hash 限定可执行脚本。不能同时向不可信同源内容开放这两项能力。禁止弹窗、导航、表单和下载，使用绑定实例的 MessageChannel 并验证消息结构与额度；`origin === "null"` 不能充当身份凭证。Tauri 各平台 WebView 是否真的隔离原生桥接，必须实测确认后才能开放导入。

| 边界         | 建议约束                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| ZIP 解包     | 拒绝绝对路径、`..`、符号链接、重复/大小写冲突路径与超限条目；按实际解压字节计数，防止 ZIP bomb。                                       |
| 体积         | 初始建议：压缩包 20 MiB、解压 60 MiB、256 文件、单文件 16 MiB；这些是待验证的初始预算。                                                |
| 资源         | 只允许只读包内索引；禁止网络资源、任意 `file:` 和系统路径；校验实际 MIME 与图像解码后尺寸。                                            |
| SVG          | 消毒脚本、事件属性、外链与 `foreignObject`。                                                                                           |
| HTML/CSS     | 使用成熟解析器和 allowlist，不能用正则过滤；禁止脚本、iframe、object、embed、表单及事件属性；检查 CSS URL、`@import`、字体与嵌套规则。 |
| CSP          | 独立限制 `img-src`、`font-src`、`connect-src`、`form-action` 等，不能沿用宽松的主窗口策略。                                            |
| 原生与 WebUI | 皮肤不得访问 Tauri 全局对象、invoke、WebUI API 或宿主原生权限。                                                                        |

当前主窗口配置中存在 `withGlobalTauri: true`、`csp: null`，因此直接向主文档注入第三方 HTML/JS 不能作为实现方案。具体隔离方案应结合目标平台能力评审，而不是仅凭 iframe 标签或 CSP 字符串推定安全。

包导入先在暂存区校验，再预览、原子启用；失败时恢复上一个可用皮肤。更新不能自动扩权。内置包走相同校验通路。L2 如需开放，应另行设计无原生权限、默认无网络且可终止的执行域，不能作为 L1 的隐藏开关。

## 8. 兼容、降级与动效预算

宿主先检查 schema 与必需能力，再检查锚点。当前视图暂时没有某个锚点时，隐藏对应装饰并释放占位。缺少可选场景能力可以降为 L0；未知必需能力必须拒绝。新增字段需在 schema 中明确标为可选，不能静默容忍字段拼写错误。

基础方案优先使用 Grid/Flex、CSS 变量、SVG 与经典关键帧。CSS anchor positioning、复杂滤镜、WebGL、Lottie/Rive 等可在有实际需求时作为独立能力与适配器添加，不把协议绑定到某个动画库。

- **可操作性**：保留文字、键盘焦点、足够对比度与直接操作入口。纯装饰对读屏隐藏；hotspot 具有名称和键盘行为。
- **减少动效**：尊重系统 `prefers-reduced-motion` 与 MXU 手动设置。关闭循环弹跳、强闪光、大幅视差；静态模式仍表达任务状态。
- **布局预算**：只在状态变化时调整占位，避免每帧重排模拟物理。指针交互期间延后移动关键控件。
- **动画预算**：初始建议最多 4 个持续动画角色；状态与锚点更新合并到每帧一次。离屏、隐藏窗口与后台暂停表演。
- **退化路径**：持续超预算时关闭昂贵滤镜/粒子、改静态图，最终卸载场景保留 tokens。JS watchdog 不能中断任意 CSS 渲染卡顿，导入前还需限制节点与昂贵效果。

这些数值是实现起点，不是测得的性能承诺。验证需覆盖中英文长标签、125%/150% 缩放、窄窗口、面板折叠、移动端 WebUI、减少动效与运行中换肤。

## 9. 在现有 MXU 中渐进接入

| 现有代码                                                                                                                             | 建议沿用与新增                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [`src/themes/types.ts`](../../../src/themes/types.ts)、[`src/themes/index.ts`](../../../src/themes/index.ts)                         | 沿用 ModeTheme、AccentTheme、applyTheme 和 CSS 变量作为 L0；新增 SkinManifest 与变量类型注册，不替换现有主题体系。 |
| [`AppearanceSection.tsx`](../../../src/components/settings/AppearanceSection.tsx)                                                    | 增加皮肤选择、导入、预览与恢复默认，明确用户覆盖项与皮肤默认值的优先级。                                           |
| [`src/App.tsx`](../../../src/App.tsx)                                                                                                | 在可控根容器添加 SkinStage，避免装饰受现有分栏的 overflow 裁切。                                                   |
| [`Toolbar.tsx`](../../../src/components/Toolbar.tsx)                                                                                 | 注册稳定的 `toolbar.actions` / `toolbar.primary` 契约和占位轨道，保留既有启动/停止业务逻辑。                       |
| [`src/stores/types.ts`](../../../src/stores/types.ts)、[`appStore.ts`](../../../src/stores/appStore.ts)                              | 新增 activeSkinId 与个人配置，派生最小公开状态；沿用桌面和 WebUI 的外观偏好分离。                                  |
| [`tauri.conf.json`](../../../src-tauri/tauri.conf.json)、[`capabilities/default.json`](../../../src-tauri/capabilities/default.json) | 评审皮肤渲染域的 CSP 与原生权限隔离；导入服务只操作指定皮肤目录。                                                  |

建议实施顺序：

1. L0 清单、正式 schema 与旧主题适配。
2. 少量稳定锚点、边缘占位和根级装饰层，用内置皮肤验证视觉行为。
3. 隔离 renderer、资源校验、导入预览与回滚。
4. 完成跨平台、无障碍、性能与恶意包验证后开放用户导入。
5. 有明确需求时再定义 L2。

变量优先级可采用“宿主默认值 → 皮肤对应明暗模式默认值 → 用户明确覆盖项”；高对比度与减少动效属于宿主强制策略。现有用户应无需迁移就能保留显示结果。未来所有新增宿主界面文案进入现有 i18n 资源。

## 10. Demo 能证明什么

六个内置场景分别展示角色占位、机甲越框、生态舱生长、黑胶旋转、完成印章与声呐扫描；另提供任务模拟、布局轮廓、减少动效、有限预设导入导出和 24 条扩展创意。它们用于讨论表现力、协议范围与操作手感。

需要明确区分：

- demo 是可信内置场景与本地模拟任务，未连接 MaaFramework，没有执行真实设备操作。
- `mxu-skin-demo/0.1` 仅包含名称、六种内置场景选择、受限十六进制色值、数值参数和效果开关；它不执行导入 HTML/CSS/JS，不是 `.mxuskin` 安装器。
- demo 的 Flex 占位证明真实重排，但完整分配结果回传、交互期间延后移动、保护区裁切和隔离导入尚需宿主实现。
- demo 切换场景会重置模拟任务；生产换肤必须保持业务任务继续执行。
- 概念切片与 Manifest 示例不是完整规范对象或可安装成品。
- 静态设计图不是 MXU 实机截图。已完成的 DOM/事件检查不等于浏览器视觉、CSS 几何、跨平台或生产隔离验证。

## 11. 待讨论与冻结事项

正式实现前仍需共同决定：

1. L1 是否只承担装饰和主题，还是需要受控的业务卡片模板？完整布局替换是否另设能力？
2. 锚点、槽位、公开状态和能力注册表的最小集合，以及缺失能力的依赖降级顺序。
3. Manifest 的正式 JSON Schema、有限状态声明、事件竞争顺序、hotspot 名称/尺寸与错误诊断格式。
4. 各平台隔离 renderer 的具体实现和原生权限验证方法。
5. 多占位请求冲突、长标签与窄窗口下的布局分配规则。
6. 作者预览、调试工具、静态打包与资源预算如何做得足够简单。
7. 第一批内置皮肤优先验证哪些玩法，哪些效果值得先做成官方可复用组件。

欢迎在设计 PR 中补充想法、替代方案、示意图或具体皮肤需求；本稿的目标是把讨论变得具体，不是提前冻结实现。
