import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTikTokHomepage, normalizeTikTokVideo, selectTikTokVideoLinks, collectTikTokHomepage } from '../scripts/tiktok-homepage.mjs';

const expected = { expectedUsername: 'fixture_creator', expectedVideoId: '9999999999999999999' };
const fixture = () => ({ id: expected.expectedVideoId, author: {uniqueId:'Fixture_Creator'}, desc:'Synthetic video', createTime:'1700000000', video:{duration:15}, stats:{playCount:1500,diggCount:30,commentCount:4}, statsV2:{playCount:'1500',diggCount:'30'} });

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

test('HTTP denial stops immediately and closes fresh anonymous contexts', async () => {
  const settings=[];let closed=0;let navigations=0;
  const browser={newContext:async options=>{settings.push(options);return {newPage:async()=>({on(){},goto:async()=>{navigations++;return {status:()=>429};}}),close:async()=>{closed++;}};}};
  const result=await collectTikTokHomepage(browser,{url:'https://www.tiktok.com/@fixture_creator',limitPerId:3});
  assert.equal(result.source.status,'blocked');assert.equal(result.records.length,0);assert.equal(result.source.termination,'BLOCKED_HTTP_429');
  assert.equal(navigations,1);assert.equal(closed,2);assert.deepEqual(settings,[{javaScriptEnabled:true},{javaScriptEnabled:false}]);
});

test('a later detail mismatch preserves earlier verified records and reports partial', async () => {
  let contextNumber=0;let closed=0;let detailReads=0;
  const browser={newContext:async()=>{
    const isEmbed=contextNumber++===0;let current;
    return {close:async()=>{closed++;},newPage:async()=>({
      on(){},url:()=>current,goto:async url=>{current=url;return {status:()=>200};},
      evaluate:async callback=>{
        const source=String(callback);
        if(source.includes('const text = document.body'))return {challenge:false,login:false};
        if(isEmbed)return [`https://www.tiktok.com/@fixture_creator/video/${expected.expectedVideoId}`,'https://www.tiktok.com/@fixture_creator/video/123'];
        return detailReads++===0?fixture():{...fixture(),id:'different'};
      },
    })};
  }};
  const result=await collectTikTokHomepage(browser,{url:'https://www.tiktok.com/@fixture_creator',limitPerId:2});
  assert.equal(result.source.status,'partial');assert.equal(result.source.requestedCount,2);assert.equal(result.source.actualCount,1);
  assert.equal(result.source.termination,'VIDEO_ID_MISMATCH');assert.equal(result.records[0].id,expected.expectedVideoId);assert.equal(closed,2);
});
