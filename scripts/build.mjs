#!/usr/bin/env node
/**
 * GIORGIA paris — Build statique · v2 "SEO"
 * ============================================================
 * Rôle :
 *   1. Récupérer le catalogue depuis Airtable (comme avant).
 *   2. **Pré-rendre** tout le HTML : sections univers, cards produits,
 *      navbar, menu mobile, slider de tabs. Plus rien n'est construit
 *      côté navigateur → les moteurs de recherche voient tout.
 *   3. Injecter les données structurées JSON-LD (Organization,
 *      WholesaleStore, ItemList de Products).
 *   4. Générer robots.txt et sitemap.xml.
 *
 * Exécution locale (pour tester avant de pusher) :
 *   AIRTABLE_API_KEY=xxx node scripts/build.mjs
 *
 * En GitHub Actions : la clé vient du secret AIRTABLE_API_KEY.
 * ============================================================ */

import { readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import matter from 'gray-matter';
import { marked } from 'marked';

/* ==========================================================================
   1. CONFIGURATION
   ========================================================================== */

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appXLBhHlXD2MCMUj';
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Catalogue';

// Domaine personnalisé pour GitHub Pages. Défini comme variable de repo
// `CUSTOM_DOMAIN` UNIQUEMENT sur le repo de production. En qualif, laisser
// vide : le site sera servi à l'URL par défaut <user>.github.io/<repo>/.
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || '';

// =============================================================
//  AUTO-DÉTECTION REPO_NAME / REPO_OWNER
//  -----------------------------------------------------------
//  Priorité 1 : variables explicites du workflow (REPO_NAME / REPO_OWNER).
//  Priorité 2 : variables natives GitHub Actions, TOUJOURS définies dans
//               un run Actions :
//                 - GITHUB_REPOSITORY        = "owner/repo"
//                 - GITHUB_REPOSITORY_OWNER  = "owner"
//  Cette redondance évite que le site casse si le workflow oublie d'injecter
//  REPO_NAME / REPO_OWNER (cas observé : SITE_BASE = '' → toutes les images
//  pointent vers /img/... au lieu de /<repo>/img/... → 404 partout).
// =============================================================
function deriveRepoInfo() {
  const explicitName  = process.env.REPO_NAME  || '';
  const explicitOwner = process.env.REPO_OWNER || '';

  // GITHUB_REPOSITORY a la forme "owner/repo"
  const ghRepo = process.env.GITHUB_REPOSITORY || '';
  const ghOwner = process.env.GITHUB_REPOSITORY_OWNER || '';

  let name = explicitName;
  let owner = explicitOwner;

  if (!name && ghRepo.includes('/')) {
    name = ghRepo.split('/').slice(1).join('/');
  }
  if (!owner) {
    owner = ghOwner || (ghRepo.split('/')[0] || '');
  }

  return { name, owner };
}

const { name: REPO_NAME, owner: REPO_OWNER } = deriveRepoInfo();

// =============================================================
//  DÉTECTION D'ENVIRONNEMENT — basée UNIQUEMENT sur CUSTOM_DOMAIN.
//  Cette logique est volontairement faite côté Node (et pas dans
//  build.yml) car les expressions GitHub Actions ont un piège avec
//  les chaînes vides : `X && '' || Y` retourne toujours Y, parce que
//  '' est falsy. Ici, en JavaScript, on a un vrai if/else propre.
// =============================================================
const IS_PROD = CUSTOM_DOMAIN !== '';

// SITE_ORIGIN : l'origine HTTPS où le site sera servi.
//   • Prod   → https://<CUSTOM_DOMAIN>          (ex. https://giorgiaparis.com)
//   • Qualif → https://<REPO_OWNER>.github.io   (ex. https://sirivie.github.io)
const SITE_ORIGIN = IS_PROD
  ? `https://${CUSTOM_DOMAIN}`
  : (REPO_OWNER ? `https://${REPO_OWNER}.github.io` : 'https://giorgiaparis.com');

// SITE_BASE : préfixe d'URL à appliquer aux chemins absolus internes
// (`/img/...`, `/cgv/`, etc.). En prod c'est vide ; en qualif c'est le
// nom du repo, parce que GitHub Pages sert depuis <owner>.github.io/<repo>/.
//   • Prod   → ''
//   • Qualif → '/<REPO_NAME>'  (ex. '/giorgia-paris-vitrinePE2026')
const SITE_BASE = IS_PROD ? '' : (REPO_NAME ? `/${REPO_NAME}` : '');

// Garde-fou : si on est en qualif sans REPO_NAME détecté, on échoue tôt
// avec un message clair plutôt que de produire un build cassé silencieux.
if (!IS_PROD && !REPO_NAME) {
  console.warn(
    '⚠ ATTENTION : mode qualif sans REPO_NAME détecté.\n' +
    '  Les chemins d\'images vont être servis depuis la racine, ce qui cassera tout en GitHub Pages.\n' +
    '  Vérifie que le job tourne bien dans GitHub Actions (GITHUB_REPOSITORY est-il défini ?)'
  );
}

const TEMPLATE_PATH = resolve('src/template.html');
const OUTPUT_DIR = resolve('dist');
const OUTPUT_HTML = resolve(OUTPUT_DIR, 'index.html');

// Répertoires du pipeline d'images
const IMG_OUTPUT_DIR = resolve(OUTPUT_DIR, 'img');      // dist/img/ — ce qui sera servi en ligne
const IMG_CACHE_DIR = resolve('.image-cache');          // Cache persistant entre les builds GitHub Actions

// Paramètres de compression — à ajuster ici en cas de besoin
const IMG_MAX_WIDTH = 1200;          // Les images plus larges sont redimensionnées
const IMG_JPEG_QUALITY = 82;         // Bon compromis qualité/poids pour JPEG
const IMG_WEBP_QUALITY = 78;         // WebP à qualité équivalente visuelle, mais plus léger
const IMG_CONCURRENCY = 6;           // Téléchargements en parallèle — pas trop pour ne pas taper Airtable trop fort
const IMG_TIMEOUT_MS = 20000;        // Abandonne un download qui traîne au-delà de 20 s

// URLs d'illustration "en dur" (non-Airtable). Centralisées ici pour qu'elles
// soient téléchargées au build, et remplacées par leurs chemins locaux dans le HTML.
const ILLUSTRATION_URLS = {
  heroPexels:
    'https://images.pexels.com/photos/6068969/pexels-photo-6068969.jpeg?auto=compress&cs=tinysrgb&w=1600',
  bannerUnsplash:
    'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=1800&h=700&fit=crop&crop=center&auto=format&q=75',
  editorialUnsplash:
    'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=800&h=1000&fit=crop&crop=top',
};

if (!API_KEY) {
  console.error('✖ AIRTABLE_API_KEY manquant. Ajoutez-le comme secret GitHub ou variable d\'environnement locale.');
  process.exit(1);
}

/* ==========================================================================
   2. UNIVERS (source unique de vérité — ex-JS du template)
   ========================================================================== */

/** Ordre et métadonnées des 5 catégories. Pour réordonner : déplacer une ligne.
 *  Ne PAS changer "id" ni "airtableKey" — ils sont couplés au front et à Airtable.
 *
 *  Champ "location" :
 *   - 'home'    → rendu sur la homepage (dans le slider univers)
 *   - 'archive' → rendu sur /collection-printemps-ete-2026/ (page ancienne collection PE 2026)
 *
 *  Pour déplacer un univers de home vers archive (ou l'inverse) :
 *  changer juste la valeur du champ location. build.mjs s'occupe du reste
 *  (nav, mobile menu, sitemap, JSON-LD, redirections legacy).
 */
const UNIVERS = [
  {
    id: 'summer',
    airtableKey: 'Summer Vibes',
    emoji: '\u{1F30A}',
    label: 'Summer Vibes',
    sub: 'Légèreté, couleur & féminité solaire',
    desc: 'Des pièces qui capturent l\u2019essence de l\u2019été : matières fluides, imprimés vivants, silhouettes libres. Un univers à fort potentiel de vente.',
    location: 'archive',
  },
  {
    id: 'working',
    airtableKey: 'Urban Woman',
    emoji: '\u{1F454}',
    label: 'Urban Woman',
    sub: 'Élégance, confiance & polyvalence au quotidien.',
    desc: 'Une sélection conçue pour la femme active contemporaine. Du bureau au week-end, découvrez des basiques surélevés et des pièces fluides qui s\u2019adaptent à toutes ses vies.',
    location: 'home',
    insertBannerAfter: true, // Encart "Vêtir les boutiques..." (doré) après Urban Woman
  },
  {
    id: 'chic',
    airtableKey: 'Chic & Soirée',
    emoji: '\u2728',
    label: 'Chic & Soirée',
    sub: 'Glamour, strass & dentelle précieuse',
    desc: 'Quand l\u2019élégance s\u2019habille de nuit. Strass, satin, dentelle — des pièces à fort impact visuel pour les boutiques de soirée et d\u2019événementiel.',
    location: 'home',
    insertEditorialAfter: true,
  },
  {
    id: 'boheme',
    airtableKey: 'Bohème',
    emoji: '\u{1F33F}',
    label: 'Bohème',
    sub: 'Fluidité, crochet & âme libre',
    desc: 'L\u2019esprit free spirit rencontre l\u2019artisanat délicat : crochet, matières naturelles, silhouettes aériennes. Fort potentiel pour les boutiques lifestyle.',
    location: 'archive',
  },
  {
    id: 'casual',
    airtableKey: 'Casual Chic',
    emoji: '\u{1F90D}',
    label: 'Casual',
    sub: 'L\u2019attitude au quotidien, sans effort apparent',
    desc: 'Le quotidien stylé : vestes à caractère, tops ornementés, looks urban-cool qui tournent en boutique.',
    location: 'home',
  },
];

// Vues dérivées de UNIVERS (utilisées partout : sections, nav, tabs, JSON-LD, sitemap)
const HOME_UNIVERS    = UNIVERS.filter(u => u.location === 'home');
const ARCHIVE_UNIVERS = UNIVERS.filter(u => u.location === 'archive');

// URL de la page archive (ancienne collection PE 2026)
const ARCHIVE_PAGE_SLUG  = 'collection-printemps-ete-2026';
const ARCHIVE_PAGE_TITLE = 'Ancienne Collection Printemps-Été 2026';
const CONTACT_PAGE_SLUG  = 'contact';

/**
 * FUTURE-PROOFING — champ Airtable "Collection".
 * Aujourd'hui, tous les produits Airtable sont de la collection PE 2026.
 * Quand la prochaine collection arrivera (AH 2026, PE 2027…), il faudra :
 *   1. Ajouter dans Airtable un champ single-select "Collection" avec les valeurs
 *      ex : "PE 2026", "AH 2026", "PE 2027"…
 *   2. Renseigner "PE 2026" sur tous les produits actuels.
 *   3. Renseigner la nouvelle valeur pour les nouveaux produits.
 *
 * Le code ci-dessous LIT ce champ s'il existe et l'utilise pour distinguer
 * "ancienne PE 2026" (→ page archive) de "nouvelle collection" (→ home,
 * même pour Summer Vibes / Bohème s'ils reviennent avec une nouvelle collection).
 *
 * Tant que le champ n'existe pas dans Airtable, on retombe sur le comportement
 * historique : la catégorie seule (`location: 'archive'`) détermine le routage.
 */
const ARCHIVE_COLLECTION_LABEL = 'PE 2026';

function resolveCollection(f) {
  const raw = f?.Collection ?? f?.collection ?? '';
  if (Array.isArray(raw)) return raw[0] ? String(raw[0]).trim() : '';
  if (typeof raw === 'object' && raw !== null && raw.name) return String(raw.name).trim();
  return String(raw || '').trim();
}

/**
 * Détermine si un enregistrement doit apparaître sur la page ARCHIVE
 * (ancienne collection PE 2026).
 *
 * Règle :
 *  - Si l'univers du produit est en `location: 'home'` → jamais archive.
 *  - Si l'univers est en `location: 'archive'` :
 *      • et que le champ Airtable "Collection" existe :
 *          → archive UNIQUEMENT si Collection === "PE 2026"
 *          → sinon home (produit d'une nouvelle collection dans un univers archive)
 *      • et que le champ n'existe pas :
 *          → archive (comportement legacy, tout Summer Vibes / Bohème = archive)
 */
function isArchiveRecord(rec, univ) {
  if (!univ || univ.location !== 'archive') return false;
  const collection = resolveCollection(rec.fields || {});
  if (!collection) return true; // legacy : pas de champ Collection → archive par défaut
  return normalizeKey(collection) === normalizeKey(ARCHIVE_COLLECTION_LABEL);
}

/** Normalise une clé catégorie pour matching tolérant (case, accents, espaces). */
function normalizeKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map catégorie Airtable → objet univers. Gère les variantes accentuées. */
const CATEGORY_TO_UNIVERS = new Map();
for (const u of UNIVERS) {
  CATEGORY_TO_UNIVERS.set(normalizeKey(u.airtableKey), u);
}
// Aliases usuels : variantes sans accent, alias court…
const ALIASES = [
  ['Chic & Soiree', 'chic'],
  ['Boheme', 'boheme'],
  ['Casual', 'casual'],
];
for (const [key, id] of ALIASES) {
  const u = UNIVERS.find(x => x.id === id);
  if (u) CATEGORY_TO_UNIVERS.set(normalizeKey(key), u);
}

/* ==========================================================================
   3. AIRTABLE FETCH (inchangé fonctionnellement)
   ========================================================================== */

async function fetchAllRecords() {
  const base = `https://api.airtable.com/v0/${encodeURIComponent(BASE_ID)}/${encodeURIComponent(TABLE_NAME)}`;
  const all = [];
  let offset = '';

  do {
    const params = new URLSearchParams();
    params.set('pageSize', '100');
    params.append('sort[0][field]', 'Ordre');
    params.append('sort[0][direction]', 'asc');
    if (offset) params.set('offset', offset);

    const url = `${base}?${params.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Airtable ${res.status} ${res.statusText} — ${txt.slice(0, 400)}`);
    }

    const data = await res.json();
    if (Array.isArray(data.records)) all.push(...data.records);
    offset = data.offset || '';
  } while (offset);

  return all;
}

/* ==========================================================================
   4. ALLÈGEMENT DU PAYLOAD (pour __GIORGIA_CATALOG__ — utile aux devs)
   ========================================================================== */

function slimAttachment(att) {
  if (!att || typeof att !== 'object') return att;
  const out = { url: att.url };
  if (att.thumbnails && att.thumbnails.large && att.thumbnails.large.url) {
    out.thumbnails = { large: { url: att.thumbnails.large.url } };
  }
  return out;
}

function isAttachmentArray(value) {
  return (
    Array.isArray(value) && value.length > 0 && value[0] &&
    typeof value[0] === 'object' &&
    typeof value[0].url === 'string' &&
    typeof value[0].id === 'string'
  );
}

