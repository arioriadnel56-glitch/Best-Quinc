import sys, time, shutil; sys.path.insert(0,'/tmp/e2e')
from lib import *
from playwright.sync_api import sync_playwright
SLUG='quincaillerie-zinsou'; URL=f'{FRONT}/app/{SLUG}/'
nb=lambda: int(sql('select count(*) from ventes'))
def past(page): return page.locator('#pastille-reseau').inner_text() if page.locator('#pastille-reseau').is_visible() else ''
def connecter(page):
    page.goto(URL); page.wait_for_selector('input[type=password]')
    page.fill('input[type=email]','koffi@zinsou.test'); page.fill('input[type=password]','Zinsou-Quinca#2026'); page.click('button[type=submit]')
    page.wait_for_selector('.nav', timeout=60000)
def vendre(page, produit):
    page.click(f'text={produit}'); page.click('button:has-text("Encaisser")'); page.wait_for_selector('button:has-text("Imprimer")', timeout=15000)
    page.click('button:has-text("×")'); time.sleep(.3)
with sync_playwright() as p:
    nav=p.chromium.launch()
    # ---------- 1. Nouveau visiteur sur l'application, serveur endormi en mode « connexion laissée en attente » ----------
    mode(mode='dort', style='hang', reveilMs=6000); urllib.request.urlopen(CTRL+'/reset').read()
    c=nav.new_context(); pg=c.new_page(); t0=time.time(); pg.goto(URL); pg.wait_for_selector('input[type=password]'); print(f'1. Nouvel appareil, serveur endormi : écran de connexion en {time.time()-t0:.2f}s, requêtes serveur : {len(journal())}')
    pg.fill('input[type=email]','koffi@zinsou.test'); pg.fill('input[type=password]','Zinsou-Quinca#2026'); pg.click('button[type=submit]')
    pg.wait_for_selector('.reveil', timeout=5000); print('   écran de transition affiché :', pg.inner_text('.reveil-titre'))
    pg.wait_for_selector('.nav', timeout=60000); print(f'   connexion aboutie automatiquement après {time.time()-t0:.1f}s ; page technique de l\'hébergeur jamais affichée :', 'Waking' not in pg.content())
    c.close()
    # ---------- 2. Visiteur qui arrive PENDANT le réveil ----------
    mode(mode='dort', style='html503', reveilMs=8000); urllib.request.urlopen(CTRL+'/ping') if False else None
    try: urllib.request.urlopen(API+'/healthz', timeout=3)
    except Exception: pass
    c=nav.new_context(); pg=c.new_page(); t0=time.time(); pg.goto(FRONT+'/'); pg.wait_for_selector('#prix'); print(f'2. Visiteur arrivé pendant le réveil : vitrine en {time.time()-t0:.2f}s'); c.close()
    mode(mode='eveille'); time.sleep(9)
    # ---------- 3. Deux appareils vendent le DERNIER marteau hors connexion ----------
    ca=nav.new_context(); cb=nav.new_context(); A=ca.new_page(); B=cb.new_page()
    for pg in (A,B): connecter(pg); pg.goto(URL+'#/caisse'); pg.wait_for_selector('text=Marteau'); time.sleep(1.2)
    v0=nb(); print(f'3. Deux appareils connectés ; stock Marteau = {sql("select quantite_stock from produits where nom like chr(77)||chr(97)||chr(114)||chr(37)")}')
    ca.set_offline(True); cb.set_offline(True)
    vendre(A,'Marteau'); vendre(B,'Marteau'); print('   chacun a vendu le dernier marteau hors connexion :', past(A), '|', past(B))
    ca.set_offline(False); cb.set_offline(False)
    attendre(lambda: nb()==v0+2 and past(A)=='' and past(B)=='', 60, msg='synchro des deux appareils')
    r=sql("select quantite_stock from produits where nom like 'Marteau%'"); an=sql("select count(*) from ventes where anomalie is not null"); 
    print(f'   Résultat : {nb()-v0} ventes enregistrées (chacune une seule fois), stock Marteau = {r} (jamais négatif), ventes marquées « à vérifier » : {an}')
    print('   anomalie :', sql("select anomalie from ventes where anomalie is not null limit 1"))
    ca.close(); cb.close()
    # ---------- 4. Session expirée avec une vente en attente ----------
    c=nav.new_context(); pg=c.new_page(); connecter(pg); pg.goto(URL+'#/caisse'); pg.wait_for_selector('text=Ciment'); time.sleep(1.2)
    v0=nb(); c.set_offline(True); vendre(pg,'Ciment'); print(f'4. Vente hors connexion en attente : {past(pg)}')
    sql("update utilisateurs set mdp_modifie_le = now() + interval '2 seconds'"); time.sleep(3)  # mot de passe changé ailleurs : la session de l'appareil n'est plus valable
    c.set_offline(False)
    pg.wait_for_selector('input[type=password]', timeout=40000); print(f'   Session refusée par le serveur -> retour à la connexion ; ventes en base : {nb()-v0} (la vente attend sur l\'appareil)')
    sql("update utilisateurs set mdp_modifie_le = null")
    pg.fill('input[type=email]','koffi@zinsou.test'); pg.fill('input[type=password]','Zinsou-Quinca#2026'); pg.click('button[type=submit]'); pg.wait_for_selector('.nav', timeout=30000)
    attendre(lambda: nb()==v0+1, 40, msg='envoi après reconnexion'); print(f'   Après reconnexion : la vente en attente est envoyée ({nb()-v0} vente, une seule fois)'); c.close()
    # ---------- 5. Interruption pendant la synchronisation (3 ventes en attente, la 2e requête est coupée) ----------
    c=nav.new_context(); pg=c.new_page(); connecter(pg); pg.goto(URL+'#/caisse'); pg.wait_for_selector('text=Ciment'); time.sleep(1.2)
    v0=nb(); c.set_offline(True)
    for _ in range(3): vendre(pg,'Ciment')
    print(f'5. 3 ventes hors connexion en attente : {past(pg)}')
    etat={'n':0}
    def route(r):
        if r.request.method=='POST' and r.request.url.endswith('/api/ventes'):
            etat['n']+=1
            return r.continue_() if etat['n']==1 else (r.abort('connectionreset') if etat['n']==2 else r.continue_())
        r.continue_()
    pg.route('**/api/ventes', route); c.set_offline(False)
    attendre(lambda: nb()==v0+3 and past(pg)=='', 90, msg='reprise après interruption')
    print(f'   Interruption simulée en pleine synchronisation, reprise automatique : {nb()-v0} ventes en base (attendu 3), requêtes POST vues par le navigateur : {etat["n"]}'); c.close()
    print('Ventes en doublon (même clé) :', sql("select count(*) from (select cle from ventes where cle is not null group by cle having count(*)>1) x"))
    nav.close()
