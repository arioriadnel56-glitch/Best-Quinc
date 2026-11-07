import sys, time, shutil; sys.path.insert(0,'/tmp/e2e')
from lib import *
from playwright.sync_api import sync_playwright
SLUG='quincaillerie-zinsou'; URL=f'{FRONT}/app/{SLUG}/'
shutil.rmtree('/tmp/e2e/profile', ignore_errors=True)
with sync_playwright() as p:
    ctx=p.chromium.launch_persistent_context('/tmp/e2e/profile', headless=True)
    page=ctx.pages[0] if ctx.pages else ctx.new_page()
    mode(mode='eveille'); urllib.request.urlopen(CTRL+'/reset').read()
    t0=time.time(); page.goto(URL); page.wait_for_selector('input[type=password]'); dt=time.time()-t0
    print(f'Connexion affichée en {dt:.2f}s ; requêtes serveur avant saisie : {len(journal())} ; titre : {page.title()}')
    page.fill('input[type=email]','koffi@zinsou.test'); page.fill('input[type=password]','Zinsou-Quinca#2026'); page.click('button[type=submit]')
    page.wait_for_selector('.nav', timeout=15000)
    jeton=page.evaluate(f"localStorage.getItem('bq:{SLUG}:token')")
    for nom,pv,pa,st in [('Ciment CPJ 42,5',6500,5000,50),('Marteau 500 g',3000,2000,1)]:
        api('POST','/api/produits',jeton,{'nom':nom,'prix_vente':pv,'prix_achat':pa,'quantite_stock':st,'seuil_alerte':2,'unite':'pièce'})
    page.goto(URL+'#/caisse'); page.wait_for_selector('text=Ciment'); time.sleep(1)
    page.evaluate("navigator.serviceWorker.ready.then(()=>1)")
    page.reload(); page.wait_for_selector('text=Ciment')
    print('SW contrôle la page :', page.evaluate('!!navigator.serviceWorker.controller'))
    print('boutons caisse :', [b.inner_text() for b in page.locator('button').all()][:25])
    page.click('text=Ciment'); time.sleep(.3); page.click('button:has-text("Encaisser")'); time.sleep(.8)
    print('après Encaisser — boutons :', [b.inner_text() for b in page.locator('dialog[open] button, .modal button, button').all()][:30])
    page.screenshot(path='/tmp/e2e/caisse.png')
    ctx.close()
