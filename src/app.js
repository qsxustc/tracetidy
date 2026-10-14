import { TraceProcessor } from './processor.js';
import { words } from './i18n.js';
import { VERSION } from './version.js';
import { formatHeaderPreview } from './preview.js';

const app = document.querySelector('#app');
const MAX_BYTES = 25 * 1024 * 1024;
let processor;
let processorError;
try { processor = new TraceProcessor(); }
catch (error) { processorError = error.message; }
let sessionGeneration = 0;
let snapshotRevision = 0;
let snapshotTimer;
let comparisonRevision = 0;
const emptyDraft = () => ({ title: '', steps: '', expected: '', actual: '' });
const state = {
  lang: navigator.language.startsWith('zh') ? 'zh' : 'en',
  har: null, summary: null, insights: null, safe: null, audit: null,
  harText: '', reportText: '', auditText: '', exportError: '',
  tab: 'requests', selected: 0, search: '', filter: 'all', sort: 'time', page: 0,
  filename: '', demo: false, preserveRoutes: false, terms: '', preview: 'har',
  busy: false, processing: false, exporting: false, finding: null,
  view: 'requests', draft: emptyDraft(), filterCache: null,
  comparison: null, comparisonText: '', baselineFilename: '', comparisonLoading: false, comparisonError: '',
  comparisonFilter: 'all', comparisonSearch: '', comparisonPage: 0, latencyMs: 100, latencyPercent: 20
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
function acceptSnapshot(result) {
  for (const key of ['safe', 'audit', 'harText', 'reportText', 'auditText']) state[key] = result[key];
  state.processing = false;
  state.exportError = '';
}
function reportDetails() {
  const fields = [['Reproduction steps', state.draft.steps], ['Expected behavior', state.draft.expected], ['Actual behavior', state.draft.actual]];
  return {
    title: state.draft.title.trim() || 'Network investigation',
    notes: fields.filter(([, text]) => text.trim()).map(([label, text]) => `${label}:\n${text.trim()}`).join('\n\n')
  };
}
function refreshExportViews() {
  if (state.tab === 'share') renderPreview();
  if (state.tab === 'report') {
    const preview = document.querySelector('#report-text');
    if (preview) preview.textContent = state.processing ? t('snapshotBusy') : state.exportError || state.reportText;
  }
  document.querySelectorAll('[data-export]').forEach(button => {
    button.disabled = !state.safe || state.busy || state.processing || state.exporting || (button.dataset.action === 'bundle' && state.comparisonLoading);
  });
}
function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  const revision = ++snapshotRevision;
  const generation = sessionGeneration;
  state.safe = null;
  state.audit = null;
  state.processing = true;
  state.exportError = '';
  refreshExportViews();
  snapshotTimer = setTimeout(async () => {
    try {
      const result = await processor.redact({
        preserveRoutes: state.preserveRoutes,
        customTerms: state.terms.split('\n').map(term => term.trim()).filter(Boolean),
        reportDetails: reportDetails()
      });
      if (revision !== snapshotRevision || generation !== sessionGeneration) return;
      acceptSnapshot(result);
    } catch (error) {
      if (revision !== snapshotRevision || generation !== sessionGeneration || error.name === 'AbortError') return;
      state.processing = false;
      state.exportError = error.message;
    }
    refreshExportViews();
  }, 220);
}
function render() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  app.innerHTML = `<aside class="sidebar">
    <a class="brand" href="./" aria-label="TraceTidy"><img src="./public/icon.svg" alt="" width="34" height="34"><span>Trace<span class="brand-light">Tidy</span><small>HAR WORKBENCH</small></span></a>
    <div class="sidebar-label">${t('workspace')}</div>
    <nav aria-label="${t('workspace')}">${[['requests','activity','workbench'],['compare','clock','compare'],['share','shield','share'],['report','file','report']].map(([id,i,label]) => `<button data-tab="${id}" class="nav-item ${state.tab === id ? 'active' : ''}" ${state.har ? '' : 'disabled'}>${icon(i)}${t(label)}${state.tab === id ? '<span class="nav-dot"></span>' : ''}</button>`).join('')}</nav>
    <div class="sidebar-art" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
    <div class="steps"><small>${t('stepTitle')}</small>${[1,2,3].map(n=>`<div><b>0${n}</b><span>${t('step'+n)}</span></div>`).join('')}</div>
    <div class="sidebar-bottom"><div class="local-status"><i></i>${t('live')}</div><p>${t('noUpload')}</p><button class="text-button" data-action="about">${icon('info',15)}${t('privacy')}</button><a class="source-link" href="https://github.com/qsxustc/tracetidy" target="_blank" rel="noopener noreferrer">${t('github')}${icon('arrow',12)}</a><small>v${VERSION} · MIT</small></div>
  </aside>
  <div class="shell"><header class="topbar"><div class="breadcrumb"><span>TraceTidy</span><span>/</span><strong>${t(state.tab === 'requests' ? 'workbench' : state.tab)}</strong></div><div class="top-actions"><span class="privacy-badge">${icon('lock',13)}${t('local')}</span><button class="language" data-action="language" aria-label="Change language">${state.lang === 'zh' ? 'EN' : '中文'}</button><button class="icon-button" data-action="about" aria-label="${t('about')}">${icon('info')}</button></div></header>
  <main><section class="hero"><div><div class="eyebrow"><span></span>${t('badge')}</div><h1>${t('headline')}</h1><p>${t('intro')}</p></div><div class="hero-actions"><button class="button secondary" data-action="demo">${icon('activity')}${t('demo')}</button><button class="button primary" data-action="import">${icon('upload')}${t('import')}</button></div></section>
  <div id="main-content"></div><footer class="footer"><span>${icon('lock',13)}${t('unsaved')}</span><button class="text-button" data-action="about">${t('about')}${icon('arrow',14)}</button></footer></main></div>
  <input id="file-input" type="file" accept=".har,.json,application/json" hidden>
  <input id="baseline-input" type="file" accept=".har,.json,application/json" hidden>
  <div class="drop-overlay" aria-hidden="true"><div>${icon('upload',48)}<h2>${t('drop')}</h2><p>${t('dropSmall')}</p></div></div>
  <dialog id="help-dialog"><button class="icon-button dialog-close" data-action="close-help" aria-label="${t('close')}">${icon('close')}</button><div class="eyebrow">TRACETIDY / ${t('local')}</div><h2>${t('helpTitle')}</h2><p>${t('helpText')}</p><p>${t('helpList')}</p><div class="notice">${icon('info')}<p>${t('helpLimit')}</p></div><p>${t('helpCli')}</p><button class="button primary" data-action="close-help">${t('close')}</button></dialog>`;
  document.querySelector('#file-input').addEventListener('change', e => { if(e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
  document.querySelector('#baseline-input').addEventListener('change', e => { if (e.target.files[0]) loadBaselineFile(e.target.files[0]); e.target.value = ''; });
  renderMain();
  refreshExportViews();
}
function renderMain() {
  const main = document.querySelector('#main-content');
  if (state.busy) {
    main.innerHTML = `<section class="loading-panel" aria-live="polite" aria-busy="true"><span class="loading-spinner" aria-hidden="true"></span><h2>${t('busy')}</h2><p>${esc(state.filename)}</p><button class="button secondary" data-action="clear">${t('cancel')}</button></section>`;
    return;
  }
  if (!state.har) { main.innerHTML = `<section class="empty-import" role="button" tabindex="0" data-action="import">${icon('upload',32)}<h2>${t('blankTitle')}</h2><p>${t('blankText')}</p><span class="button primary">${t('import')}${icon('arrow')}</span><small>${t('dropSmall')}</small></section><p class="export-hint">${t('exportHint')}</p>`; return; }
  const s=state.summary;
  main.innerHTML = `<div class="file-strip"><div>${icon('file',16)}<strong>${esc(state.filename)}</strong><span class="file-tag">${state.demo ? t('demoFile') : t('original')}</span></div><button class="text-button" data-action="clear">${icon('trash',14)}${t('clear')}</button></div>
    <section class="stats" aria-label="Trace summary">${[
      [t('requests'),s.requestCount,`${s.hostCount} ${t('hosts')}`,'neutral'],
      [t('failed'),s.failureCount,t('failures'),s.failureCount ? 'danger' : 'neutral'],
      [t('span'),ms(s.durationMs),t('walltime'),'neutral'],
      [t('transferred'),bytes(s.totalBytes),t('reported'),'neutral']
    ].map(([label,value,note,color])=>`<div class="stat"><span>${label}</span><strong class="${color}">${esc(value)}</strong><small>${note}</small></div>`).join('')}</section>
    <div class="workspace-tabs" role="tablist" aria-label="Workbench views">${[['requests','workbench'],['compare','compare'],['share','share'],['report','report']].map(([id,label])=>`<button role="tab" id="tab-${id}" tabindex="${state.tab === id ? 0 : -1}" aria-controls="panel" aria-selected="${state.tab === id}" data-tab="${id}" class="${state.tab === id ? 'selected' : ''}">${t(label)}${id === 'share' ? '<span class="tab-tag">STRICT</span>' : ''}</button>`).join('')}<span class="workspace-meta">${icon('lock',12)}${t('local')}</span></div><section id="panel" role="tabpanel" aria-labelledby="tab-${state.tab}"></section>`;
  if (state.tab === 'requests') renderRequests();
  else if (state.tab === 'compare') renderCompare();
  else if (state.tab === 'share') renderShare();
  else renderReport();
}
function filteredEntries() {
  const search = state.search.toLowerCase();
  const cacheKey = JSON.stringify([search, state.filter, state.sort, state.finding?.id]);
  if (state.filterCache?.key === cacheKey) return state.filterCache.entries;
  const entries = state.summary.entries.filter(entry =>
    entry.searchText.includes(search)
    && (!state.finding || state.finding.indices.has(entry.index))
    && (state.filter === 'all' || (state.filter === 'errors' ? entry.failed : entry.time >= 1000))
  ).sort((a,b) => state.sort === 'slow' ? b.time-a.time : state.sort === 'size' ? b.bodySize-a.bodySize : a.startOffset-b.startOffset);
  state.filterCache = { key: cacheKey, entries };
  return entries;
}
function renderRequests() {
  const insights = state.insights;
  document.querySelector('#panel').innerHTML = `<section class="triage-section"><div class="triage-heading"><div><h2>${t('triage')}</h2><p>${t('triageHint')}</p></div><div class="latency-chip" title="${t('p95Hint')}"><span>P95</span><strong>${ms(insights.stats.p95Ms)}</strong></div></div><div class="triage-grid">${insights.findings.map(finding=>`<button class="triage-card severity-${finding.severity} ${state.finding?.id===finding.id?'active':''}" data-finding="${finding.id}" aria-pressed="${state.finding?.id===finding.id}"><div><strong>${finding.count}</strong>${icon('arrow',15)}</div><h3>${t(finding.id)}</h3><p>${t(finding.id+'-hint')}</p></button>`).join('') || `<p class="no-findings">${t('noFindings')}</p>`}</div></section><div class="request-tools"><div class="mode-buttons" role="group" aria-label="Request view"><button data-view="requests" aria-pressed="${state.view==='requests'}" class="${state.view==='requests'?'active':''}">${t('requestView')}</button><button data-view="endpoints" aria-pressed="${state.view==='endpoints'}" class="${state.view==='endpoints'?'active':''}">${t('endpointView')} <span>${insights.endpoints.length}</span></button></div><div id="finding-filter"></div></div><div class="request-layout"><div class="request-list"><div class="toolbar"><label class="search">${icon('search',17)}<input id="search-input" type="search" value="${esc(state.search)}" placeholder="${t('search')}" aria-label="${t('search')}"></label><select id="status-filter" aria-label="Request filter">${[['all','all'],['errors','errors'],['slow','slow']].map(([val,label])=>`<option value="${val}" ${state.filter===val?'selected':''}>${t(label)}</option>`).join('')}</select><select id="sort-filter" aria-label="Request sort">${[['time',state.view==='endpoints'?'totalTime':'orderTime'],['slow',state.view==='endpoints'?'p95':'orderSlow'],['size','orderSize']].map(([val,label])=>`<option value="${val}" ${state.sort===val?'selected':''}>${t(label)}</option>`).join('')}</select></div><div id="request-rows"></div></div><aside id="inspector" class="inspector" aria-label="${t('details')}"></aside></div>`;
  document.querySelector('#search-input').addEventListener('input', e => {state.search=e.target.value;state.page=0;renderRows();});
  document.querySelector('#status-filter').addEventListener('change', e => {state.filter=e.target.value;state.page=0;renderRows();});
  document.querySelector('#sort-filter').addEventListener('change', e => {state.sort=e.target.value;state.page=0;renderRows();});
  renderRows(); renderInspector();
}
function renderRows() {
  const matchingEntries = filteredEntries();
  if (!matchingEntries.some(entry => entry.index === state.selected)) {
    state.selected = matchingEntries[0]?.index ?? -1;
    renderInspector();
  }
  const activeFilter = document.querySelector('#finding-filter');
  if (activeFilter) activeFilter.innerHTML = state.finding ? `<button class="finding-filter" data-action="clear-finding">${esc(state.finding.title || t(state.finding.id))}${icon('close',12)}<span class="sr-only">${t('clearFinding')}</span></button>` : '';
  if (state.view === 'endpoints') { renderEndpoints(); return; }
  const all = filteredEntries(), total = all.length, PAGE=50;
  state.page=Math.min(state.page,Math.max(0,Math.ceil(total/PAGE)-1));
  const entries=all.slice(state.page*PAGE,(state.page+1)*PAGE), span=Math.max(state.summary.durationMs,1);
  document.querySelector('#request-rows').innerHTML = `<div class="table-scroll"><table class="request-table"><thead><tr><th>${t('name')}</th><th>${t('status')}</th><th>${t('duration')}</th><th class="timeline-head">${t('waterfall')}<div><span>0</span><span>${ms(span/2)}</span><span>${ms(span)}</span></div></th><th>${t('size')}</th></tr></thead><tbody>${entries.map(e => `<tr class="${e.index===state.selected ? 'row-selected' : ''} ${e.failed ? 'failed-row' : ''}"><td><button class="request-name" data-select="${e.index}" aria-pressed="${e.index===state.selected}" title="${esc(e.url)}"><span class="method ${e.method==='POST'?'method-post':''}">${esc(e.method)}</span><span><strong>${esc(e.path || '/')}</strong><small>${esc(e.host)}</small></span></button></td><td><span class="status ${e.failed ? 'status-fail' : 'status-ok'}">${e.status || 'ERR'}</span></td><td class="duration ${e.time>=1000 ? 'slow-time':''}">${ms(e.time)}</td><td class="waterfall-cell"><div class="waterfall-track"><span class="waterfall-bar ${e.failed?'bar-fail':''}" style="left:${Math.min(100,Math.max(0,e.startOffset/span*100))}%;width:${Math.min(100,Math.max(.65,e.time/span*100))}%" title="${ms(e.startOffset)} → ${ms(e.startOffset+e.time)}"></span></div></td><td class="size">${bytes(e.bodySize)}</td></tr>`).join('')}</tbody></table>${!entries.length?`<div class="no-matches">${t('empty')}</div>`:''}</div><div class="table-bottom"><span><b>${total}</b> ${t('matches')}</span><div><button class="icon-button" data-action="previous" ${state.page===0?'disabled':''} aria-label="${t('previous')}">‹</button><span>${total ? state.page*PAGE+1:0}–${Math.min(total,(state.page+1)*PAGE)} / ${total}</span><button class="icon-button" data-action="next" ${(state.page+1)*PAGE>=total?'disabled':''} aria-label="${t('next')}">›</button></div></div>`;
}
function renderEndpoints() {
  const matching = new Set(filteredEntries().map(entry => entry.index));
  const endpoints = state.insights.endpoints.map((entry, index) => ({...entry, groupIndex:index})).filter(entry => entry.indices.some(index => matching.has(index))).sort((a,b)=>state.sort==='slow'?b.p95Ms-a.p95Ms:state.sort==='size'?b.totalBytes-a.totalBytes:b.totalTimeMs-a.totalTimeMs);
  const PAGE = 50;
  state.page = Math.min(state.page, Math.max(0, Math.ceil(endpoints.length/PAGE)-1));
  const visible = endpoints.slice(state.page*PAGE,(state.page+1)*PAGE);
  document.querySelector('#request-rows').innerHTML = `<p class="endpoint-hint">${t('endpointHint')}</p><div class="table-scroll"><table class="endpoint-table"><thead><tr><th>${t('endpoint')}</th><th>${t('calls')}</th><th>${t('errorsCount')}</th><th>P95</th><th>${t('average')}</th><th>${t('totalTime')}</th></tr></thead><tbody>${visible.map(entry=>`<tr><td><button class="request-name" data-endpoint="${entry.groupIndex}" title="${esc(entry.url)}"><span class="method">${esc(entry.method)}</span><span><strong>${esc(entry.path)}</strong><small>${esc(entry.host)}</small></span></button></td><td>${entry.count}</td><td><span class="${entry.failures?'status status-fail':''}">${entry.failures}</span></td><td>${ms(entry.p95Ms)}</td><td>${ms(entry.avgMs)}</td><td>${ms(entry.totalTimeMs)}</td></tr>`).join('')}</tbody></table>${!visible.length?`<div class="no-matches">${t('empty')}</div>`:''}</div><div class="table-bottom"><span>${endpoints.length} ${t('endpointView')}</span><div><button class="icon-button" data-action="previous" ${state.page===0?'disabled':''} aria-label="${t('previous')}">‹</button><span>${endpoints.length?state.page*PAGE+1:0}–${Math.min(endpoints.length,(state.page+1)*PAGE)} / ${endpoints.length}</span><button class="icon-button" data-action="next" ${(state.page+1)*PAGE>=endpoints.length?'disabled':''} aria-label="${t('next')}">›</button></div></div>`;
}
function renderInspector() {
  const item=state.summary.entries.find(e=>e.index===state.selected), el=document.querySelector('#inspector');
  if (!item) {el.innerHTML=`<p>${t('zero')}</p>`;return;}
  const entry=state.har.log.entries[item.index], timing=entry.timings || {};
  const recordedTiming=key=>typeof timing[key]==='number'&&Number.isFinite(timing[key])?Math.max(0,timing[key]):0;
  const timingRows=[[t('blocked'),recordedTiming('blocked'),'muted'],[t('connection'),recordedTiming('connect')+recordedTiming('dns'),'blue'],[t('waiting'),recordedTiming('wait'),'lime'],[t('receive'),recordedTiming('receive'),'purple']];
  const originalHeaders = formatHeaderPreview(entry.request.headers);
  el.innerHTML=`<div class="inspector-heading"><span>${t('details')}</span>${icon('activity',15)}</div><div class="inspector-status"><span class="status ${item.failed?'status-fail':'status-ok'}">${item.status || 'ERR'}</span><small>${t('original')}</small></div><h3>${esc(item.path || '/')}</h3><div class="original-url">${esc(item.url)}</div><div class="detail-pairs"><div><span>${t('method')}</span><b>${esc(item.method)}</b></div><div><span>${t('duration')}</span><b>${ms(item.time)}</b></div><div><span>${t('elapsed')}</span><b>${ms(item.startOffset)}</b></div><div><span>${t('contentType')}</span><b>${esc(item.mimeType || '—')}</b></div></div><div class="timing-title">TIMING BREAKDOWN</div><div class="timing-rows">${timingRows.map(([label,value,color])=>`<div><span>${label}</span><b>${ms(Math.max(0,Number.isFinite(value)?value:0))}</b><i style="width:${Math.min(100,Math.max(1,(Number.isFinite(value)?value:0)/Math.max(item.time,1)*100))}%" class="timing-${color}"></i></div>`).join('')}</div><details class="headers-details"><summary>${t('raw')}</summary><p>${t('rawWarning')}</p><pre>${esc(originalHeaders.text || t('noHeaders'))}</pre>${originalHeaders.truncated ? `<p>${t('headersTruncated')}</p>` : ''}</details><p class="local-note">${t('localNote')}</p><button class="button inspector-button" data-tab="share">${icon('shield',15)}${t('openShare')}${icon('arrow',15)}</button>`;
}

const percent = n => `${(n * 100).toFixed(1)}%`;
const signed = (n, format = value => String(value)) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${format(Math.abs(n))}`;
function renderCompare() {
  const comparison = state.comparison;
  document.querySelector('#panel').innerHTML = `<section class="comparison-intro"><div><div class="eyebrow">${t('compareBadge')}</div><h2>${t('compareTitle')}</h2><p>${t('compareIntro')}</p></div><button class="button secondary" data-action="comparison-report" ${!state.comparisonText || state.comparisonLoading ? 'disabled' : ''}>${icon('download',16)}${t('downloadComparison')}</button></section>
  <div class="comparison-files"><section class="comparison-file"><span class="comparison-label">01 / ${t('baseline')}</span><strong>${esc(state.baselineFilename || t('noBaseline'))}</strong><p>${t('baselineHint')}</p><div><button class="button secondary" data-action="baseline-import">${icon('upload',15)}${t(state.baselineFilename ? 'replaceBaseline' : 'importBaseline')}</button><button class="text-button" data-action="baseline-demo">${t('compareSample')}</button>${state.baselineFilename ? `<button class="text-button" data-action="baseline-clear">${icon('close',13)}${t('removeBaseline')}</button>` : ''}</div></section><section class="comparison-file current-file"><span class="comparison-label">02 / ${t('current')}</span><strong>${esc(state.filename)}</strong><p>${t('currentHint')}</p><div><span class="file-tag">${t('local')}</span><span>${state.summary.requestCount} ${t('requests')}</span></div></section></div>
  <div class="comparison-thresholds"><span>${t('regressionRule')}</span><label for="latency-ms">P95 +<input id="latency-ms" type="number" required min="0" max="60000" step="1" value="${state.latencyMs}" ${!comparison || state.comparisonLoading ? 'disabled' : ''}> ms</label><span>${t('and')}</span><label for="latency-percent">+<input id="latency-percent" type="number" required min="0" max="1000" step="1" value="${state.latencyPercent}" ${!comparison || state.comparisonLoading ? 'disabled' : ''}> %</label><button class="button secondary" data-action="comparison-apply" ${!comparison || state.comparisonLoading ? 'disabled' : ''}>${t('applyThresholds')}</button><small>${t('failureRule')}</small></div>
  <div id="comparison-status" aria-live="polite">${state.comparisonLoading ? `<p class="comparison-message">${t('comparisonBusy')}</p>` : state.comparisonError ? `<p class="comparison-message comparison-error">${esc(state.comparisonError)}</p>` : ''}</div>
  ${comparison && !state.comparisonLoading ? `<section class="comparison-summary" aria-label="${t('comparisonSummary')}">${[['p95',ms(comparison.baseline.p95Ms),ms(comparison.current.p95Ms)],['failureRate',percent(comparison.baseline.failureRate),percent(comparison.current.failureRate)],['requests',comparison.baseline.requestCount,comparison.current.requestCount],['transferred',bytes(comparison.baseline.totalBytes),bytes(comparison.current.totalBytes)]].map(([label,before,after])=>`<div><span>${t(label)}</span><strong>${before}<i>→</i>${after}</strong><small>${t('baseline')} → ${t('current')}</small></div>`).join('')}</section><div class="comparison-tools"><label class="search">${icon('search',17)}<input id="comparison-search" type="search" value="${esc(state.comparisonSearch)}" placeholder="${t('compareSearch')}" aria-label="${t('compareSearch')}"></label><select id="comparison-filter" aria-label="${t('compareFilter')}">${['all','regressed','improved','added','removed','unchanged'].map(key=>`<option value="${key}" ${state.comparisonFilter===key?'selected':''}>${t('compare-'+key)}${key==='all'?'':` (${comparison.counts[key]})`}</option>`).join('')}</select></div><div id="comparison-rows"></div><details class="comparison-report-preview"><summary>${t('comparisonPreview')}</summary><p class="field-hint">${t('comparisonReportHint')}</p><pre>${esc(state.comparisonText.length > 180000 ? state.comparisonText.slice(0,180000)+`\n… ${t('previewTruncated')}` : state.comparisonText)}</pre></details>` : !state.comparisonLoading && !state.comparisonError ? `<div class="comparison-empty">${icon('clock',32)}<h3>${t('compareEmpty')}</h3><p>${t('compareEmptyHint')}</p></div>` : ''}
  <p class="comparison-caveat">${icon('info',15)}${t('compareCaveat')}</p>`;
  document.querySelector('#comparison-search')?.addEventListener('input', event => { state.comparisonSearch = event.target.value; state.comparisonPage = 0; renderComparisonRows(); });
  document.querySelector('#comparison-filter')?.addEventListener('change', event => { state.comparisonFilter = event.target.value; state.comparisonPage = 0; renderComparisonRows(); });
  if (comparison && !state.comparisonLoading) renderComparisonRows();
}
function renderComparisonRows() {
  const container = document.querySelector('#comparison-rows');
  if (!container || !state.comparison) return;
  const search = state.comparisonSearch.toLowerCase();
  const endpoints = state.comparison.endpoints.filter(endpoint => (state.comparisonFilter === 'all' || endpoint.classification === state.comparisonFilter) && `${endpoint.method} ${endpoint.url}`.toLowerCase().includes(search));
  const PAGE = 50;
  state.comparisonPage = Math.min(Math.max(0,state.comparisonPage),Math.max(0,Math.ceil(endpoints.length/PAGE)-1));
  const visible = endpoints.slice(state.comparisonPage*PAGE,(state.comparisonPage+1)*PAGE);
  const pair = (endpoint, key, format = value => String(value)) => `${endpoint.baseline ? format(endpoint.baseline[key]) : '—'} <span class="comparison-arrow">→</span> ${endpoint.current ? format(endpoint.current[key]) : '—'}`;
  container.innerHTML = `<div class="table-scroll"><table class="comparison-table"><thead><tr><th>${t('endpoint')}</th><th>${t('change')}</th><th>${t('calls')}</th><th>P95 / ${t('baseline')} → ${t('current')}</th><th>Δ P95</th><th>${t('failureRate')}</th></tr></thead><tbody>${visible.map(endpoint=>`<tr><td><button class="request-name" data-comparison-endpoint="${endpoint.id}" ${!endpoint.currentIndices.length?'disabled':''} title="${esc(endpoint.url)} · ${t('viewMatching')}"><span class="method">${esc(endpoint.method)}</span><span><strong>${esc(endpoint.path)}</strong><small>${esc(endpoint.host)}</small></span></button><small class="comparison-id">${endpoint.id}</small></td><td><span class="change-badge change-${endpoint.classification}">${t('compare-'+endpoint.classification)}</span></td><td>${pair(endpoint,'count')}</td><td>${pair(endpoint,'p95Ms',ms)}</td><td class="${endpoint.delta.p95Ms>0?'delta-up':endpoint.delta.p95Ms<0?'delta-down':''}">${endpoint.baseline&&endpoint.current ? `${signed(endpoint.delta.p95Ms,ms)}<small>${endpoint.delta.p95MsPercent===null?t('noPercentage'):signed(endpoint.delta.p95MsPercent,n=>`${n.toFixed(1)}%`)}</small>` : '—'}</td><td>${pair(endpoint,'failureRate',percent)}<small>${endpoint.baseline&&endpoint.current?signed(endpoint.delta.failureRate*100,n=>`${n.toFixed(1)} pp`):''}</small></td></tr>`).join('')}</tbody></table>${!visible.length?`<div class="no-matches">${t('compareNoMatches')}</div>`:''}</div><div class="table-bottom"><span>${endpoints.length} ${t('endpointView')} · ${t('baseline')} → ${t('current')}</span><div><button class="icon-button" data-action="comparison-previous" ${state.comparisonPage===0?'disabled':''} aria-label="${t('previous')}">‹</button><span>${endpoints.length?state.comparisonPage*PAGE+1:0}–${Math.min(endpoints.length,(state.comparisonPage+1)*PAGE)} / ${endpoints.length}</span><button class="icon-button" data-action="comparison-next" ${(state.comparisonPage+1)*PAGE>=endpoints.length?'disabled':''} aria-label="${t('next')}">›</button></div></div>`;
}
function refreshComparison() {
  if (state.tab === 'compare') renderCompare();
  refreshExportViews();
}
async function clearBaseline() {
  const revision = ++comparisonRevision, generation = sessionGeneration;
  state.comparison = null; state.comparisonText = ''; state.baselineFilename = ''; state.comparisonLoading = false; state.comparisonError = '';
  refreshComparison();
  try { await processor.clearBaseline(); }
  catch (error) {
    if (revision === comparisonRevision && generation === sessionGeneration && error.name !== 'AbortError') { state.comparisonError = error.message; refreshComparison(); }
  }
}
async function loadBaselineFile(file) {
  if (file.size > MAX_BYTES) { toast(t('fileError'),true); return; }
  await loadBaselineSource(() => file.text(), file.name);
}
async function loadBaselineSource(readSource, filename) {
  if (!state.har || state.busy || !processor) return;
  const revision = ++comparisonRevision, generation = sessionGeneration;
  state.comparison = null; state.comparisonText = ''; state.baselineFilename = filename; state.comparisonLoading = true; state.comparisonError = ''; state.comparisonPage = 0;
  refreshComparison();
  try {
    await processor.clearBaseline();
    if (revision !== comparisonRevision || generation !== sessionGeneration) return;
    const source = await readSource();
    if (revision !== comparisonRevision || generation !== sessionGeneration) return;
    let result = await processor.setBaseline(source);
    if (revision !== comparisonRevision || generation !== sessionGeneration) return;
    if (state.latencyMs !== 100 || state.latencyPercent !== 20) result = await processor.compare({latencyMs:state.latencyMs,latencyPercent:state.latencyPercent});
    if (revision !== comparisonRevision || generation !== sessionGeneration) return;
    state.comparison = result.comparison; state.comparisonText = result.comparisonText; state.comparisonLoading = false;
  } catch (error) {
    if (revision !== comparisonRevision || generation !== sessionGeneration || error.name === 'AbortError') return;
    state.comparisonLoading = false; state.comparisonError = error.message;
  }
  refreshComparison();
}
async function recalculateComparison() {
  if (!state.comparison || state.comparisonLoading) return;
  const revision = ++comparisonRevision, generation = sessionGeneration;
  state.comparisonLoading = true; state.comparisonText = ''; state.comparisonError = '';
  refreshComparison();
  try {
    const result = await processor.compare({latencyMs:state.latencyMs,latencyPercent:state.latencyPercent});
    if (revision !== comparisonRevision || generation !== sessionGeneration) return;
    state.comparison = result.comparison; state.comparisonText = result.comparisonText; state.comparisonLoading = false;
  } catch (error) {
    if (revision !== comparisonRevision || generation !== sessionGeneration || error.name === 'AbortError') return;
    state.comparison = null; state.comparisonLoading = false; state.comparisonError = error.message;
  }
  refreshComparison();
}

function renderShare() {
  document.querySelector('#panel').innerHTML = `<div class="share-layout"><section class="policy-panel"><div class="eyebrow">${t('strategy')}</div><h2>${t('reviewTitle')}</h2><p>${t('reviewIntro')}</p><div class="policy-badge">${icon('shield',20)}<div><strong>${routingLabel()}</strong><span>${routingDescription()}</span></div></div><label class="toggle-row"><span><strong>${t('preserve')}</strong><small>${t('preserveHint')}</small></span><input id="preserve-routes" type="checkbox" ${state.preserveRoutes?'checked':''}><span class="toggle-track" aria-hidden="true"></span></label><label class="custom-label" for="custom-terms">${t('custom')}</label><textarea id="custom-terms" rows="3" maxlength="4096" placeholder="${t('customPlaceholder')}">${esc(state.terms)}</textarea><small class="field-hint">${t('customHint')}</small><div id="audit-cards"></div><div class="notice">${icon('info',17)}<p>${t('reviewWarning')}</p></div></section><section class="export-panel"><div class="preview-heading"><span>${t('preview')}</span><div><button class="preview-tab ${state.preview==='har'?'active':''}" data-preview="har">${t('cleaned')}</button><button class="preview-tab ${state.preview==='audit'?'active':''}" data-preview="audit">${t('audit')}</button></div></div><pre id="export-preview" tabindex="0"></pre><div class="export-actions"><button class="button primary" data-action="bundle">${icon('download')}${t('download')}</button><button class="button secondary" data-action="har">${t('downloadHar')}</button><p>${t('packHint')}</p></div></section></div>`;
  document.querySelectorAll('.export-actions button').forEach(button=>button.dataset.export='');
  document.querySelector('#preserve-routes').addEventListener('change',e=>{state.preserveRoutes=e.target.checked;scheduleSnapshot();});
  document.querySelector('#custom-terms').addEventListener('input',e=>{state.terms=e.target.value;scheduleSnapshot();});
  renderPreview();
}
function renderPreview() {
  const el=document.querySelector('#export-preview'); if(!el)return;
  document.querySelector('.policy-badge strong').textContent=routingLabel();
  document.querySelector('.policy-badge span').textContent=routingDescription();
  const full = state.processing ? t('snapshotBusy') : state.exportError || (state.preview==='audit' ? state.auditText : state.harText);
  el.textContent = full.length>180000 ? full.slice(0,180000)+`\n… ${t('previewTruncated')}` : full;
  document.querySelector('#audit-cards').innerHTML=`<div class="audit-grid">${[['removedBodies','bodies'],['removedCookies','cookies'],['removedHeaders','headers'],['maskedQueryValues','queries']].map(([k,label])=>`<div><strong>${state.audit?.[k]||0}</strong><span>${t(label)}</span>${icon('check',12)}</div>`).join('')}</div>`;
  document.querySelectorAll('.export-actions button').forEach(button=>button.disabled=!state.safe||state.processing||state.exporting);
  document.querySelector('#custom-terms').setAttribute('aria-invalid',String(Boolean(state.exportError)));
  document.querySelectorAll('[data-preview]').forEach(x=>x.classList.toggle('active',x.dataset.preview===state.preview));
}
function renderReport() {
  document.querySelector('#panel').innerHTML=`<div class="report-layout"><section class="report-intro"><div class="eyebrow">ISSUE-READY / MARKDOWN</div><h2>${t('reportTitle')}</h2><p>${t('reportIntro')}</p><form class="report-form" aria-label="${t('reportForm')}"><label for="issue-title">${t('issueTitle')}</label><input id="issue-title" data-draft="title" maxlength="240" value="${esc(state.draft.title)}" placeholder="${t('issueTitlePlaceholder')}">${['steps','expected','actual'].map(key=>`<label for="issue-${key}">${t(key)}</label><textarea id="issue-${key}" data-draft="${key}" maxlength="1400" rows="${key==='steps'?3:2}" placeholder="${t(key+'Placeholder')}">${esc(state.draft[key])}</textarea>`).join('')}</form><div class="notice">${icon('info',17)}<p>${t('authorHint')}</p></div><button class="button primary" data-export data-action="bundle">${icon('download')}${t('download')}</button><p class="field-hint">${t('packHint')}</p></section><section class="report-preview"><div class="preview-heading"><span>${t('generated')}</span><div><button class="text-button" data-export data-action="copy">${icon('copy',15)}${t('copy')}</button><button class="text-button" data-export data-action="report">${icon('download',15)}${t('downloadReport')}</button></div></div><pre id="report-text" tabindex="0"></pre></section></div>`;
  document.querySelector('.report-form').addEventListener('submit',event=>event.preventDefault());
  document.querySelectorAll('[data-draft]').forEach(field=>field.addEventListener('input',()=>{
    state.draft[field.dataset.draft]=field.value;
    scheduleSnapshot();
  }));
  refreshExportViews();
}
async function loadFile(file) {
  if (file.size>MAX_BYTES) {toast(t('fileError'),true);return;}
  await loadSource(()=>file.text(),file.name,false);
}
function resetTrace() {
  Object.assign(state,{
    har:null,summary:null,insights:null,safe:null,audit:null,harText:'',reportText:'',auditText:'',
    terms:'',filename:'',tab:'requests',search:'',filter:'all',sort:'time',page:0,preserveRoutes:false,
    busy:false,processing:false,exporting:false,exportError:'',finding:null,view:'requests',
    draft:emptyDraft(),filterCache:null,
    comparison:null,comparisonText:'',baselineFilename:'',comparisonLoading:false,comparisonError:'',
    comparisonFilter:'all',comparisonSearch:'',comparisonPage:0,latencyMs:100,latencyPercent:20
  });
}
function clearSession() {
  sessionGeneration++;
  comparisonRevision++;
  snapshotRevision++;
  clearTimeout(snapshotTimer);
  processor?.clear();
  resetTrace();
  render();
}
async function loadSource(readSource,filename,demo) {
  if (!processor) { toast(processorError, true); return; }
  clearSession();
  const generation=sessionGeneration;
  state.busy=true;
  state.filename=filename;
  render();
  try {
    const source=await readSource();
    if(generation!==sessionGeneration)return;
    const result=await processor.load(source);
    if(generation!==sessionGeneration)return;
    state.har=result.har;
    state.summary=result.summary;
    state.insights=result.insights;
    state.filename=filename;
    state.demo=demo;
    state.busy=false;
    for(const entry of state.summary.entries)entry.searchText=`${entry.method} ${entry.url} ${entry.status}`.toLowerCase();
    state.selected=state.summary.entries.find(entry=>entry.failed)?.index??0;
    acceptSnapshot(result);
    render();
    toast(t(demo?'demoLoaded':'loaded'));
  } catch(error) {
    if(generation!==sessionGeneration||error.name==='AbortError')return;
    state.busy=false;
    render();
    toast(error.message,true);
  }
}
async function loadDemo() {
  await loadSource(async()=>{
    const response=await fetch('./samples/demo.har');
    if(!response.ok)throw new Error(t('sampleUnavailable'));
    return response.text();
  },'demo.har',true);
}
function download(content,name,type='application/json') {
  const blob=content instanceof Blob ? content : new Blob([content],{type});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
app.addEventListener('click', async event => {
  const comparisonEndpoint = event.target.closest('[data-comparison-endpoint]');
  if (comparisonEndpoint) {
    const endpoint = state.comparison?.endpoints.find(item => item.id === comparisonEndpoint.dataset.comparisonEndpoint);
    if (!endpoint?.currentIndices.length) return;
    state.finding = { id: `comparison-${endpoint.id}`, title: `${endpoint.method} ${endpoint.path}`, indices: new Set(endpoint.currentIndices) };
    state.view = 'requests'; state.page = 0; state.search = ''; state.filter = 'all';
    state.selected = endpoint.currentIndices[0]; state.tab = 'requests'; render();
    document.querySelector(`[data-select="${state.selected}"]`)?.focus();
    return;
  }
  const select = event.target.closest('[data-select]');
  if (select) {
    state.selected = Number(select.dataset.select);
    document.querySelectorAll('[data-select]').forEach(button => {
      const selected = Number(button.dataset.select) === state.selected;
      button.setAttribute('aria-pressed', String(selected));
      button.closest('tr').classList.toggle('row-selected', selected);
    });
    renderInspector();
    return;
  }
  const findingButton = event.target.closest('[data-finding]');
  if (findingButton) {
    const finding = state.insights.findings.find(item => item.id === findingButton.dataset.finding);
    state.finding = state.finding?.id === finding.id ? null : { id: finding.id, indices: new Set(finding.indices) };
    state.view = 'requests'; state.page = 0; state.search = ''; state.filter = 'all';
    state.selected = filteredEntries()[0]?.index ?? -1;
    renderRequests();
    document.querySelector(`[data-finding="${finding.id}"]`).focus();
    return;
  }
  const endpointButton = event.target.closest('[data-endpoint]');
  if (endpointButton) {
    const index = Number(endpointButton.dataset.endpoint);
    const endpoint = state.insights.endpoints[index];
    state.finding = { id: `endpoint-${index}`, title: `${endpoint.method} ${endpoint.path}`, indices: new Set(endpoint.indices) };
    state.view = 'requests'; state.page = 0; state.search = ''; state.filter = 'all';
    state.selected = filteredEntries()[0]?.index ?? -1;
    renderRequests();
    document.querySelector(`[data-select="${state.selected}"]`)?.focus();
    return;
  }
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    state.view = viewButton.dataset.view; state.page = 0;
    renderRequests();
    document.querySelector(`[data-view="${state.view}"]`).focus();
    return;
  }
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    if (!state.har || state.busy) return;
    state.tab = tab.dataset.tab;
    const fromTablist = tab.getAttribute('role') === 'tab';
    render();
    (fromTablist ? document.querySelector(`#tab-${state.tab}`) : document.querySelector(`nav [data-tab="${state.tab}"]`))?.focus();
    return;
  }
  const preview = event.target.closest('[data-preview]');
  if (preview) { state.preview = preview.dataset.preview; renderPreview(); return; }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'import') document.querySelector('#file-input').click();
  else if (action === 'demo') await loadDemo();
  else if (action === 'baseline-import') document.querySelector('#baseline-input').click();
  else if (action === 'baseline-demo') await loadBaselineSource(async () => {
    const response = await fetch('./samples/baseline.har');
    if (!response.ok) throw new Error(t('sampleUnavailable'));
    return response.text();
  }, 'baseline.har');
  else if (action === 'baseline-clear') await clearBaseline();
  else if (action === 'comparison-apply') {
    const abs = document.querySelector('#latency-ms'), relative = document.querySelector('#latency-percent');
    if (!abs.reportValidity() || !relative.reportValidity()) return;
    state.latencyMs = Number(abs.value); state.latencyPercent = Number(relative.value);
    await recalculateComparison();
  }
  else if (action === 'comparison-report') {
    if (state.comparisonText && !state.comparisonLoading) download(state.comparisonText, 'comparison.md', 'text/markdown;charset=utf-8');
  }
  else if (action === 'comparison-previous' || action === 'comparison-next') {
    state.comparisonPage += action === 'comparison-next' ? 1 : -1; renderComparisonRows();
    document.querySelector(`[data-action="${action}"]`)?.focus();
  }
  else if (action === 'language') {
    state.lang = state.lang === 'en' ? 'zh' : 'en';
    clearTimeout(toast.timer);
    document.querySelector('#toast').className = '';
    render();
    document.querySelector('.language').focus();
  }
  else if (action === 'about') document.querySelector('#help-dialog').showModal();
  else if (action === 'close-help') document.querySelector('#help-dialog').close();
  else if (action === 'clear') { clearSession(); toast(t('cleared')); }
  else if (action === 'clear-finding') { state.finding = null; state.page = 0; renderRequests(); document.querySelector('#search-input').focus(); }
  else if (action === 'previous' || action === 'next') { state.page += action === 'next' ? 1 : -1; renderRows(); document.querySelector(`[data-action="${action}"]`)?.focus(); }
  else if (['har', 'report', 'bundle', 'copy'].includes(action)) {
    if (!state.safe || state.busy || state.processing || state.exporting || (action === 'bundle' && state.comparisonLoading)) return;
    if (action === 'har') download(state.harText, 'safe.har');
    else if (action === 'report') download(state.reportText, 'issue.md', 'text/markdown;charset=utf-8');
    else if (action === 'copy') {
      try { await navigator.clipboard.writeText(state.reportText); toast(t('copied')); }
      catch { toast(t('copyFailed'), true); }
    } else {
      const generation = sessionGeneration, revision = snapshotRevision, comparisonVersion = comparisonRevision;
      state.exporting = true;
      refreshExportViews();
      toast(t('preparing'));
      try {
        const blob = await processor.bundle();
        if (generation !== sessionGeneration || revision !== snapshotRevision || comparisonVersion !== comparisonRevision) return;
        download(blob, 'tracetidy-share.zip');
        toast(t('ready'));
      } catch (error) {
        if (generation === sessionGeneration && error.name !== 'AbortError') toast(error.message, true);
      } finally {
        if (generation === sessionGeneration) { state.exporting = false; refreshExportViews(); }
      }
    }
  }
});
app.addEventListener('keydown',e=>{
  if((e.key==='Enter'||e.key===' ')&&e.target.matches('.empty-import')){e.preventDefault();document.querySelector('#file-input').click();}
  if(e.target.matches('[role="tab"]')&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
    e.preventDefault();const tabs=[...document.querySelectorAll('[role="tab"]')];const index=tabs.indexOf(e.target);const n=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length;state.tab=tabs[n].dataset.tab;render();document.querySelector(`#tab-${state.tab}`).focus();
  }
});
let dragDepth=0;
window.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;document.querySelector('.drop-overlay').classList.add('visible');}});
window.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
window.addEventListener('dragleave',e=>{e.preventDefault();if(--dragDepth<=0){dragDepth=0;document.querySelector('.drop-overlay').classList.remove('visible');}});
window.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;document.querySelector('.drop-overlay').classList.remove('visible');if(e.dataTransfer.files[0])loadFile(e.dataTransfer.files[0]);});
render();
loadDemo();
