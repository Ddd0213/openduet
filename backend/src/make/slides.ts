// Versioned slide geometry. Stored HTML keeps this version until the next rebuild;
// ordinary reads do not call withBase. The minimum font size is 13px, minimum scale 0.8.
export const SLIDE_STYLE_VERSION = "2";
export const SLIDE_CSS = `
@media screen{
.duet-slide{min-height:var(--duet-slide-height,100vh);height:auto;max-height:none;overflow:visible}
.duet-slide[data-duet-fit],.duet-slide[data-duet-fit] *{font-size:max(13px,calc(var(--duet-slide-font,17px)*var(--duet-slide-scale,1)))!important}
}
`.trim();

// Measure real browser layout after every scale step. Never use transform or fixed height:
// a slide that still cannot fit remains taller and scrollable, with no clipped content.
export const SLIDE_SCRIPT = `(function(){
var slides=Array.prototype.slice.call(document.querySelectorAll(".duet-slide"));if(!slides.length)return;
var timer=0,scales=[1,.95,.9,.85,.8];
function fit(){
var body=window.getComputedStyle(document.body),height=window.innerHeight-(parseFloat(body.paddingTop)||0)-(parseFloat(body.paddingBottom)||0);
if(!(height>0))return;
slides.forEach(function(slide){
slide.removeAttribute("data-duet-fit");slide.style.setProperty("--duet-slide-scale","1");slide.style.setProperty("--duet-slide-height",height+"px");
var nodes=[slide].concat(Array.prototype.slice.call(slide.querySelectorAll("*")));
var sizes=nodes.map(function(node){return parseFloat(window.getComputedStyle(node).fontSize)||17;});
nodes.forEach(function(node,i){node.style.setProperty("--duet-slide-font",sizes[i]+"px");});
slide.setAttribute("data-duet-fit","");
for(var i=0;i<scales.length;i++){
slide.style.setProperty("--duet-slide-scale",String(scales[i]));
if(Math.max(slide.scrollHeight,slide.getBoundingClientRect().height)<=height+1)break;
}
});
}
function schedule(){clearTimeout(timer);timer=setTimeout(fit,120);}
fit();window.addEventListener("resize",schedule);window.addEventListener("orientationchange",schedule);window.addEventListener("load",fit);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fit);
})();`;
