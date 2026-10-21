# Social Media Collector · 多平台社媒采集 Skill

把浏览器中的真实采集流程交给 Codex：选择平台和任务、打开原采集表单、分页与补采详情、暂停续采、导出 Excel，并核对记录数量和关键字段。

仓库根目录就是一个可安装的 `social-media-collector` Skill，包含 Chrome MV3 扩展运行包、操作脚本、平台参考和离线测试。普通浏览器用户也可以直接手动装载扩展。

## 能力与验证范围

| 平台 | 包内任务 | 验证范围（2026-10-20更新） |
| --- | --- | --- |
| 小红书 | 笔记、博主、评论 | 笔记链接3条、关键词两页25条、一级评论5条、博主3位、暂停续采与历史导出 |
| B站 | 视频、UP主、评论、弹幕 | 单条视频及 Excel 导出 |
| 抖音 | 达人、作品、评论 | 静态核对，待逐场景实测 |
| 快手 | 达人、作品、评论 | 静态核对，待逐场景实测 |
| TikTok | 原扩展达人、作品、评论；新增独立公开资料与匿名近期视频读取 | @tiktok匿名取得3条视频及播放/点赞；近期选集最多10条，后续请求曾429 |
| Instagram | 实验资料/帖子/评论；新增匿名主页视频选集 | 匿名主页选集→3条详情：观看次数及点赞已取得；play_count未返回 |
| 巨量星图 | 搜索、达人、作品 | 静态核对，待逐场景实测 |
| 蒲公英 | 搜索、博主、邀约记录、笔记 | 静态核对，待逐场景实测 |

原扩展包含7个平台、23类任务；新增Instagram的3类本地命令任务，以及TikTok公开资料补充路径。Instagram不在原扩展侧栏中。既有验证不能保证接口今天仍可用；新场景先做少量探针。完整记录见 [验收说明](references/verification.md)。

## 安装到 Codex

需要 Git；浏览器辅助功能需要 Node.js 20+、本机 Chrome 和 Playwright；导出检查器需要 Python 3.9+。离线规划、Node 测试和文件摘要核验不需要 Playwright。

macOS / Linux：

```sh
git clone https://github.com/StarSure/social-media-collector.git "${CODEX_HOME:-$HOME/.codex}/skills/social-media-collector"
cd "${CODEX_HOME:-$HOME/.codex}/skills/social-media-collector"
npm ci --ignore-scripts
```

Windows PowerShell：

```powershell
$skillBase = if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills' } else { Join-Path $HOME '.codex/skills' }
git clone https://github.com/StarSure/social-media-collector.git (Join-Path $skillBase 'social-media-collector')
Set-Location (Join-Path $skillBase 'social-media-collector')
npm ci --ignore-scripts
```

目标目录已有内容时先检查现有安装；上述命令不会替你覆盖。ZIP 用户将包含 `SKILL.md` 的整个 `social-media-collector` 目录放入自己的 skills 目录。重新打开或刷新 Codex 的技能列表后，可以这样请求：

> 使用 $social-media-collector，在小红书按关键词“小学语文”采集25条笔记，包含标题、正文、作者、互动数和图片链接，导出到我的指定目录并核验。

## 第一次运行

在仓库根目录执行：

```sh
npm run check
node scripts/browser.mjs plan --spec examples/xiaohongshu-keyword.json
node scripts/browser.mjs launch --port 9337
```

`launch` 创建独立的专用 Chrome 配置，进程需保持运行；在该浏览器登录目标平台。自动装载流程已在 macOS / Chrome155 验证，Windows 可显式指定已安装的 Chrome：

```powershell
node scripts/browser.mjs launch --port 9337 --browser 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

另开一个终端：

```sh
node scripts/browser.mjs preflight --endpoint http://127.0.0.1:9337
node scripts/browser.mjs prepare --endpoint http://127.0.0.1:9337 --spec examples/xiaohongshu-keyword.json
```

`plan` 只校验参数；`prepare` 只打开表单并列出字段，不自动填写或开始采集。由 Codex 或使用者检查实际表单、字段和数量后，通过原界面开始任务。示例中的数量是每关键词25条；辅助任务 JSON 的支持字段以 `help` 为准，更细的过滤条件在原表单中设置。

在平台标签页按 **Alt+C** 打开原生侧栏，确认绑定的平台正确。首次提示、平台登录和验证码按真实页面处理。详细易错点见 [浏览器操作](references/browser-operations.md)。

## 直接使用 Chrome 扩展

1. 打开 `chrome://extensions/`，开启开发者模式。
2. 点击「加载已解压的扩展程序」，选择本仓库的 `assets/extension/`。
3. 打开目标平台网页，点击扩展或按 Alt+C，根据平台入口配置并运行任务。
4. 完成后使用原导出按钮，并核对实际文件。

