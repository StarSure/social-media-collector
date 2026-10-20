# 巨量星图采集

证据日期：2026-10-19；三类任务仅静态核对，页面需要对应平台登录。

## 任务与真实路由

- `author-search`：`/xingtu/hidden-collect/search-author`。它是实际 router 注册的隐藏表单，collectBy=search，collectDataScope=only-list 才分派该类；其他范围分派 author。
- `author`：`/xingtu/batch-collect/author` 支持 links；search 同样由上述隐藏路由发起。
- `aweme`：`/xingtu/batch-collect/aweme` 支持 links/author-links。

隐藏搜索表单依赖真实平台达人广场入口传入 params/authors；直接 navigate 到路径不能创造搜索条件。authors 可用于导出已选结果。这里的「隐藏」是扩展 router 名称，不能理解成权限绕过。

## 请求与依赖

base=https://www.xingtu.cn，withCredentials=true，header agw-js-conv=str。响应检查 base_resp；有 x-vc-bdturing-parameters 则走验证码处理，需平台页面实际状态。

广场 `/gw/api/gsearch/search_for_author_square`；基础资料 `/gw/api/author/get_author_base_info`；按字段继续拉营销/受众/粉丝/传播/商业名片接口，包括 `/gw/api/data_sp/author_audience_distribution`、`/gw/api/author/get_author_marketing_info`、`/gw/api/gauthor/author_get_business_card_info`。

作品 `/gw/api/aggregator/get_author_homepage_videos`、`/gw/api/data_sp/item_report_detail`、`/gw/api/ggeneric/get_video_info`。平台本身的可见权限决定可返回字段，本地身份不扩大平台权限。

## 分页、去重与字段

广场 POST page_param.page 从 1、limit=20，authors 为空或 pagination.has_more=false 停止，数量上限也终止。已选 authors 直接逐项处理；详情字段按需补取。作者作品按平台分页与 limitPerId 累计。

主键为 star_id/作品 ID；基类只对带关键词的记录合并 search_keywords，search 广场数据不能自动视为已全局去重。字段族包括基础资料、报价、粉丝受众、营销/传播/商业指标，作品列表、报告与视频媒体字段分属不同 API。

## 待验

用已登录广场真实入口产生条件，分别验 only-list 与带详情导出，至少两页并核对 star_id；再验单视频及作者作品。当前仅有平台页面/UI证据，没有真实采集导出通过证据。

## 证据定位

代码锚点：项目 `reconstruction/social-assistant/extension/chunks/sidepanel-BdTwSbFs.js` 的 `/src/tasks/xingtu/` 注册、对应表单源码路径与 router；签名和页面上下文位于 `extension/content-scripts/main.js`。普通模式使用平台页，本地构建禁用了原厂高级动态脚本模式。审计：`analysis/2026-10-19/social-assistant/collection-audit.md`；验收：`reconstruction/social-assistant/ACCEPTANCE.md` 与 `XHS-ACCEPTANCE.md`。较早静态审计中的“没有实测”以同日后续验收记录限定更新。

机器目录见 [platforms.json](../platforms.json)。`live-verified` 仅表示列出的 cases 实测，不能扩展到该任务的全部来源、模式和字段组合。

