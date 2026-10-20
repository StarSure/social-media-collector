# 浏览器操作

| 命令 | 作用 | 是否开始采集 |
| --- | --- | --- |
| plan --spec 文件 | 离线参数、路由与证据等级 | 否 |
| preflight --endpoint 地址 | 只读连接、本地扩展身份、平台标签和依赖 | 否 |
| launch --port 9337 | 随包扩展、独立Chrome配置，保持进程运行 | 否 |
| open --endpoint 地址 --platform 平台 --task 类型 | 匹配平台页面及任务管理页 | 否 |
| prepare --endpoint 地址 --spec 文件 | 打开表单并给出实际字段清单 | 否，不自动填写/提交 |
| export --endpoint 地址 --output-dir 目录 | 已完成任务的原Excel导出与摘要 | 仅导出已有结果 |

## 连接与依赖

已有项目测试浏览器通常在9336，新Skill默认9337。只连接回环CDP；不能把端点当作安装扩展或接管所有浏览器的隐式授权。Skill不保存profile，独立状态放用户Codex状态目录，不复制主Chrome配置。

辅助命令输出中的HTTP链接会去掉query/hash作为摘要；原任务JSON保留完整平台链接。不要把stdout里的URL摘要覆盖原JSON，否则小红书的真实xsec参数会丢失。

`PLAYWRIGHT_PACKAGE`可指向已有Playwright包；浏览器可指定现有Chrome。脚本可复用当前机器bundled runtime路径，换机器先预检。安装Skill不自动安装Node/Chrome/Playwright。

## Chrome155

本环境已跑通：独立配置，移除Playwright默认`--disable-extensions`，加`--enable-unsafe-extension-debugging`，CDP `Extensions.loadUnpacked`。品牌Chrome的命令行load flags可能返回扩展ID却实际blocked，不要与CDP方案混用就宣称成功。

检查manifest身份、实际worker/本地服务握手及渲染；文件存在不证明运行。`assets/runtime-manifest.json`保存29个文件摘要。

若重载后提示unsupportedDeveloperExtension，检查该**专用配置**chrome://extensions/的开发者模式，再装载；不改用户全局设置。平台页需要刷新以重注入。旧DevTools worker句柄可能报No SW，可断开自己的连接重连，不要因此误判新worker未启动。

## 平台绑定

原生侧栏不占active tab；全页sidepanel.html预览会抢active，任务可能误把扩展自身当平台。填写后在扩展上下文执行`chrome.tabs.update(platformTabId,{active:true})`，等原UI识别，按“切换”绑定，确认`window.platform.code`正确，再原表单submit。必要时在背景预览页使用原`form.requestSubmit()`，不修改任务数据或响应。

前端是memory router，改hash不会切页。用原菜单或公开的window.router.navigate，核验window.router.location.pathname和真实正文；#root非空不算路由验收。

原生侧栏推荐Alt+C。初次须知/功能提醒可能遮挡按钮，读取并处理本任务提示后操作。错误页、被遮挡点击、重复主页截图都不是功能通过证据。

辅助open/prepare不会覆盖已有任务结果页。遇此提示，正在运行的任务先保持/完成；已完成的先导出，然后通过原菜单返回历史或平台主页再准备新任务，不能直接重载清掉原结果。

## 原表单

常见ID有name/urls/keywords/limit/limitPerId，但先读实际DOM。来源用可见标签切换，隐藏radio的.check可能一直等待。关键词tag填入后Enter，数字框失焦后查值；默认字段异步加载，初始0项不应立即提交。skipFailed关闭可暴露探针错误。

自定义字段、媒体、子评论等按用户范围选择。隐藏入口需要平台页面真实params/authors/kols等；缺状态时定位原页面按钮，不拼空状态，不把只读邀约记录改成发送邀请。

## 长任务

用短等待窗口观察进度并更新用户；超时先看实际状态，不等于自动失败。登录/验证码/权限失败不无限重试。暂停继续走原UI，保留缓存。只关闭自己创建的临时页/连接，用户正在使用的浏览器可保留；不删除会话目录或历史掩盖失败。
