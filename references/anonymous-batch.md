# 匿名批量主页视频

## 当前能力与验收

严格需求是每账号按发布时间最新20条视频，逐条有TikTok播放量或Instagram观看/播放量及点赞。`selection: "latest"`读取普通游客主页，观察页面自然发出的列表响应和真实视频链接，在有界滚动内收集；不猜签名、构造私有分页请求或加载用户会话。

**实现与真实可用性分开报告。当前最新20条尚未真实通过。** 2026-10-21 TikTok样本主页HTTP200，但自然作品列表HTTP403；Instagram普通游客主页跳登录。阻塞时停止整个平台批次，不切换账号身份或自动用旧嵌入选集补数。默认未传selection的旧embed模式仍限TikTok1..10、Instagram1..6，不保证严格最新。

latest目标数量显式为1..100，常规任务设20。数量只是目标；只有同作者、唯一视频、发布时间、最新列表证据和关键指标同时满足，才能completed。置顶按发布时间处理，图片、重复、推荐、缺失时间不能替代所需的视频。仅把20条排序不能证明其为主页最新20条。完整列表或有证据的连续最新时间边界才可证明覆盖；不能证明时latestVerified=false，结果partial。

## 配置和运行

复制[TikTok最新20条](../examples/tiktok-latest20-anonymous.json)或[Instagram最新20条](../examples/instagram-latest20-anonymous.json)，替换urls和outputDir。两平台分别运行，输出在Skill目录之外。

```sh
node scripts/anonymous-homepage.mjs plan --spec /absolute/path/to/job.json
node scripts/anonymous-homepage.mjs collect --spec /absolute/path/to/job.json
```

每次启动新临时无头Chrome，不接CDP、持久profile、storageState或已登录浏览器。第一次运行需要安装好的Chrome与项目锁定依赖，CLI不自动下载浏览器。403/429、登录或验证即停；没有自动重试或定时任务。网络超时、无更多视频、指标缺失与最新顺序未验证分别报告，未提供Retry-After不表示存在已知冷却时间。

## 原链接与来源行

`urls`为主页。可选`verifyWith`按主页键配置来自来源表的真实视频URL；在采主页前只读视频详情，核验同一视频ID并确认当前作者。如果源URL的作者名已变，使用真实响应作者定位主页，保存resolution和originalUrl，原链接与源表均不改写。核对遇阻时不继续该批次。

`sourceRefs`也是按主页键配置的字符串数组，例如`["来源表!E2"]`。它只用于本地回溯，不读取或写入飞书。配置中的每个键必须在urls中，不能借此增加采集对象。

```json
{
  "verifyWith": {"https://www.tiktok.com/@tiktok": "https://www.tiktok.com/@tiktok/video/7694797676306615583"},
  "sourceRefs": {"https://www.tiktok.com/@tiktok": ["来源表!E2"]}
}
```

这是可选配置片段，应合并到完整任务JSON；只有用户来源表确实提供对应视频时才添加核对链接，不使用示例视频代替用户证据。

## 断点与重新采集

运行时在outputDir写`checkpoint-<任务摘要>.json`。latest模式逐条保存已验数据并在账号结束保存最终状态；旧embed模式按账号保存。断点采用临时文件加rename，不保存浏览器Cookie或原始页面状态。

```sh
node scripts/anonymous-homepage.mjs collect --spec /absolute/path/to/job.json --resume /absolute/path/to/checkpoint.json
```

resume仅续同一次任务：平台、账号列表、数量、selection、核对链接和来源配置必须一致。已完成账号可跳过；未完成账号重新确认当前主页发现范围，只复用仍在名单内、作者/ID/发布时间相符且指标完整的已验视频。复用记录保留原collectedAt并标restoredFromCheckpoint，不冒充本次新取数。继续遇登录或403/429依然停止，断点不是绕过限制的入口。

需要观察新指标时，重新collect，不传resume。每次输出独立时间目录，保留先前快照；可显式比较上一份data.json：

```sh
node scripts/anonymous-homepage.mjs collect --spec /absolute/path/to/job.json --previous /absolute/path/to/previous/data.json
```

历史快照必须属于相同平台及账号列表。按平台和真实视频ID比较，仅新旧都有已知计数且采集时间递增时计算差值。新视频没有0基线；未知值保持null；指标回落保留负差值，长整数不丢精度。

## 输出与判定

- data.json/data.csv：视频明细、原始发布时间、逐条字段来源和采集时间；Instagram观看与播放不混填。
- accounts.csv：逐账号目标数、去重后数量、缺口、关键指标完整数、缺失时间数、latestVerified、状态与失败类别；未访问账号明确skipped。
- report.json：批次完成度、各账号证据和HTTP诊断、断点路径、是否恢复旧数据，以及acceptance.latest20Verified。
- 使用previous时额外输出metric-changes.json/csv，保留旧值、新值和差值。

文件存在、退出时有记录、纯离线测试通过，都不能单独证明最新20条真实可采。先看账号报告、latestVerified与数量/指标缺口，再核对真实列表及详情证据。缺少播放/观看或点赞保持null，禁止补0或复制历史业务表指标。
