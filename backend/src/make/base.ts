// The one base stylesheet and component set every Make artifact builds on (L181): the app's
// design language (system font stack with PingFang SC, a comfortable line length, light and dark
// through prefers-color-scheme, a clean print layout). finish_build injects it into the model's
// HTML, so artifacts stay self-contained (no CDN, no external fonts) and look like the app.
import { SLIDE_CSS, SLIDE_SCRIPT, SLIDE_STYLE_VERSION } from "./slides.ts";

/** Marks everything the server injects, so a rebuild strips and re-injects it instead of stacking. */
export const BASE_ATTR = "data-duet-base";
/** The model puts this on each element an edit changed; the page glows them accent orange ~3 s. */
export const CHANGED_ATTR = "data-duet-changed";

/**
 * Inside the page: inline styles and scripts only, images/fonts/media as data: or blob: URIs, and
 * no network at all (connect-src 'none' keeps a page from calling the backend API with anything).
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join("; ");

/** M9 (contract §6): the page is laid out at the phone's width and never zooms or pans sideways. */
export const ARTIFACT_VIEWPORT = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

export const BASE_CSS = `
:root{color-scheme:light dark;
--duet-bg:#FAF9F7;--duet-surface:#FFFFFF;--duet-surface-2:#F3F1EE;--duet-text:#1F1E1D;--duet-muted:#6F6C67;
--duet-border:rgba(31,30,29,.10);--duet-accent:#D65A45;--duet-accent-soft:rgba(214,90,69,.14);
--duet-blue:#3A78D4;--duet-purple:#8A5CD1;--duet-green:#3A9A5B;--duet-red:#D14A3B;--duet-yellow:#C99A22;
--duet-radius:16px;--duet-radius-sm:10px;--duet-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.05);
--duet-measure:68ch;
--duet-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","PingFang SC","Hiragino Sans GB","Helvetica Neue","Segoe UI",Roboto,"Noto Sans CJK SC","Microsoft YaHei",sans-serif;
--duet-serif:"New York",ui-serif,Georgia,"Songti SC","Noto Serif CJK SC",serif;
--duet-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--duet-bg:#1C1B1A;--duet-surface:#262524;--duet-surface-2:#2F2E2C;--duet-text:#F2F0ED;
--duet-muted:#A39F99;--duet-border:rgba(255,255,255,.12);--duet-accent:#E0705C;--duet-accent-soft:rgba(224,112,92,.20);
--duet-blue:#6A9BE6;--duet-purple:#A884E0;--duet-green:#5DBB7C;--duet-red:#E36A5C;--duet-yellow:#E0B848;--duet-shadow:none}}
*,*::before,*::after{box-sizing:border-box}
html,body{overflow-x:hidden;max-width:100%;touch-action:pan-y;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--duet-bg);color:var(--duet-text);font-family:var(--duet-font);font-size:17px;line-height:1.55;overflow-wrap:break-word;
-webkit-font-smoothing:antialiased;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
h1,h2,h3,h4{line-height:1.25;margin:1.4em 0 .5em;font-weight:600;letter-spacing:-.01em}
h1{font-family:var(--duet-serif);font-size:2rem}h2{font-size:1.35rem}h3{font-size:1.1rem}h4{font-size:1rem;color:var(--duet-muted)}
p,ul,ol,blockquote,table,pre{margin:0 0 1em}
a{color:var(--duet-accent);text-decoration:none}a:hover{text-decoration:underline}
img,svg,canvas,video{max-width:100%;height:auto}
hr{border:0;border-top:1px solid var(--duet-border);margin:2em 0}
blockquote{margin-left:0;padding-left:1em;border-left:3px solid var(--duet-accent);color:var(--duet-muted)}
code,pre{font-family:var(--duet-mono);font-size:.9em}
pre{background:var(--duet-surface-2);padding:12px 14px;border-radius:var(--duet-radius-sm);overflow:auto}
table{border-collapse:collapse;width:100%;font-size:.95em}
.duet-table-wrap{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y;margin:0 0 1em}
.duet-table-wrap>table{margin:0}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--duet-border);vertical-align:top}
th{font-weight:600;color:var(--duet-muted);font-size:.85em;text-transform:none}
.duet-page{max-width:var(--duet-measure);margin:0 auto;padding:24px 20px 48px}
.duet-wide{max-width:1100px}
.duet-hero{padding:32px 0 8px}.duet-hero h1{margin-top:0}
.duet-eyebrow{font-size:.8rem;font-weight:600;color:var(--duet-accent);letter-spacing:.02em;margin-bottom:6px}
.duet-lead{font-size:1.15rem;color:var(--duet-muted)}
.duet-muted{color:var(--duet-muted)}
.duet-section{margin:32px 0}
.duet-card{background:var(--duet-surface);border:1px solid var(--duet-border);border-radius:var(--duet-radius);padding:16px 18px;box-shadow:var(--duet-shadow)}
.duet-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.duet-grid-2{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}
.duet-metric{display:flex;flex-direction:column;gap:4px}
.duet-metric-label{font-size:.85rem;color:var(--duet-muted)}
.duet-metric-value{font-size:1.8rem;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.duet-metric-delta{font-size:.85rem;font-variant-numeric:tabular-nums}
.duet-up{color:var(--duet-green)}.duet-down{color:var(--duet-red)}
.duet-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--duet-surface-2);font-size:.85rem}
.duet-chip-accent{background:var(--duet-accent-soft);color:var(--duet-accent)}
.duet-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 20px;border-radius:999px;border:0;
background:var(--duet-text);color:var(--duet-bg);font:inherit;font-weight:600;cursor:pointer}
.duet-button-accent{background:var(--duet-accent);color:#fff}
.duet-button-outline{background:transparent;color:var(--duet-text);border:1px solid var(--duet-border)}
.duet-list{list-style:none;padding:0}.duet-list>li{padding:12px 0;border-bottom:1px solid var(--duet-border)}
.duet-callout{background:var(--duet-accent-soft);border-radius:var(--duet-radius-sm);padding:12px 14px}
.duet-toc{background:var(--duet-surface-2);border-radius:var(--duet-radius-sm);padding:12px 16px;font-size:.95rem}
.duet-toc ol,.duet-toc ul{margin:0;padding-left:1.2em}
.duet-bar{height:8px;border-radius:999px;background:var(--duet-surface-2);overflow:hidden}
.duet-bar>span{display:block;height:100%;background:var(--duet-accent);border-radius:inherit}
.duet-deck{scroll-snap-type:y mandatory}
.duet-slide{min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:48px 32px;scroll-snap-align:start;
border-bottom:1px solid var(--duet-border)}
.duet-slide h1,.duet-slide h2{font-family:var(--duet-serif)}
.duet-swatch{display:flex;flex-direction:column;gap:6px}
.duet-swatch>i{display:block;height:64px;border-radius:var(--duet-radius-sm);border:1px solid var(--duet-border)}
.duet-dash{display:flex;flex-direction:column;gap:14px}
.duet-dash-head{margin:8px 0 6px}
.duet-dash-title{font-family:var(--duet-serif);font-size:2rem;font-weight:600;line-height:1.15;letter-spacing:-.015em;margin:0 0 6px}
.duet-dash-sub{color:var(--duet-muted);font-size:.95rem;margin:0}
.duet-panel{background:var(--duet-surface);border:1px solid var(--duet-border);border-radius:16px;padding:18px 18px 16px}
.duet-panel-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px;margin-bottom:12px}
.duet-panel-title{font-size:1.05rem;font-weight:600;margin:0;min-width:0}
.duet-panel-meta{font-size:.8rem;color:var(--duet-muted);white-space:nowrap}
.duet-funnel{display:flex;flex-direction:column}
.duet-funnel-row{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;row-gap:8px;align-items:start;padding:14px 0;border-top:1px solid var(--duet-border)}
.duet-funnel-row:first-child{border-top:0;padding-top:2px}
.duet-funnel-label{font-weight:600;font-size:1rem}
.duet-funnel-sub{display:block;color:var(--duet-muted);font-size:.82rem;font-weight:400;margin-top:2px}
.duet-funnel-figure{text-align:right}
.duet-funnel-value{display:block;font-size:1.6rem;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.duet-delta{display:inline-block;font-size:.8rem;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}
.duet-delta.duet-up{color:var(--duet-green)}.duet-delta.duet-down{color:var(--duet-red)}.duet-delta.duet-flat{color:var(--duet-muted)}
.duet-compare{grid-column:1/-1;display:flex;flex-direction:column;gap:4px}
.duet-compare-bar{position:relative;height:4px;border-radius:999px;background:var(--duet-surface-2);overflow:hidden}
.duet-compare-bar>span{position:absolute;left:0;top:0;bottom:0;border-radius:inherit;background:var(--duet-accent)}
.duet-compare-bar.duet-prev>span{background:var(--duet-muted);opacity:.45}
.duet-chart{position:relative;width:100%;min-height:180px}
.duet-chart svg{display:block;width:100%;height:auto;overflow:visible}
.duet-chart-grid{stroke:var(--duet-border);stroke-width:1}
.duet-chart-axis{fill:var(--duet-muted);font-family:var(--duet-font);font-size:11px;font-variant-numeric:tabular-nums}
.duet-chart-empty{color:var(--duet-muted);font-size:.9rem;padding:24px 0;text-align:center}
.duet-legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:.82rem;color:var(--duet-muted);margin-top:10px}
.duet-legend>span{display:inline-flex;align-items:center;gap:6px}
.duet-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--duet-accent)}
.duet-notes{font-size:.9rem;color:var(--duet-muted)}
.duet-notes p{margin:0 0 .7em}.duet-notes p:last-child{margin-bottom:0}
.duet-notes b,.duet-notes strong{color:var(--duet-text);font-weight:600}
[${CHANGED_ATTR}]{animation:duet-glow 3s ease-out 1;border-radius:6px}
@keyframes duet-glow{0%,55%{background-color:var(--duet-accent-soft);box-shadow:0 0 0 4px var(--duet-accent-soft)}100%{background-color:transparent;box-shadow:0 0 0 4px transparent}}
.duet-grid>*,.duet-grid-2>*,.duet-dash>*,.duet-metric>*{min-width:0}
@media (max-width:520px){body{font-size:16px}h1{font-size:1.7rem}.duet-page{padding:16px 16px 40px}.duet-grid-2{grid-template-columns:1fr}
.duet-grid{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}.duet-slide{padding:32px 20px}
.duet-dash-title{font-size:1.7rem}.duet-panel{padding:16px 14px 14px}.duet-funnel-value{font-size:1.4rem}}
@media print{:root{color-scheme:light}body{background:#fff;color:#000;font-size:11pt;padding:0}
.duet-card,.duet-panel{box-shadow:none;break-inside:avoid}.duet-page{max-width:none;padding:0}
.duet-slide{min-height:auto;break-after:page;border:0}.duet-noprint{display:none!important}
a{color:inherit}[${CHANGED_ATTR}]{animation:none}h1,h2,h3{break-after:avoid}table,pre,blockquote{break-inside:avoid}
@page{margin:18mm}}
`.trim();

