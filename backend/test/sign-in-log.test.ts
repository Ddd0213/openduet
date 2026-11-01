import {expect,test,spyOn} from "bun:test";
import {createApp} from "../src/app.ts";
import {createUser} from "../src/auth/users.ts";
import {LoginRateLimiter} from "../src/auth/rate-limit.ts";
import {log} from "../src/log.ts";
import {createTestApp} from "./helpers/app.ts";
import {sessionTokenHash} from "../src/contract/m28.ts";
test("sign-in logs resolved IP and username only, and fills session metadata",async()=>{
 const f=await createTestApp(); const records:unknown[]=[];
 const info=spyOn(log,"info").mockImplementation((msg,fields)=>{records.push({msg,fields});});
 const warn=spyOn(log,"warn").mockImplementation((msg,fields)=>{records.push({msg,fields});});
 try {
  const password="test-only correct horse battery staple";
  await createUser(f.db,f.auth,{username:"alex",name:"Alex",password});
  let ip="203.0.113.1";
  const limiter=new LoginRateLimiter(); const app=createApp({...f,loginRateLimiter:limiter,clientIp:async()=>ip});
  const login=(p:string)=>app.request("/api/session",{method:"POST",headers:{"User-Agent":"test-phone","X-Forwarded-For":"evil","Authorization":"Bearer secret-header"},body:JSON.stringify({username:"ALEX",password:p})});
  const success=await login(password); expect(success.status).toBe(200);
  const token=(await success.json() as any).token;
  expect(await f.db.session.findUnique({where:{tokenHash:sessionTokenHash(token)}})).toMatchObject({ipAddress:ip,userAgent:"test-phone"});
  for(let i=0;i<5;i++) expect((await login("wrong-secret-password")).status).toBe(401);
  expect((await login(password)).status).toBe(429);
  expect(records).toContainEqual({msg:"sign-in ok",fields:{username:"alex",ip}});
  expect(records).toContainEqual({msg:"sign-in failed",fields:{username:"alex",ip,locked:true}});
  expect(records).toContainEqual({msg:"sign-in locked",fields:{username:"alex",ip,retryAfter:1}});
  const text=JSON.stringify(records);
  for(const secret of [password,"wrong-secret-password",token,"secret-header","test-phone"]) expect(text).not.toContain(secret);
 } finally {info.mockRestore();warn.mockRestore();await f.cleanup();}
});
