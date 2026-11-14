# 内置角色素材

## 白饭鲸鱼娘

直接使用 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 在提交 `33938a355f422525886c3facd883d7179c58ebf4` 已公开的社区视频。本次不生成或重绘鲸鱼娘；透明 PNG 仅从同源视频抽帧。

| 本地文件 | 固定来源 | 处理 |
| --- | --- | --- |
| `deepseek-eat.mp4` | [吃白饭.webm](https://github.com/PC2005-cloud/dsh-pet/blob/33938a355f422525886c3facd883d7179c58ebf4/dsh-pet/assets/webm/%E5%90%83%E7%99%BD%E9%A5%AD.webm) | VP9 alpha 解码、白底合成、移除音轨并转为 H.264，保留约 10.04 秒原动作 |
| `deepseek.png` | 同上 | 取 4 秒静态帧，保留透明 |
| `deepseek-calm.png` | [待机呼吸休闲.webm](https://github.com/PC2005-cloud/dsh-pet/blob/33938a355f422525886c3facd883d7179c58ebf4/dsh-pet/assets/webm/%E5%BE%85%E6%9C%BA%E5%91%BC%E5%90%B8%E4%BC%91%E9%97%B2.webm) | 取 1 秒静态帧，保留透明 |
| `deepseek-error.png` | [工作状态-垂头叹气冒汗.webm](https://github.com/PC2005-cloud/dsh-pet/blob/33938a355f422525886c3facd883d7179c58ebf4/dsh-pet/assets/webm/%E5%B7%A5%E4%BD%9C%E7%8A%B6%E6%80%81-%E5%9E%82%E5%A4%B4%E5%8F%B9%E6%B0%94%E5%86%92%E6%B1%97.webm) | 取 4 秒静态帧，保留透明 |

动画素材：**PC2005-cloud**；原型「溟月」：**上善无形**；DeepSeek 女仆鲸鱼娘设计：**ZipZipPipe**。按来源 [README 许可说明](https://github.com/PC2005-cloud/dsh-pet/blob/33938a355f422525886c3facd883d7179c58ebf4/README.md#许可) 使用 CC BY-NC-SA 4.0，保留署名、非商业、相同方式共享条件。来源仓库的代码 MIT 许可不替代素材许可。随附来源与许可摘要见 [LICENSE.deepseek.txt](LICENSE.deepseek.txt)。

原视频为 VP9 alpha。为避免透明 WebM 不受支持时出现黑底，随包动态素材转为白底 H.264；播放失败、格式不支持或减少动效时使用同源静态帧。不承诺所有原生 WebView 都已通过验证。

## 奶蛙

- `naiwa-calm.png`：从同一 Naiwa Hub 未裁剪原视频第 1 秒导出的闭口静态 PNG，未重绘角色。
- `naiwa-still.webp`：[Naiwa Hub 奶蛙大笑条目](https://naiwahub.com/zh/memes/ghn-naiwa-wallpaper-1c05a2a8af20)提供的海报。
- `naiwa-laugh.mp4`：同一条目的本地视频，移除音轨并剪去开头 2.6 秒，保留 12.8 秒大笑动作。

社区原片和海报的收录页注明创作者及素材权利尚未核实；公开访问不代表开源授权，不将这些媒体归入代码许可。完整来源记录见 [皮肤说明](../../../docs/design/skin-system/meme-skins.md)。

最终两套不包含本次生成或重绘的角色图，不添加对白或额外剧情。运行时只使用随包本地资源，界面文字仅表达任务事实与操作提示。
