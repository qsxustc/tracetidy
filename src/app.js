import { validateHar, sanitizeHar, summarizeHar, buildReport } from './har.js';
import { createZip } from './zip.js';

const app = document.querySelector('#app');
const MAX_BYTES = 25 * 1024 * 1024;
const state = { lang: navigator.language.startsWith('zh') ? 'zh' : 'en', har: null, summary: null, safe: null, audit: null, tab: 'requests', selected: 0, search: '', filter: 'all', sort: 'time', page: 0, filename: '', demo: false, preserveRoutes: false, terms: '', preview: 'har', busy: false };
const words = {
  en: {
    workbench:'Workbench', share:'Share & redact', report:'Issue report', about:'How it works', local:'LOCAL FIRST', badge:'Your trace stays on your device', headline:'Debug the noise. <br>Share the signal.', intro:'Find the failing request. Keep the useful context.<br>Leave credentials and private payloads behind.', import:'Import HAR', demo:'Try a sample trace', clear:'Clear session', workspace:'WORKSPACE', demoFile:'Synthetic demo', requests:'Requests', failed:'Failed requests', span:'Trace span', transferred:'Response body size', hosts:'hosts', failures:'HTTP 4xx / 5xx + network errors', walltime:'First start to last finish', reported:'Reported by the HAR', live:'In-memory session', noUpload:'No trace uploads. No account.', stepTitle:'FROM TRACE TO TICKET', step1:'Inspect the original, locally', step2:'Review a stricter export', step3:'Share a useful issue pack', drop:'Drop a .har file anywhere', dropSmall:'Or use Import HAR · up to 25 MiB', search:'Search URL, method or status…', all:'All requests', errors:'Failed only', slow:'Slow ≥ 1 s', orderTime:'Start time', orderSlow:'Slowest first', orderSize:'Largest first', name:'Request / endpoint', status:'Status', duration:'Duration', waterfall:'Waterfall', size:'Size', matches:'matching requests', empty:'No requests match your filters.', details:'REQUEST INSPECTOR', original:'Local original', select:'Select a request to inspect its timings.', waiting:'Waiting (TTFB)', receive:'Receive', connection:'Connection', blocked:'Blocked / queue', raw:'Show original headers', rawWarning:'Original values are visible here. Export uses the sanitized version.', method:'Method', contentType:'Content type', noHeaders:'No headers recorded.', openShare:'Review share version', reviewTitle:'Useful evidence.<br>Fewer loose ends.', reviewIntro:'A strict field allowlist rebuilds the HAR. The original stays in memory; exports use this version.', publicMode:'PUBLIC SHARE MODE', publicDescription:'Hosts → host-n.invalid · paths → /route-n · query names → param-n', preserve:'Keep recognizable hosts & paths', preserveHint:'For private troubleshooting. Names or business identifiers in URLs may remain; review every export.', custom:'Extra values to remove', customPlaceholder:'One value per line, e.g. internal project name', customHint:'Exact, case-insensitive replacements. Applies to the retained strings. No regex.', preview:'EXPORT PREVIEW', cleaned:'Sanitized HAR', audit:'Removal manifest', bodies:'Bodies removed', cookies:'Cookies removed', headers:'Headers removed', queries:'Query values masked', download:'Download share pack', downloadHar:'HAR only', downloadReport:'Report only', copy:'Copy report', reviewWarning:'Review before sharing. Timing, status, sizes and request patterns can still reveal information. Bodies are intentionally removed; business error messages will be lost.', packHint:'ZIP contains safe.har, issue.md and audit.json. No original file or alias mapping.', reportTitle:'The handoff, already written.', reportIntro:'A Markdown report built from the same sanitized trace: failures, slow requests and diagnostic context.', generated:'GENERATED MARKDOWN', reportHint:'Add reproduction steps and expected behavior after downloading. Keep private details out of public issues.', blankTitle:'A clearer trace starts here.', blankText:'Import a browser network capture to investigate failures and build a carefully sanitized handoff.', exportHint:'In Chrome: DevTools → Network → Export HAR. Browser “sanitized” captures may still include private URLs and bodies.', close:'Close', helpTitle:'Inspect locally. Export carefully.', helpText:'TraceTidy reads HAR files in this browser tab. It never calls addresses in your trace, uploads its contents, or stores them in browser databases. The sample and app assets are loaded from this site.', helpList:'Strict exports remove request and response bodies, cookies, non-allowlisted headers, comments, IP addresses and unknown extensions. Hosts and paths become stable aliases by default. The export has no reverse mapping.', helpLimit:'This is data minimization, not guaranteed anonymization. Metadata and request patterns remain. “Keep hosts & paths” is a less private option. Review exported files before sharing.', helpCli:'The same engine runs in the included Node.js CLI, with no third-party dependencies. See the repository README for self-hosting and offline use.', loaded:'Trace loaded locally', demoLoaded:'Synthetic sample loaded', cleared:'Session cleared from memory', copied:'Report copied', copyFailed:'Clipboard unavailable. Download the report instead.', ready:'Share pack downloaded', fileError:'Use a valid HAR JSON file (up to 25 MiB).', network:'Network error', show:'Show', of:'of', previous:'Previous', next:'Next', busy:'Reading trace…', unsaved:'Closing or reloading this tab clears the imported trace.', strategy:'STRICT POLICY · v1', privacy:'Privacy & limitations', elapsed:'start offset', filename:'Trace file', zero:'This HAR has no requests. Import another capture.', localNote:'Original request data is for local investigation. Use Share & redact for exports.'
  },
  zh: {
    workbench:'网络分析', share:'检查分享版本', report:'Issue 报告', about:'工作原理', local:'本地处理', badge:'抓包内容始终留在你的设备', headline:'看清网络故障，<br>放心分享线索。', intro:'定位失败请求，保留有用的排障证据。<br>让凭据和私密正文留在分享材料之外。', import:'导入 HAR', demo:'体验示例抓包', clear:'清空本次会话', workspace:'工作区', demoFile:'合成示例', requests:'请求数', failed:'失败请求', span:'时间跨度', transferred:'响应正文大小', hosts:'个域名', failures:'HTTP 4xx / 5xx 与网络错误', walltime:'首个请求开始至最后结束', reported:'HAR 记录的字节数', live:'仅在内存中处理', noUpload:'不上传抓包，无需账号。', stepTitle:'从抓包到问题报告', step1:'在本地查看原始请求', step2:'检查严格清理后的版本', step3:'导出可以分享的报告包', drop:'把 .har 文件拖到页面', dropSmall:'也可点击导入 · 最大 25 MiB', search:'搜索 URL、方法或状态码…', all:'所有请求', errors:'仅失败请求', slow:'慢请求 ≥ 1 秒', orderTime:'按开始时间', orderSlow:'最慢优先', orderSize:'最大优先', name:'请求 / 接口', status:'状态', duration:'耗时', waterfall:'请求时间线', size:'大小', matches:'条匹配请求', empty:'没有符合筛选条件的请求。', details:'请求详情', original:'本地原始数据', select:'选择请求，查看详细耗时。', waiting:'等待响应（TTFB）', receive:'接收', connection:'建立连接', blocked:'阻塞 / 排队', raw:'展开原始请求头', rawWarning:'这里显示原始值；下载使用清理后的版本。', method:'方法', contentType:'内容类型', noHeaders:'未记录请求头。', openShare:'检查分享版本', reviewTitle:'保留排障证据，<br>减少隐私暴露。', reviewIntro:'按字段允许列表重新构建 HAR。原始数据留在内存；导出使用下方版本。', publicMode:'默认：公开分享模式', publicDescription:'域名 → host-n.invalid · 路径 → /route-n · 参数名 → param-n', preserve:'保留可识别的域名与路径', preserveHint:'适合私下排障。URL 中仍可能存在姓名或业务标识，请逐项检查导出内容。', custom:'额外需要移除的词', customPlaceholder:'每行一个值，如内部项目名', customHint:'精确匹配，忽略大小写；应用于保留的字符串，不使用正则。', preview:'导出预览', cleaned:'已清理的 HAR', audit:'清理清单', bodies:'移除正文', cookies:'移除 Cookie', headers:'移除请求头', queries:'遮盖参数值', download:'下载分享包', downloadHar:'仅 HAR', downloadReport:'仅报告', copy:'复制报告', reviewWarning:'分享前请检查。耗时、状态码、数据大小与请求模式仍可能暴露信息。正文被移除后，业务错误信息也会丢失。', packHint:'ZIP 包含 safe.har、issue.md、audit.json；不包含原文件或别名映射。', reportTitle:'把排障线索，交接清楚。', reportIntro:'从同一份已清理的抓包生成 Markdown 报告：失败请求、慢请求及诊断线索。', generated:'自动生成的 MARKDOWN', reportHint:'下载后补充复现步骤和预期行为。公开 Issue 中不要加入私密信息。', blankTitle:'从一份抓包，找到头绪。', blankText:'导入浏览器网络日志，定位失败请求并生成经过清理的分享材料。', exportHint:'Chrome：开发者工具 → 网络 → 导出 HAR。浏览器的“已清理”抓包仍可能包含私密 URL 和正文。', close:'关闭', helpTitle:'本地分析，谨慎分享。', helpText:'TraceTidy 在本浏览器标签页读取 HAR。不访问抓包中的地址，不上传文件内容，也不将其写入浏览器数据库。示例和应用静态资源从本站加载。', helpList:'严格导出会移除请求/响应正文、Cookie、未允许的请求头、注释、IP 地址和未知扩展字段。默认给域名和路径分配稳定别名；不导出还原映射。', helpLimit:'这是数据最小化工具，无法保证匿名性。元数据与请求模式仍会保留。“保留域名与路径”隐私保护较弱，所有导出都需要检查。', helpCli:'项目同时包含零第三方依赖的 Node.js CLI，使用同一个处理引擎。README 中有自部署及离线使用说明。', loaded:'已在本地载入抓包', demoLoaded:'已载入合成示例', cleared:'已从本次会话清空数据', copied:'已复制报告', copyFailed:'无法使用剪贴板，请下载报告。', ready:'已下载分享包', fileError:'请选择有效的 HAR JSON 文件（最大 25 MiB）。', network:'网络错误', show:'显示', of:'共', previous:'上一页', next:'下一页', busy:'正在读取抓包…', unsaved:'关闭或刷新页面后，导入的抓包会从会话中清除。', strategy:'严格清理策略 · v1', privacy:'隐私与限制', elapsed:'开始偏移', filename:'抓包文件', zero:'这份 HAR 没有请求，请导入另一份抓包。', localNote:'原始请求用于本地排障。导出请使用“检查分享版本”。'
  }
};
const t = key => words[state.lang][key] || key;
const routingLabel=()=>state.preserveRoutes ? (state.lang==='zh'?'私下排障：保留域名与路径':'PRIVATE DEBUGGING · ROUTES KEPT') : t('publicMode');
const routingDescription=()=>state.preserveRoutes ? t('preserveHint') : t('publicDescription');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const icon = (name, size=18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({activity:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',shield:'<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/>',file:'<path d="M14 3H6v18h12V7l-4-4Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/>',upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',download:'<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',check:'<path d="m5 12 4 4L19 6"/>',chevron:'<path d="m9 5 7 7-7 7"/>'})[name] || ''}</svg>`;
const ms = n => n >= 1000 ? `${(n/1000).toFixed(2)} s` : `${Math.round(n || 0)} ms`;
const bytes = n => n >= 1e6 ? `${(n/1e6).toFixed(2)} MB` : n >= 1000 ? `${(n/1000).toFixed(1)} kB` : `${Math.round(n || 0)} B`;
function toast(message, error=false) {
  const el = document.querySelector('#toast'); el.textContent = message; el.className = `visible ${error ? 'error' : ''}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.className = '', 4200);
}
function updateSafe() {
  if (!state.har) return false;
  try {
    const result = sanitizeHar(state.har, { preserveRoutes: state.preserveRoutes, customTerms: state.terms.split('\n').map(x => x.trim()).filter(Boolean) });
    state.safe = result.har; state.audit = result.audit; state.exportError=''; return true;
  } catch (error) {
    state.safe=null;state.audit=null;state.exportError=error.message;return false;
  }
}
function reportText() { return buildReport(state.safe); }
function auditText() { return JSON.stringify({ tool:'TraceTidy', policy:'strict-v1', preserveRoutes:state.preserveRoutes, ...state.audit }, null, 2); }
function render() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  app.innerHTML = `<aside class="sidebar">
    <a class="brand" href="./" aria-label="TraceTidy"><img src="./public/icon.svg" alt="" width="34" height="34"><span>Trace<span class="brand-light">Tidy</span><small>HAR WORKBENCH</small></span></a>
    <div class="sidebar-label">${t('workspace')}</div>
    <nav aria-label="${t('workspace')}">${[['requests','activity','workbench'],['share','shield','share'],['report','file','report']].map(([id,i,label]) => `<button data-tab="${id}" class="nav-item ${state.tab === id ? 'active' : ''}" ${state.har ? '' : 'disabled'}>${icon(i)}${t(label)}${state.tab === id ? '<span class="nav-dot"></span>' : ''}</button>`).join('')}</nav>
    <div class="sidebar-art" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
    <div class="steps"><small>${t('stepTitle')}</small>${[1,2,3].map(n=>`<div><b>0${n}</b><span>${t('step'+n)}</span></div>`).join('')}</div>
    <div class="sidebar-bottom"><div class="local-status"><i></i>${t('live')}</div><p>${t('noUpload')}</p><button class="text-button" data-action="about">${icon('info',15)}${t('privacy')}</button><small>v0.1.0 · MIT</small></div>
  </aside>
  <div class="shell"><header class="topbar"><div class="breadcrumb"><span>TraceTidy</span><span>/</span><strong>${t(state.tab === 'requests' ? 'workbench' : state.tab)}</strong></div><div class="top-actions"><span class="privacy-badge">${icon('lock',13)}${t('local')}</span><button class="language" data-action="language" aria-label="Change language">${state.lang === 'zh' ? 'EN' : '中文'}</button><button class="icon-button" data-action="about" aria-label="${t('about')}">${icon('info')}</button></div></header>
  <main><section class="hero"><div><div class="eyebrow"><span></span>${t('badge')}</div><h1>${t('headline')}</h1><p>${t('intro')}</p></div><div class="hero-actions"><button class="button secondary" data-action="demo">${icon('activity')}${t('demo')}</button><button class="button primary" data-action="import">${icon('upload')}${t('import')}</button></div></section>
  <div id="main-content"></div><footer class="footer"><span>${icon('lock',13)}${t('unsaved')}</span><button class="text-button" data-action="about">${t('about')}${icon('arrow',14)}</button></footer></main></div>
  <input id="file-input" type="file" accept=".har,.json,application/json" hidden>
  <div class="drop-overlay" aria-hidden="true"><div>${icon('upload',48)}<h2>${t('drop')}</h2><p>${t('dropSmall')}</p></div></div>
  <dialog id="help-dialog"><button class="icon-button dialog-close" data-action="close-help" aria-label="${t('close')}">${icon('close')}</button><div class="eyebrow">TRACETIDY / ${t('local')}</div><h2>${t('helpTitle')}</h2><p>${t('helpText')}</p><p>${t('helpList')}</p><div class="notice">${icon('info')}<p>${t('helpLimit')}</p></div><p>${t('helpCli')}</p><button class="button primary" data-action="close-help">${t('close')}</button></dialog>`;
  document.querySelector('#file-input').addEventListener('change', e => { if(e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
  renderMain();
}
function renderMain() {
  const main = document.querySelector('#main-content');
  if (!state.har) { main.innerHTML = `<section class="empty-import" role="button" tabindex="0" data-action="import">${icon('upload',32)}<h2>${t('blankTitle')}</h2><p>${t('blankText')}</p><span class="button primary">${t('import')}${icon('arrow')}</span><small>${t('dropSmall')}</small></section><p class="export-hint">${t('exportHint')}</p>`; return; }
  const s=state.summary;
  main.innerHTML = `<div class="file-strip"><div>${icon('file',16)}<strong>${esc(state.filename)}</strong><span class="file-tag">${state.demo ? t('demoFile') : t('original')}</span></div><button class="text-button" data-action="clear">${icon('trash',14)}${t('clear')}</button></div>
    <section class="stats" aria-label="Trace summary">${[
      [t('requests'),s.requestCount,`${s.hostCount} ${t('hosts')}`,'neutral'],
      [t('failed'),s.failureCount,t('failures'),s.failureCount ? 'danger' : 'neutral'],
      [t('span'),ms(s.durationMs),t('walltime'),'neutral'],
      [t('transferred'),bytes(s.totalBytes),t('reported'),'neutral']
    ].map(([label,value,note,color])=>`<div class="stat"><span>${label}</span><strong class="${color}">${esc(value)}</strong><small>${note}</small></div>`).join('')}</section>
    <div class="workspace-tabs" role="tablist" aria-label="Workbench views">${[['requests','workbench'],['share','share'],['report','report']].map(([id,label])=>`<button role="tab" id="tab-${id}" aria-controls="panel" aria-selected="${state.tab === id}" data-tab="${id}" class="${state.tab === id ? 'selected' : ''}">${t(label)}${id === 'share' ? '<span class="tab-tag">STRICT</span>' : ''}</button>`).join('')}<span class="workspace-meta">${icon('lock',12)}${t('local')}</span></div><section id="panel" role="tabpanel" aria-labelledby="tab-${state.tab}"></section>`;
  if (state.tab === 'requests') renderRequests();
  else if (state.tab === 'share') renderShare();
  else renderReport();
}
function filteredEntries() {
  const search = state.search.toLowerCase();
  return state.summary.entries.filter(e => `${e.method} ${e.url} ${e.status}`.toLowerCase().includes(search) && (state.filter === 'all' || (state.filter === 'errors' ? e.failed : e.time >= 1000))).sort((a,b)=>state.sort === 'slow' ? b.time-a.time : state.sort === 'size' ? b.bodySize-a.bodySize : a.startOffset-b.startOffset);
}
function renderRequests() {
  document.querySelector('#panel').innerHTML = `<div class="request-layout"><div class="request-list"><div class="toolbar"><label class="search">${icon('search',17)}<input id="search-input" type="search" value="${esc(state.search)}" placeholder="${t('search')}" aria-label="${t('search')}"></label><select id="status-filter" aria-label="Request filter">${[['all','all'],['errors','errors'],['slow','slow']].map(([val,label])=>`<option value="${val}" ${state.filter===val?'selected':''}>${t(label)}</option>`).join('')}</select><select id="sort-filter" aria-label="Request sort">${[['time','orderTime'],['slow','orderSlow'],['size','orderSize']].map(([val,label])=>`<option value="${val}" ${state.sort===val?'selected':''}>${t(label)}</option>`).join('')}</select></div><div id="request-rows"></div></div><aside id="inspector" class="inspector" aria-label="${t('details')}"></aside></div>`;
  document.querySelector('#search-input').addEventListener('input', e => {state.search=e.target.value;state.page=0;renderRows();});
  document.querySelector('#status-filter').addEventListener('change', e => {state.filter=e.target.value;state.page=0;renderRows();});
  document.querySelector('#sort-filter').addEventListener('change', e => {state.sort=e.target.value;state.page=0;renderRows();});
  renderRows(); renderInspector();
}
function renderRows() {
  const all = filteredEntries(), total = all.length, PAGE=50;
  state.page=Math.min(state.page,Math.max(0,Math.ceil(total/PAGE)-1));
  const entries=all.slice(state.page*PAGE,(state.page+1)*PAGE), span=Math.max(state.summary.durationMs,1);
  document.querySelector('#request-rows').innerHTML = `<div class="table-scroll"><table class="request-table"><thead><tr><th>${t('name')}</th><th>${t('status')}</th><th>${t('duration')}</th><th class="timeline-head">${t('waterfall')}<div><span>0</span><span>${ms(span/2)}</span><span>${ms(span)}</span></div></th><th>${t('size')}</th></tr></thead><tbody>${entries.map(e => `<tr class="${e.index===state.selected ? 'row-selected' : ''} ${e.failed ? 'failed-row' : ''}"><td><button class="request-name" data-select="${e.index}" title="${esc(e.url)}"><span class="method ${e.method==='POST'?'method-post':''}">${esc(e.method)}</span><span><strong>${esc(e.path || '/')}</strong><small>${esc(e.host)}</small></span></button></td><td><span class="status ${e.failed ? 'status-fail' : 'status-ok'}">${e.status || 'ERR'}</span></td><td class="duration ${e.time>=1000 ? 'slow-time':''}">${ms(e.time)}</td><td class="waterfall-cell"><div class="waterfall-track"><span class="waterfall-bar ${e.failed?'bar-fail':''}" style="left:${Math.min(100,Math.max(0,e.startOffset/span*100))}%;width:${Math.min(100,Math.max(.65,e.time/span*100))}%" title="${ms(e.startOffset)} → ${ms(e.startOffset+e.time)}"></span></div></td><td class="size">${bytes(e.bodySize)}</td></tr>`).join('')}</tbody></table>${!entries.length?`<div class="no-matches">${t('empty')}</div>`:''}</div><div class="table-bottom"><span><b>${total}</b> ${t('matches')}</span><div><button class="icon-button" data-action="previous" ${state.page===0?'disabled':''} aria-label="${t('previous')}">‹</button><span>${total ? state.page*PAGE+1:0}–${Math.min(total,(state.page+1)*PAGE)} / ${total}</span><button class="icon-button" data-action="next" ${(state.page+1)*PAGE>=total?'disabled':''} aria-label="${t('next')}">›</button></div></div>`;
}
function renderInspector() {
  const item=state.summary.entries.find(e=>e.index===state.selected), el=document.querySelector('#inspector');
  if (!item) {el.innerHTML=`<p>${t('zero')}</p>`;return;}
  const entry=state.har.log.entries[item.index], timing=entry.timings || {};
  const recordedTiming=key=>typeof timing[key]==='number'&&Number.isFinite(timing[key])?Math.max(0,timing[key]):0;
  const timingRows=[[t('blocked'),recordedTiming('blocked'),'muted'],[t('connection'),recordedTiming('connect')+recordedTiming('dns'),'blue'],[t('waiting'),recordedTiming('wait'),'lime'],[t('receive'),recordedTiming('receive'),'purple']];
  const originalHeaders=Array.isArray(entry.request.headers) ? entry.request.headers.filter(h=>h&&typeof h==='object').map(h=>`${typeof h.name==='string'?h.name:'?'}: ${typeof h.value==='string'?h.value:'?'}`).join('\n') : '';
  el.innerHTML=`<div class="inspector-heading"><span>${t('details')}</span>${icon('activity',15)}</div><div class="inspector-status"><span class="status ${item.failed?'status-fail':'status-ok'}">${item.status || 'ERR'}</span><small>${t('original')}</small></div><h3>${esc(item.path || '/')}</h3><div class="original-url">${esc(item.url)}</div><div class="detail-pairs"><div><span>${t('method')}</span><b>${esc(item.method)}</b></div><div><span>${t('duration')}</span><b>${ms(item.time)}</b></div><div><span>${t('elapsed')}</span><b>${ms(item.startOffset)}</b></div><div><span>${t('contentType')}</span><b>${esc(item.mimeType || '—')}</b></div></div><div class="timing-title">TIMING BREAKDOWN</div><div class="timing-rows">${timingRows.map(([label,value,color])=>`<div><span>${label}</span><b>${ms(Math.max(0,Number.isFinite(value)?value:0))}</b><i style="width:${Math.min(100,Math.max(1,(Number.isFinite(value)?value:0)/Math.max(item.time,1)*100))}%" class="timing-${color}"></i></div>`).join('')}</div><details class="headers-details"><summary>${t('raw')}</summary><p>${t('rawWarning')}</p><pre>${esc(originalHeaders || t('noHeaders'))}</pre></details><p class="local-note">${t('localNote')}</p><button class="button inspector-button" data-tab="share">${icon('shield',15)}${t('openShare')}${icon('arrow',15)}</button>`;
}
function renderShare() {
  document.querySelector('#panel').innerHTML = `<div class="share-layout"><section class="policy-panel"><div class="eyebrow">${t('strategy')}</div><h2>${t('reviewTitle')}</h2><p>${t('reviewIntro')}</p><div class="policy-badge">${icon('shield',20)}<div><strong>${routingLabel()}</strong><span>${routingDescription()}</span></div></div><label class="toggle-row"><span><strong>${t('preserve')}</strong><small>${t('preserveHint')}</small></span><input id="preserve-routes" type="checkbox" ${state.preserveRoutes?'checked':''}><span class="toggle-track" aria-hidden="true"></span></label><label class="custom-label" for="custom-terms">${t('custom')}</label><textarea id="custom-terms" rows="3" maxlength="4096" placeholder="${t('customPlaceholder')}">${esc(state.terms)}</textarea><small class="field-hint">${t('customHint')}</small><div id="audit-cards"></div><div class="notice">${icon('info',17)}<p>${t('reviewWarning')}</p></div></section><section class="export-panel"><div class="preview-heading"><span>${t('preview')}</span><div><button class="preview-tab ${state.preview==='har'?'active':''}" data-preview="har">${t('cleaned')}</button><button class="preview-tab ${state.preview==='audit'?'active':''}" data-preview="audit">${t('audit')}</button></div></div><pre id="export-preview" tabindex="0"></pre><div class="export-actions"><button class="button primary" data-action="bundle">${icon('download')}${t('download')}</button><button class="button secondary" data-action="har">${t('downloadHar')}</button><p>${t('packHint')}</p></div></section></div>`;
  document.querySelector('#preserve-routes').addEventListener('change',e=>{state.preserveRoutes=e.target.checked;updateSafe();renderPreview();});
  document.querySelector('#custom-terms').addEventListener('input',e=>{state.terms=e.target.value;clearTimeout(renderShare.timer);renderShare.timer=setTimeout(()=>{updateSafe();renderPreview();},180);});
  renderPreview();
}
function renderPreview() {
  const el=document.querySelector('#export-preview'); if(!el)return;
  document.querySelector('.policy-badge strong').textContent=routingLabel();
  document.querySelector('.policy-badge span').textContent=routingDescription();
  const full = state.exportError || (state.preview==='audit' ? auditText() : JSON.stringify(state.safe,null,2));
  el.textContent = full.length>180000 ? full.slice(0,180000)+'\n… Preview truncated; the download includes all requests.' : full;
  document.querySelector('#audit-cards').innerHTML=`<div class="audit-grid">${[['removedBodies','bodies'],['removedCookies','cookies'],['removedHeaders','headers'],['maskedQueryValues','queries']].map(([k,label])=>`<div><strong>${state.audit?.[k]||0}</strong><span>${t(label)}</span>${icon('check',12)}</div>`).join('')}</div>`;
  document.querySelectorAll('.export-actions button').forEach(button=>button.disabled=!state.safe);
  document.querySelector('#custom-terms').setAttribute('aria-invalid',String(!state.safe));
  document.querySelectorAll('[data-preview]').forEach(x=>x.classList.toggle('active',x.dataset.preview===state.preview));
}
function renderReport() {
  document.querySelector('#panel').innerHTML=`<div class="report-layout"><section class="report-intro"><div class="eyebrow">ISSUE-READY / MARKDOWN</div><h2>${t('reportTitle')}</h2><p>${t('reportIntro')}</p><div class="report-illustration" aria-hidden="true">${icon('file',48)}<div><span></span><span></span><span></span></div><b>.md</b></div><div class="notice">${icon('info',17)}<p>${t('reportHint')}</p></div><button class="button primary" data-action="bundle">${icon('download')}${t('download')}</button><p class="field-hint">${t('packHint')}</p></section><section class="report-preview"><div class="preview-heading"><span>${t('generated')}</span><div><button class="text-button" data-action="copy">${icon('copy',15)}${t('copy')}</button><button class="text-button" data-action="report">${icon('download',15)}${t('downloadReport')}</button></div></div><pre id="report-text" tabindex="0"></pre></section></div>`;
  document.querySelector('#report-text').textContent=state.safe ? reportText() : state.exportError;
}
async function loadFile(file) {
  if (state.busy) return;
  if (file.size>MAX_BYTES) {toast(t('fileError'),true);return;}
  try {state.busy=true;toast(t('busy')); const text=await file.text(); setTrace(validateHar(text),file.name,false);} catch(err) {toast(`${t('fileError')} ${err.message}`,true);} finally {state.busy=false;}
}
function setTrace(har,filename,demo) {
  state.har=har;state.summary=summarizeHar(har);state.filename=filename;state.demo=demo;state.tab='requests';state.search='';state.filter='all';state.page=0;state.terms='';state.preserveRoutes=false;
  state.selected=state.summary.entries.find(e=>e.failed)?.index ?? 0;updateSafe();render();toast(t(demo?'demoLoaded':'loaded'));
}
async function loadDemo() {
  if(state.busy)return;
  try{state.busy=true;const r=await fetch('./samples/demo.har');if(!r.ok)throw new Error('Sample unavailable');setTrace(validateHar(await r.text()),'demo.har',true);}catch(err){toast(err.message,true);}finally{state.busy=false;}
}
function download(content,name,type='application/json') {
  const blob=content instanceof Blob ? content : new Blob([content],{type});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
app.addEventListener('click',async e=>{
  const select=e.target.closest('[data-select]');if(select){state.selected=Number(select.dataset.select);renderRows();renderInspector();return;}
  const tab=e.target.closest('[data-tab]');if(tab){if(!state.har)return;updateSafe();state.tab=tab.dataset.tab;render();return;}
  const preview=e.target.closest('[data-preview]');if(preview){state.preview=preview.dataset.preview;renderPreview();return;}
  const button=e.target.closest('[data-action]');if(!button)return;
  const action=button.dataset.action;
  if(action==='import')document.querySelector('#file-input').click();
  else if(action==='demo')await loadDemo();
  else if(action==='language'){state.lang=state.lang==='en'?'zh':'en';render();}
  else if(action==='about')document.querySelector('#help-dialog').showModal();
  else if(action==='close-help')document.querySelector('#help-dialog').close();
  else if(action==='clear'){clearTimeout(renderShare.timer);Object.assign(state,{har:null,summary:null,safe:null,audit:null,terms:'',filename:'',tab:'requests',search:'',preserveRoutes:false});render();toast(t('cleared'));}
  else if(action==='previous'||action==='next'){state.page+=action==='next'?1:-1;renderRows();}
  else if(state.har){
    if(!updateSafe()){toast(state.exportError,true);return;}
    if(action==='har')download(JSON.stringify(state.safe,null,2)+'\n','safe.har');
    else if(action==='report')download(reportText(),'issue.md','text/markdown;charset=utf-8');
    else if(action==='bundle'){download(createZip({'safe.har':JSON.stringify(state.safe,null,2)+'\n','issue.md':reportText(),'audit.json':auditText()+'\n'}),'tracetidy-share.zip');toast(t('ready'));}
    else if(action==='copy'){try{await navigator.clipboard.writeText(reportText());toast(t('copied'));}catch{toast(t('copyFailed'),true);}}
  }
});
app.addEventListener('keydown',e=>{
  if((e.key==='Enter'||e.key===' ')&&e.target.matches('.empty-import')){e.preventDefault();document.querySelector('#file-input').click();}
  if(e.target.matches('[role="tab"]')&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
    e.preventDefault();const tabs=[...document.querySelectorAll('[role="tab"]')];const index=tabs.indexOf(e.target);const n=e.key==='Home'?0:e.key==='End'?2:(index+(e.key==='ArrowRight'?1:2))%3;state.tab=tabs[n].dataset.tab;render();document.querySelector(`#tab-${state.tab}`).focus();
  }
});
let dragDepth=0;
window.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;document.querySelector('.drop-overlay').classList.add('visible');}});
window.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
window.addEventListener('dragleave',e=>{e.preventDefault();if(--dragDepth<=0){dragDepth=0;document.querySelector('.drop-overlay').classList.remove('visible');}});
window.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;document.querySelector('.drop-overlay').classList.remove('visible');if(e.dataTransfer.files[0])loadFile(e.dataTransfer.files[0]);});
render();
loadDemo();