手动装载不需要 Node 或 Playwright。平台页面仍需相应登录、签名环境与权限。

## TikTok与Instagram免登录主页视频

v0.4.0新增显式`selection: "latest"`任务、发布时间核验、账号来源校对、断点和完整度报告。**每账号最新20条仍未真实验收通过**：当前TikTok自然视频列表HTTP403，Instagram游客主页要求登录；嵌入选集的成功不能替代最新20条。配置可设20代表采集目标，不代表平台一定提供20条。具体用法和验收条件见[匿名批量采集](references/anonymous-batch.md)。

```sh
node scripts/anonymous-homepage.mjs plan --spec examples/tiktok-latest20-anonymous.json
node scripts/anonymous-homepage.mjs plan --spec examples/instagram-latest20-anonymous.json
```

v0.3.0新增`scripts/anonymous-homepage.mjs`，独立启动临时无头Chrome，使用全新游客上下文，不连接现有浏览器、不载入用户profile或Cookie。TikTok从官方主页嵌入发现真实视频链接，再读详情SSR；Instagram纯JSON解析公开主页嵌入首文档中的视频对象。提取器不执行脚本文本，不接商业采集API。

```sh
node scripts/anonymous-homepage.mjs plan --spec examples/tiktok-videos-anonymous.json
node scripts/anonymous-homepage.mjs plan --spec examples/instagram-videos-anonymous.json
node scripts/anonymous-homepage.mjs collect --spec /absolute/path/to/job.json
```

复制示例并替换主页链接及输出目录；`limitPerId`必填：TikTok为1至10，Instagram当前限1至6。两者均只采嵌入选集，不代表全部历史或严格最新排序。无需先启动`browser.mjs launch`。找不到本机Chrome时用`--browser`指定路径（Windows同样适用），或设置`SOCIAL_BROWSER_EXECUTABLE`；不自动下载浏览器。

两平台均输出视频ID、作者、正文、相关计数和字段来源。TikTok另含发布时间（Unix秒原文）、时长及分享/收藏数；Instagram含独立的`viewCount`和`playCount`。缺失为null；TikTok缺少播放或点赞时报告partial；Instagram缺少观看/播放两者或点赞时报告partial。计数保留平台报告值，平台可能已经取整，不能称为未经取整的精确次数。

