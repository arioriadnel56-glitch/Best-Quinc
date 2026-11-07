-- Best-Quinca — schéma PostgreSQL (idempotent : peut être rejoué sans risque)

CREATE TABLE IF NOT EXISTS entreprises (
  id          SERIAL PRIMARY KEY,
  nom         VARCHAR(150) NOT NULL,
  slug        VARCHAR(60)  NOT NULL UNIQUE,
  adresse     VARCHAR(255),
  telephone   VARCHAR(30),
  email       VARCHAR(150),
  statut      VARCHAR(20)  NOT NULL DEFAULT 'actif',
  cree_le     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Paramètres de la PWA propre à chaque entreprise (nom installé, couleur)
CREATE TABLE IF NOT EXISTS pwa_configs (
  entreprise_id INT PRIMARY KEY REFERENCES entreprises(id) ON DELETE CASCADE,
  nom_app       VARCHAR(100) NOT NULL,
  couleur       VARCHAR(7)   NOT NULL DEFAULT '#3E5C76',
  modifie_le    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS utilisateurs (
  id                SERIAL PRIMARY KEY,
  entreprise_id     INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  nom_complet       VARCHAR(150) NOT NULL,
  email             VARCHAR(150) NOT NULL,
  mot_de_passe_hash VARCHAR(255) NOT NULL,
  role              VARCHAR(20)  NOT NULL CHECK (role IN ('proprietaire', 'secretaire')),
  actif             BOOLEAN      NOT NULL DEFAULT true,
  cree_le           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, email)
);

-- Abonnement unique : une ligne par période payée (ou d'essai)
CREATE TABLE IF NOT EXISTS abonnements (
  id            SERIAL PRIMARY KEY,
  entreprise_id INT  NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  montant       INT  NOT NULL DEFAULT 0,
  statut        VARCHAR(20) NOT NULL DEFAULT 'actif',
  date_debut    DATE NOT NULL,
  date_fin      DATE NOT NULL,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS abonnements_entreprise_idx ON abonnements (entreprise_id, date_fin);

CREATE TABLE IF NOT EXISTS paiements (
  id                    SERIAL PRIMARY KEY,
  entreprise_id         INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  abonnement_id         INT REFERENCES abonnements(id) ON DELETE SET NULL,
  agregateur            VARCHAR(20) NOT NULL,
  reference_transaction VARCHAR(120),
  montant               INT NOT NULL,
  statut                VARCHAR(20) NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'reussi', 'echoue')),
  cree_le               TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirme_le           TIMESTAMPTZ
);
-- Une transaction d'agrégateur ne peut servir qu'une seule fois
CREATE UNIQUE INDEX IF NOT EXISTS paiements_reference_uniq
  ON paiements (agregateur, reference_transaction) WHERE reference_transaction IS NOT NULL;

CREATE TABLE IF NOT EXISTS categories (
  id            SERIAL PRIMARY KEY,
  entreprise_id INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  nom           VARCHAR(100) NOT NULL,
  UNIQUE (entreprise_id, nom)
);

CREATE TABLE IF NOT EXISTS produits (
  id             SERIAL PRIMARY KEY,
  entreprise_id  INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  categorie_id   INT REFERENCES categories(id) ON DELETE SET NULL,
  nom            VARCHAR(150) NOT NULL,
  reference      VARCHAR(50),
  prix_achat     INT NOT NULL DEFAULT 0 CHECK (prix_achat >= 0),
  prix_vente     INT NOT NULL CHECK (prix_vente >= 0),
  quantite_stock INT NOT NULL DEFAULT 0 CHECK (quantite_stock >= 0),
  seuil_alerte   INT NOT NULL DEFAULT 5 CHECK (seuil_alerte >= 0),
  unite          VARCHAR(20) NOT NULL DEFAULT 'pièce',
  actif          BOOLEAN NOT NULL DEFAULT true,
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS produits_reference_uniq ON produits (entreprise_id, reference) WHERE reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS produits_entreprise_idx ON produits (entreprise_id, actif);

-- quantite = variation signée (+ entrée, - sortie)
CREATE TABLE IF NOT EXISTS mouvements_stock (
  id             SERIAL PRIMARY KEY,
  entreprise_id  INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  produit_id     INT NOT NULL REFERENCES produits(id) ON DELETE CASCADE,
  type           VARCHAR(20) NOT NULL CHECK (type IN ('entree', 'sortie', 'ajustement', 'vente')),
  quantite       INT NOT NULL,
  motif          VARCHAR(255),
  utilisateur_id INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mouvements_entreprise_idx ON mouvements_stock (entreprise_id, cree_le DESC);

CREATE TABLE IF NOT EXISTS ventes (
  id               SERIAL PRIMARY KEY,
  entreprise_id    INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  numero           INT NOT NULL,
  utilisateur_id   INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  client_nom       VARCHAR(150),
  client_telephone VARCHAR(30),
  total            INT NOT NULL CHECK (total >= 0),
  mode_paiement    VARCHAR(20) NOT NULL DEFAULT 'especes' CHECK (mode_paiement IN ('especes', 'mobile_money', 'autre')),
  cree_le          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, numero)
);
CREATE INDEX IF NOT EXISTS ventes_entreprise_idx ON ventes (entreprise_id, cree_le DESC);

CREATE TABLE IF NOT EXISTS lignes_vente (
  id            SERIAL PRIMARY KEY,
  vente_id      INT NOT NULL REFERENCES ventes(id) ON DELETE CASCADE,
  produit_id    INT REFERENCES produits(id) ON DELETE SET NULL,
  nom_produit   VARCHAR(150) NOT NULL,
  quantite      INT NOT NULL CHECK (quantite > 0),
  prix_unitaire INT NOT NULL CHECK (prix_unitaire >= 0),
  sous_total    INT NOT NULL CHECK (sous_total >= 0)
);
CREATE INDEX IF NOT EXISTS lignes_vente_vente_idx ON lignes_vente (vente_id);

-- ---------------------------------------------------------------
-- Espace super admin
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins_plateforme (
  id                SERIAL PRIMARY KEY,
  nom_complet       VARCHAR(150) NOT NULL,
  email             VARCHAR(150) NOT NULL UNIQUE,
  mot_de_passe_hash VARCHAR(255) NOT NULL,
  actif             BOOLEAN NOT NULL DEFAULT true,
  cree_le           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Paramètres de la plateforme (clés API chiffrées, prix de l'abonnement...)
CREATE TABLE IF NOT EXISTS plateforme_parametres (
  cle        VARCHAR(60) PRIMARY KEY,
  valeur     TEXT NOT NULL,
  modifie_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Récupération de mot de passe
-- ---------------------------------------------------------------
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS code_recuperation_hash VARCHAR(100);
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS mdp_modifie_le TIMESTAMPTZ;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS mdp_temporaire BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------
-- Profil de l'entreprise, logo et factures partageables
-- ---------------------------------------------------------------
ALTER TABLE entreprises ADD COLUMN IF NOT EXISTS ville VARCHAR(100);
ALTER TABLE entreprises ADD COLUMN IF NOT EXISTS ifu VARCHAR(30);
ALTER TABLE entreprises ADD COLUMN IF NOT EXISTS rccm VARCHAR(40);
ALTER TABLE entreprises ADD COLUMN IF NOT EXISTS site_web VARCHAR(120);
ALTER TABLE entreprises ADD COLUMN IF NOT EXISTS pied_facture VARCHAR(300);
ALTER TABLE entreprises ADD COLUMN IF NOT EXISTS pays_indicatif VARCHAR(4) NOT NULL DEFAULT '229';

-- Logo (affichage) et icône carrée de l'application installée
CREATE TABLE IF NOT EXISTS entreprise_images (
  entreprise_id INT PRIMARY KEY REFERENCES entreprises(id) ON DELETE CASCADE,
  logo          BYTEA NOT NULL,
  logo_type     VARCHAR(20) NOT NULL,
  icone         BYTEA NOT NULL,
  modifie_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Image de la facture d'une vente, consultable par le client via un lien secret
CREATE TABLE IF NOT EXISTS factures_images (
  vente_id      INT PRIMARY KEY REFERENCES ventes(id) ON DELETE CASCADE,
  entreprise_id INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  jeton         VARCHAR(30) NOT NULL UNIQUE,
  image         BYTEA NOT NULL,
  image_type    VARCHAR(20) NOT NULL,
  apercu        BYTEA NOT NULL,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modifie_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Ventes enregistrées hors connexion puis synchronisées
-- ---------------------------------------------------------------
ALTER TABLE ventes ADD COLUMN IF NOT EXISTS cle VARCHAR(64);
ALTER TABLE ventes ADD COLUMN IF NOT EXISTS hors_ligne BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ventes ADD COLUMN IF NOT EXISTS anomalie VARCHAR(500);
ALTER TABLE ventes ADD COLUMN IF NOT EXISTS anomalie_verifiee BOOLEAN NOT NULL DEFAULT false;
-- Une même vente envoyée deux fois (coupure réseau au mauvais moment) n'est enregistrée qu'une fois
CREATE UNIQUE INDEX IF NOT EXISTS ventes_cle_uniq ON ventes (entreprise_id, cle) WHERE cle IS NOT NULL;

-- ---------------------------------------------------------------
-- Limitation de débit partagée entre instances (serverless)
-- La clé est un hachage : ni e-mail ni adresse IP en clair.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS limites_requetes (
  cle       VARCHAR(64) PRIMARY KEY,
  compteur  INT NOT NULL,
  expire_le TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS limites_requetes_expire_idx ON limites_requetes (expire_le);

-- ---------------------------------------------------------------
-- Partenaires / sponsors (marques et distributeurs)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sponsors (
  id                 SERIAL PRIMARY KEY,
  nom                VARCHAR(120) NOT NULL,
  description        VARCHAR(500),
  site_web           VARCHAR(150),
  telephone_commande VARCHAR(20),               -- WhatsApp du distributeur, format international sans « + »
  statut             VARCHAR(20) NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'suspendu')),
  debut              DATE,                      -- période du contrat ; vide = sans limite
  fin                DATE,
  jeton_rapport      VARCHAR(64) NOT NULL UNIQUE, -- adresse secrète du rapport de statistiques
  cree_le            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sponsor_images (
  sponsor_id INT PRIMARY KEY REFERENCES sponsors(id) ON DELETE CASCADE,
  logo       BYTEA NOT NULL,
  logo_type  VARCHAR(20) NOT NULL,
  modifie_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sponsor_offres (
  id         SERIAL PRIMARY KEY,
  sponsor_id INT NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  titre      VARCHAR(120) NOT NULL,
  texte      VARCHAR(300),
  debut      DATE NOT NULL DEFAULT CURRENT_DATE,
  fin        DATE,
  actif      BOOLEAN NOT NULL DEFAULT true,
  cree_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsor_offres_sponsor_idx ON sponsor_offres (sponsor_id);
-- Une ligne par boutique, offre, type (vue ou clic) et jour : sert à compter des boutiques distinctes
CREATE TABLE IF NOT EXISTS sponsor_evenements (
  offre_id      INT NOT NULL REFERENCES sponsor_offres(id) ON DELETE CASCADE,
  entreprise_id INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  type          VARCHAR(10) NOT NULL CHECK (type IN ('vue', 'clic')),
  jour          DATE NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (offre_id, entreprise_id, type, jour)
);
CREATE TABLE IF NOT EXISTS commandes_reassort (
  id             SERIAL PRIMARY KEY,
  entreprise_id  INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  sponsor_id     INT NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  utilisateur_id INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  lignes         JSONB NOT NULL,
  note           VARCHAR(300),
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commandes_reassort_entreprise_idx ON commandes_reassort (entreprise_id, id DESC);
CREATE INDEX IF NOT EXISTS commandes_reassort_sponsor_idx ON commandes_reassort (sponsor_id, cree_le DESC);

-- Produit fourni par un partenaire (sert au réassort et aux statistiques du partenaire)
ALTER TABLE produits ADD COLUMN IF NOT EXISTS sponsor_id INT REFERENCES sponsors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS produits_sponsor_idx ON produits (sponsor_id) WHERE sponsor_id IS NOT NULL;
-- Accord de la boutique pour que ses ventes entrent, de façon anonyme et groupée, dans les statistiques des partenaires
ALTER TABLE entreprises ADD COLUMN IF NOT EXISTS partage_stats BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------
-- Formules d'abonnement (mensuelle / annuelle)
-- ---------------------------------------------------------------
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS plan  VARCHAR(10) NOT NULL DEFAULT 'mensuel';
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS jours INT;

-- ---------------------------------------------------------------
-- Ventes à crédit et remboursements clients
-- ---------------------------------------------------------------
ALTER TABLE ventes DROP CONSTRAINT IF EXISTS ventes_mode_paiement_check;
ALTER TABLE ventes ADD CONSTRAINT ventes_mode_paiement_check CHECK (mode_paiement IN ('especes', 'mobile_money', 'autre', 'credit'));
-- montant_paye : argent réellement conservé (acomptes et règlements, net des sommes rendues) ; rembourse : valeur des articles repris
ALTER TABLE ventes ADD COLUMN IF NOT EXISTS montant_paye INT;
UPDATE ventes SET montant_paye = total WHERE montant_paye IS NULL;
ALTER TABLE ventes ALTER COLUMN montant_paye SET NOT NULL;
ALTER TABLE ventes ALTER COLUMN montant_paye SET DEFAULT 0;
ALTER TABLE ventes ADD COLUMN IF NOT EXISTS rembourse INT NOT NULL DEFAULT 0;
ALTER TABLE ventes ADD COLUMN IF NOT EXISTS echeance DATE;
CREATE INDEX IF NOT EXISTS ventes_credit_idx ON ventes (entreprise_id) WHERE mode_paiement = 'credit';

ALTER TABLE mouvements_stock DROP CONSTRAINT IF EXISTS mouvements_stock_type_check;
ALTER TABLE mouvements_stock ADD CONSTRAINT mouvements_stock_type_check CHECK (type IN ('entree', 'sortie', 'ajustement', 'vente', 'retour'));

CREATE TABLE IF NOT EXISTS reglements (
  id             SERIAL PRIMARY KEY,
  entreprise_id  INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  vente_id       INT NOT NULL REFERENCES ventes(id) ON DELETE CASCADE,
  montant        INT NOT NULL CHECK (montant > 0),
  mode_paiement  VARCHAR(20) NOT NULL DEFAULT 'especes' CHECK (mode_paiement IN ('especes', 'mobile_money', 'autre')),
  utilisateur_id INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reglements_vente_idx ON reglements (vente_id);

CREATE TABLE IF NOT EXISTS remboursements (
  id               SERIAL PRIMARY KEY,
  entreprise_id    INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  vente_id         INT NOT NULL REFERENCES ventes(id) ON DELETE CASCADE,
  numero           INT NOT NULL,
  motif            VARCHAR(255) NOT NULL,
  montant          INT NOT NULL CHECK (montant > 0),
  credit_annule    INT NOT NULL DEFAULT 0 CHECK (credit_annule >= 0),
  montant_rendu    INT NOT NULL DEFAULT 0 CHECK (montant_rendu >= 0),
  mode_paiement    VARCHAR(20) NOT NULL DEFAULT 'especes' CHECK (mode_paiement IN ('especes', 'mobile_money', 'autre')),
  remis_en_stock   BOOLEAN NOT NULL DEFAULT true,
  utilisateur_id   INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  cree_le          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, numero)
);
CREATE INDEX IF NOT EXISTS remboursements_vente_idx ON remboursements (vente_id);

CREATE TABLE IF NOT EXISTS lignes_remboursement (
  id               SERIAL PRIMARY KEY,
  remboursement_id INT NOT NULL REFERENCES remboursements(id) ON DELETE CASCADE,
  ligne_vente_id   INT NOT NULL REFERENCES lignes_vente(id) ON DELETE CASCADE,
  nom_produit      VARCHAR(150) NOT NULL,
  quantite         INT NOT NULL CHECK (quantite > 0),
  prix_unitaire    INT NOT NULL CHECK (prix_unitaire >= 0),
  sous_total       INT NOT NULL CHECK (sous_total >= 0)
);
CREATE INDEX IF NOT EXISTS lignes_remboursement_idx ON lignes_remboursement (remboursement_id);

-- ---------------------------------------------------------------
-- Remise à zéro du tableau de bord (fin d'inventaire) : une date de départ, rien n'est supprimé
-- ---------------------------------------------------------------
ALTER TABLE entreprises ADD COLUMN IF NOT EXISTS tableau_depuis TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS tableau_remises (
  id             SERIAL PRIMARY KEY,
  entreprise_id  INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  utilisateur_id INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  admin_id       INT REFERENCES admins_plateforme(id) ON DELETE SET NULL,
  note           VARCHAR(255),
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tableau_remises_idx ON tableau_remises (entreprise_id, cree_le DESC);

-- ---------------------------------------------------------------
-- Inventaire : comptage du stock avec la secrétaire, écarts, validation
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventaires (
  id            SERIAL PRIMARY KEY,
  entreprise_id INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  numero        INT NOT NULL,
  statut        VARCHAR(12) NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'valide', 'annule')),
  note          VARCHAR(255),
  cree_par      INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  valide_par    INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  termine_le    TIMESTAMPTZ,
  tableau_remis BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (entreprise_id, numero)
);
-- Un seul inventaire en cours à la fois par entreprise
CREATE UNIQUE INDEX IF NOT EXISTS inventaire_en_cours_uniq ON inventaires (entreprise_id) WHERE statut = 'en_cours';

CREATE TABLE IF NOT EXISTS lignes_inventaire (
  id                SERIAL PRIMARY KEY,
  inventaire_id     INT NOT NULL REFERENCES inventaires(id) ON DELETE CASCADE,
  produit_id        INT REFERENCES produits(id) ON DELETE SET NULL,
  nom_produit       VARCHAR(150) NOT NULL,
  categorie         VARCHAR(100),
  unite             VARCHAR(30),
  prix_achat        INT NOT NULL DEFAULT 0,
  quantite_comptee  INT CHECK (quantite_comptee >= 0),
  stock_au_comptage INT,
  compte_par        INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  compte_le         TIMESTAMPTZ,
  ecart_applique    INT
);
CREATE INDEX IF NOT EXISTS lignes_inventaire_idx ON lignes_inventaire (inventaire_id);

-- ---------------------------------------------------------------
-- Bilans enregistrés (ventes du jour, de la semaine, du mois…) : instantané figé, imprimable en PDF
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bilans (
  id            SERIAL PRIMARY KEY,
  entreprise_id INT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  numero        INT NOT NULL,
  du            DATE NOT NULL,
  au            DATE NOT NULL,
  note          VARCHAR(255),
  donnees       JSONB NOT NULL,
  cree_par      INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, numero)
);
CREATE INDEX IF NOT EXISTS bilans_idx ON bilans (entreprise_id, cree_le DESC);
