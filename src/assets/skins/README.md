# 内置角色素材

## 蓝色大肥鱼（白饭鲸鱼娘）

直接使用 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 在提交 `33938a355f422525886c3facd883d7179c58ebf4` 已公开的社区视频。本次不生成或重绘鲸鱼娘；透明 PNG 仅从同源视频抽帧。

| 本地文件 | 固定来源 | 处理 |
| --- | --- | --- |
| `deepseek-eat.mp4` | [吃白饭.webm](https://github.com/PC2005-cloud/dsh-pet/blob/33938a355f422525886c3facd883d7179c58ebf4/dsh-pet/assets/webm/%E5%90%83%E7%99%BD%E9%A5%AD.webm) | VP9 alpha 解码、白底合成、移除音轨并转为 H.264，保留约 10.04 秒原动作 |
| `deepseek.png` | 同上 | 取 4 秒静态帧，保留透明 |
| `deepseek-calm.png` | [待机呼吸休闲.webm](https://github.com/PC2005-cloud/dsh-pet/blob/33938a355f422525886c3facd883d7179c58ebf4/dsh-pet/assets/webm/%E5%BE%85%E6%9C%BA%E5%91%BC%E5%90%B8%E4%BC%91%E9%97%B2.webm) | 取 1 秒静态帧，保留透明 |
| `deepseek-error.png` | [工作状态-垂头叹气冒汗.webm](https://github.com/PC2005-cloud/dsh-pet/blob/33938a355f422525886c3facd883d7179c58ebf4/dsh-pet/assets/webm/%E5%B7%A5%E4%BD%9C%E7%8A%B6%E6%80%81-%E5%9E%82%E5%A4%B4%E5%8F%B9%E6%B0%94%E5%86%92%E6%B1%97.webm) | 取 4 秒静态帧，保留透明 |

动画素材：**PC2005-cloud**；原型「溟月」：**上善无形**；DeepSeek 女仆鲸鱼娘设计：**ZipZipPipe**。按来源 [README 许可说明](https://github.com/PC2005-cloud/dsh-pet/blob/33938a355f422525886c3facd883d7179c58ebf4/README.md#许可) 使用 CC BY-NC-SA 4.0，保留署名、非商业、相同方式共享条件。来源仓库的代码 MIT 许可不替代素材许可。随附来源与许可摘要见 [LICENSE.deepseek.txt](LICENSE.deepseek.txt)。

工作区的定时按钮旁和设置预览都可以投喂白饭。视频使用白底 H.264，减少动效或播放失败时显示同源静态帧。

## 奶蛙

- `naiwa-calm.png`：从同一 Naiwa Hub 未裁剪原视频第 1 秒导出的闭口静态 PNG，未重绘角色。
- `naiwa-still.webp`：[Naiwa Hub 奶蛙大笑条目](https://naiwahub.com/zh/memes/ghn-naiwa-wallpaper-1c05a2a8af20)提供的海报。
- `naiwa-laugh.mp4`：同一条目的本地视频，移除音轨并剪去开头 2.6 秒，保留 12.8 秒大笑动作。

工作区定时按钮旁的头像和设置预览都可以播放大笑。下列贴纸均从同一角色的现有画面中去除白底和地面投影、裁边并转为透明 WebP。减少动效或播放失败时，头像与预览显示相应静帧。

| 贴纸 | 本地取材 | 姿态 |
| --- | --- | --- |
| `naiwa-idle.webp` | `naiwa-calm.png` | 闭口站立 |
| `naiwa-grin.webp` | `naiwa-laugh.mp4` 的 8.9 秒 | 仰头大笑 |
| `naiwa-clutch.webp` | 同一视频的 5.05 秒 | 捂头笑 |
| `naiwa-roll.webp` | 同一视频的 12.2 秒 | 笑倒在地 |

社区原片和海报的收录页注明创作者及素材权利尚未核实。角色、视频和从中截取的贴纸沿用原素材的权利归属，独立于 MXU 的代码许可。[社区原片](https://github.com/Nailong-Studio/NaiWa-Wallpaper/blob/036afc4f4930c90e78c0a8e26d4a2da6606c95e2/videos/%E5%A5%B6%E8%9B%99-%E5%A4%A7%E7%AC%91.mp4) · [皮肤说明](../../../docs/design/skin-system/meme-skins.md)

## 咕咕嘎嘎

形象源自《明日方舟：终末地》管理员的社区二创“咕咕嘎嘎”小企鹅。底图为 B 站 UP 主“嘎嘎咕嘎小企鹅”在教程视频 [BV1t75x6oEZU](https://www.bilibili.com/video/BV1t75x6oEZU) 中提供的三视图；贡献者以此为参考，用 Claude Opus 编写提示词、ChatGPT 生成一张六姿势表情图，本仓库从中切出各姿势并去除白底。

| 本地文件 | 姿势 | 用途 |
| --- | --- | --- |
| `gugugaga-peek.webp` | 探头眨眼 | 标签栏项目名旁 |
| `gugugaga-idle.webp` | 站立微笑 | 开始按钮旁（待机）、设置缩略图与预览 |
| `gugugaga-cheer.webp` | 举手 | 开始按钮旁（运行中）、预览互动 |
| `gugugaga-laugh.webp` | 捂肚子大笑 | 开始按钮旁（成功） |
| `gugugaga-sad.webp` | 含泪沮丧 | 开始按钮旁（失败） |
| `gugugaga-sit.webp` | 坐着 | 运行日志右下角 |

该形象的著作权归属存在争议：原 AI 二创作者已公开放弃版权主张，北京字跳网络技术有限公司另登记了同名美术作品。此处仅以非商业方式随 MXU 分发，不代表获得任何权利人授权，也不将这些图片归入代码许可。