function slimRecord(rec) {
  const fields = rec.fields || {};
  const slimFields = {};
  for (const [key, value] of Object.entries(fields)) {
    slimFields[key] = isAttachmentArray(value) ? value.map(slimAttachment) : value;
  }
  return { id: rec.id, fields: slimFields };
}

/* ==========================================================================
   5. RÉSOLUTION DES CHAMPS (port Node des helpers ex-JS)
   ========================================================================== */

function fieldPick(fields, keys) {
  if (!fields) return '';
  for (const k of keys) {
    const v = fields[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  // Recherche tolérante sur les clés (insensible à la casse et aux espaces)
  const keysSet = new Set(keys.map(k => k.toLowerCase().trim()));
  for (const k of Object.keys(fields)) {
    if (keysSet.has(k.toLowerCase().trim())) {
      const v = fields[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return '';
}

function resolveName(f) {
  return fieldPick(f, ['Nom', 'Name', 'Titre', 'Title']);
}

function resolveRef(f) {
  return fieldPick(f, ['Reference', 'Référence', 'Ref', 'REF']);
}

function resolveDesc(f) {
  return fieldPick(f, ['Description', 'Desc']);
}

function resolveCategorie(f) {
  const raw = f?.Categorie ?? f?.['Catégorie'] ?? '';
  if (Array.isArray(raw)) return raw[0] ? String(raw[0]).trim() : '';
  if (typeof raw === 'object' && raw !== null && raw.name) return String(raw.name).trim();
  return String(raw || '').trim();
}

/**
 * Résout le champ « Prévente » d'Airtable (case à cocher).
 * Retourne true si le produit est en prévente (case cochée), false sinon.
 * Tolère plusieurs noms possibles pour faciliter la maintenance.
 */
function resolvePrevente(f) {
  if (!f) return false;
  const keys = ['Prévente', 'Prevente', 'Pre-vente', 'PreVente', 'PREVENTE'];
  for (const k of keys) {
    if (k in f) {
      const v = f[k];
      // Airtable case à cocher renvoie true / false / undefined
      return v === true || v === 'true' || v === 1 || v === '1';
    }
  }
  return false;
}

function resolveBadge(f, n) {
  const keys = n === 2 ? ['Badge2', 'Badge 2', 'BADGE2'] : ['Badge', 'BADGE'];
  for (const k of keys) {
    const raw = f?.[k];
    if (raw == null || raw === '') continue;
    if (typeof raw === 'object' && raw.name) return String(raw.name).trim();
    const s = String(raw).trim();
    if (s) return s;
  }
  return '';
}

function resolveHref(f) {
  const v = fieldPick(f, ['Lien', 'Link', 'URL', 'Url']);
  if (v) return v;
  return (
    'https://wa.me/33686729311?text=' +
    encodeURIComponent('Bonjour GIORGIA paris, je souhaite passer commande pour la collection PE 2026.')
  );
}

function attachmentUrl(att) {
  if (!att || typeof att !== 'object') return '';
  if (att.thumbnails?.large?.url) return att.thumbnails.large.url;
  return att.url || '';
}

function allAttUrls(field) {
  if (!Array.isArray(field)) return [];
  return field.map(attachmentUrl).filter(Boolean);
}

/** Ordre : toutes les images de « Photos », puis Photos2, puis Photos3 (sans doublon). */
function resolvePhotos(f) {
  const p1 = allAttUrls(f?.Photos);
  const p2 = allAttUrls(f?.Photos2 ?? f?.['Photos 2'] ?? f?.['Photo 2']);
  const p3 = allAttUrls(f?.Photos3 ?? f?.['Photos 3'] ?? f?.['Photo 3']);
  const seen = new Set();
  const out = [];
  for (const u of [...p1, ...p2.slice(0, 1), ...p3.slice(0, 1)]) {
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

/** Image affichée au survol : Photos2 si présent, sinon 2e image de Photos. */
function resolveHoverUrl(f) {
  const p2 = allAttUrls(f?.Photos2 ?? f?.['Photos 2'] ?? f?.['Photo 2']);
  if (p2[0]) return p2[0];
  const p1 = allAttUrls(f?.Photos);
  return p1[1] || '';
}

/* ==========================================================================
   6. TRI PAR « Ordre »
   ========================================================================== */

function ordreValue(rec) {
  const v = rec?.fields?.Ordre;
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

function sortByOrdre(records) {
  return records.slice().sort((a, b) => {
    const oa = ordreValue(a), ob = ordreValue(b);
    if (oa == null && ob == null) return 0;
    if (oa == null) return 1;
    if (ob == null) return -1;
    return oa - ob;
  });
}

/* ==========================================================================
   7. ÉCHAPPEMENT HTML
   ========================================================================== */

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Génère le schema JSON-LD pour un article
 * Aide Google à comprendre et afficher l'article dans les rich snippets
 */
function generateArticleSchema(article, heroImageUrl) {
  const articleUrl = `${SITE_ORIGIN}${SITE_BASE}${ARTICLE_URL_PREFIX}/${article.slug}/`;
  const publishDate = article.date_publication ? new Date(article.date_publication).toISOString() : new Date().toISOString();
  
  // Extraire une partie du contenu HTML comme articleBody (limiter à 5000 chars pour ne pas surcharger)
  const articleBody = (article.contentHtml || '')
    .replace(/<[^>]*>/g, '') // Enlever les tags HTML
    .trim()
    .slice(0, 5000) + (article.contentHtml && article.contentHtml.length > 5000 ? '...' : '');

  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    'headline': article.title,
    'description': article.chapo || article.title,
    'image': heroImageUrl || `${SITE_ORIGIN}${SITE_BASE}/img/og-articles-hub.jpg`,
    'datePublished': publishDate,
    'dateModified': publishDate,
    'author': {
      '@type': 'Organization',
      'name': article.auteur || 'GIORGIA paris'
    },
    'publisher': {
      '@type': 'Organization',
      'name': 'GIORGIA paris',
      'logo': {
        '@type': 'ImageObject',
        'url': `${SITE_ORIGIN}${SITE_BASE}/img/og-articles-hub.jpg`
      }
    },
    'articleBody': articleBody,
    'url': articleUrl,
    'mainEntityOfPage': {
      '@type': 'WebPage',
      '@id': articleUrl
    }
  };
}

/**
 * Génère le schema JSON-LD BreadcrumbList pour un article
 * Aide Google à afficher le fil d'Ariane
 */
function generateBreadcrumbSchema(article) {
  const articleUrl = `${SITE_ORIGIN}${SITE_BASE}${ARTICLE_URL_PREFIX}/${article.slug}/`;
  const hubUrl = `${SITE_ORIGIN}${SITE_BASE}${ARTICLE_URL_PREFIX}/`;
  const homeUrl = `${SITE_ORIGIN}${SITE_BASE}/`;

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    'itemListElement': [
      {
        '@type': 'ListItem',
        'position': 1,
        'name': 'Accueil',
        'item': homeUrl
      },
      {
        '@type': 'ListItem',
        'position': 2,
        'name': 'Tendances & Conseils Pro',
        'item': hubUrl
      },
      {
        '@type': 'ListItem',
        'position': 3,
        'name': article.title,
        'item': articleUrl
      }
    ]
  };
}

/* ==========================================================================
   7 bis. PIPELINE D'IMAGES
   ==========================================================================
   Toutes les images du site (produits Airtable, hero Pexels, banner Unsplash)
   sont téléchargées au buildtime, compressées, converties en JPEG + WebP et
   stockées dans dist/img/. Les URLs dans le HTML pointent ensuite vers des
   chemins relatifs (/img/xxx.jpg), rendant le site totalement autonome.

   Bénéfices :
   - Images servies depuis GitHub Pages (pas de dépendance à un CDN tiers)
   - Plus d'URL Airtable qui expire toutes les 3-4h
   - WebP pour navigateurs modernes (~30 % plus léger) + JPEG de fallback
   - Les images lourdes (>300 KB) sont automatiquement redimensionnées

   Pipeline:
     URL Airtable → hash SHA-1 → cache miss ? download → compress → .jpg+.webp
                                 cache hit  → copy from .image-cache/

   Le cache (.image-cache/) est persisté entre les builds par GitHub Actions,
   donc une image déjà traitée est réutilisée instantanément.
   ========================================================================== */

/** Registre des images connues : URL source → { jpg, webp, width, height }. */
const imageRegistry = new Map();

/** Stats du pipeline, pour reporting en fin de build. */
const imageStats = { downloaded: 0, cached: 0, failed: 0, totalSavedBytes: 0 };

/**
 * Hash court et stable d'une URL. On extrait la partie "identifiante" de l'URL
 * Airtable (le path, pas le querystring avec le timestamp d'expiration) pour
 * que la même image serve le même hash même si Airtable régénère son token.
 */
function hashImageUrl(url) {
  // Airtable : les URLs ont la forme v3/u/52/52/<timestamp>/<token>/<filename>/<...>
  // On normalise en enlevant le timestamp qui change entre deux builds.
  let normalized = url;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('airtableusercontent.com')) {
      // Pour Airtable, on hash uniquement les segments de path qui sont stables.
      // La structure est /v3/u/52/52/<TIMESTAMP>/<TOKEN1>/<FILE_ID>/<TOKEN2>
      // Le token et le timestamp changent à chaque build; seul FILE_ID est stable.
      const parts = u.pathname.split('/').filter(Boolean);
      // Prend tous les segments non-numériques et non-tokens temporels
      const stable = parts.filter(p => !/^\d{10,}$/.test(p));
      normalized = stable.join('/');
    } else {
      // Pour les autres (Pexels, Unsplash), l'URL est stable → hash direct
      normalized = u.origin + u.pathname;
    }
  } catch {
    // URL invalide : hash de la chaîne brute
  }
  return createHash('sha1').update(normalized).digest('hex').slice(0, 10);
}

/** Petite fonction pour formater les bytes. */
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Télécharge une URL en buffer avec timeout. */
async function downloadUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMG_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Traite une URL image :
 *   1. Cherche dans le cache disque (hash.jpg + hash.webp)
 *   2. Si absent : télécharge, redimensionne, compresse en JPEG et WebP,
 *      écrit dans le cache
 *   3. Copie du cache vers dist/img/
 * Retourne { jpg: '/img/xxx.jpg', webp: '/img/xxx.webp', width, height }.
 * En cas d'échec complet, retourne null → fallback sur l'URL originale.
 */
async function processImage(url) {
  if (!url || typeof url !== 'string') return null;

  // Cache in-memory dans ce même build (une image référencée 3× = 1 seul traitement)
  if (imageRegistry.has(url)) return imageRegistry.get(url);

  const hash = hashImageUrl(url);
  const cacheJpg = join(IMG_CACHE_DIR, `${hash}.jpg`);
  const cacheWebp = join(IMG_CACHE_DIR, `${hash}.webp`);
  const cacheMeta = join(IMG_CACHE_DIR, `${hash}.json`);
  const outJpg = join(IMG_OUTPUT_DIR, `${hash}.jpg`);
  const outWebp = join(IMG_OUTPUT_DIR, `${hash}.webp`);

  let fromCache = false;
  let meta = null;

  // 1. Tentative cache
  try {
    const [j, w, m] = await Promise.all([
      stat(cacheJpg),
      stat(cacheWebp),
      readFile(cacheMeta, 'utf8'),
    ]);
    if (j.size > 0 && w.size > 0) {
      meta = JSON.parse(m);
      fromCache = true;
    }
  } catch {
    // Cache miss, on télécharge
  }

  // 2. Téléchargement + compression si cache miss
  if (!fromCache) {
    try {
      const originalBuf = await downloadUrl(url);
      const originalSize = originalBuf.length;

      // Sharp : analyse + redimensionnement conditionnel
      const pipeline = sharp(originalBuf, { failOn: 'none' }).rotate();
      const metadata = await pipeline.metadata();
      const needsResize = metadata.width && metadata.width > IMG_MAX_WIDTH;

      // Deux sorties parallèles : JPEG + WebP
      const [jpgBuf, webpBuf] = await Promise.all([
        sharp(originalBuf, { failOn: 'none' })
          .rotate()
          .resize({ width: needsResize ? IMG_MAX_WIDTH : undefined, withoutEnlargement: true })
          .jpeg({ quality: IMG_JPEG_QUALITY, mozjpeg: true, progressive: true })
          .toBuffer(),
        sharp(originalBuf, { failOn: 'none' })
          .rotate()
          .resize({ width: needsResize ? IMG_MAX_WIDTH : undefined, withoutEnlargement: true })
          .webp({ quality: IMG_WEBP_QUALITY })
          .toBuffer(),
      ]);

      // On garde les dimensions de la version compressée (source de vérité pour le HTML)
      const finalMeta = await sharp(jpgBuf).metadata();
      meta = {
        width: finalMeta.width,
        height: finalMeta.height,
        jpgBytes: jpgBuf.length,
        webpBytes: webpBuf.length,
        originalBytes: originalSize,
      };

      // Écriture dans le cache
      await mkdir(IMG_CACHE_DIR, { recursive: true });
      await Promise.all([
        writeFile(cacheJpg, jpgBuf),
        writeFile(cacheWebp, webpBuf),
        writeFile(cacheMeta, JSON.stringify(meta)),
      ]);

      imageStats.downloaded++;
      // Comparaison brute original vs jpg compressé (proxy utile du gain)
      if (originalSize > jpgBuf.length) {
        imageStats.totalSavedBytes += originalSize - jpgBuf.length;
      }
    } catch (err) {
      imageStats.failed++;
      console.warn(`  ⚠ Échec image ${url.slice(0, 80)}… : ${err.message}`);
      imageRegistry.set(url, null);
      return null;
    }
  } else {
    imageStats.cached++;
  }

  // 3. Copie cache → dist/img/
  await mkdir(IMG_OUTPUT_DIR, { recursive: true });
  await Promise.all([
    copyFile(cacheJpg, outJpg),
    copyFile(cacheWebp, outWebp),
  ]);

  const result = {
    jpg: `${SITE_BASE}/img/${hash}.jpg`,
    webp: `${SITE_BASE}/img/${hash}.webp`,
    width: meta.width,
    height: meta.height,
  };
  imageRegistry.set(url, result);
  return result;
}

/** Traite un tableau d'URLs en parallèle contrôlé. */
async function processImagesBatch(urls, concurrency = IMG_CONCURRENCY) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  let idx = 0;
  async function worker() {
    while (idx < uniqueUrls.length) {
      const i = idx++;
      await processImage(uniqueUrls[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/** Collecte toutes les URLs images à traiter depuis les records Airtable +
 *  les URLs en dur du template (hero Pexels, banners Unsplash). */
function collectAllImageUrls(records) {
  const urls = [];
  // 1. Images des produits Airtable
  for (const rec of records) {
    const f = rec.fields || {};
    urls.push(...resolvePhotos(f));
  }
  // 2. Images d'illustration en dur : hero Pexels + banner Unsplash + editorial Unsplash
  urls.push(
    ILLUSTRATION_URLS.heroPexels,
    ILLUSTRATION_URLS.bannerUnsplash,
    ILLUSTRATION_URLS.editorialUnsplash
  );
  return urls;
}

/**
 * Retourne les chemins locaux pour une URL donnée, ou null si l'image n'a pas
 * pu être traitée (fallback sur l'URL d'origine). À appeler dans les fonctions
 * de rendu HTML après que processImagesBatch soit terminé.
 */
function localImageFor(url) {
  if (!url) return null;
  return imageRegistry.get(url) || null;
}

/* ==========================================================================
   8. RENDU DES CARDS PRODUIT
   ========================================================================== */

function renderProductCard(fields, isPriority, univ) {
  const nom = resolveName(fields);
  const ref = resolveRef(fields);
  const desc = resolveDesc(fields);
  const href = resolveHref(fields);
  const photos = resolvePhotos(fields);
  const hoverUrl = resolveHoverUrl(fields);
  const badge = resolveBadge(fields, 1);
  const badge2 = resolveBadge(fields, 2);

  if (!photos.length) return ''; // Pas de photo = pas de card

  const mainSrc = photos[0];
  const altBase = (nom || ref || 'Produit').trim();
  // Alt SEO-friendly : nom + catégorie + marque + (ref si dispo)
  const altMain = ref
    ? `${altBase} — Réf. ${ref} — ${univ.label} — Grossiste GIORGIA paris`
    : `${altBase} — ${univ.label} — Grossiste GIORGIA paris`;

  // Résolution des chemins locaux (fallback URL Airtable si échec du pipeline)
  const mainLocal = localImageFor(mainSrc);
  const mainDisplayUrl = mainLocal ? mainLocal.jpg : mainSrc;

  // Hover URL en version locale aussi (pour que l'effet survol utilise le JPEG local)
  const hoverLocal = hoverUrl ? localImageFor(hoverUrl) : null;
  const hoverDisplayUrl = hoverLocal ? hoverLocal.jpg : hoverUrl;
  const dataHover = hoverDisplayUrl && hoverDisplayUrl !== mainDisplayUrl
    ? ` data-hover-url="${esc(hoverDisplayUrl)}"` : '';

  const loading = isPriority ? 'eager' : 'lazy';
  const fetchprio = isPriority ? ' fetchpriority="high"' : '';
  const dims = mainLocal ? ` width="${mainLocal.width}" height="${mainLocal.height}"` : '';

  // URL WebP du hover (à passer en data-attribute pour que le JS puisse swap
  // à la fois le src JPEG ET le srcset WebP du <picture>).
  const hoverWebp = hoverLocal ? hoverLocal.webp : '';
  const dataHoverWebp = hoverWebp && hoverWebp !== (mainLocal && mainLocal.webp)
    ? ` data-hover-webp="${esc(hoverWebp)}"` : '';

  let h = '';
  h += `<a class="prod-card" target="_blank" rel="noopener noreferrer" href="${esc(href)}">`;
  h += `<div class="prod-media">`;
  h += `<div class="prod-img">`;

  // <picture> : WebP si supporté (~98% du trafic depuis 2021), JPEG sinon.
  // Le JS swap simultanément le srcset du <source> et le src du <img>
  // lorsqu'on change d'image (hover, clic vignette).
  h += `<picture>`;
  if (mainLocal) {
    h += `<source srcset="${esc(mainLocal.webp)}" type="image/webp">`;
  }
  h += `<img class="prod-img-primary" src="${esc(mainDisplayUrl)}" alt="${esc(altMain)}" loading="${loading}"${fetchprio} decoding="async"${dims}${dataHover}${dataHoverWebp}>`;
  h += `</picture>`;

  if (badge || badge2) {
    h += `<div class="prod-badges">`;
    if (badge) {
      const cls = /promo/i.test(badge) && !/nouvelle/i.test(badge)
        ? 'prod-badge prod-badge--promo' : 'prod-badge';
      h += `<div class="${cls}">${esc(badge)}</div>`;
    }
    if (badge2) h += `<div class="prod-badge2">${esc(badge2)}</div>`;
    h += `</div>`;
  }

  h += `<div class="prod-wm logo" aria-hidden="true"><span class="logo-g">GIORGIA</span><span class="logo-p">paris</span></div>`;
  h += `</div>`; // .prod-img

  if (photos.length > 1) {
    h += `<div class="prod-thumbs">`;
    photos.forEach((p, i) => {
      const cls = i === 0 ? 'prod-thumb is-active' : 'prod-thumb';
      const altThumb = `${altBase} — vue ${i + 1}`;
      const thumbLocal = localImageFor(p);
      // Pour les thumbnails, on sert l'image JPEG locale directement (pas de
      // <picture> ici car ce sont de petites images, le gain WebP est marginal
      // sur les vignettes 80×80px). On stocke aussi data-webp pour permettre
      // au JS de swap correctement le srcset du <picture> principal.
      const thumbSrc = thumbLocal ? thumbLocal.jpg : p;
      const thumbWebp = thumbLocal ? thumbLocal.jpg.replace(/\.jpg$/, '.webp') : '';
      const dataWebp = thumbWebp ? ` data-webp="${esc(thumbWebp)}"` : '';
      h += `<span class="${cls}" role="button" tabindex="0" aria-label="Voir la vue ${i + 1} de ${esc(altBase)}"${dataWebp}>`;
      h += `<img src="${esc(thumbSrc)}" alt="${esc(altThumb)}" loading="lazy" decoding="async">`;
      h += `</span>`;
    });
    h += `</div>`;
  }

  h += `</div>`; // .prod-media

  h += `<div class="prod-info">`;
  // H3 = nom produit SEUL (bon pour le SEO ; la référence passe sur une ligne à part)
  h += `<h3 class="prod-name">${esc(nom || '(Sans nom)')}</h3>`;
  if (ref) h += `<p class="prod-ref">Réf. ${esc(ref)}</p>`;
  if (desc) h += `<p class="prod-desc">${esc(desc)}</p>`;
  h += `</div>`;

  h += `</a>`;
  return h;
}

/* ==========================================================================
   8 bis. RENDU DE LA SECTION PRÉVENTES
   ==========================================================================
   Section spéciale rendue en HAUT de la home (après le hero, avant l'intro).
   Filtre les produits dont le champ Airtable « Prévente » est coché.
   Aucune limite stricte sur le nombre : le carrousel s'adapte dynamiquement.

   Identité visuelle : bande contrastée bleu pétrole + accent bordeaux mode.
   Badge spécial « PRÉVENTE » sur chaque card, visuel distinct des cards univers.
   ========================================================================== */

/**
 * Card produit version « Prévente » : structure très proche de renderProductCard
 * mais avec un badge dédié et une classe CSS qui permet le styling spécifique
 * (cadre clair sur fond sombre, badge bordeaux).
 */
function renderPreventeCard(fields, isPriority) {
  const nom = resolveName(fields);
  const ref = resolveRef(fields);
  const desc = resolveDesc(fields);
  const href = resolveHref(fields);
  const photos = resolvePhotos(fields);
  const hoverUrl = resolveHoverUrl(fields);

  if (!photos.length) return ''; // Pas de photo = pas de card

  const mainSrc = photos[0];
  const altBase = (nom || ref || 'Produit').trim();
  const altMain = ref
    ? `${altBase} — Réf. ${ref} — Prévente — Grossiste GIORGIA paris`
    : `${altBase} — Prévente — Grossiste GIORGIA paris`;

  const mainLocal = localImageFor(mainSrc);
  const mainDisplayUrl = mainLocal ? mainLocal.jpg : mainSrc;

  const hoverLocal = hoverUrl ? localImageFor(hoverUrl) : null;
  const hoverDisplayUrl = hoverLocal ? hoverLocal.jpg : hoverUrl;
  const dataHover = hoverDisplayUrl && hoverDisplayUrl !== mainDisplayUrl
    ? ` data-hover-url="${esc(hoverDisplayUrl)}"` : '';

  const hoverWebp = hoverLocal ? hoverLocal.webp : '';
  const dataHoverWebp = hoverWebp && hoverWebp !== (mainLocal && mainLocal.webp)
    ? ` data-hover-webp="${esc(hoverWebp)}"` : '';

  const loading = isPriority ? 'eager' : 'lazy';
  const fetchprio = isPriority ? ' fetchpriority="high"' : '';
  const dims = mainLocal ? ` width="${mainLocal.width}" height="${mainLocal.height}"` : '';

  let h = '';
  h += `<a class="prod-card prevente-card" target="_blank" rel="noopener noreferrer" href="${esc(href)}">`;
  h += `<div class="prod-media">`;
  h += `<div class="prod-img">`;

  h += `<picture>`;
  if (mainLocal) {
    h += `<source srcset="${esc(mainLocal.webp)}" type="image/webp">`;
  }
  h += `<img class="prod-img-primary" src="${esc(mainDisplayUrl)}" alt="${esc(altMain)}" loading="${loading}"${fetchprio} decoding="async"${dims}${dataHover}${dataHoverWebp}>`;
  h += `</picture>`;

  // Badge spécial PRÉVENTE (toujours présent, écrase la logique badge classique)
  h += `<div class="prod-badges">`;
  h += `<div class="prod-badge prod-badge--prevente">Prévente</div>`;
  h += `</div>`;

  h += `<div class="prod-wm logo" aria-hidden="true"><span class="logo-g">GIORGIA</span><span class="logo-p">paris</span></div>`;
  h += `</div>`; // .prod-img
  h += `</div>`; // .prod-media

  h += `<div class="prod-info">`;
  h += `<h3 class="prod-name">${esc(nom || '(Sans nom)')}</h3>`;
  if (ref) h += `<p class="prod-ref">Réf. ${esc(ref)}</p>`;
  if (desc) h += `<p class="prod-desc">${esc(desc)}</p>`;
  h += `</div>`;

  h += `</a>`;
  return h;
}

/**
 * Section Prévente complète : bande contrastée + en-tête + carrousel horizontal.
 * Si aucun produit n'est en prévente, renvoie une chaîne vide → la section
 * disparaît proprement de la page (pas de bande vide).
 */
function renderPreventeSection(records) {
  if (!records.length) return ''; // Aucune prévente cochée → on n'affiche rien

  let h = '';
  h += `<section class="prevente-sec" id="preventes" style="scroll-margin-top:130px" aria-labelledby="title-preventes">`;
  h += `<div class="prevente-inner">`;

  // En-tête
  h += `<div class="prevente-hdr">`;
  h += `<div class="prevente-hdr-text">`;
  h += `<span class="prevente-pill"><span class="prevente-dot"></span>Préventes — Stock disponible</span>`;
  h += `<h2 class="prevente-title" id="title-preventes">Découvrez nos dernières pièces sortie d&rsquo;usine en préventes !</h2>`;
  h += `<p class="prevente-sub">Pièces fraîchement sorties de l&rsquo;atelier — livraison immédiate depuis notre stock parisien.</p>`;
  h += `</div>`;
  h += `<a class="prevente-cta" href="https://wa.me/33686729311?text=${encodeURIComponent('Bonjour GIORGIA paris, je souhaite des informations sur les produits en prévente.')}" target="_blank" rel="noopener noreferrer">Commander sur WhatsApp →</a>`;
  h += `</div>`;

  // Carrousel — réutilise les classes existantes mais avec data-carousel="preventes"
  h += `<div class="carousel-outer" data-carousel="preventes">`;
  h += `<button class="car-btn car-btn-prev" aria-label="Produit précédent" onclick="carMove('preventes',-1)">&#8592;</button>`;
  h += `<button class="car-btn car-btn-next" aria-label="Produit suivant" onclick="carMove('preventes',1)">&#8594;</button>`;
  h += `<div class="carousel-clip">`;
  h += `<div class="carousel-track" id="track-preventes">`;
  h += `<div id="grid-preventes" class="catalog-grid-root">`;

  // Les 4 premières en priorité de chargement (au-dessus de la ligne de flottaison)
  records.forEach((rec, i) => {
    h += renderPreventeCard(rec.fields || {}, i < 4);
  });

  h += `</div>`; // grid
  h += `</div>`; // track
  h += `</div>`; // clip
  h += `<div class="car-dots" id="dots-preventes"></div>`;
  h += `</div>`; // carousel-outer

  h += `</div>`; // prevente-inner
  h += `</section>`;
  return h;
}

/* ==========================================================================
   8 ter. RENDU DE L'ENCART WHATSAPP « CATALOGUE ÉTENDU »
   ==========================================================================
   Encart éditorial inséré au milieu de la home, entre deux univers.
   Message clé : tous les produits ne sont pas en ligne → contact WhatsApp.
   ========================================================================== */

function renderWhatsAppCatalogue() {
  const waUrl =
    'https://wa.me/33686729311?text=' +
    encodeURIComponent('Bonjour GIORGIA paris, je souhaite découvrir le catalogue complet (modèles non visibles sur le site).');
  return [
    '<section class="wa-catalog" aria-labelledby="wa-catalog-title">',
    '<div class="wa-catalog-inner">',
    '<div class="wa-catalog-icon" aria-hidden="true">',
    // Icône WhatsApp en SVG inline (pas de dépendance externe)
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>',
    '</div>',
    '<div class="wa-catalog-text">',
    '<h3 id="wa-catalog-title">Tous nos modèles ne sont pas en ligne</h3>',
    '<p>Notre catalogue compte plus de références que ce qui est présenté ici. Contactez-nous sur WhatsApp pour découvrir l&rsquo;intégralité de la collection PE 2026.</p>',
    '</div>',
    `<a class="wa-catalog-cta" href="${waUrl}" target="_blank" rel="noopener noreferrer">Découvrir le catalogue complet</a>`,
    '</div>',
    '</section>',
  ].join('');
}

/* ==========================================================================
   9. RENDU DES SECTIONS UNIVERS + BANNERS ÉDITORIAUX
   ========================================================================== */

function renderUniversSection(univ, products) {
  let h = '';
  h += `<section class="univ-sec" id="${univ.id}" style="scroll-margin-top:130px" aria-labelledby="title-${univ.id}">`;
  h += `<div class="sec-hdr">`;
  h += `<div class="sec-line"></div>`;
  h += `<div class="sec-center">`;
  h += `<span class="sec-eye">GIORGIA paris — Collection Printemps-Été 2026</span>`;
  h += `<h2 class="sec-title" id="title-${univ.id}">${esc(univ.label)}</h2>`;
  h += `<span class="sec-sub">${esc(univ.sub)}</span>`;
  h += `<p class="sec-desc">${esc(univ.desc)}</p>`;
  h += `</div>`;
  h += `<div class="sec-line"></div>`;
  h += `</div>`;

  h += `<div class="carousel-outer" data-carousel="${univ.id}">`;
  h += `<button class="car-btn car-btn-prev" aria-label="Produit précédent" onclick="carMove('${univ.id}',-1)">&#8592;</button>`;
  h += `<button class="car-btn car-btn-next" aria-label="Produit suivant" onclick="carMove('${univ.id}',1)">&#8594;</button>`;
  h += `<div class="carousel-clip">`;

  if (!products.length) {
    h += `<p class="catalog-loading" role="status">Aucun produit dans cette catégorie pour le moment.</p>`;
  }

  h += `<div class="carousel-track" id="track-${univ.id}">`;
  h += `<div id="grid-${univ.id}" class="catalog-grid-root">`;

  // Priorité de chargement : 4 premières du premier univers home
  // (au-dessus de la ligne de flottaison sur la home).
  // NB : pour la page archive, on garde la même logique (premier univers archive).
  const priorityUnivId = univ.location === 'archive'
    ? (ARCHIVE_UNIVERS[0]?.id)
    : (HOME_UNIVERS[0]?.id);
  products.forEach((rec, i) => {
    const isPriority = (univ.id === priorityUnivId && i < 4);
    h += renderProductCard(rec.fields || {}, isPriority, univ);
  });

  h += `</div>`; // grid
  h += `</div>`; // track
  h += `</div>`; // clip
  h += `<div class="car-dots" id="dots-${univ.id}"></div>`;
  h += `</div>`; // carousel-outer

  h += `</section>`;
  return h;
}

function renderFeatBanner() {
  // Chemin local (JPEG) si dispo, sinon fallback sur l'URL Unsplash originale
  const local = localImageFor(ILLUSTRATION_URLS.bannerUnsplash);
  const bgUrl = local ? local.jpg : ILLUSTRATION_URLS.bannerUnsplash;
  return [
    '<div class="feat-banner">',
    `<div class="feat-bg" style="background-image:url('${esc(bgUrl)}')"></div>`,
    '<div class="feat-grad"></div>',
    '<div class="feat-content">',
    '<div class="logo"><span class="logo-g">GIORGIA</span><span class="logo-p">paris</span></div>',
    '<h3>Vêtir les boutiques<br>qui font la différence.</h3>',
    '<p>Des pièces sélectionnées pour leur potentiel commercial. Pour les boutiques qui refusent le stock dormant — et qui veulent des marges réelles.</p>',
    '<a class="btn-hero-p" href="#contact">Contacter notre équipe</a>',
    '</div>',
    '</div>',
  ].join('');
}

function renderEditorial() {
  const local = localImageFor(ILLUSTRATION_URLS.editorialUnsplash);
  // Balise <picture> pour bénéficier du WebP si dispo
  let imgHtml;
  if (local) {
    imgHtml =
      '<picture>' +
      `<source srcset="${esc(local.webp)}" type="image/webp">` +
      `<img src="${esc(local.jpg)}" width="${local.width}" height="${local.height}" alt="GIORGIA paris — Showroom parisien et collection Printemps-Été 2026" loading="lazy" decoding="async">` +
      '</picture>';
  } else {
    imgHtml = `<img src="${esc(ILLUSTRATION_URLS.editorialUnsplash)}" alt="GIORGIA paris — Showroom parisien et collection Printemps-Été 2026" loading="lazy" decoding="async">`;
  }
  return [
    '<div class="editorial">',
    '<div class="ed-img">',
    imgHtml,
    '</div>',
    '<div class="ed-txt">',
    '<div class="logo"><span class="logo-g">GIORGIA</span><span class="logo-p">paris</span></div>',
    '<span class="sec-eye">Grossiste B2B · Partenaire depuis 2007</span>',
    '<h2 class="sec-title" style="color:white">Votre stock.<br>Notre expertise.</h2>',
    '<p>Basé à Aubervilliers, au cœur du triangle d\u2019or du prêt-à-porter des grossistes parisiens, nous accompagnons les boutiques de mode partout en France et à l\u2019international.</p>',
    '<p>Rejoignez les centaines de revendeurs qui font confiance à GIORGIA paris chaque saison.</p>',
    '<a class="btn-ed" href="#contact">Devenir revendeur</a>',
    '</div>',
    '</div>',
  ].join('');
}

/* ==========================================================================
   10. RENDU DE LA NAVBAR & MENUS
   ========================================================================== */

/**
 * Navbar desktop.
 *
 * Structure :
 *   • Dropdown "Nos Univers" (hover/focus) contenant :
 *      - les univers `location: 'home'` (ancres vers la home)
 *      - un lien vers la page ancienne collection PE 2026
 *   • Tendances & Conseils Pro (page dédiée)
 *   • Qui sommes-nous (page notre-histoire — URL conservée pour SEO)
 *   • Contact (nouvelle page)
 *
 * Le paramètre `context` détermine si les liens univers vers la home
 * pointent vers une ancre (`#working`) — cas home — ou vers une URL absolue
 * vers la home suivie de l'ancre (`/#working`) — cas pages autres que home.
 */
function renderNavLinks(context = 'home') {
  const homeUrl = SITE_BASE ? `${SITE_BASE}/` : '/';
  const univHref = (id) => context === 'home' ? `#${id}` : `${homeUrl}#${id}`;

  const universSubLinks = HOME_UNIVERS.map(u =>
    `<li><a href="${univHref(u.id)}">${esc(u.label)}</a></li>`
  ).join('');
  const archiveSubLink = `<li><a href="${SITE_BASE}/${ARCHIVE_PAGE_SLUG}/">${esc(ARCHIVE_PAGE_TITLE)}</a></li>`;

  const universDropdown = [
    '<li class="nav-dropdown">',
    '<button type="button" class="nav-dropdown-toggle" aria-expanded="false" aria-haspopup="true">',
    'Nos Univers <span class="nav-dropdown-chev" aria-hidden="true">▾</span>',
    '</button>',
    '<ul class="nav-dropdown-menu" role="menu">',
    universSubLinks,
    archiveSubLink,
    '</ul>',
    '</li>',
  ].join('');

  const tendancesLink = `<li><a href="${SITE_BASE}/tendances-conseils-pro/">Tendances &amp; Conseils Pro</a></li>`;
  const quiLink       = `<li><a href="${SITE_BASE}/notre-histoire/">Qui sommes-nous</a></li>`;
  const contactLink   = `<li><a href="${SITE_BASE}/${CONTACT_PAGE_SLUG}/">Contact</a></li>`;

  return universDropdown + tendancesLink + quiLink + contactLink;
}

/**
 * Menu mobile — liste plate avec sous-titre "Nos Univers".
 * Choix (b) validé : tous les liens visibles direct dans le HTML rendu,
 * meilleur pour le SEO (pas d'interaction requise pour révéler les liens).
 */
function renderMobMenuLinks(context = 'home') {
  const homeUrl = SITE_BASE ? `${SITE_BASE}/` : '/';
  const univHref = (id) => context === 'home' ? `#${id}` : `${homeUrl}#${id}`;

  const universHeading = `<div class="mob-menu-heading">Nos Univers</div>`;
  const universSubLinks = HOME_UNIVERS.map(u =>
    `<a href="${univHref(u.id)}" onclick="closeMob()">${esc(u.label)}</a>`
  ).join('');
  const archiveSubLink = `<a href="${SITE_BASE}/${ARCHIVE_PAGE_SLUG}/" onclick="closeMob()">${esc(ARCHIVE_PAGE_TITLE)}</a>`;

  const separator = `<div class="mob-menu-sep" aria-hidden="true"></div>`;

  const tendancesLink = `<a href="${SITE_BASE}/tendances-conseils-pro/" onclick="closeMob()">Tendances &amp; Conseils Pro</a>`;
  const quiLink       = `<a href="${SITE_BASE}/notre-histoire/" onclick="closeMob()">Qui sommes-nous</a>`;
  const contactLink   = `<a href="${SITE_BASE}/${CONTACT_PAGE_SLUG}/" onclick="closeMob()">Contact</a>`;

  // CTA final "Commander" — pointe vers la section #contact de la home (conservée)
  // en contexte home, ou vers la page contact autonome depuis les autres pages.
  const commanderHref = context === 'home' ? '#contact' : `${SITE_BASE}/${CONTACT_PAGE_SLUG}/`;
  const commanderLink = `<a href="${commanderHref}" onclick="closeMob()" style="color:var(--gold)">Commander</a>`;

  return (
    universHeading +
    universSubLinks +
    archiveSubLink +
    separator +
    tendancesLink +
    quiLink +
    contactLink +
    commanderLink
  );
}

/**
 * Tabs univers (slider horizontal sous le hero, homepage uniquement).
 * On ne rend QUE les univers `location: 'home'` — Summer Vibes et Bohème
 * ont leur propre page dédiée.
 */
function renderUniversTabs() {
  return HOME_UNIVERS.map(u =>
    `<a href="#${u.id}" class="utab">${u.emoji} ${esc(u.label)}</a>`
  ).join('');
}

/**
 * Tabs univers pour la page archive — pointent vers les ancres archive.
 */
function renderArchiveUniversTabs() {
  return ARCHIVE_UNIVERS.map(u =>
    `<a href="#${u.id}" class="utab">${u.emoji} ${esc(u.label)}</a>`
  ).join('');
}

/* ==========================================================================
   11. DONNÉES STRUCTURÉES JSON-LD
   ========================================================================== */

function buildOrganizationLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WholesaleStore',
    '@id': `${SITE_ORIGIN}${SITE_BASE}/#organization`,
    name: 'GIORGIA paris',
    alternateName: 'Giorgia Paris',
    description: 'Grossiste en prêt-à-porter féminin basé à Aubervilliers, près de Paris. Collection Printemps-Été 2026, pièces tendances pour boutiques indépendantes. Minimum de commande 100€ HT.',
    url: `${SITE_ORIGIN}${SITE_BASE}/`,
    telephone: '+33686729311',
    email: 'giorgia93300@gmail.com',
    foundingDate: '2007',
    priceRange: '€€',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '70 rue de la Haie Coq',
      addressLocality: 'Aubervilliers',
      postalCode: '93300',
      addressRegion: 'Île-de-France',
      addressCountry: 'FR',
    },
    areaServed: ['FR', 'BE', 'LU', 'CH', 'IT', 'ES', 'DE', 'NL', 'GB', 'IE', 'PT', 'AT'],
    sameAs: [
      'https://instagram.com/giorgia.auber',
      'https://tiktok.com/@giorgia.paris56',
    ],
  };
}

function buildItemListLd(records) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Catalogue GIORGIA paris — Collection Printemps-Été 2026',
    description: 'Sélection de pièces prêt-à-porter féminin pour boutiques professionnelles.',
    numberOfItems: records.length,
    itemListElement: records.map((rec, i) => {
      const f = rec.fields || {};
      const nom = resolveName(f);
      const photos = resolvePhotos(f);
      const descRaw = resolveDesc(f);
      const ref = resolveRef(f);
      const cat = resolveCategorie(f);

      const product = {
        '@type': 'Product',
        name: nom || `Article ${ref || i + 1}`,
        brand: { '@type': 'Brand', name: 'GIORGIA paris' },
      };
      if (photos[0]) product.image = photos.slice(0, 3); // jusqu'à 3 images
      if (descRaw) product.description = descRaw.slice(0, 300); // cap à 300 car.
      if (ref) product.sku = ref;
      if (cat) product.category = cat;

      return {
        '@type': 'ListItem',
        position: i + 1,
        item: product,
      };
    }),
  };
}

function buildWebSiteLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_ORIGIN}${SITE_BASE}/#website`,
    url: `${SITE_ORIGIN}${SITE_BASE}/`,
    name: 'GIORGIA paris',
    description: 'Catalogue du grossiste prêt-à-porter féminin GIORGIA paris — Collection Printemps-Été 2026.',
    inLanguage: 'fr-FR',
    publisher: { '@id': `${SITE_ORIGIN}${SITE_BASE}/#organization` },
  };
}