/** The scroll wrapper every table gets (M9): wide tables scroll inside it, never the page. */
export const TABLE_WRAP_CLASS = "duet-table-wrap";

/**
 * At the end of <body>: every table not already in a wrapper goes into a horizontal scroll
 * wrapper (so a wide table never scrolls the whole page on a 390 pt phone), then, after an
 * edit, the first changed passage scrolls into view (the glow itself is CSS).
 */
export const BASE_SCRIPT = `(function(){var ts=document.querySelectorAll("table");for(var i=0;i<ts.length;i++){var t=ts[i],p=t.parentNode;if(!p||(p.classList&&p.classList.contains("${TABLE_WRAP_CLASS}")))continue;var w=document.createElement("div");w.className="${TABLE_WRAP_CLASS}";p.insertBefore(w,t);w.appendChild(t);}var el=document.querySelector("[${CHANGED_ATTR}]");if(el&&el.scrollIntoView){el.scrollIntoView({block:"center"});}})();`;

/** Runtime fitting is kept separate so the table/glow script remains stable for old pages. */
export const PAGE_SCRIPT = `${BASE_SCRIPT}\n${SLIDE_SCRIPT}`;

/**
 * duetBars(el, data, opts) for dashboards (M8): per-day bar charts as inline SVG with a light
 * grid, 3 y-ticks, month labels for ISO dates, stacked series with a legend, fills from the
 * theme's variables (so light and dark both work), and a debounced redraw on resize. No library,
 * no network. data: [{ label, value }] or { labels, series: [{ name, values, color }] }; opts:
 * { height, unit, stacked, legend, label, empty, locale }. Injected into <head>, so a page's own
 * scripts can call it anywhere. Written without backslashes or template placeholders on purpose.
 */
