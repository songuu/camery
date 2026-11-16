import { expect,it } from 'vitest';
import { SourcePageSchema,SourceSummarySchema,SourceListSchema,AppendReceiptSchema,ScriptReceiptSchema } from '../src/contracts.js';
import { createSourcePage } from '../src/document.js';
import { importNovel } from '../src/novel.js';
it('uses the shared bounded source protocol on both sides of HTTP',()=>{
  const document=importNovel('第一章 标题\n内容😀'); const summary={documentId:'source',title:'小说',kind:'novel' as const,format:'novel' as const,revision:1};
  const page=createSourcePage({documentId:summary.documentId,title:summary.title,kind:'novel',revision:1,document});
  expect(SourceSummarySchema.parse(summary)).toEqual(summary);expect(SourcePageSchema.parse(page)).toEqual(page);
  expect(SourceListSchema.parse({items:[summary],nextCursor:null})).toEqual({items:[summary],nextCursor:null});
  expect(AppendReceiptSchema.safeParse({...summary,sourceDigest:document.sourceDigest,duplicate:false,batchRevision:1}).success).toBe(true);
  expect(ScriptReceiptSchema.safeParse({...summary,kind:'script',format:'docx',sourceDigest:document.sourceDigest,duplicate:false}).success).toBe(true);
  expect(AppendReceiptSchema.safeParse({...summary,sourceDigest:document.sourceDigest,duplicate:false,batchRevision:2}).success).toBe(false);
  expect(SourcePageSchema.safeParse({...page,excerpt:{...page.excerpt,end:0}}).success).toBe(false);
  expect(SourceListSchema.safeParse({items:Array(51).fill(summary),nextCursor:null}).success).toBe(false);
});
