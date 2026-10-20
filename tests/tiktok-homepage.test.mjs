import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTikTokHomepage, normalizeTikTokVideo, selectTikTokVideoLinks, selectTikTokEmbedVideoLinks, collectTikTokHomepage, validateTikTokOembed } from '../scripts/tiktok-homepage.mjs';

const expected = { expectedUsername: 'fixture_creator', expectedVideoId: '9999999999999999999' };
const fixture = () => ({ id: expected.expectedVideoId, author: {uniqueId:'Fixture_Creator'}, desc:'Synthetic video', createTime:'1700000000', video:{duration:15}, stats:{playCount:1500,diggCount:30,commentCount:4}, statsV2:{playCount:'1500',diggCount:'30'} });
const profileUrl = 'https://www.tiktok.com/@fixture_creator';
const oembed = () => ({ author_url:profileUrl, html:'<blockquote class="tiktok-embed" data-unique-id="fixture_creator" data-embed-type="creator"></blockquote><script async src="https://www.tiktok.com/embed.js"></script>' });

test('homepage only accepts exact public hosts, a profile and a bounded recent selection', () => {
  assert.equal(parseTikTokHomepage('https://www.tiktok.com/@fixture_creator?secret=discard',3).embedUrl,'https://www.tiktok.com/embed/@fixture_creator');
  for(const limit of [0,11,1.5,undefined]) assert.throws(()=>parseTikTokHomepage('https://www.tiktok.com/@fixture_creator',limit),{code:'INVALID_LIMIT'});
  for(const url of ['https://www.tiktok.com.attacker.example/@fixture_creator','https://name:password@www.tiktok.com/@fixture_creator','https://www.tiktok.com/@fixture_creator/video/123']) assert.throws(()=>parseTikTokHomepage(url,1),{code:'INVALID_URL'});
});

test('keeps string video IDs intact and distinguishes metrics from creator totals', () => {
  const item=fixture();item.authorStats={heartCount:999999};item.csrfToken='DO_NOT_EXPORT';
  const record=normalizeTikTokVideo(item,expected);
  assert.equal(record.id,'9999999999999999999');assert.equal(record.playCount,1500);assert.equal(record.likeCount,30);
  assert.equal(record.metricSources.playCount,'statsV2.playCount');assert.equal(record.metricSources.commentCount,'stats.commentCount');
  assert.equal(record.shareCount,null);assert.equal(record.collectCount,null);assert.equal(JSON.stringify(record).includes('DO_NOT_EXPORT'),false);
});

test('missing metrics remain null and real zero survives fallback without precision loss', () => {
  const item=fixture();item.statsV2={playCount:'0',diggCount:'99999999999999999999'};item.stats={playCount:1500};
  const record=normalizeTikTokVideo(item,expected);
  assert.equal(record.playCount,0);assert.equal(record.likeCount,'99999999999999999999');assert.equal(record.commentCount,null);
});

test('rejects ID or author mismatch, absent detail and unsafe numeric IDs', () => {
  assert.throws(()=>normalizeTikTokVideo({...fixture(),id:'123'},expected),{code:'VIDEO_ID_MISMATCH'});
  assert.throws(()=>normalizeTikTokVideo({...fixture(),author:{uniqueId:'other'}},expected),{code:'AUTHOR_MISMATCH'});
  assert.throws(()=>normalizeTikTokVideo(null,expected),{code:'VIDEO_ID_MISMATCH'});
  assert.throws(()=>normalizeTikTokVideo({...fixture(),id:Number.MAX_SAFE_INTEGER+1},expected),{code:'VIDEO_ID_MISMATCH'});
});

test('discovers only actual public video links, strips queries and deduplicates IDs', () => {
  const links=['https://www.tiktok.com/@fixture_creator/video/9999999999999999999?token=discard','https://www.tiktok.com/@Fixture_Creator/video/9999999999999999999','https://www.tiktok.com.attacker.example/@fixture_creator/video/3','https://www.tiktok.com/@fixture_creator/video/2'];
  assert.deepEqual(selectTikTokVideoLinks(links,'fixture_creator',2).map(x=>x.id),['9999999999999999999','2']);
  assert.equal(selectTikTokVideoLinks(links,'fixture_creator',1)[0].url.includes('?'),false);
  assert.throws(()=>selectTikTokVideoLinks(['https://www.tiktok.com/@other/video/2'],'fixture_creator',1),{code:'AUTHOR_MISMATCH'});
});

