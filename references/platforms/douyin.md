# 抖音采集

证据日期：2026-10-19；静态链路存在，尚无本项目真实采集与导出验收。

## 任务与入口

- `author`：达人链接或关键词；`/douyin/batch-collect/author`。
- `aweme`：作品链接、达人链接、合集链接、关键词；`/douyin/batch-collect/aweme`。原类另接收 `favorite`、`jingxuan`，由页面来源触发，不能当作主表单选项。
- `comment`：`/douyin/batch-collect/comment`，直接传 `urls/limitPerId`，没有 `collectBy` 枚举。

## 请求与页面依赖

作品使用 `/aweme/v1/web/aweme/detail/`、`/aweme/v1/web/aweme/post/`、`/aweme/v1/web/mix/aweme/`；搜索使用 `/aweme/v1/web/search/item/`、`/aweme/v1/web/discover/search/`、`/aweme/v1/web/general/search/single/`。达人搜索和详情依赖真实平台页面上下文。评论使用 `/aweme/v1/web/comment/list/` 与 `/aweme/v1/web/comment/list/reply/`。

MAIN world client 附页面浏览器参数和 Cookie UIFID/UIFID_TEMP 对应的 uifid，复用站点运行环境。RPA 读取 React 页面状态、滚动及拦截实际 HTTP；流式搜索按 ack/行合并响应。不能把普通外部网页 fetch 当作该环境，不能用原厂不存在的高级云脚本替代。

## 分页、去重与字段

搜索通常 count=10、offset/cursor/search_id，合集 cursor/count=10；has_more=false 或空列表停止，上限与日期条件也可提前结束。评论及子评论各用独立 cursor/count/has_more。记录主键分别为用户 ID、aweme_id、评论 ID；评论类维护 commentIds，页面 store 也按平台 ID 合并。基类仅关键词场景合并重复 ID 的 search_keywords，不保证所有无关键词来源全局去重。

字段族：作品 ID/链接/标题/发布时间/互动数/作者与媒体；达人资料/关注粉丝统计；评论文本/时间/作者/回复关系。导出以实际字段模板与 getColumns 为准；选择额外作者字段会补取详情。

## 下一次真实验收

先以一个完整作品链接采集非空 ID 并导出核值，再验关键词至少两页、作者列表、合集和子评论。收藏/精选、RPA、暂停续采与媒体下载均未验。

## 证据定位

代码锚点：项目 `reconstruction/social-assistant/extension/chunks/sidepanel-BdTwSbFs.js` 的 `/src/tasks/douyin/` 注册、对应表单源码路径与 router；签名和页面上下文位于 `extension/content-scripts/main.js`。普通模式使用平台页，本地构建禁用了原厂高级动态脚本模式。审计：`analysis/2026-10-19/social-assistant/collection-audit.md`；验收：`reconstruction/social-assistant/ACCEPTANCE.md` 与 `XHS-ACCEPTANCE.md`。较早静态审计中的“没有实测”以同日后续验收记录限定更新。

机器目录见 [platforms.json](../platforms.json)。`live-verified` 仅表示列出的 cases 实测，不能扩展到该任务的全部来源、模式和字段组合。

