import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
if(!process.env.CAMERY_BROWSER_DRIVER||!process.env.CAMERY_BROWSER_EXECUTABLE)throw new Error('Explicit installed browser driver and executable paths are required');
const mode=process.argv[3]??'main';if(!['main','warnings'].includes(mode))throw new Error('Unknown owned browser journey');
const {chromium}=require(process.env.CAMERY_BROWSER_DRIVER),baseOutput=resolve('../../artifacts/delivery/outline-adoption-browser'),output=mode==='warnings'?resolve(baseOutput,'warnings'):baseOutput;
await mkdir(output,{recursive:true});
let sequence=0;
async function control(action,parameters={}){const id=++sequence;return new Promise((accept,reject)=>{const timer=setTimeout(()=>{process.off('message',receive);reject(new Error('Owned browser control timed out'));},10000);const receive=value=>{if(value.id!==id)return;clearTimeout(timer);process.off('message',receive);if(value.error)reject(new Error('Owned browser control failed'));else accept(value.data);};process.on('message',receive);process.send({...parameters,id,action});});}
const fixture=await control('fixture'),browser=await chromium.launch({headless:true,executablePath:process.env.CAMERY_BROWSER_EXECUTABLE});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),results=[],errors=[],posts=[],routeFailures=[];
let failed=false,failure,report;
// Route assertions must reach the main journey instead of becoming an unhandled rejection during browser cleanup.
const checkedRoute=handler=>async route=>{try{await handler(route);}catch(error){routeFailures.push(error);try{await route.abort();}catch{/* A failed journey may already have closed the request. */}}};
page.setDefaultTimeout(15000);
page.on('pageerror',error=>errors.push(String(error)));
page.on('console',message=>{if(message.type()==='error'&&!/Failed to load resource:.*(?:ERR_FAILED|403|404)/.test(message.text()))errors.push(message.text());});
page.on('request',request=>{if(request.method()==='POST'&&/\/workbench\/|\/outline\/|\/outline-adoption\//.test(new URL(request.url()).pathname))posts.push({path:new URL(request.url()).pathname,body:request.postDataJSON(),key:request.headers()['idempotency-key']});});
class Workbench{
  panel(){return page.getByRole('region',{name:'正式大纲采用',exact:true});}
  button(name,scope=this.panel()){return scope.getByRole('button',{name,exact:true});}
  async connect(token){await page.getByLabel('访问凭证',{exact:true}).fill(token);await page.getByRole('button',{name:'连接工作区',exact:true}).click();await page.getByRole('button',{name:'剧作大纲',exact:true}).click();await this.panel().waitFor();}
  async run(runId){const library=page.locator('.outline-library-section').filter({has:page.getByRole('heading',{name:'大纲记录',exact:true})});await library.getByRole('button').filter({has:page.getByText(runId,{exact:true})}).click();await page.getByRole('button',{name:'人改审阅结果',exact:true}).waitFor();await this.panel().waitFor();}
  async reload(token,runId=fixture.runId){await page.reload();await this.connect(token);await this.run(runId);}
  async native(){return control('native');}
  async pending(){return page.evaluate(()=>Object.entries(sessionStorage).find(([key])=>key.startsWith('camery:outline-action:'))?.[1]??null);}
}
const app=new Workbench();
const visible=async(text,scope=app.panel())=>scope.getByText(text,{exact:false}).first().waitFor();
async function retryReady(){const retry=app.button('使用原请求重试');try{await retry.waitFor();await retry.click({trial:true});}catch(error){throw routeFailures[0]??error;}if(routeFailures.length)throw routeFailures[0];}
async function warningsJourney(){
  await page.goto(process.argv[2]);await app.connect(fixture.editorToken);await app.run(fixture.runId);
  async function readAll(receipt){
    const oracle=await control('warnings-receipt',{kind:receipt.kind,requestId:receipt.requestId,candidateId:receipt.candidateId});assert(oracle.warnings.length>500);assert.equal(receipt.warningCount,oracle.warnings.length);
    const before=await control('warning-counters'),region=app.panel().getByRole('region',{name:'回执提醒',exact:true}),seen=new Set(),items=[];let pages=0,cursor=null;
    do{
      const waiting=page.waitForResponse(response=>{const url=new URL(response.url());return response.request().method()==='GET'&&url.pathname.endsWith('/outline-adoption/candidates/'+receipt.candidateId+'/receipts')&&url.searchParams.get('kind')===receipt.kind&&url.searchParams.get('requestId')===receipt.requestId&&url.searchParams.get('section')==='warnings';});
      await region.getByRole('button',{name:/^(读取|加载更多)提醒/}).click();const response=await waiting;assert.equal(response.status(),200);const wire=await response.text();assert(Buffer.byteLength(wire)<=983040);const value=JSON.parse(wire).data;
      assert.equal(value.candidateId,receipt.candidateId);assert.equal(value.kind,receipt.kind);assert.equal(value.requestId,receipt.requestId);assert.equal(value.total,oracle.warnings.length);assert.equal(value.section,'warnings');assert(value.items.length>0&&value.items.length<=50);items.push(...value.items);pages++;
      await page.waitForFunction(({count})=>{const section=document.querySelector('[aria-label="回执提醒"]');return section?.querySelectorAll('article.outline-issue').length===count;},{count:items.length});
      cursor=value.nextCursor;if(cursor!==null){assert(!seen.has(cursor));seen.add(cursor);}
    }while(cursor!==null);
    assert(pages>10);assert.deepEqual(items,oracle.warnings);assert.deepEqual(await region.locator('article.outline-issue > p').allTextContents(),oracle.warnings.map(item=>item.message));assert.deepEqual(await region.locator('article.outline-issue > small').allTextContents(),oracle.warnings.map(item=>item.code+' · '+item.where));
    assert.equal(await region.getByRole('button',{name:/^(读取|加载更多)提醒/}).count(),0);assert.deepEqual(await control('warning-counters'),before);
    return {kind:receipt.kind,count:items.length,pages};
  }
  const preparedResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/outline/'+fixture.runId+'/candidates'));
  await app.button('准备正式大纲候选').click();const preparation=await preparedResponse;assert.equal(preparation.status(),201);const candidate=(await preparation.json()).data;assert.equal(candidate.status,'candidate');assert(candidate.preparation);assert.equal(candidate.preparation.issueCount,0);
  const prepared=await readAll(candidate.preparation);results.push('every genuine native preparation warning is read and rendered in order beyond 500, with no read-side writes or allocations');
  const adoptedResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/outline-adoption/candidates/'+candidate.candidateId+'/adopt'));
  await app.button('明确采用到正式大纲').click();const adoption=await adoptedResponse;assert.equal(adoption.status(),201);const receipt=(await adoption.json()).data;assert.equal(receipt.status,'adopted');assert.equal(receipt.issueCount,0);assert(receipt.adoption);
  const adopted=await readAll(receipt);results.push('every genuine native decision warning is read and rendered in order beyond 500, with no read-side writes or allocations');
  const region=app.panel().getByRole('region',{name:'回执提醒',exact:true});await region.evaluate(element=>element.scrollIntoView({block:'start'}));await page.screenshot({path:resolve(output,'warning-messages.png'),fullPage:false});
  assert.equal(await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>value.includes('cmry_'))),false);assert.deepEqual(errors,[]);
  return {passed:results.length,results,phases:[prepared,adopted],posts:posts.length,errors};
}
try{
  if(mode==='warnings')report=await warningsJourney();else{
  await page.goto(process.argv[2]);await app.connect(fixture.editorToken);await app.run(fixture.runId);
  assert.equal(await page.getByLabel('故事标题',{exact:true}).inputValue(),fixture.title);assert.equal(posts.length,0);
  for(const [from,to,head] of [['0.5.0-draft','0.6.0-draft',1],['0.6.0-draft','0.7.0-draft',2]]){
    await visible('结构 '+from);const before=await app.native();assert.equal(before.head,head);
    await app.button('准备项目结构升级').click();await visible('已核验的结构升级');await visible(from+' → '+to);
    const prepared=await app.native();assert.equal(prepared.head,before.head);assert.equal(prepared.adoptions,before.adoptions);assert.equal(prepared.changes,before.changes+1);
    await app.button('明确采用项目升级').click();await visible('结构 '+to);const adopted=await app.native();assert.equal(adopted.head,head+1);assert.equal(adopted.schema,to);assert.equal(adopted.adoptions,before.adoptions+1);
  }
  results.push('actual PG V05 to V06 to V07 require two independent prepare and explicit adopt decisions');

  let lostPreparation=false,preparationCommitted=false;
  await page.route('**/outline/*/candidates',checkedRoute(async route=>{if(route.request().method()==='POST'&&!lostPreparation){lostPreparation=true;const response=await route.fetch();assert.equal(response.status(),201);assert.equal((await response.json()).data.status,'candidate');preparationCommitted=true;await route.abort();}else await route.continue();}));
  const beforePrepare=await app.native();await app.button('准备正式大纲候选').click();await retryReady();assert.equal(preparationCommitted,true);
  const originalPreparation=await app.pending();assert(originalPreparation);const firstPrepare=posts.find(item=>/\/outline\/[^/]+\/candidates$/.test(item.path));assert(firstPrepare);assert.equal(firstPrepare.key,firstPrepare.body.applicationId);
  const afterPrepare=await app.native();assert.equal(afterPrepare.head,beforePrepare.head);assert.equal(afterPrepare.changes,beforePrepare.changes+1);
  await control('revoke-write');await app.reload(fixture.editorToken);await app.button('使用原请求重试').click();await visible('当前账号没有此操作的权限');await retryReady();assert.equal(await app.pending(),originalPreparation);
  await control('restore-write');await app.reload(fixture.editorToken);await app.button('使用原请求重试').click();await visible('正式候选已准备，尚未采用');assert.equal(await app.pending(),null);
  const preparations=posts.filter(item=>/\/outline\/[^/]+\/candidates$/.test(item.path));assert.equal(preparations.length,3);for(const request of preparations){assert.equal(request.key,firstPrepare.key);assert.deepEqual(request.body,firstPrepare.body);for(const forbidden of ['actor','actorId','target','draft','request'])assert.equal(Object.hasOwn(request.body,forbidden),false);}
  assert.deepEqual(await app.native(),afterPrepare);results.push('committed preparation ACK survives F5 and a forbidden retry; restoration reuses the original identity, hashes and CAS without another write');

  let lostAdoption=false,adoptionCommitted=false;
  await page.route('**/outline-adoption/candidates/*/adopt',checkedRoute(async route=>{if(route.request().method()==='POST'&&!lostAdoption){lostAdoption=true;const response=await route.fetch();assert.equal(response.status(),201);const receipt=(await response.json()).data;assert.equal(receipt.status,'adopted');assert.equal(receipt.issueCount,0);assert(receipt.adoption);adoptionCommitted=true;await route.abort();}else await route.continue();}));
  await app.button('明确采用到正式大纲').click();await retryReady();assert.equal(adoptionCommitted,true);assert(await app.pending());const committed=await app.native();assert.equal(committed.head,4);assert.equal(committed.adoptions,3);
  await app.reload(fixture.editorToken);await app.button('使用原请求重试').click();await visible('已采用到正式大纲');assert.equal(await app.pending(),null);assert.deepEqual(await app.native(),committed);
  const adoptions=posts.filter(item=>item.path.endsWith('/adopt')&&item.path.includes('/outline-adoption/'));assert.equal(adoptions.length,2);assert.equal(adoptions[0].key,adoptions[1].key);assert.deepEqual(adoptions[0].body,adoptions[1].body);results.push('actual committed adoption ACK replays after F5 with the original decision ID and no duplicate adoption');

  await app.button('准备正式大纲候选').click();await visible('正式大纲内容已经一致，本次无需变更');assert.deepEqual(await app.native(),committed);results.push('NoChange is explicit and never creates another native change or adoption');
  await app.button('查看正式大纲').click({trial:true});await app.panel().evaluate(element=>element.scrollIntoView({block:'start'}));await page.screenshot({path:resolve(output,'adoption-desktop.png'),fullPage:false});
  await app.button('查看正式大纲').click();const formal=page.getByRole('region',{name:'正式大纲完整内容',exact:true});await formal.getByRole('button').filter({has:page.getByText(fixture.title,{exact:true})}).click();await visible(fixture.title,formal);
  await formal.getByRole('heading',{name:fixture.title,exact:true}).waitFor();await formal.evaluate(element=>element.scrollIntoView({block:'start'}));await page.screenshot({path:resolve(output,'formal-desktop-top.png'),fullPage:false});
  const sourceIndex=formal.getByRole('region',{name:'来源索引',exact:true});await sourceIndex.getByRole('button',{name:'读取完整分节',exact:true}).click();await visible('此分节已完整载入',sourceIndex);
  const characters=formal.getByRole('region',{name:'正式人物与来源',exact:true});await characters.getByRole('button',{name:'读取完整分节',exact:true}).click();await characters.getByRole('button',{name:/查看正式人物/}).first().click();await visible('关联人物',formal);await visible('Character 0',formal);
  await formal.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(output,'desktop.png'),fullPage:false});
  const later=await control('later-head');assert.equal(later.head,5);await formal.getByRole('button',{name:'核对此修订',exact:true}).click();await visible('正在查看正式修订 4 · 当前项目修订 5',formal);await visible('这是历史快照',formal);assert.equal(await formal.getByText('后续正式大纲',{exact:true}).count(),0);
  await formal.getByRole('button',{name:'查看当前正式版本',exact:true}).click();await visible('正在查看正式修订 5 · 当前项目修订 5',formal);await formal.getByRole('button').filter({has:page.getByText('后续正式大纲',{exact:true})}).click();await visible('<img src=x onerror="globalThis.formalOutlineXss=1">',formal);assert.equal(await page.evaluate(()=>globalThis.formalOutlineXss??null),null);assert.equal(await formal.locator('img[src="x"]').count(),0);
  results.push('typed formal sections and pinned Character history are real PG reads; historical snapshot remains separate from the new head and text is escaped');
  await formal.getByRole('button',{name:'关闭正式大纲',exact:true}).click();
  const postsBeforeHistory=posts.length,nativeBeforeHistory=await app.native();await app.panel().getByLabel('正式修订号',{exact:true}).fill('4');await app.button('查看指定正式修订').click();await visible('正在查看正式修订 4 · 当前项目修订 5',formal);await formal.getByRole('button').filter({has:page.getByText(fixture.title,{exact:true})}).click();await formal.getByRole('heading',{name:fixture.title,exact:true}).waitFor();assert.equal(await formal.getByText('后续正式大纲',{exact:true}).count(),0);assert.equal(posts.length,postsBeforeHistory);assert.deepEqual(await app.native(),nativeBeforeHistory);await formal.getByRole('button',{name:'关闭正式大纲',exact:true}).click();

  const next=await control('next-source');await page.getByRole('button',{name:'刷新记录',exact:true}).click();await app.run(next.runId);
  await app.button('准备正式大纲候选').click();await visible('正式候选已准备，尚未采用');const beforeReject=await app.native();assert.equal(beforeReject.head,5);
  await control('stale-source');await page.getByRole('button',{name:'刷新记录',exact:true}).click();await app.button('刷新正式版本').click();await visible('来源已经变化，不能采用');assert.equal(await app.button('明确采用到正式大纲').isEnabled(),false);
  await page.getByLabel('正式候选拒绝理由',{exact:true}).fill('来源已更新，明确保留这一拒绝决定。');await app.button('拒绝这份正式候选').click();await visible('候选已拒绝，正式大纲保持原版本');await visible('来源已更新，明确保留这一拒绝决定。');
  const rejected=await app.native();assert.equal(rejected.head,beforeReject.head);assert.equal(rejected.adoptions,beforeReject.adoptions);assert.equal(rejected.changes,beforeReject.changes);results.push('stale source blocks adoption while a reasoned rejection is stored without changing the formal head');

  await page.getByRole('button',{name:'断开工作区',exact:true}).click();await app.connect(fixture.viewerToken);await app.run(fixture.runId);
  assert.equal(await app.button('准备正式大纲候选').isEnabled(),false);await app.button('查看正式大纲').click();await page.getByRole('region',{name:'正式大纲完整内容',exact:true}).waitFor();const postsBeforeRead=posts.length;
  await page.setViewportSize({width:320,height:900});const mobileFormal=page.getByRole('region',{name:'正式大纲完整内容',exact:true});await visible('正在查看正式修订 5',mobileFormal);await mobileFormal.evaluate(element=>element.scrollIntoView({block:'start'}));await page.screenshot({path:resolve(output,'formal-mobile-top.png'),fullPage:false});await mobileFormal.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(output,'mobile.png'),fullPage:false});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.equal(posts.length,postsBeforeRead);
  assert.equal(await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>value.includes('cmry_'))),false);assert.deepEqual(routeFailures,[]);assert.deepEqual(errors,[]);results.push('a different viewer identity only reads, 320px has no horizontal overflow, and credentials never enter browser storage');
  report={passed:results.length,results,posts:posts.length,errors};
  }
}catch(error){failed=true;failure=error;await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});await page.locator('body').innerText().then(text=>writeFile(resolve(output,'failure.txt'),text)).catch(()=>{});}finally{
  let cleanupError;for(const close of [()=>page.unrouteAll({behavior:'wait'}),()=>context.close(),()=>browser.close()])try{await close();}catch(error){cleanupError??=error;}
  if(process.connected)process.disconnect();if(!failed&&cleanupError){failed=true;failure=cleanupError;}
}
if(failed)throw failure;if(routeFailures.length)throw routeFailures[0];
await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
