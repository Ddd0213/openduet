import { expect, test } from "bun:test";
import { checkBaseUrl } from "../src/models/context.ts";
import { checkModelAddress, createModelFetch } from "../src/llm/net.ts";
import type { Lookup } from "../src/custom-connectors/net.ts";
import { startModelsApp, call } from "./models/harness.ts";
const publicDns: Lookup = async () => [{address:"93.184.216.34",family:4}];
const privateDns: Lookup = async () => [{address:"10.0.0.1",family:4}];

test("provider saves refuse private literals, DNS answers and embedding ranges", async () => {
  for (const url of ["https://10.0.0.1/v1", "https://169.254.169.254/v1", "https://[64:ff9b::a9fe:a9fe]/v1"]) await expect(checkBaseUrl(url,"openai",[],[],publicDns)).rejects.toMatchObject({status:400,code:"validation_failed",field:"baseUrl"});
  await expect(checkBaseUrl("https://gateway.example/v1","openai",[],[],privateDns)).rejects.toThrow(/private/);
  expect(await checkBaseUrl("https://gateway.example/v1","openai",[],[],publicDns)).toBe("https://gateway.example/v1");
});
test("localhost and exact explicit exceptions retain local gateways; private flag is not an HTTP opt-in", async () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(await checkModelAddress(new URL(`http://${host}:1234/v1`))).toBeNull();
  expect(await checkModelAddress(new URL("https://gateway.lan/v1"),{privateHosts:["gateway.lan"],lookup:privateDns})).toBeNull();
  expect(await checkModelAddress(new URL("http://gateway.lan/v1"),{insecureHosts:["gateway.lan"],lookup:privateDns})).toBeNull();
  await expect(checkModelAddress(new URL("http://gateway.lan/v1"),{privateHosts:["gateway.lan"]})).rejects.toThrow(/https/);
  await expect(checkModelAddress(new URL("https://evil.gateway.lan/v1"),{privateHosts:["gateway.lan"],lookup:privateDns})).rejects.toThrow(/private/);
});
test("model requests re-resolve every call and pin the address, Host, TLS and Request body", async () => {
  let privateNow = false, sends = 0;
  const guarded = createModelFetch({pin:true,lookup:async()=>privateNow?privateDns("",{all:true}):publicDns("",{all:true}),fetch:async(input,init)=>{
    sends++; expect(input instanceof Request ? input.url : String(input)).toBe("https://93.184.216.34/v1/chat/completions");
    expect(new Headers(init?.headers).get("host")).toBe("gateway.example");
    expect((init as any).tls.serverName).toBe("gateway.example"); expect((init as any).tls.rejectUnauthorized).toBe(true);
    expect(init?.redirect).toBe("error"); expect(input instanceof Request && await input.text()).toBe("hello");
    return new Response("ok");
  }});
  await guarded(new Request("https://gateway.example/v1/chat/completions",{method:"POST",body:"hello"}));
  privateNow=true;
  await expect(guarded("https://gateway.example/v1/chat/completions")).rejects.toThrow(/private/);
  expect(sends).toBe(1);
});
test("provider API rejects private URL without storing a provider or sending its key", async () => {
  const t = await startModelsApp();
  try {
    const before = t.net.calls.length;
    const res = await call(t,t.alex,"POST","/api/providers",{kind:"custom",protocol:"openai",baseUrl:"https://10.0.0.1/v1",key:"test-secret"});
    expect(res.status).toBe(400); expect(res.body.error.field).toBe("baseUrl");
    expect(await t.fixture.db.modelProvider.count()).toBe(0); expect(t.net.calls.length).toBe(before);
  } finally {await t.fixture.cleanup();}
});
