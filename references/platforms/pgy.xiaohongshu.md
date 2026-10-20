# 小红书蒲公英采集

证据日期：2026-10-19；四类任务仅静态核对，不能沿用普通小红书已验结论。

## 任务与真实路由

- `blogger-search`：`/pgy.xiaohongshu/hidden-collect/search-blogger`，collectBy=search 且 collectDataScope=only-list；否则分派 blogger。
- `blogger`：`/pgy.xiaohongshu/batch-collect/blogger` 的 links，或上述隐藏入口的 search。真实广场传入 params/kols，已选 kols 可直接导出。
- `note`：`/pgy.xiaohongshu/batch-collect/note` 的 links/author-links；search 来自 `/pgy.xiaohongshu/hidden-collect/search-note` 热门商业内容入口并携带 params。
- `invite`：`/pgy.xiaohongshu/hidden-collect/search-invite`，使用 params/limit，无 collectBy。读取已有邀约；`other/batch-invite` 是发邀约，不能用作采集入口。

这些隐藏路由需要平台页面发起并传入状态。普通小红书签名成功不证明蒲公英登录与数据权限可用。

## 请求与页面依赖

base=pgy.xiaohongshu.com，MAIN world 本地生成 x-s/x-t/traceid，复用该站账户 Cookie 与运行时。广场先 `/api/solar/cooperator/blogger/track` 取得 trackId，再 `/api/solar/cooperator/blogger/v2`；资料按选字段补 data_summary、fans_profile、fans_summary、notes_rate、core_data 等。

博主作品 `/api/solar/kol/data_v2/notes_detail`；笔记详情 `/api/solar/note/{id}/detail?bizCode=`。邀约 `/api/solar/invite/get_invites_overview` 后逐项 `/api/solar/invite/get_invite_info`。联系方式字段另请求 sensitive_info_view，受账户实际可见权限约束；不得把本地身份字段当作平台授权。

## 分页、去重与字段

广场 pageNum 从 1、pageSize=20，kols 空页或达到数量上限终止。博主笔记 pageNumber 从 1、pageSize=8，列表空页/每博主上限停止并补笔记详情。热门商业内容 pageNum 从 1、pageSize=34；邀约 pageNum 从 1、pageSize=10，空列表或 limit 停止。

主键为 userId/noteId/inviteId；基类的关键词去重规则不代表 search/links 全局去重，需要导出核唯一 ID。字段族：博主资料、报价、账户/日常/合作笔记/直播统计；笔记内容/媒体与商业指标；已有邀约记录。only-list 和详情任务的字段/API成本不同。

## 待验

已登录后从真实广场入口分别验 only-list 和详情、两页博主、作者笔记/热门内容、已有邀约读取；核对实际导出。发邀约、批量下单属于平台写入，不因采集 Skill 获得自动执行授权。当前无真实采集导出通过记录。

## 证据定位

代码锚点：项目 `reconstruction/social-assistant/extension/chunks/sidepanel-BdTwSbFs.js` 的 `/src/tasks/pgy.xiaohongshu/` 注册、对应表单源码路径与 router；签名和页面上下文位于 `extension/content-scripts/main.js`。普通模式使用平台页，本地构建禁用了原厂高级动态脚本模式。审计：`analysis/2026-10-19/social-assistant/collection-audit.md`；验收：`reconstruction/social-assistant/ACCEPTANCE.md` 与 `XHS-ACCEPTANCE.md`。较早静态审计中的“没有实测”以同日后续验收记录限定更新。

机器目录见 [platforms.json](../platforms.json)。`live-verified` 仅表示列出的 cases 实测，不能扩展到该任务的全部来源、模式和字段组合。

