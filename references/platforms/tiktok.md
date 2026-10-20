# TikTok 采集

证据日期：2026-10-19；三类任务均仅静态核对。

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

网络和登录预检后，依次验证单作品 API 与 Excel、关键词两页、作者作品、图片作品、评论/子评论、RPA。当前无真实平台采集、分页或导出通过记录。

## 证据定位

代码锚点：项目 `reconstruction/social-assistant/extension/chunks/sidepanel-BdTwSbFs.js` 的 `/src/tasks/tiktok/` 注册、对应表单源码路径与 router；签名和页面上下文位于 `extension/content-scripts/main.js`。普通模式使用平台页，本地构建禁用了原厂高级动态脚本模式。审计：`analysis/2026-10-19/social-assistant/collection-audit.md`；验收：`reconstruction/social-assistant/ACCEPTANCE.md` 与 `XHS-ACCEPTANCE.md`。较早静态审计中的“没有实测”以同日后续验收记录限定更新。

机器目录见 [platforms.json](../platforms.json)。`live-verified` 仅表示列出的 cases 实测，不能扩展到该任务的全部来源、模式和字段组合。