test('official oEmbed must identify the requested author in both response and markup', () => {
  assert.throws(()=>validateTikTokOembed({...oembed(),author_url:'https://www.tiktok.com/@someone_else'},profileUrl),{code:'OEMBED_IDENTITY_MISMATCH'});
  assert.throws(()=>validateTikTokOembed({...oembed(),html:oembed().html.replace('data-unique-id="fixture_creator"','data-unique-id="someone_else"')},profileUrl),{code:'OEMBED_IDENTITY_MISMATCH'});
  assert.throws(()=>validateTikTokOembed({...oembed(),author_url:'https://www.tiktok.com.attacker.example/@fixture_creator'},profileUrl),{code:'OEMBED_IDENTITY_MISMATCH'});
});

const creatorState = videos => ({ source: { data: { '/embed/@fixture_creator?dynamic=sdk-value': { isReady: true, isError: false, userInfo: { uniqueId: 'fixture_creator', privateAccount: false }, videoList: videos } } } });
const embeddedItem = id => ({ id, authorUniqueId: 'fixture_creator', privateItem: false });

test('creator JSON discovers actual public IDs without DOM links or fixed dynamic keys', () => {
  const state = creatorState([{ ...embeddedItem('1'), privateItem: true }, embeddedItem(expected.expectedVideoId), embeddedItem(expected.expectedVideoId), embeddedItem('2')]);
  assert.deepEqual(selectTikTokEmbedVideoLinks(state, 'fixture_creator', 2).map(item => item.id), [expected.expectedVideoId, '2']);
  assert.deepEqual(selectTikTokEmbedVideoLinks(null, 'fixture_creator', 2), []);
});

test('creator JSON rejects private profiles, mixed authors and imprecise IDs', () => {
  const state = creatorState([embeddedItem('1')]);
  Object.values(state.source.data)[0].userInfo.privateAccount = true;
  Object.values(state.source.data)[0].isReady = false;
  assert.throws(() => selectTikTokEmbedVideoLinks(state, 'fixture_creator', 1), { code: 'PRIVATE_PROFILE' });
  assert.throws(() => selectTikTokEmbedVideoLinks(creatorState([{ ...embeddedItem('1'), authorUniqueId: 'other' }]), 'fixture_creator', 1), { code: 'AUTHOR_MISMATCH' });
  assert.throws(() => selectTikTokEmbedVideoLinks(creatorState([embeddedItem(Number.MAX_SAFE_INTEGER + 1)]), 'fixture_creator', 1), { code: 'VIDEO_ID_MISMATCH' });
});

test('creator JSON ignores other authors and entries not ready for collection', () => {
  const state = creatorState([embeddedItem('1')]);
  const entry = Object.values(state.source.data)[0];
  entry.isReady = false;
  assert.deepEqual(selectTikTokEmbedVideoLinks(state, 'fixture_creator', 1), []);
  entry.isReady = true; entry.userInfo.uniqueId = 'other';
  assert.deepEqual(selectTikTokEmbedVideoLinks(state, 'fixture_creator', 1), []);
});

test('controlled mount markup discards returned inline scripts, event handlers and external content', () => {
  globalThis.__oembedFixtureExecuted=false;
  const untrusted=oembed().html.replace('<blockquote ','<blockquote onclick="globalThis.__oembedFixtureExecuted=true" ')
    + '<script>globalThis.__oembedFixtureExecuted=true</script><img src="https://attacker.example/pixel">';
  const safe=validateTikTokOembed({...oembed(),html:untrusted},profileUrl);
  assert.equal(globalThis.__oembedFixtureExecuted,false);delete globalThis.__oembedFixtureExecuted;
  assert.equal(safe.includes('__oembedFixtureExecuted'),false);assert.equal(safe.includes('onclick'),false);assert.equal(safe.includes('attacker.example'),false);
  assert.equal((safe.match(/<script\b/g)||[]).length,1);assert.ok(safe.includes('src="https://www.tiktok.com/embed.js"'));
  assert.ok(safe.includes(`cite="${profileUrl}"`));assert.ok(safe.includes('data-unique-id="fixture_creator"'));
});

