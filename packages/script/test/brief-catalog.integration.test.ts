import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {expect,it} from 'vitest';
import {PostgresDevelopmentBriefCatalog} from '../src/node/brief-catalog.js';
import {PostgresDevelopmentStore} from '../src/node/store.js';
import {migrateDevelopment} from '../src/node/migrate.js';
const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for saved brief discovery');
it('discovers latest saved ideas without any runs, with scope-bound stable pages across revision changes',async()=>{
  const pool=new Pool({connectionString:databaseUrl});const tenantId='development-ideas-'+randomUUID();const otherTenant=tenantId+'-other';
  try{
    await migrateDevelopment(pool);const store=new PostgresDevelopmentStore(pool);const catalog=new PostgresDevelopmentBriefCatalog(pool);
    const body={tenantId,projectId:'project',actorId:'author',expectedRevision:0,idea:'修钟学徒收到未来的来信。',episodeCount:10,targetSeconds:120};
    for(let index=0;index<24;index++)await store.putBrief({...body,briefId:'brief-'+String(index).padStart(2,'0')});
    await store.putBrief({...body,briefId:'brief-00',projectId:'other'});await store.putBrief({...body,briefId:'brief-00',tenantId:otherTenant});
    const page=await catalog.list({tenantId,projectId:'project'});expect(page.items).toHaveLength(20);expect(page.items[0]).toMatchObject({briefId:'brief-00',revision:1,ideaPreview:body.idea,actorId:'author'});
    await store.putBrief({...body,briefId:'brief-00',expectedRevision:1,idea:'已经修改但没有新建运行的创意。'});
    const tail=await catalog.list({tenantId,projectId:'project',cursor:page.nextCursor!});expect(tail.items.map(item=>item.briefId)).toEqual(['brief-20','brief-21','brief-22','brief-23']);expect(tail.nextCursor).toBeNull();
    expect((await catalog.list({tenantId,projectId:'project'})).items[0]).toMatchObject({briefId:'brief-00',revision:2,ideaPreview:'已经修改但没有新建运行的创意。'});
    expect((await catalog.list({tenantId,projectId:'other'})).items).toHaveLength(1);
    await store.putBrief({...body,briefId:'leading',projectId:'whitespace',idea:' '.repeat(120)+'修钟学徒收到来信。'});expect((await catalog.list({tenantId,projectId:'whitespace'})).items[0]!.ideaPreview).toBe(' '.repeat(120));
    await expect(catalog.list({tenantId:otherTenant,projectId:'project',cursor:page.nextCursor!})).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect((await pool.query('SELECT count(*)::int n FROM camery_script.runs WHERE tenant_id=$1',[tenantId])).rows[0].n).toBe(0);
  }finally{try{await pool.query('DELETE FROM camery_script.briefs WHERE tenant_id=ANY($1::text[])',[[tenantId,otherTenant]]);}finally{await pool.end();}}
});
