import { useState } from 'react';
import type { FormEvent, DragEvent } from 'react';
import type { UploadFormat, WorkbenchProps } from './view-types.js';
import './styles.css';

const formats: Readonly<Record<UploadFormat, { label: string; accept: string; description: string }>> = {
  novel: { label: '小说原文', accept: '.txt,text/plain', description: 'TXT · 保留原文，识别章节，接续阅读' },
  docx: { label: 'Word 剧本', accept: '.docx', description: 'DOCX · 提取正文与常见剧本样式' },
  fountain: { label: 'Fountain 剧本', accept: '.fountain,.txt,text/plain', description: 'Fountain · 识别场景、角色与对白' },
  csv: { label: 'CSV 表格剧本', accept: '.csv,text/csv', description: 'CSV · 识别场景、角色、对白与动作列' },
  tsv: { label: 'TSV 表格剧本', accept: '.tsv,text/tab-separated-values', description: 'TSV · 使用制表符分列的剧本' },
};
const unitNames: Readonly<Record<string, string>> = {
  frontmatter: '前言', chapter: '章节', scene: '场景', action: '动作', character: '角色', dialogue: '对白',
  parenthetical: '提示', transition: '转场', note: '注释', lyric: '歌词', section: '小节', synopsis: '梗概', title: '标题', unknown: '原文',
};
const warningMessages: Readonly<Record<string, string>> = {
  NO_EXPLICIT_HEADINGS: '没有识别到独立章节标题，已完整保留原文。',
  NO_SCENES: '尚未识别到明确场景，请核对原文结构。',
  UNTERMINATED_NOTE: '有一处注释未结束，原始内容已保留。',
  UNRECOGNIZED_COLUMNS: '部分表头尚未识别，内容仍保留在来源中。',
  UNKNOWN_ROW_TYPE: '部分行的类型需要人工核对。',
  DOCX_TEXT_EXTRACTION: 'Word 正文已提取，原始排版不会带入。',
  DOCX_NON_BODY_CONTENT_NOT_IMPORTED: '页眉、页脚等正文以外的内容未导入。',
};
function Arrow({ direction = 'right' }: { direction?: 'left' | 'right' }) {
  return <span aria-hidden="true">{direction === 'left' ? '←' : '→'}</span>;
}

