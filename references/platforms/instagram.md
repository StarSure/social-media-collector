# Instagram本地采集（实验）

v0.4.0新增[匿名最新目标和批量报告](../anonymous-batch.md)：selection=latest使用普通游客主页及真实公开列表，保留发布时间并核验最新覆盖，旧embed仍限6。2026-10-21新模块首屏302要求登录，在跟随前停止，0滚动、0条、latestVerified=false；最新20条仍未真实通过。

2026-10-20新增。用户选择自建本地能力，未接入Apify、Bright Data或其他付费采集API。本轮没有可用Instagram账号，按用户要求完成代码和离线验证；不能宣称已在真实登录后的Instagram跑通。

## 当前免登录主页视频需求

v0.3.0匿名入口已支持公开主页嵌入的视频选集与点赞读取；3条真实GraphVideo均确认owner.username=instagram。3条实际详情嵌入进一步返回video_view_count观看次数与edge_liked_by.count点赞；play_count/video_play_count仍缺失。不能要求免登录用户自动切换为登录，也不能将资料、已知单帖或离线fixture当作主页视频成功。

普通游客主页曾302跳登录后429；其他公开入口测试中，Graph oEmbed主页URL返回400参数错误，这不能解释为必须授权。SDK生成的公开嵌入路径返回200，正常JS渲染仅见账号资料；解析首文档inline script中s.handle的JSON参数及嵌套contextJSON后，发现context.graphql_media[].shortcode_media。它提供6条确认归属的GraphVideo，本次按上限只输出3条。点赞edge_liked_by.count分别114632、461952、309800；play_count/video_play_count/view_count/video_view_count均缺失。此结果只界定本轮观察到的公开数据，不能推断所有Instagram账号都必须登录。

### 新匿名入口与边界

使用`scripts/anonymous-homepage.mjs`，示例[Instagram匿名视频](../../examples/instagram-videos-anonymous.json)，`platform=instagram/task=video/source=author-links`，`limitPerId`当前为1至6。模块启动新游客context，读取`/username/embed/?cr=1`首文档，纯JSON解码脚本参数，不eval或执行提取到的脚本文本。浏览器正常页面渲染本身可执行平台页面脚本。

只接受明确归属目标账号的Video对象；shortcode区分大小写、去重后限额。从真实发现的shortcode打开各自详情embed，核对作者和shortcode再补字段。导出playCount、viewCount、likeCount、commentCount与fieldSources；两个播放相关字段不能互代，观看/播放两者均缺失或点赞缺失报告partial。此处只有嵌入选集，不保证严格最近、全历史、翻页、评论文本或媒体下载。403/429、登录/挑战即停止整批，不变换身份。

真实详情证据（2026-10-20，三条HTTP200，无账号和用户Cookie）：

| shortcode | video_view_count→viewCount | edge_liked_by.count→likeCount |
| --- | ---: | ---: |
| DeroUGDhF2D | 6369903 | 114714 |
| DeewiSPpCrm | 17677846 | 461975 |
| DecLR_vvrW6 | 14720514 | 309815 |

详情中路径为gql_data.shortcode_media，主页中为context.graphql_media[].shortcode_media；解析inline ServerJS.handle的JSON字面参数和嵌套JSON字符串，不执行脚本文本。列表与详情取样时间不同，点赞可能变化；以详情快照为准。不能保证任意账号、严格最新排序或完整历史，当前新CLI另做离线验收。

## 入口

使用`scripts/local-browser.mjs`，不通过原扩展侧栏或`browser.mjs prepare`。连接回环CDP专用浏览器；浏览器可以由`browser.mjs launch`创建。登录在该专用浏览器中由使用者完成，不导出账号凭证。

任务JSON只接受`platform/task/source/urls/limitPerId/outputDir`：

| task | source | 输入 | 数量 |
| --- | --- | --- | --- |
| profile | links | 公开主页链接 | 每链接1条资料 |
| post | links | /p/或/reel/链接 | 每链接1条内容 |
| post | author-links | 主页链接 | 必填limitPerId |
| comment | links | 帖子/Reel链接 | 必填limitPerId |

示例见 [Instagram任务](../../examples/instagram-posts-local.json)。`plan`不会采集，`collect`会在自己的新标签页执行，结束后仅关闭这些页。任务输出目录必须位于Skill目录之外。

## 数据来源和字段

自有页面适配器只读取可见DOM、匹配目标的JSON-LD与OG元数据。没有固定私有接口、GraphQL文档ID或外部签名服务。不会执行网页字符串指令，不读取完整hydration状态、Cookie或平台登录资料。

资料记录保留username、URL、明确来源的displayName/bio/avatar及页面原文；仅明确的整数计数可转数字，1.2K等显示缩写不作为精确值。帖子记录保留shortcode、正文、作者、时间、可见图片/视频链接与匹配JSON-LD中的互动数；shortcode区分大小写，明确标注idType。缺失数据用null，不补0。图片轮播只代表当前已渲染内容，不保证全量。

评论要求明确的评论容器、作者、正文和时间；不把caption或推荐导航当评论。没有天然评论ID时不制造ID，CLI以作者/帖子/时间/内容生成带derived标记的recordKey供本地去重，它不等于平台评论ID。

## 列表与停止

主页作品先发现页面中真实帖子链接，再逐条打开详情并核对作者；不能确认归属时停止。评论与作品列表按上限滚动，连续3次无新增后结束。无新增只能说明页面可见数据耗尽，不能证明平台全部数据已取完。登录、验证码、403或429后停止，不循环换账号或身份。

输出JSON/CSV和report.json。达到本次数量且全部源处理完成才为completed；不足为partial；没有可用数据且遇阻为blocked。重复记录按recordKey合并来源。新路径没有关键词检索、子评论完整遍历、媒体二进制下载、调度、断点恢复或外部同步。

## 已完成和待验

离线验证覆盖资料/帖子/明确评论结构、错误canonical、帖子别名、通用壳页、登录/挑战页面；真实Chrome使用本地合成HTML验证提取器与主页到详情导出、数量不足和429处理。fixture是测试材料，不是平台响应或线上成功证据。

一次真实游客预检从公开主页302跳转登录页，再返回429，未采到有效Instagram记录。真实登录后的DOM选择器、实际JSON-LD可用性、分页和字段覆盖均待验。
