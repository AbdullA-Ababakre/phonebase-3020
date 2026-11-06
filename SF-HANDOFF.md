# 旧金山 Phonebase 站点交接

## 目标与已知现场

用户有 11 台供测试的机器，朋友目前在旧金山的 macOS 电脑上连接了其中 1 台，并安装了 Codex。用户通过远程桌面访问这台电脑。请先把这 1 台接成可用站点，再逐级扩展，最终让受邀用户从官网进入网页控制台，或用自己的 REST/MCP 程序控制分配给自己的设备。

本包来自开发电脑 `/Users/jfg/phonebase` 的 2026-10-15 工作区快照，基础提交 `aaa9296`，版本号 `0.7.0`。它包含尚未提交的源码更新，不能用原仓库 main 分支替代。本包不含 Git 历史、node_modules、实际环境配置、运行时客户授权、现场校准目录或原站点密钥。它不是已经完成旧金山实机验收的安装发行版。

## 系统结构

| 服务 | 地址/端口 | 用途 |
| --- | --- | --- |
| 本地 Dashboard | 127.0.0.1:3020 | 操作员设备、设置、校准、客户分配 |
| Control plane | 127.0.0.1:3013 | 设备状态、动作校验、截图、执行回执 |
| Remote gateway | 127.0.0.1:3015 | 鉴权、客户设备范围隔离、远程视频/API |
| Supervisor | 127.0.0.1:3016 | 运行管理，首次接入前必须检查其配置 |
| Phone recognition | 127.0.0.1:3031 | 手机屏幕识别和设置 |
| 官网/客户 Console | README 中的 phonebase.co/console | 接收客户邀请码，连接站点 HTTPS 网关 |

官网地址是源码中的产品地址，本次未核验它的线上状态或管理权限。3020 是本地操作员后台；客户从官网 Console 连接认证网关。官网和站点电脑是两个独立部署。

## Codex 首次任务

1. 阅读 `AGENTS.md`、`README.md`、`docs/enterprise/DELIVERY.md`、`bridge/fleet_supervisor.ts`、`scripts/supervisor.py`、`scripts/setup-macos.sh` 和相关启动脚本。先检查依赖、端口、已运行进程和磁盘里的已有配置，不要停掉未知的现场服务。
2. 列出 macOS/CPU、Node/npm、Python、FFmpeg、Swift/Command Line Tools、串口和摄像头身份。当前源码要求 Node >=22.13；摄像头使用 Swift/AVFoundation。核实真实 USB 控制器型号/协议是否匹配 black-arm/GRBL，不要从“机械臂”名称推断兼容。
3. 审核安装脚本后安装依赖、构建 CameraBroker 和应用。可从 `./scripts/setup-macos.sh` 入手；它会修改 CLI/PATH，所以先理解脚本。先运行模拟测试：`npm run test:enterprise`。新电脑仍需完成构建和其他相关检查。
4. 根据真实身份建立该站点的 `config/device-fleet.json`。第一台可用新 ID，例如 `sf-black-arm-01`。示例 JSON 的 serialPrefix/cameraIdentity 是占位符，必须替换。设置 `profileId: "unconfigured"`，配置新设备的校准目录；启动前检查未校准/未回零的动作能力确实锁定。
5. 选择审查过的 fleet 本地启动方式。`npm run local` 会先构建，再运行 fleet、vision 和 Dashboard；运行前确认它在这个版本及本地环境中不自动移动。初次不要运行 `npm run black`、`start-black.sh`、`stable:install` 或直接套用 `.env.supervisor.example`。检查只读状态 `GET /health`、`GET /api/v1/devices` 和截图，不发运动指令。
6. 请现场人员确认空间清空后再按已说明的动作执行 Home。新机器逐台校准并验证摄像头、屏幕四角和安全触控范围，不复用源码内 legacy 校准文件或开发电脑的恢复坐标。接着在人员观察下验证一条点按及最终 completed 回执。
7. 新建本机私有密钥和站点固定 HTTPS 网关，隧道只转发 3015。先厘清谁管理 DNS/隧道，避免覆盖原站点。配置正确的官网 Origin；浏览器的摄像头权限和站点 Mac 的权限分别核验。真实密钥不写进 Git、聊天或前端公开环境变量。
8. 从本地 Dashboard 创建只分配该设备的客户授权。使用客户授权验证网站 Console、截图、REST 和 MCP；验证第二份授权不能访问第一份授权设备，并验证撤销后 REST/视频被拒绝。管理员 `cloud-link` 不给客户。
9. 单台通过后连接 2、5、11 台，逐台固定 USB/摄像头身份和独立校准。为各设备分配独立 driverPort 和 cameraStreamPort，避免 3013/3015/3016/3020/3031。参考例子 driverPort=3014/3024/3034、cameraStreamPort=3111/3112/3113；不要依赖会重排的摄像头索引。记录每个阶段的帧率/帧龄、掉线恢复、功耗和 USB 带宽情况。

## 完成标准

- 第一台真实设备出现在本地 Dashboard，有正确实时画面和明确状态。
- 现场确认后完成该机器的 Home、校准和一条受控点按，执行有最终回执。
- 受邀用户可从自己网络上的网页及 API 控制获配设备。
- 设备隔离和授权撤销有实际验证证据。
- 重启、摄像头/USB 重连和网关恢复有记录，失败时控制锁定。
- 11 台的结果按实际在线数量和容量报告；未测的能力不宣称完成。

## 现有能力边界

已有同站点多设备授权、网页、REST、MCP 和回执。11 台同时使用未验证；集中多站点后台、企业成员/角色以及完整独占执行调度不能当作已有能力。客户端需要按设备串行化动作，详见企业交付说明。

暂缺的信息由现场检查或向用户取得：具体机器型号与连接方式、摄像头数量、现场操作者、官网管理权限、新站点域名与隧道权限。先完成不依赖这些信息的代码和只读检查。