/** Génère le <script type="application/ld+json"> complet (plusieurs objets). */
function renderJsonLd(records) {
  const graph = [buildOrganizationLd(), buildWebSiteLd(), buildItemListLd(records)];
  // Échappement </script> (sécurité parseur HTML)
  const safe = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2)
    .replace(/<\/script>/gi, '<\\/script>');
  return `<script type="application/ld+json">${safe}</script>`;
}

/* ==========================================================================
   12. ROBOTS.TXT & SITEMAP.XML
   ========================================================================== */

function renderRobotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    '',
    '# Autorise explicitement les grands crawlers',
    'User-agent: Googlebot',
    'Allow: /',
    '',
    'User-agent: Googlebot-Image',
    'Allow: /',
    '',
    'User-agent: Bingbot',
    'Allow: /',
    '',
    '# Bloquer les crawlers IA qui génèrent beaucoup de charge sans apporter de trafic',
    '# (décommenter si souhaité — laisse par défaut activé pour ne pas bloquer)',
    '# User-agent: GPTBot',
    '# Disallow: /',
    '',
    `Sitemap: ${SITE_ORIGIN}${SITE_BASE}/sitemap.xml`,
    '',
  ].join('\n');
}

function renderSitemapXml(now, articlesData = []) {
  const lastmod = now.toISOString().split('.')[0] + '+00:00';

  // URLs du site. La home est prioritaire (1.0, changefreq=weekly).
  // Les pages légales sont là pour le signal E-E-A-T et la conformité mais
  // ne sont pas des pages de destination marketing → priority 0.3, rarement
  // modifiées.
  const urls = [
    { loc: `${SITE_ORIGIN}${SITE_BASE}/`,                                       priority: '1.0', changefreq: 'weekly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/${ARCHIVE_PAGE_SLUG}/`,                  priority: '0.9', changefreq: 'weekly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/${CONTACT_PAGE_SLUG}/`,                  priority: '0.7', changefreq: 'monthly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/notre-histoire/`,                        priority: '0.6', changefreq: 'monthly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/mentions-legales/`,                      priority: '0.3', changefreq: 'yearly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/cgv/`,                                   priority: '0.3', changefreq: 'yearly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/confidentialite/`,                       priority: '0.3', changefreq: 'yearly' },
    { loc: `${SITE_ORIGIN}${SITE_BASE}/politique-retour/`,                      priority: '0.3', changefreq: 'yearly' },
  ];

  // Ajouter la page hub des articles si des articles existent
  if (articlesData.length > 0) {
    urls.push({
      loc: `${SITE_ORIGIN}${SITE_BASE}${ARTICLE_URL_PREFIX}/`,
      priority: '0.9',
      changefreq: 'monthly'
    });

    // Ajouter chaque article
    for (const article of articlesData) {
      urls.push({
        loc: `${SITE_ORIGIN}${SITE_BASE}${ARTICLE_URL_PREFIX}/${article.slug}/`,
        priority: '0.8',
        changefreq: 'weekly'
      });
    }
  }

  const body = urls.map(u => [
    '  <url>',
    `    <loc>${u.loc}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${u.changefreq}</changefreq>`,
    `    <priority>${u.priority}</priority>`,
    '  </url>',
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    body,
    '</urlset>',
    '',
  ].join('\n');
}

/* ==========================================================================
   13 bis. COPIE DES PAGES LÉGALES
   ==========================================================================
   Source : src/legal/ (4 fichiers HTML + 1 CSS partagé)
   Destination :
     - dist/legal/legal-styles.css           (CSS accessible à /legal/legal-styles.css)
     - dist/mentions-legales/index.html      (URL : /mentions-legales/)
     - dist/cgv/index.html                   (URL : /cgv/)
     - dist/confidentialite/index.html       (URL : /confidentialite/)
     - dist/politique-retour/index.html      (URL : /politique-retour/)

   Le mapping est volontaire : le nom de fichier source (ex.
   "politique-confidentialite.html") n'est PAS l'URL finale (qui sera
   "/confidentialite/") pour des raisons SEO et de lisibilité.
*/

// Mapping : nom du fichier source → nom du dossier de sortie (= URL)
const LEGAL_PAGES_MAP = {
  'mentions-legales.html':         'mentions-legales',
  'cgv.html':                      'cgv',
  'politique-confidentialite.html':'confidentialite',
  'politique-retour.html':         'politique-retour',
};

async function copyLegalPages() {
  const srcDir = resolve('src/legal');

  // Vérifier que le dossier existe (il peut manquer si tu n'as pas encore
  // déposé les fichiers — dans ce cas on skip sans crasher le build).
  try {
    await stat(srcDir);
  } catch {
    console.warn('⚠ src/legal/ introuvable — pages légales non déployées.');
    console.warn('  Pour les activer, déposez les 4 HTML + le CSS dans src/legal/.');
    return { deployed: false };
  }

  // 1. Copier la CSS partagée vers dist/legal/ (CSS = pas de transformation
  // d'URL nécessaire, on copie tel quel)
  const cssSrc = join(srcDir, 'legal-styles.css');
  const cssDstDir = resolve(OUTPUT_DIR, 'legal');
  const cssDst = join(cssDstDir, 'legal-styles.css');
  try {
    await stat(cssSrc);
    await mkdir(cssDstDir, { recursive: true });
    await copyFile(cssSrc, cssDst);
    console.log(`  • CSS → ${SITE_BASE}/legal/legal-styles.css`);
  } catch {
    console.warn('  ⚠ legal-styles.css manquant dans src/legal/');
  }

  // 2. Copier chaque page HTML dans son dossier dédié, EN PRÉFIXANT les
  // liens internes par SITE_BASE. Ainsi la même source HTML fonctionne
  // en prod (SITE_BASE='') et en qualif (SITE_BASE='/giorgia-paris-vitrinePE2026').
  const deployedPages = [];
  for (const [srcFile, outFolder] of Object.entries(LEGAL_PAGES_MAP)) {
    const srcPath = join(srcDir, srcFile);
    try {
      await stat(srcPath);
    } catch {
      console.warn(`  ⚠ ${srcFile} manquant dans src/legal/ — page /${outFolder}/ non déployée.`);
      continue;
    }
    const outDir = resolve(OUTPUT_DIR, outFolder);
    const outPath = join(outDir, 'index.html');
    await mkdir(outDir, { recursive: true });

    // Lecture + transformation des URLs internes
    let html = await readFile(srcPath, 'utf8');
    html = applyBasePathToHtml(html);

    await writeFile(outPath, html, 'utf8');
    deployedPages.push(outFolder);
    console.log(`  • ${srcFile} → ${SITE_BASE}/${outFolder}/`);
  }

  return { deployed: true, pages: deployedPages };
}

/**
 * Transforme les URLs internes absolues (commençant par '/') en y ajoutant
 * SITE_BASE. À utiliser sur les pages légales avant de les écrire dans dist/.
 *
 * Exemples (avec SITE_BASE='/giorgia-paris-vitrinePE2026') :
 *   href="/"                          → href="/giorgia-paris-vitrinePE2026/"
 *   href="/cgv/"                      → href="/giorgia-paris-vitrinePE2026/cgv/"
 *   href="/legal/legal-styles.css"    → href="/giorgia-paris-vitrinePE2026/legal/legal-styles.css"
 *   href="https://example.com/x"      → inchangé (pas '/' en tête)
 *   href="mailto:..."                 → inchangé
 *   href="#anchor"                    → inchangé
 *
 * En prod, SITE_BASE='' donc cette fonction est un no-op.
 */
function applyBasePathToHtml(html) {
  if (!SITE_BASE) return html; // Prod : aucune transformation
  // On match : href="/..." ou src="/..."  où le / suit immédiatement le ".
  // Lookbehind exclu pour éviter '//' (URLs protocole-relative type //cdn.example.com).
  return html.replace(/(\bhref|\bsrc)="\/(?!\/)/g, `$1="${SITE_BASE}/`);
}

/* ==========================================================================
   13. AUDIT DU POIDS DES IMAGES (inchangé)
   ========================================================================== */

function collectImageUrls(records) {
  const items = [];
  for (const rec of records) {
    const f = rec.fields || {};
    const ref = f.Reference || f.Référence || f.REF || rec.id;
    const nom = f.Nom || f.Name || f.Produit || '';
    for (const [key, value] of Object.entries(f)) {
      if (!Array.isArray(value)) continue;
      for (const att of value) {
        if (!att || typeof att !== 'object') continue;
        const url = att?.thumbnails?.large?.url || att.url;
        if (url) items.push({ ref, nom, field: key, url });
      }
    }
  }
  return items;
}

async function measureUrl(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return null;
    const len = res.headers.get('content-length');
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

async function measureAll(items, concurrency = 8) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const size = await measureUrl(items[i].url);
      results[i] = { ...items[i], sizeBytes: size };
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function fmtKB(bytes) {
  if (bytes == null) return '   ? KB';
  return (bytes / 1024).toFixed(0).padStart(4) + ' KB';
}

async function auditImageWeights(records) {
  console.log('→ Audit du poids des images (thumbnails.large)…');
  const items = collectImageUrls(records);
  console.log(`  ${items.length} images à mesurer.`);

  const measured = await measureAll(items, 8);
  const sized = measured.filter(m => typeof m.sizeBytes === 'number');
  const failed = measured.length - sized.length;

  sized.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const totalKB = sized.reduce((s, m) => s + m.sizeBytes, 0) / 1024;
  const avgKB = sized.length ? totalKB / sized.length : 0;

  console.log(`✓ Mesurées : ${sized.length}/${items.length}` +
              (failed ? ` (${failed} échecs)` : '') + '.');
  console.log(`  Poids total : ${totalKB.toFixed(0)} KB — moyenne : ${avgKB.toFixed(0)} KB/image.`);

  const heavy = sized.filter(m => m.sizeBytes > 300 * 1024);
  if (heavy.length) {
    console.log(`⚠ ${heavy.length} images > 300 KB à compresser dans Airtable :`);
    for (const m of heavy.slice(0, 20)) {
      const who = [m.ref, m.nom].filter(Boolean).join(' — ') || '(sans ref)';
      console.log(`    ${fmtKB(m.sizeBytes)}  [${m.field}]  ${who}`);
    }
    if (heavy.length > 20) console.log(`    … et ${heavy.length - 20} autres.`);
  } else {
    console.log('✓ Aucune image > 300 KB. Catalogue bien optimisé.');
  }

  console.log('  Top 10 des images les plus lourdes :');
  for (const m of sized.slice(0, 10)) {
    const who = [m.ref, m.nom].filter(Boolean).join(' — ') || '(sans ref)';
    console.log(`    ${fmtKB(m.sizeBytes)}  [${m.field}]  ${who}`);
  }

  return {
    totalImages: items.length,
    measured: sized.length,
    totalKB: Math.round(totalKB),
    avgKB: Math.round(avgKB),
    heavyCount: heavy.length,
    top20Heavy: heavy.slice(0, 20).map(m => ({
      ref: m.ref, nom: m.nom, field: m.field,
      sizeKB: Math.round(m.sizeBytes / 1024), url: m.url,
    })),
  };
}

/* ==========================================================================
   13 ter. PIPELINE ARTICLES — "Tendances & Conseils Pro"
   ==========================================================================
   Source : src/articles/*.md  (front-matter YAML + corps Markdown)
            src/articles/article-template.html
            src/articles/articles-styles.css
            src/articles/img/<hero>.jpg

   Destination :
     - dist/tendances-conseils-pro/articles-styles.css
     - dist/tendances-conseils-pro/<slug>/index.html  (1 par article)
     - Hero images traitées via le pipeline d'images (JPEG + WebP, compressé)

   Le matching avec le catalogue Airtable se fait par RÉFÉRENCE en priorité
   (champ Reference / Référence) puis par NOM (avec normalisation accents/casse).
   Si un produit cité dans l'article n'est pas trouvé : warning, l'article est
   tout de même rendu mais sans cette card (au lieu de planter le build).
   ========================================================================== */

const ARTICLES_SRC_DIR = resolve('src/articles');
const ARTICLES_OUTPUT_DIR = resolve(OUTPUT_DIR, 'tendances-conseils-pro');
const ARTICLE_URL_PREFIX = '/tendances-conseils-pro';

/**
 * Construit un index des produits Airtable pour matching rapide.
 * Retourne { byRef: Map, byName: Map } où :
 *   - byRef indexe les produits par référence normalisée (ex. "26359")
 *   - byName indexe par nom normalisé (sans accents, lowercase, espaces collapsés)
 */
function buildProductIndex(records) {
  const byRef = new Map();
  const byName = new Map();
  for (const rec of records) {
    const f = rec.fields || {};
    const ref = resolveRef(f);
    const nom = resolveName(f);
    if (ref) {
      const k = String(ref).trim().toLowerCase();
      if (!byRef.has(k)) byRef.set(k, rec);
    }
    if (nom) {
      const k = normalizeKey(nom);
      if (!byName.has(k)) byName.set(k, rec);
    }
  }
  return { byRef, byName };
}

/**
 * Résout un produit cité dans le front-matter en cherchant dans l'index Airtable.
 * Accepte deux formats :
 *   - chaîne simple : "26393"  (format utilisé dans nos articles .md)
 *   - objet         : { reference: "26393" } ou { nom: "Robe satin" }
 * Référence prioritaire, fallback nom.
 */
function resolveSelectionProduct(productCite, index) {
  // Support des chaînes simples ("26393") en plus des objets ({reference, nom})
  if (typeof productCite === 'string') {
    const ref = productCite.trim().toLowerCase();
    if (ref && index.byRef.has(ref)) return index.byRef.get(ref);
    // Fallback : essayer comme nom
    const key = normalizeKey(productCite.trim());
    if (index.byName.has(key)) return index.byName.get(key);
    return null;
  }

  const ref = productCite.reference ? String(productCite.reference).trim().toLowerCase() : '';
  const nom = productCite.nom ? String(productCite.nom).trim() : '';

  if (ref && index.byRef.has(ref)) {
    return index.byRef.get(ref);
  }
  if (nom) {
    const key = normalizeKey(nom);
    if (index.byName.has(key)) {
      return index.byName.get(key);
    }
  }
  return null;
}

/**
 * Card produit dans le carrousel "Sélection GIORGIA".
 * Reproduit la structure de renderPreventeCard mais avec la classe selection-card
 * et une badge "Pack de 6" à la place de "Prévente".
 */
function renderSelectionCard(fields, isPriority) {
  const nom = resolveName(fields);
  const ref = resolveRef(fields);
  const desc = resolveDesc(fields);
  const href = resolveHref(fields);
  const photos = resolvePhotos(fields);

  if (!photos.length) return '';

  const mainSrc = photos[0];
  const altBase = (nom || ref || 'Produit').trim();
  const altMain = ref
    ? `${altBase} — Réf. ${ref} — Sélection GIORGIA — Grossiste GIORGIA paris`
    : `${altBase} — Sélection GIORGIA — Grossiste GIORGIA paris`;

  const mainLocal = localImageFor(mainSrc);
  const mainDisplayUrl = mainLocal ? mainLocal.jpg : mainSrc;

  const loading = isPriority ? 'eager' : 'lazy';
  const fetchprio = isPriority ? ' fetchpriority="high"' : '';
  const dims = mainLocal ? ` width="${mainLocal.width}" height="${mainLocal.height}"` : '';

  let h = '';
  h += `<a class="selection-card" target="_blank" rel="noopener noreferrer" href="${esc(href)}">`;
  h += `<div class="prod-media">`;
  h += `<div class="prod-img">`;

  h += `<picture>`;
  if (mainLocal) {
    h += `<source srcset="${esc(mainLocal.webp)}" type="image/webp">`;
  }
  h += `<img src="${esc(mainDisplayUrl)}" alt="${esc(altMain)}" loading="${loading}"${fetchprio} decoding="async"${dims}>`;
  h += `</picture>`;

  h += `<div class="prod-badges">`;
  h += `<div class="prod-badge">Pack de 6</div>`;
  h += `</div>`;

  h += `<div class="prod-wm logo" aria-hidden="true"><span class="logo-g">GIORGIA</span><span class="logo-p">paris</span></div>`;
  h += `</div>`; // .prod-img
  h += `</div>`; // .prod-media

  h += `<div class="prod-info">`;
  h += `<h3 class="prod-name">${esc(nom || '(Sans nom)')}</h3>`;
  if (ref) h += `<p class="prod-ref">Réf. ${esc(ref)}</p>`;
  if (desc) h += `<p class="prod-desc">${esc(desc)}</p>`;
  h += `</div>`;

  h += `</a>`;
  return h;
}

/**
 * Section "Sélection GIORGIA" complète : bande crème/charcoal + titre signature
 * + intro + carrousel horizontal des produits sélectionnés.
 */
function renderSelectionSection(article, products) {
  if (!products.length) return ''; // Aucun produit résolu → on n'affiche pas la section

  // ID unique du carrousel basé sur le slug (au cas où un jour on aurait
  // plusieurs sélections sur la même page)
  const carouselId = 'sel-' + article.slug;

  const waMessage = `Bonjour GIORGIA paris, je souhaite des conseils sur ${article.selection_titre || 'votre sélection ' + (article.title || '')}.`;
  const waUrl = `https://wa.me/33686729311?text=${encodeURIComponent(waMessage)}`;

  let h = '';
  h += `<section class="selection-sec" aria-labelledby="title-${carouselId}">`;
  h += `<div class="selection-inner">`;

  // En-tête
  h += `<div class="selection-hdr">`;
  h += `<div class="selection-hdr-text">`;
  h += `<span class="selection-pill"><span class="selection-dot"></span>Sélection grossiste · Stock parisien</span>`;
  h += `<h2 class="selection-title" id="title-${carouselId}">${esc(article.selection_titre || 'La sélection GIORGIA — disponible en pack de 6')}</h2>`;
  if (article.selection_intro) {
    h += `<p class="selection-sub">${esc(article.selection_intro)}</p>`;
  }
  h += `</div>`;
  h += `<a class="selection-cta" href="${esc(waUrl)}" target="_blank" rel="noopener noreferrer">Commander sur WhatsApp →</a>`;
  h += `</div>`;

  // Carrousel
  h += `<div class="carousel-outer" data-carousel="${esc(carouselId)}">`;
  h += `<button class="car-btn car-btn-prev" aria-label="Produit précédent" onclick="carMove('${esc(carouselId)}',-1)">&#8592;</button>`;
  h += `<button class="car-btn car-btn-next" aria-label="Produit suivant" onclick="carMove('${esc(carouselId)}',1)">&#8594;</button>`;
  h += `<div class="carousel-clip">`;
  h += `<div class="carousel-track" id="track-${esc(carouselId)}">`;
  h += `<div id="grid-${esc(carouselId)}" class="catalog-grid-root">`;

  // Les 4 premières images en priorité de chargement
  products.forEach((rec, i) => {
    h += renderSelectionCard(rec.fields || {}, i < 4);
  });

  h += `</div>`; // grid
  h += `</div>`; // track
  h += `</div>`; // clip
  h += `<div class="car-dots" id="dots-${esc(carouselId)}"></div>`;
  h += `</div>`; // carousel-outer

  h += `</div>`; // selection-inner
  h += `</section>`;
  return h;
}

/**
 * Formate une date ISO (2026-05-04) en libellé FR ("4 mai 2026").
 */
function formatArticleDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const mois = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
    return `${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return iso;
  }
}

/**
 * Lit un fichier .md, parse son front-matter et son corps markdown.
 * Retourne un objet article enrichi.
 * 
 * Si le slug n'est pas défini dans le front-matter, il est auto-généré
 * à partir du nom du fichier (ex: pois-printemps-ete-2026.md → slug pois-printemps-ete-2026)
 */
async function loadArticleFromFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const fileName = filePath.split('/').pop();
  
  console.log(`\n  📄 Parsing ${fileName}…`);
  console.log(`     Taille du fichier brut : ${raw.length} chars`);
  
  const parsed = matter(raw);
  const fm = parsed.data || {};
  
  console.log(`     ✓ Front-matter keys détectées : ${Object.keys(fm).join(', ')}`);
  console.log(`     ✓ Contenu markdown brut : ${parsed.content.length} chars`);
  
  // NOTE : le carrousel sera injecté dans renderArticlePage après la résolution des produits
  // Ici on stocke juste le contenu markdown tel quel
  let markdownContent = parsed.content || '';
  
  const contentHtml = marked.parse(markdownContent, {
    headerIds: false,
    mangle: false,
  });
  
  console.log(`     ✓ HTML rendu : ${contentHtml.length} chars`);
  if (contentHtml.length < 200) {
    console.log(`     ⚠️  HTML très court (preview) : ${contentHtml.slice(0, 100)}`);
  } else {
    console.log(`     ✓ HTML preview : ${contentHtml.slice(0, 150)}...`);
  }

  // Auto-génération du slug à partir du nom du fichier si absent
  let slug = fm.slug || '';
  if (!slug) {
    slug = fileName.replace(/\.md$/i, '');
    console.log(`     ℹ️  Slug auto-généré depuis le nom du fichier : ${slug}`);
  } else {
    console.log(`     ✓ Slug du front-matter : ${slug}`);
  }

  const article = {
    slug,
    title: fm.title || '',
    meta_title: fm.meta_title || fm.title || '',
    meta_description: fm.meta_description || '',
    chapo: fm.chapo || '',
    categorie: fm.categorie || '',
    date_publication: fm.date_publication || '',
    auteur: fm.auteur || 'GIORGIA paris',
    hero_image: fm.hero_image || '',
    hero_image_alt: fm.hero_image_alt || fm.title || '',
    selection_titre: fm.selection_titre || '',
    selection_intro: fm.selection_intro || '',
    selection_produits: Array.isArray(fm.selection_produits) ? fm.selection_produits : [],
    mots_cles_seo: Array.isArray(fm.mots_cles_seo) ? fm.mots_cles_seo : [],
    contentHtml,
    sourcePath: filePath,
  };
  
  console.log(`     ✓ Article chargé : titre="${article.title.slice(0, 50)}..."`);
  console.log(`     ✓ Selection produits : ${article.selection_produits.length} items`);
  
  return article;
}

/**
 * Rend une page article complète à partir du template + de l'article + des
 * produits Airtable résolus. Écrit dist/tendances-conseils-pro/<slug>/index.html.
 */
async function renderArticlePage(article, productIndex, allRecords) {
  if (!article.slug) {
    console.warn(`  ⚠ Article ${article.sourcePath} sans slug — ignoré.`);
    return null;
  }

  console.log(`\n  🎨 Rendu de la page article "${article.slug}"…`);

  // Résolution des produits cités dans selection_produits
  const resolvedProducts = [];
  const missing = [];
  for (const cite of article.selection_produits) {
    const rec = resolveSelectionProduct(cite, productIndex);
    if (rec) {
      resolvedProducts.push(rec);
    } else {
      const label = cite.reference ? `réf. ${cite.reference}` : cite.nom || '(?)';
      missing.push(label);
    }
  }
  if (missing.length) {
    console.warn(`     ⚠ Produits non trouvés dans Airtable : ${missing.join(', ')}`);
  }
  console.log(`     ✓ Produits résolus : ${resolvedProducts.length}/${article.selection_produits.length}`);

  // Section sélection GIORGIA
  const selectionHtml = renderSelectionSection(article, resolvedProducts);
  console.log(`     ✓ Section sélection rendue : ${selectionHtml.length} chars`);

  // Image hero : copiée et compressée via le pipeline d'images
  let heroImageUrl = '';
  if (article.hero_image) {
    const heroSrcPath = resolve(ARTICLES_SRC_DIR, 'img', article.hero_image);
    try {
      await stat(heroSrcPath);
      console.log(`     ✓ Image hero trouvée : ${article.hero_image}`);
      // Génère un chemin de sortie dans dist/img/articles/ (réutilise le pipeline)
      const heroOutDir = resolve(IMG_OUTPUT_DIR, 'articles');
      await mkdir(heroOutDir, { recursive: true });
      const heroOutJpg = join(heroOutDir, article.hero_image);
      const heroOutWebp = heroOutJpg.replace(/\.(jpe?g|png)$/i, '.webp');

      // Compression via sharp (mêmes paramètres que le pipeline principal)
      const buffer = await readFile(heroSrcPath);
      const img = sharp(buffer).rotate();
      const meta = await img.metadata();
      const targetWidth = meta.width && meta.width > IMG_MAX_WIDTH ? IMG_MAX_WIDTH : meta.width;

      await img.clone().resize({ width: targetWidth, withoutEnlargement: true })
        .jpeg({ quality: IMG_JPEG_QUALITY, mozjpeg: true })
        .toFile(heroOutJpg);
      await img.clone().resize({ width: targetWidth, withoutEnlargement: true })
        .webp({ quality: IMG_WEBP_QUALITY })
        .toFile(heroOutWebp);

      heroImageUrl = `${SITE_BASE}/img/articles/${article.hero_image}`;
      console.log(`     ✓ Hero compressée et servie depuis : ${heroImageUrl}`);
    } catch (err) {
      console.warn(`     ⚠ Hero image manquante : ${article.hero_image} (${err.message})`);
      // Fallback : 1ère photo du 1er produit résolu
      if (resolvedProducts.length) {
        const firstPhotos = resolvePhotos(resolvedProducts[0].fields || {});
        if (firstPhotos[0]) {
          const local = localImageFor(firstPhotos[0]);
          heroImageUrl = local ? local.jpg : firstPhotos[0];
          console.log(`     ℹ️  Fallback : photo du 1er produit`);
        }
      }
    }
  } else if (resolvedProducts.length) {
    // Pas de hero spécifié : fallback automatique sur la photo du 1er produit
    const firstPhotos = resolvePhotos(resolvedProducts[0].fields || {});
    if (firstPhotos[0]) {
      const local = localImageFor(firstPhotos[0]);
      heroImageUrl = local ? local.jpg : firstPhotos[0];
      console.log(`     ℹ️  Pas de hero custom, fallback : photo du 1er produit`);
    }
  }

  // URL canonique de l'article
  const articleUrl = `${SITE_ORIGIN}${SITE_BASE}${ARTICLE_URL_PREFIX}/${article.slug}/`;

  // CTA WhatsApp pré-rempli (différent du CTA catalogue : on track les leads "blog")
  const waMessage = `Bonjour GIORGIA paris, je souhaite des conseils sur "${article.title}".`;
  const waCtaUrl = `https://wa.me/33686729311?text=${encodeURIComponent(waMessage)}`;

  // Lecture du template article
  const templatePath = resolve('src/articles/article-template.html');
  let html = await readFile(templatePath, 'utf8');
  
  console.log(`     ✓ Template HTML chargé : ${html.length} chars`);

  // =========================================================================
  //  INJECTION DU CARROUSEL DANS LE CONTENU HTML
  // =========================================================================
  //  Le carrousel remplace le placeholder <!-- SELECTION_GIORGIA_SECTION -->
  //  qui a été placé par l'utilisateur dans le markdown de l'article.
  //  Vu que marked() a déjà rendu le markdown en HTML, les balises HTML du
  //  carrousel s'injectent directement (pas de double-échappement).
  // =========================================================================
  let contentHtml = article.contentHtml;
  if (contentHtml.includes('<!-- SELECTION_GIORGIA_SECTION -->')) {
    contentHtml = contentHtml.replace('<!-- SELECTION_GIORGIA_SECTION -->', selectionHtml);
    console.log(`     ✓ Carrousel injecté dans le contenu HTML`);
  } else if (selectionHtml.length > 0) {
    console.log(`     ⚠ Placeholder <!-- SELECTION_GIORGIA_SECTION --> non trouvé dans le markdown`);
  }

  // Générer les schemas JSON-LD
  const articleSchema = generateArticleSchema({ ...article, contentHtml }, heroImageUrl);
  const breadcrumbSchema = generateBreadcrumbSchema(article);
  const jsonLdScripts = `    <script type="application/ld+json">
${JSON.stringify(articleSchema, null, 2)}
    </script>
    <script type="application/ld+json">
${JSON.stringify(breadcrumbSchema, null, 2)}
    </script>`;

  console.log(`     ✓ Schemas JSON-LD générés (Article + BreadcrumbList)`);

  // Substitutions
  const replacements = [
    ['<!-- META_TITLE -->', esc(article.meta_title)],
    ['<!-- META_DESCRIPTION -->', esc(article.meta_description)],
    ['<!-- ARTICLE_URL -->', articleUrl],
    ['<!-- ARTICLE_TITLE -->', esc(article.title)],
    ['<!-- ARTICLE_CHAPO -->', esc(article.chapo)],
    ['<!-- ARTICLE_CATEGORIE -->', esc(article.categorie)],
    ['<!-- ARTICLE_DATE -->', esc(formatArticleDate(article.date_publication))],
    ['<!-- ARTICLE_AUTEUR -->', esc(article.auteur)],
    ['<!-- ARTICLE_CONTENT -->', contentHtml],  // contentHtml avec le carrousel injecté
    ['<!-- HERO_IMAGE_URL -->', heroImageUrl || ''],
    ['<!-- WHATSAPP_CTA_URL -->', waCtaUrl],
    ['<!-- SITE_BASE -->', SITE_BASE],
    ['<!-- SITE_ORIGIN -->', SITE_ORIGIN],
    ['<!-- ARTICLE_SCHEMAS -->', jsonLdScripts],  // Injection des schemas JSON-LD
  ];

  console.log(`     ✓ Substitutions à faire : ${replacements.length}`);
  console.log(`     ✓ Contenu article HTML final à injecter : ${contentHtml.length} chars`);
  if (contentHtml.length < 200) {
    console.log(`     ⚠️  Article HTML très court (${contentHtml.length} chars)`);
    console.log(`        Preview : ${contentHtml.slice(0, 300)}`);
  }

  for (const [ph, val] of replacements) {
    // Remplacement global pour SITE_BASE / SITE_ORIGIN / HERO_IMAGE_URL
    // (apparaissent plusieurs fois dans le template)
    html = html.split(ph).join(val);
  }

  // Écriture
  const outDir = resolve(ARTICLES_OUTPUT_DIR, article.slug);
  const outPath = resolve(outDir, 'index.html');
  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, html, 'utf8');

  console.log(`     ✓ Page écrite : ${SITE_BASE}${ARTICLE_URL_PREFIX}/${article.slug}/ (${html.length} bytes)`);

  return {
    slug: article.slug,
    title: article.title,
    chapo: article.chapo,
    categorie: article.categorie || 'Non catégorisé',
    date_publication: article.date_publication,
    hero_image_url: heroImageUrl,
    url: articleUrl,
    productsResolved: resolvedProducts.length,
    productsMissing: missing.length,
  };
}

