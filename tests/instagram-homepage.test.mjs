import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInstagramVideos, instagramScriptTexts, collectInstagramHomepage } from '../scripts/instagram-homepage.mjs';

const video = (code = 'AbC_123') => ({ __typename: 'GraphVideo', shortcode: code, id: '99999999999999999999', owner: {username:'Fixture.Creator'}, edge_media_to_caption:{edges:[{node:{text:'Synthetic fixture caption'}}]}, video_view_count:12345, edge_liked_by:{count:42}, edge_media_to_comment:{count:3} });
const options = {expectedUsername:'fixture.creator',limitPerId:3};
const wrapper = value => `(()=>{let s={};s.handle(${JSON.stringify({require:[['fixture',0,0,[{contextJSON:JSON.stringify({context:{graphql_media:value.map(shortcode_media=>({shortcode_media}))}})}]]]})});})();`;

test('decodes literal ServerJS and nested contextJSON without executing scripts', () => {
  const record=extractInstagramVideos([wrapper([video()])],options)[0];
  assert.equal(record.id,'AbC_123');assert.equal(record.idType,'shortcode');assert.equal(record.username,'Fixture.Creator');
  assert.equal(record.viewCount,12345);assert.equal(record.playCount,null);assert.equal(record.likeCount,42);assert.equal(record.commentCount,3);
  assert.ok(record.fieldSources.viewCount.endsWith('.video_view_count'));assert.ok(record.fieldSources.likeCount.endsWith('.edge_liked_by.count'));
  assert.ok(record.fieldSources.id.includes('.decoded-json-string.'));assert.equal(record.caption,'Synthetic fixture caption');
});

test('supports JSON scripts, separate plays/views and count fallbacks with real zero', () => {
  const node={...video(),play_count:0,video_view_count:'99999999999999999999',like_count:0};
  const record=extractInstagramVideos([JSON.stringify(node)],options)[0];
  assert.equal(record.playCount,0);assert.equal(record.viewCount,'99999999999999999999');assert.equal(record.likeCount,0);
  assert.equal(record.fieldSources.playCount,'script[0].json.play_count');
  const missing=extractInstagramVideos([JSON.stringify({...video(),video_view_count:undefined,edge_liked_by:undefined,edge_media_to_comment:undefined})],options)[0];
  assert.equal(missing.viewCount,null);assert.equal(missing.playCount,null);assert.equal(missing.likeCount,null);assert.equal(missing.commentCount,null);
});

test('requires confirmed owner and video type, preserves case-sensitive shortcodes and deduplicates before limit', () => {
  const nodes=[video('AbC'),video('AbC'),video('abc'),{...video('OTHER'),owner:{username:'someone_else'}},{...video('IMAGE'),__typename:'GraphImage'}];
  const records=extractInstagramVideos([JSON.stringify(nodes)],{...options,limitPerId:2});
  assert.deepEqual(records.map(x=>x.id),['AbC','abc']);
  assert.equal(extractInstagramVideos([JSON.stringify(nodes)],options).length,2);
  assert.throws(()=>extractInstagramVideos([JSON.stringify(nodes)],{...options,expectedShortcode:'OTHER'}),{code:'AUTHOR_MISMATCH'});
  assert.deepEqual(extractInstagramVideos([JSON.stringify(nodes)],{...options,expectedShortcode:'ABC'}),[]);
});

test('rejects unbounded limits and never evaluates function expressions or script payloads', () => {
  for(const limitPerId of [0,7,undefined]) assert.throws(()=>extractInstagramVideos([],{...options,limitPerId}),{code:'INVALID_LIMIT'});
  globalThis.__instagramFixtureExecuted=false;
  const scripts=['s.handle((()=>{globalThis.__instagramFixtureExecuted=true;return {}})())','globalThis.__instagramFixtureExecuted=true;', 's.handle({invalid:JSON})'];
  assert.deepEqual(extractInstagramVideos(scripts,options),[]);assert.equal(globalThis.__instagramFixtureExecuted,false);delete globalThis.__instagramFixtureExecuted;
  assert.deepEqual(instagramScriptTexts('<script src="https://example.test/a.js"></script><script type="application/json">{"x":1}</script>'),['','{"x":1}']);
});

test('unsafe numeric counts stay unknown and sensitive page fields are never exported', () => {
  const node={...video(),video_view_count:Number.MAX_SAFE_INTEGER+1,session:{token:'DO_NOT_EXPORT'}};
  const record=extractInstagramVideos([JSON.stringify(node)],options)[0];
  assert.equal(record.viewCount,null);assert.equal(JSON.stringify(record).includes('DO_NOT_EXPORT'),false);
});

