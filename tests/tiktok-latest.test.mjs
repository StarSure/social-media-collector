import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {collectTikTokLatest,resolveTikTokVideoAuthor,assessTikTokLatest,tikTokPublishedTime} from '../scripts/tiktok-latest.mjs';

const profile='https://www.tiktok.com/@fixture_creator';
const item=(id='9999999999999999999',time=1700000300,extra={})=>({id,createTime:String(time),author:{uniqueId:'fixture_creator'},video:{duration:12},desc:'Synthetic video',privateItem:false,statsV2:{playCount:'100',diggCount:'5'},...extra});
const candidate=(id,time,pinned=false)=>({id,username:'fixture_creator',timestamp:time,pinned});

function fakeBrowser({lists=[],initialLists=1,latest=true,domLinks=[],detailItems={},detailResponses=[],navigationError,navStatus=200,challenge=false,login=false}={}) {
  const audit={contexts:[],closed:0,scrolls:0,details:[],profileNavigations:0,profileClosed:0};
  const browser={newContext:async options=>{
    audit.contexts.push(options);const detail=options.javaScriptEnabled===false;let current;let responseListener;let listIndex=0;let scrollY=0;
    const response=(url,status=200,data)=>({url:()=>url,status:()=>status,ok:()=>status>=200&&status<300,headers:()=>status===429?{'retry-after':'45'}:{},json:async()=>data?.jsonPromise?await data.jsonPromise:data});
    const emitList=()=>{const list=lists[listIndex++];if(list)responseListener?.(response(`https://www.tiktok.com/api/post/item_list/?cursor=${list.requestCursor??'0'}&count=30`,list.httpStatus??200,list));};
    if(!detail)audit.emitProfileList=list=>responseListener?.(response(`https://www.tiktok.com/api/post/item_list/?cursor=${list.requestCursor??'0'}&count=30`,list.httpStatus??200,list));
    return {close:async()=>{audit.closed++;},newPage:async()=>({
      on(name,callback){if(name==='response')responseListener=callback;},url:()=>current,viewportSize:()=>({height:720,width:1280}),waitForTimeout:async()=>{},
      close:async()=>{if(!detail)audit.profileClosed++;},
      mouse:{wheel:async()=>{audit.scrolls++;scrollY=1000;emitList();}},
      goto:async url=>{
        current=url;
        if(detail){audit.details.push(url);assert.ok(audit.profileClosed>0 || audit.profileNavigations===0,'Profile must close before details begin');for(const value of detailResponses)responseListener?.(response(value.url,value.status));return response(url);}
        audit.profileNavigations++;responseListener?.(response(url,navStatus));
        if(navigationError)throw Object.assign(new Error('Navigation failed'),{name:navigationError});
        for(let index=0;index<initialLists;index++)emitList();return response(url,navStatus);
      },
      evaluate:async(callback,arg)=>{
        const id=current?.match(/\/video\/(\d+)/)?.[1];
        const data=detail?{__DEFAULT_SCOPE__:{'webapp.video-detail':{itemInfo:{itemStruct:detailItems[id]??item(id)}}}}:{__DEFAULT_SCOPE__:{'webapp.user-detail':{userInfo:{user:{uniqueId:'fixture_creator',privateAccount:false}}}}};
        const document={
          body:{innerText:login?'Log in to continue':''},documentElement:{scrollHeight:1500},
          getElementById:()=>({textContent:JSON.stringify(data)}),
          querySelectorAll:selector=>{
            if(selector==='a[href]')return domLinks.map(href=>({href}));
            if(selector.includes('captcha'))return challenge?[{getClientRects:()=>[1]}]:[];
            if(selector.includes('aria-pressed'))return latest?[{textContent:'Latest'}]:[];
            return [];
          },
        };
        return runInNewContext(`(${callback.toString()})(arg)`,{arg,document,window:{scrollY,innerHeight:720},location:{pathname:new URL(current).pathname},URL});
      },
    })};
  }};
  return {browser,audit};
}

