import {expect,test} from "bun:test";
import {loadConfig} from "../src/config.ts";
const base={PUBLIC_URL:"http://localhost:3000",DATABASE_URL:"file:./test.db",BETTER_AUTH_SECRET:"test-only-secret-at-least-32-characters"};
test("new security settings default compatibly and reject invalid fake-IP policy",()=>{
 expect(loadConfig(base)).toMatchObject({ALLOW_FAKE_IP_RANGE:"auto",LLM_ALLOW_PRIVATE_HOSTS:[],TRUSTED_PROXIES:[]});
 for(const mode of ["auto","1","0"] as const) expect(loadConfig({...base,ALLOW_FAKE_IP_RANGE:mode}).ALLOW_FAKE_IP_RANGE).toBe(mode);
 expect(()=>loadConfig({...base,ALLOW_FAKE_IP_RANGE:"yes"})).toThrow(/ALLOW_FAKE_IP_RANGE/);
 expect(loadConfig({...base,LLM_ALLOW_PRIVATE_HOSTS:"gateway.lan, 10.0.0.2",TRUSTED_PROXIES:"caddy"})).toMatchObject({LLM_ALLOW_PRIVATE_HOSTS:["gateway.lan","10.0.0.2"],TRUSTED_PROXIES:["caddy"]});
});
test("setup passes the documented new settings without executing setup or reading dotenv",async()=>{
 const script=await Bun.file(new URL("../../scripts/setup.sh",import.meta.url)).text();
 const passthrough=/PASSTHROUGH=\(([\s\S]*?)\)/.exec(script)?.[1]??"";
 const example=await Bun.file(new URL("../.env.example",import.meta.url)).text();
 for(const key of ["ALLOW_FAKE_IP_RANGE","LLM_ALLOW_PRIVATE_HOSTS","VAULT_KEY"]) {expect(passthrough).toContain(key);expect(example).toContain(`${key}=`);}
});