test('hidden counts are unknown even when server JSON contains zeros or older visible duplicates', () => {
  const hidden={...video(),like_and_view_counts_disabled:true,play_count:0,video_view_count:0,edge_liked_by:{count:0},edge_media_to_comment:{count:0}};
  for(const nodes of [[hidden],[video(),hidden],[hidden,video()]]) {
    const record=extractInstagramVideos([JSON.stringify(nodes)],options)[0];
    assert.equal(record.playCount,null);assert.equal(record.viewCount,null);assert.equal(record.likeCount,null);
    assert.ok(record.fieldSources.likeCount.endsWith(':hidden'));
  }
  assert.equal(extractInstagramVideos([JSON.stringify(hidden)],options)[0].commentCount,0);
});

test('HTTP 403 blocks immediately without accessing a saved browser context', async () => {
  let closed=0;let goto=0;const settings=[];
  const browser={newContext:async settingsValue=>{settings.push(settingsValue);return {close:async()=>closed++,newPage:async()=>({on(){},goto:async()=>{goto++;return {status:()=>403};}})};}};
  const result=await collectInstagramHomepage(browser,{url:'https://www.instagram.com/fixture.creator/',limitPerId:3});
  assert.equal(result.source.status,'blocked');assert.equal(result.source.termination,'BLOCKED_HTTP_403');assert.equal(result.records.length,0);
  assert.equal(goto,1);assert.equal(closed,1);assert.deepEqual(settings,[{javaScriptEnabled:true}]);
});

test('collector enriches only discovered videos, keeps views separate and reports completed', async () => {
  const visited=[];let current;let closed=0;
  const browser={newContext:async()=>({close:async()=>closed++,newPage:async()=>({on(){},url:()=>current,evaluate:async()=>({challenge:false,login:false}),goto:async url=>{current=url;visited.push(url);return {status:()=>200,text:async()=>`<script>${wrapper([video()])}</script>`};}})})};
  const result=await collectInstagramHomepage(browser,{url:'https://www.instagram.com/fixture.creator/',limitPerId:1});
  assert.equal(result.source.status,'completed');assert.equal(result.source.actualCount,1);assert.equal(result.records[0].viewCount,12345);assert.equal(result.records[0].playCount,null);
  assert.equal(result.source.playCountAvailable,0);assert.ok(result.records[0].fieldSources.viewCount.startsWith('detailEmbed.'));
  assert.deepEqual(visited,['https://www.instagram.com/fixture.creator/embed/?cr=1','https://www.instagram.com/p/AbC_123/embed/?cr=1']);assert.equal(closed,1);
});

test('detail hidden counts clear earlier profile counts and cannot report completed', async () => {
  let current;
  const browser={newContext:async()=>({close:async()=>{},newPage:async()=>({on(){},url:()=>current,evaluate:async()=>({challenge:false,login:false}),goto:async url=>{current=url;const node=url.includes('/p/')?{...video(),like_and_view_counts_disabled:true,video_view_count:0,edge_liked_by:{count:0}}:video();return {status:()=>200,text:async()=>`<script>${wrapper([node])}</script>`};}})})};
  const result=await collectInstagramHomepage(browser,{url:'https://www.instagram.com/fixture.creator/',limitPerId:1});
  assert.equal(result.source.status,'partial');assert.equal(result.source.termination,'required-metrics-unavailable');
  assert.equal(result.records[0].viewCount,null);assert.equal(result.records[0].likeCount,null);assert.ok(result.records[0].fieldSources.likeCount.startsWith('detailEmbed.'));
  assert.equal(result.source.evidence.parserEvaluatedScripts,false);
});

test('response-observed rate limit wins over a generic navigation error', async () => {
  let listener;
  const browser={newContext:async()=>({close:async()=>{},newPage:async()=>({on(event,callback){if(event==='response')listener=callback;},goto:async()=>{listener({url:()=> 'https://www.instagram.com/fixture.creator/embed/',status:()=>429});throw new Error('Navigation failed');}})})};
  const result=await collectInstagramHomepage(browser,{url:'https://www.instagram.com/fixture.creator/',limitPerId:1});
  assert.equal(result.source.status,'blocked');assert.equal(result.source.termination,'BLOCKED_HTTP_429');
});
