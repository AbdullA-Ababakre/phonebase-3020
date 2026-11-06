# Phonebase 企业试用交付说明

本次实现针对现有 Phonebase 平台，目标是让受邀企业能够在分配的实体设备上通过网页、REST、MCP 开发和验证自己的工作流。默认英文、邀请制、Key 接入。

## 本次交付

- 对外官网与独立文档站：18 个主题、全文搜索、移动导航、页面目录、Markdown 下载。
- API reference 从远程 OpenAPI 合同读取请求参数、请求体、响应和嵌套 schema。
- 远程快速开始、连接配置助手、Node.js/Python 只读样例、MCP 指南和企业验收指南。
- Markdown、llms.txt、llms-full.txt，以及可迁移到 Mintlify 的内容包。
- 一份客户授权可分配同一站点内 1–100 台指定设备；该数量是输入上限，不是经过测试的硬件容量。
- 本地 Rentals 多选设备；同一设备不得重复分配；过期授权不能通过续租抢占另一客户当前租用的设备。
- REST/MCP 无 Origin 请求使用 Bearer 认证；浏览器错误 Origin 仍然拒绝。
- REST、回执列表、单条回执、WebSocket 按客户的设备集合隔离。WebSocket 每 5 秒复核撤销/过期。
- 旧单设备 registry 与 v2 客户 Key 兼容。写入多设备授权后 registry 版本为 2，旧程序会拒绝读取，避免静默丢失授权范围。

## 文档平台决策

当前网站继续使用既有 Vinext/Sites，文档内容独立存放于 content/docs/pages.json。scripts/build-docs.mjs 自动生成 Markdown、远程 OpenAPI、Agent 文本和 Mintlify 导出包；原有 /docs 和 /console 地址保持兼容。

Mintlify 支持 OpenAPI 3.0/3.1 自动生成文档与认证表单，适合后续使用专属 docs 域名及团队编辑流程。此次没有创建 Mintlify 订阅或将客户 Key 传给该服务。导出包在 docs/mintlify；交互式连接助手仍由 Phonebase 网站提供。

参考：
- https://www.mintlify.com/docs/api-playground/openapi-setup
- https://www.mintlify.com/docs/quickstart
- https://spec.openapis.org/oas/v3.1.2.html

## 上线顺序

1. 完成源代码构建、合同与授权集成测试。
2. 检查官网、文档、控制台和静态资源的实际 HTTP 响应。
3. 准备网站版本，保留现有生产版本及站点公开范围。
4. 在维护窗口同时升级本地 control-plane 和 remote gateway，再启动新版 Dashboard。
5. 在设备可见后，使用独立试用授权验证网页、REST、MCP 和一条真实工作流。
6. 在 2、5、10 台等实际目标配置下逐级测量 USB/摄像头带宽、延迟、掉线和故障恢复。容量结论以测量为准。

升级使用同一份经验证的源码与构建产物，保留生产租约并备份旧运行时。测试仅使用隔离的模拟服务，不控制真实机械臂。网站部署与站点运行时更新是两个独立步骤；设备列表为空时不能完成实机验收。

## 企业平台后续必须落实的能力

| 能力 | 当前状态 | 验收条件 |
| --- | --- | --- |
| 设备分配与 Key | 本次实现同站点多设备授权 | REST/WS 隔离，续租、撤销、旧 Key 回归 |
| 企业账号与成员 | 未实现 | 企业边界、邀请/退出、密码恢复或 OIDC、成员与 Key 权限映射 |
| 细粒度角色与独立 API Key | 当前每份客户授权共享读写权限 | read/control/admin 分离，Key 轮换，最小权限回归 |
| 集中总后台 | 当前为单站点本地后台 | 多站点登记、在线心跳、集中分配、站点故障隔离 |
| 独占执行与调度 | 客户应用自行串行化每台设备 | 并发租用冲突、队列/锁过期、取消与异常恢复 |
| 审计与可观测性 | 本地回执和日志 | 跨站点事件关联、成员身份、日志导出、留存策略与告警 |
| 硬件批量交付 | 尚需实机逐级验收 | 明确容量、校准恢复、备件、电源/USB 设计、远程支持 |
| 采购与支持 | 文档提供验收流程 | 实测 SLO、支持范围、升级/回滚承诺和客户协议 |

不把上述未完成项写成既有功能，不宣称没有证据的 SLA、认证、容量或延迟。正式规模化交付前，需要按客户实际采购要求完成这些验收。

## 分享预览图

使用内置 Imagegen 生成并检查，保存到 public/og.png。提示要求：Phonebase、标题“Your software. The real world.”、副标题“Real devices. REST API. MCP.”、米白/森林绿、概念性手机和机械触控笔，不添加指标或其他公司标志。它是产品概念图，不是实物产品照片。
