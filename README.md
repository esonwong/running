# 无尽走廊 · 体感梦核 (Somatic Corridor)

用真人身体动作驱动的第一人称无限走廊游戏，梦核 / liminal space 美术风格。
浏览器摄像头实时识别 **跳跃 / 下蹲 / 左右侧移 / 出拳**，操控角色在永远跑不完的走廊里躲避障碍。

🎮 **在线体验**：https://running.esonwong.com  （需要摄像头，推荐 Chrome / Edge）

## 玩法

| 真人动作 | 游戏效果 |
|---|---|
| 🦵 原地起跳 | 跳过地面低栏（绿色） |
| 🧎 下蹲 | 钻过头顶吊障（粉色） |
| ↔️ 身体左右侧移 | 躲开侧墙（蓝色） |
| 👊 向前出拳 | 击碎挡板（橙色） |

撞到障碍 −1 生命，3 条生命用完即结束。距离越远速度越快、障碍越密。

## 运行

摄像头需要安全上下文（`localhost` 或 https），不能直接双击 `index.html`。
在本目录起一个本地服务器：

```bash
cd somatic-corridor
python3 -m http.server 8000
```

然后浏览器打开 http://localhost:8000 ，点击「开始」，授权摄像头。
站到能拍到上半身和手臂的位置，保持站立完成 2 秒校准即可开跑。

> 推荐 Chrome / Edge（MediaPipe GPU 委派最稳）。光线充足、背景简洁识别更准。

## 技术栈

- **体感**：[MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe)（浏览器端骨骼追踪，CDN 加载，无需安装）
- **3D**：[Three.js](https://threejs.org/) r160，程序化贴图 + 指数雾 + 自发光灯板营造梦核氛围
- 纯静态前端，无构建步骤

## 调参

动作识别阈值在 `js/pose.js` 顶部的 `TH` 对象里：

- `jump` / `squat`：跳、蹲的重心位移灵敏度
- `leanScale`：左右侧移灵敏度

出拳用"手臂快速伸展"检测（肩-肘-腕 2D），阈值 `punchExtHigh / punchExtLow` 在 `PoseController` 里，开局"向前出拳"校准会按你的伸展范围自适应。

走廊节奏 / 难度在 `js/game.js` 顶部常量（`SEG`、`NUM_SEG`、`speed`、`maybeSpawn` 的 `density`）。

## 已知限制 / 后续可扩展

- 出拳依赖手腕深度（z）速度，背景杂乱时可能误判 —— 可改成左右手分别绑定不同攻击
- 目前是单一直走廊，可加入转弯、分叉、收集物、BGM 与脚步音效
- 可加入多人 / 排行榜、更多梦核场景（泳池 backrooms、办公室等）

## 部署

纯静态站，已部署在 Cloudflare Pages：

```bash
wrangler pages deploy . --project-name running
```

## License

[MIT](LICENSE) © Eson Wong