/** Controlled presentation only: credentials, file bytes and source mutations remain in the application layer. */
export function ImportWorkbench(props: WorkbenchProps) {
  const [credential, setCredential] = useState('');
  const [selection, setSelection] = useState<{ file: File; projectId: string; format: UploadFormat } | null>(null);
  const [appendTarget, setAppendTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const { page } = props;
  const sources = props.connected ? props.sources : null;
  const projects = props.connected ? props.projects : [];
  const busy = props.busy !== null;
  const uploadAllowed = props.connected && props.canImport && !busy;
  const canAppend = props.format === 'novel' && page?.kind === 'novel';
  const target = JSON.stringify([props.projectId, page?.documentId ?? '']);
  const append = canAppend && appendTarget === target;
  const file = selection?.projectId === props.projectId && selection.format === props.format ? selection.file : null;
  const progress = props.progress === null ? null : Math.round(Math.max(0, Math.min(1, props.progress)) * 100);
  function selectFiles(files: FileList | null) {
    if (!files?.length || !uploadAllowed) return;
    if (files.length !== 1) { setSelectionError('请一次选择一个文件。'); return; }
    setSelection({ file: files[0]!, projectId: props.projectId, format: props.format }); setSelectionError(null);
  }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault(); setDragging(false); selectFiles(event.dataTransfer.files);
  }
  function connect(event: FormEvent) {
    event.preventDefault(); const token = credential.trim();
    if (!token || busy) return;
    setCredential(''); props.onConnect(token);
  }
  function importFile(event: FormEvent) {
    event.preventDefault();
    if (file && uploadAllowed) props.onFile(file, canAppend && append);
  }
  return <div className="camery-workbench">
    <aside className="workspace-sidebar" aria-label="来源导航">
      <a className="brand-lockup" href="#workspace-main" aria-label="Camery 来源工作台">
        <span className="brand-mark" aria-hidden="true">c<span>·</span></span>
        <span><strong>camery</strong><small>让故事，继续发生</small></span>
      </a>
      <div className="workspace-selector">
        <label htmlFor="workspace-project">当前项目</label>
        <select id="workspace-project" value={props.connected ? props.projectId : ''} disabled={!props.connected || busy || !projects.length} onChange={event => props.onProject(event.target.value)}>
          {!projects.length && <option value="">{props.connected ? '暂无可访问项目' : '连接后选择项目'}</option>}
          {projects.map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
        </select>
      </div>
      <div className="sidebar-section-label"><span>故事档案</span><span aria-hidden="true">01</span></div>
      <div className="sidebar-active"><span className="document-glyph" aria-hidden="true">▤</span><span>来源与阅读</span><span className="active-indicator" aria-hidden="true" /></div>
      <div className="sources-heading"><h2>已导入来源</h2>{sources && <span>{sources.items.length}</span>}</div>
      <nav className="source-list" aria-label="已导入来源">
        {sources?.items.map(source => <button type="button" className={`source-link${page?.documentId === source.documentId && page.kind === source.kind ? ' selected' : ''}`}
          key={`${source.kind}:${source.documentId}`} disabled={busy} onClick={() => props.onOpen(source)}
          aria-current={page?.documentId === source.documentId && page.kind === source.kind ? 'page' : undefined}>
          <span className="source-icon" aria-hidden="true">{source.kind === 'novel' ? '书' : '稿'}</span>
          <span className="source-link-copy"><strong>{source.title || source.documentId}</strong><small>{formats[source.format].label}</small></span>
        </button>)}
        {!sources?.items.length && <p className="sidebar-empty">{!props.connected ? '连接工作区后，查看你的来源。' : sources ? '来源还留白，等一个故事抵达。' : '尚未载入来源。'}</p>}
      </nav>
      {sources?.nextCursor && <button type="button" className="sidebar-more" onClick={props.onMore} disabled={busy}>载入更多 <Arrow /></button>}
      <div className="sidebar-footer">
        <p><span className={`connection-dot${props.connected ? ' connected' : ''}`} />{props.connected ? '工作区已连接' : '等待连接工作区'}</p>
        {props.connected && <button type="button" onClick={props.onDisconnect}>断开连接 <span aria-hidden="true">↗</span></button>}
        <small>原文保留，创作由你决定。</small>
      </div>
    </aside>

    <main id="workspace-main" className="workspace-main" tabIndex={-1}>
      <header className="workspace-header">
        <div><p className="breadcrumb">工作台 <span aria-hidden="true">/</span> 来源</p><h1>来源与阅读<span className="heading-dot">.</span></h1></div>
        <p className="header-note"><span aria-hidden="true">⌁</span> 每个故事，都有来处</p>
      </header>
      <div className="workspace-notices" aria-live="polite" aria-atomic="true">
        {props.error && <p className="notice error" role="alert"><span aria-hidden="true">!</span>{props.error}</p>}
        {props.connected && props.message && <p className="notice success"><span aria-hidden="true">✓</span>{props.message}</p>}
        {props.busy && <p className="notice working" role="status"><span className="busy-mark" aria-hidden="true" />{props.busy}</p>}
      </div>

      {!props.connected ? <section className="connection-stage" aria-labelledby="connection-title">
        <div className="connection-intro"><p className="eyebrow">FROM THE FIRST LINE</p><div className="editorial-line" />
          <h2 id="connection-title">先让原文落座，<br/>再让故事生长。</h2>
          <p>把小说、剧本或表格带进工作区。<br/>留下每一行来处，从上次读到的地方继续。</p>
          <div className="supported-formats"><span>小说 TXT</span><span>Word</span><span>Fountain</span><span>CSV / TSV</span></div>
        </div>
        <form className="connection-form" onSubmit={connect}>
          <span className="form-index" aria-hidden="true">01 / CONNECT</span><h3>连接工作区</h3><p>使用你的访问凭证，打开可访问的项目。</p>
          <label htmlFor="workspace-credential">访问凭证</label>
          <input id="workspace-credential" type="password" autoComplete="off" spellCheck={false} value={credential} onChange={event => setCredential(event.target.value)} disabled={busy} placeholder="输入访问凭证" required />
          <button type="submit" className="button primary" disabled={busy || !credential.trim()}>连接工作区 <Arrow /></button>
          <p className="privacy-note"><span aria-hidden="true">◇</span> 凭证只用于当前连接，应用不会保存。</p>
        </form>
      </section> : <div className="workspace-columns">
        <section className="reading-desk" aria-label="来源阅读区">
          {page ? <>
            <header className="reader-heading"><p className="eyebrow">{formats[page.format].label} <span> / </span> 原文预览</p><h2>{page.title || page.documentId}</h2>
              <div className="source-metadata"><span>{page.totalCharacters.toLocaleString('zh-CN')} 字符</span><span>{page.unitCount.toLocaleString('zh-CN')} 个识别单元</span><span>第 {page.excerpt.start.toLocaleString('zh-CN')}–{page.excerpt.end.toLocaleString('zh-CN')} 字符</span></div>
            </header>
            {page.units.some(unit => unit.kind === 'chapter' || unit.kind === 'scene' || unit.kind === 'frontmatter' || unit.kind === 'section') && <nav className="chapter-navigation" aria-label="本段章节与场景">
              {page.units.filter(unit => ['chapter', 'scene', 'frontmatter', 'section'].includes(unit.kind)).map(unit => <button type="button" key={unit.ordinal} disabled={busy} onClick={() => props.onRead(unit.start)}><small>{unitNames[unit.kind]}</small><span>{unit.title || unitNames[unit.kind]}</span></button>)}
            </nav>}
            <article className="manuscript-paper"><div className="paper-rule" aria-hidden="true" /><pre>{page.excerpt.text}</pre><span className="paper-end" aria-hidden="true">✧</span></article>
            <footer className="reader-controls">
              <div className="reader-pagination"><button type="button" className="button subtle" disabled={busy || page.excerpt.start === 0} onClick={props.onPrevious}><Arrow direction="left" />上一段</button>
                <button type="button" className="button subtle" disabled={busy || page.excerpt.end >= page.totalCharacters} onClick={() => props.onRead(page.excerpt.end)}>下一段<Arrow /></button></div>
              {page.kind === 'novel' && <button type="button" className="button checkpoint" disabled={busy} onClick={props.onCheckpoint}>保存阅读位置 <span aria-hidden="true">↗</span></button>}
            </footer>
            {page.kind === 'novel' && <p className="checkpoint-note">{page.checkpoint ? `已读位置保存在第 ${page.checkpoint.offset.toLocaleString('zh-CN')} 字符。` : '读到这里后，保存位置，下次继续。'}</p>}
            {!!page.warnings.length && <details className="import-warnings"><summary>{page.warnings.length} 条导入提示</summary><ul>{page.warnings.map((warning, index) => <li key={`${warning}:${index}`}>{warningMessages[warning] ?? '部分结构需要核对，请以保留的原文为准。'}</li>)}</ul></details>}
          </> : <div className="empty-reading"><span className="empty-book" aria-hidden="true">文</span><p className="eyebrow">A PLACE FOR YOUR STORY</p><h2>从原文开始。</h2><p>导入一份来源，或从左侧打开已有文档。<br/>识别出的章节、场景和原文会出现在这里。</p><div className="empty-rule" aria-hidden="true" /></div>}
        </section>

        <aside className="import-panel" aria-labelledby="import-title"><div className="panel-topline"><span>加入故事档案</span><span aria-hidden="true">＋</span></div>
          <h2 id="import-title">导入来源</h2><p className="panel-description">从已有文字出发，保留每一行原文。</p>
          <form onSubmit={importFile}>
            <label className="field-label" htmlFor="source-format">来源格式</label>
            <select id="source-format" value={props.format} disabled={!uploadAllowed} onChange={event => { const format = event.target.value; if (Object.hasOwn(formats, format)) props.onFormat(format as UploadFormat); setSelection(null); setAppendTarget(null); setSelectionError(null); }}>
              {Object.entries(formats).map(([format, info]) => <option key={format} value={format}>{info.label}</option>)}
            </select>
            <p className="format-description">{formats[props.format].description}</p>
            <label className={`file-drop${dragging && uploadAllowed ? ' dragging' : ''}${!uploadAllowed ? ' unavailable' : ''}`} onDragOver={event => { event.preventDefault(); if (uploadAllowed) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
              <input className="file-input" type="file" accept={formats[props.format].accept} disabled={!uploadAllowed} aria-label="选择要导入的文件" onChange={event => { selectFiles(event.target.files); event.target.value = ''; }} />
              <span className="upload-symbol" aria-hidden="true">↥</span><strong>{file ? file.name : '选择文件，或拖到这里'}</strong><span>{file ? '文件已选择，可开始导入' : '每次导入一个文件'}</span>
            </label>
            {selectionError && <p className="field-error" role="alert">{selectionError}</p>}
            {canAppend && <label className="append-option"><input type="checkbox" checked={append} disabled={!uploadAllowed} onChange={event => setAppendTarget(event.target.checked ? target : null)} /><span>追加到当前小说<small>{page.title || page.documentId}</small></span></label>}
            <button className="button primary import-submit" type="submit" disabled={!uploadAllowed || !file}>{busy ? '正在处理' : append ? '追加当前小说' : '开始导入'} <Arrow /></button>
          </form>
          {progress !== null && <div className="upload-progress"><div><span>导入进度</span><strong>{progress}%</strong></div><progress max="100" value={progress} aria-label="导入进度" /></div>}
          {!props.canImport && <p className="role-note">当前角色可阅读来源。导入与追加需要项目编辑权限。</p>}
          <div className="import-note"><span aria-hidden="true">↳</span><p>导入会保留来源和识别结果，<br/>不会直接改写已采用的内容。</p></div>
          <p className="format-limit">Word 请使用 DOCX；暂不支持旧 DOC 和 XLSX 文件。</p>
        </aside>
      </div>}
      <footer className="workspace-footnote"><span>CAMERY / SOURCE WORKSPACE</span><span>让每一次创作，都有迹可循。</span></footer>
    </main>
  </div>;
}
