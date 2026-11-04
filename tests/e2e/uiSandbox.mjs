import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The 20k-node layout benchmark: per-tick CPU of the WebAssembly kernel over 200 ticks (and, when
// GRAPHVIEW_JS_REFERENCE names the frozen JavaScript reference tick, of that run too), then the real canvas'
// frame time (tick + position sync + draw) while it settles and while a node is dragged. The frame compiles the
// committed runtime/assets/layout.wasm bytes itself; the app's sandbox fixture serves no /wasm/ route.
// GRAPHVIEW_BENCH selects the phases (ticks: kernel, jsticks: the frozen reference, settle, drag, shots; one harness run
// each fits the app harness' 25 s limit; the ticks digests of both engines must match). GRAPHVIEW_BENCH_OUT writes
// the report; GRAPHVIEW_BENCH_ASSERT=1 gates p95 frame time <= 16.7 ms (the >= 3x per-tick bar compares two
// reports). Without GRAPHVIEW_BENCH only the small graph runs, on the kernel.
const BENCH_NODES = 20000
const BENCH_LINKS = 2

export default async function () {
  const root = path.resolve(import.meta.dirname, '../..')
  const wasm = readFileSync(path.join(root, 'runtime/assets/layout.wasm')).toString('base64')
  const phases = (process.env.GRAPHVIEW_BENCH ?? '').split(',').filter(Boolean)
  const reference = process.env.GRAPHVIEW_JS_REFERENCE ? path.resolve(process.env.GRAPHVIEW_JS_REFERENCE) : null
  return {
    // The app's fixture host API predates 12.2's frame api.wasm snapshot (SandboxPluginUi reads api.wasm.list()).
    hostSetup: 'api.wasm ??= { list: () => [] };',
    entry: `
      import { initRuntime } from ${JSON.stringify(path.join(root, 'src/runtime.ts'))};
      import { GraphTabHeader, GraphSearchInput } from ${JSON.stringify(path.join(root, 'src/GraphTabHeader.tsx'))};
      import { GraphNameBar } from ${JSON.stringify(path.join(root, 'src/PresetBar.tsx'))};
      import { GraphCanvas } from ${JSON.stringify(path.join(root, 'src/GraphCanvas.tsx'))};
      import { buildGraph } from ${JSON.stringify(path.join(root, 'src/graphModel.ts'))};
      import { DEFAULT_CONFIG } from ${JSON.stringify(path.join(root, 'src/settings.ts'))};
      import { injectStyles } from ${JSON.stringify(path.join(root, 'src/styles.ts'))};
      import { layoutKernelFor } from ${JSON.stringify(path.join(root, 'src/layout.ts'))};
      ${reference ? `import { createLayoutState, layoutTick } from ${JSON.stringify(reference)};` : 'const createLayoutState=null,layoutTick=null;'}
      const wasmBytes=Uint8Array.from(atob(${JSON.stringify(wasm)}),c=>c.charCodeAt(0));
      const frameWasm={list:()=>[],load:()=>WebAssembly.compile(wasmBytes),async instantiate(id,imports){
        const module=await WebAssembly.compile(wasmBytes);
        for(let initial=1;initial<=512;initial++){const memory=new WebAssembly.Memory({initial,maximum:512});try{const instance=await WebAssembly.instantiate(module,{env:{memory,abort(){throw Error('layout aborted')},log(){}}});if(imports&&imports.env)imports.env.memory=memory;return instance}catch(error){if(!(error instanceof WebAssembly.LinkError))throw error}}
        throw Error('layout module memory could not be sized')}};
      function stream(seed){let s=seed>>>0;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296}}
      function benchGraph(){
        const next=stream(0x20000);
        const entries=Array.from({length:${BENCH_NODES}},(_,i)=>({relPath:'Taxon '+i+'.md',title:'Taxon '+i,kind:'note',links:Array.from({length:${BENCH_LINKS}},()=>'taxon '+Math.floor(next()*${BENCH_NODES})),tags:[]}));
        const graph=buildGraph(entries,DEFAULT_CONFIG.filters);
        for(const node of graph.nodes){const a=next()*Math.PI*2,r=40+next()*360;node.x=Math.cos(a)*r;node.y=Math.sin(a)*r;node.vx=0;node.vy=0}
        return graph
      }
      const stats=samples=>{const sorted=[...samples].sort((a,b)=>a-b),at=q=>sorted[Math.min(sorted.length-1,Math.floor(q*sorted.length))];return{samples:samples.length,p50:at(0.5),p95:at(0.95),max:sorted[sorted.length-1]}};
      export function register(api){
        const original=api;api=new Proxy(original,{get:(target,key)=>key==='wasm'?frameWasm:Reflect.get(target,key)});
        initRuntime(api);const R=api.React;const dispose=injectStyles();
        const data=buildGraph([{relPath:'Meadow.md',title:'Meadow',kind:'note',links:['orchid'],tags:[]},{relPath:'Orchid.md',title:'Orchid',kind:'note',links:['meadow'],tags:[]}],DEFAULT_CONFIG.filters);
        function Graph(){const ref=R.useRef(null);R.useLayoutEffect(()=>{const context=ref.current.ownerDocument.defaultView.CanvasRenderingContext2D.prototype;const clear=context.clearRect;const fill=context.fill;context.fill=function(...args){if(this.canvas.closest('#graph-root'))this.canvas.dataset.fillColors=JSON.stringify([...new Set([...JSON.parse(this.canvas.dataset.fillColors||'[]'),this.fillStyle])]);return fill.apply(this,args)};context.clearRect=function(...args){this.canvas.dataset.drawCount=String(Number(this.canvas.dataset.drawCount||0)+1);return clear.apply(this,args)};return()=>{context.clearRect=clear;context.fill=fill}},[]);return R.createElement('div',{id:'graph-root',ref,style:{width:'600px',height:'250px',position:'relative','--accent-color':'#3366ff',display:'flex',flexDirection:'column'}},R.createElement(GraphCanvas,{data,config:DEFAULT_CONFIG,focusId:'Meadow.md',focusRun:1,onOpen(){}}))}
        function Chrome(){const [value,onChange]=R.useState('');const presets={active:'Meadow',saved:[],config:DEFAULT_CONFIG};return R.createElement('div',{id:'graph-chrome',style:{width:800}},R.createElement(GraphTabHeader),R.createElement(GraphSearchInput,{find:{value,onChange,count:0,index:-1,onStep(){}}}),R.createElement('div',{id:'graph-sidebar',style:{width:280}},R.createElement(GraphNameBar,{presets})))}
        function Bench(){
          const [graph,setGraph]=R.useState(null);const ref=R.useRef(null);
          R.useEffect(()=>{
            const view=ref.current.ownerDocument.defaultView;const raf=view.requestAnimationFrame.bind(view);
            view.benchFrames=[];view.requestAnimationFrame=callback=>raf(time=>{const started=performance.now();callback(time);view.benchFrames.push(performance.now()-started)});
            view.HTMLCanvasElement.prototype.setPointerCapture=function(){};
            view.graphBench={
              async ticks(engine){
                const graph=benchGraph();const forces=DEFAULT_CONFIG.forces;const samples=[];let alpha=1;let x,y;
                if(engine==='kernel'){const kernel=await layoutKernelFor(api).pending;const layout=kernel.create();layout.load(graph);for(let i=0;i<200;i++){const t=performance.now();alpha=layout.tick(forces,alpha,-1);samples.push(performance.now()-t)}({x,y}=layout.buffers());x=x.slice();y=y.slice();layout.dispose()}
                else{const state=createLayoutState(graph);for(let i=0;i<200;i++){const t=performance.now();alpha=layoutTick(state,forces,alpha,-1);samples.push(performance.now()-t)}({x,y}=state)}
                const bytes=new Uint8Array(x.byteLength*2);bytes.set(new Uint8Array(x.buffer,x.byteOffset,x.byteLength));bytes.set(new Uint8Array(y.buffer,y.byteOffset,y.byteLength),x.byteLength);
                const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
                return {engine,nodes:graph.nodes.length,edges:graph.edges.length,stats:stats(samples),digest}
              },
              async instrument(){
                const kernel=await layoutKernelFor(api).pending;const create=kernel.create.bind(kernel);view.benchTick=[];view.benchSync=[];
                kernel.create=()=>{const handle=create();const timed=(name,list)=>{const run=handle[name].bind(handle);handle[name]=(...args)=>{const t=performance.now();const result=run(...args);list().push(performance.now()-t);return result}};timed('tick',()=>view.benchTick);timed('write',()=>view.benchSync);timed('read',()=>view.benchSync);timed('load',()=>view.benchSync);return handle}
              },
              split(){return {tick:stats(view.benchTick),sync:stats(view.benchSync)}},
              mount(){view.benchFrames=[];view.benchTick=[];view.benchSync=[];view.benchGraph=benchGraph();setGraph(view.benchGraph)},
              async settle(){const started=performance.now();let last=-1,quiet=0;while(performance.now()-started<60000){await new Promise(r=>setTimeout(r,250));if(view.benchFrames.length===last){if(++quiet>=4)break}else{quiet=0;last=view.benchFrames.length}}return {ms:performance.now()-started-1000,frames:stats(view.benchFrames)}},
              async drag(){
                const canvas=view.document.querySelector('#bench-root canvas');const rect=canvas.getBoundingClientRect();const nodes=view.benchGraph.nodes;
                const fire=(type,x,y)=>canvas.dispatchEvent(new view.PointerEvent(type,{bubbles:true,button:0,buttons:type==='pointerup'?0:1,pointerId:7,clientX:x,clientY:y}));
                let x=0,y=0,hit=false;
                for(let gy=0.3;gy<=0.7&&!hit;gy+=0.02)for(let gx=0.3;gx<=0.7&&!hit;gx+=0.02){x=rect.left+rect.width*gx;y=rect.top+rect.height*gy;const before=nodes.map(n=>n.x);fire('pointerdown',x,y);fire('pointermove',x+4,y);hit=nodes.some((n,i)=>n.x!==before[i]);if(!hit)fire('pointerup',x+4,y);else{x+=4}}
                if(!hit)return {hit:false};
                view.benchFrames=[];view.benchTick=[];view.benchSync=[];for(let i=0;i<120;i++){x+=2;fire('pointermove',x,y);await new Promise(r=>raf(()=>r()))}
                const frames=stats(view.benchFrames);fire('pointerup',x,y);return {hit:true,frames,split:view.graphBench.split()}
              }
            };
          },[]);
          return R.createElement('div',{id:'bench-root',ref,style:{width:'1000px',height:'700px',position:'relative',display:'flex',flexDirection:'column'}},graph?R.createElement(GraphCanvas,{data:graph,config:DEFAULT_CONFIG,onOpen(){}}):null)
        }
        api.registerView('fixture.graph',Graph);
        api.registerView('fixture.graph-bench',Bench);
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
      report.graphAlert=await graphFrame.executeJavaScript('document.querySelector("#graph-root [role=alert]")?.textContent??null');
      const phases=${JSON.stringify(phases)};
      if(phases.length){
      let benchFrame;
      for(let i=0;i<300&&!benchFrame;i++){for(const frame of win.webContents.mainFrame.framesInSubtree.filter(f=>f.url.endsWith('/surface.html'))){if(await frame.executeJavaScript('!!window.graphBench')){benchFrame=frame;break}}if(!benchFrame)await wait(20)}
      if(!benchFrame)throw Error('Graph benchmark view did not mount');
      win.setContentSize(1200,900);
      report.bench={phases};
      if(phases.includes('ticks'))report.bench.ticks=await benchFrame.executeJavaScript('window.graphBench.ticks("kernel")');
      if(phases.includes('jsticks'))report.bench.ticks=await benchFrame.executeJavaScript('window.graphBench.ticks("js")');
      await benchFrame.executeJavaScript('window.graphBench.instrument()');
      report.bench.host=await win.webContents.executeJavaScript('(()=>{const frame=[...document.querySelectorAll("body > div iframe")].at(-1);const holder=frame.closest("body > div");holder.style.height="720px";holder.style.width="1020px";holder.scrollIntoView();return {top:holder.getBoundingClientRect().top,height:holder.getBoundingClientRect().height}})()');
      if(phases.includes('settle')){
        await benchFrame.executeJavaScript('window.graphBench.mount();undefined');
        report.bench.settle=await benchFrame.executeJavaScript('window.graphBench.settle()');
        report.bench.settle.split=await benchFrame.executeJavaScript('window.graphBench.split()');
        report.bench.kernelMoved=await benchFrame.executeJavaScript('window.benchGraph.nodes.some(n=>!Number.isFinite(n.x))?"nan":window.benchGraph.nodes.slice(0,50).some(n=>Math.hypot(n.x,n.y)>420)');
        report.bench.alert=await benchFrame.executeJavaScript('document.querySelector("#bench-root [role=alert]")?.textContent??null');
      }
      // shots: screenshots of the host window while the 20k graph settles (GRAPHVIEW_BENCH_SHOTS names the folder).
      if(phases.includes('shots')){await benchFrame.executeJavaScript('window.graphBench.mount();undefined');report.bench.shots=[];for(const at of [300,2500,6000,12000]){await wait(at-(report.bench.shots.at(-1)?.at??0));const image=await win.webContents.capturePage();const file=${JSON.stringify(process.env.GRAPHVIEW_BENCH_SHOTS ?? '')}+'/settle-'+at+'ms.png';if(${JSON.stringify(Boolean(process.env.GRAPHVIEW_BENCH_SHOTS))})fs.writeFileSync(file,image.toPNG());report.bench.shots.push({at,file,frames:await benchFrame.executeJavaScript('window.benchFrames.length')})}}
      // The drag starts 1.5 s after mounting, while the layout is still settling: one tick per frame either way.
      if(phases.includes('drag')){await benchFrame.executeJavaScript('window.graphBench.mount();undefined');await wait(1500);report.bench.drag=await benchFrame.executeJavaScript('window.graphBench.drag()')}
      }
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
      assert.equal(result.graphAlert, null, 'The layout kernel must load in the frame')
      const bench = result.bench
      if (!bench) return
      if (process.env.GRAPHVIEW_BENCH_OUT) writeFileSync(process.env.GRAPHVIEW_BENCH_OUT, JSON.stringify(bench, null, 2) + '\n')
      const gate = process.env.GRAPHVIEW_BENCH_ASSERT === '1'
      if (bench.ticks) assert.equal(bench.ticks.nodes, BENCH_NODES)
      if (bench.settle) {
        assert.equal(bench.alert, null, 'The kernel must load in the frame')
        assert.equal(bench.kernelMoved, true, 'The canvas must spread the 20k graph with the kernel')
        if (gate) assert(bench.settle.frames.p95 <= 16.7, `p95 settle frame time ${bench.settle.frames.p95} > 16.7 ms`)
      }
      if (bench.drag) {
        assert.equal(bench.drag.hit, true, 'The drag probe must grab a node')
        if (gate) assert(bench.drag.frames.p95 <= 16.7, `p95 drag frame time ${bench.drag.frames.p95} > 16.7 ms`)
      }
    }
  }
}
