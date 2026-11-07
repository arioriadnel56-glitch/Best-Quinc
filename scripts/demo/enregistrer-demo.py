#!/usr/bin/env python3
"""Enregistre la vidéo de démonstration de Best-Quinca (page d'accueil) en pilotant la VRAIE application.

Prérequis : serveur lancé avec des données de démonstration (scripts/demo/seed.js), Python 3, `pip install playwright`,
`playwright install chromium`, ffmpeg. Usage : python3 scripts/demo/enregistrer-demo.py
Variables : DEMO_BASE (http://localhost:3100), DEMO_SLUG, DEMO_EMAIL, DEMO_PASSWORD, DEMO_LANG (fr)
Sortie : public/assets/video/demo-<langue>.mp4 et -poster.jpg (.webm si DEMO_WEBM=1)
"""
import json, os, re, shutil, subprocess, tempfile, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('DEMO_BASE', 'http://localhost:3100')
SLUG = os.environ.get('DEMO_SLUG', 'quincaillerie-zinsou')
EMAIL = os.environ.get('DEMO_EMAIL', 'koffi@quincaillerie-zinsou.bj')
MDP = os.environ.get('DEMO_PASSWORD', 'Demo2026pass')
LANGUE = os.environ.get('DEMO_LANG', 'fr')
RACINE = os.path.join(os.path.dirname(__file__), '..', '..')
SORTIE = os.path.join(RACINE, 'public', 'assets', 'video')
APP = f'/app/{SLUG}/'

cfg = json.load(urllib.request.urlopen(BASE + '/api/config'))
plans = {p['id']: p for p in cfg['plans']}
fmt = lambda n: f"{n:,}".replace(',', '\u202f') + ' F CFA'

# Légendes affichées à l'écran (une seule langue par enregistrement)
T = {
  'fr': {
    'titre': 'La caisse et le stock de votre quincaillerie', 'note': 'Démonstration en 2 minutes',
    'c1': 'Connectez-vous : votre tableau de bord résume la journée',
    'c1b': 'Ventes du jour, crédits à encaisser, stock à renouveler : tout d\'un coup d\'œil',
    'c2': 'À la caisse, touchez les produits : le ticket se calcule tout seul',
    'c2b': 'Encaissez : la facture est prête, envoyez-la au client sur WhatsApp',
    'c3': 'Un client ne peut pas tout payer ? Vendez à crédit avec un acompte',
    'c3b': 'La facture indique le reste à payer',
    'c3c': 'Suivez ce que chaque client vous doit et relancez-le en un geste',
    'c4': 'Votre stock sous contrôle : des alertes avant la rupture',
    'c5': 'Inventaire avec votre secrétaire : elle compte à l\'aveugle, vous validez les écarts',
    'c6': 'Chaque membre de l\'équipe a ses droits : la secrétaire ne voit jamais vos prix d\'achat',
    'c7': f"Un abonnement simple : {fmt(plans['mensuel']['prix'])} par mois ou {fmt(plans['annuel']['prix'])} par an",
    'fin': 'Créez votre espace en 2 minutes', 'fin2': 'Sur téléphone ou ordinateur, même sans connexion',
    'etape': 'Étape',
  },
}[LANGUE]

