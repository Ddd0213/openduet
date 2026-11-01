import {expect,test} from "bun:test";
import {MAX_REQUEST_BODY_BYTES} from "../src/body-limit.ts";
test("Caddy security headers, JSON logs and matching transport cap", async()=>{
 const config=await Bun.file(new URL("../../caddy/Caddyfile",import.meta.url)).text();
 for(const text of ['Strict-Transport-Security "max-age=31536000"','X-Content-Type-Options nosniff','Referrer-Policy no-referrer','-Server','format json','output stdout']) expect(config).toContain(text);
 expect(Number(/max_size (\d+)/.exec(config)?.[1])).toBe(MAX_REQUEST_BODY_BYTES);
});
