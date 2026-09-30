import assert from 'node:assert/strict'
import path from 'node:path'

export default async function () {
  const root = path.resolve(import.meta.dirname, '../..')
  return {
    entry: `
      import { initRuntime } from ${JSON.stringify(path.join(root, 'src/runtime.ts'))};
      import { GraphTabHeader, GraphSearchInput } from ${JSON.stringify(path.join(root, 'src/GraphTabHeader.tsx'))};
      import { GraphNameBar } from ${JSON.stringify(path.join(root, 'src/PresetBar.tsx'))};
      import { GraphCanvas } from ${JSON.stringify(path.join(root, 'src/GraphCanvas.tsx'))};
      import { buildGraph } from ${JSON.stringify(path.join(root, 'src/graphModel.ts'))};
      import { DEFAULT_CONFIG } from ${JSON.stringify(path.join(root, 'src/settings.ts'))};
      import { injectStyles } from ${JSON.stringify(path.join(root, 'src/styles.ts'))};
      export function register(api){
        initRuntime(api);const R=api.React;const dispose=injectStyles();
        const data=buildGraph([{relPath:'Meadow.md',title:'Meadow',kind:'note',links:['orchid'],tags:[]},{relPath:'Orchid.md',title:'Orchid',kind:'note',links:['meadow'],tags:[]}],DEFAULT_CONFIG.filters);
        function Graph(){const ref=R.useRef(null);R.useLayoutEffect(()=>{const context=ref.current.ownerDocument.defaultView.CanvasRenderingContext2D.prototype;const clear=context.clearRect;const fill=context.fill;context.fill=function(...args){if(this.canvas.closest('#graph-root'))this.canvas.dataset.fillColors=JSON.stringify([...new Set([...JSON.parse(this.canvas.dataset.fillColors||'[]'),this.fillStyle])]);return fill.apply(this,args)};context.clearRect=function(...args){this.canvas.dataset.drawCount=String(Number(this.canvas.dataset.drawCount||0)+1);return clear.apply(this,args)};return()=>{context.clearRect=clear;context.fill=fill}},[]);return R.createElement('div',{id:'graph-root',ref,style:{width:'600px',height:'250px',position:'relative','--accent-color':'#3366ff',display:'flex',flexDirection:'column'}},R.createElement(GraphCanvas,{data,config:DEFAULT_CONFIG,focusId:'Meadow.md',focusRun:1,onOpen(){}}))}
        function Chrome(){const [value,onChange]=R.useState('');const presets={active:'Meadow',saved:[],config:DEFAULT_CONFIG};return R.createElement('div',{id:'graph-chrome',style:{width:800}},R.createElement(GraphTabHeader),R.createElement(GraphSearchInput,{find:{value,onChange,count:0,index:-1,onStep(){}}}),R.createElement('div',{id:'graph-sidebar',style:{width:280}},R.createElement(GraphNameBar,{presets})))}
        api.registerView('fixture.graph',Graph);
        api.registerView('fixture.graph-chrome',Chrome);
        return dispose;
      }
    `,
    run: `
      let chromeFrame;
      for(let i=0;i<150;i++){
        for(const frame of win.webContents.mainFrame.framesInSubtree.filter(f=>f.url.endsWith('/surface.html'))){if(await frame.executeJavaScript('!!document.querySelector("#graph-chrome input")')){chromeFrame=frame;break}}
        if(chromeFrame)break;await wait(20)
      }
      if(!chromeFrame)throw Error('Graph header did not mount');
      report.graphChrome=await chromeFrame.executeJavaScript('(()=>{const selectors=[".graphview-topbar",".graphview-searchbar",".graphview-namebar"];return {bars:selectors.map(selector=>{const element=document.querySelector(selector),style=getComputedStyle(element);return {height:element.getBoundingClientRect().height,border:style.borderBottomWidth}}),title:document.querySelector(".graphview-topbar").textContent,searchWidth:document.querySelector(".graphview-find").getBoundingClientRect().width,searchRight:document.querySelector(".graphview-searchbar").getBoundingClientRect().right-document.querySelector(".graphview-find").getBoundingClientRect().right}})()');
      await chromeFrame.executeJavaScript('document.querySelector("#graph-chrome").style.width="280px";undefined');
      report.graphChromeNarrow=await chromeFrame.executeJavaScript('(()=>{const row=document.querySelector(".graphview-searchbar").getBoundingClientRect(),field=document.querySelector(".graphview-find").getBoundingClientRect();return {height:row.height,width:field.width,fits:field.left>=row.left&&field.right<=row.right}})()');
      let graphFrame;
      for(let i=0;i<300;i++){
        for(const frame of win.webContents.mainFrame.framesInSubtree.filter(f=>f.url.endsWith('/surface.html'))){if(await frame.executeJavaScript('!!document.querySelector("#graph-root canvas")')){graphFrame=frame;break}}
        if(graphFrame)break;await wait(20)
      }
      if(!graphFrame)throw Error('Graph canvas did not mount');
      for(let i=0;i<100;i++){report.graphDraws=await graphFrame.executeJavaScript('Number(document.querySelector("#graph-root canvas").dataset.drawCount||0)');if(report.graphDraws>10)break;await wait(20)}
      report.graphFocusColors=await graphFrame.executeJavaScript('JSON.parse(document.querySelector("#graph-root canvas").dataset.fillColors||"[]")');
      await graphFrame.executeJavaScript('Object.assign(document.getElementById("graph-root").style,{width:"440px",height:"180px"});undefined');
      for(let i=0;i<100;i++){report.graphSize=await graphFrame.executeJavaScript('(()=>{const canvas=document.querySelector("#graph-root canvas");return {width:canvas.width/devicePixelRatio,height:canvas.height/devicePixelRatio}})()');if(report.graphSize.width===440&&report.graphSize.height===180)break;await wait(20)}
    `,
    verify(result) {
      assert.deepEqual(result.graphChrome.bars, Array.from({length:3},()=>({height:38,border:'1px'})), 'Graph header, search and sidebar bars must be 37px plus their 1px separator');
      assert.equal(result.graphChrome.title, 'Default graph');
      assert(result.graphChrome.searchWidth > 760);
      assert(result.graphChrome.searchRight >= 0 && result.graphChrome.searchRight <= 12, 'Search stays against the right inset');
      assert.deepEqual(result.graphChromeNarrow, {height:38,width:270,fits:true});
      assert(result.graphFocusColors.includes('#3366ff'), 'The selected search dot must use the accent fill even with an empty query');
      assert(result.graphDraws > 10, 'Graph animation must run in the visible surface window')
      assert.deepEqual(result.graphSize, { width: 440, height: 180 }, 'Graph canvas must follow surface resize')
    }
  }
}
