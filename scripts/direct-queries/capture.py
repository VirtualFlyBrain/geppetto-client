"""Capture run_query / run_query_count replies for every query a set of terms offers,
plus the v3-cached JSON the client would fetch. Usage: python3 capture_query.py out ids..."""
import asyncio, json, sys, time, websockets, gzip, os, urllib.request, urllib.parse
URL="wss://v2.virtualflybrain.org/org.geppetto.frontend/GeppettoServlet"
PROJECT="http://v2.virtualflybrain.org/org.geppetto.frontend/geppetto/build/vfb.json"
out=sys.argv[1]; ids=sys.argv[2:]; os.makedirs(out, exist_ok=True)
async def run():
    async with websockets.connect(URL, ping_interval=None, max_size=None, open_timeout=30) as ws:
        n=[0]
        async def send(t,data):
            n[0]+=1; rid=f"cap-{n[0]}"
            await ws.send(json.dumps({"requestID":rid,"type":t,"data":(data if isinstance(data,str) else json.dumps(data)) if data is not None else None})); return rid
        async def wait_for(types, rid=None, timeout=180):
            t0=time.time()
            while time.time()-t0<timeout:
                m=await asyncio.wait_for(ws.recv(), timeout)
                if isinstance(m,(bytes,bytearray)):
                    try: m=gzip.decompress(bytes(m[1:])).decode()
                    except Exception: m=bytes(m).decode(errors='replace')
                if m=="ping": continue
                try: j=json.loads(m)
                except Exception: continue
                if j.get("requestID")==rid and (j.get("type") in types or j.get("type") in ("error_running_command","generic_error")): return j
            raise TimeoutError(types)
        await wait_for({"client_id"})
        rid=await send("load_project_from_url", PROJECT)
        pl=await wait_for({"project_loaded"}, rid); project_id=json.loads(json.loads(pl["data"])["project_loaded"])["project"]["id"]
        ml=await wait_for({"geppetto_model_loaded"}, rid); base=json.loads(json.loads(ml["data"])["geppetto_model_loaded"])
        open(f"{out}/_base_model.json","w").write(json.dumps(base))
        # map top-level query id -> query_type from the chain
        qtype={}
        for q in base["queries"]:
            ref=q["queryChain"][0].get("$ref","")
            try:
                di=int(ref.split("@dataSources.")[1].split("/")[0]); qi=int(ref.split("@queries.")[1])
                chain=base["dataSources"][di]["queries"][qi]["queryChain"]
                qtype[q["id"]]=urllib.parse.parse_qs(chain[0]["query"].replace("$ID","X"))["query_type"][0]
            except Exception as e: print("no qtype for", q["id"], e)
        json.dump(qtype, open(f"{out}/_qtype.json","w"), indent=0)
        log=[]
        for vid in ids:
            rid=await send("fetch_variable",{"projectId":project_id,"variableId":[vid],"dataSourceId":"vfbqueryTermInfo"})
            r=await wait_for({"variable_fetched"}, rid)
            ti=json.load(urllib.request.urlopen(f"https://v3-cached.virtualflybrain.org/get_term_info?id={vid}", timeout=60))
            queries=[q["query"] for q in ti.get("Queries",[]) if q.get("query")]
            name=ti.get("Name")
            for qid in queries:
                if qid not in qtype: print("skip", vid, qid, "(not a vfbquery query)"); continue
                d=f"{out}/{vid}__{qid}"; os.makedirs(d, exist_ok=True)
                try:
                    raw=urllib.request.urlopen(f"https://v3-cached.virtualflybrain.org/run_query?id={vid}&query_type={qtype[qid]}", timeout=120).read().decode()
                except Exception as e:
                    print(vid, qid, "v3 fetch failed", e); continue
                open(f"{d}/run_query.json","w").write(raw)
                rq=[{"targetVariablePath":vid,"queryPath":qid}]
                rid=await send("run_query_count",{"projectId":project_id,"runnableQueries":rq})
                c=await wait_for({"return_query_count"}, rid)
                open(f"{d}/return_query_count.json","w").write(c["data"])
                rid=await send("run_query",{"projectId":project_id,"runnableQueries":rq,"offset":0,"limit":10000})
                r=await wait_for({"return_query_results"}, rid)
                if r.get("type")!="return_query_results": print(vid,qid,"error",str(r)[:200]); continue
                open(f"{d}/return_query_results.json","w").write(r["data"])
                log.append([vid,qid,name]); print(vid, qid, len(r["data"]), flush=True)
        json.dump(log, open(f"{out}/_order.json","w"))
asyncio.run(run())
