#!/usr/bin/env python3
"""Enregistre les séquences « page d'accueil → créer son espace → installer l'application (PWA) » avec la VRAIE application.

À utiliser avec un serveur propre (aucun espace « quincaillerie-dossou » existant) :
  - soit votre serveur habituel,
  - soit la démo sans base : PORT=3100 TRIAL_DAYS=14 node scripts/demo/serveur-demo-sans-base.js
Usage : python3 scripts/demo/enregistrer-creation.py      (variables : DEMO_BASE, DEMO_SORTIE)
Sortie : creation-fr.mp4 (1280x720, sans son). Voir scripts/demo/README.md pour l'assembler avec la démonstration.
"""
import json, os, re, subprocess, tempfile, time, urllib.request, shutil
from playwright.sync_api import sync_playwright

BASE = os.environ.get('DEMO_BASE', 'http://127.0.0.1:3100')
RACINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
SORTIE = os.environ.get('DEMO_SORTIE', os.path.join(RACINE, 'public', 'assets', 'video'))
NOM, NOMC, TEL = 'Quincaillerie Dossou', 'Marius Dossou', '0197 45 12 30'
MAIL, MDP = 'marius@quincaillerie-dossou.bj', 'Marteau-Ciment-48'
SLUG = 'quincaillerie-dossou'

cfg = json.load(urllib.request.urlopen(BASE + '/api/config'))
plans = {p['id']: p for p in cfg['plans']}
fmt = lambda n: f"{n:,}".replace(',', '\u202f') + ' F CFA'
T = {
  'a1': 'Voici la page d\'accueil de Best-Quinca : la caisse et le stock de votre quincaillerie',
  'a1b': f"Un seul abonnement, tout est inclus : {fmt(plans['mensuel']['prix'])} par mois ou {fmt(plans['annuel']['prix'])} par an",
  'a2': 'Encaisser vite, suivre le stock, gérer l\'équipe, commander chez vos fournisseurs',
  'b1': 'Pour créer votre espace, remplissez ce formulaire : entreprise, nom, téléphone, e-mail, mot de passe',
  'b2': f'Votre application aura sa propre adresse, tirée du nom de l\'entreprise : /app/{SLUG}',
  'b3': 'Touchez « Créer mon espace » : c\'est fait en moins de 2 minutes',
  'b4': 'Notez votre code de récupération : il n\'est affiché qu\'une fois et sert si vous oubliez votre mot de passe',
  'c1': 'Transformez votre espace en application : touchez « Installer »',
  'c2': 'Confirmez : l\'application s\'installe comme depuis un magasin d\'applications',
  'c3': 'Sur iPhone : touchez le bouton Partager, puis « Sur l\'écran d\'accueil »',
  'c4': 'L\'icône est sur votre écran d\'accueil : l\'application s\'ouvre en plein écran, même sans connexion',
}

src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'enregistrer-demo.py'), encoding='utf-8').read()
OVERLAY = re.search(r'OVERLAY = r"""(.*?)"""', src, re.S).group(1)

INSTALL = r"""
(() => {
  window.__fausseInstallation = (nom, icone, hote) => {
    const ev = new Event('beforeinstallprompt');
    ev.prompt = () => {
      const d = document.createElement('div'); d.id = 'bq-install'; d.setAttribute('popover', 'manual');
      d.style.cssText = 'position:fixed;inset:auto;top:70px;right:40px;left:auto;margin:0;width:400px;background:#fff;color:#1f1f1f;border-radius:16px;padding:22px 24px;box-shadow:0 16px 48px rgba(0,0,0,.5);font:16px/1.4 system-ui,Segoe UI,Roboto,sans-serif;border:1px solid #d9d9d9';
      const btn = 'border:0;border-radius:999px;padding:10px 22px;font:600 15px system-ui;cursor:pointer;';
      d.innerHTML = '<div style="display:flex;gap:16px;align-items:center"><img src="' + icone + '" width="60" height="60" style="border-radius:14px"><div><div style="font-weight:700;font-size:20px">Installer l\'application ?</div><div id="bq-sous" style="color:#5f6368;font-size:14px;margin-top:2px"></div></div></div>'
        + '<div style="display:flex;justify-content:flex-end;gap:12px;margin-top:22px"><button id="bq-non" style="' + btn + 'background:#fff;color:#0b57d0">Annuler</button><button id="bq-oui" style="' + btn + 'background:#0b57d0;color:#fff">Installer</button></div>';
      d.querySelector('#bq-sous').textContent = nom + ' — ' + hote;
      document.documentElement.append(d); try { d.showPopover(); } catch (e) {}
      window.__devant && window.__devant();
      d.querySelector('#bq-oui').addEventListener('click', () => { d.remove(); window.__choix({ outcome: 'accepted' }); setTimeout(() => window.dispatchEvent(new Event('appinstalled')), 700); });
      d.querySelector('#bq-non').addEventListener('click', () => { d.remove(); window.__choix({ outcome: 'dismissed' }); });
    };
    ev.userChoice = new Promise((r) => { window.__choix = r; });
    window.dispatchEvent(ev);
  };
})();
"""