2026-10-20真实匿名探针已从@tiktok发现3条视频并取得逐条播放/点赞等指标。这只证明该样本当时可用；后续一次访问嵌入入口返回429，已停止请求，不能保证任意账号或随时稳定可用。[官方文档](https://developers.tiktok.com/docs/en/embed-creator-profiles)说明嵌入最多提供近期10条选集，**不支持完整历史列表或翻页**。HTTP403/429、登录或验证码会停止整批，不切换身份或反复重试。

**Instagram已免登录取得3条主页视频及各自观看次数、点赞数。** 观看次数来自`video_view_count`，保存为`viewCount`；平台另一个字段`play_count`未返回，`playCount`保持null，两者不互相代填。例：首条观看6369903、点赞114714。若观看和播放两项均缺失，或点赞缺失，运行必须为partial。既有DOM/JSON-LD采集器仍是离线验证的实验功能，其状态与新SSR路径分开。公开路径及字段实证见[验收说明](references/verification.md)。

v0.3.2将TikTok入口恢复为官方oEmbed→固定官方SDK→SDK实际创建的iframe，避免直接顶层打开iframe地址。优先解析真实iframe中的公开作者videoList JSON，排除私有项并去重，避免只等视觉加载漏掉已有视频。用户提供样本已由正式匿名CLI完成1条主页视频的播放/点赞采集；有限实测不代表持续稳定或全部历史。400等错误保留公开错误说明，403/429另记录阶段及Retry-After（未给则为null）；不能仅凭状态码承诺等多久恢复。输入来自既有视频链接时，URL中的作者名可能与当前详情作者不同，应按真实视频ID核对当前作者再定位主页，不回写源表。

## Instagram与TikTok新增本地采集

v0.2.0新增的自有采集器直接读取Chrome中公开呈现的DOM、JSON-LD或TikTok资料SSR数据，不调用商业数据API，也不需要服务商密钥。该DOM采集器在v0.2.0实现时只做代码和离线验证；游客探针跳转登录页并遇到429后已停止重试。

先按上文启动专用浏览器，再检查新任务：

```sh
node scripts/local-browser.mjs plan --spec examples/tiktok-profile-local.json
node scripts/local-browser.mjs plan --spec examples/instagram-posts-local.json
```

复制相应示例为自己的任务文件，替换目标链接和`outputDir`（必须在Skill目录之外）。执行：

```sh
node scripts/local-browser.mjs collect --endpoint http://127.0.0.1:9337 --spec /absolute/path/to/job.json
```

支持TikTok单/多个公开账号资料；Instagram账号资料、已知帖子/Reel链接、按主页链接发现作品、明确评论结构的可见评论。`collect`会打开并关闭自己的采集页，复用专用浏览器会话；不会清除历史或复制Cookie。这条Instagram DOM路径的登录后可用性仍待实测；上方匿名SSR路径单独登记。详细字段与限制见 [Instagram](references/platforms/instagram.md) 和 [TikTok](references/platforms/tiktok.md)。

新路径直接导出`data.json`、`data.csv`、`report.json`，每次使用独立子目录。CSV用`recordKey`核查唯一性；`partial`表示数量不足，`blocked`表示被登录、验证或访问限制阻断，不能仅看文件存在认定成功。未新增这条路径的关键词搜索、定时任务、暂停续采或飞书同步。

JSON保留ID和正文原值。CSV对可能被表格软件当公式的文本加前导单引号；导入Excel时应将长数字ID列设为文本，以免被表格软件改成近似数字。

## 导出与核验

可以直接使用原界面导出；辅助导出命令只接受已完成的任务：

```sh
node scripts/browser.mjs export --endpoint http://127.0.0.1:9337 --output-dir /absolute/path/to/output
python3 scripts/verify_export.py /actual/download.xlsx --expected-count 25 --id-column 笔记ID --required-column 笔记标题
```

Windows 的 Python 命令通常为 `py -3`；替换上面的 `python3` 即可。使用脚本返回的真实下载路径，不要照抄示例路径。核验器检查行数、唯一ID和非空字段；字段内容仍需与真实响应或页面抽查。采集文件请放在仓库目录之外。

## 开发、验证与打包

```sh
npm test
npm run test:browser
python3 -m unittest discover -s tests -p 'test_*.py'
npm run check
python3 scripts/package_skill.py --output dist/social-media-collector-0.4.0.zip
```

打包入口先核验29个运行资源的 SHA-256，只打包明确列出的项目文件；不会包含 `.git`、`node_modules`、浏览器配置或采集结果。扩展是编译后的运行快照，不是原厂 TypeScript 源码。修改扩展后需审阅变化并更新 `assets/runtime-manifest.json` 中相应摘要。

`test:browser`使用本机Chrome加载本地合成HTML，所有社媒请求都由测试拦截，不代表真实平台采集通过；可用`SOCIAL_BROWSER_EXECUTABLE`指定已安装浏览器。

## 数据与来源

普通采集依赖真实平台页面及其登录/签名上下文。任务缓存保存在扩展的 IndexedDB，本地配置保存在 Chrome storage。不要把自己的 profile、Cookie、飞书密钥或采集文件提交到仓库。

本地适配关闭原厂账号 API、动态高级脚本下载与活动上报；原厂帮助链接仍可能存在。飞书「自定义应用」及用户配置的上报目标属于额外的外部写入，需使用者明确配置。未提供原厂高级云脚本、代管飞书令牌或公网模板分享。

运行资产来自社媒助手3.6.1的本地适配包，保留原来源与版权标记。自有辅助脚本和文档的 MIT 许可不覆盖第三方扩展资产，具体见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