export const CHART_SCRIPT = `(function(){
var VARS={accent:"--duet-accent",blue:"--duet-blue",purple:"--duet-purple",green:"--duet-green",yellow:"--duet-yellow",red:"--duet-red",muted:"--duet-muted"};
var ORDER=["accent","blue","purple","green","yellow","red"];
var STEPS=[1,1.2,1.5,2,2.5,3,4,5,6,8,10];
var charts=[],timer=0;
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return "&#"+c.charCodeAt(0)+";";});}
function r2(v){return Math.round(v*100)/100;}
function color(c,i){var n=c||ORDER[i%ORDER.length];if(VARS[n])return "var("+VARS[n]+")";if(/^#[0-9a-fA-F]{3,8}$/.test(n))return n;return "var("+VARS[ORDER[i%ORDER.length]]+")";}
function lang(o){return o.locale||document.documentElement.lang||"en";}
function fmt(v,o){var s;try{s=new Intl.NumberFormat(lang(o),{maximumFractionDigits:v<10?1:0,notation:v>=10000?"compact":"standard"}).format(v);}catch(e){s=String(Math.round(v*10)/10);}return s+(o.unit||"");}
function nice(m){if(!(m>0))return 1;var p=Math.pow(10,Math.floor(Math.log(m)/Math.LN10));for(var i=0;i<STEPS.length;i++){if(STEPS[i]*p>=m-1e-9)return STEPS[i]*p;}return 10*p;}
function day(l){var m=/^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(String(l));return m?new Date(Date.UTC(+m[1],+m[2]-1,+m[3])):null;}
function dateText(d,o,withDay){try{return new Intl.DateTimeFormat(lang(o),withDay?{month:"short",day:"numeric",timeZone:"UTC"}:{month:"short",timeZone:"UTC"}).format(d);}catch(e){return (d.getUTCMonth()+1)+(withDay?"/"+d.getUTCDate():"");}}
function norm(d,o){
if(Array.isArray(d))return {labels:d.map(function(p){return p&&p.label!=null?p.label:"";}),series:[{name:o.name||"",color:o.color,values:d.map(function(p){return p?p.value:0;})}]};
if(d&&Array.isArray(d.series))return {labels:Array.isArray(d.labels)?d.labels:[],series:d.series.map(function(s){return {name:(s&&s.name)||"",color:s&&s.color,values:s&&Array.isArray(s.values)?s.values:[]};})};
return {labels:[],series:[]};}
function xLabels(labels,n,o){
var dates=[],all=labels.length===n&&n>0,out=[],i;
for(i=0;i<n;i++){dates.push(day(labels[i]));if(!dates[i])all=false;}
if(all){for(i=0;i<n;i++){if(i===0||dates[i].getUTCMonth()!==dates[i-1].getUTCMonth())out.push({i:i,text:dateText(dates[i],o,false)});}
if(out.length<2&&n>2){out=[0,Math.round((n-1)/2),n-1].map(function(j){return {i:j,text:dateText(dates[j],o,true)};});}
return out;}
var picks=n<=7?labels.map(function(_,j){return j;}):[0,Math.round((n-1)/2),n-1];
return picks.filter(function(j){return j<labels.length;}).map(function(j){return {i:j,text:String(labels[j])};});}
function bar(x,y,w,h,r){x=r2(x);y=r2(y);w=r2(w);h=r2(h);if(h<=0)return "";r=r2(Math.min(r,w/2,h));
if(r<=0)return "M"+x+","+(y+h)+"V"+y+"H"+r2(x+w)+"V"+r2(y+h)+"Z";
return "M"+x+","+r2(y+h)+"V"+r2(y+r)+"Q"+x+","+y+" "+r2(x+r)+","+y+"H"+r2(x+w-r)+"Q"+r2(x+w)+","+y+" "+r2(x+w)+","+r2(y+r)+"V"+r2(y+h)+"Z";}
function draw(c){
var el=c.el,o=c.opts,d=norm(c.data,o),labels=d.labels,series=d.series,n=labels.length,i,k;
series.forEach(function(s){if(s.values.length>n)n=s.values.length;});
if(!n||!series.length){el.innerHTML='<div class="duet-chart-empty">'+esc(o.empty||"—")+"</div>";return;}
var stacked=o.stacked!==false,vals=series.map(function(s){var a=[];for(var j=0;j<n;j++){var v=+s.values[j];a.push(v>0&&isFinite(v)?v:0);}return a;});
var peak=0;for(i=0;i<n;i++){var t=0;for(k=0;k<vals.length;k++)t=stacked?t+vals[k][i]:Math.max(t,vals[k][i]);if(t>peak)peak=t;}
var top=nice(peak),ticks=[0,top/2,top],texts=ticks.map(function(v){return fmt(v,o);});
var box=el.getBoundingClientRect?el.getBoundingClientRect().width:0;
var w=Math.max(240,Math.round(el.clientWidth||box||600)),h=Math.max(120,+o.height||180),longest=0;
texts.forEach(function(s){if(s.length>longest)longest=s.length;});
var L=Math.round(longest*6.5+10),R=4,T=8,B=22,pw=w-L-R,ph=h-T-B,band=pw/n,gap=band*(band>6?0.25:0.12),bw=Math.max(1,band-gap),rad=Math.min(4,bw/3);
function y(v){return T+ph-(v/top)*ph;}
var s='<svg viewBox="0 0 '+w+" "+h+'" width="'+w+'" height="'+h+'" role="img" aria-label="'+esc(o.label||"")+'">';
ticks.forEach(function(v,j){var yy=r2(y(v));s+='<line class="duet-chart-grid" x1="'+L+'" x2="'+(w-R)+'" y1="'+yy+'" y2="'+yy+'"></line><text class="duet-chart-axis" x="'+(L-6)+'" y="'+r2(yy+4)+'" text-anchor="end">'+esc(texts[j])+"</text>";});
for(i=0;i<n;i++){var x=L+i*band+gap/2,base=0,lab=labels[i]!=null?String(labels[i]):"";
for(k=0;k<vals.length;k++){var v=vals[k][i];if(v<=0)continue;
var bx=stacked?x:x+k*(bw/vals.length),bwk=stacked?bw:Math.max(1,bw/vals.length-(vals.length>1?1:0));
var from=stacked?base:0,to=from+v,isTop=true;if(stacked){base=to;for(var q=k+1;q<vals.length;q++)if(vals[q][i]>0)isTop=false;}
var yt=y(to);
s+='<path d="'+bar(bx,yt,bwk,y(from)-yt,isTop?Math.min(rad,bwk/3):0)+'" style="fill:'+color(series[k].color,k)+'"><title>'+esc((lab?lab+": ":"")+(series[k].name?series[k].name+" ":"")+fmt(v,o))+"</title></path>";}}
var last=-1e9;
xLabels(labels,n,o).forEach(function(p){var tx=r2(L+p.i*band+gap/2),tw=String(p.text).length*6.2,anchor="start";
if(tx+tw>w-R){tx=w-R;anchor="end";if(tx-tw<last+8)return;}else if(tx<last+8)return;
s+='<text class="duet-chart-axis" x="'+tx+'" y="'+(h-6)+'" text-anchor="'+anchor+'">'+esc(p.text)+"</text>";last=anchor==="end"?tx:tx+tw;});
s+="</svg>";
var legend="";
if(o.legend!==false&&(series.length>1||o.legend)){legend='<div class="duet-legend">'+series.map(function(se,j){return '<span><i style="background:'+color(se.color,j)+'"></i>'+esc(se.name)+"</span>";}).join("")+"</div>";}
el.innerHTML=s+legend;}
function redraw(){for(var i=0;i<charts.length;i++){try{if(document.documentElement.contains(charts[i].el))draw(charts[i]);}catch(e){}}}
window.addEventListener("resize",function(){clearTimeout(timer);timer=setTimeout(redraw,120);});
window.addEventListener("load",redraw);
window.duetBars=function(el,data,opts){
if(typeof el==="string")el=document.querySelector(el);
if(!el)return;
if(el.classList&&!el.classList.contains("duet-chart"))el.classList.add("duet-chart");
var c=null;for(var i=0;i<charts.length;i++)if(charts[i].el===el)c=charts[i];
if(!c){c={el:el};charts.push(c);}
c.data=data;c.opts=opts||{};
try{draw(c);}catch(e){el.textContent="";}};
})();`;

