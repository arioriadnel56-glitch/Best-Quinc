import sys, time; sys.path.insert(0,'/tmp/e2e')
from lib import *
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    nav=p.chromium.launch()
    for nom,url in [('vitrine','/'),('application (nouvel appareil)','/app/quincaillerie-zinsou/')]:
        mode(mode='dort', style='html503', reveilMs=6000); urllib.request.urlopen(CTRL+'/reset').read()
        c=nav.new_context(); pg=c.new_page(); t0=time.time(); pg.goto(API+url)
        vu=pg.inner_text('body')[:60].replace('\n',' | '); print(f'AVANT — {nom} pendant le sommeil : après {time.time()-t0:.2f}s le visiteur voit « {vu} »')
        c.close()
    nav.close()
