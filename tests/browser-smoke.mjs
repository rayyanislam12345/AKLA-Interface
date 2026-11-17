import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base=process.env.QA_LOCAL_URL ?? 'http://127.0.0.1:5178';
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
 const page=await browser.newPage();
 await page.goto(`${base}/tests/editor-export.html`);
 await page.waitForFunction(()=>typeof window.checkExport==='function');
 const result=await page.evaluate(()=>window.checkExport());
 assert.deepEqual(result,{tableNodes:1,rows:2,table:true,values:true});
 console.log('PASS: table content survives editor -> DOCX export');
 await page.route('**/rest/v1/matters?*',route=>route.fulfill({json:[{id:'00000000-0000-0000-0000-000000000002',name:'Test project'}]}));
 const requests=[];
 await page.route('**/rest/v1/rpc/search_project_content',route=>{
  const body=route.request().postDataJSON();requests.push(body);
  return route.fulfill({json:[{kind:'document',item_id:'v2',matter_id:'00000000-0000-0000-0000-000000000002',matter_name:'Test project',title:'Agreement',snippet:'The ⟦termination⟧ clause. <img src=x onerror=alert(1)>',document_id:'doc',version_id:'v2',version_number:2,storage_path:'project/doc/file.docx',file_name:'Agreement-v2.docx',created_at:'2026-09-11T00:00:00Z',rank:1,total_count:1,matched_in:'text'}]});
 });
 await page.goto(`${base}/tests/project-search.html?q=termination`);
 await page.getByRole('link',{name:'Agreement',exact:true}).waitFor();
 assert.equal(await page.locator('mark').innerText(),'termination');
 assert.equal(await page.locator('article img').count(),0);
 assert.match(await page.getByRole('link',{name:'Agreement',exact:true}).getAttribute('href'),/document=doc#version-v2/);
 assert.equal(requests.at(-1).p_all_versions,false);
 const olderRequest=page.waitForRequest(r=>r.url().includes('/rpc/search_project_content') && r.postDataJSON()?.p_all_versions===true);
 await page.getByLabel('Include older versions').click();
 assert.equal((await olderRequest).postDataJSON().p_all_versions,true);
 await page.getByRole('combobox',{name:'Result type'}).click();
 const noteRequest=page.waitForRequest(r=>r.url().includes('/rpc/search_project_content') && r.postDataJSON()?.p_kind==='note');
 await page.getByRole('option',{name:'Notes',exact:true}).click();
 assert.equal((await noteRequest).postDataJSON().p_kind,'note');
 console.log('PASS: project search filters, safe snippets, exact-version links');
 // Search SharePoint: the description goes to the chat server, what it is doing shows while it works, and the files come back with why, where and a link.
 // On a page of its own: the checks after this one carry on from the project search page.
 const sp=await browser.newPage();
 const spAsked=[]; let spRelease; const spHeld=new Promise(r=>{spRelease=r;});
 const spResult={query:'q',note:'Earlier drafts sit in the same folder.',searches:['"direct agreement" lenders','step-in lenders'],seen:23,opened:1,complete:true,results:[
  {name:'KPT21 - Direct Agreement [AKLA][Final].docx',webUrl:'https://aklacopk.sharepoint.com/x/KPT21.docx',folder:'Usama - Backup/Active Transactions/Karachi Port Trust',folderUrl:'https://aklacopk.sharepoint.com/x',modified:'2026-01-24T11:47:00Z',size:84000,why:"The final lenders' direct agreement for the KPT terminal.",fit:'strong',opened:true},
  {name:'Signed Direct Agreement (scan).pdf',webUrl:'https://aklacopk.sharepoint.com/x/scan.pdf',folder:'',folderUrl:'https://aklacopk.sharepoint.com/room',modified:null,size:null,why:'A scan that could not be read; the name suggests the signed copy.',fit:'possible',opened:false}]};
 await sp.route('**/sharepoint/search',async route=>{
  if(route.request().method()!=='POST') return route.fulfill({status:204});
  spAsked.push(route.request().postDataJSON());
  if(spAsked.length===1) await spHeld;
  return route.fulfill({status:200,contentType:'text/event-stream',body:`event: step\ndata: ${JSON.stringify({kind:'search',text:'Searching SharePoint for "direct agreement" lenders'})}\n\n: working\n\nevent: result\ndata: ${JSON.stringify(spResult)}\n\n`});
 });
 await sp.goto(`${base}/tests/sharepoint-search.html`);
 assert.equal(await sp.getByRole('button',{name:'Search',exact:true}).isDisabled(),true);
 await sp.getByTestId('sharepoint-search-input').fill('the signed lenders direct agreement');
 await sp.getByRole('button',{name:'Search',exact:true}).click();
 await sp.getByTestId('sharepoint-search-progress').waitFor();
 assert.equal(await sp.getByRole('button',{name:'Stop'}).count(),1);
 spRelease();
 await sp.getByTestId('sharepoint-hit').first().waitFor();
 assert.deepEqual(spAsked,[{query:'the signed lenders direct agreement'}]);
 assert.match(sp.url(),/sp=the\+signed\+lenders\+direct\+agreement/);
 const spHits=sp.getByTestId('sharepoint-hit');
 assert.equal(await spHits.count(),2);
 assert.equal(await spHits.nth(0).getByRole('link',{name:'KPT21 - Direct Agreement [AKLA][Final].docx'}).getAttribute('href'),'https://aklacopk.sharepoint.com/x/KPT21.docx');
 assert.match(await spHits.nth(0).innerText(),/Strong match[\s\S]*final lenders' direct agreement[\s\S]*Karachi Port Trust[\s\S]*Changed 24 Jan 2026[\s\S]*Opened and read/);
 assert.match(await spHits.nth(1).innerText(),/Possible[\s\S]*Data Room[\s\S]*Judged by its name/);
 assert.match(await sp.getByTestId('sharepoint-search').innerText(),/2 files found · 2 searches run, 23 files looked at, 1 opened[\s\S]*Earlier drafts sit in the same folder\./);
 // The description is in the address, so a reload looks again; so does pressing Search on the same description.
 await sp.reload();
 await sp.getByTestId('sharepoint-hit').first().waitFor();
 assert.equal(spAsked.length,2);
 const spAgain=sp.waitForResponse(r=>r.url().endsWith('/sharepoint/search') && r.request().method()==='POST');
 await sp.getByRole('button',{name:'Search',exact:true}).click();
 await spAgain;
 await sp.getByTestId('sharepoint-hit').first().waitFor();
 assert.equal(spAsked.length,3);
 console.log('PASS: Search SharePoint shows progress, then the files with why, where and a link');
 await sp.close();
 const saves=[],uploads=[];
 let state='failed';
 await page.route('**/storage/v1/object/matter-documents/**',route=>{
  assert.equal(route.request().method(),'POST'); uploads.push(route.request().url());
  assert.notEqual(route.request().headers()['x-upsert'],'true');
  return route.fulfill({json:{Key:'staged-file'}});
 });
 await page.route('**/rest/v1/rpc/save_document_version',route=>{
  const args=route.request().postDataJSON();saves.push(args);
  if(saves.length===1) return route.abort('failed');
  return route.fulfill({json:{matterDocumentId:args.p_document_id,versionId:'saved-version',versionNumber:1,fileName:'Agreement-v1.docx'}});
 });
 await page.route('**/functions/v1/process-document',route=>route.fulfill({status:500,json:{error:'Indexing unavailable'}}));
 await page.route('**/rest/v1/document_versions?*',route=>route.fulfill({json:route.request().method()==='GET'?{indexing_status:state}:null}));
 const saved=await page.evaluate(()=>window.saveFixture());
 assert.equal(saved.versionId,'saved-version'); assert.equal(saved.indexed,false);
 assert.deepEqual(saves[0],saves[1]); assert.equal(saves[0].p_create_new,true);
 state='indexed';
 assert.equal((await page.evaluate(()=>window.saveFixture())).indexed,true);
 assert.notEqual(uploads[0],uploads[1]);
 console.log('PASS: uncertain saves retry the same upload; indexing failures preserve committed versions');
} finally {await browser.close();}
