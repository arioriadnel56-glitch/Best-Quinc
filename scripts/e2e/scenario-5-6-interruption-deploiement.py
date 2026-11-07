import sys, time, subprocess; sys.path.insert(0,'/tmp/e2e')
from lib import *
exec(open('/tmp/e2e/scen4.py').read().split('with sync_playwright() as p:')[0])
def attendre_page(pg, cond, delai=60, msg=''):
    t=time.time()
    while time.time()-t<delai:
        if cond(): return
        pg.wait_for_timeout(250)
    raise AssertionError('délai dépassé : '+msg)
with sync_playwright() as p:
    nav=p.chromium.launch(); mode(mode='eveille')
    # ---------- 5. Interruption pendant la synchronisation ----------
    c=nav.new_context(); pg=c.new_page(); connecter(pg); pg.goto(URL+'#/caisse'); pg.wait_for_selector('text=Ciment'); pg.wait_for_timeout(1200)
    v0=nb(); c.set_offline(True)
    for _ in range(3): vendre(pg,'Ciment')
    print(f'5. 3 ventes hors connexion en attente : {past(pg)}')
    etat={'n':0}
    def route(r):
        if r.request.method=='POST':
            etat['n']+=1
            return r.abort('connectionreset') if etat['n']==2 else r.continue_()
        r.continue_()
    pg.route('**/api/ventes', route); t0=time.time(); c.set_offline(False)
    attendre_page(pg, lambda: nb()==v0+3 and past(pg)=='', 60, 'reprise après interruption')
    print(f'   Coupure en pleine synchronisation (2e envoi coupé) : reprise automatique en {time.time()-t0:.1f}s, {nb()-v0} ventes en base (attendu 3), envois vus par le navigateur : {etat["n"]}')
    print('   Ventes en doublon (même clé) :', sql("select count(*) from (select cle from ventes where cle is not null group by cle having count(*)>1) x"))
    c.close()
    # ---------- 6. Déploiement d'une nouvelle version avec une vente en attente ----------
    c=nav.new_context(); pg=c.new_page(); connecter(pg); pg.goto(URL+'#/caisse'); pg.wait_for_selector('text=Ciment'); pg.wait_for_timeout(1500)
    caches=lambda: pg.evaluate("caches.keys().then(k=>k.join(','))")
    v_avant=caches(); v0=nb(); c.set_offline(True); vendre(pg,'Ciment'); print(f'6. Avant déploiement : cache = {v_avant} ; {past(pg)}')
    # nouvelle version : un fichier de l'interface change, le frontend est reconstruit et redéployé
    open('/tmp/repo2/public/assets/style.css','a').write('\n/* v2 */\n')
    subprocess.run(['node','scripts/build-frontend.js'],cwd='/tmp/repo2',env={**__import__('os').environ,'API_URL':'http://127.0.0.1:3101','SORTIE':'/tmp/dist-e2e'},capture_output=True)
    c.set_offline(False); pg.wait_for_timeout(200)
    attendre_page(pg, lambda: nb()==v0+1 and past(pg)=='', 60, 'envoi après déploiement')
    pg.reload(); pg.wait_for_selector('text=Ciment'); pg.wait_for_timeout(2500); pg.reload(); pg.wait_for_selector('text=Ciment'); pg.wait_for_timeout(1500)
    v_apres=caches(); print(f'   Après déploiement : cache = {v_apres} ; la vente en attente a été envoyée une seule fois ({nb()-v0}) ; style v2 chargé : ', pg.evaluate("fetch('/assets/style.css').then(r=>r.text()).then(t=>t.includes('v2'))"))
    assert v_avant!=v_apres and ',' not in v_apres
    print('   Erreurs JS : aucune'); c.close(); nav.close()
