// Captured shape from Common App main.<hash>.js (2026-07). Two things matter:
//  1. The authenticated api25 key is the config value RIGHT AFTER the api25
//     base URL:  ...api25.commonapp.org","apiKey":"<REAL KEY>".
//  2. The "X-API-Key":"..." literal is a DECOY (sits next to an exportErrors
//     call). api25 REJECTS it with 403 on the authed endpoints. The extractor
//     must return the config key, NOT this literal.
// There is also an unrelated partner apiKey that must NOT be picked up.
this._http.post(u,b,{headers:{"Content-Type":"application/json","X-API-Key":"YOxw0L2zAB8AFTMadZRkG1TTNSAkswhY7ZMNaLFP"})}exportErrors(){}
var cfg={applicantApi:{baseUrl:"https://api25.commonapp.org",apiKey:"tYFvpgKw3GaxrwoztllAc2j5bekLdMF25aayCxwx"},partner:{baseUrl:"https://partner.example.com",apiKey:"Y7iNxZAZ0U7WgGddj633L7ADBu4sehTi2VD5Gmdu"}};