test('latest evidence requires a cursor-zero chain, not merely a sorted subset',()=>{
  const values=[candidate('1',300),candidate('2',290)];
  assert.equal(assessTikTokLatest([],values,2,true).verified,false);
  assert.equal(assessTikTokLatest([{requestCursor:'99',cursor:'100',hasMore:false,items:values}],values,2,true).verified,false);
  assert.equal(assessTikTokLatest([{requestCursor:'0',cursor:'10',hasMore:true,items:values}],values,2,false).verified,false);
  assert.equal(assessTikTokLatest([{requestCursor:'0',cursor:'10',hasMore:true,items:values},{requestCursor:'wrong',cursor:'20',hasMore:false,items:[]}],values,2,true).verified,false);
});

test('an old pinned item cannot fill the newest quota before a chronological frontier',()=>{
  const first=[candidate('old-pin',10,true),candidate('new-1',300),candidate('new-2',290)];
  const pages=[{requestCursor:'0',cursor:'A',hasMore:true,items:first}];
  assert.equal(assessTikTokLatest(pages,first,3,true).verified,false);
  const next=[candidate('new-3',280)];
  pages.push({requestCursor:'A',cursor:'B',hasMore:true,items:next});
  assert.equal(assessTikTokLatest(pages,[...first,...next],3,true).verified,true);
  const wrongOrder=[candidate('1',100),candidate('2',300)];
  assert.equal(assessTikTokLatest([{requestCursor:'0',cursor:'1',hasMore:true,items:wrongOrder}],wrongOrder,2,true).verified,false);
});

test('a fully enumerated feed may be sorted even when Latest mode is not exposed',()=>{
  const values=[candidate('old',10,true),candidate('new',300)];
  assert.equal(assessTikTokLatest([{requestCursor:'0',cursor:'1',hasMore:false,items:values}],values,2,false).verified,true);
  assert.equal(assessTikTokLatest([{requestCursor:'0',cursor:'1',hasMore:false,items:values}],[...values,candidate('not-in-response',500)],2,false).verified,false);
});

test('20 complete naturally listed videos can be verified and ordered by actual detail timestamps',async()=>{
  const values=Array.from({length:20},(_,index)=>item(String(index+1),1700000300-index));
  const detailItems=Object.fromEntries(values.map(value=>[value.id,value]));
  const {browser,audit}=fakeBrowser({latest:false,lists:[{cursor:'1',hasMore:false,itemList:[values.at(-1),...values.slice(0,-1)]}],detailItems});
  const result=await collectTikTokLatest(browser,{url:profile,limitPerId:20});
  assert.equal(result.source.status,'completed');assert.equal(result.source.latestVerified,true);assert.equal(result.records.length,20);
  assert.deepEqual(result.records.map(value=>value.id),values.map(value=>value.id));assert.equal(audit.details.length,20);assert.equal(audit.scrolls,0);
});

test('collector follows natural pagination and excludes old pinned video from latest quota',async()=>{
  const newest=item('9999999999999999999',1700000300),next=item('2',1700000200),old=item('1',1700000000,{isPinnedItem:true});
  const {browser,audit}=fakeBrowser({lists:[{requestCursor:'0',cursor:'A',hasMore:true,itemList:[old,newest]},{requestCursor:'A',cursor:'B',hasMore:true,itemList:[next]}],detailItems:{[newest.id]:newest,'2':next,'1':old}});
  const progress=[];
  const result=await collectTikTokLatest(browser,{url:profile,limitPerId:2,onProgress:async records=>progress.push(records.map(x=>x.id))});
  assert.equal(result.source.status,'completed');assert.equal(result.source.latestVerified,true);
  assert.deepEqual(result.records.map(x=>x.id),[newest.id,'2']);assert.equal(result.records[0].playCount,100);
  assert.equal(result.records[0].publishedAtISO,new Date(1700000300*1000).toISOString());
  assert.equal(audit.scrolls,1);assert.equal(audit.details.length,2);assert.deepEqual(progress,[[newest.id],[newest.id,'2']]);assert.equal(audit.closed,2);
});

test('20 distinct DOM videos alone remain partial rather than proving newest order',async()=>{
  const detailItems={};const domLinks=[];
  for(let n=1;n<=20;n++){detailItems[String(n)]=item(String(n),1700000300-n);domLinks.push(`${profile}/video/${n}`);}
  const {browser}=fakeBrowser({lists:[],latest:false,domLinks,detailItems});
  const result=await collectTikTokLatest(browser,{url:profile,limitPerId:20});
  assert.equal(result.records.length,20);assert.equal(result.source.latestVerified,false);assert.equal(result.source.status,'partial');assert.equal(result.source.termination,'latest-order-unverified');
});

