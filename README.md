[README.md](https://github.com/user-attachments/files/26831238/README.md)
# GIORGIA paris — Catalogue statique PE 2026

Site catalogue B2B généré automatiquement depuis Airtable via GitHub Actions
et publié sur GitHub Pages (domaine : `giorgiaparis.com`).

## Comment ça marche

```
┌─────────────┐    cron 2h / manuel    ┌──────────────────┐
│  Airtable   │  ────────────────────▶ │ GitHub Actions   │
│ (Catalogue) │                        │ (node build.mjs) │
└─────────────┘                        └────────┬─────────┘
                                                │
                                                ▼
                            ┌──────────────────────────────────┐
                            │ branche gh-pages : dist/index.html│
                            │ + CNAME giorgiaparis.com          │
                            └───────────────┬──────────────────┘
                                            │
                                            ▼
                                  ┌───────────────────┐
                                  │  Visiteur du site │
                                  └───────────────────┘
```

Les données Airtable sont **pré-intégrées** dans le HTML au moment du build.
Le navigateur ne contacte jamais Airtable : affichage instantané, clé API
jamais exposée.

## Mise en place initiale (à faire UNE fois)

### 1. Préparer le repo

Déplacer ce projet dans ton repo GitHub `sirivie/giorgia-paris-vitrinePE2026`
(ou remplacer le contenu existant).

Structure attendue :
```
.
├── .github/workflows/build.yml
├── scripts/build.mjs
├── src/template.html
├── package.json
├── .gitignore
└── README.md
```

### 2. Ajouter le secret Airtable

Sur GitHub : **Settings → Secrets and variables → Actions → New repository secret**

- **Name** : `AIRTABLE_API_KEY`
- **Secret** : ta clé (celle qui était dans l'ancien `index.html`, commence par `pat...`)

⚠️ **Tant que tu y es, régénère cette clé sur Airtable.** Elle a été
exposée publiquement pendant un moment — il faut créer un nouveau token,
coller le nouveau dans ce secret, et révoquer l'ancien.

### 3. (Optionnel) Variables Airtable

Les valeurs `BASE_ID` et `TABLE_NAME` ont des défauts dans `scripts/build.mjs`.
Si tu veux les surcharger sans modifier le code : **Settings → Secrets and
variables → Actions → Variables tab → New repository variable**

- `AIRTABLE_BASE_ID` (par défaut `appXLBhHlXD2MCMUj`)
- `AIRTABLE_TABLE_NAME` (par défaut `Catalogue`)
- `CUSTOM_DOMAIN` (par défaut `giorgiaparis.com`)

### 4. Lancer le premier build

Deux options :

**A) Déclenchement manuel** (recommandé pour la toute première fois) :
- Onglet **Actions** du repo
- Workflow « Build & Deploy » → bouton **Run workflow** → branche `main`
- Attendre ~1 min que ça termine

**B) Push sur main** :
- Tout push sur `main` qui touche `src/`, `scripts/` ou le workflow
  déclenchera automatiquement un rebuild.

### 5. Activer GitHub Pages sur la branche gh-pages

Après le premier build réussi, la branche `gh-pages` existe.

Sur GitHub : **Settings → Pages**
- **Source** : Deploy from a branch
- **Branch** : `gh-pages` / `(root)`
- **Custom domain** : `giorgiaparis.com` (déjà configuré normalement)
- Cocher **Enforce HTTPS**

### 6. Vérifier côté OVH

Rien à faire si le DNS pointe déjà vers GitHub Pages (ce que tu m'as dit).
Les enregistrements doivent ressembler à :

```
Type  Nom  Cible
A     @    185.199.108.153
A     @    185.199.109.153
A     @    185.199.110.153
A     @    185.199.111.153
CNAME www  sirivie.github.io.
```

## Opérations courantes

### Modifier un produit dans Airtable

Le catalogue se met à jour automatiquement **dans les 2 heures**.

Si tu veux voir la modif immédiatement : onglet **Actions** → **Build &
Deploy** → **Run workflow**. Résultat en ligne ~1 min plus tard.

### Modifier le design du site

Éditer `src/template.html`, commit, push sur `main`. Le workflow rebuilde
automatiquement.

### Vérifier qu'un déploiement est bien à jour

Ouvrir `https://giorgiaparis.com/build-info.json` — on y trouve
`generatedAt` (timestamp du dernier build) et `count` (nombre de produits).

### Tester le build en local avant de pusher

```bash
AIRTABLE_API_KEY=patXXXXX node scripts/build.mjs
# Puis ouvrir dist/index.html dans le navigateur.
```

## Dépannage

### Le workflow a échoué avec "Airtable 401"

La clé API est invalide ou expirée. Régénère-la sur Airtable et mets à jour
le secret `AIRTABLE_API_KEY`.

### Le workflow a échoué avec "Airtable 422"

Le nom de la table ou du champ a changé dans Airtable. Vérifie que le champ
`Ordre` existe toujours (utilisé pour le tri) ou change le nom du champ dans
`scripts/build.mjs`.

### Le site est vide après déploiement

Ouvrir `https://giorgiaparis.com/build-info.json` :
- Si `count: 0` → problème côté Airtable (table vide ou mal nommée).
- Si le fichier n'existe pas → le build n'a pas déployé, regarder les logs
  de l'Action.

### Les images sont cassées

Les URLs thumbnails Airtable sont stables mais peuvent occasionnellement
être régénérées. Un nouveau build règle le problème (attendre le cron ou
forcer manuellement).

## Limites connues

- **Fenêtre de 2 h max** entre une modif Airtable et sa publication
  (sauf rebuild manuel).
- **Pas de prévisualisation** : ce qui est dans Airtable passe direct en
  prod. Pour tester : build local avec `node scripts/build.mjs`.
- **Budget GitHub Actions** : 12 builds/jour × ~1 min = ~360 min/mois, très
  en-dessous de la limite de 2000 min/mois du free tier.
