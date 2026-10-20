# 哔哩哔哩采集

证据日期：2026-10-19。只有单视频 API→导出场景已验。

## 任务与入口

`/bilibili/batch-collect/{video,uploader,comment,danmaku}` 为四个实际表单路由。video 接收 links/author-links/keywords；uploader 接收 links/keywords，关键词枚举为复数 `keywords`。comment/danmaku 直接使用 urls/limit，无 collectBy 分派。

## 请求与签名

MAIN world 从 `/x/web-interface/nav` 的 WBI img/sub key 生成 w_rid/wts。详情 `/x/web-interface/wbi/view/detail`；UP主 `/x/space/wbi/acc/info`、navnum、关系统计；列表 `/x/space/wbi/arc/search`；搜索 `/x/web-interface/wbi/search/type`；视频流 `/x/player/playurl`。

评论 `/x/v2/reply/wbi/main`、`/x/v2/reply/reply`。弹幕 `/x/v2/dm/wbi/web/seg.so`、`/x/v2/dm/history/index`、`/x/v2/dm/web/history/seg.so`，arraybuffer 经 protobuf 解码。RPA 可读播放页 __INITIAL_STATE__/__pinia。

## 分页、去重与字段

UP主搜索 page 从 1、page_size=36，少于 36 条停止；评论 pagination.offset/next_offset，子评论 pn/ps=10；弹幕按分P/cid/分段，历史模式先取日期索引。达到任务数量上限会停止；单条详情没有分页。

主键分别为 bvid/mid/评论 ID/弹幕 ID；评论与弹幕各维护专用 ID Set。基类关键词合并重复记录的 search_keywords，无关键词分支不等于通用全局去重。视频字段含 ID/链接/标题/分区/发布时间/互动数/UP主与媒体；弹幕含发送时间、视频位置和文本，评论含根/回复关系。实际列依赖模板、额外详情 API 和 skipEmpty。

## 验收

真实页面 BV1xx411c7mD，以 API 模式完成 1/1；原生导出 Excel 1 行 21 列，独立解析验证 ID、标题「字幕君交流场所」、UP主「碧诗」mid=2 和正数互动统计。此样本不能证明关键词/UP主分页、评论、弹幕、历史弹幕、RPA或下载已验。

## 证据定位

代码锚点：项目 `reconstruction/social-assistant/extension/chunks/sidepanel-BdTwSbFs.js` 的 `/src/tasks/bilibili/` 注册、对应表单源码路径与 router；签名和页面上下文位于 `extension/content-scripts/main.js`。普通模式使用平台页，本地构建禁用了原厂高级动态脚本模式。审计：`analysis/2026-10-19/social-assistant/collection-audit.md`；验收：`reconstruction/social-assistant/ACCEPTANCE.md` 与 `XHS-ACCEPTANCE.md`。较早静态审计中的“没有实测”以同日后续验收记录限定更新。

机器目录见 [platforms.json](../platforms.json)。`live-verified` 仅表示列出的 cases 实测，不能扩展到该任务的全部来源、模式和字段组合。