/**
 * Génère un fichier JSON avec les 3 derniers articles
 * Utilisé par la home page pour afficher le carrousel "À lire aussi"
 */
async function generateLatestArticlesJson(generatedArticles) {
  if (!generatedArticles || generatedArticles.length === 0) {
    return { deployed: false };
  }

  // Trier par date DESC et prendre les 3 premiers
  const latest3 = generatedArticles
    .sort((a, b) => {
      const dateA = a.date_publication ? new Date(a.date_publication) : new Date(0);
      const dateB = b.date_publication ? new Date(b.date_publication) : new Date(0);
      return dateB - dateA;
    })
    .slice(0, 3)
    .map(article => ({
      slug: article.slug,
      title: article.title,
      chapo: article.chapo,
      date_publication: article.date_publication,
      hero_image_url: article.hero_image_url || `${SITE_BASE}/img/placeholder.jpg`,
    }));

  // Écrire le fichier JSON
  const apiDir = resolve(OUTPUT_DIR, 'api');
  await mkdir(apiDir, { recursive: true });
  const jsonFile = join(apiDir, 'latest-articles.json');
  
  await writeFile(jsonFile, JSON.stringify({ articles: latest3 }, null, 2), 'utf8');
  
  console.log(`  ✓ JSON généré : /api/latest-articles.json (${latest3.length} articles)`);
  return { deployed: true, count: latest3.length };
}