test('oEmbed HTTP 429 preserves Retry-After and stops before mounting or requesting videos', async () => {
  const settings=[];let closed=0;let pageCreations=0;let requests=0;
  const browser={newContext:async options=>{settings.push(options);return {
    request:{get:async(url,options)=>{requests++;assert.equal(url,`https://www.tiktok.com/oembed?url=${encodeURIComponent(profileUrl)}`);assert.equal(options.maxRedirects,0);return {status:()=>429,headers:()=>({'retry-after':'120'})};}},
    newPage:async()=>{pageCreations++;throw new Error('No page should be mounted after oEmbed 429');},close:async()=>{closed++;},
  };}};
  const result=await collectTikTokHomepage(browser,{url:profileUrl,limitPerId:3});
  assert.equal(result.source.status,'blocked');assert.equal(result.records.length,0);assert.equal(result.source.termination,'BLOCKED_HTTP_429');
  assert.deepEqual(result.source.http,{status:429,stage:'oembed',path:'/oembed',retryAfter:'120'});
  assert.equal(requests,1);assert.equal(pageCreations,0);assert.equal(closed,2);assert.deepEqual(settings,[{javaScriptEnabled:true},{javaScriptEnabled:false}]);
});

test('oEmbed non-rate error preserves the public explanation without exporting unrelated fields', async () => {
  const browser={newContext:async()=>({
    request:{get:async()=>({status:()=>400,ok:()=>false,headers:()=>({}),json:async()=>({message:'Something went wrong',cookie:'DO_NOT_EXPORT'})})},
    newPage:async()=>{throw new Error('No page should be created after HTTP400');},close:async()=>{},
  })};
  const result=await collectTikTokHomepage(browser,{url:profileUrl,limitPerId:1});
  assert.equal(result.source.termination,'OEMBED_HTTP_ERROR');
  assert.deepEqual(result.source.oembedError,{message:'Something went wrong'});
  assert.deepEqual(result.source.http,{status:400,stage:'oembed',path:'/oembed',retryAfter:null});
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'),false);
});

test('a later detail mismatch preserves earlier verified records and reports partial', async () => {
  let contextNumber=0;let closed=0;let detailReads=0;const topLevelNavigations=[];
  const frame={url:()=> 'https://www.tiktok.com/embed/@fixture_creator?sentinel=sdk-created',evaluate:async callback=>String(callback).includes('const text = document.body')?{challenge:false,login:false}:String(callback).includes('__FRONTITY_CONNECT_STATE__')?null:[`https://www.tiktok.com/@fixture_creator/video/${expected.expectedVideoId}`,'https://www.tiktok.com/@fixture_creator/video/123']};
  const browser={newContext:async()=>{
    const isEmbed=contextNumber++===0;let current;
    return {request:{get:async()=>({status:()=>200,ok:()=>true,json:async()=>oembed()})},close:async()=>{closed++;},newPage:async()=>({
      on(){},url:()=>current,frames:()=>isEmbed?[frame]:[],goto:async url=>{current=url;topLevelNavigations.push(url);if(isEmbed)assert.equal(new URL(url).hostname,'127.0.0.1');return {status:()=>200};},
      evaluate:async callback=>{
        const source=String(callback);
        if(source.includes('const text = document.body'))return {challenge:false,login:false};
        return detailReads++===0?fixture():{...fixture(),id:'different'};
      },
    })};
  }};
  const result=await collectTikTokHomepage(browser,{url:'https://www.tiktok.com/@fixture_creator',limitPerId:2});
  assert.equal(result.source.status,'partial');assert.equal(result.source.requestedCount,2);assert.equal(result.source.actualCount,1);
  assert.equal(result.source.termination,'VIDEO_ID_MISMATCH');assert.equal(result.records[0].id,expected.expectedVideoId);assert.equal(closed,2);
  assert.equal(topLevelNavigations.length,3);assert.equal(topLevelNavigations.some(url=>new URL(url).pathname.startsWith('/embed/')),false);
  assert.equal(result.source.evidence.discovery,'official-oembed-to-sdk-created-iframe');
});