test('safe resume reuses only currently discovered complete same-author records',async()=>{
  const current=item('11',1700000300);
  const {browser,audit}=fakeBrowser({lists:[{cursor:'1',hasMore:false,itemList:[current]}],detailItems:{'11':current}});
  const old={platform:'tiktok',type:'video',id:'11',username:'fixture_creator',publishedAt:'1700000300',playCount:99,likeCount:4,collectedAt:'2026-10-20T01:00:00Z'};
  const result=await collectTikTokLatest(browser,{url:profile,limitPerId:1,resumeRecords:[{...old,id:'not-current'},old]});
  assert.equal(result.source.status,'completed');assert.equal(audit.profileNavigations,1);assert.equal(audit.details.length,0);
  assert.equal(result.records[0].collectedAt,old.collectedAt);assert.equal(result.records[0].restoredFromCheckpoint,true);
  const incomplete=fakeBrowser({lists:[{cursor:'1',hasMore:false,itemList:[current]}],detailItems:{'11':current}});
  const checked=await collectTikTokLatest(incomplete.browser,{url:profile,limitPerId:1,resumeRecords:[{...old,likeCount:null}]});
  assert.equal(incomplete.audit.details.length,1);assert.equal(checked.records[0].restoredFromCheckpoint,undefined);
  for(const changed of [{...old,publishedAt:'2023-11-14T22:18:20Z'},{...old,publishedAt:'1700000000'},{...old,publishedAtUnix:1700000001}]){
    const fresh=fakeBrowser({lists:[{cursor:'1',hasMore:false,itemList:[current]}],detailItems:{'11':current}});
    const result=await collectTikTokLatest(fresh.browser,{url:profile,limitPerId:1,resumeRecords:[changed]});
    assert.equal(fresh.audit.details.length,1);assert.equal(result.records[0].restoredFromCheckpoint,undefined);
  }
});

test('timeout and first HTTP gate stop without scrolling, details or alternate requests',async()=>{
  for(const config of [{navigationError:'TimeoutError'},{navStatus:429,navigationError:'Error'},{login:true},{challenge:true}]){
    const {browser,audit}=fakeBrowser(config);
    const result=await collectTikTokLatest(browser,{url:profile,limitPerId:20});
    assert.equal(result.source.status,'blocked');assert.equal(result.records.length,0);assert.equal(audit.profileNavigations,1);assert.equal(audit.details.length,0);assert.equal(audit.scrolls,0);
    if(config.navigationError==='TimeoutError')assert.equal(result.source.termination,'NAVIGATION_TIMEOUT');
    if(config.navStatus===429){assert.equal(result.source.termination,'BLOCKED_HTTP_429');assert.equal(result.source.http.retryAfter,'45');}
    if(config.login)assert.equal(result.source.termination,'LOGIN_REQUIRED');if(config.challenge)assert.equal(result.source.termination,'CHALLENGE_REQUIRED');
  }
});

test('detail author, ID, video type and publication time are independently required',async()=>{
  const current=item('15',1700000300);
  const bad=[{...current,author:{uniqueId:'other'}},{...current,id:'16'},{...current,privateItem:true},{...current,privateItem:true,imagePost:true},{...current,createTime:null},{...current,createTime:'1700000001'}];
  for(const value of bad){
    const {browser}=fakeBrowser({lists:[{cursor:'1',hasMore:false,itemList:[current]}],detailItems:{'15':value}});
    const result=await collectTikTokLatest(browser,{url:profile,limitPerId:1});assert.equal(result.source.status,'blocked');assert.equal(result.records.length,0);
  }
});

test('source video author resolution trusts current matching-ID SSR, not stale URL author',async()=>{
  const {browser,audit}=fakeBrowser({detailItems:{'123':item('123')},detailResponses:[{url:'https://third-party.example/pixel',status:403}]});
  const result=await resolveTikTokVideoAuthor(browser,'https://www.tiktok.com/@old_name/video/123?session=discard');
  assert.deepEqual(result,{url:profile,username:'fixture_creator',videoId:'123',sourceVideoUrl:'https://www.tiktok.com/@old_name/video/123',httpStatus:200});
  assert.deepEqual(audit.contexts,[{javaScriptEnabled:false}]);assert.equal(audit.closed,1);
  await assert.rejects(resolveTikTokVideoAuthor(browser,'https://www.tiktok.com.attacker.test/@old_name/video/123'),{code:'INVALID_URL'});
  assert.equal(tikTokPublishedTime('invalid-date'),null);
});

