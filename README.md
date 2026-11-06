# 纽约飞车 · Playroom 联机版

[在线游玩](https://haidongnie.github.io/nyc-spider-playroom/)

点击「联机」创建房间，把邀请链接或四位房间码发给朋友。每个房间最多 10 人。无需 GitHub 或 Playroom 账号即可加入。直接进入游戏也可以独自游玩。

游戏同步玩家位置、朝向、姿态、便装与战衣的切换、蛛丝锚点以及所在载具。房主同步城市时段、交通信号和街道、高速路、行人、空中交通的状态。每个人可以独立切换镜头和画风。

## 操作

- 默认以便装步行。点击左上角头像，战衣会从脚向头部展开，再次点击可反向切回。
- W/S 移动，A/D 转向，空格跳跃。穿战衣时按住 Shift 或 E 向附近建筑挂丝摆荡，松开后继续向前。触屏使用 Web 按钮。
- 1 步行，2 出租车，3 自行车，4 直升机，F 驾驶 Spinner。飞行时 E 上升、Q 下降。
- J 切换写实与动漫画风，M 打开纽约地图，V 切换镜头。

## 本地运行

安装了 Node.js 时，在仓库根目录执行 `npm start`，然后打开 http://127.0.0.1:4180 。也可以从 `dist` 目录启动任意静态 HTTP 服务。多人房间需要连接互联网。

## 发布与联机服务

GitHub Pages 使用 `gh-pages` 分支根目录，对应主分支中的 `dist/`。联机传输使用 Playroom Kit 0.0.97，通过房间服务交换状态。可在 `dist/index.html` 的 `playroom-game-id` 元标签中设置自己的公开项目 ID，以便用自己的 Playroom 项目管理服务配额。

## 来源

- [Slop New York](https://github.com/mrdoob/slop-newyork) 提供曼哈顿城市与基础玩法。地理数据来源见 [原作说明](dist/README.md)。
- [Cyber Web City](https://github.com/greggman/cyber-web-city) 提供 Spinner 飞车模型和空中航迹的参考。[模型来源说明](dist/skycar-assets/ORIGIN.md)
- 蜘蛛侠角色与动作来自 Friendly Neighborhood Spider-Man 的导出。蜘蛛侠 © Marvel；便装使用用户提供的 GLB。[角色与动画署名](dist/spider-assets/NOTICE.txt)
- 《日式海边街道》提供动漫画风参考。[版本与来源](UPSTREAM.json)
- [Playroom Kit](https://docs.joinplayroom.com/) 提供多人房间服务。[SDK 版本说明](dist/js/vendor/PLAYROOM-NOTICE.txt)