/** M27: newer data versions redraw subscribers, without trusting the event's detail. */
export const DATA_SCRIPT = `(function(){
var el=document.getElementById("duet-data"),last=-1,good=false,fns=[];
function call(fn){try{fn(window.duetData);}catch(e){}}
function read(){if(!el)return;var v=Number(el.getAttribute("data-version"));if(!isFinite(v)||v<=last)return;var data;try{data=JSON.parse(el.textContent);}catch(e){return;}window.duetData=data;last=v;good=true;fns.forEach(call);}
window.duetOnData=function(fn){if(typeof fn!=="function")return;fns.push(fn);if(good)call(fn);};
document.addEventListener("duet:data",read);
if(el&&window.MutationObserver)new MutationObserver(read).observe(el,{attributes:true,attributeFilter:["data-version"],childList:true,characterData:true,subtree:true});
read();
})();`;

/** Compose at serve time only: the stored page never contains its live values. */
export function withData(html: string, json: string, version: number): string {
  const blocks = `<script type="application/json" id="duet-data" data-version="${version}" data-duet-base>${json.replace(/</g, "\\u003c")}</script><script data-duet-base data-duet-data>${DATA_SCRIPT}</script>`;
  const charts = /<script\b[^>]*\bdata-duet-base\b[^>]*\bdata-duet-charts\b[^>]*>[\s\S]*?<\/script>/i.exec(html);
  const metas = [...html.matchAll(/<meta\b[^>]*\bdata-duet-base\b[^>]*>/gi)];
  const meta = metas.at(-1);
  const head = /<head\b[^>]*>/i.exec(html);
  const at = charts ? charts.index + charts[0].length : meta ? meta.index + meta[0].length : head ? head.index + head[0].length : 0;
  return html.slice(0, at) + blocks + html.slice(at);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Removes everything withBase injected (so a rebuild starts from the model's own HTML). */
export function stripBase(html: string): string {
  return html
    .replace(new RegExp(`<(style|script)\\b[^>]*\\b${BASE_ATTR}\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"), "")
    .replace(new RegExp(`<meta\\b[^>]*\\b${BASE_ATTR}\\b[^>]*>`, "gi"), "");
}

/** The bodies withBase injects, to recognise a copy the model made without the data-duet-base marker. */
const INJECTED_BODIES = new Set([BASE_CSS, CHART_SCRIPT, DATA_SCRIPT, BASE_SCRIPT, PAGE_SCRIPT, SLIDE_CSS].map((s) => s.trim()));
const COPIED_BLOCK = /<(style|script)\b[^>]*>([\s\S]*?)<\/\1>/gi;
/** The CSP and charset metas withBase always adds (a copy, or the page's own, would only repeat them). */
const COPIED_META = /<meta\b[^>]*\b(?:http-equiv\s*=\s*["']?content-security-policy\b|charset\s*=)[^>]*>/gi;

/**
 * M21 (#10): everything the server adds to a stored page, marked or not: withBase's blocks, plus
 * copies of the base stylesheet / scripts and of the CSP / charset metas that a model carried over
 * without the marker. The page written back to the workspace for an edit or refresh, and the page
 * finish_build stores, both go through this, so injected code never ends up in Artifact.html twice
 * or as the model's own. (The artifact's CSP comes from withBase and the response header, never the
 * page; the viewport meta is dropped by withBase itself.)
 */
export function stripInjected(html: string): string {
  return stripBase(html)
    .replace(COPIED_BLOCK, (block, _tag: string, body: string) => (INJECTED_BODIES.has(body.trim()) ? "" : block))
    .replace(COPIED_META, "");
}

/** Drops the edit markers (served once the glow window is over, and before the next build). */
export function stripChanged(html: string): string {
  return html.replace(new RegExp(`\\s${CHANGED_ATTR}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, "gi"), "");
}

/** How many elements an edit marked as changed. */
export function countChanged(html: string): number {
  return [...html.matchAll(new RegExp(`<[a-z][^>]*\\s${CHANGED_ATTR}(?=[\\s=>/])`, "gi"))].length;
}

/**
 * The model's HTML (a full document or a fragment) with the base injected at the top of <head>,
 * so the page's own styles still win. Idempotent: an earlier injection is stripped first.
 */
export function withBase(html: string, opts: { lang: string; title: string }): string {
  // The page's own viewport meta would win over the base's (the last one counts): drop it, so a
  // "width=1024" page can't pan sideways on a phone.
  let doc = stripInjected(html).replace(/^\uFEFF/, "").replace(/<meta\b[^>]*\bname\s*=\s*["']?viewport\b[^>]*>/gi, "").trim();
  if (!/<html[\s>]/i.test(doc)) {
    const body = /<body[\s>]/i.test(doc) ? doc : `<body><main class="duet-page">${doc}</main></body>`;
    doc = `<html lang="${escapeHtml(opts.lang)}"><head><title>${escapeHtml(opts.title)}</title></head>${body}</html>`;
  }
  // The injection is the very first thing after the doctype (the parser opens <head> for it): a
  // "<head>" inside an earlier comment or script string can't move it, no script runs before the
  // CSP, and the base styles come before the page's own, so the page's CSS wins.
  const first =
    `<meta ${BASE_ATTR} charset="utf-8">` +
    `<meta ${BASE_ATTR} http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    `<meta ${BASE_ATTR} name="viewport" content="${ARTIFACT_VIEWPORT}">` +
    `<style ${BASE_ATTR}>${BASE_CSS}</style>` +
    // Keep the legacy base marker stable; version only the new slide geometry block.
    `<style ${BASE_ATTR} data-duet-base-version="${SLIDE_STYLE_VERSION}">${SLIDE_CSS}</style>` +
    // duetBars is defined before any of the page's own scripts run.
    `<script ${BASE_ATTR} data-duet-charts>${CHART_SCRIPT}</script>`;
  const script = `<script ${BASE_ATTR}>${PAGE_SCRIPT}</script>`;
  const closing = doc.toLowerCase().lastIndexOf("</body>");
  doc = closing >= 0 ? `${doc.slice(0, closing)}${script}${doc.slice(closing)}` : `${doc}${script}`;
  const doctype = /^<!doctype[^>]*>/i.exec(doc);
  return doctype ? `${doctype[0]}\n${first}${doc.slice(doctype[0].length).replace(/^\s+/, "")}` : `<!doctype html>\n${first}${doc}`;
}

const EXTERNAL_TAG = /<(script|link|img|iframe|source|video|audio|embed|object|track)\b[^>]*?\s(?:src|href|data|srcset)\s*=\s*["']?\s*((?:https?:)?\/\/[^\s"'>]+)/gi;
const EXTERNAL_CSS = /(?:@import\s+(?:url\()?|url\()\s*["']?\s*((?:https?:)?\/\/[^\s"')]+)/gi;

/** Why the HTML can't be stored as an artifact (said to the model), or null when it's fine. */
export function checkHtml(html: string): string | null {
  if (!html.trim()) return "The file is empty. Write the page, then call finish_build again.";
  if (!/<[a-z][\s\S]*>/i.test(html)) return "That file doesn't look like HTML. Write the page as HTML, then call finish_build again.";
  const found = new Set<string>();
  for (const m of html.matchAll(EXTERNAL_TAG)) found.add(m[2]!);
  for (const m of html.matchAll(EXTERNAL_CSS)) found.add(m[1]!);
  if (found.size === 0) return null;
  const list = [...found].slice(0, 5).join(", ");
  return `The page loads ${list} from the internet. Artifacts must be self-contained: inline the CSS and JS, embed images as data: URIs or leave them out (links with <a href> are fine). Fix the file, then call finish_build again.`;
}
