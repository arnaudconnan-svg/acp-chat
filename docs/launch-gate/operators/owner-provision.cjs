'use strict';

// Operator only. No server import, HTTP cookie, provider call or deployment.
// Resolve the authorized owner from pinned live source, never emit the mapping.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const appRequire = createRequire(path.join(process.cwd(), 'package.json'));
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
process.stderr.write = () => true;

const OWNER_ID = 'launch-owner';
const OWNER_EMAIL_SHA256 = 'f4b8dbb16ece4b5ad496dd91a87dd928ca6fa347206112bbfc91a26dde6a9667';
const OWNER_NAME = 'Arnaud Connan';
const PROJECT = 'facilitat-io';
const PRINCIPAL = 'firebase-adminsdk-fbsvc@facilitat-io.iam.gserviceaccount.com';
const DATABASE = 'https://facilitat-io-default-rtdb.europe-west1.firebasedatabase.app/';
const LIVE_SHA = 'f20d84f1962c552eaebb095d7a9e5ddb63719be7';
const LIVE_SERVER_SHA256 = 'e53e8469a084896b1ad58b19413c12dfa659a9f67db623f90df748168ba7d555';
const PINNED = {
  'professional-access.js': '5210cde3a69239f3c9e8ab1182c7b68242cb750016d9307f751e1c41e0f5c537',
  'auth-password.js': 'bf29a8e14ca710050faf58f36786470f7c1951a76147466ebea9f684ce074318'
};
// Exact source bytes from validated 3db45bb; no credential material.
const SOURCE_BASE64 = {
  "professional-access.js": [
    "J3VzZSBzdHJpY3QnOwpjb25zdCBjcnlwdG8gPSByZXF1aXJlKCdjcnlwdG8nKTsKY29uc3QgeyB2ZXJpZnlQYXNzd29yZCB9ID0g",
    "cmVxdWlyZSgnLi9hdXRoLXBhc3N3b3JkJyk7CmNvbnN0IFJPTEVTID0gbmV3IFNldChbCiAgJ3ByYWN0aXRpb25lcicsCiAgJ2Nv",
    "bW1lcmNpYWxfc3VwcG9ydCcsCiAgJ3RlY2huaWNhbF9zdXBwb3J0JywKICAnYWRtaW5pc3RyYXRvcicKXSk7CmNvbnN0IFJFQVNP",
    "TlMgPSBuZXcgU2V0KFsKICAnc3VwcG9ydF9pbmNpZGVudCcsCiAgJ3NlY3VyaXR5X3JldmlldycsCiAgJ3VzZXJfcmVxdWVzdCcs",
    "CiAgJ2lkZW50aXR5X3ZlcmlmaWNhdGlvbicKXSk7CmNvbnN0IGlkVmFsaWQgPSAoaWQpID0+CiAgdHlwZW9mIGlkID09PSAnc3Ry",
    "aW5nJyAmJiAvXltBLVphLXowLTlfLV17MSwxMjh9JC8udGVzdChpZCk7CmZ1bmN0aW9uIGNyZWF0ZVByb2Zlc3Npb25hbEFjY2Vz",
    "cyh7IGRiLCBzZWNyZXQsIG5vdyA9IERhdGUubm93IH0pIHsKICBpZiAodHlwZW9mIHNlY3JldCAhPT0gJ3N0cmluZycgfHwgc2Vj",
    "cmV0Lmxlbmd0aCA8IDMyKQogICAgdGhyb3cgbmV3IEVycm9yKCdwcm9mZXNzaW9uYWxfc2lnbmluZ19zZWNyZXRfcmVxdWlyZWQn",
    "KTsKICBjb25zdCByZWZzID0gewogICAgaWRlbnRpdGllczogZGIucmVmKCdwcm9mZXNzaW9uYWxJZGVudGl0aWVzJyksCiAgICBz",
    "ZXNzaW9uczogZGIucmVmKCdwcm9mZXNzaW9uYWxTZXNzaW9ucycpLAogICAgYXNzaWdubWVudHM6IGRiLnJlZigncHJhY3RpdGlv",
    "bmVyQXNzaWdubWVudHMnKSwKICAgIGdyYW50czogZGIucmVmKCdjb250ZW50R3JhbnRzJyksCiAgICBqb3VybmFsOiBkYi5yZWYo",
    "J3Byb2Zlc3Npb25hbEFjY2Vzc0pvdXJuYWwnKQogIH07CiAgY29uc3QgaGFzaCA9ICh4KSA9PiBjcnlwdG8uY3JlYXRlSGFzaCgn",
    "c2hhMjU2JykudXBkYXRlKHgpLmRpZ2VzdCgnaGV4Jyk7CiAgY29uc3QgcmVmZXJlbmNlID0gKGtpbmQsIGlkKSA9PgogICAgYGZh",
    "Y18ke2tpbmR9XyR7Y3J5cHRvLmNyZWF0ZUhtYWMoJ3NoYTI1NicsIHNlY3JldCkudXBkYXRlKGAke2tpbmR9OiR7aWR9YCkuZGln",
    "ZXN0KCdoZXgnKS5zbGljZSgwLCAyNCl9YDsKICBmdW5jdGlvbiByb2xlcyhyZWNvcmQpIHsKICAgIHJldHVybiBBcnJheS5pc0Fy",
    "cmF5KHJlY29yZD8ucm9sZXMpICYmCiAgICAgIHJlY29yZC5yb2xlcy5sZW5ndGggJiYKICAgICAgcmVjb3JkLnJvbGVzLmV2ZXJ5",
    "KChyKSA9PiBST0xFUy5oYXMocikpCiAgICAgID8gWy4uLm5ldyBTZXQocmVjb3JkLnJvbGVzKV0KICAgICAgOiBbXTsKICB9CiAg",
    "YXN5bmMgZnVuY3Rpb24gam91cm5hbCh7CiAgICBhY3RvciA9IG51bGwsCiAgICBhY3Rpb24sCiAgICBvYmplY3QgPSBudWxsLAog",
    "ICAgZ3JhbnQgPSBudWxsLAogICAgcmVhc29uID0gJ2RlbmllZCcsCiAgICByZXN1bHQgPSAnZGVuaWVkJywKICAgIHJlcXVlc3RJ",
    "ZCA9IG51bGwsCiAgICByb2xlID0gbnVsbAogIH0pIHsKICAgIGF3YWl0IHJlZnMuam91cm5hbC5wdXNoKHsKICAgICAgYWN0b3I6",
    "IGFjdG9yPy5pZCB8fCBudWxsLAogICAgICByb2xlOiByb2xlIHx8IGFjdG9yPy5yb2xlcyB8fCBbXSwKICAgICAgb2JqZWN0Ogog",
    "ICAgICAgIHR5cGVvZiBvYmplY3QgPT09ICdzdHJpbmcnICYmIC9eZmFjX1thLXpdK19bYS1mMC05XXsyNH0kLy50ZXN0KG9iamVj",
    "dCkKICAgICAgICAgID8gb2JqZWN0CiAgICAgICAgICA6IG51bGwsCiAgICAgIGFjdGlvbiwKICAgICAgZ3JhbnQsCiAgICAgIHJl",
    "YXNvbjogUkVBU09OUy5oYXMocmVhc29uKQogICAgICAgID8gcmVhc29uCiAgICAgICAgOiAvXlthLXpfXXsxLDY0fSQvLnRlc3Qo",
    "cmVhc29uKQogICAgICAgICAgPyByZWFzb24KICAgICAgICAgIDogJ2ludmFsaWRfcmVhc29uJywKICAgICAgcmVzdWx0LAogICAg",
    "ICB0aW1lc3RhbXA6IG5ldyBEYXRlKG5vdygpKS50b0lTT1N0cmluZygpLAogICAgICByZXF1ZXN0SWQ6IGlkVmFsaWQocmVxdWVz",
    "dElkKSA/IHJlcXVlc3RJZCA6IG51bGwKICAgIH0pOwogIH0KICBhc3luYyBmdW5jdGlvbiBsb2dpbihlbWFpbCwgcGFzc3dvcmQp",
    "IHsKICAgIGNvbnN0IHJvd3MgPQogICAgICAoCiAgICAgICAgYXdhaXQgcmVmcy5pZGVudGl0aWVzCiAgICAgICAgICAub3JkZXJC",
    "eUNoaWxkKCdlbWFpbCcpCiAgICAgICAgICAuZXF1YWxUbygKICAgICAgICAgICAgU3RyaW5nKGVtYWlsIHx8ICcnKQogICAgICAg",
    "ICAgICAgIC50cmltKCkKICAgICAgICAgICAgICAudG9Mb3dlckNhc2UoKQogICAgICAgICAgKQogICAgICAgICAgLm9uY2UoJ3Zh",
    "bHVlJykKICAgICAgKS52YWwoKSB8fCB7fTsKICAgIGNvbnN0IGVudHJpZXMgPSBPYmplY3QuZW50cmllcyhyb3dzKTsKICAgIGlm",
    "IChlbnRyaWVzLmxlbmd0aCAhPT0gMSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBbaWQsIHJlY29yZF0gPSBlbnRyaWVzWzBdOwog",
    "ICAgaWYgKAogICAgICAhaWRWYWxpZChpZCkgfHwKICAgICAgcmVjb3JkLmFjdGl2ZSAhPT0gdHJ1ZSB8fAogICAgICAhcm9sZXMo",
    "cmVjb3JkKS5sZW5ndGggfHwKICAgICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHJlY29yZC5hdXRob3JpemF0aW9uVmVyc2lvbikg",
    "fHwKICAgICAgcmVjb3JkLmF1dGhvcml6YXRpb25WZXJzaW9uIDwgMCB8fAogICAgICAhdmVyaWZ5UGFzc3dvcmQocGFzc3dvcmQs",
    "IHJlY29yZC5wYXNzd29yZEhhc2gpCiAgICApCiAgICAgIHJldHVybiBudWxsOwogICAgY29uc3QgdG9rZW4gPSBjcnlwdG8ucmFu",
    "ZG9tQnl0ZXMoMzIpLnRvU3RyaW5nKCdoZXgnKTsKICAgIGF3YWl0IHJlZnMuc2Vzc2lvbnMuY2hpbGQoaGFzaCh0b2tlbikpLnNl",
    "dCh7CiAgICAgIGlkZW50aXR5SWQ6IGlkLAogICAgICBhdXRob3JpemF0aW9uVmVyc2lvbjogcmVjb3JkLmF1dGhvcml6YXRpb25W",
    "ZXJzaW9uLAogICAgICBzY2hlbWFWZXJzaW9uOiAxLAogICAgICBjcmVhdGVkQXQ6IG5vdygpLAogICAgICBleHBpcmVzQXQ6IG5v",
    "dygpICsgMjQgKiA2MCAqIDYwICogMTAwMCwKICAgICAgcmV2b2tlZDogZmFsc2UKICAgIH0pOwogICAgcmV0dXJuIHRva2VuOwog",
    "IH0KICBhc3luYyBmdW5jdGlvbiBzZXNzaW9uKHRva2VuKSB7CiAgICBpZiAodHlwZW9mIHRva2VuICE9PSAnc3RyaW5nJyB8fCAh",
    "L15bYS1mMC05XXs2NH0kLy50ZXN0KHRva2VuKSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBzID0gKGF3YWl0IHJlZnMuc2Vzc2lv",
    "bnMuY2hpbGQoaGFzaCh0b2tlbikpLm9uY2UoJ3ZhbHVlJykpLnZhbCgpOwogICAgaWYgKAogICAgICAhcyB8fAogICAgICBzLnNj",
    "aGVtYVZlcnNpb24gIT09IDEgfHwKICAgICAgcy5yZXZva2VkICE9PSBmYWxzZSB8fAogICAgICAhTnVtYmVyLmlzRmluaXRlKHMu",
    "Y3JlYXRlZEF0KSB8fAogICAgICBzLmNyZWF0ZWRBdCA8IDAgfHwKICAgICAgcy5jcmVhdGVkQXQgPiBub3coKSB8fAogICAgICAh",
    "TnVtYmVyLmlzRmluaXRlKHMuZXhwaXJlc0F0KSB8fAogICAgICBzLmV4cGlyZXNBdCA8PSBub3coKSB8fAogICAgICBzLmV4cGly",
    "ZXNBdCAtIHMuY3JlYXRlZEF0ID4gMjQgKiA2MCAqIDYwICogMTAwMCB8fAogICAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIocy5h",
    "dXRob3JpemF0aW9uVmVyc2lvbikgfHwKICAgICAgcy5hdXRob3JpemF0aW9uVmVyc2lvbiA8IDAgfHwKICAgICAgIWlkVmFsaWQo",
    "cy5pZGVudGl0eUlkKQogICAgKQogICAgICByZXR1cm4gbnVsbDsKICAgIGNvbnN0IGkgPSAoYXdhaXQgcmVmcy5pZGVudGl0aWVz",
    "LmNoaWxkKHMuaWRlbnRpdHlJZCkub25jZSgndmFsdWUnKSkudmFsKCk7CiAgICBpZiAoCiAgICAgIGk/LmFjdGl2ZSAhPT0gdHJ1",
    "ZSB8fAogICAgICAhcm9sZXMoaSkubGVuZ3RoIHx8CiAgICAgICFOdW1iZXIuaXNTYWZlSW50ZWdlcihpLmF1dGhvcml6YXRpb25W",
    "ZXJzaW9uKSB8fAogICAgICBpLmF1dGhvcml6YXRpb25WZXJzaW9uICE9PSBzLmF1dGhvcml6YXRpb25WZXJzaW9uCiAgICApCiAg",
    "ICAgIHJldHVybiBudWxsOwogICAgcmV0dXJuIHsKICAgICAgaWQ6IHMuaWRlbnRpdHlJZCwKICAgICAgcm9sZXM6IHJvbGVzKGkp",
    "LAogICAgICBhdXRob3JpemF0aW9uVmVyc2lvbjogaS5hdXRob3JpemF0aW9uVmVyc2lvbiwKICAgICAgY2FuVXNlQWRtaW5VaTog",
    "dHJ1ZSwKICAgICAgY2FuQnlwYXNzVHdhR2F0ZTogZmFsc2UsCiAgICAgIGNhbkFjY2Vzc0FkbWluQ29udmVyc2F0aW9uczogcm9s",
    "ZXMoaSkuaW5jbHVkZXMoJ2FkbWluaXN0cmF0b3InKSwKICAgICAgY2FuQWNjZXNzU3VwcG9ydENhc2VzOiByb2xlcyhpKS5pbmNs",
    "dWRlcygnYWRtaW5pc3RyYXRvcicpLAogICAgICBjYW5BY2Nlc3NGYWNpbGl0YXRpb25BZG1pbjogcm9sZXMoaSkuaW5jbHVkZXMo",
    "J3ByYWN0aXRpb25lcicpCiAgICB9OwogIH0KICBhc3luYyBmdW5jdGlvbiByZXZva2UodG9rZW4pIHsKICAgIGlmICh0eXBlb2Yg",
    "dG9rZW4gPT09ICdzdHJpbmcnICYmIC9eW2EtZjAtOV17NjR9JC8udGVzdCh0b2tlbikpCiAgICAgIGF3YWl0IHJlZnMuc2Vzc2lv",
    "bnMuY2hpbGQoaGFzaCh0b2tlbikpLnVwZGF0ZSh7IHJldm9rZWQ6IHRydWUgfSk7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIGFzc2ln",
    "bm1lbnRBbmRHcmFudChhY3RvciwgdXNlcklkKSB7CiAgICBpZiAoIWFjdG9yPy5yb2xlcy5pbmNsdWRlcygncHJhY3RpdGlvbmVy",
    "JykgfHwgIWlkVmFsaWQodXNlcklkKSkgcmV0dXJuIG51bGw7CiAgICBjb25zdCBbYSwgZ10gPSBhd2FpdCBQcm9taXNlLmFsbChb",
    "CiAgICAgIHJlZnMuYXNzaWdubWVudHMuY2hpbGQoYWN0b3IuaWQpLmNoaWxkKHVzZXJJZCkub25jZSgndmFsdWUnKSwKICAgICAg",
    "cmVmcy5ncmFudHMuY2hpbGQodXNlcklkKS5jaGlsZChhY3Rvci5pZCkub25jZSgndmFsdWUnKQogICAgXSk7CiAgICBjb25zdCBh",
    "c3NpZ25tZW50ID0gYS52YWwoKSwKICAgICAgZ3JhbnQgPSBnLnZhbCgpOwogICAgaWYgKAogICAgICBhc3NpZ25tZW50Py5hY3Rp",
    "dmUgIT09IHRydWUgfHwKICAgICAgZ3JhbnQ/LmFjdGl2ZSAhPT0gdHJ1ZSB8fAogICAgICAhaWRWYWxpZChncmFudC5pZCkgfHwK",
    "ICAgICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKGdyYW50LnZlcnNpb24pIHx8CiAgICAgIGdyYW50LnZlcnNpb24gPCAxIHx8CiAg",
    "ICAgICFOdW1iZXIuaXNGaW5pdGUoZ3JhbnQuc3RhcnRzQXQpIHx8CiAgICAgICFOdW1iZXIuaXNGaW5pdGUoZ3JhbnQuZW5kc0F0",
    "KSB8fAogICAgICBncmFudC5zdGFydHNBdCA+IG5vdygpIHx8CiAgICAgIGdyYW50LnN0YXJ0c0F0IDwgMCB8fAogICAgICBncmFu",
    "dC5lbmRzQXQgPD0gbm93KCkgfHwKICAgICAgIVsnY29udmVyc2F0aW9uX3NwZWNpZmljJywgJ2FjY29tcGFuaW1lbnRfcGVyaW9k",
    "J10uaW5jbHVkZXMoZ3JhbnQuc2NvcGUpCiAgICApCiAgICAgIHJldHVybiBudWxsOwogICAgcmV0dXJuIGdyYW50OwogIH0KICBh",
    "c3luYyBmdW5jdGlvbiBjb250ZW50KAogICAgYWN0b3IsCiAgICB1c2VySWQsCiAgICBjb252ZXJzYXRpb24sCiAgICBhY3Rpb24s",
    "CiAgICByZXF1ZXN0SWQsCiAgICByZWFzb24sCiAgICBleGVyY2lzZWRSb2xlID0gJ3ByYWN0aXRpb25lcicKICApIHsKICAgIGxl",
    "dCBncmFudCA9IG51bGwsCiAgICAgIG9rID0gZmFsc2UsCiAgICAgIGNvZGUgPSAnY29udGVudF9kZW5pZWQnLAogICAgICByb2xl",
    "ID0gbnVsbDsKICAgIGNvbnN0IGR1cmFibGUgPQogICAgICBhY3Rpb24gIT09ICdzdW1tYXJ5JyAmJiBpZFZhbGlkKGNvbnZlcnNh",
    "dGlvbj8uaWQpCiAgICAgICAgPyAoCiAgICAgICAgICAgIGF3YWl0IGRiLnJlZignY29udmVyc2F0aW9ucycpLmNoaWxkKGNvbnZl",
    "cnNhdGlvbi5pZCkub25jZSgndmFsdWUnKQogICAgICAgICAgKS52YWwoKQogICAgICAgIDogbnVsbDsKICAgIGlmICgKICAgICAg",
    "YWN0aW9uICE9PSAnc3VtbWFyeScgJiYKICAgICAgKCFjb252ZXJzYXRpb24gfHwKICAgICAgICAhaWRWYWxpZChjb252ZXJzYXRp",
    "b24uaWQpIHx8CiAgICAgICAgY29udmVyc2F0aW9uLnVzZXJJZCAhPT0gdXNlcklkIHx8CiAgICAgICAgIWR1cmFibGUgfHwKICAg",
    "ICAgICBkdXJhYmxlLnVzZXJJZCAhPT0gdXNlcklkKQogICAgKQogICAgICBjb2RlID0gJ29iamVjdF9vd25lcl9taXNtYXRjaCc7",
    "CiAgICBlbHNlIGlmICgKICAgICAgY29udmVyc2F0aW9uPy5pc1ByaXZhdGUgPT09IHRydWUgfHwKICAgICAgY29udmVyc2F0aW9u",
    "Py5kZWxldGVkQXQgfHwKICAgICAgZHVyYWJsZT8uaXNQcml2YXRlID09PSB0cnVlIHx8CiAgICAgIGR1cmFibGU/LmRlbGV0ZWRB",
    "dAogICAgKQogICAgICBjb2RlID0gJ3ByaXZhdGVfb3JfcmVtb3ZlZCc7CiAgICBlbHNlIGlmICgKICAgICAgZXhlcmNpc2VkUm9s",
    "ZSA9PT0gJ2FkbWluaXN0cmF0b3InICYmCiAgICAgIGFjdG9yPy5yb2xlcy5pbmNsdWRlcygnYWRtaW5pc3RyYXRvcicpCiAgICAp",
    "IHsKICAgICAgcm9sZSA9ICdhZG1pbmlzdHJhdG9yJzsKICAgICAgb2sgPSBSRUFTT05TLmhhcyhyZWFzb24pOwogICAgICBjb2Rl",
    "ID0gb2sgPyByZWFzb24gOiAnYWRtaW5pc3RyYXRvcl9yZWFzb25fcmVxdWlyZWQnOwogICAgfSBlbHNlIHsKICAgICAgcm9sZSA9",
    "IGFjdG9yPy5yb2xlcy5pbmNsdWRlcygncHJhY3RpdGlvbmVyJykgPyAncHJhY3RpdGlvbmVyJyA6IG51bGw7CiAgICAgIGdyYW50",
    "ID0gYXdhaXQgYXNzaWdubWVudEFuZEdyYW50KGFjdG9yLCB1c2VySWQpOwogICAgICBvayA9CiAgICAgICAgISFncmFudCAmJgog",
    "ICAgICAgIChhY3Rpb24gPT09ICdzdW1tYXJ5JwogICAgICAgICAgPyBncmFudC5hbGxvd0ludGVyc2Vzc2lvblN1bW1hcnkgPT09",
    "IHRydWUKICAgICAgICAgIDogZ3JhbnQuc2NvcGUgPT09ICdhY2NvbXBhbmltZW50X3BlcmlvZCcgfHwKICAgICAgICAgICAgKEFy",
    "cmF5LmlzQXJyYXkoZ3JhbnQuY29udmVyc2F0aW9uSWRzKSAmJgogICAgICAgICAgICAgIGdyYW50LmNvbnZlcnNhdGlvbklkcy5p",
    "bmNsdWRlcyhjb252ZXJzYXRpb24/LmlkKSkpOwogICAgICBjb2RlID0gb2sgPyAnYWN0aXZlX2dyYW50JyA6ICdncmFudF9yZXF1",
    "aXJlZCc7CiAgICB9CiAgICBhd2FpdCBqb3VybmFsKHsKICAgICAgYWN0b3IsCiAgICAgIHJvbGUsCiAgICAgIGFjdGlvbiwKICAg",
    "ICAgb2JqZWN0OiBjb252ZXJzYXRpb24/LmlkCiAgICAgICAgPyByZWZlcmVuY2UoJ2NvbnZlcnNhdGlvbicsIGNvbnZlcnNhdGlv",
    "bi5pZCkKICAgICAgICA6IHJlZmVyZW5jZSgndXNlcicsIHVzZXJJZCksCiAgICAgIGdyYW50OiBncmFudCA/IHsgaWQ6IGdyYW50",
    "LmlkLCB2ZXJzaW9uOiBncmFudC52ZXJzaW9uIH0gOiBudWxsLAogICAgICByZWFzb246IGNvZGUsCiAgICAgIHJlc3VsdDogb2sg",
    "PyAnYWxsb3dlZCcgOiAnZGVuaWVkJywKICAgICAgcmVxdWVzdElkCiAgICB9KTsKICAgIHJldHVybiBvazsKICB9CiAgYXN5bmMg",
    "ZnVuY3Rpb24gZGlyZWN0b3J5KGFjdG9yKSB7CiAgICBpZiAoIWFjdG9yPy5yb2xlcy5pbmNsdWRlcygncHJhY3RpdGlvbmVyJykp",
    "IHJldHVybiBbXTsKICAgIGNvbnN0IGFzc2lnbm1lbnRzID0KICAgICAgKGF3YWl0IHJlZnMuYXNzaWdubWVudHMuY2hpbGQoYWN0",
    "b3IuaWQpLm9uY2UoJ3ZhbHVlJykpLnZhbCgpIHx8IHt9OwogICAgY29uc3Qgb3V0ID0gW107CiAgICBmb3IgKGNvbnN0IFt1c2Vy",
    "SWQsIGFdIG9mIE9iamVjdC5lbnRyaWVzKGFzc2lnbm1lbnRzKSkgewogICAgICBpZiAoCiAgICAgICAgYS5hY3RpdmUgIT09IHRy",
    "dWUgfHwKICAgICAgICAhaWRWYWxpZCh1c2VySWQpIHx8CiAgICAgICAgIShhd2FpdCBhc3NpZ25tZW50QW5kR3JhbnQoYWN0b3Is",
    "IHVzZXJJZCkpCiAgICAgICkKICAgICAgICBjb250aW51ZTsKICAgICAgb3V0LnB1c2goeyB1c2VySWQsIHVzZXJSZWY6IHJlZmVy",
    "ZW5jZSgndXNlcicsIHVzZXJJZCkgfSk7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KICBhc3luYyBmdW5jdGlvbiByZXNvbHZl",
    "VXNlcihhY3RvciwgdXNlclJlZikgewogICAgcmV0dXJuIChhd2FpdCBkaXJlY3RvcnkoYWN0b3IpKS5maW5kKCh4KSA9PiB4LnVz",
    "ZXJSZWYgPT09IHVzZXJSZWYpIHx8IG51bGw7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIGNvbnZlcnNhdGlvbnMoYWN0b3IsIHVzZXJJ",
    "ZCkgewogICAgY29uc3Qgcm93cyA9CiAgICAgICgKICAgICAgICBhd2FpdCBkYgogICAgICAgICAgLnJlZignY29udmVyc2F0aW9u",
    "cycpCiAgICAgICAgICAub3JkZXJCeUNoaWxkKCd1c2VySWQnKQogICAgICAgICAgLmVxdWFsVG8odXNlcklkKQogICAgICAgICAg",
    "Lm9uY2UoJ3ZhbHVlJykKICAgICAgKS52YWwoKSB8fCB7fTsKICAgIGNvbnN0IGcgPSBhd2FpdCBhc3NpZ25tZW50QW5kR3JhbnQo",
    "YWN0b3IsIHVzZXJJZCk7CiAgICBpZiAoIWcpIHJldHVybiBbXTsKICAgIHJldHVybiBPYmplY3QuZW50cmllcyhyb3dzKQogICAg",
    "ICAuZmlsdGVyKAogICAgICAgIChbaWQsIGNdKSA9PgogICAgICAgICAgYz8udXNlcklkID09PSB1c2VySWQgJiYKICAgICAgICAg",
    "IGMuaXNQcml2YXRlICE9PSB0cnVlICYmCiAgICAgICAgICAhYy5kZWxldGVkQXQgJiYKICAgICAgICAgIChnLnNjb3BlID09PSAn",
    "YWNjb21wYW5pbWVudF9wZXJpb2QnIHx8CiAgICAgICAgICAgIGcuY29udmVyc2F0aW9uSWRzPy5pbmNsdWRlcyhpZCkpCiAgICAg",
    "ICkKICAgICAgLm1hcCgoW2lkLCBjXSkgPT4gKHsgLi4uYywgaWQgfSkpOwogIH0KICBjb25zdCBwcm9qZWN0TWVzc2FnZSA9ICht",
    "KSA9PiAoewogICAgcm9sZTogWyd1c2VyJywgJ2Fzc2lzdGFudCddLmluY2x1ZGVzKG0ucm9sZSkgPyBtLnJvbGUgOiAndW5rbm93",
    "bicsCiAgICBjb250ZW50OiB0eXBlb2YgbS5jb250ZW50ID09PSAnc3RyaW5nJyA/IG0uY29udGVudCA6ICcnLAogICAgdGltZXN0",
    "YW1wOiBtLnRpbWVzdGFtcCB8fCBudWxsCiAgfSk7CiAgcmV0dXJuIHsKICAgIGxvZ2luLAogICAgc2Vzc2lvbiwKICAgIHJldm9r",
    "ZSwKICAgIGpvdXJuYWwsCiAgICByZWZlcmVuY2UsCiAgICBjb250ZW50LAogICAgZGlyZWN0b3J5LAogICAgcmVzb2x2ZVVzZXIs",
    "CiAgICBjb252ZXJzYXRpb25zLAogICAgcHJvamVjdE1lc3NhZ2UsCiAgICBhc3NpZ25tZW50QW5kR3JhbnQKICB9Owp9Cm1vZHVs",
    "ZS5leHBvcnRzID0geyBjcmVhdGVQcm9mZXNzaW9uYWxBY2Nlc3MsIFJPTEVTLCBSRUFTT05TLCBpZFZhbGlkIH07Cg=="
  ],
  "auth-password.js": [
    "J3VzZSBzdHJpY3QnOwoKY29uc3QgY3J5cHRvID0gcmVxdWlyZSgnY3J5cHRvJyk7CgpmdW5jdGlvbiBpc1N0cm9uZ1Bhc3N3b3Jk",
    "KHZhbHVlID0gJycpIHsKICBjb25zdCBwYXNzd29yZCA9IFN0cmluZyh2YWx1ZSB8fCAnJyk7CiAgcmV0dXJuICgKICAgIHBhc3N3",
    "b3JkLmxlbmd0aCA+PSAxMCAmJgogICAgL1tBLVphLXrDgC3DlsOYLcO2w7gtw79dLy50ZXN0KHBhc3N3b3JkKSAmJgogICAgL1xk",
    "Ly50ZXN0KHBhc3N3b3JkKQogICk7Cn0KCmZ1bmN0aW9uIGhhc2hQYXNzd29yZChwYXNzd29yZCkgewogIGNvbnN0IHNhbHQgPSBj",
    "cnlwdG8ucmFuZG9tQnl0ZXMoMTYpLnRvU3RyaW5nKCdoZXgnKTsKICBjb25zdCBoYXNoID0gY3J5cHRvCiAgICAuc2NyeXB0U3lu",
    "YyhTdHJpbmcocGFzc3dvcmQgfHwgJycpLCBzYWx0LCA2NCkKICAgIC50b1N0cmluZygnaGV4Jyk7CiAgcmV0dXJuIGBzY3J5cHQ6",
    "JHtzYWx0fToke2hhc2h9YDsKfQoKZnVuY3Rpb24gdmVyaWZ5UGFzc3dvcmQocGFzc3dvcmQsIHN0b3JlZEhhc2gpIHsKICBjb25z",
    "dCBwYXJ0cyA9IFN0cmluZyhzdG9yZWRIYXNoIHx8ICcnKS5zcGxpdCgnOicpOwogIGlmIChwYXJ0cy5sZW5ndGggIT09IDMgfHwg",
    "cGFydHNbMF0gIT09ICdzY3J5cHQnKSByZXR1cm4gZmFsc2U7CiAgY29uc3QgcGFzc3dvcmRIYXNoID0gY3J5cHRvLnNjcnlwdFN5",
    "bmMoU3RyaW5nKHBhc3N3b3JkIHx8ICcnKSwgcGFydHNbMV0sIDY0KTsKICBjb25zdCBleHBlY3RlZCA9IEJ1ZmZlci5mcm9tKHBh",
    "cnRzWzJdLCAnaGV4Jyk7CiAgcmV0dXJuICgKICAgIHBhc3N3b3JkSGFzaC5sZW5ndGggPT09IGV4cGVjdGVkLmxlbmd0aCAmJgog",
    "ICAgY3J5cHRvLnRpbWluZ1NhZmVFcXVhbChwYXNzd29yZEhhc2gsIGV4cGVjdGVkKQogICk7Cn0KCm1vZHVsZS5leHBvcnRzID0g",
    "eyBoYXNoUGFzc3dvcmQsIGlzU3Ryb25nUGFzc3dvcmQsIHZlcmlmeVBhc3N3b3JkIH07Cg=="
  ]
};
let moduleDirectory;
const result = {
  id: OWNER_ID,
  moduleExact: false,
  ownerSourceExact: false,
  ownerEmailExpected: false,
  contextOk: false,
  preflightOk: false,
  confirmed: false,
  created: false,
  loginOk: false,
  uniqueAdministrator: false,
  revoked: false,
  revokedSessionRejected: false,
  identityDisabledOnFailure: false,
  cleanupOk: false,
  ok: false
};

