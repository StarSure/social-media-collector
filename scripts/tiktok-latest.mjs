import { normalizeTikTokVideo } from './tiktok-homepage.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const idString = value => typeof value === 'string' && /^\d+$/.test(value) ? value : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const validCount = value => Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^\d+$/.test(value);
const cursorString = value => typeof value==='string' && value.length ? value : Number.isSafeInteger(value) ? String(value) : null;

function targetUrl(value, video = false) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_URL', 'Use an exact public TikTok HTTPS URL.'); }
  const match = (video ? /^\/@([a-zA-Z0-9._]+)\/video\/(\d+)\/?$/ : /^\/@([a-zA-Z0-9._]+)\/?$/).exec(url.pathname);
  if (url.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(url.hostname) || url.port || url.username || url.password || !match) throw fail('INVALID_URL', 'Use an exact public TikTok profile or video HTTPS URL.');
  return { username: match[1], id: match[2], url: `https://www.tiktok.com/@${match[1]}${video ? `/video/${match[2]}` : ''}` };
}

export function tikTokPublishedTime(value) {
  const seconds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (Number.isSafeInteger(seconds) && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime())) return seconds;
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed / 1000);
  }
  return null;
}

function httpError(response, stage) {
  const status = response.status();
  const code = [403, 429].includes(status) ? `BLOCKED_HTTP_${status}` : 'HTTP_ERROR';
  return Object.assign(fail(code, `TikTok ${stage} returned HTTP ${status}; stopped without retry.`), { http: {status, stage, path: new URL(response.url()).pathname, retryAfter: response.headers()['retry-after'] ?? null} });
}

async function gates(page) {
  const state = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const visible = node => node.getClientRects().length > 0;
    const modal = [...document.querySelectorAll('[role="dialog"]')].filter(visible).map(node => node.innerText).join(' ');
    return {
      challenge: /\/(?:challenge|checkpoint)(?:\/|$)/.test(location.pathname) || [...document.querySelectorAll('[id*="captcha"],[class*="captcha"],iframe[src*="captcha"]')].some(visible) || /verify (?:that )?you(?:'re| are) human|complete (?:the )?security verification|请完成安全验证/i.test(text),
      login: /\/login(?:\/|$)/.test(location.pathname) || /log in to (?:continue|view|watch|see)|sign in to (?:continue|view)|请先登录|登录后(?:查看|继续)/i.test(text) || /log in to tiktok/i.test(modal),
    };
  });
  if (state.challenge) throw fail('CHALLENGE_REQUIRED', 'TikTok requires verification; anonymous collection stopped.');
  if (state.login) throw fail('LOGIN_REQUIRED', 'TikTok requires login; anonymous collection stopped.');
}

async function navigate(page, url, stage, timeoutMs=30000) {
  let response;
  try { response = await page.goto(url, {waitUntil:'domcontentloaded', timeout:Math.max(1,Math.min(30000,timeoutMs))}); }
  catch (error) { throw Object.assign(fail(error.name === 'TimeoutError' ? 'NAVIGATION_TIMEOUT' : 'NAVIGATION_FAILED', `TikTok ${stage} navigation ${error.name === 'TimeoutError' ? 'timed out' : 'failed'}; no retry was performed.`), {http:{status:null,stage,path:new URL(url).pathname,retryAfter:null}}); }
  if (!response) throw fail('NAVIGATION_FAILED', 'The TikTok navigation produced no HTTP response.');
  if (response.status() >= 400) throw httpError(response, stage);
  const actual = new URL(page.url());
  if (!['www.tiktok.com', 'tiktok.com'].includes(actual.hostname)) throw fail('UNEXPECTED_REDIRECT', 'TikTok redirected outside its public website.');
  try { await gates(page); }
  catch(error) { error.http={status:response.status(),stage,path:new URL(response.url()).pathname,retryAfter:response.headers()['retry-after']??null};throw error; }
  return response.status();
}

