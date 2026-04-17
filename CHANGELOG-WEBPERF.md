[CHANGELOG-WEBPERF.md](https://github.com/user-attachments/files/26840582/CHANGELOG-WEBPERF.md)
# Patch webperf — Avril 2026

Optimisation du temps de chargement du catalogue PE 2026.

## Problème initial

- Console DevTools : `load` event à ~12 s.
- Chrono réel : catalogue visible et utilisable à ~27 s.
- Décalage inexpliqué de 15 s entre les deux.

## Cause racine identifiée

La fonction `waitForImages()` (ex-ligne 1917) attendait que **toutes** les
images du site soient chargées avant d'initialiser les carrousels, avec un
timeout de 25 s. Comme toutes les images étaient en `loading="lazy"`,
celles sous le fold ne se téléchargeaient jamais — donc le code attendait
systématiquement le timeout complet.

**27 s ≈ 2 s de chargement réel + 25 s de timeout inutile.**

## Patches appliqués

### 1. Suppression du blocage `waitForImages`
`src/template.html` — `loadCatalogFromAirtable()`

Le `Promise.all(waitForImages)` a été remplacé par une init immédiate des
carrousels via `requestAnimationFrame`. Les images continuent de se charger
en arrière-plan via `loading="lazy"` — elles n'ont jamais eu besoin d'être
attendues pour que les carrousels soient utilisables.

**Gain attendu : -25 s sur le temps d'affichage utilisable.**

### 2. Summer Vibes prioritaire
`src/template.html` — `buildProductCard()`

Les 4 premières cards ajoutées au carrousel "summer" reçoivent
`loading="eager"` + `fetchpriority="high"`. Le reste du site reste en
`loading="lazy"` pour économiser la bande passante.

**Gain attendu : première image Summer Vibes visible ~1 s plus tôt.**

### 3. Preconnect vers les CDN Airtable
`src/template.html` — `<head>`

Ajout de `<link rel="preconnect">` vers `v5.airtableusercontent.com` et
`dl.airtable.com`. Sans ça, le navigateur perd 200-400 ms en DNS + TCP +
TLS avant la première image produit.

### 4. Preload de l'image hero + resize
`src/template.html` — `<head>` et `.hero-bg`

L'image Pexels du hero est maintenant préchargée en priorité haute,
avec resize forcé à 1600 px (`?auto=compress&cs=tinysrgb&w=1600`). Les
deux URLs (preload + CSS) sont identiques pour que le navigateur
réutilise le cache.

**Gain attendu : LCP (Largest Contentful Paint) -1 à -2 s.**

### 5. Banner Unsplash en WebP compressé
`src/template.html` — dans `buildUniversFromConfig()`

Ajout de `&auto=format&q=75` à l'URL Unsplash du banner. Le navigateur
reçoit du WebP quand il le supporte, avec compression plus agressive.

**Gain attendu : -60% sur le poids du banner.**

## Patch bonus — audit automatique du poids des images

`scripts/build.mjs` — nouvelle fonction `auditImageWeights()`

À chaque build GitHub Actions, le script fait maintenant des requêtes HEAD
sur chaque URL `thumbnails.large` des produits Airtable et logue :
- Le poids total du catalogue.
- Le poids moyen par image.
- La liste des images > 300 KB (seuil d'alerte).
- Le top 10 des plus lourdes.

**Où voir le résultat :**
1. Dans les logs de l'Action GitHub (`Build & Deploy` → dernière run).
2. Dans `https://giorgiaparis.com/build-info.json` (JSON structuré,
   champ `imageAudit.top20Heavy`).

Pour désactiver l'audit en build local (plus rapide) :
```bash
SKIP_IMAGE_AUDIT=1 AIRTABLE_API_KEY=patXXX node scripts/build.mjs
```

## Comment tester après déploiement

1. Remplacer `src/template.html` et `scripts/build.mjs` par ces versions.
2. Commit + push sur `main`.
3. Attendre que l'Action termine (~1 min).
4. Ouvrir `giorgiaparis.com` en **navigation privée** (pour éviter le cache).
5. DevTools → onglet **Performance** → Record → recharger → Stop.
6. Regarder la métrique **LCP (Largest Contentful Paint)** : elle devrait
   être autour de 2-4 s au lieu de 27 s.

## Résultat attendu

| Métrique               | Avant  | Après  |
|------------------------|--------|--------|
| Carrousels utilisables | ~27 s  | ~2-4 s |
| Première image visible | ~3-5 s | ~1-2 s |
| LCP                    | ~27 s  | ~2-4 s |

Si après le patch le LCP est toujours > 5 s, regarder le rapport
`imageAudit.top20Heavy` dans `build-info.json` et recompresser les images
incriminées dans Airtable (remplacer les attachments par des versions
JPEG quality 80-85, 1200-1600 px max).
