import sys, time; sys.path.insert(0,'/tmp/e2e')
from lib import *
from playwright.sync_api import sync_playwright
SLUG='quincaillerie-zinsou'; URL=f'{FRONT}/app/{SLUG}/'
nb_ventes=lambda: int(sql('select count(*) from ventes'))
stock=lambda: int(sql("select quantite_stock from produits where nom like 'Ciment%'"))
def past(page): return page.locator('#pastille-reseau').inner_text() if page.locator('#pastille-reseau').is_visible() else ''
def vendre(page):
    page.click('text=Ciment'); page.click('button:has-text("Encaisser")'); page.wait_for_selector('button:has-text("Imprimer")', timeout=15000)
    page.click('button:has-text("×")'); time.sleep(.3)
def resume(j):
    h=[x for x in j if x['m']!='UPGRADE']; return f"{len(h)} requêtes HTTP ({sum(1 for x in h if x['u']=='/healthz')} sondes /healthz) + {sum(1 for x in j if x['m']=='UPGRADE')} temps réel"
with sync_playwright() as p:
    ctx=p.chromium.launch_persistent_context('/tmp/e2e/profile', headless=True)
    page=ctx.pages[0] if ctx.pages else ctx.new_page()
    erreurs=[]; page.on('pageerror', lambda e: erreurs.append(str(e)))
    v0, s0 = nb_ventes(), stock(); print(f'État initial : {v0} vente(s), stock Ciment = {s0}')
    # ---------- C. Réouverture de l'application, serveur endormi ----------
    mode(mode='dort', style='html503', reveilMs=10000); urllib.request.urlopen(CTRL+'/reset').read(); t0=time.time()
    page.goto(URL+'#/caisse'); page.wait_for_selector('text=Ciment', timeout=10000); dt=time.time()-t0
    print(f'C. Application rouverte serveur endormi : caisse et produits affichés en {dt:.2f}s ; pastille = « {past(page)} »')
    attendre(lambda: past(page)=='' , 40, msg='fin du réveil'); print(f'   Serveur réveillé et pastille effacée après {time.time()-t0:.1f}s ; {resume(journal())}')
    # ---------- D. Vente pendant que le serveur dort ----------
    mode(mode='dort', style='html503', reveilMs=8000); urllib.request.urlopen(CTRL+'/reset').read()
    page.goto(URL+'#/caisse'); page.wait_for_selector('text=Ciment'); time.sleep(1)
    t1=time.time(); vendre(page); dt=time.time()-t1
    print(f'D. Vente enregistrée serveur endormi en {dt:.2f}s ; pastille = « {past(page)} » ; ventes en base à cet instant : {nb_ventes()-v0}')
    d=attendre(lambda: nb_ventes()==v0+1 and past(page)=='', 45, msg='synchronisation après réveil')
    print(f'   Réveil puis envoi automatique : vente en base après {time.time()-t1:.1f}s (+{nb_ventes()-v0}), stock = {stock()} (attendu {s0-1}) ; {resume(journal())}')
    assert stock()==s0-1
    # ---------- E. Hors connexion complet ----------
    mode(mode='eveille'); time.sleep(1)
    ctx.set_offline(True); t2=time.time(); page.reload(); page.wait_for_selector('text=Ciment', timeout=10000)
    print(f'E. Réouverture HORS CONNEXION en {time.time()-t2:.2f}s ; pastille = « {past(page)} »')
    vendre(page); print(f'   Vente hors connexion enregistrée ; pastille = « {past(page)} » ; en base : {nb_ventes()-v0}')
    page.reload(); page.wait_for_selector('text=Ciment'); print(f'   Après fermeture/réouverture : pastille = « {past(page)} »')
    ctx.set_offline(False); t3=time.time()
    attendre(lambda: nb_ventes()==v0+2 and past(page)=='', 45, msg='sync au retour du réseau')
    print(f'   Retour d\'internet : synchronisation automatique en {time.time()-t3:.1f}s ; ventes +{nb_ventes()-v0}, stock = {stock()} (attendu {s0-2})')
    assert stock()==s0-2
    # ---------- F. Réponse perdue (le serveur a enregistré, le téléphone n'a rien reçu) ----------
    mode(mode='eveille', coupe=1); page.goto(URL+'#/caisse'); page.wait_for_selector('text=Ciment'); time.sleep(1.5)
    vendre(page); time.sleep(1)
    attendre(lambda: past(page)=='', 60, msg='fin de synchro après réponse perdue')
    print(f'F. Réponse perdue puis renvoi : ventes +{nb_ventes()-v0} (attendu 3, pas 4), stock = {stock()} (attendu {s0-3})')
    assert nb_ventes()==v0+3 and stock()==s0-3
    # ---------- G. Repos : aucune requête spontanée ----------
    urllib.request.urlopen(CTRL+'/reset').read(); time.sleep(35)
    print(f'G. 35 s sans toucher à l\'écran, serveur éveillé : {resume(journal())}')
    print('Erreurs JavaScript :', erreurs or 'aucune')
    ctx.close()
