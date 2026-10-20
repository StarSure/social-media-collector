# TikTok 采集

原扩展证据日期：2026-10-19，三类任务均仅静态核对。2026-10-20另新增自有公开账号资料读取路径，已完成有限匿名实测；两种路径不能混同。

## v0.3.0免登录近期主页视频

入口`scripts/anonymous-homepage.mjs`，任务示例[TikTok匿名视频](../../examples/tiktok-videos-anonymous.json)。每次运行独立临时Chrome；模块使用全新游客上下文读取`/embed/@username`实际视频链接，另用禁用页面JS的全新上下文读取真实详情SSR的`webapp.video-detail.itemInfo.itemStruct`。不导入用户会话，不请求此前失败的作者列表私有接口。

`limitPerId`显式为1至10；官方Creator Profile Embed只提供近期最多10条选集，不支持全历史分页。按实际链接的视频ID和详情作者双重核验；两者任一不匹配则停止。逐条输出playCount、likeCount、commentCount、shareCount、collectCount和metricSources（statsV2或stats来源）。缺失为null；播放或点赞缺失标partial，不补0。publishedAt保留Unix秒原文，长ID保留字符串；metricPrecision明确平台可能已取整。

2026-10-20 fresh anonymous Chrome：官方oEmbed和嵌入页HTTP200，发现@tiktok真实视频链接；3条详情HTTP200读到如下平台报告值：

| 视频ID | 播放量 | 点赞量 |
| --- | ---: | ---: |
| 7694797676306615583 | 1400000 | 12100 |
| 7693184538704416031 | 467600 | 14900 |
| 7692114317151423775 | 456200 | 12400 |

上述是实际探针结果；新CLI的合成页面测试不算又一次线上成功。后续一次独立嵌入请求返回429，停止该路径；不能保证当前重跑成功、任意账号可用或数值不变。403/429、登录/验证码和字段归属异常停止整批；不换身份重试。

## 新增公开资料路径

`scripts/local-browser.mjs`的`platform=tiktok/task=author/source=links`读取真实主页的`__UNIVERSAL_DATA_FOR_REHYDRATION__.__DEFAULT_SCOPE__['webapp.user-detail'].userInfo`，只提取user/stats中的公开白名单字段，不返回app context、Cookie或会话数据。示例见 [TikTok资料任务](../../examples/tiktok-profile-local.json)。先plan，再连接专用Chrome执行collect；输出JSON/CSV及状态报告。

本次fresh headless Chrome无账号、无用户Cookie，公开@tiktok主页HTTP200，读到真实用户名、字符串ID、简介、头像和统计。缺失数字保持null；不安全的数值ID拒绝解析。该结果说明此公开资料样本不必登录，不能推广成所有账号都可免登录。

独立页面探针中作品列表请求先200后403，页面显示加载错误，因此没有补造作品链接或继续单作品。后续资料适配器烟测主动阻止未使用的/api/请求，仅验证真实SSR资料，未替换平台页面响应。原扩展的作品、评论、搜索与RPA链路仍待真实验收。

## 任务与入口

`/tiktok/batch-collect/author`：keyword/links。
`/tiktok/batch-collect/aweme`：links/author-links/keyword。
`/tiktok/batch-collect/comment`：urls/limitPerId，无 collectBy。

## 请求与页面上下文

MAIN world 从 window.__$UNIVERSAL_DATA$__.__DEFAULT_SCOPE__ 或 __UNIVERSAL_DATA_FOR_REHYDRATION__ 的 webapp.app-context 读取 wid/language/region；请求还带浏览器/设备参数。代码存在默认地区上下文不等于该地区网络当前可用；需实际 TikTok 页与登录态。

端点含 `/api/user/detail/`、`/api/search/user/full/`、`/api/search/general/full/`、`/api/post/item_list/`、`/api/item/detail/`、`/api/comment/list/`、`/api/comment/list/reply/`。RPA 另通过页面状态和拦截累计。不能把未验证的签名或地域上下文直接套用到普通外部 fetch。

## 分页、去重与字段

达人搜索 cursor/count=10/search_id；作品 general 或 item/photo 搜索 offset/cursor/count=10；评论 count=20。空列表、has_more=false、评论重复 cursor 或数量配额终止。详情按页面 uniqueId/secUid 或作品 ID 补采。

主键为用户 ID/作品 ID/评论 ID；评论类维护 commentIds；基类只在关键词场景合并 search_keywords，其他来源需实际核对唯一 ID。字段族含用户资料/粉丝、作品内容/互动/视频或图集、评论/回复关系；图片作品与视频媒体结构不同，不能只验视频一种。

## 待验

网络和登录预检后，依次验证单作品 API 与 Excel、关键词两页、作者作品、图片作品、评论/子评论、RPA。原扩展链路仍无真实平台采集、分页或导出通过记录；新增匿名近期选集的有限样本见上文。

## 证据定位

代码锚点：项目 `reconstruction/social-assistant/extension/chunks/sidepanel-BdTwSbFs.js` 的 `/src/tasks/tiktok/` 注册、对应表单源码路径与 router；签名和页面上下文位于 `extension/content-scripts/main.js`。普通模式使用平台页，本地构建禁用了原厂高级动态脚本模式。审计：`analysis/2026-10-19/social-assistant/collection-audit.md`；验收：`reconstruction/social-assistant/ACCEPTANCE.md` 与 `XHS-ACCEPTANCE.md`。较早静态审计中的“没有实测”以同日后续验收记录限定更新。

机器目录见 [platforms.json](../platforms.json)。`live-verified` 仅表示列出的 cases 实测，不能扩展到该任务的全部来源、模式和字段组合。

