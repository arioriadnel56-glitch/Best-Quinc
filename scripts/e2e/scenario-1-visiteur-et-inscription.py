import sys, time; sys.path.insert(0,'/tmp/e2e')
from lib import *
from playwright.sync_api import sync_playwright
res={}
with sync_playwright() as p:
    nav=p.chromium.launch()
    # ---------- A. Nouveau visiteur, serveur ENDORMI ----------
    mode(mode='dort', style='html503', reveilMs=6000); urllib.request.urlopen(CTRL+'/reset').read()
    t0=time.time(); ctx=nav.new_context(); page=ctx.new_page()
    erreurs=[]; page.on('console', lambda m: erreurs.append(m.text) if m.type=='error' else None)
    navs=[]; page.on('framenavigated', lambda f: navs.append(f.url))
    page.goto(FRONT+'/', wait_until='load'); dt=time.time()-t0
    titre=page.title(); prix=page.inner_text('#prix')
    time.sleep(2)
    j=journal()
    print(f'A. Vitrine affichée en {dt:.2f}s serveur endormi — titre « {titre} », prix « {prix} » — requêtes reçues par le serveur : {len(j)} — navigations : {navs}')
    print('   erreurs console :', [e for e in erreurs if 'favicon' not in e] or 'aucune')
    assert len(j)==0 and 'Render' not in page.content() and 'Waking' not in page.content()
    # ---------- B. Inscription pendant le sommeil : écran de transition puis reprise automatique ----------
    page.fill('input[name=nom_entreprise]','Quincaillerie Zinsou'); page.fill('input[name=nom_complet]','Koffi Zinsou')
    page.fill('input[name=email]','koffi@zinsou.test'); page.fill('input[name=mot_de_passe]','Zinsou-Quinca#2026')
    t1=time.time(); page.click('#form-inscription button[type=submit]')
    page.wait_for_selector('.reveil', timeout=5000); t_ecran=time.time()-t1
    txt=page.inner_text('.reveil'); print(f'B. Écran de transition affiché après {t_ecran:.2f}s : « {txt.replace(chr(10)," | ")} »')
    page.screenshot(path='/tmp/e2e/b-reveil.png')
    page.wait_for_url('**/app/**', timeout=30000); t_total=time.time()-t1
    print(f'   Réveil simulé 6 s -> reprise automatique et ouverture de l\'espace après {t_total:.1f}s, URL = {page.url}')
    jb=journal(); print('   requêtes reçues pendant l\'opération :', [(x["m"],x["u"],x["mode"]) for x in jb][:14])
    assert 'Waking' not in page.content()
    slug=page.url.split('/app/')[1].split('/')[0]
    page.wait_for_selector('.nav', timeout=15000); print('   Espace ouvert, menu visible. slug =', slug)
    jeton=page.evaluate(f"localStorage.getItem('bq:{slug}:token')"); open('/tmp/e2e/state.txt','w').write(slug+'\n'+jeton)
    # service worker prêt ?
    page.evaluate("navigator.serviceWorker.ready.then(()=>1)"); time.sleep(1)
    print('   Service worker actif :', page.evaluate("!!navigator.serviceWorker.controller || 'ready'"))
    ctx.storage_state(path='/tmp/e2e/ctx.json')
    nav.close()
