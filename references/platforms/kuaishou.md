# 快手采集

证据日期：2026-10-19；三类任务均仅静态核对。

## 任务与入口

`author`：`/kuaishou/batch-collect/author`，links/keyword。
`photo`：`/kuaishou/batch-collect/photo`，author-links/links/keyword。
`comment`：`/kuaishou/batch-collect/comment`，直接使用 urls/limitPerId，无 collectBy。

## 请求与依赖

MAIN world 复用页面签名，加入 __NS_hxfalcon/caver；需要真实快手页面 Cookie 与签名运行时。REST 包括 `/rest/v/search/user`、`/rest/v/profile/user`、`/rest/v/profile/feed`、`/rest/v/search/feed`、`/rest/v/photo/comment/list`、`/rest/v/photo/comment/sublist`。作品详情另有 `/graphql`，operationName=visionVideoDetail。RPA 从 __APOLLO_STATE__/INIT_STATE、滚动和拦截结果读取真实数据。

## 分页、去重与字段

搜索使用 pcursor/searchSessionId；空页或 pcursor=no_more 停止。评论兼容旧/新版响应，使用 pcursor/pcursorV2；重复游标也终止。作者作品按 cursor 累计至 limitPerId。

主键为作者 ID/photo ID/comment ID；评论 handleRecord 检查已有记录，兼容 comment_id/commentId；页面 store 另按 ID 合并。基类关键词可合并 search_keywords，不能据此推定所有其他来源全局去重。

字段族：达人资料与粉丝统计；视频 ID/链接/描述/互动与媒体；评论正文、作者、时间、根与回复关系。作品字段模板如含作者或评论字段会另外补采，列表成功不足以证明这些字段可用。

## 待验

先单链接 API→Excel 核对 ID/标题/作者/互动，再验关键词至少两页、作者作品、评论与子评论、旧新版响应适配、RPA与暂停续采。无本项目真实采集结果可作通过证据。

## 证据定位

代码锚点：项目 `reconstruction/social-assistant/extension/chunks/sidepanel-BdTwSbFs.js` 的 `/src/tasks/kuaishou/` 注册、对应表单源码路径与 router；签名和页面上下文位于 `extension/content-scripts/main.js`。普通模式使用平台页，本地构建禁用了原厂高级动态脚本模式。审计：`analysis/2026-10-19/social-assistant/collection-audit.md`；验收：`reconstruction/social-assistant/ACCEPTANCE.md` 与 `XHS-ACCEPTANCE.md`。较早静态审计中的“没有实测”以同日后续验收记录限定更新。

机器目录见 [platforms.json](../platforms.json)。`live-verified` 仅表示列出的 cases 实测，不能扩展到该任务的全部来源、模式和字段组合。