function requireExact(name) {
  const file = path.join(moduleDirectory, name);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== PINNED[name]) throw new Error('module_mismatch');
  return require(file);
}

function resolveOwnerEmail() {
  const source = fs.readFileSync(path.join(process.cwd(), 'server.js'));
  result.ownerSourceExact = crypto.createHash('sha256').update(source).digest('hex') === LIVE_SERVER_SHA256;
  if (!result.ownerSourceExact) throw new Error('live_source_mismatch');
  // One literal email in the pinned owner list; no eval/require of server.js.
  // Do not extract the password map or any legacy password.
  const literal = source.toString('utf8').match(
    /\bconst\s+PROFESSIONAL_FULL_ACCESS_EMAILS_RAW\s*=\s*\[\s*(['"])([^'"\\\r\n]+)\1\s*\]\s*;/
  );
  if (!literal) throw new Error('owner_literal_mismatch');
  const email = literal[2].trim().toLowerCase();
  result.ownerEmailExpected = crypto.createHash('sha256').update(email).digest('hex') === OWNER_EMAIL_SHA256;
  if (!result.ownerEmailExpected) throw new Error('owner_email_mismatch');
  return email;
}

// Raw TTY input: no echo, argv, env, shell history or password file.
function secretLine(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || !process.stdout.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('tty_required'));
      return;
    }
    let text = '';
    const previousRaw = input.isRaw;
    function finish(error) {
      input.removeListener('data', receive);
      input.removeListener('error', failed);
      input.setRawMode(previousRaw);
      input.pause();
      output('\n');
      const value = text;
      text = '';
      if (error) reject(error);
      else resolve(value);
    }
    function failed() { finish(new Error('tty_failed')); }
    function receive(chunk) {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('entry_aborted'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          text = Array.from(text).slice(0, -1).join('');
        } else if (character >= ' ' && character !== '\u007f') {
          text += character;
          if (Buffer.byteLength(text, 'utf8') > 1024) {
            finish(new Error('entry_too_long'));
            return;
          }
        } else {
          finish(new Error('invalid_control_character'));
          return;
        }
      }
    }
    output(prompt);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.on('data', receive);
    input.on('error', failed);
    input.resume();
  });
}

