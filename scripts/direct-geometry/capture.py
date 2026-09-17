"""Drive the live Geppetto websocket like the browser does and save every reply.
Usage: python3 capture.py <VFB id> [<VFB id> ...]  -> captures/<id>/*.json"""
import asyncio, json, sys, time, websockets, gzip, os
URL="wss://v2.virtualflybrain.org/org.geppetto.frontend/GeppettoServlet"
PROJECT="http://v2.virtualflybrain.org/org.geppetto.frontend/geppetto/build/vfb.json"
async def run(ids):
    async with websockets.connect(URL, ping_interval=None, max_size=None, open_timeout=30) as ws:
        n=[0]
        pending={}
        async def send(t,data):
            n[0]+=1; rid=f"cap-{n[0]}"
            await ws.send(json.dumps({"requestID":rid,"type":t,"data":(data if isinstance(data,str) else json.dumps(data)) if data is not None else None}))
            return rid
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
                if j.get("type")=="error_running_command" or j.get("type")=="generic_error": print("  server error:",str(j)[:300])
            raise TimeoutError(types)
        await wait_for({"client_id"})
        rid=await send("load_project_from_url", PROJECT)
        pl=await wait_for({"project_loaded"}, rid); project_id=json.loads(json.loads(pl["data"])["project_loaded"])["project"]["id"]
        ml=await wait_for({"geppetto_model_loaded"}, rid)
        os.makedirs("captures/_project",exist_ok=True)
        open("captures/_project/geppetto_model_loaded.json","w").write(json.loads(ml["data"])["geppetto_model_loaded"])
        print("project",project_id,"base model saved")
        for vid in ids:
            d=f"captures/{vid}"; os.makedirs(d,exist_ok=True)
            rid=await send("fetch_variable",{"projectId":project_id,"variableId":[vid],"dataSourceId":"vfbqueryTermInfo"})
            r=await wait_for({"variable_fetched"}, rid)
            raw=json.loads(r["data"])["variable_fetched"]; open(f"{d}/variable_fetched.json","w").write(raw)
            m=json.loads(raw)
            # find import types for this id
            imports=[]
            for li,lib in enumerate(m.get("libraries",[])):
                for ti,t in enumerate(lib.get("types",[])):
                    if t.get("eClass")=="ImportType" and t.get("id","").startswith(vid) and not t.get("synched"):
                        imports.append((lib["id"]+"."+t["id"], t.get("modelInterpreterId"), t.get("url")))
            print(vid,"fetched; import types:",imports)
            for path,interp,url in imports:
                rid=await send("resolve_import_type",{"projectId":project_id,"paths":[path]})
                r=await wait_for({"import_type_resolved"}, rid, timeout=300)
                raw=json.loads(r["data"])["import_type_resolved"]
                open(f"{d}/import_type_resolved.{path.split('.')[-1]}.json","w").write(raw)
                print("  resolved",path,len(raw),"chars")
asyncio.run(run(sys.argv[1:]))