def ecran_accueil(pg, nom, icone):
    couleurs = ['#5B8DEF', '#F26B5B', '#4CC38A', '#F2B705', '#9B6BF2', '#EF8A5B', '#3AA3AD', '#C65BAF', '#6BA5F2', '#8BC34A', '#FF7043', '#26A69A']
    icones = ''.join(f'<div class="i"><span style="background:linear-gradient(145deg,{c},{c}cc)"></span><i></i></div>' for c in couleurs[:7])
    pg.set_content(f"""<body style="margin:0;height:100vh;overflow:hidden;background:radial-gradient(circle at 30% 20%,#2b4a7a,#12202C 70%);font-family:system-ui,'Segoe UI',Roboto,sans-serif;color:#fff">
    <style>.g{{display:grid;grid-template-columns:repeat(4,150px);gap:36px 56px;justify-content:center;margin-top:90px}}
    .i{{display:flex;flex-direction:column;align-items:center;gap:12px}} .i span{{width:112px;height:112px;border-radius:26px;display:block;box-shadow:0 6px 18px rgba(0,0,0,.35)}}
    .i i{{display:block;width:80px;height:10px;border-radius:5px;background:rgba(255,255,255,.35)}}
    .nous{{position:relative}} .nous img{{width:112px;height:112px;border-radius:26px;box-shadow:0 8px 26px rgba(0,0,0,.5);animation:pop 1.2s ease-out both}}
    .nous:after{{content:'';position:absolute;left:50%;top:56px;width:112px;height:112px;margin:-56px 0 0 -56px;border-radius:30px;border:4px solid #F2B705;animation:onde 1.6s ease-out infinite}}
    .nous b{{font-size:17px;max-width:150px;text-align:center;line-height:1.2}}
    @keyframes pop{{from{{transform:scale(.2);opacity:0}}to{{transform:scale(1);opacity:1}}}} @keyframes onde{{from{{transform:scale(1);opacity:.9}}to{{transform:scale(1.6);opacity:0}}}}</style>
    <div style="text-align:center;font-size:30px;font-weight:600;padding-top:34px;letter-spacing:1px">9:41</div>
    <div class="g">{icones}<div class="i nous"><img src="{icone}"><b>{nom}</b></div></div></body>""")
    pg.evaluate('window.__legende && window.__legende(""); try { document.getElementById("bq-curseur").hidePopover(); } catch (e) {}')

def legende(pg, texte, num=''): pg.evaluate('([t,n]) => window.__legende(t,n)', [texte, str(num)])
def pause(pg, s): pg.wait_for_timeout(int(s * 1000))
def devant(pg): pg.evaluate('window.__devant && window.__devant()')
def vers(pg, loc, apres=0.35):
    loc.first.scroll_into_view_if_needed(); b = loc.first.bounding_box()
    pg.mouse.move(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2, steps=24); pause(pg, apres)
def clic(pg, loc, apres=0.6):
    vers(pg, loc); pg.mouse.down(); pause(pg, .09); pg.mouse.up(); pause(pg, apres)
def ecrire(pg, loc, texte):
    clic(pg, loc, .2); pg.keyboard.type(texte, delay=48); pause(pg, .3)
def defiler(pg, dy, pas=36):
    n = abs(dy) // pas
    for _ in range(int(n)):
        pg.mouse.wheel(0, pas if dy > 0 else -pas); pg.wait_for_timeout(28)