OVERLAY = r"""
(() => {
  const css = `
  #bq-curseur,#bq-legende{position:fixed!important;margin:0;border:0;padding:0;inset:auto;overflow:visible;background:transparent}
  #bq-curseur{left:0;top:0;width:34px;height:34px;pointer-events:none;transform:translate(-6px,-4px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
  #bq-curseur svg{width:34px;height:34px}
  .bq-onde{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:3px solid #F2B705;background:rgba(242,183,5,.35);pointer-events:none;animation:bq-onde .55s ease-out forwards}
  @keyframes bq-onde{to{transform:scale(3.4);opacity:0}}
  #bq-legende:not(:popover-open){display:none!important}
  #bq-legende{left:50%!important;bottom:26px!important;transform:translateX(-50%);max-width:84vw;background:rgba(18,32,44,.94);color:#fff;font:600 27px/1.35 system-ui,'Segoe UI',Roboto,sans-serif;padding:14px 26px 14px 22px;border-left:9px solid #F2B705;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.4);display:flex;gap:16px;align-items:center}
  #bq-legende b{background:#F2B705;color:#12202C;border-radius:999px;min-width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;font-size:22px;flex:none}
  `;
  function init() {
    if (!document.documentElement || document.getElementById('bq-curseur')) return;
    const st = document.createElement('style'); st.textContent = css; document.documentElement.append(st);
    const c = document.createElement('div'); c.id = 'bq-curseur'; c.setAttribute('popover', 'manual');
    c.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 2l7.4 19 2.6-7.8L21 10.6z" fill="#fff" stroke="#12202C" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const l = document.createElement('div'); l.id = 'bq-legende'; l.setAttribute('popover', 'manual');
    document.documentElement.append(c, l);
    let p = {x: 640, y: 420}; try { p = JSON.parse(sessionStorage.getItem('bq-pos')) || p; } catch (e) {}
    c.style.left = p.x + 'px'; c.style.top = p.y + 'px'; try { c.showPopover(); } catch (e) {}
  }
  init(); document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('mousemove', (e) => { init(); const c = document.getElementById('bq-curseur'); c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; try { sessionStorage.setItem('bq-pos', JSON.stringify({x: e.clientX, y: e.clientY})); } catch (x) {} }, true);
  document.addEventListener('mousedown', (e) => { const o = document.createElement('div'); o.className = 'bq-onde'; o.style.left = e.clientX + 'px'; o.style.top = e.clientY + 'px'; document.documentElement.append(o); setTimeout(() => o.remove(), 700); }, true);
  // Les fenêtres (dialog) passent au premier plan de la page : on remet curseur et légende devant à chaque changement
  window.__legende = (texte, num) => {
    init(); const l = document.getElementById('bq-legende'), c = document.getElementById('bq-curseur');
    try { l.hidePopover(); } catch (e) {} if (!texte) return;
    l.innerHTML = (num ? '<b>' + num + '</b>' : '') + '<span></span>'; l.querySelector('span').textContent = texte;
    try { l.showPopover(); c.hidePopover(); c.showPopover(); } catch (e) {}
  };
  window.__devant = () => { const c = document.getElementById('bq-curseur'), l = document.getElementById('bq-legende'); try { if (l.textContent) { l.hidePopover(); l.showPopover(); } c.hidePopover(); c.showPopover(); } catch (e) {} };
})();
"""

def carte(pg, titre, sous, note=''):
    logo = os.path.join(RACINE, 'public', 'assets', 'marque', 'best-quinca-clair.png')
    import base64
    b64 = base64.b64encode(open(logo, 'rb').read()).decode()
    pg.set_content(f"""<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#12202C;color:#fff;font-family:system-ui,'Segoe UI',Roboto,sans-serif;text-align:center">
    <img src="data:image/png;base64,{b64}" style="height:230px"><div style="font-size:46px;font-weight:700;max-width:900px;line-height:1.2">{sous}</div>
    <div style="font-size:28px;color:#F2B705;font-weight:600">{note}</div></body>""")
    pg.evaluate('window.__legende(""); try { document.getElementById("bq-curseur").hidePopover(); } catch (e) {}')

def legende(pg, texte, num=''): pg.evaluate('([t,n]) => window.__legende(t,n)', [texte, str(num)])
def pause(pg, s): pg.wait_for_timeout(int(s * 1000))
def vers(pg, loc, apres=0.35):
    loc.first.scroll_into_view_if_needed(); b = loc.first.bounding_box()
    pg.mouse.move(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2, steps=24); pause(pg, apres)
def clic(pg, loc, apres=0.6):
    vers(pg, loc); pg.mouse.down(); pause(pg, .09); pg.mouse.up(); pause(pg, apres)
def aller(pg, hash_, attente=1.6):
    pg.goto(BASE + APP + hash_); pause(pg, attente); pg.evaluate('window.__devant && window.__devant()')
def ecrire(pg, loc, texte):
    loc.first.fill('')  # le champ peut déjà contenir la saisie d'une vente précédente
    clic(pg, loc, .2); pg.keyboard.type(texte, delay=75); pause(pg, .3)

