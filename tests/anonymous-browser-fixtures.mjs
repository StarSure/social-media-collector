// Independent offline Chrome acceptance. Every unknown network request is aborted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../scripts/browser.mjs';
import { collectAnonymousHomepages, validateAnonymousSpec, findAnonymousBrowser } from '../scripts/anonymous-homepage.mjs';
import { writeCollection } from '../scripts/local-browser.mjs';
export async function runAnonymousBrowserFixtures(options = {}) {
const playwright = options.playwright ?? (await loadPlaywright()).playwright;
const executablePath = options.executablePath ?? await findAnonymousBrowser(playwright);
const browser = await playwright.chromium.launch({ executablePath, headless: true });
const untouched = await browser.newContext();
await untouched.addCookies([{name:'private_session',value:'PRIVATE_COOKIE_SENTINEL',domain:'.tiktok.com',path:'/'}]);
const untouchedPage=await untouched.newPage();
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'anonymous-independent-'));
const outcomes=[];
const sample='https://www.tiktok.com/@fixture_creator';
const id1='9999999999999999991',id2='9999999999999999992';
const embed=ids=>`<!doctype html><body>${ids.map(id=>`<a href="${sample}/video/${id}">Video</a>`).join('')}</body>`;
const detail=(id,change={})=>`<!doctype html><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({secret:'PRIVATE_STATE_SENTINEL',__DEFAULT_SCOPE__:{'webapp.video-detail':{itemInfo:{itemStruct:{id,author:{uniqueId:'fixture_creator'},desc:'Synthetic only',createTime:'1700000000',stats:{playCount:0,diggCount:5},...change}}}}})}</script></body>`;
const spec=()=>validateAnonymousSpec({platform:'tiktok',task:'video',source:'author-links',urls:[sample],limitPerId:2});
const csvParse=text=>{const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}return rows;};
async function scenario(name,fixtures,job,verify){
 const requests=[],created=[];
 const owned={newContext:async options=>{
  assert.equal(Object.hasOwn(options,'storageState'),false);
  const context=await browser.newContext(options);created.push(context);
  assert.deepEqual(await context.cookies(),[]);
  await context.route('**/*',async route=>{
   const req=route.request();requests.push({url:req.url(),cookie:req.headers().cookie??''});
   assert.equal((req.headers().cookie??'').includes('PRIVATE_COOKIE_SENTINEL'),false);
   const fixture=fixtures.get(req.url());if(!fixture)return route.abort();
   return route.fulfill({status:fixture.status??200,contentType:'text/html',body:fixture.body??''});
  });return context;
 }};
 try{
  const result=await collectAnonymousHomepages(job,owned);
  assert.equal(browser.contexts().length,1,'all own contexts closed; pre-existing context retained');
  assert.equal(untouchedPage.isClosed(),false);
  assert.equal((await untouched.cookies())[0].value,'PRIVATE_COOKIE_SENTINEL');
  assert.equal(result.loginUsed,false);assert.equal(result.userSessionRead,false);
  assert.match(result.coverage,/at most 10.*no full-history/);
  assert.equal(JSON.stringify(result).includes('PRIVATE_STATE_SENTINEL'),false);
  await verify(result,requests);
  outcomes.push({name,status:'passed',recordCount:result.recordCount,collectionStatus:result.status});
 }catch(error){outcomes.push({name,status:'failed',error:error.stack});for(const context of created)await context.close().catch(()=>{});}
}
try{
 const base=()=>new Map([['https://www.tiktok.com/embed/@fixture_creator',{body:embed([id1,id1,id2])}],[`${sample}/video/${id1}`,{body:detail(id1)}],[`${sample}/video/${id2}`,{body:detail(id2)}]]);
 await scenario('fresh-context-dedupe-metrics-json-csv',base(),spec(),async result=>{
  assert.equal(result.status,'completed');assert.equal(result.recordCount,2);
  assert.deepEqual(result.records.map(r=>r.id),[id1,id2]);assert.equal(result.records[0].playCount,0);
  const out=await writeCollection(result,directory);
  const json=JSON.parse(await fs.readFile(out.files.dataFile,'utf8'));
  const [header,...rows]=csvParse((await fs.readFile(out.files.csvFile,'utf8')).replace(/^\uFEFF/,''));
  assert.equal(rows.length,json.records.length);assert.equal(header.length,Object.keys(json.records[0]).length);
  for(let i=0;i<rows.length;i++)for(let j=0;j<header.length;j++){
   const v=json.records[i][header[j]];assert.equal(rows[i][j],v==null?'':typeof v==='object'?JSON.stringify(v):String(v));
  }
 });
 const missing=base();missing.set(`${sample}/video/${id2}`,{body:detail(id2,{stats:{playCount:10}})});
 await scenario('missing-like-is-null-partial',missing,spec(),r=>{assert.equal(r.status,'partial');assert.equal(r.records[1].likeCount,null);});
 const short=base();short.set('https://www.tiktok.com/embed/@fixture_creator',{body:embed([id1])});
 await scenario('recent-selection-shortfall-is-partial',short,spec(),r=>{assert.equal(r.status,'partial');assert.equal(r.recordCount,1);});
 const multi=base();multi.set('https://www.tiktok.com/embed/@fixture_creator',{body:embed([id1])});
 const next='https://www.tiktok.com/@next_creator';
 multi.set('https://www.tiktok.com/embed/@next_creator',{body:embed(['8881','8882']).replaceAll(sample,next)});
 for(const id of ['8881','8882'])multi.set(`${next}/video/${id}`,{body:detail(id,{author:{uniqueId:'next_creator'}})});
 await scenario('normal-partial-does-not-stop-next-account',multi,{...spec(),urls:[sample,next]},r=>{assert.equal(r.status,'partial');assert.equal(r.processedSources,2);assert.equal(r.recordCount,3);});
 for(const status of [403,429]){
  const denied=base();denied.set(`${sample}/video/${id2}`,{status,body:'<!doctype html><body>Access denied or rate limited</body>'});
  await scenario(`http${status}-stops-whole-batch`,denied,{...spec(),urls:[sample,'https://www.tiktok.com/@next_creator']},(r,requests)=>{assert.equal(r.status,'partial');assert.equal(r.processedSources,1);assert.equal(requests.some(x=>x.url.includes('next_creator')),false);assert.equal(r.sources[0].termination,`BLOCKED_HTTP_${status}`,JSON.stringify(r.sources));});
 }
 for(const status of [403,429]){
  const denied=base();denied.set(`${sample}/video/${id2}`,{status});
  await scenario(`empty-http${status}-keeps-diagnosis`,denied,spec(),r=>{assert.equal(r.status,'partial');assert.equal(r.sources[0].termination,`BLOCKED_HTTP_${status}`,JSON.stringify(r.sources));});
 }
 for(const [name,change,code]of [['wrong-author',{author:{uniqueId:'other_creator'}},'AUTHOR_MISMATCH'],['wrong-video-id',{id:'123'},'VIDEO_ID_MISMATCH']]){
  const invalid=base();invalid.set(`${sample}/video/${id1}`,{body:detail(id1,change)});
  await scenario(name,invalid,spec(),r=>{assert.equal(r.status,'blocked');assert.equal(r.recordCount,0);assert.equal(r.sources[0].termination,code);});
 }
 const challenge=base();challenge.set('https://www.tiktok.com/embed/@fixture_creator',{body:'<body>Verify that you are human</body>'});
 await scenario('challenge-stops-before-detail',challenge,spec(),(r,requests)=>{assert.equal(r.status,'blocked');assert.equal(requests.length,1);assert.equal(r.sources[0].termination,'CHALLENGE_REQUIRED');});
 const result = {status:'passed',mode:'offline-only-all-network-intercepted',outcomes};
 assert.equal(outcomes.every(x=>x.status==='passed'),true,JSON.stringify(result,null,2));
 return result;
}finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAnonymousBrowserFixtures().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