tmp = tempfile.mkdtemp()
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 720}, record_video_dir=tmp, record_video_size={'width': 1280, 'height': 720},
                        service_workers='block', locale='fr-FR')
    ctx.add_init_script(OVERLAY); ctx.add_init_script(INSTALL)
    pg = ctx.new_page(); t0 = time.time()
    marque = lambda n: print(f'{time.time() - t0:6.1f}s  {n}', flush=True)

    # A — page d'accueil
    pg.goto(BASE + '/'); pg.wait_for_selector('#prix'); pause(pg, 1.0); devant(pg)
    marque('A1'); legende(pg, T['a1'], 'A'); pause(pg, 4.2)
    marque('A1b'); vers(pg, pg.locator('#prix'), .4); legende(pg, T['a1b'], 'A'); pause(pg, 6.0)
    marque('A2'); legende(pg, T['a2'], 'A')
    pg.evaluate("document.querySelector('.atouts').scrollIntoView({block:'center'})"); pause(pg, 1.2)
    pg.mouse.move(640, 300, steps=20); pause(pg, 5.2)

    # B — créer son espace
    marque('B1'); legende(pg, T['b1'], 'B')
    pg.evaluate('window.scrollTo(0,0)'); pause(pg, 1.0)
    clic(pg, pg.locator('a.btn.jaune', has_text='Créer mon espace'), 1.6)
    f = pg.locator('#form-inscription')
    pg.evaluate("document.querySelector('#form-inscription').scrollIntoView({block:'start'}); window.scrollBy(0,-24)"); pause(pg, .8)
    ecrire(pg, f.locator('input[name=nom_entreprise]'), NOM)
    ecrire(pg, f.locator('input[name=nom_complet]'), NOMC)
    ecrire(pg, f.locator('input[name=telephone]'), TEL)
    ecrire(pg, f.locator('input[name=email]'), MAIL)
    ecrire(pg, f.locator('input[name=mot_de_passe]'), MDP)
    marque('B2'); legende(pg, T['b2'], 'B'); pause(pg, 5.8)
    marque('B3'); legende(pg, T['b3'], 'B')
    clic(pg, f.locator('button[type=submit]'), 1.2)
    pg.wait_for_selector('h1:has-text("Bienvenue")'); pause(pg, 1.0); devant(pg)
    marque('B4'); legende(pg, T['b4'], 'B'); pause(pg, 5.4)
    clic(pg, pg.get_by_role('button', name="J'ai noté mon code"), 1.0)

    # C — l'espace devient une application (PWA)
    icone = pg.evaluate(f"fetch('/app/{SLUG}/icon-192.png').then(r=>r.blob()).then(b=>new Promise(res=>{{const f=new FileReader();f.onload=()=>res(f.result);f.readAsDataURL(b)}}))")
    pg.evaluate('([n,i,h]) => window.__fausseInstallation(n,i,h)', [NOM, icone, 'quincaillerie-dossou.bj']); pause(pg, .6)
    marque('C1'); legende(pg, T['c1'], 'C'); pause(pg, 2.2)
    clic(pg, pg.locator('.carte [data-installer]'), 1.2)
    marque('C2'); legende(pg, T['c2'], 'C'); devant(pg); pause(pg, 2.2)
    clic(pg, pg.locator('#bq-oui'), 1.4)
    devant(pg); pause(pg, 2.4)
    marque('C3'); legende(pg, T['c3'], 'C')
    pg.evaluate("Object.defineProperty(navigator,'userAgent',{get:()=>'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',configurable:true}); location.hash='#/produits'")
    pause(pg, 1.0); pg.evaluate("location.hash='#/bienvenue'"); pause(pg, 1.4); devant(pg)
    vers(pg, pg.locator('p.aide', has_text='Partager'), .5); pause(pg, 4.6)
    marque('C4'); ecran_accueil(pg, NOM, icone); legende(pg, T['c4'], 'C'); pause(pg, 7.6)
    legende(pg, '')
    marque('fin')
    video = pg.video; ctx.close(); b.close()
    brut = video.path()

os.makedirs(SORTIE, exist_ok=True)
sortie = os.path.join(SORTIE, 'creation-fr.mp4')
subprocess.run(['ffmpeg', '-y', '-i', brut, '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-r', '25', '-vf', 'scale=1280:720', '-an', '-movflags', '+faststart', sortie],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
shutil.rmtree(tmp, ignore_errors=True)
print(os.path.basename(sortie), round(os.path.getsize(sortie) / 1e6, 2), 'Mo')