/**
 * Pipeline complète : lit tous les .md, copie le CSS, génère les pages.
 * Appelé depuis main() après le rendu de la home.
 */
async function buildArticles(allRecords) {
  // Vérifier que le dossier source existe
  try {
    await stat(ARTICLES_SRC_DIR);
  } catch {
    console.warn('⚠ src/articles/ introuvable — section Tendances & Conseils Pro non déployée.');
    return { deployed: false, count: 0 };
  }

  console.log('→ Pipeline articles "Tendances & Conseils Pro"…');

  // 1. Copier le CSS partagé vers dist/tendances-conseils-pro/
  const cssSrc = join(ARTICLES_SRC_DIR, 'articles-styles.css');
  const cssDst = join(ARTICLES_OUTPUT_DIR, 'articles-styles.css');
  try {
    await stat(cssSrc);
    await mkdir(ARTICLES_OUTPUT_DIR, { recursive: true });
    await copyFile(cssSrc, cssDst);
    console.log(`  • CSS → ${SITE_BASE}${ARTICLE_URL_PREFIX}/articles-styles.css`);
  } catch {
    console.warn('  ⚠ articles-styles.css manquant dans src/articles/');
  }

  // 2. Index Airtable pour matching produits
  const productIndex = buildProductIndex(allRecords);

  // 3. Lister tous les .md dans src/articles/ (hors sous-dossiers img/, etc.)
  const allFiles = await readdir(ARTICLES_SRC_DIR);
  const mdFiles = allFiles.filter(f => f.endsWith('.md'));

  if (mdFiles.length === 0) {
    console.warn('  ⚠ Aucun fichier .md trouvé dans src/articles/');
    return { deployed: false, count: 0 };
  }

  console.log(`  ${mdFiles.length} article(s) à générer.`);

  // 4. Générer chaque page article
  const generatedArticles = [];
  for (const file of mdFiles) {
    const filePath = join(ARTICLES_SRC_DIR, file);
    try {
      const article = await loadArticleFromFile(filePath);
      const result = await renderArticlePage(article, productIndex, allRecords);
      if (result) {
        generatedArticles.push(result);
        console.log(`  • ${file} → ${SITE_BASE}${ARTICLE_URL_PREFIX}/${result.slug}/ (${result.productsResolved} produits)`);
      }
    } catch (err) {
      console.error(`  ✖ Échec du rendu de ${file} :`, err.message);
    }
  }

  return { deployed: true, count: generatedArticles.length, articles: generatedArticles };
}