test('invalid limits are rejected before any browser context is created',async()=>{
  const {browser,audit}=fakeBrowser();
  for(const limitPerId of [0,101,1.2])await assert.rejects(collectTikTokLatest(browser,{url:profile,limitPerId}),{code:'INVALID_LIMIT'});
  assert.equal(audit.contexts.length,0);
});

test('late profile responses during details cannot change the frozen selection or latest proof',async()=>{
  const first=item('21',1700000300),second=item('22',1700000200),newer=item('23',1700000400);
  const {browser,audit}=fakeBrowser({latest:false,lists:[{cursor:'A',hasMore:true,itemList:[first,second]}],detailItems:{'21':first,'22':second}});
  const result=await collectTikTokLatest(browser,{url:profile,limitPerId:2,onProgress:async()=>audit.emitProfileList({requestCursor:'A',cursor:'B',hasMore:false,itemList:[newer]})});
  assert.equal(result.source.latestVerified,false);assert.equal(result.source.status,'partial');assert.deepEqual(result.records.map(value=>value.id),['21','22']);
  assert.equal(result.source.discoveredCount,2);assert.equal(result.source.latestEvidence.listResponses.length,1);assert.equal(audit.profileClosed,1);
});

test('an unresolved observed list body prevents latest verification after the bounded freeze',async()=>{
  let resolveLate;
  const late=new Promise(resolve=>{resolveLate=resolve;});
  const current=item('31',1700000300),newer=item('32',1700000400);
  const {browser}=fakeBrowser({initialLists:2,lists:[{cursor:'A',hasMore:true,itemList:[current]},{requestCursor:'A',jsonPromise:late}],detailItems:{'31':current}});
  const result=await collectTikTokLatest(browser,{url:profile,limitPerId:1,onProgress:async()=>{resolveLate({cursor:'B',hasMore:false,itemList:[newer]});}});
  assert.equal(result.source.discoverySnapshot.settled,false);assert.equal(result.source.latestVerified,false);assert.equal(result.source.latestEvidence.reason,'list-responses-unsettled');
  assert.deepEqual(result.records.map(value=>value.id),['31']);assert.equal(result.source.discoveredCount,1);
});

test('known image-post IDs cannot reenter from DOM links',async()=>{
  const photo=item('41',1700000400,{imagePost:{images:[{}]}}),video=item('42',1700000300);
  const {browser,audit}=fakeBrowser({lists:[{cursor:'A',hasMore:false,itemList:[photo,video]}],domLinks:[`${profile}/video/41`,`${profile}/video/42`],detailItems:{'42':video}});
  const result=await collectTikTokLatest(browser,{url:profile,limitPerId:1});
  assert.equal(result.source.status,'completed');assert.equal(result.source.discoveredCount,1);assert.deepEqual(result.records.map(value=>value.id),['42']);
  assert.deepEqual(audit.details,[`${profile}/video/42`]);
});

test('a DOM-only detail confirmed as an image post is excluded while video quota continues',async()=>{
  const photo=item('51',1700000400,{imagePost:true}),video=item('52',1700000300);
  const {browser,audit}=fakeBrowser({domLinks:[`${profile}/video/51`,`${profile}/video/52`],detailItems:{'51':photo,'52':video}});
  const result=await collectTikTokLatest(browser,{url:profile,limitPerId:1});
  assert.equal(result.source.status,'partial');assert.equal(result.source.termination,'latest-order-unverified');assert.deepEqual(result.records.map(value=>value.id),['52']);
  assert.equal(result.source.discoveredCount,1);assert.equal(audit.details.length,2);
});

test('checkpoint file I/O failures propagate to the runner after closing owned contexts',async()=>{
  const current=item('61');const {browser,audit}=fakeBrowser({lists:[{cursor:'A',hasMore:false,itemList:[current]}],detailItems:{'61':current}});
  await assert.rejects(collectTikTokLatest(browser,{url:profile,limitPerId:1,onProgress:async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}}),{code:'ENOSPC'});
  assert.equal(audit.closed,2);
});