tmp = tempfile.mkdtemp()
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 720}, record_video_dir=tmp, record_video_size={'width': 1280, 'height': 720},
                        service_workers='block', locale='fr-FR' if LANGUE == 'fr' else 'en-US')
    ctx.add_init_script(OVERLAY)
    pg = ctx.new_page()
    carte(pg, '', T['titre'], T['note']); pause(pg, 4.5)

    # 1 — connexion et tableau de bord
    pg.goto(BASE + APP); pg.wait_for_selector('input[type=email]'); pause(pg, .8)
    legende(pg, T['c1'], 1)
    ecrire(pg, pg.locator('input[type=email]'), EMAIL)
    ecrire(pg, pg.locator('input[type=password]'), MDP)
    clic(pg, pg.locator('button[type=submit]'), 2.2)
    pg.wait_for_selector('#nav'); pg.evaluate('window.__devant()'); pause(pg, 1.2)
    legende(pg, T['c1b'], 1); pause(pg, 4.5)

    # 2 — caisse et facture
    clic(pg, pg.locator('#nav a', has_text='Caisse'), 1.6)
    legende(pg, T['c2'], 2)
    for nom in ['Ciment CPJ 42,5', 'Fer à béton 8 mm', 'Clous 70 mm']:
        clic(pg, pg.locator('button.prod', has_text=nom), .9)
    pause(pg, 1.2)
    ecrire(pg, pg.locator('.ticket input').first, 'Séraphin Agbodjan')
    legende(pg, T['c2b'], 2)
    clic(pg, pg.get_by_role('button', name=re.compile('Encaisser')), 3.4)
    pg.evaluate('window.__devant()'); pause(pg, 2.6)
    pg.keyboard.press('Escape'); pause(pg, .8)

    # 3 — vente à crédit
    legende(pg, T['c3'], 3); pause(pg, 1.2)
    for nom in ['Brouette 80 L', 'Colle PVC 250 ml']:
        clic(pg, pg.locator('button.prod', has_text=nom), .8)
    pg.locator('.ticket select').select_option('credit'); pause(pg, 1.0)
    ins = pg.locator('.ticket input')
    ecrire(pg, ins.nth(0), 'Mme Adjakpa'); ecrire(pg, ins.nth(1), '0195778899')
    ecrire(pg, pg.locator('.zone-credit input[type=number]'), '10000')
    clic(pg, pg.get_by_role('button', name=re.compile('Encaisser')), 3.2)
    pg.evaluate('window.__devant()'); legende(pg, T['c3b'], 3); pause(pg, 3.0)
    pg.keyboard.press('Escape'); pause(pg, .6)
    clic(pg, pg.locator('#nav a', has_text='Crédits'), 2.0)
    legende(pg, T['c3c'], 3); pause(pg, 3.6)

    # 4 — stock
    clic(pg, pg.locator('#nav a', has_text='Tableau de bord'), 1.8)
    legende(pg, T['c4'], 4)
    pg.mouse.wheel(0, 520); pause(pg, 2.4); pg.mouse.wheel(0, 520); pause(pg, 3.0)
    pg.mouse.wheel(0, -1200); pause(pg, .6)

    # 5 — inventaire
    clic(pg, pg.locator('#nav a', has_text='Inventaire'), 2.0)
    legende(pg, T['c5'], 5); pause(pg, 1.2)
    clic(pg, pg.locator('tr.cliquable').first, 2.0); pg.evaluate('window.__devant()'); pause(pg, 4.0)
    pg.keyboard.press('Escape'); pause(pg, .6)

    # 6 — équipe
    clic(pg, pg.locator('#nav a', has_text='Équipe'), 2.0)
    legende(pg, T['c6'], 6); pause(pg, 4.6)

    # 7 — abonnement
    clic(pg, pg.locator('#nav a', has_text='Abonnement'), 2.0)
    legende(pg, T['c7'], 7); pause(pg, 1.0)
    clic(pg, pg.locator('.plan-carte[data-plan=annuel]'), 3.4)

    legende(pg, '')
    carte(pg, '', T['fin'], T['fin2']); pause(pg, 5.0)
    video = pg.video; ctx.close(); b.close()
    brut = video.path()

os.makedirs(SORTIE, exist_ok=True)
base = os.path.join(SORTIE, f'demo-{LANGUE}')
run = lambda *a: subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
run('ffmpeg', '-y', '-i', brut, '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-r', '25', '-vf', 'scale=1280:720', '-an', '-movflags', '+faststart', base + '.mp4')
if os.environ.get('DEMO_WEBM') == '1':  # facultatif (encodage lent) : le MP4 H.264 se lit partout
    run('ffmpeg', '-y', '-i', brut, '-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-r', '25', '-vf', 'scale=1280:720', '-an', base + '.webm')
run('ffmpeg', '-y', '-ss', '22', '-i', base + '.mp4', '-frames:v', '1', '-q:v', '4', base + '-poster.jpg')

def bouton_lecture(chemin):
    """Ajoute un grand bouton « lecture » à l'affiche pour qu'on comprenne tout de suite que c'est une vidéo."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return
    im = Image.open(chemin).convert('RGBA')
    voile = Image.new('RGBA', im.size, (18, 32, 44, 70)); im = Image.alpha_composite(im, voile)
    d = ImageDraw.Draw(im); cx, cy, r = im.width // 2, im.height // 2, 66
    d.ellipse([cx - r - 5, cy - r - 5, cx + r + 5, cy + r + 5], fill=(255, 255, 255, 235))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(242, 183, 5, 255))
    d.polygon([(cx - 22, cy - 38), (cx - 22, cy + 38), (cx + 42, cy)], fill=(18, 32, 44, 255))
    im.convert('RGB').save(chemin, quality=84, optimize=True)

bouton_lecture(base + '-poster.jpg')
shutil.rmtree(tmp, ignore_errors=True)
for e in ('.mp4', '-poster.jpg'): print(os.path.basename(base) + e, round(os.path.getsize(base + e) / 1e6, 2), 'Mo')