/**
 * Génère la page index `/tendances-conseils-pro/index.html`
 * Affiche tous les articles avec filtres par catégorie et pagination.
 */
async function buildArticlesIndex(generatedArticles) {
  if (!generatedArticles || generatedArticles.length === 0) {
    console.warn('  ⚠ Aucun article à indexer — page hub non déployée.');
    return { deployed: false };
  }

  console.log('→ Génération de la page hub `/tendances-conseils-pro/`…');

  // Lire le template hub
  const templatePath = resolve('src/articles/index-template.html');
  let hubHtml;
  try {
    hubHtml = await readFile(templatePath, 'utf8');
  } catch (err) {
    console.error(`  ✖ Template hub introuvable : ${templatePath}`);
    return { deployed: false };
  }

  // Extraire les catégories uniques et les trier
  const categories = new Set(generatedArticles.map(a => a.categorie).filter(Boolean));
  const sortedCategories = Array.from(categories).sort();

  // Générer les boutons de filtre
  let filterButtonsHtml = '';
  for (const cat of sortedCategories) {
    const filterValue = cat.toLowerCase().replace(/\s+/g, '-');
    filterButtonsHtml += `<button class="hub-filter-btn" data-filter="${esc(filterValue)}">${esc(cat)}</button>\n          `;
  }

  // Trier les articles par date de publication décroissante (plus récent en premier)
  const sortedArticles = generatedArticles.slice().sort((a, b) => {
    const dateA = a.date_publication ? new Date(a.date_publication) : new Date(0);
    const dateB = b.date_publication ? new Date(b.date_publication) : new Date(0);
    return dateB - dateA;
  });

  // Générer les cartes articles (avec data-article-category pour le filtre côté client)
  let articlesCardsHtml = '';
  for (const article of sortedArticles) {
    const filterValue = (article.categorie || '').toLowerCase().replace(/\s+/g, '-');
    const articleUrl = `${SITE_BASE}${ARTICLE_URL_PREFIX}/${article.slug}/`;
    
    // Formater la date
    const dateObj = article.date_publication ? new Date(article.date_publication) : new Date();
    const dateStr = dateObj.toLocaleDateString('fr-FR', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });

    articlesCardsHtml += `<a href="${esc(articleUrl)}" class="article-card" data-article-category="${esc(filterValue)}">
      <div class="article-card-image">
        <img src="${esc(article.hero_image_url || SITE_BASE + '/img/placeholder.jpg')}" alt="${esc(article.title)}" loading="lazy" decoding="async">
      </div>
      <div class="article-card-content">
        <div class="article-card-category">${esc(article.categorie || 'Non catégorisé')}</div>
        <h3 class="article-card-title">${esc(article.title)}</h3>
        <p class="article-card-excerpt">${esc(article.chapo || '')}</p>
        <div class="article-card-meta">
          <time datetime="${article.date_publication || dateStr}">${dateStr}</time>
          <span class="article-card-cta">Lire l'article →</span>
        </div>
      </div>
    </a>\n`;
  }

  // Remplacer les placeholders dans le template
  hubHtml = hubHtml
    .replace(/<!-- ARTICLE_HUB_URL -->/g, esc(`${SITE_ORIGIN}${SITE_BASE}${ARTICLE_URL_PREFIX}/`))
    .replace(/<!-- SITE_BASE -->/g, SITE_BASE)
    .replace(/<!-- FILTERS_BUTTONS -->/g, filterButtonsHtml)
    .replace(/<!-- ARTICLES_GRID -->/g, articlesCardsHtml);

  // Écrire le fichier
  const outDir = ARTICLES_OUTPUT_DIR;
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, 'index.html');
  await writeFile(outFile, hubHtml, 'utf8');

  console.log(`  ✓ Page hub déployée : ${SITE_BASE}${ARTICLE_URL_PREFIX}/ (${generatedArticles.length} articles)`);
  return { deployed: true, count: generatedArticles.length };
}