async function detailItem(page, url, timeoutMs=30000) {
  const httpStatus = await navigate(page, url, 'video-detail', timeoutMs);
  const item = await page.evaluate(() => {
    let data;
    try { data = JSON.parse(document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent ?? ''); } catch { return null; }
    const value = data.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    if (!value) return null;
    const stats = v => v && ({playCount:v.playCount,diggCount:v.diggCount,commentCount:v.commentCount,shareCount:v.shareCount,collectCount:v.collectCount});
    return {id:value.id,desc:value.desc,createTime:value.createTime,author:{uniqueId:value.author?.uniqueId},video:value.video && {duration:value.video.duration},imagePost:Boolean(value.imagePost),privateItem:value.privateItem,stats:stats(value.stats),statsV2:stats(value.statsV2)};
  });
  if (!item) throw fail('VIDEO_DATA_MISSING', 'The public detail page has no video SSR data.');
  if (item.privateItem === true) throw fail('PRIVATE_VIDEO', 'The detail page identifies a private video.');
  if (item.imagePost || !item.video) throw fail('NOT_VIDEO', 'The discovered item is not a video; image posts are excluded.');
  return {item,httpStatus};
}

export async function resolveTikTokVideoAuthor(browser, videoUrl) {
  const target = targetUrl(videoUrl, true);
  const context = await browser.newContext({javaScriptEnabled:false});
  let blocked;
  try {
    const page = await context.newPage();
    page.on('response', response => { const url=new URL(response.url());if (['www.tiktok.com','tiktok.com'].includes(url.hostname) && [403,429].includes(response.status())) blocked ??= httpError(response,'video-detail'); });
    const {item,httpStatus} = await detailItem(page,target.url);
    if (blocked) throw blocked;
    if (idString(item.id) !== target.id) throw fail('VIDEO_ID_MISMATCH', 'The public detail ID differs from the source video URL.');
    const username = item.author?.uniqueId;
    if (typeof username !== 'string' || !/^[a-zA-Z0-9._]+$/.test(username)) throw fail('AUTHOR_MISSING', 'The public video does not identify a current author.');
    return {url:`https://www.tiktok.com/@${username}`,username,videoId:target.id,sourceVideoUrl:target.url,httpStatus};
  } catch (error) { throw blocked ?? error; }
  finally { await context.close(); }
}

// A sorted subset alone is insufficient: prove a complete feed or a Latest feed frontier.
export function assessTikTokLatest(pages, candidates, limit, latestModeConfirmed) {
  if (!pages.length || pages[0].requestCursor !== '0') return {verified:false,reason:'initial-page-unconfirmed'};
  for (let index=1;index<pages.length;index++) if (pages[index].requestCursor===null || pages[index-1].cursor===null || pages[index].requestCursor !== pages[index-1].cursor) return {verified:false,reason:'pagination-continuity-unconfirmed'};
  const unique = new Map();
  for (const page of pages) for (const item of page.items) if (!unique.has(item.id)) unique.set(item.id,item);
  if (candidates.some(item=>!unique.has(item.id))) return {verified:false,reason:'videos-outside-observed-feed'};
  if (pages.at(-1).hasMore === false) return {verified:true,reason:'complete-public-video-feed'};
  if (!latestModeConfirmed) return {verified:false,reason:'latest-sort-mode-unconfirmed'};
  const unpinned = [...unique.values()].filter(item=>!item.pinned);
  if (!unpinned.length || unpinned.some(item=>!item.timestamp)) return {verified:false,reason:'publication-boundary-unconfirmed'};
  for (let index=1;index<unpinned.length;index++) if (unpinned[index].timestamp > unpinned[index-1].timestamp) return {verified:false,reason:'nonchronological-public-feed'};
  const ordered = candidates.filter(item=>item.timestamp).sort((a,b)=>b.timestamp-a.timestamp);
  if (ordered.length<limit || unpinned.at(-1).timestamp>ordered[limit-1].timestamp) return {verified:false,reason:'newer-unseen-videos-possible'};
  return {verified:true,reason:'confirmed-latest-sort-and-pagination-frontier'};
}

