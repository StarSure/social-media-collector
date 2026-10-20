# 小红书采集

证据日期：2026-10-19。本平台部分 API 场景已有真实浏览器验收；其他来源不能沿用该通过结论。

## 任务与输入

- `note`：`/xiaohongshu/batch-collect/note`，主表单 `links/author-links/keyword`，链接应保留 xsec_token/xsec_source。
- `blogger`：`/xiaohongshu/batch-collect/blogger`，`links/keyword`。
- `comment`：`/xiaohongshu/batch-collect/comment`，直接传 urls/limitPerId，无 collectBy。
- note 的 `board-links` 来自 `/xiaohongshu/hidden-collect/board-note`；`homefeed/ai-chat/red-video` 由平台页入口触发，原实现仅支持 RPA。

关键词支持 note_type、sort、时间/范围 filters；author-links 使用每博主 limitPerId，可附日期区间。表单有 API/RPA 模式。任务 execute 的枚举多于主表单可选值。

## API、签名与页面

MAIN world base 为 edith.xiaohongshu.com（Rednote 为 webapi.rednote.com），withCredentials=true。签名调用实际页面 mnsv2 或 _webmsxyw，写 x-s/x-t/x-s-common/trace headers，并使用 Cookie a1、localStorage b1/b1b1。接口 461 验证码需人工处理；不要复制日志内 Cookie、token 作为固定凭证。

详情 POST `/api/sns/web/v1/feed`：source_note_id、image_formats、extra.need_body_topic、xsec_source、xsec_token。关键词 POST `/api/sns/web/v1/search/notes`；博主 GET `/api/sns/web/v1/user/otherinfo` 与 `/api/sns/web/v1/search/usersearch`。一级/子评论分别 `/api/sns/web/v2/comment/page`、`/api/sns/web/v2/comment/sub/page`。

RPA 详情从 __INITIAL_STATE__.note.noteDetailMap 读取，再适配字段；列表通过页面滚动/响应拦截累计。它和 API 的验收必须分别报告。

## 分页与去重

搜索 page 从 1、page_size=20，只收 model_type=note，has_more=false/无有效笔记/达到配额停止。当前构建已修复跨页重复候选提前耗尽 limit：每关键词独立 Set，按唯一笔记计数，并继续取页内剩余项。多关键词配额独立，不用全任务完成数替代。

user_posted 与 board/note 用 cursor、num=30；评论独立 cursor；发现页最多连续 3 次无新增停止。评论类维护 commentIds；博主/笔记主键为 user_id/note_id；基类仅关键词分支保证关键词合并，不应宣称所有来源全局去重。

默认笔记业务字段包括 ID/链接/类型/标题/正文、四项互动数、发布与更新时间、IP、博主 ID/链接/昵称、图片数量与封面/图片/视频字段。可选话题、发布日期、小红书号、粉丝、获赞收藏、简介、来源关键词。skipEmpty 会减少实际列数；本次来源关键词未勾选，不能声称写入工作簿。

## 已验与未验

已验完整链接 3 条（图文/视频，Excel 3 行 19 列）、「小学语文」两页 25 个唯一笔记（25 行 20 列）、13/25 暂停后续采、评论 5 条（5 行 12 列）、博主 3 位（3 行 10 列）、历史重载与重采。最终三类导出与 IndexedDB 原始平台数据共核对 220 项字段零差异。

未验：RPA、博主关键词搜索、博主笔记列表、专辑、发现页、ai-chat、red-video、子评论、全部筛选组合、媒体批量下载、定时、飞书同步和上报。

## 证据定位

代码锚点：项目 `reconstruction/social-assistant/extension/chunks/sidepanel-BdTwSbFs.js` 的 `/src/tasks/xiaohongshu/` 注册、对应表单源码路径与 router；签名和页面上下文位于 `extension/content-scripts/main.js`。普通模式使用平台页，本地构建禁用了原厂高级动态脚本模式。审计：`analysis/2026-10-19/social-assistant/collection-audit.md`；验收：`reconstruction/social-assistant/ACCEPTANCE.md` 与 `XHS-ACCEPTANCE.md`。较早静态审计中的“没有实测”以同日后续验收记录限定更新。

机器目录见 [platforms.json](../platforms.json)。`live-verified` 仅表示列出的 cases 实测，不能扩展到该任务的全部来源、模式和字段组合。