/* ==========================================================================
   14. PIPELINE PRINCIPAL
   ========================================================================== */

/* ==========================================================================
   15. PAGES DÉDIÉES : ARCHIVE (ANCIENNE COLLECTION PE 2026) & CONTACT
   ==========================================================================
   Ces deux pages sont générées à partir de templates propres dans src/pages/,
   qui n'incluent QUE leur contenu spécifique (hero, sections, contact block).
   La navbar, le menu mobile, le footer, la CSS globale et le JS interactif
   sont extraits automatiquement du template principal (src/template.html),
   ce qui garantit une source unique de vérité pour ces éléments partagés.
   Si tu modifies la CSS ou la navbar, tu la changes dans template.html et
   les deux pages dédiées récupèrent la modif au prochain build.
*/

/**
 * Extrait le bloc <style>...</style> principal du template.
 * Utilisé pour partager la CSS entre home et pages dédiées.
 */
function extractSharedStyles(template) {
  // On prend le PREMIER bloc <style> du template (celui du head)
  const match = template.match(/<style>[\s\S]*?<\/style>/);
  if (!match) throw new Error('Bloc <style> introuvable dans template.html');
  return match[0];
}

/**
 * Extrait le bloc JS interactif principal du template (celui qui contient
 * initCarousel, closeMob, etc.). On matche le bloc <script> juste après
 * la balise CATALOG_DATA (c'est le gros bloc JS du site).
 */
function extractSharedInteractiveJs(template) {
  // On cherche le <script> juste après le placeholder CATALOG_DATA
  const marker = '<!-- CATALOG_DATA -->';
  const idx = template.indexOf(marker);
  if (idx === -1) throw new Error('<!-- CATALOG_DATA --> introuvable dans template.html');
  const after = template.slice(idx + marker.length);
  const openIdx = after.indexOf('<script>');
  const closeTag = '</script>';
  if (openIdx === -1) throw new Error('<script> post-CATALOG_DATA introuvable');
  const closeIdx = after.indexOf(closeTag, openIdx);
  if (closeIdx === -1) throw new Error('</script> post-CATALOG_DATA introuvable');
  return after.slice(openIdx, closeIdx + closeTag.length);
}

/**
 * Compose le HTML final d'une page dédiée en injectant les blocs partagés
 * (styles, nav, mobile menu, footer, JS) dans un template minimal.
 *
 * Placeholders attendus dans le template de la page dédiée :
 *   <!-- SHARED_STYLES -->          → CSS globale
 *   <!-- NAV_LINKS -->              → liens navbar (rendus par renderNavLinks)
 *   <!-- MOB_MENU_LINKS -->         → menu mobile
 *   <!-- SHARED_FOOTER -->          → footer complet
 *   <!-- SHARED_JS -->              → JS interactif
 *   <!-- CAROUSEL_IDS_JS -->        → IDs des carrousels à init sur la page
 *   <!-- PAGE_JSON_LD -->           → JSON-LD spécifique à la page
 *   <!-- SITE_BASE --> / <!-- SITE_ORIGIN --> → variables d'environnement
 */
async function composePageFromTemplate(pageTemplatePath, mainTemplate, contextReplacements) {
  const pageTpl = await readFile(pageTemplatePath, 'utf8');

  const context = contextReplacements.context || 'other';
  const sharedStyles = extractSharedStyles(mainTemplate);
  const sharedJs = extractSharedInteractiveJs(mainTemplate);
  const sharedFooter = extractSharedFooter(mainTemplate);
  const sharedStickyContact = extractSharedStickyContact(mainTemplate, context);

  // Substitutions communes à toutes les pages dédiées.
  const commonReplacements = [
    ['<!-- SHARED_STYLES -->',         sharedStyles],
    ['<!-- SHARED_STICKY_CONTACT -->', sharedStickyContact],
    ['<!-- NAV_LINKS -->',             renderNavLinks(context)],
    ['<!-- MOB_MENU_LINKS -->',        renderMobMenuLinks(context)],
    ['<!-- SHARED_FOOTER -->',         sharedFooter],
    ['<!-- SHARED_JS -->',             sharedJs],
    ['<!-- SITE_ORIGIN -->',           SITE_ORIGIN],
    ['<!-- SITE_BASE -->',             SITE_BASE],
  ];

  // Merge : les substitutions spécifiques à la page écrasent les communes si conflit.
  const allReplacements = [...commonReplacements, ...contextReplacements.replacements];

  let html = pageTpl;
  for (const [ph, val] of allReplacements) {
    // On tolère les placeholders manquants pour laisser une flexibilité aux templates
    // pages dédiées (contrairement à la home où c'est strict).
    if (ph === '<!-- SITE_BASE -->' || ph === '<!-- SITE_ORIGIN -->') {
      html = html.split(ph).join(val);
    } else {
      html = html.split(ph).join(val);
    }
  }

  return html;
}

/**
 * Extrait le footer du template principal (bloc <footer>...</footer>).
 */
function extractSharedFooter(template) {
  const match = template.match(/<footer>[\s\S]*?<\/footer>/);
  if (!match) throw new Error('<footer> introuvable dans template.html');
  return match[0];
}

/**
 * Extrait le panneau "Sticky Contact" (bouton flottant + panneau qui glisse).
 * Sur les pages autres que la home, on remplace href="#contact" par une URL
 * absolue vers /contact/ pour que le lien "Showroom" reste fonctionnel.
 */
function extractSharedStickyContact(template, context = 'home') {
  const match = template.match(/<div id="sticky-contact">[\s\S]*?<div id="sticky-tab"[\s\S]*?<\/div>\s*<\/div>/);
  if (!match) {
    // Non-bloquant : si le sticky-contact est absent (template modifié), on continue.
    return '';
  }
  let html = match[0];
  if (context !== 'home') {
    // Remplacer les hrefs "#contact" (ancres de la home) par l'URL /contact/
    html = html.split('href="#contact"').join(`href="${SITE_BASE}/${CONTACT_PAGE_SLUG}/"`);
  }
  return html;
}

/**
 * Génère la page /collection-printemps-ete-2026/ (ancienne collection PE 2026).
 * Rassemble Summer Vibes + Bohème (tous les univers `location: 'archive'`).
 */
async function buildArchivePage(byUniversArchive, mainTemplate) {
  const pageTemplatePath = resolve('src/pages/archive-template.html');
  try {
    await stat(pageTemplatePath);
  } catch {
    console.warn(`  ⚠ src/pages/archive-template.html introuvable — page archive non générée.`);
    return { deployed: false };
  }

  // Rendu des sections univers archive
  let sectionsHtml = '';
  const allArchiveRecords = [];
  for (const u of ARCHIVE_UNIVERS) {
    const recs = byUniversArchive.get(u.id) || [];
    sectionsHtml += renderUniversSection(u, recs);
    allArchiveRecords.push(...recs);
  }

  // JSON-LD spécifique : ItemList des produits archive + Breadcrumb
  const jsonLd = renderArchiveJsonLd(allArchiveRecords);

  // IDs des carrousels à init sur cette page (les univers archive uniquement)
  const carouselIds = ARCHIVE_UNIVERS.map(u => u.id);
  const carouselIdsJs = JSON.stringify(carouselIds);

  const html = await composePageFromTemplate(pageTemplatePath, mainTemplate, {
    context: 'other',
    replacements: [
      ['<!-- ARCHIVE_UNIVERS_NAV_TABS -->', renderArchiveUniversTabs()],
      ['<!-- ARCHIVE_SECTIONS -->', sectionsHtml],
      ['<!-- CAROUSEL_IDS_JS -->', carouselIdsJs],
      ['<!-- PAGE_JSON_LD -->', jsonLd],
      ['<!-- PAGE_TITLE -->', ARCHIVE_PAGE_TITLE],
    ],
  });

  const outDir = resolve(OUTPUT_DIR, ARCHIVE_PAGE_SLUG);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), html, 'utf8');
  console.log(`  ✓ /${ARCHIVE_PAGE_SLUG}/ — ${allArchiveRecords.length} produits (${ARCHIVE_UNIVERS.map(u => u.label).join(' + ')})`);
  return { deployed: true, count: allArchiveRecords.length };
}

/**
 * JSON-LD de la page archive : BreadcrumbList + WebPage + ItemList.
 */
function renderArchiveJsonLd(records) {
  const url = `${SITE_ORIGIN}${SITE_BASE}/${ARCHIVE_PAGE_SLUG}/`;

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Accueil',                             item: `${SITE_ORIGIN}${SITE_BASE}/` },
      { '@type': 'ListItem', position: 2, name: ARCHIVE_PAGE_TITLE,                    item: url },
    ],
  };

  const webPage = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${url}#webpage`,
    url,
    name: `${ARCHIVE_PAGE_TITLE} — GIORGIA paris`,
    description: 'Découvrez les pièces Summer Vibes et Bohème de la collection Printemps-Été 2026 — Grossiste B2B en prêt-à-porter féminin, disponibles au stock depuis Paris.',
    isPartOf: { '@id': `${SITE_ORIGIN}${SITE_BASE}/#website` },
    inLanguage: 'fr-FR',
  };

  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Ancienne Collection Printemps-Été 2026 — GIORGIA paris',
    description: 'Pièces Summer Vibes et Bohème de la collection Printemps-Été 2026.',
    numberOfItems: records.length,
    itemListElement: records.map((rec, i) => {
      const f = rec.fields || {};
      const nom = resolveName(f);
      const photos = resolvePhotos(f);
      const descRaw = resolveDesc(f);
      const ref = resolveRef(f);
      const cat = resolveCategorie(f);

      const product = {
        '@type': 'Product',
        name: nom || `Article ${ref || i + 1}`,
        brand: { '@type': 'Brand', name: 'GIORGIA paris' },
      };
      if (photos[0]) product.image = photos.slice(0, 3);
      if (descRaw) product.description = descRaw.slice(0, 300);
      if (ref) product.sku = ref;
      if (cat) product.category = cat;

      return { '@type': 'ListItem', position: i + 1, item: product };
    }),
  };

  const graph = [breadcrumb, webPage, itemList];
  const safe = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2)
    .replace(/<\/script>/gi, '<\\/script>');
  return `<script type="application/ld+json">${safe}</script>`;
}