function reusable(record, discovery, username) {
  const published = typeof record.publishedAt==='string' && /^\d+$/.test(record.publishedAt) ? tikTokPublishedTime(record.publishedAt) : null;
  return record.platform==='tiktok' && record.type==='video' && record.id===discovery.id && record.username?.toLowerCase()===username.toLowerCase()
    && validCount(record.playCount) && validCount(record.likeCount) && published!==null && record.publishedAt===String(published) && discovery.timestamp===published
    && (record.publishedAtUnix===undefined || record.publishedAtUnix===published) && (record.publishedAtISO===undefined || tikTokPublishedTime(record.publishedAtISO)===published)
    && typeof record.collectedAt==='string' && Number.isFinite(Date.parse(record.collectedAt));
}

export async function collectTikTokLatest(browser, {url,limitPerId,onProgress,resumeRecords=[]}) {
  const target = targetUrl(url);
  if (!Number.isSafeInteger(limitPerId)||limitPerId<1||limitPerId>100) throw fail('INVALID_LIMIT','limitPerId must be an integer from 1 to 100.');
  const source = {url:target.url,requestedCount:limitPerId,actualCount:0,discoveredCount:0,status:'blocked',latestVerified:false,loginUsed:false,scrolls:0,coverage:'normal public profile and naturally emitted lists; latest order requires feed evidence',http:null};
  const records=[];const contexts=[];const discovered=new Map();const pages=[];const pending=new Set();const nonVideos=new Set();
  const runStarted=Date.now();const deadline=runStarted+120000;
  let blocked;let latestModeConfirmed=false;let discoveryTermination='scroll-limit';let stage='profile';let responseSequence=0;let acceptingLists=true;
  const upsert = item => {
    if (!item.id || nonVideos.has(item.id) || item.username?.toLowerCase()!==target.username.toLowerCase()) return;
    const old=discovered.get(item.id);discovered.set(item.id,{...old,...item,timestamp:item.timestamp??old?.timestamp??null});
  };
  const watch = page => page.on('response', response => {
    const endpoint=new URL(response.url());
    if (!['www.tiktok.com','tiktok.com'].includes(endpoint.hostname)) return;
    if ([403,429].includes(response.status())) { blocked ??= httpError(response,endpoint.pathname.endsWith('/api/post/item_list/')?'profile-list':stage);return; }
    if (!acceptingLists || !endpoint.pathname.endsWith('/api/post/item_list/') || !response.ok()) return;
    const sequence=responseSequence++;
    const task=(async()=>{
      try {
        const data=await response.json();
        if (!acceptingLists) return;
        if ((data.statusCode??data.status_code??0)!==0) throw fail('LIST_RESPONSE_ERROR','The natural profile list response reports an application error.');
        if (!Array.isArray(data.itemList)) throw fail('LIST_RESPONSE_UNREADABLE','The natural profile response does not contain the expected itemList array.');
        const items=[];
        for (const value of Array.isArray(data.itemList)?data.itemList:[]) {
          const id=idString(value.id);
          if (value.privateItem===true) throw fail('PRIVATE_VIDEO','The natural list identifies a private item; collection stopped.');
          if (value.imagePost) { if (id) {nonVideos.add(id);discovered.delete(id);}continue; }
          if (!value.video) continue;
          if (!id) throw fail('VIDEO_ID_MISMATCH','The natural list contains an imprecise or missing video ID.');
          if (value.author?.uniqueId?.toLowerCase()!==target.username.toLowerCase()) throw fail('AUTHOR_MISMATCH','The natural list contains a video for another author.');
          const item={id,username:value.author.uniqueId,timestamp:tikTokPublishedTime(value.createTime),pinned:value.isPinnedItem===true||value.isPinned===true,source:'natural-profile-response'};
          items.push(item);upsert(item);
        }
        const rawMore=data.hasMore??data.has_more;
        pages.push({sequence,path:endpoint.pathname,requestCursor:endpoint.searchParams.get('cursor'),cursor:cursorString(data.cursor),hasMore:typeof rawMore==='boolean'?rawMore:rawMore===0?false:rawMore===1?true:null,items});
      } catch(error) { if (acceptingLists) blocked ??= error.code ? error : fail('LIST_RESPONSE_UNREADABLE','The natural public video list response could not be decoded.'); }
    })();
    pending.add(task);task.then(()=>pending.delete(task),()=>pending.delete(task));
  });
  try {
    const context=await browser.newContext({javaScriptEnabled:true});contexts.push(context);
    const page=await context.newPage();watch(page);
    source.http={status:await navigate(page,target.url,'profile'),stage:'profile',path:new URL(target.url).pathname,retryAfter:null};
    let emptyPasses=0;
    for (let pass=0;pass<=60;pass++) {
      if (blocked) throw blocked;
      await gates(page);
      const before=discovered.size;
      const snapshot=await page.evaluate(username=>{
        let scope;try{scope=JSON.parse(document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent??'').__DEFAULT_SCOPE__;}catch{}
        const user=scope?.['webapp.user-detail']?.userInfo?.user;
        const active=[...document.querySelectorAll('button[aria-pressed="true"],[role="tab"][aria-selected="true"],[role="button"][aria-current="true"],[data-state="active"]')].map(node=>node.textContent.trim());
        return {username:user?.uniqueId,privateAccount:user?.privateAccount,atBottom:window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-200,latestMode:active.some(text=>/^(latest|recent|newest|最新|最新发布|最近发布)$/i.test(text)),links:[...document.querySelectorAll('a[href]')].map(a=>a.href).filter(value=>{try{const u=new URL(value);return ['www.tiktok.com','tiktok.com'].includes(u.hostname)&&u.pathname.toLowerCase().startsWith('/@'+username.toLowerCase()+'/video/');}catch{return false;}})};
      },target.username);
      if (snapshot.privateAccount===true) throw fail('PRIVATE_PROFILE','The public profile identifies a private account.');
      if (snapshot.username && snapshot.username.toLowerCase()!==target.username.toLowerCase()) throw fail('AUTHOR_MISMATCH','The profile belongs to a different current username.');
      latestModeConfirmed ||= snapshot.latestMode;
      for (const value of snapshot.links) { const video=targetUrl(value,true);upsert({id:video.id,username:video.username,source:'actual-profile-link'}); }
      await Promise.race([Promise.allSettled([...pending]),page.waitForTimeout(750)]);
      if (blocked) throw blocked;
      pages.sort((a,b)=>a.sequence-b.sequence);
      const evidence=assessTikTokLatest(pages,[...discovered.values()],limitPerId,latestModeConfirmed);
      if (evidence.verified && (discovered.size>=limitPerId || pages.at(-1)?.hasMore===false)) { discoveryTermination=evidence.reason;break; }
      emptyPasses=discovered.size===before && snapshot.atBottom?emptyPasses+1:0;
      if (emptyPasses>=3) {discoveryTermination='no-new-public-videos';break;}
      if (pass===60 || Date.now()>=deadline) {discoveryTermination=Date.now()>=deadline?'time-limit':'scroll-limit';break;}
      await page.mouse.wheel(0,Math.max(650,Math.floor((page.viewportSize()?.height??720)*0.85)));
      source.scrolls++;
      await page.waitForTimeout(Math.min(1500,Math.max(1,deadline-Date.now())));
    }
    if (blocked) throw blocked;
    const settleDeadline=Math.min(deadline,Date.now()+2000);
    while(pending.size && Date.now()<settleDeadline && !blocked) {
      let timer;
      await Promise.race([Promise.allSettled([...pending]),new Promise(resolve=>{timer=setTimeout(resolve,Math.min(50,Math.max(1,settleDeadline-Date.now())));})]);
      clearTimeout(timer);
    }
    const discoverySettled=pending.size===0;
    acceptingLists=false;
    await page.close();
    if (blocked) throw blocked;
    const frozenPages=pages.sort((a,b)=>a.sequence-b.sequence).map(value=>({...value,items:value.items.map(item=>({...item}))}));
    const candidates=[...discovered.values()].map(value=>({...value})).sort((a,b)=>(b.timestamp??0)-(a.timestamp??0));
    source.discoverySnapshot={settled:discoverySettled,profileClosedBeforeDetails:true,listResponseCount:frozenPages.length};
    source.discoveredCount=discovered.size;
    if (!discovered.size) throw fail('NO_PUBLIC_VIDEO_LINKS','No public videos were discovered on the normal anonymous profile.');
    const detailContext=await browser.newContext({javaScriptEnabled:false});contexts.push(detailContext);
    const detail=await detailContext.newPage();stage='video-detail';watch(detail);
    for (const candidate of candidates) {
      if (blocked) throw blocked;
      if (Date.now()>=deadline) throw fail('COLLECTION_TIME_LIMIT','The bounded 120-second collection time expired; no further detail requests were made.');
      let record;
      const restored=resumeRecords.find(value=>reusable(value,candidate,target.username));
      if (restored) record={...restored,restoredFromCheckpoint:true};
      else {
        const detailUrl=`https://www.tiktok.com/@${target.username}/video/${candidate.id}`;
        source.http={status:null,stage:'video-detail',path:new URL(detailUrl).pathname,retryAfter:null};
        let value;
        try { value=await detailItem(detail,detailUrl,deadline-Date.now()); }
        catch(error) {
          if (error.code==='NOT_VIDEO') { nonVideos.add(candidate.id);discovered.delete(candidate.id);continue; }
          throw error;
        }
        source.http.status=value.httpStatus;
        if (blocked) throw blocked;
        record=normalizeTikTokVideo(value.item,{expectedUsername:target.username,expectedVideoId:candidate.id});
        const timestamp=tikTokPublishedTime(value.item.createTime);
        if (!timestamp) throw fail('PUBLICATION_TIME_MISSING','The public video does not provide a valid publication time.');
        if (candidate.timestamp && candidate.timestamp!==timestamp) throw fail('PUBLICATION_TIME_MISMATCH','The detail publication time differs from the current natural profile list.');
        candidate.timestamp=timestamp;
        record={...record,publishedAtUnix:timestamp,publishedAtISO:new Date(timestamp*1000).toISOString(),collectedAt:new Date().toISOString(),sourceUrl:target.url};
      }
      candidate.timestamp=tikTokPublishedTime(record.publishedAtUnix??record.publishedAt??record.publishedAtISO);
      records.push(record);records.sort((a,b)=>tikTokPublishedTime(b.publishedAtUnix??b.publishedAt??b.publishedAtISO)-tikTokPublishedTime(a.publishedAtUnix??a.publishedAt??a.publishedAtISO));
      if (onProgress) await onProgress(records.map(value=>({...value})));
      if (blocked) throw blocked;
      if (records.length>=limitPerId) break;
    }
    if (blocked) throw blocked;
    const currentCandidates=candidates.filter(value=>!nonVideos.has(value.id));
    const currentPages=frozenPages.map(value=>({...value,items:value.items.filter(item=>!nonVideos.has(item.id))}));
    const evidence=assessTikTokLatest(currentPages,currentCandidates,limitPerId,latestModeConfirmed);
    const allTimesKnown=currentCandidates.every(value=>value.timestamp!==null);
    source.latestVerified=discoverySettled && evidence.verified && allTimesKnown;
    source.latestEvidence={reason:!discoverySettled?'list-responses-unsettled':source.latestVerified?evidence.reason:allTimesKnown?evidence.reason:'undated-discovered-videos',latestModeConfirmed,initialCursorConfirmed:currentPages[0]?.requestCursor==='0',listResponses:currentPages.map(value=>({requestCursor:value.requestCursor,cursor:value.cursor,hasMore:value.hasMore,count:value.items.length})),discoveryTermination};
    const metricsComplete=records.every(value=>validCount(value.playCount)&&validCount(value.likeCount));
    source.status=records.length===limitPerId && metricsComplete && source.latestVerified?'completed':'partial';
    source.termination=!source.latestVerified?'latest-order-unverified':!metricsComplete?'required-metrics-unavailable':records.length<limitPerId?'list-exhausted':'requested-limit';
  } catch(error) {
    const failure=blocked??error;
    if (['EACCES','EPERM','ENOSPC','EIO','EROFS','ENOENT','EMFILE','ENFILE','EFBIG','EDQUOT'].includes(error.code)) throw error;
    source.status=records.length?'partial':'blocked';source.termination=failure.code??'COLLECTION_FAILED';source.error=failure.message;if(failure.http)source.http=failure.http;
  } finally {
    acceptingLists=false;
    for (const context of contexts) await context.close();
    source.discoveredCount=discovered.size;source.actualCount=records.length;source.collectedAt=new Date().toISOString();source.elapsedMs=Date.now()-runStarted;
  }
  return {records,source};
}
