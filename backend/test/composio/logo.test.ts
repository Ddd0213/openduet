import {expect,test} from "bun:test";
import {SdkComposioGateway,EXECUTE_TIMEOUT_MS} from "../../src/composio/sdk.ts";
import {requestBytes} from "../../src/custom-connectors/outbound.ts";
import type {NetDeps} from "../../src/custom-connectors/net.ts";
const lookup:NonNullable<NetDeps["lookup"]>=async host=>[{address:host==="private.example"?"10.0.0.1":"93.184.216.34",family:4}];
const gateway=(fetch:NonNullable<NetDeps["fetch"]>)=>new SdkComposioGateway("test-key",Date.now,EXECUTE_TIMEOUT_MS,{lookup,fetch});
test("Composio image GET uses guarded manual redirects and no credentials",async()=>{
 const calls:string[]=[];
 const g=gateway(async(url,init)=>{
  calls.push(url.href); expect(init.redirect).toBe("manual"); expect(new Headers(init.headers).has("authorization")).toBe(false);
  return calls.length===1?new Response(null,{status:302,headers:{location:"https://cdn.example/image"}}):new Response(new Uint8Array([1,2,3]),{headers:{"content-type":"image/png; charset=binary"}});
 });
 expect(await g.fetchLogo("https://logo.example/image")).toEqual({bytes:new Uint8Array([1,2,3]),contentType:"image/png"});
 expect(calls).toHaveLength(2);
});
test("logos reject direct/redirect private targets, insecure protocols and redirect loops",async()=>{
 for(const location of ["https://10.0.0.1/x","https://private.example/x","http://cdn.example/x","https://[::1]/x"]) {
  let calls=0; const g=gateway(async()=>{calls++;return new Response(null,{status:302,headers:{location}});});
  expect(await g.fetchLogo("https://logo.example/x")).toBeNull(); expect(calls).toBe(1);
 }
 let calls=0; const g=gateway(async()=>{calls++;return new Response(null,{status:302,headers:{location:"/again"}});});
 expect(await g.fetchLogo("http://logo.example/x")).toBeNull(); expect(calls).toBe(0);
 expect(await g.fetchLogo("https://10.0.0.1/x")).toBeNull(); expect(calls).toBe(0);
 expect(await g.fetchLogo("https://logo.example/x")).toBeNull(); expect(calls).toBe(4);
});
test("logo bytes are capped during reading, declared sizes and non-images fail closed",async()=>{
 let cancelled=false;
 const g=gateway(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1024*1024));c.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}}),{headers:{"content-type":"image/png"}}));
 expect(await g.fetchLogo("https://logo.example/x")).toBeNull(); expect(cancelled).toBe(true);
 expect(await gateway(async()=>new Response("",{headers:{"content-length":"2000000","content-type":"image/png"}})).fetchLogo("https://logo.example/x")).toBeNull();
 expect(await gateway(async()=>new Response("html",{headers:{"content-type":"text/html"}})).fetchLogo("https://logo.example/x")).toBeNull();
});
test("binary outbound has a reading deadline",async()=>{
 const net:NetDeps={lookup,fetch:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});}}))};
 await expect(requestBytes("https://logo.example/x",{timeoutMs:30,maxBytes:1024},net)).rejects.toMatchObject({kind:"timeout"});
});