/**
 * Génère la page /contact/ (page de contact autonome, SEO-enrichie).
 */
async function buildContactPage(mainTemplate) {
  const pageTemplatePath = resolve('src/pages/contact-template.html');
  try {
    await stat(pageTemplatePath);
  } catch {
    console.warn(`  ⚠ src/pages/contact-template.html introuvable — page contact non générée.`);
    return { deployed: false };
  }

  const jsonLd = renderContactJsonLd();

  const html = await composePageFromTemplate(pageTemplatePath, mainTemplate, {
    context: 'other',
    replacements: [
      ['<!-- CAROUSEL_IDS_JS -->', '[]'], // Pas de carrousel sur la page contact
      ['<!-- PAGE_JSON_LD -->', jsonLd],
      ['<!-- PAGE_TITLE -->', 'Contact'],
    ],
  });

  const outDir = resolve(OUTPUT_DIR, CONTACT_PAGE_SLUG);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), html, 'utf8');
  console.log(`  ✓ /${CONTACT_PAGE_SLUG}/ générée`);
  return { deployed: true };
}

/**
 * JSON-LD de la page contact : BreadcrumbList + ContactPage.
 */
function renderContactJsonLd() {
  const url = `${SITE_ORIGIN}${SITE_BASE}/${CONTACT_PAGE_SLUG}/`;

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Accueil', item: `${SITE_ORIGIN}${SITE_BASE}/` },
      { '@type': 'ListItem', position: 2, name: 'Contact', item: url },
    ],
  };

  const contactPage = {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    '@id': `${url}#contactpage`,
    url,
    name: 'Contact — GIORGIA paris',
    description: 'Contactez GIORGIA paris, grossiste B2B en prêt-à-porter féminin basé à Aubervilliers. Showroom, WhatsApp, email : toutes nos coordonnées pour vos commandes.',
    isPartOf: { '@id': `${SITE_ORIGIN}${SITE_BASE}/#website` },
    inLanguage: 'fr-FR',
    mainEntity: { '@id': `${SITE_ORIGIN}${SITE_BASE}/#organization` },
  };

  const graph = [breadcrumb, contactPage];
  const safe = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2)
    .replace(/<\/script>/gi, '<\\/script>');
  return `<script type="application/ld+json">${safe}</script>`;
}

/* ==========================================================================
   16. MAIN
   ========================================================================== */

async function main() {
  const t0 = Date.now();

  console.log(`→ Airtable : ${BASE_ID} / ${TABLE_NAME}`);
  console.log(`→ Mode : ${IS_PROD ? 'PROD' : 'QUALIF'}`);
  console.log(`→ Site origin : ${SITE_ORIGIN}`);
  console.log(`→ Site base   : '${SITE_BASE}' ${SITE_BASE ? '' : '(racine)'}`);
  console.log('→ Récupération des enregistrements…');
  const records = await fetchAllRecords();
  console.log(`✓ ${records.length} produits récupérés.`);

  // Tri par champ « Ordre »
  const sortedRecords = sortByOrdre(records);

  // Payload allégé pour __GIORGIA_CATALOG__ (conservé par compatibilité)
  const slim = sortedRecords.map(slimRecord);

  // ===================================================================
  //  PIPELINE D'IMAGES : téléchargement + compression + WebP
  // -------------------------------------------------------------------
  //  Téléchargées depuis Airtable/Pexels/Unsplash, compressées (JPEG qualité
  //  82 + WebP qualité 78), écrites dans dist/img/. Le cache .image-cache/
  //  est persisté entre builds par GitHub Actions → les images déjà traitées
  //  sont instantanément réutilisées (pas de re-download, pas de re-compress).
  // ===================================================================
  console.log('→ Pipeline d\'images (download + compression + WebP)…');
  const tImg0 = Date.now();
  const allImgUrls = collectAllImageUrls(sortedRecords);
  console.log(`  ${new Set(allImgUrls).size} URLs uniques à traiter (cache = .image-cache/).`);
  await processImagesBatch(allImgUrls);
  const tImgMs = Date.now() - tImg0;
  console.log(`✓ Images : ${imageStats.downloaded} téléchargées, ${imageStats.cached} depuis le cache, ${imageStats.failed} échecs (${(tImgMs / 1000).toFixed(1)}s).`);
  if (imageStats.totalSavedBytes > 0) {
    console.log(`  Gain total de compression : ${fmtBytes(imageStats.totalSavedBytes)}.`);
  }

  // Audit webperf des images (post-compression : évalue l'état de Airtable
  // "à la source", pas des images servies qui sont maintenant locales)
  let imageAudit = null;
  if (process.env.SKIP_IMAGE_AUDIT !== '1') {
    try { imageAudit = await auditImageWeights(records); }
    catch (err) { console.warn('⚠ Audit images échoué (non bloquant) :', err.message); }
  }

  // ===================================================================
  //  Regroupement par univers, avec routage home/archive.
  //  Un enregistrement d'un univers `location: 'archive'` peut être routé
  //  vers la home s'il porte un champ "Collection" ≠ "PE 2026" (nouvelle
  //  collection dans un univers archive — cas futur AH 2026 / PE 2027).
  //  Voir isArchiveRecord() pour la règle exacte.
  // ===================================================================
  const byUniversHome    = new Map(); // Map<univ.id, records[]> — rendus sur home
  const byUniversArchive = new Map(); // Map<univ.id, records[]> — rendus sur /collection-printemps-ete-2026/
  for (const u of UNIVERS) {
    byUniversHome.set(u.id, []);
    byUniversArchive.set(u.id, []);
  }
  const unmatched = [];
  for (const rec of sortedRecords) {
    const cat = resolveCategorie(rec.fields || {});
    const univ = CATEGORY_TO_UNIVERS.get(normalizeKey(cat));
    if (!univ) {
      if (cat) unmatched.push(cat);
      continue;
    }
    if (isArchiveRecord(rec, univ)) {
      byUniversArchive.get(univ.id).push(rec);
    } else {
      byUniversHome.get(univ.id).push(rec);
    }
  }
  if (unmatched.length) {
    console.warn(`⚠ Catégories non reconnues dans Airtable :`, [...new Set(unmatched)]);
  }
  console.log('  Répartition home / archive :');
  for (const u of UNIVERS) {
    const nHome    = byUniversHome.get(u.id).length;
    const nArchive = byUniversArchive.get(u.id).length;
    const suffix = u.location === 'archive'
      ? `(archive: ${nArchive}${nHome > 0 ? ` — nouveau home: ${nHome}` : ''})`
      : `(home: ${nHome})`;
    console.log(`  • ${u.label} ${suffix}`);
  }

  // ===================================================================
  //  PRÉVENTES : produits avec champ Airtable « Prévente » coché.
  //  On garde l'ordre d'origine (tri par « Ordre » fait plus haut).
  //  Aucune limite stricte sur le nombre — le carrousel s'adapte.
  // ===================================================================
  const preventeRecords = sortedRecords.filter(rec => resolvePrevente(rec.fields || {}));
  console.log(`  • Préventes : ${preventeRecords.length} produits`);

  // Rendu des sections
  console.log('→ Rendu du HTML…');
  // Section Préventes (en tête de home, après le hero)
  const preventesHtml = renderPreventeSection(preventeRecords);
  // Encart WhatsApp catalogue étendu — placé directement après la section
  // Préventes (haut de page, maximise le rebond commercial vers WhatsApp).
  const waCatalogueHtml = renderWhatsAppCatalogue();

  // Sections univers HOME uniquement — Summer Vibes et Bohème ne sont plus
  // rendus ici (ils vivent sur /collection-printemps-ete-2026/).
  let sectionsHtml = '';
  for (const u of HOME_UNIVERS) {
    const recs = byUniversHome.get(u.id) || [];
    sectionsHtml += renderUniversSection(u, recs);
    // Un même univers peut avoir plusieurs encarts derrière lui — en pratique
    // un seul flag est posé par univers pour rester lisible.
    if (u.insertBannerAfter)    sectionsHtml += renderFeatBanner();
    if (u.insertEditorialAfter) sectionsHtml += renderEditorial();
  }

  // ===================================================================
  //  CTA HERO : la home hero affiche "Découvrir la collection".
  //  Cible prioritaire : ancre #preventes s'il y a des préventes,
  //  sinon fallback sur le premier univers home (#working = Urban Woman).
  // ===================================================================
  const heroCtaHref = preventeRecords.length > 0
    ? '#preventes'
    : `#${HOME_UNIVERS[0]?.id || 'working'}`;

  // JSON-LD
  const jsonLdHtml = renderJsonLd(sortedRecords);

  // Lecture template
  const template = await readFile(TEMPLATE_PATH, 'utf8');

  // Payload JS (conservé pour compat / debug)
  const now = new Date();
  const payload = {
    version: 2,
    generatedAt: now.toISOString(),
    count: slim.length,
    products: slim,
  };
  const payloadJson = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>');
  const catalogDataScript = `<script id="giorgia-catalog-data">window.__GIORGIA_CATALOG__=${payloadJson};</script>`;

  // Chemin local pour l'image hero (fallback sur Pexels si le traitement a échoué)
  const heroLocal = localImageFor(ILLUSTRATION_URLS.heroPexels);
  const heroImageUrl = heroLocal ? heroLocal.jpg : ILLUSTRATION_URLS.heroPexels;

  // IDs des carrousels à initialiser côté client sur la home.
  // 'preventes' est un carrousel spécial rendu conditionnellement.
  // Les IDs archive ('summer', 'boheme') ne sont PAS listés ici car ces sections
  // n'existent plus sur la home — leurs carrousels sont initialisés sur la page
  // /collection-printemps-ete-2026/ uniquement.
  const homeCarouselIds = ['preventes', ...HOME_UNIVERS.map(u => u.id)];
  const homeCarouselIdsJs = JSON.stringify(homeCarouselIds);

  // Substitutions des placeholders
  const replacements = [
    ['<!-- UNIVERS_NAV_TABS -->', renderUniversTabs()],
    ['<!-- NAV_LINKS -->', renderNavLinks('home')],
    ['<!-- MOB_MENU_LINKS -->', renderMobMenuLinks('home')],
    ['<!-- PREVENTES_SECTION -->', preventesHtml],
    ['<!-- WA_CATALOGUE_SECTION -->', waCatalogueHtml],
    ['<!-- UNIVERS_SECTIONS -->', sectionsHtml],
    ['<!-- HERO_CTA_HREF -->', heroCtaHref],
    ['<!-- CAROUSEL_IDS_JS -->', homeCarouselIdsJs],
    ['<!-- JSON_LD -->', jsonLdHtml],
    ['<!-- CATALOG_DATA -->', catalogDataScript],
    ['<!-- SITE_ORIGIN -->', SITE_ORIGIN],
    ['<!-- SITE_BASE -->', SITE_BASE],
  ];

  let html = template;
  for (const [ph, val] of replacements) {
    if (!html.includes(ph)) {
      throw new Error(
        `Placeholder ${ph} introuvable dans src/template.html. ` +
        `Vérifiez que vous avez bien mis à jour template.html à la version v2.`
      );
    }
    // SITE_BASE et SITE_ORIGIN apparaissent plusieurs fois (canonical, og:url,
    // hreflang, footer). On utilise split/join pour remplacer toutes les
    // occurrences en une passe.
    if (ph === '<!-- SITE_BASE -->' || ph === '<!-- SITE_ORIGIN -->') {
      html = html.split(ph).join(val);
    } else {
      html = html.replace(ph, val);
    }
  }

  // HERO_IMAGE_URL apparaît 4 fois dans le template (og:image, twitter:image,
  // <link rel="preload">, background CSS) → remplacement GLOBAL, pas simple.
  if (html.includes('<!-- HERO_IMAGE_URL -->')) {
    html = html.split('<!-- HERO_IMAGE_URL -->').join(heroImageUrl);
  }

  // Écriture des fichiers de sortie
  console.log('→ Écriture de dist/…');
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_HTML, html, 'utf8');
  await writeFile(resolve(OUTPUT_DIR, 'robots.txt'), renderRobotsTxt(), 'utf8');

  if (CUSTOM_DOMAIN) {
    await writeFile(resolve(OUTPUT_DIR, 'CNAME'), `${CUSTOM_DOMAIN}\n`, 'utf8');
  }

  // ===================================================================
  //  Page archive — /collection-printemps-ete-2026/
  //  Rassemble tous les produits des univers `location: 'archive'`
  //  (Summer Vibes + Bohème) sur une page dédiée.
  // ===================================================================
  console.log(`→ Génération de /${ARCHIVE_PAGE_SLUG}/…`);
  await buildArchivePage(byUniversArchive, template);

  // ===================================================================
  //  Page contact — /contact/
  //  Page SEO enrichie avec coordonnées, showroom, FAQ commande.
  //  La section #contact reste également sur la home (duplication assumée).
  // ===================================================================
  console.log(`→ Génération de /${CONTACT_PAGE_SLUG}/…`);
  await buildContactPage(template);

  // Copie des pages légales depuis src/legal/ vers dist/ avec URLs propres.
  console.log('→ Copie des pages légales…');
  await copyLegalPages();

  // Pipeline articles "Tendances & Conseils Pro"
  let articlesForSitemap = [];
  const articlesResult = await buildArticles(sortedRecords);
  if (articlesResult.deployed) {
    console.log(`✓ ${articlesResult.count} article(s) "Tendances & Conseils Pro" généré(s).`);
    
    // Générer la page hub
    const hubResult = await buildArticlesIndex(articlesResult.articles);
    if (hubResult.deployed) {
      console.log(`✓ Page hub "/tendances-conseils-pro/" générée.`);
    }
    
    // Générer le JSON des 3 derniers articles pour la home
    const jsonResult = await generateLatestArticlesJson(articlesResult.articles);
    if (jsonResult.deployed) {
      console.log(`✓ JSON articles générés pour la home.`);
    }
    
    // Stocker les articles pour la sitemap
    articlesForSitemap = articlesResult.articles || [];
  }

  // Générer la sitemap (avec les articles)
  await writeFile(resolve(OUTPUT_DIR, 'sitemap.xml'), renderSitemapXml(now, articlesForSitemap), 'utf8');

  await writeFile(
    resolve(OUTPUT_DIR, 'build-info.json'),
    JSON.stringify(
      {
        generatedAt: payload.generatedAt,
        count: payload.count,
        version: 3,
        imagePipeline: {
          downloaded: imageStats.downloaded,
          cached: imageStats.cached,
          failed: imageStats.failed,
          compressionSavedKB: Math.round(imageStats.totalSavedBytes / 1024),
        },
        imageAudit,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  const sizeKB = (html.length / 1024).toFixed(1);
  const durMs = Date.now() - t0;
  console.log(`✓ dist/index.html : ${sizeKB} KB, ${slim.length} produits, ${durMs} ms.`);
  console.log(`✓ dist/robots.txt, dist/sitemap.xml, dist/build-info.json générés.`);
}

main().catch((err) => {
  console.error('✖ Build échoué :', err.stack || err.message);
  process.exit(1);
});
