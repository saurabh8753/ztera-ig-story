# ZInsta Aggregator — Setup

## 1. Files
- `index.js` — worker code (story endpoint + failover + cache + dashboard)
- `wrangler.toml` — config

## 2. KV namespace banayein
```
wrangler kv namespace create CACHE
```
Output me jo `id` milega, use `wrangler.toml` ke `[[kv_namespaces]]` block me paste karein.

## 3. Deploy
```
wrangler deploy
```

## 4. Upstream APIs secret set karein (unlimited add kar sakte ho)
```
wrangler secret put API_LIST
```
Prompt aane par comma-separated URLs paste karein:
```
https://igstory.jaanewale6.workers.dev,https://igstory2.jaanewale6.workers.dev,https://igstory3.jaanewale6.workers.dev,https://igstory4.jaanewale6.workers.dev
```
**Naya API future me add karna ho** to bas is secret ko dubara `wrangler secret put API_LIST` se update kar do (nayi comma-separated list ke saath) — code me kuch change nahi karna padega.

## 5. Use karo
- Story fetch: `https://<your-worker>.workers.dev/story?username=someuser`
- Dashboard: `https://<your-worker>.workers.dev/dashboard`
- Raw health JSON: `https://<your-worker>.workers.dev/api/status`
- Raw traffic stats JSON: `https://<your-worker>.workers.dev/api/stats`

## Kaise kaam karta hai
- **Failover**: har request ek rotation order me APIs try karti hai (round robin, taaki load sab APIs par baraabar baate). Agar ek API down/error de to turant agli try hoti hai — user ko sirf pehla successful response milta hai.
- **Cache**: same username ka result `CACHE_TTL_SECONDS` (default 300s) tak KV me cache rehta hai, dobara request aane par turant wahi cached JSON return hota hai (`x-cache: HIT` header).
- **Dashboard**: `/dashboard` per 30 second me auto-refresh hoke sabhi APIs ka live up/down status, response time aur last-checked time dikhata hai.
- **Traffic tracking**: har `/story` request pe counter update hota hai (aaj ki date IST me) — total requests, cache-se-serve hue kitne, aur har upstream API ne kitne serve kiye (count + % share, bar ke saath). Counters KV me 2 din tak rehte hain, phir apne aap expire ho jaate hain.
