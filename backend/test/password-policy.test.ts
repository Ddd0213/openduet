import {expect,test} from "bun:test";
import {COMMON_PASSWORDS,isCommonPassword} from "../src/auth/passwords.ts";
import {createUser,setPassword,validatePassword} from "../src/auth/users.ts";
import {createTestApp} from "./helpers/app.ts";
test("new passwords need 12 characters and reject a small case-insensitive blocklist",async()=>{
 const f=await createTestApp();
 try {
  expect(COMMON_PASSWORDS.size).toBeGreaterThanOrEqual(90);
  expect(isCommonPassword("PASSWORD123456")).toBe(true);
  await expect(validatePassword(f.auth,"aB7!kQ2@vR9")).rejects.toThrow(/at least 12/);
  expect(await validatePassword(f.auth,"aB7!kQ2@vR9#")).toBe("aB7!kQ2@vR9#");
  for(const p of ["password123456","123456789012","qwertyuiop12345"]) await expect(createUser(f.db,f.auth,{username:"newuser",name:"Test",password:p})).rejects.toThrow(/common password/);
  expect(await f.db.user.count()).toBe(0);
 } finally {await f.cleanup();}
});
test("existing short/common credentials still sign in; changes enforce the new policy",async()=>{
 const f=await createTestApp();
 try {
  const user=await createUser(f.db,f.auth,{username:"legacy",name:"Test",password:"aB7!kQ2@vR9#"});
  for(const password of ["password","password123456"]) {
   const hash=await (await f.auth.$context).password.hash(password);
   await f.db.account.updateMany({where:{userId:user.id,providerId:"credential"},data:{password:hash}});
   const res=await f.app.request("/api/session",{method:"POST",body:JSON.stringify({username:"legacy",password})});
   expect(res.status).toBe(200);
  }
  await expect(setPassword(f.db,f.auth,"legacy","password123456")).rejects.toThrow(/common password/);
  await expect(setPassword(f.db,f.auth,"legacy","abcdefghijk")).rejects.toThrow(/at least 12/);
 } finally {await f.cleanup();}
});