async function main() {
  let app, db, access, token = null, password = '', confirmation = '', passwordHash = null;
  let ownerEmail = null;
  let createAttempted = false;
  const ours = record => record?.email === ownerEmail &&
    record?.displayName === OWNER_NAME && record?.passwordHash === passwordHash &&
    Array.isArray(record?.roles) && record.roles.length === 1 &&
    record.roles[0] === 'administrator' && record.authorizationVersion === 0;
  try {
    if (!path.resolve(__filename).startsWith('/tmp/')) throw new Error('temporary_operator_required');
    moduleDirectory = fs.mkdtempSync('/tmp/m0m1-owner-modules-');
    // Restore the exact embedded bytes only into this private temporary directory.
    for (const [name, digest] of Object.entries(PINNED)) {
      const source = Buffer.from(SOURCE_BASE64[name].join(''), 'base64');
      if (crypto.createHash('sha256').update(source).digest('hex') !== digest) {
        throw new Error('module_mismatch');
      }
      fs.writeFileSync(path.join(moduleDirectory, name), source, {mode: 0o600, flag: 'wx'});
    }
    const { hashPassword, isStrongPassword } = requireExact('auth-password.js');
    const { createProfessionalAccess } = requireExact('professional-access.js');
    result.moduleExact = true;
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('tty_required');
    if (process.env.RENDER_SERVICE_ID !== 'srv-d6lh0094tr6s73b71kug' ||
        process.env.RENDER_GIT_COMMIT !== LIVE_SHA ||
        process.env.FIREBASE_DATABASE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      throw new Error('runtime_mismatch');
    }
    ownerEmail = resolveOwnerEmail();
    const configFile = path.join(process.cwd(), 'lib/config.js');
    if (crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex') !==
        '541051c089d208f183add002e6923e54fdec24964016de4ebc61dbe172a5856b') {
      throw new Error('config_module_mismatch');
    }
    const { parseAppConfig, resolveServiceAccount } = appRequire('./lib/config');
    const config = parseAppConfig(process.env);
    const credential = resolveServiceAccount(config);
    if (credential.project_id !== PROJECT || credential.client_email !== PRINCIPAL ||
        new URL(config.firebaseDatabaseUrl).href !== DATABASE ||
        config.adminSessionSecret.length < 32 || config.userSessionSecret.length < 32 ||
        config.adminSessionSecret === config.userSessionSecret) {
      throw new Error('context_mismatch');
    }
    const admin = appRequire('firebase-admin');
    app = admin.initializeApp({credential: admin.credential.cert(credential), databaseURL: DATABASE},
      'launch-owner-operator');
    db = app.database();
    result.contextOk = true;
    const identities = db.ref('professionalIdentities');
    const owner = identities.child(OWNER_ID);
    const [record, emailMatches, namespace] = await Promise.all([
      owner.once('value'), identities.orderByChild('email').equalTo(ownerEmail).once('value'),
      identities.once('value')
    ]);
    if (record.exists() || emailMatches.exists() || namespace.exists()) throw new Error('preexisting_identity');
    result.preflightOk = true;
    output('Prêt. Passation à l’utilisateur : saisir et confirmer lui-même le nouveau credential.\n');
    password = await secretLine('Nouveau mot de passe (entrée masquée) : ');
    confirmation = await secretLine('Confirmation (entrée masquée) : ');
    if (password !== confirmation || !isStrongPassword(password)) throw new Error('password_rejected');
    confirmation = '';
    result.confirmed = true;
    passwordHash = hashPassword(password);
    const newRecord = {
      email: ownerEmail, displayName: OWNER_NAME, passwordHash, active: true,
      roles: ['administrator'], authorizationVersion: 0
    };
    createAttempted = true;
    // Only this initially empty professional namespace, never the RTDB root.
    // Atomic emptiness check prevents a concurrent duplicate or any overwrite.
    const creation = await identities.transaction(current =>
      current === null ? {[OWNER_ID]: newRecord} : undefined
    );
    if (!creation.committed) throw new Error('creation_refused');
    result.created = true;
    const unique = (await identities.orderByChild('email').equalTo(ownerEmail).once('value')).val() || {};
    if (Object.keys(unique).length !== 1 || !ours(unique[OWNER_ID])) throw new Error('uniqueness_failed');
    access = createProfessionalAccess({db, secret: config.adminSessionSecret});
    token = await access.login(ownerEmail, password);
    result.loginOk = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
    if (!result.loginOk) throw new Error('login_failed');
    const session = await access.session(token);
    result.uniqueAdministrator = session?.id === OWNER_ID && session.authorizationVersion === 0 &&
      session.roles?.length === 1 && session.roles[0] === 'administrator' &&
      session.canAccessAdminConversations === true && session.canAccessSupportCases === true &&
      session.canAccessFacilitationAdmin === false && session.canBypassTwaGate === false;
    if (!result.uniqueAdministrator) throw new Error('role_failed');
    await access.revoke(token);
    result.revoked = true;
    result.revokedSessionRejected = (await access.session(token)) === null;
    if (!result.revokedSessionRejected) throw new Error('revocation_failed');
    result.ok = true;
  } catch {
    result.ok = false;
  } finally {
    if (token && access) {
      try {
        await access.revoke(token);
        result.revoked = true;
        result.revokedSessionRejected = (await access.session(token)) === null;
      } catch { result.revoked = false; result.revokedSessionRejected = false; result.ok = false; }
    }
    if (!result.ok && createAttempted && db) {
      try {
        const ref = db.ref('professionalIdentities').child(OWNER_ID);
        const disabled = await ref.transaction(record => {
          if (!ours(record)) return;
          return {...record, active: false, authorizationVersion: 1};
        });
        result.identityDisabledOnFailure = disabled.committed;
      } catch { result.identityDisabledOnFailure = false; }
    }
    password = ''; confirmation = ''; passwordHash = null; token = null; ownerEmail = null;
    try {
      if (db) db.goOffline();
      if (app) await app.delete(); // Close this local SDK app, never delete an instance.
      result.cleanupOk = true;
    } catch { result.cleanupOk = false; result.ok = false; }
    output(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  }
}

main().catch(() => {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  output(JSON.stringify({id: OWNER_ID, ok: false}) + '\n');
  process.exitCode = 1;
});
