"""Capture variable_fetched replies for a corpus, plus the v3-cached term info the client would fetch.
Usage: python3 capture_terminfo.py corpus_terminfo.json outdir"""
import asyncio, json, sys, time, websockets, gzip, os, urllib.request
URL="wss://v2.virtualflybrain.org/org.geppetto.frontend/GeppettoServlet"
PROJECT="http://v2.virtualflybrain.org/org.geppetto.frontend/geppetto/build/vfb.json"
corpus=json.load(open(sys.argv[1])); out=sys.argv[2]; os.makedirs(out, exist_ok=True)
async def run():
    async with websockets.connect(URL, ping_interval=None, max_size=None, open_timeout=30) as ws:
        n=[0]
        async def send(t,data):
            n[0]+=1; rid=f"cap-{n[0]}"
            await ws.send(json.dumps({"requestID":rid,"type":t,"data":(data if isinstance(data,str) else json.dumps(data)) if data is not None else None})); return rid
        async def wait_for(types, rid=None, timeout=120):
            t0=time.time()
            while time.time()-t0<timeout:
                m=await asyncio.wait_for(ws.recv(), timeout)
                if isinstance(m,(bytes,bytearray)):
                    try: m=gzip.decompress(bytes(m[1:])).decode()
                    except Exception: m=bytes(m).decode(errors='replace')
                if m=="ping": continue
                try: j=json.loads(m)
                except Exception: continue
                if j.get("type") in types and (rid is None or j.get("requestID")==rid): return j
                if j.get("type") in ("error_running_command","generic_error") and j.get("requestID")==rid: return j
            raise TimeoutError(types)
        await wait_for({"client_id"})
        rid=await send("load_project_from_url", PROJECT)
        pl=await wait_for({"project_loaded"}, rid); project_id=json.loads(json.loads(pl["data"])["project_loaded"])["project"]["id"]
        ml=await wait_for({"geppetto_model_loaded"}, rid)
        open(f"{out}/_base_model.json","w").write(json.loads(ml["data"])["geppetto_model_loaded"])
        order=[]
        for group,vid,label in corpus:
            try:
                ti=urllib.request.urlopen(f"https://v3-cached.virtualflybrain.org/get_term_info?id={vid}", timeout=60).read().decode()
            except Exception as e:
                print(vid,"term info fetch failed",e); continue
            rid=await send("fetch_variable",{"projectId":project_id,"variableId":[vid],"dataSourceId":"vfbqueryTermInfo"})
            r=await wait_for({"variable_fetched"}, rid, timeout=180)
            if r.get("type")!="variable_fetched":
                print(vid,"server error",str(r)[:200]); continue
            raw=json.loads(r["data"])["variable_fetched"]
            os.makedirs(f"{out}/{vid}",exist_ok=True)
            open(f"{out}/{vid}/term_info.json","w").write(ti)
            open(f"{out}/{vid}/variable_fetched.json","w").write(raw)
            order.append(vid); print(group, vid, len(raw), flush=True)
        json.dump(order, open(f"{out}/_order.json","w"))
asyncio.run(run())
