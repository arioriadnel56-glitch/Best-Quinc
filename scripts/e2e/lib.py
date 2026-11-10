import psycopg2, time, urllib.request, subprocess
import json

FRONT='http://127.0.0.1:3102'; API='http://127.0.0.1:3101'; CTRL='http://127.0.0.1:3199'
def ctrl(chemin):
    return json.loads(urllib.request.urlopen(CTRL+chemin).read().decode() or 'null') if chemin.startswith('/mode') or chemin.startswith('/journal') else urllib.request.urlopen(CTRL+chemin).read()
def mode(**kw):
    q='&'.join(f'{k}={v}' for k,v in kw.items()); return ctrl('/mode?'+q)
def journal(depuis=0): return ctrl(f'/journal?depuis={depuis}')
def sql(req):
    conn = psycopg2.connect(database="bq", host="/tmp", port=5433, user="postgres")
    try:
        with conn.cursor() as cur:
            cur.execute(req)
            if cur.description:
                rows = cur.fetchall()
                return "\n".join("|".join(str(col) for col in row) for row in rows)
            conn.commit()
            return ""
    finally:
        conn.close()
def api(methode, chemin, jeton=None, corps=None):
    r=urllib.request.Request(API+chemin, method=methode, data=json.dumps(corps).encode() if corps is not None else None, headers={'Content-Type':'application/json', **({'Authorization':'Bearer '+jeton} if jeton else {})})
    return json.loads(urllib.request.urlopen(r).read().decode())
def attendre(cond, delai=30, pas=0.2, msg=''):
    t=time.time()
    while time.time()-t<delai:
        try:
            if cond(): return time.time()-t
        except Exception: pass
        time.sleep(pas)
    raise AssertionError('délai dépassé : '+msg)
def http_requetes(j): return [x for x in j if x['m']!='UPGRADE']
